const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { VAN_COMPANIES, VAN_MODES, VanError, adapterFor, demoAdapter } = require('../services/van');
const { PointError, pointPolicy, changePoints, pointEligibleAmount, earnRate, calcEarn } = require('../services/points');
const { earningContext, grantReferralReward, posBadges } = require('../services/members');
const { LotError, parseLotInput, insertLot, lotLabel } = require('../services/lots');
const { taxBreakdown } = require('../services/tax');

const router = express.Router();

const PAYMENT_METHODS = {
  CARD: '카드',
  CASH: '현금',
  TRANSFER: '계좌이체',
  EASY_PAY: '간편결제',
  POINT: '포인트'
};

const PICKUP_DONE_STATUSES = ['PICKED_UP', 'COMPLETED', 'CANCELED'];
const COUNSEL_OPEN_STATUSES = ['RESERVED', 'CONFIRMED'];
const PHONE_DIGITS_SQL = (column) => `REPLACE(REPLACE(REPLACE(COALESCE(${column}, ''), '-', ''), ' ', ''), '.', '')`;

class PosError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof PosError || error instanceof VanError || error instanceof PointError || error instanceof LotError) {
        return res.status(error.status).json({ message: error.message });
      }
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(400).json({ message: error.message });
      }
      console.error(error);
      return res.status(500).json({ message: 'POS 처리 중 오류가 발생했습니다.' });
    }
  };
}

function won(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function cleanText(value, maxLength = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function toInt(value, label, { min = 0, max = 100000000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PosError(`${label}이(가) 올바르지 않습니다.`);
  }
  return number;
}

function isOwner(req) {
  return req.user.role === 'PHARMACY_OWNER';
}

function requireOwner(req, action) {
  if (!isOwner(req)) throw new PosError(`${action}은(는) 약국 관리자만 처리할 수 있습니다.`, 403);
}

function localToday() {
  return getOne("SELECT date('now', 'localtime') AS today").today;
}

function assertDate(value, fallback) {
  const date = String(value || '').trim() || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PosError('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
  return date;
}

function audit(req, action, targetType, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, @target_type, @target_id, @description)`,
    {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId,
      action,
      target_type: targetType,
      target_id: targetId,
      description
    }
  );
}

function ensureTerminal(pharmacyId) {
  const terminal = getOne(
    "SELECT * FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1",
    { pharmacy_id: pharmacyId }
  );
  if (terminal) return terminal;
  const result = run("INSERT INTO pos_terminals (pharmacy_id, terminal_name) VALUES (@pharmacy_id, '카운터 1')", {
    pharmacy_id: pharmacyId
  });
  return getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: result.lastInsertRowid });
}

function findOpenSession(terminalId) {
  return getOne("SELECT * FROM pos_sessions WHERE terminal_id = @terminal_id AND status = 'OPEN'", {
    terminal_id: terminalId
  });
}

function requireOpenSession(req) {
  const terminal = ensureTerminal(req.pharmacyId);
  const session = findOpenSession(terminal.id);
  if (!session) throw new PosError('영업이 시작되지 않았습니다. 시재를 입력하고 영업을 시작해 주세요.', 409);
  return { terminal, session };
}

function nextOrderNumber(prefix, pharmacyId) {
  const ymd = getOne("SELECT substr(strftime('%Y%m%d', 'now', 'localtime'), 3) AS ymd").ymd;
  const base = `${prefix}${pharmacyId}-${ymd}-`;
  const last = getOne(
    'SELECT order_number FROM orders WHERE order_number LIKE @pattern ORDER BY order_number DESC LIMIT 1',
    { pattern: `${base}%` }
  );
  const seq = last ? Number(last.order_number.slice(base.length)) + 1 : 1;
  return `${base}${String(seq).padStart(4, '0')}`;
}

function normalizePayments(payments, expectedTotal, { requireCardApproval = true, allowChange = true, allowPoint = true } = {}) {
  const list = Array.isArray(payments) ? payments : [];
  const normalized = list.map((payment) => {
    const method = String(payment.method || payment.payment_method || '').toUpperCase();
    if (!PAYMENT_METHODS[method]) throw new PosError('결제수단을 선택해 주세요.');
    if (method === 'POINT' && !allowPoint) throw new PosError('이 결제에는 포인트를 사용할 수 없습니다.');
    const label = PAYMENT_METHODS[method];
    const amount = Number(payment.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new PosError(`${label} 금액이 올바르지 않습니다.`);

    const approvalNumber = cleanText(payment.approval_number, 30);
    if (approvalNumber && /^\d{13,19}$/.test(approvalNumber.replace(/[\s-]/g, ''))) {
      throw new PosError('카드번호로 보이는 값은 저장할 수 없습니다. 단말기 영수증의 승인번호만 입력해 주세요.');
    }
    const vanTransactionId = payment.van_transaction_id ? Number(payment.van_transaction_id) : null;
    if (vanTransactionId !== null && !Number.isInteger(vanTransactionId)) throw new PosError('VAN 승인 정보가 올바르지 않습니다.');
    if (method === 'CARD' && requireCardApproval && !approvalNumber && !vanTransactionId) {
      throw new PosError('카드 단말기에서 승인된 승인번호를 입력해 주세요.');
    }

    let receivedAmount = null;
    let changeAmount = null;
    const received = payment.received_amount;
    if (allowChange && method === 'CASH' && received !== undefined && received !== null && received !== '') {
      receivedAmount = Number(received);
      if (!Number.isInteger(receivedAmount) || receivedAmount < amount) {
        throw new PosError('받은 현금이 결제 금액보다 적습니다.');
      }
      changeAmount = receivedAmount - amount;
    }

    return {
      method,
      amount,
      approval_number: approvalNumber,
      card_company: method === 'CARD' ? cleanText(payment.card_company, 30) : null,
      cash_receipt_number: method === 'CASH' ? cleanText(payment.cash_receipt_number, 30) : null,
      received_amount: receivedAmount,
      change_amount: changeAmount,
      van_transaction_id: vanTransactionId
    };
  });

  const sum = normalized.reduce((total, payment) => total + payment.amount, 0);
  if (sum !== expectedTotal) {
    throw new PosError(`결제 금액 합계 ${won(sum)}이(가) 결제할 금액 ${won(expectedTotal)}과(와) 일치하지 않습니다.`);
  }
  return normalized;
}

function claimVanTransaction(pharmacyId, payment, orderId) {
  const tx = getOne('SELECT * FROM van_transactions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: payment.van_transaction_id,
    pharmacy_id: pharmacyId
  });
  if (!tx || tx.transaction_type !== 'APPROVE') throw new PosError('VAN 승인 내역을 찾을 수 없습니다.');
  if (tx.status !== 'APPROVED' || tx.order_id) throw new PosError('이미 사용되었거나 취소된 VAN 승인입니다.', 409);
  if (tx.payment_method !== payment.method) throw new PosError('VAN 승인 결제수단이 일치하지 않습니다.');
  if (tx.amount !== payment.amount) {
    throw new PosError(`VAN 승인 금액(${won(tx.amount)})과 결제 금액(${won(payment.amount)})이 다릅니다.`);
  }
  run("UPDATE van_transactions SET status = 'USED', order_id = @order_id WHERE id = @id AND status = 'APPROVED'", {
    id: tx.id,
    order_id: orderId
  });
  return tx;
}

// 데모 VAN으로 승인된 원결제는 환불할 때도 데모 VAN 취소 전문을 만들어 승인번호를 남긴다.
function cancelVanPayment(pharmacyId, payment, orderId, { terminal, userId }) {
  const original = payment.van_original;
  const result = demoAdapter.cancel({ approval_number: original.approval_number, amount: payment.amount });
  const inserted = run(
    `INSERT INTO van_transactions (
      pharmacy_id, terminal_id, van_company, tid, transaction_type, payment_method, amount, approval_number,
      card_company, original_approval_number, status, order_id, is_demo, message, created_by
    ) VALUES (
      @pharmacy_id, @terminal_id, @van_company, @tid, 'CANCEL', @payment_method, @amount, @approval_number,
      @card_company, @original_approval_number, 'USED', @order_id, 1, @message, @created_by
    )`,
    {
      pharmacy_id: pharmacyId,
      terminal_id: terminal ? terminal.id : null,
      van_company: terminal ? terminal.van_company : null,
      tid: terminal ? terminal.tid : null,
      payment_method: payment.method,
      amount: payment.amount,
      approval_number: result.approval_number,
      card_company: original.card_company || null,
      original_approval_number: original.approval_number,
      order_id: orderId,
      message: result.message,
      created_by: userId
    }
  );
  return { ...result, card_company: original.card_company, van_transaction_id: inserted.lastInsertRowid };
}

function attachVanOriginals(originalOrderId, payments) {
  const vanPayments = getAll(
    "SELECT * FROM payments WHERE order_id = @id AND paid_amount > 0 AND payment_provider = 'VAN_DEMO' ORDER BY id ASC",
    { id: originalOrderId }
  );
  return payments.map((payment) => {
    const original = vanPayments.find((row) => row.payment_method === payment.method);
    return original
      ? { ...payment, van_original: { approval_number: original.approval_number, card_company: original.card_company } }
      : payment;
  });
}

function insertPayments(orderId, payments, { sign = 1, session, terminal, userId, customerId = null }) {
  for (const input of payments) {
    const payment = { ...input, provider: input.method === 'CARD' ? 'VAN_MANUAL' : 'POS' };
    if (input.method === 'POINT') {
      if (!customerId) throw new PosError('포인트는 회원 거래에서만 사용할 수 있습니다.');
      changePoints({
        pharmacyId: terminal.pharmacy_id,
        customerId,
        orderId,
        entryType: sign > 0 ? 'USE' : 'USE_RESTORE',
        points: sign * -input.amount,
        reason: sign > 0 ? '현장 결제 포인트 사용' : '취소·반품 포인트 복원',
        userId
      });
      Object.assign(payment, { provider: 'POINT', approval_number: null, card_company: null, van_transaction_id: null });
    } else if (sign > 0 && input.van_transaction_id) {
      const tx = claimVanTransaction(terminal.pharmacy_id, input, orderId);
      Object.assign(payment, {
        approval_number: tx.approval_number,
        card_company: tx.card_company,
        installment_months: tx.installment_months,
        provider: tx.is_demo ? 'VAN_DEMO' : 'VAN'
      });
    } else if (sign < 0 && input.van_original) {
      const cancel = cancelVanPayment(terminal.pharmacy_id, input, orderId, { terminal, userId });
      Object.assign(payment, {
        approval_number: cancel.approval_number,
        card_company: cancel.card_company,
        van_transaction_id: cancel.van_transaction_id,
        provider: 'VAN_DEMO'
      });
    } else {
      payment.van_transaction_id = null;
    }

    run(
      `INSERT INTO payments (
        order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at, refunded_at,
        approval_number, terminal_id, card_company, cash_receipt_number, received_amount, change_amount,
        pos_session_id, created_by, van_transaction_id, installment_months
      ) VALUES (
        @order_id, @payment_method, @payment_provider, @payment_status, @paid_amount, CURRENT_TIMESTAMP,
        CASE WHEN @sign < 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
        @approval_number, @terminal_id, @card_company, @cash_receipt_number, @received_amount, @change_amount,
        @pos_session_id, @created_by, @van_transaction_id, @installment_months
      )`,
      {
        order_id: orderId,
        payment_method: payment.method,
        payment_provider: payment.provider,
        van_transaction_id: payment.van_transaction_id || null,
        installment_months: payment.installment_months ?? null,
        payment_status: sign < 0 ? 'REFUNDED' : 'PAID',
        paid_amount: sign * payment.amount,
        sign,
        approval_number: payment.approval_number || null,
        terminal_id: terminal ? String(terminal.id) : null,
        card_company: payment.card_company || null,
        cash_receipt_number: payment.cash_receipt_number || null,
        received_amount: payment.received_amount ?? null,
        change_amount: payment.change_amount ?? null,
        pos_session_id: session ? session.id : null,
        created_by: userId
      }
    );
  }
}

function logInventory(req, productId, before, after, changeType, reason, orderId) {
  run(
    `INSERT INTO inventory_logs (
      pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by,
      reference_type, reference_id
    ) VALUES (
      @pharmacy_id, @product_id, @change_type, @quantity_before, @quantity_after, @reason, @created_by,
      'ORDER', @reference_id
    )`,
    {
      pharmacy_id: req.pharmacyId,
      product_id: productId,
      change_type: changeType,
      quantity_before: before,
      quantity_after: after,
      reason,
      created_by: req.user.id,
      reference_id: orderId
    }
  );
}

function sessionSummary(session) {
  const payments = getAll(
    `SELECT payment_method,
      COUNT(CASE WHEN paid_amount > 0 THEN 1 END) AS pay_count,
      COALESCE(SUM(CASE WHEN paid_amount > 0 THEN paid_amount ELSE 0 END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN paid_amount < 0 THEN paid_amount ELSE 0 END), 0) AS refunded_amount,
      COALESCE(SUM(paid_amount), 0) AS net_amount
     FROM payments
     WHERE pos_session_id = @id
     GROUP BY payment_method
     ORDER BY payment_method`,
    { id: session.id }
  );

  const sales = getOne(
    `SELECT
      COUNT(CASE WHEN order_type = 'POS_SALE' THEN 1 END) AS sale_count,
      COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN final_amount ELSE 0 END), 0) AS gross_sales,
      COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN discount_amount ELSE 0 END), 0) AS discount_total,
      COUNT(CASE WHEN order_type = 'POS_REFUND' THEN 1 END) AS refund_count,
      COALESCE(SUM(CASE WHEN order_type = 'POS_REFUND' THEN final_amount ELSE 0 END), 0) AS refund_total,
      COUNT(CASE WHEN order_type = 'PICKUP' THEN 1 END) AS pickup_paid_count
     FROM orders
     WHERE pos_session_id = @id`,
    { id: session.id }
  );

  const movements = getAll(
    `SELECT m.*, u.name AS created_by_name
     FROM cash_movements m
     LEFT JOIN users u ON u.id = m.created_by
     WHERE m.session_id = @id
     ORDER BY m.id ASC`,
    { id: session.id }
  );
  const deposits = movements.filter((m) => m.movement_type === 'DEPOSIT').reduce((sum, m) => sum + m.amount, 0);
  const withdrawals = movements.filter((m) => m.movement_type === 'WITHDRAW').reduce((sum, m) => sum + m.amount, 0);
  const cashNet = payments.find((p) => p.payment_method === 'CASH')?.net_amount || 0;

  return {
    payments,
    ...sales,
    net_sales: sales.gross_sales + sales.refund_total,
    cash_net: cashNet,
    deposits,
    withdrawals,
    movements,
    expected_cash: session.opening_cash + cashNet + deposits - withdrawals
  };
}

function withSummary(session) {
  if (!session) return null;
  const opener = getOne('SELECT name FROM users WHERE id = @id', { id: session.opened_by });
  return { ...session, opened_by_name: opener?.name || null, summary: sessionSummary(session) };
}

function getPosOrder(req, id) {
  const order = getOne(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name,
            orig.order_number AS original_order_number
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users u ON u.id = o.cashier_user_id
     LEFT JOIN orders orig ON orig.id = o.original_order_id
     WHERE o.id = @id AND o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS'`,
    { id: Number(id), pharmacy_id: req.pharmacyId }
  );
  if (!order) throw new PosError('POS 거래를 찾을 수 없습니다.', 404);
  return order;
}

