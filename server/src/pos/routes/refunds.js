const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { PAYMENT_METHODS, PosError, audit, cleanText, handle, requireOwner, toInt, won } = require('../common');
const { attachVanOriginals, normalizePayments, requireBridgeCancels, vanOriginal } = require('../services/payment-service');
const { cancelCashReceiptsForRefund, reissueHint } = require('../services/cash-receipt-service');
const { createRefundOrder, refundablePaymentBalances, reverseEarnedPoints } = require('../services/refund-service');
const { buildReceipt, getPosOrder } = require('../services/sale-service');
const { requireOpenSession } = require('../services/session-service');

const router = express.Router();

router.post(
  '/sales/:id/cancel',
  handle((req) => {
    requireOwner(req, '판매 취소');
    const reason = cleanText(req.body.reason);
    if (!reason) throw new PosError('취소 사유를 입력해 주세요.');
    const restock = req.body.restock !== false;
    const cardCancelApproval = cleanText(req.body.card_cancel_approval_number, 30);

    const receipt = transaction(() => {
      const { terminal, session } = requireOpenSession(req);
      const original = getPosOrder(req, req.params.id);
      if (original.order_type !== 'POS_SALE') throw new PosError('판매 거래만 취소할 수 있습니다.');
      if (original.order_status === 'CANCELED') throw new PosError('이미 취소된 거래입니다.', 409);
      if (original.order_status !== 'COMPLETED') {
        throw new PosError('반품 이력이 있는 거래는 전체 취소할 수 없습니다. 남은 상품은 부분반품으로 처리해 주세요.', 409);
      }
      const sameDay = getOne("SELECT date(@created_at, 'localtime') = date('now', 'localtime') AS same_day", {
        created_at: original.created_at
      }).same_day === 1;
      if (!sameDay) throw new PosError('당일 거래만 전체 취소할 수 있습니다. 지난 거래는 부분반품으로 처리해 주세요.');

      const marked = run(
        `UPDATE orders
         SET order_status = 'CANCELED', payment_status = 'CANCELED', refund_reason = @reason, updated_at = CURRENT_TIMESTAMP
         WHERE id = @id AND order_status = 'COMPLETED'`,
        { id: original.id, reason }
      );
      if (marked.changes === 0) throw new PosError('이미 취소된 거래입니다.', 409);

      const items = getAll('SELECT * FROM order_items WHERE order_id = @id ORDER BY id ASC', { id: original.id });
      const lines = items.map((item) => ({
        item,
        quantity: item.quantity,
        amount: item.total_price - (item.discount_amount || 0)
      }));
      const payments = getAll('SELECT * FROM payments WHERE order_id = @id AND paid_amount > 0 ORDER BY id ASC', {
        id: original.id
      }).map((payment) => ({
        method: payment.payment_method,
        amount: payment.paid_amount,
        approval_number: payment.payment_method === 'CARD' ? cardCancelApproval || payment.approval_number : null,
        card_company: payment.card_company,
        van_original: vanOriginal(payment)
      }));
      requireBridgeCancels(terminal, payments, req.body.van_cancels);

      const { refundOrderId, refundTotal } = createRefundOrder(req, {
        original,
        lines,
        refundType: 'CANCEL',
        reason,
        payments,
        restock,
        session,
        terminal
      });
      reverseEarnedPoints(req, original, refundOrderId, lines, { full: true });
      const cashReceipt = cancelCashReceiptsForRefund(req, { terminal, original, refundOrderId, payments, cancels: req.body.cash_receipt_cancels });

      run(
        `UPDATE payments SET payment_status = 'CANCELED', canceled_at = CURRENT_TIMESTAMP
         WHERE order_id = @id AND paid_amount > 0`,
        { id: original.id }
      );

      audit(
        req,
        'POS_CANCEL',
        'ORDER',
        original.id,
        `판매 전체 취소 ${original.order_number} · ${won(refundTotal)} · 사유: ${reason}${restock ? '' : ' · 재입고 안 함'}`
      );
      return { refund: buildReceipt(req, refundOrderId), original: buildReceipt(req, original.id), cash_receipt_notices: cashReceipt.notices };
    })();

    return receipt;
  })
);

