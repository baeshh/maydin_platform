// Bridge가 영수증 프린터로 ESC/POS를 보내는 길.
//  tcp://192.168.0.50:9100   네트워크(LAN) 영수증 프린터. 보내기 전후에 실시간 상태(DLE EOT)로 용지·덮개를 확인한다.
//  device:/dev/usb/lp0       USB·직렬 장치 파일. 한쪽 방향이라 용지 상태는 알 수 없다.
//  file:/경로/폴더            출력 대신 .bin(ESC/POS)과 .txt(미리보기)를 남긴다. 연습·점검용.
// Windows의 USB 프린터는 RAW 인쇄 대기열이나 제조사 SDK를 쓰는 실제 Bridge에서 다룬다.
const fs = require('fs');
const net = require('net');
const path = require('path');

const DLE_EOT = (n) => Buffer.from([0x10, 0x04, n]);

const STATE_MESSAGES = {
  READY: '출력 가능',
  PAPER_NEAR_END: '용지가 거의 떨어졌습니다',
  PAPER_OUT: '용지가 없습니다. 용지를 넣어 주세요',
  COVER_OPEN: '프린터 덮개가 열려 있습니다',
  OFFLINE: '프린터에 연결할 수 없습니다. 전원·케이블·네트워크를 확인해 주세요',
  ERROR: '프린터 오류입니다. 전원을 껐다 켜 주세요',
  UNKNOWN: '프린터 상태를 알 수 없는 연결입니다(보내기만 함)',
  NOT_CONFIGURED: '이 Bridge에 영수증 프린터가 설정되지 않았습니다'
};
const PRINTABLE = ['READY', 'PAPER_NEAR_END', 'UNKNOWN'];

function parseTarget(spec) {
  const value = String(spec || '').trim();
  if (!value) return { kind: 'none' };
  if (value.startsWith('tcp://')) {
    const url = new URL(value);
    return { kind: 'tcp', host: url.hostname, port: Number(url.port || 9100) };
  }
  if (value.startsWith('device:')) return { kind: 'device', path: value.slice('device:'.length) };
  if (value.startsWith('file:')) return { kind: 'file', dir: value.slice('file:'.length) };
  throw new Error(`알 수 없는 프린터 주소입니다: ${value} (tcp://주소:9100 · device:/경로 · file:/폴더)`);
}

// DLE EOT 1(프린터) · 2(오프라인 원인) · 4(롤 용지) 응답으로 상태를 정한다.
function stateFromBytes(printer, offline, paper) {
  if (offline & 0x04) return 'COVER_OPEN';
  if (offline & 0x20 || paper & 0x60) return 'PAPER_OUT';
  if (offline & 0x40) return 'ERROR';
  if (printer & 0x08) return 'OFFLINE';
  if (paper & 0x0c) return 'PAPER_NEAR_END';
  return 'READY';
}

function describe(state, extra = {}) {
  return { state, message: STATE_MESSAGES[state] || state, ...extra };
}

// 한 연결에서 상태 조회와 출력을 차례로 한다.
class TcpPrinter {
  constructor({ host, port }, { timeout = 3000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };
      socket.setTimeout(this.timeout, () => fail(new Error('timeout')));
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.flush();
        });
        this.socket = socket;
        resolve(this);
      });
    });
  }

  flush() {
    while (this.waiters.length && this.buffer.length) {
      const waiter = this.waiters.shift();
      const byte = this.buffer[0];
      this.buffer = this.buffer.subarray(1);
      waiter.resolve(byte);
    }
  }

  readByte() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error('status timeout'));
      }, this.timeout);
      const done = (byte) => {
        clearTimeout(timer);
        resolve(byte);
      };
      this.waiters.push({ resolve: done });
      this.flush();
    });
  }

  async query(n) {
    this.socket.write(DLE_EOT(n));
    return this.readByte();
  }

  async status() {
    const printer = await this.query(1);
    const offline = await this.query(2);
    const paper = await this.query(4);
    return stateFromBytes(printer, offline, paper);
  }

  write(bytes) {
    return new Promise((resolve, reject) => this.socket.write(bytes, (error) => (error ? reject(error) : resolve())));
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

async function printerStatus(target, options = {}) {
  if (target.kind === 'none') return describe('NOT_CONFIGURED');
  if (target.kind === 'file') return describe('READY', { detail: `파일로 저장: ${target.dir}` });
  if (target.kind === 'device') {
    try {
      fs.accessSync(target.path, fs.constants.W_OK);
      return describe('UNKNOWN', { detail: target.path });
    } catch {
      return describe('OFFLINE', { detail: target.path });
    }
  }
  const printer = new TcpPrinter(target, options);
  try {
    await printer.connect();
    return describe(await printer.status(), { detail: `${target.host}:${target.port}` });
  } catch {
    return describe('OFFLINE', { detail: `${target.host}:${target.port}` });
  } finally {
    printer.close();
  }
}

function failed(state, message) {
  return { status: 'FAILED', error_code: state, message: message || STATE_MESSAGES[state] || state };
}

// 보내기 전 상태가 나쁘면 아무것도 보내지 않는다(FAILED). 보낸 뒤 용지가 떨어졌으면 일부만 나왔을 수 있다고 알린다.
async function sendToPrinter(target, bytes, { jobId, preview, settleMs = 300, timeout = 3000 } = {}) {
  if (target.kind === 'none') return failed('NOT_CONFIGURED');
  if (target.kind === 'file') {
    fs.mkdirSync(target.dir, { recursive: true });
    const base = path.join(target.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${jobId}`);
    fs.writeFileSync(`${base}.bin`, bytes);
    if (preview) fs.writeFileSync(`${base}.txt`, preview);
    return { status: 'PRINTED', message: `파일로 저장했습니다 (${path.basename(base)}.txt)` };
  }
  if (target.kind === 'device') {
    try {
      fs.writeFileSync(target.path, bytes);
      return { status: 'PRINTED', message: '프린터로 보냈습니다(장치 연결은 용지 상태를 확인할 수 없음)' };
    } catch (error) {
      return failed('OFFLINE', `${STATE_MESSAGES.OFFLINE} (${error.code || error.message})`);
    }
  }

  const printer = new TcpPrinter(target, { timeout });
  try {
    await printer.connect();
  } catch {
    return failed('OFFLINE');
  }
  try {
    let state;
    try {
      state = await printer.status();
    } catch {
      return failed('OFFLINE', '프린터가 상태 조회에 답하지 않습니다. 전원·네트워크를 확인해 주세요');
    }
    if (!PRINTABLE.includes(state)) return failed(state);
    await printer.write(bytes);
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
    let after;
    try {
      after = await printer.status();
    } catch {
      return failed('UNKNOWN_RESULT', '보낸 뒤 프린터가 답하지 않습니다. 영수증이 나왔는지 확인해 주세요');
    }
    if (!PRINTABLE.includes(after)) {
      return failed(after, `${STATE_MESSAGES[after] || after}. 출력 도중 멈춰 영수증이 일부만 나왔을 수 있습니다`);
    }
    return { status: 'PRINTED', message: after === 'PAPER_NEAR_END' ? STATE_MESSAGES.PAPER_NEAR_END : null };
  } finally {
    printer.close();
  }
}

module.exports = { STATE_MESSAGES, parseTarget, printerStatus, sendToPrinter, stateFromBytes };
