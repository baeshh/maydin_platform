import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

// 화면이 쓰는 잠금 코드를 그대로 불러와 Node WebCrypto로 잠근다.
const OfflineSeal = new Function(`${readFileSync(new URL('../public/pos/offline-seal.js', import.meta.url), 'utf8')}\n;return OfflineSeal;`)();

const admin = await login('admin@maydin.kr', 'admin1234');
const code = `OF${String(Date.now()).slice(-6)}`;
const ownerEmail = `${code.toLowerCase()}@offline.kr`;
await api('/admin/pharmacies', {
  token: admin,
  method: 'POST',
  body: { pharmacy_code: code, pharmacy_name: '보관약국', owner_name: '오약사', store_slug: `off-${code.toLowerCase()}`, owner_email: ownerEmail, owner_password: 'offlineOwner2026' }
});
const owner = await login(ownerEmail, 'offlineOwner2026');
const pharmacyId = db.prepare('SELECT id FROM pharmacies WHERE pharmacy_code = ?').get(code).id;
const staffEmail = `offline-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '보관직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');

const as = (token, device) => (path, options = {}) =>
  api(path, { token, ...options, headers: { ...(device ? { 'X-POS-Device': device } : {}), ...(options.headers || {}) } });
const product = (name, stock) =>
  Number(
    db
      .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type) VALUES (?, ?, 5000, ?, 'ON_SALE', 'GENERAL')")
      .run(pharmacyId, name, stock).lastInsertRowid
  );
const stockOf = (id) => db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id).stock_quantity;
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const tempNo = (id) => id.slice(0, 8);

const itemA = product('보관 테스트 A', 10);
const itemB = product('보관 테스트 B', 10);

let ctx = (await as(owner)('/pos/context')).data;
const counter1 = ctx.terminal;
await as(owner)('/pos/sessions/open', { method: 'POST', body: { opening_cash: 0 } });

// 화면 queueSale과 같은 모양으로 잠근다.
async function sealedSale(key, { id = randomUUID(), item = itemA, quantity = 1, occurred = minutesAgo(10), pharmacy = pharmacyId } = {}) {
  const amount = 5000 * quantity;
  const body = {
    customer_id: null,
    items: [{ product_id: item, quantity, price: 5000 }],
    discount_amount: 0,
    discount_reason: '',
    payments: [{ method: 'CASH', amount, received_amount: amount }]
  };
  const sealed = await OfflineSeal.seal(key, pharmacy, id, { v: 1, pharmacy_id: pharmacy, terminal_id: null, client_sale_id: id, occurred_at: occurred, cashier: '보관직원', body, first_body: null });
  return { id, sealed, occurred, amount };
}
const entryOf = (sale, status = 'PENDING') => ({ id: sale.id, occurred_at: sale.occurred, amount: sale.amount, status, sealed: true });

console.log('[카운터 잠금 키 — 공개키만 기기로]');
const key = ctx.offline_key;
{
  check('context에 공개키·키 번호', key?.key_id && key.public_key && key.alg === 'RSA-OAEP-256/A256GCM' && key.format === 'maydin-offline/1', key);
  const row = db.prepare('SELECT seal_key_id, seal_private_key_enc FROM pos_terminals WHERE id = ?').get(counter1.id);
  check('개인키는 DB에 암호문으로만', row.seal_key_id === key.key_id && row.seal_private_key_enc.startsWith('v1:') && !row.seal_private_key_enc.includes('PRIVATE KEY'));
  const again = (await as(owner)('/pos/context')).data.offline_key;
  check('다시 열어도 같은 키', again.key_id === key.key_id && again.public_key === key.public_key);
  const terminals = await as(owner)('/pos/terminals');
  const text = JSON.stringify([ctx, terminals.data]);
  check('응답 어디에도 개인키·암호문 없음', !text.includes('seal_private_key_enc') && !text.includes('PRIVATE KEY') && !text.includes(row.seal_private_key_enc.slice(0, 20)));
  check('키를 암호화 칸 점검 목록에 등록', readFileSync(new URL('../src/services/secure.js', import.meta.url), 'utf8').includes("['pos_terminals', 'seal_private_key_enc']"));
}

const outage1 = (await as(owner)('/pos/outages', { method: 'POST', body: { kind: 'NETWORK', started_at: minutesAgo(30), ended_at: new Date().toISOString(), note: '보관 시험' } })).data.outage;

console.log('[잠긴 거래 전송 — 서버만 풂 · 한 번만 저장]');
let s1;
{
  s1 = await sealedSale(key, { quantity: 2 });
  const stored = JSON.stringify(s1.sealed);
  check('잠긴 내용에 상품·금액·결제 평문 없음', !stored.includes('product_id') && !stored.includes('payments') && !stored.includes('received_amount'), stored.slice(0, 120));
  let res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s1.id, sealed: s1.sealed, outage_id: outage1.id } });
  check('잠긴 거래 저장 201', res.status === 201 && res.data.order?.final_amount === 10000, res.data);
  const order = db.prepare('SELECT * FROM orders WHERE client_sale_id = ?').get(s1.id);
  check('장애 중 판매로 장애에 묶임 · 실제 판매 시각', order.recovery_source === 'OFFLINE_QUEUE' && order.outage_id === outage1.id && order.created_at === s1.occurred.slice(0, 19).replace('T', ' '), order);
  check('재고 차감 10 → 8', stockOf(itemA) === 8);
  res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s1.id, sealed: s1.sealed, outage_id: outage1.id } });
  check('다시 보내면 200 · 한 번만', res.status === 200 && res.data.duplicate === true && db.prepare('SELECT COUNT(*) AS n FROM orders WHERE client_sale_id = ?').get(s1.id).n === 1, res.data);
  check('재고 그대로 8', stockOf(itemA) === 8);
}

console.log('[변조·바꿔치기·다른 약국 키 거절]');
{
  const s = await sealedSale(key);
  const bytes = Buffer.from(s.sealed.ciphertext, 'base64');
  bytes[5] ^= 0xff;
  let res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s.id, sealed: { ...s.sealed, ciphertext: bytes.toString('base64') }, outage_id: outage1.id } });
  check('내용 1바이트 변조 → 400 SEALED_INVALID', res.status === 400 && res.data.reason === 'SEALED_INVALID', res.data);
  res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: randomUUID(), sealed: s.sealed, outage_id: outage1.id } });
  check('다른 거래 번호로 바꿔 보내기 → 400', res.status === 400 && res.data.reason === 'SEALED_INVALID', res.data);
  res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s.id, sealed: { ...s.sealed, wrapped_key: Buffer.alloc(256, 1).toString('base64') }, outage_id: outage1.id } });
  check('감싼 키 변조 → 400', res.status === 400, res.data);
  const otherOwner = await login('owner@apharmacy.kr', 'owner1234');
  const otherKey = (await as(otherOwner)('/pos/context')).data.offline_key;
  const foreign = await sealedSale(otherKey);
  res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: foreign.id, sealed: foreign.sealed, outage_id: outage1.id } });
  check('다른 약국 카운터 키로 잠근 거래 → 400', res.status === 400 && res.data.reason === 'SEALED_INVALID', res.data);
  const spoof = await sealedSale(key, { pharmacy: pharmacyId + 100000 });
  res = await as(owner)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: spoof.id, sealed: spoof.sealed, outage_id: outage1.id } });
  check('다른 약국 번호로 묶은 거래 → 400', res.status === 400, res.data);
  check('거절한 거래는 저장 안 됨', !db.prepare('SELECT 1 FROM orders WHERE client_sale_id IN (?, ?, ?)').get(s.id, foreign.id, spoof.id));
}

console.log('[PC별 미전송 보고 — 서버에 있는 거래는 기기에서 지우라고 알려 줌]');
let pc1;
let s2;
{
  const reg = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: counter1.id, device_label: '계산대 PC 1' } });
  check('PC 1 등록', reg.status === 201, reg.data);
  pc1 = reg.data.device_token;
  s2 = await sealedSale(key, { item: itemB, quantity: 3 });
  let res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [entryOf(s1), entryOf(s2)] } });
  check('보고 200 · 이미 저장된 s1은 지우라고 알려 줌', res.status === 200 && res.data.saved_ids.length === 1 && res.data.saved_ids[0] === s1.id, res.data);
  const row = db.prepare('SELECT * FROM pos_device_queues WHERE pharmacy_id = ? AND install_id = ?').get(pharmacyId, 'pc1-install-000000001');
  check('서버에는 번호·시각·금액·상태만 (상품·결제 없음)', row && !row.entries_json.includes('items') && !row.entries_json.includes('CASH') && row.pending_count === 2, row);
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [entryOf(s2)] } });
  const status = await as(owner, pc1)('/pos/offline-queue/status');
  const c1 = status.data.terminals.find((t) => t.terminal_id === counter1.id);
  check('카운터별 미전송 1건', c1?.unsent_count === 1 && !c1.unreported, c1);
  const device = status.data.devices.find((d) => d.install === 'PC1-INST');
  check('PC별 남은 거래에 임시번호·상태', device?.entries?.[0]?.temp_number === tempNo(s2.id).toUpperCase() && device.entries[0].state === 'MISSING', device);
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'bad', entries: [] } });
  check('설치 번호 형식 검사', res.status === 400, res.data);
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', entries: [{ id: 'bad id!', amount: 1 }] } });
  check('거래 번호 형식 검사', res.status === 400, res.data);
  res = await as(staff, pc1)('/pos/offline-queue/status');
  check('직원은 전체 현황 불가(403)', res.status === 403, res.data);
}

console.log('[마감·재고 대사 — 미전송 거래가 남으면 막음]');
{
  const session = (await as(owner, pc1)('/pos/sessions/current')).data.session;
  let res = await as(owner, pc1)(`/pos/sessions/${session.id}/close`, { method: 'POST', body: { actual_cash: session.summary.expected_cash } });
  check('마감 409 OFFLINE_QUEUE_PENDING', res.status === 409 && res.data.reason === 'OFFLINE_QUEUE_PENDING' && res.data.devices?.length === 1, res.data);
  res = await as(owner, pc1)(`/pos/outages/${outage1.id}`);
  check('장애 상세에 미전송 PC 표시', res.data.device_check?.pending?.length === 1, res.data.device_check);
  res = await as(owner, pc1)(`/pos/outages/${outage1.id}/reconcile`, { method: 'POST', body: { counts: [] } });
  check('재고 대사 409 OFFLINE_QUEUE_PENDING', res.status === 409 && res.data.reason === 'OFFLINE_QUEUE_PENDING', res.data);

  res = await as(owner, pc1)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s2.id, sealed: s2.sealed, outage_id: outage1.id } });
  check('s2 전송', res.status === 201, res.data);
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [entryOf(s2)] } });
  check('전송 후 보고 → 지우라고 알려 줌', res.data.saved_ids?.[0] === s2.id, res.data);
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [] } });
  const c1 = (await as(owner, pc1)('/pos/offline-queue/status')).data.terminals.find((t) => t.terminal_id === counter1.id);
  check('지운 뒤 미전송 0', c1.unsent_count === 0, c1);
}

console.log('[보고 없는 PC — 관리자가 확인해야 대사]');
let pc2;
{
  const reg = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_name: '카운터 2', device_label: '안쪽 PC' } });
  pc2 = reg.data.device_token;
  const res = await as(owner, pc1)(`/pos/outages/${outage1.id}`);
  const unreported = res.data.device_check?.unconfirmed?.find((u) => u.kind === 'UNREPORTED');
  check('보고한 적 없는 등록 PC는 확인 필요', unreported?.terminal_name === '카운터 2', res.data.device_check);
}

console.log('[PC 교체 — 기존 PC의 미전송 거래 확인]');
let pc3;
let s3;
{
  s3 = await sealedSale(key, { item: itemA, quantity: 1 });
  await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [entryOf(s3)] } });
  let res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: counter1.id, replace: true, device_label: '새 PC' } });
  check('미전송 남은 PC 교체 → 409 DEVICE_QUEUE_UNCONFIRMED', res.status === 409 && res.data.reason === 'DEVICE_QUEUE_UNCONFIRMED' && res.data.device_check?.state === 'PENDING', res.data);
  res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: counter1.id, replace: true, acknowledge_unsent: true } });
  check('확인만 하고 사유 없으면 400', res.status === 400, res.data);
  check('교체 안 됨', (await as(owner, pc1)('/pos/context')).data.device.state === 'REGISTERED');
  res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: counter1.id, replace: true, device_label: '새 PC', acknowledge_unsent: true, note: '기존 PC 전원 불량' } });
  check('사유 적고 교체 201', res.status === 201 && res.data.replaced === true && res.data.device_check?.state === 'PENDING', res.data);
  pc3 = res.data.device_token;
  const log = db.prepare("SELECT description AS detail FROM admin_logs WHERE action = 'POS_TERMINAL_DEVICE_REPLACE' AND target_id = ? ORDER BY id DESC LIMIT 1").get(counter1.id);
  check('감사 기록에 미전송·사유', /미전송 1건/.test(log?.detail || '') && /기존 PC 전원 불량/.test(log.detail), log);
  check('옛 PC는 UNKNOWN', (await as(owner, pc1)('/pos/context')).data.device.state === 'UNKNOWN');
  res = await as(owner, pc1)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc1-install-000000001', storage: 'indexeddb', entries: [entryOf(s3)] } });
  check('옛 PC가 다시 보고해도 교체 기록으로 남음', res.status === 200 && res.data.retired === true, res.data);
  const status = (await as(owner, pc3)('/pos/offline-queue/status')).data;
  const old = status.devices.find((d) => d.install === 'PC1-INST');
  check('유실 목록: 교체한 PC의 s3 = 서버에 없음', old?.retired_at && old.entries.length === 1 && old.entries[0].state === 'MISSING' && old.missing_count === 1, old);
  check('새 카운터 현황에는 미전송 없음', status.terminals.find((t) => t.terminal_id === counter1.id).unsent_count === 0);
  res = await as(owner, pc3)(`/pos/outages/${outage1.id}`);
  check('장애 대사 확인 목록에 유실 거래', res.data.device_check.unconfirmed.some((u) => u.kind === 'LOST' && u.missing_count === 1), res.data.device_check);
  res = await as(owner, pc3)(`/pos/offline-queue/devices/${old.id}/resolve`, { method: 'POST', body: {} });
  check('서버에 없는 거래가 있으면 사유 없이 확인 완료 불가', res.status === 400, res.data);

  // 옛 PC에서 내보낸 파일을 새 PC에서 가져와 보낸다(잠긴 그대로 보냄).
  res = await as(owner, pc3)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s3.id, sealed: s3.sealed, outage_id: outage1.id } });
  check('가져온 잠긴 거래를 새 PC에서 전송 201', res.status === 201, res.data);
  const after = (await as(owner, pc3)('/pos/offline-queue/status')).data.devices.find((d) => d.install === 'PC1-INST');
  check('유실 목록에서 s3 = 서버에 저장됨', after.entries[0].state === 'SAVED' && after.entries[0].order_number && after.missing_count === 0, after);
  res = await as(owner, pc3)(`/pos/offline-queue/devices/${old.id}/resolve`, { method: 'POST', body: {} });
  check('모두 들어오면 확인 완료', res.status === 200 && !res.data.devices.some((d) => d.id === old.id), res.data);
  check('확인 완료 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_DEVICE_QUEUE_RESOLVE' AND description LIKE '%PC1-INST%'").get()));
}

console.log('[PC 고장으로 유실 → 임시번호로 수기 복구 · 두 번 기록 막기]');
let s4;
{
  s4 = await sealedSale(key, { item: itemB, quantity: 1 });
  const s5 = await sealedSale(key, { item: itemB, quantity: 1 });
  await as(owner, pc3)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc3-install-000000001', storage: 'indexeddb', entries: [entryOf(s4), entryOf(s5)] } });
  let res = await as(owner)('/pos/terminals/register', { method: 'POST', body: { terminal_id: counter1.id, replace: true, acknowledge_unsent: true, note: 'SSD 고장' } });
  check('고장 PC 교체', res.status === 201, res.data);
  const pc4 = res.data.device_token;
  const lost = (await as(owner, pc4)('/pos/offline-queue/status')).data.devices.find((d) => d.install === 'PC3-INST');
  check('유실 목록 2건 · 서버에 없음', lost?.missing_count === 2, lost);

  const manualBody = (ref, extra = {}) => ({
    client_sale_id: randomUUID(),
    items: [{ product_id: itemB, quantity: 1, price: 5000 }],
    payments: [{ method: 'CASH', amount: 5000 }],
    recovery: { source: 'MANUAL', occurred_at: s4.occurred, outage_id: outage1.id, note: '종이 장부', ref },
    ...extra
  });
  res = await as(owner, pc4)('/pos/sales', { method: 'POST', body: manualBody(tempNo(s4.id).toUpperCase()) });
  check('임시번호 넣어 수기 복구 201', res.status === 201, res.data);
  check('주문에 임시번호 기록', db.prepare('SELECT recovery_ref FROM orders WHERE id = ?').get(res.data.order.id).recovery_ref === tempNo(s4.id));
  res = await as(staff, pc4)('/pos/sales', { method: 'POST', body: manualBody(tempNo(s5.id)) });
  check('직원은 수기 복구 불가(403)', res.status === 403, res.data);
  res = await as(owner, pc4)('/pos/sales', { method: 'POST', body: manualBody(tempNo(s4.id)) });
  check('같은 임시번호 두 번 → 409 ALREADY_RECOVERED', res.status === 409 && res.data.reason === 'ALREADY_RECOVERED', res.data);
  res = await as(owner, pc4)('/pos/sales', { method: 'POST', body: manualBody(tempNo(s1.id)) });
  check('이미 전송된 거래의 임시번호 → 409 ALREADY_SAVED', res.status === 409 && res.data.reason === 'ALREADY_SAVED', res.data);
  res = await as(owner, pc4)('/pos/sales', { method: 'POST', body: manualBody('xyz') });
  check('임시번호 형식 검사 400', res.status === 400, res.data);
  res = await as(owner, pc4)('/pos/offline-sales', { method: 'POST', body: { client_sale_id: s4.id, sealed: s4.sealed, outage_id: outage1.id } });
  check('고친 PC에서 늦게 들어온 s4 → 409 RECOVERED_MANUALLY', res.status === 409 && res.data.reason === 'RECOVERED_MANUALLY', res.data);
  check('s4는 수기 복구 1건만', db.prepare("SELECT COUNT(*) AS n FROM orders WHERE pharmacy_id = ? AND (client_sale_id = ? OR recovery_ref = ?)").get(pharmacyId, s4.id, tempNo(s4.id)).n === 1);

  const after = (await as(owner, pc4)('/pos/offline-queue/status')).data.devices.find((d) => d.install === 'PC3-INST');
  const states = Object.fromEntries(after.entries.map((e) => [e.temp_number, e.state]));
  check('유실 목록: s4 = 수기 복구, s5 = 서버에 없음', states[tempNo(s4.id).toUpperCase()] === 'MANUAL' && states[tempNo(s5.id).toUpperCase()] === 'MISSING', states);
  res = await as(owner, pc4)(`/pos/offline-queue/devices/${after.id}/resolve`, { method: 'POST', body: { note: 's5 실제 판매 없음 · 장부 대조' } });
  check('남은 1건은 사유 적고 확인 완료', res.status === 200, res.data);
  const log = db.prepare("SELECT description AS detail FROM admin_logs WHERE action = 'POS_DEVICE_QUEUE_RESOLVE' AND description LIKE '%PC3-INST%'").get();
  check('감사 기록에 서버에 없음 1건·사유', /서버에 없음 1건/.test(log?.detail || '') && /장부 대조/.test(log.detail), log);

  console.log('[재고 대사 — 확인 못 한 PC는 관리자가 직접 확인]');
  res = await as(owner, pc4)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc4-install-000000001', storage: 'indexeddb', entries: [] } });
  const detail = (await as(owner, pc4)(`/pos/outages/${outage1.id}`)).data;
  check('미전송 없음 · 카운터 2만 확인 필요', detail.device_check.pending.length === 0 && detail.device_check.unconfirmed.length === 1 && detail.device_check.unconfirmed[0].kind === 'UNREPORTED', detail.device_check);
  check('복구 거래에 임시번호', detail.sales.some((s) => s.recovery_ref === tempNo(s4.id)) && detail.sales.some((s) => s.temp_number === tempNo(s1.id).toUpperCase()), detail.sales);
  const counts = detail.products.map((p) => ({ product_id: p.product_id, counted_quantity: p.product_id === itemA ? 6 : 5 }));
  res = await as(owner, pc4)(`/pos/outages/${outage1.id}/reconcile`, { method: 'POST', body: { counts } });
  check('확인 없이 대사 → 409 DEVICES_UNCONFIRMED', res.status === 409 && res.data.reason === 'DEVICES_UNCONFIRMED', res.data);
  res = await as(owner, pc4)(`/pos/outages/${outage1.id}/reconcile`, { method: 'POST', body: { counts, confirm_devices: true, note: '매대 실사' } });
  check('직접 확인 표시하고 대사 완료', res.status === 200 && res.data.outage.status === 'RECONCILED', res.data);
  // 장애 중 판매: A 2+1개(10 → 7), B 3+1개(10 → 6). 센 수량 A 6, B 5로 맞춘다.
  check('재고를 센 수량으로 맞춤 (A 7→6, B 6→5)', stockOf(itemA) === 6 && stockOf(itemB) === 5, { a: stockOf(itemA), b: stockOf(itemB), adjusted: res.data.adjusted });
  const audit = db.prepare("SELECT description AS detail FROM admin_logs WHERE action = 'POS_OUTAGE_RECONCILE' AND target_id = ? ORDER BY id DESC LIMIT 1").get(outage1.id);
  check('대사 감사 기록에 직접 확인한 PC', /직접 확인한 PC: 카운터 2/.test(audit?.detail || ''), audit);

  console.log('[마감 — 미전송 없으면 진행]');
  const session = (await as(owner, pc4)('/pos/sessions/current')).data.session;
  res = await as(owner, pc4)(`/pos/sessions/${session.id}/close`, { method: 'POST', body: { actual_cash: session.summary.expected_cash } });
  check('미전송 없음 → 마감 200', res.status === 200, res.data);
}

console.log('[PC 해제도 같은 확인]');
{
  let res = await as(owner)(`/pos/terminals/${(await as(owner, pc2)('/pos/context')).data.terminal.id}/revoke-device`, { method: 'POST' });
  check('보고 없는 PC 해제 → 409', res.status === 409 && res.data.device_check?.state === 'UNREPORTED', res.data);
  await as(owner, pc2)('/pos/offline-queue/report', { method: 'POST', body: { install_id: 'pc2-install-000000001', storage: 'indexeddb', entries: [] } });
  const terminalId = (await as(owner, pc2)('/pos/context')).data.terminal.id;
  res = await as(owner)(`/pos/terminals/${terminalId}/revoke-device`, { method: 'POST' });
  check('남은 거래 없다고 보고한 PC는 바로 해제', res.status === 200, res.data);
}

done();
