// 일괄 등록 테스트용 파일(CP949 CSV, 엑셀, 글자 PDF, 스캔 PDF)을 만든다. 실제 고객 정보는 넣지 않는다.
// 사용: node tests/fixtures/generate.mjs  (macOS의 iconv와 Google Chrome 필요)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const dir = path.dirname(fileURLToPath(import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function ean13(body12) {
  const digits = String(body12).split('').map(Number);
  const sum = digits.reduce((acc, digit, index) => acc + digit * (index % 2 ? 3 : 1), 0);
  return `${body12}${(10 - (sum % 10)) % 10}`;
}

const csv = [
  '재고현황 2026-10-10',
  ',,,,,,,,',
  '상품코드,바코드,품명,구분,소비자가(원),매입가,현재고,제조사,유통기한',
  `P-001,${ean13('880123456789')},비타민C 1000,건강기능식품,"15,000",9000,30,메이딘랩,2027.06.30`,
  `P-002,${ean13('880987654321')},소화제 정,일반의약품,4500,2800,12,한빛제약,`,
  'P-003,,처방약 테스트,전문의약품,3000,1000,5,,',
  `P-004,${ean13('880111111111')},마스크 KF94,의약외품,1200,500,-2,,`,
  '합계,,,,,,45,,'
].join('\r\n');
writeFileSync(path.join(dir, 'pos-export-cp949.csv'), execFileSync('iconv', ['-f', 'utf-8', '-t', 'cp949'], { input: csv }));

const sheet = XLSX.utils.aoa_to_sheet([
  ['상품 재고 목록'],
  ['바코드', '상품명', '판매가', '재고수량', '사용기한', '과세구분'],
  [Number(ean13('880200000001')), '종합비타민', 22000, 15, new Date(2027, 2, 31), '과세'],
  [Number(ean13('880200000002')), '유산균 30포', 31000, 8, new Date(2026, 11, 15), '과세'],
  [Number(ean13('880200000003')), '생리식염수', 3000, 40, '', '면세']
], { cellDates: true });
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, sheet, '재고');
XLSX.writeFile(book, path.join(dir, 'pos-export.xlsx'));

const pdfRows = Array.from({ length: 70 }, (_, index) => {
  const no = String(index + 1).padStart(3, '0');
  const name = index === 2 ? '아주 긴 이름의 건강기능식품 오메가3 트리플 스트렝스 대용량 180캡슐' : `테스트 상품 ${no}`;
  return `<tr><td>Q-${no}</td><td>${ean13(`8803000${no}00`)}</td><td class="name">${name}</td><td class="n">${(1000 + index * 100).toLocaleString('ko-KR')}</td><td class="n">${index % 9}</td></tr>`;
}).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
body{font-family:'Apple SD Gothic Neo',sans-serif;font-size:11px;margin:24px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 6px}
td.n{text-align:right}td.name{width:180px}
</style><h3>재고 현황표</h3><p>출력일 2026-10-10</p>
<table><thead><tr><th>상품코드</th><th>바코드</th><th>상품명</th><th>판매가</th><th>현재고</th></tr></thead><tbody>${pdfRows}</tbody></table>`;

const work = mkdtempSync(path.join(tmpdir(), 'maydin-fixture-'));
writeFileSync(path.join(work, 'table.html'), html);
const printPdf = (input, output) =>
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${output}`, `file://${input}`], { stdio: 'ignore' });
printPdf(path.join(work, 'table.html'), path.join(dir, 'pos-export.pdf'));

execFileSync(chrome, ['--headless=new', '--disable-gpu', '--window-size=900,600', `--screenshot=${path.join(work, 'shot.png')}`, `file://${path.join(work, 'table.html')}`], { stdio: 'ignore' });
const png = readFileSync(path.join(work, 'shot.png')).toString('base64');
writeFileSync(path.join(work, 'scan.html'), `<!doctype html><body style="margin:0"><img style="width:100%" src="data:image/png;base64,${png}">`);
printPdf(path.join(work, 'scan.html'), path.join(dir, 'scanned.pdf'));

console.log('fixtures written to', dir);
