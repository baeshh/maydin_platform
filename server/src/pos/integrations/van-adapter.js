// VAN 어댑터 공통 규격.
//
// 어댑터는 세 종류다.
//  - SERVER : 서버가 VAN사와 직접 주고받는다. (데모 VAN, 계약 후 VAN사 API)
//  - BRIDGE : 카운터 PC의 MAYDIN Bridge가 카드 단말기·VAN Agent와 통신하고, 서버는 Bridge가 서명한 결과만 검증한다.
//  - MANUAL : 기존 단말기에서 단독 승인한 뒤 승인번호만 입력한다. 서버가 확인할 수 없어 '미대조'로 남는다.
//
// 모든 결과는 { status, approvalNumber, cardCompany, vanReference, message } 꼴이다.
//  status: APPROVED(승인) · DECLINED(거절) · UNKNOWN(응답 없음 — 승인됐는지 모름) · NOT_FOUND(조회해 보니 승인 없음)
// UNKNOWN은 절대 자동으로 다시 승인하지 않는다. inquire(대사)로만 APPROVED / NOT_FOUND 를 정한다.
//
// 카드번호·간편결제 바코드·주민번호는 어댑터 밖으로 내보내지도 저장하지도 않는다.

class VanError extends Error {
  constructor(message, status = 402, reason = 'VAN_DECLINED') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

class VanUnavailableError extends VanError {
  constructor(message) {
    super(message, 409, 'VAN_NOT_CONFIGURED');
  }
}

const VAN_COMPANIES = ['KIS정보통신', 'NICE정보통신', 'KSNET', 'KICC', '스마트로', '다우데이타'];

const RESULT_STATUSES = ['APPROVED', 'DECLINED', 'UNKNOWN', 'NOT_FOUND'];

function result(status, fields = {}) {
  if (!RESULT_STATUSES.includes(status)) throw new Error(`알 수 없는 VAN 결과 ${status}`);
  return {
    status,
    approvalNumber: fields.approvalNumber || null,
    cardCompany: fields.cardCompany || null,
    vanReference: fields.vanReference || null,
    originalApprovalNumber: fields.originalApprovalNumber || null,
    maskedIdentity: fields.maskedIdentity || null,
    message: fields.message || null
  };
}

function notSupported(name, action) {
  return () => {
    throw new VanUnavailableError(`${name}은(는) ${action}을(를) 지원하지 않습니다.`);
  };
}

// 어댑터가 빠뜨린 기능은 '지원 안 함' 오류로 채운다. 호출하는 쪽은 어댑터 종류를 몰라도 된다.
function defineAdapter(spec) {
  const name = spec.label || spec.mode;
  return {
    kind: 'SERVER',
    isDemo: false,
    available: () => true,
    approve: notSupported(name, '서버 승인'),
    cancel: notSupported(name, '서버 취소'),
    inquire: notSupported(name, '거래 조회'),
    issueCashReceipt: notSupported(name, '현금영수증'),
    verifyBridgeResult: notSupported(name, 'Bridge 결과 검증'),
    ...spec
  };
}

module.exports = { RESULT_STATUSES, VAN_COMPANIES, VanError, VanUnavailableError, defineAdapter, result };
