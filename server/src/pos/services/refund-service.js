const { getAll, getOne, run } = require('../../db');
const { refundCost } = require('../../services/order-cost');
const { changePoints, pointEligibleAmount } = require('../../services/points');
const { isPointEligible } = require('../../services/product-kind');
const { PosError, audit, nextOrderNumber } = require('../common');
const { logInventory } = require('./inventory-service');
const { insertPayments } = require('./payment-service');

function refundablePaymentBalances(originalOrderId) {
  const rows = getAll(
    `SELECT payment_method, COALESCE(SUM(paid_amount), 0) AS balance
     FROM payments
     WHERE order_id = @id OR order_id IN (SELECT id FROM orders WHERE original_order_id = @id)
     GROUP BY payment_method`,
    { id: originalOrderId }
  );
  return Object.fromEntries(rows.map((row) => [row.payment_method, row.balance]));
}

// 원거래와 연결된 음수 반품 주문을 만들어 매출·결제·재고를 함께 되돌린다.
function createRefundOrder(req, { original, lines, refundType, reason, payments, restock, session, terminal }) {
  const grossTotal = lines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const refundTotal = lines.reduce((sum, line) => sum + line.amount, 0);

  const orderResult = run(
    `INSERT INTO orders (
      order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, delivery_fee,
      discount_amount, final_amount, payment_status, order_status, delivery_status, contact_name, contact_phone,
      pos_terminal_id, pos_session_id, cashier_user_id, original_order_id, refund_reason
    ) VALUES (
      @order_number, @pharmacy_id, @customer_id, 'POS_REFUND', 'POS', @total_product_amount, 0,
      @discount_amount, @final_amount, 'REFUNDED', 'COMPLETED', 'NOT_APPLICABLE', @contact_name, @contact_phone,
      @pos_terminal_id, @pos_session_id, @cashier_user_id, @original_order_id, @refund_reason
    )`,
    {
      order_number: nextOrderNumber('RFD', req.pharmacyId),
      pharmacy_id: req.pharmacyId,
      customer_id: original.customer_id,
      total_product_amount: -grossTotal,
      discount_amount: -(grossTotal - refundTotal),
      final_amount: -refundTotal,
      contact_name: original.contact_name,
      contact_phone: original.contact_phone,
      pos_terminal_id: terminal.id,
      pos_session_id: session.id,
      cashier_user_id: req.user.id,
      original_order_id: original.id,
      refund_reason: reason
    }
  );
  const refundOrderId = orderResult.lastInsertRowid;

  for (const { item, quantity, amount } of lines) {
    run(
      `INSERT INTO order_items (
        order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, discount_amount,
        unit_cost, cost_amount, cost_source
      ) VALUES (
        @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @discount_amount,
        @unit_cost, @cost_amount, @cost_source
      )`,
      {
        order_id: refundOrderId,
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: -quantity,
        price: item.price,
        total_price: -(item.price * quantity),
        product_type: item.product_type,
        tax_type: item.tax_type,
        discount_amount: -(item.price * quantity - amount),
        ...refundCost(item, quantity)
      }
    );

    const updated = run(
      `UPDATE order_items
       SET refunded_quantity = COALESCE(refunded_quantity, 0) + @quantity,
           refunded_amount = COALESCE(refunded_amount, 0) + @amount
       WHERE id = @id AND COALESCE(refunded_quantity, 0) + @quantity <= quantity`,
      { id: item.id, quantity, amount }
    );
    if (updated.changes === 0) throw new PosError(`${item.product_name}의 반품 가능 수량을 초과했습니다.`);

    if (restock) {
      const product = getOne('SELECT stock_quantity FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: item.product_id,
        pharmacy_id: req.pharmacyId
      });
      if (product) {
        run(
          `UPDATE products
           SET stock_quantity = stock_quantity + @quantity,
               status = CASE WHEN status = 'SOLD_OUT' THEN 'ON_SALE' ELSE status END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = @id AND pharmacy_id = @pharmacy_id`,
          { id: item.product_id, pharmacy_id: req.pharmacyId, quantity }
        );
        logInventory(
          req,
          item.product_id,
          product.stock_quantity,
          product.stock_quantity + quantity,
          'POS_REFUND',
          refundType === 'CANCEL' ? '현장 판매 취소 재입고' : '현장 반품 재입고',
          refundOrderId
        );
      }
    }
  }

  insertPayments(refundOrderId, payments, {
    sign: -1,
    session,
    terminal,
    userId: req.user.id,
    customerId: original.customer_id
  });

  run(
    `INSERT INTO refunds (
      pharmacy_id, original_order_id, refund_order_id, refund_type, refund_amount, reason, approved_by, created_by
    ) VALUES (
      @pharmacy_id, @original_order_id, @refund_order_id, @refund_type, @refund_amount, @reason, @user_id, @user_id
    )`,
    {
      pharmacy_id: req.pharmacyId,
      original_order_id: original.id,
      refund_order_id: refundOrderId,
      refund_type: refundType,
      refund_amount: refundTotal,
      reason,
      user_id: req.user.id
    }
  );

  return { refundOrderId, refundTotal };
}

// 적립 포인트를 이미 써 버린 고객은 잔액까지만 회수하고, 못 돌려받은 포인트는 원장 사유에 남긴다.
function reverseEarnedPoints(req, original, refundOrderId, lines, { full }) {
  const earned = original.points_earned || 0;
  if (!original.customer_id || earned <= 0) return null;
  const reversedSoFar = -getOne(
    'SELECT COALESCE(SUM(points_earned), 0) AS total FROM orders WHERE original_order_id = @id AND id != @refund_id',
    { id: original.id, refund_id: refundOrderId }
  ).total;
  const remaining = earned - reversedSoFar;
  if (remaining <= 0) return null;

  let target = remaining;
  if (!full) {
    const items = getAll('SELECT total_price, discount_amount, product_type FROM order_items WHERE order_id = @id', {
      id: original.id
    });
    const eligibleTotal = pointEligibleAmount(items);
    const eligibleRefund = lines
      .filter((line) => isPointEligible(line.item.product_type))
      .reduce((sum, line) => sum + line.amount, 0);
    target = eligibleTotal > 0 ? Math.min(remaining, Math.floor((earned * eligibleRefund) / eligibleTotal)) : 0;
  }
  if (target <= 0) return null;

  const balance = getOne('SELECT point_balance FROM customers WHERE id = @id', { id: original.customer_id }).point_balance;
  const taken = Math.min(balance, target);
  const shortfall = target - taken;
  run('UPDATE orders SET points_earned = @points WHERE id = @id', { id: refundOrderId, points: -target });
  if (taken > 0 || shortfall > 0) {
    const reason = `${original.order_number} ${full ? '취소' : '반품'} 적립 회수${shortfall > 0 ? ` · 잔액 부족으로 ${shortfall}P 미회수` : ''}`;
    if (taken > 0) {
      changePoints({
        pharmacyId: req.pharmacyId,
        customerId: original.customer_id,
        orderId: refundOrderId,
        entryType: 'EARN_CANCEL',
        points: -taken,
        reason,
        userId: req.user.id
      });
    }
    if (shortfall > 0) audit(req, 'POINT_SHORTFALL', 'ORDER', original.id, reason);
  }
  return { target, taken, shortfall };
}

module.exports = {
  refundablePaymentBalances,
  createRefundOrder,
  reverseEarnedPoints
};
