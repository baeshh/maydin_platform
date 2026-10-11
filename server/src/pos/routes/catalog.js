const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { insertLot, lotLabel, parseLotInput } = require('../../services/lots');
const { assertNotSyncing } = require('../../services/product-import');
const { ProductKindError, normalizeProductType } = require('../../services/product-kind');
const { PosError, audit, cleanText, handle, parseMemberCode, requireOwner, toInt, won } = require('../common');
const { POS_PRODUCT_COLUMNS, assertBarcodeFree, getPosProduct, logStock, normalizeBarcode } = require('../services/inventory-service');

const router = express.Router();

router.get(
  '/products',
  handle((req) => {
    const query = String(req.query.query || '').trim();
    const categoryId = Number(req.query.category_id) || null;
    const conditions = ["p.pharmacy_id = @pharmacy_id", "p.status != 'HIDDEN'", 'COALESCE(p.pos_sale_enabled, 1) = 1'];
    if (query) conditions.push('(p.barcode = @query OR p.product_name LIKE @like OR p.barcode LIKE @like)');
    if (categoryId) conditions.push('p.category_id = @category_id');

    const products = getAll(
      `SELECT ${POS_PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE WHEN p.barcode = @query THEN 0 ELSE 1 END, p.product_name ASC
       LIMIT 80`,
      { pharmacy_id: req.pharmacyId, query, like: `%${query}%`, category_id: categoryId }
    );
    const exact = query ? products.find((product) => product.barcode === query) : null;
    return { products, exact_match_id: exact ? exact.id : null };
  })
);

router.get(
  '/scan',
  handle((req) => {
    const code = String(req.query.code || '').trim();
    if (!code) throw new PosError('스캔한 코드가 없습니다.');

    const product = getOne(
      `SELECT ${POS_PRODUCT_COLUMNS}
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.pharmacy_id = @pharmacy_id AND p.barcode = @code AND p.status != 'HIDDEN'`,
      { pharmacy_id: req.pharmacyId, code }
    );
    if (product) return { type: 'PRODUCT', code, product };

    const memberCode = parseMemberCode(code);
    if (memberCode) {
      const customer = getOne("SELECT id, name FROM customers WHERE pharmacy_id = @pharmacy_id AND member_code = @code AND approval_status = 'APPROVED'", {
        pharmacy_id: req.pharmacyId,
        code: memberCode
      });
      if (customer) return { type: 'CUSTOMER', code, customer_id: customer.id, customer_name: customer.name };
      return { type: 'UNKNOWN', code, message: '우리 약국 회원이 아니거나 없는 회원 코드입니다.' };
    }

    const order = getOne(
      `SELECT id, order_number, order_type, sales_channel FROM orders
       WHERE pharmacy_id = @pharmacy_id AND order_number = @code COLLATE NOCASE`,
      { pharmacy_id: req.pharmacyId, code }
    );
    if (order) {
      if (order.sales_channel === 'POS') return { type: 'SALE', code, order_id: order.id };
      if (order.order_type === 'PICKUP') return { type: 'PICKUP', code, order_id: order.id };
      return { type: 'ORDER', code, order_id: order.id, message: `${order.order_number}은(는) 온라인 주문입니다. 파트너센터에서 확인하세요.` };
    }

    const hidden = getOne(
      "SELECT product_name FROM products WHERE pharmacy_id = @pharmacy_id AND barcode = @code AND status = 'HIDDEN'",
      { pharmacy_id: req.pharmacyId, code }
    );
    if (hidden) return { type: 'UNKNOWN', code, message: `"${hidden.product_name}"은(는) 숨김 처리된 상품입니다. 파트너센터에서 판매 상태를 바꿔 주세요.` };

    return { type: 'UNKNOWN', code, registrable: /^[0-9A-Za-z-]{4,64}$/.test(code) };
  })
);

