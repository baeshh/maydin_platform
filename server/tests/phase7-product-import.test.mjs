import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, api, check, done, login, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const P = require('../public/import-parse.js');
const db = new Database(process.env.DB_PATH);
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const owner = await login('owner@apharmacy.kr', 'owner1234');
let seq = 0;

function ean13(body12) {
  const sum = String(body12)
    .split('')
    .map(Number)
    .reduce((acc, digit, index) => acc + digit * (index % 2 ? 3 : 1), 0);
  return `${body12}${(10 - (sum % 10)) % 10}`;
}
function barcode() {
  seq += 1;
  return ean13(`880${String(process.pid % 1000).padStart(3, '0')}${String(seq).padStart(6, '0')}`);
}

const preview = (mode, rows, options = {}, extra = {}) =>
  api('/product-import/preview', { token: owner, method: 'POST', body: { mode, rows, options, file_name: 'test.csv', source_type: 'CSV', ...extra } });
const rowsOf = async (batchId, filter = 'ALL') => (await api(`/product-import/batches/${batchId}?filter=${filter}&page_size=200`, { token: owner })).data.rows;
const apply = (batchId) => api(`/product-import/batches/${batchId}/apply`, { token: owner, method: 'POST' });
const revert = (batchId) => api(`/product-import/batches/${batchId}/revert`, { token: owner, method: 'POST' });
const productBy = (code) => db.prepare('SELECT * FROM products WHERE pharmacy_id = 1 AND barcode = ?').get(code);
const setSync = (body) => api('/product-import/sync', { token: owner, method: 'PATCH', body });

