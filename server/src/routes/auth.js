const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getOne, run, transaction, assignMemberCode, assignReferralCode } = require('../db');
const { authenticate, signToken } = require('../middleware/auth');
const {
  CustomerError,
  normalizeConsentChanges,
  recordConsents,
  normalizeProfile,
  validateBirthday,
  findChannel
} = require('../services/customers');
const auth = require('../services/member-auth');
const throttle = require('../services/throttle');
const { hashIp } = require('../services/secure');

const router = express.Router();

const WINDOW_MS = 15 * 60 * 1000;
const CODE_FAIL_LIMIT = 10;
const LOGIN_FAIL_LIMIT = 30;
const STAFF_FAIL_LIMIT = 20;
const PENDING_MESSAGE = '약국에서 가입 내용을 확인하고 있어요. 확인이 끝나면 휴대폰 번호와 PIN으로 로그인할 수 있어요.';
const REJECTED_MESSAGE = '가입이 승인되지 않았어요. 자세한 내용은 약국에 문의해 주세요.';
const LOGIN_FAILED = '휴대폰 번호 또는 PIN이 맞지 않습니다.';

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    pharmacy_id: user.pharmacy_id
  };
}

function fail(res, error) {
  if (error instanceof CustomerError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: '처리 중 오류가 발생했습니다.' });
}

function findPharmacy(pharmacyCode) {
  const pharmacy = getOne("SELECT * FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'", {
    pharmacyCode: String(pharmacyCode || '')
  });
  if (!pharmacy) throw new CustomerError('약국을 찾을 수 없습니다.', 404);
  return pharmacy;
}

function findCustomerByPhone(pharmacyId, phone) {
  return getOne(
    `SELECT c.*, u.status AS user_status
     FROM customers c
     JOIN users u ON u.id = c.user_id
     WHERE c.pharmacy_id = @pharmacy_id AND u.role = 'CUSTOMER'
       AND REPLACE(REPLACE(REPLACE(c.phone, '-', ''), ' ', ''), '.', '') = @phone`,
    { pharmacy_id: pharmacyId, phone }
  );
}

// 코드 대입을 막기 위해 같은 IP의 코드 실패를 센다. 실패가 쌓이면 잠시 막는다.
function codeGuard(req) {
  const key = `code:${req.ip}`;
  if (throttle.blocked(key, CODE_FAIL_LIMIT, WINDOW_MS)) {
    throw new CustomerError(`코드를 여러 번 잘못 입력했어요. ${throttle.minutesLeft(key, WINDOW_MS)}분 뒤에 다시 시도해 주세요.`, 429);
  }
  return key;
}

function withCodeFailure(key, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof auth.CodeError) throttle.recordFailure(key, WINDOW_MS);
    throw error;
  }
}

router.post('/login', (req, res) => {
  const key = `staff:${req.ip}`;
  if (throttle.blocked(key, STAFF_FAIL_LIMIT, WINDOW_MS)) {
    return res.status(429).json({ message: `로그인을 여러 번 실패했어요. ${throttle.minutesLeft(key, WINDOW_MS)}분 뒤에 다시 시도해 주세요.` });
  }
  const { email, password } = req.body;
  const user = getOne("SELECT * FROM users WHERE email = @email AND status = 'ACTIVE' AND role != 'CUSTOMER'", { email });

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throttle.recordFailure(key, WINDOW_MS);
    return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }

  return res.json({ token: signToken(user), user: publicUser(user) });
});

// 가입 화면에서 코드를 먼저 확인해 구매 일자·금액을 보여 준다. 고객은 자기 영수증이 맞는지 확인할 수 있다.
router.get('/customer/signup-code', (req, res) => {
  try {
    const pharmacy = findPharmacy(req.query.pharmacyCode);
    const key = codeGuard(req);
    const { purchase } = withCodeFailure(key, () => auth.checkSignupCode(pharmacy.id, req.query.code));
    return res.json({ valid: true, purchase });
  } catch (error) {
    return fail(res, error);
  }
});

