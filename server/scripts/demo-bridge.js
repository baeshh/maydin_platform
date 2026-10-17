#!/usr/bin/env node
// MAYDIN Bridge (데모) — 카운터 PC에서 도는 로컬 프로그램을 흉내 낸다.
// 실제 Bridge는 여기서 카드 단말기·VAN Agent와 통신한다. 데모는 승인번호를 만들어 내고, 결과를 Bridge 키로 서명한다.
// 카드번호·결제 바코드는 받지도 저장하지도 않는다. 거래 기록(journal)에는 요청 번호·금액·승인번호만 남긴다.
//
// 실행: npm run bridge:demo   (기본 http://127.0.0.1:18181)
// 환경변수: BRIDGE_PORT, BRIDGE_STORE(설정·기록 파일), BRIDGE_ALLOWED_ORIGINS(쉼표 구분 POS 주소),
//           BRIDGE_SIMULATE=DECLINE|TIMEOUT_APPROVED|TIMEOUT_NOT_APPROVED (모든 승인·현금영수증에 적용)
//           BRIDGE_PRINTER=tcp://192.168.0.50:9100 | device:/dev/usb/lp0 | file:/폴더 (기본: data/bridge-prints 폴더에 저장)
//           BRIDGE_PRINTER_COLUMNS(기본 42, 58mm 용지는 32), BRIDGE_PRINTER_ENCODING(기본 cp949)
// 다음 한 건만 실패를 흉내 내려면: curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"next":"TIMEOUT_APPROVED"}'
// 출력 실패: -d '{"next_print":"PAPER_OUT"}' (PAPER_OUT·COVER_OPEN·OFFLINE·HANG) · 고객 키패드 입력: -d '{"keypad_identity":"01012345678"}'

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { BRIDGE_PROTOCOL, sign } = require('../src/pos/integrations/bridge-protocol');
const { IdentityError, SELF_ISSUE_IDENTITY, classifyIdentity } = require('../src/pos/integrations/cash-identity');
const { render, renderText } = require('../src/pos/printing/escpos');
const { parseTarget, printerStatus, sendToPrinter } = require('../src/pos/printing/printer-transport');

const PORT = Number(process.env.BRIDGE_PORT || 18181);
const STORE = process.env.BRIDGE_STORE || path.join(__dirname, '..', 'data', 'demo-bridge.json');
const ALLOWED_ORIGINS = (process.env.BRIDGE_ALLOWED_ORIGINS || 'http://localhost:3001,http://127.0.0.1:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const SIMULATIONS = ['DECLINE', 'TIMEOUT_APPROVED', 'TIMEOUT_NOT_APPROVED'];
const CARD_COMPANIES = ['신한카드', '삼성카드', 'KB국민카드', '현대카드', '롯데카드', '하나카드', 'BC카드', 'NH농협카드'];
const MAX_JOURNAL = 500;
const PRINT_SIMULATIONS = ['PAPER_OUT', 'COVER_OPEN', 'OFFLINE', 'HANG'];
const PRINTER = parseTarget(process.env.BRIDGE_PRINTER || `file:${path.join(path.dirname(STORE), 'bridge-prints')}`);
const PRINTER_COLUMNS = Number(process.env.BRIDGE_PRINTER_COLUMNS || 42);
const PRINTER_ENCODING = process.env.BRIDGE_PRINTER_ENCODING || 'cp949';

let nextSimulation = null;
let nextPrintSimulation = null;
let keypadIdentity = null;
const printing = new Set();

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { terminal_id: null, bridge_key: null, journal: {} };
  }
}

const store = load();

function save() {
  const ids = Object.keys(store.journal);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_JOURNAL))) delete store.journal[id];
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function signed(payload) {
  return { ...payload, signature: sign(store.bridge_key, payload) };
}

function result(request, fields) {
  return {
    protocol: BRIDGE_PROTOCOL,
    terminal_id: store.terminal_id,
    request_id: request.request_id,
    method: request.method,
    amount: Number(request.amount),
    installment_months: Number(request.installment_months || 0),
    occurred_at: new Date().toISOString(),
    demo: true,
    ...fields
  };
}

