// POS 화면 파일만 보관해 두었다가 서버에 연결되지 않을 때 다시 열 수 있게 한다.
// API 응답(판매·고객 정보)은 절대 보관하지 않는다. 연결되어 있으면 항상 새 파일을 받는다.
// pos.html이 읽는 파일이 바뀌면 이 목록과 CACHE 이름을 함께 바꾼다.
const CACHE = 'maydin-pos-shell-v4';
const POS_SCRIPTS = [
  'core', 'auth', 'offline-seal', 'local-store', 'recovery', 'session', 'catalog', 'cart', 'customer', 'van-bridge', 'payment',
  'approvals', 'receipt', 'printer', 'cash-receipt', 'refund', 'pickup', 'hold', 'inventory', 'terminal', 'counter', 'report', 'main'
];
const SHELL = [
  '/pos.html',
  '/pos/pos.css',
  '/app.js',
  '/scan-kit.js',
  '/vendor/jsbarcode.min.js',
  '/vendor/qrcode.js',
  ...POS_SCRIPTS.map((name) => `/pos/${name}.js`)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname === '/pos' ? '/pos.html' : url.pathname;
  if (!SHELL.includes(path)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(path, copy));
        }
        return response;
      })
      .catch(() => caches.match(path))
  );
});