function buildReceipt(req, orderId) {
  const order = getPosOrder(req, orderId);
  const pharmacy = getOne(
    'SELECT pharmacy_name, owner_name, business_number, phone, address FROM pharmacies WHERE id = @id',
    { id: req.pharmacyId }
  );
  const items = getAll(
    `SELECT oi.*, oi.quantity - COALESCE(oi.refunded_quantity, 0) AS refundable_quantity
     FROM order_items oi WHERE oi.order_id = @id ORDER BY oi.id ASC`,
    { id: order.id }
  );
  const payments = getAll('SELECT * FROM payments WHERE order_id = @id ORDER BY id ASC', { id: order.id });
  const refunds = getAll(
    `SELECT o.id, o.order_number, o.final_amount, o.refund_reason, o.created_at, r.refund_type, u.name AS created_by_name
     FROM orders o
     LEFT JOIN refunds r ON r.refund_order_id = o.id
     LEFT JOIN users u ON u.id = o.cashier_user_id
     WHERE o.original_order_id = @id
     ORDER BY o.id ASC`,
    { id: order.id }
  );
  const sameDay = getOne("SELECT date(@created_at, 'localtime') = date('now', 'localtime') AS same_day", {
    created_at: order.created_at
  }).same_day === 1;
  const pointBalance = order.customer_id
    ? getOne('SELECT point_balance FROM customers WHERE id = @id', { id: order.customer_id })?.point_balance ?? null
    : null;

  return {
    pharmacy,
    order,
    items,
    payments,
    refunds,
    points: order.customer_id
      ? {
          earned: order.points_earned || 0,
          reward:
            getOne("SELECT COALESCE(SUM(points), 0) AS total FROM point_ledger WHERE order_id = @id AND customer_id = @customer_id AND entry_type = 'REWARD'", {
              id: order.id,
              customer_id: order.customer_id
            }).total,
          balance: pointBalance
        }
      : null,
    tax: taxBreakdown(items),
    payment_balances: order.order_type === 'POS_SALE' ? refundablePaymentBalances(order.id) : {},
    permissions: {
      can_cancel: isOwner(req) && order.order_type === 'POS_SALE' && order.order_status === 'COMPLETED' && sameDay,
      can_refund:
        isOwner(req) &&
        order.order_type === 'POS_SALE' &&
        ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.order_status) &&
        items.some((item) => item.refundable_quantity > 0)
    }
  };
}

function refundablePaymentBalances(originalOrderId) {
  const rows = getAll(
    `SELECT payment_method, COALESCE(SUM(paid_amount), 0) AS balance
     FROM payments
     WHERE order_id = @id OR order_id IN (SELECT id FROM orders WHERE original_order_id = @id)
     GROUP BY payment_method`,
    { id: originalOrderId }
  );
  return Object.fromEntries(rows.map((row) => [row.payment_method, row.balance]));
}

// 원거래와 연결된 음수 반품 주문을 만들어 매출·결제·재고를 함께 되돌린다.
function createRefundOrder(req, { original, lines, refundType, reason, payments, restock, session, terminal }) {
  const grossTotal = lines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const refundTotal = lines.reduce((sum, line) => sum + line.amount, 0);

  const orderResult = run(
    `INSERT INTO orders (
      order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, delivery_fee,
      discount_amount, final_amount, payment_status, order_status, delivery_status, contact_name, contact_phone,
      pos_terminal_id, pos_session_id, cashier_user_id, original_order_id, refund_reason
    ) VALUES (
      @order_number, @pharmacy_id, @customer_id, 'POS_REFUND', 'POS', @total_product_amount, 0,
      @discount_amount, @final_amount, 'REFUNDED', 'COMPLETED', 'NOT_APPLICABLE', @contact_name, @contact_phone,
      @pos_terminal_id, @pos_session_id, @cashier_user_id, @original_order_id, @refund_reason
    )`,
    {
      order_number: nextOrderNumber('RFD', req.pharmacyId),
      pharmacy_id: req.pharmacyId,
      customer_id: original.customer_id,
      total_product_amount: -grossTotal,
      discount_amount: -(grossTotal - refundTotal),
      final_amount: -refundTotal,
      contact_name: original.contact_name,
      contact_phone: original.contact_phone,
      pos_terminal_id: terminal.id,
      pos_session_id: session.id,
      cashier_user_id: req.user.id,
      original_order_id: original.id,
      refund_reason: reason
    }
  );
  const refundOrderId = orderResult.lastInsertRowid;

  for (const { item, quantity, amount } of lines) {
    run(
      `INSERT INTO order_items (
        order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, discount_amount
      ) VALUES (
        @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @discount_amount
      )`,
      {
        order_id: refundOrderId,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: -quantity,
        price: item.price,
        total_price: -(item.price * quantity),
        product_type: item.product_type,
        tax_type: item.tax_type,
        discount_amount: -(item.price * quantity - amount)
      }
    );

    const updated = run(
      `UPDATE order_items
       SET refunded_quantity = COALESCE(refunded_quantity, 0) + @quantity,
           refunded_amount = COALESCE(refunded_amount, 0) + @amount
       WHERE id = @id AND COALESCE(refunded_quantity, 0) + @quantity <= quantity`,
      { id: item.id, quantity, amount }
    );
    if (updated.changes === 0) throw new PosError(`${item.product_name}의 반품 가능 수량을 초과했습니다.`);

    if (restock) {
      const product = getOne('SELECT stock_quantity FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: item.product_id,
        pharmacy_id: req.pharmacyId
      });
      if (product) {
        run(
          `UPDATE products
           SET stock_quantity = stock_quantity + @quantity,
               status = CASE WHEN status = 'SOLD_OUT' THEN 'ON_SALE' ELSE status END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = @id AND pharmacy_id = @pharmacy_id`,
          { id: item.product_id, pharmacy_id: req.pharmacyId, quantity }
        );
        logInventory(
          req,
          item.product_id,
          product.stock_quantity,
          product.stock_quantity + quantity,
          'POS_REFUND',
          refundType === 'CANCEL' ? '현장 판매 취소 재입고' : '현장 반품 재입고',
          refundOrderId
        );
      }
    }
  }

  insertPayments(refundOrderId, payments, {
    sign: -1,
    session,
    terminal,
    userId: req.user.id,
    customerId: original.customer_id
  });

  run(
    `INSERT INTO refunds (
      pharmacy_id, original_order_id, refund_order_id, refund_type, refund_amount, reason, approved_by, created_by
    ) VALUES (
      @pharmacy_id, @original_order_id, @refund_order_id, @refund_type, @refund_amount, @reason, @user_id, @user_id
    )`,
    {
      pharmacy_id: req.pharmacyId,
      original_order_id: original.id,
      refund_order_id: refundOrderId,
      refund_type: refundType,
      refund_amount: refundTotal,
      reason,
      user_id: req.user.id
    }
  );

  return { refundOrderId, refundTotal };
}

