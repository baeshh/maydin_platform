const { getAll, getOne, run } = require('../../db');
const { changePoints } = require('../../services/points');
const { ADAPTERS, VanError, adapterFor, demoAdapter, manualAdapter } = require('../integrations');
const { BRIDGE_PROTOCOL } = require('../integrations/bridge-protocol');
const { PAYMENT_METHODS, PosError, cleanText, toInt, won } = require('../common');
const { requireOpenSession } = require('./session-service');

const APPROVAL_METHODS = ['CARD', 'EASY_PAY'];
// 결과를 아직 모르는 승인. 이 상태가 남아 있으면 같은 판매에 새 승인을 요청할 수 없다(이중 결제 방지).
const PENDING_STATUSES = ['REQUESTED', 'UNKNOWN'];
const REQUEST_ID = /^[0-9A-Za-z-]{16,64}$/;

function normalizePayments(payments, expectedTotal, { requireCardApproval = true, allowChange = true, allowPoint = true } = {}) {
  const list = Array.isArray(payments) ? payments : [];
  const normalized = list.map((payment) => {
    const method = String(payment.method || payment.payment_method || '').toUpperCase();
    if (!PAYMENT_METHODS[method]) throw new PosError('결제수단을 선택해 주세요.');
    if (method === 'POINT' && !allowPoint) throw new PosError('이 결제에는 포인트를 사용할 수 없습니다.');
    const label = PAYMENT_METHODS[method];
    const amount = Number(payment.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new PosError(`${label} 금액이 올바르지 않습니다.`);

    const approvalNumber = cleanText(payment.approval_number, 30);
    if (approvalNumber && /^\d{13,19}$/.test(approvalNumber.replace(/[\s-]/g, ''))) {
      throw new PosError('카드번호로 보이는 값은 저장할 수 없습니다. 단말기 영수증의 승인번호만 입력해 주세요.');
    }
    const vanTransactionId = payment.van_transaction_id ? Number(payment.van_transaction_id) : null;
    if (vanTransactionId !== null && !Number.isInteger(vanTransactionId)) throw new PosError('VAN 승인 정보가 올바르지 않습니다.');
    if (method === 'CARD' && requireCardApproval && !approvalNumber && !vanTransactionId) {
      throw new PosError('카드 단말기에서 승인된 승인번호를 입력해 주세요.');
    }

    let receivedAmount = null;
    let changeAmount = null;
    const received = payment.received_amount;
    if (allowChange && method === 'CASH' && received !== undefined && received !== null && received !== '') {
      receivedAmount = Number(received);
      if (!Number.isInteger(receivedAmount) || receivedAmount < amount) {
        throw new PosError('받은 현금이 결제 금액보다 적습니다.');
      }
      changeAmount = receivedAmount - amount;
    }

    return {
      method,
      amount,
      approval_number: approvalNumber,
      card_company: method === 'CARD' ? cleanText(payment.card_company, 30) : null,
      cash_receipt_number: method === 'CASH' ? cleanText(payment.cash_receipt_number, 30) : null,
      received_amount: receivedAmount,
      change_amount: changeAmount,
      van_transaction_id: vanTransactionId
    };
  });

  const sum = normalized.reduce((total, payment) => total + payment.amount, 0);
  if (sum !== expectedTotal) {
    throw new PosError(`결제 금액 합계 ${won(sum)}이(가) 결제할 금액 ${won(expectedTotal)}과(와) 일치하지 않습니다.`);
  }
  return normalized;
}

/* ---------- 승인 기록 ---------- */

function getVan(id) {
  return getOne('SELECT * FROM van_transactions WHERE id = @id', { id });
}

function publicVan(tx) {
  return tx && {
    id: tx.id,
    request_id: tx.request_id,
    transaction_type: tx.transaction_type,
    payment_method: tx.payment_method,
    amount: tx.amount,
    installment_months: tx.installment_months,
    approval_number: tx.approval_number === '-' ? null : tx.approval_number,
    card_company: tx.card_company,
    status: tx.status,
    source: tx.source,
    is_demo: tx.is_demo === 1,
    message: tx.message,
    order_id: tx.order_id,
    sale_draft_id: tx.sale_draft_id,
    created_at: tx.created_at
  };
}

function insertVan(req, terminal, fields) {
  const result = run(
    `INSERT INTO van_transactions (
      pharmacy_id, terminal_id, van_company, tid, transaction_type, payment_method, amount, installment_months,
      approval_number, card_company, masked_identity, original_approval_number, status, order_id, is_demo, message, created_by,
      request_id, sale_draft_id, source, van_reference, resolved_at
    ) VALUES (
      @pharmacy_id, @terminal_id, @van_company, @tid, @transaction_type, @payment_method, @amount, @installment_months,
      @approval_number, @card_company, @masked_identity, @original_approval_number, @status, @order_id, @is_demo, @message, @created_by,
      @request_id, @sale_draft_id, @source, @van_reference, @resolved_at
    )`,
    {
      pharmacy_id: terminal.pharmacy_id,
      terminal_id: terminal.id,
      van_company: terminal.van_company || null,
      tid: terminal.tid || null,
      installment_months: 0,
      approval_number: '-',
      card_company: null,
      masked_identity: null,
      original_approval_number: null,
      order_id: null,
      is_demo: 1,
      message: null,
      created_by: req.user.id,
      request_id: null,
      sale_draft_id: null,
      source: 'SERVER',
      van_reference: null,
      resolved_at: null,
      ...fields
    }
  );
  return getVan(result.lastInsertRowid);
}

// VAN 결과를 기록에 반영한다. 결과가 정해지면(UNKNOWN 아님) 처리 시각을 남긴다.
function applyOutcome(tx, outcome, { isDemo, resolvedBy = null } = {}) {
  const status = outcome.status === 'NOT_FOUND' ? 'NOT_FOUND' : outcome.status;
  run(
    `UPDATE van_transactions
     SET status = @status,
         approval_number = COALESCE(@approval_number, approval_number),
         card_company = COALESCE(@card_company, card_company),
         van_reference = COALESCE(@van_reference, van_reference),
         is_demo = COALESCE(@is_demo, is_demo),
         message = COALESCE(@message, message),
         resolved_at = CASE WHEN @status IN ('REQUESTED', 'UNKNOWN') THEN resolved_at ELSE CURRENT_TIMESTAMP END,
         resolved_by = COALESCE(@resolved_by, resolved_by)
     WHERE id = @id AND status IN ('REQUESTED', 'UNKNOWN')`,
    {
      id: tx.id,
      status,
      approval_number: outcome.approvalNumber || null,
      card_company: outcome.cardCompany || null,
      van_reference: outcome.vanReference || null,
      is_demo: isDemo === undefined ? null : isDemo ? 1 : 0,
      message: outcome.message || null,
      resolved_by: resolvedBy
    }
  );
  return getVan(tx.id);
}

function declined(tx) {
  return new PosError(tx.message || '카드사에서 승인을 거절했습니다.', 402, 'VAN_DECLINED', { van_transaction: publicVan(tx) });
}

function bridgeRequest(terminal, tx, transactionType = 'APPROVE', extra = {}) {
  return {
    protocol: BRIDGE_PROTOCOL,
    terminal_id: terminal.id,
    request_id: tx.request_id,
    transaction_type: transactionType,
    method: tx.payment_method,
    amount: tx.amount,
    installment_months: tx.installment_months || 0,
    ...extra
  };
}

function requireBridgeAdapter(terminal) {
  const adapter = adapterFor(terminal);
  if (adapter.kind !== 'BRIDGE') throw new PosError('이 카운터는 Bridge 연동 모드가 아닙니다.', 409);
  return adapter;
}

function applyBridgeResult(terminal, tx, raw) {
  const outcome = requireBridgeAdapter(terminal).verifyBridgeResult(terminal, raw, {
    requestId: tx.request_id,
    transactionType: 'APPROVE',
    method: tx.payment_method,
    amount: tx.amount
  });
  return applyOutcome(tx, outcome, { isDemo: outcome.isDemo });
}

function parseRequestId(value) {
  const id = String(value || '').trim();
  if (!REQUEST_ID.test(id)) throw new PosError('승인 요청 번호가 올바르지 않습니다.');
  return id;
}

function findByRequest(pharmacyId, requestId) {
  return getOne('SELECT * FROM van_transactions WHERE pharmacy_id = @pharmacy_id AND request_id = @request_id', {
    pharmacy_id: pharmacyId,
    request_id: requestId
  });
}

function draftApprovals(draftId) {
  return getAll("SELECT * FROM van_transactions WHERE sale_draft_id = @id AND transaction_type = 'APPROVE' ORDER BY id ASC", { id: draftId });
}

// 결제 전 판매(draft)에 카드·간편결제 승인을 붙인다.
// 같은 요청 번호로 다시 오면 다시 승인하지 않고 처음 기록을 돌려준다. 결과를 모르는 승인이 있으면 새 승인을 막는다.
function requestApproval(req, { terminal, draft, body }) {
  const requestId = parseRequestId(body.request_id);
  const method = String(body.method || '').toUpperCase();
  if (!APPROVAL_METHODS.includes(method)) throw new PosError('VAN 승인은 카드·간편결제만 가능합니다.');
  const amount = toInt(body.amount, '승인 금액', { min: 1, max: 100000000 });
  const installmentMonths = method === 'CARD' ? toInt(body.installment_months || 0, '할부 개월', { min: 0, max: 12 }) : 0;
  if (installmentMonths === 1) throw new PosError('할부는 2개월부터 선택할 수 있습니다.');

  const existing = findByRequest(req.pharmacyId, requestId);
  if (existing) {
    if (existing.sale_draft_id !== draft.id || existing.amount !== amount || existing.payment_method !== method) {
      throw new PosError('이미 다른 결제에 쓴 승인 요청 번호입니다.', 409, 'REQUEST_ID_REUSED');
    }
    if (existing.source === 'BRIDGE' && PENDING_STATUSES.includes(existing.status) && body.bridge_result) {
      const tx = applyBridgeResult(terminal, existing, body.bridge_result);
      if (tx.status === 'DECLINED') throw declined(tx);
      return { tx };
    }
    return { tx: existing, duplicate: true, bridgeRequest: existing.source === 'BRIDGE' && existing.status === 'REQUESTED' ? bridgeRequest(terminal, existing) : undefined };
  }

  const approvals = draftApprovals(draft.id);
  const pending = approvals.filter((tx) => PENDING_STATUSES.includes(tx.status));
  if (pending.length) {
    throw new PosError('결과를 아직 모르는 승인이 있습니다. 카드를 다시 승인하지 말고 먼저 승인 결과를 확인해 주세요.', 409, 'APPROVAL_PENDING', {
      pending: pending.map(publicVan)
    });
  }
  const approved = approvals.filter((tx) => tx.status === 'APPROVED').reduce((sum, tx) => sum + tx.amount, 0);
  if (approved + amount > draft.amount) {
    throw new PosError(`승인 합계가 결제할 금액(${won(draft.amount)})을 넘습니다. (이미 승인 ${won(approved)})`);
  }

  const adapter = adapterFor(terminal);
  const base = { transaction_type: 'APPROVE', payment_method: method, amount, installment_months: installmentMonths, request_id: requestId, sale_draft_id: draft.id };

  if (body.manual === true || adapter.kind === 'MANUAL') {
    const outcome = manualAdapter.record({ approvalNumber: body.approval_number, cardCompany: cleanText(body.card_company, 30) });
    const tx = insertVan(req, terminal, {
      ...base,
      source: 'MANUAL',
      is_demo: 0,
      status: 'APPROVED',
      approval_number: outcome.approvalNumber,
      card_company: outcome.cardCompany,
      message: outcome.message,
      resolved_at: getOne('SELECT CURRENT_TIMESTAMP AS now').now
    });
    return { tx };
  }

  if (adapter.kind === 'BRIDGE') {
    if (!terminal.bridge_key_enc) {
      throw new PosError('이 카운터에 연결된 Bridge가 없습니다. 카운터 관리에서 Bridge 키를 발급해 이 PC의 Bridge에 넣어 주세요.', 409, 'BRIDGE_NOT_PAIRED');
    }
    const tx = insertVan(req, terminal, { ...base, source: 'BRIDGE', is_demo: 0, status: 'REQUESTED' });
    if (body.bridge_result) {
      const done = applyBridgeResult(terminal, tx, body.bridge_result);
      if (done.status === 'DECLINED') throw declined(done);
      return { tx: done };
    }
    return { tx, bridgeRequest: bridgeRequest(terminal, tx) };
  }

  // 서버가 VAN사와 직접 통신. 요청 기록을 먼저 남겨 두어, 응답 전에 끊겨도 대사할 거리가 남는다.
  const tx = insertVan(req, terminal, { ...base, source: 'SERVER', is_demo: adapter.isDemo ? 1 : 0, status: 'REQUESTED' });
  let outcome;
  try {
    outcome = adapter.approve({
      pharmacyId: req.pharmacyId,
      requestId,
      method,
      amount,
      installmentMonths,
      barcode: body.barcode,
      simulate: adapter.isDemo ? body.simulate : undefined
    });
  } catch (error) {
    if (error instanceof VanError && error.reason === 'VAN_DECLINED') {
      throw declined(applyOutcome(tx, { status: 'DECLINED', message: error.message }));
    }
    if (!(error instanceof VanError)) console.error(error);
    return { tx: applyOutcome(tx, { status: 'UNKNOWN', message: 'VAN 응답을 받지 못했습니다. 승인 결과를 조회해 주세요.' }) };
  }
  const done = applyOutcome(tx, outcome);
  if (done.status === 'DECLINED') throw declined(done);
  return { tx: done };
}

// 결과를 모르는 승인(UNKNOWN·REQUESTED)을 정한다. 다시 승인하지 않고 VAN사·Bridge 조회 결과로만 정한다.
// 조회할 수 없으면 약국 관리자가 단말기 영수증·VAN 매출 내역을 보고 직접 정한다.
function reconcileApproval(req, { terminal, tx, body, owner }) {
  if (!PENDING_STATUSES.includes(tx.status)) return { tx, unchanged: true };

  if (body.resolution) {
    if (!owner) throw new PosError('승인 결과를 직접 정하는 것은 약국 관리자만 할 수 있습니다.', 403);
    const resolution = String(body.resolution).toUpperCase();
    if (resolution === 'APPROVED') {
      const outcome = manualAdapter.record({ approvalNumber: body.approval_number, cardCompany: cleanText(body.card_company, 30) });
      return {
        tx: applyOutcome(tx, { ...outcome, message: '관리자 확인 · 단말기 영수증 기준 승인' }, { resolvedBy: req.user.id })
      };
    }
    if (resolution === 'NOT_APPROVED') {
      return { tx: applyOutcome(tx, { status: 'NOT_FOUND', message: '관리자 확인 · 단말기에 승인 기록 없음' }, { resolvedBy: req.user.id }) };
    }
    throw new PosError('승인 확인 결과가 올바르지 않습니다.');
  }

  if (tx.terminal_id !== terminal.id) throw new PosError('다른 카운터의 승인은 그 카운터에서 조회해 주세요.', 403);
  if (tx.source === 'BRIDGE') {
    if (!body.bridge_result) {
      throw new PosError('이 카운터 Bridge에서 승인 결과를 조회해 주세요.', 409, 'BRIDGE_RESULT_REQUIRED', {
        bridge_request: bridgeRequest(terminal, tx, 'INQUIRE')
      });
    }
    return { tx: applyBridgeResult(terminal, tx, body.bridge_result) };
  }
  const adapter = tx.is_demo ? demoAdapter : adapterFor(terminal);
  const outcome = adapter.inquire({ pharmacyId: req.pharmacyId, requestId: tx.request_id });
  return { tx: applyOutcome(tx, outcome) };
}

// 판매에 쓰기 전 승인을 취소한다. Bridge 승인은 단말기에서 취소한 서명 결과가 있어야 한다.
function voidApproval(req, { terminal, tx, body }) {
  if (tx.transaction_type !== 'APPROVE') throw new PosError('VAN 승인 내역을 찾을 수 없습니다.', 404);
  if (tx.terminal_id !== terminal.id) throw new PosError('다른 카운터 단말기의 승인은 그 카운터에서 취소해 주세요.', 403);
  if (PENDING_STATUSES.includes(tx.status)) throw new PosError('결과를 모르는 승인은 먼저 결과를 조회해 주세요.', 409, 'APPROVAL_PENDING');
  if (tx.status !== 'APPROVED' || tx.order_id) throw new PosError('판매에 사용된 승인은 거래내역에서 취소·반품으로 처리해 주세요.', 409);

  let message = '[데모] 판매 전 승인 취소';
  if (tx.source === 'BRIDGE') {
    const cancelRequest = { ...bridgeRequest(terminal, tx, 'CANCEL'), original_approval_number: tx.approval_number };
    if (!body.bridge_result) {
      throw new PosError('카드 단말기에서 승인을 취소해야 합니다.', 409, 'VAN_CANCEL_REQUIRED', { bridge_request: { ...cancelRequest, request_id: null } });
    }
    recordBridgeCancel(req, terminal, { method: tx.payment_method, amount: tx.amount, originalApprovalNumber: tx.approval_number, cardCompany: tx.card_company, raw: body.bridge_result });
    message = '판매 전 승인 취소 (단말기 취소 확인)';
  } else if (tx.source === 'MANUAL') {
    message = '판매 전 승인 취소 · 단말기에서 취소했는지 영수증으로 확인';
  } else if (!tx.is_demo) {
    message = '판매 전 승인 취소';
  }
  run("UPDATE van_transactions SET status = 'VOIDED', message = @message WHERE id = @id AND status = 'APPROVED' AND order_id IS NULL", {
    id: tx.id,
    message
  });
  return getVan(tx.id);
}

/* ---------- 판매·환불 결제 저장 ---------- */

function claimVanTransaction(terminal, payment, orderId, draftId = null) {
  const tx = getOne('SELECT * FROM van_transactions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: payment.van_transaction_id,
    pharmacy_id: terminal.pharmacy_id
  });
  if (!tx || tx.transaction_type !== 'APPROVE') throw new PosError('VAN 승인 내역을 찾을 수 없습니다.');
  if (tx.terminal_id !== terminal.id) throw new PosError('다른 카운터 단말기에서 받은 승인입니다. 이 카운터 단말기로 결제해 주세요.', 409);
  if ((tx.sale_draft_id || null) !== draftId) throw new PosError('이 판매에 묶인 승인이 아닙니다.', 409);
  if (PENDING_STATUSES.includes(tx.status)) throw new PosError('결과를 아직 모르는 승인입니다. 승인 결과를 먼저 확인해 주세요.', 409, 'APPROVAL_PENDING');
  if (tx.status !== 'APPROVED' || tx.order_id) throw new PosError('이미 사용되었거나 취소된 VAN 승인입니다.', 409);
  if (tx.payment_method !== payment.method) throw new PosError('VAN 승인 결제수단이 일치하지 않습니다.');
  if (tx.amount !== payment.amount) {
    throw new PosError(`VAN 승인 금액(${won(tx.amount)})과 결제 금액(${won(payment.amount)})이 다릅니다.`);
  }
  run("UPDATE van_transactions SET status = 'USED', order_id = @order_id WHERE id = @id AND status = 'APPROVED'", {
    id: tx.id,
    order_id: orderId
  });
  return tx;
}

