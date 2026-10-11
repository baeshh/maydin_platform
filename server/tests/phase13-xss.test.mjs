import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
const publicDir = new URL('../public/', import.meta.url);

const owner = await login('owner@apharmacy.kr', 'owner1234');
let seq = 0;
async function create(body) {
  seq += 1;
  return api('/products', {
    token: owner,
    method: 'POST',
    body: { product_name: `XSS 테스트 ${process.pid}-${seq}`, price: 1000, stock_quantity: 5, product_type: 'GENERAL', online_visible: true, ...body }
  });
}
const mallProduct = async (id) =>
  (await api('/products/mall?pharmacyCode=A001', { token: owner })).data.products.find((p) => p.id === id);

console.log('[이미지 주소 — 저장할 때 http(s)·서버 경로만 받음]');
{
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example/x.png', 'https://a.example/x.png" onerror="alert(1)', '/\\evil.example/x.png', 'vbscript:msgbox(1)']) {
    const res = await create({ thumbnail_url: bad });
    check(`거절: ${bad}`, res.status === 400 && /이미지 주소/.test(res.data.message), res.data);
  }
  let res = await create({ thumbnail_url: 'https://cdn.example.com/a b.png'.replace(' ', '%20') });
  check('https 주소는 저장', res.status === 201 && res.data.product.thumbnail_url === 'https://cdn.example.com/a%20b.png', res.data);
  res = await create({ thumbnail_url: '/uploads/vitamin.png' });
  check('이 서버 경로는 저장', res.status === 201 && res.data.product.thumbnail_url === '/uploads/vitamin.png', res.data);
  res = await create({ thumbnail_url: '' });
  check('비워 두면 이미지 없음', res.status === 201 && res.data.product.thumbnail_url === null, res.data);

  const id = res.data.product.id;
  res = await api(`/products/${id}`, { token: owner, method: 'PATCH', body: { thumbnail_url: 'javascript:alert(1)' } });
  check('수정할 때도 거절', res.status === 400, res.data);
  res = await api(`/products/${id}`, { token: owner, method: 'PATCH', body: { thumbnail_url: 'https://cdn.example.com/ok.png' } });
  check('수정으로 https 주소 저장', res.status === 200 && res.data.product.thumbnail_url === 'https://cdn.example.com/ok.png', res.data);
}

console.log('[예전에 저장된 잘못된 주소 — 몰 응답에서 빼고, 다른 항목 수정은 막지 않음]');
{
  const res = await create({ product_name: '<img src=x onerror=alert(1)>' });
  const id = res.data.product.id;
  db.prepare('UPDATE products SET thumbnail_url = ? WHERE id = ?').run('javascript:alert(document.cookie)', id);
  let product = await mallProduct(id);
  check('몰 응답에서 잘못된 이미지 주소는 null', product && product.thumbnail_url === null, product);
  check('상품명은 원문 그대로 내려줌(화면에서 글자로만 표시)', product.product_name === '<img src=x onerror=alert(1)>', product);

  const patch = await api(`/products/${id}`, { token: owner, method: 'PATCH', body: { price: 1200 } });
  check('이미지 외 수정은 그대로 됨', patch.status === 200 && patch.data.product.price === 1200, patch.data);
  check('수정하면서 잘못된 주소는 비워짐', patch.data.product.thumbnail_url === null, patch.data.product);
}

console.log('[화면 공용 도구 — app.js]');
{
  const context = { location: { origin: 'http://localhost:3001' }, URL, localStorage: {}, sessionStorage: {}, document: {} };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('app.js', publicDir), 'utf8'), context);
  const { safeUrl, escapeHtml } = context;
  check('safeUrl: https 허용', safeUrl('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png');
  check('safeUrl: 서버 경로는 절대 주소로', safeUrl('/uploads/a.png') === 'http://localhost:3001/uploads/a.png');
  for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'vbscript:x', '/\\evil.example']) {
    check(`safeUrl 거절: ${JSON.stringify(bad)}`, safeUrl(bad) === '');
  }
  check('safeUrl: 따옴표는 인코딩돼 속성을 못 벗어남', !safeUrl('https://a.example/x"onerror=1').includes('"'));
  check('escapeHtml: 다섯 글자 모두 이스케이프', escapeHtml(`<a href="x" onclick='y'>&</a>`) === '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  check('escapeHtml: null·undefined는 빈 문자열', escapeHtml(null) === '' && escapeHtml(undefined) === '');
}

console.log('[쇼핑 화면 — 서버 값을 HTML 문자열로 넣지 않음]');
for (const page of ['store.html', 'cart.html', 'order-pickup.html', 'order-delivery.html']) {
  const html = readFileSync(new URL(page, publicDir), 'utf8');
  check(`${page}: innerHTML 없음`, !/\.innerHTML\s*=|insertAdjacentHTML/.test(html));
}

done();
