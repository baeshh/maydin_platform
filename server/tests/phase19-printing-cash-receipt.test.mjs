// 영수증 프린터 직접 출력(Bridge)과 현금영수증(VAN 규격) 흐름.
//  - ESC/POS 변환: 초기화·한글(CP949)·정렬·바코드·QR·돈통·절단
//  - 가짜 네트워크 프린터(TCP 9100)로 용지 없음·덮개 열림·무응답·출력 도중 용지 끝·응답 끊김 → 재시도, 중복 출력 없음
//  - 재출력 표시·브라우저 대체·출력 안 함·시험 출력
//  - 현금영수증: 서버가 금액·과세 구분 계산, 식별번호는 Bridge에서만(가린 값만 저장), 결과 모름 → 조회,
//    반품 때 단말기 취소 필수·남은 금액 재발급, 카드만 환불하면 그대로, 자진발급
// 이 파일이 임시 DB로 서버·데모 Bridge·가짜 프린터를 직접 띄운다.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, done } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const iconv = require('iconv-lite');
const { sign } = require('../src/pos/integrations/bridge-protocol.js');
const { DRAWER_KICK, FEED_AND_CUT, displayWidth, render, renderText, wrap } = require('../src/pos/printing/escpos.js');
const { stateFromBytes } = require('../src/pos/printing/printer-transport.js');
const { classifyIdentity } = require('../src/pos/integrations/cash-identity.js');

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(path.join(tmpdir(), 'maydin-print-'));
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

async function launch(script, env, healthPath) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], { cwd: serverDir, env: { ...env, PORT: String(port), BRIDGE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  const proc = {
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    started: false,
    stop() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
    }
  };
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null) return proc;
    try {
      if ((await fetch(`${proc.base}${healthPath}`)).ok) {
        proc.started = true;
        return proc;
      }
    } catch {}
    await sleep(100);
  }
  await proc.stop();
  return proc;
}

async function call(base, pathname, { token, body, method = body === undefined ? 'GET' : 'POST', timeout } = {}) {
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  } catch (error) {
    return { status: 0, data: null, error: error.name };
  }
}

/* ---------- 가짜 네트워크 영수증 프린터 (ESC/POS · DLE EOT 실시간 상태) ---------- */
function statusByte(state, n) {
  const base = 0x12;
  if (n === 1) return state === 'OFFLINE' ? base | 0x08 : base;
  if (n === 2) return base | (state === 'COVER_OPEN' ? 0x04 : 0) | (state === 'PAPER_OUT' ? 0x20 : 0);
  if (n === 4) return base | (state === 'PAPER_OUT' ? 0x60 : 0) | (state === 'NEAR_END' ? 0x0c : 0);
  return base;
}

function fakePrinter() {
  const printer = { state: 'READY', received: Buffer.alloc(0) };
  const server = createServer((socket) => {
    let wrote = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const data = [];
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 0x10 && chunk[i + 1] === 0x04 && i + 2 < chunk.length) {
          const n = chunk[i + 2];
          i += 2;
          if (printer.state === 'SILENT') continue;
          const state = printer.state === 'PAPER_OUT_AFTER' ? (wrote ? 'PAPER_OUT' : 'READY') : printer.state;
          socket.write(Buffer.from([statusByte(state, n)]));
        } else {
          data.push(chunk[i]);
        }
      }
      if (data.length) {
        wrote = true;
        printer.received = Buffer.concat([printer.received, Buffer.from(data)]);
      }
    });
  });
  printer.listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  printer.close = () => new Promise((resolve) => server.close(resolve));
  printer.count = (needle) => {
    let n = 0;
    for (let at = printer.received.indexOf(needle); at !== -1; at = printer.received.indexOf(needle, at + 1)) n += 1;
    return n;
  };
  printer.cuts = () => printer.count(FEED_AND_CUT);
  return printer;
}

const sha = (document) => createHash('sha256').update(JSON.stringify(document)).digest('hex');
const docText = (document) => document.lines.map((l) => l.text || `${l.left || ''} ${l.right || ''}`).join('\n');

