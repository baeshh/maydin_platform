import { createRequire } from 'node:module';
import {
  TEST_PIN,
  api,
  check,
  createSignupCode,
  done,
  login,
  postSignup,
  signupBody,
  signupMember,
  testIp
} from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
db.prepare('UPDATE pharmacies SET point_enabled = 1, point_earn_rate = 1, point_min_use = 1000 WHERE id = 1').run();
const productId = db
  .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status) VALUES (1, '가입인증 테스트 영양제', 10000, 500, 'ON_SALE')")
  .run().lastInsertRowid;
let session = (await api('/pos/sessions/current', { token: owner })).data.session;
if (!session) session = (await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } })).data.session;

const sell = (body = {}) =>
  api('/pos/sales', {
    token: owner,
    method: 'POST',
    body: { items: [{ product_id: productId, quantity: 2 }], payments: [{ method: 'CASH', amount: 20000 }], ...body }
  });
const customerLogin = (phone, pin = TEST_PIN, ip = testIp()) =>
  api('/auth/customer/login', { method: 'POST', body: { pharmacyCode: 'A001', phone, pin }, headers: { 'X-Forwarded-For': ip } });
const customerRow = (phone) => db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);

// 실제 POS 판매 영수증의 코드로 가입 본문을 만든다.
function bodyWithCode(code, overrides = {}) {
  const { body } = signupBody(db, overrides);
  return { ...body, code };
}

console.log('[영수증 가입 코드]');
let saleCode;
let saleOrderId;
{
  let res = await sell();
  check('비회원 판매 영수증에 가입 코드', res.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(res.data.signup_code?.code || ''), res.data.signup_code);
  saleCode = res.data.signup_code.code;
  saleOrderId = res.data.order.id;
  const row = db.prepare("SELECT expires_at > datetime('now', '+6 days') AS ok FROM verification_codes WHERE order_id = ?").get(saleOrderId);
  check('가입 코드는 7일 유효', row?.ok === 1, row);

  const member = db.prepare("SELECT id FROM customers WHERE approval_status = 'APPROVED' LIMIT 1").get();
  if (member) {
    res = await sell({ customer_id: member.id });
    check('회원 판매에는 가입 코드 없음', res.status === 201 && res.data.signup_code === null, res.data.signup_code);
  }

  res = await api(`/auth/customer/signup-code?pharmacyCode=A001&code=${encodeURIComponent(saleCode.toLowerCase())}`, { headers: { 'X-Forwarded-For': testIp() } });
  check('코드 확인 (소문자·하이픈 허용) → 구매 일자·금액', res.status === 200 && res.data.purchase.amount === 20000 && res.data.purchase.item_count === 1, res.data);

  const reissue = await sell();
  const oldCode = reissue.data.signup_code.code;
  res = await api(`/pos/sales/${reissue.data.order.id}/signup-code`, { token: owner, method: 'POST' });
  check('약국이 가입 코드 재발급', res.status === 200 && res.data.issued.code !== oldCode && res.data.signup_code.code === res.data.issued.code, res.data.issued);
  res = await api(`/auth/customer/signup-code?pharmacyCode=A001&code=${oldCode}`, { headers: { 'X-Forwarded-For': testIp() } });
  check('재발급하면 예전 코드는 무효', res.status === 400, res.data);
  const log = db.prepare("SELECT 1 FROM admin_logs WHERE action = 'SIGNUP_CODE_REISSUE' AND target_id = ?").get(reissue.data.order.id);
  check('재발급 감사 로그', Boolean(log));
}

