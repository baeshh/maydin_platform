const { decrypt } = require('../../services/secure');
const { signatureMatches } = require('./bridge-protocol');
const { VanError, VanUnavailableError, defineAdapter, result } = require('./van-adapter');

const BRIDGE_STATUSES = ['APPROVED', 'DECLINED', 'UNKNOWN', 'NOT_FOUND'];
const PRINT_STATUSES = ['PRINTED', 'FAILED'];
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// 국세청 자진발급용 번호. 고객이 번호를 주지 않아도 발급해야 할 때 쓴다.
const { IDENTITY_TYPES, SELF_ISSUE_IDENTITY } = require('./cash-identity');

function bridgeKey(terminal) {
  if (!terminal.bridge_key_enc) throw new VanUnavailableError('이 카운터에 연결된 Bridge가 없습니다. 카운터 관리에서 Bridge 키를 발급해 Bridge에 넣어 주세요.');
  return decrypt(terminal.bridge_key_enc);
}

function invalid(message) {
  return new VanError(message, 400, 'BRIDGE_RESULT_INVALID');
}

// 모든 Bridge 결과에 공통: 서명·카운터·요청 번호·거래 종류·상태·시각.
function verifySigned(terminal, raw, { requestId, transactionType, statuses }) {
  if (!raw || typeof raw !== 'object') throw new VanError('Bridge 결과가 없습니다.', 400, 'BRIDGE_RESULT_INVALID');
  if (!signatureMatches(bridgeKey(terminal), raw)) {
    throw invalid('Bridge 서명이 맞지 않아 결과로 인정할 수 없습니다. 이 카운터의 Bridge 키를 확인해 주세요.');
  }
  const mismatch = [
    String(raw.terminal_id) !== String(terminal.id) && '카운터',
    raw.request_id !== requestId && '요청 번호',
    raw.transaction_type !== transactionType && '거래 종류'
  ].filter(Boolean);
  if (mismatch.length) throw invalid(`Bridge 결과의 ${mismatch.join('·')}이(가) 요청과 다릅니다.`);
  if (!statuses.includes(raw.status)) throw invalid('Bridge 결과 상태가 올바르지 않습니다.');
  const occurred = Date.parse(raw.occurred_at);
  if (!Number.isFinite(occurred) || occurred > Date.now() + CLOCK_SKEW_MS) {
    throw invalid('Bridge 결과 시각이 올바르지 않습니다. 카운터 PC 시계를 확인해 주세요.');
  }
}

// 현금영수증 식별번호는 가린 값만 받는다. 자진발급 번호만 그대로 둔다.
function checkMaskedIdentity(raw) {
  const value = String(raw.masked_identity || '');
  if (!IDENTITY_TYPES.includes(raw.identity_type)) throw invalid('현금영수증 식별번호 종류가 올바르지 않습니다.');
  if (raw.identity_type === 'SELF') {
    if (value !== SELF_ISSUE_IDENTITY) throw invalid('자진발급 번호가 올바르지 않습니다.');
    return;
  }
  const visible = value.replace(/[^0-9]/g, '').length;
  if (!/^[0-9*-]{6,24}$/.test(value) || !value.includes('*') || visible > 8) {
    throw invalid('현금영수증 식별번호는 가린 값만 받을 수 있습니다. Bridge가 번호를 가려서 보내야 합니다.');
  }
}

// POS 화면이 전달한 카드·현금영수증 결과를 검증한다. 서명·카운터·요청 번호·금액이 모두 맞아야 결과로 인정한다.
function verifyBridgeResult(terminal, raw, expected) {
  verifySigned(terminal, raw, { requestId: expected.requestId, transactionType: expected.transactionType, statuses: BRIDGE_STATUSES });
  const mismatch = [
    expected.method && raw.method !== expected.method && '결제수단',
    expected.amount !== undefined && Number(raw.amount) !== expected.amount && '금액',
    expected.originalApprovalNumber && raw.original_approval_number !== expected.originalApprovalNumber && '원승인번호',
    expected.purpose && raw.purpose !== expected.purpose && '발급 용도'
  ].filter(Boolean);
  if (mismatch.length) throw invalid(`Bridge 결과의 ${mismatch.join('·')}이(가) 요청과 다릅니다.`);
  if (raw.status === 'APPROVED' && !/^[0-9A-Za-z-]{4,20}$/.test(String(raw.approval_number || ''))) {
    throw invalid('Bridge 결과에 승인번호가 없습니다.');
  }
  if (expected.transactionType === 'CASH_RECEIPT' && raw.status === 'APPROVED') checkMaskedIdentity(raw);
  return {
    ...result(raw.status, {
      approvalNumber: raw.approval_number,
      cardCompany: raw.card_company,
      vanReference: raw.van_reference,
      originalApprovalNumber: raw.original_approval_number,
      maskedIdentity: raw.masked_identity,
      message: raw.message ? String(raw.message).slice(0, 200) : null
    }),
    identityType: raw.identity_type || null,
    isDemo: raw.demo === true || raw.demo === 'true' || raw.demo === 1 || raw.demo === '1'
  };
}

// 영수증 출력 결과. 서버가 보낸 문서(해시)를 그대로 출력했는지까지 맞춰 본다.
function verifyPrintResult(terminal, raw, { jobId, documentHash }) {
  verifySigned(terminal, raw, { requestId: jobId, transactionType: 'PRINT', statuses: PRINT_STATUSES });
  if (raw.document_hash !== documentHash) throw invalid('Bridge가 출력한 영수증 내용이 요청과 다릅니다.');
  return {
    status: raw.status,
    errorCode: raw.status === 'FAILED' ? String(raw.error_code || 'ERROR').slice(0, 30) : null,
    message: raw.message ? String(raw.message).slice(0, 200) : null
  };
}

// 카드 단말기는 카운터 PC의 Bridge가 다룬다. 서버는 승인·취소를 직접 하지 않고 서명된 결과만 받는다.
const bridgeAdapter = defineAdapter({
  mode: 'BRIDGE',
  label: 'MAYDIN Bridge 연동',
  kind: 'BRIDGE',
  verifyBridgeResult
});

module.exports = { SELF_ISSUE_IDENTITY, bridgeAdapter, verifyBridgeResult, verifyPrintResult };
