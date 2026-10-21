import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { BASE, api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sharp = require('sharp');
const db = new Database(process.env.DB_PATH);

// 상품 사진(촬영·업로드·공유)과 식약처 건강기능식품 신고 정보 연결.
const admin = await login('admin@maydin.kr', 'admin1234');
const stamp = String(Date.now()).slice(-5);

async function openPharmacy(letter) {
  const code = `PM${letter}${stamp}`;
  const email = `${code.toLowerCase()}@media.kr`;
  await api('/admin/pharmacies', {
    token: admin,
    method: 'POST',
    body: { pharmacy_code: code, pharmacy_name: `${letter}사진약국`, owner_name: `${letter}약사`, store_slug: `media-${code.toLowerCase()}`, owner_email: email, owner_password: 'mediaOwner2026' }
  });
  return { code, id: db.prepare('SELECT id FROM pharmacies WHERE pharmacy_code = ?').get(code).id, owner: await login(email, 'mediaOwner2026') };
}

const A = await openPharmacy('A');
const B = await openPharmacy('B');
const BARCODE = `880${stamp}12345`.slice(0, 13);
const product = async (pharmacy, name) =>
  (await api('/products', { token: pharmacy.owner, method: 'POST', body: { product_name: name, price: 20000, stock_quantity: 5, product_type: 'GENERAL', online_visible: true, barcode: BARCODE } })).data.product;
const aItem = await product(A, '사진 테스트 오메가3');
const bItem = await product(B, '사진 테스트 오메가3');

const upload = (token, productId, buffer, type = 'image/jpeg') =>
  fetch(`${BASE}/api/products/${productId}/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: buffer }).then(async (res) => ({
    status: res.status,
    data: await res.json().catch(() => ({}))
  }));
const photo = (color, { width = 1600, height = 1000, orientation } = {}) => {
  let image = sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 });
  if (orientation) image = image.withMetadata({ orientation });
  return image.withExif({ IFD0: { Make: 'TestPhone', Copyright: 'pharmacy' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1' } }).toBuffer();
};
const media = async (url) => {
  const res = await fetch(`${BASE}${url}`);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
};

console.log('[사진 올리기 — 방향 바로잡기·크기 줄이기·위치정보 지우기]');
let first;
{
  const res = await upload(A.owner, aItem.id, await photo('#d33', { width: 1600, height: 1000, orientation: 6 }));
  check('업로드 200 · 사진 1장', res.status === 200 && res.data.images?.length === 1, res.data);
  first = res.data.images[0];
  check('세로 사진은 돌려서 저장(EXIF 방향 6 → 750×1200)', first.width === 750 && first.height === 1200, first);
  const full = await media(first.url);
  check('/media 원본 WebP · 1년 캐시', full.status === 200 && full.type === 'image/webp' && /immutable/.test(full.cache), full);
  const meta = await sharp(full.body).metadata();
  check('긴 변 1200px 이하', Math.max(meta.width, meta.height) <= 1200, meta);
  check('촬영 정보·위치(EXIF) 지움', !meta.exif && !full.body.includes(Buffer.from('TestPhone')), meta.exif?.length);
  const thumb = await sharp((await media(first.thumb_url)).body).metadata();
  check('목록용 작은 사진 480px', Math.max(thumb.width, thumb.height) <= 480, thumb);
  const row = db.prepare('SELECT thumbnail_url FROM products WHERE id = ?').get(aItem.id);
  check('상품 대표 이미지가 첫 사진의 작은 사진', row.thumbnail_url === first.thumb_url, row);
  const again = await upload(A.owner, aItem.id, await photo('#d33', { width: 1600, height: 1000, orientation: 6 }));
  check('같은 사진 또 올리면 409', again.status === 409, again.data);
}

console.log('[잘못된 파일·권한·약국 독립]');
{
  let res = await upload(A.owner, aItem.id, Buffer.from('<svg onload=alert(1)>'), 'image/svg+xml');
  check('그림이 아닌 파일 400', res.status === 400, res.data);
  res = await upload(A.owner, bItem.id, await photo('#3a3'));
  check('다른 약국 상품에 업로드 404', res.status === 404, res.data);
  res = await api(`/products/${bItem.id}/images`, { token: A.owner });
  check('다른 약국 상품 사진 목록 404', res.status === 404, res.data);
  res = await upload(A.owner, aItem.id, Buffer.alloc(11 * 1024 * 1024, 1), 'image/jpeg');
  check('10MB 넘는 파일 413', res.status === 413, res.data);
  for (const bad of ['../../etc/passwd', 'x.webp', `${'a'.repeat(64)}.png`]) {
    const r = await fetch(`${BASE}/media/products/${bad}`);
    check(`이상한 사진 경로 거절(${bad})`, r.status === 404);
  }
}

console.log('[여러 장 · 대표 사진 · 삭제]');
let second;
{
  const res = await upload(A.owner, aItem.id, await photo('#33d'));
  second = res.data.images[1];
  check('두 번째 사진', res.data.images.length === 2 && second, res.data);
  const primary = await api(`/products/${aItem.id}/images/${second.id}`, { token: A.owner, method: 'PATCH', body: { primary: true } });
  check('대표 사진 바꾸기', primary.data.images[0].id === second.id, primary.data);
  check('목록 대표 이미지도 바뀜', db.prepare('SELECT thumbnail_url FROM products WHERE id = ?').get(aItem.id).thumbnail_url === second.thumb_url);
  const detail = await api(`/products/mall/${aItem.id}?pharmacyCode=${A.code}`, { token: A.owner });
  check('고객 상세에 사진 2장(대표 먼저)', detail.status === 200 && detail.data.images.length === 2 && detail.data.images[0].id === second.id, detail.data.images);
}

console.log('[공유 사진 — 같은 바코드, 올린 약국이 허락했을 때만]');
{
  let res = await api(`/products/${bItem.id}/image-suggestions`, { token: B.owner });
  check('A가 허락 전에는 후보 없음', res.status === 200 && res.data.suggestions.length === 0, res.data);
  res = await api('/pharmacies/me/mall-settings', { token: A.owner, method: 'PATCH', body: { share_product_photos: true } });
  check('A 사진 공유 허락', res.status === 200 && res.data.share_product_photos === true, res.data);
  res = await api(`/products/${bItem.id}/image-suggestions`, { token: B.owner });
  check('B에게 A 사진 2장이 후보로', res.data.suggestions.length === 2 && !JSON.stringify(res.data).includes(A.code), res.data);
  const pick = res.data.suggestions.find((s) => s.url === first.url);
  res = await api(`/products/${bItem.id}/images/shared`, { token: B.owner, method: 'POST', body: { image_key: pick.image_key } });
  check('B가 공유 사진 쓰기', res.status === 200 && res.data.images.length === 1 && res.data.images[0].source === 'SHARED', res.data);
  res = await api(`/products/${bItem.id}/images/shared`, { token: B.owner, method: 'POST', body: { image_key: 'products/' + 'f'.repeat(64) + '.webp' } });
  check('후보가 아닌 사진 키는 거절', res.status === 404, res.data);
  res = await api(`/products/${aItem.id}/image-suggestions`, { token: A.owner });
  check('B는 공유 허락 안 했으므로 A에게 후보 없음', res.data.suggestions.length === 0, res.data);

  const firstRow = (await api(`/products/${aItem.id}/images`, { token: A.owner })).data.images.find((i) => i.url === first.url);
  res = await api(`/products/${aItem.id}/images/${firstRow.id}`, { token: A.owner, method: 'DELETE' });
  check('A가 사진 지움', res.status === 200 && res.data.images.length === 1, res.data);
  check('B가 쓰는 사진 파일은 남음', (await media(first.url)).status === 200);
  const bDetail = await api(`/products/mall/${bItem.id}?pharmacyCode=${B.code}`, { token: B.owner });
  check('B 상세에 그대로 보임', bDetail.data.images.length === 1 && bDetail.data.images[0].url === first.url, bDetail.data.images);

  await api('/pharmacies/me/mall-settings', { token: A.owner, method: 'PATCH', body: { share_product_photos: false } });
  res = await api(`/products/${bItem.id}/image-suggestions`, { token: B.owner });
  check('A가 공유를 끄면 새 후보로 안 보임', res.data.suggestions.length === 0, res.data);
}

console.log('[식약처 건강기능식품 정보 — 검색·연결·고객 상세]');
const calls = [];
const imageHits = [];
const webPhotos = {
  '/img/lutein-a.jpg': await sharp({ create: { width: 800, height: 800, channels: 3, background: '#e8a33d' } }).jpeg().toBuffer(),
  '/img/lutein-b.jpg': await sharp({ create: { width: 700, height: 700, channels: 3, background: '#4a8fe7' } }).jpeg().toBuffer()
};
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/img/')) {
    imageHits.push(url.pathname);
    if (!webPhotos[url.pathname]) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(webPhotos[url.pathname]);
  }
  if (url.pathname === '/search.json') {
    calls.push(Object.fromEntries(url.searchParams));
    const local = `http://127.0.0.1:${process.env.MFDS_FAKE_PORT}`;
    const q = url.searchParams.get('q') || '';
    const results = q.includes('루테인')
      ? [
          { title: '눈건강제약 웹사진 루테인 골드 60캡슐', link: 'http://169.254.169.254/latest/meta-data/', source: 'meta', original: 'http://169.254.169.254/latest/meta-data/p.jpg', original_width: 1000, original_height: 1000 },
          { title: '눈건강제약 웹사진 루테인 골드 후기', link: 'https://blog.naver.com/someone/1', source: '블로그', original: `${local}/img/lutein-a.jpg`, original_width: 900, original_height: 900 },
          { title: '전혀 다른 비타민', link: 'https://shop.example.com/x', source: 'shop', original: `${local}/img/lutein-a.jpg`, original_width: 900, original_height: 900 },
          { title: '[눈건강제약] 웹사진 루테인 골드 60캡슐', link: 'https://shop.example.com/lutein', source: '예시몰', original: `${local}/img/lutein-a.jpg`, original_width: 800, original_height: 800 },
          { title: '눈건강제약 웹사진 루테인 골드', link: 'https://store.example.com/lutein', source: '예시스토어', original: `${local}/img/lutein-b.jpg`, original_width: 700, original_height: 700 }
        ]
      : [];
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ images_results: results }));
  }
  calls.push(Object.fromEntries(url.searchParams));
  const item = {
    STTEMNT_NO: '200400200001',
    PRDUCT: ' 사진 테스트 오메가3 ',
    ENTRPS: '(주)테스트제약',
    MAIN_FNCTN: '혈중 중성지질 개선·혈행 개선에 도움을 줄 수 있음',
    SRV_USE: '1일 1회, 1회 1캡슐을 물과 함께 섭취하십시오.',
    INTAKE_HINT1: '1. 질환이 있거나 의약품 복용 시 전문가와 상담하십시오.\n2. 알레르기 체질은 섭취에 주의하십시오.',
    PRSRV_PD: '직사광선을 피해 서늘한 곳에 보관',
    DISTB_PD: '제조일로부터 24개월',
    SUNGSANG: '노란색 연질캡슐',
    BASE_STANDARD: 'EPA와 DHA의 합: 표시량의 80% 이상',
    REGIST_DT: '20040101'
  };
  const other = { ...item, STTEMNT_NO: '200500300002', PRDUCT: '다른회사 오메가3', ENTRPS: '다른식품' };
  const twinA = { ...item, STTEMNT_NO: '200600400001', PRDUCT: '중복 오메가3', ENTRPS: '가나제약' };
  const twinB = { ...item, STTEMNT_NO: '200600400002', PRDUCT: '중복 오메가3', ENTRPS: '다라식품' };
  const all = [item, other, twinA, twinB];
  let items = [];
  if (url.searchParams.get('STTEMNT_NO')) items = all.filter((i) => i.STTEMNT_NO === url.searchParams.get('STTEMNT_NO'));
  else if (url.searchParams.get('Prduct')) items = all.filter((i) => i.PRDUCT.includes(url.searchParams.get('Prduct').trim().split(' ').pop()));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { totalCount: items.length, items: items.map((i) => ({ item: i })) } }));
});
await new Promise((resolve) => fake.listen(Number(process.env.MFDS_FAKE_PORT), '127.0.0.1', resolve));
try {
  let res = await api(`/products/mfds/search?q=${encodeURIComponent('오')}`, { token: A.owner });
  check('한 글자 검색 400', res.status === 400, res.data);
  res = await api(`/products/mfds/search?q=${encodeURIComponent('오메가3')}&company=${encodeURIComponent('테스트제약')}`, { token: A.owner });
  check('제품명 검색 · 같은 제조사 먼저', res.status === 200 && res.data.results[0]?.report_no === '200400200001' && res.data.results.length >= 2, res.data);
  check('인증키를 서버에서만 붙임', calls.at(-1)?.serviceKey === 'test-mfds-key' && !JSON.stringify(res.data).includes('test-mfds-key'), calls.at(-1));
  res = await api(`/products/${aItem.id}/mfds`, { token: A.owner, method: 'POST', body: { report_no: '200400200001' } });
  check('신고번호로 연결', res.status === 200 && res.data.mfds.main_function.includes('혈행'), res.data);
  check('신고 정보를 DB에 보관', Boolean(db.prepare("SELECT 1 FROM mfds_htfs WHERE report_no = '200400200001'").get()));
  res = await api(`/products/${aItem.id}/mfds`, { token: A.owner, method: 'POST', body: { report_no: '999999999999' } });
  check('없는 신고번호 404', res.status === 404, res.data);
  res = await api(`/products/${bItem.id}/mfds`, { token: A.owner, method: 'POST', body: { report_no: '200400200001' } });
  check('다른 약국 상품 연결 불가(404)', res.status === 404, res.data);
  const detail = await api(`/products/mall/${aItem.id}?pharmacyCode=${A.code}`, { token: A.owner });
  const info = detail.data.mfds;
  check('고객 상세에 기능성·섭취 방법·주의사항·보관·출처', info?.main_function && info.intake_method && info.intake_caution.includes('\n') && info.storage && /식품의약품안전처/.test(info.source), info);
  check('제품명 앞뒤 공백 정리', info.product_name === '사진 테스트 오메가3', info.product_name);

  // 같은 신고번호를 연결한 약국끼리도 공유 사진 후보가 된다.
  await api('/pharmacies/me/mall-settings', { token: A.owner, method: 'PATCH', body: { share_product_photos: true } });
  db.prepare('UPDATE products SET barcode = NULL WHERE id = ?').run(bItem.id);
  res = await api(`/products/${bItem.id}/image-suggestions`, { token: B.owner });
  check('바코드 없으면(신고번호 연결 전) 후보 없음', res.data.suggestions.length === 0, res.data);
  await api(`/products/${bItem.id}/mfds`, { token: B.owner, method: 'POST', body: { report_no: '200400200001' } });
  res = await api(`/products/${bItem.id}/image-suggestions`, { token: B.owner });
  check('같은 신고번호면 후보로 보임', res.data.suggestions.length === 1 && res.data.suggestions[0].url === second.url, res.data);

  res = await api(`/products/${aItem.id}/mfds`, { token: A.owner, method: 'DELETE' });
  check('연결 해제', res.status === 200);
  check('해제하면 고객 상세에서 사라짐', (await api(`/products/mall/${aItem.id}?pharmacyCode=${A.code}`, { token: A.owner })).data.mfds === null);
  const customer = (await api('/products/mfds/search?q=abc', {})).status;
  check('로그인 없이 식약처 검색 불가', customer === 401, customer);

  console.log('[성분 자동 매칭 — 제품명·제조사가 하나로 맞을 때만, 약사 승인 전에는 고객에게 안 보임]');
  const wait = () => new Promise((resolve) => setTimeout(resolve, 400));
  const row = (id) => db.prepare('SELECT mfds_report_no, mfds_link_source, mfds_match_basis, mfds_verified_at, mfds_verified_by FROM products WHERE id = ?').get(id);
  const create = (body) => api('/products', { token: A.owner, method: 'POST', body: { price: 15000, stock_quantity: 3, product_type: 'GENERAL', online_visible: true, ...body } }).then((r) => r.data.product);
  const exact = await create({ product_name: '다른회사 오메가3' });
  const twin = await create({ product_name: '중복 오메가3' });
  const wrongMaker = await create({ product_name: '다른회사 오메가3', brand: '엉뚱식품' });
  const drug = await create({ product_name: '다른회사 오메가3 ', product_type: 'OTC', online_visible: false });
  await wait();
  check('제품명이 하나로 맞으면 자동 매칭(미검증)', row(exact.id).mfds_report_no === '200500300002' && row(exact.id).mfds_link_source === 'AUTO' && !row(exact.id).mfds_verified_at, row(exact.id));
  check('브랜드가 비어 있으면 근거는 "제품명만 일치"', row(exact.id).mfds_match_basis === 'NAME', row(exact.id));
  check('같은 이름이 여러 업체면 매칭 안 함', row(twin.id).mfds_report_no === null, row(twin.id));
  check('브랜드(제조사)가 신고 업체와 다르면 매칭 안 함', row(wrongMaker.id).mfds_report_no === null, row(wrongMaker.id));
  check('일반의약품은 건강기능식품 정보로 매칭 안 함', row(drug.id).mfds_report_no === null, row(drug.id));
  const mallInfo = async (id) => (await api(`/products/mall/${id}?pharmacyCode=${A.code}`, { token: A.owner })).data;
  check('미검증 성분 정보는 고객 상세에 안 보임', (await mallInfo(exact.id)).mfds === null);
  let list = (await api('/products', { token: A.owner })).data.products;
  check('상품 목록에서 미검증 상태를 알 수 있음', list.find((p) => p.id === exact.id).mfds_verified_at === null && list.find((p) => p.id === exact.id).mfds_report_no === '200500300002');

  res = await api(`/products/${exact.id}/verify?pharmacyId=${A.id}`, { token: admin, method: 'POST', body: { ingredients: true } });
  check('본사 관리자는 승인 불가(약사만)', res.status === 403, res.data);
  res = await api(`/products/${exact.id}/verify`, { token: B.owner, method: 'POST', body: { ingredients: true } });
  check('다른 약국 약사는 승인 불가(404)', res.status === 404, res.data);
  res = await api(`/products/${exact.id}/verify`, { token: A.owner, method: 'POST', body: {} });
  check('승인할 항목 없으면 400', res.status === 400, res.data);
  res = await api(`/products/${exact.id}/verify`, { token: A.owner, method: 'POST', body: { ingredients: true } });
  check('약사 승인 → 검증 완료', res.status === 200 && res.data.unverified === false && row(exact.id).mfds_verified_at && row(exact.id).mfds_verified_by, { data: res.data, row: row(exact.id) });
  check('승인 기록(누가·무엇을) 남김', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'PRODUCT_VERIFY' AND target_id = ? AND description LIKE '%200500300002%'").get(exact.id)));
  const approved = await mallInfo(exact.id);
  check('승인하면 고객 상세에 성분 정보', approved.mfds?.report_no === '200500300002' && /EPA와 DHA/.test(approved.mfds.standard), approved.mfds);
  res = await api(`/products/${exact.id}/mfds`, { token: A.owner });
  check('검증한 약사 이름·시각 조회', res.data.verified_by === 'A약사' && Boolean(res.data.verified_at), res.data);

  await api(`/products/${exact.id}`, { token: A.owner, method: 'PATCH', body: { brand: '다른식품' } });
  check('제조사(브랜드)가 바뀌면 재검증 대기', row(exact.id).mfds_report_no === '200500300002' && !row(exact.id).mfds_verified_at, row(exact.id));
  check('재검증 전에는 고객에게 다시 안 보임', (await mallInfo(exact.id)).mfds === null);
  await api(`/products/${exact.id}/mfds/confirm`, { token: A.owner, method: 'POST' });
  check('다시 승인하면 보임', (await mallInfo(exact.id)).mfds?.report_no === '200500300002');

  db.prepare("UPDATE mfds_htfs SET intake_method = '예전 섭취 방법' WHERE report_no = '200500300002'").run();
  await api(`/products/${twin.id}/mfds`, { token: A.owner, method: 'POST', body: { report_no: '200500300002' } });
  check('식약처 내용이 바뀌면 그 제품을 쓰는 상품은 재검증 대기', !row(exact.id).mfds_verified_at, row(exact.id));
  check('약사가 직접 골라 연결하면 바로 검증 완료', row(twin.id).mfds_match_basis === 'MANUAL' && Boolean(row(twin.id).mfds_verified_at), row(twin.id));
  await api(`/products/${twin.id}/mfds`, { token: A.owner, method: 'DELETE' });
  db.prepare("UPDATE products SET mfds_link_source = NULL WHERE id = ?").run(twin.id);

  await api(`/products/${exact.id}/mfds`, { token: A.owner, method: 'DELETE' });
  await api(`/products/${exact.id}`, { token: A.owner, method: 'PATCH', body: { brand: '다른식품 ' } });
  await wait();
  check('약국이 해제한 상품은 다시 자동 매칭 안 함', row(exact.id).mfds_report_no === null && row(exact.id).mfds_link_source === 'REMOVED', row(exact.id));
  await api(`/products/${twin.id}`, { token: A.owner, method: 'PATCH', body: { brand: '다라식품' } });
  await wait();
  check('브랜드(제조사)를 넣으면 같은 이름 중 그 업체 제품으로 매칭', row(twin.id).mfds_report_no === '200600400002' && row(twin.id).mfds_match_basis === 'NAME_COMPANY', row(twin.id));
  const batchItem = await create({ product_name: '사진 테스트 오메가3', product_type: 'UNCLASSIFIED', online_visible: false });
  await api('/products/bulk-type', { token: A.owner, method: 'POST', body: { ids: [batchItem.id], product_type: 'GENERAL' } });
  await wait();
  check('일반 상품으로 분류하면 자동 매칭', row(batchItem.id).mfds_report_no === '200400200001', row(batchItem.id));
  db.prepare('UPDATE products SET mfds_report_no = NULL, mfds_link_source = NULL WHERE id = ?').run(batchItem.id);
  res = await api('/products/auto-match', { token: A.owner, method: 'POST' });
  check('한꺼번에 자동 매칭 결과(성분·여러 업체·사진)', res.status === 200 && res.data.linked.some((p) => p.id === batchItem.id) && Array.isArray(res.data.ambiguous) && Array.isArray(res.data.photos), res.data);
  res = await api('/products/auto-match', { token: B.owner, method: 'POST' });
  check('다른 약국 상품은 건드리지 않음', !res.data.linked.some((p) => [exact.id, twin.id, batchItem.id].includes(p.id)), res.data);

  console.log('[사진 자동 매칭 — 같은 바코드의 공유 사진을 미검증으로, 약사 승인 후 공개]');
  const C = await openPharmacy('C');
  const imagesOf = async (pharmacy, id) => (await api(`/products/${id}/images`, { token: pharmacy.owner })).data.images;
  const cItem = await product(C, '사진 테스트 오메가3');
  await wait();
  let cImages = await imagesOf(C, cItem.id);
  check('같은 바코드 상품에 공유 사진 1장이 미검증으로 붙음', cImages.length === 1 && cImages[0].verified === false && cImages[0].match_basis === 'BARCODE' && cImages[0].url === second.url, cImages);
  const cMall = async () => (await api(`/products/mall/${cItem.id}?pharmacyCode=${C.code}`, { token: C.owner })).data;
  check('자동으로 붙은 사진도 고객 상세에 바로 보임(미검증 표시)', (await cMall()).images.length === 1 && (await cMall()).images[0].verified === false);
  check('목록 대표 사진도 바로 채움', db.prepare('SELECT thumbnail_url FROM products WHERE id = ?').get(cItem.id).thumbnail_url === cImages[0].thumb_url);
  list = (await api('/products', { token: C.owner })).data.products;
  check('상품 목록에 미검증 사진 수', Number(list.find((p) => p.id === cItem.id).photo_pending) === 1, list.find((p) => p.id === cItem.id));

  await api(`/products/${cItem.id}/images/${cImages[0].id}`, { token: C.owner, method: 'DELETE' });
  res = await api('/products/auto-match', { token: C.owner, method: 'POST' });
  check('약국이 지운 자동 사진은 다시 붙이지 않음', !res.data.photos.some((p) => p.id === cItem.id) && (await imagesOf(C, cItem.id)).length === 0, res.data);

  res = await upload(A.owner, aItem.id, await photo('#3c6'));
  const fresh = res.data.images.at(-1);
  cImages = await imagesOf(C, cItem.id);
  check('공유 약국이 새 사진을 올리면 사진 없는 같은 상품에 바로 미검증으로 감', cImages.length === 1 && cImages[0].url === fresh.url && !cImages[0].verified, cImages);
  res = await api(`/products/${cItem.id}/verify`, { token: C.owner, method: 'POST', body: { image_ids: [cImages[0].id] } });
  check('약사가 사진 승인', res.status === 200 && res.data.photos === 1 && res.data.photo_pending === 0, res.data);
  check('승인한 사진은 고객 상세·목록 대표 사진에 보임', (await cMall()).images.length === 1 && db.prepare('SELECT thumbnail_url FROM products WHERE id = ?').get(cItem.id).thumbnail_url === fresh.thumb_url);
  await api(`/products/${cItem.id}`, { token: C.owner, method: 'PATCH', body: { barcode: '8800000000017' } });
  check('바코드가 바뀌면 사진도 재검증 대기(고객에게는 계속 보임)', (await cMall()).images.length === 1 && (await imagesOf(C, cItem.id))[0].verified === false);

  console.log('[사진 자동 매칭 — 공유 사진이 없으면 구글 이미지 검색에서 가장 잘 맞는 사진]');
  const webItem = await create({ product_name: '웹사진 루테인 골드', brand: '눈건강제약' });
  await wait();
  await wait();
  let webImagesNow = await imagesOf(A, webItem.id);
  const search = calls.findLast((c) => c.engine === 'google_images' && c.q.includes('루테인'));
  check('제품명·브랜드로 구글 이미지 검색(키는 서버에서만)', search?.q === '눈건강제약 웹사진 루테인 골드' && search.api_key === 'test-serp-key' && search.gl === 'kr', search);
  check(
    '제목이 맞는 쇼핑몰 사진을 골라 저장(블로그·다른 상품 제외)',
    webImagesNow.length === 1 && webImagesNow[0].source === 'WEB' && webImagesNow[0].source_url === 'https://shop.example.com/lutein' && !webImagesNow[0].verified,
    webImagesNow
  );
  check('내부망(메타데이터) 주소 사진은 받지 않음', !imageHits.some((p) => p.includes('meta')), imageHits);
  const webMall = (await api(`/products/mall/${webItem.id}?pharmacyCode=${A.code}`, { token: A.owner })).data;
  check('고객 상세에 바로 보임', webMall.images.length === 1 && webMall.images[0].verified === false, webMall.images);
  check('목록 대표 사진도 채움', db.prepare('SELECT thumbnail_url FROM products WHERE id = ?').get(webItem.id).thumbnail_url === webImagesNow[0].thumb_url);
  const searches = () => calls.filter((c) => c.engine === 'google_images').length;
  const before = searches();
  await api('/products/auto-match', { token: A.owner, method: 'POST' });
  check('사진이 있으면 다시 검색하지 않음', searches() === before, searches());

  await api(`/products/${webItem.id}/images/${webImagesNow[0].id}`, { token: A.owner, method: 'DELETE' });
  res = await api('/products/auto-match', { token: A.owner, method: 'POST' });
  check('30일 안에는 같은 상품을 다시 검색하지 않음(검색 횟수 아끼기)', searches() === before && (await imagesOf(A, webItem.id)).length === 0, searches());
  db.prepare('UPDATE products SET photo_searched_at = NULL WHERE id = ?').run(webItem.id);
  res = await api('/products/auto-match', { token: A.owner, method: 'POST' });
  webImagesNow = await imagesOf(A, webItem.id);
  check('약국이 지운 사진은 빼고 다음 후보를 붙임', res.data.photos.some((p) => p.id === webItem.id && p.basis === 'WEB') && webImagesNow[0]?.source_url === 'https://store.example.com/lutein', { result: res.data.photos, images: webImagesNow });
  res = await api(`/products/${webItem.id}/verify`, { token: A.owner, method: 'POST', body: { image_ids: [webImagesNow[0].id] } });
  check('약사가 웹 사진도 승인', res.status === 200 && (await imagesOf(A, webItem.id))[0].verified === true, res.data);

  const webService = require('../src/services/web-images.js');
  check(
    '내부 주소 판별(메타데이터·사설망·IPv6 사설·매핑 주소)',
    webService.isBlockedAddress('169.254.169.254', 4) && webService.isBlockedAddress('10.0.0.5', 4) && webService.isBlockedAddress('fd00::1', 6) &&
      webService.isBlockedAddress('::ffff:192.168.0.1', 6) && !webService.isBlockedAddress('8.8.8.8', 4)
  );
  const blockedDownload = await webService.download('http://169.254.169.254/latest/meta-data/').catch((error) => error.code);
  check('메타데이터 주소로 직접 받기도 거절', blockedDownload === 'BLOCKED_ADDRESS', blockedDownload);
} finally {
  fake.close();
}

done();
