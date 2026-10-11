const { getAll, getOne } = require('../db');

// 판매 순간의 매출원가를 계산한다. 재고 차감 "전에" 불러야 한다.
// 차감 순서는 trg_products_consume_lots와 같다: 로트 없는 재고 → 유통기한 빠른 로트 → 같은 기한이면 먼저 들어온 로트.
// 로트 매입가가 없으면 상품 원가로, 그것도 없으면 원가를 모르는 것으로 둔다.
function saleCost(productId, quantity) {
  const product = getOne('SELECT stock_quantity, cost_price FROM products WHERE id = @id', { id: productId });
  if (!product || quantity <= 0) return { unit_cost: null, cost_amount: null, cost_source: null };
  const lots = getAll(
    `SELECT remaining_quantity, unit_cost FROM product_lots
     WHERE product_id = @id AND remaining_quantity > 0
     ORDER BY expiry_date ASC, id ASC`,
    { id: productId }
  );

  let need = quantity;
  let total = 0;
  let unknown = false;
  const sources = new Set();
  const take = (available, unitCost, source) => {
    const qty = Math.min(need, Math.max(0, available));
    if (qty <= 0) return;
    if (unitCost === null || unitCost === undefined) unknown = true;
    else total += qty * unitCost;
    sources.add(source);
    need -= qty;
  };

  const lotTotal = lots.reduce((sum, lot) => sum + lot.remaining_quantity, 0);
  take(product.stock_quantity - lotTotal, product.cost_price, 'PRODUCT');
  for (const lot of lots) {
    if (need <= 0) break;
    const hasLotCost = lot.unit_cost !== null && lot.unit_cost !== undefined;
    take(lot.remaining_quantity, hasLotCost ? lot.unit_cost : product.cost_price, hasLotCost ? 'LOT' : 'PRODUCT');
  }
  take(need, product.cost_price, 'PRODUCT');

  if (unknown) return { unit_cost: null, cost_amount: null, cost_source: null };
  return {
    unit_cost: Math.round((total / quantity) * 100) / 100,
    cost_amount: Math.round(total),
    cost_source: sources.size > 1 ? 'MIXED' : [...sources][0]
  };
}

// 반품·취소 줄의 원가: 원래 판매 줄에 기록된 원가를 수량 비율대로 음수로 되돌린다.
function refundCost(item, quantity) {
  if (item.cost_amount === null || item.cost_amount === undefined || !item.quantity) {
    return { unit_cost: null, cost_amount: null, cost_source: null };
  }
  return {
    unit_cost: item.unit_cost,
    cost_amount: -Math.round((item.cost_amount * quantity) / item.quantity),
    cost_source: item.cost_source
  };
}

module.exports = { saleCost, refundCost };
