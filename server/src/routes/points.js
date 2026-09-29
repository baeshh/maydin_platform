const express = require('express');
const { getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { POINT_ENTRY_LABELS, PointError, pointPolicy, changePoints, customerLedger } = require('../services/points');

const router = express.Router();

function audit(req, action, targetType, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, @target_type, @target_id, @description)`,
    {
      user_id: req.user.id,
      pharmacy_id: req.user.pharmacy_id,
      action,
      target_type: targetType,
      target_id: targetId,
      description
    }
  );
}

function fail(res, error) {
  if (error instanceof PointError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: '포인트 처리 중 오류가 발생했습니다.' });
}

function findCustomer(req) {
  return getOne(
    'SELECT id, name, phone, member_code, point_balance FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id',
    { id: Number(req.params.id), pharmacy_id: req.user.pharmacy_id }
  );
}

router.get('/me', authenticate, requireRole('CUSTOMER'), (req, res) => {
  const customer = getOne('SELECT id, pharmacy_id, point_balance FROM customers WHERE user_id = @user_id', {
    user_id: req.user.id
  });
  if (!customer) return res.status(404).json({ message: '고객 정보를 찾을 수 없습니다.' });
  return res.json({
    balance: customer.point_balance,
    policy: pointPolicy(customer.pharmacy_id),
    labels: POINT_ENTRY_LABELS,
    ledger: customerLedger(customer.pharmacy_id, customer.id, 30).map(({ created_by_name, ...entry }) => entry)
  });
});

router.use(authenticate, requireRole('PHARMACY_OWNER', 'POS_STAFF'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  return next();
});

router.get('/settings', (req, res) => {
  res.json({ policy: pointPolicy(req.user.pharmacy_id) });
});

router.patch('/settings', requireRole('PHARMACY_OWNER'), (req, res) => {
  const current = pointPolicy(req.user.pharmacy_id);
  const enabled = req.body.enabled === undefined ? current.enabled : Boolean(req.body.enabled);
  const earnRate = req.body.earn_rate === undefined ? current.earn_rate : Number(req.body.earn_rate);
  const minUse = req.body.min_use === undefined ? current.min_use : Number(req.body.min_use);
  if (!Number.isFinite(earnRate) || earnRate < 0 || earnRate > 10 || Math.round(earnRate * 10) !== earnRate * 10) {
    return res.status(400).json({ message: '적립률은 0~10% 사이, 소수점 한 자리까지 입력해 주세요.' });
  }
  if (!Number.isInteger(minUse) || minUse < 0 || minUse > 100000) {
    return res.status(400).json({ message: '최소 사용 포인트는 0~100,000P 사이로 입력해 주세요.' });
  }

  transaction(() => {
    run(
      `UPDATE pharmacies SET point_enabled = @enabled, point_earn_rate = @earn_rate, point_min_use = @min_use,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = @id`,
      { id: req.user.pharmacy_id, enabled: enabled ? 1 : 0, earn_rate: earnRate, min_use: minUse }
    );
    audit(
      req,
      'POINT_SETTING',
      'PHARMACY',
      req.user.pharmacy_id,
      `포인트 정책 변경 · ${enabled ? '사용' : '중지'} · 적립 ${earnRate}% · 최소 사용 ${minUse}P`
    );
  })();
  return res.json({ policy: pointPolicy(req.user.pharmacy_id) });
});

router.get('/customers/:id', (req, res) => {
  const customer = findCustomer(req);
  if (!customer) return res.status(404).json({ message: '고객을 찾을 수 없습니다.' });
  return res.json({ customer, labels: POINT_ENTRY_LABELS, ledger: customerLedger(req.user.pharmacy_id, customer.id) });
});

router.post('/customers/:id/adjust', requireRole('PHARMACY_OWNER'), (req, res) => {
  const points = Number(req.body.points);
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1000000) {
    return res.status(400).json({ message: '조정할 포인트를 입력해 주세요. (차감은 음수)' });
  }
  if (!reason) return res.status(400).json({ message: '조정 사유를 입력해 주세요.' });

  try {
    const result = transaction(() => {
      const customer = findCustomer(req);
      if (!customer) throw new PointError('고객을 찾을 수 없습니다.', 404);
      const balance = changePoints({
        pharmacyId: req.user.pharmacy_id,
        customerId: customer.id,
        entryType: 'ADJUST',
        points,
        reason,
        userId: req.user.id
      });
      audit(
        req,
        'POINT_ADJUST',
        'CUSTOMER',
        customer.id,
        `포인트 수동 조정 · ${customer.name} · ${points > 0 ? '+' : ''}${points}P → 잔액 ${balance}P · 사유: ${reason}`
      );
      return { balance, customer: findCustomer(req) };
    })();
    return res.json({ ...result, ledger: customerLedger(req.user.pharmacy_id, result.customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
