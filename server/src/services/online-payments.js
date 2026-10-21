const crypto = require('crypto');
const { getAll, getOne, run, transaction } = require('../db');
const { deliveryFeeFor, mallPolicy } = require('./mall-policy');
const { onlineOrderStatus } = require('./member-auth');
const { onlineStockGate } = require('./product-import');
const { isOnlineSellable, onlineBlockedMessage } = require('./product-kind');
const { saleCost } = require('./order-cost');
const { decrypt, encrypt } = require('./secure');
const flow = require('./order-flow');
const { GatewayError, demo, gatewayFor, isGatewayProvider, paymentConfig, providerLabel } = require('./payment-gateway');

// 온라인 결제 흐름
// 1) 결제 요청(online_checkouts): 장바구니·금액·배송 정보를 서버가 고정한다. 아직 주문·재고는 건드리지 않는다.
// 2) 결제창 인증 → 승인 요청: 서버가 금액·주문번호를 다시 맞춰 본 뒤 결제사에 승인을 요청한다.
// 3) 결제사 응답을 검증한 뒤에만 한 트랜잭션에서 주문 생성 + 재고 차감 + 결제 기록을 남긴다.
// 응답이 끊기면 결제사에 조회해 맞추고(재시도), 같은 주문에 두 번 승인되지 않도록 결제 요청 단위로 잠근다.

