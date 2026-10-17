// 현금영수증 식별번호 구분·가리기. Bridge(카운터 PC)와 데모 VAN이 쓴다. 가린 값만 서버로 간다.
//  PHONE     휴대폰번호 10~11자리 (01로 시작)
//  BUSINESS  사업자등록번호 10자리 (지출증빙)
//  CARD      현금영수증카드·신용카드 번호 16~19자리
//  SELF      국세청 자진발급 번호 010-000-1234 (고객이 번호를 주지 않을 때)
// 주민등록번호(13자리)는 받지 않는다.

const SELF_ISSUE_IDENTITY = '010-000-1234';
const IDENTITY_TYPES = ['PHONE', 'BUSINESS', 'CARD', 'SELF'];

class IdentityError extends Error {}

function classifyIdentity(value) {
  const digits = String(value || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) throw new IdentityError('식별번호는 숫자만 입력해 주세요.');
  if (digits.length === 13) throw new IdentityError('주민등록번호는 받지 않습니다. 휴대폰번호·현금영수증카드·사업자번호를 입력해 주세요.');
  if (digits.startsWith('01') && (digits.length === 10 || digits.length === 11)) {
    return { type: 'PHONE', masked: `${digits.slice(0, 3)}-****-${digits.slice(-4)}` };
  }
  if (digits.length === 10) return { type: 'BUSINESS', masked: `${digits.slice(0, 3)}-**-***${digits.slice(-2)}` };
  if (digits.length >= 16 && digits.length <= 19) return { type: 'CARD', masked: `****-****-****-${digits.slice(-4)}` };
  throw new IdentityError('휴대폰번호(10~11자리)·사업자번호(10자리)·현금영수증카드(16~19자리)만 받을 수 있습니다.');
}

module.exports = { IDENTITY_TYPES, IdentityError, SELF_ISSUE_IDENTITY, classifyIdentity };
