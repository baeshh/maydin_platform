import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { api, check, checkout, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
const { paymentConfig } = require('../src/services/payment-gateway.js');

const owner = await login('owner@apharmacy.kr', 'owner1234');
const admin = await login('admin@maydin.kr', 'admin1234');

let seq = 0;
async function product(body = {}) {
  seq += 1;
  const res = await api('/products', {
    token: owner,
    method: 'POST',
    body: { product_name: `결제 테스트 ${process.pid}-${seq}`, price: 10000, stock_quantity: 0, product_type: 'GENERAL', online_visible: true, ...body }
  });
  return res.data.product;
}
const fill = (id, stock) => db.prepare("UPDATE products SET stock_quantity = ?, status = 'ON_SALE' WHERE id = ?").run(stock, id);
const stockOf = (id) => db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id).stock_quantity;
const checkoutRow = (id) => db.prepare('SELECT * FROM online_checkouts WHERE id = ?').get(id);
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const demoRow = (key) => db.prepare('SELECT * FROM pg_demo_payments WHERE payment_key = ?').get(key);
const orderCount = () => db.prepare("SELECT COUNT(*) AS n FROM orders WHERE order_type IN ('PICKUP', 'DELIVERY')").get().n;
const cartCount = (token) => api('/cart', { token }).then((res) => res.data.items.length);
const pickupBody = (extra = {}) => ({ order_type: 'PICKUP', contact_name: '결제', contact_phone: '01000000000', preferred_at: '2026-12-01T10:00', ...extra });
const addCart = (token, productId, quantity = 1) => api('/cart', { token, method: 'POST', body: { product_id: productId, quantity } });
const startCheckout = (token, body = pickupBody()) => api('/payments/checkouts', { token, method: 'POST', body });
const authorize = (token, checkoutId, scenario = 'APPROVE') =>
  api('/payments/demo/authorize', { token, method: 'POST', body: { checkout_id: checkoutId, scenario } });
const confirm = (token, body) => api('/payments/confirm', { token, method: 'POST', body });
const reconcile = () => api('/payments/reconcile', { token: admin, method: 'POST' });

async function member() {
  return (await signupMember(db, {}, { keepOrder: true })).data.token;
}

const goods = await product({ price: 12000 });
fill(goods.id, 50);

console.log('[결제 설정 — 운영에서는 실제 결제가 확실할 때만 열림]');
{
  const res = await api('/payments/config');
  check('테스트 서버는 (데모) 결제', res.data.mode === 'DEMO' && res.data.enabled && res.data.label.includes('(데모)'), res.data);
  check('운영 + 설정 없음 → 결제 닫힘', paymentConfig({ NODE_ENV: 'production' }).enabled === false);
  check('운영 + 데모 → 닫힘', paymentConfig({ NODE_ENV: 'production', PG_PROVIDER: 'DEMO' }).enabled === false);
  const live = { NODE_ENV: 'production', PG_PROVIDER: 'TOSS', TOSS_SECRET_KEY: 'live_sk_x', TOSS_CLIENT_KEY: 'live_ck_x' };
  check('실결제 키만 넣고 운영 전환 안 하면 닫힘', paymentConfig(live).enabled === false && /PG_LIVE_ENABLED/.test(paymentConfig(live).message));
  check('운영 전환까지 하면 실결제', paymentConfig({ ...live, PG_LIVE_ENABLED: 'true' }).mode === 'LIVE');
  check('키 종류가 섞이면 닫힘', paymentConfig({ ...live, TOSS_CLIENT_KEY: 'test_ck_x', PG_LIVE_ENABLED: 'true' }).enabled === false);
  check(
    '운영 서버에 테스트 키는 닫힘',
    paymentConfig({ NODE_ENV: 'production', PG_PROVIDER: 'TOSS', TOSS_SECRET_KEY: 'test_sk_x', TOSS_CLIENT_KEY: 'test_ck_x' }).enabled === false
  );
  const testKeys = { NODE_ENV: 'production', PG_PROVIDER: 'TOSS', TOSS_SECRET_KEY: 'test_sk_x', TOSS_CLIENT_KEY: 'test_ck_x' };
  check('예전 허용 변수(ALLOW_*)로는 운영에서 안 열림', paymentConfig({ ...testKeys, ALLOW_TEST_PAYMENTS: 'true' }).enabled === false && paymentConfig({ NODE_ENV: 'production', PG_PROVIDER: 'DEMO', ALLOW_DEMO_PAYMENTS: 'true' }).enabled === false);
  check('스테이징 서버만 테스트 키·데모 허용', paymentConfig({ ...testKeys, MAYDIN_STAGING: 'true' }).mode === 'TEST' && paymentConfig({ NODE_ENV: 'production', PG_PROVIDER: 'DEMO', MAYDIN_STAGING: 'true' }).mode === 'DEMO');
  check('개발 서버 테스트 키는 (테스트) 표시', paymentConfig({ PG_PROVIDER: 'TOSS', TOSS_SECRET_KEY: 'test_sk_x', TOSS_CLIENT_KEY: 'test_ck_x' }).mode === 'TEST');
  check('알 수 없는 결제사는 닫힘', paymentConfig({ PG_PROVIDER: 'MOCK' }).enabled === false);
}

