import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { api, check, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

// 약국마다 다른 온라인 몰 정책(배송·픽업·배송비·무료배송 기준·공지), 판매자 정보, 실제 판매 기준 인기 상품.
const admin = await login('admin@maydin.kr', 'admin1234');
const code = `ML${String(Date.now()).slice(-6)}`;
const ownerEmail = `${code.toLowerCase()}@mall.kr`;
await api('/admin/pharmacies', {
  token: admin,
  method: 'POST',
  body: {
    pharmacy_code: code,
    pharmacy_name: '정책약국',
    owner_name: '정약사',
    business_number: '123-45-67890',
    phone: '02-555-0101',
    address: '서울시 중구 정책로 1',
    store_slug: `mall-${code.toLowerCase()}`,
    owner_email: ownerEmail,
    owner_password: 'mallPolicy2026'
  }
});
const owner = await login(ownerEmail, 'mallPolicy2026');
const pharmacyId = db.prepare('SELECT id FROM pharmacies WHERE pharmacy_code = ?').get(code).id;
await api('/staff', { token: owner, method: 'POST', body: { name: '정책직원', email: `${code.toLowerCase()}-staff@mall.kr`, password: 'staff1234a' } });
const staff = await login(`${code.toLowerCase()}-staff@mall.kr`, 'staff1234a');

const product = async (name, price, extra = {}) =>
  (await api('/products', { token: owner, method: 'POST', body: { product_name: name, price, stock_quantity: 30, product_type: 'GENERAL', online_visible: true, category_name: '건강기능식품', ...extra } })).data.product;
const settings = (token, body) => api('/pharmacies/me/mall-settings', { token, method: 'PATCH', body });
const byCode = () => api(`/pharmacies/by-code/${code}`);

console.log('[기본 정책 — 예전 고정값과 같음 · 판매자 정보 공개]');
{
  const res = await byCode();
  check('배송 3,000원 · 5만원 이상 무료 · 배송·픽업 켬', res.status === 200 && res.data.mall?.delivery_fee === 3000 && res.data.mall.free_delivery_min === 50000 && res.data.mall.delivery_enabled && res.data.mall.pickup_enabled, res.data.mall);
  check('판매자 정보(상호·대표·사업자번호·주소·전화)', res.data.seller?.pharmacy_name === '정책약국' && res.data.seller.owner_name === '정약사' && res.data.seller.business_number === '123-45-67890' && res.data.seller.phone, res.data.seller);
}

console.log('[약국 관리자만 설정 · 값 검사]');
{
  let res = await settings(staff, { delivery_fee: 0 });
  check('직원은 설정 불가(403)', res.status === 403, res.data);
  res = await settings(owner, { delivery_fee: -1 });
  check('음수 배송비 400', res.status === 400, res.data);
  res = await settings(owner, { delivery_fee: 2500.5 });
  check('소수 배송비 400', res.status === 400, res.data);
  res = await settings(owner, { delivery_enabled: false, pickup_enabled: false });
  check('배송·픽업 둘 다 끄기 400', res.status === 400, res.data);
  res = await settings(owner, { notice: 'x'.repeat(301) });
  check('공지 300자 초과 400', res.status === 400, res.data);
  res = await settings(owner, { delivery_fee: 2500, free_delivery_min: 30000, notice: '평일 3시 전 주문은 당일 출고' });
  check('설정 저장', res.status === 200 && res.data.mall.delivery_fee === 2500 && res.data.mall.free_delivery_min === 30000, res.data);
  res = await byCode();
  check('고객 몰에 바로 반영(배송비·기준·공지)', res.data.mall.delivery_fee === 2500 && res.data.mall.free_delivery_min === 30000 && res.data.mall.notice === '평일 3시 전 주문은 당일 출고', res.data.mall);
  check('설정 변경 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'MALL_SETTINGS' AND pharmacy_id = ? AND description LIKE '%2,500원%'").get(pharmacyId)));
}

const cheap = await product('정책 비타민', 10000);
const pricey = await product('정책 오메가', 35000);
const hidden = await product('정책 숨김', 9000, { online_visible: false });
const member = await signupMember(db, { pharmacyCode: code }, { keepOrder: true });
const token = member.data.token;
const cart = (productId, quantity = 1) => api('/cart', { token, method: 'POST', body: { product_id: productId, quantity } });
const clearCart = async () => {
  for (const item of (await api('/cart', { token })).data.items) await api(`/cart/${item.id}`, { token, method: 'DELETE' });
};
const delivery = (extra = {}) => ({ order_type: 'DELIVERY', delivery: { receiver_name: '정고객', receiver_phone: '01012341234', address: '서울시 중구 1' }, allow_duplicate: true, ...extra });
const pickup = () => ({ order_type: 'PICKUP', contact_name: '정고객', contact_phone: '01012341234', preferred_at: '2026-12-01T10:00', allow_duplicate: true });

console.log('[결제 금액 — 서버가 약국 정책으로 배송비 계산]');
{
  check('회원 가입', Boolean(token), member.data);
  await cart(cheap.id, 1);
  let res = await api('/payments/checkouts', { token, method: 'POST', body: delivery() });
  check('3만원 미만 배송 → 배송비 2,500원', res.status === 201 && res.data.checkout?.delivery_fee === 2500 && res.data.checkout.amount === 12500, res.data);
  await clearCart();
  await cart(pricey.id, 1);
  res = await api('/payments/checkouts', { token, method: 'POST', body: delivery({ checkout_key: 'mall-free-0001' }) });
  check('3만원 이상 → 무료배송', res.status === 201 && res.data.checkout?.delivery_fee === 0 && res.data.checkout.amount === 35000, res.data);
  res = await api('/payments/checkouts', { token, method: 'POST', body: pickup() });
  check('매장 픽업은 배송비 0원', res.status === 201 && res.data.checkout?.delivery_fee === 0, res.data);

  await settings(owner, { delivery_enabled: false });
  res = await api('/payments/checkouts', { token, method: 'POST', body: delivery({ checkout_key: 'mall-off-0001' }) });
  check('배송 끄면 배송 결제 400', res.status === 400 && /배송 주문을 받지 않/.test(res.data.message), res.data);
  res = await api('/payments/checkouts', { token, method: 'POST', body: pickup() });
  check('픽업은 그대로 가능(같은 요청은 기존 결제 요청 재사용)', [200, 201].includes(res.status) && res.data.checkout?.order_type === 'PICKUP', res.data);
  await settings(owner, { delivery_enabled: true, pickup_enabled: false });
  res = await api('/payments/checkouts', { token, method: 'POST', body: pickup() });
  check('픽업 끄면 픽업 결제 400', res.status === 400 && /픽업 주문을 받지 않/.test(res.data.message), res.data);
  await settings(owner, { pickup_enabled: true, delivery_fee: 0 });
  await clearCart();
  await cart(cheap.id, 1);
  res = await api('/payments/checkouts', { token, method: 'POST', body: delivery({ checkout_key: 'mall-zero-0001' }) });
  check('배송비 0원 설정 → 무료배송', res.status === 201 && res.data.checkout?.delivery_fee === 0, res.data);
  await clearCart();
}

console.log('[인기 상품 — 최근 30일 실제 판매 수량]');
{
  let res = await api(`/products/mall?pharmacyCode=${code}`, { token });
  check('판매 기록 없으면 인기 상품 없음', res.status === 200 && Array.isArray(res.data.popular_ids) && res.data.popular_ids.length === 0, res.data.popular_ids);
  const sale = (productId, quantity, { refunded = 0, daysAgo = 0, status = 'PAID' } = {}) => {
    const orderId = db
      .prepare(
        `INSERT INTO orders (order_number, pharmacy_id, order_type, sales_channel, total_product_amount, final_amount, order_status, payment_status, created_at)
         VALUES (?, ?, 'POS_SALE', 'POS', 0, 0, 'COMPLETED', ?, datetime('now', ?))`
      )
      .run(`ML-${Date.now()}-${Math.random()}`, pharmacyId, status, `-${daysAgo} days`).lastInsertRowid;
    db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total_price, refunded_quantity) VALUES (?, ?, ?, ?, 0, 0, ?)').run(orderId, productId, 'x', quantity, refunded);
  };
  sale(cheap.id, 2);
  sale(pricey.id, 5);
  sale(pricey.id, 3, { refunded: 3 });
  sale(cheap.id, 9, { daysAgo: 40 });
  sale(cheap.id, 9, { status: 'PENDING' });
  sale(hidden.id, 50);
  res = await api(`/products/mall?pharmacyCode=${code}`, { token });
  check('판매 수량 순(오메가 5 > 비타민 2) · 환불·30일 지난·미결제 제외', JSON.stringify(res.data.popular_ids) === JSON.stringify([pricey.id, cheap.id]), res.data.popular_ids);
  check('온라인 판매 안 하는 상품은 인기 상품에 없음', !res.data.popular_ids.includes(hidden.id));
  res = await api(`/products/mall/${pricey.id}?pharmacyCode=${code}`, { token });
  check('상품 상세 조회', res.status === 200 && res.data.product.product_name === '정책 오메가' && !('cost_price' in res.data.product), res.data);
  res = await api(`/products/mall/${hidden.id}?pharmacyCode=${code}`, { token });
  check('온라인 판매 안 하는 상품 상세 404', res.status === 404, res.data);
}

console.log('[고객 화면 — 고정 문구·가짜 표시 없음]');
{
  const store = read('store.html');
  check('몰 제목 MAYDIN STORE · 약국 온라인 몰 부제', /class="mall-brand-title">MAYDIN STORE</.test(store) && /mallSubtitle\(pharmacy\)/.test(store));
  check('고정 홍보 문구 없음', !/환절기|단독 혜택|맞춤 추천|지금 가장 많이 담는/.test(store));
  check('근거 없는 BEST·무료배송 배지 없음', !/'BEST'|'무료배송'\)/.test(store) && !/>= 50000/.test(store));
  for (const file of ['cart.html', 'order-delivery.html', 'order.html']) {
    check(`${file}: 고정 배송비(3,000원·5만원) 없음`, !/50000|: 3000|5만원 이상/.test(read(file)));
  }
  check('상품 상세 페이지', /\/products\/mall\/\$\{productId\}/.test(read('product.html')));
}

done();
