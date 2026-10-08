import { createRequire } from 'node:module';
import { api, check, done, login, uniquePhone } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const thisMonth = new Date().getMonth() + 1;
const otherMonth = (thisMonth % 12) + 1;

db.prepare('UPDATE pharmacies SET point_enabled = 1, point_earn_rate = 1, point_min_use = 1000 WHERE id = 1').run();
db.prepare('DELETE FROM member_policies WHERE pharmacy_id = 1').run();
const productId = db
  .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status) VALUES (1, '4단계 테스트 영양제', 10000, 500, 'ON_SALE')")
  .run().lastInsertRowid;

let session = (await api('/pos/sessions/current', { token: owner })).data.session;
if (!session) session = (await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } })).data.session;

async function member(name, extra = {}) {
  const res = await api('/auth/customer/signup', {
    method: 'POST',
    body: { pharmacyCode: 'A001', name, phone: uniquePhone(), consents: { TERMS: true, PRIVACY: true }, ...extra }
  });
  if (res.status !== 201) throw new Error(`가입 실패 ${name}: ${JSON.stringify(res.data)}`);
  const me = await api('/customers/me', { token: res.data.token });
  return { ...me.data.customer, token: res.data.token };
}

let seq = 0;
function pastOrder(customerId, amount, daysAgo) {
  seq += 1;
  const created = db.prepare(`SELECT datetime('now', ?) AS at`).get(`-${daysAgo} days`).at;
  db.prepare(
    `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, created_at)
     VALUES (?, 1, ?, 'PICKUP', 'ONLINE', ?, ?, 'COMPLETED', ?)`
  ).run(`T4-${Date.now()}-${seq}`, customerId, amount, amount, created);
}

async function sell(customerId, quantity = 1) {
  return api('/pos/sales', {
    token: owner,
    method: 'POST',
    body: { customer_id: customerId, items: [{ product_id: productId, quantity }], payments: [{ method: 'CASH', amount: 10000 * quantity }] }
  });
}

const balance = (id) => db.prepare('SELECT point_balance FROM customers WHERE id = ?').get(id).point_balance;
const lastEarn = (orderId) => db.prepare("SELECT points, reason FROM point_ledger WHERE order_id = ? AND entry_type = 'EARN'").get(orderId);

