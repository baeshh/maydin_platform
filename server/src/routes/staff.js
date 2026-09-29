const express = require('express');
const bcrypt = require('bcryptjs');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const STAFF_COLUMNS = `u.id, u.email, u.name, u.phone, u.status, u.created_at, u.updated_at,
  (SELECT MAX(created_at) FROM admin_logs l WHERE l.user_id = u.id AND l.action LIKE 'POS_%') AS last_pos_activity_at,
  (SELECT COUNT(*) FROM orders o WHERE o.cashier_user_id = u.id AND o.order_type = 'POS_SALE'
     AND date(o.created_at, 'localtime') = date('now', 'localtime')) AS today_sale_count`;

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '비밀번호는 영문과 숫자를 함께 사용해 주세요.';
  return null;
}

function audit(req, action, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, 'USER', @target_id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.user.pharmacy_id, action, target_id: targetId, description }
  );
}

function findStaff(req) {
  return getOne(
    `SELECT ${STAFF_COLUMNS} FROM users u
     WHERE u.id = @id AND u.role = 'POS_STAFF' AND u.pharmacy_id = @pharmacy_id`,
    { id: Number(req.params.id), pharmacy_id: req.user.pharmacy_id }
  );
}

router.use(authenticate, requireRole('PHARMACY_OWNER'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  return next();
});

router.get('/', (req, res) => {
  const staff = getAll(
    `SELECT ${STAFF_COLUMNS} FROM users u
     WHERE u.role = 'POS_STAFF' AND u.pharmacy_id = @pharmacy_id
     ORDER BY CASE WHEN u.status = 'ACTIVE' THEN 0 ELSE 1 END, u.name ASC`,
    { pharmacy_id: req.user.pharmacy_id }
  );
  res.json({ staff });
});

router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim() || null;
  if (!name) return res.status(400).json({ message: '직원 이름을 입력해 주세요.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: '로그인 이메일 형식이 올바르지 않습니다.' });
  const passwordError = validatePassword(req.body.password);
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (getOne('SELECT id FROM users WHERE email = @email', { email })) {
    return res.status(409).json({ message: '이미 사용 중인 이메일입니다.' });
  }

  const staff = transaction(() => {
    const result = run(
      `INSERT INTO users (email, password_hash, name, phone, role, pharmacy_id)
       VALUES (@email, @password_hash, @name, @phone, 'POS_STAFF', @pharmacy_id)`,
      {
        email,
        password_hash: bcrypt.hashSync(String(req.body.password), 10),
        name,
        phone,
        pharmacy_id: req.user.pharmacy_id
      }
    );
    audit(req, 'POS_STAFF_CREATE', result.lastInsertRowid, `POS 직원 등록 · ${name} (${email})`);
    return getOne(`SELECT ${STAFF_COLUMNS} FROM users u WHERE u.id = @id`, { id: result.lastInsertRowid });
  })();

  res.status(201).json({ staff });
});

router.patch('/:id', (req, res) => {
  const staff = findStaff(req);
  if (!staff) return res.status(404).json({ message: '직원 계정을 찾을 수 없습니다.' });

  const name = req.body.name === undefined ? staff.name : String(req.body.name).trim();
  const phone = req.body.phone === undefined ? staff.phone : String(req.body.phone).trim() || null;
  const status = req.body.status === undefined ? staff.status : String(req.body.status).toUpperCase();
  if (!name) return res.status(400).json({ message: '직원 이름을 입력해 주세요.' });
  if (!['ACTIVE', 'INACTIVE'].includes(status)) return res.status(400).json({ message: '계정 상태가 올바르지 않습니다.' });

  const updated = transaction(() => {
    run(
      `UPDATE users SET name = @name, phone = @phone, status = @status, updated_at = CURRENT_TIMESTAMP
       WHERE id = @id AND role = 'POS_STAFF' AND pharmacy_id = @pharmacy_id`,
      { id: staff.id, name, phone, status, pharmacy_id: req.user.pharmacy_id }
    );
    const changes = [];
    if (name !== staff.name) changes.push(`이름 ${staff.name} → ${name}`);
    if ((phone || '') !== (staff.phone || '')) changes.push('연락처 변경');
    if (status !== staff.status) changes.push(status === 'ACTIVE' ? '계정 사용 재개' : '계정 사용 중지');
    if (changes.length) {
      audit(req, status !== staff.status && status === 'INACTIVE' ? 'POS_STAFF_DEACTIVATE' : 'POS_STAFF_UPDATE', staff.id, `POS 직원 ${staff.name} · ${changes.join(' · ')}`);
    }
    return findStaff(req);
  })();

  res.json({ staff: updated });
});

router.post('/:id/reset-password', (req, res) => {
  const staff = findStaff(req);
  if (!staff) return res.status(404).json({ message: '직원 계정을 찾을 수 없습니다.' });
  const passwordError = validatePassword(req.body.password);
  if (passwordError) return res.status(400).json({ message: passwordError });

  transaction(() => {
    run('UPDATE users SET password_hash = @hash, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
      id: staff.id,
      hash: bcrypt.hashSync(String(req.body.password), 10)
    });
    audit(req, 'POS_STAFF_PASSWORD_RESET', staff.id, `POS 직원 ${staff.name} 비밀번호 재설정`);
  })();

  res.json({ ok: true });
});

module.exports = router;
