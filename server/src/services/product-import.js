const { getOne, getAll, run, transaction } = require('../db');
const { insertLot } = require('./lots');

class ImportError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MODES = ['MIGRATE', 'ADD', 'SYNC'];
const MAX_ROWS = 20000;
const MAX_STOCK = 1000000;
const PREVIEW_TTL_MINUTES = 60;
const REVERT_HOURS = 24;
const MISSING_ACTIONS = ['KEEP', 'ZERO', 'POS_OFF'];
const UPDATABLE_FIELDS = [
  'stock',
  'price',
  'discount_price',
  'cost_price',
  'product_name',
  'category',
  'brand',
  'product_type',
  'tax_type',
  'safety_stock',
  'supplier'
];
const DEFAULT_UPDATE_FIELDS = {
  MIGRATE: ['stock', 'price', 'cost_price'],
  ADD: ['stock', 'cost_price'],
  SYNC: ['stock']
};
const IMPORT_LOG_TYPES = ['IMPORT', 'IMPORT_REVERT'];

const FIELD_LABELS = {
  stock_quantity: '재고',
  product_name: '상품명',
  price: '판매가',
  discount_price: '할인가',
  cost_price: '매입가',
  category_id: '분류',
  brand: '브랜드',
  product_type: '구분',
  tax_type: '과세',
  safety_stock: '안전재고',
  supplier_id: '거래처',
  barcode: '바코드',
  external_code: '기존 POS 상품코드',
  pos_sale_enabled: 'POS 판매',
  online_visible: '온라인 공개',
  needs_review: '구분 확인 필요'
};

/* ---------- 값 정리 ---------- */

function text(value, max = 200) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// "15,000원", "₩ 15000", "1.2e3"은 숫자로 읽고, 빈칸은 null, 읽을 수 없으면 NaN.
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const raw = String(value ?? '').replace(/[,\s원₩]/g, '');
  if (!raw) return null;
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
}

function gs1CheckDigitOk(digits) {
  const body = digits.slice(0, -1).split('').reverse();
  const sum = body.reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

function normalizeBarcode(value) {
  let raw = String(value ?? '').replace(/\s/g, '');
  if (!raw) return { value: null };
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(raw)) {
    return { error: '엑셀이 바코드를 지수(예: 8.8E+12)로 바꿔 뒷자리가 사라졌습니다. 바코드 열을 텍스트로 저장해 다시 올려 주세요.' };
  }
  if (/^\d+\.0+$/.test(raw)) raw = raw.replace(/\.0+$/, '');
  if (raw.length > 40) return { error: '바코드가 너무 깁니다(40자 이내).' };
  if (/^\d+$/.test(raw)) {
    if ([8, 12, 13, 14].includes(raw.length) && !gs1CheckDigitOk(raw)) {
      return { value: raw, warning: '바코드 마지막 검증 숫자가 맞지 않습니다. 바코드를 확인해 주세요.' };
    }
    if (raw.length >= 9 && raw.length <= 11) {
      return { value: raw, warning: '바코드 자릿수가 일반적이지 않습니다. 앞자리 0이 빠졌는지 확인해 주세요.' };
    }
  }
  return { value: raw };
}

const KIND_RULES = [
  { pattern: /전문\s*의약품|전문약|^etc$/i, kind: 'ETC' },
  { pattern: /일반\s*의약품|일반약|^otc$/i, kind: 'OTC' },
  { pattern: /의약외품|건강\s*기능|건기식|화장품|잡화|기타|일반\s*상품|공산품|식품|의료\s*기기|위생|생활/i, kind: 'GENERAL' }
];

function normalizeKind(value) {
  const raw = text(value, 40);
  if (!raw) return null;
  return KIND_RULES.find((rule) => rule.pattern.test(raw))?.kind || 'UNKNOWN';
}

function normalizeTax(value) {
  const raw = text(value, 20);
  if (!raw) return null;
  if (/면세|비과세|영세|exempt|^n$/i.test(raw)) return 'EXEMPT';
  if (/과세|taxable|^y$/i.test(raw)) return 'TAXABLE';
  return 'UNKNOWN';
}

