const crypto = require('crypto');
const { getAll, getOne, run } = require('../../db');
const { verifyPrintResult } = require('../integrations/bridge-adapter');
const { BRIDGE_PROTOCOL } = require('../integrations/bridge-protocol');
const { documentHash, receiptDocument, testDocument } = require('../printing/receipt-document');
const { PosError } = require('../common');
const { buildReceipt, getPosOrder } = require('./sale-service');
const { PRINTER_MODES, printerSettings } = require('./terminal-service');

// 영수증 출력 작업. 서버가 영수증 문서를 만들고, 이 카운터 PC의 Bridge가 영수증 프린터로 직접 출력한 뒤 서명한 결과를 돌려준다.
// 같은 작업 번호(job_id)는 Bridge가 한 번만 출력한다. 실패한 작업은 같은 번호로 다시 보내고, 이미 출력한 판매를 또 뽑으면 재출력으로 표시한다.

const OPEN_STATUSES = ['REQUESTED', 'FAILED'];
const MAX_HASHES = 20;

function requestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function getJob(req, jobId) {
  const job = getOne(
    `SELECT j.*, o.order_number FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id
     WHERE j.pharmacy_id = @pharmacy_id AND j.job_id = @job_id`,
    { pharmacy_id: req.pharmacyId, job_id: String(jobId || '') }
  );
  if (!job) throw new PosError('출력 작업을 찾을 수 없습니다.', 404);
  return job;
}

function publicJob(job) {
  return job && {
    id: job.id,
    job_id: job.job_id,
    order_id: job.order_id,
    order_number: job.order_number || null,
    document_type: job.document_type,
    copy_type: job.copy_type,
    channel: job.channel,
    status: job.status,
    open_drawer: job.open_drawer === 1,
    error_code: job.error_code,
    message: job.message,
    attempts: job.attempts,
    created_at: job.created_at,
    printed_at: job.printed_at
  };
}

function reload(req, job) {
  return getJob(req, job.job_id);
}

function buildDocument(req, terminal, job, { firstAttempt }) {
  if (job.document_type === 'TEST') return testDocument({ terminalName: terminal.terminal_name, printedAt: job.created_at });
  return receiptDocument(buildReceipt(req, job.order_id), {
    copyType: job.copy_type,
    printedAt: job.created_at,
    // 돈통은 처음 보낼 때만 연다. 다시 보낼 때 또 열리지 않게 한다.
    openDrawer: firstAttempt && job.open_drawer === 1,
    origin: requestOrigin(req)
  });
}

// Bridge에 보낼 출력 요청. 같은 작업을 다시 보낼 때 내용이 바뀌었을 수 있어(포인트 잔액 등) 보낸 문서 해시를 모두 남긴다.
function printRequest(req, terminal, job, { firstAttempt = false } = {}) {
  const document = buildDocument(req, terminal, job, { firstAttempt });
  const hash = documentHash(document);
  const hashes = JSON.parse(job.document_hashes || '[]');
  if (!hashes.includes(hash)) {
    hashes.push(hash);
    run('UPDATE pos_print_jobs SET document_hashes = @hashes, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
      id: job.id,
      hashes: JSON.stringify(hashes.slice(-MAX_HASHES))
    });
  }
  return { protocol: BRIDGE_PROTOCOL, terminal_id: terminal.id, job_id: job.job_id, transaction_type: 'PRINT', document, document_hash: hash };
}

function requireBridgePrinter(terminal) {
  if (!terminal.bridge_key_enc) {
    throw new PosError('이 카운터에 연결된 Bridge가 없어 프린터로 직접 출력할 수 없습니다. 브라우저 인쇄를 쓰거나 Bridge를 연결해 주세요.', 409, 'BRIDGE_NOT_PAIRED');
  }
}

