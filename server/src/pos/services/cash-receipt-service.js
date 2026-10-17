const crypto = require('crypto');
const { getAll, getOne, run } = require('../../db');
const { TEST_PAYMENTS_DISABLED, testPaymentsAllowed } = require('../../services/payment-policy');
const { splitVat } = require('../../services/tax');
const { adapterFor } = require('../integrations');
const { SELF_ISSUE_IDENTITY, classifyIdentity } = require('../integrations/cash-identity');
const { BRIDGE_PROTOCOL } = require('../integrations/bridge-protocol');
const { PosError, audit, cleanText, won } = require('../common');
const { PENDING_STATUSES, demoRejected, findByRequest, getVan, insertVan, parseRequestId, requireBridgeAdapter } = require('./payment-service');
const { refundablePaymentBalances } = require('./refund-service');

// 현금영수증. 판매를 저장한 뒤 그 판매의 현금·계좌이체 금액으로 발급한다(금액은 서버가 정한다).
// 식별번호(휴대폰·현금영수증카드·사업자번호)는 단말기 키패드나 이 PC의 Bridge로만 가고 서버에는 오지 않는다.
// 서버에는 Bridge가 가려서 서명한 번호(예: 010-****-5678)만 남는다. 주민등록번호는 받지 않는다.

const PURPOSES = { INCOME: '소득공제', EXPENSE: '지출증빙' };
// TERMINAL: 고객이 단말기 키패드에 입력 · POS: 직원이 이 화면에 입력해 Bridge로만 보냄 · SELF: 국세청 자진발급 번호
const IDENTITY_INPUTS = ['TERMINAL', 'POS', 'SELF'];
// VAN 현금영수증 취소 사유 코드: 1 거래취소 · 2 오류발급 · 3 기타
const CANCEL_REASONS = { 1: '거래취소', 2: '오류발급', 3: '기타' };
const ELIGIBLE_METHODS = ['CASH', 'TRANSFER'];

function localDate(value) {
  return getOne("SELECT strftime('%Y%m%d', @value, 'localtime') AS d", { value }).d;
}

// 발급할 금액 = 이 판매의 현금·계좌이체 잔액(반품 뒤 금액). 과세·면세 비율은 남은 상품 기준으로 나눈다.
function cashReceiptAmounts(orderId) {
  const balances = refundablePaymentBalances(orderId);
  const amount = ELIGIBLE_METHODS.reduce((sum, method) => sum + Math.max(0, balances[method] || 0), 0);
  const items = getAll('SELECT total_price, discount_amount, refunded_amount, tax_type FROM order_items WHERE order_id = @id', { id: orderId });
  let taxable = 0;
  let total = 0;
  for (const item of items) {
    const net = (item.total_price || 0) - (item.discount_amount || 0) - (item.refunded_amount || 0);
    total += net;
    if ((item.tax_type || 'TAXABLE') !== 'EXEMPT') taxable += net;
  }
  const taxablePart = total > 0 ? Math.round((amount * taxable) / total) : amount;
  const { supply, vat } = splitVat(taxablePart);
  return { amount, supply_amount: supply, vat_amount: vat, tax_free_amount: amount - taxablePart, service_charge: 0 };
}

function receiptsOf(orderId, statuses) {
  return getAll(
    `SELECT * FROM van_transactions
     WHERE order_id = @order_id AND transaction_type = 'CASH_RECEIPT' AND status IN (${statuses.map((s) => `'${s}'`).join(', ')})
     ORDER BY id ASC`,
    { order_id: orderId }
  );
}

const activeCashReceipts = (orderId) => receiptsOf(orderId, ['USED']);

// 영수증에 싣는 현금영수증: 판매는 발급, 반품은 취소 기록.
function receiptCashReceipts(order) {
  const rows =
    order.order_type === 'POS_REFUND'
      ? getAll("SELECT * FROM van_transactions WHERE order_id = @id AND transaction_type = 'CASH_RECEIPT_CANCEL' ORDER BY id", { id: order.id })
      : receiptsOf(order.id, ['USED']);
  return rows.map((tx) => ({
    kind: tx.transaction_type === 'CASH_RECEIPT_CANCEL' ? 'CANCEL' : 'ISSUE',
    approval_number: tx.approval_number,
    original_approval_number: tx.original_approval_number,
    masked_identity: tx.masked_identity,
    purpose: tx.cash_receipt_purpose,
    amount: tx.amount,
    is_demo: tx.is_demo === 1,
    source: tx.source
  }));
}

