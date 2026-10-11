const { VanUnavailableError, defineAdapter } = require('./van-adapter');
const { verifyBridgeResult } = require('./bridge-adapter');

// KIS정보통신 연동 뼈대. 구조는 NICE와 같다. 단말기 승인은 Bridge가, 승인 확인은 KIS 거래 조회로 한다.
const REQUIREMENTS = ['KIS 가맹점 번호', '카운터별 TID', '거래 조회 API 인증키', 'KIS VAN Agent 연동 규격서'];

const kisAdapter = defineAdapter({
  mode: 'KIS',
  label: 'KIS정보통신 연동',
  kind: 'BRIDGE',
  requirements: REQUIREMENTS,
  available: () => Boolean(process.env.KIS_VAN_MERCHANT_ID && process.env.KIS_VAN_API_KEY && process.env.KIS_VAN_ENABLED === '1'),
  verifyBridgeResult,
  inquire() {
    throw new VanUnavailableError(`KIS 거래 조회는 계약 후 연동합니다. 필요한 것: ${REQUIREMENTS.join(', ')}`);
  }
});

module.exports = { kisAdapter };