console.log('[가입 막기 — 코드·필수 정보]');
{
  let res = await postSignup(bodyWithCode(''));
  check('코드 없이 가입 400', res.status === 400, res.data);
  res = await postSignup(bodyWithCode('ZZZZ-ZZZZ'));
  check('틀린 코드 400', res.status === 400, res.data);
  const expired = createSignupCode(db, { ttl: '-1 minutes' });
  res = await postSignup(bodyWithCode(expired.code));
  check('만료된 코드 400', res.status === 400, res.data);

  const otherPharmacy = db.prepare('SELECT id FROM pharmacies WHERE id != 1 LIMIT 1').get();
  if (otherPharmacy) {
    const foreign = createSignupCode(db, { pharmacyId: otherPharmacy.id });
    res = await postSignup(bodyWithCode(foreign.code));
    check('다른 약국 영수증 코드 400', res.status === 400, res.data);
  }

  const canceled = await sell();
  await api(`/pos/sales/${canceled.data.order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '테스트 취소' } });
  res = await postSignup(bodyWithCode(canceled.data.signup_code.code));
  check('취소된 거래 코드 400', res.status === 400 && res.data.message.includes('취소'), res.data);

  const valid = createSignupCode(db).code;
  const cases = [
    ['민감정보 동의 없음', { consents: { TERMS: true, PRIVACY: true } }],
    ['성별 없음', { gender: '' }],
    ['생년 없음', { birth_year: undefined }],
    ['주소 없음', { address: ' ' }],
    ['알레르기 미입력', { allergy_none: false, allergy: '' }],
    ['복용 약 미입력', { medications_none: false }],
    ['만 14세 미만', { birth_year: new Date().getFullYear() - 10 }],
    ['PIN 5자리', { pin: '12345' }],
    ['PIN 같은 숫자', { pin: '777777' }],
    ['PIN 연속 숫자', { pin: '345678' }],
    ['PIN 생년월일', { birth_year: 1990, birth_month: 3, birth_day: 7, pin: '900307' }],
    ['PIN 휴대폰 번호 일부', { phone: '01048291573', pin: '482915' }]
  ];
  for (const [label, overrides] of cases) {
    res = await postSignup(bodyWithCode(valid, overrides));
    check(`${label} 400`, res.status === 400, res.data);
  }
  const unused = db.prepare("SELECT status FROM verification_codes WHERE code = ?").get(valid);
  check('검증에 실패하면 코드는 그대로 남음', unused.status === 'ACTIVE', unused);
}

console.log('[정상 가입 · 자동 승인]');
let approved;
{
  const body = bodyWithCode(saleCode, {
    name: '자동승인',
    allergy_none: false,
    allergy: '페니실린',
    medications_none: false,
    medications: '혈압약'
  });
  let res = await postSignup(body);
  check('영수증 코드로 가입 → 자동 승인 201', res.status === 201 && res.data.status === 'APPROVED' && res.data.token, res.data);
  check('인증 구매 적립 200P (2만 원 × 1%)', res.data.points_earned === 200, res.data);
  approved = { ...body, token: res.data.token, row: customerRow(body.phone) };

  const order = db.prepare('SELECT customer_id, points_earned FROM orders WHERE id = ?').get(saleOrderId);
  check('인증 구매가 회원 이력으로 연결', order.customer_id === approved.row.id && order.points_earned === 200, order);
  const ledger = db.prepare("SELECT reason FROM point_ledger WHERE order_id = ? AND entry_type = 'EARN'").get(saleOrderId);
  check('적립 사유 기록', ledger?.reason.startsWith('가입 인증 구매 적립'), ledger);
  check('코드 사용 처리', db.prepare('SELECT status, used_by_customer_id FROM verification_codes WHERE order_id = ? AND status = ?').get(saleOrderId, 'USED')?.used_by_customer_id === approved.row.id);

  res = await postSignup(bodyWithCode(saleCode));
  check('같은 코드 재사용 400', res.status === 400, res.data);
  res = await postSignup(bodyWithCode(createSignupCode(db).code, { phone: body.phone }));
  check('같은 번호 재가입 409', res.status === 409, res.data);

  check('PIN은 해시로만 저장', approved.row.pin_hash.startsWith('$2') && !approved.row.pin_hash.includes(TEST_PIN), approved.row.pin_hash);
  check('건강 정보는 암호문으로 저장', approved.row.health_info.startsWith('v1:') && !approved.row.health_info.includes('페니실린'), approved.row.health_info);
  check('주소 저장', db.prepare('SELECT address FROM addresses WHERE id = ?').get(approved.row.default_address_id)?.address === body.address);

  res = await api('/customers/me', { token: approved.token });
  check('본인은 건강 정보 조회', res.data.health?.allergy === '페니실린' && res.data.health.has_alert === true, res.data.health);
  check('본인 응답에 승인 메모·PIN 정보 없음', !('approval_note' in res.data.customer) && !('pin_hash' in res.data.customer), res.data.customer);
  check('민감정보 동의 기록', res.data.consents.HEALTH_INFO.agreed && res.data.consents.HEALTH_INFO.source === 'SIGNUP', res.data.consents.HEALTH_INFO);

  res = await api('/dashboard/customers', { token: owner });
  const listed = res.data.customers.find((c) => c.id === approved.row.id);
  check('고객 목록 응답에 PIN 해시·건강 정보 없음', listed && !('pin_hash' in listed) && !('health_info' in listed), listed);
}

console.log('[이상 징후 → 승인 대기]');
{
  const partial = await sell();
  const item = db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(partial.data.order.id);
  const refund = await api(`/pos/sales/${partial.data.order.id}/refunds`, {
    token: owner,
    method: 'POST',
    body: { reason: '부분 반품', items: [{ order_item_id: item.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 10000 }] }
  });
  check('(준비) 부분 반품', refund.status === 201 || refund.status === 200, refund.data);
  const body = bodyWithCode(partial.data.signup_code.code, { name: '부분반품가입' });
  let res = await postSignup(body);
  check('부분 반품 거래로 가입 → 승인 대기 202', res.status === 202 && res.data.status === 'PENDING' && !res.data.token, res.data);
  const pending = customerRow(body.phone);
  check('승인 대기 사유 기록', pending.approval_status === 'PENDING' && pending.approval_note.includes('부분 반품'), pending);

  res = await customerLogin(body.phone);
  check('승인 대기 중 로그인 403', res.status === 403 && res.data.status === 'PENDING', res.data);
  res = await api(`/pos/customers?query=${body.phone}`, { token: owner });
  check('승인 대기 회원은 POS 검색에 안 나옴', res.data.customers.length === 0, res.data);
  res = await api(`/members?q=${encodeURIComponent('부분반품가입')}`, { token: owner });
  check('승인 대기 회원은 회원 분석에 안 나옴', res.data.members.length === 0, res.data.members);

  res = await api('/customers/signup-requests', { token: owner });
  const request = res.data.requests.find((r) => r.id === pending.id);
  check('약국 승인 대기 목록', request && request.order_amount === 20000 && request.approval_note.includes('부분 반품'), request);

  res = await api(`/customers/${pending.id}/approve`, { token: owner, method: 'POST' });
  check('약사 승인', res.status === 200 && res.data.linked === true && res.data.points === 0, res.data);
  res = await customerLogin(body.phone);
  check('승인 후 로그인', res.status === 200 && res.data.token, res.data);
  res = await api(`/customers/${pending.id}/approve`, { token: owner, method: 'POST' });
  check('이미 승인된 회원 다시 승인 409', res.status === 409, res.data);

  const twinBody = bodyWithCode(createSignupCode(db).code, {
    name: approved.name,
    birth_year: approved.birth_year,
    birth_month: approved.birth_month,
    birth_day: approved.birth_day
  });
  res = await postSignup(twinBody);
  const twin = customerRow(twinBody.phone);
  check('이름·생년월일 같은 회원 → 승인 대기', res.status === 202 && twin.approval_note.includes('중복'), twin);
  res = await api(`/customers/${twin.id}/reject`, { token: owner, method: 'POST', body: {} });
  check('거절 사유 없으면 400', res.status === 400, res.data);
  res = await api(`/customers/${twin.id}/reject`, { token: owner, method: 'POST', body: { reason: '중복 가입' } });
  check('약사 거절', res.status === 200 && !res.data.requests.some((r) => r.id === twin.id), res.data);
  res = await customerLogin(twinBody.phone);
  check('거절된 회원 로그인 403', res.status === 403 && res.data.status === 'REJECTED', res.data);
  check('거절하면 건강 정보 삭제', customerRow(twinBody.phone).health_info === null);
  check('승인·거절 감사 로그', ['SIGNUP_APPROVE', 'SIGNUP_REJECT'].every((a) => db.prepare('SELECT 1 FROM admin_logs WHERE action = ?').get(a)));

  const ip = testIp();
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await postSignup(bodyWithCode(createSignupCode(db).code), ip)).status);
  check('같은 기기에서 24시간 안에 3번째 가입 → 승인 대기', statuses.join(',') === '201,201,202', statuses);

  const guessIp = testIp();
  for (let i = 0; i < 3; i += 1) await postSignup(bodyWithCode(`WRNG${i}AAA`), guessIp);
  const guessBody = bodyWithCode(createSignupCode(db).code);
  res = await postSignup(guessBody, guessIp);
  check('코드를 3번 틀린 뒤 가입 → 승인 대기', res.status === 202 && customerRow(guessBody.phone).approval_note.includes('틀린'), res.data);
}

console.log('[PIN 로그인]');
{
  let res = await api('/auth/customer/phone-login', { method: 'POST', body: { pharmacyCode: 'A001', phone: approved.phone } });
  check('번호만으로 로그인하던 API는 막힘 (410)', res.status === 410, res.data);
  res = await customerLogin(approved.phone);
  check('휴대폰 + PIN 로그인', res.status === 200 && res.data.user.role === 'CUSTOMER', res.data);
  const wrong = await customerLogin(approved.phone, '000001');
  const unknown = await customerLogin('01099990000', TEST_PIN);
  check('틀린 PIN과 없는 번호는 같은 응답 (가입 여부 숨김)', wrong.status === 401 && unknown.status === 401 && wrong.data.message === unknown.data.message, [wrong.data, unknown.data]);

  res = await api('/auth/login', { method: 'POST', body: { email: `a001-${approved.phone}@customer.local`, password: TEST_PIN } });
  check('고객 계정은 이메일 로그인 불가', res.status === 401, res.data);

  const ip = testIp();
  for (let i = 0; i < 3; i += 1) await customerLogin(approved.phone, '000001', ip);
  res = await customerLogin(approved.phone, '000001', ip);
  check('5번째 실패에서 잠김 423', res.status === 423 && res.data.message.includes('잠겼'), res.data);
  res = await customerLogin(approved.phone);
  check('잠긴 동안에는 맞는 PIN도 423', res.status === 423, res.data);
  db.prepare("UPDATE customers SET pin_locked_until = datetime('now', '-1 minutes') WHERE id = ?").run(approved.row.id);
  res = await customerLogin(approved.phone);
  check('잠금 시간이 지나면 로그인 · 실패 횟수 초기화', res.status === 200 && customerRow(approved.phone).pin_failed_count === 0, res.data);
  db.prepare('UPDATE customers SET pin_failed_count = 10 WHERE id = ?').run(approved.row.id);
  res = await customerLogin(approved.phone);
  check('10번 실패하면 약국 재설정 전까지 잠김', res.status === 423 && res.data.message.includes('약국'), res.data);
}

console.log('[PIN 재설정 · 기존 회원 첫 PIN]');
{
  let res = await api(`/customers/${approved.row.id}/pin-reset-code`, { token: owner, method: 'POST' });
  check('약국이 PIN 재설정 코드 발급', res.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(res.data.code), res.data);
  const resetCode = res.data.code;
  const reset = (body, ip = testIp()) =>
    api('/auth/customer/reset-pin', { method: 'POST', body: { pharmacyCode: 'A001', ...body }, headers: { 'X-Forwarded-For': ip } });

  res = await reset({ phone: '01099990000', code: resetCode, pin: '264819' });
  check('다른 번호로 재설정 400', res.status === 400, res.data);
  res = await reset({ phone: approved.phone, code: resetCode, pin: '111111' });
  check('약한 PIN 400', res.status === 400, res.data);
  res = await reset({ phone: approved.phone, code: resetCode, pin: '264819' });
  check('재설정 성공 → 바로 로그인', res.status === 200 && res.data.token, res.data);
  check('잠금 해제', customerRow(approved.phone).pin_failed_count === 0);
  res = await customerLogin(approved.phone);
  check('예전 PIN은 안 됨', res.status === 401, res.data);
  res = await customerLogin(approved.phone, '264819');
  check('새 PIN으로 로그인', res.status === 200, res.data);
  res = await reset({ phone: approved.phone, code: resetCode, pin: '582047' });
  check('재설정 코드 재사용 400', res.status === 400, res.data);
  approved.token = (await customerLogin(approved.phone, '264819')).data.token;

  res = await api('/customers/me/pin', { token: approved.token, method: 'POST', body: { current_pin: '000000', pin: '582047' } });
  check('앱 PIN 변경: 지금 PIN 틀리면 400', res.status === 400, res.data);
  res = await api('/customers/me/pin', { token: approved.token, method: 'POST', body: { current_pin: '264819', pin: '582047' } });
  check('앱 PIN 변경', res.status === 200 && (await customerLogin(approved.phone, '582047')).status === 200, res.data);

  const legacy = db.prepare("SELECT id, phone FROM customers WHERE approval_status = 'APPROVED' AND id != ? ORDER BY id LIMIT 1").get(approved.row.id);
  db.prepare('UPDATE customers SET pin_hash = NULL WHERE id = ?').run(legacy.id);
  res = await customerLogin(legacy.phone);
  check('PIN 없는 기존 회원은 로그인 불가', res.status === 401, res.data);
  const first = (await api(`/customers/${legacy.id}/pin-reset-code`, { token: owner, method: 'POST' })).data.code;
  res = await reset({ phone: legacy.phone, code: first, pin: '730518' });
  check('약국 코드로 첫 PIN 설정 → 로그인', res.status === 200 && (await customerLogin(legacy.phone, '730518')).status === 200, res.data);
}

console.log('[건강 정보 열람 · 철회]');
{
  let res = await api(`/customers/${approved.row.id}`, { token: owner });
  check('회원 상세에는 건강 정보 내용 없이 등록 여부만', res.data.customer.has_health === 1 && !('health' in res.data), res.data.customer);
  res = await api(`/customers/${approved.row.id}/health`, { token: owner });
  check('약사 건강 정보 열람', res.status === 200 && res.data.health.allergy === '페니실린', res.data);
  check('열람 감사 로그', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'HEALTH_VIEW' AND target_id = ?").get(approved.row.id)));
  res = await api(`/pos/customers/${approved.row.id}`, { token: owner });
  check('POS 관리자에게 건강 정보 있음 표시', res.data.membership?.has_health === true, res.data.membership);
  res = await api(`/pos/customers/${approved.row.id}/health`, { token: owner });
  check('POS에서 약사 열람', res.status === 200 && res.data.health.medications === '혈압약', res.data);

  res = await api('/customers/me/health', { token: approved.token, method: 'DELETE' });
  check('고객이 민감정보 동의 철회 → 즉시 삭제', res.status === 200 && customerRow(approved.phone).health_info === null && !res.data.consents.HEALTH_INFO.agreed, res.data);
  res = await api('/customers/me/health', { token: approved.token, method: 'PUT', body: { allergy_none: true, medications_none: true } });
  check('동의 없이 다시 저장 400', res.status === 400, res.data);
  res = await api('/customers/me/health', { token: approved.token, method: 'PUT', body: { consent: true, allergy: '조개류', medications_none: true } });
  check('다시 동의하고 저장', res.status === 200 && res.data.health.allergy === '조개류' && res.data.consents.HEALTH_INFO.agreed, res.data);
}

console.log('[추천 보상 — 인증 구매는 첫 구매로 안 침]');
{
  const referrer = db.prepare('SELECT id, referral_code, point_balance FROM customers WHERE id = ?').get(approved.row.id);
  const sale = await sell();
  const body = bodyWithCode(sale.data.signup_code.code, { referral_code: referrer.referral_code });
  let res = await postSignup(body);
  const friend = customerRow(body.phone);
  check('추천 코드로 가입 · 인증 구매 적립만', res.status === 201 && friend.point_balance === 200 && !friend.referral_rewarded_at, friend);
  res = await sell({ customer_id: friend.id });
  check('가입 후 첫 구매에 추천 보상', res.data.points.reward === 1000, res.data.points);
}

console.log('[온라인 주문 — 매장 구매 인증한 승인 회원만]');
{
  const order = (token, type = 'PICKUP') =>
    api('/orders', {
      token,
      method: 'POST',
      body: { order_type: type, payment_method: 'MOCK_CARD', contact_name: '테스트', contact_phone: '01000000000', preferred_at: '2026-12-01T10:00', memo: '상담' }
    });
  const addCart = (token) => api('/cart', { token, method: 'POST', body: { product_id: productId, quantity: 1 } });

  const sale = await sell();
  let res = await postSignup(bodyWithCode(sale.data.signup_code.code));
  const verified = res.data.token;
  res = await api('/orders/eligibility', { token: verified });
  check('영수증으로 가입한 회원은 온라인 주문 가능', res.data.allowed === true, res.data);
  await addCart(verified);
  res = await order(verified);
  check('인증 회원 픽업 주문 201', res.status === 201, res.data);

  const legacy = await signupMember(db);
  const legacyRow = customerRow(legacy.phone);
  res = await api('/orders/eligibility', { token: legacy.data.token });
  check('매장 구매 이력 없는 회원은 온라인 주문 불가', res.data.allowed === false && res.data.reason === 'NO_STORE_PURCHASE', res.data);
  await addCart(legacy.data.token);
  res = await order(legacy.data.token);
  check('배송·픽업 주문 403', res.status === 403 && res.data.reason === 'NO_STORE_PURCHASE', res.data);
  res = await order(legacy.data.token, 'DELIVERY');
  check('배송 주문도 403', res.status === 403, res.data);
  res = await order(legacy.data.token, 'COUNSEL');
  check('결제 없는 복약상담 예약은 가능', res.status === 201, res.data);
  res = await api(`/customers/${legacyRow.id}`, { token: owner });
  check('약국 회원 화면에 온라인 주문 불가 표시', res.data.online_order?.allowed === false, res.data.online_order);

  const refunded = await sell({ customer_id: legacyRow.id });
  await api(`/pos/sales/${refunded.data.order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '테스트 취소' } });
  res = await api('/orders/eligibility', { token: legacy.data.token });
  check('취소된 매장 구매는 인증으로 안 침', res.data.allowed === false, res.data);

  await sell({ customer_id: legacyRow.id });
  res = await api('/orders/eligibility', { token: legacy.data.token });
  check('매장에서 회원으로 결제하면 온라인 주문 가능', res.data.allowed === true, res.data);
  res = await order(legacy.data.token);
  check('인증 후 픽업 주문 201', res.status === 201, res.data);
}

