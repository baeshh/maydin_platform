const express = require('express');
const { getAll, getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const REQUEST_STATUSES = { OPEN: '접수', ORDERED: '발주함', STOCKED: '입고 완료', REJECTED: '취급 안 함' };
const ALERT_STATUSES = { WAITING: '입고 대기', NOTIFIED: '안내 완료', DONE: '완료', CANCELED: '취소' };
const MAX_OPEN_REQUESTS = 10;
const SEARCH_THROTTLE_MS = 10 * 60 * 1000;
const recentSearches = new Map();

function customerOf(req) {
  if (req.user?.role !== 'CUSTOMER') return null;
  return getOne('SELECT id, pharmacy_id FROM customers WHERE user_id = @user_id', { user_id: req.user.id });
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isAvailable(product) {
  return product.status === 'ON_SALE' && Number(product.stock_quantity) > 0;
}

function throttled(key) {
  const now = Date.now();
  if (recentSearches.size > 5000) {
    for (const [k, at] of recentSearches) if (now - at > SEARCH_THROTTLE_MS) recentSearches.delete(k);
  }
  const last = recentSearches.get(key);
  recentSearches.set(key, now);
  return last && now - last < SEARCH_THROTTLE_MS;
}

/* ---------- 결과 없는 검색어 ---------- */

// 숫자만 있는 검색어(바코드·전화번호일 수 있음)는 기록하지 않는다.
router.post('/search-miss', authenticate, requireRole('CUSTOMER', 'PHARMACY_OWNER', 'POS_STAFF'), (req, res) => {
  const query = cleanText(req.body.query, 40).toLowerCase();
  if (query.length < 2 || !/[^\d\s-]/.test(query)) return res.json({ ok: true, recorded: false });

  let pharmacyId;
  let source;
  let customerId = null;
  if (req.user.role === 'CUSTOMER') {
    const customer = customerOf(req);
    if (!customer) return res.status(403).json({ message: '이 약국몰 회원만 이용할 수 있습니다.' });
    pharmacyId = customer.pharmacy_id;
    customerId = customer.id;
    source = 'STORE';
  } else {
    pharmacyId = req.user.pharmacy_id;
    source = 'POS';
  }
  if (!pharmacyId) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  if (throttled(`${pharmacyId}|${source}|${query}|${customerId || req.user.id}`)) return res.json({ ok: true, recorded: false });

  run('INSERT INTO search_misses (pharmacy_id, query, source, customer_id) VALUES (@pharmacy_id, @query, @source, @customer_id)', {
    pharmacy_id: pharmacyId,
    query,
    source,
    customer_id: customerId
  });
  return res.json({ ok: true, recorded: true });
});

/* ---------- 고객: 입고 알림 · 상품 요청 ---------- */

const customerRouter = express.Router();
customerRouter.use(authenticate, requireRole('CUSTOMER'), (req, res, next) => {
  req.customer = customerOf(req);
  if (!req.customer) return res.status(404).json({ message: '고객 정보를 찾을 수 없습니다.' });
  return next();
});

function myAlerts(customerId) {
  return getAll(
    `SELECT a.id, a.product_id, a.status, a.created_at, a.notified_at,
            p.product_name, p.thumbnail_url, p.status AS product_status, p.stock_quantity, p.price, p.discount_price
     FROM restock_alerts a JOIN products p ON p.id = a.product_id
     WHERE a.customer_id = @customer_id AND a.status IN ('WAITING', 'NOTIFIED')
     ORDER BY a.id DESC`,
    { customer_id: customerId }
  ).map(({ product_status, stock_quantity, ...row }) => ({ ...row, available: product_status === 'ON_SALE' && stock_quantity > 0 }));
}

customerRouter.get('/restock-alerts', (req, res) => {
  res.json({ alerts: myAlerts(req.customer.id), statuses: ALERT_STATUSES });
});

customerRouter.post('/restock-alerts', (req, res) => {
  const product = getOne(
    "SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id AND status != 'HIDDEN'",
    { id: Number(req.body.product_id), pharmacy_id: req.customer.pharmacy_id }
  );
  if (!product || product.product_type === 'OTC') return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  if (isAvailable(product)) return res.status(400).json({ message: '지금 구매할 수 있는 상품입니다.' });
  const existing = getOne("SELECT id FROM restock_alerts WHERE customer_id = @customer_id AND product_id = @product_id AND status = 'WAITING'", {
    customer_id: req.customer.id,
    product_id: product.id
  });
  if (!existing) {
    run('INSERT INTO restock_alerts (pharmacy_id, product_id, customer_id) VALUES (@pharmacy_id, @product_id, @customer_id)', {
      pharmacy_id: req.customer.pharmacy_id,
      product_id: product.id,
      customer_id: req.customer.id
    });
  }
  return res.status(existing ? 200 : 201).json({ alerts: myAlerts(req.customer.id) });
});

customerRouter.delete('/restock-alerts/:id', (req, res) => {
  const result = run(
    `UPDATE restock_alerts SET status = 'CANCELED', closed_at = CURRENT_TIMESTAMP
     WHERE id = @id AND customer_id = @customer_id AND status IN ('WAITING', 'NOTIFIED')`,
    { id: Number(req.params.id), customer_id: req.customer.id }
  );
  if (!result.changes) return res.status(404).json({ message: '입고 알림을 찾을 수 없습니다.' });
  return res.json({ alerts: myAlerts(req.customer.id) });
});

function myRequests(customerId) {
  return getAll(
    `SELECT id, product_name, memo, status, reply, created_at, handled_at
     FROM product_requests WHERE customer_id = @customer_id ORDER BY id DESC LIMIT 30`,
    { customer_id: customerId }
  );
}

customerRouter.get('/product-requests', (req, res) => {
  res.json({ requests: myRequests(req.customer.id), statuses: REQUEST_STATUSES });
});

customerRouter.post('/product-requests', (req, res) => {
  const productName = cleanText(req.body.product_name, 80);
  const memo = cleanText(req.body.memo, 200) || null;
  if (productName.length < 2) return res.status(400).json({ message: '찾는 상품 이름을 2자 이상 입력해 주세요.' });
  const open = getOne("SELECT COUNT(*) AS n FROM product_requests WHERE customer_id = @customer_id AND status = 'OPEN'", {
    customer_id: req.customer.id
  }).n;
  if (open >= MAX_OPEN_REQUESTS) return res.status(429).json({ message: `처리 대기 중인 요청이 ${MAX_OPEN_REQUESTS}건입니다. 약국 답변 후 다시 요청해 주세요.` });
  run(
    'INSERT INTO product_requests (pharmacy_id, customer_id, product_name, memo) VALUES (@pharmacy_id, @customer_id, @product_name, @memo)',
    { pharmacy_id: req.customer.pharmacy_id, customer_id: req.customer.id, product_name: productName, memo }
  );
  return res.status(201).json({ requests: myRequests(req.customer.id) });
});

router.use('/me', customerRouter);

/* ---------- 약국: 수요 신호 요약 ---------- */

const ownerRouter = express.Router();
ownerRouter.use(authenticate, requireRole('PHARMACY_OWNER'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  return next();
});

ownerRouter.get('/summary', (req, res) => {
  const days = Math.min(365, Math.max(7, Number.parseInt(req.query.days, 10) || 90));
  const params = { pharmacy_id: req.user.pharmacy_id, window: `-${days} days` };
  const searches = getAll(
    `SELECT query, COUNT(*) AS count,
            COUNT(CASE WHEN source = 'STORE' THEN 1 END) AS store_count,
            COUNT(CASE WHEN source = 'POS' THEN 1 END) AS pos_count,
            COUNT(DISTINCT customer_id) AS customer_count,
            MAX(created_at) AS last_at
     FROM search_misses
     WHERE pharmacy_id = @pharmacy_id AND created_at >= datetime('now', @window)
     GROUP BY query ORDER BY count DESC, last_at DESC LIMIT 30`,
    params
  );
  const restock = getAll(
    `SELECT p.id AS product_id, p.product_name, p.status, p.stock_quantity,
            COUNT(CASE WHEN a.status = 'WAITING' THEN 1 END) AS waiting,
            COUNT(CASE WHEN a.status = 'NOTIFIED' THEN 1 END) AS notified,
            MIN(CASE WHEN a.status = 'WAITING' THEN a.created_at END) AS first_at
     FROM restock_alerts a JOIN products p ON p.id = a.product_id
     WHERE a.pharmacy_id = @pharmacy_id AND a.status IN ('WAITING', 'NOTIFIED')
     GROUP BY p.id ORDER BY waiting DESC, first_at`,
    params
  ).map((row) => ({ ...row, available: isAvailable(row) }));
  const requests = getAll(
    `SELECT r.id, r.product_name, r.memo, r.status, r.reply, r.created_at, r.handled_at, c.name AS customer_name
     FROM product_requests r LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.pharmacy_id = @pharmacy_id AND (r.status = 'OPEN' OR r.created_at >= datetime('now', @window))
     ORDER BY CASE WHEN r.status = 'OPEN' THEN 0 ELSE 1 END, r.id DESC LIMIT 50`,
    params
  );
  res.json({ days, searches, restock, requests, request_statuses: REQUEST_STATUSES });
});

ownerRouter.patch('/product-requests/:id', (req, res) => {
  const status = String(req.body.status || '');
  if (!REQUEST_STATUSES[status]) return res.status(400).json({ message: '처리 상태를 확인해 주세요.' });
  const reply = cleanText(req.body.reply, 200) || null;
  const result = run(
    `UPDATE product_requests SET status = @status, reply = COALESCE(@reply, reply), handled_by = @user_id, handled_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id`,
    { id: Number(req.params.id), pharmacy_id: req.user.pharmacy_id, status, reply, user_id: req.user.id }
  );
  if (!result.changes) return res.status(404).json({ message: '요청을 찾을 수 없습니다.' });
  return res.json({ ok: true });
});

// 실제 문자 발송은 문자 서비스 계약 후 붙인다. 지금은 약국이 연락한 뒤 안내 완료로 표시한다.
ownerRouter.post('/restock-alerts/:productId/notified', (req, res) => {
  const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.productId),
    pharmacy_id: req.user.pharmacy_id
  });
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
  if (!isAvailable(product)) return res.status(400).json({ message: '아직 입고되지 않은 상품입니다. 재고를 먼저 등록해 주세요.' });
  const result = run(
    `UPDATE restock_alerts SET status = 'NOTIFIED', notified_at = CURRENT_TIMESTAMP
     WHERE product_id = @product_id AND pharmacy_id = @pharmacy_id AND status = 'WAITING'`,
    { product_id: product.id, pharmacy_id: req.user.pharmacy_id }
  );
  return res.json({ notified: result.changes });
});

ownerRouter.get('/restock-alerts/:productId/customers', (req, res) => {
  const customers = getAll(
    `SELECT c.id, c.name, c.phone, a.status, a.created_at
     FROM restock_alerts a JOIN customers c ON c.id = a.customer_id
     WHERE a.product_id = @product_id AND a.pharmacy_id = @pharmacy_id AND a.status IN ('WAITING', 'NOTIFIED')
     ORDER BY a.id`,
    { product_id: Number(req.params.productId), pharmacy_id: req.user.pharmacy_id }
  );
  res.json({ customers });
});

router.use(ownerRouter);

module.exports = router;
