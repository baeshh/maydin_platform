const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { issueSignupCode } = require('../../services/member-auth');
const { PHONE_DIGITS_SQL, PosError, assertDate, audit, digits, handle, localToday, requireOwner } = require('../common');
const { createPosSale, deserializeRequest, parseSaleRequest, priceSale, requestHash, serializeRequest } = require('../services/checkout-service');
const { orderByClientId, saveDirectSale } = require('../services/direct-sale-service');
const { assertDraftPayable, closeDraft, findDraft, publicDraft, requireClientSaleId, requireOpenDraft } = require('../services/draft-service');
const { PENDING_STATUSES, draftApprovals, publicVan } = require('../services/payment-service');
const { buildReceipt, getPosOrder } = require('../services/sale-service');
const { requireOpenSession } = require('../services/session-service');
const { requireTerminal } = require('../services/terminal-service');

const router = express.Router();

const LIVE_APPROVAL_STATUSES = [...PENDING_STATUSES, 'APPROVED'];

// 현금·계좌이체·수동 승인번호 판매와 장애 복구 판매. 카드 승인을 서버·Bridge로 받는 판매는 prepare → confirm 으로 저장한다.
router.post(
  '/sales',
  handle((req, res) => {
    const receipt = saveDirectSale(req, req.body);
    res.status(receipt.duplicate ? 200 : 201);
    return receipt;
  })
);

/* ---------- 결제 전 판매 등록 → 승인 → 확정 ---------- */

