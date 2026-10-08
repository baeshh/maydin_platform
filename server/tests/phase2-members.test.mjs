import { createRequire } from 'node:module';
import { BASE, REQUIRED_CONSENTS, api, check, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const thisMonth = new Date().getMonth() + 1;

async function member(name, extra = {}) {
  const res = await signupMember(db, { name, consents: { ...REQUIRED_CONSENTS, ...(extra.consents || {}) }, ...extra.profile });
  if (res.status !== 201) throw new Error(`가입 실패 ${name}: ${JSON.stringify(res.data)}`);
  const me = await api('/customers/me', { token: res.data.token });
  return { ...me.data.customer, phone: res.phone, token: res.data.token };
}

const product = db.prepare('SELECT id, product_name FROM products WHERE pharmacy_id = 1 ORDER BY id LIMIT 1').get();
let seq = 0;
function order(customerId, amount, daysAgo, { type = amount > 0 ? 'POS_SALE' : 'POS_REFUND', status = 'COMPLETED', channel = 'POS', method = 'CARD' } = {}) {
  seq += 1;
  const created = db.prepare(`SELECT datetime('now', ?) AS at`).get(`-${daysAgo} days`).at;
  const result = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`T2-${Date.now()}-${seq}`, customerId, type, channel, Math.abs(amount), amount, status, created);
  if (amount > 0) {
    db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total_price) VALUES (?, ?, ?, 1, ?, ?)').run(
      result.lastInsertRowid, product.id, product.product_name, amount, amount
    );
    db.prepare('INSERT INTO payments (order_id, payment_method, payment_status, paid_amount) VALUES (?, ?, ?, ?)').run(result.lastInsertRowid, method, 'PAID', amount);
  }
}

const before = (await api('/members/summary', { token: owner })).data.totals;

const A = await member('분석A', { consents: { MARKETING_SMS: true } });
order(A.id, 400000, 300);
order(A.id, 200000, 100);
order(A.id, 150000, 10, { method: 'CASH' });
order(A.id, -60000, 5);

const B = await member('분석B');
order(B.id, 20000, 130);
order(B.id, 20000, 100);
order(B.id, 20000, 70);

const C = await member('분석C');
order(C.id, 500000, 400);
order(C.id, 5000, 200);

const D = await member('분석D', { profile: { birth_month: thisMonth, birth_day: 1, birth_year: 1995, gender: 'F' } });
order(D.id, 120000, 5, { type: 'PICKUP', channel: 'ONLINE' });

const E = await member('분석E', { profile: { birth_year: 1970, gender: 'M' } });
order(E.id, 35000, 60);
order(E.id, 10000, 50, { status: 'CANCELED' });
order(E.id, -10000, 50);

const F = await member('분석F');

async function metrics(customer) {
  const res = await api(`/members/${customer.id}`, { token: owner });
  return res.data;
}

console.log('[회원 지표]');
{
  const a = (await metrics(A)).metrics;
  check('A 반품 차감 12개월 순구매 69만', a.net_12m === 690000, a.net_12m);
  check('A 등급 골드', a.grade === 'GOLD' && a.grade_bonus === 1, a.grade);
  check('A 다음 등급 VIP까지 1만', a.next_grade?.grade === 'VIP' && a.next_grade.remaining === 10000, a.next_grade);
  check('A 구매 3회 (반품은 횟수 제외)', a.visit_count === 3, a.visit_count);
  check('A 평균 구매 주기 145일', a.avg_interval_days === 145, a.avg_interval_days);
  check('A 활성', a.status === 'ACTIVE', a.status);
  check('A 1회 평균 23만 → 10만 원 이상', a.avg_ticket === 230000 && a.amount_tier === 'OVER_100K', a);
  check('A 최고 결제 40만', a.max_ticket === 400000, a.max_ticket);

  const b = (await metrics(B)).metrics;
  check('B 평소 30일 간격, 70일 무구매 → 이탈 위험', b.status === 'AT_RISK' && b.avg_interval_days === 30, b);
  check('B 일반 등급, 1~3만 원대', b.grade === 'BASIC' && b.amount_tier === 'UNDER_30K', b);

  const c = (await metrics(C)).metrics;
  check('C 200일 무구매 → 휴면', c.status === 'DORMANT', c.status);
  check('C 12개월 지난 구매는 등급에서 제외', c.net_12m === 5000 && c.net_total === 505000 && c.grade === 'BASIC', c);

  const d = (await metrics(D)).metrics;
  check('D 첫 구매 5일 → 신규, 실버', d.status === 'NEW' && d.grade === 'SILVER', d);
  check('D 이번 달 생일 · 연령대', d.birthday_this_month && d.age_band === `${Math.floor((new Date().getFullYear() - 1995) / 10) * 10}대`, d);

  const e = (await metrics(E)).metrics;
  check('E 취소된 판매는 횟수 제외 → 재방문 없음', e.status === 'ONE_TIME' && e.visit_count === 1 && e.net_total === 35000, e);
  check('E 3~5만 원대 · 연령대', e.amount_tier === 'UNDER_50K' && e.age_band === `${Math.floor((new Date().getFullYear() - 1970) / 10) * 10}대`, e);

  const f = (await metrics(F)).metrics;
  check('F 구매 없음', f.status === 'NO_PURCHASE' && f.amount_tier === null && f.grade === 'BASIC', f);
}

