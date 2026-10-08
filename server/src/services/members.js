const { getAll, getOne, run } = require('../db');

const DAY_MS = 86400000;

const DEFAULT_POLICY = {
  silver_min: 100000,
  gold_min: 300000,
  vip_min: 700000,
  silver_bonus: 0.5,
  gold_bonus: 1,
  vip_bonus: 2,
  churn_multiplier: 2,
  dormant_days: 180,
  new_days: 30,
  birthday_multiplier: 2,
  referral_reward: 1000
};

const POLICY_FIELDS = {
  silver_min: { label: '실버 기준 금액', min: 0, max: 100000000, integer: true },
  gold_min: { label: '골드 기준 금액', min: 0, max: 100000000, integer: true },
  vip_min: { label: 'VIP 기준 금액', min: 0, max: 100000000, integer: true },
  silver_bonus: { label: '실버 추가 적립률', min: 0, max: 10 },
  gold_bonus: { label: '골드 추가 적립률', min: 0, max: 10 },
  vip_bonus: { label: 'VIP 추가 적립률', min: 0, max: 10 },
  churn_multiplier: { label: '이탈 위험 기준(평소 간격의 배수)', min: 1.2, max: 10 },
  dormant_days: { label: '휴면 기준 일수', min: 30, max: 1095, integer: true },
  new_days: { label: '신규 회원 기간', min: 1, max: 180, integer: true },
  birthday_multiplier: { label: '생일 달 적립 배수', min: 1, max: 5 },
  referral_reward: { label: '추천 보상 포인트', min: 0, max: 100000, integer: true }
};

const GRADES = {
  VIP: { label: 'VIP', color: '#7c3aed' },
  GOLD: { label: '골드', color: '#d97706' },
  SILVER: { label: '실버', color: '#64748b' },
  BASIC: { label: '일반', color: '#94a3b8' }
};
const GRADE_ORDER = ['BASIC', 'SILVER', 'GOLD', 'VIP'];

const STATUSES = {
  NEW: '신규',
  ACTIVE: '활성',
  ONE_TIME: '재방문 없음',
  AT_RISK: '이탈 위험',
  DORMANT: '휴면',
  NO_PURCHASE: '구매 없음'
};

const AMOUNT_TIERS = [
  { key: 'UNDER_10K', label: '1만 원 미만', max: 10000 },
  { key: 'UNDER_30K', label: '1~3만 원', max: 30000 },
  { key: 'UNDER_50K', label: '3~5만 원', max: 50000 },
  { key: 'UNDER_100K', label: '5~10만 원', max: 100000 },
  { key: 'OVER_100K', label: '10만 원 이상', max: Infinity }
];

const CHANNELS = { POS: '매장', PICKUP: '픽업', DELIVERY: '배송' };
const PAYMENT_LABELS = { CARD: '카드', CASH: '현금', TRANSFER: '계좌이체', EASY_PAY: '간편결제', POINT: '포인트', MOCK_CARD: '온라인 결제' };
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const AGE_BANDS = ['10대 이하', '20대', '30대', '40대', '50대', '60대 이상'];
// 이탈 위험 판단에 쓰는 최소 구매 간격. 하루 이틀 간격으로 연달아 산 회원이 바로 이탈 위험이 되지 않게 한다.
const MIN_INTERVAL_DAYS = 14;

class MemberError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function memberPolicy(pharmacyId) {
  const row = getOne('SELECT * FROM member_policies WHERE pharmacy_id = @id', { id: pharmacyId });
  const policy = { ...DEFAULT_POLICY };
  if (row) for (const key of Object.keys(DEFAULT_POLICY)) policy[key] = Number(row[key]);
  return policy;
}

function validatePolicy(input, current) {
  const next = { ...current };
  for (const [key, meta] of Object.entries(POLICY_FIELDS)) {
    if (input[key] === undefined || input[key] === '') continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < meta.min || value > meta.max || (meta.integer && !Number.isInteger(value))) {
      throw new MemberError(`${meta.label}을(를) 확인해 주세요. (${meta.min.toLocaleString()} ~ ${meta.max.toLocaleString()})`);
    }
    next[key] = meta.integer ? value : Math.round(value * 10) / 10;
  }
  if (!(next.silver_min < next.gold_min && next.gold_min < next.vip_min)) {
    throw new MemberError('등급 기준 금액은 실버 < 골드 < VIP 순으로 커야 합니다.');
  }
  if (!(next.silver_bonus <= next.gold_bonus && next.gold_bonus <= next.vip_bonus)) {
    throw new MemberError('추가 적립률은 높은 등급일수록 같거나 커야 합니다.');
  }
  if (next.new_days >= next.dormant_days) throw new MemberError('신규 회원 기간은 휴면 기준보다 짧아야 합니다.');
  return next;
}

