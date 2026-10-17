// 실물 단말기 현장 검증 전에, 같은 상황을 서버 프로세스를 실제로 죽였다 살리며 확인한다.
//  - 카드 승인 직후 서버 중단 → 재시작 후 다시 승인하지 않고 조회로 확정
//  - 판매 확정 도중 서버 중단 → 판매는 정확히 한 번
//  - 승인 취소 후 재요청 → 취소 반영 전 재승인 불가, 취소 재전송은 한 번만 반영
//  - 운영 서버는 데모·테스트 결제를 받지 않고, 운영·스테이징 DB를 섞어 쓰지 못함
// 공용 테스트 서버를 쓰지 않고 이 파일이 임시 DB로 서버와 데모 Bridge를 직접 띄운다.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, done } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { sign } = require('../src/pos/integrations/bridge-protocol.js');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(path.join(tmpdir(), 'maydin-van-crash-'));

const KEYS = { JWT_SECRET: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function envFor(dbName, extra = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_PATH: path.join(tempDir, dbName),
    BACKUP_DIR: path.join(tempDir, `${dbName}-backups`),
    PAYMENT_RECONCILE_INTERVAL_SECONDS: '3600',
    ...KEYS,
    ...extra
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

const runScript = (script, env, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: serverDir, env, encoding: 'utf8', timeout: 30000 });
const output = (res) => `${res.stdout || ''}${res.stderr || ''}`;

async function launch(script, env, healthPath) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    cwd: serverDir,
    env: { ...env, PORT: String(port), BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const proc = {
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    started: false,
    code: null,
    stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill(signal);
      });
    }
  };
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null) {
      proc.code = child.exitCode;
      return proc;
    }
    try {
      const res = await fetch(`${proc.base}${healthPath}`);
      if (res.ok) {
        proc.started = true;
        return proc;
      }
    } catch {}
    await sleep(100);
  }
  await proc.stop('SIGKILL');
  return proc;
}

const startServer = (env) => launch('src/index.js', env, '/api/health');

