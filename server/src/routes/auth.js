const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getOne, run, transaction } = require('../db');
const { authenticate, signToken } = require('../middleware/auth');

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

  const normalizedPhone = String(phone || '').replace(/\D/g, '');
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
      `INSERT INTO customers (user_id, pharmacy_id, name, phone, email, marketing_agree)
       VALUES (@user_id, @pharmacy_id, @name, @phone, @email, @marketing_agree)`,
      {
        user_id: userResult.lastInsertRowid,
        pharmacy_id: pharmacy.id,
        name,
        phone,
        email: customerEmail,
        marketing_agree: marketing_agree ? 1 : 0
      }
    );

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

module.exports = router;
