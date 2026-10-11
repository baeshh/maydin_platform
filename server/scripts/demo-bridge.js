#!/usr/bin/env node
// MAYDIN Bridge (데모) — 카운터 PC에서 도는 로컬 프로그램을 흉내 낸다.
// 실제 Bridge는 여기서 카드 단말기·VAN Agent와 통신한다. 데모는 승인번호를 만들어 내고, 결과를 Bridge 키로 서명한다.
// 카드번호·결제 바코드는 받지도 저장하지도 않는다. 거래 기록(journal)에는 요청 번호·금액·승인번호만 남긴다.
//
// 실행: npm run bridge:demo   (기본 http://127.0.0.1:18181)
// 환경변수: BRIDGE_PORT, BRIDGE_STORE(설정·기록 파일), BRIDGE_ALLOWED_ORIGINS(쉼표 구분 POS 주소),
//           BRIDGE_SIMULATE=DECLINE|TIMEOUT_APPROVED|TIMEOUT_NOT_APPROVED (모든 승인에 적용)
// 다음 한 건만 실패를 흉내 내려면: curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"next":"TIMEOUT_APPROVED"}'

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { BRIDGE_PROTOCOL, sign } = require('../src/pos/integrations/bridge-protocol');

const PORT = Number(process.env.BRIDGE_PORT || 18181);
const STORE = process.env.BRIDGE_STORE || path.join(__dirname, '..', 'data', 'demo-bridge.json');
const ALLOWED_ORIGINS = (process.env.BRIDGE_ALLOWED_ORIGINS || 'http://localhost:3001,http://127.0.0.1:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const SIMULATIONS = ['DECLINE', 'TIMEOUT_APPROVED', 'TIMEOUT_NOT_APPROVED'];
const CARD_COMPANIES = ['신한카드', '삼성카드', 'KB국민카드', '현대카드', '롯데카드', '하나카드', 'BC카드', 'NH농협카드'];
const MAX_JOURNAL = 500;

let nextSimulation = null;

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

function inquire(request) {
  checkRequest(request, 'APPROVE');
  const known = store.journal[request.request_id];
  if (known) return signed(known);
  return signed(result(request, { transaction_type: 'APPROVE', status: 'NOT_FOUND', message: '[데모] 단말기에 이 요청의 승인 기록이 없습니다.' }));
}

function pair(body) {
  const terminalId = Number(body.terminal_id);
  if (!Number.isInteger(terminalId) || terminalId <= 0) throw new BridgeFail('카운터 번호가 올바르지 않습니다.');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(String(body.bridge_key || ''))) throw new BridgeFail('Bridge 키 형식이 올바르지 않습니다.');
  const changed = store.terminal_id !== terminalId;
  store.terminal_id = terminalId;
  store.bridge_key = body.bridge_key;
  if (changed) store.journal = {};
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
      if (raw.length > 10000) reject(new BridgeFail('요청이 너무 큽니다.', 413));
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
    device: '데모 카드 단말기'
  }),
  'POST /v1/pair': pair,
  'POST /v1/approve': approve,
  'POST /v1/cancel': cancel,
  'POST /v1/inquire': inquire,
  'POST /v1/demo/simulate': (body) => {
    if (body.next && !SIMULATIONS.includes(body.next)) throw new BridgeFail(`next는 ${SIMULATIONS.join(', ')} 중 하나입니다.`);
    nextSimulation = body.next || null;
    return { next: nextSimulation };
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
      console.log(`[bridge] (데모) 응답 끊김 흉내 · ${body.request_id}`);
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
