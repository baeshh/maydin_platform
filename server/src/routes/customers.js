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
const { RELATIONS, familyView, addFamily, updateFamily, removeFamily } = require('../services/family');
const { pointPolicy } = require('../services/points');
const auth = require('../services/member-auth');
const bcrypt = require('bcryptjs');

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
            c.approval_status, c.approval_note, c.approved_at, c.signup_order_id,
            c.pin_hash IS NOT NULL AS pin_set, c.pin_failed_count, c.pin_locked_until,
            c.health_info IS NOT NULL AS has_health, c.health_updated_at,
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
    channel_types: CHANNEL_TYPES,
    relations: RELATIONS
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
  const customer = profileOf(row.id);
  delete customer.approval_note;
  delete customer.pin_failed_count;
  delete customer.pin_locked_until;
  return customer;
}

router.get('/me', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const pharmacy = getOne('SELECT pharmacy_code, pharmacy_name FROM pharmacies WHERE id = @id', { id: customer.pharmacy_id });
    return res.json({
      customer,
      health: auth.readHealth(customer.id),
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

// 생일 달 적립 배수와 만 14세 확인 때문에, 한 번 등록한 생년월일은 고객이 직접 바꾸지 못하게 한다.
router.patch('/me/profile', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const changesBirthday = ['birth_year', 'birth_month', 'birth_day'].some(
      (key) => key in req.body && customer[key] != null && Number(req.body[key]) !== customer[key]
    );
    if (changesBirthday) throw new CustomerError('생년월일은 한 번 등록하면 앱에서 바꿀 수 없어요. 약국에 문의해 주세요.');
    if ('gender' in req.body && !req.body.gender && customer.gender) throw new CustomerError('성별은 비워 둘 수 없어요.');
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
    transaction(() => {
      recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes, source: 'APP', userId: req.user.id });
      if (changes.HEALTH_INFO === false) auth.clearHealth(customer.id);
    })();
    return res.json({ consents: currentConsents(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

// 알레르기·복용 약은 민감정보라 동의가 있어야 저장한다. 이 기능 전에 가입한 회원은 여기서 처음 동의할 수 있다.
router.put('/me/health', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const agreed = currentConsents(customer.id).HEALTH_INFO.agreed;
    if (!agreed && req.body.consent !== true) throw new CustomerError('민감정보(알레르기·복용 약) 수집·이용에 동의해 주세요.');
    const health = auth.normalizeHealth(req.body);
    transaction(() => {
      if (!agreed) {
        recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes: { HEALTH_INFO: true }, source: 'APP', userId: req.user.id });
      }
      auth.saveHealth(customer.id, health);
    })();
    return res.json({ health: auth.readHealth(customer.id), consents: currentConsents(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/me/health', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    transaction(() => {
      recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes: { HEALTH_INFO: false }, source: 'APP', userId: req.user.id });
      auth.clearHealth(customer.id);
    })();
    return res.json({ health: null, consents: currentConsents(customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/me/pin', requireRole('CUSTOMER'), (req, res) => {
  try {
    const row = getOne('SELECT * FROM customers WHERE user_id = @user_id', { user_id: req.user.id });
    if (!row) throw new CustomerError('고객 정보를 찾을 수 없습니다.', 404);
    const lock = auth.pinLock(row);
    if (lock) throw new CustomerError(lock.message, 423);
    if (!row.pin_hash || !bcrypt.compareSync(String(req.body.current_pin || ''), row.pin_hash)) {
      const after = auth.recordPinFailure(row.id);
      const nextLock = auth.pinLock(after);
      throw new CustomerError(nextLock ? nextLock.message : '지금 쓰는 PIN이 맞지 않습니다.', nextLock ? 423 : 400);
    }
    const pin = auth.validatePin(req.body.pin, {
      birth: { year: row.birth_year, month: row.birth_month, day: row.birth_day },
      phone: row.phone
    });
    if (bcrypt.compareSync(pin, row.pin_hash)) throw new CustomerError('지금과 다른 PIN으로 정해 주세요.');
    auth.setPin(row.id, pin);
    return res.json({ ok: true });
  } catch (error) {
    return fail(res, error);
  }
});

// 고객은 계정 없는 가족만 직접 등록한다. 이미 가입한 회원끼리 연결하는 일은 두 사람이 함께 약국에서 한다.
router.get('/me/family', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    return res.json({ family: familyView(customer.pharmacy_id, customer.id), relations: RELATIONS });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/me/family', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    addFamily({ pharmacyId: customer.pharmacy_id, headId: customer.id, input: req.body, userId: req.user.id });
    return res.status(201).json({ family: familyView(customer.pharmacy_id, customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/me/family/:familyId', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    updateFamily(customer.id, Number(req.params.familyId), req.body);
    return res.json({ family: familyView(customer.pharmacy_id, customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/me/family/:familyId', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    removeFamily(customer.id, Number(req.params.familyId));
    return res.json({ family: familyView(customer.pharmacy_id, customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/me/family/leave', requireRole('CUSTOMER'), (req, res) => {
  try {
    const customer = myCustomer(req);
    const result = run('DELETE FROM family_members WHERE linked_customer_id = @id', { id: customer.id });
    if (!result.changes) throw new CustomerError('연결된 가족이 없습니다.');
    return res.json({ family: familyView(customer.pharmacy_id, customer.id) });
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

router.get('/signup-requests', (req, res) => {
  res.json({ requests: auth.signupRequests(req.user.pharmacy_id), labels: labels() });
});

router.post('/:id/approve', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    const result = transaction(() => {
      const approval = auth.approveCustomer({ customerId: customer.id, userId: req.user.id });
      audit(req, 'SIGNUP_APPROVE', customer.id, `가입 승인 · ${customer.name}${approval.points ? ` · 인증 구매 적립 ${approval.points}P` : ''}`);
      return approval;
    })();
    return res.json({ ...result, requests: auth.signupRequests(req.user.pharmacy_id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/:id/reject', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) throw new CustomerError('거절 사유를 적어 주세요.');
    transaction(() => {
      auth.rejectCustomer({ customerId: customer.id, userId: req.user.id, reason });
      audit(req, 'SIGNUP_REJECT', customer.id, `가입 거절 · ${customer.name} · 사유: ${reason}`);
    })();
    return res.json({ requests: auth.signupRequests(req.user.pharmacy_id) });
  } catch (error) {
    return fail(res, error);
  }
});

// 본인 확인(방문·전화)을 한 뒤에만 발급한다. 코드는 24시간 동안 한 번 쓸 수 있다.
router.post('/:id/pin-reset-code', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    if (customer.approval_status !== 'APPROVED') throw new CustomerError('승인된 회원에게만 PIN 코드를 발급할 수 있습니다.');
    const issued = transaction(() => {
      const code = auth.issueCode({ pharmacyId: customer.pharmacy_id, purpose: 'PIN_RESET', customerId: customer.id, userId: req.user.id });
      audit(req, 'PIN_RESET_CODE', customer.id, `PIN ${customer.pin_set ? '재설정' : '설정'} 코드 발급 · ${customer.name}`);
      return code;
    })();
    return res.status(201).json(issued);
  } catch (error) {
    return fail(res, error);
  }
});

// 민감정보라 누가 언제 봤는지 남긴다.
router.get('/:id/health', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    const health = auth.readHealth(customer.id);
    audit(req, 'HEALTH_VIEW', customer.id, `건강 정보 열람 · ${customer.name}`);
    return res.json({ health });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/:id', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    return res.json({
      customer,
      consents: currentConsents(customer.id),
      consent_history: consentHistory(customer.id),
      family: familyView(customer.pharmacy_id, customer.id),
      labels: labels()
    });
  } catch (error) {
    return fail(res, error);
  }
});

// 이미 가입한 회원을 가족으로 연결할 때는 전화번호(숫자만) 또는 회원코드로 찾는다.
function findLinkTarget(pharmacyId, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const row = getOne(
    `SELECT id FROM customers
     WHERE pharmacy_id = @pharmacy_id AND (UPPER(member_code) = UPPER(@raw) OR (LENGTH(@digits) >= 10 AND REPLACE(phone, '-', '') = @digits))`,
    { pharmacy_id: pharmacyId, raw, digits }
  );
  if (!row) throw new CustomerError('연결할 회원을 찾을 수 없습니다. 전화번호 전체 또는 회원코드를 입력해 주세요.', 404);
  return row.id;
}

router.post('/:id/family', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    transaction(() => {
      const linkedId = findLinkTarget(customer.pharmacy_id, req.body.link_query);
      const familyId = addFamily({ pharmacyId: customer.pharmacy_id, headId: customer.id, input: req.body, linkedCustomerId: linkedId, userId: req.user.id });
      const row = getOne('SELECT name, relation FROM family_members WHERE id = @id', { id: familyId });
      audit(req, 'FAMILY_ADD', customer.id, `가족 ${linkedId ? '회원 연결' : '등록'} · ${customer.name} → ${RELATIONS[row.relation]} ${row.name}`);
    })();
    return res.status(201).json({ family: familyView(customer.pharmacy_id, customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/:id/family/:familyId', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    updateFamily(customer.id, Number(req.params.familyId), req.body);
    return res.json({ family: familyView(customer.pharmacy_id, customer.id) });
  } catch (error) {
    return fail(res, error);
  }
});

router.delete('/:id/family/:familyId', (req, res) => {
  try {
    const customer = pharmacyCustomer(req);
    transaction(() => {
      const row = removeFamily(customer.id, Number(req.params.familyId));
      audit(req, 'FAMILY_REMOVE', customer.id, `가족 해제 · ${customer.name} → ${RELATIONS[row.relation]} ${row.name}`);
    })();
    return res.json({ family: familyView(customer.pharmacy_id, customer.id) });
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
      if (changes.HEALTH_INFO === false) auth.clearHealth(customer.id);
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
