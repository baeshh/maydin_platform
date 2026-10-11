const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { onlineOrderStatus } = require('../services/member-auth');
const { onlineStockBuffer, onlineStockGate } = require('../services/product-import');
const { isOnlineSellable, onlineBlockedMessage } = require('../services/product-kind');
const { saleCost } = require('../services/order-cost');
const {
  OrderFlowError,
  availableActions,
  cancelOrder,
  orderHistory,
  recordCreatedAndPaid,
  recordHistory,
  refundOrder,
  transition
} = require('../services/order-flow');
const { encrypt } = require('../services/secure');
const privacy = require('../services/privacy');

const { stripCounselNote } = privacy;
const router = express.Router();

const ORDER_TYPES = new Set(['DELIVERY', 'PICKUP', 'COUNSEL']);
const COUNSEL_NOTE_MAX_LENGTH = 500;

function orderNumber(prefix = 'ORD') {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
}

function getCartItems(userId, pharmacyId) {
  return getAll(
    `SELECT c.id AS cart_id, c.quantity, p.*
     FROM carts c
     JOIN products p ON p.id = c.product_id AND p.pharmacy_id = c.pharmacy_id
     WHERE c.user_id = @user_id AND c.pharmacy_id = @pharmacy_id
     ORDER BY c.id ASC`,
    { user_id: userId, pharmacy_id: pharmacyId }
  );
}

function assertCartReady(cartItems, buffer = 0) {
  if (cartItems.length === 0) throw new Error('장바구니가 비어 있습니다.');

  let total = 0;
  for (const item of cartItems) {
    if (item.product_type !== 'GENERAL') throw new Error(onlineBlockedMessage(item));
    if (item.status !== 'ON_SALE' || !isOnlineSellable(item)) throw new Error(`${item.product_name} 상품은 판매중이 아닙니다.`);
    if (item.stock_quantity - buffer < item.quantity) throw new Error(`${item.product_name} 재고가 부족합니다.`);
    total += Number(item.discount_price || item.price) * item.quantity;
  }
  return total;
}

function insertOrderItems(orderId, cartItems, pharmacyId, userId, buffer = 0) {
  for (const item of cartItems) {
    const price = Number(item.discount_price || item.price);
    run(
      `INSERT INTO order_items (
        order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, unit_cost, cost_amount, cost_source
      ) VALUES (
        @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @unit_cost, @cost_amount, @cost_source
      )`,
      {
        order_id: orderId,
        product_id: item.id,
        product_name: item.product_name,
        quantity: item.quantity,
        price,
        total_price: price * item.quantity,
        product_type: item.product_type || 'GENERAL',
        tax_type: item.tax_type || 'TAXABLE',
        ...saleCost(item.id, item.quantity)
      }
    );

    const stockResult = run(
      `UPDATE products
       SET stock_quantity = stock_quantity - @quantity,
           status = CASE WHEN stock_quantity - @quantity <= 0 THEN 'SOLD_OUT' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @product_id AND pharmacy_id = @pharmacy_id AND stock_quantity - @buffer >= @quantity`,
      { quantity: item.quantity, product_id: item.id, pharmacy_id: pharmacyId, buffer }
    );
    if (stockResult.changes === 0) throw new Error(`${item.product_name} 재고가 부족합니다.`);

    run(
      `INSERT INTO inventory_logs (
        pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by
      ) VALUES (
        @pharmacy_id, @product_id, 'ORDER', @quantity_before, @quantity_after, @reason, @created_by
      )`,
      {
        pharmacy_id: pharmacyId,
        product_id: item.id,
        quantity_before: item.stock_quantity,
        quantity_after: item.stock_quantity - item.quantity,
        reason: '주문 재고 차감',
        created_by: userId
      }
    );
  }
}

function clearCart(userId, pharmacyId) {
  run('DELETE FROM carts WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    user_id: userId,
    pharmacy_id: pharmacyId
  });
}

router.use(authenticate);

