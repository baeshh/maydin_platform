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

const router = express.Router();

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

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = getOne("SELECT * FROM users WHERE email = @email AND status = 'ACTIVE'", { email });

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }

  return res.json({ token: signToken(user), user: publicUser(user) });
});

router.post('/customer/signup', (req, res) => {
  const {
    pharmacyCode,
    name,
    phone,
    email,
    password,
    receiver_name,
    zip_code,
    address,
    address_detail,
    marketing_agree
  } = req.body;

  const pharmacy = getOne(
    "SELECT * FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'",
    { pharmacyCode }
  );
  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  let consents;
  let profile;
  try {
    consents = {
      TERMS: false,
      PRIVACY: false,
      MARKETING_SMS: Boolean(marketing_agree),
      MARKETING_KAKAO: false,
      MARKETING_NIGHT: false,
      ...normalizeConsentChanges(req.body.consents)
    };
    delete consents.THIRD_PARTY;
    if (!consents.TERMS || !consents.PRIVACY) throw new CustomerError('필수 약관(이용약관, 개인정보 수집·이용)에 동의해 주세요.');
    if (consents.MARKETING_NIGHT && !consents.MARKETING_SMS && !consents.MARKETING_KAKAO) {
      throw new CustomerError('야간 광고 수신은 문자 또는 알림톡 수신에 동의한 경우에만 선택할 수 있습니다.');
    }
    profile = normalizeProfile(req.body, new Date().getFullYear());
    validateBirthday(profile.birth_month ?? null, profile.birth_day ?? null);
  } catch (error) {
    if (error instanceof CustomerError) return res.status(error.status).json({ message: error.message });
    throw error;
  }

  if (!String(name || '').trim()) return res.status(400).json({ message: '이름을 입력해 주세요.' });
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (!/^01\d{8,9}$/.test(normalizedPhone)) return res.status(400).json({ message: '휴대폰 번호를 확인해 주세요.' });

  const referralCode = String(req.body.referral_code || '').trim().toUpperCase();
  const referrer = referralCode
    ? getOne('SELECT id FROM customers WHERE pharmacy_id = @pharmacy_id AND referral_code = @code', {
        pharmacy_id: pharmacy.id,
        code: referralCode
      })
    : null;
  if (referralCode && !referrer) return res.status(400).json({ message: '추천인 코드를 찾을 수 없습니다. 코드를 확인하거나 비워 두세요.' });
  const channel = findChannel(pharmacy.id, req.body.channel);

  const customerEmail = email || `${pharmacy.pharmacy_code.toLowerCase()}-${normalizedPhone}@customer.local`;
  const customerPassword = password || crypto.randomBytes(18).toString('hex');

  const exists = getOne('SELECT id FROM users WHERE email = @email', { email: customerEmail });
  if (exists) return res.status(409).json({ message: '이미 가입된 이메일입니다.' });

  const phoneExists = getOne(
    `SELECT id
     FROM customers
     WHERE pharmacy_id = @pharmacy_id AND REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '.', '') = @phone`,
    { pharmacy_id: pharmacy.id, phone: normalizedPhone }
  );
  if (phoneExists) return res.status(409).json({ message: '이미 해당 약국몰에 가입된 휴대폰 번호입니다.' });

  const createCustomer = transaction(() => {
    const userResult = run(
      `INSERT INTO users (email, password_hash, name, phone, role, pharmacy_id)
       VALUES (@email, @password_hash, @name, @phone, 'CUSTOMER', @pharmacy_id)`,
      {
        email: customerEmail,
        password_hash: bcrypt.hashSync(customerPassword, 10),
        name,
        phone,
        pharmacy_id: pharmacy.id
      }
    );

    const customerResult = run(
      `INSERT INTO customers (
         user_id, pharmacy_id, name, phone, email, marketing_agree,
         birth_year, birth_month, birth_day, gender, referred_by_customer_id, signup_channel_id
       ) VALUES (
         @user_id, @pharmacy_id, @name, @phone, @email, 0,
         @birth_year, @birth_month, @birth_day, @gender, @referred_by, @signup_channel_id
       )`,
      {
        user_id: userResult.lastInsertRowid,
        pharmacy_id: pharmacy.id,
        name,
        phone,
        email: customerEmail,
        birth_year: profile.birth_year ?? null,
        birth_month: profile.birth_month ?? null,
        birth_day: profile.birth_day ?? null,
        gender: profile.gender ?? null,
        referred_by: referrer ? referrer.id : null,
        signup_channel_id: channel ? channel.id : null
      }
    );
    const customerId = customerResult.lastInsertRowid;

    assignMemberCode(customerId);
    assignReferralCode(customerId);
    recordConsents({ pharmacyId: pharmacy.id, customerId, changes: consents, source: 'SIGNUP', userId: userResult.lastInsertRowid });
    if (channel) {
      run('UPDATE signup_channels SET signup_count = signup_count + 1 WHERE id = @id', { id: channel.id });
    }

    let addressId = null;
    if (address) {
      const addressResult = run(
        `INSERT INTO addresses (
          user_id, pharmacy_id, receiver_name, phone, zip_code, address, address_detail, is_default
        ) VALUES (
          @user_id, @pharmacy_id, @receiver_name, @phone, @zip_code, @address, @address_detail, 1
        )`,
        {
          user_id: userResult.lastInsertRowid,
          pharmacy_id: pharmacy.id,
          receiver_name: receiver_name || name,
          phone,
          zip_code,
          address,
          address_detail
        }
      );
      addressId = addressResult.lastInsertRowid;
      run('UPDATE customers SET default_address_id = @addressId WHERE id = @customerId', {
        addressId,
        customerId: customerResult.lastInsertRowid
      });
    }

    run('UPDATE qr_codes SET signup_count = signup_count + 1 WHERE pharmacy_id = @pharmacy_id', {
      pharmacy_id: pharmacy.id
    });

    return getOne('SELECT * FROM users WHERE id = @id', { id: userResult.lastInsertRowid });
  });

  const user = createCustomer();
  return res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/customer/phone-login', (req, res) => {
  const { pharmacyCode, phone } = req.body;
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const pharmacy = getOne(
    "SELECT id FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'",
    { pharmacyCode }
  );
  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  const user = getOne(
    `SELECT u.*
     FROM users u
     JOIN customers c ON c.user_id = u.id
     WHERE u.role = 'CUSTOMER'
       AND u.status = 'ACTIVE'
       AND u.pharmacy_id = @pharmacy_id
       AND REPLACE(REPLACE(REPLACE(c.phone, '-', ''), ' ', ''), '.', '') = @phone`,
    { pharmacy_id: pharmacy.id, phone: normalizedPhone }
  );
  if (!user) return res.status(401).json({ message: '가입된 고객 정보를 찾을 수 없습니다.' });

  return res.json({ token: signToken(user), user: publicUser(user) });
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
     WHERE c.user_id = @user_id`,
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