router.post(
  '/products/quick',
  handle((req, res) => {
    requireOwner(req, '상품 등록');
    const productName = cleanText(req.body.product_name, 100);
    if (!productName) throw new PosError('상품명을 입력해 주세요.');
    const price = toInt(req.body.price, '판매가', { min: 0, max: 10000000 });
    const stock = toInt(req.body.stock_quantity ?? 0, '재고', { min: 0, max: 100000 });
    const safetyStock = toInt(req.body.safety_stock ?? 0, '안전재고', { min: 0, max: 100000 });
    if (stock > 0) assertNotSyncing(req.pharmacyId, '초기 재고 입력');
    let productType;
    try {
      productType = normalizeProductType(req.body.product_type);
    } catch (error) {
      if (error instanceof ProductKindError) throw new PosError(error.message);
      throw error;
    }
    const taxType = String(req.body.tax_type || 'TAXABLE').toUpperCase();
    if (!['TAXABLE', 'EXEMPT'].includes(taxType)) throw new PosError('과세 구분이 올바르지 않습니다.');
    const barcode = normalizeBarcode(req.body.barcode);
    if (!barcode) throw new PosError('바코드를 입력해 주세요.');
    const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
    const lot = stock > 0 ? parseLotInput(req.body) : null;

    const product = transaction(() => {
      assertBarcodeFree(req.pharmacyId, barcode);
      if (categoryId) {
        const category = getOne('SELECT id FROM categories WHERE id = @id AND pharmacy_id = @pharmacy_id', {
          id: categoryId,
          pharmacy_id: req.pharmacyId
        });
        if (!category) throw new PosError('카테고리를 찾을 수 없습니다.');
      }
      const result = run(
        `INSERT INTO products (
          pharmacy_id, category_id, product_name, price, stock_quantity, status, barcode, product_type, tax_type, safety_stock,
          pos_sale_enabled, online_visible
        ) VALUES (
          @pharmacy_id, @category_id, @product_name, @price, @stock, @status, @barcode, @product_type, @tax_type, @safety_stock, 1, 0
        )`,
        {
          pharmacy_id: req.pharmacyId,
          category_id: categoryId,
          product_name: productName,
          price,
          stock,
          status: stock > 0 ? 'ON_SALE' : 'SOLD_OUT',
          barcode,
          product_type: productType,
          tax_type: taxType,
          safety_stock: safetyStock
        }
      );
      const id = result.lastInsertRowid;
      if (stock > 0) {
        insertLot({ pharmacyId: req.pharmacyId, productId: id, quantity: stock, lot, userId: req.user.id });
        logStock(req, id, 0, stock, 'RECEIVE', lot ? `POS 신규 등록 입고 · ${lotLabel(lot)}` : 'POS 신규 등록 입고');
      }
      audit(req, 'POS_PRODUCT_CREATE', 'PRODUCT', id, `POS 신규 상품 등록 · ${productName} · ${won(price)} · 바코드 ${barcode}`);
      return getPosProduct(req.pharmacyId, id);
    })();

    res.status(201);
    return { product };
  })
);

router.post(
  '/products/:id/barcode',
  handle((req) => {
    requireOwner(req, '바코드 연결');
    const barcode = normalizeBarcode(req.body.barcode);
    if (!barcode) throw new PosError('바코드를 입력해 주세요.');
    const product = transaction(() => {
      const current = getOne("SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'", {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!current) throw new PosError('상품을 찾을 수 없습니다.', 404);
      assertBarcodeFree(req.pharmacyId, barcode, current.id);
      run('UPDATE products SET barcode = @barcode, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: current.id, barcode });
      audit(
        req,
        'POS_BARCODE_LINK',
        'PRODUCT',
        current.id,
        `바코드 연결 · ${current.product_name} · ${current.barcode ? `${current.barcode} → ` : ''}${barcode}`
      );
      return getPosProduct(req.pharmacyId, current.id);
    })();
    return { product };
  })
);

module.exports = router;