class PaymentError extends Error {
  constructor(message, status = 400, reason = 'PAYMENT_ERROR', extra = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

const ONLINE_TYPES = new Set(['PICKUP', 'DELIVERY']);
const MEMO_MAX_LENGTH = 200;
const PENDING_STATES = new Set(['CONFIRMING', 'UNKNOWN', 'REFUND_REQUIRED']);
const CHECKOUT_STATUS_LABELS = {
  READY: '결제 대기',
  CONFIRMING: '결제 승인 확인 중',
  UNKNOWN: '결제 결과 확인 중',
  DONE: '결제 완료',
  FAILED: '결제 실패',
  EXPIRED: '결제 시간 만료',
  CANCELED: '승인 후 자동 취소',
  REFUND_REQUIRED: '결제 취소 재시도 중'
};

const ttlMinutes = () => Math.max(5, Number(process.env.PAYMENT_CHECKOUT_TTL_MINUTES || 30));
const staleSeconds = () => Math.max(10, Number(process.env.PAYMENT_STALE_SECONDS || 120));
const DUPLICATE_WINDOW_MINUTES = 10;

function orderNumber(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomInt(0, 10000).toString().padStart(4, '0')}`;
}

function cleanText(value, max = 100) {
  return String(value ?? '').trim().slice(0, max);
}

function getCheckout(id) {
  return getOne('SELECT * FROM online_checkouts WHERE id = @id', { id });
}

function readPayload(checkout) {
  if (!checkout.payload) return null;
  try {
    return JSON.parse(decrypt(checkout.payload));
  } catch {
    return null;
  }
}

function publicCheckout(row, config = paymentConfig()) {
  if (!row) return null;
  return {
    id: row.id,
    pg_order_id: row.pg_order_id,
    order_name: row.order_name,
    order_type: row.order_type,
    amount: row.amount,
    total_product_amount: row.total_product_amount,
    delivery_fee: row.delivery_fee,
    status: row.status,
    status_label: CHECKOUT_STATUS_LABELS[row.status] || row.status,
    expires_at: row.expires_at,
    order_id: row.order_id,
    fail_code: row.fail_code,
    fail_message: row.fail_message,
    provider: row.provider,
    payment_mode: row.payment_mode,
    provider_label: providerLabel(row.provider, row.payment_mode),
    client_key: row.provider === 'TOSS' && config.provider === 'TOSS' && config.enabled ? config.clientKey : null,
    created_at: row.created_at
  };
}

function outcome(checkoutId) {
  const row = getCheckout(checkoutId);
  const order = row?.order_id ? getOne('SELECT * FROM orders WHERE id = @id', { id: row.order_id }) : null;
  return { state: row?.status, checkout: publicCheckout(row), order, message: row?.fail_message || null };
}

// 결제 요청을 끝낸다(실패·만료·취소). 배송지·연락처가 든 주문서 내용은 더 쓸 일이 없으므로 바로 지운다.
function closeCheckout(id, status, { code = null, message = null, from = null } = {}) {
  return run(
    `UPDATE online_checkouts
     SET status = @status, fail_code = @code, fail_message = @message, payload = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status != 'DONE' ${from ? 'AND status = @from' : ''}`,
    { id, status, code, message, from }
  ).changes;
}

/* ---------- 장바구니 확인 ---------- */

function cartItems(userId, pharmacyId) {
  return getAll(
    `SELECT c.id AS cart_id, c.quantity, p.*
     FROM carts c
     JOIN products p ON p.id = c.product_id AND p.pharmacy_id = c.pharmacy_id
     WHERE c.user_id = @user_id AND c.pharmacy_id = @pharmacy_id
     ORDER BY c.id ASC`,
    { user_id: userId, pharmacy_id: pharmacyId }
  );
}

function assertSellable(product, quantity, buffer) {
  if (!product) throw new PaymentError('상품이 삭제되어 주문할 수 없습니다.', 409, 'NOT_SELLABLE');
  if (product.product_type !== 'GENERAL') throw new PaymentError(onlineBlockedMessage(product), 409, 'NOT_SELLABLE');
  if (product.status !== 'ON_SALE' || !isOnlineSellable(product)) {
    throw new PaymentError(`${product.product_name} 상품은 판매중이 아닙니다.`, 409, 'NOT_SELLABLE');
  }
  if (product.stock_quantity - buffer < quantity) throw new PaymentError(`${product.product_name} 재고가 부족합니다.`, 409, 'OUT_OF_STOCK');
}

function linesFromCart(items, buffer) {
  if (items.length === 0) throw new PaymentError('장바구니가 비어 있습니다.', 400, 'EMPTY_CART');
  return items.map((item) => {
    try {
      assertSellable(item, item.quantity, buffer);
    } catch (error) {
      error.status = 400;
      throw error;
    }
    return { product_id: item.id, product_name: item.product_name, quantity: item.quantity, price: Number(item.discount_price || item.price) };
  });
}

// 결제 승인 직전·직후에 고정된 주문 내용으로 지금도 팔 수 있는지 다시 본다.
function assertLinesSellable(pharmacyId, lines) {
  const { buffer } = onlineStockGate(pharmacyId);
  for (const line of lines) {
    const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: line.product_id, pharmacy_id: pharmacyId });
    assertSellable(product, line.quantity, buffer);
  }
  return buffer;
}

/* ---------- 1) 결제 요청 ---------- */

function parseOrderDetails(orderType, body, customer) {
  const memo = cleanText(body.memo, MEMO_MAX_LENGTH);
  const contactName = cleanText(body.contact_name || customer.name, 50);
  const contactPhone = cleanText(body.contact_phone || customer.phone, 30);
  if (orderType === 'PICKUP') {
    const preferredAt = cleanText(body.preferred_at, 30);
    if (!preferredAt) throw new PaymentError('희망 픽업 일시를 입력해 주세요.');
    if (!contactName || !contactPhone) throw new PaymentError('수령인 정보를 입력해 주세요.');
    return { memo, preferred_at: preferredAt, contact_name: contactName, contact_phone: contactPhone };
  }
  const delivery = body.delivery || {};
  const address = cleanText(delivery.address, 200);
  if (!address) throw new PaymentError('배송지 주소를 입력해 주세요.');
  const receiverName = cleanText(delivery.receiver_name, 50) || customer.name;
  const receiverPhone = cleanText(delivery.receiver_phone, 30) || customer.phone;
  return {
    memo,
    preferred_at: null,
    contact_name: receiverName || contactName,
    contact_phone: receiverPhone || contactPhone,
    delivery: {
      receiver_name: receiverName,
      receiver_phone: receiverPhone,
      zip_code: cleanText(delivery.zip_code, 10),
      address,
      address_detail: cleanText(delivery.address_detail, 200)
    }
  };
}

function cartHash(orderType, lines, amount) {
  const key = JSON.stringify([orderType, amount, lines.map((l) => [l.product_id, l.quantity, l.price])]);
  return crypto.createHash('sha256').update(key).digest('hex');
}

function createCheckout({ userId, customer, pharmacyId, body }) {
  const config = paymentConfig();
  if (!config.enabled) throw new PaymentError(config.message, 503, 'PAYMENT_DISABLED');
  const orderType = String(body.order_type || '').toUpperCase();
  if (!ONLINE_TYPES.has(orderType)) throw new PaymentError('배송 주문 또는 매장 픽업만 결제할 수 있습니다.', 400, 'INVALID_ORDER_TYPE');
  if (!customer) throw new PaymentError('고객 정보를 찾을 수 없습니다.', 400, 'NO_MEMBER');
  const policy = mallPolicy(pharmacyId);
  if (orderType === 'DELIVERY' && !policy.delivery_enabled) throw new PaymentError('이 약국은 지금 배송 주문을 받지 않습니다. 매장 픽업으로 주문해 주세요.', 400, 'DELIVERY_DISABLED');
  if (orderType === 'PICKUP' && !policy.pickup_enabled) throw new PaymentError('이 약국은 지금 매장 픽업 주문을 받지 않습니다.', 400, 'PICKUP_DISABLED');

  const eligibility = onlineOrderStatus(customer);
  if (!eligibility.allowed) throw new PaymentError(eligibility.message, 403, eligibility.reason);
  const gate = onlineStockGate(pharmacyId);
  if (gate.paused) throw new PaymentError(gate.message, 409, 'STOCK_SYNC_PAUSED');

  // 같은 버튼을 두 번 눌러도 결제 요청은 하나만 만든다.
  const clientKey = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.checkout_key || '')) ? String(body.checkout_key) : null;
  if (clientKey) {
    const existing = getOne('SELECT * FROM online_checkouts WHERE customer_id = @customer_id AND client_key = @client_key', {
      customer_id: customer.id,
      client_key: clientKey
    });
    if (existing) return { checkout: existing, reused: true };
  }

  const lines = linesFromCart(cartItems(userId, pharmacyId), gate.buffer);
  const details = parseOrderDetails(orderType, body, customer);
  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const deliveryFee = orderType === 'DELIVERY' ? deliveryFeeFor(policy, total) : 0;
  const amount = total + deliveryFee;
  if (amount <= 0) throw new PaymentError('결제 금액이 0원인 주문은 받을 수 없습니다.', 400, 'ZERO_AMOUNT');
  const hash = cartHash(orderType, lines, amount);
  const payload = encrypt(JSON.stringify({ ...details, lines }));

  // 같은 장바구니로 결제 중인 요청이 있으면 새로 만들지 않고 이어 쓴다. 창 두 개에서 각각 결제되는 것을 막는다.
  const active = getOne(
    `SELECT * FROM online_checkouts
     WHERE customer_id = @customer_id AND cart_hash = @hash AND status IN ('READY', 'CONFIRMING', 'UNKNOWN', 'REFUND_REQUIRED')
       AND (status != 'READY' OR expires_at > datetime('now'))
     ORDER BY id DESC LIMIT 1`,
    { customer_id: customer.id, hash }
  );
  if (active && active.status !== 'READY') {
    throw new PaymentError('같은 장바구니의 결제 결과를 확인하고 있습니다. 잠시 후 주문 내역을 확인해 주세요.', 409, 'PAYMENT_IN_PROGRESS', {
      checkout_id: active.id
    });
  }
  if (active) {
    run("UPDATE online_checkouts SET payload = @payload, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'READY'", {
      id: active.id,
      payload
    });
    return { checkout: getCheckout(active.id), reused: true };
  }

  const recent = getOne(
    `SELECT o.order_number FROM online_checkouts c
     JOIN orders o ON o.id = c.order_id
     WHERE c.customer_id = @customer_id AND c.cart_hash = @hash AND c.status = 'DONE'
       AND c.confirmed_at > datetime('now', @window) AND o.order_status NOT IN ('CANCELED', 'REFUNDED')
     ORDER BY c.id DESC LIMIT 1`,
    { customer_id: customer.id, hash, window: `-${DUPLICATE_WINDOW_MINUTES} minutes` }
  );
  if (recent && body.allow_duplicate !== true) {
    throw new PaymentError(
      `${DUPLICATE_WINDOW_MINUTES}분 안에 같은 상품을 이미 결제했습니다(주문번호 ${recent.order_number}). 한 번 더 주문하려면 다시 확인해 주세요.`,
      409,
      'DUPLICATE_SUSPECTED',
      { order_number: recent.order_number }
    );
  }

  const first = lines[0].product_name;
  const orderName = (lines.length > 1 ? `${first} 외 ${lines.length - 1}건` : first).slice(0, 100);
  try {
    const result = run(
      `INSERT INTO online_checkouts (
        pharmacy_id, customer_id, user_id, order_type, pg_order_id, order_name, amount, total_product_amount, delivery_fee,
        cart_hash, client_key, payload, provider, payment_mode, expires_at
      ) VALUES (
        @pharmacy_id, @customer_id, @user_id, @order_type, @pg_order_id, @order_name, @amount, @total, @delivery_fee,
        @hash, @client_key, @payload, @provider, @mode, datetime('now', @ttl)
      )`,
      {
        pharmacy_id: pharmacyId,
        customer_id: customer.id,
        user_id: userId,
        order_type: orderType,
        pg_order_id: orderNumber(orderType === 'PICKUP' ? 'PCK' : 'ORD'),
        order_name: orderName,
        amount,
        total,
        delivery_fee: deliveryFee,
        hash,
        client_key: clientKey,
        payload,
        provider: config.provider,
        mode: config.mode,
        ttl: `+${ttlMinutes()} minutes`
      }
    );
    return { checkout: getCheckout(result.lastInsertRowid), reused: false };
  } catch (error) {
    if (clientKey && /UNIQUE/.test(error.message)) {
      return {
        checkout: getOne('SELECT * FROM online_checkouts WHERE customer_id = @customer_id AND client_key = @client_key', {
          customer_id: customer.id,
          client_key: clientKey
        }),
        reused: true
      };
    }
    throw error;
  }
}

/* ---------- 데모 결제창 ---------- */

function demoAuthorize(checkout, scenario, method) {
  const config = paymentConfig();
  if (config.provider !== 'DEMO' || !config.enabled || checkout.provider !== 'DEMO') {
    throw new PaymentError('(데모) 결제창은 데모 결제 모드에서만 쓸 수 있습니다.', 404, 'DEMO_DISABLED');
  }
  if (checkout.status !== 'READY') throw new PaymentError('이미 처리된 결제 요청입니다.', 409, 'CHECKOUT_CLOSED');
  if (getOne("SELECT 1 AS expired FROM online_checkouts WHERE id = @id AND expires_at <= datetime('now')", { id: checkout.id })) {
    closeCheckout(checkout.id, 'EXPIRED', { code: 'EXPIRED', message: '결제 시간이 지났습니다. 다시 주문해 주세요.', from: 'READY' });
    throw new PaymentError('결제 시간이 지났습니다. 다시 주문해 주세요.', 410, 'CHECKOUT_EXPIRED');
  }
  try {
    return demo.authorize({ orderId: checkout.pg_order_id, amount: checkout.amount, orderName: checkout.order_name, scenario, method });
  } catch (error) {
    if (error instanceof GatewayError) throw new PaymentError(error.message, error.status, error.code);
    throw error;
  }
}

/* ---------- 2) 승인 요청 ---------- */

async function confirmPayment({ customer, paymentKey, orderId, amount }) {
  const key = cleanText(paymentKey, 200);
  if (!key) throw new PaymentError('결제 키가 없습니다.', 400, 'PAYMENT_KEY_REQUIRED');
  const checkout = getOne('SELECT * FROM online_checkouts WHERE pg_order_id = @order_id', { order_id: cleanText(orderId, 64) });
  if (!checkout || !customer || checkout.customer_id !== customer.id) throw new PaymentError('결제 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');

  if (checkout.status === 'DONE') {
    if (checkout.payment_key === key) return outcome(checkout.id);
    throw new PaymentError('이 주문은 이미 다른 결제로 완료되었습니다. 이번 결제는 승인하지 않아 청구되지 않습니다.', 409, 'ALREADY_PAID');
  }
  if (PENDING_STATES.has(checkout.status)) {
    if (checkout.payment_key !== key) {
      throw new PaymentError('이 주문의 다른 결제를 확인하고 있습니다. 이번 결제는 승인하지 않아 청구되지 않습니다.', 409, 'PAYMENT_IN_PROGRESS');
    }
    return syncCheckout(checkout.id);
  }
  if (checkout.status !== 'READY') {
    throw new PaymentError(checkout.fail_message || '이미 끝난 결제 요청입니다. 다시 주문해 주세요.', checkout.status === 'EXPIRED' ? 410 : 409, 'CHECKOUT_CLOSED');
  }

  // 결제창에서 넘어온 금액은 고객 브라우저를 거친 값이라 서버가 고정한 금액과 다르면 승인하지 않는다.
  if (Number(amount) !== checkout.amount) {
    closeCheckout(checkout.id, 'FAILED', { code: 'AMOUNT_MISMATCH', message: '결제 금액이 주문 금액과 달라 승인하지 않았습니다.', from: 'READY' });
    throw new PaymentError('결제 금액이 주문 금액과 달라 승인하지 않았습니다. 청구되지 않습니다.', 400, 'AMOUNT_MISMATCH');
  }
  if (getOne("SELECT 1 AS expired FROM online_checkouts WHERE id = @id AND expires_at <= datetime('now')", { id: checkout.id })) {
    closeCheckout(checkout.id, 'EXPIRED', { code: 'EXPIRED', message: '결제 시간이 지나 승인하지 않았습니다. 다시 주문해 주세요.', from: 'READY' });
    throw new PaymentError('결제 시간이 지나 승인하지 않았습니다. 청구되지 않으니 다시 주문해 주세요.', 410, 'CHECKOUT_EXPIRED');
  }
  const config = paymentConfig();
  if (!config.enabled || config.provider !== checkout.provider || config.mode !== checkout.payment_mode) {
    throw new PaymentError('결제 설정이 바뀌어 이 결제를 승인할 수 없습니다. 청구되지 않으니 다시 주문해 주세요.', 503, 'PAYMENT_DISABLED');
  }
  const payload = readPayload(checkout);
  try {
    if (!payload) throw new PaymentError('주문 내용을 읽을 수 없습니다.', 409, 'CHECKOUT_CLOSED');
    assertLinesSellable(checkout.pharmacy_id, payload.lines);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    closeCheckout(checkout.id, 'FAILED', { code: error.reason, message: `${error.message} 결제는 승인하지 않았습니다.`, from: 'READY' });
    throw new PaymentError(`${error.message} 결제는 승인하지 않아 청구되지 않습니다.`, 409, error.reason);
  }

  // 한 결제 요청에는 한 번만 승인을 요청한다. 동시에 들어온 두 번째 요청은 여기서 멈춘다.
  const locked = run(
    `UPDATE online_checkouts
     SET status = 'CONFIRMING', payment_key = @key, attempt_count = attempt_count + 1,
         confirm_started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status = 'READY'`,
    { id: checkout.id, key }
  );
  if (locked.changes === 0) return confirmPayment({ customer, paymentKey: key, orderId, amount });

  let payment;
  try {
    payment = await gatewayFor(checkout.provider).confirm({
      paymentKey: key,
      orderId: checkout.pg_order_id,
      amount: checkout.amount,
      idempotencyKey: `confirm-${checkout.pg_order_id}`
    });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (!error.unknown) {
      closeCheckout(checkout.id, 'FAILED', { code: error.code, message: error.message, from: 'CONFIRMING' });
      return outcome(checkout.id);
    }
    run(
      "UPDATE online_checkouts SET status = 'UNKNOWN', fail_code = @code, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'CONFIRMING'",
      { id: checkout.id, code: error.code }
    );
    return syncCheckout(checkout.id);
  }
  return applyApproved(getCheckout(checkout.id), payment);
}

// 결제사가 승인했다고 한 결과를 그대로 믿지 않고 상태·주문번호·금액·결제 키를 다시 맞춰 본다.
function approvalProblem(checkout, payment) {
  if (payment.status !== 'DONE') return `결제 상태가 승인 완료가 아닙니다(${payment.status}).`;
  if (payment.orderId !== checkout.pg_order_id) return '결제사 주문번호가 다릅니다.';
  if (payment.totalAmount !== checkout.amount || payment.balanceAmount !== checkout.amount) return '승인 금액이 주문 금액과 다릅니다.';
  if (checkout.payment_key && payment.paymentKey !== checkout.payment_key) return '결제 키가 다릅니다.';
  return null;
}

async function applyApproved(checkout, payment) {
  if (checkout.status === 'DONE') {
    if (checkout.payment_key !== payment.paymentKey && payment.status === 'DONE' && payment.orderId === checkout.pg_order_id) {
      await voidPayment(checkout, payment, '같은 주문의 중복 결제');
    }
    return outcome(checkout.id);
  }
  const problem = approvalProblem(checkout, payment);
  if (problem) {
    if (payment.orderId === checkout.pg_order_id && payment.status === 'DONE') {
      return cancelAfterApproval(checkout, payment, { code: 'VERIFY_FAILED', message: `결제 검증 실패: ${problem}` });
    }
    closeCheckout(checkout.id, 'FAILED', { code: 'VERIFY_FAILED', message: `결제 검증 실패: ${problem}` });
    return outcome(checkout.id);
  }
  try {
    finalizeCheckout(checkout.id, payment);
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    if (error.reason === 'ALREADY_DONE') return outcome(checkout.id);
    return cancelAfterApproval(checkout, payment, { code: error.reason, message: error.message });
  }
  return outcome(checkout.id);
}

// 이 주문에 쓰이지 않는 승인 건을 결제사에서 취소한다(실패해도 다음 정산에서 다시 시도할 수 있도록 기록만 남긴다).
async function voidPayment(checkout, payment, reason) {
  try {
    const result = await gatewayFor(checkout.provider).cancel({
      paymentKey: payment.paymentKey,
      reason,
      idempotencyKey: `void-${payment.paymentKey}`.slice(0, 300)
    });
    return result.status === 'CANCELED';
  } catch (error) {
    run(
      `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
       VALUES (NULL, @pharmacy_id, 'PAYMENT_VOID_FAILED', 'CHECKOUT', @id, @description)`,
      { pharmacy_id: checkout.pharmacy_id, id: checkout.id, description: `${checkout.pg_order_id} 중복 승인 취소 실패: ${error.message}` }
    );
    return false;
  }
}

// 승인은 됐지만 주문을 만들 수 없을 때(재고 부족·검증 실패) 바로 결제를 취소한다. 실패하면 정산 작업이 다시 시도한다.
async function cancelAfterApproval(checkout, payment, { code, message }) {
  const marked = run(
    `UPDATE online_checkouts
     SET status = 'REFUND_REQUIRED', payment_key = COALESCE(payment_key, @key), fail_code = @code, fail_message = @message,
         payload = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status != 'DONE'`,
    { id: checkout.id, key: payment.paymentKey, code, message }
  );
  if (marked.changes === 0) return outcome(checkout.id);
  try {
    const result = await gatewayFor(checkout.provider).cancel({
      paymentKey: payment.paymentKey,
      reason: message.slice(0, 200),
      idempotencyKey: `void-${checkout.pg_order_id}`
    });
    if (result.status !== 'CANCELED') throw new GatewayError(`결제사 취소 결과가 ${result.status}입니다.`, { code: 'CANCEL_MISMATCH' });
    closeCheckout(checkout.id, 'CANCELED', { code, message: `${message} 결제는 자동으로 취소했습니다.`, from: 'REFUND_REQUIRED' });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
  }
  return outcome(checkout.id);
}

/* ---------- 3) 주문 생성: 결제 승인을 확인한 뒤에만 ---------- */

function finalizeCheckout(checkoutId, payment) {
  return transaction(() => {
    const checkout = getCheckout(checkoutId);
    if (checkout.status === 'DONE') throw new PaymentError('이미 주문이 만들어졌습니다.', 409, 'ALREADY_DONE');
    if (!['CONFIRMING', 'UNKNOWN', 'FAILED', 'EXPIRED'].includes(checkout.status)) {
      throw new PaymentError('닫힌 결제 요청이라 주문을 만들 수 없습니다.', 409, 'CHECKOUT_CLOSED');
    }
    const payload = readPayload(checkout);
    if (!payload) throw new PaymentError('결제 시간이 지나 주문서가 닫혔습니다.', 409, 'CHECKOUT_CLOSED');
    const customer = getOne('SELECT * FROM customers WHERE id = @id', { id: checkout.customer_id });
    if (!customer || customer.withdrawn_at) throw new PaymentError('탈퇴한 회원의 결제입니다.', 409, 'CHECKOUT_CLOSED');

    const buffer = assertLinesSellable(checkout.pharmacy_id, payload.lines);
    const created = run(
      `INSERT INTO orders (
        order_number, pharmacy_id, customer_id, order_type, total_product_amount, delivery_fee,
        discount_amount, final_amount, payment_status, order_status, delivery_status,
        preferred_at, memo, contact_name, contact_phone
      ) VALUES (
        @order_number, @pharmacy_id, @customer_id, @order_type, @total, @delivery_fee,
        0, @amount, 'READY', 'PAYMENT_PENDING', 'NOT_SHIPPED',
        @preferred_at, @memo, @contact_name, @contact_phone
      )`,
      {
        order_number: checkout.pg_order_id,
        pharmacy_id: checkout.pharmacy_id,
        customer_id: checkout.customer_id,
        order_type: checkout.order_type,
        total: checkout.total_product_amount,
        delivery_fee: checkout.delivery_fee,
        amount: checkout.amount,
        preferred_at: payload.preferred_at || null,
        memo: payload.memo || '',
        contact_name: payload.contact_name,
        contact_phone: payload.contact_phone
      }
    );
    const orderId = created.lastInsertRowid;

    for (const line of payload.lines) {
      const product = getOne('SELECT * FROM products WHERE id = @id', { id: line.product_id });
      run(
        `INSERT INTO order_items (
          order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, unit_cost, cost_amount, cost_source
        ) VALUES (
          @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @unit_cost, @cost_amount, @cost_source
        )`,
        {
          order_id: orderId,
          product_id: line.product_id,
          product_name: line.product_name,
          quantity: line.quantity,
          price: line.price,
          total_price: line.price * line.quantity,
          product_type: product.product_type || 'GENERAL',
          tax_type: product.tax_type || 'TAXABLE',
          ...saleCost(line.product_id, line.quantity)
        }
      );
      const stock = run(
        `UPDATE products
         SET stock_quantity = stock_quantity - @quantity,
             status = CASE WHEN stock_quantity - @quantity <= 0 THEN 'SOLD_OUT' ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id AND stock_quantity - @buffer >= @quantity`,
        { id: line.product_id, quantity: line.quantity, buffer }
      );
      if (stock.changes === 0) throw new PaymentError(`${line.product_name} 재고가 부족합니다.`, 409, 'OUT_OF_STOCK');
      run(
        `INSERT INTO inventory_logs (
          pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type, reference_id
        ) VALUES (
          @pharmacy_id, @product_id, 'ORDER', @before, @after, '온라인 결제 주문 재고 차감', @user_id, 'ORDER', @order_id
        )`,
        {
          pharmacy_id: checkout.pharmacy_id,
          product_id: line.product_id,
          before: product.stock_quantity,
          after: product.stock_quantity - line.quantity,
          user_id: checkout.user_id,
          order_id: orderId
        }
      );
    }

    if (checkout.order_type === 'DELIVERY') {
      const delivery = payload.delivery || {};
      run(
        `INSERT INTO deliveries (order_id, receiver_name, receiver_phone, zip_code, address, address_detail, delivery_status)
         VALUES (@order_id, @receiver_name, @receiver_phone, @zip_code, @address, @address_detail, 'NOT_SHIPPED')`,
        {
          order_id: orderId,
          receiver_name: delivery.receiver_name || payload.contact_name,
          receiver_phone: delivery.receiver_phone || payload.contact_phone,
          zip_code: delivery.zip_code || '',
          address: delivery.address || '',
          address_detail: delivery.address_detail || ''
        }
      );
    }

    const order = getOne('SELECT * FROM orders WHERE id = @id', { id: orderId });
    flow.recordHistory({ order, action: 'CREATE', to: 'CREATED', actorType: 'CUSTOMER', userId: checkout.user_id });
    flow.recordHistory({
      order,
      action: 'PAYMENT_REQUEST',
      from: 'CREATED',
      to: 'PAYMENT_PENDING',
      amount: checkout.amount,
      actorType: 'CUSTOMER',
      userId: checkout.user_id
    });
    run(
      `INSERT INTO payments (
        order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at,
        payment_key, pg_order_id, payment_mode, approved_at, receipt_url
      ) VALUES (
        @order_id, @method, @provider, 'PAID', @amount, CURRENT_TIMESTAMP,
        @payment_key, @pg_order_id, @mode, @approved_at, @receipt_url
      )`,
      {
        order_id: orderId,
        method: cleanText(payment.method || 'CARD', 50),
        provider: checkout.provider,
        amount: payment.totalAmount,
        payment_key: payment.paymentKey,
        pg_order_id: checkout.pg_order_id,
        mode: checkout.payment_mode,
        approved_at: payment.approvedAt || null,
        receipt_url: payment.receiptUrl || null
      }
    );
    run("UPDATE orders SET payment_status = 'PAID' WHERE id = @id", { id: orderId });
    flow.setStatus(order, 'PAYMENT_COMPLETED', {
      action: 'PAYMENT_APPROVED',
      actorType: 'SYSTEM',
      reason: `온라인 결제 승인 · ${providerLabel(checkout.provider, checkout.payment_mode)}`
    });

    const ids = payload.lines.map((l) => Number(l.product_id));
    run(
      `DELETE FROM carts WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id
         AND product_id IN (SELECT value FROM json_each(@ids))`,
      { user_id: checkout.user_id, pharmacy_id: checkout.pharmacy_id, ids: JSON.stringify(ids) }
    );
    const done = run(
      `UPDATE online_checkouts
       SET status = 'DONE', order_id = @order_id, payment_key = @payment_key, payload = NULL,
           fail_code = NULL, fail_message = NULL, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status = @from`,
      { id: checkout.id, order_id: orderId, payment_key: payment.paymentKey, from: checkout.status }
    );
    if (done.changes === 0) throw new PaymentError('이미 주문이 만들어졌습니다.', 409, 'ALREADY_DONE');
    return orderId;
  })();
}

/* ---------- 결과 맞추기(재시도) ---------- */

// 결과를 모르는 결제 요청을 결제사 조회로 맞춘다. 승인 전(인증만 된) 상태면 같은 멱등 키로 승인을 다시 요청한다.
async function syncCheckout(checkoutId) {
  const checkout = getCheckout(checkoutId);
  if (!checkout || !PENDING_STATES.has(checkout.status)) return outcome(checkoutId);
  const gateway = gatewayFor(checkout.provider);

  let payment;
  try {
    payment = await gateway.lookup({ paymentKey: checkout.payment_key, orderId: checkout.pg_order_id });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.code === 'NOT_FOUND_PAYMENT' && checkout.status !== 'REFUND_REQUIRED') {
      closeCheckout(checkout.id, 'FAILED', { code: 'NOT_FOUND_PAYMENT', message: '결제사에 승인된 결제가 없습니다. 청구되지 않았습니다.' });
    }
    return outcome(checkoutId);
  }

  if (checkout.status === 'REFUND_REQUIRED') {
    const message = checkout.fail_message || '주문을 만들 수 없는 결제입니다.';
    if (payment.status === 'CANCELED') {
      closeCheckout(checkout.id, 'CANCELED', { code: checkout.fail_code, message: `${message} 결제는 자동으로 취소했습니다.`, from: 'REFUND_REQUIRED' });
    } else if (payment.status === 'DONE') {
      return cancelAfterApproval(checkout, payment, { code: checkout.fail_code, message });
    }
    return outcome(checkoutId);
  }

  if (payment.status === 'DONE') return applyApproved(checkout, payment);
  if (['IN_PROGRESS', 'READY'].includes(payment.status) && checkout.payment_key) {
    const live = getOne("SELECT 1 AS ok FROM online_checkouts WHERE id = @id AND expires_at > datetime('now')", { id: checkout.id });
    if (!live) {
      closeCheckout(checkout.id, 'FAILED', { code: 'EXPIRED', message: '승인 시간이 지나 결제하지 않았습니다. 청구되지 않습니다.' });
      return outcome(checkoutId);
    }
    try {
      const retried = await gateway.confirm({
        paymentKey: checkout.payment_key,
        orderId: checkout.pg_order_id,
        amount: checkout.amount,
        idempotencyKey: `confirm-${checkout.pg_order_id}`
      });
      return applyApproved(getCheckout(checkout.id), retried);
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      if (!error.unknown) closeCheckout(checkout.id, 'FAILED', { code: error.code, message: error.message });
      return outcome(checkoutId);
    }
  }
  if (['ABORTED', 'EXPIRED', 'CANCELED', 'PARTIAL_CANCELED'].includes(payment.status)) {
    closeCheckout(checkout.id, 'FAILED', { code: payment.status, message: '결제가 승인되지 않았습니다. 청구되지 않습니다.' });
  }
  return outcome(checkoutId);
}

/* ---------- 결제사 웹훅 ---------- */

function webhookEventId(provider, headers, body) {
  const transmission = cleanText(headers['tosspayments-webhook-transmission-id'], 200);
  if (transmission) return transmission;
  return crypto.createHash('sha256').update(`${provider}:${JSON.stringify(body)}`).digest('hex');
}

// 웹훅 본문(상태·금액)은 믿지 않는다. 결제 키·주문번호만 꺼내 결제사에서 직접 다시 조회한 결과로 처리한다.
async function handleWebhook(providerParam, body, headers = {}) {
  const provider = String(providerParam || '').toUpperCase();
  const config = paymentConfig();
  if (!isGatewayProvider(provider) || (provider === 'DEMO' && !(config.provider === 'DEMO' && config.enabled))) {
    throw new PaymentError('알 수 없는 결제사입니다.', 404, 'UNKNOWN_PROVIDER');
  }
  const data = body && typeof body.data === 'object' && body.data ? body.data : body || {};
  const paymentKey = cleanText(data.paymentKey, 200) || null;
  const orderId = cleanText(data.orderId, 64) || null;
  if (!paymentKey && !orderId) return { ignored: true };

  const eventId = webhookEventId(provider, headers, body);
  const inserted = run(
    `INSERT OR IGNORE INTO payment_events (provider, event_id, event_type, pg_order_id, payment_key)
     VALUES (@provider, @event_id, @event_type, @order_id, @payment_key)`,
    { provider, event_id: eventId, event_type: cleanText(body?.eventType, 50) || null, order_id: orderId, payment_key: paymentKey }
  );
  const event = getOne('SELECT * FROM payment_events WHERE provider = @provider AND event_id = @event_id', { provider, event_id: eventId });
  if (!inserted.changes) {
    if (event.processed_at) return { duplicate: true, result: event.result };
    run('UPDATE payment_events SET attempts = attempts + 1 WHERE id = @id', { id: event.id });
  }

  try {
    const result = await reconcilePayment({ provider, paymentKey, orderId });
    run('UPDATE payment_events SET processed_at = CURRENT_TIMESTAMP, result = @result, error = NULL WHERE id = @id', { id: event.id, result });
    return { result };
  } catch (error) {
    run('UPDATE payment_events SET error = @error WHERE id = @id', { id: event.id, error: String(error.message).slice(0, 500) });
    throw error;
  }
}

async function reconcilePayment({ provider, paymentKey, orderId }) {
  let payment;
  try {
    payment = await gatewayFor(provider).lookup({ paymentKey, orderId });
  } catch (error) {
    if (error instanceof GatewayError && error.code === 'NOT_FOUND_PAYMENT') return 'NOT_FOUND';
    throw error;
  }
  const checkout = getOne('SELECT * FROM online_checkouts WHERE pg_order_id = @order_id AND provider = @provider', {
    order_id: payment.orderId,
    provider
  });
  if (!checkout) return 'UNKNOWN_ORDER';

  if (payment.status === 'DONE') {
    if (checkout.status === 'DONE') {
      if (checkout.payment_key === payment.paymentKey) return 'ALREADY_DONE';
      return (await voidPayment(checkout, payment, '같은 주문의 중복 결제')) ? 'DUPLICATE_CANCELED' : 'DUPLICATE_CANCEL_FAILED';
    }
    if (checkout.payment_key && checkout.payment_key !== payment.paymentKey) {
      return (await voidPayment(checkout, payment, '같은 주문의 중복 결제')) ? 'DUPLICATE_CANCELED' : 'DUPLICATE_CANCEL_FAILED';
    }
    if (checkout.status === 'REFUND_REQUIRED') return (await syncCheckout(checkout.id)).state;
    if (checkout.status === 'CANCELED') return 'ALREADY_CANCELED';
    run(
      `UPDATE online_checkouts SET payment_key = @key, status = CASE WHEN status = 'READY' THEN 'UNKNOWN' ELSE status END,
         updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
      { id: checkout.id, key: payment.paymentKey }
    );
    return (await applyApproved(getCheckout(checkout.id), payment)).state;
  }

  if (payment.status === 'CANCELED' || payment.status === 'PARTIAL_CANCELED') {
    if (checkout.status === 'DONE' && checkout.order_id) return syncExternalCancel(checkout, payment);
    if (PENDING_STATES.has(checkout.status)) return (await syncCheckout(checkout.id)).state;
    return 'NO_CHANGE';
  }
  if (PENDING_STATES.has(checkout.status)) return (await syncCheckout(checkout.id)).state;
  return 'NO_CHANGE';
}