function savePolicy(pharmacyId, policy, userId) {
  const columns = Object.keys(DEFAULT_POLICY);
  run(
    `INSERT INTO member_policies (pharmacy_id, ${columns.join(', ')}, updated_by, updated_at)
     VALUES (@pharmacy_id, ${columns.map((c) => `@${c}`).join(', ')}, @updated_by, CURRENT_TIMESTAMP)
     ON CONFLICT(pharmacy_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(', ')},
       updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
    { pharmacy_id: pharmacyId, ...policy, updated_by: userId }
  );
}

function gradeFor(policy, amount) {
  if (amount >= policy.vip_min) return 'VIP';
  if (amount >= policy.gold_min) return 'GOLD';
  if (amount >= policy.silver_min) return 'SILVER';
  return 'BASIC';
}

function gradeBonus(policy, grade) {
  return { VIP: policy.vip_bonus, GOLD: policy.gold_bonus, SILVER: policy.silver_bonus }[grade] || 0;
}

function nextGrade(policy, grade, amount) {
  const next = GRADE_ORDER[GRADE_ORDER.indexOf(grade) + 1];
  if (!next) return null;
  const min = policy[`${next.toLowerCase()}_min`];
  return { grade: next, label: GRADES[next].label, min, remaining: Math.max(0, min - amount) };
}

function tierFor(avgTicket) {
  if (avgTicket == null) return null;
  return AMOUNT_TIERS.find((tier) => avgTicket < tier.max).key;
}

function ageBand(birthYear, now) {
  if (!birthYear) return null;
  const age = now.getFullYear() - birthYear;
  if (age < 20) return AGE_BANDS[0];
  if (age >= 60) return AGE_BANDS[5];
  return AGE_BANDS[Math.floor(age / 10) - 1];
}

const parseUtc = (value) => (value ? Date.parse(`${String(value).replace(' ', 'T')}Z`) : null);
const round1 = (value) => Math.round(value * 10) / 10;

// 판매(+)와 반품(-) 주문을 합쳐 순구매로 계산한다. 상담 기록(COUNSEL)과 취소된 판매는 구매 횟수에서 뺀다.
const MEMBER_SALES_SQL = `
  SELECT o.customer_id,
    COUNT(CASE WHEN o.final_amount > 0 AND o.order_status != 'CANCELED' THEN 1 END) AS visit_count,
    COALESCE(SUM(o.final_amount), 0) AS net_total,
    COALESCE(SUM(CASE WHEN o.created_at >= datetime('now', '-12 months') THEN o.final_amount ELSE 0 END), 0) AS net_12m,
    COUNT(CASE WHEN o.final_amount > 0 AND o.order_status != 'CANCELED' AND o.created_at >= datetime('now', '-12 months') THEN 1 END) AS visits_12m,
    MIN(CASE WHEN o.final_amount > 0 AND o.order_status != 'CANCELED' THEN o.created_at END) AS first_purchase_at,
    MAX(CASE WHEN o.final_amount > 0 AND o.order_status != 'CANCELED' THEN o.created_at END) AS last_purchase_at,
    MAX(CASE WHEN o.order_status != 'CANCELED' THEN o.final_amount END) AS max_ticket
  FROM orders o
  WHERE o.pharmacy_id = @pharmacy_id AND o.customer_id IS NOT NULL AND o.order_type != 'COUNSEL'
  GROUP BY o.customer_id`;

function baseRows(pharmacyId, customerId = null) {
  return getAll(
    `WITH sales AS (${MEMBER_SALES_SQL}),
     consents AS (
       SELECT cc.customer_id,
         MAX(CASE WHEN cc.consent_type = 'MARKETING_SMS' THEN cc.agreed END) AS sms,
         MAX(CASE WHEN cc.consent_type = 'MARKETING_KAKAO' THEN cc.agreed END) AS kakao
       FROM customer_consents cc
       WHERE cc.pharmacy_id = @pharmacy_id
         AND cc.consent_type IN ('MARKETING_SMS', 'MARKETING_KAKAO')
         AND cc.id = (SELECT MAX(id) FROM customer_consents WHERE customer_id = cc.customer_id AND consent_type = cc.consent_type)
       GROUP BY cc.customer_id
     )
     SELECT c.id, c.name, c.phone, c.member_code, c.created_at, c.point_balance, c.marketing_agree,
            c.birth_year, c.birth_month, c.birth_day, c.gender, c.signup_channel_id,
            ch.name AS signup_channel_name,
            COALESCE(consents.sms, 0) AS consent_sms, COALESCE(consents.kakao, 0) AS consent_kakao,
            COALESCE(sales.visit_count, 0) AS visit_count, COALESCE(sales.net_total, 0) AS net_total,
            COALESCE(sales.net_12m, 0) AS net_12m, COALESCE(sales.visits_12m, 0) AS visits_12m,
            sales.first_purchase_at, sales.last_purchase_at, sales.max_ticket
     FROM customers c
     LEFT JOIN sales ON sales.customer_id = c.id
     LEFT JOIN consents ON consents.customer_id = c.id
     LEFT JOIN signup_channels ch ON ch.id = c.signup_channel_id
     WHERE c.pharmacy_id = @pharmacy_id ${customerId ? 'AND c.id = @customer_id' : ''}
     ORDER BY c.id`,
    { pharmacy_id: pharmacyId, customer_id: customerId }
  );
}

function enrich(row, policy, now = new Date()) {
  const nowMs = now.getTime();
  const first = parseUtc(row.first_purchase_at);
  const last = parseUtc(row.last_purchase_at);
  const visits = row.visit_count;
  const avgInterval = visits >= 2 ? round1((last - first) / DAY_MS / (visits - 1)) : null;
  const daysSinceLast = last ? Math.floor((nowMs - last) / DAY_MS) : null;
  const daysSinceFirst = first ? Math.floor((nowMs - first) / DAY_MS) : null;

  let status;
  if (!visits) status = 'NO_PURCHASE';
  else if (daysSinceLast >= policy.dormant_days) status = 'DORMANT';
  else if (daysSinceFirst <= policy.new_days) status = 'NEW';
  else if (visits === 1) status = 'ONE_TIME';
  else if (daysSinceLast > policy.churn_multiplier * Math.max(avgInterval, MIN_INTERVAL_DAYS)) status = 'AT_RISK';
  else status = 'ACTIVE';

  const grade = gradeFor(policy, row.net_12m);
  const avgTicket = visits ? Math.max(0, Math.round(row.net_total / visits)) : null;
  const windowStart = Math.max(first || nowMs, nowMs - 365 * DAY_MS);
  const activeMonths = Math.min(12, Math.max(1, Math.ceil((nowMs - windowStart) / (30.44 * DAY_MS))));

  return {
    ...row,
    marketing_agree: row.marketing_agree === 1,
    consent_sms: row.consent_sms === 1,
    consent_kakao: row.consent_kakao === 1,
    grade,
    grade_bonus: gradeBonus(policy, grade),
    next_grade: nextGrade(policy, grade, row.net_12m),
    status,
    avg_ticket: avgTicket,
    amount_tier: tierFor(avgTicket),
    monthly_spend: visits ? Math.round(Math.max(0, row.net_12m) / activeMonths) : 0,
    avg_interval_days: avgInterval,
    days_since_last: daysSinceLast,
    expected_next_at: avgInterval && last ? new Date(last + avgInterval * DAY_MS).toISOString().slice(0, 10) : null,
    birthday_this_month: row.birth_month === now.getMonth() + 1,
    age_band: ageBand(row.birth_year, now)
  };
}

function memberList(pharmacyId, policy = memberPolicy(pharmacyId)) {
  const now = new Date();
  return baseRows(pharmacyId).map((row) => enrich(row, policy, now));
}

function memberMetrics(pharmacyId, customerId, policy = memberPolicy(pharmacyId)) {
  const row = baseRows(pharmacyId, customerId)[0];
  return row ? enrich(row, policy) : null;
}

function filterMembers(members, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  return members.filter((m) => {
    if (query.grade && m.grade !== query.grade) return false;
    if (query.status && m.status !== query.status) return false;
    if (query.tier && m.amount_tier !== query.tier) return false;
    if (query.channel && String(m.signup_channel_id || 'BASIC') !== String(query.channel)) return false;
    if (query.birthday === '1' && !m.birthday_this_month) return false;
    if (query.marketing === '1' && !m.marketing_agree) return false;
    if (query.age && m.age_band !== query.age) return false;
    if (query.gender && (m.gender || 'NONE') !== query.gender) return false;
    if (q) {
      const phone = String(m.phone || '').replace(/\D/g, '');
      const hit = m.name.toLowerCase().includes(q) || String(m.member_code || '').toLowerCase().includes(q) || (digits.length >= 4 && phone.includes(digits));
      if (!hit) return false;
    }
    return true;
  });
}

const SORTS = {
  recent: (a, b) => String(b.last_purchase_at || '').localeCompare(String(a.last_purchase_at || '')),
  spend: (a, b) => b.net_12m - a.net_12m,
  visits: (a, b) => b.visit_count - a.visit_count,
  joined: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  name: (a, b) => a.name.localeCompare(b.name, 'ko')
};

function sortMembers(members, sort) {
  return [...members].sort(SORTS[sort] || SORTS.recent);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

function countBy(members, key, keys) {
  const map = new Map(keys.map((k) => [k, { key: k, count: 0, net_12m: 0 }]));
  for (const m of members) {
    const k = m[key] ?? null;
    if (!map.has(k)) map.set(k, { key: k, count: 0, net_12m: 0 });
    const entry = map.get(k);
    entry.count += 1;
    entry.net_12m += m.net_12m;
  }
  return [...map.values()];
}

function memberSummary(pharmacyId) {
  const policy = memberPolicy(pharmacyId);
  const members = memberList(pharmacyId, policy);
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const localMonth = (value) => {
    const d = new Date(parseUtc(value));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const purchasers = members.filter((m) => m.visit_count > 0);
  const store = getOne(
    `SELECT COUNT(CASE WHEN final_amount > 0 AND order_status != 'CANCELED' THEN 1 END) AS sale_count,
            COUNT(CASE WHEN final_amount > 0 AND order_status != 'CANCELED' AND customer_id IS NOT NULL THEN 1 END) AS member_sale_count,
            COALESCE(SUM(final_amount), 0) AS net_amount,
            COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN final_amount ELSE 0 END), 0) AS member_net_amount
     FROM orders
     WHERE pharmacy_id = @pharmacy_id AND order_type != 'COUNSEL' AND created_at >= datetime('now', '-12 months')`,
    { pharmacy_id: pharmacyId }
  );
  const share = (part, total) => (total ? round1((part / total) * 100) : null);

  return {
    policy,
    totals: {
      members: members.length,
      new_signups_this_month: members.filter((m) => localMonth(m.created_at) === monthKey).length,
      purchasers: purchasers.length,
      active_90d: purchasers.filter((m) => m.days_since_last < 90).length,
      repeat_rate: share(purchasers.filter((m) => m.visit_count >= 2).length, purchasers.length),
      median_interval_days: median(purchasers.filter((m) => m.avg_interval_days != null).map((m) => m.avg_interval_days)),
      avg_ticket: purchasers.length ? Math.round(purchasers.reduce((s, m) => s + m.net_total, 0) / purchasers.reduce((s, m) => s + m.visit_count, 0)) : null,
      at_risk: members.filter((m) => m.status === 'AT_RISK').length,
      dormant: members.filter((m) => m.status === 'DORMANT').length,
      birthdays_this_month: members.filter((m) => m.birthday_this_month).length,
      marketing_agreed: members.filter((m) => m.marketing_agree).length,
      member_sale_rate: share(store.member_sale_count, store.sale_count),
      member_sales_share: share(store.member_net_amount, store.net_amount),
      net_12m: store.net_amount,
      member_net_12m: store.member_net_amount
    },
    grades: countBy(members, 'grade', GRADE_ORDER.slice().reverse()),
    statuses: countBy(members, 'status', Object.keys(STATUSES)),
    tiers: countBy(purchasers, 'amount_tier', AMOUNT_TIERS.map((t) => t.key)),
    ages: countBy(members, 'age_band', [...AGE_BANDS, null]),
    genders: countBy(members, 'gender', ['F', 'M', null]),
    channels: countBy(members, 'signup_channel_name', [null]).map((entry) => ({
      ...entry,
      purchasers: members.filter((m) => m.signup_channel_name === entry.key && m.visit_count > 0).length
    }))
  };
}

// 회원 한 명의 구매 행동: 채널·요일·시간대·결제수단·할인 사용·선호 카테고리
function memberBehavior(pharmacyId, customerId) {
  const params = { pharmacy_id: pharmacyId, customer_id: customerId };
  const saleWhere = `o.pharmacy_id = @pharmacy_id AND o.customer_id = @customer_id AND o.order_type != 'COUNSEL'
    AND o.final_amount > 0 AND o.order_status != 'CANCELED'`;
  const orders = getAll(
    `SELECT o.id, o.order_type, o.sales_channel, o.final_amount, o.discount_amount,
            CAST(strftime('%w', o.created_at, 'localtime') AS INTEGER) AS weekday,
            CAST(strftime('%H', o.created_at, 'localtime') AS INTEGER) AS hour,
            (SELECT COALESCE(SUM(p.paid_amount), 0) FROM payments p WHERE p.order_id = o.id AND p.payment_method = 'POINT') AS point_used
     FROM orders o WHERE ${saleWhere}`,
    params
  );
  if (!orders.length) return null;

  const tally = (items, keyFn) => {
    const map = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (key == null) continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  };
  const channelOf = (o) => (o.sales_channel === 'POS' ? 'POS' : o.order_type === 'PICKUP' ? 'PICKUP' : 'DELIVERY');
  const hourBand = (h) => (h < 12 ? '오전' : h < 18 ? '오후' : '저녁');

  const payments = getAll(
    `SELECT p.payment_method, COUNT(DISTINCT p.order_id) AS count
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${saleWhere}
     GROUP BY p.payment_method ORDER BY count DESC`,
    params
  );
  const categories = getAll(
    `SELECT COALESCE(c.category_name, '기타') AS name, SUM(i.total_price - COALESCE(i.discount_amount, 0) - COALESCE(i.refunded_amount, 0)) AS amount,
            COUNT(DISTINCT o.id) AS orders
     FROM order_items i
     JOIN orders o ON o.id = i.order_id
     LEFT JOIN products p ON p.id = i.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${saleWhere}
     GROUP BY name ORDER BY amount DESC LIMIT 3`,
    params
  );
  const recent = getAll(
    `SELECT o.id, o.order_number, o.order_type, o.sales_channel, o.final_amount, o.created_at,
            (SELECT GROUP_CONCAT(product_name, ', ') FROM (SELECT product_name FROM order_items WHERE order_id = o.id LIMIT 3)) AS items,
            (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
     FROM orders o
     WHERE o.pharmacy_id = @pharmacy_id AND o.customer_id = @customer_id AND o.order_type != 'COUNSEL'
     ORDER BY o.id DESC LIMIT 8`,
    params
  );

  const discounted = orders.filter((o) => o.discount_amount > 0 || o.point_used > 0).length;
  return {
    channels: tally(orders, channelOf).map((e) => ({ ...e, label: CHANNELS[e.key] })),
    weekdays: tally(orders, (o) => o.weekday).slice(0, 2).map((e) => ({ ...e, label: WEEKDAYS[e.key] })),
    hour_bands: tally(orders, (o) => hourBand(o.hour)).slice(0, 1),
    payments: payments.map((p) => ({ key: p.payment_method, label: PAYMENT_LABELS[p.payment_method] || p.payment_method, count: p.count })),
    discount_rate: round1((discounted / orders.length) * 100),
    top_categories: categories,
    recent_orders: recent
  };
}

function labels() {
  return {
    grades: Object.fromEntries(Object.entries(GRADES).map(([k, v]) => [k, v.label])),
    grade_colors: Object.fromEntries(Object.entries(GRADES).map(([k, v]) => [k, v.color])),
    statuses: STATUSES,
    tiers: Object.fromEntries(AMOUNT_TIERS.map((t) => [t.key, t.label])),
    age_bands: AGE_BANDS,
    genders: { F: '여성', M: '남성' },
    policy_fields: Object.fromEntries(Object.entries(POLICY_FIELDS).map(([k, v]) => [k, v.label]))
  };
}

module.exports = {
  DEFAULT_POLICY,
  GRADES,
  STATUSES,
  AMOUNT_TIERS,
  MemberError,
  memberPolicy,
  validatePolicy,
  savePolicy,
  gradeFor,
  gradeBonus,
  memberList,
  memberMetrics,
  memberSummary,
  memberBehavior,
  filterMembers,
  sortMembers,
  labels
};