router.get('/', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const customerOnly = req.user.role === 'CUSTOMER';
  const sql = customerOnly
    ? `SELECT o.*, d.receiver_name, d.address
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.pharmacy_id = @pharmacy_id AND c.user_id = @user_id AND o.order_type != 'ONLINE_REFUND'
       ORDER BY o.id DESC`
    : `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, d.receiver_name, d.address, d.courier, d.tracking_number
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.pharmacy_id = @pharmacy_id AND COALESCE(o.sales_channel, 'ONLINE') != 'POS' AND o.order_type != 'ONLINE_REFUND'
       ORDER BY o.id DESC`;

  const orders = getAll(sql, { pharmacy_id: req.pharmacyId, user_id: req.user.id }).map((row) => {
    const order = stripCounselNote(row, { reveal: customerOnly });
    return ORDER_TYPES.has(order.order_type || 'DELIVERY') && order.sales_channel !== 'POS'
      ? { ...order, ...availableActions(order, req.user.role) }
      : order;
  });
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
  const order = stripCounselNote(row, { reveal: req.user.role === 'CUSTOMER' });

  if (req.user.role === 'CUSTOMER') {
    const customer = getOne('SELECT id FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId
    });
    if (!customer || customer.id !== order.customer_id) {
      return res.status(403).json({ message: '본인 주문만 조회할 수 있습니다.' });
    }
  }

  const items = getAll('SELECT * FROM order_items WHERE order_id = @order_id', { order_id: order.id }).map((item) =>
    req.user.role === 'CUSTOMER' ? withoutCost(item) : item
  );
  const payments = getAll('SELECT * FROM payments WHERE order_id = @order_id ORDER BY id ASC', { order_id: order.id });
  const delivery = getOne('SELECT * FROM deliveries WHERE order_id = @order_id', { order_id: order.id });
  const online = ORDER_TYPES.has(order.order_type || 'DELIVERY') && order.sales_channel !== 'POS';
  res.json({
    order: online ? { ...order, ...availableActions(order, req.user.role) } : order,
    items,
    payment: payments[0] || null,
    payments,
    delivery,
    history: orderHistory(order.id)
  });
});

router.post('/', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  const customer = findMyCustomer(req);
  if (!customer) return res.status(400).json({ message: '고객 정보를 찾을 수 없습니다.' });

  const orderType = String(req.body.order_type || 'DELIVERY').toUpperCase();
  if (!ORDER_TYPES.has(orderType)) {
    return res.status(400).json({ message: '지원하지 않는 주문 유형입니다.' });
  }

  const eligibility = onlineOrderStatus(customer);
  const blocked = orderType === 'COUNSEL' ? eligibility.reason === 'NOT_APPROVED' : !eligibility.allowed;
  if (blocked) return res.status(403).json({ message: eligibility.message, reason: eligibility.reason });
  if (orderType !== 'COUNSEL') {
    const gate = onlineStockGate(req.pharmacyId);
    if (gate.paused) return res.status(409).json({ message: gate.message, reason: 'STOCK_SYNC_PAUSED' });
  }

  const createOrder = transaction(() => {
    if (orderType === 'COUNSEL') {
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
    }

    const cartItems = getCartItems(req.user.id, req.pharmacyId);
    const buffer = onlineStockBuffer(req.pharmacyId);
    const total = assertCartReady(cartItems, buffer);
    const preferredAt = String(req.body.preferred_at || '').trim();
    const memo = String(req.body.memo || '').trim();
    const contactName = String(req.body.contact_name || customer.name || '').trim();
    const contactPhone = String(req.body.contact_phone || customer.phone || '').trim();

    if (orderType === 'PICKUP') {
      if (!preferredAt) throw new Error('희망 픽업 일시를 입력해 주세요.');
      if (!contactName || !contactPhone) throw new Error('수령인 정보를 입력해 주세요.');

      const orderResult = run(
        `INSERT INTO orders (
          order_number, pharmacy_id, customer_id, order_type, total_product_amount, delivery_fee,
          discount_amount, final_amount, payment_status, order_status, delivery_status,
          preferred_at, memo, contact_name, contact_phone
        ) VALUES (
          @order_number, @pharmacy_id, @customer_id, 'PICKUP', @total_product_amount, 0,
          0, @final_amount, 'READY', 'PAYMENT_PENDING', 'NOT_SHIPPED',
          @preferred_at, @memo, @contact_name, @contact_phone
        )`,
        {
          order_number: orderNumber('PCK'),
          pharmacy_id: req.pharmacyId,
          customer_id: customer.id,
          total_product_amount: total,
          final_amount: total,
          preferred_at: preferredAt,
          memo,
          contact_name: contactName,
          contact_phone: contactPhone
        }
      );

      insertOrderItems(orderResult.lastInsertRowid, cartItems, req.pharmacyId, req.user.id, buffer);
      recordCreatedAndPaid(getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid }), {
        userId: req.user.id,
        paymentMethod: req.body.payment_method || 'MOCK_CARD'
      });

      clearCart(req.user.id, req.pharmacyId);
      return getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid });
    }

    const delivery = req.body.delivery || {};
    if (!String(delivery.address || '').trim()) {
      throw new Error('배송지 주소를 입력해 주세요.');
    }

    const deliveryFee = total >= 50000 ? 0 : 3000;
    const finalAmount = total + deliveryFee;
    const orderResult = run(
      `INSERT INTO orders (
        order_number, pharmacy_id, customer_id, order_type, total_product_amount, delivery_fee,
        discount_amount, final_amount, payment_status, order_status, delivery_status,
        preferred_at, memo, contact_name, contact_phone
      ) VALUES (
        @order_number, @pharmacy_id, @customer_id, 'DELIVERY', @total_product_amount, @delivery_fee,
        0, @final_amount, 'READY', 'PAYMENT_PENDING', 'NOT_SHIPPED',
        NULL, @memo, @contact_name, @contact_phone
      )`,
      {
        order_number: orderNumber('ORD'),
        pharmacy_id: req.pharmacyId,
        customer_id: customer.id,
        total_product_amount: total,
        delivery_fee: deliveryFee,
        final_amount: finalAmount,
        memo,
        contact_name: delivery.receiver_name || contactName,
        contact_phone: delivery.receiver_phone || contactPhone
      }
    );

    insertOrderItems(orderResult.lastInsertRowid, cartItems, req.pharmacyId, req.user.id, buffer);

    run(
      `INSERT INTO deliveries (
        order_id, receiver_name, receiver_phone, zip_code, address, address_detail, delivery_status
      ) VALUES (
        @order_id, @receiver_name, @receiver_phone, @zip_code, @address, @address_detail, 'NOT_SHIPPED'
      )`,
      {
        order_id: orderResult.lastInsertRowid,
        receiver_name: delivery.receiver_name || customer.name,
        receiver_phone: delivery.receiver_phone || customer.phone,
        zip_code: delivery.zip_code || '',
        address: delivery.address || '',
        address_detail: delivery.address_detail || ''
      }
    );
    recordCreatedAndPaid(getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid }), {
      userId: req.user.id,
      paymentMethod: req.body.payment_method || 'MOCK_CARD'
    });

    clearCart(req.user.id, req.pharmacyId);
    return getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid });
  });

  try {
    res.status(201).json({ order: stripCounselNote(createOrder(), { reveal: true }) });
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
      return stripCounselNote(getOne('SELECT * FROM orders WHERE id = @id', { id: order.id }));
    })();
    res.json({ order: { ...result, ...availableActions(result, req.user.role) } });
  } catch (error) {
    sendFlowError(res, error);
  }
});