function normalizeDate(value) {
  const raw = text(value, 20);
  if (!raw) return { value: null };
  let match = raw.match(/^(\d{4})[-./\s]?(\d{1,2})[-./\s]?(\d{1,2})$/) || raw.match(/^(\d{2})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!match && /^\d{6}$/.test(raw)) match = [raw, raw.slice(0, 2), raw.slice(2, 4), raw.slice(4, 6)];
  if (!match) return { error: true };
  const year = match[1].length === 2 ? 2000 + Number(match[1]) : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { error: true };
  return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

function todayLocal() {
  return getOne("SELECT date('now', 'localtime') AS today").today;
}

function nowUtc() {
  return getOne("SELECT datetime('now') AS now").now;
}

function toUtcTimestamp(value) {
  if (!value) return null;
  const textValue = String(value).trim();
  // DB에 저장된 형식(YYYY-MM-DD HH:MM:SS)은 UTC다. 그냥 new Date에 넣으면 서버 지역 시각으로 읽힌다.
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(textValue) ? `${textValue.replace(' ', 'T')}Z` : textValue);
  if (Number.isNaN(date.getTime())) throw new ImportError('시각 형식이 올바르지 않습니다.');
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/* ---------- 약국 설정 ---------- */

function syncSettings(pharmacyId) {
  const row = getOne(
    `SELECT pos_sync_enabled, pos_sync_reflected_until, pos_sync_reflected_log_id, online_stock_buffer, pos_sync_interval_hours
     FROM pharmacies WHERE id = @id`,
    { id: pharmacyId }
  );
  return {
    enabled: Number(row?.pos_sync_enabled || 0) === 1,
    reflected_until: row?.pos_sync_reflected_until || null,
    reflected_log_id: Number(row?.pos_sync_reflected_log_id || 0),
    online_stock_buffer: Number(row?.online_stock_buffer ?? 1),
    interval_hours: Number(row?.pos_sync_interval_hours ?? 24)
  };
}

function onlineStockBuffer(pharmacyId) {
  const settings = syncSettings(pharmacyId);
  return settings.enabled ? settings.online_stock_buffer : 0;
}

function assertNotSyncing(pharmacyId, action = '입고·폐기·실사') {
  if (syncSettings(pharmacyId).enabled) {
    throw new ImportError(`기존 POS와 병행 중이라 ${action}는 기존 POS에서 처리해 주세요. 재고는 다음 동기화 때 맞춰집니다.`, 409);
  }
}

// 반영 기준(E) 이후 MAYDIN에서 일어난 재고 변화(판매 −, 반품·취소 +). 일괄 등록 자체는 뺀다.
// 기록 시각은 초 단위라 같은 초에 생긴 판매가 빠지거나 두 번 잡힐 수 있어, 경계는 재고 기록 번호로 정한다.
function netChangesSince(pharmacyId, sinceLogId, untilLogId = null) {
  const rows = getAll(
    `SELECT product_id, SUM(quantity_after - quantity_before) AS net
     FROM inventory_logs
     WHERE pharmacy_id = @pharmacy_id AND id > @since
       AND (@until IS NULL OR id <= @until)
       AND change_type NOT IN ('IMPORT', 'IMPORT_REVERT')
     GROUP BY product_id`,
    { pharmacy_id: pharmacyId, since: Number(sinceLogId) || 0, until: untilLogId }
  );
  return new Map(rows.map((row) => [row.product_id, Number(row.net)]));
}

function lastLogId() {
  return Number(getOne('SELECT COALESCE(MAX(id), 0) AS id FROM inventory_logs').id);
}

/* ---------- 행 평가 ---------- */

function loadContext(pharmacyId) {
  const products = getAll('SELECT * FROM products WHERE pharmacy_id = @pharmacy_id', { pharmacy_id: pharmacyId });
  const byId = new Map();
  const byBarcode = new Map();
  const byCode = new Map();
  const byName = new Map();
  for (const product of products) {
    byId.set(product.id, product);
    if (product.barcode) byBarcode.set(product.barcode, product);
    if (product.external_code) byCode.set(product.external_code, product);
    const key = product.product_name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(product);
  }
  const categories = new Map(
    getAll('SELECT id, category_name FROM categories WHERE pharmacy_id = @pharmacy_id', { pharmacy_id: pharmacyId }).map((c) => [c.category_name, c.id])
  );
  const suppliers = new Map(
    getAll("SELECT id, name FROM suppliers WHERE pharmacy_id = @pharmacy_id AND status = 'ACTIVE'", { pharmacy_id: pharmacyId }).map((s) => [s.name, s.id])
  );
  const lotCounts = new Map(
    getAll(
      'SELECT product_id, COUNT(*) AS n FROM product_lots WHERE pharmacy_id = @pharmacy_id AND remaining_quantity > 0 GROUP BY product_id',
      { pharmacy_id: pharmacyId }
    ).map((row) => [row.product_id, row.n])
  );
  return { pharmacyId, products, byId, byBarcode, byCode, byName, categories, suppliers, lotCounts, today: todayLocal() };
}

function normalizeOptions(raw = {}, mode) {
  const updateFields = Array.isArray(raw.update_fields)
    ? raw.update_fields.filter((field) => UPDATABLE_FIELDS.includes(field))
    : DEFAULT_UPDATE_FIELDS[mode] || DEFAULT_UPDATE_FIELDS.MIGRATE;
  const missing = MISSING_ACTIONS.includes(raw.missing) ? raw.missing : 'KEEP';
  const links = {};
  for (const [rowNo, productId] of Object.entries(raw.links || {})) {
    if (Number(productId) > 0) links[Number(rowNo)] = Number(productId);
  }
  return {
    update_fields: updateFields,
    missing: mode === 'ADD' ? 'KEEP' : missing,
    cost_includes_vat: raw.cost_includes_vat === true,
    links,
    excluded: [...new Set((raw.excluded || []).map(Number).filter((n) => n > 0))]
  };
}

function readRow(input, mode) {
  const errors = [];
  const warnings = [];
  const barcode = normalizeBarcode(input.barcode);
  if (barcode.error) errors.push(barcode.error);
  if (barcode.warning) warnings.push(barcode.warning);

  const externalCode = text(input.external_code, 41);
  if (externalCode.length > 40) errors.push('기존 POS 상품코드는 40자 이내여야 합니다.');

  const name = text(input.product_name, 101);
  if (name.length > 100) errors.push('상품명은 100자 이내여야 합니다.');

  const price = parseNumber(input.price);
  if (Number.isNaN(price)) errors.push('판매가가 숫자가 아닙니다.');
  else if (price !== null && (price <= 0 || !Number.isInteger(price))) errors.push('판매가는 0보다 큰 정수여야 합니다.');

  let discount = parseNumber(input.discount_price);
  if (Number.isNaN(discount) || (discount !== null && discount <= 0)) discount = null;

  const cost = parseNumber(input.cost_price);
  if (Number.isNaN(cost)) errors.push('매입가가 숫자가 아닙니다.');
  else if (cost !== null && cost < 0) errors.push('매입가는 0 이상이어야 합니다.');

  let stock = parseNumber(input.stock);
  if (Number.isNaN(stock)) errors.push('재고 수량이 숫자가 아닙니다.');
  else if (stock !== null && !Number.isInteger(stock)) errors.push('재고 수량은 정수여야 합니다.');
  else if (stock !== null && Math.abs(stock) > MAX_STOCK) errors.push('재고 수량이 너무 큽니다.');
  else if (stock !== null && stock < 0) {
    if (mode === 'ADD') errors.push('더하기 수량은 0 이상이어야 합니다.');
    else {
      warnings.push(`기존 POS 재고가 ${stock}개(마이너스)라 0개로 넣습니다.`);
      stock = 0;
    }
  }

  const safety = parseNumber(input.safety_stock);
  const kind = normalizeKind(input.product_kind);
  const tax = normalizeTax(input.tax);
  if (tax === 'UNKNOWN') warnings.push(`과세 구분 "${text(input.tax, 20)}"을 알 수 없어 과세로 봅니다.`);

  const expiry = normalizeDate(input.expiry_date);
  let lot = null;
  if (expiry.error) warnings.push('유통기한 형식을 읽을 수 없어 로트 없이 넣습니다.');
  else if (expiry.value) lot = { expiry_date: expiry.value, lot_number: text(input.lot_number, 40) || null };

  return {
    errors,
    warnings,
    values: {
      barcode: barcode.value || null,
      external_code: externalCode || null,
      product_name: name || null,
      price: Number.isFinite(price) ? price : null,
      discount_price: discount,
      cost_price: Number.isFinite(cost) ? Math.round(cost) : null,
      stock: Number.isFinite(stock) ? stock : null,
      safety_stock: Number.isInteger(safety) && safety >= 0 ? safety : null,
      category: text(input.category, 40) || null,
      brand: text(input.brand, 40) || null,
      supplier: text(input.supplier, 60) || null,
      kind,
      tax: tax === 'UNKNOWN' ? 'TAXABLE' : tax,
      lot
    }
  };
}

function costWithoutVat(cost, taxType, includesVat) {
  if (cost === null) return null;
  return includesVat && taxType !== 'EXEMPT' ? Math.round(cost / 1.1) : cost;
}

function nextStock(mode, current, fileStock, net) {
  if (mode === 'ADD') return current + fileStock;
  if (mode === 'SYNC') return fileStock + net;
  return fileStock;
}

function stockStatus(status, stock) {
  if (stock > 0 && status === 'SOLD_OUT') return 'ON_SALE';
  if (stock <= 0 && status === 'ON_SALE') return 'SOLD_OUT';
  return status;
}

function bigSyncDifference(before, after) {
  const diff = Math.abs(after - before);
  return diff >= 10 || (diff >= 3 && diff / Math.max(before, 1) >= 0.3);
}

// 미리보기와 적용이 같은 계산을 쓴다. 적용 때는 그 시점 재고로 다시 계산한다.
function evaluate(pharmacyId, mode, rows, options) {
  const ctx = loadContext(pharmacyId);
  const net = mode === 'SYNC' ? netChangesSince(pharmacyId, syncSettings(pharmacyId).reflected_log_id) : new Map();
  const excluded = new Set(options.excluded);

  const parsed = rows.map((input) => ({ input, ...readRow(input, mode) }));
  const keyCount = (key) => {
    const counts = new Map();
    for (const row of parsed) {
      const value = row.values[key];
      if (value && !excluded.has(row.input.row_no)) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
  };
  const barcodeCount = keyCount('barcode');
  const codeCount = keyCount('external_code');

  const matchedIds = new Set();
  const newCategories = new Set();
  const newSuppliers = new Set();
  const results = [];

  for (const { input, errors, warnings, values } of parsed) {
    const rowNo = input.row_no;
    const result = { row_no: rowNo, input, product_id: null, action: 'ERROR', before: null, after: null, stock_before: null, stock_after: null, lot: null, errors, warnings, name_matches: [] };
    results.push(result);

    if (excluded.has(rowNo)) {
      result.action = 'SKIP';
      result.warnings = ['미리보기에서 제외한 행입니다.'];
      result.errors = [];
      continue;
    }
    if (values.barcode && barcodeCount.get(values.barcode) > 1) errors.push(`같은 바코드(${values.barcode})가 파일에 여러 번 나옵니다.`);
    if (values.external_code && codeCount.get(values.external_code) > 1) errors.push(`같은 상품코드(${values.external_code})가 파일에 여러 번 나옵니다.`);

    let product = null;
    const linkedId = options.links[rowNo];
    if (linkedId) {
      product = ctx.byId.get(linkedId) || null;
      if (!product) errors.push('연결하려는 상품을 찾을 수 없습니다.');
    } else {
      const byBarcode = values.barcode ? ctx.byBarcode.get(values.barcode) : null;
      const byCode = values.external_code ? ctx.byCode.get(values.external_code) : null;
      if (byBarcode && byCode && byBarcode.id !== byCode.id) {
        errors.push(`바코드로는 "${byBarcode.product_name}", 상품코드로는 "${byCode.product_name}"이 찾아져 어느 상품인지 알 수 없습니다.`);
      }
      product = byBarcode || byCode || null;
    }
    if (product) {
      matchedIds.add(product.id);
      result.product_id = product.id;
    }

    if (values.kind === 'ETC') {
      result.action = 'SKIP';
      result.errors = [];
      result.warnings = ['전문의약품은 가져오지 않습니다.'];
      continue;
    }
    if (errors.length) continue;

    if (product) evaluateUpdate(ctx, mode, options, values, product, result, net, newCategories, newSuppliers);
    else evaluateCreate(ctx, mode, options, values, result, net, newCategories, newSuppliers);
  }

  if (options.missing !== 'KEEP' && mode !== 'ADD') {
    for (const product of ctx.products) {
      if (product.status === 'HIDDEN' || matchedIds.has(product.id)) continue;
      const before = {};
      const after = {};
      if (options.missing === 'ZERO' && product.stock_quantity > 0) {
        before.stock_quantity = product.stock_quantity;
        after.stock_quantity = 0;
      }
      if (options.missing === 'POS_OFF' && Number(product.pos_sale_enabled) === 1) {
        before.pos_sale_enabled = 1;
        after.pos_sale_enabled = 0;
      }
      if (!Object.keys(after).length) continue;
      results.push({
        row_no: 0,
        input: { missing: true, product_name: product.product_name, barcode: product.barcode },
        product_id: product.id,
        action: 'UPDATE',
        before,
        after,
        stock_before: product.stock_quantity,
        stock_after: after.stock_quantity ?? product.stock_quantity,
        lot: null,
        errors: [],
        warnings: [options.missing === 'ZERO' ? '파일에 없는 상품이라 재고를 0으로 맞춥니다.' : '파일에 없는 상품이라 POS 판매를 멈춥니다.'],
        name_matches: []
      });
    }
  }

  return { results, newCategories: [...newCategories], newSuppliers: [...newSuppliers] };
}

function evaluateUpdate(ctx, mode, options, values, product, result, net, newCategories, newSuppliers) {
  const fields = new Set(options.update_fields);
  const before = {};
  const after = {};
  const set = (column, value) => {
    if (value === undefined || value === null) return;
    if (product[column] === value || (product[column] == null && value === '')) return;
    before[column] = product[column] ?? null;
    after[column] = value;
  };

  const taxType = fields.has('tax_type') && values.tax ? values.tax : product.tax_type;
  if (fields.has('product_name') && values.product_name) set('product_name', values.product_name);
  if (fields.has('price') && values.price !== null) set('price', values.price);
  if (fields.has('discount_price')) {
    const price = after.price ?? product.price;
    if (values.discount_price !== null && values.discount_price >= price) {
      result.warnings.push('할인가가 판매가보다 크거나 같아 할인가를 비웁니다.');
      if (product.discount_price !== null) {
        before.discount_price = product.discount_price;
        after.discount_price = null;
      }
    } else if (values.discount_price !== null) set('discount_price', values.discount_price);
  }
  if (fields.has('cost_price')) set('cost_price', costWithoutVat(values.cost_price, taxType, options.cost_includes_vat));
  if (fields.has('brand')) set('brand', values.brand);
  if (fields.has('safety_stock')) set('safety_stock', values.safety_stock);
  if (fields.has('tax_type')) set('tax_type', values.tax);
  if (fields.has('category') && values.category) {
    const categoryId = ctx.categories.get(values.category);
    if (categoryId) set('category_id', categoryId);
    else {
      newCategories.add(values.category);
      before.category_id = product.category_id ?? null;
      after.category_id = null;
      after._category_name = values.category;
    }
  }
  if (fields.has('supplier') && values.supplier) {
    const supplierId = ctx.suppliers.get(values.supplier);
    if (supplierId) set('supplier_id', supplierId);
    else {
      newSuppliers.add(values.supplier);
      before.supplier_id = product.supplier_id ?? null;
      after.supplier_id = null;
      after._supplier_name = values.supplier;
    }
  }
  if (fields.has('product_type') && values.kind) {
    if (values.kind === 'UNKNOWN') result.warnings.push('구분 값을 알 수 없어 기존 구분을 그대로 둡니다.');
    else if (values.kind !== product.product_type) {
      set('product_type', values.kind);
      if (values.kind === 'OTC') result.warnings.push('일반의약품으로 바뀝니다. 온라인 몰과 장바구니에서 빠집니다.');
      else {
        result.warnings.push('일반의약품에서 일반 상품으로 바뀝니다. 온라인에는 약국이 확인한 뒤 공개됩니다.');
        set('online_visible', 0);
        set('needs_review', 1);
      }
    }
  }
  if (values.external_code && !product.external_code && !ctx.byCode.has(values.external_code)) set('external_code', values.external_code);
  if (values.barcode && !product.barcode && !ctx.byBarcode.has(values.barcode)) set('barcode', values.barcode);

  result.stock_before = product.stock_quantity;
  result.stock_after = product.stock_quantity;
  if (fields.has('stock') && values.stock !== null) {
    let stock = nextStock(mode, product.stock_quantity, values.stock, net.get(product.id) || 0);
    if (mode === 'SYNC' && net.get(product.id)) {
      result.warnings.push(`기존 POS에 아직 입력되지 않은 MAYDIN 판매 ${-net.get(product.id)}개를 반영했습니다.`);
    }
    if (stock < 0) {
      result.warnings.push('계산된 재고가 마이너스라 0개로 맞춥니다.');
      stock = 0;
    }
    if (stock !== product.stock_quantity) {
      before.stock_quantity = product.stock_quantity;
      after.stock_quantity = stock;
      result.stock_after = stock;
      if (mode === 'SYNC' && bigSyncDifference(product.stock_quantity, stock)) {
        result.warnings.push(`재고 차이가 큽니다 (${product.stock_quantity} → ${stock}).`);
      }
    }
  }

  if (values.lot && mode !== 'SYNC') {
    if (values.lot.expiry_date < ctx.today) result.warnings.push('유통기한이 지나 로트 없이 넣습니다.');
    else if (mode === 'ADD' && values.stock > 0) result.lot = { ...values.lot, quantity: values.stock };
    else if (mode === 'MIGRATE' && !ctx.lotCounts.get(product.id) && result.stock_after > 0) {
      result.lot = { ...values.lot, quantity: result.stock_after };
    }
  }

  if (product.status === 'HIDDEN') result.warnings.push('숨김(판매 중지) 상품입니다. 값만 바뀌고 계속 숨김 상태입니다.');
  result.before = before;
  result.after = after;
  result.action = Object.keys(after).length || result.lot ? 'UPDATE' : 'UNCHANGED';
}

function evaluateCreate(ctx, mode, options, values, result, net, newCategories, newSuppliers) {
  if (!values.product_name) result.errors.push('새 상품이라 상품명이 필요합니다.');
  if (values.price === null) result.errors.push('새 상품이라 판매가가 필요합니다.');
  if (result.errors.length) return;

  const kindKnown = values.kind === 'OTC' || values.kind === 'GENERAL';
  if (!kindKnown && values.kind) result.warnings.push('구분(일반의약품 여부)을 알 수 없어 "구분 확인 필요"로 표시합니다.');
  const sameName = ctx.byName.get(values.product_name.toLowerCase()) || [];
  if (sameName.length) {
    result.name_matches = sameName.slice(0, 5).map((p) => ({ id: p.id, product_name: p.product_name, barcode: p.barcode }));
    result.warnings.push('이름이 같은 상품이 이미 있습니다. 같은 상품이면 연결해 주세요.');
  }
  if (!values.barcode && !values.external_code) result.warnings.push('바코드·상품코드가 없어 다음에 올리면 또 새 상품으로 들어갑니다.');

  let stock = values.stock ?? 0;
  if (mode === 'SYNC' && stock < 0) stock = 0;
  if (values.category && !ctx.categories.has(values.category)) newCategories.add(values.category);
  if (values.supplier && !ctx.suppliers.has(values.supplier)) newSuppliers.add(values.supplier);
  const taxType = values.tax || 'TAXABLE';
  let discount = values.discount_price;
  if (discount !== null && discount >= values.price) {
    result.warnings.push('할인가가 판매가보다 크거나 같아 할인가를 비웁니다.');
    discount = null;
  }

  result.after = {
    product_name: values.product_name,
    barcode: values.barcode,
    external_code: values.external_code,
    price: values.price,
    discount_price: discount,
    cost_price: costWithoutVat(values.cost_price, taxType, options.cost_includes_vat),
    stock_quantity: stock,
    safety_stock: values.safety_stock ?? 0,
    brand: values.brand,
    product_type: kindKnown ? values.kind : 'GENERAL',
    tax_type: taxType,
    needs_review: kindKnown ? 0 : 1,
    online_visible: 0,
    _category_name: values.category,
    _supplier_name: values.supplier
  };
  result.stock_before = 0;
  result.stock_after = stock;
  if (values.lot) {
    if (values.lot.expiry_date < ctx.today) result.warnings.push('유통기한이 지나 로트 없이 넣습니다.');
    else if (stock > 0) result.lot = { ...values.lot, quantity: stock };
  }
  result.action = 'CREATE';
}

function summarize(results) {
  const count = (action) => results.filter((r) => r.action === action).length;
  return {
    total_rows: results.filter((r) => r.row_no > 0).length,
    create_count: count('CREATE'),
    update_count: count('UPDATE'),
    unchanged_count: count('UNCHANGED'),
    skip_count: count('SKIP'),
    error_count: count('ERROR'),
    warning_count: results.filter((r) => r.warnings.length && r.action !== 'SKIP').length
  };
}

/* ---------- 미리보기 · 적용 ---------- */

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    return fallback;
  }
}

function sanitizeInputRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new ImportError('가져올 행이 없습니다.');
  if (rows.length > MAX_ROWS) throw new ImportError(`한 번에 ${MAX_ROWS.toLocaleString()}행까지 올릴 수 있습니다.`);
  const keys = ['product_name', 'barcode', 'external_code', 'price', 'discount_price', 'cost_price', 'stock', 'category', 'product_kind', 'tax', 'brand', 'supplier', 'expiry_date', 'lot_number', 'safety_stock'];
  return rows.map((row, index) => {
    const clean = { row_no: Number(row?.row_no) > 0 ? Math.floor(Number(row.row_no)) : index + 1 };
    for (const key of keys) {
      const value = row?.[key];
      if (value === undefined || value === null || value === '') continue;
      clean[key] = typeof value === 'number' ? value : String(value).slice(0, 200);
    }
    return clean;
  });
}

function insertRows(batchId, results) {
  for (const r of results) {
    run(
      `INSERT INTO import_batch_rows (
        batch_id, row_no, input, product_id, action, before_values, after_values, stock_before, stock_after, messages, created_lot_id
      ) VALUES (
        @batch_id, @row_no, @input, @product_id, @action, @before_values, @after_values, @stock_before, @stock_after, @messages, @created_lot_id
      )`,
      {
        batch_id: batchId,
        row_no: r.row_no,
        input: JSON.stringify(r.input),
        product_id: r.product_id,
        action: r.action,
        before_values: r.before ? JSON.stringify(r.before) : null,
        after_values: r.after ? JSON.stringify({ ...r.after, ...(r.lot ? { _lot: r.lot } : {}), ...(r.name_matches.length ? { _name_matches: r.name_matches } : {}) }) : null,
        stock_before: r.stock_before,
        stock_after: r.stock_after,
        messages: JSON.stringify([...r.errors.map((text) => ({ level: 'error', text })), ...r.warnings.map((text) => ({ level: 'warning', text }))]),
        created_lot_id: r.created_lot_id || null
      }
    );
  }
}

