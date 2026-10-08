const express = require('express');
const { getAll, getOne, run, transaction, assignReferralCode } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  CONSENT_TYPES,
  CONSENT_SOURCES,
  GENDERS,
  CHANNEL_TYPES,
  CustomerError,
  currentConsents,
  consentHistory,
  normalizeConsentChanges,
  recordConsents,
  recordConsentNotice,
  normalizeProfile,
  validateBirthday
} = require('../services/customers');
const { customerMembership } = require('../services/members');
const { pointPolicy } = require('../services/points');

const router = express.Router();
router.use(authenticate);

function fail(res, error, fallback = '회원 정보를 처리하는 중 오류가 발생했습니다.') {
  if (error instanceof CustomerError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: fallback });
}

function audit(req, action, customerId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, 'CUSTOMER', @target_id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.user.pharmacy_id, action, target_id: customerId, description }
  );
}

function profileOf(customerId) {
  const customer = getOne(
    `SELECT c.id, c.pharmacy_id, c.name, c.phone, c.member_code, c.referral_code, c.point_balance, c.created_at,
            c.birth_year, c.birth_month, c.birth_day, c.gender, c.referred_by_customer_id,
            ch.name AS signup_channel_name, ch.channel_type AS signup_channel_type,
            r.name AS referrer_name,
            (SELECT COUNT(*) FROM customers x WHERE x.referred_by_customer_id = c.id) AS referred_count
     FROM customers c
     LEFT JOIN signup_channels ch ON ch.id = c.signup_channel_id
     LEFT JOIN customers r ON r.id = c.referred_by_customer_id
     WHERE c.id = @id`,
    { id: customerId }
  );
  if (!customer) return null;
  if (!customer.referral_code) customer.referral_code = assignReferralCode(customer.id);
  return customer;
}

function labels() {
  return {
    consent_types: Object.fromEntries(Object.entries(CONSENT_TYPES).map(([key, meta]) => [key, meta.label])),
    consent_sources: CONSENT_SOURCES,
    genders: GENDERS,
    channel_types: CHANNEL_TYPES
  };
}

function updateProfile(customer, body) {
  const profile = normalizeProfile(body, new Date().getFullYear());
  const merged = { birth_month: customer.birth_month, birth_day: customer.birth_day, ...profile };
  validateBirthday(merged.birth_month ?? null, merged.birth_day ?? null);
  const keys = Object.keys(profile);
  if (!keys.length) throw new CustomerError('변경할 내용이 없습니다.');
  run(`UPDATE customers SET ${keys.map((key) => `${key} = @${key}`).join(', ')} WHERE id = @id`, { ...profile, id: customer.id });
}

/* ---------- 고객 본인 ---------- */

function myCustomer(req) {
  const row = getOne('SELECT id FROM customers WHERE user_id = @user_id', { user_id: req.user.id });
  if (!row) throw new CustomerError('고객 정보를 찾을 수 없습니다.', 404);
  return profileOf(row.id);
}

router.get('/me', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const pharmacy = getOne('SELECT pharmacy_code, pharmacy_name FROM pharmacies WHERE id = @id', { id: customer.pharmacy_id });
    return res.json({
      customer,
      consents: currentConsents(customer.id),
      membership: customerMembership(customer.pharmacy_id, customer.id),
      point_enabled: pointPolicy(customer.pharmacy_id).enabled,
      pharmacy,
      labels: labels()
    });
  } catch (error) {
    return fail(res, error);
  }
});

