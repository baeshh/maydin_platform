const { decrypt } = require('../../services/secure');
const { signatureMatches } = require('./bridge-protocol');
const { VanError, VanUnavailableError, defineAdapter, result } = require('./van-adapter');

const BRIDGE_STATUSES = ['APPROVED', 'DECLINED', 'UNKNOWN', 'NOT_FOUND'];
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function bridgeKey(terminal) {
  if (!terminal.bridge_key_enc) throw new VanUnavailableError('이 카운터에 연결된 Bridge가 없습니다. 카운터 관리에서 Bridge 키를 발급해 Bridge에 넣어 주세요.');
  return decrypt(terminal.bridge_key_enc);
}

// POS 화면이 전달한 Bridge 결과를 검증한다. 서명·카운터·요청 번호·금액이 모두 맞아야 결과로 인정한다.
function verifyBridgeResult(terminal, raw, expected) {
  if (!raw || typeof raw !== 'object') throw new VanError('Bridge 결과가 없습니다.', 400, 'BRIDGE_RESULT_INVALID');
  if (!signatureMatches(bridgeKey(terminal), raw)) {
    throw new VanError('Bridge 서명이 맞지 않아 승인으로 인정할 수 없습니다. 이 카운터의 Bridge 키를 확인해 주세요.', 400, 'BRIDGE_RESULT_INVALID');
  }
  const mismatch = [
    String(raw.terminal_id) !== String(terminal.id) && '카운터',
    raw.request_id !== expected.requestId && '요청 번호',
    raw.transaction_type !== expected.transactionType && '거래 종류',
    expected.method && raw.method !== expected.method && '결제수단',
    expected.amount !== undefined && Number(raw.amount) !== expected.amount && '금액',
    expected.originalApprovalNumber && raw.original_approval_number !== expected.originalApprovalNumber && '원승인번호'
  ].filter(Boolean);
  if (mismatch.length) throw new VanError(`Bridge 결과의 ${mismatch.join('·')}이(가) 요청과 다릅니다.`, 400, 'BRIDGE_RESULT_INVALID');
  if (!BRIDGE_STATUSES.includes(raw.status)) throw new VanError('Bridge 결과 상태가 올바르지 않습니다.', 400, 'BRIDGE_RESULT_INVALID');
  const occurred = Date.parse(raw.occurred_at);
  if (!Number.isFinite(occurred) || occurred > Date.now() + CLOCK_SKEW_MS) {
    throw new VanError('Bridge 결과 시각이 올바르지 않습니다. 카운터 PC 시계를 확인해 주세요.', 400, 'BRIDGE_RESULT_INVALID');
  }
  if (raw.status === 'APPROVED' && !/^[0-9A-Za-z-]{4,20}$/.test(String(raw.approval_number || ''))) {
    throw new VanError('Bridge 결과에 승인번호가 없습니다.', 400, 'BRIDGE_RESULT_INVALID');
  }
  return {
    ...result(raw.status, {
      approvalNumber: raw.approval_number,
      cardCompany: raw.card_company,
      vanReference: raw.van_reference,
      originalApprovalNumber: raw.original_approval_number,
      message: raw.message ? String(raw.message).slice(0, 200) : null
    }),
    isDemo: raw.demo === true || raw.demo === 'true' || raw.demo === 1 || raw.demo === '1'
  };
}

// 카드 단말기는 카운터 PC의 Bridge가 다룬다. 서버는 승인·취소를 직접 하지 않고 서명된 결과만 받는다.
const bridgeAdapter = defineAdapter({
  mode: 'BRIDGE',
  label: 'MAYDIN Bridge 연동',
  kind: 'BRIDGE',
  verifyBridgeResult
});

module.exports = { bridgeAdapter, verifyBridgeResult };