function preview({ pharmacyId, userId, mode, rows, options: rawOptions = {}, fileName, sourceType, snapshotAt }) {
  if (!MODES.includes(mode)) throw new ImportError('가져오기 방식(이전·더하기·동기화)을 골라 주세요.');
  const settings = syncSettings(pharmacyId);
  if (mode === 'SYNC' && !settings.enabled) throw new ImportError('기존 POS 병행 모드를 먼저 켜 주세요.', 409);
  if (settings.enabled && mode === 'MIGRATE') {
    throw new ImportError('기존 POS와 병행 중에는 "동기화"로 올려 주세요. 덮어쓰기는 MAYDIN 판매분을 되살립니다.', 409);
  }
  if (mode === 'ADD' && settings.enabled) throw new ImportError('기존 POS와 병행 중에는 입고를 기존 POS에서 처리해 주세요.', 409);

  const inputRows = sanitizeInputRows(rows);
  const options = normalizeOptions(rawOptions, mode);
  const snapshot = mode === 'SYNC' ? toUtcTimestamp(snapshotAt) || nowUtc() : null;
  const batchWarnings = [];
  if (snapshot) {
    if (snapshot > getOne("SELECT datetime('now', '+5 minutes') AS t").t) throw new ImportError('재고 기준 시각이 미래입니다.');
    if (settings.reflected_until && snapshot < settings.reflected_until) {
      batchWarnings.push('파일의 재고 기준 시각이 "기존 POS에 입력함"으로 표시한 시각보다 이릅니다. 최근 MAYDIN 판매가 빠질 수 있습니다.');
    }
  }

  const { results, newCategories, newSuppliers } = evaluate(pharmacyId, mode, inputRows, options);
  const unknownKind = results.filter((r) => r.action === 'CREATE' && r.after?.needs_review && !text(r.input.product_kind, 40)).length;
  if (unknownKind) {
    batchWarnings.push(`구분(일반의약품 여부)이 비어 있는 새 상품 ${unknownKind.toLocaleString()}개는 "구분 확인 필요"로 표시합니다. 상품 관리에서 확인한 뒤 온라인에 공개하세요.`);
  }
  const summary = summarize(results);

  const batchId = transaction(() => {
    run(
      `UPDATE import_batches SET status = 'EXPIRED'
       WHERE pharmacy_id = @pharmacy_id AND status = 'PREVIEW'`,
      { pharmacy_id: pharmacyId }
    );
    const id = run(
      `INSERT INTO import_batches (
        pharmacy_id, mode, file_name, source_type, options, snapshot_at, reflected_until, reflected_log_id,
        total_rows, create_count, update_count, unchanged_count, skip_count, error_count, warning_count, created_by
      ) VALUES (
        @pharmacy_id, @mode, @file_name, @source_type, @options, @snapshot_at, @reflected_until, @reflected_log_id,
        @total_rows, @create_count, @update_count, @unchanged_count, @skip_count, @error_count, @warning_count, @created_by
      )`,
      {
        pharmacy_id: pharmacyId,
        mode,
        file_name: text(fileName, 120) || null,
        source_type: text(sourceType, 10) || null,
        options: JSON.stringify(options),
        snapshot_at: snapshot,
        reflected_until: mode === 'SYNC' ? settings.reflected_until : null,
        reflected_log_id: mode === 'SYNC' ? settings.reflected_log_id : null,
        created_by: userId,
        ...summary
      }
    ).lastInsertRowid;
    insertRows(id, results);
    return id;
  })();

  return { batch_id: batchId, summary, new_categories: newCategories, new_suppliers: newSuppliers, batch_warnings: batchWarnings };
}