function parseSignup(body, pharmacy) {
  const consents = {
    TERMS: false,
    PRIVACY: false,
    HEALTH_INFO: false,
    MARKETING_SMS: Boolean(body.marketing_agree),
    MARKETING_KAKAO: false,
    MARKETING_NIGHT: false,
    ...normalizeConsentChanges(body.consents)
  };
  delete consents.THIRD_PARTY;
  if (!consents.TERMS || !consents.PRIVACY) throw new CustomerError('필수 약관(이용약관, 개인정보 수집·이용)에 동의해 주세요.');
  if (!consents.HEALTH_INFO) throw new CustomerError('알레르기·복용 약 정보 수집(민감정보)에 동의해 주세요.');
  if (consents.MARKETING_NIGHT && !consents.MARKETING_SMS && !consents.MARKETING_KAKAO) {
    throw new CustomerError('야간 광고 수신은 문자 또는 알림톡 수신에 동의한 경우에만 선택할 수 있습니다.');
  }

  const name = String(body.name || '').trim();
  if (!name) throw new CustomerError('이름을 입력해 주세요.');
  if (name.length > 30) throw new CustomerError('이름은 30자 이내로 입력해 주세요.');
  const phone = auth.digitsOnly(body.phone);
  if (!/^01\d{8,9}$/.test(phone)) throw new CustomerError('휴대폰 번호를 확인해 주세요.');

  const profile = normalizeProfile(body, new Date().getFullYear());
  validateBirthday(profile.birth_month ?? null, profile.birth_day ?? null);
  auth.requireBirthdate(profile);
  if (!profile.gender) throw new CustomerError('성별을 선택해 주세요.');

  const address = String(body.address || '').trim();
  if (!address) throw new CustomerError('주소를 입력해 주세요.');
  if (address.length > 200) throw new CustomerError('주소가 너무 깁니다.');
  const addressDetail = String(body.address_detail || '').trim().slice(0, 100);
  const zipCode = String(body.zip_code || '').trim().slice(0, 10);

  const health = auth.normalizeHealth(body);
  const pin = auth.validatePin(body.pin, {
    birth: { year: profile.birth_year, month: profile.birth_month, day: profile.birth_day },
    phone
  });

  const referralCode = String(body.referral_code || '').trim().toUpperCase();
  const referrer = referralCode
    ? getOne("SELECT id FROM customers WHERE pharmacy_id = @pharmacy_id AND referral_code = @code AND approval_status = 'APPROVED'", {
        pharmacy_id: pharmacy.id,
        code: referralCode
      })
    : null;
  if (referralCode && !referrer) throw new CustomerError('추천인 코드를 찾을 수 없습니다. 코드를 확인하거나 비워 두세요.');

  return { consents, name, phone, profile, address, addressDetail, zipCode, health, pin, referrer };
}