// 적립 포인트를 이미 써 버린 고객은 잔액까지만 회수하고, 못 돌려받은 포인트는 원장 사유에 남긴다.
function reverseEarnedPoints(req, original, refundOrderId, lines, { full }) {
  const earned = original.points_earned || 0;
  if (!original.customer_id || earned <= 0) return null;
  const reversedSoFar = -getOne(
    'SELECT COALESCE(SUM(points_earned), 0) AS total FROM orders WHERE original_order_id = @id AND id != @refund_id',
    { id: original.id, refund_id: refundOrderId }
  ).total;
  const remaining = earned - reversedSoFar;
  if (remaining <= 0) return null;

  let target = remaining;
  if (!full) {
    const items = getAll('SELECT total_price, discount_amount, product_type FROM order_items WHERE order_id = @id', {
      id: original.id
    });
    const eligibleTotal = pointEligibleAmount(items);
    const eligibleRefund = lines
      .filter((line) => (line.item.product_type || 'GENERAL') !== 'OTC')
      .reduce((sum, line) => sum + line.amount, 0);
    target = eligibleTotal > 0 ? Math.min(remaining, Math.floor((earned * eligibleRefund) / eligibleTotal)) : 0;
  }
  if (target <= 0) return null;

  const balance = getOne('SELECT point_balance FROM customers WHERE id = @id', { id: original.customer_id }).point_balance;
  const taken = Math.min(balance, target);
  const shortfall = target - taken;
  run('UPDATE orders SET points_earned = @points WHERE id = @id', { id: refundOrderId, points: -target });
  if (taken > 0 || shortfall > 0) {
    const reason = `${original.order_number} ${full ? '취소' : '반품'} 적립 회수${shortfall > 0 ? ` · 잔액 부족으로 ${shortfall}P 미회수` : ''}`;
    if (taken > 0) {
      changePoints({
        pharmacyId: req.pharmacyId,
        customerId: original.customer_id,
        orderId: refundOrderId,
        entryType: 'EARN_CANCEL',
        points: -taken,
        reason,
        userId: req.user.id
      });
    }
    if (shortfall > 0) audit(req, 'POINT_SHORTFALL', 'ORDER', original.id, reason);
  }
  return { target, taken, shortfall };
}

const EXPIRY_ALERT_DAYS = 90;
const NEAREST_EXPIRY_SQL =
  '(SELECT MIN(pl.expiry_date) FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0)';
const EXPIRED_SQL = `EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0
  AND pl.expiry_date < date('now', 'localtime'))`;
const EXPIRING_SQL = `EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0
  AND pl.expiry_date >= date('now', 'localtime') AND pl.expiry_date <= date('now', 'localtime', '+${EXPIRY_ALERT_DAYS} days'))`;

const POS_PRODUCT_COLUMNS = `p.id, p.product_name, p.price, p.discount_price, COALESCE(p.discount_price, p.price) AS sale_price,
  p.stock_quantity, p.status, p.barcode, COALESCE(p.product_type, 'GENERAL') AS product_type,
  p.safety_stock, p.thumbnail_url, p.category_id, c.category_name, ${NEAREST_EXPIRY_SQL} AS nearest_expiry,
  (SELECT COALESCE(SUM(pl.remaining_quantity), 0) FROM product_lots pl WHERE pl.product_id = p.id) AS lot_quantity`;

function getPosProduct(pharmacyId, id) {
  return getOne(
    `SELECT ${POS_PRODUCT_COLUMNS}
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = @id AND p.pharmacy_id = @pharmacy_id`,
    { id: Number(id), pharmacy_id: pharmacyId }
  );
}

function vanInfo(terminal) {
  const mode = terminal.van_mode === 'DEMO' ? 'DEMO' : 'MANUAL';
  return {
    mode,
    mode_label: VAN_MODES[mode],
    van_company: terminal.van_company || null,
    tid: terminal.tid || null,
    is_demo: mode === 'DEMO'
  };
}

function heldCount(pharmacyId) {
  return getOne("SELECT COUNT(*) AS count FROM pos_holds WHERE pharmacy_id = @pharmacy_id AND status = 'HELD'", {
    pharmacy_id: pharmacyId
  }).count;
}

const LOW_STOCK_SQL = "(p.stock_quantity <= 0 OR (COALESCE(p.safety_stock, 0) > 0 AND p.stock_quantity <= p.safety_stock))";

function inventoryAlerts(pharmacyId) {
  return getOne(
    `SELECT
      COUNT(CASE WHEN ${LOW_STOCK_SQL} THEN 1 END) AS low_count,
      COUNT(CASE WHEN p.stock_quantity <= 0 THEN 1 END) AS out_count,
      COUNT(CASE WHEN ${EXPIRED_SQL} THEN 1 END) AS expired_count,
      COUNT(CASE WHEN ${EXPIRING_SQL} THEN 1 END) AS expiring_count,
      ${EXPIRY_ALERT_DAYS} AS expiry_alert_days
     FROM products p
     WHERE p.pharmacy_id = @pharmacy_id AND p.status != 'HIDDEN'`,
    { pharmacy_id: pharmacyId }
  );
}

function normalizeBarcode(value) {
  const barcode = String(value ?? '').trim();
  if (!barcode) return null;
  if (barcode.length > 64 || /\s/.test(barcode)) throw new PosError('바코드 형식이 올바르지 않습니다.');
  return barcode;
}

function assertBarcodeFree(pharmacyId, barcode, exceptId = 0) {
  const duplicate = getOne(
    'SELECT id, product_name FROM products WHERE pharmacy_id = @pharmacy_id AND barcode = @barcode AND id != @id',
    { pharmacy_id: pharmacyId, barcode, id: exceptId }
  );
  if (duplicate) throw new PosError(`이미 "${duplicate.product_name}" 상품에 등록된 바코드입니다.`, 409);
}

function parseMemberCode(code) {
  const match = String(code || '').trim().match(/^(?:MAYDIN-MEMBER:)?(MD\d{10})$/i);
  return match ? match[1].toUpperCase() : null;
}

router.use(authenticate, requireRole('PHARMACY_OWNER', 'POS_STAFF'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  req.pharmacyId = req.user.pharmacy_id;
  return next();
});

router.get(
  '/context',
  handle((req) => {
    const pharmacy = getOne(
      'SELECT id, pharmacy_code, pharmacy_name, owner_name, business_number, phone, address FROM pharmacies WHERE id = @id',
      { id: req.pharmacyId }
    );
    const terminal = ensureTerminal(req.pharmacyId);
    const categories = getAll(
      `SELECT c.id, c.category_name
       FROM categories c
       WHERE c.pharmacy_id = @pharmacy_id
         AND EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.status != 'HIDDEN')
       ORDER BY c.category_name`,
      { pharmacy_id: req.pharmacyId }
    );
    return {
      pharmacy,
      user: { id: req.user.id, name: req.user.name, role: req.user.role },
      terminal,
      van: vanInfo(terminal),
      session: withSummary(findOpenSession(terminal.id)),
      today: localToday(),
      categories,
      payment_methods: PAYMENT_METHODS,
      point_policy: pointPolicy(req.pharmacyId),
      hold_count: heldCount(req.pharmacyId),
      inventory_alerts: inventoryAlerts(req.pharmacyId),
      permissions: {
        can_refund: isOwner(req),
        can_close: isOwner(req),
        can_cash_movement: isOwner(req),
        can_sell_otc: isOwner(req),
        can_view_audit: isOwner(req),
        can_register_product: isOwner(req),
        can_receive_stock: true,
        can_adjust_stock: isOwner(req),
        can_manage_van: isOwner(req)
      }
    };
  })
);

router.get(
  '/products',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const categoryId = Number(req.query.category_id) || null;
    const conditions = ["p.pharmacy_id = @pharmacy_id", "p.status != 'HIDDEN'", 'COALESCE(p.pos_sale_enabled, 1) = 1'];
    if (query) conditions.push('(p.barcode = @query OR p.product_name LIKE @like OR p.barcode LIKE @like)');
    if (categoryId) conditions.push('p.category_id = @category_id');

    const products = getAll(
      `SELECT ${POS_PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN p.barcode = @query THEN 0 ELSE 1 END, p.product_name ASC
       LIMIT 80`,
      { pharmacy_id: req.pharmacyId, query, like: `%${query}%`, category_id: categoryId }
    );
    const exact = query ? products.find((product) => product.barcode === query) : null;
    return { products, exact_match_id: exact ? exact.id : null };
  })
);

router.get(
  '/customers',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    if (!query) return { customers: [] };
    const phone = digits(query);
    const memberCode = query.match(/^M(\d+)$/i);
    const scannedCode = parseMemberCode(query);

    const customers = getAll(
      `SELECT c.id, c.name, c.phone, c.email, c.created_at, c.member_code, c.point_balance,
        COUNT(CASE WHEN o.order_type NOT IN ('POS_REFUND', 'COUNSEL') THEN o.id END) AS order_count,
        COALESCE(SUM(o.final_amount), 0) AS total_amount,
        MAX(o.created_at) AS last_order_at
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       WHERE c.pharmacy_id = @pharmacy_id
         AND (
           c.name LIKE @like
           OR (LENGTH(@phone) >= 3 AND ${PHONE_DIGITS_SQL('c.phone')} LIKE @phone_like)
           OR c.id = @member_id
           OR c.member_code = @scanned_code
         )
       GROUP BY c.id
       ORDER BY c.name ASC
       LIMIT 20`,
      {
        pharmacy_id: req.pharmacyId,
        like: `%${query}%`,
        phone,
        phone_like: `%${phone}%`,
        member_id: memberCode ? Number(memberCode[1]) : -1,
        scanned_code: scannedCode || ''
      }
    );
    return { customers };
  })
);

router.get(
  '/customers/:id',
  handle((req) => {
    const customer = getOne('SELECT id, name, phone, email, created_at, member_code, point_balance FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: Number(req.params.id),
      pharmacy_id: req.pharmacyId
    });
    if (!customer) throw new PosError('고객을 찾을 수 없습니다.', 404);
    const orders = getAll(
      `SELECT o.id, o.order_number, o.order_type, o.sales_channel, o.order_status, o.final_amount, o.created_at,
        (SELECT GROUP_CONCAT(product_name || ' ×' || quantity, ', ') FROM order_items WHERE order_id = o.id) AS items_summary
       FROM orders o
       WHERE o.customer_id = @id AND o.pharmacy_id = @pharmacy_id
       ORDER BY o.id DESC
       LIMIT 10`,
      { id: customer.id, pharmacy_id: req.pharmacyId }
    );
    return { customer, orders, membership: posBadges(req.pharmacyId, customer.id) };
  })
);

router.get(
  '/sessions/current',
  handle((req) => {
    const terminal = ensureTerminal(req.pharmacyId);
    return { terminal, session: withSummary(findOpenSession(terminal.id)) };
  })
);

