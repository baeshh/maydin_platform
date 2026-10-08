const express = require('express');
const { getAll, getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

const PRODUCT_TYPES = new Set(['GENERAL', 'OTC']);

function normalizeBarcode(value) {
  const barcode = String(value ?? '').trim();
  return barcode || null;
}

function normalizeProductType(value) {
  const type = String(value || 'GENERAL').toUpperCase();
  if (!PRODUCT_TYPES.has(type)) throw new Error('상품 유형이 올바르지 않습니다.');
  return type;
}

function normalizeTaxType(value) {
  const type = String(value || 'TAXABLE').toUpperCase();
  if (!['TAXABLE', 'EXEMPT'].includes(type)) throw new Error('과세 구분이 올바르지 않습니다.');
  return type;
}

function optionalInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizeBrand(value) {
  const brand = String(value ?? '').trim();
  if (brand.length > 40) throw new Error('브랜드는 40자 이내로 입력해 주세요.');
  return brand || null;
}

// 1회 구매 수량 1개를 다 먹거나 쓰는 데 걸리는 일수. 다음 구매 예상일 계산에 쓴다.
function normalizeSupplyDays(value) {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('복용·사용 기간은 1~365일로 입력해 주세요.');
  return days;
}

function assertBarcodeAvailable(pharmacyId, barcode, exceptId = 0) {
  if (!barcode) return;
  const duplicate = getOne(
    'SELECT id, product_name FROM products WHERE pharmacy_id = @pharmacy_id AND barcode = @barcode AND id != @id',
    { pharmacy_id: pharmacyId, barcode, id: exceptId }
  );
  if (duplicate) throw new Error(`이미 "${duplicate.product_name}" 상품에 등록된 바코드입니다.`);
}

function publicProduct({ cost_price, supplier_id, safety_stock, pos_sale_enabled, ...product }) {
  return product;
}

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
     WHERE p.pharmacy_id = @pharmacy_id AND p.status != 'HIDDEN' AND COALESCE(p.product_type, 'GENERAL') != 'OTC'
     ORDER BY p.id DESC`,
    { pharmacy_id: pharmacy.id }
  );
  res.json({ products: products.map(publicProduct) });
});

router.get('/public/:id', (req, res) => {
  const product = getOne(
    `SELECT p.*, c.category_name, ph.pharmacy_code, ph.pharmacy_name
     FROM products p
     JOIN pharmacies ph ON ph.id = p.pharmacy_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = @id AND p.status != 'HIDDEN' AND COALESCE(p.product_type, 'GENERAL') != 'OTC'`,
    { id: Number(req.params.id) }
  );
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  res.json({ product: publicProduct(product) });
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

  let barcode;
  let productType;
  let taxType;
  let brand;
  let supplyDays;
  try {
    barcode = normalizeBarcode(req.body.barcode);
    productType = normalizeProductType(req.body.product_type);
    taxType = normalizeTaxType(req.body.tax_type);
    brand = normalizeBrand(req.body.brand);
    supplyDays = normalizeSupplyDays(req.body.supply_days);
    assertBarcodeAvailable(req.pharmacyId, barcode);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

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
      stock_quantity, status, thumbnail_url, barcode, product_type, tax_type, safety_stock, cost_price, pos_sale_enabled,
      brand, supply_days
    ) VALUES (
      @pharmacy_id, @category_id, @product_name, @description, @price, @discount_price,
      @stock_quantity, @status, @thumbnail_url, @barcode, @product_type, @tax_type, @safety_stock, @cost_price, @pos_sale_enabled,
      @brand, @supply_days
    )`,
    {
      pharmacy_id: req.pharmacyId,
      brand,
      supply_days: supplyDays,
      category_id: categoryId,
      product_name,
      description,
      price: Number(price),
      discount_price: discount_price ? Number(discount_price) : null,
      stock_quantity: Number(stock_quantity || 0),
      status: status || 'ON_SALE',
      thumbnail_url,
      barcode,
      product_type: productType,
      tax_type: taxType,
      safety_stock: Math.max(0, optionalInt(req.body.safety_stock) || 0),
      cost_price: optionalInt(req.body.cost_price),
      pos_sale_enabled: req.body.pos_sale_enabled === false || req.body.pos_sale_enabled === 0 ? 0 : 1
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
  let barcode;
  let productType;
  let taxType;
  let brand;
  let supplyDays;
  try {
    barcode = normalizeBarcode(next.barcode);
    productType = normalizeProductType(next.product_type);
    taxType = normalizeTaxType(next.tax_type);
    brand = normalizeBrand(next.brand);
    supplyDays = normalizeSupplyDays(next.supply_days);
    assertBarcodeAvailable(req.pharmacyId, barcode, product.id);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const nextStock = Number(next.stock_quantity);
  if (!Number.isInteger(nextStock) || nextStock < 0) {
    return res.status(400).json({ message: '재고는 0 이상의 정수여야 합니다.' });
  }

  run(
    `UPDATE products
     SET product_name = @product_name,
         description = @description,
         price = @price,
         discount_price = @discount_price,
         stock_quantity = @stock_quantity,
         status = @status,
         thumbnail_url = @thumbnail_url,
         barcode = @barcode,
         product_type = @product_type,
         tax_type = @tax_type,
         safety_stock = @safety_stock,
         cost_price = @cost_price,
         pos_sale_enabled = @pos_sale_enabled,
         brand = @brand,
         supply_days = @supply_days,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    {
      id: product.id,
      pharmacy_id: req.pharmacyId,
      brand,
      supply_days: supplyDays,
      product_name: next.product_name,
      description: next.description,
      price: Number(next.price),
      discount_price: next.discount_price ? Number(next.discount_price) : null,
      stock_quantity: nextStock,
      status: next.status,
      thumbnail_url: next.thumbnail_url,
      barcode,
      product_type: productType,
      tax_type: taxType,
      safety_stock: Math.max(0, optionalInt(next.safety_stock) || 0),
      cost_price: optionalInt(next.cost_price),
      pos_sale_enabled: next.pos_sale_enabled === false || Number(next.pos_sale_enabled) === 0 ? 0 : 1
    }
  );

  if (productType === 'OTC' && product.product_type !== 'OTC') {
    run('DELETE FROM carts WHERE product_id = @product_id', { product_id: product.id });
  }

  if (Number(product.stock_quantity) !== nextStock) {
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
        quantity_after: nextStock,
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