router.post('/customer/signup', (req, res) => {
  try {
    const pharmacy = findPharmacy(req.body.pharmacyCode);
    const input = parseSignup(req.body, pharmacy);
    const key = codeGuard(req);
    const verified = withCodeFailure(key, () => auth.checkSignupCode(pharmacy.id, req.body.code));

    if (findCustomerByPhone(pharmacy.id, input.phone)) {
      throw new CustomerError('이미 가입된 휴대폰 번호입니다. 로그인하거나, PIN을 잊었다면 약국에서 재설정 코드를 받아 주세요.', 409);
    }
    const email = `${pharmacy.pharmacy_code.toLowerCase()}-${input.phone}@customer.local`;
    if (getOne('SELECT id FROM users WHERE email = @email', { email })) throw new CustomerError('이미 가입된 휴대폰 번호입니다.', 409);

    const ipHash = hashIp(req.ip);
    const flags = auth.signupFlags({
      pharmacyId: pharmacy.id,
      ipHash,
      codeFailures: throttle.failures(key, WINDOW_MS),
      name: input.name,
      profile: input.profile,
      partiallyRefunded: verified.partiallyRefunded
    });
    const channel = findChannel(pharmacy.id, req.body.channel);

    const result = transaction(() => {
      const userId = run(
        `INSERT INTO users (email, password_hash, name, phone, role, pharmacy_id, status)
         VALUES (@email, @password_hash, @name, @phone, 'CUSTOMER', @pharmacy_id, 'PENDING')`,
        {
          email,
          // 고객은 PIN으로만 로그인한다. 이 비밀번호는 아무도 모르는 값으로 채워 둔다.
          password_hash: bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 10),
          name: input.name,
          phone: input.phone,
          pharmacy_id: pharmacy.id
        }
      ).lastInsertRowid;

      const customerId = run(
        `INSERT INTO customers (
           user_id, pharmacy_id, name, phone, email, marketing_agree,
           birth_year, birth_month, birth_day, gender, referred_by_customer_id, signup_channel_id,
           approval_status, approval_note, signup_order_id, signup_ip_hash, pin_hash
         ) VALUES (
           @user_id, @pharmacy_id, @name, @phone, @email, 0,
           @birth_year, @birth_month, @birth_day, @gender, @referred_by, @signup_channel_id,
           'PENDING', @approval_note, @signup_order_id, @signup_ip_hash, @pin_hash
         )`,
        {
          user_id: userId,
          pharmacy_id: pharmacy.id,
          name: input.name,
          phone: input.phone,
          email,
          birth_year: input.profile.birth_year,
          birth_month: input.profile.birth_month,
          birth_day: input.profile.birth_day,
          gender: input.profile.gender,
          referred_by: input.referrer ? input.referrer.id : null,
          signup_channel_id: channel ? channel.id : null,
          approval_note: flags.length ? flags.join(' / ') : null,
          signup_order_id: verified.order.id,
          signup_ip_hash: ipHash,
          pin_hash: auth.hashPin(input.pin)
        }
      ).lastInsertRowid;

      auth.consumeCode(verified.row.id, customerId);
      assignMemberCode(customerId);
      assignReferralCode(customerId);
      recordConsents({ pharmacyId: pharmacy.id, customerId, changes: input.consents, source: 'SIGNUP', userId });
      auth.saveHealth(customerId, input.health);
      if (channel) run('UPDATE signup_channels SET signup_count = signup_count + 1 WHERE id = @id', { id: channel.id });

      const addressId = run(
        `INSERT INTO addresses (user_id, pharmacy_id, receiver_name, phone, zip_code, address, address_detail, is_default)
         VALUES (@user_id, @pharmacy_id, @receiver_name, @phone, @zip_code, @address, @address_detail, 1)`,
        {
          user_id: userId,
          pharmacy_id: pharmacy.id,
          receiver_name: input.name,
          phone: input.phone,
          zip_code: input.zipCode || null,
          address: input.address,
          address_detail: input.addressDetail || null
        }
      ).lastInsertRowid;
      run('UPDATE customers SET default_address_id = @addressId WHERE id = @customerId', { addressId, customerId });
      run('UPDATE qr_codes SET signup_count = signup_count + 1 WHERE pharmacy_id = @pharmacy_id', { pharmacy_id: pharmacy.id });

      const approval = flags.length ? null : auth.approveCustomer({ customerId });
      return { userId, approval };
    })();

    if (!result.approval) return res.status(202).json({ status: 'PENDING', message: PENDING_MESSAGE });
    const user = getOne('SELECT * FROM users WHERE id = @id', { id: result.userId });
    return res.status(201).json({ status: 'APPROVED', token: signToken(user), user: publicUser(user), points_earned: result.approval.points });
  } catch (error) {
    return fail(res, error);
  }
});

