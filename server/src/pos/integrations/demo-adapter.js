const crypto = require('crypto');
const { getOne, run } = require('../../db');
const { testPaymentsAllowed } = require('../../services/payment-policy');
const { IdentityError, classifyIdentity } = require('./cash-identity');
const { VanError, defineAdapter, result } = require('./van-adapter');

const DEMO_CARD_COMPANIES = ['신한카드', '삼성카드', 'KB국민카드', '현대카드', '롯데카드', '하나카드', 'BC카드', 'NH농협카드'];
const DEMO_EASY_PAY = [
  { prefix: '28', name: '카카오페이' },
  { prefix: '29', name: '네이버페이' },
  { prefix: '30', name: '토스페이' },
  { prefix: '31', name: '페이코' }
];

// 응답 끊김 연습용. 데모에서만 받는다.
const DEMO_SIMULATIONS = {
  TIMEOUT_APPROVED: 'VAN사에서는 승인됐지만 응답이 끊김',
  TIMEOUT_NOT_APPROVED: 'VAN사에 닿기 전에 끊김'
};

function approvalNumber() {
  return String(crypto.randomInt(0, 1e8)).padStart(8, '0');
}

function pick(list) {
  return list[crypto.randomInt(0, list.length)];
}

function maskIdentity(value) {
  try {
    return classifyIdentity(value).masked;
  } catch {
    return null;
  }
}

// 데모 VAN사 서버의 거래 원장에 남긴다. 결과 조회는 이 원장만 본다.
function ledger(pharmacyId, requestId, fields) {
  if (!requestId) return;
  run(
    `INSERT OR IGNORE INTO van_demo_ledger (request_id, pharmacy_id, transaction_type, status, amount, approval_number, card_company, original_approval_number)
     VALUES (@request_id, @pharmacy_id, @transaction_type, @status, @amount, @approval_number, @card_company, @original_approval_number)`,
    { request_id: requestId, pharmacy_id: pharmacyId, original_approval_number: null, card_company: null, ...fields }
  );
}

// 실제 VAN 전문 대신 승인번호만 만들어 주는 데모 VAN. 카드번호·결제 바코드는 받지도 저장하지도 않는다.
const demoAdapter = defineAdapter({
  mode: 'DEMO',
  label: 'VAN 자동 승인 (데모)',
  isDemo: true,
  available: () => testPaymentsAllowed(),

  approve({ pharmacyId, requestId, method, amount, installmentMonths = 0, barcode, simulate }) {
    let cardCompany;
    if (method === 'CARD') {
      if (installmentMonths > 0 && amount < 50000) throw new VanError('[데모] 5만원 미만은 할부 결제를 할 수 없습니다. (카드사 거절)');
      cardCompany = pick(DEMO_CARD_COMPANIES);
    } else if (method === 'EASY_PAY') {
      const code = String(barcode || '').replace(/\s/g, '');
      if (!/^\d{16,24}$/.test(code)) {
        throw new VanError('[데모] 간편결제 바코드는 숫자 16~24자리입니다. 고객 앱의 결제 바코드를 다시 스캔해 주세요.');
      }
      cardCompany = (DEMO_EASY_PAY.find((item) => code.startsWith(item.prefix)) || { name: '간편결제' }).name;
    } else {
      throw new VanError('VAN 승인은 카드·간편결제만 가능합니다.', 400);
    }
    if (simulate === 'TIMEOUT_NOT_APPROVED') return result('UNKNOWN', { message: `[데모] ${DEMO_SIMULATIONS[simulate]}` });
    const number = approvalNumber();
    ledger(pharmacyId, requestId, { transaction_type: 'APPROVE', status: 'APPROVED', amount, approval_number: number, card_company: cardCompany });
    if (simulate === 'TIMEOUT_APPROVED') return result('UNKNOWN', { message: `[데모] ${DEMO_SIMULATIONS[simulate]}` });
    return result('APPROVED', {
      approvalNumber: number,
      cardCompany,
      vanReference: requestId ? `DEMO-${requestId.slice(0, 8)}` : null,
      message: `[데모] ${method === 'CARD' ? '카드' : cardCompany} 승인 완료`
    });
  },

  cancel({ pharmacyId, requestId, original, amount }) {
    const number = approvalNumber();
    ledger(pharmacyId, requestId, {
      transaction_type: 'CANCEL',
      status: 'APPROVED',
      amount,
      approval_number: number,
      card_company: original.card_company || null,
      original_approval_number: original.approval_number
    });
    return result('APPROVED', {
      approvalNumber: number,
      cardCompany: original.card_company,
      originalApprovalNumber: original.approval_number,
      message: '[데모] 승인 취소 완료'
    });
  },

  inquire({ pharmacyId, requestId }) {
    const row = getOne('SELECT * FROM van_demo_ledger WHERE request_id = @id AND pharmacy_id = @pharmacy_id', {
      id: requestId,
      pharmacy_id: pharmacyId
    });
    if (!row) return result('NOT_FOUND', { message: '[데모] VAN사에 해당 승인 요청 기록이 없습니다.' });
    return result('APPROVED', {
      approvalNumber: row.approval_number,
      cardCompany: row.card_company,
      vanReference: `DEMO-${requestId.slice(0, 8)}`,
      message: '[데모] VAN사 조회 결과 승인 확인'
    });
  },

  issueCashReceipt({ identity, purpose }) {
    let classified;
    try {
      classified = classifyIdentity(identity);
    } catch (error) {
      if (error instanceof IdentityError) throw new VanError(`[데모] ${error.message}`, 400, 'IDENTITY_INVALID');
      throw error;
    }
    return result('APPROVED', {
      approvalNumber: approvalNumber(),
      maskedIdentity: classified.masked,
      message: `[데모] 현금영수증 ${purpose === 'EXPENSE' ? '지출증빙' : '소득공제'} 발급 완료`
    });
  }
});

module.exports = { DEMO_SIMULATIONS, demoAdapter, maskIdentity };
