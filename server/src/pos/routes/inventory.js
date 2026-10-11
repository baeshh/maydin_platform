const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { insertLot, lotLabel, parseLotInput } = require('../../services/lots');
const { assertNotSyncing } = require('../../services/product-import');
const { PosError, audit, cleanText, handle, requireOwner, toInt } = require('../common');
const { EXPIRED_SQL, EXPIRING_SQL, EXPIRY_ALERT_DAYS, LOW_STOCK_SQL, POS_PRODUCT_COLUMNS, STOCK_ADJUST_TYPES, activeLots, getPosProduct, inventoryAlerts, logStock } = require('../services/inventory-service');

const router = express.Router();

router.get(
  '/inventory',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const filter = ['low', 'out', 'expiring', 'expired'].includes(req.query.filter) ? req.query.filter : 'all';
    const conditions = ['p.pharmacy_id = @pharmacy_id', "p.status != 'HIDDEN'"];
    if (query) conditions.push('(p.barcode = @query OR p.product_name LIKE @like OR p.barcode LIKE @like)');
    if (filter === 'low') conditions.push(LOW_STOCK_SQL);
    if (filter === 'out') conditions.push('p.stock_quantity <= 0');
    if (filter === 'expiring') conditions.push(EXPIRING_SQL);
    if (filter === 'expired') conditions.push(EXPIRED_SQL);
    const order = ['expiring', 'expired'].includes(filter) ? 'nearest_expiry ASC, p.product_name ASC' : 'is_low DESC, p.product_name ASC';

    const products = getAll(
      `SELECT ${POS_PRODUCT_COLUMNS}, p.cost_price,
        CASE WHEN ${LOW_STOCK_SQL} THEN 1 ELSE 0 END AS is_low,
        CASE WHEN ${EXPIRED_SQL} THEN 1 ELSE 0 END AS has_expired,
        (SELECT MAX(created_at) FROM inventory_logs l WHERE l.product_id = p.id) AS last_changed_at
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN p.barcode = @query THEN 0 ELSE 1 END, ${order}
       LIMIT 200`,
      { pharmacy_id: req.pharmacyId, query, like: `%${query}%` }
    );
    const exact = query ? products.find((product) => product.barcode === query) : null;
    return { products, exact_match_id: exact ? exact.id : null, alerts: inventoryAlerts(req.pharmacyId) };
  })
);

router.get(
  '/inventory/products/:id/logs',
  handle((req) => {
    const product = getPosProduct(req.pharmacyId, req.params.id);
    if (!product) throw new PosError('상품을 찾을 수 없습니다.', 404);
    const logs = getAll(
      `SELECT l.id, l.change_type, l.quantity_before, l.quantity_after, l.reason, l.created_at, l.reference_type,
              l.reference_id, u.name AS created_by_name
       FROM inventory_logs l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.product_id = @id AND l.pharmacy_id = @pharmacy_id
       ORDER BY l.id DESC
       LIMIT 60`,
      { id: product.id, pharmacy_id: req.pharmacyId }
    );
    return { product, logs, lots: activeLots(product.id), expiry_alert_days: EXPIRY_ALERT_DAYS };
  })
);

