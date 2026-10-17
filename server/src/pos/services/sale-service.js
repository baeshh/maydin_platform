const { getAll, getOne } = require('../../db');
const { receiptSignupCode } = require('../../services/member-auth');
const { taxBreakdown } = require('../../services/tax');
const { PosError, isOwner } = require('../common');
const { cashReceiptAmounts, receiptCashReceipts } = require('./cash-receipt-service');
const { refundablePaymentBalances } = require('./refund-service');

function getPosOrder(req, id) {
  const order = getOne(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name,
            orig.order_number AS original_order_number
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users u ON u.id = o.cashier_user_id
     LEFT JOIN orders orig ON orig.id = o.original_order_id
     WHERE o.id = @id AND o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS'`,
    { id: Number(id), pharmacy_id: req.pharmacyId }
  );
  if (!order) throw new PosError('POS 거래를 찾을 수 없습니다.', 404);
  return order;
}

function buildReceipt(req, orderId) {
  const order = getPosOrder(req, orderId);
  const pharmacy = getOne(
    'SELECT pharmacy_code, pharmacy_name, owner_name, business_number, phone, address FROM pharmacies WHERE id = @id',
    { id: req.pharmacyId }
  );
  const items = getAll(
    `SELECT oi.*, oi.quantity - COALESCE(oi.refunded_quantity, 0) AS refundable_quantity
     FROM order_items oi WHERE oi.order_id = @id ORDER BY oi.id ASC`,
    { id: order.id }
  );
  const payments = getAll(
    `SELECT p.*, COALESCE(v.is_demo, CASE WHEN p.payment_provider = 'VAN_DEMO' THEN 1 ELSE 0 END) AS is_demo
     FROM payments p LEFT JOIN van_transactions v ON v.id = p.van_transaction_id
     WHERE p.order_id = @id ORDER BY p.id ASC`,
    { id: order.id }
  );
  const refunds = getAll(
    `SELECT o.id, o.order_number, o.final_amount, o.refund_reason, o.created_at, r.refund_type, u.name AS created_by_name
     FROM orders o
     LEFT JOIN refunds r ON r.refund_order_id = o.id
     LEFT JOIN users u ON u.id = o.cashier_user_id
     WHERE o.original_order_id = @id
     ORDER BY o.id ASC`,
    { id: order.id }
  );
  const sameDay = getOne("SELECT date(@created_at, 'localtime') = date('now', 'localtime') AS same_day", {
    created_at: order.created_at
  }).same_day === 1;
  const pointBalance = order.customer_id
    ? getOne('SELECT point_balance FROM customers WHERE id = @id', { id: order.customer_id })?.point_balance ?? null
    : null;
  const cashReceipts = receiptCashReceipts(order);
  const issuable = order.order_type === 'POS_SALE' && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.order_status);
  const cashReceiptAmount = issuable ? cashReceiptAmounts(order.id).amount : 0;
  const pendingCashReceipt = getOne(
    "SELECT id FROM van_transactions WHERE order_id = @id AND transaction_type = 'CASH_RECEIPT' AND status IN ('REQUESTED', 'UNKNOWN') LIMIT 1",
    { id: order.id }
  );

  return {
    pharmacy,
    order,
    items,
    payments,
    refunds,
    points: order.customer_id
      ? {
          earned: order.points_earned || 0,
          reward:
            getOne("SELECT COALESCE(SUM(points), 0) AS total FROM point_ledger WHERE order_id = @id AND customer_id = @customer_id AND entry_type = 'REWARD'", {
              id: order.id,
              customer_id: order.customer_id
            }).total,
          balance: pointBalance
        }
      : null,
    tax: taxBreakdown(items),
    payment_balances: order.order_type === 'POS_SALE' ? refundablePaymentBalances(order.id) : {},
    signup_code: receiptSignupCode(order),
    cash_receipts: cashReceipts,
    cash_receipt_amount: cashReceiptAmount,
    cash_receipt_pending: Boolean(pendingCashReceipt),
    permissions: {
      can_issue_cash_receipt: cashReceiptAmount > 0 && !cashReceipts.length && !pendingCashReceipt,
      can_issue_signup_code:
        isOwner(req) && order.order_type === 'POS_SALE' && !order.customer_id && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.order_status),
      can_cancel: isOwner(req) && order.order_type === 'POS_SALE' && order.order_status === 'COMPLETED' && sameDay,
      can_refund:
        isOwner(req) &&
        order.order_type === 'POS_SALE' &&
        ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(order.order_status) &&
        items.some((item) => item.refundable_quantity > 0)
    }
  };
}

module.exports = {
  getPosOrder,
  buildReceipt
};
