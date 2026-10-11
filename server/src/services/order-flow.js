const { getAll, getOne, run } = require('../db');
const { refundCost } = require('./order-cost');

class OrderFlowError extends Error {
  constructor(message, status = 409, reason = 'INVALID_TRANSITION') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const STATUS_LABELS = {
  CREATED: '주문 생성',
  PAYMENT_PENDING: '결제 대기',
  PAYMENT_COMPLETED: '결제 완료',
  PREPARING: '상품 준비',
  READY_FOR_PICKUP: '픽업 대기',
  SHIPPING: '배송중',
  PICKED_UP: '픽업 완료',
  DELIVERED: '배송 완료',
  RESERVED: '예약 접수',
  CONFIRMED: '상담 확정',
  COMPLETED: '완료',
  CANCELED: '취소',
  REFUNDED: '환불 완료'
};

const ACTION_LABELS = {
  CREATE: '주문 생성',
  PAYMENT_REQUEST: '결제 요청',
  PAYMENT_APPROVED: '결제 승인',
  TRANSITION: '상태 변경',
  COUNTER_PICKUP: '카운터 수령',
  COUNSEL_SALE: '상담 후 구매',
  CANCEL: '주문 취소',
  REFUND: '환불'
};

// 정상 진행 경로만 둔다. 취소·환불은 cancelOrder/refundOrder로만 처리한다.
// 결제 단계(생성 → 결제 대기 → 결제 완료)는 결제 승인으로만 넘어가고, 약국이 직접 바꿀 수 없다.
const FLOWS = {
  DELIVERY: {
    CREATED: ['PAYMENT_PENDING'],
    PAYMENT_PENDING: ['PAYMENT_COMPLETED'],
    PAYMENT_COMPLETED: ['PREPARING'],
    PREPARING: ['SHIPPING'],
    SHIPPING: ['DELIVERED']
  },
  PICKUP: {
    CREATED: ['PAYMENT_PENDING'],
    PAYMENT_PENDING: ['PAYMENT_COMPLETED'],
    PAYMENT_COMPLETED: ['PREPARING'],
    PREPARING: ['READY_FOR_PICKUP'],
    READY_FOR_PICKUP: ['PICKED_UP']
  },
  COUNSEL: {
    RESERVED: ['CONFIRMED', 'COMPLETED'],
    CONFIRMED: ['COMPLETED']
  }
};
const SYSTEM_ONLY_TARGETS = new Set(['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED']);
const ONLINE_ORDER_TYPES = new Set(Object.keys(FLOWS));

// 아직 내보내지 않은 주문만 취소할 수 있다. 배송 출발·수령 뒤에는 환불로 처리한다.
const CANCELABLE = {
  DELIVERY: ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'PREPARING'],
  PICKUP: ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'PREPARING', 'READY_FOR_PICKUP'],
  COUNSEL: ['RESERVED', 'CONFIRMED']
};
// 고객은 약국이 상품 준비를 시작하기 전까지만 스스로 취소할 수 있다.
const CUSTOMER_CANCELABLE = {
  DELIVERY: ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED'],
  PICKUP: ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED'],
  COUNSEL: ['RESERVED']
};
const REFUNDABLE = { DELIVERY: ['DELIVERED'], PICKUP: ['PICKED_UP'] };

const label = (status) => STATUS_LABELS[status] || status;

function orderTypeOf(order) {
  return order.order_type || 'DELIVERY';
}

function assertOnlineOrder(order) {
  if (!order) throw new OrderFlowError('주문을 찾을 수 없습니다.', 404, 'NOT_FOUND');
  if (!ONLINE_ORDER_TYPES.has(orderTypeOf(order)) || order.sales_channel === 'POS') {
    throw new OrderFlowError('매장 POS 거래는 POS의 취소·반품 메뉴에서 처리해 주세요.', 400, 'NOT_ONLINE_ORDER');
  }
}

// 약국 직원이 지금 누를 수 있는 다음 상태.
function nextStatuses(order) {
  const flow = FLOWS[orderTypeOf(order)] || {};
  return (flow[order.order_status] || []).filter((status) => !SYSTEM_ONLY_TARGETS.has(status));
}

