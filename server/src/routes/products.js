const express = require('express');
const { getAll, getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

router.get('/public', (req, res) => {
  const { pharmacyCode } = req.query;
  const pharmacy = getOne("SELECT id FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'", {
    pharmacyCode
  });
  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  const products = getAll(
    `SELECT p.*, c.category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.pharmacy_id = @pharmacy_id AND p.status != 'HIDDEN'
     ORDER BY p.id DESC`,
    { pharmacy_id: pharmacy.id }
  );
  res.json({ products });
});

router.get('/public/:id', (req, res) => {
  const product = getOne(
    `SELECT p.*, c.category_name, ph.pharmacy_code, ph.pharmacy_name
     FROM products p
     JOIN pharmacies ph ON ph.id = p.pharmacy_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = @id AND p.status != 'HIDDEN'`,
    { id: Number(req.params.id) }
  );
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  res.json({ product });
});

router.use(authenticate, requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope);

router.get('/', (req, res) => {
  const products = getAll(
    `SELECT p.*, c.category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.pharmacy_id = @pharmacy_id
     ORDER BY p.id DESC`,
    { pharmacy_id: req.pharmacyId }
  );
  res.json({ products });
});

router.post('/', (req, res) => {
  const {
    product_name,
    description,
    price,
    discount_price,
    stock_quantity,
    status,
    category_name,
    thumbnail_url
  } = req.body;

  let categoryId = null;
  if (category_name) {
    const category = getOne(
      'SELECT id FROM categories WHERE pharmacy_id = @pharmacy_id AND category_name = @category_name',
      { pharmacy_id: req.pharmacyId, category_name }
    );
    categoryId = category
      ? category.id
      : run(
          'INSERT INTO categories (pharmacy_id, category_name) VALUES (@pharmacy_id, @category_name)',
          { pharmacy_id: req.pharmacyId, category_name }
        ).lastInsertRowid;
  }

  const result = run(
    `INSERT INTO products (
      pharmacy_id, category_id, product_name, description, price, discount_price,
      stock_quantity, status, thumbnail_url
    ) VALUES (
      @pharmacy_id, @category_id, @product_name, @description, @price, @discount_price,
      @stock_quantity, @status, @thumbnail_url
    )`,
    {
      pharmacy_id: req.pharmacyId,
      category_id: categoryId,
      product_name,
      description,
      price: Number(price),
      discount_price: discount_price ? Number(discount_price) : null,
      stock_quantity: Number(stock_quantity || 0),
      status: status || 'ON_SALE',
      thumbnail_url
    }
  );

  res.status(201).json({ product: getOne('SELECT * FROM products WHERE id = @id', { id: result.lastInsertRowid }) });
});

router.patch('/:id', (req, res) => {
  const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });

  const next = { ...product, ...req.body };
  run(
    `UPDATE products
     SET product_name = @product_name,
         description = @description,
         price = @price,
         discount_price = @discount_price,
         stock_quantity = @stock_quantity,
         status = @status,
         thumbnail_url = @thumbnail_url,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    {
      id: product.id,
      pharmacy_id: req.pharmacyId,
      product_name: next.product_name,
      description: next.description,
      price: Number(next.price),
      discount_price: next.discount_price ? Number(next.discount_price) : null,
      stock_quantity: Number(next.stock_quantity),
      status: next.status,
      thumbnail_url: next.thumbnail_url
    }
  );

  if (Number(product.stock_quantity) !== Number(next.stock_quantity)) {
    run(
      `INSERT INTO inventory_logs (
        pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by
      ) VALUES (
        @pharmacy_id, @product_id, 'ADJUST', @quantity_before, @quantity_after, @reason, @created_by
      )`,
      {
        pharmacy_id: req.pharmacyId,
        product_id: product.id,
        quantity_before: product.stock_quantity,
        quantity_after: Number(next.stock_quantity),
        reason: '상품 수정',
        created_by: req.user.id
      }
    );
  }

  res.json({ product: getOne('SELECT * FROM products WHERE id = @id', { id: product.id }) });
});

router.delete('/:id', (req, res) => {
  run("UPDATE products SET status = 'HIDDEN', updated_at = CURRENT_TIMESTAMP WHERE id = @id AND pharmacy_id = @pharmacy_id", {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  res.json({ ok: true });
});

module.exports = router;
