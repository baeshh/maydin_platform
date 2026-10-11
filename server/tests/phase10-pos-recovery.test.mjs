import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const owner = await login('owner@apharmacy.kr', 'owner1234');
const admin = await login('admin@maydin.kr', 'admin1234');
const staffEmail = `recovery-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '복구직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');
const session = (await api('/pos/sessions/current', { token: owner })).data.session;
if (!session) await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } });

let seq = 0;
async function product(body = {}) {
  seq += 1;
  const res = await api('/products', {
    token: owner,
    method: 'POST',
    body: { product_name: `복구 테스트 ${process.pid}-${seq}`, price: 10000, stock_quantity: 0, product_type: 'GENERAL', ...body }
  });
  return res.data.product;
}
const fill = (id, stock) => db.prepare("UPDATE products SET stock_quantity = ?, status = 'ON_SALE' WHERE id = ?").run(stock, id);
const productRow = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const orderRow = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const dbTime = (iso) => iso.slice(0, 19).replace('T', ' ');
const sale = (token, body) => api('/pos/sales', { token, method: 'POST', body });

console.log('[장애 감지 — 상태 확인은 DB까지 확인]');
{
  const res = await api('/health');
  check('상태 확인 200 · DB 정상', res.status === 200 && res.data.db === 'ok', res.data);
}

console.log('[판매 재시도 — 같은 거래 고유번호는 한 번만 저장]');
{
  const item = await product();
  fill(item.id, 5);
  const id = randomUUID();
  const body = { client_sale_id: id, items: [{ product_id: item.id, quantity: 2 }], payments: [{ method: 'CASH', amount: 20000 }] };
  const first = await sale(owner, body);
  check('첫 요청 저장 201', first.status === 201 && !first.data.duplicate, first.data);
  const again = await sale(owner, body);
  check('같은 요청 재시도는 200 · duplicate 표시 · 같은 주문', again.status === 200 && again.data.duplicate === true && again.data.order.id === first.data.order.id, again.data);
  check('주문은 1건만', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE client_sale_id = ?').get(id).n === 1);
  check('재고는 한 번만 차감 (5 → 3)', productRow(item.id).stock_quantity === 3, productRow(item.id));

  const changed = await sale(owner, { ...body, items: [{ product_id: item.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 10000 }] });
  check('같은 번호에 다른 내용은 409', changed.status === 409, changed.data);
  check('다른 내용 거부 후에도 재고 그대로', productRow(item.id).stock_quantity === 3);

  const bad = await sale(owner, { ...body, client_sale_id: 'bad id!' });
  check('잘못된 거래 고유번호 형식 400', bad.status === 400, bad.data);

  const plain = await sale(owner, { items: [{ product_id: item.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 10000 }] });
  check('고유번호 없는 일반 판매는 그대로 동작', plain.status === 201, plain.data);
}

console.log('[장애 기록 — 복구 거래는 장애에 묶임]');
let outage;
let shortageProduct;
let queuedId;
{
  shortageProduct = await product();
  fill(shortageProduct.id, 2);
  const occurred = minutesAgo(20);
  queuedId = randomUUID();
  const recoveryBody = (extra = {}) => ({
    client_sale_id: queuedId,
    items: [{ product_id: shortageProduct.id, quantity: 3, price: 9000 }],
    payments: [{ method: 'CARD', amount: 27000, approval_number: '30012345', card_company: '신한' }],
    recovery: { source: 'OFFLINE_QUEUE', occurred_at: occurred },
    ...extra
  });

  let res = await sale(staff, recoveryBody());
  check('장애 기록 없이 복구 거래 400', res.status === 400 && /장애/.test(res.data.message), res.data);
  res = await sale(staff, recoveryBody({ recovery: { source: 'OFFLINE_QUEUE', occurred_at: occurred, outage_id: 999999 } }));
  check('없는 장애 404', res.status === 404, res.data);

  res = await api('/pos/outages', { token: staff, method: 'POST', body: { kind: 'NETWORK', started_at: minutesAgo(30), note: '통신사 회선 장애' } });
  check('직원도 장애 등록 201', res.status === 201 && res.data.outage.status === 'RECOVERING', res.data);
  outage = res.data.outage;
  const recovery = { source: 'OFFLINE_QUEUE', occurred_at: occurred, outage_id: outage.id };

  res = await api('/pos/outages', { token: staff, method: 'POST', body: { kind: 'NETWORK', started_at: minutesAgo(60 * 24 * 10) } });
  check('7일보다 오래된 장애는 등록 불가', res.status === 400, res.data);

  res = await sale(staff, { ...recoveryBody({ recovery }), client_sale_id: undefined });
  check('복구 거래에 고유번호 없으면 400', res.status === 400, res.data);

  res = await sale(staff, recoveryBody({ recovery: { ...recovery, occurred_at: minutesAgo(60 * 24 * 8) } }));
  check('8일 전 거래 복구 불가', res.status === 400, res.data);
  res = await sale(staff, recoveryBody({ recovery: { ...recovery, occurred_at: minutesAgo(-30) } }));
  check('미래 시각 거래 복구 불가', res.status === 400, res.data);

  res = await sale(staff, recoveryBody({ recovery, payments: [{ method: 'POINT', amount: 27000 }] }));
  check('장애 중 거래는 포인트 결제 불가', res.status === 400, res.data);

  res = await sale(staff, recoveryBody({ recovery }));
  check('재고보다 많이 팔린 장애 중 거래도 저장 201', res.status === 201, res.data);
  const order = orderRow(res.data.order.id);
  check('판매 시각은 실제 판매 시각', order.created_at === dbTime(occurred), { created: order.created_at, occurred: dbTime(occurred) });
  check('복구 출처·장애 번호 기록', order.recovery_source === 'OFFLINE_QUEUE' && order.outage_id === outage.id && order.recovered_at, order);
  const line = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(order.id);
  check('그때 받은 가격 9,000원 기록', line.price === 9000 && order.final_amount === 27000, line);
  check('시스템 재고 부족분 1개 기록', line.stock_shortage === 1, line);
  check('재고는 0에서 멈추고 품절 표시', productRow(shortageProduct.id).stock_quantity === 0 && productRow(shortageProduct.id).status === 'SOLD_OUT');
  const pay = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(order.id);
  check('결제 시각도 실제 판매 시각', pay.paid_at === dbTime(occurred) && pay.approval_number === '30012345', pay);
  check(
    '복구 거래에는 가입 코드 발급 안 함',
    db.prepare("SELECT COUNT(*) AS n FROM verification_codes WHERE order_id = ?").get(order.id).n === 0
  );
  check(
    '복구 감사 기록',
    db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'POS_SALE_RECOVERED' AND target_id = ?").get(order.id).n === 1
  );

  const again = await sale(staff, recoveryBody({ recovery }));
  check('복구 재전송은 중복으로 처리 200', again.status === 200 && again.data.duplicate === true, again.data);
  check('복구 재전송해도 주문 1건', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE client_sale_id = ?').get(queuedId).n === 1);

  const manualBody = {
    client_sale_id: randomUUID(),
    items: [{ product_id: shortageProduct.id, quantity: 1, price: 10000 }],
    payments: [{ method: 'CASH', amount: 10000 }],
    recovery: { source: 'MANUAL', occurred_at: minutesAgo(15), outage_id: outage.id, note: '수기 장부 3번' }
  };
  res = await sale(staff, manualBody);
  check('수기 거래 복구는 직원 불가 403', res.status === 403, res.data);
  res = await sale(owner, manualBody);
  check('약사는 수기 거래 복구 201', res.status === 201 && orderRow(res.data.order.id).recovery_source === 'MANUAL', res.data);
}

console.log('[장애 후 재고 대사]');
{
  let res = await api('/pos/outages', { token: staff });
  const listed = res.data.outages.find((o) => o.id === outage.id);
  check('장애 목록 거래 2건 · 37,000원 · 부족 2개', listed?.sale_count === 2 && listed.sale_amount === 37000 && listed.shortage_quantity === 2, listed);

  res = await api(`/pos/outages/${outage.id}`, { token: owner });
  const row = res.data.products.find((p) => p.product_id === shortageProduct.id);
  check('대사표에 상품·판매 4개·부족 2개', row?.sold_quantity === 4 && row.shortage_quantity === 2, res.data.products);

  res = await api(`/pos/outages/${outage.id}/reconcile`, { token: staff, method: 'POST', body: { counts: [] } });
  check('재고 대사는 직원 불가 403', res.status === 403, res.data);
  res = await api(`/pos/outages/${outage.id}/reconcile`, { token: owner, method: 'POST', body: { counts: [] } });
  check('실사 수량 없으면 400', res.status === 400, res.data);

  res = await api(`/pos/outages/${outage.id}/reconcile`, {
    token: owner,
    method: 'POST',
    body: { note: '매대·창고 실사', counts: [{ product_id: shortageProduct.id, counted_quantity: 1 }] }
  });
  check('재고 대사 완료', res.status === 200 && res.data.outage.status === 'RECONCILED' && res.data.adjusted.length === 1, res.data);
  check('실사 수량으로 재고 맞춤 · 판매 재개', productRow(shortageProduct.id).stock_quantity === 1 && productRow(shortageProduct.id).status === 'ON_SALE');
  const log = db
    .prepare("SELECT * FROM inventory_logs WHERE product_id = ? AND change_type = 'COUNT_ADJUST' ORDER BY id DESC")
    .get(shortageProduct.id);
  check('재고 변경 이력 남김', log?.quantity_before === 0 && log.quantity_after === 1 && /장애/.test(log.reason), log);

  res = await api(`/pos/outages/${outage.id}/reconcile`, { token: owner, method: 'POST', body: { counts: [] } });
  check('두 번 대사 불가 409', res.status === 409, res.data);
  res = await sale(staff, {
    client_sale_id: randomUUID(),
    items: [{ product_id: shortageProduct.id, quantity: 1, price: 10000 }],
    payments: [{ method: 'CASH', amount: 10000 }],
    recovery: { source: 'OFFLINE_QUEUE', occurred_at: minutesAgo(10), outage_id: outage.id }
  });
  check('대사 끝난 장애에 거래 추가 불가 409', res.status === 409, res.data);
  const resend = await sale(staff, {
    client_sale_id: queuedId,
    items: [{ product_id: shortageProduct.id, quantity: 3, price: 9000 }],
    payments: [{ method: 'CARD', amount: 27000, approval_number: '30012345', card_company: '신한' }],
    recovery: { source: 'OFFLINE_QUEUE', occurred_at: db.prepare('SELECT created_at FROM orders WHERE client_sale_id = ?').get(queuedId).created_at.replace(' ', 'T') + 'Z', outage_id: outage.id }
  });
  check('대사 뒤 늦게 온 재전송도 중복으로 처리 200', resend.status === 200 && resend.data.duplicate === true, resend.data);
}

console.log('[장애 대비 상품 목록]');
{
  const hidden = await product();
  db.prepare("UPDATE products SET status = 'HIDDEN' WHERE id = ?").run(hidden.id);
  const res = await api('/pos/offline-catalog', { token: staff });
  check('직원 조회 200', res.status === 200 && Array.isArray(res.data.products), res.data);
  const ids = new Set(res.data.products.map((p) => p.id));
  check('판매 상품 포함 · 숨김 제외', ids.has(shortageProduct.id) && !ids.has(hidden.id));
  check('전문의약품 제외', res.data.products.every((p) => p.product_type !== 'ETC'));
  check('바코드·판매가·구분 포함', res.data.products.every((p) => 'barcode' in p && 'sale_price' in p && 'product_type' in p));
}

console.log('[SQLite 백업 · 복구 훈련]');
{
  let res = await api('/admin/backups', { token: owner });
  check('약국 계정은 백업 조회 불가', res.status === 403, res.status);

  res = await api('/admin/backups', { token: admin, method: 'POST' });
  check('관리자 즉시 백업 201', res.status === 201 && res.data.backup.ok, res.data);
  const entry = res.data.backup;
  const file = path.join(process.env.BACKUP_DIR, entry.file);
  check('백업 파일 생성', existsSync(file));
  check('소유자만 읽기 (0600)', (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8));
  check('무결성·외래키 검사 통과', entry.integrity === 'ok' && entry.foreign_key_errors === 0, entry);
  const liveOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  check('주문 건수 일치', entry.counts.orders === liveOrders, { backup: entry.counts.orders, live: liveOrders });
  check('체크섬 기록', /^[0-9a-f]{64}$/.test(entry.sha256));

  res = await api('/admin/backups/drill', { token: admin, method: 'POST', body: {} });
  check('복구 훈련 성공', res.status === 200 && res.data.drill.ok, res.data.drill);
  check('복구 훈련 4단계(검사·복원·기동·대조) 모두 통과', res.data.drill.steps.length === 4 && res.data.drill.steps.every((s) => s.ok), res.data.drill.steps);
  check('상태에 마지막 성공 훈련 표시', res.data.last_good_drill?.file === entry.file, res.data.last_good_drill);

  const bytes = readFileSync(file);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(file, bytes);
  res = await api('/admin/backups/drill', { token: admin, method: 'POST', body: { file: entry.file } });
  check('손상된 백업은 훈련 실패로 기록', res.status === 500 && !res.data.drill.ok && /체크섬/.test(res.data.drill.error), res.data.drill);
  check('실패한 훈련이 마지막 훈련으로 보임', res.data.last_drill?.ok === false);
}

done();
