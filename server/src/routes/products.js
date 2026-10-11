const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { ImportError, assertNotSyncing, onlineStockBuffer } = require('../services/product-import');
const { normalizeProductType, onlineSellableSql, resolveOnlineVisible } = require('../services/product-kind');

const router = express.Router();

function normalizeBarcode(value) {
  const barcode = String(value ?? '').trim();
  return barcode || null;
}

function posSaleFlag(value, current = 1) {
  if (value === undefined) return Number(current ?? 1) === 0 ? 0 : 1;
  return value === false || value === 'false' || Number(value) === 0 ? 0 : 1;
}

function idList(value) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new Error('상품을 선택해 주세요.');
  if (ids.length > 5000) throw new Error('한 번에 5,000개까지 바꿀 수 있습니다.');
  return ids;
}

function idParams(ids, params) {
  ids.forEach((id, index) => {
    params[`id${index}`] = id;
  });
  return ids.map((_, index) => `@id${index}`).join(',');
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

function publicProduct(
  { cost_price, supplier_id, safety_stock, pos_sale_enabled, online_visible, needs_review, external_code, ...product },
  buffer = 0
) {
  // 기존 POS와 병행 중이면 동기화 사이의 오차만큼 온라인에 덜 보여 준다.
  const stock = Math.max(0, Number(product.stock_quantity) - buffer);
  return {
    ...product,
    stock_quantity: stock,
    status: stock <= 0 && product.status === 'ON_SALE' ? 'SOLD_OUT' : product.status
  };
}

const MALL_VISIBLE_SQL = onlineSellableSql('p');

function syncBlocked(res, error) {
  if (error instanceof ImportError) return res.status(error.status).json({ message: error.message });
  throw error;
}

// 폐쇄몰: 그 약국의 승인된 회원만 상품을 본다. 약국 운영자·직원은 자기 약국, 본사 관리자는 모든 약국을 미리 볼 수 있다.
function mallPharmacy(req, res, next) {
  const pharmacy = getOne("SELECT id FROM pharmacies WHERE pharmacy_code = @code AND status = 'ACTIVE'", {
    code: req.query.pharmacyCode
  });
  const { role, pharmacy_id: userPharmacyId } = req.user;

  if (role === 'CUSTOMER') {
    const member = getOne('SELECT approval_status FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
      user_id: req.user.id,
      pharmacy_id: userPharmacyId
    });
    if (!member || member.approval_status !== 'APPROVED') {
      return res.status(403).json({ message: '약국에서 가입을 승인한 회원만 이용할 수 있습니다.' });
    }
  }
  if (role === 'ADMIN') {
    if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });
    req.mallPharmacyId = pharmacy.id;
    return next();
  }
  if (!['CUSTOMER', 'PHARMACY_OWNER', 'POS_STAFF'].includes(role)) {
    return res.status(403).json({ message: '이 약국몰 회원만 이용할 수 있습니다.' });
  }
  if (req.query.pharmacyCode && (!pharmacy || pharmacy.id !== userPharmacyId)) {
    return res.status(403).json({ message: '이 약국몰 회원만 이용할 수 있습니다. 이 약국에서 가입해 주세요.' });
  }
  req.mallPharmacyId = userPharmacyId;
  return next();
}

router.get('/mall', authenticate, mallPharmacy, (req, res) => {
  const products = getAll(
    `SELECT p.*, c.category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.pharmacy_id = @pharmacy_id AND ${MALL_VISIBLE_SQL}
     ORDER BY p.id DESC`,
    { pharmacy_id: req.mallPharmacyId }
  );
  const buffer = onlineStockBuffer(req.mallPharmacyId);
  res.json({ products: products.map((product) => publicProduct(product, buffer)) });
});