function providerFor(tx) {
  if (tx.source === 'MANUAL') return 'VAN_MANUAL';
  if (tx.source === 'BRIDGE') return 'VAN_BRIDGE';
  return tx.is_demo ? 'VAN_DEMO' : 'VAN';
}

// 서버가 VAN·Bridge로 확인하지 못한 카드·간편결제(수동 입력·관리자 확인)는 단말기 영수증과 대조해야 한다.
function verifyStatusFor(tx) {
  return tx.source === 'MANUAL' || tx.resolved_by ? 'UNVERIFIED' : 'VERIFIED';
}

function recordBridgeCancel(req, terminal, { method, amount, originalApprovalNumber, cardCompany, raw, orderId = null }) {
  if (!raw?.request_id) throw new PosError('Bridge 취소 결과가 없습니다.', 400, 'BRIDGE_RESULT_INVALID');
  const outcome = requireBridgeAdapter(terminal).verifyBridgeResult(terminal, raw, {
    requestId: raw.request_id,
    transactionType: 'CANCEL',
    method,
    amount,
    originalApprovalNumber
  });
  if (outcome.status !== 'APPROVED') throw new PosError(`단말기 취소가 완료되지 않았습니다. (${outcome.message || outcome.status})`, 409, 'VAN_CANCEL_FAILED');
  if (findByRequest(terminal.pharmacy_id, raw.request_id)) throw new PosError('이미 반영된 취소 결과입니다.', 409, 'REQUEST_ID_REUSED');
  return insertVan(req, terminal, {
    transaction_type: 'CANCEL',
    payment_method: method,
    amount,
    approval_number: outcome.approvalNumber,
    card_company: cardCompany || outcome.cardCompany,
    original_approval_number: originalApprovalNumber,
    status: 'USED',
    order_id: orderId,
    is_demo: outcome.isDemo ? 1 : 0,
    message: outcome.message || '단말기 취소 완료',
    request_id: raw.request_id,
    source: 'BRIDGE',
    van_reference: outcome.vanReference,
    resolved_at: getOne('SELECT CURRENT_TIMESTAMP AS now').now
  });
}

