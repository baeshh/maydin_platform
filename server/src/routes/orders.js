const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

const ORDER_TYPES = new Set(['DELIVERY', 'PICKUP', 'COUNSEL']);

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

function assertCartReady(cartItems) {
  if (cartItems.length === 0) throw new Error('장바구니가 비어 있습니다.');

  let total = 0;
  for (const item of cartItems) {
    if (item.status !== 'ON_SALE') throw new Error(`${item.product_name} 상품은 판매중이 아닙니다.`);
    if (item.stock_quantity < item.quantity) throw new Error(`${item.product_name} 재고가 부족합니다.`);
    total += Number(item.discount_price || item.price) * item.quantity;
  }
  return total;
}

function insertOrderItems(orderId, cartItems, pharmacyId, userId) {
  for (const item of cartItems) {
    const price = Number(item.discount_price || item.price);
    run(
      `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total_price)
       VALUES (@order_id, @product_id, @product_name, @quantity, @price, @total_price)`,
      {
        order_id: orderId,
        product_id: item.id,
        product_name: item.product_name,
        quantity: item.quantity,
        price,
        total_price: price * item.quantity
      }
    );

    run(
      `UPDATE products
       SET stock_quantity = stock_quantity - @quantity,
           status = CASE WHEN stock_quantity - @quantity <= 0 THEN 'SOLD_OUT' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @product_id AND pharmacy_id = @pharmacy_id`,
      { quantity: item.quantity, product_id: item.id, pharmacy_id: pharmacyId }
    );

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
       WHERE o.pharmacy_id = @pharmacy_id AND c.user_id = @user_id
       ORDER BY o.id DESC`
    : `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, d.receiver_name, d.address, d.courier, d.tracking_number
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN deliveries d ON d.order_id = o.id
       WHERE o.pharmacy_id = @pharmacy_id
       ORDER BY o.id DESC`;

  const orders = getAll(sql, { pharmacy_id: req.pharmacyId, user_id: req.user.id });
  res.json({ orders });
});

router.get('/:id', requireRole('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const order = getOne('SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!order) return res.status(404).json({ message: '주문을 찾을 수 없습니다.' });

  if (req.user.role === 'CUSTOMER') {
    const customer = getOne('SELECT id FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId
    });
    if (!customer || customer.id !== order.customer_id) {
      return res.status(403).json({ message: '본인 주문만 조회할 수 있습니다.' });
    }
  }

  const items = getAll('SELECT * FROM order_items WHERE order_id = @order_id', { order_id: order.id });
  const payment = getOne('SELECT * FROM payments WHERE order_id = @order_id', { order_id: order.id });
  const delivery = getOne('SELECT * FROM deliveries WHERE order_id = @order_id', { order_id: order.id });
  res.json({ order, items, payment, delivery });
});

router.post('/', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  const customer = getOne('SELECT * FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    user_id: req.user.id,
    pharmacy_id: req.pharmacyId
  });
  if (!customer) return res.status(400).json({ message: '고객 정보를 찾을 수 없습니다.' });

  const orderType = String(req.body.order_type || 'DELIVERY').toUpperCase();
  if (!ORDER_TYPES.has(orderType)) {
    return res.status(400).json({ message: '지원하지 않는 주문 유형입니다.' });
  }

  const createOrder = transaction(() => {
    if (orderType === 'COUNSEL') {
      const preferredAt = String(req.body.preferred_at || '').trim();
      const memo = String(req.body.memo || '').trim();
      if (!preferredAt) throw new Error('희망 상담 일시를 입력해 주세요.');
      if (!memo) throw new Error('상담 문의 내용을 입력해 주세요.');

      const contactName = String(req.body.contact_name || customer.name || '').trim();
      const contactPhone = String(req.body.contact_phone || customer.phone || '').trim();

      const orderResult = run(
        `INSERT INTO orders (
          order_number, pharmacy_id, customer_id, order_type, total_product_amount, delivery_fee,
          discount_amount, final_amount, payment_status, order_status, delivery_status,
          preferred_at, memo, contact_name, contact_phone
        ) VALUES (
          @order_number, @pharmacy_id, @customer_id, 'COUNSEL', 0, 0,
          0, 0, 'PAID', 'RESERVED', 'NOT_SHIPPED',
          @preferred_at, @memo, @contact_name, @contact_phone
        )`,
        {
          order_number: orderNumber('CNS'),
          pharmacy_id: req.pharmacyId,
          customer_id: customer.id,
          preferred_at: preferredAt,
          memo,
          contact_name: contactName,
          contact_phone: contactPhone
        }
      );

      run(
        `INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at)
         VALUES (@order_id, 'NONE', 'MOCK', 'PAID', 0, CURRENT_TIMESTAMP)`,
        { order_id: orderResult.lastInsertRowid }
      );

      return getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid });
    }

    const cartItems = getCartItems(req.user.id, req.pharmacyId);
    const total = assertCartReady(cartItems);
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
          0, @final_amount, 'PAID', 'RESERVED', 'READY_FOR_PICKUP',
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

      insertOrderItems(orderResult.lastInsertRowid, cartItems, req.pharmacyId, req.user.id);

      run(
        `INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at)
         VALUES (@order_id, @payment_method, 'MOCK', 'PAID', @paid_amount, CURRENT_TIMESTAMP)`,
        {
          order_id: orderResult.lastInsertRowid,
          payment_method: req.body.payment_method || 'MOCK_CARD',
          paid_amount: total
        }
      );

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
        0, @final_amount, 'PAID', 'PAYMENT_COMPLETED', 'NOT_SHIPPED',
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

    insertOrderItems(orderResult.lastInsertRowid, cartItems, req.pharmacyId, req.user.id);

    run(
      `INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at)
       VALUES (@order_id, @payment_method, 'MOCK', 'PAID', @paid_amount, CURRENT_TIMESTAMP)`,
      {
        order_id: orderResult.lastInsertRowid,
        payment_method: req.body.payment_method || 'MOCK_CARD',
        paid_amount: finalAmount
      }
    );

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

    clearCart(req.user.id, req.pharmacyId);
    return getOne('SELECT * FROM orders WHERE id = @id', { id: orderResult.lastInsertRowid });
  });

  try {
    res.status(201).json({ order: createOrder() });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/:id/status', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const { order_status, delivery_status, courier, tracking_number } = req.body;
  const order = getOne('SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!order) return res.status(404).json({ message: '주문을 찾을 수 없습니다.' });

  run(
    `UPDATE orders
     SET order_status = COALESCE(@order_status, order_status),
         delivery_status = COALESCE(@delivery_status, delivery_status),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    {
      id: order.id,
      pharmacy_id: req.pharmacyId,
      order_status: order_status || null,
      delivery_status: delivery_status || null
    }
  );

  if (order.order_type === 'DELIVERY' || !order.order_type) {
    run(
      `UPDATE deliveries
       SET courier = COALESCE(@courier, courier),
           tracking_number = COALESCE(@tracking_number, tracking_number),
           delivery_status = COALESCE(@delivery_status, delivery_status),
           shipped_at = CASE WHEN @delivery_status = 'SHIPPING' THEN CURRENT_TIMESTAMP ELSE shipped_at END,
           delivered_at = CASE WHEN @delivery_status = 'DELIVERED' THEN CURRENT_TIMESTAMP ELSE delivered_at END
       WHERE order_id = @order_id`,
      {
        order_id: order.id,
        courier: courier || null,
        tracking_number: tracking_number || null,
        delivery_status: delivery_status || null
      }
    );
  }

  res.json({ order: getOne('SELECT * FROM orders WHERE id = @id', { id: order.id }) });
});

module.exports = router;
