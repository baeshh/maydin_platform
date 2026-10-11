const crypto = require('crypto');
const { getOne, run } = require('../db');

// 결제사 연동. 실제 결제사는 토스페이먼츠(코어 API v1)만, 그 밖에는 실제 돈이 오가지 않는 데모 결제사를 둔다.
// 서버는 결제사의 응답(승인 상태·금액·주문번호)을 직접 다시 확인한 뒤에만 주문을 만든다.

class GatewayError extends Error {
  // unknown: 결제사가 처리했는지 알 수 없음(시간 초과·5xx). 결과를 조회해서 맞춰야 한다.
  constructor(message, { code = 'PG_ERROR', status = 502, unknown = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.unknown = unknown;
  }
}

const PROVIDER_LABELS = { TOSS: '토스페이먼츠', DEMO: '데모 결제', MOCK: '데모 결제' };

function disabled(provider, message) {
  return { provider, mode: 'DISABLED', enabled: false, label: '온라인 결제 중지', message };
}

// 운영(NODE_ENV=production)에서는 실제 결제가 확실히 켜진 경우에만 온라인 결제를 연다(실패 시 닫힘).
function paymentConfig(env = process.env) {
  const provider = String(env.PG_PROVIDER || 'DEMO').trim().toUpperCase();
  const production = env.NODE_ENV === 'production';

  if (provider === 'TOSS') {
    const secretKey = String(env.TOSS_SECRET_KEY || '').trim();
    const clientKey = String(env.TOSS_CLIENT_KEY || '').trim();
    if (!secretKey || !clientKey) return disabled(provider, '결제사 키가 설정되지 않아 온라인 결제를 받을 수 없습니다.');
    const live = secretKey.startsWith('live_');
    if (live !== clientKey.startsWith('live_')) return disabled(provider, '결제사 클라이언트 키와 시크릿 키의 종류(테스트/실결제)가 다릅니다.');
    if (live && env.PG_LIVE_ENABLED !== 'true') {
      return disabled(provider, '실결제 키가 있지만 운영 전환(PG_LIVE_ENABLED=true)을 하지 않아 온라인 결제를 막아 두었습니다.');
    }
    if (!live && production && env.ALLOW_TEST_PAYMENTS !== 'true') {
      return disabled(provider, '운영 서버에서는 테스트 키로 결제를 받을 수 없습니다.');
    }
    return {
      provider,
      mode: live ? 'LIVE' : 'TEST',
      enabled: true,
      clientKey,
      label: live ? PROVIDER_LABELS.TOSS : `${PROVIDER_LABELS.TOSS} (테스트 — 실제 청구 없음)`,
      message: live ? null : '테스트 결제입니다. 카드에 실제로 청구되지 않으니 상품을 내보내지 마세요.'
    };
  }

  if (provider === 'DEMO') {
    if (production && env.ALLOW_DEMO_PAYMENTS !== 'true') {
      return disabled(provider, '운영 서버에서는 데모 결제를 쓸 수 없습니다. 결제사 연동을 마친 뒤 온라인 주문을 열어 주세요.');
    }
    return {
      provider,
      mode: 'DEMO',
      enabled: true,
      label: '(데모) 결제',
      message: '(데모) 실제 돈이 오가지 않는 시험용 결제입니다. 상품을 내보내지 마세요.'
    };
  }

  return disabled(provider, provider === 'NONE' ? '온라인 결제를 꺼 두었습니다. 매장에서 구매해 주세요.' : `지원하지 않는 결제사(${provider})입니다.`);
}

function providerLabel(provider, mode) {
  const base = PROVIDER_LABELS[provider] || provider;
  if (provider === 'MOCK' || mode === 'DEMO') return '(데모) 결제';
  if (mode === 'TEST') return `${base} (테스트)`;
  return base;
}

/* ---------- 데모 결제사: 같은 DB 안에서 결제사 쪽 기록을 흉내 낸다. 실제 청구는 없다. ---------- */

function demoPayment(row) {
  if (!row) return null;
  const canceled = row.status === 'CANCELED';
  return {
    paymentKey: row.payment_key,
    orderId: row.order_id,
    status: row.status,
    totalAmount: row.amount,
    balanceAmount: canceled ? 0 : row.amount,
    method: '(데모) 카드',
    approvedAt: row.approved_at,
    receiptUrl: null,
    cancels: canceled ? [{ amount: row.amount, transactionKey: row.cancel_transaction_key, canceledAt: row.canceled_at, reason: row.cancel_reason }] : []
  };
}

const DEMO_SCENARIOS = new Set(['APPROVE', 'DECLINE', 'TIMEOUT', 'CANCEL_FAIL', 'CANCEL_TIMEOUT']);

const demo = {
  provider: 'DEMO',

  // 결제창에서 고객이 인증을 마친 상태. 같은 주문번호로 이미 승인된 결제가 있으면 결제사처럼 거절한다.
  authorize({ orderId, amount, orderName, scenario = 'APPROVE' }) {
    const normalized = DEMO_SCENARIOS.has(scenario) ? scenario : 'APPROVE';
    const done = getOne("SELECT id FROM pg_demo_payments WHERE order_id = @order_id AND status IN ('DONE', 'CANCELED')", { order_id: orderId });
    if (done) throw new GatewayError('이미 결제된 주문번호입니다.', { code: 'DUPLICATED_ORDER_ID', status: 409 });
    const paymentKey = `demo_${crypto.randomBytes(12).toString('hex')}`;
    run(
      `INSERT INTO pg_demo_payments (payment_key, order_id, order_name, amount, scenario)
       VALUES (@payment_key, @order_id, @order_name, @amount, @scenario)`,
      { payment_key: paymentKey, order_id: orderId, order_name: orderName, amount, scenario: normalized }
    );
    return { paymentKey, orderId, amount };
  },

  async confirm({ paymentKey, orderId, amount }) {
    const row = getOne('SELECT * FROM pg_demo_payments WHERE payment_key = @key', { key: paymentKey });
    if (!row) throw new GatewayError('결제 정보를 찾을 수 없습니다.', { code: 'NOT_FOUND_PAYMENT', status: 404 });
    if (row.order_id !== orderId || row.amount !== Number(amount)) {
      throw new GatewayError('결제 금액 또는 주문번호가 결제창 요청과 다릅니다.', { code: 'INVALID_REQUEST', status: 400 });
    }
    if (row.status === 'DONE') return demoPayment(row);
    if (row.status !== 'IN_PROGRESS') throw new GatewayError('승인할 수 없는 결제입니다.', { code: 'INVALID_PAYMENT_STATUS', status: 400 });
    if (row.scenario === 'DECLINE') {
      run("UPDATE pg_demo_payments SET status = 'ABORTED' WHERE id = @id", { id: row.id });
      throw new GatewayError('(데모) 카드사에서 결제를 거절했습니다.', { code: 'REJECT_CARD_COMPANY', status: 403 });
    }
    run("UPDATE pg_demo_payments SET status = 'DONE', approved_at = CURRENT_TIMESTAMP WHERE id = @id AND status = 'IN_PROGRESS'", { id: row.id });
    if (row.scenario === 'TIMEOUT') {
      run("UPDATE pg_demo_payments SET scenario = 'APPROVE' WHERE id = @id", { id: row.id });
      throw new GatewayError('(데모) 결제사 응답 시간이 초과되었습니다.', { code: 'NETWORK', unknown: true });
    }
    return demoPayment(getOne('SELECT * FROM pg_demo_payments WHERE id = @id', { id: row.id }));
  },

  async lookup({ paymentKey, orderId }) {
    const row = paymentKey
      ? getOne('SELECT * FROM pg_demo_payments WHERE payment_key = @key', { key: paymentKey })
      : getOne('SELECT * FROM pg_demo_payments WHERE order_id = @order_id ORDER BY id DESC LIMIT 1', { order_id: orderId });
    if (!row) throw new GatewayError('결제 정보를 찾을 수 없습니다.', { code: 'NOT_FOUND_PAYMENT', status: 404 });
    return demoPayment(row);
  },

  async cancel({ paymentKey, reason }) {
    const row = getOne('SELECT * FROM pg_demo_payments WHERE payment_key = @key', { key: paymentKey });
    if (!row) throw new GatewayError('결제 정보를 찾을 수 없습니다.', { code: 'NOT_FOUND_PAYMENT', status: 404 });
    if (row.status === 'CANCELED') return demoPayment(row);
    if (row.status !== 'DONE') throw new GatewayError('취소할 수 없는 결제 상태입니다.', { code: 'NOT_CANCELABLE_PAYMENT', status: 400 });
    if (row.scenario === 'CANCEL_FAIL') throw new GatewayError('(데모) 결제사에서 취소를 처리하지 못했습니다.', { code: 'PROVIDER_ERROR', status: 502 });
    if (row.scenario === 'CANCEL_TIMEOUT') {
      run(
        `UPDATE pg_demo_payments SET status = 'CANCELED', canceled_at = CURRENT_TIMESTAMP, cancel_reason = @reason,
           cancel_transaction_key = @tx, scenario = 'APPROVE' WHERE id = @id`,
        { id: row.id, reason, tx: `demo_cx_${crypto.randomBytes(8).toString('hex')}` }
      );
      throw new GatewayError('(데모) 결제사 응답 시간이 초과되었습니다.', { code: 'NETWORK', unknown: true });
    }
    run(
      `UPDATE pg_demo_payments SET status = 'CANCELED', canceled_at = CURRENT_TIMESTAMP, cancel_reason = @reason,
         cancel_transaction_key = @tx WHERE id = @id AND status = 'DONE'`,
      { id: row.id, reason, tx: `demo_cx_${crypto.randomBytes(8).toString('hex')}` }
    );
    return demoPayment(getOne('SELECT * FROM pg_demo_payments WHERE id = @id', { id: row.id }));
  }
};

/* ---------- 토스페이먼츠 코어 API ---------- */

function tossPayment(data) {
  return {
    paymentKey: data.paymentKey,
    orderId: data.orderId,
    status: data.status,
    totalAmount: Number(data.totalAmount),
    balanceAmount: Number(data.balanceAmount ?? data.totalAmount),
    method: data.easyPay?.provider ? `${data.method || '간편결제'} · ${data.easyPay.provider}` : data.method || null,
    approvedAt: data.approvedAt || null,
    receiptUrl: data.receipt?.url || null,
    cancels: (data.cancels || []).map((c) => ({
      amount: Number(c.cancelAmount),
      transactionKey: c.transactionKey,
      canceledAt: c.canceledAt,
      reason: c.cancelReason
    }))
  };
}

async function tossRequest(method, path, { body, idempotencyKey } = {}) {
  const secretKey = String(process.env.TOSS_SECRET_KEY || '').trim();
  if (!secretKey) throw new GatewayError('결제사 키가 설정되지 않았습니다.', { code: 'PG_NOT_CONFIGURED', status: 503 });
  const base = String(process.env.TOSS_API_BASE || 'https://api.tosspayments.com').replace(/\/$/, '');
  const timeout = Number(process.env.PG_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    throw new GatewayError('결제사 응답이 없습니다. 결제 결과를 다시 확인합니다.', { code: 'NETWORK', unknown: true });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  throw new GatewayError(data.message || `결제사 오류 (${res.status})`, {
    code: data.code || `HTTP_${res.status}`,
    status: res.status >= 500 ? 502 : res.status,
    unknown: res.status >= 500 || data.code === 'ALREADY_PROCESSED_PAYMENT' || data.code === 'PROVIDER_ERROR'
  });
}

const toss = {
  provider: 'TOSS',

  async confirm({ paymentKey, orderId, amount, idempotencyKey }) {
    return tossPayment(await tossRequest('POST', '/v1/payments/confirm', { body: { paymentKey, orderId, amount }, idempotencyKey }));
  },

  async lookup({ paymentKey, orderId }) {
    const path = paymentKey ? `/v1/payments/${encodeURIComponent(paymentKey)}` : `/v1/payments/orders/${encodeURIComponent(orderId)}`;
    return tossPayment(await tossRequest('GET', path));
  },

  async cancel({ paymentKey, reason, idempotencyKey }) {
    return tossPayment(
      await tossRequest('POST', `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
        body: { cancelReason: String(reason || '주문 취소').slice(0, 200) },
        idempotencyKey
      })
    );
  }
};

const ADAPTERS = { DEMO: demo, TOSS: toss };

function gatewayFor(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new GatewayError(`${provider} 결제는 자동 취소를 지원하지 않습니다.`, { code: 'UNSUPPORTED_PROVIDER', status: 409 });
  return adapter;
}

function isGatewayProvider(provider) {
  return Boolean(ADAPTERS[provider]);
}

module.exports = {
  GatewayError,
  demo,
  gatewayFor,
  isGatewayProvider,
  paymentConfig,
  providerLabel
};
