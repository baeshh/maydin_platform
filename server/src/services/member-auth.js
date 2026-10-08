const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getOne, getAll, run } = require('../db');
const { CustomerError } = require('./customers');
const { encrypt, decrypt } = require('./secure');
const { pointPolicy, pointEligibleAmount, earnRate, calcEarn, changePoints } = require('./points');
const { earningContext } = require('./members');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const SIGNUP_CODE_DAYS = 7;
const PIN_RESET_HOURS = 24;
const REISSUE_MAX_DAYS = 90;
const PIN_LOCK_AFTER = 5;
const PIN_LOCK_MINUTES = 30;
const PIN_HARD_LOCK_AFTER = 10;
const MIN_SIGNUP_AGE = 14;
const HEALTH_MAX_LENGTH = 300;
const SAME_DEVICE_DAILY_LIMIT = 2;
const CODE_FAILURES_BEFORE_REVIEW = 3;

class CodeError extends CustomerError {}

const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatCode = (code) => (code ? `${code.slice(0, 4)}-${code.slice(4)}` : null);
const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

function generateCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]).join('');
    if (!getOne('SELECT 1 FROM verification_codes WHERE code = @code', { code })) return code;
  }
  throw new CustomerError('인증 코드를 만들지 못했습니다. 다시 시도해 주세요.', 500);
}

function issueCode({ pharmacyId, purpose, orderId = null, customerId = null, userId = null }) {
  if (purpose === 'SIGNUP') {
    run("UPDATE verification_codes SET status = 'REVOKED' WHERE order_id = @id AND purpose = 'SIGNUP' AND status = 'ACTIVE'", { id: orderId });
  } else {
    run("UPDATE verification_codes SET status = 'REVOKED' WHERE customer_id = @id AND purpose = 'PIN_RESET' AND status = 'ACTIVE'", { id: customerId });
  }
  const code = generateCode();
  run(
    `INSERT INTO verification_codes (pharmacy_id, purpose, code, order_id, customer_id, expires_at, issued_by)
     VALUES (@pharmacy_id, @purpose, @code, @order_id, @customer_id, datetime('now', @ttl), @issued_by)`,
    {
      pharmacy_id: pharmacyId,
      purpose,
      code,
      order_id: orderId,
      customer_id: customerId,
      ttl: purpose === 'SIGNUP' ? `+${SIGNUP_CODE_DAYS} days` : `+${PIN_RESET_HOURS} hours`,
      issued_by: userId
    }
  );
  const row = getOne('SELECT code, expires_at FROM verification_codes WHERE code = @code', { code });
  return { code: formatCode(row.code), expires_at: row.expires_at };
}

function refundedAmount(orderId) {
  return -getOne(
    "SELECT COALESCE(SUM(final_amount), 0) AS total FROM orders WHERE original_order_id = @id AND order_type = 'POS_REFUND'",
    { id: orderId }
  ).total;
}

// 가입 인증에 쓸 수 있는 거래: 비회원 매장 판매이고 취소·전액 환불되지 않은 것.
function signupBlocker(order) {
  if (!order || order.order_type !== 'POS_SALE' || order.sales_channel !== 'POS') return '매장 판매 거래만 가입 인증에 쓸 수 있습니다.';
  if (order.customer_id) return '이미 회원에게 연결된 거래입니다.';
  if (['CANCELED', 'REFUNDED'].includes(order.order_status) || order.final_amount <= 0) return '취소·환불된 거래로는 가입할 수 없습니다.';
  if (refundedAmount(order.id) >= order.final_amount) return '취소·환불된 거래로는 가입할 수 없습니다.';
  return null;
}

