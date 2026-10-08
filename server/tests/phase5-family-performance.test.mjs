import { createRequire } from 'node:module';
import { BASE, api, check, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const admin = await login('admin@maydin.kr', 'admin1234');
const year = new Date().getFullYear();

async function member(name, pharmacyCode = 'A001') {
  const res = await signupMember(db, { pharmacyCode, name });
  if (res.status !== 201) throw new Error(`가입 실패 ${name}: ${JSON.stringify(res.data)}`);
  const me = await api('/customers/me', { token: res.data.token });
  return { ...me.data.customer, phone: res.phone, token: res.data.token };
}

let seq = 0;
function order(pharmacyId, customerId, amount, daysAgo) {
  seq += 1;
  const created = db.prepare(`SELECT datetime('now', ?) AS at`).get(`-${daysAgo} days`).at;
  db.prepare(
    `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, created_at)
     VALUES (?, ?, ?, 'POS_SALE', 'POS', ?, ?, 'COMPLETED', ?)`
  ).run(`T5-${Date.now()}-${seq}`, pharmacyId, customerId, amount, amount, created);
}

console.log('[가족 · 고객 앱]');
const head = await member('가족대표');
const spouse = await member('가족배우자');
const other = await member('다른대표');
let familyId;
{
  let res = await api('/customers/me/family', { token: head.token });
  check('처음엔 가족 없음', res.status === 200 && res.data.family.members.length === 0 && res.data.relations.CHILD === '자녀', res.data);

  res = await api('/customers/me/family', { token: head.token, method: 'POST', body: { relation: 'CHILD', name: '첫째', birth_year: year - 7, gender: 'F' } });
  check('자녀 등록', res.status === 201 && res.data.family.members[0].age === 7 && res.data.family.members[0].relation_label === '자녀', res.data);
  familyId = res.data.family.members[0].id;

  res = await api('/customers/me/family', { token: head.token, method: 'POST', body: { relation: 'FRIEND', name: '친구' } });
  check('없는 관계 400', res.status === 400, res.data);
  res = await api('/customers/me/family', { token: head.token, method: 'POST', body: { relation: 'PARENT', name: '' } });
  check('이름·호칭 없으면 400', res.status === 400, res.data);
  res = await api('/customers/me/family', { token: head.token, method: 'POST', body: { relation: 'PARENT', name: '어머니', birth_year: year + 1 } });
  check('미래 출생연도 400', res.status === 400, res.data);

  res = await api(`/customers/me/family/${familyId}`, { token: head.token, method: 'PATCH', body: { name: '큰딸' } });
  check('호칭 수정', res.status === 200 && res.data.family.members[0].name === '큰딸', res.data);
  res = await api(`/customers/me/family/${familyId}`, { token: other.token, method: 'DELETE' });
  check('남의 가족은 삭제 불가 404', res.status === 404, res.data);

  const many = await member('가족많은회원');
  for (let i = 0; i < 8; i += 1) {
    await api('/customers/me/family', { token: many.token, method: 'POST', body: { relation: 'ETC', name: `가족${i}` } });
  }
  res = await api('/customers/me/family', { token: many.token, method: 'POST', body: { relation: 'ETC', name: '아홉째' } });
  check('가족은 8명까지', res.status === 400 && res.data.message.includes('8명'), res.data);
}

console.log('[가족 · 약국에서 회원 연결]');
{
  order(1, head.id, 50000, 20);
  order(1, spouse.id, 30000, 10);

  let res = await api(`/customers/${head.id}/family`, { token: owner, method: 'POST', body: { relation: 'SPOUSE', link_query: spouse.phone } });
  check('전화번호로 가입 회원 연결', res.status === 201 && res.data.family.members.some((m) => m.linked_customer_id === spouse.id), res.data);
  const linked = res.data.family.members.find((m) => m.linked_customer_id === spouse.id);
  check('연결 회원 이름 자동 채움', linked?.name === '가족배우자', linked);
  check('가족 합산 12개월 구매 8만', res.data.family.household?.net_12m === 80000, res.data.family.household);

  res = await api(`/customers/${other.id}/family`, { token: owner, method: 'POST', body: { relation: 'SPOUSE', link_query: spouse.phone } });
  check('이미 연결된 회원은 다른 가족에 연결 불가 409', res.status === 409, res.data);
  res = await api(`/customers/${other.id}/family`, { token: owner, method: 'POST', body: { relation: 'SIBLING', link_query: head.member_code } });
  check('가족 대표는 다른 가족에 연결 불가 409', res.status === 409, res.data);
  res = await api(`/customers/${head.id}/family`, { token: owner, method: 'POST', body: { relation: 'ETC', link_query: head.phone } });
  check('본인 연결 불가', res.status === 400, res.data);
  res = await api(`/customers/${head.id}/family`, { token: owner, method: 'POST', body: { relation: 'ETC', link_query: '01000000000' } });
  check('없는 회원 404', res.status === 404, res.data);
  res = await api(`/customers/${head.id}/family`, { token: owner, method: 'POST', body: { relation: 'ETC', link_query: '1234' } });
  check('전화 뒤 4자리로는 연결 안 됨', res.status === 404, res.data);

  res = await api('/customers/me/family', { token: spouse.token, method: 'POST', body: { relation: 'CHILD', name: '아이' } });
  check('연결된 회원은 따로 가족 등록 불가', res.status === 400, res.data);
  res = await api('/customers/me/family', { token: spouse.token });
  check('연결된 회원 화면에 대표 표시', res.data.family.linked_to?.head_name === '가족대표' && res.data.family.linked_to.relation_label === '배우자', res.data.family);

  const detail = await api(`/customers/${spouse.id}`, { token: owner });
  check('약국 회원 상세에 가족 연결 정보', detail.data.family?.linked_to?.head_id === head.id, detail.data.family);

  const audit = db.prepare("SELECT description FROM admin_logs WHERE action = 'FAMILY_ADD' ORDER BY id DESC LIMIT 1").get();
  check('가족 연결 감사 로그', audit?.description.includes('회원 연결') && audit.description.includes('배우자'), audit);

  const pos = await api(`/pos/customers/${head.id}`, { token: owner });
  check('POS 배지: 가족 요약 (연결 회원은 출생연도로 나이 표시)', /^자녀\(7세\), 배우자\(\d+세\)$/.test(pos.data.membership.family_text), pos.data.membership);
  const pos2 = await api(`/pos/customers/${spouse.id}`, { token: owner });
  check('POS 배지: 연결 회원은 대표 이름', pos2.data.membership.family_head === '가족대표', pos2.data.membership);
}

console.log('[가족 · 회원 분석 필터]');
{
  const ids = async (family) => (await api(`/members?family=${family}&q=가족`, { token: owner })).data.members.map((m) => m.id);
  check('자녀 있는 회원', (await ids('CHILD')).includes(head.id));
  check('12세 이하 자녀', (await ids('YOUNG_CHILD')).includes(head.id));
  check('부모님 등록 회원에는 없음', !(await ids('PARENT')).includes(head.id));
  check('가족 등록 회원', (await ids('ANY')).includes(head.id));
  const list = (await api(`/members?q=가족대표`, { token: owner })).data.members[0];
  check('목록에 가족 요약', /^자녀\(7세\), 배우자\(\d+세\)$/.test(list?.family_text || ''), list);

  const res = await fetch(`${BASE}/api/members/export.csv?q=가족대표`, { headers: { Authorization: `Bearer ${owner}` } });
  const text = await res.text();
  check('CSV에 가족 열', text.includes('가족') && text.includes('자녀(7세)'), text.slice(0, 200));
}

console.log('[가족 · 해제]');
{
  let res = await api('/customers/me/family/leave', { token: spouse.token, method: 'POST' });
  check('연결 회원이 스스로 연결 끊기', res.status === 200 && res.data.family.linked_to === null, res.data);
  res = await api('/customers/me/family/leave', { token: spouse.token, method: 'POST' });
  check('다시 끊으면 400', res.status === 400, res.data);
  res = await api(`/customers/${head.id}`, { token: owner });
  check('대표 가족 목록에서 빠짐', res.data.family.members.length === 1, res.data.family.members);

  res = await api(`/customers/${head.id}/family/${familyId}`, { token: owner, method: 'DELETE' });
  check('약국에서 가족 해제', res.status === 200 && res.data.family.members.length === 0, res.data);
  check('해제 감사 로그', !!db.prepare("SELECT 1 FROM admin_logs WHERE action = 'FAMILY_REMOVE' AND target_id = ?").get(head.id));
}

console.log('[본사 약국별 성과]');
{
  const code = `P5${String(Date.now()).slice(-5)}`;
  const created = await api('/admin/pharmacies', {
    token: admin,
    method: 'POST',
    body: {
      pharmacy_code: code,
      pharmacy_name: '성과테스트약국',
      owner_name: '김약사',
      store_slug: `perf-${code.toLowerCase()}`,
      commission_rate: 5,
      owner_email: `${code.toLowerCase()}@perf.kr`,
      owner_password: 'owner1234'
    }
  });
  check('테스트 약국 생성', created.status === 201 || created.status === 200, created.data);
  const pharmacyId = created.data.pharmacy.id;

  const m1 = await member('성과1', code);
  const m2 = await member('성과2', code);
  await member('성과3', code);
  order(pharmacyId, m1.id, 30000, 100);
  order(pharmacyId, m1.id, 20000, 10);
  order(pharmacyId, m2.id, 10000, 5);
  order(pharmacyId, null, 40000, 2);
  db.prepare('UPDATE customers SET point_balance = 500 WHERE id = ?').run(m1.id);

  let res = await api('/admin/performance', { token: owner });
  check('약국 계정은 본사 성과 조회 불가', res.status === 403, res.status);

  res = await api('/admin/performance', { token: admin });
  const p = res.data.pharmacies.find((row) => row.id === pharmacyId);
  check('회원 3명 · 구매 회원 2명', p?.members === 3 && p.purchasers === 2, p);
  check('재방문율 50%', p?.repeat_rate === 50, p?.repeat_rate);
  check('90일 내 구매 회원 2명', p?.active_90d === 2, p?.active_90d);
  check('12개월 순매출 10만 · 결제 4건 · 객단가 2.5만', p?.net_12m === 100000 && p.sales_12m === 4 && p.avg_ticket === 25000, p);
  check('회원 거래 비율 75% · 회원 매출 비중 60%', p?.member_sale_rate === 75 && p.member_sales_share === 60, p);
  check('미사용 포인트 500P', p?.points_outstanding === 500, p?.points_outstanding);
  check('개인정보 필드 없음', p && !JSON.stringify(res.data).includes(m1.phone) && !('customers' in p), Object.keys(p || {}));
  const sum = res.data.pharmacies.reduce((s, row) => s + row.members, 0);
  check('전체 회원 = 약국별 합', res.data.totals.members === sum && res.data.totals.pharmacies === res.data.pharmacies.length, res.data.totals);

  const csv = await fetch(`${BASE}/api/admin/performance.csv`, { headers: { Authorization: `Bearer ${admin}` } });
  const text = await csv.text();
  check('성과 CSV', csv.status === 200 && text.includes('재방문율(%)') && text.includes('성과테스트약국'), text.slice(0, 120));
}

done();