function bridgeIssueRequest(terminal, tx, amounts, identityInput) {
  return {
    protocol: BRIDGE_PROTOCOL,
    terminal_id: terminal.id,
    request_id: tx.request_id,
    transaction_type: 'CASH_RECEIPT',
    method: 'CASH',
    amount: tx.amount,
    supply_amount: amounts.supply_amount,
    vat_amount: amounts.vat_amount,
    tax_free_amount: amounts.tax_free_amount,
    service_charge: 0,
    purpose: tx.cash_receipt_purpose,
    identity_input: identityInput,
    identity_type: tx.identity_type
  };
}

// 발급이 확정된 현금영수증을 판매에 붙인다. 판매 결제 줄에도 승인번호를 남겨 영수증·대조에 보이게 한다.
function attachToOrder(tx) {
  run("UPDATE van_transactions SET status = 'USED' WHERE id = @id AND status = 'APPROVED'", { id: tx.id });
  run(
    `UPDATE payments SET cash_receipt_number = @number
     WHERE id = (SELECT id FROM payments WHERE order_id = @order_id AND payment_method IN ('CASH', 'TRANSFER') AND paid_amount > 0 ORDER BY id LIMIT 1)`,
    { number: tx.approval_number, order_id: tx.order_id }
  );
  return getVan(tx.id);
}

function applyIssueResult(terminal, tx, raw) {
  const outcome = requireBridgeAdapter(terminal).verifyBridgeResult(terminal, raw, {
    requestId: tx.request_id,
    transactionType: 'CASH_RECEIPT',
    method: 'CASH',
    amount: tx.amount,
    purpose: tx.cash_receipt_purpose
  });
  if (outcome.isDemo && !testPaymentsAllowed()) {
    run(
      `UPDATE van_transactions SET status = 'DECLINED', is_demo = 1, message = @message, resolved_at = CURRENT_TIMESTAMP
       WHERE id = @id AND status IN ('REQUESTED', 'UNKNOWN')`,
      { id: tx.id, message: `(데모) Bridge 결과라 받지 않았습니다. ${TEST_PAYMENTS_DISABLED}` }
    );
    return getVan(tx.id);
  }
  run(
    `UPDATE van_transactions
     SET status = @status, approval_number = COALESCE(@approval_number, approval_number), masked_identity = COALESCE(@masked_identity, masked_identity),
         identity_type = COALESCE(@identity_type, identity_type), van_reference = COALESCE(@van_reference, van_reference),
         is_demo = @is_demo, message = COALESCE(@message, message),
         resolved_at = CASE WHEN @status IN ('REQUESTED', 'UNKNOWN') THEN resolved_at ELSE CURRENT_TIMESTAMP END
     WHERE id = @id AND status IN ('REQUESTED', 'UNKNOWN')`,
    {
      id: tx.id,
      status: outcome.status,
      approval_number: outcome.approvalNumber,
      masked_identity: outcome.maskedIdentity,
      identity_type: outcome.identityType,
      van_reference: outcome.vanReference,
      is_demo: outcome.isDemo ? 1 : 0,
      message: outcome.message
    }
  );
  const updated = getVan(tx.id);
  return updated.status === 'APPROVED' ? attachToOrder(updated) : updated;
}

function requireIssuable(order) {
  if (order.order_type !== 'POS_SALE' || !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.order_status)) {
    throw new PosError('판매 완료된 거래에만 현금영수증을 발급할 수 있습니다.', 409);
  }
  if (activeCashReceipts(order.id).length) {
    throw new PosError('이미 현금영수증을 발급한 거래입니다. 바꾸려면 먼저 취소해야 합니다.', 409, 'CASH_RECEIPT_EXISTS');
  }
  const pending = receiptsOf(order.id, PENDING_STATUSES);
  if (pending.length) {
    throw new PosError('결과를 모르는 현금영수증 발급이 있습니다. 다시 발급하지 말고 먼저 결과를 조회해 주세요.', 409, 'CASH_RECEIPT_PENDING', {
      pending: pending.map((tx) => ({ id: tx.id, request_id: tx.request_id, amount: tx.amount }))
    });
  }
}