function findBatch(pharmacyId, batchId) {
  const batch = getOne('SELECT * FROM import_batches WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(batchId), pharmacy_id: pharmacyId });
  if (!batch) throw new ImportError('일괄 등록 기록을 찾을 수 없습니다.', 404);
  return batch;
}

function logStock(pharmacyId, productId, before, after, changeType, reason, userId, batchId) {
  run(
    `INSERT INTO inventory_logs (
      pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type, reference_id
    ) VALUES (@pharmacy_id, @product_id, @change_type, @before, @after, @reason, @user_id, 'IMPORT_BATCH', @batch_id)`,
    { pharmacy_id: pharmacyId, product_id: productId, change_type: changeType, before, after, reason, user_id: userId, batch_id: batchId }
  );
}

function ensureCategory(pharmacyId, name, cache) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  const id = run('INSERT INTO categories (pharmacy_id, category_name) VALUES (@pharmacy_id, @name)', { pharmacy_id: pharmacyId, name }).lastInsertRowid;
  cache.set(name, id);
  return id;
}

function ensureSupplier(pharmacyId, name, cache) {
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  const id = run('INSERT INTO suppliers (pharmacy_id, name) VALUES (@pharmacy_id, @name)', { pharmacy_id: pharmacyId, name }).lastInsertRowid;
  cache.set(name, id);
  return id;
}

const UPDATE_COLUMNS = [
  'product_name',
  'price',
  'discount_price',
  'cost_price',
  'category_id',
  'brand',
  'product_type',
  'tax_type',
  'safety_stock',
  'supplier_id',
  'barcode',
  'external_code',
  'pos_sale_enabled',
  'online_visible',
  'needs_review'
];

function applyResult(pharmacyId, userId, batchId, mode, r, categoryCache, supplierCache, reason) {
  if (r.action === 'CREATE') {
    const a = r.after;
    const productId = run(
      `INSERT INTO products (
        pharmacy_id, category_id, product_name, price, discount_price, cost_price, stock_quantity, status,
        barcode, external_code, product_type, tax_type, safety_stock, brand, supplier_id, online_visible, needs_review
      ) VALUES (
        @pharmacy_id, @category_id, @product_name, @price, @discount_price, @cost_price, @stock_quantity, @status,
        @barcode, @external_code, @product_type, @tax_type, @safety_stock, @brand, @supplier_id, 0, @needs_review
      )`,
      {
        pharmacy_id: pharmacyId,
        category_id: ensureCategory(pharmacyId, a._category_name, categoryCache),
        supplier_id: ensureSupplier(pharmacyId, a._supplier_name, supplierCache),
        product_name: a.product_name,
        price: a.price,
        discount_price: a.discount_price,
        cost_price: a.cost_price,
        stock_quantity: a.stock_quantity,
        status: a.stock_quantity > 0 ? 'ON_SALE' : 'SOLD_OUT',
        barcode: a.barcode,
        external_code: a.external_code,
        product_type: a.product_type,
        tax_type: a.tax_type,
        safety_stock: a.safety_stock,
        brand: a.brand,
        needs_review: a.needs_review
      }
    ).lastInsertRowid;
    r.product_id = productId;
    if (a.stock_quantity > 0) logStock(pharmacyId, productId, 0, a.stock_quantity, 'IMPORT', reason, userId, batchId);
    if (r.lot) {
      r.created_lot_id = insertLot({ pharmacyId, productId, quantity: r.lot.quantity, lot: r.lot, unitCost: a.cost_price, userId });
    }
    return;
  }

  if (r.action !== 'UPDATE') return;
  const after = { ...r.after };
  if (after._category_name) after.category_id = ensureCategory(pharmacyId, after._category_name, categoryCache);
  if (after._supplier_name) after.supplier_id = ensureSupplier(pharmacyId, after._supplier_name, supplierCache);
  r.after = after;

  const columns = UPDATE_COLUMNS.filter((column) => column in after);
  if (columns.length) {
    run(
      `UPDATE products SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = @id AND pharmacy_id = @pharmacy_id`,
      { id: r.product_id, pharmacy_id: pharmacyId, ...Object.fromEntries(columns.map((c) => [c, after[c]])) }
    );
    if (after.product_type === 'OTC') run('DELETE FROM carts WHERE product_id = @id', { id: r.product_id });
  }
  if ('stock_quantity' in after) {
    const current = getOne('SELECT status FROM products WHERE id = @id', { id: r.product_id });
    run(
      `UPDATE products SET stock_quantity = @stock, status = @status, updated_at = CURRENT_TIMESTAMP
       WHERE id = @id AND stock_quantity = @before`,
      { id: r.product_id, stock: after.stock_quantity, before: r.stock_before, status: stockStatus(current.status, after.stock_quantity) }
    );
    logStock(pharmacyId, r.product_id, r.stock_before, after.stock_quantity, 'IMPORT', reason, userId, batchId);
  }
  if (r.lot) {
    const product = getOne('SELECT cost_price FROM products WHERE id = @id', { id: r.product_id });
    r.created_lot_id = insertLot({ pharmacyId, productId: r.product_id, quantity: r.lot.quantity, lot: r.lot, unitCost: product.cost_price, userId });
  }
}