// 결제사 관리 화면 등 바깥에서 결제가 취소된 경우. 전액 취소이고 아직 되돌릴 수 있는 주문이면 주문도 취소한다.
// 그렇지 않으면(부분 취소·이미 배송 완료) 자동으로 바꾸지 않고 약국이 확인하도록 표시한다.
async function syncExternalCancel(checkout, payment) {
  const order = getOne('SELECT * FROM orders WHERE id = @id', { id: checkout.order_id });
  const ours = flow.paidPayments(order.id).filter((p) => p.payment_key === payment.paymentKey);
  if (ours.length === 0) return 'ALREADY_REVERSED';
  // 우리가 요청한 취소의 응답을 못 받은 경우: 결제사가 취소를 확인해 줬으니 주문 정리를 이어서 한다.
  if (order.cancel_lock_at) return `CANCEL_${await resumeReversal(order.id)}`;

  const kind = flow.CANCELABLE[order.order_type]?.includes(order.order_status)
    ? 'CANCEL'
    : flow.REFUNDABLE[order.order_type]?.includes(order.order_status)
      ? 'REFUND'
      : null;
  if (payment.balanceAmount !== 0 || !kind) {
    const canceled = payment.totalAmount - payment.balanceAmount;
    const alert = `결제사에서 ${canceled.toLocaleString('ko-KR')}원이 취소되었습니다. 주문 상태와 맞지 않아 자동 처리하지 않았습니다. 확인해 주세요.`;
    transaction(() => {
      run('UPDATE orders SET payment_alert = @alert, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: order.id, alert });
      run(
        `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
         VALUES (NULL, @pharmacy_id, 'PAYMENT_EXTERNAL_CANCEL', 'ORDER', @id, @description)`,
        { pharmacy_id: order.pharmacy_id, id: order.id, description: `${order.order_number} ${alert}` }
      );
    })();
    return 'ALERT';
  }

  const gatewayCancels = new Map(ours.map((p) => [p.id, { transactionKey: payment.cancels.at(-1)?.transactionKey || null }]));
  transaction(() => {
    const fresh = getOne('SELECT * FROM orders WHERE id = @id', { id: order.id });
    const options = { reason: '결제사에서 결제가 취소됨', userId: null, actorType: 'SYSTEM', gatewayCancels };
    if (kind === 'CANCEL') flow.cancelOrder(fresh, options);
    else flow.refundOrder(fresh, { ...options, restock: false });
  })();
  return kind === 'CANCEL' ? 'EXTERNAL_CANCELED' : 'EXTERNAL_REFUNDED';
}

/* ---------- 주문 취소·환불: 결제사 취소가 확인된 뒤에만 주문·재고·매출을 되돌린다 ---------- */

function gatewayPayments(order) {
  if (order.final_amount <= 0) return [];
  return flow.paidPayments(order.id).filter((p) => isGatewayProvider(p.payment_provider) && p.payment_key);
}

function applyReversal(orderId, request, gatewayCancels) {
  return transaction(() => {
    const order = getOne('SELECT * FROM orders WHERE id = @id', { id: orderId });
    const options = { reason: request.reason, userId: request.userId, actorType: request.actorType, gatewayCancels };
    const result = request.kind === 'CANCEL' ? flow.cancelOrder(order, options) : flow.refundOrder(order, { ...options, restock: request.restock });
    if (request.audit) {
      run(
        `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
         VALUES (@user_id, @pharmacy_id, @action, 'ORDER', @target_id, @description)`,
        { ...request.audit, target_id: order.id }
      );
    }
    return result;
  })();
}

function releaseCancelLock(orderId, alert = null) {
  run(
    `UPDATE orders SET cancel_lock_at = NULL, cancel_request = NULL,
       payment_alert = COALESCE(@alert, payment_alert), updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id: orderId, alert }
  );
}

async function cancelAtGateway(payment, reason) {
  const gateway = gatewayFor(payment.payment_provider);
  const idempotencyKey = `cancel-${payment.id}-${payment.payment_key}`.slice(0, 300);
  let result;
  try {
    result = await gateway.cancel({ paymentKey: payment.payment_key, reason, idempotencyKey });
  } catch (error) {
    if (!(error instanceof GatewayError) || error.code !== 'ALREADY_CANCELED_PAYMENT') throw error;
    result = await gateway.lookup({ paymentKey: payment.payment_key });
  }
  if (result.status !== 'CANCELED' || result.balanceAmount !== 0) {
    throw new GatewayError(`결제사 취소 결과가 전액 취소가 아닙니다(${result.status}).`, { code: 'CANCEL_MISMATCH' });
  }
  return { transactionKey: result.cancels.at(-1)?.transactionKey || null };
}

async function finishReversal(orderId, request) {
  const order = getOne('SELECT * FROM orders WHERE id = @id', { id: orderId });
  const cancels = new Map();
  try {
    for (const payment of gatewayPayments(order)) cancels.set(payment.id, await cancelAtGateway(payment, request.reason));
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.unknown) {
      throw new flow.OrderFlowError('결제사 응답이 늦어 취소 결과를 확인하고 있습니다. 잠시 후 주문 상태를 다시 확인해 주세요.', 502, 'PG_CANCEL_PENDING');
    }
    if (cancels.size === 0) releaseCancelLock(orderId);
    throw new flow.OrderFlowError(`결제사에서 취소를 처리하지 못해 주문을 그대로 두었습니다. (${error.message})`, 502, 'PG_CANCEL_FAILED');
  }
  try {
    return applyReversal(orderId, request, cancels);
  } catch (error) {
    releaseCancelLock(orderId, `결제사 취소는 끝났지만 주문 정리에 실패했습니다: ${error.message}`);
    throw error;
  }
}

// kind: CANCEL | REFUND. 결제사 결제가 있으면 주문을 잠그고 결제사 취소 → 주문·재고·매출 되돌리기 순서로 처리한다.
async function reverseOnlineOrder(order, { kind, reason, restock = kind === 'CANCEL', userId, actorType, audit = null }) {
  flow.assertReversible(order, kind, actorType);
  if (order.cancel_lock_at) throw new flow.OrderFlowError('결제 취소를 처리하는 중인 주문입니다. 잠시 후 다시 확인해 주세요.', 409, 'CANCEL_IN_PROGRESS');
  const request = { kind, reason, restock, userId, actorType, audit };
  if (gatewayPayments(order).length === 0) return applyReversal(order.id, request, new Map());

  const locked = run(
    `UPDATE orders SET cancel_lock_at = CURRENT_TIMESTAMP, cancel_request = @request, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND order_status = @status AND cancel_lock_at IS NULL`,
    { id: order.id, status: order.order_status, request: JSON.stringify(request) }
  );
  if (locked.changes === 0) throw new flow.OrderFlowError('다른 화면에서 주문 상태가 먼저 바뀌었습니다. 새로고침해 주세요.', 409, 'STALE');
  return finishReversal(order.id, request);
}

// 결제사 취소 도중 멈춘 주문(서버 재시작·응답 끊김)을 이어서 처리한다.
async function resumeReversal(orderId) {
  const order = getOne('SELECT * FROM orders WHERE id = @id', { id: orderId });
  if (!order?.cancel_lock_at) return 'NOT_LOCKED';
  let request;
  try {
    request = JSON.parse(order.cancel_request);
  } catch {
    request = null;
  }
  if (!request) {
    releaseCancelLock(orderId, '취소 요청 내용을 읽지 못해 잠금을 풀었습니다. 결제사 취소 여부를 확인해 주세요.');
    return 'RELEASED';
  }
  try {
    await finishReversal(orderId, request);
    return 'COMPLETED';
  } catch (error) {
    if (error.reason === 'PG_CANCEL_PENDING') return 'PENDING';
    if (error.reason === 'PG_CANCEL_FAILED') {
      releaseCancelLock(orderId, `결제사 취소를 이어서 처리하지 못했습니다: ${error.message}`);
      return 'FAILED';
    }
    return 'RELEASED';
  }
}

/* ---------- 정산 작업 ---------- */

async function runPaymentReconcile() {
  const summary = { expired: 0, checked: 0, done: 0, failed: 0, canceled: 0, pending: 0, cancel_resumed: 0, errors: 0 };
  summary.expired = run(
    `UPDATE online_checkouts
     SET status = 'EXPIRED', payload = NULL, fail_code = 'EXPIRED', fail_message = '결제 시간이 지나 주문서를 닫았습니다. 청구되지 않았습니다.',
         updated_at = CURRENT_TIMESTAMP
     WHERE status = 'READY' AND expires_at <= datetime('now')`
  ).changes;

  const stale = `-${staleSeconds()} seconds`;
  const pending = getAll(
    `SELECT id FROM online_checkouts
     WHERE status IN ('UNKNOWN', 'REFUND_REQUIRED')
        OR (status = 'CONFIRMING' AND confirm_started_at <= datetime('now', @stale))
     ORDER BY id ASC LIMIT 200`,
    { stale }
  );
  for (const { id } of pending) {
    summary.checked += 1;
    try {
      const { state } = await syncCheckout(id);
      if (state === 'DONE') summary.done += 1;
      else if (state === 'FAILED' || state === 'EXPIRED') summary.failed += 1;
      else if (state === 'CANCELED') summary.canceled += 1;
      else summary.pending += 1;
    } catch (error) {
      summary.errors += 1;
    }
  }

  const locks = getAll('SELECT id FROM orders WHERE cancel_lock_at IS NOT NULL AND cancel_lock_at <= datetime(\'now\', @stale) LIMIT 200', { stale });
  for (const { id } of locks) {
    const result = await resumeReversal(id).catch(() => 'ERROR');
    if (result === 'COMPLETED') summary.cancel_resumed += 1;
    else if (result === 'ERROR') summary.errors += 1;
  }
  return summary;
}

function startPaymentSchedule(logger = console) {
  const seconds = Number(process.env.PAYMENT_RECONCILE_INTERVAL_SECONDS ?? (process.env.NODE_ENV === 'test' ? 0 : 60));
  if (!seconds) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runPaymentReconcile();
      const { checked, expired, ...rest } = result;
      if (Object.values(rest).some(Boolean)) logger.log('[payments] 결제 정산', result);
    } catch (error) {
      logger.error('[payments] 결제 정산 실패', error);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, seconds * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// 약국 화면용: 결과 확인이 필요한 결제 요청과 결제사 취소 알림.
function attentionList(pharmacyId) {
  const checkouts = getAll(
    `SELECT c.*, cu.name AS customer_name FROM online_checkouts c
     LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE c.pharmacy_id = @pharmacy_id
       AND (c.status IN ('CONFIRMING', 'UNKNOWN', 'REFUND_REQUIRED')
            OR (c.status IN ('FAILED', 'CANCELED') AND c.updated_at > datetime('now', '-3 days')))
     ORDER BY c.id DESC LIMIT 100`,
    { pharmacy_id: pharmacyId }
  ).map((row) => ({ ...publicCheckout(row), customer_name: row.customer_name }));
  const orders = getAll(
    `SELECT id, order_number, order_status, final_amount, payment_alert, cancel_lock_at FROM orders
     WHERE pharmacy_id = @pharmacy_id AND (payment_alert IS NOT NULL OR cancel_lock_at IS NOT NULL)
     ORDER BY id DESC LIMIT 100`,
    { pharmacy_id: pharmacyId }
  );
  return { checkouts, orders };
}

module.exports = {
  CHECKOUT_STATUS_LABELS,
  PaymentError,
  attentionList,
  confirmPayment,
  createCheckout,
  demoAuthorize,
  getCheckout,
  handleWebhook,
  outcome,
  publicCheckout,
  reconcilePayment,
  reverseOnlineOrder,
  runPaymentReconcile,
  startPaymentSchedule,
  syncCheckout
};