/* ================= 1. ESC/POS 변환 ================= */
console.log('[ESC/POS 변환]');
{
  check('한글 두 칸 · 영문 한 칸', displayWidth('가a') === 3);
  check('한글 줄바꿈이 칸 수를 넘지 않음', wrap('가나다라마바사아자차', 7).every((line) => displayWidth(line) <= 7));
  check('띄어쓰기에서 줄을 바꿈(단어를 쪼개지 않음)', JSON.stringify(wrap('QR을 찍고 가입하면 이번 구매도 포인트로 적립돼요', 42)) === JSON.stringify(['QR을 찍고 가입하면 이번 구매도 포인트로', '적립돼요']));
  check('앞쪽 들여쓰기는 유지', wrap('  11,000원 x 1', 42)[0] === '  11,000원 x 1');
  const document = {
    version: 1,
    kind: 'RECEIPT',
    open_drawer: true,
    cut: true,
    lines: [
      { type: 'text', text: '마이딘약국', align: 'center', bold: true, size: 2 },
      { type: 'pair', left: '결제 금액', right: '16,000원', bold: true },
      { type: 'rule', char: '-' },
      { type: 'barcode', format: 'CODE128', data: 'POS-20261012-0001' },
      { type: 'qr', data: 'https://example.kr/join.html?code=ABC' }
    ]
  };
  const bytes = render(document, { columns: 42 });
  check('ESC @ 초기화로 시작', bytes[0] === 0x1b && bytes[1] === 0x40);
  check('한국 문자 설정(ESC R 13 · FS &)', bytes.includes(Buffer.from([0x1b, 0x52, 13, 0x1c, 0x26])));
  check('한글은 CP949', bytes.includes(iconv.encode('마이딘약국', 'cp949')));
  check('돈통 열기 명령', bytes.includes(DRAWER_KICK));
  check('CODE128 바코드', bytes.includes(Buffer.from([0x1d, 0x6b, 73])) && bytes.includes(Buffer.from('{BPOS-20261012-0001', 'ascii')));
  check('QR 코드', bytes.includes(Buffer.from([0x1d, 0x28, 0x6b])));
  check('마지막은 용지 올림 + 부분 절단', bytes.subarray(-FEED_AND_CUT.length).equals(FEED_AND_CUT));
  check('돈통 안 열면 명령 없음', !render({ ...document, open_drawer: false }).includes(DRAWER_KICK));
  const preview = renderText(document, { columns: 42 }).split('\n');
  check('금액 줄은 42칸에 맞춤', displayWidth(preview.find((l) => l.includes('결제 금액'))) === 42, preview);
  check('미리보기에 절단 위치', preview.at(-1).includes('절단'));
  check('프린터 상태: 용지 없음', stateFromBytes(0x12, 0x32, 0x72) === 'PAPER_OUT');
  check('프린터 상태: 덮개 열림', stateFromBytes(0x12, 0x16, 0x12) === 'COVER_OPEN');
  check('프린터 상태: 용지 거의 없음', stateFromBytes(0x12, 0x12, 0x1e) === 'PAPER_NEAR_END');
  check('식별번호 휴대폰 가림', classifyIdentity('010-1234-5678').masked === '010-****-5678');
  check('식별번호 카드는 뒤 4자리만', classifyIdentity('1234567812345678').masked === '****-****-****-5678');
  let rejected = false;
  try {
    classifyIdentity('9001011234567');
  } catch {
    rejected = true;
  }
  check('주민등록번호 13자리 거절', rejected);
}