router.post(
  ['/sales/:id/refunds', '/refunds/:id'],
  handle((req, res) => {
    requireOwner(req, '반품');
    const reason = cleanText(req.body.reason);
    if (!reason) throw new PosError('반품 사유를 입력해 주세요.');
    const restock = req.body.restock !== false;
    const requested = Array.isArray(req.body.items) ? req.body.items : [];
    if (requested.length === 0) throw new PosError('반품할 상품과 수량을 선택해 주세요.');

    const result = transaction(() => {
      const { terminal, session } = requireOpenSession(req);
      const original = getPosOrder(req, req.params.id);
      if (original.order_type !== 'POS_SALE') throw new PosError('판매 거래만 반품할 수 있습니다.');
      if (!['COMPLETED', 'PARTIALLY_REFUNDED'].includes(original.order_status)) {
        throw new PosError('이미 취소되었거나 전체 반품된 거래입니다.', 409);
      }

      const items = getAll('SELECT * FROM order_items WHERE order_id = @id', { id: original.id });
      const quantities = new Map();
      for (const raw of requested) {
        const quantity = Number(raw.quantity);
        if (!quantity) continue;
        const id = Number(raw.order_item_id);
        quantities.set(id, (quantities.get(id) || 0) + toInt(quantity, '반품 수량', { min: 1, max: 999 }));
      }
      if (quantities.size === 0) throw new PosError('반품할 상품과 수량을 선택해 주세요.');

      const lines = [];
      for (const [itemId, quantity] of quantities) {
        const item = items.find((row) => row.id === itemId);
        if (!item) throw new PosError('원거래에 없는 상품이 포함되어 있습니다.');
        const refundedQuantity = item.refunded_quantity || 0;
        const remaining = item.quantity - refundedQuantity;
        if (quantity > remaining) {
          throw new PosError(`${item.product_name}은(는) 최대 ${remaining}개까지 반품할 수 있습니다.`);
        }
        const net = item.total_price - (item.discount_amount || 0);
        const amount =
          quantity === remaining ? net - (item.refunded_amount || 0) : Math.floor((net * quantity) / item.quantity);
        lines.push({ item, quantity, amount });
      }
      const refundTotal = lines.reduce((sum, line) => sum + line.amount, 0);

      const balances = refundablePaymentBalances(original.id);
      let payments;
      if (Array.isArray(req.body.payments) && req.body.payments.length > 0) {
        payments = normalizePayments(req.body.payments, refundTotal, { requireCardApproval: false, allowChange: false });
        const perMethod = {};
        for (const payment of payments) perMethod[payment.method] = (perMethod[payment.method] || 0) + payment.amount;
        for (const [method, amount] of Object.entries(perMethod)) {
          const balance = balances[method] || 0;
          if (amount > balance) {
            throw new PosError(`${PAYMENT_METHODS[method]} 환불 가능 금액(${won(balance)})을 초과했습니다.`);
          }
        }
      } else if (refundTotal === 0) {
        payments = [];
      } else {
        const methods = Object.entries(balances).filter(([, balance]) => balance > 0);
        if (methods.length !== 1) {
          throw new PosError('복합결제 거래는 환불할 결제수단별 금액을 입력해 주세요.');
        }
        const [method, balance] = methods[0];
        if (refundTotal > balance) throw new PosError(`환불 가능 금액(${won(balance)})을 초과했습니다.`);
        payments = [{ method, amount: refundTotal }];
      }
      payments = requireBridgeCancels(terminal, attachVanOriginals(original.id, payments), req.body.van_cancels);

      const { refundOrderId } = createRefundOrder(req, {
        original,
        lines,
        refundType: 'PARTIAL',
        reason,
        payments,
        restock,
        session,
        terminal
      });

      const remainingQuantity = getOne(
        'SELECT COALESCE(SUM(quantity - COALESCE(refunded_quantity, 0)), 0) AS remaining FROM order_items WHERE order_id = @id',
        { id: original.id }
      ).remaining;
      const nextStatus = remainingQuantity > 0 ? 'PARTIALLY_REFUNDED' : 'REFUNDED';
      reverseEarnedPoints(req, original, refundOrderId, lines, { full: nextStatus === 'REFUNDED' });
      const cashReceipt = cancelCashReceiptsForRefund(req, { terminal, original, refundOrderId, payments, cancels: req.body.cash_receipt_cancels });
      run(
        `UPDATE orders SET order_status = @status, payment_status = @status, updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
        { id: original.id, status: nextStatus }
      );
      if (nextStatus === 'REFUNDED') {
        run(
          `UPDATE payments SET payment_status = 'REFUNDED', refunded_at = CURRENT_TIMESTAMP
           WHERE order_id = @id AND paid_amount > 0`,
          { id: original.id }
        );
      }

      const summary = lines.map((line) => `${line.item.product_name} ×${line.quantity}`).join(', ');
      audit(
        req,
        'POS_REFUND',
        'ORDER',
        original.id,
        `부분반품 ${original.order_number} · ${summary} · ${won(refundTotal)} · 사유: ${reason}${restock ? '' : ' · 재입고 안 함'}`
      );
      return {
        refund: buildReceipt(req, refundOrderId),
        original: buildReceipt(req, original.id),
        cash_receipt_notices: cashReceipt.notices,
        cash_receipt_reissue: reissueHint(original.id, cashReceipt.canceled)
      };
    })();

    res.status(201);
    return result;
  })
);

module.exports = router;
