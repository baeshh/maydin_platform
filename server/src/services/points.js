const { getOne, getAll, run } = require('../db');

const POINT_ENTRY_LABELS = {
  EARN: '적립',
  USE: '사용',
  EARN_CANCEL: '적립 취소',
  USE_RESTORE: '사용 취소(복원)',
  ADJUST: '수동 조정',
  REWARD: '추천 보상'
};

class PointError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function pointPolicy(pharmacyId) {
  const row = getOne('SELECT point_enabled, point_earn_rate, point_min_use FROM pharmacies WHERE id = @id', {
    id: pharmacyId
  });
  return {
    enabled: Number(row?.point_enabled ?? 0) === 1,
    earn_rate: Number(row?.point_earn_rate ?? 0),
    min_use: Number(row?.point_min_use ?? 0)
  };
}

// 잔액 변경과 원장 기록은 항상 같은 트랜잭션 안에서 함께 일어나야 한다.
function changePoints({ pharmacyId, customerId, orderId = null, entryType, points, reason = null, userId = null }) {
  if (!points) return null;
  const updated = run(
    `UPDATE customers SET point_balance = point_balance + @points
     WHERE id = @id AND pharmacy_id = @pharmacy_id AND point_balance + @points >= 0`,
    { id: customerId, pharmacy_id: pharmacyId, points }
  );
  if (updated.changes === 0) {
    const exists = getOne('SELECT id FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: customerId,
      pharmacy_id: pharmacyId
    });
    throw new PointError(exists ? '포인트 잔액이 부족합니다.' : '회원을 찾을 수 없습니다.', exists ? 400 : 404);
  }
  const balance = getOne('SELECT point_balance FROM customers WHERE id = @id', { id: customerId }).point_balance;
  run(
    `INSERT INTO point_ledger (pharmacy_id, customer_id, order_id, entry_type, points, balance_after, reason, created_by)
     VALUES (@pharmacy_id, @customer_id, @order_id, @entry_type, @points, @balance_after, @reason, @created_by)`,
    {
      pharmacy_id: pharmacyId,
      customer_id: customerId,
      order_id: orderId,
      entry_type: entryType,
      points,
      balance_after: balance,
      reason,
      created_by: userId
    }
  );
  return balance;
}

// 일반의약품은 포인트 적립·사용 대상에서 제외한다.
function pointEligibleAmount(items) {
  return items
    .filter((item) => (item.product_type || 'GENERAL') !== 'OTC')
    .reduce((sum, item) => sum + (item.total_price - (item.discount_amount || 0)), 0);
}

// 적립률 = (기본 적립률 + 등급 추가 적립률) × 생일 달 배수. 약국이 기본 적립률을 0으로 두면 적립하지 않는다.
function earnRate(policy, { bonus = 0, multiplier = 1 } = {}) {
  if (!policy.enabled || policy.earn_rate <= 0) return 0;
  return Math.round((policy.earn_rate + bonus) * multiplier * 100) / 100;
}

function calcEarn(policy, eligibleAmount, pointsUsed, boost) {
  const rate = earnRate(policy, boost);
  if (rate <= 0) return 0;
  const base = Math.max(0, eligibleAmount - pointsUsed);
  return Math.floor((base * Math.round(rate * 100)) / 10000);
}

function customerLedger(pharmacyId, customerId, limit = 50) {
  return getAll(
    `SELECT l.id, l.order_id, l.entry_type, l.points, l.balance_after, l.reason, l.created_at,
            o.order_number, u.name AS created_by_name
     FROM point_ledger l
     LEFT JOIN orders o ON o.id = l.order_id
     LEFT JOIN users u ON u.id = l.created_by
     WHERE l.pharmacy_id = @pharmacy_id AND l.customer_id = @customer_id
     ORDER BY l.id DESC
     LIMIT @limit`,
    { pharmacy_id: pharmacyId, customer_id: customerId, limit }
  );
}

module.exports = {
  POINT_ENTRY_LABELS,
  PointError,
  pointPolicy,
  changePoints,
  pointEligibleAmount,
  earnRate,
  calcEarn,
  customerLedger
};