// 내보내기 전 주문 취소: 결제 취소 + 재고 원복 + 음수 매출 기록 + 이력. 고객은 상품 준비 전까지만 가능하다.
router.post('/:id/cancel', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  try {
    const customer = req.user.role === 'CUSTOMER';
    const reason = cleanReason(req.body.reason) || (customer ? '고객 직접 취소' : '');
    if (reason.length < 2) throw new OrderFlowError('취소 사유를 입력해 주세요.', 400, 'REASON_REQUIRED');
    const result = transaction(() => {
      const order = findOrderFor(req);
      const outcome = cancelOrder(order, { reason, userId: req.user.id, actorType: customer ? 'CUSTOMER' : 'STAFF' });
      auditOrder(req, 'ORDER_CANCEL', order, `${order.order_number} 취소 · ${order.final_amount.toLocaleString('ko-KR')}원 · 사유: ${reason}`);
      return outcome;
    })();
    res.json({ ...result, order: stripCounselNote(result.order, { reveal: customer }) });
  } catch (error) {
    sendFlowError(res, error);
  }
});

// 수령·배송 완료 뒤 전액 환불. 돌려받은 상품을 다시 팔 수 있을 때만 restock으로 재고에 넣는다.
router.post('/:id/refund', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  try {
    const reason = cleanReason(req.body.reason);
    if (reason.length < 2) throw new OrderFlowError('환불 사유를 입력해 주세요.', 400, 'REASON_REQUIRED');
    const restock = req.body.restock === true || req.body.restock === 'true';
    const result = transaction(() => {
      const order = findOrderFor(req);
      const outcome = refundOrder(order, { reason, restock, userId: req.user.id });
      auditOrder(
        req,
        'ORDER_REFUND',
        order,
        `${order.order_number} 환불 · ${order.final_amount.toLocaleString('ko-KR')}원 · 사유: ${reason}${restock ? ' · 재입고' : ''}`
      );
      return outcome;
    })();
    res.json(result);
  } catch (error) {
    sendFlowError(res, error);
  }
});

module.exports = router;
