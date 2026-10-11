import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { check, done } from './lib.mjs';

const publicDir = new URL('../public/', import.meta.url);
const read = (file) => readFileSync(new URL(file, publicDir), 'utf8');

console.log('[POS 화면 파일 — 장애 중 다시 열기]');
{
  const shell = vm.runInNewContext(`${read('pos-sw.js')}\n;SHELL`, {
    self: { addEventListener() {}, location: { origin: 'http://127.0.0.1' } }
  });
  const assets = [...read('pos.html').matchAll(/(?:src|href)="(\/[^"?]+\.(?:js|css))/g)].map((m) => m[1]);
  const missing = assets.filter((path) => !shell.includes(path));
  check('pos.html이 읽는 파일을 모두 보관', assets.length > 10 && missing.length === 0, missing);
  check('API 경로는 보관하지 않음', shell.every((path) => !path.startsWith('/api/')), shell);
  check('보관소 파일이 대기열 파일보다 먼저 읽힘', assets.indexOf('/pos/local-store.js') >= 0 && assets.indexOf('/pos/local-store.js') < assets.indexOf('/pos/recovery.js'));
}

function fakeLocalStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    failWrites: false,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: (key) => data.delete(key)
  };
}

function loadStore(localStorage) {
  return vm.runInNewContext(`${read('pos/local-store.js')}\n;({ LocalStore, minimizeQueued })`, {
    window: {},
    navigator: {},
    localStorage,
    structuredClone
  });
}

console.log('[이 기기 보관소 — IndexedDB가 없을 때 localStorage]');
{
  const legacy = [
    {
      client_sale_id: 'sale-1',
      body: { items: [{ product_id: 1, quantity: 1, price: 1000 }], payments: [{ method: 'CASH', amount: 1000 }] },
      summary: { total: 1000, lines: [{ name: '테스트 약', quantity: 1, price: 1000, product_type: 'GENERAL' }], customer: '홍길동' },
      status: 'PENDING'
    }
  ];
  const storage = fakeLocalStorage({ maydin_pos_queue_1: JSON.stringify(legacy) });
  const { LocalStore } = loadStore(storage);
  await LocalStore.open(1);
  check('IndexedDB 없으면 localStorage 사용', LocalStore.backend === 'local', LocalStore.backend);
  const queue = LocalStore.get('queue', []);
  check('예전 대기열을 읽음', queue.length === 1 && queue[0].client_sale_id === 'sale-1', queue);
  check('예전 대기열의 고객 이름은 버림', !('customer' in queue[0].summary) && !JSON.stringify(queue).includes('홍길동'), queue);
  check('보낼 내용(body)은 그대로', queue[0].body.payments[0].amount === 1000);

  queue[0].status = 'FAILED';
  check('읽은 사본을 고쳐도 저장값은 그대로', LocalStore.get('queue')[0].status === 'PENDING');

  check('비우면 기기에서 지움', (await LocalStore.set('queue', null)) === true && !storage.data.has('maydin_pos_queue_1'));
  check('지운 뒤 빈 값', LocalStore.get('queue', []).length === 0);
  await LocalStore.set('queue', [{ client_sale_id: 'sale-x' }]);
  await LocalStore.set('queue', []);
  check('빈 목록도 기기에서 지움', !storage.data.has('maydin_pos_queue_1') && LocalStore.get('queue') === null);

  storage.failWrites = true;
  const ok = await LocalStore.set('queue', [{ client_sale_id: 'sale-2' }]);
  check('저장 실패를 알려 줌', ok === false);
  check('저장 실패하면 화면 사본도 되돌림', LocalStore.get('queue', []).length === 0, LocalStore.get('queue'));
  storage.failWrites = false;

  await LocalStore.set('outage', { started_at: '2026-01-01T00:00:00Z' });
  await LocalStore.open(2);
  check('약국별로 나눠 보관', LocalStore.get('outage') === null && LocalStore.get('queue') === null);
  await LocalStore.open(1);
  check('같은 약국으로 돌아오면 다시 보임', LocalStore.get('outage')?.started_at === '2026-01-01T00:00:00Z');
}

console.log('[새로 보관하는 판매 — 최소 정보]');
{
  const src = read('pos/recovery.js');
  const start = src.indexOf('async function queueSale');
  const queueSale = src.slice(start, src.indexOf('const queue = saleQueue();', start));
  check('장애 중 판매에 고객 이름을 남기지 않음', start >= 0 && !/state\.customer\.name/.test(queueSale));
}

done();
