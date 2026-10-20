import { createRequire } from 'node:module';
import { TEST_PIN, api, check, done, login, postSignup, signupBody } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

// 약국마다 독립된 폐쇄몰: 상품·분류·장바구니·회원·로그인이 다른 약국으로 넘어가지 않는다.
const admin = await login('admin@maydin.kr', 'admin1234');
const stamp = String(Date.now()).slice(-5);

async function openPharmacy(letter) {
  const code = `I${letter}${stamp}`;
  const email = `${code.toLowerCase()}@iso.kr`;
  const res = await api('/admin/pharmacies', {
    token: admin,
    method: 'POST',
    body: { pharmacy_code: code, pharmacy_name: `${letter}약국`, owner_name: `${letter}약사`, store_slug: `iso-${code.toLowerCase()}`, owner_email: email, owner_password: 'isolation2026' }
  });
  const id = db.prepare('SELECT id FROM pharmacies WHERE pharmacy_code = ?').get(code)?.id;
  return { code, id, created: res.status, owner: await login(email, 'isolation2026') };
}

const A = await openPharmacy('A');
const B = await openPharmacy('B');

const product = (owner, body) =>
  api('/products', {
    token: owner,
    method: 'POST',
    body: { price: 12000, stock_quantity: 10, status: 'ON_SALE', category_name: '건강기능식품', tax_type: 'TAXABLE', ...body }
  });

async function joinAs(pharmacy, phone) {
  const { body } = signupBody(db, { pharmacyCode: pharmacy.code, ...(phone ? { phone } : {}) });
  const res = await postSignup(body);
  return { res, phone: body.phone, token: res.data.token, user: res.data.user };
}

console.log('[새 약국은 빈 몰로 시작]');
{
  check('A·B약국 개설', A.created === 201 && B.created === 201 && A.id && B.id, { A: A.created, B: B.created });
  const res = await api('/products', { token: B.owner });
  check('B약국 상품 0개 (다른 약국 상품을 복사하지 않음)', res.status === 200 && res.data.products.length === 0, res.data);
}

console.log('[상품 등록 — 일반 상품 + 온라인 판매 켬만 고객 몰에 보임]');
let aLive;
let aUnclassified;
let aOtc;
let bLive;
{
  aLive = (await product(A.owner, { product_name: 'A 비타민', product_type: 'GENERAL', online_visible: true })).data.product;
  aUnclassified = (await product(A.owner, { product_name: 'A 분류 전 상품' })).data.product;
  aOtc = (await product(A.owner, { product_name: 'A 일반의약품', product_type: 'OTC' })).data.product;
  bLive = (await product(B.owner, { product_name: 'B 오메가3', product_type: 'GENERAL', online_visible: true })).data.product;
  check('상품이 각자 약국에 저장', aLive.pharmacy_id === A.id && bLive.pharmacy_id === B.id);
  check('구분 없이 등록하면 분류 전 · 온라인 꺼짐', aUnclassified.product_type === 'UNCLASSIFIED' && aUnclassified.online_visible === 0, aUnclassified);
  const categories = db.prepare("SELECT pharmacy_id, id FROM categories WHERE category_name = '건강기능식품' AND pharmacy_id IN (?, ?)").all(A.id, B.id);
  check('같은 이름 분류도 약국마다 따로', categories.length === 2 && categories[0].id !== categories[1].id, categories);
}

console.log('[고객 — 자기 약국몰만]');
let custA;
let custB;
{
  custA = await joinAs(A);
  custB = await joinAs(B);
  check('A·B약국 회원 가입', custA.token && custB.token, { a: custA.res.data, b: custB.res.data });
  check('로그인 정보에 자기 약국 코드', custA.user?.pharmacy_code === A.code && custB.user?.pharmacy_code === B.code, custA.user);

  let res = await api(`/products/mall?pharmacyCode=${A.code}`, { token: custA.token });
  const names = (res.data.products || []).map((p) => p.product_name);
  check('A 회원: A 몰에 A 일반 상품만', res.status === 200 && names.length === 1 && names[0] === 'A 비타민', names);
  check('분류 전·일반의약품은 고객 몰에 안 보임', !names.includes('A 분류 전 상품') && !names.includes('A 일반의약품'));
  res = await api(`/products/mall?pharmacyCode=${B.code}`, { token: custA.token });
  check('A 회원은 B 몰 접근 불가(403)', res.status === 403, res.data);
  res = await api('/products/mall', { token: custB.token });
  check('B 회원: 코드 없이 열면 자기 몰(B)', res.status === 200 && res.data.products.length === 1 && res.data.products[0].id === bLive.id, res.data);
  res = await api(`/products/mall/${bLive.id}?pharmacyCode=${A.code}`, { token: custA.token });
  check('A 회원이 B 상품 번호로 조회 → 404', res.status === 404, res.data);
  res = await api('/cart', { token: custA.token, method: 'POST', body: { product_id: bLive.id, quantity: 1 } });
  check('A 회원 장바구니에 B 상품 못 담음', res.status === 404, res.data);
  res = await api('/cart', { token: custA.token, method: 'POST', body: { product_id: aLive.id, quantity: 1 } });
  check('A 회원 장바구니에 A 상품 담음', res.status === 201, res.data);
  res = await api('/cart', { token: custB.token });
  check('B 회원 장바구니에는 A 상품 없음', res.status === 200 && res.data.items.length === 0, res.data);
}