console.log('[구매 행동]');
{
  const a = (await metrics(A)).behavior;
  check('채널: 매장', a.channels[0].key === 'POS', a.channels);
  check('결제수단: 카드 2 · 현금 1', a.payments[0].key === 'CARD' && a.payments[0].count === 2 && a.payments.find((p) => p.key === 'CASH')?.count === 1, a.payments);
  check('선호 카테고리', a.top_categories.length >= 1, a.top_categories);
  check('최근 주문 4건(반품 포함)', a.recent_orders.length === 4, a.recent_orders.length);
  const d = (await metrics(D)).behavior;
  check('D 채널: 픽업', d.channels[0].key === 'PICKUP', d.channels);
  const f = (await metrics(F)).behavior;
  check('구매 없으면 행동 정보 없음', f === null, f);
}

console.log('[요약]');
{
  const res = await api('/members/summary', { token: owner });
  const t = res.data.totals;
  check('회원 수 +6', t.members - before.members === 6, { before: before.members, after: t.members });
  check('구매 회원 +5', t.purchasers - before.purchasers === 5, t);
  check('이탈 위험 +1 · 휴면 +1', t.at_risk - before.at_risk === 1 && t.dormant - before.dormant === 1, t);
  check('이번 달 생일 +1', t.birthdays_this_month - before.birthdays_this_month === 1, t);
  check('등급 분포 4개', res.data.grades.length === 4 && res.data.grades[0].key === 'VIP', res.data.grades);
  check('상태 분포에 이름표', res.data.labels.statuses.AT_RISK === '이탈 위험', res.data.labels);
  check('회원 결제 비율 100% (비회원 판매 없음)', t.member_sale_rate === 100, t.member_sale_rate);
}

console.log('[목록 · 필터]');
{
  let res = await api('/members?q=분석&sort=spend', { token: owner });
  check('이름 검색 6명', res.data.total === 6, res.data.total);
  check('12개월 구매액 순 정렬', res.data.members[0].name === '분석A', res.data.members.map((m) => m.name));
  res = await api('/members?q=분석&status=AT_RISK', { token: owner });
  check('상태 필터', res.data.total === 1 && res.data.members[0].name === '분석B', res.data.members.map((m) => m.name));
  res = await api('/members?q=분석&grade=SILVER', { token: owner });
  check('등급 필터', res.data.total === 1 && res.data.members[0].name === '분석D', res.data.members.map((m) => m.name));
  res = await api('/members?q=분석&tier=OVER_100K', { token: owner });
  check('금액대 필터 (C는 평균 25만)', res.data.total === 3, res.data.members.map((m) => m.name));
  res = await api('/members?q=분석&birthday=1', { token: owner });
  check('이번 달 생일 필터', res.data.total === 1, res.data.total);
  res = await api('/members?q=분석&marketing=1', { token: owner });
  check('마케팅 동의 필터', res.data.total === 1 && res.data.members[0].name === '분석A', res.data.total);
  res = await api(`/members?q=${A.phone.slice(-4)}`, { token: owner });
  check('전화번호 뒤 4자리 검색', res.data.members.some((m) => m.id === A.id), res.data.total);
}

console.log('[CSV]');
{
  const res = await fetch(`${BASE}/api/members/export.csv?q=${encodeURIComponent('분석')}`, { headers: { Authorization: `Bearer ${owner}` } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  check('CSV 200 · BOM', res.status === 200 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, res.status);
  const lines = text.trim().split('\r\n');
  check('헤더 + 6행', lines.length === 7, lines.length);
  const aLine = lines.find((l) => l.includes('분석A'));
  const bLine = lines.find((l) => l.includes('분석B'));
  check('동의 회원은 연락처 포함', aLine.includes(A.phone), aLine);
  check('미동의 회원은 연락처 제외', !bLine.includes(B.phone) && bLine.includes('(수신 미동의)'), bLine);
  const log = db.prepare("SELECT description FROM admin_logs WHERE action = 'MEMBER_EXPORT' ORDER BY id DESC LIMIT 1").get();
  check('CSV 다운로드 감사 로그', log && log.description.includes('6명'), log);
}

console.log('[등급 기준 설정]');
{
  let res = await api('/members/policy', { token: owner });
  check('기본 기준', res.data.policy.silver_min === 100000 && res.data.policy.vip_bonus === 2 && res.data.policy.dormant_days === 180, res.data.policy);
  res = await api('/members/policy', { token: owner, method: 'PATCH', body: { silver_min: 400000 } });
  check('실버 ≥ 골드면 400', res.status === 400, res.data);
  res = await api('/members/policy', { token: owner, method: 'PATCH', body: { gold_bonus: 3 } });
  check('골드 적립률 > VIP면 400', res.status === 400, res.data);
  res = await api('/members/policy', { token: owner, method: 'PATCH', body: { dormant_days: 10 } });
  check('휴면 기준 범위 오류 400', res.status === 400, res.data);
  res = await api('/members/policy', { token: owner, method: 'PATCH', body: { vip_min: 600000 } });
  check('VIP 기준 60만으로 변경', res.status === 200 && res.data.policy.vip_min === 600000, res.data);
  let a = (await metrics(A)).metrics;
  check('기준 변경 즉시 A는 VIP', a.grade === 'VIP' && a.next_grade === null, a.grade);
  res = await api('/members/policy', { token: owner, method: 'PATCH', body: { dormant_days: 250 } });
  const c = (await metrics(C)).metrics;
  check('휴면 기준 250일이면 C는 휴면 아님', c.status === 'ACTIVE', c.status);
  await api('/members/policy', { token: owner, method: 'PATCH', body: { vip_min: 700000, dormant_days: 180 } });
  a = (await metrics(A)).metrics;
  check('기준 되돌리면 A는 골드', a.grade === 'GOLD', a.grade);
}

console.log('[권한]');
{
  let res = await api('/members/summary', { token: A.token });
  check('고객은 회원 분석 불가', res.status === 403, res.status);
  res = await api('/members/999999', { token: owner });
  check('없는 회원 404', res.status === 404, res.status);
}

done();