const MODE_LABELS = { MIGRATE: '이전(덮어쓰기)', ADD: '입고(더하기)', SYNC: '기존 POS 동기화' };

function apply({ pharmacyId, userId, batchId }) {
  return transaction(() => {
    const batch = findBatch(pharmacyId, batchId);
    if (batch.status !== 'PREVIEW') throw new ImportError('이미 적용했거나 만료된 미리보기입니다. 파일을 다시 올려 주세요.', 409);
    const fresh = getOne(`SELECT created_at > datetime('now', '-${PREVIEW_TTL_MINUTES} minutes') AS ok FROM import_batches WHERE id = @id`, { id: batch.id });
    if (!fresh.ok) {
      run("UPDATE import_batches SET status = 'EXPIRED' WHERE id = @id", { id: batch.id });
      throw new ImportError('미리보기를 만든 지 1시간이 지났습니다. 파일을 다시 올려 주세요.', 409);
    }
    const settings = syncSettings(pharmacyId);
    if (batch.mode === 'SYNC' && !settings.enabled) throw new ImportError('기존 POS 병행 모드가 꺼져 있습니다.', 409);
    if (batch.mode === 'SYNC' && settings.reflected_log_id !== Number(batch.reflected_log_id || 0)) {
      throw new ImportError('미리보기 이후 "기존 POS에 입력함" 시각이 바뀌었습니다. 다시 미리보기 해 주세요.', 409);
    }

    const previewRows = getAll('SELECT row_no, product_id, stock_after FROM import_batch_rows WHERE batch_id = @id', { id: batch.id });
    const previewStock = new Map(previewRows.map((r) => [`${r.row_no}:${r.product_id}`, r.stock_after]));
    const inputs = getAll('SELECT input FROM import_batch_rows WHERE batch_id = @id AND row_no > 0 ORDER BY row_no', { id: batch.id }).map((r) => JSON.parse(r.input));
    const options = parseJson(batch.options, {});
    const { results } = evaluate(pharmacyId, batch.mode, inputs, options);

    const recalculated = results.filter(
      (r) => r.product_id && previewStock.has(`${r.row_no}:${r.product_id}`) && previewStock.get(`${r.row_no}:${r.product_id}`) !== r.stock_after
    ).length;

    const categoryCache = new Map();
    const supplierCache = new Map();
    const reason = `일괄 등록 #${batch.id} · ${MODE_LABELS[batch.mode]}${batch.file_name ? ` · ${batch.file_name}` : ''}`;
    for (const r of results) applyResult(pharmacyId, userId, batch.id, batch.mode, r, categoryCache, supplierCache, reason);

    run('DELETE FROM import_batch_rows WHERE batch_id = @id', { id: batch.id });
    insertRows(batch.id, results);
    const summary = summarize(results);
    run(
      `UPDATE import_batches
       SET status = 'APPLIED', applied_by = @user_id, applied_at = CURRENT_TIMESTAMP,
           total_rows = @total_rows, create_count = @create_count, update_count = @update_count,
           unchanged_count = @unchanged_count, skip_count = @skip_count, error_count = @error_count, warning_count = @warning_count
       WHERE id = @id`,
      { id: batch.id, user_id: userId, ...summary }
    );
    audit(pharmacyId, userId, 'PRODUCT_IMPORT', batch.id, `${reason} · 신규 ${summary.create_count} · 수정 ${summary.update_count} · 제외 ${summary.skip_count + summary.error_count}`);
    return { batch_id: batch.id, summary, recalculated };
  })();
}