console.log('[파일 읽기 — CSV · 엑셀 · PDF]');
{
  const { text, encoding } = P.decodeText(readFileSync(path.join(fixtures, 'pos-export-cp949.csv')));
  check('한글 윈도우(CP949) CSV 자동 인식', encoding === 'euc-kr' && text.includes('비타민C'), encoding);
  const table = P.parseDelimited(text);
  const header = P.detectHeaderRow(table);
  check('제목 줄 아래 3번째 줄을 머리글로 찾음', header === 2, header);
  const map = P.autoMap(table[header]);
  check('열 이름 자동 맞춤(품명·소비자가(원)·현재고·제조사)', map.product_name === 2 && map.price === 4 && map.stock === 6 && map.brand === 7, map);
  const built = P.buildRows(table, header, map);
  check('합계 줄은 건너뜀', built.rows.length === 4 && built.skipped.summary === 1, built.skipped);
  check('쉼표 들어간 가격은 그대로 전달', built.rows[0].price === '15,000', built.rows[0]);

  const utf8 = P.decodeText(new TextEncoder().encode('\uFEFF상품명,재고\n가,1\n'));
  check('UTF-8 BOM CSV', utf8.encoding === 'utf-8' && utf8.text.startsWith('상품명'), utf8);
  const tabbed = P.parseDelimited('상품명\t바코드\t재고\n"따옴표, 상품"\t123\t5\n');
  check('탭 구분·따옴표 칸', tabbed[1][0] === '따옴표, 상품' && tabbed[1][2] === '5', tabbed);

  const exactFirst = P.autoMap(['상품명', '입고수량', '현재고']);
  check('정확히 맞는 열 이름을 먼저 고름(현재고 > 입고수량)', exactFirst.stock === 2, exactFirst);
  const pii = P.piiColumns([['상품명', '고객명', '휴대폰', '비고'], ['가', '홍길동', '010', '900101-1234567']], 0);
  check('개인정보 열(고객명·휴대폰·주민번호 값) 찾아냄', JSON.stringify(pii) === '[1,2,3]', pii);

  const book = P.readWorkbook(XLSX, readFileSync(path.join(fixtures, 'pos-export.xlsx')));
  const sheet = P.tableFromSheet(XLSX, book, book.SheetNames[0]);
  const xHeader = P.detectHeaderRow(sheet);
  const xRows = P.buildRows(sheet, xHeader, P.autoMap(sheet[xHeader])).rows;
  check('엑셀 숫자 바코드가 지수로 바뀌지 않음', xRows[0].barcode === ean13('880200000001'), xRows[0]);
  check('엑셀 날짜 칸은 YYYY-MM-DD', xRows[0].expiry_date === '2027-03-31', xRows[0]);

  const pdfjs = await import(path.join(serverDir, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'));
  const options = {
    cMapUrl: path.join(serverDir, 'node_modules/pdfjs-dist/cmaps/') + '/',
    standardFontDataUrl: path.join(serverDir, 'node_modules/pdfjs-dist/standard_fonts/') + '/'
  };
  const pdf = await P.readPdf(pdfjs, new Uint8Array(readFileSync(path.join(fixtures, 'pos-export.pdf'))), options);
  const pMap = P.autoMap(pdf.table[0]);
  const pRows = P.buildRows(pdf.table, 0, pMap).rows;
  check('글자 PDF 표 → 2쪽 70행', pdf.headerFound && !pdf.scanned && pdf.pageCount === 2 && pRows.length === 70, { pages: pdf.pageCount, rows: pRows.length });
  check('PDF 열 맞춤(코드·바코드·이름·가격·재고)', pMap.external_code === 0 && pMap.barcode === 1 && pMap.product_name === 2 && pMap.price === 3 && pMap.stock === 4, pMap);
  check('PDF 마지막 행 값', pRows[69].external_code === 'Q-070' && pRows[69].price === '7,900' && pRows[69].stock === '6', pRows[69]);
  const wrapped = pRows.find((row) => row.external_code === 'Q-003');
  check('두 줄로 나뉜 긴 상품명을 한 행으로 합침', wrapped.product_name.startsWith('아주 긴 이름') && wrapped.product_name.endsWith('180캡슐') && wrapped.stock === '2', wrapped);
  const scan = await P.readPdf(pdfjs, new Uint8Array(readFileSync(path.join(fixtures, 'scanned.pdf'))), options);
  check('스캔(사진) PDF는 글자 없음으로 판정', scan.scanned && !scan.headerFound, scan);
}

console.log('[권한]');
{
  const staffEmail = `import-staff-${process.pid}@test.kr`;
  await api('/staff', { token: owner, method: 'POST', body: { name: '일괄직원', email: staffEmail, password: 'staff1234a' } });
  const staff = await login(staffEmail, 'staff1234a');
  let res = await api('/product-import/preview', { token: staff, method: 'POST', body: { mode: 'ADD', rows: [{ product_name: '가', price: 1 }] } });
  check('POS 직원은 일괄 등록 불가(403)', res.status === 403, res.status);
  res = await api('/product-import/sync', { token: staff });
  check('POS 직원은 병행 설정 조회 불가(403)', res.status === 403, res.status);
  res = await api('/product-import/batches');
  check('로그인 없이 401', res.status === 401, res.status);
  const tpl = await fetch(`${BASE}/api/product-import/template.csv`, { headers: { Authorization: `Bearer ${owner}` } });
  const bytes = new Uint8Array(await tpl.arrayBuffer());
  const body = new TextDecoder().decode(bytes);
  check('MAYDIN 양식 CSV(엑셀 한글용 BOM)', tpl.status === 200 && bytes[0] === 0xef && bytes[1] === 0xbb && body.includes('상품명,바코드'), tpl.status);
}

console.log('[행 검증]');
{
  const dup = barcode();
  const res = await preview('MIGRATE', [
    { row_no: 2, product_name: '지수 바코드', barcode: '8.80123E+12', price: '1000', stock: '1' },
    { row_no: 3, product_name: '중복 A', barcode: dup, price: '1000', stock: '1' },
    { row_no: 4, product_name: '중복 B', barcode: dup, price: '1000', stock: '1' },
    { row_no: 5, product_name: '전문약', barcode: barcode(), price: '1000', stock: '1', product_kind: '전문의약품' },
    { row_no: 6, product_name: '마이너스', barcode: barcode(), price: '1000', stock: '-3', product_kind: '의약외품' },
    { row_no: 7, product_name: '소수 재고', barcode: barcode(), price: '1000', stock: '1.5' },
    { row_no: 8, product_name: '가격 없음', barcode: barcode(), stock: '1' },
    { row_no: 9, product_name: '구분 모름', barcode: barcode(), price: '1000', stock: '1', product_kind: 'X등급' },
    { row_no: 10, product_name: '체크숫자 틀림', barcode: '8801234567890', price: '1000', stock: '1' }
  ]);
  check('미리보기 201', res.status === 201, res.data);
  const rows = await rowsOf(res.data.batch_id);
  const byRow = Object.fromEntries(rows.map((row) => [row.row_no, row]));
  const text = (row) => row.messages.map((m) => m.text).join(' ');
  check('지수로 바뀐 바코드는 오류', byRow[2].action === 'ERROR' && /지수|텍스트/.test(text(byRow[2])), text(byRow[2]));
  check('파일 안 같은 바코드는 둘 다 오류', byRow[3].action === 'ERROR' && byRow[4].action === 'ERROR', [byRow[3].action, byRow[4].action]);
  check('전문의약품은 건너뜀', byRow[5].action === 'SKIP', byRow[5]);
  check('음수 재고는 0으로 넣고 경고', byRow[6].action === 'CREATE' && byRow[6].stock_after === 0 && byRow[6].messages.some((m) => m.level === 'warning'), byRow[6]);
  check('소수 재고는 오류', byRow[7].action === 'ERROR', byRow[7]);
  check('새 상품인데 판매가 없으면 오류', byRow[8].action === 'ERROR', byRow[8]);
  check('구분을 모르면 신규 + 구분 확인 필요', byRow[9].action === 'CREATE' && byRow[9].created.needs_review === 1 && byRow[9].created.product_type === 'GENERAL', byRow[9].created);
  check('체크 숫자 틀린 바코드는 경고만', byRow[10].action === 'CREATE' && byRow[10].messages.some((m) => m.level === 'warning'), byRow[10]);
  check('요약 개수', res.data.summary.error_count === 5 && res.data.summary.skip_count === 1 && res.data.summary.create_count === 3, res.data.summary);
  const addRes = await preview('ADD', [{ row_no: 2, product_name: '더하기 음수', barcode: barcode(), price: '1000', stock: '-1' }]);
  check('더하기에서 음수 수량은 오류', addRes.data.summary.error_count === 1, addRes.data.summary);
  const big = await preview('ADD', Array.from({ length: 20001 }, (_, i) => ({ row_no: i + 2, product_name: `p${i}`, price: '1' })));
  check('20,000행 초과는 거절', big.status === 400, big.status);
}

console.log('[이전 — 신규·수정·로트·온라인 비공개]');
let migrateBatch;
const codeA = barcode();
const codeB = barcode();
let existing;
{
  existing = db
    .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, barcode, cost_price) VALUES (1, '기존 영양제', 20000, 5, 'ON_SALE', ?, 10000)")
    .run(codeB).lastInsertRowid;
  const res = await preview('MIGRATE', [
    { row_no: 2, product_name: '이전 신규 비타민', barcode: codeA, external_code: `EX-${process.pid}-1`, price: '12,000원', cost_price: '6000', stock: '30', category: `이전분류${process.pid}`, product_kind: '건강기능식품', expiry_date: '2027.06.30', lot_number: 'L-1' },
    { row_no: 3, product_name: '기존 영양제(파일 이름)', barcode: codeB, price: '18000', cost_price: '9000', stock: '12' }
  ]);
  migrateBatch = res.data.batch_id;
  const rows = await rowsOf(migrateBatch);
  const update = rows.find((row) => row.action === 'UPDATE');
  check('바코드로 기존 상품을 찾아 수정', update?.product_id === Number(existing), update);
  const labels = update.changes.map((c) => `${c.label}:${c.before}->${c.after}`);
  check('바뀌는 값(재고 5→12, 판매가, 매입가) 표시', labels.includes('재고:5->12') && labels.includes('판매가:20000->18000') && labels.includes('매입가:10000->9000'), labels);
  check('기본으로 상품명은 바꾸지 않음', !update.changes.some((c) => c.field === 'product_name'), update.changes);
  check('새 분류 미리 알림', res.data.new_categories.includes(`이전분류${process.pid}`), res.data.new_categories);

  const applied = await apply(migrateBatch);
  check('적용 200', applied.status === 200 && applied.data.summary.create_count === 1 && applied.data.summary.update_count === 1, applied.data);
  const created = productBy(codeA);
  check('신규 상품은 온라인 비공개로 등록', created && created.online_visible === 0 && created.stock_quantity === 30 && created.price === 12000, created);
  check('기존 POS 상품코드 저장', created.external_code === `EX-${process.pid}-1`, created.external_code);
  const lot = db.prepare('SELECT * FROM product_lots WHERE product_id = ?').get(created.id);
  check('유통기한·로트로 로트 생성', lot?.expiry_date === '2027-06-30' && lot.lot_number === 'L-1' && lot.remaining_quantity === 30, lot);
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(existing);
  check('기존 상품 재고·가격 수정', updated.stock_quantity === 12 && updated.price === 18000 && updated.cost_price === 9000, updated);
  const logs = db.prepare("SELECT * FROM inventory_logs WHERE product_id IN (?, ?) AND change_type = 'IMPORT'").all(created.id, existing);
  check('재고 기록(IMPORT) 남김', logs.length === 2 && logs.every((l) => l.reference_type === 'IMPORT_BATCH' && l.reference_id === migrateBatch), logs);
  const audit = db.prepare("SELECT * FROM admin_logs WHERE action = 'PRODUCT_IMPORT' AND target_id = ?").get(migrateBatch);
  check('감사 기록', Boolean(audit), audit);
  check('같은 미리보기는 두 번 적용 불가', (await apply(migrateBatch)).status === 409);

  const mall = await api('/products/mall?pharmacyCode=A001', { token: owner });
  check('온라인 비공개 상품은 몰에 안 보임', !mall.data.products.some((p) => p.id === created.id), mall.status);
  const member = await signupMember(db, {}, { keepOrder: true });
  const cart = await api('/cart', { token: member.data.token, method: 'POST', body: { product_id: created.id, quantity: 1 } });
  check('온라인 비공개 상품은 장바구니에 못 담음', cart.status === 404, cart.status);
  const publish = await api('/products/bulk-visibility', { token: owner, method: 'POST', body: { ids: [created.id], online_visible: true } });
  check('온라인 공개', publish.data.updated === 1 && db.prepare('SELECT online_visible FROM products WHERE id = ?').get(created.id).online_visible === 1, publish.data);
  const mall2 = await api('/products/mall?pharmacyCode=A001', { token: owner });
  check('공개하면 몰에 보임', mall2.data.products.some((p) => p.id === created.id));
  db.prepare('UPDATE products SET online_visible = 0 WHERE id = ?').run(created.id);
}

console.log('[다시 올리기 — 코드로 찾기 · 연결 · 빼기 · 파일에 없는 상품]');
{
  const res = await preview('MIGRATE', [
    { row_no: 2, product_name: '이름 바뀐 비타민', external_code: `EX-${process.pid}-1`, price: '12000', stock: '30' },
    { row_no: 3, product_name: '기존 영양제', price: '18000', stock: '12' },
    { row_no: 4, product_name: '뺄 상품', barcode: barcode(), price: '1000', stock: '1' }
  ]);
  const rows = await rowsOf(res.data.batch_id);
  const byRow = Object.fromEntries(rows.filter((r) => r.row_no).map((row) => [row.row_no, row]));
  check('바코드 없어도 기존 POS 코드로 찾음(변화 없음)', byRow[2].action === 'UNCHANGED' && byRow[2].product_id === productBy(codeA).id, byRow[2]);
  check('이름만 같으면 신규 + 연결 후보', byRow[3].action === 'CREATE' && byRow[3].name_matches.some((m) => m.id === Number(existing)), byRow[3]);

  const linked = await preview(
    'MIGRATE',
    [
      { row_no: 3, product_name: '기존 영양제', price: '18000', stock: '15' },
      { row_no: 4, product_name: '뺄 상품', barcode: barcode(), price: '1000', stock: '1' }
    ],
    { links: { 3: Number(existing) }, excluded: [4], missing: 'ZERO' }
  );
  const lrows = await rowsOf(linked.data.batch_id);
  const linkRow = lrows.find((r) => r.row_no === 3);
  check('연결하면 그 상품을 수정', linkRow.action === 'UPDATE' && linkRow.product_id === Number(existing) && linkRow.stock_after === 15, linkRow);
  check('뺀 행은 건너뜀', lrows.find((r) => r.row_no === 4).action === 'SKIP');
  const missingA = lrows.find((r) => r.missing && r.product_id === productBy(codeA).id);
  check('파일에 없는 상품은 재고 0으로(선택한 경우)', missingA?.action === 'UPDATE' && missingA.stock_after === 0, missingA);
  check('파일 안 상품을 지우지는 않음(삭제 행 없음)', lrows.every((r) => ['UPDATE', 'UNCHANGED', 'SKIP', 'CREATE', 'ERROR'].includes(r.action)));

  db.prepare("UPDATE import_batches SET created_at = datetime('now', '-61 minutes') WHERE id = ?").run(linked.data.batch_id);
  const expired = await apply(linked.data.batch_id);
  check('60분 지난 미리보기는 적용 불가(409)', expired.status === 409, expired.data);
}

console.log('[입고분 더하기 · 되돌리기]');
{
  const before = db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(existing).stock_quantity;
  const res = await preview('ADD', [{ row_no: 2, barcode: codeB, stock: '7', cost_price: '8000', expiry_date: '2028-01-31' }]);
  const rows = await rowsOf(res.data.batch_id);
  check('더하기: 지금 재고 + 파일 수량', rows[0].action === 'UPDATE' && rows[0].stock_after === before + 7, rows[0]);
  check('더하기는 기본으로 판매가를 바꾸지 않음', !rows[0].changes.some((c) => c.field === 'price'), rows[0].changes);
  const applied = await apply(res.data.batch_id);
  check('더하기 적용', applied.status === 200 && db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(existing).stock_quantity === before + 7);
  const lot = db.prepare("SELECT * FROM product_lots WHERE product_id = ? AND expiry_date = '2028-01-31'").get(existing);
  check('더한 수량만큼 로트', lot?.received_quantity === 7 && lot.unit_cost === 8000, lot);

  let rev = await revert(migrateBatch);
  check('가장 최근 것이 아니면 되돌리기 불가(409)', rev.status === 409, rev.data);
  rev = await revert(res.data.batch_id);
  check('더하기 되돌리기', rev.status === 200 && db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(existing).stock_quantity === before, rev.data);
  check('되돌리면 만든 로트 삭제', !db.prepare("SELECT 1 FROM product_lots WHERE product_id = ? AND expiry_date = '2028-01-31'").get(existing));
  check('되돌린 건은 다시 되돌릴 수 없음', (await revert(res.data.batch_id)).status === 409);

  const createdId = productBy(codeA).id;
  db.prepare('UPDATE products SET stock_quantity = stock_quantity - 1 WHERE id = ?').run(createdId);
  db.prepare("INSERT INTO inventory_logs (pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason) VALUES (1, ?, 'POS_SALE', 30, 29, '테스트 판매')").run(createdId);
  rev = await revert(migrateBatch);
  check('이전 되돌리기', rev.status === 200, rev.data);
  const createdAfter = db.prepare('SELECT * FROM products WHERE id = ?').get(createdId);
  check('이미 팔린 신규 상품은 지우지 않고 숨김', createdAfter?.status === 'HIDDEN', createdAfter);
  const existingAfter = db.prepare('SELECT * FROM products WHERE id = ?').get(existing);
  check('수정한 상품은 적용 전 값으로', existingAfter.stock_quantity === 5 && existingAfter.price === 20000 && existingAfter.cost_price === 10000, existingAfter);

  const fresh = await preview('ADD', [{ row_no: 2, product_name: '안 팔린 신규', barcode: barcode(), price: '1000', stock: '3' }]);
  await apply(fresh.data.batch_id);
  const freshId = db.prepare("SELECT id FROM products WHERE product_name = '안 팔린 신규' AND pharmacy_id = 1").get().id;
  await revert(fresh.data.batch_id);
  check('안 팔린 신규 상품은 되돌리면 삭제', !db.prepare('SELECT 1 FROM products WHERE id = ?').get(freshId));
  const history = await api('/product-import/batches', { token: owner });
  check('등록 이력에 적용·되돌림 표시', history.data.batches.some((b) => b.status === 'REVERTED') && history.data.batches.every((b) => b.status !== 'PREVIEW'), history.data.batches.length);
}

console.log('[프로필]');
{
  let res = await api('/product-import/profiles', { token: owner, method: 'POST', body: { name: '옛 POS', column_map: { product_name: '품명', stock: '현재고' }, options: { missing: 'KEEP' } } });
  check('설정 저장', res.status === 200 && res.data.profiles.some((p) => p.name === '옛 POS' && p.column_map.stock === '현재고'), res.data);
  res = await api('/product-import/profiles', { token: owner, method: 'POST', body: { name: '옛 POS', column_map: { product_name: '상품명' } } });
  const profile = res.data.profiles.find((p) => p.name === '옛 POS');
  check('같은 이름이면 덮어씀', res.data.profiles.filter((p) => p.name === '옛 POS').length === 1 && profile.column_map.product_name === '상품명', res.data.profiles);
  check('프로필로 열 다시 맞춤', JSON.stringify(P.mapFromProfile(['코드', '상품명'], profile.column_map)) === '{"product_name":1}');
  res = await api(`/product-import/profiles/${profile.id}`, { token: owner, method: 'DELETE' });
  check('설정 삭제', !res.data.profiles.some((p) => p.name === '옛 POS'));
}

console.log('[기존 POS 병행 동기화]');
{
  const code = barcode();
  const productId = db
    .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, barcode) VALUES (1, '병행 테스트 상품', 5000, 20, 'ON_SALE', ?)")
    .run(code).lastInsertRowid;

  let res = await preview('SYNC', [{ row_no: 2, barcode: code, stock: '20' }]);
  check('병행 모드가 꺼져 있으면 동기화 불가(409)', res.status === 409, res.status);
  res = await setSync({ enabled: true, online_stock_buffer: 2, interval_hours: 24 });
  check('병행 모드 켜기', res.status === 200 && res.data.enabled && res.data.reflected_until, res.data);
  const startedAt = res.data.reflected_until;

  res = await preview('MIGRATE', [{ row_no: 2, barcode: code, stock: '1' }]);
  check('병행 중에는 이전 모드 불가(409)', res.status === 409, res.status);
  res = await api('/pos/inventory/adjust', { token: owner, method: 'POST', body: { adjust_type: 'RECEIVE', product_id: productId, quantity: 5 } });
  check('병행 중 MAYDIN 입고 막힘(409)', res.status === 409 && res.data.message.includes('기존 POS'), res.data);
  res = await api('/pos/inventory/adjust', { token: owner, method: 'POST', body: { adjust_type: 'COUNT', product_id: productId, counted_quantity: 3, reason: '실사' } });
  check('병행 중 재고 실사 막힘(409)', res.status === 409, res.status);
  res = await api(`/products/${productId}`, { token: owner, method: 'PATCH', body: { stock_quantity: 99 } });
  check('병행 중 상품 수정으로 재고 변경 막힘(409)', res.status === 409, res.status);
  res = await api(`/products/${productId}`, { token: owner, method: 'PATCH', body: { price: 5500 } });
  check('재고가 아닌 값은 수정 가능', res.status === 200 && res.data.product.price === 5500, res.data);
  res = await api('/pos/products/quick', { token: owner, method: 'POST', body: { product_name: '병행 중 신규', price: 1000, stock_quantity: 3, barcode: barcode() } });
  check('병행 중 초기 재고 있는 빠른 등록 막힘(409)', res.status === 409, res.status);

  const mall = await api('/products/mall?pharmacyCode=A001', { token: owner });
  const shown = mall.data.products.find((p) => p.id === Number(productId));
  check('온라인에는 재고 - 여유분(20-2=18)', shown?.stock_quantity === 18, shown);
  check('온라인 응답에 기존 POS 코드·공개 여부 안 보냄', shown && !('external_code' in shown) && !('online_visible' in shown), Object.keys(shown || {}));

  let session = (await api('/pos/sessions/current', { token: owner })).data.session;
  if (!session) session = (await api('/pos/sessions/open', { token: owner, method: 'POST', body: { opening_cash: 0 } })).data.session;
  const sale = await api('/pos/sales', { token: owner, method: 'POST', body: { items: [{ product_id: productId, quantity: 3 }], payments: [{ method: 'CASH', amount: 16500 }] } });
  check('병행 중에도 MAYDIN POS 판매는 됨', sale.status === 201, sale.data);
  const refund = await api('/pos/sales', { token: owner, method: 'POST', body: { items: [{ product_id: productId, quantity: 1 }], payments: [{ method: 'CASH', amount: 5500 }] } });
  await api(`/pos/sales/${refund.data.order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '테스트 취소' } });
  check('MAYDIN 재고 20 → 17', db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity === 17);

  res = await api('/product-import/sync/outflow', { token: owner });
  const out = res.data.items.find((item) => item.product_id === Number(productId));
  check('MAYDIN에서 판 수량(취소 반영) 3', out?.quantity_out === 3, res.data);
  check('같은 초에 켠 직후 판매도 빠짐없이 잡음(기록 번호 기준)', res.data.until_log_id > res.data.from_log_id, res.data);
  const csv = await fetch(`${BASE}/api/product-import/sync/outflow.csv?until_log_id=${res.data.until_log_id}`, { headers: { Authorization: `Bearer ${owner}` } });
  check('판매 수량 CSV', csv.status === 200 && (await csv.text()).includes('병행 테스트 상품'), csv.status);

  // 기존 POS는 MAYDIN 판매를 모르므로 파일에는 여전히 20개(기존 POS에서 2개를 더 팔았다면 18개)
  res = await preview('SYNC', [{ row_no: 2, barcode: code, stock: '18' }], {}, { snapshot_at: new Date().toISOString() });
  check('동기화 미리보기 201', res.status === 201, res.data);
  let rows = await rowsOf(res.data.batch_id);
  check('새 재고 = 파일 18 - MAYDIN 판매 3 = 15', rows[0].stock_after === 15, rows[0]);
  check('적용', (await apply(res.data.batch_id)).status === 200 && db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(productId).stock_quantity === 15);

  res = await api('/product-import/sync/reflected', { token: owner, method: 'POST', body: { until_log_id: 0 } });
  check('입력 표시는 뒤로 못 돌림', res.status === 400, res.data);
  res = await api('/product-import/sync/reflected', { token: owner, method: 'POST', body: { until_log_id: 10_000_000 } });
  check('아직 없는 기록까지 표시 불가', res.status === 400, res.data);
  const listed = (await api('/product-import/sync/outflow', { token: owner })).data;
  // 목록을 내려받은 뒤에 생긴 판매는 다음 목록으로 넘어가야 한다.
  const late = await api('/pos/sales', { token: owner, method: 'POST', body: { items: [{ product_id: productId, quantity: 1 }], payments: [{ method: 'CASH', amount: 5500 }] } });
  res = await api('/product-import/sync/reflected', { token: owner, method: 'POST', body: { until_log_id: listed.until_log_id, until: listed.until } });
  check('기존 POS에 입력했음 표시', res.status === 200 && res.data.reflected_log_id === listed.until_log_id && res.data.reflected_until >= startedAt, res.data);
  res = await api('/product-import/sync/outflow', { token: owner });
  const after = res.data.items.filter((item) => item.product_id === Number(productId));
  check('표시한 뒤에는 그 뒤 판매(1개)만 남음', late.status === 201 && after.length === 1 && after[0].quantity_out === 1, res.data.items);
  await api(`/pos/sales/${late.data.order.id}/cancel`, { token: owner, method: 'POST', body: { reason: '테스트 취소' } });
  res = await api('/product-import/sync/outflow', { token: owner });
  await api('/product-import/sync/reflected', { token: owner, method: 'POST', body: { until_log_id: res.data.until_log_id } });
  res = await preview('SYNC', [{ row_no: 2, barcode: code, stock: '15' }], {}, { snapshot_at: new Date().toISOString() });
  rows = await rowsOf(res.data.batch_id);
  check('입력한 뒤 동기화는 파일 재고 그대로(15)', rows[0].action === 'UNCHANGED' && rows[0].stock_after === 15, rows[0]);
  res = await preview('SYNC', [{ row_no: 2, barcode: code, stock: '15' }], {}, { snapshot_at: '2000-01-01T00:00:00Z' });
  check('파일 시각이 입력 표시보다 이르면 경고', res.data.batch_warnings?.length === 1, res.data.batch_warnings);

  const member = await signupMember(db, {}, { keepOrder: true });
  db.prepare('UPDATE products SET stock_quantity = 3 WHERE id = ?').run(productId);
  await api('/cart', { token: member.data.token, method: 'POST', body: { product_id: productId, quantity: 2 } });
  res = await api('/orders', {
    token: member.data.token,
    method: 'POST',
    body: { order_type: 'PICKUP', payment_method: 'MOCK_CARD', contact_name: '테스트', contact_phone: '01000000000', preferred_at: '2026-12-01T10:00' }
  });
  check('여유분을 넘는 온라인 주문은 거절(재고 3, 여유분 2)', res.status === 400 && res.data.message.includes('재고'), res.data);

  res = await setSync({ enabled: false });
  check('병행 모드 끄기', res.status === 200 && res.data.enabled === false);
  res = await api('/pos/inventory/adjust', { token: owner, method: 'POST', body: { adjust_type: 'RECEIVE', product_id: productId, quantity: 1 } });
  check('끄면 MAYDIN 입고 다시 가능', res.status < 300 && res.data.product?.stock_quantity === 4, res.data);
  const mallOff = await api('/products/mall?pharmacyCode=A001', { token: owner });
  check('끄면 여유분 없이 실제 재고', mallOff.data.products.find((p) => p.id === Number(productId))?.stock_quantity === 4, mallOff.data.products.find((p) => p.id === Number(productId)));
  res = await setSync({ online_stock_buffer: 101 });
  check('여유분 범위 검사', res.status === 400, res.status);
}

done();
