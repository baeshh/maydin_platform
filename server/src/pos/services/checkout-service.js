const crypto = require('crypto');
const { getAll, getOne, run } = require('../../db');
const { issueSignupCode } = require('../../services/member-auth');
const { earningContext, grantReferralReward } = require('../../services/members');
const { saleCost } = require('../../services/order-cost');
const { recordHistory } = require('../../services/order-flow');
const { calcEarn, changePoints, earnRate, pointEligibleAmount, pointPolicy } = require('../../services/points');
const { RECOVERY_SOURCES } = require('../../services/pos-recovery');
const { posSaleBlockReason } = require('../../services/product-kind');
const { COUNSEL_OPEN_STATUSES, PAYMENT_METHODS, PosError, audit, cleanText, isOwner, nextOrderNumber, toInt, won } = require('../common');
const { logInventory } = require('./inventory-service');
const { insertPayments, normalizePayments } = require('./payment-service');
const { buildReceipt } = require('./sale-service');

// 판매 요청(상품·할인·회원)을 읽는다. 장애 중 판매는 그때 받은 가격을 그대로 기록한다.
function parseSaleRequest(body, { recovery = null } = {}) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) throw new PosError('판매할 상품을 담아 주세요.');
  // 같은 상품을 다른 가격으로 두 번 담을 수는 없다.
  const items = new Map();
  for (const raw of rawItems) {
    const productId = Number(raw.product_id);
    const quantity = toInt(raw.quantity, '수량', { min: 1, max: 999 });
    const price = recovery && raw.price !== undefined && raw.price !== null ? toInt(raw.price, '판매 가격') : null;
    const line = items.get(productId);
    if (line && line.price !== price) throw new PosError('같은 상품을 다른 가격으로 나눠 담을 수 없습니다.');
    items.set(productId, { quantity: (line?.quantity || 0) + quantity, price });
  }
  return {
    items,
    customerId: body.customer_id ? Number(body.customer_id) : null,
    counselOrderId: recovery ? null : body.counsel_order_id ? Number(body.counsel_order_id) : null,
    discountAmount: toInt(body.discount_amount || 0, '할인 금액'),
    discountReason: cleanText(body.discount_reason),
    memo: cleanText(body.memo, 500)
  };
}

// 결제 전 판매(초안)에 저장하는 꼴. 상품 번호·수량·할인·회원 번호만 담는다.
function serializeRequest(request) {
  return JSON.stringify({
    items: [...request.items].map(([id, line]) => [id, line.quantity, line.price ?? null]).sort((a, b) => a[0] - b[0]),
    customer_id: request.customerId,
    counsel_order_id: request.counselOrderId,
    discount_amount: request.discountAmount,
    discount_reason: request.discountReason,
    memo: request.memo
  });
}

function deserializeRequest(json) {
  const data = JSON.parse(json);
  return {
    items: new Map(data.items.map(([id, quantity, price]) => [id, { quantity, price }])),
    customerId: data.customer_id,
    counselOrderId: data.counsel_order_id,
    discountAmount: data.discount_amount,
    discountReason: data.discount_reason,
    memo: data.memo
  };
}

function requestHash(request) {
  return crypto.createHash('sha256').update(serializeRequest(request)).digest('hex');
}

// 상품·재고·할인·회원을 확인해 판매 줄과 결제할 금액을 정한다. DB는 바꾸지 않는다.
function priceSale(req, request, { recovery = null } = {}) {
  const lines = [];
  for (const [productId, { quantity, price: chargedPrice }] of request.items) {
    const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: productId,
      pharmacy_id: req.pharmacyId
    });
    if (!product || (!recovery && product.status === 'HIDDEN')) throw new PosError('판매할 수 없는 상품이 포함되어 있습니다.');
    const blocked = posSaleBlockReason(product, { isPharmacist: isOwner(req) });
    if (blocked) throw new PosError(blocked.message, blocked.status);
    // 장애 중에 이미 건넨 상품은 시스템 재고가 모자라도 기록한다. 모자란 만큼은 재고 대사에서 맞춘다.
    if (!recovery) {
      if (product.status !== 'ON_SALE' || product.stock_quantity <= 0) {
        throw new PosError(`${product.product_name}은(는) 품절 상품입니다.`);
      }
      if (product.stock_quantity < quantity) {
        throw new PosError(`${product.product_name} 재고가 부족합니다. (현재 ${product.stock_quantity}개)`);
      }
    }
    const price = chargedPrice ?? Number(product.discount_price || product.price);
    const taken = Math.min(quantity, Math.max(0, product.stock_quantity));
    lines.push({ product, quantity, price, total: price * quantity, taken, shortage: quantity - taken });
  }

  const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
  const { discountAmount, discountReason } = request;
  if (discountAmount > subtotal) throw new PosError('할인 금액이 상품 합계보다 클 수 없습니다.');
  if (discountAmount > 0 && !discountReason) throw new PosError('할인 사유를 입력해 주세요.');

  let customer = null;
  if (request.customerId) {
    customer = getOne("SELECT * FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id AND approval_status = 'APPROVED'", {
      id: request.customerId,
      pharmacy_id: req.pharmacyId
    });
    if (!customer) throw new PosError('선택한 회원을 찾을 수 없습니다.');
  }

  let counsel = null;
  if (request.counselOrderId) {
    counsel = getOne("SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id AND order_type = 'COUNSEL'", {
      id: request.counselOrderId,
      pharmacy_id: req.pharmacyId
    });
    if (!counsel) throw new PosError('연결할 복약상담 예약을 찾을 수 없습니다.');
    if (!customer && counsel.customer_id) {
      customer = getOne('SELECT * FROM customers WHERE id = @id', { id: counsel.customer_id });
    }
  }

  return { lines, subtotal, finalAmount: subtotal - discountAmount, customer, counsel };
}