function availableActions(order, role) {
  const type = orderTypeOf(order);
  const customer = role === 'CUSTOMER';
  if (order.cancel_lock_at) return { next_statuses: [], can_cancel: false, can_refund: false, cancel_in_progress: true };
  return {
    next_statuses: customer ? [] : nextStatuses(order),
    can_cancel: (customer ? CUSTOMER_CANCELABLE : CANCELABLE)[type]?.includes(order.order_status) || false,
    can_refund: !customer && (REFUNDABLE[type]?.includes(order.order_status) || false)
  };
}

function assertTransition(order, to, { actorType = 'STAFF' } = {}) {
  assertOnlineOrder(order);
  if (to === 'CANCELED' || to === 'REFUNDED') {
    throw new OrderFlowError('취소·환불은 상태 변경이 아니라 취소/환불 처리로 진행해 주세요.', 400, 'USE_CANCEL_OR_REFUND');
  }
  if (!STATUS_LABELS[to]) throw new OrderFlowError('알 수 없는 주문 상태입니다.', 400, 'UNKNOWN_STATUS');
  if (actorType !== 'SYSTEM' && SYSTEM_ONLY_TARGETS.has(to)) {
    throw new OrderFlowError('결제 상태는 결제 승인 결과로만 바뀝니다.', 403, 'SYSTEM_ONLY');
  }
  const allowed = (FLOWS[orderTypeOf(order)] || {})[order.order_status] || [];
  if (!allowed.includes(to)) {
    const hint = nextStatuses(order).map(label).join(', ');
    throw new OrderFlowError(
      `${label(order.order_status)} 상태에서는 ${label(to)}(으)로 바꿀 수 없습니다.${hint ? ` 다음 단계: ${hint}` : ''}`
    );
  }
}

function deliveryStatusFor(type, status, current) {
  if (type === 'DELIVERY') {
    if (status === 'SHIPPING' || status === 'DELIVERED') return status;
    return 'NOT_SHIPPED';
  }
  if (type === 'PICKUP') {
    if (status === 'READY_FOR_PICKUP' || status === 'PICKED_UP') return status;
    return 'NOT_SHIPPED';
  }
  return current || 'NOT_SHIPPED';
}

function recordHistory({ order, action, from = null, to, reason = null, amount = null, actorType = 'STAFF', userId = null }) {
  run(
    `INSERT INTO order_status_history (order_id, pharmacy_id, action, from_status, to_status, reason, amount, actor_type, created_by)
     VALUES (@order_id, @pharmacy_id, @action, @from_status, @to_status, @reason, @amount, @actor_type, @created_by)`,
    {
      order_id: order.id,
      pharmacy_id: order.pharmacy_id,
      action,
      from_status: from,
      to_status: to,
      reason,
      amount,
      actor_type: actorType,
      created_by: userId
    }
  );
}

// 상태를 바꾼다. 다른 요청이 먼저 바꿨거나(현재 상태가 다르면) 결제 취소가 진행 중이면 실패한다.
function setStatus(order, to, { action = 'TRANSITION', actorType = 'STAFF', userId = null, reason = null, extra = {} } = {}) {
  const type = orderTypeOf(order);
  const deliveryStatus = deliveryStatusFor(type, to, order.delivery_status);
  const updated = run(
    `UPDATE orders
     SET order_status = @to, delivery_status = @delivery_status, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND order_status = @from AND cancel_lock_at IS NULL`,
    { id: order.id, to, from: order.order_status, delivery_status: deliveryStatus }
  );
  if (updated.changes === 0) {
    const locked = getOne('SELECT cancel_lock_at FROM orders WHERE id = @id', { id: order.id })?.cancel_lock_at;
    if (locked) throw new OrderFlowError('결제 취소를 처리하는 중인 주문입니다. 잠시 후 다시 확인해 주세요.', 409, 'CANCEL_IN_PROGRESS');
    throw new OrderFlowError('다른 화면에서 주문 상태가 먼저 바뀌었습니다. 새로고침해 주세요.', 409, 'STALE');
  }

  if (type === 'DELIVERY') {
    run(
      `UPDATE deliveries
       SET courier = COALESCE(@courier, courier),
           tracking_number = COALESCE(@tracking_number, tracking_number),
           delivery_status = @delivery_status,
           shipped_at = CASE WHEN @to = 'SHIPPING' THEN CURRENT_TIMESTAMP ELSE shipped_at END,
           delivered_at = CASE WHEN @to = 'DELIVERED' THEN CURRENT_TIMESTAMP ELSE delivered_at END
       WHERE order_id = @order_id`,
      {
        order_id: order.id,
        to,
        delivery_status: deliveryStatus,
        courier: extra.courier || null,
        tracking_number: extra.tracking_number || null
      }
    );
  }
  recordHistory({ order, action, from: order.order_status, to, reason, actorType, userId });
  return { ...order, order_status: to, delivery_status: deliveryStatus };
}

