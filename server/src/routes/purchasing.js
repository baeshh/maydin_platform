const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { LotError, parseLotInput, insertLot, lotLabel } = require('../services/lots');

const router = express.Router();

const PO_STATUS_LABELS = {
  DRAFT: '작성 중',
  ORDERED: '발주 완료',
  PARTIAL: '부분 입고',
  RECEIVED: '입고 완료',
  CLOSED: '입고 종료',
  CANCELLED: '취소'
};
const OPEN_PO_STATUSES = "('DRAFT', 'ORDERED', 'PARTIAL')";
const LOW_STOCK_SQL = "(p.stock_quantity <= 0 OR (COALESCE(p.safety_stock, 0) > 0 AND p.stock_quantity <= p.safety_stock))";
const DEFAULT_REORDER_QUANTITY = 10;
const MAX_PO_ITEMS = 200;

class PurchaseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof PurchaseError || error instanceof LotError) {
        return res.status(error.status).json({ message: error.message });
      }
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(400).json({ message: error.message });
      }
      console.error(error);
      return res.status(500).json({ message: '발주 처리 중 오류가 발생했습니다.' });
    }
  };
}

function cleanText(value, maxLength = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function toInt(value, label, { min = 0, max = 100000000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PurchaseError(`${label}이(가) 올바르지 않습니다.`);
  }
  return number;
}

function audit(req, action, targetType, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, @target_type, @target_id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.pharmacyId, action, target_type: targetType, target_id: targetId, description }
  );
}

function requireOwner(req, action) {
  if (req.user.role !== 'PHARMACY_OWNER') throw new PurchaseError(`${action}은(는) 약국 관리자만 처리할 수 있습니다.`, 403);
}

router.use(authenticate, requireRole('PHARMACY_OWNER', 'POS_STAFF'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  req.pharmacyId = req.user.pharmacy_id;
  return next();
});

/* ---------- 거래처 ---------- */

const SUPPLIER_COLUMNS = `s.*,
  (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.status != 'HIDDEN') AS product_count,
  (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ${OPEN_PO_STATUSES}) AS open_order_count,
  (SELECT MAX(po.ordered_at) FROM purchase_orders po WHERE po.supplier_id = s.id) AS last_ordered_at`;

