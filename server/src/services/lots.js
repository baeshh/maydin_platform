const { getOne, run } = require('../db');

class LotError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseLotInput({ expiry_date: expiryInput, lot_number: lotInput } = {}) {
  const expiry = String(expiryInput ?? '').trim();
  const lotNumber = String(lotInput ?? '').trim().slice(0, 40) || null;
  if (!expiry) {
    if (lotNumber) throw new LotError('로트번호를 입력하면 유통기한도 함께 입력해 주세요.');
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) {
    throw new LotError('유통기한 형식이 올바르지 않습니다. (YYYY-MM-DD)');
  }
  const { today } = getOne("SELECT date('now', 'localtime') AS today");
  if (expiry < today) throw new LotError('이미 유통기한이 지난 상품은 입고할 수 없습니다.');
  return { expiry_date: expiry, lot_number: lotNumber };
}

function insertLot({ pharmacyId, productId, quantity, lot, unitCost = null, supplierId = null, purchaseOrderId = null, userId }) {
  if (!lot) return null;
  const result = run(
    `INSERT INTO product_lots (
      pharmacy_id, product_id, lot_number, expiry_date, received_quantity, remaining_quantity,
      unit_cost, supplier_id, purchase_order_id, received_by
    ) VALUES (
      @pharmacy_id, @product_id, @lot_number, @expiry_date, @quantity, @quantity,
      @unit_cost, @supplier_id, @purchase_order_id, @user_id
    )`,
    {
      pharmacy_id: pharmacyId,
      product_id: productId,
      lot_number: lot.lot_number,
      expiry_date: lot.expiry_date,
      quantity,
      unit_cost: unitCost,
      supplier_id: supplierId,
      purchase_order_id: purchaseOrderId,
      user_id: userId
    }
  );
  return result.lastInsertRowid;
}

function lotLabel(lot) {
  if (!lot) return '';
  return `${lot.lot_number ? `로트 ${lot.lot_number} · ` : ''}유통기한 ${lot.expiry_date}`;
}

module.exports = { LotError, parseLotInput, insertLot, lotLabel };