function audit(pharmacyId, userId, action, batchId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, 'IMPORT_BATCH', @target_id, @description)`,
    { user_id: userId, pharmacy_id: pharmacyId, action, target_id: batchId, description }
  );
}

/* ---------- 되돌리기 ---------- */

function revert({ pharmacyId, userId, batchId }) {
  return transaction(() => {
    const batch = findBatch(pharmacyId, batchId);
    if (batch.status !== 'APPLIED') throw new ImportError('적용된 일괄 등록만 되돌릴 수 있습니다.', 409);
    const recent = getOne(`SELECT applied_at > datetime('now', '-${REVERT_HOURS} hours') AS ok FROM import_batches WHERE id = @id`, { id: batch.id });
    if (!recent.ok) throw new ImportError(`적용 후 ${REVERT_HOURS}시간이 지나 되돌릴 수 없습니다.`, 409);
    const later = getOne(
      "SELECT id FROM import_batches WHERE pharmacy_id = @pharmacy_id AND status = 'APPLIED' AND id > @id LIMIT 1",
      { pharmacy_id: pharmacyId, id: batch.id }
    );
    if (later) throw new ImportError(`나중에 적용한 일괄 등록(#${later.id})부터 되돌려 주세요.`, 409);

    const rows = getAll(
      "SELECT * FROM import_batch_rows WHERE batch_id = @id AND action IN ('CREATE', 'UPDATE') AND product_id IS NOT NULL",
      { id: batch.id }
    );
    const blocked = [];
    const plans = rows.map((row) => {
      const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: row.product_id, pharmacy_id: pharmacyId });
      const before = parseJson(row.before_values, {});
      const after = parseJson(row.after_values, {});
      const delta = row.action === 'CREATE' ? 0 : 'stock_quantity' in after ? row.stock_after - row.stock_before : 0;
      const stock = product ? product.stock_quantity - delta : null;
      if (product && stock < 0) blocked.push(`${product.product_name} (현재 ${product.stock_quantity}개)`);
      return { row, product, before, delta, stock };
    });
    if (blocked.length) {
      throw new ImportError(`되돌리면 재고가 마이너스가 되는 상품이 있어 되돌릴 수 없습니다: ${blocked.slice(0, 5).join(', ')}${blocked.length > 5 ? ` 외 ${blocked.length - 5}개` : ''}`, 409);
    }

    const reason = `일괄 등록 #${batch.id} 되돌리기`;
    let removed = 0;
    let hidden = 0;
    let restored = 0;
    for (const { row, product, before, delta, stock } of plans) {
      if (!product) continue;
      if (row.created_lot_id) {
        run('DELETE FROM product_lots WHERE id = @id AND remaining_quantity = received_quantity', { id: row.created_lot_id });
      }
      if (row.action === 'CREATE') {
        const used = getOne(
          `SELECT
             EXISTS (SELECT 1 FROM order_items WHERE product_id = @id)
             OR EXISTS (SELECT 1 FROM inventory_logs WHERE product_id = @id AND NOT (change_type = 'IMPORT' AND reference_id = @batch_id))
             OR EXISTS (SELECT 1 FROM purchase_order_items WHERE product_id = @id) AS used`,
          { id: product.id, batch_id: batch.id }
        ).used;
        if (used) {
          run("UPDATE products SET status = 'HIDDEN', online_visible = 0, updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: product.id });
          hidden += 1;
        } else {
          run('DELETE FROM products WHERE id = @id', { id: product.id });
          removed += 1;
        }
        continue;
      }
      const columns = UPDATE_COLUMNS.filter((column) => column in before);
      if (columns.length) {
        run(
          `UPDATE products SET ${columns.map((c) => `${c} = @${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
          { id: product.id, ...Object.fromEntries(columns.map((c) => [c, before[c]])) }
        );
      }
      if (delta !== 0) {
        run('UPDATE products SET stock_quantity = @stock, status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
          id: product.id,
          stock,
          status: stockStatus(getOne('SELECT status FROM products WHERE id = @id', { id: product.id }).status, stock)
        });
        logStock(pharmacyId, product.id, product.stock_quantity, stock, 'IMPORT_REVERT', reason, userId, batch.id);
      }
      restored += 1;
    }

    run("UPDATE import_batches SET status = 'REVERTED', reverted_by = @user_id, reverted_at = CURRENT_TIMESTAMP WHERE id = @id", {
      id: batch.id,
      user_id: userId
    });
    audit(pharmacyId, userId, 'PRODUCT_IMPORT_REVERT', batch.id, `${reason} · 복원 ${restored} · 삭제 ${removed} · 숨김 ${hidden}`);
    return { restored, removed, hidden };
  })();
}

/* ---------- 조회 ---------- */

function displayChanges(before, after, names) {
  const changes = [];
  for (const [column, value] of Object.entries(after || {})) {
    if (column.startsWith('_') || !FIELD_LABELS[column]) continue;
    let from = before?.[column] ?? null;
    let to = value;
    if (column === 'category_id') {
      from = names.categories.get(from) ?? from;
      to = after._category_name || names.categories.get(to) || to;
    }
    if (column === 'supplier_id') {
      from = names.suppliers.get(from) ?? from;
      to = after._supplier_name || names.suppliers.get(to) || to;
    }
    changes.push({ field: column, label: FIELD_LABELS[column], before: from, after: to });
  }
  return changes;
}

function batchRows(pharmacyId, batchId, { filter = 'ALL', q = '', page = 1, pageSize = 50 } = {}) {
  const batch = findBatch(pharmacyId, batchId);
  const conditions = ['batch_id = @batch_id'];
  if (filter === 'WARNING') conditions.push(`messages LIKE '%"warning"%' AND action != 'SKIP'`);
  else if (['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR'].includes(filter)) conditions.push('action = @filter');
  if (q) conditions.push('(input LIKE @q OR after_values LIKE @q)');
  const where = conditions.join(' AND ');
  const params = { batch_id: batch.id, filter, q: `%${q}%` };
  const total = getOne(`SELECT COUNT(*) AS n FROM import_batch_rows WHERE ${where}`, params).n;
  const size = Math.min(200, Math.max(10, Number(pageSize) || 50));
  const current = Math.max(1, Math.min(Number(page) || 1, Math.max(1, Math.ceil(total / size))));
  const rows = getAll(
    `SELECT * FROM import_batch_rows WHERE ${where}
     ORDER BY CASE WHEN row_no = 0 THEN 1 ELSE 0 END, row_no, id LIMIT @limit OFFSET @offset`,
    { ...params, limit: size, offset: (current - 1) * size }
  );
  const names = {
    categories: new Map(getAll('SELECT id, category_name FROM categories WHERE pharmacy_id = @p', { p: pharmacyId }).map((c) => [c.id, c.category_name])),
    suppliers: new Map(getAll('SELECT id, name FROM suppliers WHERE pharmacy_id = @p', { p: pharmacyId }).map((s) => [s.id, s.name]))
  };
  return {
    batch: { ...batch, options: parseJson(batch.options, {}) },
    total,
    page: current,
    page_size: size,
    rows: rows.map((row) => {
      const input = parseJson(row.input, {});
      const before = parseJson(row.before_values, null);
      const after = parseJson(row.after_values, null);
      return {
        row_no: row.row_no,
        missing: Boolean(input.missing),
        product_id: row.product_id,
        action: row.action,
        product_name: after?.product_name || input.product_name || '',
        barcode: after?.barcode || input.barcode || '',
        external_code: after?.external_code || input.external_code || '',
        stock_before: row.stock_before,
        stock_after: row.stock_after,
        changes: row.action === 'CREATE' ? [] : displayChanges(before, after, names),
        created: row.action === 'CREATE' ? after : null,
        lot: after?._lot || null,
        name_matches: after?._name_matches || [],
        messages: parseJson(row.messages, [])
      };
    })
  };
}

function batches(pharmacyId) {
  return getAll(
    `SELECT b.id, b.mode, b.status, b.file_name, b.source_type, b.snapshot_at, b.total_rows, b.create_count, b.update_count,
            b.unchanged_count, b.skip_count, b.error_count, b.warning_count, b.created_at, b.applied_at, b.reverted_at,
            u.name AS applied_by_name,
            b.status = 'APPLIED' AND b.applied_at > datetime('now', '-${REVERT_HOURS} hours')
              AND NOT EXISTS (SELECT 1 FROM import_batches n WHERE n.pharmacy_id = b.pharmacy_id AND n.status = 'APPLIED' AND n.id > b.id) AS can_revert
     FROM import_batches b
     LEFT JOIN users u ON u.id = b.applied_by
     WHERE b.pharmacy_id = @pharmacy_id AND b.status IN ('APPLIED', 'REVERTED')
     ORDER BY b.id DESC LIMIT 50`,
    { pharmacy_id: pharmacyId }
  );
}

/* ---------- 병행 동기화 ---------- */