async function call(base, pathname, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

async function loginAt(base, email, password) {
  const res = await call(base, '/api/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`로그인 실패 ${email}: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

function initDb(env) {
  const res = runScript('src/db/init.js', env);
  if (res.status !== 0) throw new Error(`init-db 실패: ${output(res)}`);
}

let server;
let bridgeProc;
try {
  /* ================= 1. 승인·취소 도중 서버 중단 (테스트 서버 + 데모 Bridge) ================= */
  const env = envFor('crash.db');
  initDb(env);
  const db = new Database(env.DB_PATH);
  const productId = db
    .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type) VALUES (1, '중단 시험 상품', 10000, 100, 'ON_SALE', 'GENERAL')")
    .run().lastInsertRowid;
  const stock = () => db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity;
  const vanByRequest = (requestId) => db.prepare('SELECT * FROM van_transactions WHERE request_id = ?').get(requestId);

  let token;
  const restart = async (signal = 'SIGKILL') => {
    if (server) await server.stop(signal);
    server = await startServer(env);
    if (!server.started) throw new Error(`서버 재시작 실패: ${server.log()}`);
    token = await loginAt(server.base, 'owner@apharmacy.kr', 'owner1234');
  };
  const pos = (pathname, body, method) => call(server.base, `/api/pos${pathname}`, { token, body, method });
  const bridge = (pathname, body) => call(bridgeProc.base, pathname, { body });
  const items = [{ product_id: productId, quantity: 1 }];
  const prepare = (cid) => pos('/sales/prepare', { client_sale_id: cid, items });
  const approve = (cid, requestId, extra = {}) => pos('/payments/approve', { client_sale_id: cid, request_id: requestId, method: 'CARD', amount: 10000, ...extra });
  const card = (tx) => [{ method: 'CARD', amount: 10000, van_transaction_id: tx.id }];

  await restart();
  bridgeProc = await launch('scripts/demo-bridge.js', { ...process.env, BRIDGE_STORE: path.join(tempDir, 'bridge.json') }, '/v1/status');
  if (!bridgeProc.started) throw new Error(`데모 Bridge 시작 실패: ${bridgeProc.log()}`);

  let session = (await pos('/sessions/current')).data.session;
  if (!session) session = (await pos('/sessions/open', { opening_cash: 0 })).data.session;
  await pos('/van/terminal', { van_mode: 'BRIDGE' }, 'PATCH');
  const issued = await pos('/van/bridge-key', {});
  const paired = await bridge('/v1/pair', { terminal_id: issued.data.terminal_id, bridge_key: issued.data.bridge_key });
  check('준비: Bridge 모드 + 데모 Bridge 연결', issued.status === 201 && paired.status === 200, { issued: issued.data, paired: paired.data });

  console.log('[① 단말기 승인 직후 서버 중단 → 재시작 후 조회로 확정]');
  {
    const cid = randomUUID();
    const rid = randomUUID();
    await prepare(cid);
    let res = await approve(cid, rid);
    check('승인 요청 기록 후 Bridge 요청', res.status === 202 && res.data.bridge_request?.request_id === rid, res.data);
    const approved = await bridge('/v1/approve', res.data.bridge_request);
    check('단말기 승인 완료(카드 청구됨)', approved.data.status === 'APPROVED', approved.data);
    const before = stock();

    await server.stop('SIGKILL');
    check('서버 중단 시점: 승인 결과 모르는 상태로 남음', vanByRequest(rid).status === 'REQUESTED');
    await restart();

    res = await pos('/payments/pending');
    check('재시작 후 정리할 승인 목록에 보임', res.data.approvals?.some((a) => a.request_id === rid && a.status === 'REQUESTED'), res.data);
    res = await approve(cid, randomUUID());
    check('결과 확인 전 새 승인 막음(이중 결제 방지)', res.status === 409 && res.data.reason === 'APPROVAL_PENDING', res.data);
    res = await pos(`/sales/drafts/${cid}/cancel`, {});
    check('결과 확인 전 판매 취소 막음', res.status === 409 && res.data.reason === 'DRAFT_LOCKED', res.data);
    res = await pos(`/sessions/${session.id}/close`, { actual_cash: 0 });
    check('결과 확인 전 마감 막음', res.status === 409 && res.data.reason === 'VAN_APPROVALS_OPEN', res.data);

    const inquired = await bridge('/v1/inquire', { ...approved.data, transaction_type: 'APPROVE' });
    res = await pos('/payments/reconcile', { request_id: rid, bridge_result: inquired.data });
    const tx = res.data.van_transaction;
    check('Bridge 조회 → 같은 승인번호로 승인 확정', tx?.status === 'APPROVED' && tx.approval_number === approved.data.approval_number, res.data);
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(tx) });
    check('판매 확정', res.status === 201, res.data);
    check('재고는 한 번만 차감', stock() === before - 1, { before, after: stock() });
    check('결제 한 건 · 단말기 확인', db.prepare("SELECT COUNT(*) AS n FROM payments WHERE van_transaction_id = ? AND payment_provider = 'VAN_BRIDGE' AND verify_status = 'VERIFIED'").get(tx.id).n === 1);
  }

  console.log('[② POS가 받아 둔 승인 결과를 재시작 뒤 다시 보냄]');
  {
    const cid = randomUUID();
    const rid = randomUUID();
    await prepare(cid);
    const res0 = await approve(cid, rid);
    const approved = await bridge('/v1/approve', res0.data.bridge_request);
    await server.stop('SIGKILL');
    await restart();
    let res = await approve(cid, rid, { bridge_result: approved.data });
    check('같은 요청 번호 + 서명된 결과 → 승인', res.status === 201 && res.data.van_transaction.status === 'APPROVED', res.data);
    res = await approve(cid, rid, { bridge_result: approved.data });
    check('한 번 더 보내도 그대로(중복 승인 없음)', res.status === 200 && res.data.duplicate === true, res.data);
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(res.data.van_transaction) });
    check('판매 확정', res.status === 201, res.data);
  }

  console.log('[③ 판매 확정 도중 서버 중단 → 판매는 정확히 한 번]');
  for (const delay of [0, 15, 60]) {
    const cid = randomUUID();
    const rid = randomUUID();
    await prepare(cid);
    const res0 = await approve(cid, rid);
    const approved = await bridge('/v1/approve', res0.data.bridge_request);
    const done0 = await approve(cid, rid, { bridge_result: approved.data });
    const tx = done0.data.van_transaction;
    const before = stock();

    const inFlight = pos('/sales/confirm', { client_sale_id: cid, payments: card(tx) }).catch(() => null);
    await sleep(delay);
    await server.stop('SIGKILL');
    await inFlight;
    await restart();

    let res = await pos(`/sales/by-client-id/${cid}`);
    const savedBeforeCrash = res.data.status === 'SAVED';
    if (!savedBeforeCrash) {
      res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(tx) });
      check(`(${delay}ms) 저장 전 중단 → 같은 승인으로 다시 확정`, res.status === 201, res.data);
    }
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(tx) });
    check(`(${delay}ms) 확정 재전송 → 같은 주문`, res.status === 200 && res.data.duplicate === true, res.data);
    const orders = db.prepare('SELECT COUNT(DISTINCT order_id) AS n FROM payments WHERE van_transaction_id = ?').get(tx.id).n;
    check(`(${delay}ms) 주문 1건 · 재고 1개 차감 (중단 전 저장: ${savedBeforeCrash ? '예' : '아니오'})`, orders === 1 && stock() === before - 1, { orders, before, after: stock() });
  }

  console.log('[④ 승인 취소 후 재요청 — 단말기 취소 직후 서버 중단]');
  let resaleOrder;
  {
    const cid = randomUUID();
    const ridA = randomUUID();
    await prepare(cid);
    let res = await approve(cid, ridA);
    const approvedA = await bridge('/v1/approve', res.data.bridge_request);
    res = await approve(cid, ridA, { bridge_result: approvedA.data });
    const txA = res.data.van_transaction;
    res = await pos(`/van/transactions/${txA.id}/void`, {});
    check('단말기 취소 결과 없으면 취소 불가', res.status === 409 && res.data.reason === 'VAN_CANCEL_REQUIRED', res.data);
    const cancelRid = randomUUID();
    const canceled = await bridge('/v1/cancel', { ...res.data.bridge_request, request_id: cancelRid });
    check('단말기 승인 취소 완료', canceled.data.status === 'APPROVED' && canceled.data.original_approval_number === txA.approval_number, canceled.data);

    await server.stop('SIGKILL');
    await restart();

    res = await pos('/payments/pending');
    check('재시작 후: 취소 반영 전이라 미사용 승인으로 보임', res.data.approvals?.some((a) => a.id === txA.id && a.status === 'APPROVED'), res.data);
    res = await approve(cid, randomUUID());
    check('취소 반영 전 재승인 불가(합계 초과)', res.status === 400, res.data);
    res = await pos(`/sessions/${session.id}/close`, { actual_cash: 0 });
    check('취소 반영 전 마감 불가', res.status === 409 && res.data.reason === 'VAN_APPROVALS_OPEN', res.data);

    res = await pos(`/van/transactions/${txA.id}/void`, { bridge_result: canceled.data });
    check('같은 단말기 취소 결과로 취소 반영', res.status === 200 && res.data.van_transaction.status === 'VOIDED', res.data);
    res = await pos(`/van/transactions/${txA.id}/void`, { bridge_result: canceled.data });
    check('응답 못 받아 다시 보내도 성공(한 번만 반영)', res.status === 200 && res.data.van_transaction.status === 'VOIDED', res.data);
    check('취소 기록 1건', db.prepare("SELECT COUNT(*) AS n FROM van_transactions WHERE request_id = ? AND transaction_type = 'CANCEL'").get(cancelRid).n === 1);
    check('취소 감사 기록 1건', db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'POS_VAN_VOID' AND target_id = ?").get(txA.id).n === 1);

    res = await approve(cid, ridA);
    check('취소한 승인의 요청 번호로 다시 보내도 새 승인 안 함', res.status === 200 && res.data.duplicate === true && res.data.van_transaction.status === 'VOIDED' && !res.data.bridge_request, res.data);
    const ridB = randomUUID();
    res = await approve(cid, ridB);
    const approvedB = await bridge('/v1/approve', res.data.bridge_request);
    res = await approve(cid, ridB, { bridge_result: approvedB.data });
    const txB = res.data.van_transaction;
    check('새 요청 번호로 재승인', res.status === 201 && txB.status === 'APPROVED' && txB.approval_number !== txA.approval_number, res.data);
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(txA) });
    check('취소된 승인으로는 확정 불가', res.status === 409, res.data);
    const before = stock();
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(txB) });
    resaleOrder = res.data.order;
    check('재승인으로 확정 · 재고 1개 차감', res.status === 201 && stock() === before - 1, res.data);
  }

  console.log('[⑤ 판매 후 단말기 취소(환불) 직후 서버 중단]');
  {
    let res = await pos(`/sales/${resaleOrder.id}/cancel`, { reason: '현장 검증' });
    const request = res.data.cancels?.[0];
    check('환불 전 단말기 취소 요청', res.status === 409 && res.data.reason === 'VAN_CANCEL_REQUIRED' && request, res.data);
    const canceled = await bridge('/v1/cancel', { ...request, request_id: randomUUID() });
    const before = stock();
    await server.stop('SIGKILL');
    await restart();
    check('서버 중단 동안 판매는 그대로', db.prepare('SELECT order_status FROM orders WHERE id = ?').get(resaleOrder.id).order_status === 'COMPLETED');
    const body = { reason: '현장 검증', van_cancels: [{ original_approval_number: request.original_approval_number, bridge_result: canceled.data }] };
    res = await pos(`/sales/${resaleOrder.id}/cancel`, body);
    check('같은 단말기 취소 결과로 환불 · 재고 복원', res.status === 200 && stock() === before + 1, res.data);
    res = await pos(`/sales/${resaleOrder.id}/cancel`, body);
    check('환불 재전송 → 거절(이중 환불 없음)', res.status >= 400 && res.status < 500, res.data);
    check('환불 주문 1건', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE original_order_id = ?').get(resaleOrder.id).n === 1);
  }

  console.log('[마감 — 정리 끝나면 마감]');
  {
    const res = await pos('/payments/pending');
    check('정리할 승인 없음', res.data.approvals?.length === 0, res.data);
  }
  await server.stop();
  server = null;
  db.close();

  /* ================= 2. 운영 서버의 데모·테스트 결제 정책 ================= */
  const OWNER_PASSWORD = 'Field-Check-2026';
  const prepareProdDb = (dbName) => {
    const base = envFor(dbName);
    initDb(base);
    const conn = new Database(base.DB_PATH);
    conn.prepare('UPDATE users SET password_hash = ?').run(bcrypt.hashSync(OWNER_PASSWORD, 4));
    return conn;
  };

  console.log('[운영 서버 — 데모·테스트 결제 받지 않음]');
  {
    const conn = prepareProdDb('prod.db');
    const orderId = conn
      .prepare("INSERT INTO orders (order_number, pharmacy_id, order_type, total_product_amount, final_amount, order_status, payment_status) VALUES ('DEMO-OLD-1', 1, 'POS_SALE', 5000, 5000, 'COMPLETED', 'PAID')")
      .run().lastInsertRowid;
    conn.prepare("INSERT INTO payments (order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at) VALUES (?, 'CARD', 'VAN_DEMO', 'PAID', 5000, CURRENT_TIMESTAMP)").run(orderId);
    const prodProduct = conn
      .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type) VALUES (1, '운영 시험 상품', 10000, 10, 'ON_SALE', 'GENERAL')")
      .run().lastInsertRowid;

    const prodEnv = envFor('prod.db', { NODE_ENV: 'production' });
    server = await startServer(prodEnv);
    check('운영 서버 시작', server.started, server.log());
    check('이미 있는 데모 결제는 시작할 때 경고', /데모·테스트 결제.*VAN_DEMO 1건/.test(server.log()), server.log());
    check('DB에 운영 표시', conn.prepare("SELECT value FROM system_settings WHERE key = 'data_environment'").get()?.value === 'PRODUCTION');
    token = await loginAt(server.base, 'owner@apharmacy.kr', OWNER_PASSWORD);

    let res = await call(server.base, '/api/payments/config');
    check('온라인 데모 결제 닫힘', res.data.enabled === false, res.data);
    res = await pos('/van/terminal');
    check('데모 VAN은 선택 불가로 표시', res.data.modes?.find((m) => m.mode === 'DEMO')?.available === false, res.data.modes);
    res = await pos('/van/terminal', { van_mode: 'DEMO' }, 'PATCH');
    check('데모 VAN으로 바꾸기 거절', res.status === 409 && res.data.reason === 'TEST_PAYMENTS_DISABLED', res.data);

    let prodSession = (await pos('/sessions/current')).data.session;
    if (!prodSession) prodSession = (await pos('/sessions/open', { opening_cash: 0 })).data.session;
    const terminalId = conn.prepare('SELECT id FROM pos_terminals WHERE pharmacy_id = 1 ORDER BY id LIMIT 1').get().id;
    conn.prepare("UPDATE pos_terminals SET van_mode = 'DEMO' WHERE id = ?").run(terminalId);
    const cid = randomUUID();
    res = await pos('/sales/prepare', { client_sale_id: cid, items: [{ product_id: prodProduct, quantity: 1 }] });
    check('판매 등록', res.status === 201, res.data);
    res = await approve(cid, randomUUID());
    check('예전에 데모로 둔 단말기도 승인 거절', res.status === 409 && res.data.reason === 'TEST_PAYMENTS_DISABLED', res.data);
    const cashCid = randomUUID();
    await pos('/sales/prepare', { client_sale_id: cashCid, items: [{ product_id: prodProduct, quantity: 1 }] });
    res = await pos('/sales/confirm', { client_sale_id: cashCid, payments: [{ method: 'CASH', amount: 10000 }] });
    check('현금 판매', res.status === 201, res.data);
    res = await pos(`/sales/${res.data.order?.id}/cash-receipt`, { request_id: randomUUID(), purpose: 'INCOME', identity_input: 'POS', identity: '01012345678' });
    check('데모 현금영수증 거절', res.status === 409 && res.data.reason === 'TEST_PAYMENTS_DISABLED', res.data);

    conn.prepare("UPDATE pos_terminals SET van_mode = 'MANUAL' WHERE id = ?").run(terminalId);
    await pos('/van/terminal', { van_mode: 'BRIDGE' }, 'PATCH');
    const key = (await pos('/van/bridge-key', {})).data.bridge_key;
    const bridgeResult = (requestId, extra = {}) => {
      const payload = {
        protocol: 'maydin-bridge/1',
        terminal_id: terminalId,
        request_id: requestId,
        transaction_type: 'APPROVE',
        status: 'APPROVED',
        method: 'CARD',
        amount: 10000,
        installment_months: 0,
        approval_number: 'R1234567',
        card_company: '신한카드',
        occurred_at: new Date().toISOString(),
        ...extra
      };
      return { ...payload, signature: sign(key, payload) };
    };
    const demoRid = randomUUID();
    await approve(cid, demoRid);
    res = await approve(cid, demoRid, { bridge_result: bridgeResult(demoRid, { demo: true }) });
    check('데모 Bridge 승인 → 거절로 기록', res.status === 402 && res.data.reason === 'VAN_DECLINED' && /데모/.test(res.data.message), res.data);
    check('거절된 데모 승인은 판매에 못 씀', conn.prepare('SELECT status, is_demo FROM van_transactions WHERE request_id = ?').get(demoRid).status === 'DECLINED');
    const realRid = randomUUID();
    await approve(cid, realRid);
    res = await approve(cid, realRid, { bridge_result: bridgeResult(realRid) });
    check('실제 단말기 Bridge 결과는 승인', res.status === 201 && res.data.van_transaction.status === 'APPROVED' && res.data.van_transaction.is_demo === false, res.data);
    res = await pos('/sales/confirm', { client_sale_id: cid, payments: card(res.data.van_transaction) });
    check('실제 승인으로 판매', res.status === 201, res.data);
    const saleId = res.data.order.id;
    const cancelResult = (extra = {}) => {
      const payload = {
        protocol: 'maydin-bridge/1',
        terminal_id: terminalId,
        request_id: randomUUID(),
        transaction_type: 'CANCEL',
        status: 'APPROVED',
        method: 'CARD',
        amount: 10000,
        approval_number: 'C7654321',
        original_approval_number: 'R1234567',
        occurred_at: new Date().toISOString(),
        ...extra
      };
      return { original_approval_number: 'R1234567', bridge_result: { ...payload, signature: sign(key, payload) } };
    };
    res = await pos(`/sales/${saleId}/cancel`, { reason: '데모 취소 시도', van_cancels: [cancelResult({ demo: true })] });
    check('실제 승인을 데모 Bridge 취소로 환불 불가', res.status === 409 && res.data.reason === 'TEST_PAYMENTS_DISABLED', res.data);
    check('판매 그대로', conn.prepare('SELECT order_status FROM orders WHERE id = ?').get(saleId).order_status === 'COMPLETED');
    res = await pos(`/sales/${saleId}/cancel`, { reason: '실제 취소', van_cancels: [cancelResult()] });
    check('실제 단말기 취소로 환불', res.status === 200, res.data);
    await server.stop();
    server = null;

    server = await startServer(envFor('prod.db', { NODE_ENV: 'production', MAYDIN_STAGING: 'true' }));
    check('운영 DB를 스테이징(시험 결제 허용)으로는 못 띄움', !server.started && /운영 DB/.test(server.log()), server.log());
    server = null;
    const init = runScript('src/db/init.js', envFor('prod.db', { NODE_ENV: 'production', MAYDIN_STAGING: 'true' }));
    check('init-db도 같은 이유로 중단', init.status === 1 && /운영 DB/.test(output(init)), output(init));

    const audit = runScript('scripts/security-check.js', prodEnv, ['--db', prodEnv.DB_PATH]);
    check('보안 점검에 데모 결제 표시 · 종료 코드 1', audit.status === 1 && /데모·테스트 결제가 매출·재고에 잡혀 있음: VAN_DEMO 1건/.test(output(audit)), output(audit));
    conn.close();
  }

  console.log('[스테이징 서버 — 시험 결제 허용, 그 DB는 운영으로 못 씀]');
  {
    const conn = prepareProdDb('staging.db');
    server = await startServer(envFor('staging.db', { NODE_ENV: 'production', MAYDIN_STAGING: 'true' }));
    check('스테이징 서버 시작 · 경고 표시', server.started && /스테이징 서버/.test(server.log()), server.log());
    check('DB에 스테이징 표시', conn.prepare("SELECT value FROM system_settings WHERE key = 'data_environment'").get()?.value === 'STAGING');
    const res = await call(server.base, '/api/payments/config');
    check('스테이징은 (데모) 결제 열림', res.data.enabled === true && res.data.mode === 'DEMO', res.data);
    await server.stop();
    server = await startServer(envFor('staging.db', { NODE_ENV: 'production' }));
    check('스테이징 DB를 운영으로는 못 띄움', !server.started && /스테이징 서버/.test(server.log()), server.log());
    server = null;
    conn.close();
  }
} finally {
  if (server) await server.stop('SIGKILL');
  if (bridgeProc) await bridgeProc.stop('SIGKILL');
  rmSync(tempDir, { recursive: true, force: true });
}

done();
