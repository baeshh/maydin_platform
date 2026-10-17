import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const staffEmail = `counter-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '카운터직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');

const as = (token, device) => (path, options = {}) =>
  api(path, { token, ...options, headers: { ...(device ? { 'X-POS-Device': device } : {}), ...(options.headers || {}) } });
const productId = db
  .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type) VALUES (1, '카운터 테스트 상품', 3000, 100, 'ON_SALE', 'GENERAL')")
  .run().lastInsertRowid;
const saleBody = (extra = {}) => ({ items: [{ product_id: productId, quantity: 1 }], payments: [{ method: 'CASH', amount: 3000 }], ...extra });
await as(owner)('/pos/context');
const firstTerminal = db.prepare("SELECT * FROM pos_terminals WHERE pharmacy_id = 1 AND status = 'ACTIVE' ORDER BY id LIMIT 1").get();
const counterName = `테스트 카운터 ${process.pid}`;
let deviceA;
let deviceB;
let terminalA;

try {
  console.log('[등록 전 — 예전처럼 카운터 하나를 함께 씀]');
  {
    const ctx = await as(owner)('/pos/context');
    check('기기 상태 = 등록 전(단일 카운터)', ctx.data.device?.state === 'LEGACY', ctx.data.device);
    check('첫 카운터를 씀', ctx.data.terminal?.id === firstTerminal.id, ctx.data.terminal);
    check('관리자에게 카운터 목록 · 해시는 안 보냄', Array.isArray(ctx.data.terminals) && ctx.data.terminals.every((t) => !('device_key_hash' in t)), ctx.data.terminals);
    check('관리 권한 표시', ctx.data.permissions.can_manage_terminals === true);
    const staffCtx = await as(staff)('/pos/context');
    check('직원에게는 카운터 목록 안 보냄', staffCtx.data.terminals === undefined && staffCtx.data.permissions.can_manage_terminals === false);
    let res = await as(staff)('/pos/terminals/register', { method: 'POST', body: {} });
    check('직원은 PC 등록 불가(403)', res.status === 403, res.data);
    res = await as(staff)('/pos/terminals');
    check('직원은 카운터 목록 불가(403)', res.status === 403, res.data);
  }

  console.log('[PC 등록 — 토큰은 한 번만 내려주고 해시만 저장]');
  {
    const res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_name: counterName, device_label: '입구 PC' } });
    check('새 카운터로 등록 201', res.status === 201 && res.data.terminal?.terminal_name === counterName && !res.data.replaced, res.data);
    deviceA = res.data.device_token;
    terminalA = res.data.terminal;
    check('기기 토큰 형식', /^pdt_[A-Za-z0-9_-]{30,}$/.test(deviceA || ''), deviceA);
    const row = db.prepare('SELECT * FROM pos_terminals WHERE id = ?').get(terminalA.id);
    check('DB에는 토큰 원문 없이 sha256 해시만', row.device_key_hash === createHash('sha256').update(deviceA).digest('hex') && !JSON.stringify(row).includes(deviceA));
    check('응답에 해시 안 보냄', !('device_key_hash' in res.data.terminal) && res.data.terminal.device_registered === true, res.data.terminal);
    const dup = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_name: counterName } });
    check('같은 이름 카운터는 거절(409)', dup.status === 409, dup.data);
    check('등록 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_TERMINAL_REGISTER' AND target_id = ?").get(terminalA.id)));
  }

  console.log('[등록한 뒤 — 등록된 PC만 카운터로 인정]');
  {
    let ctx = await as(owner)('/pos/context');
    check('토큰 없는 PC = 미등록 · 카운터·영업 없음', ctx.data.device.state === 'UNREGISTERED' && ctx.data.terminal === null && ctx.data.session === null, ctx.data.device);
    let res = await as(owner)('/pos/sales', { method: 'POST', body: saleBody() });
    check('미등록 PC 판매 428 TERMINAL_REQUIRED', res.status === 428 && res.data.reason === 'TERMINAL_REQUIRED', res.data);
    res = await as(owner)('/pos/sessions/current');
    check('미등록 PC 영업 조회 428', res.status === 428, res.data);
    res = await as(owner)('/pos/van/terminal');
    check('미등록 PC 단말기 설정 428', res.status === 428, res.data);
    res = await as(owner)('/pos/products?q=카운터');
    check('상품 조회는 됨(카운터와 무관)', res.status === 200, res.status);
    ctx = await as(owner, 'pdt_forged-token-value-000000000000')('/pos/context');
    check('위조 토큰 = 알 수 없는 PC', ctx.data.device.state === 'UNKNOWN' && ctx.data.terminal === null, ctx.data.device);
    res = await as(owner, 'pdt_forged-token-value-000000000000')('/pos/sales', { method: 'POST', body: saleBody() });
    check('위조 토큰 판매 428', res.status === 428, res.data);

    ctx = await as(owner, deviceA)('/pos/context');
    check('등록 PC = 그 카운터', ctx.data.device.state === 'REGISTERED' && ctx.data.terminal?.id === terminalA.id, ctx.data);
    check('새 카운터는 영업 전', ctx.data.session === null, ctx.data.session);
    check('마지막 접속 시각 기록', Boolean(db.prepare('SELECT last_seen_at FROM pos_terminals WHERE id = ?').get(terminalA.id).last_seen_at));
  }

  console.log('[카운터마다 영업 세션·시재 따로]');
  let sessionA;
  let sessionB;
  {
    let res = await as(owner, deviceA)('/pos/sessions/open', { method: 'POST', body: { opening_cash: 10000 } });
    check('A 카운터 영업 시작', res.status === 201 && res.data.session?.terminal_id === terminalA.id, res.data);
    sessionA = res.data.session;
    res = await as(owner, deviceA)('/pos/sessions/open', { method: 'POST', body: { opening_cash: 0 } });
    check('같은 카운터 두 번 시작 409', res.status === 409, res.data);
    let threw = false;
    try {
      db.prepare("INSERT INTO pos_sessions (pharmacy_id, terminal_id, business_date, opening_cash, opened_by, status) VALUES (1, ?, date('now'), 0, 1, 'OPEN')").run(terminalA.id);
    } catch {
      threw = true;
    }
    check('DB도 카운터당 열린 영업 하나만 허용', threw);

    res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: firstTerminal.id, device_label: '안쪽 PC' } });
    check('기존 첫 카운터에 다른 PC 등록', res.status === 201 && res.data.terminal.id === firstTerminal.id, res.data);
    deviceB = res.data.device_token;
    res = await as(owner, deviceB)('/pos/sessions/current');
    sessionB = res.data.session;
    if (!sessionB) sessionB = (await as(owner, deviceB)('/pos/sessions/open', { method: 'POST', body: { opening_cash: 0 } })).data.session;
    check('B 카운터는 자기 영업', sessionB && sessionB.id !== sessionA.id && sessionB.terminal_id === firstTerminal.id, sessionB);

    const saleA = await as(staff, deviceA)('/pos/sales', { method: 'POST', body: saleBody() });
    const saleB = await as(owner, deviceB)('/pos/sales', { method: 'POST', body: saleBody() });
    check('직원도 등록 PC에서 판매', saleA.status === 201, saleA.data);
    const rowA = db.prepare('SELECT pos_terminal_id, pos_session_id FROM orders WHERE id = ?').get(saleA.data.order.id);
    const rowB = db.prepare('SELECT pos_terminal_id, pos_session_id FROM orders WHERE id = ?').get(saleB.data.order.id);
    check('판매는 요청한 PC의 카운터·영업에 기록', rowA.pos_terminal_id === terminalA.id && rowA.pos_session_id === sessionA.id && rowB.pos_terminal_id === firstTerminal.id && rowB.pos_session_id === sessionB.id, { rowA, rowB });
    const summaryA = (await as(owner, deviceA)('/pos/sessions/current')).data.session;
    check('A 시재 = 시작 10,000 + A 현금 3,000', summaryA.summary?.expected_cash === 13000, summaryA.summary);
  }

  console.log('[PC 교체·해제]');
  {
    let res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: terminalA.id } });
    check('이미 PC가 있는 카운터는 교체 확인 필요(409)', res.status === 409 && res.data.reason === 'DEVICE_ALREADY_REGISTERED', res.data);
    // 교체 전에 기존 PC가 보관 거래가 없다고 보고한다(PC 교체 절차).
    res = await as(owner, deviceA)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'phase14-pc-a-000001', storage: 'indexeddb', entries: [] } });
    check('기존 PC 보관 거래 보고', res.status === 200, res.data);
    res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: terminalA.id, replace: true, device_label: '새 PC' } });
    check('교체 등록', res.status === 201 && res.data.replaced === true, res.data);
    const oldA = deviceA;
    deviceA = res.data.device_token;
    res = await as(owner, oldA)('/pos/sales', { method: 'POST', body: saleBody() });
    check('교체된 옛 PC는 판매 불가(428)', res.status === 428, res.data);
    res = await as(owner, deviceA)('/pos/sessions/current');
    check('새 PC가 같은 영업을 이어받음', res.data.session?.id === sessionA.id, res.data.session);
    check('교체 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_TERMINAL_DEVICE_REPLACE' AND target_id = ?").get(terminalA.id)));
  }

  console.log('[VAN 승인은 받은 카운터에서만 사용·취소]');
  {
    let res = await as(owner, deviceA)('/pos/van/terminal', { method: 'PATCH', body: { van_mode: 'DEMO' } });
    check('A 카운터 데모 승인 켜기', res.status === 200 && res.data.van.mode === 'DEMO', res.data);
    res = await as(owner, deviceB)('/pos/van/terminal');
    check('B 카운터 설정은 그대로', res.status === 200 && res.data.terminal.id === firstTerminal.id, res.data.terminal);
    const clientSaleId = randomUUID();
    res = await as(owner, deviceA)('/pos/sales/prepare', { method: 'POST', body: saleBody({ client_sale_id: clientSaleId }) });
    check('A 카운터 결제 준비', res.status === 201 && res.data.draft?.terminal_id === terminalA.id, res.data);
    const draftId = res.data.draft?.id;
    const approval = await as(owner, deviceA)('/pos/payments/approve', {
      method: 'POST',
      body: { client_sale_id: clientSaleId, request_id: randomUUID(), method: 'CARD', amount: 3000 }
    });
    check('A 단말기 승인(데모)', approval.status === 201 && approval.data.van_transaction?.status === 'APPROVED', approval.data);
    const txId = approval.data.van_transaction?.id;
    res = await as(owner, deviceB)('/pos/payments/approve', {
      method: 'POST',
      body: { client_sale_id: clientSaleId, request_id: randomUUID(), method: 'CARD', amount: 3000 }
    });
    check('B 카운터에서 A 판매에 승인 불가(403)', res.status === 403, res.data);
    res = await as(owner, deviceB)('/pos/sales/confirm', {
      method: 'POST',
      body: { client_sale_id: clientSaleId, payments: [{ method: 'CARD', amount: 3000, van_transaction_id: txId }] }
    });
    check('B 카운터에서 A 판매 확정 불가(403)', res.status === 403, res.data);
    res = await as(owner, deviceB)('/pos/sales', { method: 'POST', body: saleBody({ payments: [{ method: 'CARD', amount: 3000, van_transaction_id: txId }] }) });
    check('B 카운터에서 A 승인 사용 불가(409)', res.status === 409, res.data);
    res = await as(owner, deviceB)(`/pos/van/transactions/${txId}/void`, { method: 'POST' });
    check('B 카운터에서 A 승인 취소 불가(403)', res.status === 403, res.data);
    res = await as(owner, deviceA)(`/pos/van/transactions/${txId}/void`, { method: 'POST' });
    check('A 카운터에서 취소', res.status === 200 && res.data.van_transaction.status === 'VOIDED', res.data);
    res = await as(owner, deviceA)(`/pos/sales/drafts/${clientSaleId}/cancel`, { method: 'POST' });
    check('승인 취소 뒤 판매 준비 취소', res.status === 200 && res.data.draft?.id === draftId && res.data.draft.status === 'CANCELED', res.data);
    res = await as(owner, deviceA)('/pos/van/terminal');
    check('VAN 기록은 그 카운터 것만', res.data.transactions.every((t) => t.terminal_id === terminalA.id), res.data.transactions);
  }

  console.log('[일마감·사용 중지]');
  {
    let res = await as(owner, deviceA)(`/pos/terminals/${terminalA.id}`, { method: 'PATCH', body: { status: 'INACTIVE' } });
    check('영업 중 카운터는 사용 중지 불가(409)', res.status === 409, res.data);
    res = await as(owner, deviceB)(`/pos/sessions/${sessionA.id}/close`, { method: 'POST', body: { actual_cash: 13000 } });
    check('다른 카운터 PC에서 마감 불가(403)', res.status === 403, res.data);
    res = await as(staff, deviceA)(`/pos/sessions/${sessionA.id}/close`, { method: 'POST', body: { actual_cash: 13000 } });
    check('직원은 마감 불가(403)', res.status === 403, res.data);
    res = await as(owner, deviceA)(`/pos/sessions/${sessionA.id}/close`, { method: 'POST', body: { actual_cash: 13000 } });
    check('그 카운터 PC에서 마감', res.status === 200, res.data);
    res = await as(owner, deviceA)(`/pos/terminals/${terminalA.id}`, { method: 'PATCH', body: { status: 'INACTIVE' } });
    check('마감 뒤 사용 중지', res.status === 200, res.data);
    const ctx = await as(owner, deviceA)('/pos/context');
    check('사용 중지 카운터 PC = DISABLED', ctx.data.device.state === 'DISABLED' && ctx.data.terminal === null, ctx.data.device);
    res = await as(owner, deviceA)('/pos/sessions/open', { method: 'POST', body: { opening_cash: 0 } });
    check('사용 중지 카운터 영업 시작 불가(428)', res.status === 428, res.data);
    res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: terminalA.id, replace: true } });
    check('사용 중지 카운터에 PC 등록 불가(409)', res.status === 409, res.data);
    res = await as(owner)(`/pos/terminals/${terminalA.id}`, { method: 'PATCH', body: { status: 'BROKEN' } });
    check('없는 상태 거절', res.status === 400, res.data);

    res = await as(owner, deviceB)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'phase14-pc-b-000001', storage: 'indexeddb', entries: [] } });
    check('B PC 보관 거래 보고', res.status === 200, res.data);
    res = await as(owner)(`/pos/terminals/${firstTerminal.id}/revoke-device`, { method: 'POST' });
    check('B PC 해제', res.status === 200, res.data);
    res = await as(owner, deviceB)('/pos/sales', { method: 'POST', body: saleBody() });
    check('해제된 PC 판매 불가(428)', res.status === 428, res.data);
    check('해제 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_TERMINAL_REVOKE' AND target_id = ?").get(firstTerminal.id)));
    const list = (await as(owner)('/pos/terminals')).data.terminals;
    const listed = list.find((t) => t.id === terminalA.id);
    check('카운터 목록에 상태·PC 표시', listed?.status === 'INACTIVE' && listed.device_registered === true && listed.device_label === '새 PC', listed);
  }
} finally {
  // 다른 테스트 파일은 카운터 등록 전(단일 카운터) 상태를 전제로 한다.
  db.prepare('UPDATE pos_terminals SET device_key_hash = NULL WHERE pharmacy_id = 1').run();
  db.prepare("UPDATE pos_terminals SET status = 'ACTIVE' WHERE id = ?").run(firstTerminal.id);
  if (terminalA) {
    db.prepare("UPDATE pos_sessions SET status = 'CLOSED' WHERE terminal_id = ? AND status = 'OPEN'").run(terminalA.id);
    db.prepare("UPDATE pos_terminals SET status = 'INACTIVE' WHERE id = ?").run(terminalA.id);
  }
}

console.log('[모두 해제하면 다시 단일 카운터]');
{
  const ctx = await as(owner)('/pos/context');
  check('다시 등록 전 상태 · 첫 카운터', ctx.data.device.state === 'LEGACY' && ctx.data.terminal?.id === firstTerminal.id, ctx.data.device);
}

done();