console.log('[결제 요청 — 승인 전에는 주문·재고를 건드리지 않음]');
const buyer = await member();
{
  let res = await api('/orders', { token: buyer, method: 'POST', body: pickupBody() });
  check('결제창 없이 바로 주문 불가', res.status === 400 && res.data.reason === 'USE_CHECKOUT', res.data);

  await addCart(buyer, goods.id, 2);
  const before = { stock: stockOf(goods.id), orders: orderCount() };
  let created = await startCheckout(buyer, pickupBody({ checkout_key: 'key-first-0001', amount: 1 }));
  const request = created.data.checkout;
  check('결제 요청 201 · 금액은 서버 계산(고객 값 무시)', created.status === 201 && request.amount === 24000, created.data);
  check('주문번호는 결제 요청 때 고정', /^PCK-/.test(request.pg_order_id) && request.status === 'READY', request);
  check('승인 전: 주문 없음 · 재고 그대로', orderCount() === before.orders && stockOf(goods.id) === before.stock);
  check('주문서(연락처)는 암호화 저장', checkoutRow(request.id).payload.startsWith('v1:') && !checkoutRow(request.id).payload.includes('01000000000'));

  created = await startCheckout(buyer, pickupBody({ checkout_key: 'key-first-0001' }));
  check('같은 요청 키 → 같은 결제 요청', created.status === 200 && created.data.reused && created.data.checkout.id === request.id, created.data);
  created = await startCheckout(buyer, pickupBody({ checkout_key: 'key-second-002' }));
  check('같은 장바구니로 다시 → 진행 중인 요청 이어 쓰기', created.data.checkout.id === request.id, created.data);

  const auth = (await authorize(buyer, request.id)).data;
  res = await confirm(buyer, { ...auth, amount: auth.amount - 1000 });
  check('금액 바꿔 승인 요청 → 400', res.status === 400 && res.data.reason === 'AMOUNT_MISMATCH', res.data);
  check('금액 불일치면 결제사 승인 안 함(청구 없음)', demoRow(auth.paymentKey).status === 'IN_PROGRESS');
  check('주문도 안 생김', orderCount() === before.orders && checkoutRow(request.id).status === 'FAILED');
  check('실패한 주문서 내용은 바로 파기', checkoutRow(request.id).payload === null);
  check('장바구니 그대로', (await cartCount(buyer)) === 1);
}