let server;
let bridgeProc;
const printer = fakePrinter();
try {
  const printerPort = await printer.listen();
  const env = { ...process.env, NODE_ENV: 'test', DB_PATH: path.join(tempDir, 'print.db'), BACKUP_DIR: path.join(tempDir, 'backups'), PAYMENT_RECONCILE_INTERVAL_SECONDS: '3600', ...KEYS };
  const init = spawnSync(process.execPath, ['src/db/init.js'], { cwd: serverDir, env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`init-db 실패: ${init.stdout}${init.stderr}`);
  const db = new Database(env.DB_PATH);
  const product = (name, price, taxType = 'TAXABLE') =>
    db
      .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type, tax_type) VALUES (1, ?, ?, 500, 'ON_SALE', 'GENERAL', ?)")
      .run(name, price, taxType).lastInsertRowid;
  const taxable = product('과세 상품', 11000);
  const exempt = product('면세 상품', 5000, 'EXEMPT');

  server = await launch('src/index.js', env, '/api/health');
  if (!server.started) throw new Error(`서버 시작 실패: ${server.log()}`);
  bridgeProc = await launch(
    'scripts/demo-bridge.js',
    { ...process.env, BRIDGE_STORE: path.join(tempDir, 'bridge.json'), BRIDGE_PRINTER: `tcp://127.0.0.1:${printerPort}` },
    '/v1/status'
  );
  if (!bridgeProc.started) throw new Error(`데모 Bridge 시작 실패: ${bridgeProc.log()}`);

  const token = (await call(server.base, '/api/auth/login', { body: { email: 'owner@apharmacy.kr', password: 'owner1234' } })).data.token;
  const pos = (pathname, body, method) => call(server.base, `/api/pos${pathname}`, { token, body, method });
  const bridge = (pathname, body, options = {}) => call(bridgeProc.base, pathname, { body, ...options });
  const audits = (action) => db.prepare('SELECT COUNT(*) AS n FROM admin_logs WHERE action = ?').get(action).n;
  const sale = async (items, payments) => {
    const cid = randomUUID();
    const prepared = await pos('/sales/prepare', { client_sale_id: cid, items });
    if (prepared.status !== 201) throw new Error(`판매 등록 실패 ${JSON.stringify(prepared.data)}`);
    const res = await pos('/sales/confirm', { client_sale_id: cid, payments: typeof payments === 'function' ? await payments(cid) : payments });
    if (res.status !== 201) throw new Error(`판매 확정 실패 ${JSON.stringify(res.data)}`);
    return res.data.order;
  };
  const cashSale = (amount = 11000, items = [{ product_id: taxable, quantity: 1 }]) => sale(items, [{ method: 'CASH', amount }]);

  let session = (await pos('/sessions/current')).data.session;
  if (!session) session = (await pos('/sessions/open', { opening_cash: 0 })).data.session;
  let res = await pos('/printer/settings', { mode: 'BRIDGE' }, 'PATCH');
  check('Bridge 연결 전에는 프린터 직접 출력 설정 불가', res.status === 409 && res.data.reason === 'BRIDGE_NOT_PAIRED', res.data);
  await pos('/van/terminal', { van_mode: 'BRIDGE' }, 'PATCH');
  const issued = await pos('/van/bridge-key', {});
  const bridgeKey = issued.data.bridge_key;
  const terminalId = issued.data.terminal_id;
  await bridge('/v1/pair', { terminal_id: terminalId, bridge_key: bridgeKey });

  /* ================= 2. 영수증 프린터 직접 출력 ================= */
  console.log('[프린터 설정 · 상태]');
  {
    res = await pos('/printer/settings', { mode: 'BRIDGE', auto_print: true, open_drawer: true }, 'PATCH');
    check('프린터 직접 출력 · 자동 출력 · 돈통 열기 설정', res.status === 200 && res.data.printer.mode === 'BRIDGE' && res.data.printer.auto_print && res.data.printer.open_drawer, res.data);
    res = await pos('/van/terminal');
    check('카운터 정보에 프린터 설정', res.data.van.printer?.mode === 'BRIDGE', res.data.van);
    res = await bridge('/v1/printer/status');
    check('Bridge가 프린터 상태 조회(DLE EOT) → 출력 가능', res.data.state === 'READY', res.data);
    printer.state = 'PAPER_OUT';
    res = await bridge('/v1/printer/status');
    check('용지 없음 상태 감지', res.data.state === 'PAPER_OUT', res.data);
    printer.state = 'READY';
  }

  const sendPrint = async (printRequest, options) => {
    const printed = await bridge('/v1/print', printRequest, options);
    if (printed.status !== 200) return { printed };
    const reported = await pos(`/print-jobs/${printRequest.job_id}/result`, { bridge_result: printed.data });
    return { printed, reported };
  };

  console.log('[판매 영수증 직접 출력 · 돈통 · 절단]');
  const order1 = await cashSale();
  {
    res = await pos(`/sales/${order1.id}/print`, {});
    const request = res.data.print_request;
    check('출력 작업 생성 · 원본 · 돈통 열기', res.status === 201 && res.data.job.copy_type === 'ORIGINAL' && request?.document.open_drawer === true && request.transaction_type === 'PRINT', res.data);
    check('문서 해시 = 서버가 만든 문서', request.document_hash === sha(request.document));
    check('문서에 판매 내용', docText(request.document).includes(order1.order_number) && docText(request.document).includes('11,000원'));
    const cutsBefore = printer.cuts();
    const { printed, reported } = await sendPrint(request);
    check('Bridge 출력 성공(서명된 결과)', printed.data.status === 'PRINTED' && printed.data.signature && printed.data.document_hash === request.document_hash, printed.data);
    check('프린터에 한 장 · 절단 · 돈통 열림', printer.cuts() === cutsBefore + 1 && printer.count(DRAWER_KICK) === 1);
    check('프린터가 받은 내용에 한글 상호(CP949)', printer.received.includes(iconv.encode('영수증', 'cp949')));
    check('서버 작업 = 출력 완료', reported.data.job?.status === 'PRINTED' && reported.data.job.attempts === 1, reported.data);

    const again = await sendPrint(request);
    check('같은 작업을 다시 보내도 프린터는 다시 안 뽑음', again.printed.data.status === 'PRINTED' && printer.cuts() === cutsBefore + 1);
    check('서버도 그대로', again.reported.data.unchanged === true, again.reported.data);

    const forged = { ...printed.data, status: 'FAILED', error_code: 'PAPER_OUT' };
    res = await pos(`/print-jobs/${request.job_id}/result`, { bridge_result: forged });
    check('서명 안 맞는 출력 결과 거절', res.status === 400 && res.data.reason === 'BRIDGE_RESULT_INVALID', res.data);
  }

  console.log('[재출력 표시]');
  {
    const reprintAudits = audits('POS_RECEIPT_REPRINT');
    res = await pos(`/sales/${order1.id}/print`, {});
    const request = res.data.print_request;
    check('이미 출력한 판매 → 재출력 작업', res.status === 201 && res.data.job.copy_type === 'REPRINT', res.data);
    check('재출력 문서에 [재출력] 표시 · 돈통 안 엶', docText(request.document).includes('[재출력]') && request.document.open_drawer === false);
    const kicks = printer.count(DRAWER_KICK);
    const { reported } = await sendPrint(request);
    check('재출력 완료 · 돈통 그대로', reported.data.job.status === 'PRINTED' && printer.count(DRAWER_KICK) === kicks, reported.data);
    check('재출력 감사 기록', audits('POS_RECEIPT_REPRINT') === reprintAudits + 1);
  }

  console.log('[용지 없음 → 보내지 않음 → 같은 작업 재시도]');
  {
    const order = await cashSale();
    printer.state = 'PAPER_OUT';
    res = await pos(`/sales/${order.id}/print`, {});
    const request = res.data.print_request;
    const received = printer.received.length;
    const { printed, reported } = await sendPrint(request);
    check('Bridge: 용지 없음 실패', printed.data.status === 'FAILED' && printed.data.error_code === 'PAPER_OUT', printed.data);
    check('용지 없으면 프린터에 아무것도 안 보냄', printer.received.length === received);
    check('서버 작업 = 실패 · 감사 기록', reported.data.job.status === 'FAILED' && audits('POS_PRINT_FAILED') >= 1, reported.data);
    res = await pos('/print-jobs/open');
    check('미출력 목록에 보임', res.data.jobs.some((j) => j.job_id === request.job_id && j.status === 'FAILED'), res.data);
    res = await pos(`/sales/${order.id}/print`, {});
    check('다시 출력 눌러도 새 작업 안 만들고 같은 작업', res.status === 200 && res.data.resumed && res.data.print_request.job_id === request.job_id && res.data.job.copy_type === 'ORIGINAL', res.data);

    printer.state = 'READY';
    res = await pos(`/print-jobs/${request.job_id}/retry`, {});
    check('재시도 요청 = 같은 작업 번호', res.status === 200 && res.data.print_request.job_id === request.job_id, res.data);
    check('재시도에는 돈통 다시 안 엶', res.data.print_request.document.open_drawer === false);
    const cuts = printer.cuts();
    const retried = await sendPrint(res.data.print_request);
    check('재시도 출력 완료 · 한 장', retried.reported.data.job.status === 'PRINTED' && printer.cuts() === cuts + 1, retried.reported.data);
    res = await pos('/print-jobs/open');
    check('미출력 목록에서 빠짐', !res.data.jobs.some((j) => j.job_id === request.job_id));
    res = await pos(`/print-jobs/${request.job_id}/retry`, {});
    check('출력된 작업은 재시도 불가(재출력으로)', res.status === 409 && res.data.reason === 'ALREADY_PRINTED', res.data);
  }

  console.log('[덮개 열림 · 프린터 무응답 · 출력 도중 용지 끝]');
  {
    const order = await cashSale();
    printer.state = 'COVER_OPEN';
    const request = (await pos(`/sales/${order.id}/print`, {})).data.print_request;
    let out = await sendPrint(request);
    check('덮개 열림 실패', out.printed.data.error_code === 'COVER_OPEN', out.printed.data);

    printer.state = 'SILENT';
    out = await sendPrint((await pos(`/print-jobs/${request.job_id}/retry`, {})).data.print_request);
    check('상태 조회에 답 없음 → 연결 실패로 보내지 않음', out.printed.data.status === 'FAILED' && out.printed.data.error_code === 'OFFLINE', out.printed.data);

    printer.state = 'PAPER_OUT_AFTER';
    out = await sendPrint((await pos(`/print-jobs/${request.job_id}/retry`, {})).data.print_request);
    check('출력 뒤 용지 끝 → 일부만 나왔을 수 있다고 실패', out.printed.data.status === 'FAILED' && /일부만/.test(out.printed.data.message), out.printed.data);
    check('서버 작업 실패 · 시도 3회', out.reported.data.job.status === 'FAILED' && out.reported.data.job.attempts === 3, out.reported.data);

    printer.state = 'READY';
    out = await sendPrint((await pos(`/print-jobs/${request.job_id}/retry`, {})).data.print_request);
    check('용지 넣고 재시도 → 출력', out.reported.data.job.status === 'PRINTED', out.reported.data);
  }

  console.log('[출력 응답 끊김 → 재시도해도 두 번 안 뽑음]');
  {
    const order = await cashSale();
    const request = (await pos(`/sales/${order.id}/print`, {})).data.print_request;
    await bridge('/v1/demo/simulate', { next_print: 'HANG' });
    const cuts = printer.cuts();
    const lost = await bridge('/v1/print', request, { timeout: 2500 });
    check('POS는 응답을 못 받음', lost.status === 0, lost);
    check('프린터에는 이미 나옴', printer.cuts() === cuts + 1);
    res = await pos('/print-jobs/open');
    check('서버는 결과 모름(미출력 목록)', res.data.jobs.some((j) => j.job_id === request.job_id && j.status === 'REQUESTED'), res.data);
    res = await pos(`/print-jobs/${request.job_id}/retry`, {});
    const out = await sendPrint(res.data.print_request);
    check('재시도 → Bridge 기록으로 출력 완료 확인 · 다시 안 뽑음', out.reported.data.job.status === 'PRINTED' && printer.cuts() === cuts + 1, { job: out.reported.data.job, cuts: printer.cuts() });
    const prints = (await bridge('/v1/demo/prints')).data.prints;
    check('Bridge 출력 횟수 1', prints[request.job_id] === 1, prints);
  }

  console.log('[내용 바꿔치기 거절]');
  {
    const order = await cashSale();
    const request = (await pos(`/sales/${order.id}/print`, {})).data.print_request;
    const tampered = { ...request, document: { ...request.document, lines: [...request.document.lines, { type: 'text', text: '할인 쿠폰 100%' }] } };
    res = await bridge('/v1/print', tampered);
    check('해시와 다른 문서는 Bridge가 출력 안 함', res.status === 400, res.data);
    const { document_hash: _omit, ...withoutHash } = tampered;
    const printed = await bridge('/v1/print', withoutHash);
    res = await pos(`/print-jobs/${request.job_id}/result`, { bridge_result: printed.data });
    check('해시 없이 뽑은 다른 문서 결과는 서버가 거절', res.status === 400 && /내용이 요청과 다릅니다/.test(res.data.message), res.data);

    res = await pos(`/print-jobs/${request.job_id}/browser`, {});
    check('브라우저 인쇄로 대체 → 영수증 데이터 · 출력 처리', res.status === 200 && res.data.job.channel === 'BROWSER' && res.data.job.status === 'PRINTED' && res.data.receipt?.order.id === order.id, res.data);
  }

  console.log('[출력 안 함 · 시험 출력 · 브라우저 모드]');
  {
    const order = await cashSale();
    printer.state = 'PAPER_OUT';
    const request = (await pos(`/sales/${order.id}/print`, {})).data.print_request;
    await sendPrint(request);
    res = await pos(`/print-jobs/${request.job_id}/skip`, {});
    check('출력 안 함 → 목록에서 빠짐', res.data.job.status === 'CANCELED' && !(await pos('/print-jobs/open')).data.jobs.some((j) => j.job_id === request.job_id), res.data);
    printer.state = 'READY';

    res = await pos('/printer/test', {});
    const out = await sendPrint(res.data.print_request);
    check('시험 출력', res.status === 201 && res.data.job.document_type === 'TEST' && out.reported.data.job.status === 'PRINTED', out.reported.data);

    await pos('/printer/settings', { mode: 'BROWSER' }, 'PATCH');
    res = await pos(`/sales/${order.id}/print`, {});
    check('브라우저 모드 → 영수증 데이터로 window.print', res.status === 201 && res.data.job.channel === 'BROWSER' && res.data.receipt && !res.data.print_request, res.data);
    check('출력 안 한 판매의 첫 브라우저 인쇄는 원본', res.data.job.copy_type === 'ORIGINAL', res.data.job);
    await pos('/printer/settings', { mode: 'BRIDGE' }, 'PATCH');
  }

  /* ================= 3. 현금영수증 ================= */
  const issue = (orderId, body = {}) => pos(`/sales/${orderId}/cash-receipt`, { request_id: randomUUID(), purpose: 'INCOME', identity_input: 'TERMINAL', ...body });
  const issueThroughBridge = async (orderId, body = {}, keypad = '01098765432') => {
    const requested = await issue(orderId, body);
    if (requested.status !== 202) return { requested };
    if (keypad) await bridge('/v1/demo/simulate', { keypad_identity: keypad });
    const issued = await bridge('/v1/cash-receipt', requested.data.bridge_request);
    const saved = await issue(orderId, { ...body, request_id: requested.data.bridge_request.request_id, bridge_result: issued.data });
    return { requested, issued, saved };
  };

  console.log('[현금영수증 발급 — 금액은 서버, 식별번호는 단말기]');
  let mixedOrder;
  {
    mixedOrder = await sale([{ product_id: taxable, quantity: 1 }, { product_id: exempt, quantity: 1 }], [{ method: 'CASH', amount: 16000 }]);
    res = await pos(`/sales/${mixedOrder.id}/cash-receipt`);
    const amounts = res.data.amounts;
    check('발급 금액 = 현금 16,000 · 공급가 10,000 · 부가세 1,000 · 면세 5,000', amounts.amount === 16000 && amounts.supply_amount === 10000 && amounts.vat_amount === 1000 && amounts.tax_free_amount === 5000, amounts);
    res = await issue(mixedOrder.id, { identity: '01012345678' });
    check('Bridge 모드에서 식별번호를 서버로 보내면 거절', res.status === 400 && /서버로 보내지 않습니다/.test(res.data.message), res.data);
    res = await issue(mixedOrder.id, { purpose: 'EXPENSE', identity_input: 'SELF' });
    check('자진발급은 소득공제만', res.status === 400, res.data);

    const { requested, issued, saved } = await issueThroughBridge(mixedOrder.id, {}, '010-1234-5678');
    const request = requested.data.bridge_request;
    check('발급 요청 기록 → Bridge 요청(식별번호 없음)', requested.status === 202 && request.transaction_type === 'CASH_RECEIPT' && request.amount === 16000 && request.tax_free_amount === 5000 && !('identity' in request), requested.data);
    check('Bridge: 고객이 키패드에 입력한 번호를 가려서 서명', issued.data.status === 'APPROVED' && issued.data.masked_identity === '010-****-5678' && issued.data.identity_type === 'PHONE' && !JSON.stringify(issued.data).includes('12345678'), issued.data);
    const tx = saved.data.van_transaction;
    check('서버: 발급 완료 · 판매에 연결', saved.status === 201 && tx.status === 'USED' && tx.masked_identity === '010-****-5678' && tx.cash_receipt_purpose === 'INCOME', saved.data);
    const row = db.prepare('SELECT * FROM van_transactions WHERE id = ?').get(tx.id);
    check('DB에 원래 번호 없음', !JSON.stringify(row).includes('12345678'), row);
    check('결제 줄에 현금영수증 승인번호', db.prepare("SELECT cash_receipt_number FROM payments WHERE order_id = ? AND payment_method = 'CASH'").get(mixedOrder.id).cash_receipt_number === tx.approval_number);
    res = await pos(`/sales/${mixedOrder.id}`);
    check('영수증 데이터에 현금영수증 · 추가 발급 불가', res.data.cash_receipts?.[0]?.approval_number === tx.approval_number && res.data.permissions.can_issue_cash_receipt === false, res.data.cash_receipts);
    res = await pos(`/sales/${mixedOrder.id}/print`, {});
    check('출력 문서에 현금영수증 승인번호·가린 번호', docText(res.data.print_request.document).includes(tx.approval_number) && docText(res.data.print_request.document).includes('010-****-5678'));
    await sendPrint(res.data.print_request);
    res = await issue(mixedOrder.id);
    check('이미 발급한 판매 → 409', res.status === 409 && res.data.reason === 'CASH_RECEIPT_EXISTS', res.data);
    res = await issue(mixedOrder.id, { request_id: request.request_id, bridge_result: issued.data });
    check('같은 결과 재전송 → 그대로(중복 없음)', res.status === 200 && res.data.duplicate === true, res.data);
  }

  console.log('[가리지 않은 번호·주민번호·카드 판매]');
  {
    const order = await cashSale();
    const requested = await issue(order.id);
    const rid = requested.data.bridge_request.request_id;
    const payload = {
      protocol: 'maydin-bridge/1',
      terminal_id: terminalId,
      request_id: rid,
      transaction_type: 'CASH_RECEIPT',
      status: 'APPROVED',
      method: 'CASH',
      amount: 11000,
      approval_number: '55554444',
      purpose: 'INCOME',
      identity_type: 'PHONE',
      masked_identity: '010-1234-5678',
      occurred_at: new Date().toISOString()
    };
    res = await issue(order.id, { request_id: rid, bridge_result: { ...payload, signature: sign(bridgeKey, payload) } });
    check('가리지 않은 식별번호 결과 거절', res.status === 400 && /가린 값/.test(res.data.message), res.data);
    const wrongAmount = { ...payload, amount: 1000, masked_identity: '010-****-5678' };
    res = await issue(order.id, { request_id: rid, bridge_result: { ...wrongAmount, signature: sign(bridgeKey, wrongAmount) } });
    check('금액 다른 결과 거절', res.status === 400 && /금액/.test(res.data.message), res.data);
    res = await bridge('/v1/cash-receipt', { ...requested.data.bridge_request, identity_input: 'POS', identity: '900101-1234567' });
    check('Bridge도 주민등록번호 거절', res.status === 400 && /주민등록번호/.test(res.data.message), res.data);
    const okResult = await bridge('/v1/cash-receipt', { ...requested.data.bridge_request, identity_input: 'POS', identity: '123-45-67890' });
    check('직원 입력 사업자번호(지출증빙 등) → 가림', okResult.data.masked_identity === '123-**-***90' && okResult.data.identity_type === 'BUSINESS', okResult.data);
    res = await issue(order.id, { request_id: rid, bridge_result: okResult.data });
    check('발급 완료', res.status === 201 && res.data.van_transaction.identity_type === 'BUSINESS', res.data);
  }

  console.log('[발급 응답 끊김 → 재발급 막고 조회로 확정]');
  {
    const order = await cashSale();
    const requested = await issue(order.id);
    const request = requested.data.bridge_request;
    await bridge('/v1/demo/simulate', { next: 'TIMEOUT_APPROVED', keypad_identity: '01011112222' });
    const lost = await bridge('/v1/cash-receipt', request, { timeout: 2500 });
    check('POS는 발급 결과를 못 받음', lost.status === 0);
    res = await pos('/payments/pending');
    check('정리할 목록에 현금영수증', res.data.approvals.some((a) => a.request_id === request.request_id && a.transaction_type === 'CASH_RECEIPT'), res.data);
    res = await issue(order.id);
    check('결과 모르는 동안 새 발급 막음(이중 발급 방지)', res.status === 409 && res.data.reason === 'CASH_RECEIPT_PENDING', res.data);
    res = await pos(`/sessions/${session.id}/close`, { actual_cash: 0 });
    check('결과 모르는 현금영수증이 있으면 마감 불가', res.status === 409 && res.data.reason === 'VAN_APPROVALS_OPEN', res.data);
    res = await pos('/payments/reconcile', { request_id: request.request_id });
    check('조회는 Bridge 결과 필요', res.status === 409 && res.data.reason === 'BRIDGE_RESULT_REQUIRED' && res.data.bridge_request.transaction_type === 'CASH_RECEIPT', res.data);
    const inquired = await bridge('/v1/inquire', res.data.bridge_request);
    check('Bridge 조회: 발급돼 있음', inquired.data.status === 'APPROVED' && inquired.data.masked_identity === '010-****-2222', inquired.data);
    res = await pos('/payments/reconcile', { request_id: request.request_id, bridge_result: inquired.data });
    check('조회 결과로 발급 확정 · 판매에 연결', res.data.van_transaction.status === 'USED' && res.data.van_transaction.order_id === order.id, res.data);
    check('정리 목록 비움', !(await pos('/payments/pending')).data.approvals.some((a) => a.request_id === request.request_id));
  }

  console.log('[단말기에 기록 없음 → 새로 발급 · 자진발급]');
  {
    const order = await cashSale();
    const requested = await issue(order.id);
    res = await pos('/payments/reconcile', { request_id: requested.data.bridge_request.request_id });
    const inquired = await bridge('/v1/inquire', res.data.bridge_request);
    res = await pos('/payments/reconcile', { request_id: requested.data.bridge_request.request_id, bridge_result: inquired.data });
    check('기록 없음 → NOT_FOUND', res.data.van_transaction.status === 'NOT_FOUND', res.data);
    const { saved } = await issueThroughBridge(order.id, { identity_input: 'SELF' }, null);
    check('번호 안 준 고객 → 자진발급 010-000-1234', saved.status === 201 && saved.data.van_transaction.masked_identity === '010-000-1234' && saved.data.van_transaction.identity_type === 'SELF', saved.data);
  }

  console.log('[카드만 결제한 판매는 발급 불가]');
  {
    const approveCard = async (cid) => {
      const rid = randomUUID();
      const started = await pos('/payments/approve', { client_sale_id: cid, request_id: rid, method: 'CARD', amount: 11000 });
      const approved = await bridge('/v1/approve', started.data.bridge_request);
      const done0 = await pos('/payments/approve', { client_sale_id: cid, request_id: rid, method: 'CARD', amount: 11000, bridge_result: approved.data });
      return [{ method: 'CARD', amount: 11000, van_transaction_id: done0.data.van_transaction.id }];
    };
    const cardOrder = await sale([{ product_id: taxable, quantity: 1 }], approveCard);
    res = await issue(cardOrder.id);
    check('현금·계좌이체 없음 → 400', res.status === 400 && /현금·계좌이체/.test(res.data.message), res.data);
  }

  console.log('[부분반품 → 현금영수증 단말기 취소 필수 → 남은 금액 재발급]');
  {
    const receipt = (await pos(`/sales/${mixedOrder.id}`)).data;
    const exemptItem = receipt.items.find((i) => i.product_id === exempt);
    const original = receipt.cash_receipts[0];
    const body = { reason: '면세 상품 반품', items: [{ order_item_id: exemptItem.id, quantity: 1 }], payments: [{ method: 'CASH', amount: 5000 }] };
    res = await pos(`/sales/${mixedOrder.id}/refunds`, body);
    const cancelRequest = res.data.cash_receipt_cancels?.[0];
    check('현금 환불 → 현금영수증 취소 먼저(409)', res.status === 409 && res.data.reason === 'CASH_RECEIPT_CANCEL_REQUIRED', res.data);
    check(
      '취소 요청 = 원승인번호 · 원거래일자 · 사유 1 · 원금액',
      cancelRequest.transaction_type === 'CASH_RECEIPT_CANCEL' && cancelRequest.original_approval_number === original.approval_number && /^\d{8}$/.test(cancelRequest.original_approved_at) && cancelRequest.cancel_reason === '1' && cancelRequest.amount === 16000,
      cancelRequest
    );
    check('반품은 아직 저장 안 됨', db.prepare('SELECT COUNT(*) AS n FROM orders WHERE original_order_id = ?').get(mixedOrder.id).n === 0);
    const canceled = await bridge('/v1/cash-receipt', { ...cancelRequest, request_id: randomUUID() });
    check('Bridge 현금영수증 취소', canceled.data.status === 'APPROVED' && canceled.data.original_approval_number === original.approval_number, canceled.data);
    res = await pos(`/sales/${mixedOrder.id}/refunds`, { ...body, cash_receipt_cancels: [{ original_approval_number: original.approval_number, bridge_result: canceled.data }] });
    check('취소 결과와 함께 반품 저장', res.status === 201, res.data);
    check('남은 현금 11,000원 재발급 안내', res.data.cash_receipt_reissue?.amount === 11000 && res.data.cash_receipt_reissue.purpose === 'INCOME', res.data.cash_receipt_reissue);
    check('반품 영수증에 현금영수증 취소', res.data.refund.cash_receipts?.[0]?.kind === 'CANCEL' && res.data.refund.cash_receipts[0].original_approval_number === original.approval_number, res.data.refund.cash_receipts);
    check('원래 현금영수증은 취소 처리', db.prepare("SELECT status FROM van_transactions WHERE order_id = ? AND transaction_type = 'CASH_RECEIPT' AND approval_number = ?").get(mixedOrder.id, original.approval_number).status === 'VOIDED');
    check('현금영수증 취소 감사 기록', audits('POS_CASH_RECEIPT_CANCEL') === 1);

    res = await pos(`/sales/${mixedOrder.id}/cash-receipt`);
    check('재발급 금액 = 남은 과세 11,000 · 면세 0', res.data.amounts.amount === 11000 && res.data.amounts.tax_free_amount === 0 && res.data.amounts.vat_amount === 1000, res.data.amounts);
    const { saved } = await issueThroughBridge(mixedOrder.id);
    check('남은 금액으로 재발급', saved.status === 201 && saved.data.van_transaction.amount === 11000, saved.data);
  }

  console.log('[판매 전체 취소 → 현금영수증 취소]');
  {
    const order = await cashSale();
    const { saved } = await issueThroughBridge(order.id);
    res = await pos(`/sales/${order.id}/cancel`, { reason: '고객 변심' });
    const request = res.data.cash_receipt_cancels?.[0];
    check('전체 취소도 현금영수증 취소 먼저', res.status === 409 && res.data.reason === 'CASH_RECEIPT_CANCEL_REQUIRED' && request.original_approval_number === saved.data.van_transaction.approval_number, res.data);
    const canceled = await bridge('/v1/cash-receipt', { ...request, request_id: randomUUID() });
    const declinedResult = { ...canceled.data, status: 'DECLINED', approval_number: null };
    res = await pos(`/sales/${order.id}/cancel`, { reason: '고객 변심', cash_receipt_cancels: [{ original_approval_number: request.original_approval_number, bridge_result: { ...declinedResult, signature: sign(bridgeKey, declinedResult) } }] });
    check('취소 거절 결과로는 판매 취소 안 함', res.status === 409 && res.data.reason === 'VAN_CANCEL_FAILED', res.data);
    res = await pos(`/sales/${order.id}/cancel`, { reason: '고객 변심', cash_receipt_cancels: [{ original_approval_number: request.original_approval_number, bridge_result: canceled.data }] });
    check('판매 취소 완료 · 재발급 안내 없음', res.status === 200 && !res.data.cash_receipt_reissue, res.data);
  }

  /* ================= 4. 데모 VAN 모드 자진발급 ================= */
  console.log('[데모 VAN 모드]');
  {
    await pos('/van/terminal', { van_mode: 'DEMO' }, 'PATCH');
    const order = await cashSale();
    res = await issue(order.id, { identity_input: 'SELF' });
    check('(데모) 자진발급 즉시 완료', res.status === 201 && res.data.van_transaction.masked_identity === '010-000-1234' && res.data.van_transaction.is_demo === true, res.data);
    const refund = await pos(`/sales/${order.id}/cancel`, { reason: '데모 취소' });
    check('(데모) 판매 취소 때 현금영수증 자동 취소', refund.status === 200 && refund.data.refund.cash_receipts?.[0]?.kind === 'CANCEL', refund.data);
    await pos('/van/terminal', { van_mode: 'MANUAL' }, 'PATCH');
    const manual = await cashSale();
    res = await issue(manual.id, { approval_number: '98761234' });
    check('수동: 단말기에서 발급한 승인번호 기록', res.status === 201 && res.data.van_transaction.source === 'MANUAL', res.data);
    res = await pos(`/sales/${manual.id}/cancel`, { reason: '수동 취소' });
    check('수동 발급분은 단말기에서 직접 취소하라고 안내', res.status === 200 && res.data.cash_receipt_notices?.some((n) => n.includes('98761234')), res.data);
  }

  db.close();
} catch (error) {
  console.error(error);
  check('예외 없이 끝남', false, error.message);
  if (server) console.error(server.log().slice(-3000));
} finally {
  if (server) await server.stop();
  if (bridgeProc) await bridgeProc.stop();
  await printer.close();
  rmSync(tempDir, { recursive: true, force: true });
}
done();