router.post(
  '/sessions/open',
  handle((req, res) => {
    const openingCash = toInt(req.body.opening_cash ?? 0, '시작 시재');
    const terminal = ensureTerminal(req.pharmacyId);
    if (findOpenSession(terminal.id)) throw new PosError('이미 영업 중인 카운터입니다.', 409);

    const session = transaction(() => {
      const result = run(
        `INSERT INTO pos_sessions (pharmacy_id, terminal_id, business_date, opening_cash, opened_by)
         VALUES (@pharmacy_id, @terminal_id, date('now', 'localtime'), @opening_cash, @user_id)`,
        { pharmacy_id: req.pharmacyId, terminal_id: terminal.id, opening_cash: openingCash, user_id: req.user.id }
      );
      audit(req, 'POS_SESSION_OPEN', 'POS_SESSION', result.lastInsertRowid, `영업 시작 · 시작 시재 ${won(openingCash)}`);
      return getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: result.lastInsertRowid });
    })();

    res.status(201);
    return { session: withSummary(session) };
  })
);

router.post(
  '/sessions/:id/cash-movements',
  handle((req, res) => {
    requireOwner(req, '현금 입출금');
    const { session } = requireOpenSession(req);
    if (session.id !== Number(req.params.id)) throw new PosError('현재 영업 중인 세션이 아닙니다.', 409);

    const movementType = String(req.body.movement_type || '').toUpperCase();
    if (!['DEPOSIT', 'WITHDRAW'].includes(movementType)) throw new PosError('입금/출금 구분을 선택해 주세요.');
    const amount = toInt(req.body.amount, '금액', { min: 1 });
    const reason = cleanText(req.body.reason);
    if (!reason) throw new PosError('입출금 사유를 입력해 주세요.');

    if (movementType === 'WITHDRAW') {
      const available = sessionSummary(session).expected_cash;
      if (amount > available) throw new PosError(`현재 예상 시재(${won(available)})보다 많이 출금할 수 없습니다.`);
    }

    transaction(() => {
      const result = run(
        `INSERT INTO cash_movements (pharmacy_id, session_id, movement_type, amount, reason, created_by)
         VALUES (@pharmacy_id, @session_id, @movement_type, @amount, @reason, @user_id)`,
        {
          pharmacy_id: req.pharmacyId,
          session_id: session.id,
          movement_type: movementType,
          amount,
          reason,
          user_id: req.user.id
        }
      );
      audit(
        req,
        'POS_CASH_MOVEMENT',
        'CASH_MOVEMENT',
        result.lastInsertRowid,
        `${movementType === 'DEPOSIT' ? '현금 입금' : '현금 출금'} ${won(amount)} · ${reason}`
      );
    })();

    res.status(201);
    return { session: withSummary(getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: session.id })) };
  })
);

router.post(
  '/sessions/:id/close',
  handle((req) => {
    requireOwner(req, '일마감');
    const session = getOne('SELECT * FROM pos_sessions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: Number(req.params.id),
      pharmacy_id: req.pharmacyId
    });
    if (!session) throw new PosError('영업 세션을 찾을 수 없습니다.', 404);
    if (session.status !== 'OPEN') throw new PosError('이미 마감된 영업입니다.', 409);

    const actualCash = toInt(req.body.actual_cash, '실제 현금');
    const note = cleanText(req.body.note, 500);

    const closed = transaction(() => {
      const summary = sessionSummary(session);
      const difference = actualCash - summary.expected_cash;
      if (difference !== 0 && !note) {
        throw new PosError(`시재 차액 ${won(difference)}이(가) 있습니다. 차액 사유를 입력해 주세요.`);
      }
      const result = run(
        `UPDATE pos_sessions
         SET status = 'CLOSED', expected_cash = @expected_cash, actual_cash = @actual_cash,
             cash_difference = @difference, summary_json = @summary_json, close_note = @note,
             closed_by = @user_id, closed_at = CURRENT_TIMESTAMP
         WHERE id = @id AND status = 'OPEN'`,
        {
          id: session.id,
          expected_cash: summary.expected_cash,
          actual_cash: actualCash,
          difference,
          summary_json: JSON.stringify(summary),
          note,
          user_id: req.user.id
        }
      );
      if (result.changes === 0) throw new PosError('이미 마감된 영업입니다.', 409);
      audit(
        req,
        'POS_SESSION_CLOSE',
        'POS_SESSION',
        session.id,
        `일마감 · 순매출 ${won(summary.net_sales)} · 예상 시재 ${won(summary.expected_cash)} · 실제 ${won(actualCash)} · 차액 ${won(difference)}${note ? ` · ${note}` : ''}`
      );
      return getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: session.id });
    })();

    return { session: { ...closed, summary: JSON.parse(closed.summary_json) } };
  })
);

router.post(
  '/sales',
  handle((req, res) => {
    const { terminal, session } = requireOpenSession(req);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (rawItems.length === 0) throw new PosError('판매할 상품을 담아 주세요.');

    const merged = new Map();
    for (const raw of rawItems) {
      const productId = Number(raw.product_id);
      const quantity = toInt(raw.quantity, '수량', { min: 1, max: 999 });
      merged.set(productId, (merged.get(productId) || 0) + quantity);
    }

    const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
    const counselOrderId = req.body.counsel_order_id ? Number(req.body.counsel_order_id) : null;
    const discountAmount = toInt(req.body.discount_amount || 0, '할인 금액');
    const discountReason = cleanText(req.body.discount_reason);
    const memo = cleanText(req.body.memo, 500);

    const receipt = transaction(() => {
      const lines = [];
      for (const [productId, quantity] of merged) {
        const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
          id: productId,
          pharmacy_id: req.pharmacyId
        });
        if (!product || product.status === 'HIDDEN') throw new PosError('판매할 수 없는 상품이 포함되어 있습니다.');
        if (Number(product.pos_sale_enabled ?? 1) === 0) throw new PosError(`${product.product_name}은(는) POS 판매가 중지된 상품입니다.`);
        if (product.product_type === 'OTC' && !isOwner(req)) {
          throw new PosError(`${product.product_name}은(는) 일반의약품이라 약사(관리자) 계정으로만 판매할 수 있습니다.`, 403);
        }
        if (product.status !== 'ON_SALE' || product.stock_quantity <= 0) {
          throw new PosError(`${product.product_name}은(는) 품절 상품입니다.`);
        }
        if (product.stock_quantity < quantity) {
          throw new PosError(`${product.product_name} 재고가 부족합니다. (현재 ${product.stock_quantity}개)`);
        }
        const price = Number(product.discount_price || product.price);
        lines.push({ product, quantity, price, total: price * quantity });
      }

      const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
      if (discountAmount > subtotal) throw new PosError('할인 금액이 상품 합계보다 클 수 없습니다.');
      if (discountAmount > 0 && !discountReason) throw new PosError('할인 사유를 입력해 주세요.');
      const finalAmount = subtotal - discountAmount;
      const payments = normalizePayments(req.body.payments, finalAmount);

      let customer = null;
      if (customerId) {
        customer = getOne('SELECT * FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
          id: customerId,
          pharmacy_id: req.pharmacyId
        });
        if (!customer) throw new PosError('선택한 회원을 찾을 수 없습니다.');
      }

      let counsel = null;
      if (counselOrderId) {
        counsel = getOne(
          "SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id AND order_type = 'COUNSEL'",
          { id: counselOrderId, pharmacy_id: req.pharmacyId }
        );
        if (!counsel) throw new PosError('연결할 복약상담 예약을 찾을 수 없습니다.');
        if (!customer && counsel.customer_id) {
          customer = getOne('SELECT * FROM customers WHERE id = @id', { id: counsel.customer_id });
        }
      }

      const orderResult = run(
        `INSERT INTO orders (
          order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, delivery_fee,
          discount_amount, final_amount, payment_status, order_status, delivery_status, memo, contact_name,
          contact_phone, pos_terminal_id, pos_session_id, cashier_user_id, discount_reason, counsel_order_id
        ) VALUES (
          @order_number, @pharmacy_id, @customer_id, 'POS_SALE', 'POS', @subtotal, 0,
          @discount_amount, @final_amount, 'PAID', 'COMPLETED', 'NOT_APPLICABLE', @memo, @contact_name,
          @contact_phone, @terminal_id, @session_id, @user_id, @discount_reason, @counsel_order_id
        )`,
        {
          order_number: nextOrderNumber('POS', req.pharmacyId),
          pharmacy_id: req.pharmacyId,
          customer_id: customer ? customer.id : null,
          subtotal,
          discount_amount: discountAmount,
          final_amount: finalAmount,
          memo,
          contact_name: customer ? customer.name : null,
          contact_phone: customer ? customer.phone : null,
          terminal_id: terminal.id,
          session_id: session.id,
          user_id: req.user.id,
          discount_reason: discountAmount > 0 ? discountReason : null,
          counsel_order_id: counsel ? counsel.id : null
        }
      );
      const orderId = orderResult.lastInsertRowid;

      let discountLeft = discountAmount;
      lines.forEach((line, index) => {
        const share =
          index === lines.length - 1 ? discountLeft : subtotal > 0 ? Math.floor((line.total * discountAmount) / subtotal) : 0;
        discountLeft -= share;

        run(
          `INSERT INTO order_items (
            order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, discount_amount, discount_reason
          ) VALUES (
            @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @discount_amount, @discount_reason
          )`,
          {
            order_id: orderId,
            product_id: line.product.id,
            product_name: line.product.product_name,
            quantity: line.quantity,
            price: line.price,
            total_price: line.total,
            product_type: line.product.product_type || 'GENERAL',
            tax_type: line.product.tax_type || 'TAXABLE',
            discount_amount: share,
            discount_reason: share > 0 ? discountReason : null
          }
        );

        const stock = run(
          `UPDATE products
           SET stock_quantity = stock_quantity - @quantity,
               status = CASE WHEN stock_quantity - @quantity <= 0 THEN 'SOLD_OUT' ELSE status END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = @id AND pharmacy_id = @pharmacy_id AND stock_quantity >= @quantity`,
          { id: line.product.id, pharmacy_id: req.pharmacyId, quantity: line.quantity }
        );
        if (stock.changes === 0) throw new PosError(`${line.product.product_name} 재고가 부족합니다.`);
        logInventory(
          req,
          line.product.id,
          line.product.stock_quantity,
          line.product.stock_quantity - line.quantity,
          'POS_SALE',
          '현장 판매 재고 차감',
          orderId
        );
      });

      const policy = pointPolicy(req.pharmacyId);
      const pointsUsed = payments.filter((p) => p.method === 'POINT').reduce((sum, p) => sum + p.amount, 0);
      const eligible = pointEligibleAmount(
        getAll('SELECT total_price, discount_amount, product_type FROM order_items WHERE order_id = @id', { id: orderId })
      );
      if (pointsUsed > 0) {
        if (!customer) throw new PosError('포인트는 회원을 선택한 뒤 사용할 수 있습니다.');
        if (!policy.enabled) throw new PosError('이 약국은 포인트 사용을 중지했습니다.');
        if (pointsUsed < policy.min_use) throw new PosError(`포인트는 ${policy.min_use.toLocaleString('ko-KR')}P 이상부터 사용할 수 있습니다.`);
        if (pointsUsed > eligible) {
          throw new PosError(`일반의약품 금액은 포인트로 결제할 수 없습니다. (포인트 사용 가능 ${won(eligible)})`);
        }
      }

      insertPayments(orderId, payments, { session, terminal, userId: req.user.id, customerId: customer ? customer.id : null });

      const boost = customer ? earningContext(req.pharmacyId, customer.id, { excludeOrderId: orderId }) : null;
      const earned = customer ? calcEarn(policy, eligible, pointsUsed, boost) : 0;
      if (earned > 0) {
        const extras = [
          boost.bonus > 0 ? `${boost.grade_label} +${boost.bonus}%p` : null,
          boost.multiplier > 1 ? `생일 달 ${boost.multiplier}배` : null
        ].filter(Boolean);
        run('UPDATE orders SET points_earned = @points WHERE id = @id', { id: orderId, points: earned });
        changePoints({
          pharmacyId: req.pharmacyId,
          customerId: customer.id,
          orderId,
          entryType: 'EARN',
          points: earned,
          reason: `현장 구매 적립 ${earnRate(policy, boost)}%${extras.length ? ` (기본 ${policy.earn_rate}% · ${extras.join(' · ')})` : ''}`,
          userId: req.user.id
        });
      }
      const referral = customer
        ? grantReferralReward({ pharmacyId: req.pharmacyId, customerId: customer.id, orderId, userId: req.user.id })
        : null;

      if (counsel && COUNSEL_OPEN_STATUSES.includes(counsel.order_status)) {
        run("UPDATE orders SET order_status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", {
          id: counsel.id
        });
      }

      const methods = payments.map((p) => `${PAYMENT_METHODS[p.method]} ${won(p.amount)}`).join(' + ');
      audit(
        req,
        'POS_SALE',
        'ORDER',
        orderId,
        `현장 판매 ${won(finalAmount)} (${methods || '결제 없음'})${customer ? ` · 회원 ${customer.name}` : ' · 비회원'}${earned > 0 ? ` · 적립 ${earned}P` : ''}${referral ? ` · 추천 보상 ${referral.points}P (추천인 ${referral.referrer_name})` : ''}`
      );
      if (discountAmount > 0) {
        audit(req, 'POS_DISCOUNT', 'ORDER', orderId, `할인 ${won(discountAmount)} · 사유: ${discountReason}`);
      }

      return buildReceipt(req, orderId);
    })();

    res.status(201);
    return receipt;
  })
);