// 생일 달 적립 배수가 있어서, 한 번 등록한 생일은 고객이 직접 바꾸지 못하게 한다.
router.patch('/me/profile', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const changesBirthday = ['birth_month', 'birth_day'].some(
      (key) => key in req.body && customer[key] != null && Number(req.body[key]) !== customer[key]
    );
    if (changesBirthday) throw new CustomerError('생일은 한 번 등록하면 앱에서 바꿀 수 없어요. 약국에 문의해 주세요.');
    updateProfile(customer, req.body);
    return res.json({ customer: profileOf(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/me/consents', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const changes = normalizeConsentChanges(req.body.consents);
    if (!Object.keys(changes).length) throw new CustomerError('변경할 동의 항목이 없습니다.');
    if (Object.entries(changes).some(([type, agreed]) => CONSENT_TYPES[type].required && !agreed)) {
      throw new CustomerError('필수 동의를 철회하려면 회원 탈퇴가 필요합니다. 약국에 문의해 주세요.');
    }
    transaction(() => recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes, source: 'APP', userId: req.user.id }))();
    return res.json({ consents: currentConsents(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

/* ---------- 약국 관리자 ---------- */

router.use(requireRole('PHARMACY_OWNER'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  return next();
});

function pharmacyCustomer(req) {
  const row = getOne('SELECT id FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    pharmacy_id: req.user.pharmacy_id
  });
  if (!row) throw new CustomerError('회원을 찾을 수 없습니다.', 404);
  return profileOf(row.id);
}

router.get('/consent-renewals', (req, res) => {
  const rows = getAll(
    `SELECT c.id, c.name, c.phone, cc.consent_type, cc.created_at AS consented_at,
            datetime(cc.created_at, '+2 years') AS due_at
     FROM customer_consents cc
     JOIN customers c ON c.id = cc.customer_id
     WHERE cc.pharmacy_id = @pharmacy_id
       AND cc.consent_type IN ('MARKETING_SMS', 'MARKETING_KAKAO')
       AND cc.agreed = 1
       AND cc.id = (SELECT MAX(id) FROM customer_consents WHERE customer_id = cc.customer_id AND consent_type = cc.consent_type)
       AND cc.created_at <= datetime('now', '+30 days', '-2 years')
     ORDER BY cc.created_at`,
    { pharmacy_id: req.user.pharmacy_id }
  );
  const byCustomer = new Map();
  for (const row of rows) {
    const entry = byCustomer.get(row.id) || { id: row.id, name: row.name, phone: row.phone, due_at: row.due_at, consent_types: [] };
    entry.consent_types.push(row.consent_type);
    if (row.due_at < entry.due_at) entry.due_at = row.due_at;
    byCustomer.set(row.id, entry);
  }
  res.json({ renewals: [...byCustomer.values()], labels: labels() });
});

router.get('/:id', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    return res.json({
      customer,
      consents: currentConsents(customer.id),
      consent_history: consentHistory(customer.id),
      labels: labels()
    });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/:id/profile', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    transaction(() => {
      updateProfile(customer, req.body);
      audit(req, 'CUSTOMER_PROFILE', customer.id, `회원 선택 정보 수정 · ${customer.name}`);
    })();
    return res.json({ customer: profileOf(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

// 약국은 고객이 전화·방문으로 요청한 철회만 대신 처리할 수 있다. 동의는 고객 본인이 해야 한다.
router.post('/:id/consents/withdraw', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    const types = Array.isArray(req.body.types) ? req.body.types : [];
    if (!types.length) throw new CustomerError('철회할 동의 항목을 선택해 주세요.');
    const changes = {};
    for (const type of types) {
      if (!CONSENT_TYPES[type]) throw new CustomerError('알 수 없는 동의 항목입니다.');
      if (CONSENT_TYPES[type].required) throw new CustomerError('필수 동의 철회는 회원 탈퇴로 처리해야 합니다.');
      changes[type] = false;
    }
    const written = transaction(() => {
      const result = recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes, source: 'PARTNER', userId: req.user.id });
      if (result.length) {
        audit(req, 'CONSENT_WITHDRAW', customer.id, `동의 철회 대행 · ${customer.name} · ${result.map((type) => CONSENT_TYPES[type].label).join(', ')}`);
      }
      return result;
    })();
    return res.json({ written, consents: currentConsents(customer.id), consent_history: consentHistory(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:id/consents/notice', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    const written = transaction(() => {
      const result = recordConsentNotice({ pharmacyId: customer.pharmacy_id, customerId: customer.id, userId: req.user.id });
      if (!result.length) throw new CustomerError('수신 동의한 마케팅 항목이 없습니다.');
      audit(req, 'CONSENT_NOTICE', customer.id, `수신 동의 재확인 안내 완료 · ${customer.name}`);
      return result;
    })();
    return res.json({ written, consents: currentConsents(customer.id), consent_history: consentHistory(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
