const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { onlineOrderStatus } = require('../services/member-auth');
const { OrderFlowError, availableActions, orderHistory, recordHistory, transition } = require('../services/order-flow');
const { reverseOnlineOrder } = require('../services/online-payments');
const { providerLabel } = require('../services/payment-gateway');
const { encrypt } = require('../services/secure');
const privacy = require('../services/privacy');

const { stripCounselNote } = privacy;
const router = express.Router();

const ORDER_TYPES = new Set(['DELIVERY', 'PICKUP', 'COUNSEL']);
const COUNSEL_NOTE_MAX_LENGTH = 500;

function orderNumber(prefix = 'ORD') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
}

router.use(authenticate);

const PAYMENT_COLUMNS = `
  (SELECT payment_provider FROM payments WHERE order_id = o.id ORDER BY id ASC LIMIT 1) AS payment_provider,
  (SELECT payment_mode FROM payments WHERE order_id = o.id ORDER BY id ASC LIMIT 1) AS payment_mode`;

// 화면에 내보내는 주문. 결제 취소 요청 내부값은 빼고, 데모·테스트 결제인지 알 수 있게 결제 표시를 붙인다.
function presentOrder(row, role) {
  const { cancel_request, ...order } = stripCounselNote(row, { reveal: role === 'CUSTOMER' });
  if (!ORDER_TYPES.has(order.order_type || 'DELIVERY') || order.sales_channel === 'POS') return order;
  const paymentLabel = order.order_type !== 'COUNSEL' && order.payment_provider ? providerLabel(order.payment_provider, order.payment_mode) : null;
  return { ...order, payment_label: paymentLabel, ...availableActions(order, role) };
}

router.get('/', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const customerOnly = req.user.role === 'CUSTOMER';
  const sql = customerOnly
    ? `SELECT o.*, d.receiver_name, d.address, ${PAYMENT_COLUMNS}
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.pharmacy_id = @pharmacy_id AND c.user_id = @user_id AND o.order_type != 'ONLINE_REFUND'
       ORDER BY o.id DESC`
    : `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, d.receiver_name, d.address, d.courier, d.tracking_number, ${PAYMENT_COLUMNS}
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.pharmacy_id = @pharmacy_id AND COALESCE(o.sales_channel, 'ONLINE') != 'POS' AND o.order_type != 'ONLINE_REFUND'
       ORDER BY o.id DESC`;

  const orders = getAll(sql, { pharmacy_id: req.pharmacyId, user_id: req.user.id }).map((row) => presentOrder(row, req.user.role));
  res.json({ orders });
});

function sendFlowError(res, error) {
  if (error instanceof OrderFlowError) return res.status(error.status).json({ message: error.message, reason: error.reason });
  return res.status(400).json({ message: error.message });
}

function findOrderFor(req) {
  const order = getOne('SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!order) throw new OrderFlowError('주문을 찾을 수 없습니다.', 404, 'NOT_FOUND');
  if (req.user.role === 'CUSTOMER') {
    const customer = findMyCustomer(req);
    if (!customer || customer.id !== order.customer_id) throw new OrderFlowError('본인 주문만 처리할 수 있습니다.', 403, 'NOT_OWNER');
  }
  return order;
}

function auditOrder(req, action, order, description) {
  if (req.user.role === 'CUSTOMER') return;
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, 'ORDER', @target_id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.pharmacyId, action, target_id: order.id, description }
  );
}

function withoutCost({ unit_cost, cost_amount, cost_source, ...item }) {
  return item;
}

function cleanReason(value) {
  return String(value || '').trim().slice(0, 200);
}

function findMyCustomer(req) {
  return getOne('SELECT * FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    user_id: req.user.id,
    pharmacy_id: req.pharmacyId
  });
}

router.get('/eligibility', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  res.json(onlineOrderStatus(findMyCustomer(req)));
});

// 상담 예약 때 고객이 적은 증상·복용 약은 약사(약국 대표 계정)만 열람하고, 열람 기록이 고객에게도 보인다.
router.get('/:id/counsel-note', requireRole('PHARMACY_OWNER'), requirePharmacyScope, (req, res) => {
  try {
    const order = findOrderFor(req);
    if (order.order_type !== 'COUNSEL') throw new OrderFlowError('복약상담 예약이 아닙니다.', 400, 'NOT_COUNSEL');
    const note = privacy.counselNote(order);
    if (note && order.customer_id) {
      privacy.logAccess({
        userId: req.user.id,
        pharmacyId: req.pharmacyId,
        customerId: order.customer_id,
        action: 'COUNSEL_NOTE_VIEW',
        purpose: 'COUNSEL',
        description: `상담 내용 열람 · ${order.order_number}`
      });
    }
    res.json({ note, purged_at: order.counsel_note_purged_at });
  } catch (error) {
    sendFlowError(res, error);
  }
});