function transition(order, to, options = {}) {
  assertTransition(order, to, options);
  if (to === 'SHIPPING') {
    const courier = String(options.extra?.courier || '').trim();
    const tracking = String(options.extra?.tracking_number || '').trim();
    if (!courier || !tracking) throw new OrderFlowError('배송중으로 바꾸려면 택배사와 송장번호를 입력해 주세요.', 400, 'TRACKING_REQUIRED');
  }
  return setStatus(order, to, options);
}

function orderNumber(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
}

function paidPayments(orderId) {
  return getAll("SELECT * FROM payments WHERE order_id = @id AND payment_status = 'PAID' AND paid_amount > 0 ORDER BY id ASC", { id: orderId });
}

// 결제를 취소 처리한다. 결제사 결제는 결제사가 취소를 확인해 준 건(gatewayCancels)만 취소로 바꾼다.
// 예전 데모(MOCK) 결제는 결제사가 없으므로 바로 취소한다. 취소 금액이 주문 금액과 맞는지 확인한다.
function cancelPayments(order, kind, gatewayCancels = new Map()) {
  const payments = paidPayments(order.id);
  const paid = payments.reduce((sum, p) => sum + p.paid_amount, 0);
  if (paid !== order.final_amount) {
    throw new OrderFlowError(`결제 금액(${paid.toLocaleString('ko-KR')}원)이 주문 금액과 달라 자동 ${kind === 'REFUND' ? '환불' : '취소'}할 수 없습니다.`, 409, 'PAYMENT_MISMATCH');
  }
  const unconfirmed = payments.find((p) => p.payment_provider !== 'MOCK' && !gatewayCancels.has(p.id));
  if (unconfirmed) throw new OrderFlowError('결제사 취소가 확인되지 않아 주문을 취소할 수 없습니다.', 409, 'PAYMENT_PROVIDER');

  const status = kind === 'REFUND' ? 'REFUNDED' : 'CANCELED';
  for (const payment of payments) {
    const result = run(
      `UPDATE payments
       SET payment_status = @status,
           canceled_at = CASE WHEN @status = 'CANCELED' THEN CURRENT_TIMESTAMP ELSE canceled_at END,
           refunded_at = CASE WHEN @status = 'REFUNDED' THEN CURRENT_TIMESTAMP ELSE refunded_at END,
           cancel_transaction_key = COALESCE(@transaction_key, cancel_transaction_key)
       WHERE id = @id AND payment_status = 'PAID'`,
      { id: payment.id, status, transaction_key: gatewayCancels.get(payment.id)?.transactionKey || null }
    );
    if (result.changes === 0) throw new OrderFlowError('결제가 이미 취소되었습니다.', 409, 'PAYMENT_ALREADY_CANCELED');
  }
  return { payments, status };
}