function findSupplier(pharmacyId, id) {
  return getOne(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.id = @id AND s.pharmacy_id = @pharmacy_id`, {
    id: Number(id),
    pharmacy_id: pharmacyId
  });
}

function parseSupplier(body, current = {}) {
  const pick = (key, max) => (body[key] === undefined ? current[key] ?? null : cleanText(body[key], max));
  const name = pick('name', 60);
  if (!name) throw new PurchaseError('거래처 이름을 입력해 주세요.');
  let businessNumber = pick('business_number', 20);
  if (businessNumber) {
    const digits = businessNumber.replace(/\D/g, '');
    if (digits.length !== 10) throw new PurchaseError('사업자등록번호는 숫자 10자리로 입력해 주세요.');
    businessNumber = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
  }
  const email = pick('email', 100);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PurchaseError('거래처 이메일 형식이 올바르지 않습니다.');
  const status = body.status === undefined ? current.status || 'ACTIVE' : String(body.status).toUpperCase();
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new PurchaseError('거래처 상태가 올바르지 않습니다.');
  return {
    name,
    business_number: businessNumber,
    contact_name: pick('contact_name', 40),
    phone: pick('phone', 20),
    email,
    memo: pick('memo', 200),
    status
  };
}

function assertNameFree(pharmacyId, name, exceptId = 0) {
  const taken = getOne('SELECT id FROM suppliers WHERE pharmacy_id = @pharmacy_id AND name = @name AND id != @except', {
    pharmacy_id: pharmacyId,
    name,
    except: exceptId
  });
  if (taken) throw new PurchaseError('같은 이름의 거래처가 이미 있습니다.', 409);
}

router.get(
  '/suppliers',
  handle((req) => ({
    suppliers: getAll(
      `SELECT ${SUPPLIER_COLUMNS} FROM suppliers s WHERE s.pharmacy_id = @pharmacy_id
       ORDER BY CASE WHEN s.status = 'ACTIVE' THEN 0 ELSE 1 END, s.name ASC`,
      { pharmacy_id: req.pharmacyId }
    )
  }))
);

router.post(
  '/suppliers',
  handle((req, res) => {
    requireOwner(req, '거래처 등록');
    const data = parseSupplier(req.body);
    const supplier = transaction(() => {
      assertNameFree(req.pharmacyId, data.name);
      const result = run(
        `INSERT INTO suppliers (pharmacy_id, name, business_number, contact_name, phone, email, memo, status)
         VALUES (@pharmacy_id, @name, @business_number, @contact_name, @phone, @email, @memo, @status)`,
        { pharmacy_id: req.pharmacyId, ...data }
      );
      audit(req, 'SUPPLIER_CREATE', 'SUPPLIER', result.lastInsertRowid, `거래처 등록 · ${data.name}`);
      return findSupplier(req.pharmacyId, result.lastInsertRowid);
    })();
    res.status(201);
    return { supplier };
  })
);

router.patch(
  '/suppliers/:id',
  handle((req) => {
    requireOwner(req, '거래처 수정');
    const current = findSupplier(req.pharmacyId, req.params.id);
    if (!current) throw new PurchaseError('거래처를 찾을 수 없습니다.', 404);
    const data = parseSupplier(req.body, current);
    const supplier = transaction(() => {
      assertNameFree(req.pharmacyId, data.name, current.id);
      run(
        `UPDATE suppliers SET name = @name, business_number = @business_number, contact_name = @contact_name, phone = @phone,
           email = @email, memo = @memo, status = @status, updated_at = CURRENT_TIMESTAMP
         WHERE id = @id`,
        { id: current.id, ...data }
      );
      const statusNote = current.status !== data.status ? ` · ${data.status === 'ACTIVE' ? '거래 재개' : '거래 중지'}` : '';
      audit(req, 'SUPPLIER_UPDATE', 'SUPPLIER', current.id, `거래처 수정 · ${data.name}${statusNote}`);
      return findSupplier(req.pharmacyId, current.id);
    })();
    return { supplier };
  })
);

router.patch(
  '/products/:id/supplier',
  handle((req) => {
    requireOwner(req, '기본 거래처 지정');
    const product = getOne("SELECT id, product_name FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'", {
      id: Number(req.params.id),
      pharmacy_id: req.pharmacyId
    });
    if (!product) throw new PurchaseError('상품을 찾을 수 없습니다.', 404);
    let supplier = null;
    if (req.body.supplier_id) {
      supplier = findSupplier(req.pharmacyId, req.body.supplier_id);
      if (!supplier) throw new PurchaseError('거래처를 찾을 수 없습니다.', 404);
    }
    run('UPDATE products SET supplier_id = @supplier_id, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
      id: product.id,
      supplier_id: supplier ? supplier.id : null
    });
    return { product_id: product.id, supplier_id: supplier ? supplier.id : null };
  })
);

/* ---------- 발주 추천 ---------- */

function incomingSql(alias = 'p') {
  return `(SELECT COALESCE(SUM(i.quantity - i.received_quantity), 0)
    FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
    WHERE i.product_id = ${alias}.id AND po.status IN ${OPEN_PO_STATUSES})`;
}

function reorderSuggestions(pharmacyId) {
  const rows = getAll(
    `SELECT p.id AS product_id, p.product_name, p.barcode, p.product_type, p.stock_quantity,
            COALESCE(p.safety_stock, 0) AS safety_stock, ${incomingSql()} AS incoming,
            COALESCE(p.cost_price,
              (SELECT i.unit_cost FROM purchase_order_items i JOIN purchase_orders po ON po.id = i.purchase_order_id
               WHERE i.product_id = p.id AND po.status != 'CANCELLED' ORDER BY i.id DESC LIMIT 1), 0) AS unit_cost,
            COALESCE(ps.id,
              (SELECT po.supplier_id FROM purchase_order_items i
               JOIN purchase_orders po ON po.id = i.purchase_order_id
               JOIN suppliers s2 ON s2.id = po.supplier_id AND s2.status = 'ACTIVE'
               WHERE i.product_id = p.id AND po.status != 'CANCELLED' ORDER BY po.id DESC LIMIT 1)) AS supplier_id
     FROM products p
     LEFT JOIN suppliers ps ON ps.id = p.supplier_id AND ps.status = 'ACTIVE'
     WHERE p.pharmacy_id = @pharmacy_id AND p.status NOT IN ('HIDDEN', 'STOPPED') AND ${LOW_STOCK_SQL}
     ORDER BY p.stock_quantity <= 0 DESC, p.product_name ASC`,
    { pharmacy_id: pharmacyId }
  );
  const supplierNames = Object.fromEntries(
    getAll('SELECT id, name FROM suppliers WHERE pharmacy_id = @pharmacy_id', { pharmacy_id: pharmacyId }).map((s) => [s.id, s.name])
  );
  return rows
    .map((row) => {
      const target = row.safety_stock > 0 ? row.safety_stock * 2 : DEFAULT_REORDER_QUANTITY;
      return {
        ...row,
        target_quantity: target,
        suggested_quantity: target - row.stock_quantity - row.incoming,
        supplier_name: row.supplier_id ? supplierNames[row.supplier_id] || null : null
      };
    })
    .filter((row) => row.suggested_quantity > 0);
}

router.get(
  '/suggestions',
  handle((req) => ({
    suggestions: reorderSuggestions(req.pharmacyId),
    rule: `안전재고의 2배까지 채우는 수량에서 진행 중인 발주 수량을 뺍니다. 안전재고를 정하지 않은 품절 상품은 ${DEFAULT_REORDER_QUANTITY}개를 제안합니다.`
  }))
);

/* ---------- 발주서 ---------- */

const PO_LIST_COLUMNS = `po.*, s.name AS supplier_name, u.name AS created_by_name,
  (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS item_count,
  (SELECT COALESCE(SUM(i.quantity), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS total_quantity,
  (SELECT COALESCE(SUM(i.received_quantity), 0) FROM purchase_order_items i WHERE i.purchase_order_id = po.id) AS received_quantity`;

function findOrder(pharmacyId, id) {
  return getOne(
    `SELECT ${PO_LIST_COLUMNS} FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN users u ON u.id = po.created_by
     WHERE po.id = @id AND po.pharmacy_id = @pharmacy_id`,
    { id: Number(id), pharmacy_id: pharmacyId }
  );
}

function orderDetail(pharmacyId, id) {
  const order = findOrder(pharmacyId, id);
  if (!order) return null;
  const items = getAll(
    `SELECT i.*, p.stock_quantity, COALESCE(p.safety_stock, 0) AS safety_stock
     FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     WHERE i.purchase_order_id = @id ORDER BY i.id ASC`,
    { id: order.id }
  );
  const receipts = getAll(
    `SELECT l.id, l.product_id, p.product_name, l.quantity_after - l.quantity_before AS quantity, l.reason, l.created_at,
            u.name AS created_by_name
     FROM inventory_logs l JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.created_by
     WHERE l.reference_type = 'PURCHASE_ORDER' AND l.reference_id = @id
     ORDER BY l.id DESC`,
    { id: order.id }
  );
  const supplier = getOne('SELECT * FROM suppliers WHERE id = @id', { id: order.supplier_id });
  const pharmacy = getOne('SELECT pharmacy_name, business_number, phone, address FROM pharmacies WHERE id = @id', { id: pharmacyId });
  return { order, items, receipts, supplier, pharmacy };
}

function nextPoNumber(pharmacyId) {
  const { today } = getOne("SELECT strftime('%Y%m%d', 'now', 'localtime') AS today");
  const prefix = `PO-${today}-`;
  const last = getOne(
    'SELECT po_number FROM purchase_orders WHERE pharmacy_id = @pharmacy_id AND po_number LIKE @like ORDER BY po_number DESC LIMIT 1',
    { pharmacy_id: pharmacyId, like: `${prefix}%` }
  );
  const seq = last ? Number(last.po_number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

function parseItems(pharmacyId, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new PurchaseError('발주할 상품을 한 개 이상 넣어 주세요.');
  if (rawItems.length > MAX_PO_ITEMS) throw new PurchaseError(`발주서 한 장에는 상품을 ${MAX_PO_ITEMS}개까지 넣을 수 있습니다.`);
  const seen = new Set();
  return rawItems.map((raw) => {
    const product = getOne(
      "SELECT id, product_name, barcode FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'",
      { id: Number(raw.product_id), pharmacy_id: pharmacyId }
    );
    if (!product) throw new PurchaseError('발주할 수 없는 상품이 포함되어 있습니다.', 404);
    if (seen.has(product.id)) throw new PurchaseError(`${product.product_name} 상품이 중복으로 들어 있습니다.`);
    seen.add(product.id);
    return {
      product,
      quantity: toInt(raw.quantity, `${product.product_name} 발주 수량`, { min: 1, max: 100000 }),
      unit_cost: toInt(raw.unit_cost ?? 0, `${product.product_name} 매입 단가`, { min: 0, max: 100000000 })
    };
  });
}

function parseExpectedDate(value) {
  const date = cleanText(value, 10);
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new PurchaseError('입고 예정일 형식이 올바르지 않습니다. (YYYY-MM-DD)');
  }
  return date;
}

function writeItems(orderId, items) {
  run('DELETE FROM purchase_order_items WHERE purchase_order_id = @id', { id: orderId });
  for (const item of items) {
    run(
      `INSERT INTO purchase_order_items (purchase_order_id, product_id, product_name, barcode, quantity, unit_cost)
       VALUES (@order_id, @product_id, @product_name, @barcode, @quantity, @unit_cost)`,
      {
        order_id: orderId,
        product_id: item.product.id,
        product_name: item.product.product_name,
        barcode: item.product.barcode || null,
        quantity: item.quantity,
        unit_cost: item.unit_cost
      }
    );
  }
  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0);
  run('UPDATE purchase_orders SET total_amount = @total, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: orderId, total });
  return total;
}

function rememberSupplier(items, supplierId) {
  for (const item of items) {
    run('UPDATE products SET supplier_id = @supplier_id WHERE id = @id AND supplier_id IS NULL', {
      id: item.product.id,
      supplier_id: supplierId
    });
  }
}

function activeSupplier(pharmacyId, id) {
  const supplier = findSupplier(pharmacyId, id);
  if (!supplier) throw new PurchaseError('거래처를 선택해 주세요.', 404);
  if (supplier.status !== 'ACTIVE') throw new PurchaseError('거래 중지된 거래처에는 발주할 수 없습니다.');
  return supplier;
}

function createDraft(req, { supplier, items, memo = null, expectedDate = null, auto = false }) {
  const poNumber = nextPoNumber(req.pharmacyId);
  const result = run(
    `INSERT INTO purchase_orders (pharmacy_id, supplier_id, po_number, expected_date, memo, created_by)
     VALUES (@pharmacy_id, @supplier_id, @po_number, @expected_date, @memo, @user_id)`,
    { pharmacy_id: req.pharmacyId, supplier_id: supplier.id, po_number: poNumber, expected_date: expectedDate, memo, user_id: req.user.id }
  );
  const total = writeItems(result.lastInsertRowid, items);
  rememberSupplier(items, supplier.id);
  audit(
    req,
    'PO_CREATE',
    'PURCHASE_ORDER',
    result.lastInsertRowid,
    `발주서 작성${auto ? ' (자동)' : ''} · ${poNumber} · ${supplier.name} · ${items.length}품목 · ${total.toLocaleString('ko-KR')}원`
  );
  return result.lastInsertRowid;
}

router.get(
  '/orders',
  handle((req) => {
    const status = String(req.query.status || '').toUpperCase();
    const conditions = ['po.pharmacy_id = @pharmacy_id'];
    if (status === 'OPEN') conditions.push(`po.status IN ${OPEN_PO_STATUSES}`);
    else if (PO_STATUS_LABELS[status]) conditions.push('po.status = @status');
    const orders = getAll(
      `SELECT ${PO_LIST_COLUMNS} FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users u ON u.id = po.created_by
       WHERE ${conditions.join(' AND ')}
       ORDER BY CASE po.status WHEN 'PARTIAL' THEN 0 WHEN 'ORDERED' THEN 1 WHEN 'DRAFT' THEN 2 ELSE 3 END, po.id DESC
       LIMIT 200`,
      { pharmacy_id: req.pharmacyId, status }
    );
    return { orders, status_labels: PO_STATUS_LABELS };
  })
);

router.get(
  '/orders/:id',
  handle((req) => {
    const detail = orderDetail(req.pharmacyId, req.params.id);
    if (!detail) throw new PurchaseError('발주서를 찾을 수 없습니다.', 404);
    return { ...detail, status_labels: PO_STATUS_LABELS };
  })
);

router.post(
  '/orders',
  handle((req, res) => {
    requireOwner(req, '발주서 작성');
    const id = transaction(() => {
      const supplier = activeSupplier(req.pharmacyId, req.body.supplier_id);
      const items = parseItems(req.pharmacyId, req.body.items);
      return createDraft(req, {
        supplier,
        items,
        memo: cleanText(req.body.memo),
        expectedDate: parseExpectedDate(req.body.expected_date)
      });
    })();
    res.status(201);
    return orderDetail(req.pharmacyId, id);
  })
);

router.post(
  '/orders/auto',
  handle((req, res) => {
    requireOwner(req, '발주서 자동 작성');
    const result = transaction(() => {
      const suggestions = reorderSuggestions(req.pharmacyId);
      const groups = new Map();
      let skipped = 0;
      for (const row of suggestions) {
        if (!row.supplier_id) {
          skipped += 1;
          continue;
        }
        if (!groups.has(row.supplier_id)) groups.set(row.supplier_id, []);
        groups.get(row.supplier_id).push(row);
      }
      const created = [];
      for (const [supplierId, rows] of groups) {
        const supplier = activeSupplier(req.pharmacyId, supplierId);
        const items = parseItems(
          req.pharmacyId,
          rows.map((row) => ({ product_id: row.product_id, quantity: row.suggested_quantity, unit_cost: row.unit_cost }))
        );
        created.push(createDraft(req, { supplier, items, memo: '안전재고 기준 자동 작성', auto: true }));
      }
      return { created, skipped };
    })();
    if (result.created.length === 0 && result.skipped === 0) throw new PurchaseError('발주가 필요한 상품이 없습니다.');
    res.status(201);
    return {
      orders: result.created.map((id) => findOrder(req.pharmacyId, id)),
      skipped_without_supplier: result.skipped
    };
  })
);

function lockOrder(req, allowed, action) {
  const order = findOrder(req.pharmacyId, req.params.id);
  if (!order) throw new PurchaseError('발주서를 찾을 수 없습니다.', 404);
  if (!allowed.includes(order.status)) {
    throw new PurchaseError(`${PO_STATUS_LABELS[order.status]} 상태의 발주서는 ${action}할 수 없습니다.`, 409);
  }
  return order;
}

router.patch(
  '/orders/:id',
  handle((req) => {
    requireOwner(req, '발주서 수정');
    transaction(() => {
      const order = lockOrder(req, ['DRAFT'], '수정');
      const supplier = req.body.supplier_id ? activeSupplier(req.pharmacyId, req.body.supplier_id) : null;
      const memo = req.body.memo === undefined ? order.memo : cleanText(req.body.memo);
      const expected = req.body.expected_date === undefined ? order.expected_date : parseExpectedDate(req.body.expected_date);
      run(
        `UPDATE purchase_orders SET supplier_id = @supplier_id, memo = @memo, expected_date = @expected_date,
           updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
        { id: order.id, supplier_id: supplier ? supplier.id : order.supplier_id, memo, expected_date: expected }
      );
      let total = order.total_amount;
      if (req.body.items !== undefined) {
        const items = parseItems(req.pharmacyId, req.body.items);
        total = writeItems(order.id, items);
      }
      audit(req, 'PO_UPDATE', 'PURCHASE_ORDER', order.id, `발주서 수정 · ${order.po_number} · ${total.toLocaleString('ko-KR')}원`);
    })();
    return orderDetail(req.pharmacyId, req.params.id);
  })
);

