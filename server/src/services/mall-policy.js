const { getAll, getOne, run } = require('../db');
const { onlineSellableSql } = require('./product-kind');

// 약국 온라인 몰 정책: 배송·픽업 사용, 배송비, 무료배송 기준, 몰 공지. 결제 금액은 서버가 이 값으로만 계산한다.
const LIMITS = { fee: 100000, freeMin: 10000000, notice: 300 };

class MallPolicyError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function mallPolicy(pharmacyId) {
  const row = getOne(
    `SELECT delivery_enabled, delivery_fee, free_delivery_min, pickup_enabled, mall_notice
     FROM pharmacies WHERE id = @id`,
    { id: pharmacyId }
  );
  if (!row) return null;
  return {
    delivery_enabled: Number(row.delivery_enabled) === 1,
    delivery_fee: Number(row.delivery_fee) || 0,
    // 0이면 무료배송 기준 없음(항상 배송비)
    free_delivery_min: Number(row.free_delivery_min) || 0,
    pickup_enabled: Number(row.pickup_enabled) === 1,
    notice: row.mall_notice || ''
  };
}

function deliveryFeeFor(policy, productTotal) {
  if (!policy.delivery_fee) return 0;
  if (policy.free_delivery_min && productTotal >= policy.free_delivery_min) return 0;
  return policy.delivery_fee;
}

function wholeWon(value, label, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new MallPolicyError(`${label}는 0 ~ ${max.toLocaleString()}원 사이 정수로 입력해 주세요.`);
  }
  return number;
}

function updateMallPolicy(pharmacyId, body) {
  const current = mallPolicy(pharmacyId);
  const flag = (value, fallback) => (value === undefined ? fallback : value === true || value === 1 || value === '1' || value === 'true');
  const next = {
    delivery_enabled: flag(body.delivery_enabled, current.delivery_enabled),
    pickup_enabled: flag(body.pickup_enabled, current.pickup_enabled),
    delivery_fee: body.delivery_fee === undefined ? current.delivery_fee : wholeWon(body.delivery_fee, '배송비', LIMITS.fee),
    free_delivery_min:
      body.free_delivery_min === undefined ? current.free_delivery_min : wholeWon(body.free_delivery_min, '무료배송 기준 금액', LIMITS.freeMin),
    notice: body.notice === undefined ? current.notice : String(body.notice || '').trim()
  };
  if (next.notice.length > LIMITS.notice) throw new MallPolicyError(`몰 공지는 ${LIMITS.notice}자 이내로 입력해 주세요.`);
  if (!next.delivery_enabled && !next.pickup_enabled) throw new MallPolicyError('배송과 매장 픽업 중 하나는 켜 두어야 고객이 주문할 수 있습니다.');
  run(
    `UPDATE pharmacies
     SET delivery_enabled = @delivery_enabled, delivery_fee = @delivery_fee, free_delivery_min = @free_delivery_min,
         pickup_enabled = @pickup_enabled, mall_notice = @notice, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    {
      id: pharmacyId,
      delivery_enabled: next.delivery_enabled ? 1 : 0,
      pickup_enabled: next.pickup_enabled ? 1 : 0,
      delivery_fee: next.delivery_fee,
      free_delivery_min: next.free_delivery_min,
      notice: next.notice || null
    }
  );
  return mallPolicy(pharmacyId);
}

// 전자상거래 판매자 표시 정보(상호·대표자·사업자등록번호·주소·전화).
function sellerInfo(pharmacyId) {
  return getOne('SELECT pharmacy_name, owner_name, business_number, address, phone FROM pharmacies WHERE id = @id', { id: pharmacyId }) || null;
}

// 최근 30일 실제로 팔린 수량(취소·환불 뺀 값) 기준 인기 상품. 지금 온라인에서 파는 상품만, 팔린 적이 있어야 들어간다.
function popularProductIds(pharmacyId, limit = 10) {
  return getAll(
    `SELECT oi.product_id, SUM(oi.quantity - COALESCE(oi.refunded_quantity, 0)) AS sold
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE o.pharmacy_id = @pharmacy_id AND p.pharmacy_id = @pharmacy_id
       AND o.payment_status = 'PAID' AND o.canceled_at IS NULL
       AND o.order_type NOT IN ('COUNSEL', 'POS_REFUND', 'ONLINE_REFUND')
       AND o.created_at >= datetime('now', '-30 days')
       AND ${onlineSellableSql('p')}
     GROUP BY oi.product_id
     HAVING sold > 0
     ORDER BY sold DESC, oi.product_id DESC
     LIMIT @limit`,
    { pharmacy_id: pharmacyId, limit }
  ).map((row) => row.product_id);
}

module.exports = { MallPolicyError, deliveryFeeFor, mallPolicy, popularProductIds, sellerInfo, updateMallPolicy };