function syncStatus(pharmacyId) {
  const settings = syncSettings(pharmacyId);
  const last = getOne(
    "SELECT applied_at, snapshot_at FROM import_batches WHERE pharmacy_id = @pharmacy_id AND mode = 'SYNC' AND status = 'APPLIED' ORDER BY id DESC LIMIT 1",
    { pharmacy_id: pharmacyId }
  );
  const stale = settings.enabled
    ? !last || Boolean(getOne(`SELECT @at < datetime('now', '-' || @hours || ' hours') AS stale`, { at: last.applied_at, hours: settings.interval_hours }).stale)
    : false;
  return { ...settings, last_sync_at: last?.applied_at || null, last_snapshot_at: last?.snapshot_at || null, stale };
}

function updateSync(pharmacyId, userId, body) {
  const current = syncSettings(pharmacyId);
  const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
  const buffer = body.online_stock_buffer === undefined ? current.online_stock_buffer : Number(body.online_stock_buffer);
  const hours = body.interval_hours === undefined ? current.interval_hours : Number(body.interval_hours);
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 100) throw new ImportError('온라인 여유분은 0~100개로 정해 주세요.');
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new ImportError('동기화 주기는 1~168시간으로 정해 주세요.');
  run(
    `UPDATE pharmacies
     SET pos_sync_enabled = @enabled, online_stock_buffer = @buffer, pos_sync_interval_hours = @hours,
         pos_sync_reflected_until = CASE WHEN @turning_on = 1 THEN datetime('now') ELSE pos_sync_reflected_until END,
         pos_sync_reflected_log_id = CASE WHEN @turning_on = 1 THEN @log_id ELSE pos_sync_reflected_log_id END
     WHERE id = @id`,
    { id: pharmacyId, enabled: enabled ? 1 : 0, buffer, hours, turning_on: enabled && !current.enabled ? 1 : 0, log_id: lastLogId() }
  );
  if (enabled !== current.enabled) {
    audit(pharmacyId, userId, enabled ? 'POS_SYNC_ON' : 'POS_SYNC_OFF', null, enabled ? '기존 POS 병행 모드 켬' : '기존 POS 병행 모드 끔');
  }
  return syncStatus(pharmacyId);
}

function outflow(pharmacyId, untilLogIdInput) {
  const settings = syncSettings(pharmacyId);
  if (!settings.enabled) throw new ImportError('기존 POS 병행 모드가 꺼져 있습니다.', 409);
  const max = lastLogId();
  const requested = Number(untilLogIdInput);
  const untilLogId = Number.isInteger(requested) && requested > 0 ? Math.min(requested, max) : max;
  if (untilLogId < settings.reflected_log_id) throw new ImportError('이미 기존 POS에 입력했다고 표시한 기간입니다.', 409);
  const loggedAt = requested > 0 ? getOne('SELECT created_at FROM inventory_logs WHERE id = @id', { id: untilLogId })?.created_at : null;
  const until = loggedAt || nowUtc();
  const net = netChangesSince(pharmacyId, settings.reflected_log_id, untilLogId);
  const ids = [...net.keys()].filter((id) => net.get(id) !== 0);
  const products = ids.length
    ? getAll(`SELECT id, product_name, barcode, external_code FROM products WHERE pharmacy_id = @p AND id IN (${ids.map(Number).join(',')})`, { p: pharmacyId })
    : [];
  const items = products
    .map((p) => ({ product_id: p.id, product_name: p.product_name, barcode: p.barcode, external_code: p.external_code, quantity_out: -net.get(p.id) }))
    .sort((a, b) => b.quantity_out - a.quantity_out || a.product_name.localeCompare(b.product_name, 'ko'));
  return { from: settings.reflected_until, until, from_log_id: settings.reflected_log_id, until_log_id: untilLogId, items };
}

// 내려받은 판매 수량 목록(until_log_id까지)을 기존 POS에 다 입력했다고 표시한다.
function markReflected(pharmacyId, userId, { until_log_id: untilLogIdInput, until: untilInput } = {}) {
  const settings = syncSettings(pharmacyId);
  if (!settings.enabled) throw new ImportError('기존 POS 병행 모드가 꺼져 있습니다.', 409);
  const untilLogId = Number(untilLogIdInput);
  if (!Number.isInteger(untilLogId) || untilLogId < 0) throw new ImportError('MAYDIN에서 판 수량을 먼저 확인해 주세요.');
  if (untilLogId > lastLogId()) throw new ImportError('아직 없는 기록까지 표시할 수 없습니다.');
  if (untilLogId < settings.reflected_log_id) throw new ImportError('이전에 표시한 것보다 앞으로 돌릴 수 없습니다.');
  const now = nowUtc();
  const asked = toUtcTimestamp(untilInput);
  const until = asked && asked <= now ? asked : now;
  run('UPDATE pharmacies SET pos_sync_reflected_until = @until, pos_sync_reflected_log_id = @log_id WHERE id = @id', {
    id: pharmacyId,
    until,
    log_id: untilLogId
  });
  audit(pharmacyId, userId, 'POS_SYNC_REFLECTED', null, `MAYDIN 판매를 기존 POS에 입력함 · ${until} (UTC)까지`);
  return syncStatus(pharmacyId);
}

/* ---------- 프로필 ---------- */

function profiles(pharmacyId) {
  return getAll('SELECT id, name, column_map, options, updated_at FROM import_profiles WHERE pharmacy_id = @p ORDER BY updated_at DESC', { p: pharmacyId }).map(
    (row) => ({ ...row, column_map: parseJson(row.column_map, {}), options: parseJson(row.options, {}) })
  );
}

function saveProfile(pharmacyId, userId, body) {
  const name = text(body.name, 40);
  if (!name) throw new ImportError('설정 이름을 입력해 주세요.');
  const columnMap = body.column_map && typeof body.column_map === 'object' ? body.column_map : null;
  if (!columnMap) throw new ImportError('열 맞추기 설정이 없습니다.');
  const options = body.options && typeof body.options === 'object' ? body.options : {};
  const map = JSON.stringify(columnMap);
  const optionText = JSON.stringify(options);
  if (map.length > 4000 || optionText.length > 2000) throw new ImportError('설정이 너무 깁니다.');
  run(
    `INSERT INTO import_profiles (pharmacy_id, name, column_map, options, created_by)
     VALUES (@p, @name, @map, @options, @user_id)
     ON CONFLICT(pharmacy_id, name) DO UPDATE SET column_map = excluded.column_map, options = excluded.options, updated_at = CURRENT_TIMESTAMP`,
    { p: pharmacyId, name, map, options: optionText, user_id: userId }
  );
  return profiles(pharmacyId);
}

function deleteProfile(pharmacyId, profileId) {
  run('DELETE FROM import_profiles WHERE id = @id AND pharmacy_id = @p', { id: Number(profileId), p: pharmacyId });
  return profiles(pharmacyId);
}

module.exports = {
  ImportError,
  MAX_ROWS,
  UPDATABLE_FIELDS,
  DEFAULT_UPDATE_FIELDS,
  normalizeBarcode,
  normalizeKind,
  normalizeDate,
  syncSettings,
  onlineStockBuffer,
  assertNotSyncing,
  preview,
  apply,
  revert,
  batchRows,
  batches,
  syncStatus,
  updateSync,
  outflow,
  markReflected,
  profiles,
  saveProfile,
  deleteProfile
};
