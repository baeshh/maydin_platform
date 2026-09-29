const crypto = require('crypto');

const VAN_COMPANIES = ['KIS정보통신', 'NICE정보통신', 'KSNET', 'KICC', '스마트로', '다우데이타'];
const VAN_MODES = { MANUAL: '카드 수동 승인', DEMO: 'VAN 자동 승인 (데모)' };

const DEMO_CARD_COMPANIES = ['신한카드', '삼성카드', 'KB국민카드', '현대카드', '롯데카드', '하나카드', 'BC카드', 'NH농협카드'];
const DEMO_EASY_PAY = [
  { prefix: '28', name: '카카오페이' },
  { prefix: '29', name: '네이버페이' },
  { prefix: '30', name: '토스페이' },
  { prefix: '31', name: '페이코' }
];

class VanError extends Error {
  constructor(message) {
    super(message);
    this.status = 402;
  }
}

function approvalNumber() {
  return String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

function pick(list) {
  return list[crypto.randomInt(0, list.length)];
}

function maskIdentity(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  if (digits.length === 10 && !digits.startsWith('01')) return `${digits.slice(0, 3)}-**-***${digits.slice(-2)}`;
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

// 실제 VAN 전문 대신 승인번호만 만들어 주는 데모 어댑터. 카드번호·결제 바코드는 받지도 저장하지도 않는다.
const demoAdapter = {
  isDemo: true,

  approveCard({ amount, installmentMonths }) {
    if (installmentMonths > 0 && amount < 50000) {
      throw new VanError('[데모] 5만원 미만은 할부 결제를 할 수 없습니다. (카드사 거절)');
    }
    return {
      approval_number: approvalNumber(),
      card_company: pick(DEMO_CARD_COMPANIES),
      message: '[데모] 카드 승인 완료'
    };
  },

  approveEasyPay({ amount, barcode }) {
    const code = String(barcode || '').replace(/\s/g, '');
    if (!/^\d{16,24}$/.test(code)) {
      throw new VanError('[데모] 간편결제 바코드는 숫자 16~24자리입니다. 고객 앱의 결제 바코드를 다시 스캔해 주세요.');
    }
    if (amount <= 0) throw new VanError('[데모] 결제 금액이 올바르지 않습니다.');
    const provider = DEMO_EASY_PAY.find((item) => code.startsWith(item.prefix)) || { name: '간편결제' };
    return {
      approval_number: approvalNumber(),
      card_company: provider.name,
      message: `[데모] ${provider.name} 승인 완료`
    };
  },

  cancel({ approval_number: original }) {
    return {
      approval_number: approvalNumber(),
      original_approval_number: original,
      message: '[데모] 승인 취소 완료'
    };
  },

  issueCashReceipt({ identity, purpose }) {
    const masked = maskIdentity(identity);
    if (!masked) throw new VanError('[데모] 휴대폰번호 또는 사업자번호를 입력해 주세요.');
    return {
      approval_number: approvalNumber(),
      masked_identity: masked,
      message: `[데모] 현금영수증 ${purpose === 'EXPENSE' ? '지출증빙' : '소득공제'} 발급 완료`
    };
  }
};

function adapterFor(terminal) {
  if (terminal && terminal.van_mode === 'DEMO') return demoAdapter;
  return null;
}

module.exports = {
  VAN_COMPANIES,
  VAN_MODES,
  VanError,
  adapterFor,
  demoAdapter,
  maskIdentity
};
