const { getOne, run } = require('../db');

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

const TRACKED_FIELDS = ['product_name', 'company', 'main_function', 'intake_method', 'intake_caution', 'storage', 'shelf_life', 'appearance', 'standard'];

// 식약처 내용이 바뀌면 그 신고번호에 연결된 상품은 약사가 다시 확인할 때까지 미검증으로 돌린다.
function saveRecord(record) {
  const before = cachedRecord(record.report_no);
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
  if (before && TRACKED_FIELDS.some((field) => (before[field] ?? null) !== (record[field] ?? null))) {
    run('UPDATE products SET mfds_verified_at = NULL, mfds_verified_by = NULL WHERE mfds_report_no = @no AND mfds_verified_at IS NOT NULL', { no: record.report_no });
  }
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

// 약국이 직접 고른 제품. 약사(약국 운영자) 계정이 고르면 그 자체로 검증으로 본다.
async function linkProduct(pharmacyId, productId, reportNo, verifierId = null) {
  const product = getOne('SELECT id FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(productId), pharmacy_id: pharmacyId });
  if (!product) throw new MfdsError('상품을 찾을 수 없습니다.', 404);
  const record = await fetchRecord(reportNo);
  run(
    `UPDATE products SET mfds_report_no = @no, mfds_link_source = 'MANUAL', mfds_match_basis = 'MANUAL', mfds_checked_at = CURRENT_TIMESTAMP,
       mfds_verified_at = CASE WHEN @verifier IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, mfds_verified_by = @verifier, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id: product.id, no: record.report_no, verifier: verifierId }
  );
  return record;
}

function unlinkProduct(pharmacyId, productId) {
  const result = run(
    `UPDATE products SET mfds_report_no = NULL, mfds_link_source = 'REMOVED', mfds_match_basis = NULL, mfds_verified_at = NULL, mfds_verified_by = NULL,
       mfds_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    { id: Number(productId), pharmacy_id: pharmacyId }
  );
  if (!result.changes) throw new MfdsError('상품을 찾을 수 없습니다.', 404);
}

const isRetired = (name) => /^\(?구\)|수출용/.test(String(name || '').trim());

// 자동 연결은 식약처 신고 제품명과 상품명(브랜드를 붙인 이름 포함)이 정확히 같고, 그런 제품이 하나뿐일 때만 한다.
// 브랜드(제조사)를 적어 두었으면 신고 업체명이나 신고 제품명에 그 브랜드가 있어야 하고, 없으면 고르지 않는다.
function pickExact(product, candidates) {
  const names = new Set([normalize(product.product_name), product.brand ? normalize(`${product.brand}${product.product_name}`) : null].filter(Boolean));
  const brand = normalize(product.brand);
  let exact = candidates.filter((c) => !isRetired(c.product_name) && names.has(normalize(c.product_name)));
  const byCompany = (c) => normalize(c.company).includes(brand);
  if (brand) exact = exact.filter((c) => byCompany(c) || normalize(c.product_name).includes(brand));
  const unique = [...new Map(exact.map((c) => [c.report_no, c])).values()];
  const match = unique.length === 1 ? unique[0] : null;
  // NAME_BRAND: 신고 업체는 다르지만(위탁 제조 등) 신고 제품명에 브랜드가 들어 있음
  const basis = !brand ? 'NAME' : match && byCompany(match) ? 'NAME_COMPANY' : 'NAME_BRAND';
  return { match, candidates: unique, basis };
}

// 일반 상품(건강기능식품)인데 아직 식약처 정보가 없는 상품을 맞춰 미검증으로 연결한다. 약국이 해제한 상품은 건드리지 않는다.
async function autoLinkProduct(productId) {
  const product = getOne('SELECT id, product_name, brand, product_type, mfds_report_no, mfds_link_source FROM products WHERE id = @id', { id: productId });
  if (!product || product.product_type !== 'GENERAL' || product.mfds_report_no || product.mfds_link_source === 'REMOVED' || !serviceKey()) {
    return { status: 'SKIPPED' };
  }
  const query = String(product.product_name || '').trim();
  if (query.length < 2) return { status: 'SKIPPED' };
  const items = (await call({ Prduct: query.slice(0, 60), numOfRows: '100' })).map(toRecord).filter((r) => r.report_no && r.product_name);
  const { match, candidates, basis } = pickExact(product, items);
  run('UPDATE products SET mfds_checked_at = CURRENT_TIMESTAMP WHERE id = @id', { id: product.id });
  if (!match) return { status: candidates.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: candidates.length };
  saveRecord(items.find((r) => r.report_no === match.report_no));
  run(
    `UPDATE products SET mfds_report_no = @no, mfds_link_source = 'AUTO', mfds_match_basis = @basis, mfds_verified_at = NULL, mfds_verified_by = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND mfds_report_no IS NULL`,
    { id: product.id, no: match.report_no, basis }
  );
  return { status: 'LINKED', report_no: match.report_no, product_name: match.product_name, company: match.company, basis };
}

// 상품명·브랜드·바코드가 바뀌면 연결을 다시 본다. 아직 확인 안 한 자동 연결은 풀고 다시 맞추고, 확인했던 연결은 재검증 대기로 돌린다.
function markRecheck(productId) {
  run(
    `UPDATE products SET mfds_report_no = NULL, mfds_link_source = NULL, mfds_match_basis = NULL
     WHERE id = @id AND mfds_link_source = 'AUTO' AND mfds_verified_at IS NULL`,
    { id: productId }
  );
  run('UPDATE products SET mfds_verified_at = NULL, mfds_verified_by = NULL WHERE id = @id AND mfds_report_no IS NOT NULL', { id: productId });
}

function verifyLink(pharmacyId, productId, userId) {
  const result = run(
    `UPDATE products SET mfds_verified_at = CURRENT_TIMESTAMP, mfds_verified_by = @user_id, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id AND mfds_report_no IS NOT NULL`,
    { id: Number(productId), pharmacy_id: pharmacyId, user_id: userId }
  );
  if (!result.changes) throw new MfdsError('연결된 식약처 정보가 없습니다.', 404);
}

module.exports = {
  MfdsError,
  autoLinkProduct,
  cachedRecord,
  fetchRecord,
  linkProduct,
  mallRecord,
  markRecheck,
  pickExact,
  searchProducts,
  serviceKey,
  unlinkProduct,
  verifyLink
};