// 판매를 저장한다: 주문·품목·재고·결제·포인트·상담 완료·감사 기록. 호출하는 쪽이 트랜잭션을 연다.
function createPosSale(req, { terminal, session, request, payments: rawPayments, clientSaleId = null, fingerprint = null, recovery = null, draftId = null }) {
  const { lines, subtotal, finalAmount, customer, counsel } = priceSale(req, request, { recovery });
  const { discountAmount, discountReason, memo } = request;
  const payments = normalizePayments(rawPayments, finalAmount, { allowPoint: !recovery });
  if (recovery && payments.some((p) => p.van_transaction_id)) {
    throw new PosError('장애 중 거래는 카드 단말기 영수증의 승인번호를 직접 입력해 주세요.');
  }

  const orderResult = run(
    `INSERT INTO orders (
      order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, delivery_fee,
      discount_amount, final_amount, payment_status, order_status, delivery_status, memo, contact_name,
      contact_phone, pos_terminal_id, pos_session_id, cashier_user_id, discount_reason, counsel_order_id,
      client_sale_id, client_sale_hash, recovery_source, recovered_at, outage_id, created_at, updated_at
    ) VALUES (
      @order_number, @pharmacy_id, @customer_id, 'POS_SALE', 'POS', @subtotal, 0,
      @discount_amount, @final_amount, 'PAID', 'COMPLETED', 'NOT_APPLICABLE', @memo, @contact_name,
      @contact_phone, @terminal_id, @session_id, @user_id, @discount_reason, @counsel_order_id,
      @client_sale_id, @client_sale_hash, @recovery_source, @recovered_at, @outage_id,
      COALESCE(@occurred_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
    )`,
    {
      order_number: nextOrderNumber('POS', req.pharmacyId),
      pharmacy_id: req.pharmacyId,
      customer_id: customer ? customer.id : null,
      subtotal,
      discount_amount: discountAmount,
      final_amount: finalAmount,
      memo,
      contact_name: customer ? customer.name : null,
      contact_phone: customer ? customer.phone : null,
      terminal_id: terminal.id,
      session_id: session.id,
      user_id: req.user.id,
      discount_reason: discountAmount > 0 ? discountReason : null,
      counsel_order_id: counsel ? counsel.id : null,
      client_sale_id: clientSaleId,
      client_sale_hash: fingerprint,
      recovery_source: recovery ? recovery.source : null,
      recovered_at: recovery ? getOne('SELECT CURRENT_TIMESTAMP AS now').now : null,
      outage_id: recovery?.outage ? recovery.outage.id : null,
      occurred_at: recovery ? recovery.occurredAt : null
    }
  );
  const orderId = orderResult.lastInsertRowid;

  let discountLeft = discountAmount;
  lines.forEach((line, index) => {
    const share =
      index === lines.length - 1 ? discountLeft : subtotal > 0 ? Math.floor((line.total * discountAmount) / subtotal) : 0;
    discountLeft -= share;

    run(
      `INSERT INTO order_items (
        order_id, product_id, product_name, quantity, price, total_price, product_type, tax_type, discount_amount, discount_reason,
        unit_cost, cost_amount, cost_source, stock_shortage
      ) VALUES (
        @order_id, @product_id, @product_name, @quantity, @price, @total_price, @product_type, @tax_type, @discount_amount, @discount_reason,
        @unit_cost, @cost_amount, @cost_source, @stock_shortage
      )`,
      {
        order_id: orderId,
        product_id: line.product.id,
        product_name: line.product.product_name,
        quantity: line.quantity,
        price: line.price,
        total_price: line.total,
        product_type: line.product.product_type || 'GENERAL',
        tax_type: line.product.tax_type || 'TAXABLE',
        discount_amount: share,
        discount_reason: share > 0 ? discountReason : null,
        stock_shortage: line.shortage,
        ...saleCost(line.product.id, line.quantity)
      }
    );

    if (line.taken === 0) return;
    const stock = run(
      `UPDATE products
       SET stock_quantity = stock_quantity - @quantity,
           status = CASE WHEN stock_quantity - @quantity <= 0 THEN 'SOLD_OUT' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = @id AND pharmacy_id = @pharmacy_id AND stock_quantity >= @quantity`,
      { id: line.product.id, pharmacy_id: req.pharmacyId, quantity: line.taken }
    );
    if (stock.changes === 0) throw new PosError(`${line.product.product_name} 재고가 부족합니다.`);
    logInventory(
      req,
      line.product.id,
      line.product.stock_quantity,
      line.product.stock_quantity - line.taken,
      'POS_SALE',
      recovery
        ? `장애 복구 판매 재고 차감${line.shortage ? ` · 시스템 재고 ${line.shortage}개 부족 (재고 대사 필요)` : ''}`
        : '현장 판매 재고 차감',
      orderId
    );
  });

  const policy = pointPolicy(req.pharmacyId);
  const pointsUsed = payments.filter((p) => p.method === 'POINT').reduce((sum, p) => sum + p.amount, 0);
  const eligible = pointEligibleAmount(
    getAll('SELECT total_price, discount_amount, product_type FROM order_items WHERE order_id = @id', { id: orderId })
  );
  if (pointsUsed > 0) {
    if (!customer) throw new PosError('포인트는 회원을 선택한 뒤 사용할 수 있습니다.');
    if (!policy.enabled) throw new PosError('이 약국은 포인트 사용을 중지했습니다.');
    if (pointsUsed < policy.min_use) throw new PosError(`포인트는 ${policy.min_use.toLocaleString('ko-KR')}P 이상부터 사용할 수 있습니다.`);
    if (pointsUsed > eligible) {
      throw new PosError(`일반의약품·분류 전 상품 금액은 포인트로 결제할 수 없습니다. (포인트 사용 가능 ${won(eligible)})`);
    }
  }

  insertPayments(orderId, payments, { session, terminal, userId: req.user.id, customerId: customer ? customer.id : null, draftId });
  if (recovery) {
    run('UPDATE payments SET paid_at = @at WHERE order_id = @id', { id: orderId, at: recovery.occurredAt });
  }

  const boost = customer ? earningContext(req.pharmacyId, customer.id, { excludeOrderId: orderId }) : null;
  const earned = customer ? calcEarn(policy, eligible, pointsUsed, boost) : 0;
  if (earned > 0) {
    const extras = [
      boost.bonus > 0 ? `${boost.grade_label} +${boost.bonus}%p` : null,
      boost.multiplier > 1 ? `생일 달 ${boost.multiplier}배` : null
    ].filter(Boolean);
    run('UPDATE orders SET points_earned = @points WHERE id = @id', { id: orderId, points: earned });
    changePoints({
      pharmacyId: req.pharmacyId,
      customerId: customer.id,
      orderId,
      entryType: 'EARN',
      points: earned,
      reason: `현장 구매 적립 ${earnRate(policy, boost)}%${extras.length ? ` (기본 ${policy.earn_rate}% · ${extras.join(' · ')})` : ''}`,
      userId: req.user.id
    });
  }
  const referral = customer ? grantReferralReward({ pharmacyId: req.pharmacyId, customerId: customer.id, orderId, userId: req.user.id }) : null;

  if (counsel && COUNSEL_OPEN_STATUSES.includes(counsel.order_status)) {
    run("UPDATE orders SET order_status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: counsel.id });
    recordHistory({ order: counsel, action: 'COUNSEL_SALE', from: counsel.order_status, to: 'COMPLETED', userId: req.user.id });
  }

  const methods = payments.map((p) => `${PAYMENT_METHODS[p.method]} ${won(p.amount)}`).join(' + ');
  audit(
    req,
    'POS_SALE',
    'ORDER',
    orderId,
    `현장 판매 ${won(finalAmount)} (${methods || '결제 없음'})${customer ? ` · 회원 ${customer.name}` : ' · 비회원'}${earned > 0 ? ` · 적립 ${earned}P` : ''}${referral ? ` · 추천 보상 ${referral.points}P (추천인 ${referral.referrer_name})` : ''}`
  );
  if (discountAmount > 0) {
    audit(req, 'POS_DISCOUNT', 'ORDER', orderId, `할인 ${won(discountAmount)} · 사유: ${discountReason}`);
  }
  if (recovery) {
    const shortage = lines.filter((line) => line.shortage > 0).map((line) => `${line.product.product_name} ${line.shortage}개`);
    audit(
      req,
      'POS_SALE_RECOVERED',
      'ORDER',
      orderId,
      `${RECOVERY_SOURCES[recovery.source]} · 장애 #${recovery.outage.id} · 실제 판매 ${recovery.occurredAt} UTC${recovery.note ? ` · ${recovery.note}` : ''}${shortage.length ? ` · 시스템 재고 부족: ${shortage.join(', ')}` : ''}`
    );
  }
  if (!recovery && !customer && finalAmount > 0) issueSignupCode({ pharmacyId: req.pharmacyId, orderId, userId: req.user.id });

  return { orderId, receipt: buildReceipt(req, orderId) };
}

module.exports = { createPosSale, deserializeRequest, parseSaleRequest, priceSale, requestHash, serializeRequest };
