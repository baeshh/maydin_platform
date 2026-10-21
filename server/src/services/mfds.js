const { getAll, getOne, run } = require('../db');

// 식품의약품안전처_건강기능식품정보(공공데이터포털 HtfsInfoService03).
// 약국이 고른 신고번호의 정보만 우리 DB에 보관하고(30일마다 새로 받음), 고객 화면은 보관본으로 보여 준다.
const DEFAULT_BASE = 'https://apis.data.go.kr/1471000/HtfsInfoService03';
const REFRESH_DAYS = 30;
const REPORT_NO = /^[0-9]{6,20}$/;

class MfdsError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const serviceKey = () => process.env.MFDS_SERVICE_KEY || '';
const clean = (value) => (value === undefined || value === null ? null : String(value).trim() || null);

async function call(params) {
  if (!serviceKey()) throw new MfdsError('식약처 연동 인증키가 설정되지 않았습니다. 관리자에게 문의해 주세요.', 503);
  const url = new URL(`${process.env.MFDS_API_BASE || DEFAULT_BASE}/getHtfsItem01`);
  url.search = new URLSearchParams({ serviceKey: serviceKey(), type: 'json', pageNo: '1', numOfRows: '20', ...params }).toString();
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    data = await res.json();
  } catch {
    throw new MfdsError('식약처 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (data?.header?.resultCode !== '00') throw new MfdsError('식약처 정보 조회에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  return (data.body?.items || []).map((entry) => entry.item || entry);
}

function toRecord(item) {
  return {
    report_no: clean(item.STTEMNT_NO),
    product_name: clean(item.PRDUCT),
    company: clean(item.ENTRPS),
    main_function: clean(item.MAIN_FNCTN),
    intake_method: clean(item.SRV_USE),
    intake_caution: clean(item.INTAKE_HINT1),
    storage: clean(item.PRSRV_PD),
    shelf_life: clean(item.DISTB_PD),
    appearance: clean(item.SUNGSANG),
    standard: clean(item.BASE_STANDARD),
    registered_at: clean(item.REGIST_DT)
  };
}

const normalize = (value) => String(value || '').toLowerCase().replace(/\(주\)|주식회사|\(구\)|[\s·,()[\]+&/-]/g, '');

// 제품명으로 후보를 찾는다(이름에 검색어가 들어간 제품 최대 100건). 같은 제조사, 이름이 더 비슷한 제품을 위로 올린다.
async function searchProducts(query, company) {
  const q = String(query || '').trim();
  if (q.length < 2) throw new MfdsError('제품명을 두 글자 이상 입력해 주세요.', 400);
  const items = (await call({ Prduct: q.slice(0, 60), numOfRows: '100' })).map(toRecord).filter((r) => r.report_no && r.product_name);
  const firm = normalize(company);
  const target = normalize(q);
  const score = (r) => {
    const name = normalize(r.product_name);
    let points = 0;
    if (firm && normalize(r.company).includes(firm)) points += 4;
    if (name === target) points += 3;
    else if (name.startsWith(target)) points += 1;
    // 이름이 검색어에 가까울수록(덧붙은 글자가 적을수록) 위로
    points -= Math.min(2, Math.max(0, name.length - target.length) / 20);
    if (/^\(?구\)/.test(r.product_name) || /수출용/.test(r.product_name)) points -= 2;
    return points;
  };
  return items
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 20)
    .map(({ r }) => ({ report_no: r.report_no, product_name: r.product_name, company: r.company, main_function: r.main_function, registered_at: r.registered_at }));
}

function saveRecord(record) {
  run(
    `INSERT INTO mfds_htfs (report_no, product_name, company, main_function, intake_method, intake_caution, storage, shelf_life, appearance, standard, registered_at, fetched_at)
     VALUES (@report_no, @product_name, @company, @main_function, @intake_method, @intake_caution, @storage, @shelf_life, @appearance, @standard, @registered_at, CURRENT_TIMESTAMP)
     ON CONFLICT(report_no) DO UPDATE SET
       product_name = excluded.product_name, company = excluded.company, main_function = excluded.main_function,
       intake_method = excluded.intake_method, intake_caution = excluded.intake_caution, storage = excluded.storage,
       shelf_life = excluded.shelf_life, appearance = excluded.appearance, standard = excluded.standard,
       registered_at = excluded.registered_at, fetched_at = CURRENT_TIMESTAMP`,
    record
  );
}

async function fetchRecord(reportNo) {
  const no = String(reportNo || '').trim();
  if (!REPORT_NO.test(no)) throw new MfdsError('신고번호 형식이 올바르지 않습니다.', 400);
  const record = (await call({ STTEMNT_NO: no, numOfRows: '1' })).map(toRecord).find((r) => r.report_no === no);
  if (!record) throw new MfdsError('식약처에서 이 신고번호의 제품을 찾을 수 없습니다.', 404);
  saveRecord(record);
  return record;
}

function cachedRecord(reportNo) {
  if (!reportNo) return null;
  return getOne('SELECT * FROM mfds_htfs WHERE report_no = @no', { no: reportNo }) || null;
}

// 고객 화면용. 보관본이 오래됐으면 응답은 보관본으로 하고 뒤에서 새로 받는다.
function mallRecord(reportNo) {
  const record = cachedRecord(reportNo);
  if (!record) return null;
  const stale = getOne(`SELECT fetched_at < datetime('now', '-${REFRESH_DAYS} days') AS stale FROM mfds_htfs WHERE report_no = @no`, { no: reportNo }).stale;
  if (stale && serviceKey()) fetchRecord(reportNo).catch(() => {});
  const { fetched_at: fetchedAt, ...rest } = record;
  return { ...rest, fetched_at: fetchedAt, source: '식품의약품안전처 건강기능식품정보' };
}

