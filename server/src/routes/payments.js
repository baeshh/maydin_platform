const express = require('express');
const { getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { paymentConfig } = require('../services/payment-gateway');
const payments = require('../services/online-payments');

const router = express.Router();

// 결과 상태 → HTTP. 결과를 아직 모르면 202로 알려 주고 화면이 다시 확인하게 한다.
const STATE_HTTP = { DONE: 200, READY: 409, CONFIRMING: 202, UNKNOWN: 202, REFUND_REQUIRED: 202, FAILED: 402, CANCELED: 409, EXPIRED: 410 };

function send(res, error) {
  if (error instanceof payments.PaymentError) {
    return res.status(error.status).json({ message: error.message, reason: error.reason, ...error.extra });
  }
  console.error(error);
  return res.status(500).json({ message: '결제 처리 중 서버 오류가 발생했습니다. 주문 내역에서 결제 결과를 확인해 주세요.' });
}

function outcomeBody(result) {
  return {
    state: result.state,
    pending: STATE_HTTP[result.state] === 202,
    message: result.state === 'DONE' ? null : result.message || result.checkout?.status_label,
    checkout: result.checkout,
    order: result.order
  };
}

function sendOutcome(res, result) {
  res.status(STATE_HTTP[result.state] || 200).json(outcomeBody(result));
}

function myCustomer(req) {
  return getOne('SELECT * FROM customers WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    user_id: req.user.id,
    pharmacy_id: req.pharmacyId
  });
}

function myCheckout(req, id = req.params.id) {
  const checkout = payments.getCheckout(Number(id));
  const customer = myCustomer(req);
  if (!checkout || !customer || checkout.customer_id !== customer.id) {
    throw new payments.PaymentError('결제 요청을 찾을 수 없습니다.', 404, 'NOT_FOUND');
  }
  return checkout;
}

// 결제 모드 안내(로그인 없이도 결제 화면에서 확인). 키 중 공개해도 되는 클라이언트 키만 내려 준다.
router.get('/config', (req, res) => {
  const config = paymentConfig();
  res.json({
    provider: config.provider,
    mode: config.mode,
    enabled: config.enabled,
    label: config.label,
    message: config.message || null,
    client_key: config.enabled ? config.clientKey || null : null
  });
});

// 결제사 웹훅. 인증 대신 결제사 재조회로 검증한다. 처리에 실패하면 5xx로 답해 결제사가 다시 보내게 한다.
router.post('/webhook/:provider', async (req, res) => {
  try {
    res.json(await payments.handleWebhook(req.params.provider, req.body, req.headers));
  } catch (error) {
    if (error instanceof payments.PaymentError && error.status < 500) return res.status(error.status).json({ message: error.message });
    console.error('[payments] 웹훅 처리 실패', error.message);
    res.status(500).json({ message: '웹훅 처리 실패' });
  }
});

router.use(authenticate);

router.post('/checkouts', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  try {
    const { checkout, reused } = payments.createCheckout({
      userId: req.user.id,
      customer: myCustomer(req),
      pharmacyId: req.pharmacyId,
      body: req.body || {}
    });
    res.status(reused ? 200 : 201).json({ checkout: payments.publicCheckout(checkout), reused });
  } catch (error) {
    send(res, error);
  }
});

router.get('/checkouts/:id', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  try {
    res.json(outcomeBody(payments.outcome(myCheckout(req).id)));
  } catch (error) {
    send(res, error);
  }
});

// 결과 확인 중인 결제를 지금 결제사에 조회해 맞춘다.
router.post('/checkouts/:id/sync', requireRole('CUSTOMER'), requirePharmacyScope, async (req, res) => {
  try {
    sendOutcome(res, await payments.syncCheckout(myCheckout(req).id));
  } catch (error) {
    send(res, error);
  }
});

// 결제창 인증을 마치고 돌아온 고객 브라우저가 부른다. 서버가 금액을 맞춰 본 뒤 결제사에 승인을 요청한다.
router.post('/confirm', requireRole('CUSTOMER'), requirePharmacyScope, async (req, res) => {
  try {
    const result = await payments.confirmPayment({
      customer: myCustomer(req),
      paymentKey: req.body.paymentKey,
      orderId: req.body.orderId,
      amount: req.body.amount
    });
    sendOutcome(res, result);
  } catch (error) {
    send(res, error);
  }
});

// (데모) 결제창: 실제 결제사 대신 인증만 흉내 내고 결제 키를 준다. 데모 모드에서만 열린다.
router.post('/demo/authorize', requireRole('CUSTOMER'), requirePharmacyScope, (req, res) => {
  try {
    const checkout = myCheckout(req, req.body.checkout_id);
    res.json(payments.demoAuthorize(checkout, String(req.body.scenario || 'APPROVE').toUpperCase()));
  } catch (error) {
    send(res, error);
  }
});

// 약국: 결과 확인이 필요한 결제와 결제사 쪽 취소 알림.
router.get('/attention', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  res.json({ config: paymentConfig().label, ...payments.attentionList(req.pharmacyId) });
});

router.post('/orders/:id/alert/resolve', requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope, (req, res) => {
  const order = getOne('SELECT id, order_number, payment_alert FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.pharmacyId
  });
  if (!order) return res.status(404).json({ message: '주문을 찾을 수 없습니다.' });
  const note = String(req.body.note || '').trim().slice(0, 200);
  if (note.length < 2) return res.status(400).json({ message: '어떻게 확인·처리했는지 적어 주세요.' });
  run('UPDATE orders SET payment_alert = NULL WHERE id = @id', { id: order.id });
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, 'PAYMENT_ALERT_RESOLVE', 'ORDER', @id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.pharmacyId, id: order.id, description: `${order.order_number} ${order.payment_alert || ''} → ${note}` }
  );
  res.json({ ok: true });
});

// 정산 작업을 바로 돌린다(만료 처리·결과 미확인 결제 조회·멈춘 취소 이어서 처리).
router.post('/reconcile', requireRole('ADMIN'), async (req, res) => {
  try {
    res.json(await payments.runPaymentReconcile());
  } catch (error) {
    send(res, error);
  }
});

module.exports = router;
