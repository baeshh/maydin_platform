const { VanUnavailableError, defineAdapter } = require('./van-adapter');
const { verifyBridgeResult } = require('./bridge-adapter');

// NICE정보통신 연동 뼈대. 단말기 승인은 카운터 PC의 NICE VAN Agent를 MAYDIN Bridge가 호출하고,
// 서버는 Bridge 서명 결과를 받은 뒤 NICE 거래 조회 API로 한 번 더 확인한다(inquire).
// 계약 전이라 아래 값이 없으면 이 방식을 고를 수 없다.
const REQUIREMENTS = ['NICE 가맹점 번호', '카운터별 TID', '거래 조회 API 인증키', 'VAN Agent 연동 규격서(SDK)'];

const niceAdapter = defineAdapter({
  mode: 'NICE',
  label: 'NICE정보통신 연동',
  kind: 'BRIDGE',
  requirements: REQUIREMENTS,
  available: () => Boolean(process.env.NICE_VAN_MERCHANT_ID && process.env.NICE_VAN_API_KEY && process.env.NICE_VAN_ENABLED === '1'),
  verifyBridgeResult,
  inquire() {
    // 계약 후: NICE 거래 조회 API(가맹점 번호 + TID + 요청 번호)로 승인 여부를 확인한다.
    throw new VanUnavailableError(`NICE 거래 조회는 계약 후 연동합니다. 필요한 것: ${REQUIREMENTS.join(', ')}`);
  }
});

module.exports = { niceAdapter };