router.post(
  '/orders/:id/confirm',
  handle((req) => {
    requireOwner(req, '발주 확정');
    transaction(() => {
      const order = lockOrder(req, ['DRAFT'], '확정');
      activeSupplier(req.pharmacyId, order.supplier_id);
      if (order.item_count === 0) throw new PurchaseError('발주할 상품이 없습니다.');
      run(
        `UPDATE purchase_orders SET status = 'ORDERED', ordered_at = CURRENT_TIMESTAMP, ordered_by = @user_id,
           updated_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'DRAFT'`,
        { id: order.id, user_id: req.user.id }
      );
      audit(req, 'PO_CONFIRM', 'PURCHASE_ORDER', order.id, `발주 확정 · ${order.po_number} · ${order.supplier_name} · ${order.total_amount.toLocaleString('ko-KR')}원`);
    })();
    return orderDetail(req.pharmacyId, req.params.id);
  })
);

router.post(
  '/orders/:id/cancel',
  handle((req) => {
    requireOwner(req, '발주 취소');
    transaction(() => {
      const order = lockOrder(req, ['DRAFT', 'ORDERED'], '취소');
      if (order.received_quantity > 0) throw new PurchaseError('입고된 상품이 있는 발주서는 취소 대신 입고 종료해 주세요.', 409);
      const reason = cleanText(req.body.reason) || (order.status === 'DRAFT' ? '작성 취소' : null);
      if (!reason) throw new PurchaseError('발주 취소 사유를 입력해 주세요.');
      run(
        `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancel_reason = @reason,
           updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
        { id: order.id, reason }
      );
      audit(req, 'PO_CANCEL', 'PURCHASE_ORDER', order.id, `발주 취소 · ${order.po_number} · 사유: ${reason}`);
    })();
    return orderDetail(req.pharmacyId, req.params.id);
  })
);

router.post(
  '/orders/:id/close',
  handle((req) => {
    requireOwner(req, '입고 종료');
    transaction(() => {
      const order = lockOrder(req, ['PARTIAL'], '입고 종료');
      const reason = cleanText(req.body.reason);
      if (!reason) throw new PurchaseError('남은 수량을 받지 않는 사유를 입력해 주세요.');
      run(
        `UPDATE purchase_orders SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, cancel_reason = @reason,
           updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
        { id: order.id, reason }
      );
      audit(
        req,
        'PO_CLOSE',
        'PURCHASE_ORDER',
        order.id,
        `입고 종료 · ${order.po_number} · ${order.received_quantity}/${order.total_quantity}개 입고 · 사유: ${reason}`
      );
    })();
    return orderDetail(req.pharmacyId, req.params.id);
  })
);