// 현금영수증 발급(또는 같은 요청 번호로 Bridge 결과 전달·결과 조회).
function issueCashReceipt(req, { terminal, order, body }) {
  const requestId = parseRequestId(body.request_id);
  const purpose = String(body.purpose || 'INCOME').toUpperCase();
  if (!PURPOSES[purpose]) throw new PosError('현금영수증 용도(소득공제·지출증빙)를 선택해 주세요.');
  const identityInput = String(body.identity_input || 'TERMINAL').toUpperCase();
  if (!IDENTITY_INPUTS.includes(identityInput)) throw new PosError('식별번호 입력 방법이 올바르지 않습니다.');
  if (identityInput === 'SELF' && purpose !== 'INCOME') throw new PosError('자진발급은 소득공제용으로만 발급합니다.');

  const existing = findByRequest(req.pharmacyId, requestId);
  if (existing) {
    if (existing.transaction_type !== 'CASH_RECEIPT' || existing.order_id !== order.id) {
      throw new PosError('이미 다른 거래에 쓴 요청 번호입니다.', 409, 'REQUEST_ID_REUSED');
    }
    if (existing.source === 'BRIDGE' && PENDING_STATUSES.includes(existing.status) && body.bridge_result) {
      return { tx: applyIssueResult(terminal, existing, body.bridge_result) };
    }
    const amounts = cashReceiptAmounts(order.id);
    return {
      tx: existing,
      duplicate: true,
      bridgeRequest: existing.source === 'BRIDGE' && existing.status === 'REQUESTED' ? bridgeIssueRequest(terminal, existing, amounts, identityInput) : undefined
    };
  }

  requireIssuable(order);
  const amounts = cashReceiptAmounts(order.id);
  if (amounts.amount <= 0) throw new PosError('이 거래에는 현금·계좌이체로 받은 금액이 없어 현금영수증을 발급할 수 없습니다.');

  const adapter = adapterFor(terminal);
  const base = {
    transaction_type: 'CASH_RECEIPT',
    payment_method: 'CASH',
    amount: amounts.amount,
    request_id: requestId,
    order_id: order.id,
    cash_receipt_purpose: purpose,
    identity_type: identityInput === 'SELF' ? 'SELF' : null
  };

  if (adapter.kind === 'BRIDGE') {
    if (body.identity !== undefined) throw new PosError('식별번호는 서버로 보내지 않습니다. 이 PC의 Bridge(단말기)에만 전달해 주세요.', 400);
    if (!terminal.bridge_key_enc) throw new PosError('이 카운터에 연결된 Bridge가 없습니다.', 409, 'BRIDGE_NOT_PAIRED');
    const tx = insertVan(req, terminal, { ...base, source: 'BRIDGE', is_demo: 0, status: 'REQUESTED' });
    if (body.bridge_result) {
      return { tx: applyIssueResult(terminal, tx, body.bridge_result) };
    }
    return { tx, bridgeRequest: bridgeIssueRequest(terminal, tx, amounts, identityInput) };
  }

  if (adapter.isDemo) {
    if (!testPaymentsAllowed()) throw demoRejected();
    const result =
      identityInput === 'SELF'
        ? { approvalNumber: String(crypto.randomInt(0, 1e8)).padStart(8, '0'), maskedIdentity: SELF_ISSUE_IDENTITY, message: '[데모] 현금영수증 자진발급' }
        : adapter.issueCashReceipt({ identity: body.identity, purpose });
    const tx = insertVan(req, terminal, {
      ...base,
      identity_type: identityInput === 'SELF' ? 'SELF' : classifyIdentity(body.identity).type,
      source: 'SERVER',
      is_demo: 1,
      status: 'APPROVED',
      approval_number: result.approvalNumber,
      masked_identity: result.maskedIdentity,
      message: result.message,
      resolved_at: getOne('SELECT CURRENT_TIMESTAMP AS now').now
    });
    return { tx: attachToOrder(tx) };
  }

  // 수동: 카운터의 기존 단말기에서 따로 발급한 승인번호만 적어 둔다.
  const approvalNumber = cleanText(body.approval_number, 30);
  if (!approvalNumber || !/^[0-9A-Za-z-]{4,20}$/.test(approvalNumber)) {
    throw new PosError('단말기에서 발급한 현금영수증 승인번호를 입력해 주세요.');
  }
  if (/^\d{13,19}$/.test(approvalNumber.replace(/-/g, ''))) throw new PosError('카드·주민번호로 보이는 값은 저장할 수 없습니다. 승인번호만 입력해 주세요.');
  const tx = insertVan(req, terminal, {
    ...base,
    source: 'MANUAL',
    is_demo: 0,
    status: 'APPROVED',
    approval_number: approvalNumber,
    message: '단말기에서 발급 · 승인번호 직접 입력',
    resolved_at: getOne('SELECT CURRENT_TIMESTAMP AS now').now
  });
  return { tx: attachToOrder(tx) };
}