// 매출·원가를 되돌리는 음수 주문. 취소·환불한 날짜의 매출에서 빠지도록 원주문은 그대로 둔다.
function createReversalOrder(order, items, payments, { reason, paymentStatus }) {
  const lines = items
    .map((item) => ({ item, quantity: item.quantity - (item.refunded_quantity || 0) }))
    .filter((line) => line.quantity > 0);
  const gross = lines.reduce((sum, { item, quantity }) => sum + item.price * quantity, 0);
  const result = run(
    `INSERT INTO orders (
      order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, delivery_fee,
      discount_amount, final_amount, payment_status, order_status, delivery_status, contact_name, contact_phone,
      original_order_id, refund_reason
    ) VALUES (
      @order_number, @pharmacy_id, @customer_id, 'ONLINE_REFUND', @sales_channel, @total_product_amount, @delivery_fee,
      @discount_amount, @final_amount, @payment_status, 'COMPLETED', 'NOT_APPLICABLE', @contact_name, @contact_phone,
      @original_order_id, @refund_reason
    )`,
    {
      order_number: orderNumber('ORF'),
      pharmacy_id: order.pharmacy_id,
      customer_id: order.customer_id,
      sales_channel: order.sales_channel || 'ONLINE',
      total_product_amount: -gross,
      delivery_fee: -(order.delivery_fee || 0),
      discount_amount: -(order.discount_amount || 0),
      final_amount: -order.final_amount,
      payment_status: paymentStatus,
      contact_name: order.contact_name,
      contact_phone: order.contact_phone,
      original_order_id: order.id,
      refund_reason: reason
    }
  );
  const reversalId = result.lastInsertRowid;

  for (const { item, quantity } of lines) {
    const amount = item.price * quantity - Math.round(((item.discount_amount || 0) * quantity) / item.quantity);
    const cost = refundCost(item, quantity);
    run(
      `INSERT INTO order_items (
        order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, discount_amount,
        unit_cost, cost_amount, cost_source
      ) VALUES (
        @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @discount_amount,
        @unit_cost, @cost_amount, @cost_source
      )`,
      {
        order_id: reversalId,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: -quantity,
        price: item.price,
        total_price: -(item.price * quantity),
        product_type: item.product_type,
        tax_type: item.tax_type,
        discount_amount: -(item.price * quantity - amount),
        ...cost
      }
    );
    const updated = run(
      `UPDATE order_items
       SET refunded_quantity = COALESCE(refunded_quantity, 0) + @quantity,
           refunded_amount = COALESCE(refunded_amount, 0) + @amount
       WHERE id = @id AND COALESCE(refunded_quantity, 0) + @quantity <= quantity`,
      { id: item.id, quantity, amount }
    );
    if (updated.changes === 0) throw new OrderFlowError(`${item.product_name}은(는) 이미 환불되었습니다.`, 409, 'ALREADY_REFUNDED');
  }

  for (const payment of payments) {
    run(
      `INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at, payment_key, payment_mode)
       VALUES (@order_id, @payment_method, @payment_provider, @payment_status, @paid_amount, CURRENT_TIMESTAMP, @payment_key, @payment_mode)`,
      {
        order_id: reversalId,
        payment_method: payment.payment_method,
        payment_provider: payment.payment_provider,
        payment_status: paymentStatus,
        paid_amount: -payment.paid_amount,
        payment_key: payment.payment_key || null,
        payment_mode: payment.payment_mode || null
      }
    );
  }
  return reversalId;
}

// 판매로 줄였던 재고를 되돌린다. 줄어든 만큼 정확히 늘었는지 확인한다.
function restoreStock(order, items, { userId, reason }) {
  const restored = [];
  for (const item of items) {
    const quantity = item.quantity - (item.refunded_quantity || 0);
    if (quantity <= 0) continue;
    const product = getOne('SELECT id, stock_quantity FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: item.product_id,
      pharmacy_id: order.pharmacy_id
    });
    if (!product) throw new OrderFlowError(`${item.product_name} 상품이 삭제되어 재고를 되돌릴 수 없습니다.`, 409, 'PRODUCT_MISSING');
    run(
      `UPDATE products
       SET stock_quantity = stock_quantity + @quantity,
           status = CASE WHEN status = 'SOLD_OUT' THEN 'ON_SALE' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @id`,
      { id: product.id, quantity }
    );
    const after = getOne('SELECT stock_quantity FROM products WHERE id = @id', { id: product.id }).stock_quantity;
    if (after !== product.stock_quantity + quantity) throw new OrderFlowError('재고 원복 결과가 맞지 않아 취소를 중단했습니다.', 500, 'STOCK_MISMATCH');
    run(
      `INSERT INTO inventory_logs (
        pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type, reference_id
      ) VALUES (
        @pharmacy_id, @product_id, 'ORDER_CANCEL', @before, @after, @reason, @created_by, 'ORDER', @order_id
      )`,
      {
        pharmacy_id: order.pharmacy_id,
        product_id: product.id,
        before: product.stock_quantity,
        after,
        reason,
        created_by: userId,
        order_id: order.id
      }
    );
    restored.push({ product_id: product.id, product_name: item.product_name, quantity });
  }
  return restored;
}