function issueSignupCode({ pharmacyId, orderId, userId, reissue = false }) {
  const order = getOne('SELECT * FROM orders WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: orderId, pharmacy_id: pharmacyId });
  const blocker = signupBlocker(order);
  if (blocker) throw new CustomerError(blocker);
  if (reissue) {
    const old = getOne("SELECT created_at < datetime('now', @limit) AS old FROM orders WHERE id = @id", {
      id: orderId,
      limit: `-${REISSUE_MAX_DAYS} days`
    }).old;
    if (old) throw new CustomerError(`가입 코드는 구매 후 ${REISSUE_MAX_DAYS}일 안에만 다시 발급할 수 있습니다.`);
  }
  return issueCode({ pharmacyId, purpose: 'SIGNUP', orderId, userId });
}

// 영수증에 찍을 가입 코드. 이미 쓴 코드나 만료된 코드는 보여 주지 않는다.
function receiptSignupCode(order) {
  if (order.order_type !== 'POS_SALE' || order.customer_id || order.order_status === 'CANCELED') return null;
  const row = getOne(
    `SELECT code, expires_at FROM verification_codes
     WHERE order_id = @id AND purpose = 'SIGNUP' AND status = 'ACTIVE' AND expires_at > datetime('now')`,
    { id: order.id }
  );
  return row ? { code: formatCode(row.code), raw: row.code, expires_at: row.expires_at } : null;
}

function findActiveCode(pharmacyId, purpose, raw) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) return null;
  return getOne(
    `SELECT * FROM verification_codes
     WHERE pharmacy_id = @pharmacy_id AND purpose = @purpose AND code = @code AND status = 'ACTIVE' AND expires_at > datetime('now')`,
    { pharmacy_id: pharmacyId, purpose, code }
  );
}

function checkSignupCode(pharmacyId, raw) {
  const row = findActiveCode(pharmacyId, 'SIGNUP', raw);
  if (!row) throw new CodeError('가입 코드가 맞지 않거나 기간(발급 후 7일)이 지났습니다. 영수증의 코드를 다시 확인해 주세요.');
  const order = getOne('SELECT * FROM orders WHERE id = @id', { id: row.order_id });
  const blocker = signupBlocker(order);
  if (blocker) {
    run("UPDATE verification_codes SET status = 'REVOKED' WHERE id = @id", { id: row.id });
    throw new CodeError(blocker);
  }
  const items = getOne('SELECT COUNT(*) AS count FROM order_items WHERE order_id = @id', { id: order.id }).count;
  return {
    row,
    order,
    partiallyRefunded: refundedAmount(order.id) > 0,
    purchase: { purchased_at: order.created_at, amount: order.final_amount, item_count: items }
  };
}

function consumeCode(id, customerId) {
  const result = run(
    `UPDATE verification_codes SET status = 'USED', used_at = CURRENT_TIMESTAMP, used_by_customer_id = @customer_id
     WHERE id = @id AND status = 'ACTIVE' AND expires_at > datetime('now')`,
    { id, customer_id: customerId }
  );
  if (result.changes === 0) throw new CodeError('이미 사용했거나 만료된 코드입니다.', 409);
}

/* ---------- 필수 정보 ---------- */

function ageOn(year, month, day, now = new Date()) {
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) age -= 1;
  return age;
}

function requireBirthdate(profile) {
  if (profile.birth_year == null || profile.birth_month == null || profile.birth_day == null) {
    throw new CustomerError('생년월일(연·월·일)을 모두 입력해 주세요.');
  }
  const date = new Date(profile.birth_year, profile.birth_month - 1, profile.birth_day);
  if (date.getMonth() !== profile.birth_month - 1) throw new CustomerError('생년월일을 확인해 주세요.');
  if (ageOn(profile.birth_year, profile.birth_month, profile.birth_day) < MIN_SIGNUP_AGE) {
    throw new CustomerError('만 14세 미만은 보호자 동의가 필요해 앱으로 가입할 수 없어요. 보호자와 함께 약국에 방문해 주세요.');
  }
}

function normalizeHealthField(text, none, [object, topic]) {
  if (none === true || none === 'true' || none === 1 || none === '1' || none === 'on') return '';
  const value = String(text || '').trim();
  if (!value) throw new CustomerError(`${object} 적거나 '없음'을 선택해 주세요.`);
  if (value.length > HEALTH_MAX_LENGTH) throw new CustomerError(`${topic} ${HEALTH_MAX_LENGTH}자 이내로 적어 주세요.`);
  return value;
}

function normalizeHealth(body) {
  return {
    allergy: normalizeHealthField(body.allergy, body.allergy_none, ['알레르기를', '알레르기는']),
    medications: normalizeHealthField(body.medications, body.medications_none, ['복용 중인 약을', '복용 중인 약은'])
  };
}

function saveHealth(customerId, health) {
  run('UPDATE customers SET health_info = @info, health_updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
    id: customerId,
    info: encrypt(JSON.stringify(health))
  });
}

