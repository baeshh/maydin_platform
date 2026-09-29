const express = require('express');
const { getAll, getOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { TAX_TYPE_LABELS, splitVat } = require('../services/tax');

const router = express.Router();

const CHANNELS = { ALL: '전체', POS: '매장 POS', ONLINE: '온라인' };
const CHANNEL_LABELS = { POS: '매장 POS', ONLINE: '온라인' };
const METHOD_LABELS = {
  CARD: '카드',
  CASH: '현금',
  TRANSFER: '계좌이체',
  EASY_PAY: '간편결제',
  POINT: '포인트',
  MOCK_CARD: '온라인 결제 (데모)'
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const MONTHLY_THRESHOLD_DAYS = 62;
const MAX_RANGE_DAYS = 1096;

class ReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

router.use(authenticate, requireRole('PHARMACY_OWNER'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  req.pharmacyId = req.user.pharmacy_id;
  return next();
});

function parseDate(value, fallback) {
  const date = String(value || '').trim() || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ReportError('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
  }
  return date;
}

function parseQuery(query) {
  const { today, month_start: monthStart } = getOne(
    "SELECT date('now', 'localtime') AS today, date('now', 'localtime', 'start of month') AS month_start"
  );
  const from = parseDate(query.from, monthStart);
  const to = parseDate(query.to, today);
  if (from > to) throw new ReportError('조회 시작일이 종료일보다 늦습니다.');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) throw new ReportError('조회 기간은 최대 3년까지 가능합니다.');
  const channel = String(query.channel || 'ALL').toUpperCase();
  if (!CHANNELS[channel]) throw new ReportError('판매 채널이 올바르지 않습니다.');
  return { from, to, days, channel };
}

function orderFilter(channel, alias = 'o') {
  const conditions = [
    `${alias}.pharmacy_id = @pharmacy_id`,
    `${alias}.order_type != 'COUNSEL'`,
    `date(${alias}.created_at, 'localtime') BETWEEN @from AND @to`
  ];
  if (channel === 'POS') conditions.push(`${alias}.sales_channel = 'POS'`);
  if (channel === 'ONLINE') conditions.push(`COALESCE(${alias}.sales_channel, 'ONLINE') != 'POS'`);
  return conditions.join(' AND ');
}

const ITEM_NET = '(oi.total_price - COALESCE(oi.discount_amount, 0))';
const ITEM_TAX = "COALESCE(oi.tax_type, p.tax_type, 'TAXABLE')";

function eachDate(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function eachMonth(from, to) {
  const months = [];
  let [year, month] = from.slice(0, 7).split('-').map(Number);
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key >= last) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function marginOf(row) {
  const margin = row.cost_known_net - row.cost_amount;
  return {
    margin_amount: row.cost_known_net ? margin : null,
    margin_rate: row.cost_known_net > 0 ? Math.round((margin / row.cost_known_net) * 1000) / 10 : null
  };
}

function salesReport(pharmacyId, { from, to, days, channel }) {
  const params = { pharmacy_id: pharmacyId, from, to };
  const where = orderFilter(channel);

  const totals = getOne(
    `SELECT
       COUNT(CASE WHEN o.final_amount > 0 THEN 1 END) AS sale_count,
       COUNT(CASE WHEN o.final_amount < 0 THEN 1 END) AS refund_count,
       COALESCE(SUM(CASE WHEN o.final_amount > 0 THEN o.final_amount ELSE 0 END), 0) AS gross_amount,
       COALESCE(SUM(CASE WHEN o.final_amount < 0 THEN o.final_amount ELSE 0 END), 0) AS refund_amount,
       COALESCE(SUM(o.final_amount), 0) AS net_amount,
       COALESCE(SUM(CASE WHEN o.final_amount > 0 THEN o.discount_amount ELSE 0 END), 0) AS discount_amount,
       COALESCE(SUM(o.delivery_fee), 0) AS delivery_fee,
       COUNT(DISTINCT CASE WHEN o.final_amount > 0 THEN o.customer_id END) AS member_count,
       COUNT(CASE WHEN o.final_amount > 0 AND o.customer_id IS NULL THEN 1 END) AS walk_in_count
     FROM orders o WHERE ${where}`,
    params
  );
  totals.avg_ticket = totals.sale_count ? Math.round(totals.gross_amount / totals.sale_count) : 0;

  const taxRows = getAll(
    `SELECT ${ITEM_TAX} AS tax_type, COALESCE(SUM(${ITEM_NET}), 0) AS net_amount, COALESCE(SUM(oi.quantity), 0) AS quantity
     FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
     WHERE ${where}
     GROUP BY ${ITEM_TAX}`,
    params
  );
  const taxableItems = taxRows.filter((r) => r.tax_type !== 'EXEMPT').reduce((sum, r) => sum + r.net_amount, 0);
  const exempt = taxRows.filter((r) => r.tax_type === 'EXEMPT').reduce((sum, r) => sum + r.net_amount, 0);
  const taxable = taxableItems + totals.delivery_fee;
  const tax = {
    taxable_amount: taxable,
    exempt_amount: exempt,
    delivery_fee: totals.delivery_fee,
    ...Object.fromEntries(Object.entries(splitVat(taxable)).map(([k, v]) => [`${k}_amount`, v])),
    unallocated_amount: totals.net_amount - taxable - exempt
  };

  const costRow = getOne(
    `SELECT
       COALESCE(SUM(CASE WHEN p.cost_price IS NOT NULL THEN ${ITEM_NET} ELSE 0 END), 0) AS cost_known_net,
       COALESCE(SUM(CASE WHEN p.cost_price IS NOT NULL THEN oi.quantity * p.cost_price ELSE 0 END), 0) AS cost_amount,
       COALESCE(SUM(${ITEM_NET}), 0) AS item_net
     FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN products p ON p.id = oi.product_id
     WHERE ${where}`,
    params
  );
  const margin = {
    ...costRow,
    ...marginOf(costRow),
    coverage_rate: costRow.item_net ? Math.round((costRow.cost_known_net / costRow.item_net) * 1000) / 10 : null
  };

  const monthly = days > MONTHLY_THRESHOLD_DAYS;
  const periodExpr = monthly ? "strftime('%Y-%m', o.created_at, 'localtime')" : "date(o.created_at, 'localtime')";
  const trendRows = getAll(
    `SELECT ${periodExpr} AS period,
       COUNT(CASE WHEN o.final_amount > 0 THEN 1 END) AS sale_count,
       COALESCE(SUM(CASE WHEN o.final_amount > 0 THEN o.final_amount ELSE 0 END), 0) AS gross_amount,
       COALESCE(SUM(CASE WHEN o.final_amount < 0 THEN o.final_amount ELSE 0 END), 0) AS refund_amount,
       COALESCE(SUM(o.final_amount), 0) AS net_amount,
       COALESCE(SUM(CASE WHEN o.sales_channel = 'POS' THEN o.final_amount ELSE 0 END), 0) AS pos_amount,
       COALESCE(SUM(CASE WHEN COALESCE(o.sales_channel, 'ONLINE') != 'POS' THEN o.final_amount ELSE 0 END), 0) AS online_amount
     FROM orders o WHERE ${where}
     GROUP BY period`,
    params
  );
  const trendMap = new Map(trendRows.map((r) => [r.period, r]));
  const empty = { sale_count: 0, gross_amount: 0, refund_amount: 0, net_amount: 0, pos_amount: 0, online_amount: 0 };
  const trend = (monthly ? eachMonth(from, to) : eachDate(from, to)).map((period) => ({ period, ...empty, ...trendMap.get(period) }));

  const hourRows = getAll(
    `SELECT CAST(strftime('%H', o.created_at, 'localtime') AS INTEGER) AS hour,
       COUNT(CASE WHEN o.final_amount > 0 THEN 1 END) AS sale_count,
       COALESCE(SUM(o.final_amount), 0) AS net_amount
     FROM orders o WHERE ${where}
     GROUP BY hour`,
    params
  );
  const hourMap = new Map(hourRows.map((r) => [r.hour, r]));
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, sale_count: 0, net_amount: 0, ...hourMap.get(hour) }));

  const weekdayRows = getAll(
    `SELECT CAST(strftime('%w', o.created_at, 'localtime') AS INTEGER) AS weekday,
       COUNT(CASE WHEN o.final_amount > 0 THEN 1 END) AS sale_count,
       COALESCE(SUM(o.final_amount), 0) AS net_amount
     FROM orders o WHERE ${where}
     GROUP BY weekday`,
    params
  );
  const weekdayMap = new Map(weekdayRows.map((r) => [r.weekday, r]));
  const dayCounts = Array(7).fill(0);
  for (const date of eachDate(from, to)) dayCounts[new Date(`${date}T00:00:00Z`).getUTCDay()] += 1;
  const weekdays = WEEKDAYS.map((label, weekday) => {
    const row = { weekday, label, sale_count: 0, net_amount: 0, ...weekdayMap.get(weekday) };
    return { ...row, days: dayCounts[weekday], avg_net_amount: dayCounts[weekday] ? Math.round(row.net_amount / dayCounts[weekday]) : 0 };
  });

  const products = getAll(
    `SELECT oi.product_id, MAX(oi.product_name) AS product_name, p.barcode, COALESCE(c.category_name, '미분류') AS category_name,
       COALESCE(MAX(oi.product_type), p.product_type, 'GENERAL') AS product_type, ${ITEM_TAX} AS tax_type,
       COALESCE(SUM(CASE WHEN oi.quantity > 0 THEN oi.quantity ELSE 0 END), 0) AS sold_quantity,
       COALESCE(SUM(CASE WHEN oi.quantity < 0 THEN -oi.quantity ELSE 0 END), 0) AS refunded_quantity,
       COALESCE(SUM(oi.quantity), 0) AS net_quantity,
       COALESCE(SUM(${ITEM_NET}), 0) AS net_amount,
       COALESCE(SUM(CASE WHEN oi.quantity > 0 THEN COALESCE(oi.discount_amount, 0) ELSE 0 END), 0) AS discount_amount,
       p.cost_price,
       CASE WHEN p.cost_price IS NOT NULL THEN COALESCE(SUM(${ITEM_NET}), 0) ELSE 0 END AS cost_known_net,
       CASE WHEN p.cost_price IS NOT NULL THEN COALESCE(SUM(oi.quantity), 0) * p.cost_price ELSE 0 END AS cost_amount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${where}
     GROUP BY oi.product_id
     HAVING SUM(oi.quantity) != 0 OR SUM(${ITEM_NET}) != 0
     ORDER BY net_amount DESC
     LIMIT 1000`,
    params
  ).map((row) => ({ ...row, ...marginOf(row), share: 0 }));
  const productNet = products.reduce((sum, p) => sum + p.net_amount, 0);
  for (const p of products) p.share = productNet ? Math.round((p.net_amount / productNet) * 1000) / 10 : 0;

  const categoryMap = new Map();
  for (const p of products) {
    const row = categoryMap.get(p.category_name) || {
      category_name: p.category_name,
      product_count: 0,
      net_quantity: 0,
      net_amount: 0,
      cost_known_net: 0,
      cost_amount: 0
    };
    row.product_count += 1;
    row.net_quantity += p.net_quantity;
    row.net_amount += p.net_amount;
    row.cost_known_net += p.cost_known_net;
    row.cost_amount += p.cost_amount;
    categoryMap.set(p.category_name, row);
  }
  const categories = [...categoryMap.values()]
    .map((row) => ({ ...row, ...marginOf(row), share: productNet ? Math.round((row.net_amount / productNet) * 1000) / 10 : 0 }))
    .sort((a, b) => b.net_amount - a.net_amount);

  const staff = channel === 'ONLINE'
    ? []
    : getAll(
        `SELECT o.cashier_user_id, COALESCE(u.name, '-') AS staff_name, u.role,
           COUNT(CASE WHEN o.order_type = 'POS_SALE' THEN 1 END) AS sale_count,
           COUNT(CASE WHEN o.order_type = 'POS_REFUND' THEN 1 END) AS refund_count,
           COALESCE(SUM(CASE WHEN o.order_type = 'POS_SALE' THEN o.final_amount ELSE 0 END), 0) AS gross_amount,
           COALESCE(SUM(CASE WHEN o.order_type = 'POS_REFUND' THEN o.final_amount ELSE 0 END), 0) AS refund_amount,
           COALESCE(SUM(o.final_amount), 0) AS net_amount,
           COALESCE(SUM(CASE WHEN o.order_type = 'POS_SALE' THEN o.discount_amount ELSE 0 END), 0) AS discount_amount
         FROM orders o LEFT JOIN users u ON u.id = o.cashier_user_id
         WHERE ${orderFilter('POS')}
         GROUP BY o.cashier_user_id
         ORDER BY net_amount DESC`,
        params
      ).map((row) => ({ ...row, avg_ticket: row.sale_count ? Math.round(row.gross_amount / row.sale_count) : 0 }));

  const payments = getAll(
    `SELECT p.payment_method,
       COUNT(CASE WHEN p.paid_amount > 0 THEN 1 END) AS pay_count,
       COALESCE(SUM(CASE WHEN p.paid_amount > 0 THEN p.paid_amount ELSE 0 END), 0) AS paid_amount,
       COALESCE(SUM(CASE WHEN p.paid_amount < 0 THEN p.paid_amount ELSE 0 END), 0) AS refunded_amount,
       COALESCE(SUM(p.paid_amount), 0) AS net_amount
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${where} AND p.payment_method != 'NONE'
     GROUP BY p.payment_method
     ORDER BY net_amount DESC`,
    params
  );

  const channels = getAll(
    `SELECT CASE WHEN o.sales_channel = 'POS' THEN 'POS' ELSE 'ONLINE' END AS channel,
       COUNT(CASE WHEN o.final_amount > 0 THEN 1 END) AS sale_count,
       COALESCE(SUM(o.final_amount), 0) AS net_amount
     FROM orders o WHERE ${where}
     GROUP BY channel ORDER BY net_amount DESC`,
    params
  );

  return {
    from,
    to,
    channel,
    granularity: monthly ? 'MONTH' : 'DAY',
    totals,
    tax,
    margin,
    channels,
    trend,
    hourly,
    weekdays,
    products,
    categories,
    staff,
    payments
  };
}