// 결과를 모르는 현금영수증 발급을 정한다(승인 정리 화면). 다시 발급하지 않는다.
function reconcileCashReceipt(req, { terminal, tx, body, owner }) {
  if (!PENDING_STATUSES.includes(tx.status)) return { tx, unchanged: true };
  if (body.resolution) {
    if (!owner) throw new PosError('발급 결과를 직접 정하는 것은 약국 관리자만 할 수 있습니다.', 403);
    const resolution = String(body.resolution).toUpperCase();
    if (resolution === 'APPROVED') {
      const approvalNumber = cleanText(body.approval_number, 30);
      if (!approvalNumber || !/^[0-9A-Za-z-]{4,20}$/.test(approvalNumber)) throw new PosError('단말기 영수증의 현금영수증 승인번호를 입력해 주세요.');
      run(
        `UPDATE van_transactions SET status = 'APPROVED', approval_number = @number, resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP,
                message = '관리자 확인 · 단말기 영수증 기준 발급'
         WHERE id = @id AND status IN ('REQUESTED', 'UNKNOWN')`,
        { id: tx.id, number: approvalNumber, user_id: req.user.id }
      );
      return { tx: attachToOrder(getVan(tx.id)) };
    }
    if (resolution === 'NOT_APPROVED') {
      run(
        `UPDATE van_transactions SET status = 'NOT_FOUND', resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP,
                message = '관리자 확인 · 단말기에 발급 기록 없음'
         WHERE id = @id AND status IN ('REQUESTED', 'UNKNOWN')`,
        { id: tx.id, user_id: req.user.id }
      );
      return { tx: getVan(tx.id) };
    }
    throw new PosError('발급 확인 결과가 올바르지 않습니다.');
  }
  if (tx.terminal_id !== terminal.id) throw new PosError('다른 카운터의 현금영수증은 그 카운터에서 조회해 주세요.', 403);
  if (tx.source !== 'BRIDGE') throw new PosError('이 현금영수증은 조회할 수 없습니다. 단말기 영수증을 보고 관리자가 정해 주세요.', 409);
  if (!body.bridge_result) {
    throw new PosError('이 카운터 Bridge에서 발급 결과를 조회해 주세요.', 409, 'BRIDGE_RESULT_REQUIRED', {
      bridge_request: { protocol: BRIDGE_PROTOCOL, terminal_id: terminal.id, request_id: tx.request_id, transaction_type: 'CASH_RECEIPT', method: 'CASH', amount: tx.amount, purpose: tx.cash_receipt_purpose }
    });
  }
  return { tx: applyIssueResult(terminal, tx, body.bridge_result) };
}

/* ---------- 반품·취소 때 현금영수증 취소 ---------- */

function cancelRequest(terminal, tx) {
  return {
    protocol: BRIDGE_PROTOCOL,
    terminal_id: terminal.id,
    request_id: null,
    transaction_type: 'CASH_RECEIPT_CANCEL',
    method: 'CASH',
    amount: tx.amount,
    purpose: tx.cash_receipt_purpose,
    original_approval_number: tx.approval_number,
    original_approved_at: localDate(tx.resolved_at || tx.created_at),
    cancel_reason: '1'
  };
}

function insertCancel(req, terminal, tx, refundOrderId, { voidMessage, ...fields }) {
  insertVan(req, terminal, {
    transaction_type: 'CASH_RECEIPT_CANCEL',
    payment_method: 'CASH',
    amount: tx.amount,
    original_approval_number: tx.approval_number,
    original_approved_at: localDate(tx.resolved_at || tx.created_at),
    cancel_reason: '1',
    cash_receipt_purpose: tx.cash_receipt_purpose,
    identity_type: tx.identity_type,
    masked_identity: tx.masked_identity,
    status: 'USED',
    order_id: refundOrderId,
    resolved_at: getOne('SELECT CURRENT_TIMESTAMP AS now').now,
    ...fields
  });
  run("UPDATE van_transactions SET status = 'VOIDED', message = @message WHERE id = @id AND status = 'USED'", {
    id: tx.id,
    message: voidMessage || '현금영수증 취소'
  });
}