function clearHealth(customerId) {
  run('UPDATE customers SET health_info = NULL, health_updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: customerId });
}

function readHealth(customerId) {
  const row = getOne('SELECT health_info, health_updated_at FROM customers WHERE id = @id', { id: customerId });
  if (!row || !row.health_info) return null;
  const data = JSON.parse(decrypt(row.health_info));
  return { ...data, has_alert: Boolean(data.allergy || data.medications), updated_at: row.health_updated_at };
}

/* ---------- PIN ---------- */

function validatePin(pin, { birth = null, phone = '' } = {}) {
  const value = String(pin || '');
  if (!/^\d{6}$/.test(value)) throw new CustomerError('PIN은 숫자 6자리로 정해 주세요.');
  if (/^(\d)\1{5}$/.test(value) || '01234567890'.includes(value) || '09876543210'.includes(value)) {
    throw new CustomerError('같은 숫자나 연속된 숫자는 PIN으로 쓸 수 없어요.');
  }
  if (birth && birth.year) {
    const yymmdd = `${String(birth.year).slice(-2)}${String(birth.month).padStart(2, '0')}${String(birth.day).padStart(2, '0')}`;
    if (value === yymmdd) throw new CustomerError('생년월일은 PIN으로 쓸 수 없어요.');
  }
  if (digitsOnly(phone).includes(value)) throw new CustomerError('휴대폰 번호에 들어간 숫자는 PIN으로 쓸 수 없어요.');
  return value;
}

const hashPin = (pin) => bcrypt.hashSync(pin, 10);

function pinLock(customer) {
  if (customer.pin_failed_count >= PIN_HARD_LOCK_AFTER) {
    return { hard: true, message: 'PIN을 여러 번 틀려 잠겼어요. 약국에서 PIN 재설정 코드를 받아 다시 설정해 주세요.' };
  }
  if (customer.pin_locked_until) {
    const left = getOne("SELECT CAST((julianday(@until) - julianday('now')) * 1440 AS INTEGER) + 1 AS minutes", {
      until: customer.pin_locked_until
    }).minutes;
    if (left > 0) return { hard: false, message: `PIN을 ${PIN_LOCK_AFTER}번 틀려 잠겼어요. ${left}분 뒤에 다시 시도하거나 약국에서 PIN을 재설정해 주세요.` };
  }
  return null;
}

function recordPinFailure(customerId) {
  run(
    `UPDATE customers
     SET pin_failed_count = pin_failed_count + 1,
         pin_locked_until = CASE WHEN (pin_failed_count + 1) % @lock_after = 0
                                 THEN datetime('now', @lock_minutes) ELSE pin_locked_until END
     WHERE id = @id`,
    { id: customerId, lock_after: PIN_LOCK_AFTER, lock_minutes: `+${PIN_LOCK_MINUTES} minutes` }
  );
  return getOne('SELECT pin_failed_count, pin_locked_until FROM customers WHERE id = @id', { id: customerId });
}

function setPin(customerId, pin) {
  run('UPDATE customers SET pin_hash = @hash, pin_failed_count = 0, pin_locked_until = NULL WHERE id = @id', {
    id: customerId,
    hash: hashPin(pin)
  });
}

/* ---------- 이상 징후 · 승인 ---------- */

// 하나라도 걸리면 자동 승인하지 않고 약사 확인을 기다린다.
function signupFlags({ pharmacyId, ipHash, codeFailures, name, profile, partiallyRefunded }) {
  const flags = [];
  if (partiallyRefunded) flags.push('인증한 구매 건에 부분 반품이 있음');
  const sameDevice = getOne(
    `SELECT COUNT(*) AS count FROM customers
     WHERE pharmacy_id = @pharmacy_id AND signup_ip_hash = @ip AND created_at >= datetime('now', '-1 day')`,
    { pharmacy_id: pharmacyId, ip: ipHash }
  ).count;
  if (sameDevice >= SAME_DEVICE_DAILY_LIMIT) flags.push(`같은 기기·네트워크에서 24시간 안에 ${sameDevice + 1}번째 가입`);
  if (codeFailures >= CODE_FAILURES_BEFORE_REVIEW) flags.push(`가입 코드를 ${codeFailures}번 틀린 뒤 가입`);
  const twin = getOne(
    `SELECT COUNT(*) AS count FROM customers
     WHERE pharmacy_id = @pharmacy_id AND name = @name AND birth_year = @y AND birth_month = @m AND birth_day = @d`,
    { pharmacy_id: pharmacyId, name, y: profile.birth_year, m: profile.birth_month, d: profile.birth_day }
  ).count;
  if (twin > 0) flags.push('이름·생년월일이 같은 회원이 이미 있음 (중복 가입 의심)');
  return flags;
}

// 가입 인증에 쓴 구매를 회원 이력으로 옮기고, 그 구매분을 기본 적립률로 적립한다. 반품이 있었던 거래는 적립하지 않는다.
function linkSignupOrder(customer, userId) {
  if (!customer.signup_order_id) return { linked: false, points: 0 };
  const order = getOne('SELECT * FROM orders WHERE id = @id AND customer_id IS NULL', { id: customer.signup_order_id });
  if (!order || order.order_status === 'CANCELED') return { linked: false, points: 0 };
  run('UPDATE orders SET customer_id = @customer_id, contact_name = @name, contact_phone = @phone, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
    id: order.id,
    customer_id: customer.id,
    name: customer.name,
    phone: customer.phone
  });
  if (refundedAmount(order.id) > 0) return { linked: true, points: 0 };

  const policy = pointPolicy(customer.pharmacy_id);
  const items = getAll('SELECT total_price, discount_amount, product_type FROM order_items WHERE order_id = @id', { id: order.id });
  const boost = earningContext(customer.pharmacy_id, customer.id, { excludeOrderId: order.id });
  const points = calcEarn(policy, pointEligibleAmount(items), 0, boost);
  if (points > 0) {
    run('UPDATE orders SET points_earned = @points WHERE id = @id', { id: order.id, points });
    changePoints({
      pharmacyId: customer.pharmacy_id,
      customerId: customer.id,
      orderId: order.id,
      entryType: 'EARN',
      points,
      reason: `가입 인증 구매 적립 ${earnRate(policy, boost)}%`,
      userId
    });
  }
  return { linked: true, points };
}

