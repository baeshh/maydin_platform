// 파트너센터 · 상품 일괄 등록(다른 POS에서 이전, 입고분 더하기, 기존 POS와 병행 동기화)
// owner.html의 h, showToast, api, $, formatDate, loadOwner를 그대로 쓴다.

const IMPORT_MODES = {
  MIGRATE: { label: '기존 POS에서 옮기기', desc: '파일의 재고로 MAYDIN 재고를 맞춥니다. 처음 한 번 옮길 때 씁니다.' },
  ADD: { label: '입고분 더하기', desc: '파일의 수량만큼 지금 재고에 더합니다. 거래처 납품서·입고 목록에 씁니다.' },
  SYNC: { label: '기존 POS와 병행', desc: '기존 POS 재고에서 그 뒤 MAYDIN에서 판 수량을 빼서 맞춥니다.' }
};
const IMPORT_ACTIONS = {
  CREATE: { text: '신규', color: 'blue' },
  UPDATE: { text: '수정', color: 'green' },
  UNCHANGED: { text: '변화 없음', color: 'gray' },
  SKIP: { text: '건너뜀', color: 'gray' },
  ERROR: { text: '오류', color: 'red' }
};
const IMPORT_UPDATE_FIELDS = [
  ['stock', '재고'],
  ['price', '판매가'],
  ['cost_price', '매입가'],
  ['discount_price', '할인가'],
  ['product_name', '상품명'],
  ['category', '분류'],
  ['brand', '브랜드'],
  ['product_type', '구분'],
  ['tax_type', '과세'],
  ['safety_stock', '안전재고'],
  ['supplier', '거래처']
];
const IMPORT_MAX_BYTES = { CSV: 10 * 1024 * 1024, XLSX: 10 * 1024 * 1024, PDF: 20 * 1024 * 1024 };

const imp = {
  tab: 'file',
  mode: 'MIGRATE',
  loading: '',
  file: null,
  encoding: 'auto',
  workbook: null,
  sheet: '',
  pdfInfo: null,
  table: [],
  headerRow: 0,
  map: {},
  pii: [],
  built: null,
  profiles: [],
  profileName: '',
  options: { update_fields: ['stock', 'price', 'cost_price'], missing: 'KEEP', cost_includes_vat: false, links: {}, excluded: [] },
  snapshotAt: '',
  batch: null,
  view: { batchId: null, filter: 'ALL', q: '', page: 1, data: null, readOnly: false },
  result: null,
  history: [],
  sync: null,
  outflow: null
};

function importBadge(action) {
  const item = IMPORT_ACTIONS[action] || { text: action, color: 'gray' };
  return `<span class="badge ${item.color}" style="white-space: nowrap;">${h(item.text)}</span>`;
}

function importValue(field, value) {
  if (value === null || value === undefined || value === '') return '없음';
  if (['price', 'discount_price', 'cost_price'].includes(field)) return money(value);
  if (field === 'product_type') return { GENERAL: '일반 상품', OTC: '일반의약품' }[value] || value;
  if (field === 'tax_type') return { TAXABLE: '과세', EXEMPT: '면세' }[value] || value;
  if (['pos_sale_enabled', 'online_visible', 'needs_review'].includes(field)) return Number(value) ? '예' : '아니오';
  return String(value);
}

function localInputNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

async function loadImport() {
  try {
    const [sync, profiles] = await Promise.all([api.request('/product-import/sync'), api.request('/product-import/profiles')]);
    imp.sync = sync;
    imp.profiles = profiles.profiles;
    window.posSyncEnabled = sync.enabled;
    $('#navImportBadge').hidden = !sync.stale;
    if (sync.enabled && imp.mode === 'MIGRATE') setImportMode('SYNC');
    if (imp.tab === 'history') await loadImportHistory(false);
    renderImport();
  } catch (error) {
    $('#importBody').innerHTML = renderEmpty(error.message);
  }
}

function setImportTab(tab) {
  imp.tab = tab;
  if (tab === 'history') loadImportHistory();
  else renderImport();
}

function renderImport() {
  const tabs = [
    ['file', '파일로 등록'],
    ['history', '등록 이력'],
    ['sync', `기존 POS 병행${imp.sync?.enabled ? ' · 켜짐' : ''}`]
  ];
  $('#importTabs').innerHTML = tabs
    .map(([key, label]) => `<button class="tab-btn ${imp.tab === key ? 'active' : ''}" type="button" onclick="setImportTab('${key}')">${h(label)}</button>`)
    .join('');
  let body = '';
  if (imp.tab === 'history') body = renderImportHistory();
  else if (imp.tab === 'sync') body = renderImportSync();
  else if (imp.result) body = renderImportResult();
  else if (imp.batch) body = renderImportPreview();
  else body = renderImportSetup();
  $('#importBody').innerHTML = (imp.loading ? `<div class="insight-box imp-loading">${h(imp.loading)}</div>` : '') + body;
}

/* ---------- 1. 방식·파일 ---------- */