router.get(
  '/sales',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const date = assertDate(req.query.date, localToday());
    const phone = digits(query);
    const conditions = ['o.pharmacy_id = @pharmacy_id', "o.sales_channel = 'POS'"];
    if (query) {
      conditions.push(
        `(o.order_number LIKE @like OR c.name LIKE @like OR (LENGTH(@phone) >= 4 AND ${PHONE_DIGITS_SQL('c.phone')} LIKE @phone_like))`
      );
    } else {
      conditions.push("date(o.created_at, 'localtime') = @date");
    }

    const sales = getAll(
      `SELECT o.id, o.order_number, o.order_type, o.order_status, o.payment_status, o.total_product_amount,
              o.discount_amount, o.final_amount, o.created_at, o.original_order_id, o.customer_id,
              COALESCE(c.name, '비회원') AS customer_name, c.phone AS customer_phone, u.name AS cashier_name,
              orig.order_number AS original_order_number,
              (SELECT GROUP_CONCAT(DISTINCT payment_method) FROM payments WHERE order_id = o.id) AS payment_methods,
              (SELECT GROUP_CONCAT(product_name || ' ×' || ABS(quantity), ', ') FROM order_items WHERE order_id = o.id) AS items_summary
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = o.cashier_user_id
       LEFT JOIN orders orig ON orig.id = o.original_order_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY o.id DESC
       LIMIT 200`,
      { pharmacy_id: req.pharmacyId, date, like: `%${query}%`, phone, phone_like: `%${phone}%` }
    );
    return { date, sales };
  })
);

router.get(
  '/sales/:id',
  handle((req) => buildReceipt(req, req.params.id))
);

router.post(
  '/sales/:id/reprint',
  handle((req) => {
    const receipt = buildReceipt(req, req.params.id);
    audit(req, 'POS_RECEIPT_REPRINT', 'ORDER', receipt.order.id, `영수증 재출력 · ${receipt.order.order_number}`);
    return receipt;
  })
);

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
        van_original:
          payment.payment_provider === 'VAN_DEMO'
            ? { approval_number: payment.approval_number, card_company: payment.card_company }
            : null
      }));

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
      return { refund: buildReceipt(req, refundOrderId), original: buildReceipt(req, original.id) };
    })();

    return receipt;
  })
);

router.post(
  '/sales/:id/refunds',
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
      payments = attachVanOriginals(original.id, payments);

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
      return { refund: buildReceipt(req, refundOrderId), original: buildReceipt(req, original.id) };
    })();

    res.status(201);
    return result;
  })
);

router.get(
  '/pickups',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const scope = req.query.scope === 'all' ? 'all' : 'pending';
    const phone = digits(query);
    const conditions = ['o.pharmacy_id = @pharmacy_id', "o.order_type = 'PICKUP'"];
    if (scope === 'pending') conditions.push(`o.order_status NOT IN ('${PICKUP_DONE_STATUSES.join("','")}')`);
    if (query) {
      conditions.push(
        `(o.order_number LIKE @like OR c.name LIKE @like OR o.contact_name LIKE @like
          OR (LENGTH(@phone) >= 4 AND (${PHONE_DIGITS_SQL('c.phone')} LIKE @phone_like OR ${PHONE_DIGITS_SQL('o.contact_phone')} LIKE @phone_like)))`
      );
    }

    const pickups = getAll(
      `SELECT o.*, COALESCE(c.name, o.contact_name) AS customer_name, c.phone AS customer_phone,
        (SELECT GROUP_CONCAT(product_name || ' ×' || quantity, ', ') FROM order_items WHERE order_id = o.id) AS items_summary,
        u.name AS picked_up_by_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users u ON u.id = o.picked_up_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN o.order_status IN ('${PICKUP_DONE_STATUSES.join("','")}') THEN 1 ELSE 0 END,
                COALESCE(o.preferred_at, o.created_at) ASC
       LIMIT 100`,
      { pharmacy_id: req.pharmacyId, like: `%${query}%`, phone, phone_like: `%${phone}%` }
    );
    return { pickups };
  })
);