function approveCustomer({ customerId, userId = null }) {
  const customer = getOne('SELECT * FROM customers WHERE id = @id', { id: customerId });
  if (!customer) throw new CustomerError('회원을 찾을 수 없습니다.', 404);
  if (customer.approval_status !== 'PENDING') throw new CustomerError('승인 대기 중인 가입만 승인할 수 있습니다.', 409);
  run("UPDATE customers SET approval_status = 'APPROVED', approved_at = CURRENT_TIMESTAMP, approved_by = @user_id WHERE id = @id", {
    id: customerId,
    user_id: userId
  });
  run("UPDATE users SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: customer.user_id });
  return linkSignupOrder(customer, userId);
}

function rejectCustomer({ customerId, userId, reason }) {
  const customer = getOne('SELECT * FROM customers WHERE id = @id', { id: customerId });
  if (!customer) throw new CustomerError('회원을 찾을 수 없습니다.', 404);
  if (customer.approval_status !== 'PENDING') throw new CustomerError('승인 대기 중인 가입만 거절할 수 있습니다.', 409);
  run(
    `UPDATE customers SET approval_status = 'REJECTED', approved_at = CURRENT_TIMESTAMP, approved_by = @user_id,
       approval_note = TRIM(COALESCE(approval_note, '') || ' / 거절 사유: ' || @reason, ' /')
     WHERE id = @id`,
    { id: customerId, user_id: userId, reason }
  );
  run("UPDATE users SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = @id", { id: customer.user_id });
  clearHealth(customerId);
}

function signupRequests(pharmacyId) {
  return getAll(
    `SELECT c.id, c.name, c.phone, c.birth_year, c.birth_month, c.birth_day, c.gender, c.created_at, c.approval_note,
            o.order_number, o.final_amount AS order_amount, o.created_at AS order_created_at,
            (SELECT GROUP_CONCAT(product_name || ' ×' || quantity, ', ') FROM order_items WHERE order_id = o.id) AS order_items,
            r.name AS referrer_name
     FROM customers c
     LEFT JOIN orders o ON o.id = c.signup_order_id
     LEFT JOIN customers r ON r.id = c.referred_by_customer_id
     WHERE c.pharmacy_id = @pharmacy_id AND c.approval_status = 'PENDING'
     ORDER BY c.id ASC`,
    { pharmacy_id: pharmacyId }
  );
}

module.exports = {
  CODE_LENGTH,
  SIGNUP_CODE_DAYS,
  PIN_RESET_HOURS,
  CodeError,
  normalizeCode,
  digitsOnly,
  issueCode,
  issueSignupCode,
  receiptSignupCode,
  findActiveCode,
  checkSignupCode,
  consumeCode,
  requireBirthdate,
  normalizeHealth,
  saveHealth,
  clearHealth,
  readHealth,
  validatePin,
  hashPin,
  pinLock,
  recordPinFailure,
  setPin,
  signupFlags,
  approveCustomer,
  rejectCustomer,
  signupRequests
};