console.log('[폐쇄몰 — 로그인한 회원만 접속]');
{
  let res = await api('/products/mall?pharmacyCode=A001');
  check('비회원 상품 목록 401', res.status === 401, res.data);
  res = await api(`/products/mall/${productId}?pharmacyCode=A001`);
  check('비회원 상품 상세 401', res.status === 401, res.data);
  res = await api('/products/public?pharmacyCode=A001');
  check('예전 공개 상품 경로로도 못 봄', res.status === 401, res.status);
  res = await api('/demand/search-miss', { method: 'POST', body: { pharmacyCode: 'A001', query: '비회원검색' } });
  check('비회원 검색 기록 401', res.status === 401, res.data);

  const member = await signupMember(db);
  res = await api('/products/mall?pharmacyCode=A001', { token: member.data.token });
  check('승인 회원은 상품 목록 열람', res.status === 200 && res.data.products.some((p) => p.id === productId), res.status);
  res = await api(`/products/mall/${productId}?pharmacyCode=A001`, { token: member.data.token });
  check('승인 회원은 상품 상세 열람', res.status === 200 && !('cost_price' in res.data.product), res.data);

  const admin = await login('admin@maydin.kr', 'admin1234');
  const code = `M6${String(Date.now()).slice(-5)}`;
  await api('/admin/pharmacies', {
    token: admin,
    method: 'POST',
    body: { pharmacy_code: code, pharmacy_name: '다른약국', owner_name: '이약사', store_slug: `mall-${code.toLowerCase()}`, owner_email: `${code.toLowerCase()}@mall.kr`, owner_password: 'owner1234' }
  });
  res = await api(`/products/mall?pharmacyCode=${code}`, { token: member.data.token });
  check('다른 약국 회원은 403', res.status === 403, res.data);
  const otherProduct = db
    .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status) VALUES ((SELECT id FROM pharmacies WHERE pharmacy_code = ?), '다른약국 상품', 1000, 5, 'ON_SALE')")
    .run(code).lastInsertRowid;
  res = await api(`/products/mall/${otherProduct}`, { token: member.data.token });
  check('다른 약국 상품 상세 404', res.status === 404, res.data);

  res = await api('/products/mall?pharmacyCode=A001', { token: owner });
  check('약국 운영자는 자기 몰 미리보기', res.status === 200, res.status);
  res = await api(`/products/mall?pharmacyCode=${code}`, { token: owner });
  check('다른 약국 몰은 운영자도 403', res.status === 403, res.data);
  res = await api(`/products/mall?pharmacyCode=${code}`, { token: admin });
  check('본사 관리자는 모든 몰 미리보기', res.status === 200 && res.data.products.length === 1, res.data);

  const pending = bodyWithCode((await sell()).data.signup_code.code, { name: customerRow(member.phone).name, birth_year: member.body.birth_year, birth_month: member.body.birth_month, birth_day: member.body.birth_day });
  res = await postSignup(pending);
  check('승인 대기 가입은 토큰 없음', res.status === 202 && !res.data.token, res.data);
}

console.log('[코드 대입 제한]');
{
  const ip = testIp();
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    statuses.push((await api(`/auth/customer/signup-code?pharmacyCode=A001&code=BAD${i}CODE`, { headers: { 'X-Forwarded-For': ip } })).status);
  }
  check('같은 IP에서 10번 틀리면 잠시 차단 (429)', statuses.slice(0, 10).every((s) => s === 400) && statuses[10] === 429, statuses);
  const res = await postSignup(bodyWithCode(createSignupCode(db).code), ip);
  check('차단 중에는 맞는 코드로도 가입 불가', res.status === 429, res.data);
}

done();
