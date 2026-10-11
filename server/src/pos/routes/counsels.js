const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { recordHistory } = require('../../services/order-flow');
const privacy = require('../../services/privacy');
const { COUNSEL_OPEN_STATUSES, PosError, audit, handle, requireOwner } = require('../common');

const router = express.Router();

router.get(
  '/counsels',
  handle((req) => {
    const scope = req.query.scope === 'all' ? 'all' : 'pending';
    const conditions = ['o.pharmacy_id = @pharmacy_id', "o.order_type = 'COUNSEL'"];
    if (scope === 'pending') conditions.push(`o.order_status IN ('${COUNSEL_OPEN_STATUSES.join("','")}')`);
    const counsels = getAll(
      `SELECT o.id, o.order_number, o.order_status, o.preferred_at, o.contact_name, o.contact_phone,
              o.counsel_note IS NOT NULL AS has_note,
              o.customer_id, o.created_at, c.name AS customer_name, c.phone AS customer_phone,
              (SELECT order_number FROM orders s WHERE s.counsel_order_id = o.id ORDER BY s.id DESC LIMIT 1) AS linked_sale_number
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(o.preferred_at, o.created_at) ASC
       LIMIT 100`,
      { pharmacy_id: req.pharmacyId }
    );
    return { counsels: counsels.map((row) => ({ ...row, has_note: row.has_note === 1 })) };
  })
);

// 상담 예약 때 고객이 적은 증상·복용 약. 약사만 열람하고 기록을 남긴다.
router.get(
  '/counsels/:id/note',
  handle((req) => {
    requireOwner(req, '상담 내용 열람');
    const counsel = getOne(
      `SELECT o.*, c.name AS customer_name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = @id AND o.pharmacy_id = @pharmacy_id AND o.order_type = 'COUNSEL'`,
      { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
    );
    if (!counsel) throw new PosError('복약상담 예약을 찾을 수 없습니다.', 404);
    const note = privacy.counselNote(counsel);
    if (note && counsel.customer_id) {
      privacy.logAccess({
        userId: req.user.id,
        pharmacyId: req.pharmacyId,
        customerId: counsel.customer_id,
        action: 'COUNSEL_NOTE_VIEW',
        purpose: 'COUNSEL',
        description: `상담 내용 열람 · ${counsel.order_number} · ${counsel.customer_name || ''}`
      });
    }
    return { note, purged_at: counsel.counsel_note_purged_at };
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
      recordHistory({ order: counsel, action: 'TRANSITION', from: counsel.order_status, to: 'COMPLETED', reason: '구매 없이 상담 완료', userId: req.user.id });
      audit(req, 'POS_COUNSEL_COMPLETE', 'ORDER', counsel.id, `복약상담 완료 ${counsel.order_number} (구매 없음)`);
    })();
    return { ok: true };
  })
);

module.exports = router;