async function linkProduct(pharmacyId, productId, reportNo) {
  const product = getOne('SELECT id FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(productId), pharmacy_id: pharmacyId });
  if (!product) throw new MfdsError('상품을 찾을 수 없습니다.', 404);
  const record = await fetchRecord(reportNo);
  run(
    "UPDATE products SET mfds_report_no = @no, mfds_link_source = 'MANUAL', mfds_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = @id",
    { id: product.id, no: record.report_no }
  );
  return record;
}

function unlinkProduct(pharmacyId, productId) {
  const result = run(
    "UPDATE products SET mfds_report_no = NULL, mfds_link_source = 'REMOVED', mfds_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND pharmacy_id = @pharmacy_id",
    { id: Number(productId), pharmacy_id: pharmacyId }
  );
  if (!result.changes) throw new MfdsError('상품을 찾을 수 없습니다.', 404);
}

const isRetired = (name) => /^\(?구\)|수출용/.test(String(name || '').trim());

// 상품명(브랜드를 붙인 이름 포함)이 식약처 신고 제품명과 정확히 같고, 그런 제품이 하나뿐일 때만 고른다.
// 같은 이름이 여러 업체에 있으면(예: "오메가3") 고르지 않고 후보로만 돌려준다.
function pickExact(product, candidates) {
  const names = new Set([normalize(product.product_name), product.brand ? normalize(`${product.brand}${product.product_name}`) : null].filter(Boolean));
  const brand = normalize(product.brand);
  let exact = candidates.filter((c) => !isRetired(c.product_name) && names.has(normalize(c.product_name)));
  if (brand) {
    const sameMaker = exact.filter((c) => normalize(c.company).includes(brand) || normalize(c.product_name).includes(brand));
    if (sameMaker.length) exact = sameMaker;
  }
  const unique = [...new Map(exact.map((c) => [c.report_no, c])).values()];
  return { match: unique.length === 1 ? unique[0] : null, candidates: unique };
}

// 일반 상품(건강기능식품)인데 아직 식약처 정보가 없는 상품을 이름으로 맞춰 연결한다. 약국이 해제한 상품은 건드리지 않는다.
async function autoLinkProduct(productId) {
  const product = getOne('SELECT id, product_name, brand, product_type, mfds_report_no, mfds_link_source FROM products WHERE id = @id', { id: productId });
  if (!product || product.product_type !== 'GENERAL' || product.mfds_report_no || product.mfds_link_source === 'REMOVED' || !serviceKey()) {
    return { status: 'SKIPPED' };
  }
  const query = String(product.product_name || '').trim();
  if (query.length < 2) return { status: 'SKIPPED' };
  const items = (await call({ Prduct: query.slice(0, 60), numOfRows: '100' })).map(toRecord).filter((r) => r.report_no && r.product_name);
  const { match, candidates } = pickExact(product, items);
  run('UPDATE products SET mfds_checked_at = CURRENT_TIMESTAMP WHERE id = @id', { id: product.id });
  if (!match) return { status: candidates.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: candidates.length };
  saveRecord(items.find((r) => r.report_no === match.report_no));
  run(
    "UPDATE products SET mfds_report_no = @no, mfds_link_source = 'AUTO', updated_at = CURRENT_TIMESTAMP WHERE id = @id AND mfds_report_no IS NULL",
    { id: product.id, no: match.report_no }
  );
  return { status: 'LINKED', report_no: match.report_no, product_name: match.product_name, company: match.company };
}

// 상품 등록·수정 뒤에 응답을 늦추지 않고 뒤에서 맞춰 본다.
function autoLinkLater(productId) {
  if (!serviceKey()) return;
  setImmediate(() => autoLinkProduct(productId).catch(() => {}));
}

async function autoLinkPharmacy(pharmacyId, limit = 200) {
  const products = getAll(
    `SELECT id, product_name FROM products
     WHERE pharmacy_id = @pharmacy_id AND product_type = 'GENERAL' AND status != 'HIDDEN'
       AND mfds_report_no IS NULL AND COALESCE(mfds_link_source, '') != 'REMOVED'
     ORDER BY online_visible DESC, id DESC LIMIT @limit`,
    { pharmacy_id: pharmacyId, limit }
  );
  const result = { linked: [], ambiguous: [], not_found: [] };
  for (const product of products) {
    const outcome = await autoLinkProduct(product.id);
    if (outcome.status === 'LINKED') result.linked.push({ id: product.id, product_name: product.product_name, mfds_name: outcome.product_name, company: outcome.company });
    else if (outcome.status === 'AMBIGUOUS') result.ambiguous.push({ id: product.id, product_name: product.product_name, candidates: outcome.candidates });
    else if (outcome.status === 'NOT_FOUND') result.not_found.push({ id: product.id, product_name: product.product_name });
  }
  return result;
}

function confirmLink(pharmacyId, productId) {
  const result = run(
    "UPDATE products SET mfds_link_source = 'MANUAL', updated_at = CURRENT_TIMESTAMP WHERE id = @id AND pharmacy_id = @pharmacy_id AND mfds_report_no IS NOT NULL",
    { id: Number(productId), pharmacy_id: pharmacyId }
  );
  if (!result.changes) throw new MfdsError('연결된 식약처 정보가 없습니다.', 404);
}

module.exports = {
  MfdsError,
  autoLinkLater,
  autoLinkPharmacy,
  autoLinkProduct,
  cachedRecord,
  confirmLink,
  fetchRecord,
  linkProduct,
  mallRecord,
  pickExact,
  searchProducts,
  unlinkProduct
};