router.get(
  '/pickups/:id',
  handle((req) => {
    const order = getOne(
      `SELECT o.*, COALESCE(c.name, o.contact_name) AS customer_name, c.phone AS customer_phone
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = @id AND o.pharmacy_id = @pharmacy_id AND o.order_type = 'PICKUP'`,
      { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
    );
    if (!order) throw new PosError('픽업 주문을 찾을 수 없습니다.', 404);
    const items = getAll('SELECT * FROM order_items WHERE order_id = @id ORDER BY id ASC', { id: order.id });
    const payments = getAll('SELECT * FROM payments WHERE order_id = @id ORDER BY id ASC', { id: order.id });
    return { order, items, payments };
  })
);

router.post(
  '/pickups/:id/complete',
  handle((req) => {
    const result = transaction(() => {
      const order = getOne(
        "SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id AND order_type = 'PICKUP'",
        { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
      );
      if (!order) throw new PosError('픽업 주문을 찾을 수 없습니다.', 404);
      if (PICKUP_DONE_STATUSES.includes(order.order_status)) throw new PosError('이미 수령 완료되었거나 취소된 주문입니다.', 409);

      let counterPayment = null;
      if (order.payment_status !== 'PAID') {
        const { terminal, session } = requireOpenSession(req);
        const payments = normalizePayments(req.body.payments, order.final_amount, { allowPoint: false });
        insertPayments(order.id, payments, { session, terminal, userId: req.user.id });
        run(
          `UPDATE orders
           SET payment_status = 'PAID', sales_channel = 'PICKUP_COUNTER', pos_terminal_id = @terminal_id,
               pos_session_id = @session_id, cashier_user_id = @user_id
           WHERE id = @id`,
          { id: order.id, terminal_id: terminal.id, session_id: session.id, user_id: req.user.id }
        );
        counterPayment = payments;
      }

      const updated = run(
        `UPDATE orders
         SET order_status = 'PICKED_UP', delivery_status = 'PICKED_UP', picked_up_at = CURRENT_TIMESTAMP,
             picked_up_by = @user_id, updated_at = CURRENT_TIMESTAMP
         WHERE id = @id AND order_status NOT IN ('${PICKUP_DONE_STATUSES.join("','")}')`,
        { id: order.id, user_id: req.user.id }
      );
      if (updated.changes === 0) throw new PosError('이미 수령 완료된 주문입니다.', 409);

      audit(
        req,
        'POS_PICKUP_COMPLETE',
        'ORDER',
        order.id,
        `픽업 수령 완료 ${order.order_number}${counterPayment ? ` · 카운터 결제 ${won(order.final_amount)}` : ''}`
      );
      return getOne('SELECT * FROM orders WHERE id = @id', { id: order.id });
    })();
    return { order: result };
  })
);

router.get(
  '/counsels',
  handle((req) => {
    const scope = req.query.scope === 'all' ? 'all' : 'pending';
    const conditions = ['o.pharmacy_id = @pharmacy_id', "o.order_type = 'COUNSEL'"];
    if (scope === 'pending') conditions.push(`o.order_status IN ('${COUNSEL_OPEN_STATUSES.join("','")}')`);
    const counsels = getAll(
      `SELECT o.id, o.order_number, o.order_status, o.preferred_at, o.memo, o.contact_name, o.contact_phone,
              o.customer_id, o.created_at, c.name AS customer_name, c.phone AS customer_phone,
              (SELECT order_number FROM orders s WHERE s.counsel_order_id = o.id ORDER BY s.id DESC LIMIT 1) AS linked_sale_number
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(o.preferred_at, o.created_at) ASC
       LIMIT 100`,
      { pharmacy_id: req.pharmacyId }
    );
    return { counsels };
  })
);

router.post(
  '/counsels/:id/complete',
  handle((req) => {
    const counsel = getOne(
      "SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id AND order_type = 'COUNSEL'",
      { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
    );
    if (!counsel) throw new PosError('복약상담 예약을 찾을 수 없습니다.', 404);
    if (!COUNSEL_OPEN_STATUSES.includes(counsel.order_status)) throw new PosError('이미 완료된 상담입니다.', 409);
    transaction(() => {
      run("UPDATE orders SET order_status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: counsel.id });
      audit(req, 'POS_COUNSEL_COMPLETE', 'ORDER', counsel.id, `복약상담 완료 ${counsel.order_number} (구매 없음)`);
    })();
    return { ok: true };
  })
);

router.get(
  '/reports/daily',
  handle((req) => {
    const today = localToday();
    const from = assertDate(req.query.from || req.query.date, today);
    const to = assertDate(req.query.to || req.query.date, from);
    if (from > to) throw new PosError('조회 시작일이 종료일보다 늦습니다.');
    const params = { pharmacy_id: req.pharmacyId, from, to };
    const inRange = (column) => `date(${column}, 'localtime') BETWEEN @from AND @to`;

    const channels = getAll(
      `SELECT COALESCE(sales_channel, 'ONLINE') AS channel,
        COUNT(CASE WHEN final_amount > 0 THEN 1 END) AS order_count,
        COALESCE(SUM(CASE WHEN final_amount > 0 THEN final_amount ELSE 0 END), 0) AS gross_amount,
        COALESCE(SUM(CASE WHEN final_amount < 0 THEN final_amount ELSE 0 END), 0) AS refund_amount,
        COALESCE(SUM(final_amount), 0) AS net_amount
       FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_type != 'COUNSEL' AND ${inRange('created_at')}
       GROUP BY COALESCE(sales_channel, 'ONLINE')
       ORDER BY net_amount DESC`,
      params
    );

    const payments = getAll(
      `SELECT p.payment_method,
        COUNT(CASE WHEN p.paid_amount > 0 THEN 1 END) AS pay_count,
        COALESCE(SUM(CASE WHEN p.paid_amount > 0 THEN p.paid_amount ELSE 0 END), 0) AS paid_amount,
        COALESCE(SUM(CASE WHEN p.paid_amount < 0 THEN p.paid_amount ELSE 0 END), 0) AS refunded_amount,
        COALESCE(SUM(p.paid_amount), 0) AS net_amount
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.pharmacy_id = @pharmacy_id AND p.payment_method != 'NONE'
         AND ${inRange('COALESCE(p.paid_at, o.created_at)')}
       GROUP BY p.payment_method
       ORDER BY net_amount DESC`,
      params
    );

    const cashiers = getAll(
      `SELECT o.cashier_user_id, COALESCE(u.name, '-') AS cashier_name,
        COUNT(CASE WHEN o.order_type = 'POS_SALE' THEN 1 END) AS sale_count,
        COUNT(CASE WHEN o.order_type = 'POS_REFUND' THEN 1 END) AS refund_count,
        COALESCE(SUM(o.final_amount), 0) AS net_amount,
        COALESCE(SUM(CASE WHEN o.order_type = 'POS_SALE' THEN o.discount_amount ELSE 0 END), 0) AS discount_amount
       FROM orders o
       LEFT JOIN users u ON u.id = o.cashier_user_id
       WHERE o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS' AND ${inRange('o.created_at')}
       GROUP BY o.cashier_user_id
       ORDER BY net_amount DESC`,
      params
    );

    const products = getAll(
      `SELECT oi.product_id, oi.product_name, COALESCE(oi.product_type, 'GENERAL') AS product_type,
        SUM(oi.quantity) AS net_quantity,
        SUM(oi.total_price - COALESCE(oi.discount_amount, 0)) AS net_amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS' AND ${inRange('o.created_at')}
       GROUP BY oi.product_id
       HAVING SUM(oi.quantity) != 0 OR SUM(oi.total_price) != 0
       ORDER BY net_amount DESC
       LIMIT 20`,
      params
    );

    const totals = getOne(
      `SELECT
        COALESCE(SUM(final_amount), 0) AS net_amount,
        COALESCE(SUM(CASE WHEN sales_channel = 'POS' THEN final_amount ELSE 0 END), 0) AS pos_net_amount,
        COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN discount_amount ELSE 0 END), 0) AS discount_amount,
        COUNT(CASE WHEN order_type = 'POS_SALE' THEN 1 END) AS pos_sale_count,
        COUNT(CASE WHEN order_type = 'POS_REFUND' THEN 1 END) AS pos_refund_count,
        COALESCE(SUM(CASE WHEN order_type = 'POS_REFUND' THEN final_amount ELSE 0 END), 0) AS pos_refund_amount
       FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_type != 'COUNSEL' AND ${inRange('created_at')}`,
      params
    );

    const sessions = getAll(
      `SELECT s.id, s.business_date, s.status, s.opening_cash, s.expected_cash, s.actual_cash, s.cash_difference,
              s.close_note, s.opened_at, s.closed_at, t.terminal_name,
              uo.name AS opened_by_name, uc.name AS closed_by_name
       FROM pos_sessions s
       JOIN pos_terminals t ON t.id = s.terminal_id
       LEFT JOIN users uo ON uo.id = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.pharmacy_id = @pharmacy_id AND s.business_date BETWEEN @from AND @to
       ORDER BY s.id DESC`,
      params
    );

    return { from, to, totals, channels, payments, cashiers, products, sessions };
  })
);

router.get(
  '/audit-logs',
  handle((req) => {
    requireOwner(req, '감사 로그 조회');
    const logs = getAll(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.description, l.created_at, u.name AS user_name, u.role AS user_role
       FROM admin_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.pharmacy_id = @pharmacy_id
         AND (l.action GLOB 'POS_*' OR l.action GLOB 'POINT_*' OR l.action GLOB 'PO_*' OR l.action GLOB 'SUPPLIER_*')
       ORDER BY l.id DESC
       LIMIT 150`,
      { pharmacy_id: req.pharmacyId }
    );
    return { logs };
  })
);

/* ---------- 통합 스캔 · 바코드 등록 ---------- */

router.get(
  '/scan',
  handle((req) => {
    const code = String(req.query.code || '').trim();
    if (!code) throw new PosError('스캔한 코드가 없습니다.');

    const product = getOne(
      `SELECT ${POS_PRODUCT_COLUMNS}
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.pharmacy_id = @pharmacy_id AND p.barcode = @code AND p.status != 'HIDDEN'`,
      { pharmacy_id: req.pharmacyId, code }
    );
    if (product) return { type: 'PRODUCT', code, product };

    const memberCode = parseMemberCode(code);
    if (memberCode) {
      const customer = getOne('SELECT id, name FROM customers WHERE pharmacy_id = @pharmacy_id AND member_code = @code', {
        pharmacy_id: req.pharmacyId,
        code: memberCode
      });
      if (customer) return { type: 'CUSTOMER', code, customer_id: customer.id, customer_name: customer.name };
      return { type: 'UNKNOWN', code, message: '우리 약국 회원이 아니거나 없는 회원 코드입니다.' };
    }

    const order = getOne(
      `SELECT id, order_number, order_type, sales_channel FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_number = @code COLLATE NOCASE`,
      { pharmacy_id: req.pharmacyId, code }
    );
    if (order) {
      if (order.sales_channel === 'POS') return { type: 'SALE', code, order_id: order.id };
      if (order.order_type === 'PICKUP') return { type: 'PICKUP', code, order_id: order.id };
      return { type: 'ORDER', code, order_id: order.id, message: `${order.order_number}은(는) 온라인 주문입니다. 파트너센터에서 확인하세요.` };
    }

    const hidden = getOne(
      "SELECT product_name FROM products WHERE pharmacy_id = @pharmacy_id AND barcode = @code AND status = 'HIDDEN'",
      { pharmacy_id: req.pharmacyId, code }
    );
    if (hidden) return { type: 'UNKNOWN', code, message: `"${hidden.product_name}"은(는) 숨김 처리된 상품입니다. 파트너센터에서 판매 상태를 바꿔 주세요.` };

    return { type: 'UNKNOWN', code, registrable: /^[0-9A-Za-z-]{4,64}$/.test(code) };
  })
);

router.post(
  '/products/quick',
  handle((req, res) => {
    requireOwner(req, '상품 등록');
    const productName = cleanText(req.body.product_name, 100);
    if (!productName) throw new PosError('상품명을 입력해 주세요.');
    const price = toInt(req.body.price, '판매가', { min: 0, max: 10000000 });
    const stock = toInt(req.body.stock_quantity ?? 0, '재고', { min: 0, max: 100000 });
    const safetyStock = toInt(req.body.safety_stock ?? 0, '안전재고', { min: 0, max: 100000 });
    const productType = String(req.body.product_type || 'GENERAL').toUpperCase();
    if (!['GENERAL', 'OTC'].includes(productType)) throw new PosError('상품 유형이 올바르지 않습니다.');
    const taxType = String(req.body.tax_type || 'TAXABLE').toUpperCase();
    if (!['TAXABLE', 'EXEMPT'].includes(taxType)) throw new PosError('과세 구분이 올바르지 않습니다.');
    const barcode = normalizeBarcode(req.body.barcode);
    if (!barcode) throw new PosError('바코드를 입력해 주세요.');
    const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
    const lot = stock > 0 ? parseLotInput(req.body) : null;

    const product = transaction(() => {
      assertBarcodeFree(req.pharmacyId, barcode);
      if (categoryId) {
        const category = getOne('SELECT id FROM categories WHERE id = @id AND pharmacy_id = @pharmacy_id', {
          id: categoryId,
          pharmacy_id: req.pharmacyId
        });
        if (!category) throw new PosError('카테고리를 찾을 수 없습니다.');
      }
      const result = run(
        `INSERT INTO products (
          pharmacy_id, category_id, product_name, price, stock_quantity, status, barcode, product_type, tax_type, safety_stock, pos_sale_enabled
        ) VALUES (
          @pharmacy_id, @category_id, @product_name, @price, @stock, @status, @barcode, @product_type, @tax_type, @safety_stock, 1
        )`,
        {
          pharmacy_id: req.pharmacyId,
          category_id: categoryId,
          product_name: productName,
          price,
          stock,
          status: stock > 0 ? 'ON_SALE' : 'SOLD_OUT',
          barcode,
          product_type: productType,
          tax_type: taxType,
          safety_stock: safetyStock
        }
      );
      const id = result.lastInsertRowid;
      if (stock > 0) {
        insertLot({ pharmacyId: req.pharmacyId, productId: id, quantity: stock, lot, userId: req.user.id });
        logStock(req, id, 0, stock, 'RECEIVE', lot ? `POS 신규 등록 입고 · ${lotLabel(lot)}` : 'POS 신규 등록 입고');
      }
      audit(req, 'POS_PRODUCT_CREATE', 'PRODUCT', id, `POS 신규 상품 등록 · ${productName} · ${won(price)} · 바코드 ${barcode}`);
      return getPosProduct(req.pharmacyId, id);
    })();

    res.status(201);
    return { product };
  })
);

router.post(
  '/products/:id/barcode',
  handle((req) => {
    requireOwner(req, '바코드 연결');
    const barcode = normalizeBarcode(req.body.barcode);
    if (!barcode) throw new PosError('바코드를 입력해 주세요.');
    const product = transaction(() => {
      const current = getOne("SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'", {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!current) throw new PosError('상품을 찾을 수 없습니다.', 404);
      assertBarcodeFree(req.pharmacyId, barcode, current.id);
      run('UPDATE products SET barcode = @barcode, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: current.id, barcode });
      audit(
        req,
        'POS_BARCODE_LINK',
        'PRODUCT',
        current.id,
        `바코드 연결 · ${current.product_name} · ${current.barcode ? `${current.barcode} → ` : ''}${barcode}`
      );
      return getPosProduct(req.pharmacyId, current.id);
    })();
    return { product };
  })
);

/* ---------- 보류 판매 ---------- */

function serializeHold(row) {
  return { ...row, items: JSON.parse(row.items_json || '[]'), items_json: undefined };
}

function holdRows(pharmacyId) {
  return getAll(
    `SELECT h.*, c.name AS customer_name, u.name AS created_by_name, o.order_number AS counsel_order_number
     FROM pos_holds h
     LEFT JOIN customers c ON c.id = h.customer_id
     LEFT JOIN users u ON u.id = h.created_by
     LEFT JOIN orders o ON o.id = h.counsel_order_id
     WHERE h.pharmacy_id = @pharmacy_id AND h.status = 'HELD'
     ORDER BY h.id ASC`,
    { pharmacy_id: pharmacyId }
  ).map(serializeHold);
}

router.get(
  '/holds',
  handle((req) => ({ holds: holdRows(req.pharmacyId) }))
);

router.post(
  '/holds',
  handle((req, res) => {
    const { terminal, session } = requireOpenSession(req);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (rawItems.length === 0) throw new PosError('보류할 상품이 없습니다.');
    if (heldCount(req.pharmacyId) >= 30) throw new PosError('보류는 최대 30건까지 가능합니다. 오래된 보류를 정리해 주세요.');

    const merged = new Map();
    for (const raw of rawItems) {
      const productId = Number(raw.product_id);
      merged.set(productId, (merged.get(productId) || 0) + toInt(raw.quantity, '수량', { min: 1, max: 999 }));
    }

    const hold = transaction(() => {
      const items = [];
      for (const [productId, quantity] of merged) {
        const product = getPosProduct(req.pharmacyId, productId);
        if (!product) throw new PosError('보류할 수 없는 상품이 포함되어 있습니다.');
        items.push({ product_id: product.id, product_name: product.product_name, quantity, sale_price: product.sale_price });
      }
      const total = items.reduce((sum, item) => sum + item.sale_price * item.quantity, 0);
      const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
      if (customerId && !getOne('SELECT id FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: customerId, pharmacy_id: req.pharmacyId })) {
        throw new PosError('선택한 회원을 찾을 수 없습니다.');
      }
      const counselId = req.body.counsel_order_id ? Number(req.body.counsel_order_id) : null;
      const discountAmount = Math.min(toInt(req.body.discount_amount || 0, '할인 금액'), total);
      const holdNumber =
        getOne(
          `SELECT COALESCE(MAX(hold_number), 0) + 1 AS next FROM pos_holds
           WHERE pharmacy_id = @pharmacy_id AND date(created_at, 'localtime') = date('now', 'localtime')`,
          { pharmacy_id: req.pharmacyId }
        ).next;

      const result = run(
        `INSERT INTO pos_holds (
          pharmacy_id, terminal_id, session_id, hold_number, label, customer_id, counsel_order_id, items_json,
          item_count, total_amount, discount_amount, discount_reason, created_by
        ) VALUES (
          @pharmacy_id, @terminal_id, @session_id, @hold_number, @label, @customer_id, @counsel_order_id, @items_json,
          @item_count, @total_amount, @discount_amount, @discount_reason, @user_id
        )`,
        {
          pharmacy_id: req.pharmacyId,
          terminal_id: terminal.id,
          session_id: session.id,
          hold_number: holdNumber,
          label: cleanText(req.body.label, 30),
          customer_id: customerId,
          counsel_order_id: counselId,
          items_json: JSON.stringify(items),
          item_count: items.reduce((sum, item) => sum + item.quantity, 0),
          total_amount: total,
          discount_amount: discountAmount,
          discount_reason: discountAmount > 0 ? cleanText(req.body.discount_reason) : null,
          user_id: req.user.id
        }
      );
      audit(req, 'POS_HOLD', 'POS_HOLD', result.lastInsertRowid, `판매 보류 #${holdNumber} · ${items.length}종 ${won(total)}`);
      return holdRows(req.pharmacyId).find((row) => row.id === result.lastInsertRowid);
    })();

    res.status(201);
    return { hold, hold_count: heldCount(req.pharmacyId) };
  })
);

router.post(
  '/holds/:id/recall',
  handle((req) => {
    const result = transaction(() => {
      const hold = getOne("SELECT * FROM pos_holds WHERE id = @id AND pharmacy_id = @pharmacy_id", {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!hold) throw new PosError('보류 내역을 찾을 수 없습니다.', 404);
      if (hold.status !== 'HELD') throw new PosError('이미 불러왔거나 폐기된 보류입니다.', 409);

      const warnings = [];
      const items = [];
      for (const saved of JSON.parse(hold.items_json)) {
        const product = getPosProduct(req.pharmacyId, saved.product_id);
        if (!product || product.status === 'HIDDEN') {
          warnings.push(`${saved.product_name}: 판매 중지되어 제외했습니다.`);
          continue;
        }
        if (product.status !== 'ON_SALE' || product.stock_quantity <= 0) {
          warnings.push(`${product.product_name}: 품절되어 제외했습니다.`);
          continue;
        }
        let quantity = saved.quantity;
        if (product.stock_quantity < quantity) {
          warnings.push(`${product.product_name}: 재고가 ${product.stock_quantity}개라 수량을 줄였습니다.`);
          quantity = product.stock_quantity;
        }
        if (product.sale_price !== saved.sale_price) {
          warnings.push(`${product.product_name}: 가격이 ${won(saved.sale_price)} → ${won(product.sale_price)}(으)로 바뀌었습니다.`);
        }
        items.push({ product, quantity });
      }

      const customer = hold.customer_id
        ? getOne('SELECT id, name, phone, member_code FROM customers WHERE id = @id', { id: hold.customer_id })
        : null;
      const counsel = hold.counsel_order_id
        ? getOne("SELECT id, order_number, customer_id FROM orders WHERE id = @id AND order_type = 'COUNSEL'", { id: hold.counsel_order_id })
        : null;

      run(
        "UPDATE pos_holds SET status = 'RECALLED', resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'HELD'",
        { id: hold.id, user_id: req.user.id }
      );
      audit(req, 'POS_HOLD_RECALL', 'POS_HOLD', hold.id, `보류 불러오기 #${hold.hold_number}${warnings.length ? ` · 변경 ${warnings.length}건` : ''}`);
      return {
        hold: serializeHold(hold),
        items,
        customer,
        counsel,
        discount: { amount: hold.discount_amount, reason: hold.discount_reason || '' },
        warnings
      };
    })();
    return { ...result, hold_count: heldCount(req.pharmacyId) };
  })
);

router.post(
  '/holds/:id/discard',
  handle((req) => {
    transaction(() => {
      const hold = getOne('SELECT * FROM pos_holds WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!hold) throw new PosError('보류 내역을 찾을 수 없습니다.', 404);
      if (hold.status !== 'HELD') throw new PosError('이미 불러왔거나 폐기된 보류입니다.', 409);
      run(
        "UPDATE pos_holds SET status = 'DISCARDED', resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP WHERE id = @id",
        { id: hold.id, user_id: req.user.id }
      );
      audit(req, 'POS_HOLD_DISCARD', 'POS_HOLD', hold.id, `보류 폐기 #${hold.hold_number} · ${won(hold.total_amount)}`);
    })();
    return { ok: true, hold_count: heldCount(req.pharmacyId) };
  })
);

/* ---------- 재고 처리 ---------- */

const STOCK_ADJUST_TYPES = {
  RECEIVE: { label: '입고', logType: 'RECEIVE', action: 'POS_STOCK_RECEIVE' },
  DISPOSE: { label: '폐기', logType: 'DISPOSE', action: 'POS_STOCK_DISPOSE' },
  COUNT: { label: '실사 조정', logType: 'COUNT_ADJUST', action: 'POS_STOCK_COUNT' }
};

function activeLots(productId) {
  return getAll(
    `SELECT id, lot_number, expiry_date, received_quantity, remaining_quantity, created_at,
            CAST(julianday(expiry_date) - julianday(date('now', 'localtime')) AS INTEGER) AS days_left
     FROM product_lots
     WHERE product_id = @id AND remaining_quantity > 0
     ORDER BY expiry_date ASC, id ASC`,
    { id: productId }
  );
}

function logStock(req, productId, before, after, changeType, reason) {
  run(
    `INSERT INTO inventory_logs (
      pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type
    ) VALUES (
      @pharmacy_id, @product_id, @change_type, @before, @after, @reason, @user_id, 'MANUAL'
    )`,
    { pharmacy_id: req.pharmacyId, product_id: productId, change_type: changeType, before, after, reason, user_id: req.user.id }
  );
}

router.get(
  '/inventory',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const filter = ['low', 'out', 'expiring', 'expired'].includes(req.query.filter) ? req.query.filter : 'all';
    const conditions = ['p.pharmacy_id = @pharmacy_id', "p.status != 'HIDDEN'"];
    if (query) conditions.push('(p.barcode = @query OR p.product_name LIKE @like OR p.barcode LIKE @like)');
    if (filter === 'low') conditions.push(LOW_STOCK_SQL);
    if (filter === 'out') conditions.push('p.stock_quantity <= 0');
    if (filter === 'expiring') conditions.push(EXPIRING_SQL);
    if (filter === 'expired') conditions.push(EXPIRED_SQL);
    const order = ['expiring', 'expired'].includes(filter) ? 'nearest_expiry ASC, p.product_name ASC' : 'is_low DESC, p.product_name ASC';

    const products = getAll(
      `SELECT ${POS_PRODUCT_COLUMNS}, p.cost_price,
        CASE WHEN ${LOW_STOCK_SQL} THEN 1 ELSE 0 END AS is_low,
        CASE WHEN ${EXPIRED_SQL} THEN 1 ELSE 0 END AS has_expired,
        (SELECT MAX(created_at) FROM inventory_logs l WHERE l.product_id = p.id) AS last_changed_at
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN p.barcode = @query THEN 0 ELSE 1 END, ${order}
       LIMIT 200`,
      { pharmacy_id: req.pharmacyId, query, like: `%${query}%` }
    );
    const exact = query ? products.find((product) => product.barcode === query) : null;
    return { products, exact_match_id: exact ? exact.id : null, alerts: inventoryAlerts(req.pharmacyId) };
  })
);

router.get(
  '/inventory/products/:id/logs',
  handle((req) => {
    const product = getPosProduct(req.pharmacyId, req.params.id);
    if (!product) throw new PosError('상품을 찾을 수 없습니다.', 404);
    const logs = getAll(
      `SELECT l.id, l.change_type, l.quantity_before, l.quantity_after, l.reason, l.created_at, l.reference_type,
              l.reference_id, u.name AS created_by_name
       FROM inventory_logs l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.product_id = @id AND l.pharmacy_id = @pharmacy_id
       ORDER BY l.id DESC
       LIMIT 60`,
      { id: product.id, pharmacy_id: req.pharmacyId }
    );
    return { product, logs, lots: activeLots(product.id), expiry_alert_days: EXPIRY_ALERT_DAYS };
  })
);

router.post(
  '/inventory/adjust',
  handle((req, res) => {
    const type = String(req.body.adjust_type || '').toUpperCase();
    const config = STOCK_ADJUST_TYPES[type];
    if (!config) throw new PosError('입고·폐기·실사 조정 중 하나를 선택해 주세요.');
    if (type !== 'RECEIVE') requireOwner(req, config.label);
    const reason = cleanText(req.body.reason);
    const lot = type === 'RECEIVE' ? parseLotInput(req.body) : null;
    const lotId = type === 'DISPOSE' && req.body.lot_id ? Number(req.body.lot_id) : null;

    const product = transaction(() => {
      const current = getOne("SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'", {
        id: Number(req.body.product_id),
        pharmacy_id: req.pharmacyId
      });
      if (!current) throw new PosError('상품을 찾을 수 없습니다.', 404);
      const before = current.stock_quantity;
      let after;
      let lotNote = '';
      if (type === 'RECEIVE') {
        const quantity = toInt(req.body.quantity, '입고 수량', { min: 1, max: 100000 });
        after = before + quantity;
        if (lot) {
          insertLot({ pharmacyId: req.pharmacyId, productId: current.id, quantity, lot, userId: req.user.id });
          lotNote = lotLabel(lot);
        }
      } else if (type === 'DISPOSE') {
        const quantity = toInt(req.body.quantity, '폐기 수량', { min: 1, max: 100000 });
        if (quantity > before) throw new PosError(`현재 재고(${before}개)보다 많이 폐기할 수 없습니다.`);
        if (!reason) throw new PosError('폐기 사유를 입력해 주세요.');
        if (lotId) {
          const target = getOne('SELECT * FROM product_lots WHERE id = @id AND product_id = @product_id', {
            id: lotId,
            product_id: current.id
          });
          if (!target || target.remaining_quantity <= 0) throw new PosError('폐기할 로트를 찾을 수 없습니다.', 404);
          if (quantity > target.remaining_quantity) {
            throw new PosError(`선택한 로트의 남은 수량(${target.remaining_quantity}개)보다 많이 폐기할 수 없습니다.`);
          }
          // 재고보다 먼저 로트를 줄여야 트리거가 다른 로트를 건드리지 않는다.
          run(
            `UPDATE product_lots SET remaining_quantity = remaining_quantity - @quantity, updated_at = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: target.id, quantity }
          );
          lotNote = lotLabel(target);
        }
        after = before - quantity;
      } else {
        after = toInt(req.body.quantity, '실사 수량', { min: 0, max: 100000 });
        if (after !== before && !reason) throw new PosError('실사 차이가 있으면 조정 사유를 입력해 주세요.');
      }

      run(
        `UPDATE products
         SET stock_quantity = @after,
             status = CASE
               WHEN @after > 0 AND status = 'SOLD_OUT' THEN 'ON_SALE'
               WHEN @after <= 0 AND status = 'ON_SALE' THEN 'SOLD_OUT'
               ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id AND stock_quantity = @before`,
        { id: current.id, before, after }
      );
      const baseReason = reason || (type === 'RECEIVE' ? '입고' : '실사 확인 (차이 없음)');
      const finalReason = lotNote ? `${baseReason} · ${lotNote}` : baseReason;
      logStock(req, current.id, before, after, config.logType, finalReason);
      audit(
        req,
        config.action,
        'PRODUCT',
        current.id,
        `${config.label} · ${current.product_name} · ${before} → ${after} (${after - before >= 0 ? '+' : ''}${after - before}) · ${finalReason}`
      );
      return getPosProduct(req.pharmacyId, current.id);
    })();

    res.status(201);
    return { product, lots: activeLots(product.id), alerts: inventoryAlerts(req.pharmacyId) };
  })
);

router.patch(
  '/inventory/products/:id/safety-stock',
  handle((req) => {
    requireOwner(req, '안전재고 설정');
    const safetyStock = toInt(req.body.safety_stock, '안전재고', { min: 0, max: 100000 });
    const product = getPosProduct(req.pharmacyId, req.params.id);
    if (!product) throw new PosError('상품을 찾을 수 없습니다.', 404);
    transaction(() => {
      run('UPDATE products SET safety_stock = @safety_stock, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
        id: product.id,
        safety_stock: safetyStock
      });
      audit(req, 'POS_SAFETY_STOCK', 'PRODUCT', product.id, `안전재고 설정 · ${product.product_name} · ${product.safety_stock || 0} → ${safetyStock}`);
    })();
    return { product: getPosProduct(req.pharmacyId, product.id), alerts: inventoryAlerts(req.pharmacyId) };
  })
);

/* ---------- VAN 연동 (데모) ---------- */

function recordVan(req, terminal, fields) {
  const result = run(
    `INSERT INTO van_transactions (
      pharmacy_id, terminal_id, van_company, tid, transaction_type, payment_method, amount, installment_months,
      approval_number, card_company, masked_identity, status, is_demo, message, created_by
    ) VALUES (
      @pharmacy_id, @terminal_id, @van_company, @tid, @transaction_type, @payment_method, @amount, @installment_months,
      @approval_number, @card_company, @masked_identity, @status, 1, @message, @created_by
    )`,
    {
      pharmacy_id: req.pharmacyId,
      terminal_id: terminal.id,
      van_company: terminal.van_company || null,
      tid: terminal.tid || null,
      installment_months: 0,
      card_company: null,
      masked_identity: null,
      created_by: req.user.id,
      ...fields
    }
  );
  return getOne('SELECT * FROM van_transactions WHERE id = @id', { id: result.lastInsertRowid });
}

function requireVanAdapter(req) {
  const { terminal, session } = requireOpenSession(req);
  const adapter = adapterFor(terminal);
  if (!adapter) throw new PosError('단말기가 카드 수동 승인 모드입니다. 단말기 설정에서 VAN 자동 승인(데모)을 켜 주세요.', 409);
  return { terminal, session, adapter };
}

router.get(
  '/van/terminal',
  handle((req) => {
    const terminal = ensureTerminal(req.pharmacyId);
    const transactions = getAll(
      `SELECT v.*, u.name AS created_by_name, o.order_number
       FROM van_transactions v
       LEFT JOIN users u ON u.id = v.created_by
       LEFT JOIN orders o ON o.id = v.order_id
       WHERE v.pharmacy_id = @pharmacy_id AND date(v.created_at, 'localtime') = date('now', 'localtime')
       ORDER BY v.id DESC
       LIMIT 50`,
      { pharmacy_id: req.pharmacyId }
    );
    return { terminal, van: vanInfo(terminal), van_companies: VAN_COMPANIES, modes: VAN_MODES, transactions };
  })
);

router.patch(
  '/van/terminal',
  handle((req) => {
    requireOwner(req, '단말기 설정');
    const terminal = ensureTerminal(req.pharmacyId);
    const mode = String(req.body.van_mode || terminal.van_mode || 'MANUAL').toUpperCase();
    if (!VAN_MODES[mode]) throw new PosError('승인 방식이 올바르지 않습니다.');
    const vanCompany = cleanText(req.body.van_company, 30);
    if (vanCompany && !VAN_COMPANIES.includes(vanCompany)) throw new PosError('VAN사를 목록에서 선택해 주세요.');
    const tid = cleanText(req.body.tid, 20);
    if (tid && !/^[0-9A-Za-z-]{4,20}$/.test(tid)) throw new PosError('TID는 영문·숫자 4~20자입니다.');
    const terminalName = cleanText(req.body.terminal_name, 30) || terminal.terminal_name;

    transaction(() => {
      run(
        `UPDATE pos_terminals
         SET terminal_name = @terminal_name, van_company = @van_company, tid = @tid, van_mode = @van_mode,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
        { id: terminal.id, terminal_name: terminalName, van_company: vanCompany, tid, van_mode: mode }
      );
      audit(
        req,
        'POS_VAN_SETTING',
        'POS_TERMINAL',
        terminal.id,
        `단말기 설정 · ${terminalName} · ${VAN_MODES[mode]} · ${vanCompany || 'VAN 미지정'} · TID ${tid || '-'}`
      );
    })();
    const updated = getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: terminal.id });
    return { terminal: updated, van: vanInfo(updated) };
  })
);

router.post(
  '/van/approve',
  handle((req, res) => {
    const { terminal, adapter } = requireVanAdapter(req);
    const method = String(req.body.method || '').toUpperCase();
    if (!['CARD', 'EASY_PAY'].includes(method)) throw new PosError('VAN 승인은 카드·간편결제만 가능합니다.');
    const amount = toInt(req.body.amount, '승인 금액', { min: 1, max: 100000000 });
    const installmentMonths = method === 'CARD' ? toInt(req.body.installment_months || 0, '할부 개월', { min: 0, max: 12 }) : 0;
    if (installmentMonths === 1) throw new PosError('할부는 2개월부터 선택할 수 있습니다.');

    let approval;
    try {
      approval =
        method === 'CARD'
          ? adapter.approveCard({ amount, installmentMonths })
          : adapter.approveEasyPay({ amount, barcode: req.body.barcode });
    } catch (error) {
      if (error instanceof VanError) {
        recordVan(req, terminal, {
          transaction_type: 'APPROVE',
          payment_method: method,
          amount,
          installment_months: installmentMonths,
          approval_number: '-',
          status: 'DECLINED',
          message: error.message
        });
      }
      throw error;
    }

    const tx = recordVan(req, terminal, {
      transaction_type: 'APPROVE',
      payment_method: method,
      amount,
      installment_months: installmentMonths,
      approval_number: approval.approval_number,
      card_company: approval.card_company,
      status: 'APPROVED',
      message: approval.message
    });
    res.status(201);
    return { van_transaction: tx };
  })
);

router.post(
  '/van/transactions/:id/void',
  handle((req) => {
    const tx = transaction(() => {
      const current = getOne('SELECT * FROM van_transactions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!current || current.transaction_type !== 'APPROVE') throw new PosError('VAN 승인 내역을 찾을 수 없습니다.', 404);
      if (current.status !== 'APPROVED' || current.order_id) {
        throw new PosError('판매에 사용된 승인은 거래내역에서 취소·반품으로 처리해 주세요.', 409);
      }
      run("UPDATE van_transactions SET status = 'VOIDED', message = @message WHERE id = @id", {
        id: current.id,
        message: '[데모] 판매 전 승인 취소'
      });
      return getOne('SELECT * FROM van_transactions WHERE id = @id', { id: current.id });
    })();
    return { van_transaction: tx };
  })
);

router.post(
  '/van/cash-receipt',
  handle((req, res) => {
    const { terminal, adapter } = requireVanAdapter(req);
    const amount = toInt(req.body.amount, '현금영수증 금액', { min: 1, max: 100000000 });
    const purpose = req.body.purpose === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
    const result = adapter.issueCashReceipt({ identity: req.body.identity, purpose });
    const tx = recordVan(req, terminal, {
      transaction_type: 'CASH_RECEIPT',
      payment_method: 'CASH',
      amount,
      approval_number: result.approval_number,
      masked_identity: result.masked_identity,
      status: 'APPROVED',
      message: result.message
    });
    res.status(201);
    return { van_transaction: tx };
  })
);

module.exports = router;
