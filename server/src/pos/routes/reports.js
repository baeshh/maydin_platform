const express = require('express');
const { getAll, getOne } = require('../../db');
const { PosError, assertDate, handle, localToday, requireOwner } = require('../common');

const router = express.Router();

router.get(
  '/reports/daily',
  handle((req) => {
    const today = localToday();
    const from = assertDate(req.query.from || req.query.date, today);
    const to = assertDate(req.query.to || req.query.date, from);
    if (from > to) throw new PosError('조회 시작일이 종료일보다 늦습니다.');
    const params = { pharmacy_id: req.pharmacyId, from, to };
    const inRange = (column) => `date(${column}, 'localtime') BETWEEN @from AND @to`;

    const channels = getAll(
      `SELECT COALESCE(sales_channel, 'ONLINE') AS channel,
        COUNT(CASE WHEN final_amount > 0 THEN 1 END) AS order_count,
        COALESCE(SUM(CASE WHEN final_amount > 0 THEN final_amount ELSE 0 END), 0) AS gross_amount,
        COALESCE(SUM(CASE WHEN final_amount < 0 THEN final_amount ELSE 0 END), 0) AS refund_amount,
        COALESCE(SUM(final_amount), 0) AS net_amount
       FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_type != 'COUNSEL' AND ${inRange('created_at')}
       GROUP BY COALESCE(sales_channel, 'ONLINE')
       ORDER BY net_amount DESC`,
      params
    );

    const payments = getAll(
      `SELECT p.payment_method,
        COUNT(CASE WHEN p.paid_amount > 0 THEN 1 END) AS pay_count,
        COALESCE(SUM(CASE WHEN p.paid_amount > 0 THEN p.paid_amount ELSE 0 END), 0) AS paid_amount,
        COALESCE(SUM(CASE WHEN p.paid_amount < 0 THEN p.paid_amount ELSE 0 END), 0) AS refunded_amount,
        COALESCE(SUM(p.paid_amount), 0) AS net_amount
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.pharmacy_id = @pharmacy_id AND p.payment_method != 'NONE'
         AND ${inRange('COALESCE(p.paid_at, o.created_at)')}
       GROUP BY p.payment_method
       ORDER BY net_amount DESC`,
      params
    );

    const cashiers = getAll(
      `SELECT o.cashier_user_id, COALESCE(u.name, '-') AS cashier_name,
        COUNT(CASE WHEN o.order_type = 'POS_SALE' THEN 1 END) AS sale_count,
        COUNT(CASE WHEN o.order_type = 'POS_REFUND' THEN 1 END) AS refund_count,
        COALESCE(SUM(o.final_amount), 0) AS net_amount,
        COALESCE(SUM(CASE WHEN o.order_type = 'POS_SALE' THEN o.discount_amount ELSE 0 END), 0) AS discount_amount
       FROM orders o
       LEFT JOIN users u ON u.id = o.cashier_user_id
       WHERE o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS' AND ${inRange('o.created_at')}
       GROUP BY o.cashier_user_id
       ORDER BY net_amount DESC`,
      params
    );

    const products = getAll(
      `SELECT oi.product_id, oi.product_name, COALESCE(oi.product_type, 'GENERAL') AS product_type,
        SUM(oi.quantity) AS net_quantity,
        SUM(oi.total_price - COALESCE(oi.discount_amount, 0)) AS net_amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.pharmacy_id = @pharmacy_id AND o.sales_channel = 'POS' AND ${inRange('o.created_at')}
       GROUP BY oi.product_id
       HAVING SUM(oi.quantity) != 0 OR SUM(oi.total_price) != 0
       ORDER BY net_amount DESC
       LIMIT 20`,
      params
    );

    const totals = getOne(
      `SELECT
        COALESCE(SUM(final_amount), 0) AS net_amount,
        COALESCE(SUM(CASE WHEN sales_channel = 'POS' THEN final_amount ELSE 0 END), 0) AS pos_net_amount,
        COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN discount_amount ELSE 0 END), 0) AS discount_amount,
        COUNT(CASE WHEN order_type = 'POS_SALE' THEN 1 END) AS pos_sale_count,
        COUNT(CASE WHEN order_type = 'POS_REFUND' THEN 1 END) AS pos_refund_count,
        COALESCE(SUM(CASE WHEN order_type = 'POS_REFUND' THEN final_amount ELSE 0 END), 0) AS pos_refund_amount
       FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_type != 'COUNSEL' AND ${inRange('created_at')}`,
      params
    );

    const sessions = getAll(
      `SELECT s.id, s.business_date, s.status, s.opening_cash, s.expected_cash, s.actual_cash, s.cash_difference,
              s.close_note, s.opened_at, s.closed_at, t.terminal_name,
              uo.name AS opened_by_name, uc.name AS closed_by_name
       FROM pos_sessions s
       JOIN pos_terminals t ON t.id = s.terminal_id
       LEFT JOIN users uo ON uo.id = s.opened_by
       LEFT JOIN users uc ON uc.id = s.closed_by
       WHERE s.pharmacy_id = @pharmacy_id AND s.business_date BETWEEN @from AND @to
       ORDER BY s.id DESC`,
      params
    );

    return { from, to, totals, channels, payments, cashiers, products, sessions };
  })
);

router.get(
  '/audit-logs',
  handle((req) => {
    requireOwner(req, '감사 로그 조회');
    const logs = getAll(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.description, l.created_at, u.name AS user_name, u.role AS user_role
       FROM admin_logs l
       LEFT JOIN users u ON u.id = l.user_id
       WHERE l.pharmacy_id = @pharmacy_id
         AND (l.action GLOB 'POS_*' OR l.action GLOB 'POINT_*' OR l.action GLOB 'PO_*' OR l.action GLOB 'SUPPLIER_*')
       ORDER BY l.id DESC
       LIMIT 150`,
      { pharmacy_id: req.pharmacyId }
    );
    return { logs };
  })
);

module.exports = router;