// 현금·계좌이체를 돌려주는 반품이면 발급한 현금영수증을 취소해야 한다(금액이 바뀌므로 전부 취소 후 남은 금액으로 재발급).
// Bridge 발급분은 단말기 취소 결과가 있어야 반품을 저장한다. 데모는 서버가 취소하고, 수동 발급분은 단말기에서 직접 취소하도록 알린다.
function cancelCashReceiptsForRefund(req, { terminal, original, refundOrderId, payments, cancels }) {
  const refundsCash = payments.some((p) => ELIGIBLE_METHODS.includes(p.method) && p.amount > 0);
  const active = activeCashReceipts(original.id);
  if (!refundsCash || !active.length) return { notices: [] };

  const given = Array.isArray(cancels) ? cancels : [];
  const missing = active.filter((tx) => tx.source === 'BRIDGE' && !given.some((c) => c.original_approval_number === tx.approval_number && c.bridge_result));
  if (missing.length) {
    throw new PosError('현금영수증을 단말기에서 먼저 취소해야 합니다.', 409, 'CASH_RECEIPT_CANCEL_REQUIRED', {
      cash_receipt_cancels: missing.map((tx) => cancelRequest(terminal, tx))
    });
  }

  const notices = [];
  for (const tx of active) {
    if (tx.source === 'BRIDGE') {
      const raw = given.find((c) => c.original_approval_number === tx.approval_number).bridge_result;
      if (!raw?.request_id) throw new PosError('현금영수증 취소 결과가 없습니다.', 400, 'BRIDGE_RESULT_INVALID');
      const outcome = requireBridgeAdapter(terminal).verifyBridgeResult(terminal, raw, {
        requestId: raw.request_id,
        transactionType: 'CASH_RECEIPT_CANCEL',
        method: 'CASH',
        amount: tx.amount,
        originalApprovalNumber: tx.approval_number
      });
      if (outcome.isDemo && tx.is_demo !== 1 && !testPaymentsAllowed()) throw demoRejected();
      if (outcome.status !== 'APPROVED') throw new PosError(`현금영수증 취소가 완료되지 않았습니다. (${outcome.message || outcome.status})`, 409, 'VAN_CANCEL_FAILED');
      if (findByRequest(terminal.pharmacy_id, raw.request_id)) throw new PosError('이미 반영된 취소 결과입니다.', 409, 'REQUEST_ID_REUSED');
      insertCancel(req, terminal, tx, refundOrderId, {
        source: 'BRIDGE',
        is_demo: outcome.isDemo ? 1 : 0,
        request_id: raw.request_id,
        approval_number: outcome.approvalNumber,
        van_reference: outcome.vanReference,
        message: outcome.message || '현금영수증 취소 (단말기 확인)'
      });
    } else if (tx.is_demo === 1) {
      insertCancel(req, terminal, tx, refundOrderId, {
        source: 'SERVER',
        is_demo: 1,
        approval_number: String(crypto.randomInt(0, 1e8)).padStart(8, '0'),
        message: '[데모] 현금영수증 취소'
      });
    } else {
      insertCancel(req, terminal, tx, refundOrderId, {
        source: 'MANUAL',
        is_demo: 0,
        approval_number: '-',
        message: '수동 발급분 · 단말기에서 직접 취소해야 함',
        voidMessage: '반품으로 취소 필요 · 단말기에서 직접 취소'
      });
      notices.push(`현금영수증(승인 ${tx.approval_number})은 기존 단말기에서 직접 취소해 주세요.`);
    }
    audit(req, 'POS_CASH_RECEIPT_CANCEL', 'ORDER', original.id, `현금영수증 취소 ${won(tx.amount)} · 원승인 ${tx.approval_number} · ${CANCEL_REASONS[1]}`);
  }
  return { notices, canceled: active.length };
}

// 반품 뒤 남은 현금·계좌이체 금액이 있으면 다시 발급하라고 알린다.
function reissueHint(originalOrderId, canceled) {
  if (!canceled) return null;
  const { amount } = cashReceiptAmounts(originalOrderId);
  const previous = getOne(
    "SELECT cash_receipt_purpose, identity_type FROM van_transactions WHERE order_id = @id AND transaction_type = 'CASH_RECEIPT' ORDER BY id DESC LIMIT 1",
    { id: originalOrderId }
  );
  return amount > 0 ? { order_id: originalOrderId, amount, purpose: previous?.cash_receipt_purpose || 'INCOME', self_issued: previous?.identity_type === 'SELF' } : null;
}

module.exports = {
  CANCEL_REASONS,
  IDENTITY_INPUTS,
  PURPOSES,
  activeCashReceipts,
  cancelCashReceiptsForRefund,
  cashReceiptAmounts,
  issueCashReceipt,
  receiptCashReceipts,
  reconcileCashReceipt,
  reissueHint
};