function renderImportSetup() {
  const syncOn = imp.sync?.enabled;
  const modes = Object.entries(IMPORT_MODES)
    .map(([key, mode]) => {
      const disabled = (key === 'SYNC' && !syncOn) || (key === 'MIGRATE' && syncOn);
      const note = key === 'SYNC' && !syncOn ? '병행 모드를 켜야 쓸 수 있습니다.' : key === 'MIGRATE' && syncOn ? '병행 중에는 쓸 수 없습니다.' : mode.desc;
      return `<label class="imp-mode ${imp.mode === key ? 'active' : ''} ${disabled ? 'disabled' : ''}">
        <input type="radio" name="impMode" value="${key}" ${imp.mode === key ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="setImportMode('${key}')" />
        <strong>${h(mode.label)}</strong><span>${h(note)}</span>
      </label>`;
    })
    .join('');
  return `
    <div class="imp-modes">${modes}</div>
    <div class="imp-drop">
      <div class="inline-actions" style="align-items: center;">
        <label class="btn btn-outline btn-sm" for="importFile">${imp.file ? '다른 파일 고르기' : '파일 고르기'}</label>
        <input id="importFile" type="file" hidden accept=".csv,.txt,.tsv,.xlsx,.xls,.pdf" onchange="pickImportFile(this.files[0])" />
        <strong>${imp.file ? h(imp.file.name) : ''}</strong>
      </div>
      <p class="list-meta">CSV · 엑셀(.xlsx, .xls) · PDF(글자를 고를 수 있는 PDF). 최대 20,000행.
        파일은 이 브라우저에서만 읽고, 서버에는 맞춘 행만 보냅니다. 원본 파일은 저장하지 않습니다.</p>
      <p class="list-meta">기존 POS의 "재고 현황" 내보내기 파일을 그대로 올리면 됩니다. 양식이 없으면
        <button class="muted-link" type="button" onclick="downloadImportFile('/product-import/template.csv')">MAYDIN 양식</button>을 쓰세요.</p>
    </div>
    ${imp.table.length ? renderImportMapping() : ''}`;
}

function setImportMode(mode) {
  if (mode !== imp.mode && !imp.profileName) {
    imp.options.update_fields = { ADD: ['stock', 'cost_price'], SYNC: ['stock'] }[mode] || ['stock', 'price', 'cost_price'];
  }
  imp.mode = mode;
  if (mode === 'ADD') imp.options.missing = 'KEEP';
  if (mode === 'SYNC' && !imp.snapshotAt) imp.snapshotAt = localInputNow();
  rebuildImportRows();
  renderImport();
}

async function loadScriptOnce(src) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('파일 읽기 도구를 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
}

async function pickImportFile(file) {
  if (!file) return;
  const kind = ImportParse.fileKind(file.name);
  if (!kind) return showToast('CSV, 엑셀, PDF 파일만 올릴 수 있습니다.');
  if (file.size > IMPORT_MAX_BYTES[kind]) return showToast(`파일이 너무 큽니다. ${kind === 'PDF' ? 20 : 10}MB 이하로 올려 주세요.`);
  Object.assign(imp, { file: { name: file.name, kind, bytes: new Uint8Array(await file.arrayBuffer()) }, encoding: 'auto', workbook: null, sheet: '', pdfInfo: null, table: [] });
  imp.options.links = {};
  imp.options.excluded = [];
  imp.loading = '파일을 읽는 중입니다.';
  renderImport();
  try {
    await readImportFile();
  } catch (error) {
    imp.table = [];
    showToast(error.message || '파일을 읽지 못했습니다.');
  }
  imp.loading = '';
  renderImport();
}

async function readImportFile() {
  const { kind, bytes } = imp.file;
  if (kind === 'CSV') {
    const decoded = ImportParse.decodeText(bytes, imp.encoding);
    imp.encodingUsed = decoded.encoding;
    setImportTable(ImportParse.parseDelimited(decoded.text));
  } else if (kind === 'XLSX') {
    await loadScriptOnce('/vendor/xlsx.full.min.js');
    imp.workbook = ImportParse.readWorkbook(window.XLSX, bytes);
    imp.sheet = imp.sheet || imp.workbook.SheetNames[0];
    setImportTable(ImportParse.tableFromSheet(window.XLSX, imp.workbook, imp.sheet));
  } else {
    const pdfjs = await import('/vendor/pdfjs/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    const result = await ImportParse.readPdf(pdfjs, bytes.slice(), {
      cMapUrl: '/vendor/pdfjs/cmaps/',
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'
    });
    imp.pdfInfo = result;
    if (result.scanned) {
      imp.table = [];
      throw new Error('사진이나 스캔으로 만든 PDF라 글자를 읽을 수 없습니다. 기존 POS에서 엑셀·CSV로 내보내거나, 글자를 고를 수 있는 PDF로 저장해 올려 주세요.');
    }
    if (!result.headerFound) {
      imp.table = [];
      throw new Error('PDF에서 표 머리글(상품명, 바코드, 재고 등)을 찾지 못했습니다. 엑셀·CSV로 내보내 올려 주세요.');
    }
    setImportTable(result.table);
  }
  if (!imp.table.length) throw new Error('파일에 읽을 내용이 없습니다.');
}

function setImportTable(table) {
  imp.table = table;
  imp.headerRow = ImportParse.detectHeaderRow(table);
  applyImportHeader(true);
}

function applyImportHeader(tryProfile) {
  const headers = imp.table[imp.headerRow] || [];
  imp.pii = ImportParse.piiColumns(imp.table, imp.headerRow);
  imp.map = ImportParse.autoMap(headers);
  if (tryProfile) {
    const best = bestImportProfile(headers);
    if (best) {
      useImportProfile(best, false);
      showToast(`저장된 설정 "${best.name}"을(를) 적용했습니다.`);
    }
  }
  dropPiiFromMap();
  rebuildImportRows();
}

function dropPiiFromMap() {
  for (const [key, index] of Object.entries(imp.map)) {
    if (imp.pii.includes(index)) delete imp.map[key];
  }
}

function bestImportProfile(headers) {
  let best = null;
  for (const profile of imp.profiles) {
    const names = Object.values(profile.column_map || {});
    if (!names.length) continue;
    const map = ImportParse.mapFromProfile(headers, profile.column_map);
    if (Object.keys(map).length !== names.length) continue;
    if (!best || names.length > best.count) best = { ...profile, count: names.length };
  }
  return best;
}