console.log('[정상 승인 — 검증 후 주문 생성 + 재고 차감 + 결제 기록]');
let paidOrder;
{
  const before = stockOf(goods.id);
  const created = (await startCheckout(buyer)).data.checkout;
  const auth = (await authorize(buyer, created.id)).data;
  let res = await confirm(buyer, auth);
  paidOrder = res.data.order;
  check('승인 200 · 결제 완료 주문', res.status === 200 && paidOrder.order_status === 'PAYMENT_COMPLETED' && paidOrder.payment_status === 'PAID', res.data);
  check('주문번호 = 결제사 주문번호', paidOrder.order_number === created.pg_order_id);
  check('재고 차감', stockOf(goods.id) === before - 2);
  check('장바구니 비움', (await cartCount(buyer)) === 0);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(paidOrder.id);
  check(
    '결제 기록: 결제사·결제 키·모드',
    payment.payment_provider === 'DEMO' && payment.payment_key === auth.paymentKey && payment.payment_mode === 'DEMO' && payment.paid_amount === 24000,
    payment
  );
  const steps = db.prepare('SELECT from_status, to_status, actor_type FROM order_status_history WHERE order_id = ? ORDER BY id').all(paidOrder.id);
  check('이력: 생성 → 결제 대기 → 결제 완료(시스템)', steps.map((s) => s.to_status).join(',') === 'CREATED,PAYMENT_PENDING,PAYMENT_COMPLETED' && steps[2].actor_type === 'SYSTEM', steps);
  check('결제 요청 DONE · 주문서 파기', checkoutRow(created.id).status === 'DONE' && checkoutRow(created.id).payload === null);

  res = await confirm(buyer, auth);
  check('같은 승인 재요청 → 같은 주문(중복 주문 없음)', res.status === 200 && res.data.order.id === paidOrder.id, res.data);
  check('주문 1건만', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_number = ?').get(created.pg_order_id).n === 1);
  res = await authorize(buyer, created.id);
  check('결제 끝난 주문으로 결제창 다시 열기 불가', res.status === 409, res.data);
  res = await confirm(buyer, { ...auth, paymentKey: 'demo_other_payment' });
  check('같은 주문에 다른 결제 승인 요청 → 409(청구 안 함)', res.status === 409 && res.data.reason === 'ALREADY_PAID', res.data);

  const list = (await api('/orders', { token: owner })).data.orders.find((o) => o.id === paidOrder.id);
  check('약국 주문 목록에 (데모) 결제 표시', list.payment_label === '(데모) 결제' && list.cancel_request === undefined, list);
  const other = await member();
  res = await confirm(other, auth);
  check('다른 회원이 남의 결제 승인 요청 → 404', res.status === 404, res.data);
}

console.log('[중복 결제 방지 — 동시 승인 · 같은 장바구니 재결제]');
{
  const token = await member();
  await addCart(token, goods.id, 1);
  const created = (await startCheckout(token)).data.checkout;
  const auth = (await authorize(token, created.id)).data;
  const [a, b] = await Promise.all([confirm(token, auth), confirm(token, auth)]);
  check('동시에 두 번 승인 요청해도 둘 다 같은 주문', a.status === 200 && b.status === 200 && a.data.order.id === b.data.order.id, [a.data, b.data]);
  check('주문 1건만', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE order_number = ?').get(created.pg_order_id).n === 1);

  await addCart(token, goods.id, 1);
  let res = await startCheckout(token);
  check('10분 안에 같은 상품 재결제 → 확인 요청(409)', res.status === 409 && res.data.reason === 'DUPLICATE_SUSPECTED', res.data);
  res = await startCheckout(token, pickupBody({ allow_duplicate: true }));
  check('고객이 확인하면 새 결제 요청', res.status === 201, res.data);
}

console.log('[결제 실패·응답 끊김 — 재시도로 결과 맞추기]');
{
  const token = await member();
  await addCart(token, goods.id, 1);
  const before = { stock: stockOf(goods.id), orders: orderCount() };
  let res = await checkout(token, pickupBody(), { scenario: 'DECLINE' });
  check('카드 거절 → 402 FAILED', res.status === 402 && res.data.state === 'FAILED' && /거절/.test(res.data.message), res.data);
  check('거절: 주문·재고 그대로 · 장바구니 유지', orderCount() === before.orders && stockOf(goods.id) === before.stock && (await cartCount(token)) === 1);

  res = await checkout(token, pickupBody(), { scenario: 'TIMEOUT' });
  check('승인 응답 끊김 → 결제사 조회로 승인 확인 후 주문', res.status === 201 && res.data.state === 'DONE' && res.data.order, res.data);
  check('재시도해도 주문 1건', orderCount() === before.orders + 1);

  // 결제사는 승인했는데 서버가 그 직후 멈춘 경우: 정산 작업이 결제사에 조회해 주문을 만든다.
  await addCart(token, goods.id, 1);
  const created = (await startCheckout(token, pickupBody({ allow_duplicate: true }))).data.checkout;
  const auth = (await authorize(token, created.id)).data;
  db.prepare("UPDATE pg_demo_payments SET status = 'DONE', approved_at = CURRENT_TIMESTAMP WHERE payment_key = ?").run(auth.paymentKey);
  db.prepare("UPDATE online_checkouts SET status = 'CONFIRMING', payment_key = ?, confirm_started_at = datetime('now', '-10 minutes') WHERE id = ?").run(
    auth.paymentKey,
    created.id
  );
  res = await api(`/payments/checkouts/${created.id}`, { token });
  check('확인 중인 결제는 확인 중 표시', res.status === 200 && res.data.pending && res.data.state === 'CONFIRMING', res.data);
  res = await reconcile();
  check('정산 작업이 멈춘 승인 처리', res.status === 200 && res.data.done >= 1, res.data);
  check('멈춘 승인 → 주문 생성', checkoutRow(created.id).status === 'DONE' && orderRow(checkoutRow(created.id).order_id).payment_status === 'PAID');
  res = await api(`/payments/checkouts/${created.id}`, { token });
  check('고객 결과 조회 200 + 주문', res.status === 200 && res.data.order?.id === checkoutRow(created.id).order_id, res.data);
}

console.log('[재고 — 승인 전에 부족하면 승인 안 함, 승인 뒤 부족하면 자동 취소]');
{
  const scarce = await product({ price: 5000 });
  fill(scarce.id, 1);
  const token = await member();
  await addCart(token, scarce.id, 1);
  let created = (await startCheckout(token)).data.checkout;
  let auth = (await authorize(token, created.id)).data;
  fill(scarce.id, 0);
  let res = await confirm(token, auth);
  check('승인 직전 재고 없음 → 409 · 결제사 승인 안 함', res.status === 409 && res.data.reason === 'OUT_OF_STOCK' && demoRow(auth.paymentKey).status === 'IN_PROGRESS', res.data);

  fill(scarce.id, 1);
  created = (await startCheckout(token)).data.checkout;
  auth = (await authorize(token, created.id)).data;
  db.prepare("UPDATE pg_demo_payments SET status = 'DONE' WHERE payment_key = ?").run(auth.paymentKey);
  db.prepare("UPDATE online_checkouts SET status = 'UNKNOWN', payment_key = ? WHERE id = ?").run(auth.paymentKey, created.id);
  fill(scarce.id, 0);
  res = await api(`/payments/checkouts/${created.id}/sync`, { token, method: 'POST' });
  check('승인 뒤 재고 없음 → 결제 자동 취소', res.data.state === 'CANCELED' && demoRow(auth.paymentKey).status === 'CANCELED', res.data);
  check('자동 취소 안내 문구', /자동으로 취소/.test(res.data.message), res.data.message);
  check('주문은 만들지 않음', !checkoutRow(created.id).order_id);
}

console.log('[결제 시간 만료]');
{
  const token = await member();
  await addCart(token, goods.id, 1);
  const created = (await startCheckout(token)).data.checkout;
  const auth = (await authorize(token, created.id)).data;
  db.prepare("UPDATE online_checkouts SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(created.id);
  let res = await confirm(token, auth);
  check('만료된 요청은 승인 안 함(410)', res.status === 410 && demoRow(auth.paymentKey).status === 'IN_PROGRESS', res.data);

  const stale = (await startCheckout(token, pickupBody({ allow_duplicate: true }))).data.checkout;
  db.prepare("UPDATE online_checkouts SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(stale.id);
  res = await reconcile();
  check('정산 작업이 만료 처리 + 주문서 파기', res.data.expired >= 1 && checkoutRow(stale.id).status === 'EXPIRED' && checkoutRow(stale.id).payload === null, res.data);
}

console.log('[취소·환불 — 결제사 취소가 확인된 뒤에만 되돌림]');
{
  const token = await member();
  await addCart(token, goods.id, 2);
  let order = (await checkout(token, pickupBody())).data.order;
  const key = db.prepare('SELECT payment_key FROM payments WHERE order_id = ?').get(order.id).payment_key;
  const before = stockOf(goods.id);

  db.prepare("UPDATE pg_demo_payments SET scenario = 'CANCEL_FAIL' WHERE payment_key = ?").run(key);
  let res = await api(`/orders/${order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '재고 착오' } });
  check('결제사 취소 실패 → 502 · 주문 그대로', res.status === 502 && res.data.reason === 'PG_CANCEL_FAILED' && orderRow(order.id).order_status === 'PAYMENT_COMPLETED', res.data);
  check('실패 시 재고·잠금 그대로/해제', stockOf(goods.id) === before && orderRow(order.id).cancel_lock_at === null);

  db.prepare("UPDATE pg_demo_payments SET scenario = 'APPROVE' WHERE payment_key = ?").run(key);
  res = await api(`/orders/${order.id}/cancel`, { token, method: 'POST', body: {} });
  check('고객 취소 → 결제사 취소 후 주문 취소', res.status === 200 && res.data.order.order_status === 'CANCELED' && demoRow(key).status === 'CANCELED', res.data);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id LIMIT 1').get(order.id);
  check('결제 취소 기록 + 결제사 취소 거래번호', payment.payment_status === 'CANCELED' && payment.cancel_transaction_key?.startsWith('demo_cx_'), payment);
  check('재고 원복', stockOf(goods.id) === before + 2);
  res = await api(`/orders/${order.id}/cancel`, { token, method: 'POST', body: {} });
  check('두 번 취소 불가', res.status === 409, res.data);

  // 결제사 응답이 끊긴 취소: 주문을 잠가 두고 정산 작업이 마무리한다.
  await addCart(token, goods.id, 1);
  order = (await checkout(token, pickupBody({ allow_duplicate: true }))).data.order;
  const key2 = db.prepare('SELECT payment_key FROM payments WHERE order_id = ?').get(order.id).payment_key;
  db.prepare("UPDATE pg_demo_payments SET scenario = 'CANCEL_TIMEOUT' WHERE payment_key = ?").run(key2);
  res = await api(`/orders/${order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '고객 요청' } });
  check('취소 응답 끊김 → 502 확인 중', res.status === 502 && res.data.reason === 'PG_CANCEL_PENDING', res.data);
  check('주문은 잠김(아직 결제 완료)', orderRow(order.id).cancel_lock_at && orderRow(order.id).order_status === 'PAYMENT_COMPLETED');
  res = await api(`/orders/${order.id}/status`, { token: owner, method: 'PATCH', body: { order_status: 'PREPARING' } });
  check('잠긴 동안 상태 변경 불가', res.status === 409 && res.data.reason === 'CANCEL_IN_PROGRESS', res.data);
  const listed = (await api('/orders', { token: owner })).data.orders.find((o) => o.id === order.id);
  check('잠긴 주문은 버튼 없음', listed.cancel_in_progress && !listed.can_cancel && listed.next_statuses.length === 0, listed);
  db.prepare("UPDATE orders SET cancel_lock_at = datetime('now', '-10 minutes') WHERE id = ?").run(order.id);
  res = await reconcile();
  check('정산 작업이 멈춘 취소 마무리', res.data.cancel_resumed >= 1 && orderRow(order.id).order_status === 'CANCELED', res.data);
  const audit = db.prepare("SELECT * FROM admin_logs WHERE action = 'ORDER_CANCEL' AND target_id = ?").get(order.id);
  check('마무리해도 약국 감사 기록 남음', audit && audit.description.includes('고객 요청'), audit);

  // 수령 후 환불
  await addCart(token, goods.id, 1);
  order = (await checkout(token, pickupBody({ allow_duplicate: true }))).data.order;
  for (const status of ['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP']) {
    await api(`/orders/${order.id}/status`, { token: owner, method: 'PATCH', body: { order_status: status } });
  }
  const key3 = db.prepare('SELECT payment_key FROM payments WHERE order_id = ?').get(order.id).payment_key;
  res = await api(`/orders/${order.id}/refund`, { token: owner, method: 'POST', body: { reason: '불량', restock: false } });
  check('수령 후 환불 → 결제사 환불 확인 후 REFUNDED', res.status === 200 && res.data.order.order_status === 'REFUNDED' && demoRow(key3).status === 'CANCELED', res.data);
}

console.log('[결제사 웹훅 — 본문은 믿지 않고 다시 조회]');
{
  const token = await member();
  await addCart(token, goods.id, 1);
  const order = (await checkout(token, pickupBody())).data.order;
  const key = db.prepare('SELECT payment_key FROM payments WHERE order_id = ?').get(order.id).payment_key;
  const before = stockOf(goods.id);

  let res = await api('/payments/webhook/demo', {
    method: 'POST',
    body: { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: key, orderId: order.order_number, status: 'CANCELED' } }
  });
  check('웹훅이 취소라고 해도 결제사 조회가 승인이면 무시', res.status === 200 && res.data.result === 'ALREADY_DONE' && orderRow(order.id).order_status === 'PAYMENT_COMPLETED', res.data);

  db.prepare("UPDATE pg_demo_payments SET status = 'CANCELED', canceled_at = CURRENT_TIMESTAMP, cancel_transaction_key = 'demo_cx_dashboard' WHERE payment_key = ?").run(key);
  const event = { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: key, orderId: order.order_number, status: 'CANCELED' } };
  res = await api('/payments/webhook/demo', { method: 'POST', body: event, headers: { 'tosspayments-webhook-transmission-id': `tx-${process.pid}-1` } });
  check('결제사 쪽 취소 → 주문 취소 + 재고 원복', res.data.result === 'EXTERNAL_CANCELED' && orderRow(order.id).order_status === 'CANCELED' && stockOf(goods.id) === before + 1, res.data);
  res = await api('/payments/webhook/demo', { method: 'POST', body: event, headers: { 'tosspayments-webhook-transmission-id': `tx-${process.pid}-1` } });
  check('같은 웹훅 재전송은 한 번만 처리', res.data.duplicate === true, res.data);

  // 이미 배송 중인 주문이 결제사에서 취소되면 자동으로 바꾸지 않고 약국에 알림
  await addCart(token, goods.id, 1);
  const shipping = (await checkout(token, { ...pickupBody(), order_type: 'DELIVERY', delivery: { address: '서울시 결제로 1' }, allow_duplicate: true })).data.order;
  await api(`/orders/${shipping.id}/status`, { token: owner, method: 'PATCH', body: { order_status: 'PREPARING' } });
  await api(`/orders/${shipping.id}/status`, { token: owner, method: 'PATCH', body: { order_status: 'SHIPPING', courier: 'CJ', tracking_number: '123' } });
  const shipKey = db.prepare('SELECT payment_key FROM payments WHERE order_id = ?').get(shipping.id).payment_key;
  db.prepare("UPDATE pg_demo_payments SET status = 'CANCELED' WHERE payment_key = ?").run(shipKey);
  res = await api('/payments/webhook/demo', { method: 'POST', body: { data: { paymentKey: shipKey, orderId: shipping.order_number } } });
  check('배송 중 결제사 취소 → 자동 변경 대신 알림', res.data.result === 'ALERT' && orderRow(shipping.id).order_status === 'SHIPPING' && orderRow(shipping.id).payment_alert, res.data);
  res = await api('/payments/attention', { token: owner });
  check('약국 확인 목록에 알림', res.data.orders.some((o) => o.id === shipping.id), res.data);
  res = await api(`/payments/orders/${shipping.id}/alert/resolve`, { token: owner, method: 'POST', body: { note: '고객과 통화 후 반송 처리' } });
  check('확인 메모 남기고 알림 해제', res.status === 200 && orderRow(shipping.id).payment_alert === null, res.data);

  res = await api('/payments/webhook/unknown', { method: 'POST', body: { data: { paymentKey: 'x' } } });
  check('알 수 없는 결제사 웹훅 404', res.status === 404, res.data);
}

console.log('[매출 — 승인 안 된 결제는 매출·주문에 안 잡힘]');
{
  const sales = async () =>
    (await api('/dashboard/pharmacy', { token: owner })).data.summary?.today_sales ??
    db.prepare("SELECT COALESCE(SUM(final_amount), 0) AS s FROM orders WHERE pharmacy_id = 1").get().s;
  const token = await member();
  await addCart(token, goods.id, 1);
  const before = await sales();
  await checkout(token, pickupBody(), { scenario: 'DECLINE' });
  await startCheckout(token, pickupBody({ allow_duplicate: true }));
  check('거절·대기 결제는 온라인 매출 변화 없음', (await sales()) === before);
}

console.log('[토스페이먼츠 연동 — 가짜 결제사 서버로 승인·조회·취소 요청 형식 확인]');
{
  const SECRET = 'test_sk_fake';
  const tossPayments = new Map();
  const requests = [];
  const seenIdempotency = new Map();
  let failConfirm = 0;
  const view = (p) => ({
    paymentKey: p.paymentKey,
    orderId: p.orderId,
    orderName: p.orderName,
    status: p.status,
    totalAmount: p.amount,
    balanceAmount: p.status === 'CANCELED' ? 0 : p.amount,
    method: '카드',
    approvedAt: '2026-10-11T10:00:00+09:00',
    receipt: { url: `https://receipt.example/${p.paymentKey}` },
    card: { number: '43301234****123*', issuerCode: '11' },
    cancels: p.cancels
  });
  const fake = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`) return send(401, { code: 'UNAUTHORIZED_KEY', message: '인증 실패' });
    const idem = req.headers['idempotency-key'];
    if (idem && seenIdempotency.has(idem)) return send(200, seenIdempotency.get(idem));
    let m;
    if (req.method === 'POST' && req.url === '/v1/payments/confirm') {
      const p = tossPayments.get(body.paymentKey);
      if (!p) return send(404, { code: 'NOT_FOUND_PAYMENT', message: '결제 없음' });
      if (p.orderId !== body.orderId || p.amount !== body.amount) return send(400, { code: 'INVALID_REQUEST', message: '금액 불일치' });
      if (p.status === 'DONE') return send(400, { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제' });
      p.status = 'DONE';
      if (failConfirm > 0) {
        failConfirm -= 1;
        return send(500, { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '내부 오류' });
      }
      const data = view(p);
      if (idem) seenIdempotency.set(idem, data);
      return send(200, data);
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/v1\/payments\/orders\/(.+)$/))) {
      const p = [...tossPayments.values()].find((x) => x.orderId === decodeURIComponent(m[1]));
      return p ? send(200, view(p)) : send(404, { code: 'NOT_FOUND_PAYMENT', message: '결제 없음' });
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/v1\/payments\/([^/]+)$/))) {
      const p = tossPayments.get(decodeURIComponent(m[1]));
      return p ? send(200, view(p)) : send(404, { code: 'NOT_FOUND_PAYMENT', message: '결제 없음' });
    }
    if (req.method === 'POST' && (m = req.url.match(/^\/v1\/payments\/([^/]+)\/cancel$/))) {
      const p = tossPayments.get(decodeURIComponent(m[1]));
      if (!p) return send(404, { code: 'NOT_FOUND_PAYMENT', message: '결제 없음' });
      if (p.status === 'CANCELED') return send(400, { code: 'ALREADY_CANCELED_PAYMENT', message: '이미 취소' });
      p.status = 'CANCELED';
      p.cancels.push({ cancelAmount: p.amount, transactionKey: `tx_${p.paymentKey}`, canceledAt: '2026-10-11T11:00:00+09:00', cancelReason: body.cancelReason });
      const data = view(p);
      if (idem) seenIdempotency.set(idem, data);
      return send(200, data);
    }
    send(404, { code: 'NOT_FOUND', message: req.url });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));

  const port = await new Promise((resolve) => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const server = spawn(process.execPath, ['src/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      PG_PROVIDER: 'TOSS',
      TOSS_SECRET_KEY: SECRET,
      TOSS_CLIENT_KEY: 'test_ck_fake',
      TOSS_API_BASE: `http://127.0.0.1:${fake.address().port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));
  const tossBase = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${tossBase}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (path, { token, method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(`${tossBase}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const tossOrder = async (token) => {
    const created = (await call('/payments/checkouts', { token, method: 'POST', body: pickupBody({ allow_duplicate: true }) })).data.checkout;
    const paymentKey = `tgen_${created.id}_${Date.now()}`;
    tossPayments.set(paymentKey, { paymentKey, orderId: created.pg_order_id, orderName: created.order_name, amount: created.amount, status: 'IN_PROGRESS', cancels: [] });
    return { created, paymentKey };
  };

  try {
    let res = await call('/payments/config');
    check('토스 테스트 키 → 클라이언트 키만 공개', res.data.mode === 'TEST' && res.data.client_key === 'test_ck_fake' && !JSON.stringify(res.data).includes(SECRET), res.data);
    const token = await member();
    await addCart(token, goods.id, 1);
    const { created, paymentKey } = await tossOrder(token);
    check('결제 요청에 클라이언트 키 포함', created.provider === 'TOSS' && created.client_key === 'test_ck_fake', created);
    res = await call('/payments/demo/authorize', { token, method: 'POST', body: { checkout_id: created.id } });
    check('토스 모드에서는 (데모) 결제창 닫힘', res.status === 404, res.data);

    res = await call('/payments/confirm', { token, method: 'POST', body: { paymentKey, orderId: created.pg_order_id, amount: created.amount } });
    check('토스 승인 → 주문 생성', res.status === 200 && res.data.order?.order_status === 'PAYMENT_COMPLETED', res.data);
    const confirmCall = requests.find((r) => r.url === '/v1/payments/confirm');
    check(
      '승인 요청: 시크릿 키 Basic 인증 · 멱등 키 · 서버 금액',
      confirmCall.auth.startsWith('Basic ') && confirmCall.idem === `confirm-${created.pg_order_id}` && confirmCall.body.amount === created.amount,
      confirmCall
    );
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(res.data.order.id);
    check('결제 기록: 토스(테스트) · 영수증 주소', payment.payment_provider === 'TOSS' && payment.payment_mode === 'TEST' && payment.receipt_url?.includes(paymentKey), payment);
    check('카드번호는 저장 안 함', !JSON.stringify(payment).includes('****') && !JSON.stringify(checkoutRow(created.id)).includes('****'));
    const orderId = res.data.order.id;

    res = await call(`/orders/${orderId}/cancel`, { token, method: 'POST', body: {} });
    const cancelCall = requests.find((r) => r.url.endsWith('/cancel'));
    check('취소 → 토스 취소 API 호출 후 주문 취소', res.status === 200 && res.data.order.order_status === 'CANCELED' && tossPayments.get(paymentKey).status === 'CANCELED', res.data);
    check('취소 요청에 멱등 키·사유', cancelCall.idem?.startsWith('cancel-') && cancelCall.body.cancelReason === '고객 직접 취소', cancelCall);
    check('토스 취소 거래번호 기록', db.prepare('SELECT cancel_transaction_key FROM payments WHERE order_id = ? ORDER BY id LIMIT 1').get(orderId).cancel_transaction_key === `tx_${paymentKey}`);

    // 승인 응답이 5xx로 끊김 → 결제사 조회로 확인
    await addCart(token, goods.id, 1);
    const second = await tossOrder(token);
    failConfirm = 1;
    res = await call('/payments/confirm', { token, method: 'POST', body: { paymentKey: second.paymentKey, orderId: second.created.pg_order_id, amount: second.created.amount } });
    check('토스 5xx 뒤 조회로 승인 확인 → 주문', res.status === 200 && res.data.state === 'DONE', res.data);

    // 웹훅: 토스 대시보드에서 취소
    const secondOrder = res.data.order;
    tossPayments.get(second.paymentKey).status = 'CANCELED';
    tossPayments.get(second.paymentKey).cancels.push({ cancelAmount: second.created.amount, transactionKey: 'tx_dash', canceledAt: '2026-10-11T12:00:00+09:00' });
    res = await call('/payments/webhook/toss', {
      method: 'POST',
      body: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-10-11T12:00:00', data: { paymentKey: second.paymentKey, orderId: second.created.pg_order_id, status: 'CANCELED' } },
      headers: { 'tosspayments-webhook-transmission-id': `toss-${process.pid}-1` }
    });
    check('토스 웹훅 → 재조회 후 주문 취소', res.status === 200 && res.data.result === 'EXTERNAL_CANCELED' && orderRow(secondOrder.id).order_status === 'CANCELED', res.data);

    res = await call('/payments/webhook/toss', { method: 'POST', body: { data: { paymentKey: 'tgen_missing', orderId: 'PCK-none' } } });
    check('모르는 결제 웹훅은 무시(200)', res.status === 200 && res.data.result === 'NOT_FOUND', res.data);
  } finally {
    server.kill();
    fake.close();
    if (process.env.SHOW_SERVER_LOG && process.exitCode) console.log(serverLog);
  }
}

done();