// 데모 VAN으로 승인된 원결제는 환불할 때도 데모 VAN 취소 전문을 만들어 승인번호를 남긴다.
function cancelVanPayment(req, payment, orderId, { terminal }) {
  const original = payment.van_original;
  const outcome = demoAdapter.cancel({ pharmacyId: terminal.pharmacy_id, original, amount: payment.amount });
  return insertVan(req, terminal, {
    transaction_type: 'CANCEL',
    payment_method: payment.method,
    amount: payment.amount,
    approval_number: outcome.approvalNumber,
    card_company: original.card_company || null,
    original_approval_number: original.approval_number,
    status: 'USED',
    order_id: orderId,
    message: outcome.message
  });
}

const CANCELABLE_PROVIDERS = ['VAN_DEMO', 'VAN_BRIDGE'];

function vanOriginal(row) {
  return CANCELABLE_PROVIDERS.includes(row.payment_provider)
    ? { approval_number: row.approval_number, card_company: row.card_company, provider: row.payment_provider }
    : null;
}

function attachVanOriginals(originalOrderId, payments) {
  const vanPayments = getAll(
    `SELECT * FROM payments WHERE order_id = @id AND paid_amount > 0 AND payment_provider IN (${CANCELABLE_PROVIDERS.map((p) => `'${p}'`).join(', ')})
     ORDER BY id ASC`,
    { id: originalOrderId }
  );
  return payments.map((payment) => {
    const original = vanPayments.find((row) => row.payment_method === payment.method);
    return original ? { ...payment, van_original: vanOriginal(original) } : payment;
  });
}

