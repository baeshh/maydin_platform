import { createRequire } from 'node:module';
import { api, check, checkout, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const staffEmail = `flow-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '흐름직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');
const session = (await api('/pos/sessions/current', { token: owner })).data.session;
if (!session) await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } });

const today = db.prepare("SELECT date('now', 'localtime') AS d").get().d;
let seq = 0;
async function product(body = {}) {
  seq += 1;
  const res = await api('/products', {
    token: owner,
    method: 'POST',
    body: { product_name: `흐름 테스트 ${process.pid}-${seq}`, price: 10000, stock_quantity: 0, product_type: 'GENERAL', ...body }
  });
  return res.data.product;
}
const fill = (id, stock) => db.prepare("UPDATE products SET stock_quantity = ?, status = 'ON_SALE' WHERE id = ?").run(stock, id);
const stockOf = (id) => db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id).stock_quantity;
const items = (orderId) => db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const history = (id) => db.prepare('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id').all(id);
const sell = (productId, quantity) =>
  api('/pos/sales', {
    token: owner,
    method: 'POST',
    body: { items: [{ product_id: productId, quantity }], payments: [{ method: 'CASH', amount: 10000 * quantity }] }
  });
async function reportRow(productId) {
  const res = await api(`/reports/sales?period=RANGE&from=${today}&to=${today}`, { token: owner });
  return res.data.products.find((p) => p.product_id === productId);
}

console.log('[원가 스냅샷 — 판매 순간 로트 순서대로 원가 기록]');
let lotted;
let firstSale;
{
  lotted = await product({ cost_price: 8000 });
  fill(lotted.id, 10);
  const lot = db.prepare(
    `INSERT INTO product_lots (pharmacy_id, product_id, lot_number, expiry_date, received_quantity, remaining_quantity, unit_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  lot.run(lotted.pharmacy_id, lotted.id, 'A', '2027-01-31', 3, 3, 7000);
  lot.run(lotted.pharmacy_id, lotted.id, 'B', '2027-06-30', 4, 4, 7500);

  let res = await sell(lotted.id, 5);
  check('POS 판매', res.status === 201, res.data);
  firstSale = res.data.order.id;
  const [line] = items(firstSale);
  check('로트 없는 재고 3개(8,000) + 기한 빠른 로트 2개(7,000) = 38,000원', line.cost_amount === 38000, line);
  check('평균 단가 7,600원 · 출처 혼합', line.unit_cost === 7600 && line.cost_source === 'MIXED', line);

  await api(`/products/${lotted.id}`, { token: owner, method: 'PATCH', body: { cost_price: 9000 } });
  check('원가를 바꿔도 지난 판매 원가는 그대로', items(firstSale)[0].cost_amount === 38000, items(firstSale)[0]);

  res = await sell(lotted.id, 3);
  const [second] = items(res.data.order.id);
  check('남은 로트 A 1개(7,000) + B 2개(7,500) = 22,000원', second.cost_amount === 22000 && second.cost_source === 'LOT', second);

  res = await api(`/pos/sales/${firstSale}/refunds`, {
    token: owner,
    method: 'POST',
    body: { reason: '원가 테스트 반품', items: [{ order_item_id: line.id, quantity: 1 }] }
  });
  check('부분 반품', res.status === 201, res.data);
  const [refundLine] = items(res.data.refund.order.id);
  check('반품 줄은 판매 당시 원가로 음수 (-7,600)', refundLine.cost_amount === -7600 && refundLine.quantity === -1, refundLine);

  const row = await reportRow(lotted.id);
  check('리포트 순매출 70,000원', row?.net_amount === 70000, row);
  check('리포트 매출원가 = 38,000 + 22,000 - 7,600', row?.cost_amount === 52400, row);
  check('매출총이익 17,600원 (현재 원가 9,000원과 무관)', row?.margin_amount === 17600 && row?.cost_price === 9000, row);
}

console.log('[원가 스냅샷 — 원가 모르는 상품 · 매장 판매 취소]');
{
  const noCost = await product();
  fill(noCost.id, 5);
  let res = await sell(noCost.id, 1);
  const [line] = items(res.data.order.id);
  check('원가 없는 상품은 원가 미기록', line.cost_amount === null && line.unit_cost === null, line);
  const row = await reportRow(noCost.id);
  check('리포트에서도 원가 미기록 · 이익 없음', row && row.cost_lines === 0 && row.margin_amount === null, row);

  const withCost = await product({ cost_price: 4000 });
  fill(withCost.id, 5);
  res = await sell(withCost.id, 2);
  const saleId = res.data.order.id;
  res = await api(`/pos/sales/${saleId}/cancel`, { token: owner, method: 'POST', body: { reason: '원가 테스트 취소' } });
  check('매장 판매 취소', res.status === 200 || res.status === 201, res.data);
  const refund = db.prepare("SELECT id FROM orders WHERE original_order_id = ? AND order_type = 'POS_REFUND'").get(saleId);
  check('취소 줄 원가 -8,000원', items(refund.id)[0].cost_amount === -8000, items(refund.id));
  const report = await reportRow(withCost.id);
  check('취소한 판매는 매출·원가 모두 0', !report || (report.net_amount === 0 && report.cost_amount === 0), report);
}

console.log('[온라인 주문 — 생성 → 결제 대기 → 결제 완료 이력]');
const member = await signupMember(db, {}, { keepOrder: true });
const customer = member.data.token;
const other = (await signupMember(db, {}, { keepOrder: true })).data.token;
const goods = await product({ cost_price: 5000, online_visible: true });
fill(goods.id, 20);

async function order(type = 'PICKUP', quantity = 1, token = customer) {
  await api('/cart', { token, method: 'POST', body: { product_id: goods.id, quantity } });
  const body = { order_type: type, contact_name: '흐름', contact_phone: '01000000000', preferred_at: '2026-12-01T10:00', allow_duplicate: true };
  if (type === 'DELIVERY') body.delivery = { receiver_name: '흐름', receiver_phone: '01000000000', address: '서울시 테스트로 1' };
  const res = await checkout(token, body);
  return res.data.order;
}
const patch = (id, body, token = owner) => api(`/orders/${id}/status`, { token, method: 'PATCH', body });

let delivery;
{
  const before = stockOf(goods.id);
  delivery = await order('DELIVERY', 2);
  check('배송 주문 생성 → 결제 완료', delivery?.order_status === 'PAYMENT_COMPLETED' && delivery.payment_status === 'PAID', delivery);
  check('재고 차감', stockOf(goods.id) === before - 2);
  const steps = history(delivery.id).map((h) => `${h.from_status || '-'}>${h.to_status}`);
  check('이력: 생성 → 결제 대기 → 결제 완료', steps.join(',') === '->CREATED,CREATED>PAYMENT_PENDING,PAYMENT_PENDING>PAYMENT_COMPLETED', steps);
  check('결제 승인은 시스템 기록', history(delivery.id)[2].actor_type === 'SYSTEM', history(delivery.id)[2]);
  check('온라인 주문도 판매 원가 기록 (5,000 × 2)', items(delivery.id)[0].cost_amount === 10000, items(delivery.id));

  const mine = await api(`/orders/${delivery.id}`, { token: customer });
  check('고객 주문 상세에는 원가가 없음', mine.status === 200 && !('cost_amount' in mine.data.items[0]) && !('unit_cost' in mine.data.items[0]), mine.data.items);
  check('고객 주문 상세에 이력', mine.data.history.length === 3 && mine.data.history[2].to_label === '결제 완료', mine.data.history);
}

console.log('[상태 변경 — 권한 · 허용된 다음 단계만]');
{
  let res = await patch(delivery.id, { order_status: 'PREPARING' }, customer);
  check('고객은 상태 변경 불가', res.status === 403, res.data);
  res = await patch(delivery.id, { order_status: 'PREPARING' }, staff);
  check('POS 직원은 온라인 상태 변경 불가', res.status === 403, res.data);
  res = await patch(delivery.id, { order_status: 'DELIVERED' });
  check('결제 완료 → 배송 완료로 건너뛰기 불가', res.status === 409 && /상품 준비/.test(res.data.message), res.data);
  res = await patch(delivery.id, { order_status: 'SHIPPING', courier: 'CJ', tracking_number: '1' });
  check('상품 준비 없이 배송중 불가', res.status === 409, res.data);
  res = await patch(delivery.id, { order_status: 'CANCELED' });
  check('상태 변경으로 취소 불가 → 취소 경로 안내', res.status === 400 && res.data.reason === 'USE_CANCEL_OR_REFUND', res.data);
  res = await patch(delivery.id, { order_status: 'PAYMENT_COMPLETED' });
  check('결제 상태는 직접 바꿀 수 없음', res.status === 403 && res.data.reason === 'SYSTEM_ONLY', res.data);
  res = await patch(delivery.id, { order_status: 'NOPE' });
  check('없는 상태 거절', res.status === 400, res.data);
  res = await patch(999999, { order_status: 'PREPARING' });
  check('없는 주문 404', res.status === 404, res.data);

  res = await patch(delivery.id, { order_status: 'PREPARING' });
  check('결제 완료 → 상품 준비', res.status === 200 && res.data.order.order_status === 'PREPARING', res.data);
  check('다음 단계 안내는 배송중', JSON.stringify(res.data.order.next_statuses) === '["SHIPPING"]', res.data.order);
  res = await patch(delivery.id, { order_status: 'SHIPPING' });
  check('송장 없이 배송중 불가', res.status === 400 && res.data.reason === 'TRACKING_REQUIRED', res.data);
  res = await patch(delivery.id, { order_status: 'SHIPPING', courier: 'CJ대한통운', tracking_number: '123456789' });
  check('상품 준비 → 배송중', res.status === 200 && res.data.order.delivery_status === 'SHIPPING', res.data);
  const shipped = db.prepare('SELECT * FROM deliveries WHERE order_id = ?').get(delivery.id);
  check('배송 정보 기록', shipped.tracking_number === '123456789' && shipped.shipped_at, shipped);

  res = await api(`/orders/${delivery.id}/cancel`, { token: owner, method: 'POST', body: { reason: '배송중 취소 시도' } });
  check('배송중에는 취소 불가 (환불로 안내)', res.status === 409 && /환불/.test(res.data.message), res.data);
  res = await api(`/orders/${delivery.id}/refund`, { token: owner, method: 'POST', body: { reason: '배송중 환불 시도' } });
  check('배송 완료 전에는 환불 불가', res.status === 409, res.data);

  res = await patch(delivery.id, { order_status: 'DELIVERED' });
  check('배송중 → 배송 완료', res.status === 200 && res.data.order.can_refund === true && res.data.order.next_statuses.length === 0, res.data);
  res = await patch(delivery.id, { order_status: 'DELIVERED' });
  check('같은 상태로 다시 바꾸기 불가', res.status === 409, res.data);
  check('이력 6건', history(delivery.id).length === 6, history(delivery.id));
}

console.log('[환불 — 배송·수령 완료 뒤 · 결제 환불 · 음수 매출 · 이력]');
{
  let res = await api(`/orders/${delivery.id}/refund`, { token: owner, method: 'POST', body: {} });
  check('환불 사유 필수', res.status === 400 && res.data.reason === 'REASON_REQUIRED', res.data);
  res = await api(`/orders/${delivery.id}/refund`, { token: customer, method: 'POST', body: { reason: '고객 환불' } });
  check('고객은 환불 직접 불가', res.status === 403, res.data);

  const before = stockOf(goods.id);
  res = await api(`/orders/${delivery.id}/refund`, { token: owner, method: 'POST', body: { reason: '파손 반품', restock: false } });
  check('환불 처리', res.status === 200 && res.data.order.order_status === 'REFUNDED' && res.data.order.payment_status === 'REFUNDED', res.data);
  check('재입고 안 하면 재고 그대로', stockOf(goods.id) === before);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? AND paid_amount > 0').get(delivery.id);
  check('결제 환불 기록', payment.payment_status === 'REFUNDED' && payment.refunded_at, payment);
  const reversal = orderRow(res.data.reversal_order_id);
  const original = orderRow(delivery.id);
  check('음수 환불 주문 (배송비 포함 전액)', reversal.order_type === 'ONLINE_REFUND' && reversal.final_amount === -original.final_amount, reversal);
  check('환불 주문 원가도 음수', items(reversal.id)[0].cost_amount === -10000, items(reversal.id));
  const refundPay = db.prepare('SELECT SUM(paid_amount) AS s FROM payments WHERE order_id = ?').get(reversal.id).s;
  check('결제 내역 합계 0', refundPay === -original.final_amount, refundPay);
  const last = history(delivery.id).at(-1);
  check('환불 이력 (사유·금액·재입고 여부)', last.action === 'REFUND' && last.to_status === 'REFUNDED' && /파손 반품.*재입고 안 함/.test(last.reason) && last.amount === -original.final_amount, last);
  check('관리 로그', db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'ORDER_REFUND' AND target_id = ?").get(delivery.id).n === 1);

  res = await api(`/orders/${delivery.id}/refund`, { token: owner, method: 'POST', body: { reason: '두 번째' } });
  check('두 번 환불 불가', res.status === 409, res.data);
  const list = (await api('/orders', { token: owner })).data.orders;
  check('주문 목록에 환불 주문은 따로 안 보임', !list.some((o) => o.order_type === 'ONLINE_REFUND'), list.length);
  const mine = (await api('/orders', { token: customer })).data.orders;
  check('고객 주문 목록에도 안 보임', !mine.some((o) => o.order_type === 'ONLINE_REFUND'));
}

console.log('[취소 — 결제 취소 + 재고 원복 + 이력]');
{
  const before = stockOf(goods.id);
  const pickup = await order('PICKUP', 3);
  check('픽업 주문도 결제 완료로 시작', pickup.order_status === 'PAYMENT_COMPLETED', pickup);
  let res = await api(`/orders/${pickup.id}/cancel`, { token: other, method: 'POST', body: {} });
  check('남의 주문 취소 불가', res.status === 403, res.data);

  res = await api(`/orders/${pickup.id}/cancel`, { token: customer, method: 'POST', body: {} });
  check('고객이 상품 준비 전 직접 취소', res.status === 200 && res.data.order.order_status === 'CANCELED' && res.data.order.payment_status === 'CANCELED', res.data);
  check('재고 원복', stockOf(goods.id) === before, { before, now: stockOf(goods.id) });
  const log = db.prepare("SELECT * FROM inventory_logs WHERE change_type = 'ORDER_CANCEL' AND reference_id = ?").get(pickup.id);
  check('재고 원복 기록', log && log.quantity_after - log.quantity_before === 3, log);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? AND paid_amount > 0').get(pickup.id);
  check('결제 취소 기록', payment.payment_status === 'CANCELED' && payment.canceled_at, payment);
  const reversal = orderRow(res.data.reversal_order_id);
  check('취소분 음수 매출', reversal.final_amount === -30000 && items(reversal.id)[0].cost_amount === -15000, items(reversal.id));
  const last = history(pickup.id).at(-1);
  check('취소 이력 (고객 · 사유)', last.action === 'CANCEL' && last.actor_type === 'CUSTOMER' && /고객 직접 취소/.test(last.reason), last);
  check('고객 취소는 관리 로그에 안 남음', db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'ORDER_CANCEL' AND target_id = ?").get(pickup.id).n === 0);

  res = await api(`/orders/${pickup.id}/cancel`, { token: customer, method: 'POST', body: {} });
  check('이미 취소된 주문 다시 취소 불가', res.status === 409 && res.data.reason === 'ALREADY_CLOSED', res.data);
  res = await patch(pickup.id, { order_status: 'PREPARING' });
  check('취소된 주문은 진행 불가', res.status === 409, res.data);
  res = await api(`/pos/pickups/${pickup.id}/complete`, { token: owner, method: 'POST', body: {} });
  check('취소된 픽업은 카운터 수령 불가', res.status === 409, res.data);

  const preparing = await order('PICKUP', 1);
  await patch(preparing.id, { order_status: 'PREPARING' });
  res = await api(`/orders/${preparing.id}/cancel`, { token: customer, method: 'POST', body: {} });
  check('상품 준비 시작 뒤 고객 취소 불가', res.status === 409 && res.data.reason === 'CUSTOMER_CANCEL_CLOSED', res.data);
  res = await api(`/orders/${preparing.id}/cancel`, { token: owner, method: 'POST', body: { reason: ' ' } });
  check('약국 취소는 사유 필수', res.status === 400, res.data);
  res = await api(`/orders/${preparing.id}/cancel`, { token: owner, method: 'POST', body: { reason: '재고 파손' } });
  check('약국은 상품 준비 중에도 취소', res.status === 200 && res.data.order.order_status === 'CANCELED', res.data);
  check('약국 취소는 관리 로그', db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'ORDER_CANCEL' AND target_id = ?").get(preparing.id).n === 1);

  const sum = db
    .prepare('SELECT SUM(final_amount) AS amount FROM orders WHERE id IN (?, ?) OR original_order_id IN (?, ?)')
    .get(pickup.id, preparing.id, pickup.id, preparing.id);
  check('취소한 주문은 매출 합계 0', sum.amount === 0, sum);
}

console.log('[픽업 — 상품 준비 → 픽업 대기 → 수령 · 카운터 수령]');
{
  const pickup = await order('PICKUP', 1);
  let res = await patch(pickup.id, { order_status: 'READY_FOR_PICKUP' });
  check('상품 준비 없이 픽업 대기 불가', res.status === 409, res.data);
  await patch(pickup.id, { order_status: 'PREPARING' });
  res = await patch(pickup.id, { order_status: 'READY_FOR_PICKUP' });
  check('상품 준비 → 픽업 대기', res.status === 200 && res.data.order.delivery_status === 'READY_FOR_PICKUP', res.data);
  res = await patch(pickup.id, { order_status: 'PICKED_UP' });
  check('픽업 대기 → 수령 완료', res.status === 200 && res.data.order.can_refund === true, res.data);
  res = await api(`/orders/${pickup.id}/refund`, { token: owner, method: 'POST', body: { reason: '단순 변심', restock: true } });
  const before = res.status === 200 ? null : res.data;
  check('수령 뒤 환불 + 재입고', res.status === 200 && res.data.restored[0]?.quantity === 1, before || res.data);

  const counter = await order('PICKUP', 1);
  res = await api(`/pos/pickups/${counter.id}/complete`, { token: staff, method: 'POST', body: {} });
  check('카운터에서 바로 수령 처리', res.status === 200 && res.data.order.order_status === 'PICKED_UP', res.data);
  const last = history(counter.id).at(-1);
  check('카운터 수령 이력', last.action === 'COUNTER_PICKUP' && last.from_status === 'PAYMENT_COMPLETED', last);
  res = await api(`/pos/pickups/${counter.id}/complete`, { token: staff, method: 'POST', body: {} });
  check('두 번 수령 불가', res.status === 409, res.data);
}

console.log('[상담 예약 — 확정 · 취소 이력]');
{
  let res = await api('/orders', {
    token: customer,
    method: 'POST',
    body: { order_type: 'COUNSEL', preferred_at: '2026-12-01T10:00', memo: '복약 상담', counsel_consent: true, contact_name: '흐름', contact_phone: '01000000000' }
  });
  const counsel = res.data.order;
  check('상담 예약 생성 이력', history(counsel.id)[0]?.to_status === 'RESERVED', history(counsel.id));
  res = await patch(counsel.id, { order_status: 'SHIPPING', courier: 'x', tracking_number: '1' });
  check('상담에는 배송 단계 없음', res.status === 409, res.data);
  res = await patch(counsel.id, { order_status: 'CONFIRMED' });
  check('예약 → 상담 확정', res.status === 200, res.data);
  res = await api(`/orders/${counsel.id}/cancel`, { token: customer, method: 'POST', body: {} });
  check('확정된 상담은 고객 취소 불가', res.status === 409, res.data);
  res = await api(`/orders/${counsel.id}/cancel`, { token: owner, method: 'POST', body: { reason: '약사 부재' } });
  check('약국은 상담 취소 (결제 없음)', res.status === 200 && res.data.order.order_status === 'CANCELED' && res.data.reversal_order_id === null, res.data);
}

console.log('[POS 거래는 온라인 경로로 처리 불가]');
{
  const res = await api(`/orders/${firstSale}/cancel`, { token: owner, method: 'POST', body: { reason: '잘못된 경로' } });
  check('매장 거래는 POS에서만 취소', res.status === 400 && res.data.reason === 'NOT_ONLINE_ORDER', res.data);
}

done();
