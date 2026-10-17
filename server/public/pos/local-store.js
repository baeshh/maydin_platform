// MAYDIN POS · 이 기기 보관소 (IndexedDB)
/* 장애 중 판매·장애 시작 시각·장애 대비 상품 목록만 이 기기에 둔다. 약국별로 나눠 보관한다.
   화면은 메모리 사본을 바로 읽고, 쓰기는 사본을 먼저 바꾼 뒤 IndexedDB에 저장한다.
   IndexedDB를 쓸 수 없는 브라우저에서는 localStorage에 둔다. 서버로 보낸 거래는 바로 지운다.
   장애 중 판매는 offline-seal.js로 잠가 둔다. 브라우저 저장소 자체는 암호화되지 않으므로 잠그지 못한 거래는 평문으로 표시한다. */

const LOCAL_DB = 'maydin_pos';
const LOCAL_STORE = 'kv';
const LOCAL_NAMES = ['queue', 'outage', 'catalog'];

const LocalStore = {
  db: null,
  scope: null,
  backend: 'memory',
  cache: new Map(),

  key(name) {
    return `${this.scope}:${name}`;
  },

  legacyKey(name) {
    return `maydin_pos_${name}_${this.scope}`;
  },

  openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(LOCAL_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
  },

  tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(LOCAL_STORE, mode);
      const result = fn(transaction.objectStore(LOCAL_STORE));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('aborted'));
    });
  },

  async open(scope) {
    if (this.scope === String(scope) && this.backend !== 'memory') return;
    this.scope = String(scope);
    this.cache = new Map();
    try {
      if (!window.indexedDB) throw new Error('no indexedDB');
      this.db = this.db || (await this.openDb());
      this.backend = 'indexeddb';
      for (const name of LOCAL_NAMES) {
        const value = await this.tx('readonly', (store) => store.get(this.key(name)));
        if (value !== undefined) this.cache.set(name, value);
      }
      await this.migrateLegacy();
      navigator.storage?.persist?.().catch(() => {});
    } catch {
      this.db = null;
      this.backend = 'local';
      for (const name of LOCAL_NAMES) {
        try {
          const raw = localStorage.getItem(this.legacyKey(name));
          if (raw) this.cache.set(name, name === 'queue' ? JSON.parse(raw).map(minimizeQueued) : JSON.parse(raw));
        } catch {
          /* 깨진 값은 버린다 */
        }
      }
    }
  },

  // 예전 버전이 localStorage에 둔 값을 옮긴다. 장애 중 판매는 합쳐서 하나도 잃지 않게 한다.
  async migrateLegacy() {
    for (const name of LOCAL_NAMES) {
      const raw = localStorage.getItem(this.legacyKey(name));
      if (!raw) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        localStorage.removeItem(this.legacyKey(name));
        continue;
      }
      if (name === 'queue') {
        const current = this.cache.get('queue') || [];
        const known = new Set(current.map((entry) => entry.client_sale_id));
        value = [...current, ...value.filter((entry) => !known.has(entry.client_sale_id)).map(minimizeQueued)];
      } else if (this.cache.has(name)) {
        localStorage.removeItem(this.legacyKey(name));
        continue;
      }
      if (await this.set(name, value)) localStorage.removeItem(this.legacyKey(name));
    }
  },

  // 큰 상품 목록은 그대로, 장애 중 판매·장애 정보는 복사본을 준다(화면에서 고쳐도 저장 전에는 바뀌지 않게).
  get(name, fallback = null) {
    if (!this.cache.has(name)) return fallback;
    const value = this.cache.get(name);
    return name === 'catalog' ? value : structuredClone(value);
  },

  // 빈 목록은 저장하지 않고 지운다(보낸 거래가 기기에 흔적으로 남지 않게).
  async set(name, value) {
    if (Array.isArray(value) && value.length === 0) value = null;
    const had = this.cache.has(name);
    const previous = this.cache.get(name);
    if (value === null || value === undefined) this.cache.delete(name);
    else this.cache.set(name, name === 'catalog' ? value : structuredClone(value));
    try {
      if (this.backend === 'indexeddb') {
        await this.tx('readwrite', (store) => (value === null || value === undefined ? store.delete(this.key(name)) : store.put(value, this.key(name))));
      } else if (this.backend === 'local') {
        if (value === null || value === undefined) localStorage.removeItem(this.legacyKey(name));
        else localStorage.setItem(this.legacyKey(name), JSON.stringify(value));
      }
      return true;
    } catch {
      if (had) this.cache.set(name, previous);
      else this.cache.delete(name);
      return false;
    }
  }
};

// 기기에 남기는 판매는 서버에 다시 보낼 때 필요한 것만 둔다. 고객 이름 등은 남기지 않는다.
// 잠근 거래는 금액·건수·결제 방법 요약만 평문이다.
function minimizeQueued(entry) {
  if (entry.sealed) {
    const { client_sale_id, occurred_at, status, error, outage_id, imported, sealed, summary = {} } = entry;
    return { client_sale_id, occurred_at, status, error, outage_id, imported, sealed, summary: { total: summary.total, count: summary.count, methods: summary.methods } };
  }
  const { summary = {}, ...rest } = entry;
  return {
    ...rest,
    summary: {
      total: summary.total,
      lines: (summary.lines || []).map(({ name, quantity, price, product_type }) => ({ name, quantity, price, product_type }))
    }
  };
}
