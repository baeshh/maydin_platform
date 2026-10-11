const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { recordHistory } = require('../../services/order-flow');
const { PHONE_DIGITS_SQL, PICKUP_DONE_STATUSES, PICKUP_HANDOVER_STATUSES, PosError, audit, digits, handle, won } = require('../common');
const { assertDraftPayable, closeDraft, requireOpenDraft } = require('../services/draft-service');
const { insertPayments, normalizePayments } = require('../services/payment-service');
const { requireOpenSession } = require('../services/session-service');

const router = express.Router();

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
      if (!PICKUP_HANDOVER_STATUSES.includes(order.order_status)) {
        throw new PosError('이미 수령 완료되었거나 취소·환불된 주문입니다.', 409);
      }

      let counterPayment = null;
      if (order.payment_status !== 'PAID') {
        const { terminal, session } = requireOpenSession(req);
        // 카드 승인을 서버·Bridge로 받은 결제는 결제 전 등록(prepare)에 묶인 승인만 쓴다.
        let draft = null;
        if (req.body.client_sale_id) {
          draft = requireOpenDraft(req, terminal, req.body.client_sale_id);
          if (draft.pickup_order_id !== order.id) throw new PosError('이 픽업 주문에 묶인 결제가 아닙니다.', 409);
          assertDraftPayable(draft, req.body.payments);
        }
        const payments = normalizePayments(req.body.payments, order.final_amount, { allowPoint: false });
        insertPayments(order.id, payments, { session, terminal, userId: req.user.id, draftId: draft ? draft.id : null });
        if (draft) closeDraft(draft.id, 'CONFIRMED', order.id);
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
         WHERE id = @id AND order_status = @from AND cancel_lock_at IS NULL`,
        { id: order.id, user_id: req.user.id, from: order.order_status }
      );
      if (updated.changes === 0) {
        if (getOne('SELECT cancel_lock_at FROM orders WHERE id = @id', { id: order.id })?.cancel_lock_at) {
          throw new PosError('결제 취소를 처리하는 중인 주문이라 내줄 수 없습니다.', 409);
        }
        throw new PosError('이미 수령 완료된 주문입니다.', 409);
      }
      if (counterPayment) {
        recordHistory({
          order,
          action: 'PAYMENT_APPROVED',
          from: order.order_status,
          to: 'PAYMENT_COMPLETED',
          amount: order.final_amount,
          reason: '카운터 결제',
          userId: req.user.id
        });
      }
      recordHistory({
        order,
        action: 'COUNTER_PICKUP',
        from: counterPayment ? 'PAYMENT_COMPLETED' : order.order_status,
        to: 'PICKED_UP',
        userId: req.user.id
      });

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

module.exports = router;
