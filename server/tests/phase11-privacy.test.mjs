import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_PIN, api, check, createSignupCode, done, login, postSignup, signupBody, signupMember, testIp } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = path.join(path.dirname(process.env.DB_PATH), 'privacy-erasures.jsonl');

const owner = await login('owner@apharmacy.kr', 'owner1234');
const admin = await login('admin@maydin.kr', 'admin1234');
const staffEmail = `privacy-staff-${process.pid}@maydin.test`;
await api('/staff', { token: owner, method: 'POST', body: { name: '개인정보직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');

const customerRow = (id) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
const customerLogin = (phone, pin = TEST_PIN) =>
  api('/auth/customer/login', { method: 'POST', body: { pharmacyCode: 'A001', phone, pin }, headers: { 'X-Forwarded-For': testIp() } });
const runRetention = () => api('/admin/privacy/retention', { token: admin, method: 'POST' });
const ago = (modifier) => db.prepare('SELECT datetime(?, ?) AS at').get('now', modifier).at;

async function member(overrides = {}) {
  const res = await signupMember(db, overrides);
  const row = db.prepare('SELECT * FROM customers WHERE phone = ?').get(res.phone);
  return { token: res.data.token, phone: res.phone, id: row.id, row };
}

console.log('[가입 — 꼭 필요한 정보만]');
let minimal;
{
  const { body } = signupBody(db, {
    gender: '',
    address: '',
    consents: { TERMS: true, PRIVACY: true, HEALTH_INFO: true },
    allergy: '페니실린',
    medications: '혈압약'
  });
  const res = await postSignup(body);
  check('성별·주소·건강 정보 없이 가입 201', res.status === 201 && res.data.token, res.data);
  const row = db.prepare('SELECT * FROM customers WHERE phone = ?').get(body.phone);
  minimal = { token: res.data.token, phone: body.phone, id: row.id };
  check('성별 비어 있음', row.gender === null, row.gender);
  check('주소 없으면 배송지도 만들지 않음', row.default_address_id === null && !db.prepare('SELECT 1 FROM addresses WHERE user_id = ?').get(row.user_id));
  check('가입 요청에 건강 정보를 보내도 저장하지 않음', row.health_info === null, row.health_info);
  const consent = db.prepare("SELECT 1 FROM customer_consents WHERE customer_id = ? AND consent_type = 'HEALTH_INFO'").get(row.id);
  check('가입 때 민감정보 동의는 기록하지 않음', !consent);

  const missing = await postSignup(signupBody(db, { consents: { TERMS: true } }).body);
  check('필수 동의(개인정보)는 여전히 필요 400', missing.status === 400, missing.data);
}

console.log('[복약상담 — 문의 내용은 선택, 적으면 따로 동의·암호화]');
let counselId;
{
  const counsel = (body) =>
    api('/orders', { token: minimal.token, method: 'POST', body: { order_type: 'COUNSEL', preferred_at: '2026-12-01T10:00', ...body } });
  let res = await counsel({});
  check('문의 내용 없이 예약 201', res.status === 201 && res.data.order.has_counsel_note === false, res.data);
  res = await counsel({ memo: '두통약을 먹고 있어요' });
  check('문의 내용만 적고 동의 안 하면 400', res.status === 400 && res.data.message.includes('동의'), res.data);
  res = await counsel({ memo: '두통약을 먹고 있어요', counsel_consent: true });
  check('동의하고 문의 내용 전달 201', res.status === 201 && res.data.order.counsel_note === '두통약을 먹고 있어요', res.data);
  counselId = res.data.order.id;

  const row = db.prepare('SELECT memo, counsel_note, counsel_consent_at FROM orders WHERE id = ?').get(counselId);
  check('일반 메모 칸에는 남기지 않음', row.memo === null, row);
  check('문의 내용은 암호문 저장', row.counsel_note.startsWith('v1:') && !row.counsel_note.includes('두통'), row.counsel_note);
  check('예약별 동의 시각 기록', Boolean(row.counsel_consent_at));

  res = await api('/orders', { token: minimal.token });
  check('고객 본인은 자기 문의 내용 확인', res.data.orders.find((o) => o.id === counselId)?.counsel_note === '두통약을 먹고 있어요');
  res = await api('/orders', { token: owner });
  const listed = res.data.orders.find((o) => o.id === counselId);
  check('약국 주문 목록에는 내용 없이 있음 표시만', listed.has_counsel_note === true && !('counsel_note' in listed) && listed.memo === null, listed);
  res = await api('/pos/counsels', { token: staff });
  const posListed = res.data.counsels.find((c) => c.id === counselId);
  check('POS 상담 목록(직원)에도 내용 없음', posListed && posListed.has_note === true && !('memo' in posListed) && !('counsel_note' in posListed), posListed);

  res = await api(`/pos/counsels/${counselId}/note`, { token: staff });
  check('직원은 상담 내용 열람 불가 403', res.status === 403, res.data);
  res = await api(`/orders/${counselId}/counsel-note`, { token: admin, headers: { 'X-Pharmacy-Id': '1' } });
  check('플랫폼 관리자도 상담 내용 열람 불가 403', res.status === 403, res.data);
  res = await api(`/pos/counsels/${counselId}/note`, { token: owner });
  check('약사는 POS에서 열람', res.status === 200 && res.data.note === '두통약을 먹고 있어요', res.data);
  res = await api(`/orders/${counselId}/counsel-note`, { token: owner });
  check('약사는 파트너센터에서 열람', res.status === 200 && res.data.note === '두통약을 먹고 있어요', res.data);
  const viewLog = db.prepare("SELECT purpose FROM admin_logs WHERE action = 'COUNSEL_NOTE_VIEW' AND target_id = ?").all(minimal.id);
  check('열람 기록 2건 · 목적 복약상담', viewLog.length === 2 && viewLog.every((l) => l.purpose === 'COUNSEL'), viewLog);

  res = await api(`/orders/${counselId}/counsel-note`, { token: minimal.token, method: 'DELETE' });
  check('고객이 자기 문의 내용 삭제', res.status === 200 && res.data.order.has_counsel_note === false, res.data);
  const purged = db.prepare('SELECT counsel_note, counsel_note_purged_at FROM orders WHERE id = ?').get(counselId);
  check('삭제하면 암호문도 비우고 삭제 시각 기록', purged.counsel_note === null && Boolean(purged.counsel_note_purged_at), purged);
}

console.log('[건강 정보 — 열람 권한·목적]');
let patient;
{
  patient = await member();
  let res = await api(`/customers/${patient.id}/health`, { token: owner, method: 'PUT', body: { allergy: '조개', medications_none: true } });
  check('고객 동의 없으면 약사도 입력 불가 409', res.status === 409, res.data);
  res = await api('/customers/me/health', { token: patient.token, method: 'PUT', body: { allergy: '페니실린', medications: '와파린' } });
  check('동의 없이 고객 저장 400', res.status === 400, res.data);
  res = await api('/customers/me/consents', { token: patient.token, method: 'PATCH', body: { consents: { HEALTH_INFO: true } } });
  check('내용 없이 민감정보 동의만 하기 400', res.status === 400, res.data);
  res = await api('/customers/me/health', { token: patient.token, method: 'PUT', body: { consent: true, allergy: '페니실린', medications: '와파린' } });
  check('고객이 동의하고 입력', res.status === 200 && res.data.health.updated_by === 'CUSTOMER' && Boolean(res.data.health.expires_at), res.data);

  res = await api(`/customers/${patient.id}/health`, { token: owner });
  check('열람 목적 없으면 400', res.status === 400 && res.data.message.includes('목적'), res.data);
  res = await api(`/customers/${patient.id}/health?purpose=MARKETING`, { token: owner });
  check('정해진 목적이 아니면 400', res.status === 400, res.data);
  res = await api(`/customers/${patient.id}/health?purpose=SALE_CHECK`, { token: owner });
  check('목적을 고르면 약사 열람', res.status === 200 && res.data.health.medications === '와파린', res.data);
  res = await api(`/pos/customers/${patient.id}/health?purpose=COUNSEL`, { token: staff });
  check('직원은 POS에서 건강 정보 열람 불가 403', res.status === 403, res.data);
  res = await api(`/customers/${patient.id}/health?purpose=COUNSEL`, { token: admin });
  check('플랫폼 관리자는 건강 정보 열람 불가 403', res.status === 403, res.data);
  res = await api(`/pos/customers/${patient.id}/health`, { token: owner });
  check('POS도 목적 없으면 400', res.status === 400, res.data);

  res = await api(`/pos/customers/${patient.id}/health`, { token: owner, method: 'PUT', body: { allergy: '페니실린', medications: '와파린, 아스피린' } });
  check('상담 중 약사가 고침', res.status === 200 && res.data.health.medications === '와파린, 아스피린' && res.data.health.updated_by === 'PHARMACIST', res.data);
  res = await api(`/pos/customers/${patient.id}/health`, { token: staff, method: 'PUT', body: { allergy_none: true, medications_none: true } });
  check('직원은 고칠 수 없음 403', res.status === 403, res.data);

  res = await api('/customers/me/privacy', { token: patient.token });
  const log = res.data.access_log;
  check('고객이 자기 정보 이용 기록 확인', log.some((l) => l.action === 'HEALTH_VIEW' && l.purpose_label.includes('판매 전') && l.by === '약사'), log);
  check('약사 수정도 기록에 보임', log.some((l) => l.action === 'HEALTH_UPDATE'), log);
  check('보유기간 안내(건강 정보 24개월)', res.data.retention.health_months === 24, res.data.retention);
  check('이용 기록에 다른 고객 이름 없음', !JSON.stringify(log).includes('description'), log);
}

console.log('[동의 철회 · 보유기간]');
{
  let res = await api('/customers/me/health', { token: patient.token, method: 'DELETE' });
  check('고객이 동의 철회 → 즉시 삭제', res.status === 200 && customerRow(patient.id).health_info === null, res.data);
  check('철회 삭제가 이용 기록에 남음', res.data.privacy.access_log[0].action === 'HEALTH_CONSENT_WITHDRAWN', res.data.privacy.access_log[0]);

  await api('/customers/me/health', { token: patient.token, method: 'PUT', body: { consent: true, allergy: '페니실린', medications_none: true } });
  db.prepare('UPDATE customers SET health_updated_at = ? WHERE id = ?').run(ago('-23 months'), patient.id);
  res = await api('/customers/me/health/confirm', { token: patient.token, method: 'POST' });
  const confirmed = customerRow(patient.id);
  check('변경 없음 확인 → 보유기간 다시 시작', res.status === 200 && confirmed.health_updated_at > ago('-1 minutes') && res.data.health.allergy === '페니실린', res.data);

  db.prepare('UPDATE customers SET health_updated_at = ? WHERE id = ?').run(ago('-25 months'), patient.id);
  const counselOld = db.prepare("SELECT id FROM orders WHERE order_type = 'COUNSEL' AND customer_id = ? ORDER BY id LIMIT 1").get(minimal.id).id;
  db.prepare("UPDATE orders SET counsel_note = 'v1:dummy', counsel_note_purged_at = NULL, updated_at = ? WHERE id = ?").run(ago('-400 days'), counselOld);

  const rejectedBody = signupBody(db).body;
  await postSignup(rejectedBody);
  const rejected = db.prepare('SELECT id FROM customers WHERE phone = ?').get(rejectedBody.phone);
  db.prepare("UPDATE customers SET approval_status = 'PENDING' WHERE id = ?").run(rejected.id);
  res = await api(`/customers/${rejected.id}/reject`, { token: owner, method: 'POST', body: { reason: '본인 확인 불가' } });
  db.prepare('UPDATE customers SET approved_at = ? WHERE id = ?').run(ago('-31 days'), rejected.id);

  res = await runRetention();
  check('보유기간 파기 실행', res.status === 200 && res.data.result.health >= 1 && res.data.result.counsel_notes >= 1 && res.data.result.rejected >= 1, res.data);
  check('24개월 지난 건강 정보 삭제', customerRow(patient.id).health_info === null);
  const log = (await api('/customers/me/privacy', { token: patient.token })).data.access_log;
  check('만료 삭제가 고객 이용 기록에 보임', log[0].action === 'HEALTH_EXPIRED' && log[0].by === '시스템', log[0]);
  check('1년 지난 상담 내용 삭제', db.prepare('SELECT counsel_note FROM orders WHERE id = ?').get(counselOld).counsel_note === null);
  const rejectedRow = customerRow(rejected.id);
  check('거절 30일 지난 가입 신청은 이름·연락처·생일 파기', rejectedRow.phone === null && rejectedRow.birth_year === null && rejectedRow.name === '가입거절(파기)', rejectedRow);
  check('파기 실행 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'PRIVACY_RETENTION'").get()));
  res = await runRetention();
  check('다시 돌려도 같은 대상은 0건', res.data.result.health === 0 && res.data.result.rejected === 0 && res.data.result.counsel_notes === 0, res.data.result);
}

console.log('[회원 탈퇴 — 본인]');
let leaver;
{
  leaver = await member();
  db.prepare('UPDATE pharmacies SET point_enabled = 1 WHERE id = 1').run();
  db.prepare('UPDATE customers SET point_balance = 1500 WHERE id = ?').run(leaver.id);
  await api('/customers/me/health', { token: leaver.token, method: 'PUT', body: { consent: true, allergy: '땅콩', medications_none: true } });
  const counsel = await api('/orders', {
    token: leaver.token,
    method: 'POST',
    body: { order_type: 'COUNSEL', preferred_at: '2026-12-02T10:00', memo: '수면제 상담', counsel_consent: true }
  });
  const openPickup = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, total_product_amount, final_amount, order_status, payment_status, contact_name, contact_phone)
       VALUES (?, 1, ?, 'PICKUP', 5000, 5000, 'PREPARING', 'PAID', '탈퇴예정', ?)`
    )
    .run(`PV-${process.pid}-${Date.now()}`, leaver.id, leaver.phone).lastInsertRowid;

  let res = await api('/customers/me/withdraw', { token: leaver.token, method: 'POST', body: { pin: TEST_PIN } });
  check('탈퇴 안내 확인 없으면 400', res.status === 400, res.data);
  res = await api('/customers/me/withdraw', { token: leaver.token, method: 'POST', body: { pin: '000001', confirm: true } });
  check('PIN 틀리면 400', res.status === 400, res.data);
  res = await api('/customers/me/withdraw', { token: leaver.token, method: 'POST', body: { pin: TEST_PIN, confirm: true } });
  check('진행 중인 픽업 주문이 있으면 409', res.status === 409 && res.data.message.includes('진행 중인 주문'), res.data);

  db.prepare("UPDATE orders SET order_status = 'PICKED_UP' WHERE id = ?").run(openPickup);
  const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').get(leaver.id).n;
  res = await api('/customers/me/withdraw', { token: leaver.token, method: 'POST', body: { pin: TEST_PIN, confirm: true } });
  check('탈퇴 200', res.status === 200 && res.data.withdrawn === true, res.data);

  const row = customerRow(leaver.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  check('이름·연락처·생일·성별·PIN 파기', row.name === '탈퇴회원' && row.phone === null && row.birth_year === null && row.gender === null && row.pin_hash === null, row);
  check('건강 정보 파기', row.health_info === null && row.health_updated_at === null);
  check('탈퇴 상태·시각', row.approval_status === 'WITHDRAWN' && Boolean(row.withdrawn_at) && row.withdrawal_source === 'APP', row);
  check('로그인 계정도 익명화', user.status === 'WITHDRAWN' && user.phone === null && user.email.endsWith('@erased.local') && user.name === '탈퇴회원', user);
  check('배송지 삭제', !db.prepare('SELECT 1 FROM addresses WHERE user_id = ?').get(row.user_id));
  check('포인트 소멸 기록', row.point_balance === 0 && Boolean(db.prepare("SELECT 1 FROM point_ledger WHERE customer_id = ? AND entry_type = 'ADJUST' AND points = -1500").get(leaver.id)));
  const counselRow = db.prepare('SELECT order_status, counsel_note FROM orders WHERE id = ?').get(counsel.data.order.id);
  check('남은 상담 예약 취소 · 상담 내용 파기', counselRow.order_status === 'CANCELED' && counselRow.counsel_note === null, counselRow);
  check('거래 기록은 보존(법정 보존기간)', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').get(leaver.id).n === ordersBefore);
  const consents = db.prepare("SELECT consent_type FROM customer_consents WHERE customer_id = ? AND agreed = 0 AND source = 'APP'").all(leaver.id).map((r) => r.consent_type);
  check('동의 전부 철회 기록', ['TERMS', 'PRIVACY', 'HEALTH_INFO'].every((t) => consents.includes(t)), consents);
  check('탈퇴 감사 로그', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'CUSTOMER_WITHDRAW' AND target_id = ?").get(leaver.id)));
  check('파기 장부에 회원 번호만 기록', fs.readFileSync(ledgerPath, 'utf8').includes(`"customer_id":${leaver.id}`) && !fs.readFileSync(ledgerPath, 'utf8').includes(leaver.phone));

  res = await api('/customers/me', { token: leaver.token });
  check('탈퇴 뒤 기존 토큰 사용 불가', res.status === 401 || res.status === 403, res.status);
  res = await customerLogin(leaver.phone);
  check('탈퇴 뒤 로그인 불가 401', res.status === 401, res.data);
  res = await api(`/pos/scan?code=${encodeURIComponent(`MAYDIN-MEMBER:${leaver.row.member_code}`)}`, { token: owner });
  check('탈퇴 회원 코드는 POS에서 회원으로 안 잡힘', res.status === 200 && res.data.type === 'UNKNOWN', res.data);
  res = await postSignup({ ...signupBody(db).body, phone: leaver.phone });
  check('같은 번호로 다시 가입 가능', res.status === 201 || res.status === 202, res.data);
}

console.log('[회원 탈퇴 — 약국 대리 처리]');
{
  const target = await member();
  let res = await api(`/customers/${target.id}/withdraw`, { token: owner, method: 'POST', body: { reason: '방문 요청' } });
  check('본인 확인 체크 없으면 400', res.status === 400, res.data);
  res = await api(`/customers/${target.id}/withdraw`, { token: owner, method: 'POST', body: { identity_checked: true } });
  check('요청 경로 없으면 400', res.status === 400, res.data);
  res = await api(`/customers/${target.id}/withdraw`, { token: staff, method: 'POST', body: { identity_checked: true, reason: '방문 요청' } });
  check('직원은 대리 탈퇴 불가 403', res.status === 403, res.data);
  res = await api(`/customers/${target.id}/withdraw`, { token: owner, method: 'POST', body: { identity_checked: true, reason: '방문 요청' } });
  check('약사 대리 탈퇴', res.status === 200 && res.data.customer.withdrawn_at && customerRow(target.id).withdrawal_source === 'PARTNER', res.data);
  res = await api(`/customers/${target.id}/withdraw`, { token: owner, method: 'POST', body: { identity_checked: true, reason: '방문 요청' } });
  check('이미 탈퇴한 회원 409', res.status === 409, res.data);
  res = await api(`/customers/${target.id}/profile`, { token: owner, method: 'PATCH', body: { gender: 'F' } });
  check('탈퇴 회원 정보 수정 불가 409', res.status === 409, res.data);
  res = await api('/dashboard/customers', { token: owner });
  check('회원 목록에서 빠짐', !res.data.customers.some((c) => c.id === target.id));
}

console.log('[백업 복원 뒤 재파기 · 거래 보존기간]');
{
  db.prepare("UPDATE customers SET name = '복원된이름', phone = '01055554444', approval_status = 'APPROVED', withdrawn_at = NULL, personal_purged_at = NULL WHERE id = ?").run(leaver.id);
  let res = await runRetention();
  const row = customerRow(leaver.id);
  check('복원으로 되살아난 탈퇴 회원 정보를 다시 파기', res.data.result.reapplied === 1 && row.name === '탈퇴회원' && row.phone === null && row.approval_status === 'WITHDRAWN', { result: res.data.result, row });

  const oldOrder = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, total_product_amount, final_amount, order_status, payment_status, contact_name, contact_phone, created_at)
       VALUES (?, 1, ?, 'DELIVERY', 7000, 7000, 'DELIVERED', 'PAID', '옛이름', '01011112222', ?)`
    )
    .run(`PO-${process.pid}-${Date.now()}`, leaver.id, ago('-6 years')).lastInsertRowid;
  db.prepare("INSERT INTO deliveries (order_id, receiver_name, receiver_phone, address) VALUES (?, '옛이름', '01011112222', '서울시 어딘가 1')").run(oldOrder);
  res = await runRetention();
  const order = db.prepare('SELECT contact_name, contact_phone, final_amount FROM orders WHERE id = ?').get(oldOrder);
  const delivery = db.prepare('SELECT receiver_name, receiver_phone, address FROM deliveries WHERE order_id = ?').get(oldOrder);
  check('5년 지난 탈퇴 회원 주문의 연락처 파기 · 금액은 남음', order.contact_name === null && order.contact_phone === null && order.final_amount === 7000, order);
  check('배송지도 파기', delivery.receiver_name === '(파기)' && delivery.address === '(파기)' && delivery.receiver_phone === '', delivery);
}

console.log('[예전 상담 메모 이전]');
{
  const legacy = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, total_product_amount, final_amount, order_status, payment_status, memo)
       VALUES (?, 1, ?, 'COUNSEL', 0, 0, 'RESERVED', 'PAID', '예전 평문 메모: 혈압약 복용')`
    )
    .run(`PL-${process.pid}-${Date.now()}`, minimal.id).lastInsertRowid;
  const out = spawnSync(process.execPath, ['scripts/retention.js'], { cwd: serverDir, env: process.env, encoding: 'utf8' });
  check('npm run retention 실행', out.status === 0, out.stderr || out.stdout);
  const row = db.prepare('SELECT memo, counsel_note FROM orders WHERE id = ?').get(legacy);
  check('평문 상담 메모를 암호문으로 옮김', row.memo === null && row.counsel_note.startsWith('v1:') && !row.counsel_note.includes('혈압'), row);
  const res = await api(`/orders/${legacy}/counsel-note`, { token: owner });
  check('옮긴 내용은 약사가 열람 가능', res.data.note === '예전 평문 메모: 혈압약 복용', res.data);
}

done();