router.get('/mall/:id', authenticate, mallPharmacy, (req, res) => {
  const product = getOne(
    `SELECT p.*, c.category_name, ph.pharmacy_code, ph.pharmacy_name
     FROM products p
     JOIN pharmacies ph ON ph.id = p.pharmacy_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = @id AND p.pharmacy_id = @pharmacy_id AND ${MALL_VISIBLE_SQL}`,
    { id: Number(req.params.id), pharmacy_id: req.mallPharmacyId }
  );
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  res.json({ product: publicProduct(product, onlineStockBuffer(req.mallPharmacyId)) });
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
  let onlineVisible;
  let taxType;
  let brand;
  let supplyDays;
  try {
    barcode = normalizeBarcode(req.body.barcode);
    productType = normalizeProductType(req.body.product_type);
    onlineVisible = resolveOnlineVisible(productType, req.body.online_visible, 0);
    taxType = normalizeTaxType(req.body.tax_type);
    brand = normalizeBrand(req.body.brand);
    supplyDays = normalizeSupplyDays(req.body.supply_days);
    assertBarcodeAvailable(req.pharmacyId, barcode);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  if (Number(stock_quantity || 0) > 0) {
    try {
      assertNotSyncing(req.pharmacyId, '초기 재고 입력');
    } catch (error) {
      return syncBlocked(res, error);
    }
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
      online_visible, brand, supply_days
    ) VALUES (
      @pharmacy_id, @category_id, @product_name, @description, @price, @discount_price,
      @stock_quantity, @status, @thumbnail_url, @barcode, @product_type, @tax_type, @safety_stock, @cost_price, @pos_sale_enabled,
      @online_visible, @brand, @supply_days
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
      online_visible: onlineVisible,
      tax_type: taxType,
      safety_stock: Math.max(0, optionalInt(req.body.safety_stock) || 0),
      cost_price: optionalInt(req.body.cost_price),
      pos_sale_enabled: posSaleFlag(req.body.pos_sale_enabled)
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
  let onlineVisible;
  let taxType;
  let brand;
  let supplyDays;
  try {
    barcode = normalizeBarcode(next.barcode);
    productType = normalizeProductType(next.product_type, product.product_type);
    // 구분이 바뀌면 온라인 판매는 약국이 다시 켜야 한다.
    const currentOnline = productType === product.product_type ? product.online_visible : 0;
    onlineVisible = resolveOnlineVisible(productType, req.body.online_visible, currentOnline);
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
  if (Number(product.stock_quantity) !== nextStock) {
    try {
      assertNotSyncing(req.pharmacyId, '재고 수정');
    } catch (error) {
      return syncBlocked(res, error);
    }
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
         online_visible = @online_visible,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    {
      id: product.id,
      pharmacy_id: req.pharmacyId,
      online_visible: onlineVisible,
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
      pos_sale_enabled: posSaleFlag(req.body.pos_sale_enabled, product.pos_sale_enabled)
    }
  );

  if (productType !== 'GENERAL' && product.product_type === 'GENERAL') {
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

// 온라인 판매를 한꺼번에 켜거나 끈다. 일반 상품으로 분류된 상품만 켤 수 있다.
router.post('/bulk-visibility', (req, res) => {
  let ids;
  try {
    ids = idList(req.body.ids);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  const visible = req.body.online_visible === true || Number(req.body.online_visible) === 1 ? 1 : 0;
  const params = { pharmacy_id: req.pharmacyId, visible };
  const placeholders = idParams(ids, params);
  const result = run(
    `UPDATE products
     SET online_visible = @visible,
         updated_at = CURRENT_TIMESTAMP
     WHERE pharmacy_id = @pharmacy_id AND id IN (${placeholders})
       AND (@visible = 0 OR product_type = 'GENERAL')`,
    params
  );
  const skipped = visible
    ? getOne(
        `SELECT COUNT(*) AS count FROM products
         WHERE pharmacy_id = @pharmacy_id AND id IN (${placeholders}) AND product_type != 'GENERAL'`,
        params
      ).count
    : 0;
  res.json({ updated: result.changes, skipped });
});

// 분류 전 상품을 한꺼번에 분류한다. 분류가 바뀐 상품은 온라인 판매를 끄고, 약국이 확인한 뒤 따로 켠다.
router.post('/bulk-type', (req, res) => {
  let ids;
  let productType;
  try {
    ids = idList(req.body.ids);
    productType = normalizeProductType(req.body.product_type, null);
    if (!productType) throw new Error('바꿀 구분을 골라 주세요.');
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  const params = { pharmacy_id: req.pharmacyId, product_type: productType };
  const placeholders = idParams(ids, params);
  const updated = transaction(() => {
    const result = run(
      `UPDATE products
       SET product_type = @product_type,
           online_visible = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE pharmacy_id = @pharmacy_id AND id IN (${placeholders}) AND product_type != @product_type`,
      params
    );
    if (productType !== 'GENERAL') {
      run(
        `DELETE FROM carts WHERE product_id IN (
           SELECT id FROM products WHERE pharmacy_id = @pharmacy_id AND id IN (${placeholders})
         )`,
        params
      );
    }
    return result.changes;
  })();
  res.json({ updated });
});

router.delete('/:id', (req, res) => {
  run("UPDATE products SET status = 'HIDDEN', updated_at = CURRENT_TIMESTAMP WHERE id = @id AND pharmacy_id = @pharmacy_id", {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  res.json({ ok: true });
});

module.exports = router;