console.log('[같은 휴대폰 번호도 약국마다 별도 회원]');
{
  const again = await joinAs(B, custA.phone);
  check('A 회원 번호로 B약국에 따로 가입', Boolean(again.token) && again.user.pharmacy_code === B.code && again.user.id !== custA.user.id, again.res.data);
  let res = await api('/auth/customer/login', { method: 'POST', body: { pharmacyCode: A.code, phone: custB.phone, pin: TEST_PIN } });
  check('B 회원 번호로 A약국 로그인 불가', res.status >= 400 && !res.data.token, res.data);
  res = await api('/auth/customer/login', { method: 'POST', body: { pharmacyCode: B.code, phone: custA.phone, pin: TEST_PIN } });
  check('같은 번호로 B약국 로그인 → B 회원 계정', res.status === 200 && res.data.user.pharmacy_code === B.code && res.data.user.id === again.user.id, res.data);
}

console.log('[약국 운영자 — 자기 약국 데이터만]');
{
  let res = await api('/products', { token: A.owner });
  check('A 운영자 상품 목록에 B 상품 없음', res.data.products.every((p) => p.pharmacy_id === A.id) && !res.data.products.some((p) => p.id === bLive.id));
  res = await api(`/products?pharmacyId=${B.id}`, { token: A.owner });
  check('pharmacyId를 바꿔 보내도 A 상품만', res.data.products.every((p) => p.pharmacy_id === A.id), res.data.products.map((p) => p.pharmacy_id));
  res = await api(`/products/${bLive.id}`, { token: A.owner, method: 'PATCH', body: { price: 1, stock_quantity: 0 } });
  check('A 운영자가 B 상품 수정 불가(404)', res.status === 404, res.data);
  await api(`/products/${bLive.id}`, { token: A.owner, method: 'DELETE' });
  const row = db.prepare('SELECT price, status, stock_quantity FROM products WHERE id = ?').get(bLive.id);
  check('B 상품 그대로(가격·재고·상태)', row.price === 12000 && row.status === 'ON_SALE' && row.stock_quantity === 10, row);
  res = await api('/products/bulk-visibility', { token: A.owner, method: 'POST', body: { ids: [bLive.id], online_visible: false } });
  check('일괄 변경도 B 상품은 건드리지 못함', res.data.updated === 0 && db.prepare('SELECT online_visible FROM products WHERE id = ?').get(bLive.id).online_visible === 1, res.data);
  res = await api(`/products/mall?pharmacyCode=${B.code}`, { token: A.owner });
  check('A 운영자는 B 몰 미리보기 불가(403)', res.status === 403, res.data);
  res = await api('/members', { token: A.owner });
  const list = res.data.members || [];
  const bPhoneTail = custB.phone.slice(-4);
  check('A 운영자 회원 목록에 A 회원만', res.status === 200 && list.length === 1 && !JSON.stringify(list).includes(custB.user.name) && !JSON.stringify(list).includes(bPhoneTail), list);
}

console.log('[분류 → 온라인 판매 켜면 고객 몰에 나타남]');
{
  let res = await api('/products/bulk-type', { token: A.owner, method: 'POST', body: { ids: [aUnclassified.id], product_type: 'GENERAL' } });
  check('일반 상품으로 분류', res.data.updated === 1, res.data);
  res = await api(`/products/mall?pharmacyCode=${A.code}`, { token: custA.token });
  check('분류만 하면 아직 안 보임', !res.data.products.some((p) => p.id === aUnclassified.id));
  await api('/products/bulk-visibility', { token: A.owner, method: 'POST', body: { ids: [aUnclassified.id, aOtc.id], online_visible: true } });
  res = await api(`/products/mall?pharmacyCode=${A.code}`, { token: custA.token });
  const ids = res.data.products.map((p) => p.id);
  check('온라인 판매 켜면 보임 · 일반의약품은 켜도 안 보임', ids.includes(aUnclassified.id) && !ids.includes(aOtc.id), ids);
  res = await api(`/products/mall?pharmacyCode=${B.code}`, { token: custB.token });
  check('B 몰은 그대로 B 상품 1개', res.data.products.length === 1 && res.data.products[0].id === bLive.id, res.data.products.map((p) => p.product_name));
}

done();