router.post(
  '/orders/:id/receive',
  handle((req, res) => {
    const lines = Array.isArray(req.body.items) ? req.body.items : [];
    transaction(() => {
      const order = lockOrder(req, ['ORDERED', 'PARTIAL'], '입고');
      const received = [];
      for (const line of lines) {
        const quantity = toInt(line.quantity ?? 0, '입고 수량', { min: 0, max: 100000 });
        if (quantity === 0) continue;
        const item = getOne('SELECT * FROM purchase_order_items WHERE id = @id AND purchase_order_id = @order_id', {
          id: Number(line.item_id),
          order_id: order.id
        });
        if (!item) throw new PurchaseError('발주서에 없는 상품입니다.', 404);
        const remaining = item.quantity - item.received_quantity;
        if (quantity > remaining) {
          throw new PurchaseError(`${item.product_name}: 남은 발주 수량(${remaining}개)보다 많이 입고할 수 없습니다.`);
        }
        const unitCost = line.unit_cost === undefined || line.unit_cost === '' || line.unit_cost === null
          ? item.unit_cost
          : toInt(line.unit_cost, `${item.product_name} 매입 단가`, { min: 0, max: 100000000 });
        const lot = parseLotInput(line);
        const product = getOne('SELECT id, stock_quantity FROM products WHERE id = @id', { id: item.product_id });
        const before = product.stock_quantity;
        const after = before + quantity;

        run(
          `UPDATE products
           SET stock_quantity = @after,
               status = CASE WHEN status = 'SOLD_OUT' THEN 'ON_SALE' ELSE status END,
               cost_price = CASE WHEN @unit_cost > 0 THEN @unit_cost ELSE cost_price END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = @id AND stock_quantity = @before`,
          { id: product.id, before, after, unit_cost: unitCost }
        );
        run(
          'UPDATE purchase_order_items SET received_quantity = received_quantity + @quantity WHERE id = @id',
          { id: item.id, quantity }
        );
        if (lot) {
          insertLot({
            pharmacyId: req.pharmacyId,
            productId: product.id,
            quantity,
            lot,
            unitCost: unitCost || null,
            supplierId: order.supplier_id,
            purchaseOrderId: order.id,
            userId: req.user.id
          });
        }
        const reason = [`발주 입고 ${order.po_number}`, order.supplier_name, lotLabel(lot)].filter(Boolean).join(' · ');
        run(
          `INSERT INTO inventory_logs (
             pharmacy_id, product_id, change_type, quantity_before, quantity_after, reason, created_by, reference_type, reference_id
           ) VALUES (@pharmacy_id, @product_id, 'RECEIVE', @before, @after, @reason, @user_id, 'PURCHASE_ORDER', @order_id)`,
          { pharmacy_id: req.pharmacyId, product_id: product.id, before, after, reason, user_id: req.user.id, order_id: order.id }
        );
        received.push(`${item.product_name} ${quantity}개`);
      }
      if (received.length === 0) throw new PurchaseError('입고 수량을 한 개 이상 입력해 주세요.');

      const { open } = getOne(
        'SELECT COUNT(*) AS open FROM purchase_order_items WHERE purchase_order_id = @id AND received_quantity < quantity',
        { id: order.id }
      );
      const nextStatus = open === 0 ? 'RECEIVED' : 'PARTIAL';
      run(
        `UPDATE purchase_orders SET status = @status,
           received_at = CASE WHEN @status = 'RECEIVED' THEN CURRENT_TIMESTAMP ELSE received_at END,
           updated_at = CURRENT_TIMESTAMP WHERE id = @id`,
        { id: order.id, status: nextStatus }
      );
      audit(
        req,
        'PO_RECEIVE',
        'PURCHASE_ORDER',
        order.id,
        `발주 입고 · ${order.po_number} · ${received.join(', ')} · ${PO_STATUS_LABELS[nextStatus]}`
      );
    })();
    res.status(201);
    return orderDetail(req.pharmacyId, req.params.id);
  })
);

module.exports = router;
