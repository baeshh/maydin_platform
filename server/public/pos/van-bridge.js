// MAYDIN POS · 카운터 PC의 MAYDIN Bridge 연결 (maydin-bridge/1)
// Bridge는 이 PC에서 카드 단말기·VAN Agent와 통신하고, 결과를 Bridge 키로 서명해 돌려준다.
// 화면은 서명된 결과를 서버에 그대로 넘길 뿐이며, 서버가 서명을 확인한 결과만 승인으로 인정한다.

const BRIDGE_URL_KEY = 'maydin_bridge_url';
const BRIDGE_DEFAULT_URL = 'http://127.0.0.1:18181';

class BridgeError extends Error {
  constructor(message, { unreachable = false, timeout = false } = {}) {
    super(message);
    this.unreachable = unreachable;
    this.timeout = timeout;
  }
}

const VanBridge = {
  url() {
    return localStorage.getItem(BRIDGE_URL_KEY) || BRIDGE_DEFAULT_URL;
  },

  setUrl(value) {
    const url = String(value || '').trim().replace(/\/+$/, '');
    if (!url || url === BRIDGE_DEFAULT_URL) localStorage.removeItem(BRIDGE_URL_KEY);
    else localStorage.setItem(BRIDGE_URL_KEY, url);
  },

  async call(path, body, { timeout = 10000, timeoutMessage } = {}) {
    let res;
    try {
      res = await fetch(`${this.url()}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new BridgeError(timeoutMessage || '카드 단말기 응답이 없습니다. 카드를 다시 승인하지 말고 결과 조회를 눌러 주세요.', { timeout: true });
      }
      throw new BridgeError('이 PC의 MAYDIN Bridge에 연결할 수 없습니다. Bridge 프로그램이 켜져 있는지 확인해 주세요.', { unreachable: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new BridgeError(data.message || `Bridge 오류 (${res.status})`);
    return data;
  },

  status() {
    return this.call('/v1/status', undefined, { timeout: 3000 });
  },

  // 서버에서 받은 Bridge 키를 이 PC의 Bridge에 넣는다. 키는 브라우저에 남기지 않는다.
  pair({ terminalId, bridgeKey, serverOrigin }) {
    return this.call('/v1/pair', { terminal_id: terminalId, bridge_key: bridgeKey, server_origin: serverOrigin }, { timeout: 5000 });
  },

  // 고객이 카드를 꽂고 서명하는 시간까지 기다린다.
  approve(request) {
    return this.call('/v1/approve', request, { timeout: 90000 });
  },

  cancel(request) {
    return this.call('/v1/cancel', { ...request, request_id: request.request_id || newSaleId() }, { timeout: 90000 });
  },

  inquire(request) {
    return this.call('/v1/inquire', request, { timeout: 15000 });
  },

  // 현금영수증 발급·취소. 고객이 단말기 키패드에 번호를 누르는 시간까지 기다린다.
  // 직원이 화면에 입력한 식별번호(identity)는 이 PC의 Bridge로만 가고 서버로는 보내지 않는다.
  cashReceipt(request) {
    return this.call('/v1/cash-receipt', { ...request, request_id: request.request_id || newSaleId() }, {
      timeout: 90000,
      timeoutMessage: '단말기 응답이 없습니다. 현금영수증을 다시 발급하지 말고 승인 정리에서 결과를 조회해 주세요.'
    });
  },

  // 영수증 프린터 출력. 같은 작업 번호는 Bridge가 한 번만 출력한다.
  print(request) {
    return this.call('/v1/print', request, {
      timeout: 30000,
      timeoutMessage: '프린터 응답이 없습니다. 영수증이 나왔는지 확인해 주세요. 다시 출력해도 이미 나온 영수증은 또 뽑지 않습니다.'
    });
  },

  printerStatus() {
    return this.call('/v1/printer/status', undefined, { timeout: 8000 });
  }
};