// Bridge로 승인한 결제를 환불하려면 카운터 단말기에서 먼저 취소해야 한다. 필요한 취소 목록을 알려 준다.
function requireBridgeCancels(terminal, payments, vanCancels) {
  const given = Array.isArray(vanCancels) ? vanCancels : [];
  const missing = [];
  for (const payment of payments) {
    if (payment.van_original?.provider !== 'VAN_BRIDGE') continue;
    const match = given.find((c) => c.original_approval_number === payment.van_original.approval_number && c.bridge_result);
    if (match) payment.bridge_cancel = match.bridge_result;
    else {
      missing.push({
        protocol: BRIDGE_PROTOCOL,
        terminal_id: terminal.id,
        transaction_type: 'CANCEL',
        method: payment.method,
        amount: payment.amount,
        original_approval_number: payment.van_original.approval_number
      });
    }
  }
  if (missing.length) {
    throw new PosError('카드 단말기에서 원승인을 먼저 취소해야 합니다.', 409, 'VAN_CANCEL_REQUIRED', { cancels: missing });
  }
  return payments;
}

function insertPayments(orderId, payments, { sign = 1, session, terminal, userId, customerId = null, draftId = null, req = null }) {
  const actor = req || { user: { id: userId } };
  for (const input of payments) {
    const payment = { ...input, provider: input.method === 'CARD' ? 'VAN_MANUAL' : 'POS', verify_status: null };
    if (input.method === 'POINT') {
      if (!customerId) throw new PosError('포인트는 회원 거래에서만 사용할 수 있습니다.');
      changePoints({
        pharmacyId: terminal.pharmacy_id,
        customerId,
        orderId,
        entryType: sign > 0 ? 'USE' : 'USE_RESTORE',
        points: sign * -input.amount,
        reason: sign > 0 ? '현장 결제 포인트 사용' : '취소·반품 포인트 복원',
        userId
      });
      Object.assign(payment, { provider: 'POINT', approval_number: null, card_company: null, van_transaction_id: null });
    } else if (sign > 0 && input.van_transaction_id) {
      const tx = claimVanTransaction(terminal, input, orderId, draftId);
      Object.assign(payment, {
        approval_number: tx.approval_number,
        card_company: tx.card_company,
        installment_months: tx.installment_months,
        provider: providerFor(tx),
        verify_status: verifyStatusFor(tx)
      });
    } else if (sign < 0 && input.van_original?.provider === 'VAN_BRIDGE') {
      const cancel = recordBridgeCancel(actor, terminal, {
        method: input.method,
        amount: input.amount,
        originalApprovalNumber: input.van_original.approval_number,
        cardCompany: input.van_original.card_company,
        raw: input.bridge_cancel,
        orderId
      });
      Object.assign(payment, {
        approval_number: cancel.approval_number,
        card_company: cancel.card_company,
        van_transaction_id: cancel.id,
        provider: 'VAN_BRIDGE',
        verify_status: 'VERIFIED'
      });
    } else if (sign < 0 && input.van_original) {
      const cancel = cancelVanPayment(actor, input, orderId, { terminal });
      Object.assign(payment, {
        approval_number: cancel.approval_number,
        card_company: cancel.card_company,
        van_transaction_id: cancel.id,
        provider: 'VAN_DEMO',
        verify_status: 'VERIFIED'
      });
    } else {
      payment.van_transaction_id = null;
      if (APPROVAL_METHODS.includes(input.method)) payment.verify_status = 'UNVERIFIED';
    }

    run(
      `INSERT INTO payments (
        order_id, payment_method, payment_provider, payment_status, paid_amount, paid_at, refunded_at,
        approval_number, terminal_id, card_company, cash_receipt_number, received_amount, change_amount,
        pos_session_id, created_by, van_transaction_id, installment_months, verify_status
      ) VALUES (
        @order_id, @payment_method, @payment_provider, @payment_status, @paid_amount, CURRENT_TIMESTAMP,
        CASE WHEN @sign < 0 THEN CURRENT_TIMESTAMP ELSE NULL END,
        @approval_number, @terminal_id, @card_company, @cash_receipt_number, @received_amount, @change_amount,
        @pos_session_id, @created_by, @van_transaction_id, @installment_months, @verify_status
      )`,
      {
        order_id: orderId,
        payment_method: payment.method,
        payment_provider: payment.provider,
        van_transaction_id: payment.van_transaction_id || null,
        installment_months: payment.installment_months ?? null,
        payment_status: sign < 0 ? 'REFUNDED' : 'PAID',
        paid_amount: sign * payment.amount,
        sign,
        approval_number: payment.approval_number || null,
        terminal_id: terminal ? String(terminal.id) : null,
        card_company: payment.card_company || null,
        cash_receipt_number: payment.cash_receipt_number || null,
        received_amount: payment.received_amount ?? null,
        change_amount: payment.change_amount ?? null,
        pos_session_id: session ? session.id : null,
        created_by: userId,
        verify_status: payment.verify_status
      }
    );
  }
}

