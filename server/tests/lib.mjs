export const BASE = process.env.BASE || 'http://127.0.0.1:3001';

let passed = 0;
let failed = 0;

export async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export async function login(email, password) {
  const { status, data } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200) throw new Error(`로그인 실패: ${email} (${status})`);
  return data.token;
}

export function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

export function done() {
  console.log(`  ${passed} 통과, ${failed} 실패`);
  if (failed) process.exit(1);
}

export function uniquePhone() {
  return `010${String(Date.now() % 1e8).padStart(8, '0').slice(-4)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
}

/* ---------- 구매 인증 가입 ---------- */

export const TEST_PIN = '913572';
export const REQUIRED_CONSENTS = { TERMS: true, PRIVACY: true, HEALTH_INFO: true };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let seq = 0;

// 테스트 파일마다(프로세스마다) 다른 대역의 가짜 IP. 같은 기기 반복 가입 판정에 걸리지 않게 한다.
export function testIp() {
  seq += 1;
  return `10.${process.pid % 250}.${Math.floor(seq / 250) % 250}.${(seq % 250) + 1}`;
}

export function pharmacyIdOf(db, pharmacyCode = 'A001') {
  return db.prepare('SELECT id FROM pharmacies WHERE pharmacy_code = ?').get(pharmacyCode).id;
}

// 비회원 매장 판매 1건과 그 영수증의 가입 코드를 DB에 바로 만든다.
export function createSignupCode(db, { pharmacyId = 1, amount = 1000, ttl = '+7 days', orderId = null } = {}) {
  seq += 1;
  const id =
    orderId ||
    db
      .prepare(
        `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, payment_status)
         VALUES (?, ?, NULL, 'POS_SALE', 'POS', ?, ?, 'COMPLETED', 'PAID')`
      )
      .run(`TS-${process.pid}-${Date.now()}-${seq}`, pharmacyId, amount, amount).lastInsertRowid;
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  db.prepare(
    `INSERT INTO verification_codes (pharmacy_id, purpose, code, order_id, expires_at)
     VALUES (?, 'SIGNUP', ?, ?, datetime('now', ?))`
  ).run(pharmacyId, code, id, ttl);
  return { code, orderId: Number(id) };
}

// 필수 정보를 다 채운 가입 요청 본문. 생일 달은 이번 달을 피해서 생일 배수 적립이 끼어들지 않게 한다.
export function signupBody(db, overrides = {}) {
  seq += 1;
  const pharmacyCode = overrides.pharmacyCode || 'A001';
  const { code, orderId } = createSignupCode(db, { pharmacyId: pharmacyIdOf(db, pharmacyCode) });
  const otherMonth = (new Date().getMonth() + 1) % 12 + 1;
  return {
    orderId,
    body: {
      pharmacyCode,
      code,
      name: `테스트${process.pid % 1000}-${seq}`,
      phone: uniquePhone(),
      birth_year: 1960 + ((seq * 7 + process.pid) % 40),
      birth_month: otherMonth,
      birth_day: 1 + ((seq + process.pid) % 28),
      gender: 'F',
      address: '서울시 테스트구 테스트로 1',
      allergy_none: true,
      medications_none: true,
      pin: TEST_PIN,
      consents: REQUIRED_CONSENTS,
      ...overrides
    }
  };
}

export function postSignup(body, ip = testIp()) {
  return api('/auth/customer/signup', { method: 'POST', body, headers: { 'X-Forwarded-For': ip } });
}

// 예전 테스트용 회원 가입. 가입 인증에 쓴 가짜 구매는 지워서 구매 통계가 달라지지 않게 한다.
export async function signupMember(db, overrides = {}, { keepOrder = false } = {}) {
  const { body, orderId } = signupBody(db, overrides);
  const res = await postSignup(body);
  if (!keepOrder) db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  return { ...res, phone: body.phone, body, orderId };
}