// 고객은 언제든 자기 상담 문의 내용을 지울 수 있다(해당 예약의 동의 철회).
router.delete('/:id/counsel-note', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  try {
    const order = findOrderFor(req);
    if (order.order_type !== 'COUNSEL') throw new OrderFlowError('복약상담 예약이 아닙니다.', 400, 'NOT_COUNSEL');
    privacy.deleteCounselNote(order.id);
    res.json({ order: stripCounselNote(getOne('SELECT * FROM orders WHERE id = @id', { id: order.id }), { reveal: true }) });
  } catch (error) {
    sendFlowError(res, error);
  }
});

router.get('/:id', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const row = getOne('SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!row) return res.status(404).json({ message: '주문을 찾을 수 없습니다.' });

  if (req.user.role === 'CUSTOMER') {
    const customer = getOne('SELECT id FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId
    });
    if (!customer || customer.id !== row.customer_id) {
      return res.status(403).json({ message: '본인 주문만 조회할 수 있습니다.' });
    }
  }

  const items = getAll('SELECT * FROM order_items WHERE order_id = @order_id', { order_id: row.id }).map((item) =>
    req.user.role === 'CUSTOMER' ? withoutCost(item) : item
  );
  const payments = getAll('SELECT * FROM payments WHERE order_id = @order_id ORDER BY id ASC', { order_id: row.id });
  const delivery = getOne('SELECT * FROM deliveries WHERE order_id = @order_id', { order_id: row.id });
  res.json({
    order: presentOrder({ ...row, payment_provider: payments[0]?.payment_provider, payment_mode: payments[0]?.payment_mode }, req.user.role),
    items,
    payment: payments[0] || null,
    payments,
    delivery,
    history: orderHistory(row.id)
  });
});

// 상담 예약만 여기서 만든다. 배송·픽업 주문은 결제사 승인을 확인한 뒤에만 만들어지므로 /api/payments/checkouts 를 거친다.
router.post('/', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  const customer = findMyCustomer(req);
  if (!customer) return res.status(400).json({ message: '고객 정보를 찾을 수 없습니다.' });

  const orderType = String(req.body.order_type || 'DELIVERY').toUpperCase();
  if (!ORDER_TYPES.has(orderType)) {
    return res.status(400).json({ message: '지원하지 않는 주문 유형입니다.' });
  }
  if (orderType !== 'COUNSEL') {
    return res.status(400).json({ message: '배송·픽업 주문은 결제창을 거쳐야 합니다. 주문 화면에서 다시 결제해 주세요.', reason: 'USE_CHECKOUT' });
  }

  const eligibility = onlineOrderStatus(customer);
  if (eligibility.reason === 'NOT_APPROVED') return res.status(403).json({ message: eligibility.message, reason: eligibility.reason });

  const createCounsel = transaction(() => {
    // 문의 내용은 선택이다. 증상·복용 약이 들어갈 수 있어 적을 때만 이 예약에 대한 동의를 받고 암호화해 둔다.
    const preferredAt = String(req.body.preferred_at || '').trim();
    const note = String(req.body.memo || '').trim();
    if (!preferredAt) throw new Error('희망 상담 일시를 입력해 주세요.');
    if (note.length > COUNSEL_NOTE_MAX_LENGTH) throw new Error(`상담 문의 내용은 ${COUNSEL_NOTE_MAX_LENGTH}자 이내로 적어 주세요.`);
    if (note && req.body.counsel_consent !== true) {
      throw new Error('문의 내용(증상·복용 약)을 약사에게 전달하려면 민감정보 수집·이용에 동의해 주세요. 동의하지 않으면 내용을 비우고 예약할 수 있어요.');
    }

    const contactName = String(req.body.contact_name || customer.name || '').trim();
    const contactPhone = String(req.body.contact_phone || customer.phone || '').trim();

    const orderResult = run(
      `INSERT INTO orders (
        order_number, pharmacy_id, customer_id, order_type, total_product_amount, delivery_fee,
        discount_amount, final_amount, payment_status, order_status, delivery_status,
        preferred_at, contact_name, contact_phone, counsel_note, counsel_consent_at
      ) VALUES (
        @order_number, @pharmacy_id, @customer_id, 'COUNSEL', 0, 0,
        0, 0, 'PAID', 'RESERVED', 'NOT_SHIPPED',
        @preferred_at, @contact_name, @contact_phone, @counsel_note, CASE WHEN @counsel_note IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END
      )`,
      {
        order_number: orderNumber('CNS'),
        pharmacy_id: req.pharmacyId,
        customer_id: customer.id,
        preferred_at: preferredAt,
        contact_name: contactName,
        contact_phone: contactPhone,
        counsel_note: note ? encrypt(note) : null
      }
    );

    run(
      `INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at)
       VALUES (@order_id, 'NONE', 'MOCK', 'PAID', 0, CURRENT_TIMESTAMP)`,
      { order_id: orderResult.lastInsertRowid }
    );

    const counsel = getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid });
    recordHistory({ order: counsel, action: 'CREATE', to: 'RESERVED', actorType: 'CUSTOMER', userId: req.user.id });
    return counsel;
  });

  try {
    res.status(201).json({ order: stripCounselNote(createCounsel(), { reveal: true }) });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// 정상 진행(상품 준비 → 픽업 대기/배송중 → 완료)만 바꾼다. 배송 상태는 주문 상태에서 정해지므로 따로 받지 않는다.
router.patch('/:id/status', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  try {
    const to = String(req.body.order_status || '').trim().toUpperCase();
    if (!to) throw new OrderFlowError('바꿀 주문 상태를 지정해 주세요.', 400, 'STATUS_REQUIRED');
    const result = transaction(() => {
      const order = findOrderFor(req);
      transition(order, to, {
        userId: req.user.id,
        reason: cleanReason(req.body.reason) || null,
        extra: { courier: req.body.courier, tracking_number: req.body.tracking_number }
      });
      auditOrder(req, 'ORDER_STATUS', order, `${order.order_number} ${order.order_status} → ${to}`);
      return getOne('SELECT * FROM orders WHERE id = @id', { id: order.id });
    })();
    res.json({ order: presentOrder(result, req.user.role) });
  } catch (error) {
    sendFlowError(res, error);
  }
});

