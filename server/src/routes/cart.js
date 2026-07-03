const express = require('express');
const { getAll, getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

router.use(authenticate, requireRole('CUSTOMER'), requirePharmacyScope);

router.get('/', (req, res) => {
  const items = getAll(
    `SELECT c.id, c.quantity, p.id AS product_id, p.product_name, p.price, p.discount_price,
            p.stock_quantity, p.status, COALESCE(p.discount_price, p.price) AS sale_price
     FROM carts c
     JOIN products p ON p.id = c.product_id AND p.pharmacy_id = c.pharmacy_id
     WHERE c.user_id = @user_id AND c.pharmacy_id = @pharmacy_id
     ORDER BY c.id DESC`,
    { user_id: req.user.id, pharmacy_id: req.pharmacyId }
  );
  res.json({ items });
});

router.post('/', (req, res) => {
  const product = getOne('SELECT * FROM products WHERE id = @product_id AND pharmacy_id = @pharmacy_id', {
    product_id: Number(req.body.product_id),
    pharmacy_id: req.pharmacyId
  });
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  if (product.status !== 'ON_SALE') return res.status(400).json({ message: '판매중인 상품이 아닙니다.' });

  run(
    `INSERT INTO carts (user_id, pharmacy_id, product_id, quantity)
     VALUES (@user_id, @pharmacy_id, @product_id, @quantity)
     ON CONFLICT(user_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity`,
    {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId,
      product_id: product.id,
      quantity: Number(req.body.quantity || 1)
    }
  );
  res.status(201).json({ ok: true });
});

router.patch('/:id', (req, res) => {
  run(
    'UPDATE carts SET quantity = @quantity WHERE id = @id AND user_id = @user_id AND pharmacy_id = @pharmacy_id',
    {
      id: Number(req.params.id),
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId,
      quantity: Number(req.body.quantity)
    }
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  run('DELETE FROM carts WHERE id = @id AND user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    user_id: req.user.id,
    pharmacy_id: req.pharmacyId
  });
  res.json({ ok: true });
});

module.exports = router;
