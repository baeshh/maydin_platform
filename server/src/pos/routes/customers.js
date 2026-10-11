const express = require('express');
const { getAll, getOne, transaction } = require('../../db');
const { currentConsents } = require('../../services/customers');
const { normalizeHealth, readHealth, saveHealth } = require('../../services/member-auth');
const { posBadges } = require('../../services/members');
const privacy = require('../../services/privacy');
const { PHONE_DIGITS_SQL, PosError, digits, handle, isOwner, parseMemberCode, requireOwner } = require('../common');

const router = express.Router();

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
        COUNT(CASE WHEN o.order_type NOT IN ('POS_REFUND', 'ONLINE_REFUND', 'COUNSEL') THEN o.id END) AS order_count,
        COALESCE(SUM(o.final_amount), 0) AS total_amount,
        MAX(o.created_at) AS last_order_at
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       WHERE c.pharmacy_id = @pharmacy_id
         AND c.approval_status = 'APPROVED'
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
    const customer = getOne(
      `SELECT id, name, phone, email, created_at, member_code, point_balance, health_info IS NOT NULL AS has_health
       FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id AND approval_status = 'APPROVED'`,
      { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
    );
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
    const membership = posBadges(req.pharmacyId, customer.id);
    if (membership && isOwner(req)) membership.has_health = customer.has_health === 1;
    return { customer: { ...customer, has_health: undefined }, orders, membership };
  })
);

function healthCustomer(req) {
  const customer = getOne("SELECT id, name FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id AND approval_status = 'APPROVED'", {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!customer) throw new PosError('고객을 찾을 수 없습니다.', 404);
  return customer;
}

// 알레르기·복용 약은 약사(관리자)만, 목적을 고른 뒤에 본다. 열람 기록은 고객 앱에서도 보인다.
router.get(
  '/customers/:id/health',
  handle((req) => {
    requireOwner(req, '건강 정보 열람');
    const customer = healthCustomer(req);
    const purpose = privacy.parsePurpose(req.query.purpose);
    privacy.logAccess({
      userId: req.user.id,
      pharmacyId: req.pharmacyId,
      customerId: customer.id,
      action: 'HEALTH_VIEW',
      purpose,
      description: `POS 건강 정보 열람 · ${customer.name} · 목적: ${privacy.ACCESS_PURPOSES[purpose]}`
    });
    return { health: readHealth(customer.id), agreed: currentConsents(customer.id).HEALTH_INFO.agreed };
  })
);

// 상담하며 들은 내용으로 고친다. 고객이 앱에서 보관에 동의한 경우에만 저장한다.
router.put(
  '/customers/:id/health',
  handle((req) => {
    requireOwner(req, '건강 정보 수정');
    const customer = healthCustomer(req);
    if (!currentConsents(customer.id).HEALTH_INFO.agreed) {
      throw new PosError('고객이 건강 정보 보관에 동의하지 않았습니다. 고객이 앱 내 정보에서 동의한 뒤 입력할 수 있어요.', 409);
    }
    const health = normalizeHealth(req.body);
    transaction(() => {
      saveHealth(customer.id, health, req.user.id);
      privacy.logAccess({
        userId: req.user.id,
        pharmacyId: req.pharmacyId,
        customerId: customer.id,
        action: 'HEALTH_UPDATE',
        purpose: 'COUNSEL',
        description: `POS 건강 정보 수정 · ${customer.name}`
      });
    })();
    return { health: readHealth(customer.id) };
  })
);

module.exports = router;
