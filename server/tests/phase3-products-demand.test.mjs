import { createRequire } from 'node:module';
import { api, check, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');

async function signup(name) {
  const res = await signupMember(db, { name });
  const me = await api('/customers/me', { token: res.data.token });
  return { ...me.data.customer, token: res.data.token };
}

async function product(body) {
  const res = await api('/products', { token: owner, method: 'POST', body: { price: 10000, stock_quantity: 10, category_name: '건강기능식품', ...body } });
  if (res.status !== 201) throw new Error(JSON.stringify(res.data));
  return res.data.product;
}

let seq = 0;
function sale(customerId, daysAgo, lines) {
  seq += 1;
  const created = db.prepare("SELECT datetime('now', ?) AS at").get(`-${daysAgo} days`).at;
  const total = lines.reduce((s, [p, q]) => s + p.price * q, 0);
  const id = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, created_at)
       VALUES (?, 1, ?, 'POS_SALE', 'POS', ?, ?, 'COMPLETED', ?)`
    )
    .run(`T3-${Date.now()}-${seq}`, customerId, total, total, created).lastInsertRowid;
  for (const [p, q] of lines) {
    db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total_price) VALUES (?, ?, ?, ?, ?, ?)').run(id, p.id, p.product_name, q, p.price, p.price * q);
  }
}

console.log('[상품 브랜드 · 복용 기간]');
let vitamin;
let omega;
let probiotic;
{
  let res = await api('/products', { token: owner, method: 'POST', body: { product_name: '잘못된기간', price: 1000, supply_days: 0 } });
  check('복용 기간 0일 400', res.status === 400, res.data);
  res = await api('/products', { token: owner, method: 'POST', body: { product_name: '긴브랜드', price: 1000, brand: 'x'.repeat(41) } });
  check('브랜드 40자 초과 400', res.status === 400, res.data);
  vitamin = await product({ product_name: '테스트 비타민D 30일', brand: '메이딘랩', supply_days: 30, cost_price: 4000 });
  check('브랜드 · 복용 기간 저장', vitamin.brand === '메이딘랩' && vitamin.supply_days === 30, vitamin);
  omega = await product({ product_name: '테스트 오메가3', supply_days: 60 });
  probiotic = await product({ product_name: '테스트 유산균' });
  res = await api(`/products/${probiotic.id}`, { token: owner, method: 'PATCH', body: { supply_days: 15, brand: '장건강' } });
  check('복용 기간 수정', res.data.product.supply_days === 15 && res.data.product.brand === '장건강', res.data);
  probiotic = res.data.product;
  res = await api(`/products/${probiotic.id}`, { token: owner, method: 'PATCH', body: { supply_days: '' } });
  check('복용 기간 비우기', res.data.product.supply_days === null, res.data.product);
  await api(`/products/${probiotic.id}`, { token: owner, method: 'PATCH', body: { supply_days: 15 } });

  res = await api('/products/public?pharmacyCode=A001');
  const pub = res.data.products.find((p) => p.id === vitamin.id);
  check('고객용 상품 목록에 브랜드 노출', pub.brand === '메이딘랩', pub);
  check('고객용 상품 목록에 매입 원가 · 거래처 없음', !('cost_price' in pub) && !('supplier_id' in pub) && !('safety_stock' in pub), Object.keys(pub));
  res = await api(`/products/public/${vitamin.id}`);
  check('고객용 상품 상세에 매입 원가 없음', res.status === 200 && !('cost_price' in res.data.product), res.data);
}

console.log('[다음 구매 예상일]');
{
  const due = await signup('재구매예정');
  sale(due.id, 25, [[vitamin, 1], [probiotic, 4]]);
  const later = await signup('여유있음');
  sale(later.id, 25, [[vitamin, 2]]);

  let res = await api(`/members/${due.id}`, { token: owner });
  const m = res.data.metrics;
  check('비타민 30일 · 25일 전 구매 → 재구매 시기', m.refill_due.some((r) => r.product_id === vitamin.id && r.days_left === 5), m.refill_due);
  check('유산균 15일×4개 → 아직 아님', !m.refill_due.some((r) => r.product_id === probiotic.id), m.refill_due);
  check('다음 재구매일 = 가장 가까운 날', m.next_refill_date === m.refill_due[0].runout_date, m.next_refill_date);
  check('상세에 상품별 예정일', res.data.behavior.refills.length === 2, res.data.behavior.refills);

  res = await api(`/members/${later.id}`, { token: owner });
  check('2개 구매 → 35일 남음, 재구매 시기 아님', res.data.metrics.refill_due.length === 0 && res.data.behavior.refills[0].days_left === 35, res.data.behavior.refills);

  res = await api('/members?refill=1&q=재구매', { token: owner });
  check('재구매 예정 필터', res.data.total === 1 && res.data.members[0].id === due.id, res.data.members.map((x) => x.name));
  res = await api('/members/summary', { token: owner });
  check('요약에 재구매 예정 수', res.data.totals.refill_due >= 1, res.data.totals.refill_due);

  db.prepare("UPDATE order_items SET refunded_quantity = 1 WHERE product_id = ? AND order_id IN (SELECT id FROM orders WHERE customer_id = ?)").run(vitamin.id, due.id);
  res = await api(`/members/${due.id}`, { token: owner });
  check('전량 반품한 상품은 예정일 없음', !res.data.behavior.refills.some((r) => r.product_id === vitamin.id), res.data.behavior.refills);
}

console.log('[함께 산 상품]');
{
  const buyer = await signup('장바구니');
  sale(buyer.id, 3, [[vitamin, 1], [omega, 1]]);
  sale(buyer.id, 4, [[vitamin, 1], [omega, 1]]);
  sale(buyer.id, 5, [[vitamin, 1], [omega, 1], [probiotic, 1]]);
  sale(buyer.id, 6, [[omega, 1], [probiotic, 1]]);
  const res = await api('/reports/basket?days=10', { token: owner });
  const pair = res.data.pairs.find((p) => [p.a_id, p.b_id].sort().join() === [vitamin.id, omega.id].sort().join());
  check('비타민+오메가 3회', pair && pair.together === 3, res.data.pairs);
  const vitaminSide = pair.a_id === vitamin.id ? pair.confidence_ab : pair.confidence_ba;
  const omegaSide = pair.a_id === vitamin.id ? pair.confidence_ba : pair.confidence_ab;
  check('비타민 결제 100% · 오메가 결제 75%가 함께 삼', vitaminSide === 100 && omegaSide === 75, pair);
  check('향상도 = 함께 산 횟수 × 전체 결제 / (A 결제 × B 결제)', pair.lift === Math.round(((3 * res.data.orders) / (3 * 4)) * 100) / 100, pair.lift);
  check('최소 2회 미만 조합 제외', res.data.pairs.length === 2 && !res.data.pairs.some((p) => p.together < 2), res.data.pairs);
  const one = await api('/reports/basket?days=10&min=1', { token: owner });
  check('min=1이면 1회 조합 포함', one.data.pairs.length === 3, one.data.pairs.length);
  check('기간 · 2개 이상 담은 결제 수', res.data.days === 10 && res.data.multi_orders === 4, res.data);
}

console.log('[결과 없는 검색어]');
{
  let res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'A001', query: '  루테인   지아잔틴 ' } });
  check('매장몰 검색 기록', res.data.recorded === true, res.data);
  res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'A001', query: '루테인 지아잔틴' } });
  check('같은 검색어 10분 내 중복 무시', res.data.recorded === false, res.data);
  res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'A001', query: '01012345678' } });
  check('숫자만(전화번호·바코드)은 기록 안 함', res.data.recorded === false, res.data);
  res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'A001', query: '루' } });
  check('1글자는 기록 안 함', res.data.recorded === false, res.data);
  res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'NOPE', query: '마그네슘' } });
  check('없는 약국 404', res.status === 404, res.data);
  res = await api('/demand/search-miss', { token: owner, method: 'POST', body: { query: '루테인 지아잔틴' } });
  check('POS 검색 기록', res.data.recorded === true, res.data);
  const customer = await signup('검색고객');
  res = await api('/demand/search-miss', { token: customer.token, method: 'POST', body: { pharmacyCode: 'A001', query: '마그네슘' } });
  const row = db.prepare("SELECT * FROM search_misses WHERE query = '마그네슘'").get();
  check('로그인 고객 검색은 회원 연결', res.data.recorded && row.customer_id === customer.id && row.source === 'STORE', row);

  res = await api('/demand/summary', { token: owner });
  const lutein = res.data.searches.find((s) => s.query === '루테인 지아잔틴');
  check('요약: 검색어 2회 (매장몰 1 · POS 1)', lutein && lutein.count === 2 && lutein.store_count === 1 && lutein.pos_count === 1, lutein);
}

console.log('[입고 알림]');
{
  const customer = await signup('입고알림');
  const soldOut = await product({ product_name: '테스트 품절상품', stock_quantity: 0, status: 'SOLD_OUT' });
  const otc = await product({ product_name: '테스트 일반의약품', stock_quantity: 0, product_type: 'OTC' });

  let res = await api('/demand/me/restock-alerts', { token: customer.token, method: 'POST', body: { product_id: vitamin.id } });
  check('재고 있는 상품은 신청 불가', res.status === 400, res.data);
  res = await api('/demand/me/restock-alerts', { token: customer.token, method: 'POST', body: { product_id: otc.id } });
  check('일반의약품은 신청 불가', res.status === 404, res.data);
  res = await api('/demand/me/restock-alerts', { token: customer.token, method: 'POST', body: { product_id: soldOut.id } });
  check('품절 상품 입고 알림 신청', res.status === 201 && res.data.alerts[0].product_id === soldOut.id && !res.data.alerts[0].available, res.data);
  res = await api('/demand/me/restock-alerts', { token: customer.token, method: 'POST', body: { product_id: soldOut.id } });
  check('중복 신청은 하나로', res.status === 200 && res.data.alerts.length === 1, res.data);
  res = await api('/demand/me/restock-alerts', { token: owner, method: 'POST', body: { product_id: soldOut.id } });
  check('약국 계정은 신청 불가', res.status === 403, res.data);

  res = await api('/demand/summary', { token: owner });
  let entry = res.data.restock.find((r) => r.product_id === soldOut.id);
  check('요약: 입고 대기 1명', entry && entry.waiting === 1 && !entry.available, entry);
  res = await api(`/demand/restock-alerts/${soldOut.id}/notified`, { token: owner, method: 'POST' });
  check('입고 전 안내 완료 불가', res.status === 400, res.data);

  await api(`/products/${soldOut.id}`, { token: owner, method: 'PATCH', body: { stock_quantity: 5, status: 'ON_SALE' } });
  res = await api('/demand/me/restock-alerts', { token: customer.token });
  check('입고되면 고객 화면에 구매 가능 표시', res.data.alerts[0].available === true, res.data.alerts);
  res = await api(`/demand/restock-alerts/${soldOut.id}/customers`, { token: owner });
  check('알림 신청 고객 목록', res.data.customers.length === 1 && res.data.customers[0].id === customer.id, res.data);
  res = await api(`/demand/restock-alerts/${soldOut.id}/notified`, { token: owner, method: 'POST' });
  check('입고 후 안내 완료', res.status === 200 && res.data.notified === 1, res.data);
  res = await api('/demand/me/restock-alerts', { token: customer.token });
  check('고객 화면 상태 안내 완료', res.data.alerts[0].status === 'NOTIFIED', res.data.alerts);
  res = await api(`/demand/me/restock-alerts/${res.data.alerts[0].id}`, { token: customer.token, method: 'DELETE' });
  check('고객이 알림 닫기', res.status === 200 && res.data.alerts.length === 0, res.data);
}

console.log('[상품 요청]');
{
  const customer = await signup('상품요청');
  let res = await api('/demand/me/product-requests', { token: customer.token, method: 'POST', body: { product_name: '루' } });
  check('짧은 요청 400', res.status === 400, res.data);
  res = await api('/demand/me/product-requests', { token: customer.token, method: 'POST', body: { product_name: '루테인 지아잔틴 60캡슐', memo: '눈 피로' } });
  check('상품 요청 등록', res.status === 201 && res.data.requests[0].status === 'OPEN', res.data);
  const id = res.data.requests[0].id;

  res = await api('/demand/summary', { token: owner });
  check('요약에 요청 표시', res.data.requests.some((r) => r.id === id && r.customer_name === '상품요청'), res.data.requests);
  res = await api(`/demand/product-requests/${id}`, { token: owner, method: 'PATCH', body: { status: 'NOPE' } });
  check('잘못된 상태 400', res.status === 400, res.data);
  res = await api(`/demand/product-requests/${id}`, { token: owner, method: 'PATCH', body: { status: 'ORDERED', reply: '다음 주 화요일 입고 예정입니다.' } });
  check('약국 답변', res.status === 200, res.data);
  res = await api('/demand/me/product-requests', { token: customer.token });
  check('고객이 답변 확인', res.data.requests[0].status === 'ORDERED' && res.data.requests[0].reply.includes('화요일'), res.data.requests);

  for (let i = 0; i < 10; i += 1) {
    await api('/demand/me/product-requests', { token: customer.token, method: 'POST', body: { product_name: `요청상품${i}` } });
  }
  res = await api('/demand/me/product-requests', { token: customer.token, method: 'POST', body: { product_name: '한도초과' } });
  check('대기 요청 10건 넘으면 429', res.status === 429, res.data);
  res = await api('/demand/summary', { token: customer.token });
  check('고객은 수요 요약 불가', res.status === 403, res.data);
}

done();