function approvalNumber() {
  return String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

class BridgeFail extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function checkRequest(request, type) {
  if (!store.bridge_key) throw new BridgeFail('Bridge가 카운터와 연결되지 않았습니다. POS 카운터 관리에서 Bridge 키를 넣어 주세요.', 409);
  if (request.protocol && request.protocol !== BRIDGE_PROTOCOL) throw new BridgeFail('지원하지 않는 Bridge 규격입니다.');
  if (String(request.terminal_id) !== String(store.terminal_id)) {
    throw new BridgeFail(`이 Bridge는 카운터 #${store.terminal_id}용입니다. 다른 카운터 요청은 처리하지 않습니다.`, 409);
  }
  if (!/^[0-9A-Za-z-]{16,64}$/.test(String(request.request_id || ''))) throw new BridgeFail('요청 번호가 올바르지 않습니다.');
  if (!['CARD', 'EASY_PAY'].includes(request.method)) throw new BridgeFail('결제수단이 올바르지 않습니다.');
  if (!Number.isInteger(Number(request.amount)) || Number(request.amount) <= 0) throw new BridgeFail('금액이 올바르지 않습니다.');
  if (type === 'CANCEL' && !request.original_approval_number) throw new BridgeFail('원승인번호가 필요합니다.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HANG = Symbol('hang');

async function approve(request) {
  checkRequest(request, 'APPROVE');
  // 같은 요청 번호는 다시 승인하지 않고 처음 결과를 돌려준다.
  const known = store.journal[request.request_id];
  if (known) return signed(known);

  const simulate = nextSimulation || (SIMULATIONS.includes(process.env.BRIDGE_SIMULATE) ? process.env.BRIDGE_SIMULATE : null);
  nextSimulation = null;
  await sleep(1200);
  if (simulate === 'TIMEOUT_NOT_APPROVED') return HANG;
  if (simulate === 'DECLINE') {
    const declined = result(request, { transaction_type: 'APPROVE', status: 'DECLINED', message: '[데모] 카드사 거절 (한도 초과)' });
    store.journal[request.request_id] = declined;
    save();
    return signed(declined);
  }
  const approved = result(request, {
    transaction_type: 'APPROVE',
    status: 'APPROVED',
    approval_number: approvalNumber(),
    card_company: request.method === 'CARD' ? CARD_COMPANIES[crypto.randomInt(0, CARD_COMPANIES.length)] : '간편결제',
    van_reference: `BRG-${request.request_id.slice(0, 8)}`,
    message: '[데모] Bridge 승인 완료'
  });
  store.journal[request.request_id] = approved;
  save();
  return simulate === 'TIMEOUT_APPROVED' ? HANG : signed(approved);
}

async function cancel(request) {
  checkRequest(request, 'CANCEL');
  const known = store.journal[request.request_id];
  if (known) return signed(known);
  await sleep(800);
  const canceled = result(request, {
    transaction_type: 'CANCEL',
    status: 'APPROVED',
    approval_number: approvalNumber(),
    original_approval_number: request.original_approval_number,
    van_reference: `BRG-C-${request.request_id.slice(0, 8)}`,
    message: '[데모] Bridge 승인 취소 완료'
  });
  store.journal[request.request_id] = canceled;
  save();
  return signed(canceled);
}

// 결과를 모르는 승인·현금영수증 발급을 요청 번호로 조회한다. 다시 승인하지 않는다.
function inquire(request) {
  if (request.transaction_type === 'CASH_RECEIPT') {
    checkCashReceipt(request);
    const known = store.journal[request.request_id];
    if (known) return signed(known);
    return signed({
      protocol: BRIDGE_PROTOCOL,
      terminal_id: store.terminal_id,
      request_id: request.request_id,
      transaction_type: 'CASH_RECEIPT',
      method: 'CASH',
      amount: Number(request.amount),
      purpose: request.purpose,
      status: 'NOT_FOUND',
      occurred_at: new Date().toISOString(),
      demo: true,
      message: '[데모] 단말기에 이 요청의 발급 기록이 없습니다.'
    });
  }
  checkRequest(request, 'APPROVE');
  const known = store.journal[request.request_id];
  if (known) return signed(known);
  return signed(result(request, { transaction_type: 'APPROVE', status: 'NOT_FOUND', message: '[데모] 단말기에 이 요청의 승인 기록이 없습니다.' }));
}

/* ---------- 현금영수증 ---------- */

// 식별번호는 단말기 키패드(TERMINAL) 또는 POS 화면(POS)에서 이 Bridge로만 온다. 가린 번호만 결과에 담는다.
function checkCashReceipt(request) {
  if (!store.bridge_key) throw new BridgeFail('Bridge가 카운터와 연결되지 않았습니다. POS 카운터 관리에서 Bridge 키를 넣어 주세요.', 409);
  if (request.protocol && request.protocol !== BRIDGE_PROTOCOL) throw new BridgeFail('지원하지 않는 Bridge 규격입니다.');
  if (String(request.terminal_id) !== String(store.terminal_id)) {
    throw new BridgeFail(`이 Bridge는 카운터 #${store.terminal_id}용입니다. 다른 카운터 요청은 처리하지 않습니다.`, 409);
  }
  if (!/^[0-9A-Za-z-]{16,64}$/.test(String(request.request_id || ''))) throw new BridgeFail('요청 번호가 올바르지 않습니다.');
  if (!['CASH_RECEIPT', 'CASH_RECEIPT_CANCEL'].includes(request.transaction_type)) throw new BridgeFail('현금영수증 거래 종류가 올바르지 않습니다.');
  if (!Number.isInteger(Number(request.amount)) || Number(request.amount) <= 0) throw new BridgeFail('금액이 올바르지 않습니다.');
  if (!['INCOME', 'EXPENSE'].includes(request.purpose)) throw new BridgeFail('발급 용도(소득공제·지출증빙)가 올바르지 않습니다.');
  if (request.transaction_type === 'CASH_RECEIPT_CANCEL') {
    if (!request.original_approval_number) throw new BridgeFail('원승인번호가 필요합니다.');
    if (!/^\d{8}$/.test(String(request.original_approved_at || ''))) throw new BridgeFail('원거래일자(YYYYMMDD)가 필요합니다.');
    if (!['1', '2', '3'].includes(String(request.cancel_reason || ''))) throw new BridgeFail('취소 사유 코드(1 거래취소 · 2 오류발급 · 3 기타)가 필요합니다.');
  }
}

function identityFor(request) {
  if (request.identity_input === 'SELF') return { type: 'SELF', masked: SELF_ISSUE_IDENTITY };
  // 데모: 고객이 단말기 키패드에 번호를 누른 것으로 친다.
  const raw = request.identity_input === 'POS' ? request.identity : keypadIdentity || `010${String(crypto.randomInt(0, 1e8)).padStart(8, '0')}`;
  keypadIdentity = null;
  try {
    return classifyIdentity(raw);
  } catch (error) {
    if (error instanceof IdentityError) throw new BridgeFail(error.message);
    throw error;
  }
}

async function cashReceipt(request) {
  checkCashReceipt(request);
  const known = store.journal[request.request_id];
  if (known) return signed(known);
  const isCancel = request.transaction_type === 'CASH_RECEIPT_CANCEL';
  const identity = isCancel ? null : identityFor(request);

  const simulate = nextSimulation || (SIMULATIONS.includes(process.env.BRIDGE_SIMULATE) ? process.env.BRIDGE_SIMULATE : null);
  nextSimulation = null;
  await sleep(600);
  if (simulate === 'TIMEOUT_NOT_APPROVED') return HANG;
  const base = {
    protocol: BRIDGE_PROTOCOL,
    terminal_id: store.terminal_id,
    request_id: request.request_id,
    transaction_type: request.transaction_type,
    method: 'CASH',
    amount: Number(request.amount),
    purpose: request.purpose,
    occurred_at: new Date().toISOString(),
    demo: true
  };
  if (simulate === 'DECLINE') {
    const declined = { ...base, status: 'DECLINED', message: '[데모] 국세청 발급 거절 (식별번호 오류)' };
    store.journal[request.request_id] = declined;
    save();
    return signed(declined);
  }
  const done = {
    ...base,
    status: 'APPROVED',
    approval_number: approvalNumber(),
    van_reference: `BRG-R-${request.request_id.slice(0, 8)}`,
    ...(isCancel
      ? {
          original_approval_number: request.original_approval_number,
          original_approved_at: request.original_approved_at,
          cancel_reason: String(request.cancel_reason),
          message: '[데모] 현금영수증 취소 완료'
        }
      : {
          identity_type: identity.type,
          masked_identity: identity.masked,
          message: `[데모] 현금영수증 ${request.purpose === 'EXPENSE' ? '지출증빙' : '소득공제'} 발급 완료`
        })
  };
  store.journal[request.request_id] = done;
  save();
  return simulate === 'TIMEOUT_APPROVED' ? HANG : signed(done);
}

/* ---------- 영수증 출력 ---------- */

function documentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

// 같은 작업 번호는 한 번만 출력한다. 이미 출력했으면 다시 뽑지 않고 처음 결과를 돌려준다(응답이 끊겨 POS가 다시 보낸 경우).
async function print(request) {
  if (!store.bridge_key) throw new BridgeFail('Bridge가 카운터와 연결되지 않았습니다.', 409);
  if (String(request.terminal_id) !== String(store.terminal_id)) {
    throw new BridgeFail(`이 Bridge는 카운터 #${store.terminal_id}용입니다. 다른 카운터 요청은 처리하지 않습니다.`, 409);
  }
  const jobId = String(request.job_id || '');
  if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new BridgeFail('출력 작업 번호가 올바르지 않습니다.');
  const document = request.document;
  if (!document || !Array.isArray(document.lines)) throw new BridgeFail('출력할 영수증이 없습니다.');
  const hash = documentHash(document);
  if (request.document_hash && request.document_hash !== hash) throw new BridgeFail('영수증 내용이 서버가 만든 것과 다릅니다. 다시 요청해 주세요.');

  store.prints = store.prints || {};
  const key = `print:${jobId}`;
  const known = store.journal[key];
  if (known && known.status === 'PRINTED') return signed(known);
  if (printing.has(jobId)) throw new BridgeFail('이 영수증을 출력하는 중입니다.', 409);
  printing.add(jobId);
  try {
    const simulate = nextPrintSimulation;
    nextPrintSimulation = null;
    let outcome;
    if (simulate && simulate !== 'HANG') {
      const messages = { PAPER_OUT: '용지가 없습니다. 용지를 넣어 주세요', COVER_OPEN: '프린터 덮개가 열려 있습니다', OFFLINE: '프린터에 연결할 수 없습니다' };
      outcome = { status: 'FAILED', error_code: simulate, message: `[데모] ${messages[simulate]}` };
    } else {
      const bytes = render(document, { columns: PRINTER_COLUMNS, encoding: PRINTER_ENCODING });
      outcome = await sendToPrinter(PRINTER, bytes, { jobId, preview: renderText(document, { columns: PRINTER_COLUMNS }) });
    }
    if (outcome.status === 'PRINTED') store.prints[jobId] = (store.prints[jobId] || 0) + 1;
    const done = {
      protocol: BRIDGE_PROTOCOL,
      terminal_id: store.terminal_id,
      request_id: jobId,
      transaction_type: 'PRINT',
      status: outcome.status,
      error_code: outcome.error_code || null,
      message: outcome.message || null,
      document_hash: hash,
      occurred_at: new Date().toISOString(),
      demo: true
    };
    store.journal[key] = done;
    save();
    return simulate === 'HANG' ? HANG : signed(done);
  } finally {
    printing.delete(jobId);
  }
}

async function printJobStatus(request) {
  const known = store.journal[`print:${String(request.job_id || '')}`];
  if (!known) return { job_id: request.job_id, status: 'NOT_FOUND', message: '이 Bridge에 출력 기록이 없습니다.' };
  return signed(known);
}

function pair(body) {
  const terminalId = Number(body.terminal_id);
  if (!Number.isInteger(terminalId) || terminalId <= 0) throw new BridgeFail('카운터 번호가 올바르지 않습니다.');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(body.bridge_key || ''))) throw new BridgeFail('Bridge 키 형식이 올바르지 않습니다.');
  const changed = store.terminal_id !== terminalId;
  store.terminal_id = terminalId;
  store.bridge_key = body.bridge_key;
  if (changed) {
    store.journal = {};
    store.prints = {};
  }
  save();
  console.log(`[bridge] 카운터 #${terminalId}와 연결했습니다.`);
  return { paired: true, terminal_id: terminalId };
}

/* ---------- HTTP ---------- */

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 공개 주소의 POS 화면이 이 PC의 로컬 주소로 요청할 때(Private Network Access) 필요하다.
  if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return true;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 200000) reject(new BridgeFail('요청이 너무 큽니다.', 413));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new BridgeFail('JSON 형식이 아닙니다.'));
      }
    });
    req.on('error', reject);
  });
}

