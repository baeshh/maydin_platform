import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { api, check, checkout, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const staffEmail = `kind-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '분류직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');

let seq = 0;
async function create(body) {
  seq += 1;
  return api('/products', {
    token: owner,
    method: 'POST',
    body: { product_name: `분류 테스트 ${process.pid}-${seq}`, price: 1000, stock_quantity: 0, ...body }
  });
}
const row = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const inMall = async (id) => (await api('/products/mall?pharmacyCode=A001', { token: owner })).data.products.some((p) => p.id === id);
const fill = (id, stock = 20) => db.prepare("UPDATE products SET stock_quantity = ?, status = 'ON_SALE' WHERE id = ?").run(stock, id);

console.log('[등록 — 구분을 안 정하면 분류 전 · 온라인 판매 꺼짐]');
let unclassified;
let general;
{
  let res = await create({});
  unclassified = res.data.product;
  check('구분 없이 등록하면 분류 전', res.status === 201 && unclassified.product_type === 'UNCLASSIFIED', res.data);
  check('분류 전 상품은 온라인 판매 꺼짐', unclassified.online_visible === 0, unclassified);
  check('분류 전 상품도 POS 판매는 켜짐', unclassified.pos_sale_enabled === 1, unclassified);
  fill(unclassified.id);
  check('분류 전 상품은 몰에 안 보임', !(await inMall(unclassified.id)));

  res = await create({ product_type: 'GENERAL' });
  general = res.data.product;
  check('일반 상품도 온라인 판매를 켜지 않으면 꺼진 채 등록', res.status === 201 && general.online_visible === 0, res.data);

  res = await create({ product_type: 'OTC', online_visible: true });
  check('일반의약품은 온라인 판매를 켤 수 없음', res.status === 400 && /온라인/.test(res.data.message), res.data);
  res = await create({ product_type: 'ETC', online_visible: true });
  check('전문의약품은 온라인 판매를 켤 수 없음', res.status === 400, res.data);
  res = await create({ product_type: 'MEDICINE' });
  check('없는 구분은 거절', res.status === 400, res.data);
  res = await create({ product_type: 'general', online_visible: true, pos_sale_enabled: false });
  check('일반 상품은 온라인만 켜고 POS는 끌 수 있음', res.status === 201 && res.data.product.online_visible === 1 && res.data.product.pos_sale_enabled === 0, res.data);
}

console.log('[수정 — 분류해도 온라인은 따로 켬 · 구분이 바뀌면 온라인 꺼짐]');
{
  let res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { product_type: 'GENERAL' } });
  check('분류 전 → 일반 상품', res.status === 200 && res.data.product.product_type === 'GENERAL', res.data);
  check('분류만 해서는 온라인 판매가 켜지지 않음', res.data.product.online_visible === 0 && !(await inMall(unclassified.id)), res.data.product);

  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { online_visible: true } });
  check('일반 상품은 온라인 판매를 켤 수 있음', res.status === 200 && res.data.product.online_visible === 1 && (await inMall(unclassified.id)), res.data);

  const member = await signupMember(db, {}, { keepOrder: true });
  res = await api('/cart', { token: member.data.token, method: 'POST', body: { product_id: unclassified.id, quantity: 1 } });
  check('장바구니 담기', res.status === 201 || res.status === 200, res.data);

  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { product_type: 'OTC' } });
  check('일반의약품으로 바꾸면 온라인 판매가 꺼짐', res.status === 200 && res.data.product.online_visible === 0, res.data);
  check('일반의약품으로 바꾸면 장바구니에서 빠짐', db.prepare('SELECT COUNT(*) AS n FROM carts WHERE product_id = ?').get(unclassified.id).n === 0);

  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { online_visible: true } });
  check('일반의약품은 수정으로도 온라인 판매를 켤 수 없음', res.status === 400, res.data);

  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { product_type: 'GENERAL' } });
  check('다시 일반 상품으로 바꿔도 온라인 판매는 꺼진 채', res.status === 200 && res.data.product.online_visible === 0, res.data);

  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { pos_sale_enabled: false } });
  check('POS 판매만 따로 끄기', res.status === 200 && res.data.product.pos_sale_enabled === 0 && res.data.product.product_type === 'GENERAL', res.data);
  res = await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { price: 1200 } });
  check('다른 값을 고쳐도 POS 판매 설정 유지', res.data.product.pos_sale_enabled === 0, res.data.product);
  await api(`/products/${unclassified.id}`, { token: owner, method: 'PATCH', body: { pos_sale_enabled: true } });
}

console.log('[일괄 — 온라인 판매는 일반 상품만 · 일괄 분류]');
{
  const a = (await create({})).data.product;
  const b = (await create({ product_type: 'GENERAL' })).data.product;
  const c = (await create({ product_type: 'OTC' })).data.product;
  let res = await api('/products/bulk-visibility', { token: owner, method: 'POST', body: { ids: [a.id, b.id, c.id], online_visible: true } });
  check('일반 상품만 켜고 나머지는 건너뜀', res.data.updated === 1 && res.data.skipped === 2, res.data);
  check('분류 전·일반의약품은 그대로 꺼짐', row(a.id).online_visible === 0 && row(c.id).online_visible === 0 && row(b.id).online_visible === 1);

  res = await api('/products/bulk-type', { token: owner, method: 'POST', body: { ids: [a.id, b.id], product_type: 'GENERAL' } });
  check('일괄 분류 (이미 일반 상품인 것은 그대로)', res.status === 200 && res.data.updated === 1, res.data);
  check('일괄 분류해도 온라인 판매는 꺼진 채', row(a.id).product_type === 'GENERAL' && row(a.id).online_visible === 0, row(a.id));
  check('이미 같은 구분이면 온라인 설정 유지', row(b.id).online_visible === 1, row(b.id));

  res = await api('/products/bulk-type', { token: owner, method: 'POST', body: { ids: [b.id], product_type: 'ETC' } });
  check('전문의약품으로 일괄 분류하면 온라인 꺼짐', res.data.updated === 1 && row(b.id).product_type === 'ETC' && row(b.id).online_visible === 0, row(b.id));
  res = await api('/products/bulk-type', { token: owner, method: 'POST', body: { ids: [a.id] } });
  check('구분 없이 일괄 분류는 거절', res.status === 400, res.data);
  res = await api('/products/bulk-type', { token: staff, method: 'POST', body: { ids: [a.id], product_type: 'OTC' } });
  check('직원은 일괄 분류 불가', res.status === 403, res.status);
}

console.log('[온라인 — 일반 상품만 담고 주문]');
{
  const member = await signupMember(db, {}, { keepOrder: true });
  const token = member.data.token;
  const kinds = {};
  for (const type of ['UNCLASSIFIED', 'ETC', 'OTC']) {
    kinds[type] = (await create({ product_type: type })).data.product;
    fill(kinds[type].id);
    // 예전 데이터처럼 온라인 값만 켜져 있어도 구분으로 막혀야 한다.
    db.prepare('UPDATE products SET online_visible = 1 WHERE id = ?').run(kinds[type].id);
  }
  let res = await api('/cart', { token, method: 'POST', body: { product_id: kinds.UNCLASSIFIED.id, quantity: 1 } });
  check('분류 전 상품은 장바구니에 못 담음', res.status === 404, res);
  res = await api('/cart', { token, method: 'POST', body: { product_id: kinds.ETC.id, quantity: 1 } });
  check('전문의약품은 장바구니에 못 담음', res.status === 404, res);
  res = await api('/cart', { token, method: 'POST', body: { product_id: kinds.OTC.id, quantity: 1 } });
  check('일반의약품은 방문 구매 안내', res.status === 400 && /일반의약품/.test(res.data.message), res.data);
  const mall = (await api('/products/mall?pharmacyCode=A001', { token })).data.products;
  check('몰에는 일반 상품만', mall.every((p) => p.product_type === 'GENERAL'), mall.map((p) => p.product_type));
  res = await api(`/products/mall/${kinds.UNCLASSIFIED.id}?pharmacyCode=A001`, { token });
  check('분류 전 상품 상세도 안 보임', res.status === 404, res.status);
  db.prepare('UPDATE products SET stock_quantity = 0 WHERE id = ?').run(kinds.UNCLASSIFIED.id);
  res = await api('/demand/me/restock-alerts', { token, method: 'POST', body: { product_id: kinds.UNCLASSIFIED.id } });
  check('분류 전 상품은 재입고 알림 신청 불가', res.status === 404, res.data);

  const sellable = (await create({ product_type: 'GENERAL', online_visible: true, stock_quantity: 0 })).data.product;
  fill(sellable.id);
  res = await api('/cart', { token, method: 'POST', body: { product_id: sellable.id, quantity: 1 } });
  check('일반 상품은 담김', res.status === 201 || res.status === 200, res.data);
  db.prepare("UPDATE products SET product_type = 'UNCLASSIFIED' WHERE id = ?").run(sellable.id);
  res = await checkout(token, { order_type: 'PICKUP', contact_name: '테스트', contact_phone: '01000000000', preferred_at: '2026-12-01T10:00' });
  check('담은 뒤 분류 전으로 바뀌면 주문 막힘', res.status === 400 && /온라인에서 판매하지/.test(res.data.message), res.data);
  db.prepare('DELETE FROM carts WHERE product_id = ?').run(sellable.id);
}

console.log('[POS — 분류 전·일반의약품은 약사만 · 전문의약품은 판매 불가 · 포인트 제외]');
{
  db.prepare('UPDATE pharmacies SET point_enabled = 1, point_earn_rate = 1, point_min_use = 1000 WHERE id = 1').run();
  const session = (await api('/pos/sessions/current', { token: owner })).data.session;
  if (!session) await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } });
  const make = async (type, extra = {}) => {
    const product = (await create({ product_type: type, price: 10000, ...extra })).data.product;
    fill(product.id);
    return product;
  };
  const sell = (token, product, customerId = null) =>
    api('/pos/sales', {
      token,
      method: 'POST',
      body: { customer_id: customerId, items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 10000 }] }
    });

  const pending = await make('UNCLASSIFIED');
  const etc = await make('ETC');
  const general = await make('GENERAL');
  const posOff = await make('GENERAL', { pos_sale_enabled: false });

  let res = await sell(staff, pending);
  check('직원은 분류 전 상품 판매 불가', res.status === 403 && /분류/.test(res.data.message), res.data);
  res = await sell(staff, general);
  check('직원도 일반 상품은 판매', res.status === 201, res.data);
  res = await sell(owner, etc);
  check('전문의약품은 약사도 POS 판매 불가', res.status === 400 && /전문의약품/.test(res.data.message), res.data);
  res = await sell(owner, posOff);
  check('POS 판매를 끈 상품은 판매 불가', res.status === 400 && /POS 판매/.test(res.data.message), res.data);

  const member = await signupMember(db, {}, { keepOrder: true });
  const customerId = (await api('/customers/me', { token: member.data.token })).data.customer.id;
  res = await sell(owner, pending, customerId);
  check('약사는 분류 전 상품 판매', res.status === 201, res.data);
  check('분류 전 상품은 포인트 적립 안 함', res.data.points?.earned === 0, res.data.points);
  res = await sell(owner, general, customerId);
  check('일반 상품은 적립', res.data.points?.earned === 100, res.data.points);

  res = await api('/pos/products?query=' + encodeURIComponent(etc.product_name), { token: owner });
  check('POS 검색에 전문의약품은 구분과 함께 보임', res.data.products.some((p) => p.id === etc.id && p.product_type === 'ETC'), res.data);

  res = await api('/pos/products/quick', {
    token: owner,
    method: 'POST',
    body: { product_name: `빠른 등록 ${process.pid}`, price: 1000, barcode: `88${process.pid}${Date.now() % 1e6}` }
  });
  check('POS 빠른 등록도 구분 없으면 분류 전', res.status === 201 && res.data.product.product_type === 'UNCLASSIFIED', res.data);
  check('POS 빠른 등록 상품은 온라인 판매 꺼짐', row(res.data.product.id).online_visible === 0, row(res.data.product.id));
  res = await api('/pos/products/quick', { token: owner, method: 'POST', body: { product_name: 'x', price: 1, barcode: '1234', product_type: 'DRUG' } });
  check('POS 빠른 등록 잘못된 구분 거절', res.status === 400, res.data);
}

console.log('[이전 데이터 — "구분 확인 필요"는 분류 전으로, 일반 상품이 아니면 온라인 끔]');
{
  const flagged = (await create({ product_type: 'GENERAL' })).data.product;
  const otc = (await create({ product_type: 'OTC' })).data.product;
  db.prepare('UPDATE products SET needs_review = 1, online_visible = 1 WHERE id = ?').run(flagged.id);
  db.prepare('UPDATE products SET online_visible = 1 WHERE id = ?').run(otc.id);
  execFileSync(process.execPath, ['-e', "require('./src/db').migrate()"], { cwd: new URL('..', import.meta.url), env: process.env });
  check('구분 확인 필요 → 분류 전 · 온라인 끔', row(flagged.id).product_type === 'UNCLASSIFIED' && row(flagged.id).online_visible === 0 && row(flagged.id).needs_review === 0, row(flagged.id));
  check('일반의약품에 남은 온라인 값 정리', row(otc.id).online_visible === 0, row(otc.id));
}

done();