console.log('[등급·생일 적립]');
{
  const basic = await member('적립일반', { birth_month: otherMonth, birth_day: 1 });
  let res = await sell(basic.id);
  check('일반 회원 1만 원 → 1% 100P', res.status === 201 && res.data.points.earned === 100, res.data);
  check('적립 사유 기본 1%', lastEarn(res.data.order.id)?.reason === '현장 구매 적립 1%', lastEarn(res.data.order.id));

  const silver = await member('적립실버');
  pastOrder(silver.id, 100000, 30);
  res = await sell(silver.id);
  check('실버(10만) → 1.5% 150P', res.data.points.earned === 150, res.data.points);
  check('적립 사유에 실버 +0.5%p', /1\.5%.*실버 \+0\.5%p/.test(lastEarn(res.data.order.id)?.reason || ''), lastEarn(res.data.order.id));

  const gold = await member('적립골드', { birth_month: thisMonth, birth_day: 1 });
  pastOrder(gold.id, 300000, 60);
  const pos = await api(`/pos/customers/${gold.id}`, { token: owner });
  const m = pos.data.membership;
  check('POS 회원 배지: 골드 +1%p', m?.grade === 'GOLD' && m.grade_label === '골드' && m.grade_bonus === 1, m);
  check('POS 회원 배지: 생일 달 2배', m?.birthday_this_month === true && m.birthday_multiplier === 2, m);
  check('POS 배지에 정확한 생일·금액 없음', m && !('birth_day' in m) && !('net_12m' in m), m);
  res = await sell(gold.id);
  check('골드 + 생일 달 → (1+1)×2 = 4% 400P', res.data.points.earned === 400, res.data.points);
  check('적립 사유에 골드·생일 달', /4%.*골드 \+1%p.*생일 달 2배/.test(lastEarn(res.data.order.id)?.reason || ''), lastEarn(res.data.order.id));

  const cancel = await api(`/pos/sales/${res.data.order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '테스트 취소' } });
  const reversed = db.prepare("SELECT SUM(points) AS total FROM point_ledger WHERE customer_id = ? AND entry_type = 'EARN_CANCEL'").get(gold.id).total;
  check('취소하면 등급 적립분도 전액 회수', cancel.status === 200 && reversed === -400, { status: cancel.status, reversed });

  const edge = await member('적립경계');
  pastOrder(edge.id, 95000, 10);
  res = await sell(edge.id);
  check('등급은 이번 구매 전 금액 기준 (9.5만 → 일반 1%)', res.data.points.earned === 100, res.data.points);
  const after = (await api(`/pos/customers/${edge.id}`, { token: owner })).data.membership;
  check('구매 후에는 실버로 올라감', after.grade === 'SILVER', after);

  await api('/members/policy', { token: owner, method: 'PATCH', body: { birthday_multiplier: 1 } });
  const bday = await member('생일배수끔', { birth_month: thisMonth, birth_day: 2 });
  res = await sell(bday.id);
  check('생일 배수 1로 바꾸면 생일 달에도 1%', res.data.points.earned === 100, res.data.points);
  await api('/members/policy', { token: owner, method: 'PATCH', body: { birthday_multiplier: 2 } });
}

console.log('[친구 추천 보상]');
{
  const referrer = await member('추천한사람');
  const friend = await member('추천받은친구', { referral_code: referrer.referral_code });
  const beforeReferrer = balance(referrer.id);
  let res = await sell(friend.id);
  check('첫 구매 영수증에 추천 보상 1,000P', res.status === 201 && res.data.points.reward === 1000, res.data.points);
  check('새 회원 잔액 = 적립 100 + 보상 1,000', balance(friend.id) === 1100, balance(friend.id));
  check('추천인 잔액 +1,000', balance(referrer.id) === beforeReferrer + 1000, balance(referrer.id));
  const rewards = db.prepare("SELECT customer_id, points, reason FROM point_ledger WHERE order_id = ? AND entry_type = 'REWARD'").all(res.data.order.id);
  check('보상 원장 2건 (REWARD)', rewards.length === 2, rewards);
  check('추천인 원장 사유에 친구 이름 가림', rewards.some((r) => r.customer_id === referrer.id && r.reason.includes('추*')), rewards);
  check('보상 지급 시각 기록', !!db.prepare('SELECT referral_rewarded_at FROM customers WHERE id = ?').get(friend.id).referral_rewarded_at);

  res = await sell(friend.id);
  check('두 번째 구매에는 보상 없음', res.data.points.reward === 0 && balance(referrer.id) === beforeReferrer + 1000, res.data.points);

  const log = db.prepare("SELECT description FROM admin_logs WHERE action = 'POS_SALE' ORDER BY id DESC LIMIT 2").all();
  check('감사 로그에 추천 보상 기록', log.some((l) => l.description.includes('추천 보상 1,000P') || l.description.includes('추천 보상 1000P')), log);

  const noRef = await member('추천없음');
  res = await sell(noRef.id);
  check('추천 없이 가입한 회원은 보상 없음', res.data.points.reward === 0 && balance(noRef.id) === 100, res.data.points);

  db.prepare('UPDATE pharmacies SET point_enabled = 0 WHERE id = 1').run();
  const offFriend = await member('포인트중지친구', { referral_code: referrer.referral_code });
  res = await sell(offFriend.id);
  check('포인트 중지 중에는 적립·보상 없음', res.data.points.earned === 0 && res.data.points.reward === 0, res.data.points);
  db.prepare('UPDATE pharmacies SET point_enabled = 1 WHERE id = 1').run();
  res = await sell(offFriend.id);
  check('이미 매장 구매가 있으면 나중에 보상하지 않음', res.data.points.reward === 0, res.data.points);
}

console.log('[고객 앱 내 등급]');
{
  const app = await member('앱회원');
  pastOrder(app.id, 250000, 20);
  let res = await api('/customers/me', { token: app.token });
  const m = res.data.membership;
  check('내 등급 실버', res.status === 200 && m.grade === 'SILVER' && m.grade_label === '실버', m);
  check('골드까지 5만 원', m.next_grade?.grade === 'GOLD' && m.next_grade.remaining === 50000, m.next_grade);
  check('등급표 4단계 · 기준 금액', m.grades.length === 4 && m.grades[0].min === 0 && m.grades[3].min === 700000, m.grades);
  check('포인트 사용 여부·약국 코드', res.data.point_enabled === true && res.data.pharmacy?.pharmacy_code === 'A001', res.data.pharmacy);
  check('추천 보상 금액 안내', m.referral_reward === 1000, m.referral_reward);
  check('곧 떨어질 상품 배열', Array.isArray(m.refills), m.refills);

  res = await api('/customers/me/profile', { token: app.token, method: 'PATCH', body: { birth_month: 5, birth_day: 10 } });
  check('생일 처음 등록은 가능', res.status === 200 && res.data.customer.birth_month === 5, res.data);
  res = await api('/customers/me/profile', { token: app.token, method: 'PATCH', body: { birth_month: thisMonth, birth_day: 1 } });
  check('등록한 생일은 앱에서 변경 불가', res.status === 400 && res.data.message.includes('약국'), res.data);
  res = await api('/customers/me/profile', { token: app.token, method: 'PATCH', body: { birth_month: null, birth_day: null } });
  check('등록한 생일 지우기도 불가', res.status === 400, res.data);
  res = await api('/customers/me/profile', { token: app.token, method: 'PATCH', body: { birth_month: 5, birth_day: 10, birth_year: 1990, gender: 'F' } });
  check('같은 생일 + 출생연도·성별 수정은 가능', res.status === 200 && res.data.customer.birth_year === 1990, res.data);
  res = await api(`/customers/${app.id}/profile`, { token: owner, method: 'PATCH', body: { birth_month: 6, birth_day: 1 } });
  check('약국은 생일 변경 가능', res.status === 200 && res.data.customer.birth_month === 6, res.data);

  const legacy = await member('기존회원');
  db.prepare("DELETE FROM customer_consents WHERE customer_id = ? AND consent_type IN ('TERMS', 'PRIVACY')").run(legacy.id);
  res = await api('/customers/me/consents', { token: legacy.token, method: 'PATCH', body: { consents: { TERMS: true, PRIVACY: true, MARKETING_SMS: true } } });
  check('기록 없는 필수 동의를 앱에서 동의', res.status === 200 && res.data.consents.TERMS.agreed && res.data.consents.MARKETING_SMS.agreed, res.data);
  res = await api('/customers/me/consents', { token: legacy.token, method: 'PATCH', body: { consents: { MARKETING_SMS: false, MARKETING_KAKAO: false } } });
  check('앱에서 마케팅 수신 끄기', res.status === 200 && !res.data.consents.MARKETING_SMS.agreed, res.data);
}

done();