function auditFor(req, action, order, description) {
  if (req.user.role === 'CUSTOMER') return null;
  return { user_id: req.user.id, pharmacy_id: req.pharmacyId, action, description };
}

// 내보내기 전 주문 취소: 결제사 취소 확인 → 재고 원복 + 음수 매출 기록 + 이력. 고객은 상품 준비 전까지만 가능하다.
router.post('/:id/cancel', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, async (req, res) => {
  try {
    const customer = req.user.role === 'CUSTOMER';
    const reason = cleanReason(req.body.reason) || (customer ? '고객 직접 취소' : '');
    if (reason.length < 2) throw new OrderFlowError('취소 사유를 입력해 주세요.', 400, 'REASON_REQUIRED');
    const order = findOrderFor(req);
    const result = await reverseOnlineOrder(order, {
      kind: 'CANCEL',
      reason,
      userId: req.user.id,
      actorType: customer ? 'CUSTOMER' : 'STAFF',
      audit: auditFor(req, 'ORDER_CANCEL', order, `${order.order_number} 취소 · ${order.final_amount.toLocaleString('ko-KR')}원 · 사유: ${reason}`)
    });
    res.json({ ...result, order: presentOrder(result.order, req.user.role) });
  } catch (error) {
    sendFlowError(res, error);
  }
});

// 수령·배송 완료 뒤 전액 환불. 결제사 환불을 확인한 뒤 되돌린다. 돌려받은 상품을 다시 팔 수 있을 때만 restock으로 재고에 넣는다.
router.post('/:id/refund', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, async (req, res) => {
  try {
    const reason = cleanReason(req.body.reason);
    if (reason.length < 2) throw new OrderFlowError('환불 사유를 입력해 주세요.', 400, 'REASON_REQUIRED');
    const restock = req.body.restock === true || req.body.restock === 'true';
    const order = findOrderFor(req);
    const result = await reverseOnlineOrder(order, {
      kind: 'REFUND',
      reason,
      restock,
      userId: req.user.id,
      actorType: 'STAFF',
      audit: auditFor(
        req,
        'ORDER_REFUND',
        order,
        `${order.order_number} 환불 · ${order.final_amount.toLocaleString('ko-KR')}원 · 사유: ${reason}${restock ? ' · 재입고' : ''}`
      )
    });
    res.json({ ...result, order: presentOrder(result.order, req.user.role) });
  } catch (error) {
    sendFlowError(res, error);
  }
});

module.exports = router;