function reverseOrder(order, { kind, reason, restock, userId, actorType, gatewayCancels }) {
  const items = getAll('SELECT * FROM order_items WHERE order_id = @id ORDER BY id ASC', { id: order.id });
  let reversalId = null;
  let paymentStatus = order.payment_status;
  let restored = [];
  if (order.final_amount > 0) {
    const canceled = cancelPayments(order, kind, gatewayCancels);
    paymentStatus = canceled.status;
    if (restock) restored = restoreStock(order, items, { userId, reason: kind === 'REFUND' ? '온라인 환불 재입고' : '온라인 주문 취소 재고 원복' });
    reversalId = createReversalOrder(order, items, canceled.payments, { reason, paymentStatus });
  }

  const to = kind === 'REFUND' ? 'REFUNDED' : 'CANCELED';
  const updated = run(
    `UPDATE orders
     SET order_status = @to, payment_status = @payment_status, refund_reason = @reason,
         canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         cancel_lock_at = NULL, cancel_request = NULL
     WHERE id = @id AND order_status = @from`,
    { id: order.id, to, from: order.order_status, payment_status: paymentStatus, reason }
  );
  if (updated.changes === 0) throw new OrderFlowError('다른 화면에서 주문 상태가 먼저 바뀌었습니다. 새로고침해 주세요.', 409, 'STALE');
  if (orderTypeOf(order) === 'DELIVERY' && kind === 'CANCEL') {
    run("UPDATE deliveries SET delivery_status = 'CANCELED' WHERE order_id = @id", { id: order.id });
  }

  const stockNote = order.final_amount > 0 ? (restock ? ` · 재고 ${restored.reduce((s, r) => s + r.quantity, 0)}개 원복` : ' · 재입고 안 함') : '';
  recordHistory({
    order,
    action: kind,
    from: order.order_status,
    to,
    reason: `${reason}${stockNote}`,
    amount: order.final_amount > 0 ? -order.final_amount : null,
    actorType,
    userId
  });
  return { order: getOne('SELECT * FROM orders WHERE id = @id', { id: order.id }), reversal_order_id: reversalId, restored };
}

// 취소(CANCEL)·환불(REFUND)을 지금 할 수 있는지. 결제사 호출 전에 먼저 확인한다.
function assertReversible(order, kind, actorType = 'STAFF') {
  assertOnlineOrder(order);
  const closed = order.order_status === 'CANCELED' || order.order_status === 'REFUNDED';
  if (kind === 'CANCEL') {
    const table = actorType === 'CUSTOMER' ? CUSTOMER_CANCELABLE : CANCELABLE;
    if (table[orderTypeOf(order)]?.includes(order.order_status)) return;
    if (closed) throw new OrderFlowError('이미 취소·환불된 주문입니다.', 409, 'ALREADY_CLOSED');
    if (actorType === 'CUSTOMER') {
      throw new OrderFlowError('약국에서 상품 준비를 시작해 직접 취소할 수 없습니다. 약국에 문의해 주세요.', 409, 'CUSTOMER_CANCEL_CLOSED');
    }
    throw new OrderFlowError(`${label(order.order_status)} 상태에서는 취소할 수 없습니다. 수령·배송 완료 뒤 환불로 처리해 주세요.`);
  }
  if (REFUNDABLE[orderTypeOf(order)]?.includes(order.order_status)) return;
  if (closed) throw new OrderFlowError('이미 취소·환불된 주문입니다.', 409, 'ALREADY_CLOSED');
  throw new OrderFlowError(`${label(order.order_status)} 상태에서는 환불할 수 없습니다. 수령·배송 전이면 취소로 처리해 주세요.`);
}

function cancelOrder(order, { reason, userId, actorType, gatewayCancels }) {
  assertReversible(order, 'CANCEL', actorType);
  return reverseOrder(order, { kind: 'CANCEL', reason, restock: true, userId, actorType, gatewayCancels });
}

function refundOrder(order, { reason, restock, userId, actorType = 'STAFF', gatewayCancels }) {
  assertReversible(order, 'REFUND', actorType);
  return reverseOrder(order, { kind: 'REFUND', reason, restock, userId, actorType, gatewayCancels });
}

function orderHistory(orderId) {
  return getAll(
    `SELECT h.id, h.action, h.from_status, h.to_status, h.reason, h.amount, h.actor_type, h.created_at, u.name AS created_by_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.created_by
     WHERE h.order_id = @id
     ORDER BY h.id ASC`,
    { id: orderId }
  ).map((row) => ({
    ...row,
    action_label: ACTION_LABELS[row.action] || row.action,
    from_label: row.from_status ? label(row.from_status) : null,
    to_label: label(row.to_status)
  }));
}

module.exports = {
  CANCELABLE,
  OrderFlowError,
  REFUNDABLE,
  STATUS_LABELS,
  assertReversible,
  availableActions,
  assertTransition,
  cancelOrder,
  nextStatuses,
  orderHistory,
  paidPayments,
  recordHistory,
  refundOrder,
  setStatus,
  transition
};
