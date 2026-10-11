const { VanError, defineAdapter, result } = require('./van-adapter');

// 기존 카드 단말기에서 단독 승인하고 승인번호만 옮겨 적는 방식. 시범 운영용이다.
// 서버는 이 번호가 진짜인지 알 수 없으므로 결제는 '미대조'로 남고, 약국 관리자가 단말기 영수증·VAN 매출 내역과
// 맞춰 본 뒤에야 '대조 완료'가 된다. 대조하지 않은 수동 승인이 있으면 그 카운터는 일마감할 수 없다.
const manualAdapter = defineAdapter({
  mode: 'MANUAL',
  label: '카드 수동 승인',
  kind: 'MANUAL',

  record({ approvalNumber, cardCompany }) {
    const number = String(approvalNumber || '').trim();
    if (!/^[0-9A-Za-z-]{4,20}$/.test(number)) throw new VanError('단말기 영수증의 승인번호(영문·숫자 4~20자)를 입력해 주세요.', 400);
    if (/^\d{13,19}$/.test(number.replace(/-/g, ''))) {
      throw new VanError('카드번호로 보이는 값은 저장할 수 없습니다. 단말기 영수증의 승인번호만 입력해 주세요.', 400);
    }
    return result('APPROVED', { approvalNumber: number, cardCompany, message: '수동 입력 승인번호 · 단말기 영수증 대조 필요' });
  }
});

module.exports = { manualAdapter };