/* ---------- CSV ---------- */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // 엑셀에서 수식으로 해석되지 않도록 =,+,-,@로 시작하는 문자열 앞에 작은따옴표를 붙인다.
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_TABLES = {
  summary: {
    label: '요약',
    build: (r) => [
      ['항목', '값'],
      ['조회 기간', `${r.from} ~ ${r.to}`],
      ['판매 채널', CHANNELS[r.channel]],
      ['판매 건수', r.totals.sale_count],
      ['총매출', r.totals.gross_amount],
      ['반품·취소', r.totals.refund_amount],
      ['순매출', r.totals.net_amount],
      ['할인', r.totals.discount_amount],
      ['객단가', r.totals.avg_ticket],
      ['과세 매출 (부가세 포함)', r.tax.taxable_amount],
      ['과세 공급가액', r.tax.supply_amount],
      ['부가세', r.tax.vat_amount],
      ['면세 매출', r.tax.exempt_amount],
      ['추정 매출원가 (현재 원가 기준)', r.margin.cost_amount],
      ['추정 매출총이익', r.margin.margin_amount],
      ['원가 등록 매출 비중(%)', r.margin.coverage_rate]
    ]
  },
  trend: {
    label: '기간별',
    build: (r) => [
      [r.granularity === 'MONTH' ? '월' : '일자', '판매 건수', '총매출', '반품·취소', '순매출', '매장 POS', '온라인'],
      ...r.trend.map((t) => [t.period, t.sale_count, t.gross_amount, t.refund_amount, t.net_amount, t.pos_amount, t.online_amount])
    ]
  },
  hourly: {
    label: '시간대별',
    build: (r) => [['시간대', '판매 건수', '순매출'], ...r.hourly.map((h) => [`${String(h.hour).padStart(2, '0')}시`, h.sale_count, h.net_amount])]
  },
  weekday: {
    label: '요일별',
    build: (r) => [
      ['요일', '일수', '판매 건수', '순매출', '일평균 순매출'],
      ...r.weekdays.map((w) => [w.label, w.days, w.sale_count, w.net_amount, w.avg_net_amount])
    ]
  },
  products: {
    label: '상품별',
    build: (r) => [
      ['상품명', '바코드', '카테고리', '구분', '과세', '판매 수량', '반품 수량', '순수량', '순매출', '비중(%)', '할인', '현재 원가', '추정 원가', '추정 이익', '이익률(%)'],
      ...r.products.map((p) => [
        p.product_name,
        p.barcode,
        p.category_name,
        p.product_type === 'OTC' ? '일반의약품' : '일반',
        TAX_TYPE_LABELS[p.tax_type] || p.tax_type,
        p.sold_quantity,
        p.refunded_quantity,
        p.net_quantity,
        p.net_amount,
        p.share,
        p.discount_amount,
        p.cost_price,
        p.cost_price == null ? null : p.cost_amount,
        p.margin_amount,
        p.margin_rate
      ])
    ]
  },
  categories: {
    label: '카테고리별',
    build: (r) => [
      ['카테고리', '상품 수', '순수량', '순매출', '비중(%)', '추정 이익', '이익률(%)'],
      ...r.categories.map((c) => [c.category_name, c.product_count, c.net_quantity, c.net_amount, c.share, c.margin_amount, c.margin_rate])
    ]
  },
  staff: {
    label: '직원별',
    build: (r) => [
      ['판매자', '판매 건수', '반품 건수', '총매출', '반품', '순매출', '할인', '객단가'],
      ...r.staff.map((s) => [s.staff_name, s.sale_count, s.refund_count, s.gross_amount, s.refund_amount, s.net_amount, s.discount_amount, s.avg_ticket])
    ]
  },
  payments: {
    label: '결제수단별',
    build: (r) => [
      ['결제수단', '결제 건수', '결제 금액', '환불', '순액'],
      ...r.payments.map((p) => [METHOD_LABELS[p.payment_method] || p.payment_method, p.pay_count, p.paid_amount, p.refunded_amount, p.net_amount])
    ]
  },
  tax: {
    label: '과세구분',
    build: (r) => [
      ['구분', '금액'],
      ['과세 매출 (부가세 포함)', r.tax.taxable_amount],
      ['  - 공급가액', r.tax.supply_amount],
      ['  - 부가세', r.tax.vat_amount],
      ['  (배송비 포함분)', r.tax.delivery_fee],
      ['면세 매출', r.tax.exempt_amount],
      ['합계', r.tax.taxable_amount + r.tax.exempt_amount]
    ]
  }
};

function sendError(res, error, fallback) {
  if (error instanceof ReportError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: fallback });
}

router.get('/sales', (req, res) => {
  try {
    const query = parseQuery(req.query);
    return res.json({ ...salesReport(req.pharmacyId, query), channel_labels: CHANNEL_LABELS, method_labels: METHOD_LABELS });
  } catch (error) {
    return sendError(res, error, '리포트를 만드는 중 오류가 발생했습니다.');
  }
});

router.get('/sales.csv', (req, res) => {
  try {
    const table = CSV_TABLES[String(req.query.type || 'summary')];
    if (!table) throw new ReportError('내려받을 표 종류가 올바르지 않습니다.');
    const query = parseQuery(req.query);
    const rows = table.build(salesReport(req.pharmacyId, query));
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
    const filename = `MAYDIN_매출_${table.label}_${query.from}_${query.to}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sales-${req.query.type || 'summary'}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.send(csv);
  } catch (error) {
    return sendError(res, error, 'CSV를 만드는 중 오류가 발생했습니다.');
  }
});

module.exports = router;
