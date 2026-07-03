const express = require('express');
const { getAll, getOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

router.use(authenticate, requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope);

router.get('/pharmacy', (req, res) => {
  const summary = getOne(
    `SELECT
      COALESCE(SUM(CASE WHEN date(created_at) = date('now', 'localtime') THEN final_amount ELSE 0 END), 0) AS today_sales,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') THEN final_amount ELSE 0 END), 0) AS month_sales,
      COALESCE(SUM(final_amount), 0) AS total_sales,
      COUNT(CASE WHEN date(created_at) = date('now', 'localtime') THEN 1 END) AS today_order_count,
      COUNT(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') THEN 1 END) AS month_order_count,
      COUNT(CASE WHEN delivery_status != 'DELIVERED' THEN 1 END) AS pending_delivery_count,
      COUNT(CASE WHEN delivery_status = 'DELIVERED' THEN 1 END) AS delivered_count
     FROM orders
     WHERE pharmacy_id = @pharmacy_id`,
    { pharmacy_id: req.pharmacyId }
  );

  const counts = getOne(
    `SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'CUSTOMER' AND pharmacy_id = @pharmacy_id) AS customer_count,
      (SELECT COUNT(*) FROM products WHERE pharmacy_id = @pharmacy_id AND stock_quantity <= 5) AS low_stock_count,
      (SELECT COUNT(*) FROM products WHERE pharmacy_id = @pharmacy_id AND status = 'SOLD_OUT') AS sold_out_count`,
    { pharmacy_id: req.pharmacyId }
  );

  const popularProducts = getAll(
    `SELECT oi.product_name, SUM(oi.quantity) AS sold_quantity, SUM(oi.total_price) AS sales
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.pharmacy_id = @pharmacy_id
     GROUP BY oi.product_id
     ORDER BY sold_quantity DESC
     LIMIT 5`,
    { pharmacy_id: req.pharmacyId }
  );

  const recentOrders = getAll(
    `SELECT o.*, c.name AS customer_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.pharmacy_id = @pharmacy_id
     ORDER BY o.id DESC
     LIMIT 10`,
    { pharmacy_id: req.pharmacyId }
  );

  res.json({ summary: { ...summary, ...counts }, popularProducts, recentOrders });
});

router.get('/customers', (req, res) => {
  const customers = getAll(
    `SELECT c.*,
      COALESCE(SUM(o.final_amount), 0) AS total_purchase_amount,
      MAX(o.created_at) AS last_order_at,
      COUNT(o.id) AS order_count
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     WHERE c.pharmacy_id = @pharmacy_id
     GROUP BY c.id
     ORDER BY c.id DESC`,
    { pharmacy_id: req.pharmacyId }
  );
  res.json({ customers });
});

module.exports = router;