function insertJob(req, terminal, fields) {
  const jobId = crypto.randomUUID();
  run(
    `INSERT INTO pos_print_jobs (pharmacy_id, terminal_id, order_id, job_id, document_type, copy_type, channel, status, open_drawer, message, created_by, printed_at)
     VALUES (@pharmacy_id, @terminal_id, @order_id, @job_id, @document_type, @copy_type, @channel, @status, @open_drawer, @message, @created_by,
             CASE WHEN @status = 'PRINTED' THEN CURRENT_TIMESTAMP END)`,
    {
      pharmacy_id: req.pharmacyId,
      terminal_id: terminal.id,
      job_id: jobId,
      order_id: null,
      open_drawer: 0,
      message: null,
      created_by: req.user.id,
      ...fields
    }
  );
  return getJob(req, jobId);
}

// 판매 영수증 출력 작업을 만든다. 이미 출력한 판매면 재출력으로 표시한다.
// 같은 판매에 아직 결과가 없거나 실패한 Bridge 작업이 있으면 새로 만들지 않고 그 작업을 다시 보낸다(이중 출력 방지).
function createReceiptJob(req, terminal, { orderId, channel }) {
  const order = getPosOrder(req, orderId);
  const settings = printerSettings(terminal);
  const target = String(channel || settings.mode).toUpperCase();
  if (!PRINTER_MODES[target]) throw new PosError('출력 방법이 올바르지 않습니다.');

  if (target === 'BRIDGE') {
    requireBridgePrinter(terminal);
    const open = getOne(
      `SELECT job_id FROM pos_print_jobs
       WHERE order_id = @order_id AND terminal_id = @terminal_id AND channel = 'BRIDGE' AND status IN ('REQUESTED', 'FAILED')
       ORDER BY id DESC LIMIT 1`,
      { order_id: order.id, terminal_id: terminal.id }
    );
    if (open) {
      const job = getJob(req, open.job_id);
      run("UPDATE pos_print_jobs SET status = 'REQUESTED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: job.id });
      return { job: reload(req, job), printRequest: printRequest(req, terminal, job, { firstAttempt: job.attempts === 0 }), resumed: true };
    }
  }

  const printed = getOne("SELECT id FROM pos_print_jobs WHERE order_id = @order_id AND status = 'PRINTED' LIMIT 1", { order_id: order.id });
  const copyType = printed ? 'REPRINT' : 'ORIGINAL';
  const cashMoved = getOne("SELECT id FROM payments WHERE order_id = @id AND payment_method = 'CASH' LIMIT 1", { id: order.id });
  const openDrawer = copyType === 'ORIGINAL' && settings.open_drawer && Boolean(cashMoved);

  if (target === 'BROWSER') {
    // 브라우저 인쇄는 프린터에서 실제로 나왔는지 서버가 알 수 없다. 인쇄 창을 연 것을 출력으로 기록한다.
    const job = insertJob(req, terminal, {
      order_id: order.id,
      document_type: 'RECEIPT',
      copy_type: copyType,
      channel: 'BROWSER',
      status: 'PRINTED',
      message: '브라우저 인쇄 (실제 출력 여부는 확인 불가)'
    });
    return { job, receipt: buildReceipt(req, order.id) };
  }

  const job = insertJob(req, terminal, {
    order_id: order.id,
    document_type: 'RECEIPT',
    copy_type: copyType,
    channel: 'BRIDGE',
    status: 'REQUESTED',
    open_drawer: openDrawer ? 1 : 0
  });
  return { job, printRequest: printRequest(req, terminal, job, { firstAttempt: true }) };
}

function createTestJob(req, terminal) {
  requireBridgePrinter(terminal);
  const job = insertJob(req, terminal, { document_type: 'TEST', copy_type: 'ORIGINAL', channel: 'BRIDGE', status: 'REQUESTED' });
  return { job, printRequest: printRequest(req, terminal, job, { firstAttempt: true }) };
}

function requireOwnJob(terminal, job) {
  if (job.terminal_id !== terminal.id) throw new PosError('다른 카운터의 출력 작업입니다. 그 카운터에서 처리해 주세요.', 403);
}

// Bridge 출력 결과를 반영한다. 출력된 작업은 나중에 온 실패 결과로 되돌리지 않는다.
function recordPrintResult(req, terminal, job, raw) {
  requireOwnJob(terminal, job);
  if (job.channel !== 'BRIDGE') throw new PosError('Bridge 출력 작업이 아닙니다.', 409);
  const hashes = JSON.parse(job.document_hashes || '[]');
  const expectedHash = hashes.includes(raw?.document_hash) ? raw.document_hash : hashes[hashes.length - 1];
  const outcome = verifyPrintResult(terminal, raw, { jobId: job.job_id, documentHash: expectedHash });
  if (job.status === 'PRINTED') return { job, unchanged: true };
  if (job.status === 'CANCELED' && outcome.status !== 'PRINTED') return { job, unchanged: true };
  run(
    `UPDATE pos_print_jobs
     SET status = @status, error_code = @error_code, message = @message, attempts = attempts + 1,
         printed_at = CASE WHEN @status = 'PRINTED' THEN CURRENT_TIMESTAMP ELSE printed_at END, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    {
      id: job.id,
      status: outcome.status,
      error_code: outcome.errorCode,
      message: outcome.message || (outcome.status === 'PRINTED' ? '프린터 출력 완료' : '프린터 출력 실패')
    }
  );
  return { job: reload(req, job) };
}

function requireOpen(job) {
  if (job.status === 'PRINTED') throw new PosError('이미 출력된 영수증입니다. 다시 뽑으려면 재출력을 눌러 주세요.', 409, 'ALREADY_PRINTED');
  if (!OPEN_STATUSES.includes(job.status)) throw new PosError('출력하지 않기로 한 작업입니다.', 409);
}

// 실패·결과 모름 작업을 같은 작업 번호로 다시 보낸다. Bridge가 이미 출력했으면 다시 뽑지 않고 그 결과를 돌려준다.
function retryPrintJob(req, terminal, job) {
  requireOwnJob(terminal, job);
  if (job.channel !== 'BRIDGE') throw new PosError('Bridge 출력 작업이 아닙니다.', 409);
  requireOpen(job);
  requireBridgePrinter(terminal);
  run("UPDATE pos_print_jobs SET status = 'REQUESTED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: job.id });
  return { job: reload(req, job), printRequest: printRequest(req, terminal, job, { firstAttempt: job.attempts === 0 }) };
}

// 프린터를 쓸 수 없을 때 브라우저 인쇄로 대신 출력한다.
function browserFallback(req, terminal, job) {
  requireOwnJob(terminal, job);
  requireOpen(job);
  if (job.document_type !== 'RECEIPT') throw new PosError('시험 출력은 브라우저로 대신하지 않습니다.', 409);
  run(
    `UPDATE pos_print_jobs SET channel = 'BROWSER', status = 'PRINTED', printed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
            message = '프린터 대신 브라우저 인쇄 (실제 출력 여부는 확인 불가)'
     WHERE id = @id`,
    { id: job.id }
  );
  return { job: reload(req, job), receipt: buildReceipt(req, job.order_id) };
}

// 고객이 영수증을 받지 않고 떠났을 때 등. 미출력 목록에서 뺀다.
function skipPrintJob(req, terminal, job) {
  requireOwnJob(terminal, job);
  requireOpen(job);
  run("UPDATE pos_print_jobs SET status = 'CANCELED', message = '출력 안 함', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: job.id });
  return { job: reload(req, job) };
}

// 이 카운터에서 출력하지 못한(실패·결과 모름) 영수증. 최근 2일만 보여 준다.
function openPrintJobs(terminal) {
  return getAll(
    `SELECT j.*, o.order_number FROM pos_print_jobs j LEFT JOIN orders o ON o.id = j.order_id
     WHERE j.terminal_id = @terminal_id AND j.channel = 'BRIDGE' AND j.status IN ('REQUESTED', 'FAILED')
       AND j.created_at >= datetime('now', '-2 days')
     ORDER BY j.id DESC LIMIT 50`,
    { terminal_id: terminal.id }
  ).map(publicJob);
}

module.exports = {
  browserFallback,
  createReceiptJob,
  createTestJob,
  getJob,
  openPrintJobs,
  publicJob,
  recordPrintResult,
  retryPrintJob,
  skipPrintJob
};