const routes = {
  'GET /v1/status': () => ({
    protocol: BRIDGE_PROTOCOL,
    demo: true,
    paired: Boolean(store.bridge_key),
    terminal_id: store.terminal_id,
    device: '데모 카드 단말기',
    printer: PRINTER.kind === 'none' ? null : { kind: PRINTER.kind, columns: PRINTER_COLUMNS, encoding: PRINTER_ENCODING },
    features: ['APPROVE', 'CANCEL', 'INQUIRE', 'CASH_RECEIPT', 'CASH_RECEIPT_CANCEL', 'PRINT']
  }),
  'GET /v1/printer/status': () => printerStatus(PRINTER),
  'POST /v1/pair': pair,
  'POST /v1/approve': approve,
  'POST /v1/cancel': cancel,
  'POST /v1/inquire': inquire,
  'POST /v1/cash-receipt': cashReceipt,
  'POST /v1/print': print,
  'POST /v1/print/status': printJobStatus,
  'GET /v1/demo/prints': () => ({ prints: store.prints || {} }),
  'POST /v1/demo/simulate': (body) => {
    if (body.next && !SIMULATIONS.includes(body.next)) throw new BridgeFail(`next는 ${SIMULATIONS.join(', ')} 중 하나입니다.`);
    if (body.next_print && !PRINT_SIMULATIONS.includes(body.next_print)) throw new BridgeFail(`next_print는 ${PRINT_SIMULATIONS.join(', ')} 중 하나입니다.`);
    if ('next' in body) nextSimulation = body.next || null;
    if ('next_print' in body) nextPrintSimulation = body.next_print || null;
    if ('keypad_identity' in body) keypadIdentity = body.keypad_identity || null;
    return { next: nextSimulation, next_print: nextPrintSimulation, keypad_identity: keypadIdentity ? '(입력됨)' : null };
  }
};

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) return send(res, 403, { message: '허용되지 않은 POS 주소입니다. BRIDGE_ALLOWED_ORIGINS를 확인해 주세요.' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const handler = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!handler) return send(res, 404, { message: '없는 Bridge 주소입니다.' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await handler(body);
    if (out === HANG) {
      console.log(`[bridge] (데모) 응답 끊김 흉내 · ${body.request_id || body.job_id}`);
      return setTimeout(() => req.socket.destroy(), 120000);
    }
    console.log(`[bridge] ${req.method} ${req.url} → ${out.status || 'OK'}${out.approval_number ? ` · ${out.approval_number}` : ''}`);
    return send(res, 200, out);
  } catch (error) {
    if (!(error instanceof BridgeFail)) console.error(error);
    return send(res, error.status || 500, { message: error instanceof BridgeFail ? error.message : 'Bridge 내부 오류' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MAYDIN Bridge (데모) · http://127.0.0.1:${PORT} · ${BRIDGE_PROTOCOL}`);
  console.log(`허용 POS 주소: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(store.bridge_key ? `카운터 #${store.terminal_id}와 연결됨` : '아직 카운터와 연결되지 않았습니다. POS 카운터 관리 → Bridge 연결에서 키를 넣어 주세요.');
});