router.post('/customer/login', (req, res) => {
  try {
    const key = `login:${req.ip}`;
    if (throttle.blocked(key, LOGIN_FAIL_LIMIT, WINDOW_MS)) {
      throw new CustomerError(`로그인을 여러 번 실패했어요. ${throttle.minutesLeft(key, WINDOW_MS)}분 뒤에 다시 시도해 주세요.`, 429);
    }
    const pharmacy = findPharmacy(req.body.pharmacyCode);
    const customer = findCustomerByPhone(pharmacy.id, auth.digitsOnly(req.body.phone));
    const loginFailed = () => {
      throttle.recordFailure(key, WINDOW_MS);
      return new CustomerError(LOGIN_FAILED, 401);
    };
    if (!customer || !customer.pin_hash) throw loginFailed();

    const lock = auth.pinLock(customer);
    if (lock) throw new CustomerError(lock.message, 423);
    if (!bcrypt.compareSync(String(req.body.pin || ''), customer.pin_hash)) {
      const after = auth.recordPinFailure(customer.id);
      const nextLock = auth.pinLock(after);
      if (nextLock) {
        throttle.recordFailure(key, WINDOW_MS);
        throw new CustomerError(nextLock.message, 423);
      }
      throw loginFailed();
    }
    run('UPDATE customers SET pin_failed_count = 0, pin_locked_until = NULL WHERE id = @id', { id: customer.id });

    if (customer.approval_status === 'PENDING') return res.status(403).json({ status: 'PENDING', message: PENDING_MESSAGE });
    if (customer.approval_status === 'REJECTED') return res.status(403).json({ status: 'REJECTED', message: REJECTED_MESSAGE });
    const user = getOne("SELECT * FROM users WHERE id = @id AND status = 'ACTIVE'", { id: customer.user_id });
    if (!user) throw new CustomerError('이용할 수 없는 계정입니다. 약국에 문의해 주세요.', 403);
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    return fail(res, error);
  }
});

// 번호만으로 로그인하던 예전 방식. 전화번호만 알면 남의 계정에 들어갈 수 있어서 막았다.
router.post('/customer/phone-login', (req, res) => {
  res.status(410).json({ message: '휴대폰 번호와 PIN으로 로그인해 주세요.' });
});

// 기존 회원의 첫 PIN 설정과 PIN 분실 재설정. 약국에서 본인 확인 후 발급한 코드가 있어야 한다.
router.post('/customer/reset-pin', (req, res) => {
  try {
    const pharmacy = findPharmacy(req.body.pharmacyCode);
    const key = codeGuard(req);
    const phone = auth.digitsOnly(req.body.phone);
    const { row, customer } = withCodeFailure(key, () => {
      const code = auth.findActiveCode(pharmacy.id, 'PIN_RESET', req.body.code);
      const owner = code ? findCustomerByPhone(pharmacy.id, phone) : null;
      if (!code || !owner || owner.id !== code.customer_id) {
        throw new auth.CodeError('코드 또는 휴대폰 번호가 맞지 않습니다. 코드는 발급 후 24시간 동안만 쓸 수 있어요.');
      }
      return { row: code, customer: owner };
    });
    const pin = auth.validatePin(req.body.pin, {
      birth: { year: customer.birth_year, month: customer.birth_month, day: customer.birth_day },
      phone
    });
    transaction(() => {
      auth.consumeCode(row.id, customer.id);
      auth.setPin(customer.id, pin);
    })();
    if (customer.approval_status !== 'APPROVED') return res.status(403).json({ status: customer.approval_status, message: PENDING_MESSAGE });
    const user = getOne("SELECT * FROM users WHERE id = @id AND status = 'ACTIVE'", { id: customer.user_id });
    if (!user) throw new CustomerError('이용할 수 없는 계정입니다. 약국에 문의해 주세요.', 403);
    return res.json({ token: signToken(user), user: publicUser(user) });
  } catch (error) {
    return fail(res, error);
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.get('/membership', authenticate, (req, res) => {
  if (req.user.role !== 'CUSTOMER') return res.status(403).json({ message: '고객 계정만 멤버십을 조회할 수 있습니다.' });
  const customer = getOne(
    `SELECT c.id, c.name, c.phone, c.member_code, c.point_balance, p.pharmacy_name, p.point_enabled
     FROM customers c
     JOIN pharmacies p ON p.id = c.pharmacy_id
     WHERE c.user_id = @user_id AND c.approval_status = 'APPROVED'`,
    { user_id: req.user.id }
  );
  if (!customer) return res.status(404).json({ message: '고객 정보를 찾을 수 없습니다.' });
  const memberCode = customer.member_code || assignMemberCode(customer.id);
  return res.json({
    membership: {
      name: customer.name,
      pharmacy_name: customer.pharmacy_name,
      member_code: memberCode,
      qr_payload: `MAYDIN-MEMBER:${memberCode}`,
      point_balance: customer.point_balance,
      point_enabled: customer.point_enabled === 1
    }
  });
});

module.exports = router;