// ① 결제 전에 판매 내용을 서버에 올린다. 카드 승인은 이 판매에 묶이고, 승인이 있으면 상품·금액을 바꿀 수 없다.
router.post(
  '/sales/prepare',
  handle((req, res) => {
    const { terminal, session } = requireOpenSession(req);
    const clientSaleId = requireClientSaleId(req.body.client_sale_id);
    const pickupOrderId = req.body.pickup_order_id ? Number(req.body.pickup_order_id) : null;
    const request = pickupOrderId ? null : parseSaleRequest(req.body);
    const hash = pickupOrderId ? `PICKUP:${pickupOrderId}` : requestHash(request);

    const result = transaction(() => {
      const saved = orderByClientId(req.pharmacyId, clientSaleId);
      if (saved) return { draft: publicDraft(findDraft(req.pharmacyId, clientSaleId)), order: buildReceipt(req, saved.id) };
      let amount;
      if (pickupOrderId) {
        const pickup = getOne(
          "SELECT final_amount, payment_status FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id AND order_type = 'PICKUP'",
          { id: pickupOrderId, pharmacy_id: req.pharmacyId }
        );
        if (!pickup) throw new PosError('픽업 주문을 찾을 수 없습니다.', 404);
        if (pickup.payment_status === 'PAID') throw new PosError('이미 결제된 픽업 주문입니다.', 409);
        amount = pickup.final_amount;
      } else {
        amount = priceSale(req, request).finalAmount;
      }
      const draft = findDraft(req.pharmacyId, clientSaleId);
      const fields = {
        request_json: request ? serializeRequest(request) : null,
        request_hash: hash,
        amount,
        session_id: session.id
      };
      if (!draft) {
        run(
          `INSERT INTO pos_sale_drafts (pharmacy_id, terminal_id, session_id, client_sale_id, pickup_order_id, request_json, request_hash, amount, created_by)
           VALUES (@pharmacy_id, @terminal_id, @session_id, @client_sale_id, @pickup_order_id, @request_json, @request_hash, @amount, @user_id)`,
          {
            ...fields,
            pharmacy_id: req.pharmacyId,
            terminal_id: terminal.id,
            client_sale_id: clientSaleId,
            pickup_order_id: pickupOrderId,
            user_id: req.user.id
          }
        );
      } else {
        if (draft.terminal_id !== terminal.id) throw new PosError('다른 카운터에서 준비한 판매입니다.', 403);
        if (draft.status !== 'OPEN') throw new PosError('이미 끝난 판매입니다. 새 판매로 다시 시작해 주세요.', 409, `DRAFT_${draft.status}`);
        if (draft.request_hash !== hash) {
          const live = draftApprovals(draft.id).filter((tx) => LIVE_APPROVAL_STATUSES.includes(tx.status));
          if (live.length) {
            throw new PosError('카드 승인이 있는 판매는 상품·금액을 바꿀 수 없습니다. 승인을 취소한 뒤 다시 시도해 주세요.', 409, 'DRAFT_LOCKED', {
              approvals: live.map(publicVan)
            });
          }
          run(
            `UPDATE pos_sale_drafts SET request_json = @request_json, request_hash = @request_hash, amount = @amount, session_id = @session_id,
                    updated_at = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { ...fields, id: draft.id }
          );
        }
      }
      return { draft: publicDraft(findDraft(req.pharmacyId, clientSaleId)) };
    })();
    res.status(result.order ? 200 : 201);
    return result;
  })
);

// ③ 승인이 끝난 판매를 확정한다. 상품·금액은 prepare 때 서버에 올린 내용만 쓴다. 같은 요청을 다시 보내도 한 번만 저장된다.
router.post(
  '/sales/confirm',
  handle((req, res) => {
    const { terminal, session } = requireOpenSession(req);
    const clientSaleId = requireClientSaleId(req.body.client_sale_id);
    const receipt = transaction(() => {
      const draft = findDraft(req.pharmacyId, clientSaleId);
      if (!draft) throw new PosError('결제 준비된 판매를 찾을 수 없습니다.', 404, 'DRAFT_NOT_FOUND');
      if (draft.terminal_id !== terminal.id) throw new PosError('다른 카운터에서 준비한 판매입니다.', 403);
      if (draft.status === 'CONFIRMED') return { ...buildReceipt(req, draft.order_id), duplicate: true };
      if (draft.status !== 'OPEN') throw new PosError('취소된 판매입니다.', 409, 'DRAFT_CANCELED');
      if (draft.pickup_order_id) throw new PosError('픽업 주문 결제는 픽업 수령 완료로 저장해 주세요.', 409);
      assertDraftPayable(draft, req.body.payments);

      const { orderId, receipt: saved } = createPosSale(req, {
        terminal,
        session,
        request: deserializeRequest(draft.request_json),
        payments: req.body.payments,
        clientSaleId,
        fingerprint: draft.request_hash,
        draftId: draft.id
      });
      closeDraft(draft.id, 'CONFIRMED', orderId);
      return saved;
    })();
    res.status(receipt.duplicate ? 200 : 201);
    return receipt;
  })
);

// 응답을 못 받은 판매가 서버에 저장됐는지 거래 고유번호로 확인한다.
router.get(
  '/sales/by-client-id/:id',
  handle((req) => {
    const clientSaleId = requireClientSaleId(req.params.id);
    const order = orderByClientId(req.pharmacyId, clientSaleId);
    const draft = findDraft(req.pharmacyId, clientSaleId);
    return {
      client_sale_id: clientSaleId,
      status: order ? 'SAVED' : draft ? draft.status : 'NOT_FOUND',
      order: order ? buildReceipt(req, order.id) : null,
      draft: publicDraft(draft)
    };
  })
);

router.post(
  '/sales/drafts/:id/cancel',
  handle((req) => {
    const terminal = requireTerminal(req);
    const draft = requireOpenDraft(req, terminal, req.params.id);
    const live = draftApprovals(draft.id).filter((tx) => LIVE_APPROVAL_STATUSES.includes(tx.status));
    if (live.length) {
      throw new PosError('승인이 남아 있는 판매는 승인을 먼저 취소하거나 결과를 확인해 주세요.', 409, 'DRAFT_LOCKED', { approvals: live.map(publicVan) });
    }
    closeDraft(draft.id, 'CANCELED');
    return { draft: publicDraft(findDraft(req.pharmacyId, draft.client_sale_id)) };
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

// 영수증을 잃어버린 고객에게 가입 코드를 다시 준다. 이전 코드는 바로 못 쓰게 된다.
router.post(
  '/sales/:id/signup-code',
  handle((req) => {
    requireOwner(req, '가입 코드 재발급');
    const order = getPosOrder(req, req.params.id);
    return transaction(() => {
      const issued = issueSignupCode({ pharmacyId: req.pharmacyId, orderId: order.id, userId: req.user.id, reissue: true });
      audit(req, 'SIGNUP_CODE_REISSUE', 'ORDER', order.id, `가입 코드 재발급 · ${order.order_number}`);
      return { ...buildReceipt(req, order.id), issued };
    })();
  })
);

router.post(
  '/sales/:id/reprint',
  handle((req) => {
    const receipt = buildReceipt(req, req.params.id);
    audit(req, 'POS_RECEIPT_REPRINT', 'ORDER', receipt.order.id, `영수증 재출력 · ${receipt.order.order_number}`);
    return receipt;
  })
);

module.exports = router;