router.post(
  '/inventory/adjust',
  handle((req, res) => {
    const type = String(req.body.adjust_type || '').toUpperCase();
    const config = STOCK_ADJUST_TYPES[type];
    if (!config) throw new PosError('입고·폐기·실사 조정 중 하나를 선택해 주세요.');
    if (type !== 'RECEIVE') requireOwner(req, config.label);
    assertNotSyncing(req.pharmacyId, config.label);
    const reason = cleanText(req.body.reason);
    const lot = type === 'RECEIVE' ? parseLotInput(req.body) : null;
    const lotId = type === 'DISPOSE' && req.body.lot_id ? Number(req.body.lot_id) : null;

    const product = transaction(() => {
      const current = getOne("SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'", {
        id: Number(req.body.product_id),
        pharmacy_id: req.pharmacyId
      });
      if (!current) throw new PosError('상품을 찾을 수 없습니다.', 404);
      const before = current.stock_quantity;
      let after;
      let lotNote = '';
      if (type === 'RECEIVE') {
        const quantity = toInt(req.body.quantity, '입고 수량', { min: 1, max: 100000 });
        after = before + quantity;
        if (lot) {
          insertLot({ pharmacyId: req.pharmacyId, productId: current.id, quantity, lot, userId: req.user.id });
          lotNote = lotLabel(lot);
        }
      } else if (type === 'DISPOSE') {
        const quantity = toInt(req.body.quantity, '폐기 수량', { min: 1, max: 100000 });
        if (quantity > before) throw new PosError(`현재 재고(${before}개)보다 많이 폐기할 수 없습니다.`);
        if (!reason) throw new PosError('폐기 사유를 입력해 주세요.');
        if (lotId) {
          const target = getOne('SELECT * FROM product_lots WHERE id = @id AND product_id = @product_id', {
            id: lotId,
            product_id: current.id
          });
          if (!target || target.remaining_quantity <= 0) throw new PosError('폐기할 로트를 찾을 수 없습니다.', 404);
          if (quantity > target.remaining_quantity) {
            throw new PosError(`선택한 로트의 남은 수량(${target.remaining_quantity}개)보다 많이 폐기할 수 없습니다.`);
          }
          // 재고보다 먼저 로트를 줄여야 트리거가 다른 로트를 건드리지 않는다.
          run(
            `UPDATE product_lots SET remaining_quantity = remaining_quantity - @quantity, updated_at = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: target.id, quantity }
          );
          lotNote = lotLabel(target);
        }
        after = before - quantity;
      } else {
        after = toInt(req.body.quantity, '실사 수량', { min: 0, max: 100000 });
        if (after !== before && !reason) throw new PosError('실사 차이가 있으면 조정 사유를 입력해 주세요.');
      }

      run(
        `UPDATE products
         SET stock_quantity = @after,
             status = CASE
               WHEN @after > 0 AND status = 'SOLD_OUT' THEN 'ON_SALE'
               WHEN @after <= 0 AND status = 'ON_SALE' THEN 'SOLD_OUT'
               ELSE status END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = @id AND stock_quantity = @before`,
        { id: current.id, before, after }
      );
      const baseReason = reason || (type === 'RECEIVE' ? '입고' : '실사 확인 (차이 없음)');
      const finalReason = lotNote ? `${baseReason} · ${lotNote}` : baseReason;
      logStock(req, current.id, before, after, config.logType, finalReason);
      audit(
        req,
        config.action,
        'PRODUCT',
        current.id,
        `${config.label} · ${current.product_name} · ${before} → ${after} (${after - before >= 0 ? '+' : ''}${after - before}) · ${finalReason}`
      );
      return getPosProduct(req.pharmacyId, current.id);
    })();

    res.status(201);
    return { product, lots: activeLots(product.id), alerts: inventoryAlerts(req.pharmacyId) };
  })
);

router.patch(
  '/inventory/products/:id/safety-stock',
  handle((req) => {
    requireOwner(req, '안전재고 설정');
    const safetyStock = toInt(req.body.safety_stock, '안전재고', { min: 0, max: 100000 });
    const product = getPosProduct(req.pharmacyId, req.params.id);
    if (!product) throw new PosError('상품을 찾을 수 없습니다.', 404);
    transaction(() => {
      run('UPDATE products SET safety_stock = @safety_stock, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
        id: product.id,
        safety_stock: safetyStock
      });
      audit(req, 'POS_SAFETY_STOCK', 'PRODUCT', product.id, `안전재고 설정 · ${product.product_name} · ${product.safety_stock || 0} → ${safetyStock}`);
    })();
    return { product: getPosProduct(req.pharmacyId, product.id), alerts: inventoryAlerts(req.pharmacyId) };
  })
);

module.exports = router;
