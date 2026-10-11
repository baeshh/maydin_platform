const { getAll, getOne, run } = require('../../db');
const { PosError } = require('../common');

function logInventory(req, productId, before, after, changeType, reason, orderId) {
  run(
    `INSERT INTO inventory_logs (
      pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by,
      reference_type, reference_id
    ) VALUES (
      @pharmacy_id, @product_id, @change_type, @quantity_before, @quantity_after, @reason, @created_by,
      'ORDER', @reference_id
    )`,
    {
      pharmacy_id: req.pharmacyId,
      product_id: productId,
      change_type: changeType,
      quantity_before: before,
      quantity_after: after,
      reason,
      created_by: req.user.id,
      reference_id: orderId
    }
  );
}

const EXPIRY_ALERT_DAYS = 90;

const NEAREST_EXPIRY_SQL =
  '(SELECT MIN(pl.expiry_date) FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0)';

const EXPIRED_SQL = `EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0
  AND pl.expiry_date < date('now', 'localtime'))`;

const EXPIRING_SQL = `EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_id = p.id AND pl.remaining_quantity > 0
  AND pl.expiry_date >= date('now', 'localtime') AND pl.expiry_date <= date('now', 'localtime', '+${EXPIRY_ALERT_DAYS} days'))`;

const POS_PRODUCT_COLUMNS = `p.id, p.product_name, p.price, p.discount_price, COALESCE(p.discount_price, p.price) AS sale_price,
  p.stock_quantity, p.status, p.barcode, COALESCE(p.product_type, 'GENERAL') AS product_type,
  p.safety_stock, p.thumbnail_url, p.category_id, c.category_name, ${NEAREST_EXPIRY_SQL} AS nearest_expiry,
  (SELECT COALESCE(SUM(pl.remaining_quantity), 0) FROM product_lots pl WHERE pl.product_id = p.id) AS lot_quantity`;

function getPosProduct(pharmacyId, id) {
  return getOne(
    `SELECT ${POS_PRODUCT_COLUMNS}
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = @id AND p.pharmacy_id = @pharmacy_id`,
    { id: Number(id), pharmacy_id: pharmacyId }
  );
}

const LOW_STOCK_SQL = "(p.stock_quantity <= 0 OR (COALESCE(p.safety_stock, 0) > 0 AND p.stock_quantity <= p.safety_stock))";

function inventoryAlerts(pharmacyId) {
  return getOne(
    `SELECT
      COUNT(CASE WHEN ${LOW_STOCK_SQL} THEN 1 END) AS low_count,
      COUNT(CASE WHEN p.stock_quantity <= 0 THEN 1 END) AS out_count,
      COUNT(CASE WHEN ${EXPIRED_SQL} THEN 1 END) AS expired_count,
      COUNT(CASE WHEN ${EXPIRING_SQL} THEN 1 END) AS expiring_count,
      ${EXPIRY_ALERT_DAYS} AS expiry_alert_days
     FROM products p
     WHERE p.pharmacy_id = @pharmacy_id AND p.status != 'HIDDEN'`,
    { pharmacy_id: pharmacyId }
  );
}

function normalizeBarcode(value) {
  const barcode = String(value ?? '').trim();
  if (!barcode) return null;
  if (barcode.length > 64 || /\s/.test(barcode)) throw new PosError('바코드 형식이 올바르지 않습니다.');
  return barcode;
}

function assertBarcodeFree(pharmacyId, barcode, exceptId = 0) {
  const duplicate = getOne(
    'SELECT id, product_name FROM products WHERE pharmacy_id = @pharmacy_id AND barcode = @barcode AND id != @id',
    { pharmacy_id: pharmacyId, barcode, id: exceptId }
  );
  if (duplicate) throw new PosError(`이미 "${duplicate.product_name}" 상품에 등록된 바코드입니다.`, 409);
}

const STOCK_ADJUST_TYPES = {
  RECEIVE: { label: '입고', logType: 'RECEIVE', action: 'POS_STOCK_RECEIVE' },
  DISPOSE: { label: '폐기', logType: 'DISPOSE', action: 'POS_STOCK_DISPOSE' },
  COUNT: { label: '실사 조정', logType: 'COUNT_ADJUST', action: 'POS_STOCK_COUNT' }
};

function activeLots(productId) {
  return getAll(
    `SELECT id, lot_number, expiry_date, received_quantity, remaining_quantity, created_at,
            CAST(julianday(expiry_date) - julianday(date('now', 'localtime')) AS INTEGER) AS days_left
     FROM product_lots
     WHERE product_id = @id AND remaining_quantity > 0
     ORDER BY expiry_date ASC, id ASC`,
    { id: productId }
  );
}

function logStock(req, productId, before, after, changeType, reason) {
  run(
    `INSERT INTO inventory_logs (
      pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type
    ) VALUES (
      @pharmacy_id, @product_id, @change_type, @before, @after, @reason, @user_id, 'MANUAL'
    )`,
    { pharmacy_id: req.pharmacyId, product_id: productId, change_type: changeType, before, after, reason, user_id: req.user.id }
  );
}

module.exports = {
  logInventory,
  EXPIRY_ALERT_DAYS,
  NEAREST_EXPIRY_SQL,
  EXPIRED_SQL,
  EXPIRING_SQL,
  POS_PRODUCT_COLUMNS,
  getPosProduct,
  LOW_STOCK_SQL,
  inventoryAlerts,
  normalizeBarcode,
  assertBarcodeFree,
  STOCK_ADJUST_TYPES,
  activeLots,
  logStock
};