function useImportProfile(profile, rebuild = true) {
  const headers = imp.table[imp.headerRow] || [];
  imp.map = ImportParse.mapFromProfile(headers, profile.column_map);
  const options = profile.options || {};
  if (Array.isArray(options.update_fields)) imp.options.update_fields = options.update_fields;
  if (options.missing && imp.mode !== 'ADD') imp.options.missing = options.missing;
  imp.options.cost_includes_vat = options.cost_includes_vat === true;
  imp.profileName = profile.name;
  if (rebuild) {
    dropPiiFromMap();
    rebuildImportRows();
    renderImport();
  }
}

function rebuildImportRows() {
  imp.built = imp.table.length ? ImportParse.buildRows(imp.table, imp.headerRow, imp.map) : null;
}

/* ---------- 2. 열 맞추기·옵션 ---------- */

function renderImportMapping() {
  const headers = imp.table[imp.headerRow] || [];
  const sample = imp.table[imp.headerRow + 1] || [];
  const columnOptions = (selected) =>
    `<option value="">가져오지 않음</option>` +
    headers
      .map((header, index) => {
        const pii = imp.pii.includes(index);
        return `<option value="${index}" ${selected === index ? 'selected' : ''} ${pii ? 'disabled' : ''}>${index + 1}. ${h(header || '(이름 없음)')}${pii ? ' · 개인정보' : ''}</option>`;
      })
      .join('');
  const fields = ImportParse.FIELDS.map((field) => {
    const index = imp.map[field.key];
    const value = Number.isInteger(index) ? sample[index] : '';
    return `<div class="imp-map-row">
      <label class="form-label">${h(field.label)}${field.required ? ' <span class="imp-req">신규 필수</span>' : ''}</label>
      <select class="form-control" onchange="setImportColumn('${field.key}', this.value)">${columnOptions(index)}</select>
      <span class="list-meta imp-sample" title="${h(value)}">${value ? `예: ${h(value)}` : ''}</span>
    </div>`;
  }).join('');

  const fileMeta = [];
  if (imp.file.kind === 'CSV') {
    fileMeta.push(`<label class="list-meta">글자 인코딩
      <select class="form-control imp-inline" onchange="setImportEncoding(this.value)">
        <option value="auto" ${imp.encoding === 'auto' ? 'selected' : ''}>자동 (${imp.encodingUsed === 'euc-kr' ? '한글 윈도우' : 'UTF-8'})</option>
        <option value="utf-8" ${imp.encoding === 'utf-8' ? 'selected' : ''}>UTF-8</option>
        <option value="euc-kr" ${imp.encoding === 'euc-kr' ? 'selected' : ''}>한글 윈도우(CP949)</option>
      </select></label>`);
  }
  if (imp.workbook && imp.workbook.SheetNames.length > 1) {
    fileMeta.push(`<label class="list-meta">시트
      <select class="form-control imp-inline" onchange="setImportSheet(this.value)">
        ${imp.workbook.SheetNames.map((name) => `<option ${name === imp.sheet ? 'selected' : ''}>${h(name)}</option>`).join('')}
      </select></label>`);
  }
  if (imp.pdfInfo) {
    fileMeta.push(`<span class="list-meta">PDF ${imp.pdfInfo.pageCount}쪽${imp.pdfInfo.truncated ? ' (앞 300쪽만 읽음)' : ''} · 표를 글자 위치로 나눴으니 아래 예시가 맞는지 꼭 확인해 주세요.</span>`);
  }
  fileMeta.push(`<label class="list-meta">머리글 줄
    <input class="form-control imp-inline mini-input" type="number" min="1" max="${Math.min(imp.table.length, 50)}" value="${imp.headerRow + 1}" onchange="setImportHeaderRow(this.value)" /></label>`);

  const skipped = imp.built?.skipped || {};
  const skippedText = [
    skipped.empty && `빈 줄 ${skipped.empty}`,
    skipped.summary && `합계 줄 ${skipped.summary}`,
    skipped.header && `반복 머리글 ${skipped.header}`,
    skipped.no_key && `상품명·바코드·코드가 모두 없는 줄 ${skipped.no_key}`
  ].filter(Boolean);
  const rows = imp.built?.rows || [];
  const hasKey = ['barcode', 'external_code'].some((key) => Number.isInteger(imp.map[key]));
  const mapped = ImportParse.FIELDS.filter((field) => Number.isInteger(imp.map[field.key]));
  const piiNames = imp.pii.map((index) => headers[index] || `${index + 1}번째 열`);

  return `
    <div class="imp-step">
      <h3>2. 열 맞추기 <span class="list-meta">${h(imp.file.name)} · 읽은 상품 ${rows.length.toLocaleString()}행</span></h3>
      <div class="report-controls">${fileMeta.join('')}</div>
      ${piiNames.length ? `<div class="insight-box imp-warn">개인정보로 보이는 열(${h(piiNames.join(', '))})은 가져오지 않습니다.</div>` : ''}
      ${imp.built?.truncated ? `<div class="insight-box imp-warn">20,000행을 넘어 앞 20,000행만 올립니다. 파일을 나눠 올려 주세요.</div>` : ''}
      ${!hasKey ? '<div class="insight-box imp-warn">바코드나 기존 POS 상품코드 열이 없으면 다음에 올릴 때 같은 상품을 찾지 못합니다. 둘 중 하나는 꼭 맞춰 주세요.</div>' : ''}
      ${skippedText.length ? `<p class="list-meta">건너뛴 줄: ${h(skippedText.join(' · '))}</p>` : ''}
      <div class="imp-profile">
        <select class="form-control imp-inline" onchange="if (this.value) useImportProfile(imp.profiles.find((p) => p.id === Number(this.value)))">
          <option value="">저장된 설정 불러오기</option>
          ${imp.profiles.map((p) => `<option value="${p.id}">${h(p.name)}</option>`).join('')}
        </select>
        <input id="importProfileName" class="form-control imp-inline" maxlength="40" placeholder="예: 기존 OO POS 재고" value="${h(imp.profileName)}" />
        <button class="btn btn-outline btn-sm" type="button" onclick="saveImportProfile()">이 설정 저장</button>
        ${imp.profiles.length ? `<button class="muted-link" type="button" onclick="deleteImportProfile()">저장된 설정 지우기</button>` : ''}
      </div>
      <div class="imp-map">${fields}</div>
    </div>
    <div class="imp-step">
      <h3>3. 적용 방법</h3>
      ${renderImportOptions()}
    </div>
    ${rows.length ? `
    <div class="imp-step">
      <h3>읽은 내용 확인 <span class="list-meta">앞 5행</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th class="row-no">줄</th>${mapped.map((field) => `<th>${h(field.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 5).map((row) => `<tr><td class="row-no">${row.row_no}</td>${mapped.map((field) => `<td>${h(row[field.key])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </div>` : ''}
    <div class="inline-actions imp-actions">
      <button class="btn btn-primary" type="button" ${rows.length ? '' : 'disabled'} onclick="previewImport()">미리보기 만들기 (${rows.length.toLocaleString()}행)</button>
      <button class="btn btn-outline" type="button" onclick="resetImport()">다른 파일 올리기</button>
    </div>`;
}

function renderImportOptions() {
  const fields = IMPORT_UPDATE_FIELDS.map(
    ([key, label]) => `<label class="check-chip"><input type="checkbox" ${imp.options.update_fields.includes(key) ? 'checked' : ''} onchange="toggleImportField('${key}', this.checked)" /> ${h(label)}</label>`
  ).join('');
  const missing =
    imp.mode === 'ADD'
      ? ''
      : `<div class="form-group full">
          <span class="form-label">파일에 없는 MAYDIN 상품</span>
          <div class="segmented small">
            ${[
              ['KEEP', '그대로 두기'],
              ['ZERO', '재고 0으로'],
              ['POS_OFF', 'POS 판매 중지']
            ]
              .map(([key, label]) => `<button type="button" class="${imp.options.missing === key ? 'active' : ''}" onclick="imp.options.missing='${key}'; renderImport()">${label}</button>`)
              .join('')}
          </div>
        </div>`;
  const snapshot =
    imp.mode === 'SYNC'
      ? `<div class="form-group">
          <label class="form-label" for="importSnapshot">기존 POS에서 이 파일을 내려받은 시각</label>
          <input id="importSnapshot" class="form-control" type="datetime-local" value="${h(imp.snapshotAt)}" max="${localInputNow()}" onchange="imp.snapshotAt = this.value" />
          <span class="list-meta">이 시각 뒤에 MAYDIN에서 판 수량을 빼서 맞춥니다.</span>
        </div>`
      : '';
  return `
    <div class="form-grid">
      <div class="form-group full">
        <span class="form-label">이미 있는 상품에서 바꿀 항목</span>
        <div class="inline-actions" style="flex-wrap: wrap;">${fields}</div>
        <span class="list-meta">새 상품은 파일의 모든 값으로 만들고, 온라인에는 공개하지 않은 상태로 등록합니다.</span>
      </div>
      ${missing}
      <div class="form-group">
        <label class="check-chip"><input type="checkbox" ${imp.options.cost_includes_vat ? 'checked' : ''} onchange="imp.options.cost_includes_vat = this.checked" /> 파일의 매입가가 부가세 포함 금액</label>
      </div>
      ${snapshot}
    </div>`;
}

function setImportColumn(key, value) {
  if (value === '') delete imp.map[key];
  else {
    const index = Number(value);
    for (const [other, column] of Object.entries(imp.map)) if (column === index) delete imp.map[other];
    imp.map[key] = index;
  }
  rebuildImportRows();
  renderImport();
}

function toggleImportField(key, checked) {
  const set = new Set(imp.options.update_fields);
  if (checked) set.add(key);
  else set.delete(key);
  imp.options.update_fields = [...set];
}

async function setImportEncoding(value) {
  imp.encoding = value;
  await readImportFile().catch((error) => showToast(error.message));
  renderImport();
}

function setImportSheet(name) {
  imp.sheet = name;
  setImportTable(ImportParse.tableFromSheet(window.XLSX, imp.workbook, name));
  renderImport();
}

function setImportHeaderRow(value) {
  imp.headerRow = Math.min(Math.max(0, Number(value) - 1), imp.table.length - 1);
  applyImportHeader(false);
  renderImport();
}

async function saveImportProfile() {
  const name = $('#importProfileName').value.trim();
  if (!name) return showToast('설정 이름을 입력해 주세요.');
  try {
    const headers = imp.table[imp.headerRow] || [];
    const { profiles } = await api.request('/product-import/profiles', {
      method: 'POST',
      body: {
        name,
        column_map: ImportParse.profileFromMap(headers, imp.map),
        options: { update_fields: imp.options.update_fields, missing: imp.options.missing, cost_includes_vat: imp.options.cost_includes_vat }
      }
    });
    imp.profiles = profiles;
    imp.profileName = name;
    showToast(`"${name}" 설정을 저장했습니다. 다음에 같은 형식의 파일을 올리면 자동으로 맞춥니다.`);
    renderImport();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteImportProfile() {
  const name = prompt(`지울 설정 이름을 입력하세요.\n${imp.profiles.map((p) => p.name).join(', ')}`);
  const profile = imp.profiles.find((p) => p.name === (name || '').trim());
  if (!profile) return name && showToast('그 이름의 설정이 없습니다.');
  try {
    imp.profiles = (await api.request(`/product-import/profiles/${profile.id}`, { method: 'DELETE' })).profiles;
    showToast('설정을 지웠습니다.');
    renderImport();
  } catch (error) {
    showToast(error.message);
  }
}

function resetImport() {
  Object.assign(imp, { file: null, workbook: null, pdfInfo: null, table: [], map: {}, pii: [], built: null, batch: null, result: null, profileName: '' });
  imp.options.links = {};
  imp.options.excluded = [];
  imp.view = { batchId: null, filter: 'ALL', q: '', page: 1, data: null, readOnly: false };
  renderImport();
}

/* ---------- 4. 미리보기 ---------- */

async function previewImport() {
  if (!imp.built?.rows.length) return;
  if (imp.mode === 'SYNC' && !imp.snapshotAt) return showToast('파일을 내려받은 시각을 입력해 주세요.');
  imp.loading = `${imp.built.rows.length.toLocaleString()}행을 확인하는 중입니다.`;
  renderImport();
  try {
    const batch = await api.request('/product-import/preview', {
      method: 'POST',
      body: {
        mode: imp.mode,
        rows: imp.built.rows,
        options: imp.options,
        file_name: imp.file.name,
        source_type: imp.file.kind,
        snapshot_at: imp.mode === 'SYNC' ? new Date(imp.snapshotAt).toISOString() : undefined
      }
    });
    imp.batch = batch;
    const keep = Boolean(imp.view.batchId) && !imp.view.readOnly;
    imp.view = { batchId: batch.batch_id, filter: keep ? imp.view.filter : 'ALL', q: keep ? imp.view.q : '', page: keep ? imp.view.page : 1, data: null, readOnly: false };
    await loadImportRows();
  } catch (error) {
    showToast(error.message);
  }
  imp.loading = '';
  renderImport();
}

async function loadImportRows() {
  const { batchId, filter, q, page } = imp.view;
  const params = new URLSearchParams({ filter, q, page, page_size: 50 });
  imp.view.data = await api.request(`/product-import/batches/${batchId}?${params}`);
}

async function setImportView(patch) {
  Object.assign(imp.view, patch);
  try {
    await loadImportRows();
  } catch (error) {
    showToast(error.message);
  }
  renderImport();
}

function renderImportCounts(batch) {
  const counts = [
    ['ALL', '전체', batch.total_rows],
    ['CREATE', '신규', batch.create_count],
    ['UPDATE', '수정', batch.update_count],
    ['UNCHANGED', '변화 없음', batch.unchanged_count],
    ['WARNING', '확인할 점', batch.warning_count],
    ['SKIP', '건너뜀', batch.skip_count],
    ['ERROR', '오류', batch.error_count]
  ];
  return `<div class="imp-counts">${counts
    .map(
      ([key, label, count]) =>
        `<button type="button" class="imp-count ${imp.view.filter === key ? 'active' : ''} ${key === 'ERROR' && count ? 'danger' : ''}" onclick="setImportView({ filter: '${key}', page: 1 })"><span>${label}</span><strong>${Number(count || 0).toLocaleString()}</strong></button>`
    )
    .join('')}</div>`;
}

function renderImportChanges(row) {
  if (row.created) {
    const c = row.created;
    const parts = [
      `재고 ${Number(c.stock_quantity || 0).toLocaleString()}`,
      `판매가 ${money(c.price)}`,
      c.cost_price !== null && c.cost_price !== undefined ? `매입가 ${money(c.cost_price)}` : '',
      c.product_type === 'OTC' ? '일반의약품' : '',
      c.tax_type === 'EXEMPT' ? '면세' : '',
      c._category_name ? `분류 ${c._category_name}` : '',
      '온라인 비공개'
    ].filter(Boolean);
    return `<div class="list-meta">${h(parts.join(' · '))}</div>`;
  }
  const changes = row.changes.filter((change) => !['online_visible', 'needs_review'].includes(change.field) || row.missing);
  if (!changes.length) return '<span class="list-meta">-</span>';
  return changes
    .map((change) => `<div class="imp-change"><span>${h(change.label)}</span> ${h(importValue(change.field, change.before))} <b>→</b> ${h(importValue(change.field, change.after))}</div>`)
    .join('');
}

function renderImportRowsTable(readOnly) {
  const data = imp.view.data;
  if (!data) return '';
  if (!data.rows.length) return renderEmpty('해당하는 행이 없습니다.');
  const totalPages = Math.max(1, Math.ceil(data.total / data.page_size));
  return `
    <div class="table-wrap"><table>
      <thead><tr><th class="row-no">줄</th><th>결과</th><th>상품</th><th>바뀌는 내용</th><th>확인할 점</th>${readOnly ? '' : '<th></th>'}</tr></thead>
      <tbody>${data.rows
        .map((row) => {
          const excluded = imp.options.excluded.includes(row.row_no);
          const lot = row.lot ? `<div class="list-meta">유통기한 ${h(row.lot.expiry_date)}${row.lot.lot_number ? ` · 로트 ${h(row.lot.lot_number)}` : ''}</div>` : '';
          const messages = row.messages.map((m) => `<div class="imp-msg ${m.level}">${h(m.text)}</div>`).join('');
          const link =
            !readOnly && row.action === 'CREATE' && row.name_matches.length
              ? `<select class="form-control imp-inline" onchange="linkImportRow(${row.row_no}, this.value)">
                  <option value="">새 상품으로 등록</option>
                  ${row.name_matches.map((m) => `<option value="${m.id}">기존 "${h(m.product_name)}"${m.barcode ? ` (${h(m.barcode)})` : ''}와 같은 상품</option>`).join('')}
                </select>`
              : '';
          const linked = !readOnly && imp.options.links[row.row_no] ? `<button class="muted-link" type="button" onclick="linkImportRow(${row.row_no}, '')">연결 풀기</button>` : '';
          const actions = readOnly || !row.row_no
            ? ''
            : `<td>${link}${linked}<button class="muted-link" type="button" onclick="toggleImportExclude(${row.row_no})">${excluded ? '다시 넣기' : '빼기'}</button></td>`;
          return `<tr>
            <td class="row-no">${row.row_no || '-'}</td>
            <td>${importBadge(row.action)}${row.missing ? '<div class="list-meta">파일에 없음</div>' : ''}</td>
            <td><div class="list-title">${h(row.product_name || '(이름 없음)')}</div>
              <div class="list-meta">${[row.barcode && `바코드 ${row.barcode}`, row.external_code && `코드 ${row.external_code}`].filter(Boolean).map(h).join(' · ') || '바코드·코드 없음'}</div></td>
            <td>${renderImportChanges(row)}${lot}</td>
            <td>${messages || '<span class="list-meta">-</span>'}</td>
            ${actions}
          </tr>`;
        })
        .join('')}</tbody>
    </table></div>
    ${pagerHtml(data.page, totalPages, 'goImportPage')}`;
}

function goImportPage(page) {
  setImportView({ page });
}

function renderImportPreview() {
  const data = imp.view.data;
  if (!data) return '';
  const batch = data.batch;
  const applyCount = batch.create_count + batch.update_count;
  const extra = [];
  if (imp.batch.new_categories?.length) extra.push(`새로 만들 분류: ${imp.batch.new_categories.join(', ')}`);
  if (imp.batch.new_suppliers?.length) extra.push(`등록되지 않은 거래처(연결하지 않음): ${imp.batch.new_suppliers.join(', ')}`);
  return `
    <div class="imp-step">
      <h3>4. 미리보기 <span class="list-meta">${h(IMPORT_MODES[batch.mode].label)} · ${h(batch.file_name || '')} · 60분 안에 적용해 주세요</span></h3>
      ${(imp.batch.batch_warnings || []).map((text) => `<div class="insight-box imp-warn">${h(text)}</div>`).join('')}
      ${extra.length ? `<p class="list-meta">${h(extra.join(' / '))}</p>` : ''}
      ${renderImportCounts(batch)}
      <div class="report-controls">
        <input class="form-control" type="search" placeholder="상품명 · 바코드 · 코드 (Enter)" value="${h(imp.view.q)}" onchange="setImportView({ q: this.value.trim(), page: 1 })" style="width: 260px;" />
        <span style="flex: 1;"></span>
        <button class="btn btn-outline btn-sm" type="button" onclick="downloadImportFile('/product-import/batches/${batch.id}/rows.csv?filter=ERROR')">오류 행 CSV</button>
        <button class="btn btn-outline btn-sm" type="button" onclick="downloadImportFile('/product-import/batches/${batch.id}/rows.csv?filter=WARNING')">확인할 점 CSV</button>
      </div>
      ${renderImportRowsTable(false)}
    </div>
    <div class="inline-actions imp-actions">
      <button class="btn btn-primary" type="button" ${applyCount ? '' : 'disabled'} onclick="applyImport()">신규 ${batch.create_count.toLocaleString()} · 수정 ${batch.update_count.toLocaleString()}건 적용하기</button>
      <button class="btn btn-outline" type="button" onclick="imp.batch = null; renderImport()">열 맞추기로 돌아가기</button>
      <span class="list-meta">오류·건너뜀 행은 적용하지 않습니다.</span>
    </div>`;
}

function linkImportRow(rowNo, productId) {
  if (productId) imp.options.links[rowNo] = Number(productId);
  else delete imp.options.links[rowNo];
  previewImport();
}

function toggleImportExclude(rowNo) {
  const set = new Set(imp.options.excluded);
  if (set.has(rowNo)) set.delete(rowNo);
  else set.add(rowNo);
  imp.options.excluded = [...set];
  previewImport();
}

async function applyImport() {
  const batch = imp.view.data.batch;
  const lines = [`${IMPORT_MODES[batch.mode].label}: 신규 ${batch.create_count}건, 수정 ${batch.update_count}건을 적용할까요?`];
  if (batch.mode === 'MIGRATE') lines.push('재고가 파일의 수량으로 바뀝니다.');
  lines.push('24시간 안에는 등록 이력에서 되돌릴 수 있습니다.');
  if (!confirm(lines.join('\n'))) return;
  imp.loading = '적용하는 중입니다.';
  renderImport();
  try {
    imp.result = await api.request(`/product-import/batches/${batch.id}/apply`, { method: 'POST' });
    imp.batch = null;
    imp.view = { batchId: imp.result.batch_id, filter: 'ALL', q: '', page: 1, data: null, readOnly: true };
    await loadImportRows();
    loadOwner();
  } catch (error) {
    if (error.status === 409) imp.batch = null;
    showToast(error.status === 409 ? `${error.message} 미리보기를 다시 만들어 주세요.` : error.message);
  }
  imp.loading = '';
  renderImport();
}

function renderImportResult() {
  const { summary, recalculated } = imp.result;
  return `
    <div class="insight-box imp-done">
      <h3>적용했습니다</h3>
      <p>신규 ${summary.create_count.toLocaleString()}개 · 수정 ${summary.update_count.toLocaleString()}개 · 변화 없음 ${summary.unchanged_count.toLocaleString()}개 · 건너뜀·오류 ${(summary.skip_count + summary.error_count).toLocaleString()}개</p>
      ${recalculated ? `<p class="list-meta">미리보기 뒤 재고가 바뀐 ${recalculated}개 상품은 적용 시점 기준으로 다시 계산했습니다.</p>` : ''}
      ${summary.create_count ? '<p class="list-meta">새 상품은 온라인에 공개하지 않은 상태입니다. 상품 정보를 확인한 뒤 공개해 주세요.</p>' : ''}
      <div class="inline-actions" style="margin-top: 10px;">
        ${summary.create_count ? `<button class="btn btn-primary btn-sm" type="button" onclick="showProductFilter('offline')">온라인 비공개 상품 보기</button>` : ''}
        <button class="btn btn-outline btn-sm" type="button" onclick="revertImport(${imp.result.batch_id})">되돌리기</button>
        <button class="btn btn-outline btn-sm" type="button" onclick="resetImport()">새 파일 올리기</button>
      </div>
    </div>
    ${renderImportCounts(imp.view.data.batch)}
    ${renderImportRowsTable(true)}`;
}

/* ---------- 이력·되돌리기 ---------- */

async function loadImportHistory(render = true) {
  try {
    imp.history = (await api.request('/product-import/batches')).batches;
  } catch (error) {
    showToast(error.message);
  }
  if (render) renderImport();
}

function renderImportHistory() {
  if (!imp.history.length) return renderEmpty('아직 적용한 일괄 등록이 없습니다.');
  const detail = imp.view.readOnly && imp.view.data && imp.tab === 'history';
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>적용 시각</th><th>방식</th><th>파일</th><th>결과</th><th>상태</th><th></th></tr></thead>
      <tbody>${imp.history
        .map(
          (b) => `<tr>
          <td>${h(formatDate(b.applied_at))}<div class="list-meta">${h(b.applied_by_name || '')}</div></td>
          <td>${h(IMPORT_MODES[b.mode]?.label || b.mode)}</td>
          <td>${h(b.file_name || '-')}<div class="list-meta">${h(b.source_type || '')}</div></td>
          <td class="list-meta">신규 ${b.create_count} · 수정 ${b.update_count} · 변화 없음 ${b.unchanged_count} · 건너뜀 ${b.skip_count + b.error_count}</td>
          <td>${b.status === 'REVERTED' ? `<span class="badge gray">되돌림</span><div class="list-meta">${h(formatDate(b.reverted_at))}</div>` : '<span class="badge green">적용됨</span>'}</td>
          <td><div class="inline-actions">
            <button class="muted-link" type="button" onclick="openImportBatch(${b.id})">자세히</button>
            ${b.can_revert ? `<button class="btn btn-outline btn-sm" type="button" onclick="revertImport(${b.id})">되돌리기</button>` : ''}
          </div></td>
        </tr>`
        )
        .join('')}</tbody>
    </table></div>
    <p class="list-meta" style="margin-top: 8px;">되돌리기는 적용 뒤 24시간 안, 가장 최근에 적용한 건부터 할 수 있습니다.</p>
    ${detail ? `<div class="imp-step"><h3>${h(imp.view.data.batch.file_name || '')} 자세히</h3>${renderImportCounts(imp.view.data.batch)}${renderImportRowsTable(true)}</div>` : ''}`;
}

async function openImportBatch(id) {
  imp.view = { batchId: id, filter: 'ALL', q: '', page: 1, data: null, readOnly: true };
  await setImportView({});
}

async function revertImport(id) {
  if (!confirm('이 일괄 등록을 되돌릴까요?\n새로 만든 상품은 지우고(이미 팔렸으면 숨김), 바뀐 값과 재고는 적용 전으로 돌립니다. 그 뒤에 팔린 수량은 그대로 둡니다.')) return;
  try {
    await api.request(`/product-import/batches/${id}/revert`, { method: 'POST' });
    showToast('되돌렸습니다.');
    imp.result = null;
    imp.tab = 'history';
    imp.view = { batchId: null, filter: 'ALL', q: '', page: 1, data: null, readOnly: false };
    await loadImportHistory();
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

/* ---------- 기존 POS 병행 ---------- */

function renderImportSync() {
  const s = imp.sync;
  if (!s) return '';
  const outflow = imp.outflow;
  const totalOut = outflow ? outflow.items.reduce((sum, item) => sum + Math.max(0, item.quantity_out), 0) : 0;
  return `
    <div class="insight-box">
      <strong>기존 POS를 계속 쓰면서 MAYDIN 온라인몰·POS를 함께 쓰는 방법</strong>
      <ol class="imp-guide">
        <li>기존 POS의 재고 파일을 정해진 주기마다 "파일로 등록 → 기존 POS와 병행"으로 올립니다. 파일을 내려받은 뒤 MAYDIN에서 판 수량은 자동으로 빼고 맞춥니다.</li>
        <li>MAYDIN에서 판 수량(온라인 주문·픽업·MAYDIN POS)은 아래에서 내려받아 기존 POS에도 입력하고 "입력했어요"를 누릅니다.</li>
        <li>입고·폐기·재고 실사는 기존 POS에서만 합니다. 병행 중에는 MAYDIN에서 막힙니다.</li>
      </ol>
    </div>
    <form class="form-grid" onsubmit="saveImportSync(event)">
      <div class="form-group full">
        <label class="check-chip"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''} /> 기존 POS와 병행 모드 사용</label>
      </div>
      <div class="form-group">
        <label class="form-label" for="syncBuffer">온라인 여유분 (개)</label>
        <input id="syncBuffer" class="form-control" name="online_stock_buffer" type="number" min="0" max="100" value="${s.online_stock_buffer}" />
        <span class="list-meta">재고가 이 수량 이하이면 온라인에서는 품절로 보입니다. 동기화 사이에 매장에서 팔린 것과 겹치지 않게 합니다.</span>
      </div>
      <div class="form-group">
        <label class="form-label" for="syncInterval">동기화 주기 (시간)</label>
        <input id="syncInterval" class="form-control" name="interval_hours" type="number" min="1" max="168" value="${s.interval_hours}" />
        <span class="list-meta">이 시간이 지나도록 파일을 올리지 않으면 알려 드립니다.</span>
      </div>
      <div class="form-group full inline-actions"><button class="btn btn-primary" type="submit">저장</button></div>
    </form>
    ${s.enabled ? `
    <div class="imp-step">
      <h3>현재 상태</h3>
      ${s.stale ? `<div class="insight-box imp-warn">${s.last_sync_at ? `마지막 동기화(${h(formatDate(s.last_sync_at))}) 뒤 ${s.interval_hours}시간이 지났습니다.` : '아직 동기화 파일을 올리지 않았습니다.'} 기존 POS 재고 파일을 올려 주세요.</div>` : ''}
      <p class="list-meta">마지막 동기화 ${h(s.last_sync_at ? formatDate(s.last_sync_at) : '없음')} · MAYDIN 판매를 기존 POS에 입력한 시각 ${h(s.reflected_until ? formatDate(s.reflected_until) : '-')}</p>
      <div class="inline-actions" style="margin-top: 10px;">
        <button class="btn btn-primary btn-sm" type="button" onclick="imp.tab='file'; resetImport(); setImportMode('SYNC')">동기화 파일 올리기</button>
        <button class="btn btn-outline btn-sm" type="button" onclick="loadImportOutflow()">MAYDIN에서 판 수량 보기</button>
      </div>
    </div>
    ${outflow ? `
    <div class="imp-step">
      <h3>MAYDIN에서 판 수량 <span class="list-meta">${h(formatDate(outflow.from))} ~ ${h(formatDate(outflow.until))} · ${outflow.items.length}개 상품 · ${totalOut.toLocaleString()}개</span></h3>
      ${outflow.items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>상품</th><th>바코드 · 코드</th><th>수량</th></tr></thead>
        <tbody>${outflow.items.slice(0, 100).map((item) => `<tr><td>${h(item.product_name)}</td><td class="list-meta">${h([item.barcode, item.external_code].filter(Boolean).join(' · ') || '-')}</td><td>${item.quantity_out < 0 ? `+${-item.quantity_out} (반품 등)` : item.quantity_out.toLocaleString()}</td></tr>`).join('')}</tbody>
      </table></div>${outflow.items.length > 100 ? '<p class="list-meta">앞 100개만 보입니다. 전체는 CSV로 내려받으세요.</p>' : ''}` : renderEmpty('이 기간에 MAYDIN에서 바뀐 재고가 없습니다.')}
      <div class="inline-actions" style="margin-top: 10px;">
        <button class="btn btn-outline btn-sm" type="button" onclick="downloadImportFile('/product-import/sync/outflow.csv?until_log_id=${Number(outflow.until_log_id)}')">CSV 내려받기</button>
        <button class="btn btn-primary btn-sm" type="button" onclick="markImportReflected()">기존 POS에 모두 입력했어요</button>
      </div>
    </div>` : ''}` : ''}`;
}

async function saveImportSync(event) {
  event.preventDefault();
  const form = event.target;
  const enabled = form.enabled.checked;
  if (enabled && !imp.sync.enabled && !confirm('병행 모드를 켜면 MAYDIN에서 입고·폐기·재고 실사·재고 직접 수정이 막히고, 기존 POS 파일로만 재고를 맞춥니다. 켤까요?')) return;
  if (!enabled && imp.sync.enabled && !confirm('병행 모드를 끄면 MAYDIN 재고만 기준이 됩니다. 기존 POS를 더 이상 쓰지 않을 때만 끄세요. 끌까요?')) return;
  try {
    imp.sync = await api.request('/product-import/sync', {
      method: 'PATCH',
      body: { enabled, online_stock_buffer: Number(form.online_stock_buffer.value), interval_hours: Number(form.interval_hours.value) }
    });
    imp.outflow = null;
    if (imp.sync.enabled && imp.mode === 'MIGRATE') setImportMode('SYNC');
    if (!imp.sync.enabled && imp.mode === 'SYNC') setImportMode('MIGRATE');
    window.posSyncEnabled = imp.sync.enabled;
    showToast('저장했습니다.');
    renderImport();
    renderProductPage();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadImportOutflow() {
  try {
    imp.outflow = await api.request('/product-import/sync/outflow');
    renderImport();
  } catch (error) {
    showToast(error.message);
  }
}

async function markImportReflected() {
  if (!imp.outflow) return;
  if (!confirm(`${formatDate(imp.outflow.until)}까지 MAYDIN에서 판 수량을 기존 POS에 모두 입력했나요?\n다음 동기화부터 이 수량은 빼지 않습니다.`)) return;
  try {
    imp.sync = await api.request('/product-import/sync/reflected', {
      method: 'POST',
      body: { until_log_id: imp.outflow.until_log_id, until: imp.outflow.until }
    });
    imp.outflow = null;
    showToast('입력한 시각을 기록했습니다.');
    renderImport();
  } catch (error) {
    showToast(error.message);
  }
}

async function downloadImportFile(path) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || '파일을 내려받지 못했습니다.');
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const filename = match ? decodeURIComponent(match[1]) : 'maydin.csv';
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showToast(error.message);
  }
}
