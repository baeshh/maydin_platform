const crypto = require('crypto');
const { getAll, getOne, run } = require('../db');

class RecoveryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const RECOVERY_SOURCES = { OFFLINE_QUEUE: '장애 중 단말기 임시 저장', MANUAL: '수기 기록 복구' };
const OUTAGE_KINDS = { NETWORK: '인터넷 끊김', SERVER: '서버 장애', POWER: '정전·PC 장애', OTHER: '기타' };
const RECOVERY_MAX_DAYS = 7;
const CLIENT_SALE_ID = /^[A-Za-z0-9-]{8,64}$/;

function parseClientSaleId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = String(value).trim();
  if (!CLIENT_SALE_ID.test(id)) throw new RecoveryError('거래 고유번호 형식이 올바르지 않습니다.');
  return id;
}

// SQLite CURRENT_TIMESTAMP와 같은 UTC 'YYYY-MM-DD HH:MM:SS' 형식으로 바꾼다.
function toDbTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseTime(value, label) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) throw new RecoveryError(`${label}을(를) 확인해 주세요.`);
  const now = Date.now();
  if (date.getTime() > now + 5 * 60 * 1000) throw new RecoveryError(`${label}이(가) 현재보다 늦습니다.`);
  if (date.getTime() < now - RECOVERY_MAX_DAYS * 86400000) {
    throw new RecoveryError(`${RECOVERY_MAX_DAYS}일보다 오래된 거래는 복구할 수 없습니다. 파트너센터에서 재고 실사로 맞춰 주세요.`);
  }
  return date;
}

function findOutage(pharmacyId, id) {
  const outage = getOne('SELECT * FROM pos_outages WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(id), pharmacy_id: pharmacyId });
  if (!outage) throw new RecoveryError('장애 기록을 찾을 수 없습니다.', 404);
  return outage;
}

// 장애 중 판매를 서버에 다시 올릴 때의 정보. 일반 판매면 null.
function parseRecovery(raw, pharmacyId) {
  if (!raw) return null;
  const source = String(raw.source || '').toUpperCase();
  if (!RECOVERY_SOURCES[source]) throw new RecoveryError('복구 거래 종류가 올바르지 않습니다.');
  const occurredAt = toDbTime(parseTime(raw.occurred_at, '실제 판매 시각'));
  if (!raw.outage_id) throw new RecoveryError('복구 거래는 장애 기록에 묶어야 합니다. 장애를 먼저 등록해 주세요.');
  const outage = findOutage(pharmacyId, raw.outage_id);
  return { source, occurredAt, outage, note: String(raw.note || '').trim().slice(0, 200) };
}

// 이미 저장된 거래의 재전송(중복)은 대사 뒤에도 허용해야 하므로, 중복 확인 다음에 부른다.
function assertOutageOpen(outage) {
  const current = getOne('SELECT status FROM pos_outages WHERE id = @id', { id: outage.id });
  if (current.status === 'RECONCILED') {
    throw new RecoveryError('재고 대사를 마친 장애에는 거래를 더 추가할 수 없습니다. 새 장애로 기록해 주세요.', 409);
  }
}

// 같은 거래 고유번호로 다시 들어온 요청이 처음 요청과 같은 내용인지 비교하는 지문.
function saleFingerprint({ items, discountAmount, payments, customerId, occurredAt }) {
  const body = JSON.stringify({
    items: [...items].map(([id, line]) => [id, line.quantity, line.price ?? null]).sort((a, b) => a[0] - b[0]),
    discount: discountAmount,
    payments: (payments || [])
      .map((p) => [String(p.method || '').toUpperCase(), Number(p.amount)])
      .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])),
    customer: customerId || null,
    occurred: occurredAt || null
  });
  return crypto.createHash('sha256').update(body).digest('hex');
}

function createOutage({ pharmacyId, userId, kind, startedAt, endedAt, note }) {
  const type = String(kind || 'NETWORK').toUpperCase();
  if (!OUTAGE_KINDS[type]) throw new RecoveryError('장애 종류를 선택해 주세요.');
  const start = parseTime(startedAt, '장애 시작 시각');
  const end = endedAt ? parseTime(endedAt, '장애 종료 시각') : new Date();
  if (end < start) throw new RecoveryError('장애 종료 시각이 시작보다 빠릅니다.');
  const result = run(
    `INSERT INTO pos_outages (pharmacy_id, kind, started_at, ended_at, note, reported_by)
     VALUES (@pharmacy_id, @kind, @started_at, @ended_at, @note, @user_id)`,
    {
      pharmacy_id: pharmacyId,
      kind: type,
      started_at: toDbTime(start),
      ended_at: toDbTime(end),
      note: String(note || '').trim().slice(0, 300) || null,
      user_id: userId
    }
  );
  return getOne('SELECT * FROM pos_outages WHERE id = @id', { id: result.lastInsertRowid });
}

function outageSummarySql(alias = 'g') {
  return `
    (SELECT COUNT(*) FROM orders o WHERE o.outage_id = ${alias}.id) AS sale_count,
    (SELECT COALESCE(SUM(o.final_amount), 0) FROM orders o WHERE o.outage_id = ${alias}.id) AS sale_amount,
    (SELECT COALESCE(SUM(oi.stock_shortage), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.outage_id = ${alias}.id) AS shortage_quantity`;
}

function listOutages(pharmacyId) {
  return getAll(
    `SELECT g.*, u.name AS reported_by_name, r.name AS reconciled_by_name, ${outageSummarySql('g')}
     FROM pos_outages g
     LEFT JOIN users u ON u.id = g.reported_by
     LEFT JOIN users r ON r.id = g.reconciled_by
     WHERE g.pharmacy_id = @pharmacy_id
     ORDER BY g.id DESC
     LIMIT 30`,
    { pharmacy_id: pharmacyId }
  ).map((row) => ({ ...row, kind_label: OUTAGE_KINDS[row.kind] || row.kind }));
}

// 장애 뒤 재고 대사표: 복구한 거래에 나온 상품마다 판매 수량·부족분·현재 재고.
function outageDetail(pharmacyId, id) {
  const outage = findOutage(pharmacyId, id);
  const sales = getAll(
    `SELECT o.id, o.order_number, o.final_amount, o.created_at, o.recovered_at, o.recovery_source, u.name AS cashier_name,
            (SELECT GROUP_CONCAT(product_name || ' ×' || quantity, ', ') FROM order_items WHERE order_id = o.id) AS items_summary
     FROM orders o LEFT JOIN users u ON u.id = o.cashier_user_id
     WHERE o.outage_id = @id ORDER BY o.created_at ASC`,
    { id: outage.id }
  ).map((row) => ({ ...row, source_label: RECOVERY_SOURCES[row.recovery_source] || row.recovery_source }));
  const products = getAll(
    `SELECT p.id AS product_id, p.product_name, p.barcode, p.stock_quantity, p.status,
            SUM(oi.quantity) AS sold_quantity, SUM(oi.stock_shortage) AS shortage_quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.outage_id = @id
     GROUP BY p.id
     ORDER BY SUM(oi.stock_shortage) DESC, p.product_name ASC`,
    { id: outage.id }
  );
  return { outage: { ...outage, kind_label: OUTAGE_KINDS[outage.kind] || outage.kind }, sales, products };
}

module.exports = {
  OUTAGE_KINDS,
  RECOVERY_SOURCES,
  RecoveryError,
  assertOutageOpen,
  createOutage,
  findOutage,
  listOutages,
  outageDetail,
  parseClientSaleId,
  parseRecovery,
  saleFingerprint
};
