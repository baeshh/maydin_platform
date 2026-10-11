// 다른 POS에서 내보낸 CSV·엑셀·PDF를 브라우저에서 읽어 행 목록으로 바꾼다. 원본 파일은 서버로 보내지 않는다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImportParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ROWS = 20000;

  const FIELDS = [
    { key: 'product_name', label: '상품명', required: true, synonyms: ['상품명', '품명', '제품명', '상품명칭', '품목명', '약품명', '상품이름', '제품명칭', 'productname', 'itemname', 'name'] },
    { key: 'barcode', label: '바코드', synonyms: ['바코드', '바코드번호', '표준코드', '대표바코드', '상품바코드', 'ean', 'gtin', 'barcode'] },
    { key: 'external_code', label: '기존 POS 상품코드', synonyms: ['상품코드', '품목코드', '코드', '자체코드', '제품코드', '관리코드', 'sku', 'code', 'itemcode'] },
    { key: 'price', label: '판매가', required: true, synonyms: ['판매가', '소비자가', '판매단가', '정상가', '판매가격', '소비자가격', '단가', '가격', 'price'] },
    { key: 'discount_price', label: '할인가', synonyms: ['할인가', '행사가', '할인판매가', '세일가'] },
    { key: 'cost_price', label: '매입가', synonyms: ['매입가', '입고가', '매입단가', '원가', '입고단가', '사입가', 'cost'] },
    { key: 'stock', label: '재고', synonyms: ['현재고', '재고', '재고수량', '현재재고', '재고량', '현재고수량', '잔량', '수량', 'stock', 'qty'] },
    { key: 'category', label: '분류', synonyms: ['분류', '대분류', '카테고리', '상품분류', '분류명', 'category'] },
    { key: 'product_kind', label: '구분', synonyms: ['구분', '상품구분', '품목구분', '의약품구분', '상품유형', '품목유형', '종류'] },
    { key: 'tax', label: '과세 구분', synonyms: ['과세구분', '과면세', '과세면세', '부가세구분', '과세여부', '면세여부', '과세'] },
    { key: 'brand', label: '브랜드', synonyms: ['브랜드', '제조사', '제약사', '제조원', '제조회사', 'brand', 'maker'] },
    { key: 'supplier', label: '거래처', synonyms: ['거래처', '매입처', '공급처', '도매상', '도매처', '거래처명', 'supplier', 'vendor'] },
    { key: 'expiry_date', label: '유통기한', synonyms: ['유통기한', '사용기한', '유효기간', '유효기한', '만료일', 'expiry', 'expirydate'] },
    { key: 'lot_number', label: '로트번호', synonyms: ['로트', '로트번호', '제조번호', 'lot', 'lotno', 'lotnumber'] },
    { key: 'safety_stock', label: '안전재고', synonyms: ['안전재고', '적정재고', '최소재고'] }
  ];
  const FIELD_KEYS = FIELDS.map((field) => field.key);

  // 고객 개인정보로 보이는 열. 열 맞추기 대상에서 빼고, 서버로 보내지 않는다.
  const PII_HEADERS = ['주민', '주민번호', '주민등록', '생년월일', '전화', '휴대폰', '핸드폰', '연락처', '고객명', '환자', '성명', '주소', '카드번호', '이메일'];
  const RRN_PATTERN = /\b\d{6}\s?-\s?[1-4]\d{6}\b/;
  const SUMMARY_PATTERN = /^(합\s*계|총\s*계|소\s*계|총\s*합\s*계|누\s*계|계|total|sum|subtotal)$/i;

  function normalizeHeader(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/[\s_\-./:·,'"]/g, '');
  }

  function matchHeaderDetail(value) {
    const header = normalizeHeader(value);
    if (!header) return null;
    for (const field of FIELDS) {
      if (field.synonyms.includes(header)) return { key: field.key, exact: true };
    }
    let best = null;
    for (const field of FIELDS) {
      for (const synonym of field.synonyms) {
        if (synonym.length < 2 || !header.includes(synonym)) continue;
        if (!best || synonym.length > best.length) best = { key: field.key, length: synonym.length };
      }
    }
    return best ? { key: best.key, exact: false } : null;
  }

  function matchHeader(value) {
    const match = matchHeaderDetail(value);
    return match ? match.key : null;
  }

  function isPiiHeader(value) {
    const header = normalizeHeader(value);
    if (!header || matchHeader(value)) return false;
    return PII_HEADERS.some((word) => header.includes(word));
  }

  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return formatDate(value);
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
    }
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function formatDate(date) {
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /* ---------- CSV ---------- */

  function decodeText(bytes, encoding = 'auto') {
    let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (encoding === 'euc-kr') return { text: new TextDecoder('euc-kr').decode(data), encoding: 'euc-kr' };
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), encoding: 'utf-8' };
    } catch (error) {
      if (encoding === 'utf-8') return { text: new TextDecoder('utf-8').decode(data), encoding: 'utf-8' };
      return { text: new TextDecoder('euc-kr').decode(data), encoding: 'euc-kr' };
    }
  }

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
    const score = (char) => lines.reduce((sum, line) => sum + (line.split(char).length - 1), 0);
    const candidates = [',', '\t', ';'].map((char) => ({ char, count: score(char) }));
    candidates.sort((a, b) => b.count - a.count);
    return candidates[0].count ? candidates[0].char : ',';
  }

  function parseDelimited(text, delimiter = detectDelimiter(text)) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          cell += char;
        }
      } else if (char === '"' && cell === '') {
        quoted = true;
      } else if (char === delimiter) {
        row.push(cell);
        cell = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.map((cells) => cells.map(cellText));
  }

  /* ---------- 엑셀 ---------- */

  function readWorkbook(XLSX, bytes) {
    return XLSX.read(bytes, { type: 'array', cellDates: true, dense: true });
  }

  // 바코드가 지수(8.8E+12)로 바뀌지 않도록 서식 대신 원래 값을 읽는다.
  function tableFromSheet(XLSX, workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
    return rows.map((cells) => cells.map(cellText));
  }

  /* ---------- PDF ---------- */

  function groupLines(items) {
    const sorted = items
      .filter((item) => String(item.str || '').trim())
      .map((item) => ({
        text: String(item.str).replace(/\s+/g, ' ').trim(),
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: Math.abs(item.height || item.transform[3] || 8)
      }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const item of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - item.y) <= Math.max(2, Math.min(line.height, item.height) * 0.5)) {
        line.items.push(item);
      } else {
        lines.push({ y: item.y, height: item.height, items: [item] });
      }
    }
    return lines.map((line) => ({ y: line.y, height: line.height, segments: mergeSegments(line.items.sort((a, b) => a.x - b.x)) }));
  }

  // pdf.js는 한 칸의 글자를 여러 조각으로 줄 때가 있어, 거의 붙어 있는 조각은 합친다.
  function mergeSegments(items) {
    const segments = [];
    for (const item of items) {
      const last = segments[segments.length - 1];
      const gap = last ? item.x - last.x1 : Infinity;
      if (last && gap < Math.max(1.5, item.height * 0.35)) {
        last.text += gap > item.height * 0.15 ? ` ${item.text}` : item.text;
        last.x1 = Math.max(last.x1, item.x + item.width);
      } else {
        segments.push({ text: item.text, x0: item.x, x1: item.x + item.width });
      }
    }
    return segments;
  }

  function headerOf(segments) {
    const keys = segments.map((segment) => matchHeader(segment.text));
    const matched = new Set(keys.filter(Boolean));
    return matched.size >= 2 && (matched.has('product_name') || matched.has('barcode') || matched.has('external_code')) ? keys : null;
  }

  function columnBounds(segments) {
    const centers = segments.map((segment) => (segment.x0 + segment.x1) / 2);
    return centers.map((center, index) => ({
      from: index === 0 ? -Infinity : (centers[index - 1] + center) / 2,
      to: index === centers.length - 1 ? Infinity : (center + centers[index + 1]) / 2
    }));
  }

  function placeSegments(segments, bounds) {
    const cells = bounds.map(() => '');
    for (const segment of segments) {
      const center = (segment.x0 + segment.x1) / 2;
      const index = bounds.findIndex((bound) => center >= bound.from && center < bound.to);
      if (index < 0) continue;
      cells[index] = cells[index] ? `${cells[index]} ${segment.text}` : segment.text;
    }
    return cells;
  }

  function looksNumeric(text) {
    return /^[-+]?[\d,.\s원₩%]+$/.test(text);
  }

  // 칸 안에서 줄바꿈된 글자(긴 상품명 등)는 숫자가 있는 가장 가까운 줄에 위아래 순서대로 붙인다.
  function attachFragments(lines) {
    const filledOf = (cells) => cells.map((cell, index) => (cell ? index : -1)).filter((index) => index >= 0);
    const isFragment = (cells) => {
      const filled = filledOf(cells);
      return filled.length > 0 && filled.length <= 2 && filled.every((index) => !looksNumeric(cells[index]));
    };
    const anchors = lines.filter((line) => !isFragment(line.cells));
    if (!anchors.length) return lines.map((line) => line.cells);
    for (const line of lines) {
      if (!isFragment(line.cells)) continue;
      const nearest = anchors.reduce((best, anchor) => (Math.abs(anchor.y - line.y) < Math.abs(best.y - line.y) ? anchor : best));
      if (Math.abs(nearest.y - line.y) > Math.max(line.height, nearest.height) * 3) {
        anchors.push(line);
        continue;
      }
      nearest.parts = nearest.parts || [];
      nearest.parts.push(line);
    }
    return anchors
      .sort((a, b) => b.y - a.y)
      .map((anchor) => {
        if (!anchor.parts) return anchor.cells;
        const pieces = [anchor, ...anchor.parts].sort((a, b) => b.y - a.y);
        return anchor.cells.map((_, index) => pieces.map((piece) => piece.cells[index]).filter(Boolean).join(' '));
      });
  }

  // 머리글의 가로 위치를 기준으로 각 줄의 글자를 열에 나눠 넣는다. 머리글이 페이지마다 반복되면 다시 맞춘다.
  function tableFromPdfPages(pages) {
    let header = null;
    let bounds = null;
    let textLength = 0;
    const rows = [];
    for (const items of pages) {
      let lines = [];
      const flush = () => {
        rows.push(...attachFragments(lines));
        lines = [];
      };
      for (const line of groupLines(items)) {
        textLength += line.segments.reduce((sum, segment) => sum + segment.text.length, 0);
        if (headerOf(line.segments)) {
          flush();
          bounds = columnBounds(line.segments);
          if (!header) header = line.segments.map((segment) => segment.text);
          continue;
        }
        if (!bounds) continue;
        lines.push({ y: line.y, height: line.height, cells: placeSegments(line.segments, bounds) });
      }
      flush();
    }
    return { table: header ? [header, ...rows] : [], headerFound: Boolean(header), textLength };
  }

  async function readPdf(pdfjsLib, bytes, { cMapUrl, standardFontDataUrl, maxPages = 300 } = {}) {
    const doc = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false
    }).promise;
    const pages = [];
    const pageCount = Math.min(doc.numPages, maxPages);
    for (let number = 1; number <= pageCount; number += 1) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items);
      page.cleanup();
    }
    await doc.destroy();
    const result = tableFromPdfPages(pages);
    return {
      ...result,
      pageCount: doc.numPages,
      truncated: doc.numPages > pageCount,
      // 글자가 거의 없으면 사진을 찍거나 스캔한 PDF로 본다.
      scanned: result.textLength < Math.max(20, pageCount * 5)
    };
  }

  /* ---------- 머리글·열 맞추기·행 만들기 ---------- */

  function detectHeaderRow(table) {
    let best = { index: 0, score: 0 };
    const limit = Math.min(table.length, 30);
    for (let index = 0; index < limit; index += 1) {
      const matched = new Set(table[index].map(matchHeader).filter(Boolean));
      if (matched.size > best.score) best = { index, score: matched.size };
    }
    return best.score >= 2 ? best.index : 0;
  }

  function autoMap(headers) {
    const map = {};
    const matches = headers.map(matchHeaderDetail);
    for (const exact of [true, false]) {
      matches.forEach((match, index) => {
        if (!match || match.exact !== exact || map[match.key] !== undefined) return;
        if (Object.values(map).includes(index)) return;
        map[match.key] = index;
      });
    }
    return map;
  }

  // 저장된 프로필은 열 이름으로 기억한다. 열 순서가 바뀌어도 같은 이름을 찾아 맞춘다.
  function mapFromProfile(headers, columnMap) {
    const map = {};
    const normalized = headers.map(normalizeHeader);
    for (const [key, name] of Object.entries(columnMap || {})) {
      if (!FIELD_KEYS.includes(key)) continue;
      const index = normalized.indexOf(normalizeHeader(name));
      if (index >= 0) map[key] = index;
    }
    return map;
  }

  function profileFromMap(headers, map) {
    const columnMap = {};
    for (const [key, index] of Object.entries(map)) {
      if (FIELD_KEYS.includes(key) && headers[index] !== undefined) columnMap[key] = headers[index];
    }
    return columnMap;
  }

  function piiColumns(table, headerIndex) {
    const headers = table[headerIndex] || [];
    const columns = new Set();
    headers.forEach((header, index) => {
      if (isPiiHeader(header)) columns.add(index);
    });
    for (const cells of table.slice(headerIndex + 1, headerIndex + 201)) {
      cells.forEach((cell, index) => {
        if (RRN_PATTERN.test(cell)) columns.add(index);
      });
    }
    return [...columns].sort((a, b) => a - b);
  }

  function buildRows(table, headerIndex, map) {
    const headers = table[headerIndex] || [];
    const normalizedHeaders = headers.map(normalizeHeader).join('|');
    const rows = [];
    const skipped = { empty: 0, summary: 0, header: 0, no_key: 0 };
    const entries = Object.entries(map).filter(([key, index]) => FIELD_KEYS.includes(key) && Number.isInteger(index));
    for (let index = headerIndex + 1; index < table.length; index += 1) {
      const cells = table[index] || [];
      if (!cells.some((cell) => cell)) {
        skipped.empty += 1;
        continue;
      }
      if (cells.map(normalizeHeader).join('|') === normalizedHeaders) {
        skipped.header += 1;
        continue;
      }
      if (cells.some((cell) => SUMMARY_PATTERN.test(String(cell).trim()))) {
        skipped.summary += 1;
        continue;
      }
      const row = { row_no: index + 1 };
      for (const [key, column] of entries) row[key] = cells[column] ?? '';
      if (!row.product_name && !row.barcode && !row.external_code) {
        skipped.no_key += 1;
        continue;
      }
      rows.push(row);
    }
    return { rows: rows.slice(0, MAX_ROWS), skipped, truncated: rows.length > MAX_ROWS };
  }

  function fileKind(name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return 'CSV';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'XLSX';
    if (ext === 'pdf') return 'PDF';
    return null;
  }

  return {
    MAX_ROWS,
    FIELDS,
    FIELD_KEYS,
    normalizeHeader,
    matchHeader,
    isPiiHeader,
    decodeText,
    detectDelimiter,
    parseDelimited,
    readWorkbook,
    tableFromSheet,
    groupLines,
    tableFromPdfPages,
    readPdf,
    detectHeaderRow,
    autoMap,
    mapFromProfile,
    profileFromMap,
    piiColumns,
    buildRows,
    fileKind
  };
});