// 현금영수증 등 판매와 따로 남기는 데모 VAN 기록.
function recordVan(req, terminal, fields) {
  return insertVan(req, terminal, fields);
}

function requireVanAdapter(req) {
  const { terminal, session } = requireOpenSession(req);
  const adapter = adapterFor(terminal);
  if (!adapter.isDemo) throw new PosError('단말기가 데모 VAN 모드가 아닙니다. 현금영수증은 카드 단말기에서 발급해 주세요.', 409);
  return { terminal, session, adapter };
}

// 카운터에 결과를 모르는 승인·판매에 안 쓴 승인이 남아 있으면 마감 전에 정리해야 한다.
function openApprovals(terminalId) {
  return getAll(
    `SELECT * FROM van_transactions
     WHERE terminal_id = @terminal_id AND transaction_type = 'APPROVE'
       AND (status IN ('REQUESTED', 'UNKNOWN') OR (status = 'APPROVED' AND order_id IS NULL))
     ORDER BY id ASC`,
    { terminal_id: terminalId }
  );
}

module.exports = {
  ADAPTERS,
  PENDING_STATUSES,
  attachVanOriginals,
  claimVanTransaction,
  draftApprovals,
  findByRequest,
  getVan,
  insertPayments,
  normalizePayments,
  openApprovals,
  parseRequestId,
  publicVan,
  reconcileApproval,
  recordVan,
  requestApproval,
  requireBridgeCancels,
  requireVanAdapter,
  vanOriginal,
  voidApproval
};
