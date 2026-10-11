const express = require('express');
const { getOne, run, transaction } = require('../../db');
const { PosError, audit, cleanText, handle, toInt, won } = require('../common');
const { heldCount, holdRows, serializeHold } = require('../services/hold-service');
const { getPosProduct } = require('../services/inventory-service');
const { requireOpenSession } = require('../services/session-service');

const router = express.Router();

router.get(
  '/holds',
  handle((req) => ({ holds: holdRows(req.pharmacyId) }))
);

router.post(
  '/holds',
  handle((req, res) => {
    const { terminal, session } = requireOpenSession(req);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (rawItems.length === 0) throw new PosError('보류할 상품이 없습니다.');
    if (heldCount(req.pharmacyId) >= 30) throw new PosError('보류는 최대 30건까지 가능합니다. 오래된 보류를 정리해 주세요.');

    const merged = new Map();
    for (const raw of rawItems) {
      const productId = Number(raw.product_id);
      merged.set(productId, (merged.get(productId) || 0) + toInt(raw.quantity, '수량', { min: 1, max: 999 }));
    }

    const hold = transaction(() => {
      const items = [];
      for (const [productId, quantity] of merged) {
        const product = getPosProduct(req.pharmacyId, productId);
        if (!product) throw new PosError('보류할 수 없는 상품이 포함되어 있습니다.');
        items.push({ product_id: product.id, product_name: product.product_name, quantity, sale_price: product.sale_price });
      }
      const total = items.reduce((sum, item) => sum + item.sale_price * item.quantity, 0);
      const customerId = req.body.customer_id ? Number(req.body.customer_id) : null;
      if (customerId && !getOne('SELECT id FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: customerId, pharmacy_id: req.pharmacyId })) {
        throw new PosError('선택한 회원을 찾을 수 없습니다.');
      }
      const counselId = req.body.counsel_order_id ? Number(req.body.counsel_order_id) : null;
      const discountAmount = Math.min(toInt(req.body.discount_amount || 0, '할인 금액'), total);
      const holdNumber =
        getOne(
          `SELECT COALESCE(MAX(hold_number), 0) + 1 AS next FROM pos_holds
           WHERE pharmacy_id = @pharmacy_id AND date(created_at, 'localtime') = date('now', 'localtime')`,
          { pharmacy_id: req.pharmacyId }
        ).next;

      const result = run(
        `INSERT INTO pos_holds (
          pharmacy_id, terminal_id, session_id, hold_number, label, customer_id, counsel_order_id, items_json,
          item_count, total_amount, discount_amount, discount_reason, created_by
        ) VALUES (
          @pharmacy_id, @terminal_id, @session_id, @hold_number, @label, @customer_id, @counsel_order_id, @items_json,
          @item_count, @total_amount, @discount_amount, @discount_reason, @user_id
        )`,
        {
          pharmacy_id: req.pharmacyId,
          terminal_id: terminal.id,
          session_id: session.id,
          hold_number: holdNumber,
          label: cleanText(req.body.label, 30),
          customer_id: customerId,
          counsel_order_id: counselId,
          items_json: JSON.stringify(items),
          item_count: items.reduce((sum, item) => sum + item.quantity, 0),
          total_amount: total,
          discount_amount: discountAmount,
          discount_reason: discountAmount > 0 ? cleanText(req.body.discount_reason) : null,
          user_id: req.user.id
        }
      );
      audit(req, 'POS_HOLD', 'POS_HOLD', result.lastInsertRowid, `판매 보류 #${holdNumber} · ${items.length}종 ${won(total)}`);
      return holdRows(req.pharmacyId).find((row) => row.id === result.lastInsertRowid);
    })();

    res.status(201);
    return { hold, hold_count: heldCount(req.pharmacyId) };
  })
);

router.post(
  '/holds/:id/recall',
  handle((req) => {
    const result = transaction(() => {
      const hold = getOne("SELECT * FROM pos_holds WHERE id = @id AND pharmacy_id = @pharmacy_id", {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!hold) throw new PosError('보류 내역을 찾을 수 없습니다.', 404);
      if (hold.status !== 'HELD') throw new PosError('이미 불러왔거나 폐기된 보류입니다.', 409);

      const warnings = [];
      const items = [];
      for (const saved of JSON.parse(hold.items_json)) {
        const product = getPosProduct(req.pharmacyId, saved.product_id);
        if (!product || product.status === 'HIDDEN') {
          warnings.push(`${saved.product_name}: 판매 중지되어 제외했습니다.`);
          continue;
        }
        if (product.status !== 'ON_SALE' || product.stock_quantity <= 0) {
          warnings.push(`${product.product_name}: 품절되어 제외했습니다.`);
          continue;
        }
        let quantity = saved.quantity;
        if (product.stock_quantity < quantity) {
          warnings.push(`${product.product_name}: 재고가 ${product.stock_quantity}개라 수량을 줄였습니다.`);
          quantity = product.stock_quantity;
        }
        if (product.sale_price !== saved.sale_price) {
          warnings.push(`${product.product_name}: 가격이 ${won(saved.sale_price)} → ${won(product.sale_price)}(으)로 바뀌었습니다.`);
        }
        items.push({ product, quantity });
      }

      const customer = hold.customer_id
        ? getOne('SELECT id, name, phone, member_code FROM customers WHERE id = @id', { id: hold.customer_id })
        : null;
      const counsel = hold.counsel_order_id
        ? getOne("SELECT id, order_number, customer_id FROM orders WHERE id = @id AND order_type = 'COUNSEL'", { id: hold.counsel_order_id })
        : null;

      run(
        "UPDATE pos_holds SET status = 'RECALLED', resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'HELD'",
        { id: hold.id, user_id: req.user.id }
      );
      audit(req, 'POS_HOLD_RECALL', 'POS_HOLD', hold.id, `보류 불러오기 #${hold.hold_number}${warnings.length ? ` · 변경 ${warnings.length}건` : ''}`);
      return {
        hold: serializeHold(hold),
        items,
        customer,
        counsel,
        discount: { amount: hold.discount_amount, reason: hold.discount_reason || '' },
        warnings
      };
    })();
    return { ...result, hold_count: heldCount(req.pharmacyId) };
  })
);

router.post(
  '/holds/:id/discard',
  handle((req) => {
    transaction(() => {
      const hold = getOne('SELECT * FROM pos_holds WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!hold) throw new PosError('보류 내역을 찾을 수 없습니다.', 404);
      if (hold.status !== 'HELD') throw new PosError('이미 불러왔거나 폐기된 보류입니다.', 409);
      run(
        "UPDATE pos_holds SET status = 'DISCARDED', resolved_by = @user_id, resolved_at = CURRENT_TIMESTAMP WHERE id = @id",
        { id: hold.id, user_id: req.user.id }
      );
      audit(req, 'POS_HOLD_DISCARD', 'POS_HOLD', hold.id, `보류 폐기 #${hold.hold_number} · ${won(hold.total_amount)}`);
    })();
    return { ok: true, hold_count: heldCount(req.pharmacyId) };
  })
);

module.exports = router;
