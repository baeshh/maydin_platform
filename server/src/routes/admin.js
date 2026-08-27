const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate, requireRole('ADMIN'));

router.get('/summary', (req, res) => {
  const totals = getOne(
    `SELECT
      (SELECT COUNT(*) FROM pharmacies) AS pharmacy_count,
      (SELECT COUNT(*) FROM pharmacies WHERE status = 'ACTIVE') AS active_pharmacy_count,
      (SELECT COUNT(*) FROM users WHERE role = 'CUSTOMER') AS customer_count,
      (SELECT COUNT(*) FROM orders) AS order_count,
      COALESCE((SELECT SUM(final_amount) FROM orders WHERE payment_status = 'PAID'), 0) AS total_sales`
  );
  const topPharmacies = getAll(
    `SELECT p.id, p.pharmacy_name, COUNT(o.id) AS order_count, COALESCE(SUM(o.final_amount), 0) AS sales
     FROM pharmacies p
     LEFT JOIN orders o ON o.pharmacy_id = p.id
     GROUP BY p.id
     ORDER BY sales DESC
     LIMIT 5`
  );
  res.json({ totals, topPharmacies });
});

router.get('/pharmacies', (req, res) => {
  const pharmacies = getAll(
    `SELECT p.*,
      q.qr_url,
      q.scan_count,
      q.signup_count,
      (SELECT COUNT(*) FROM users u WHERE u.role = 'CUSTOMER' AND u.pharmacy_id = p.id) AS customer_count,
      (SELECT COUNT(*) FROM products pr WHERE pr.pharmacy_id = p.id) AS product_count,
      (SELECT COUNT(*) FROM orders o WHERE o.pharmacy_id = p.id) AS order_count,
      COALESCE((SELECT SUM(final_amount) FROM orders o WHERE o.pharmacy_id = p.id), 0) AS sales
     FROM pharmacies p
     LEFT JOIN qr_codes q ON q.pharmacy_id = p.id
     ORDER BY p.id DESC`
  );
  res.json({ pharmacies });
});

router.post('/pharmacies', (req, res) => {
  const {
    pharmacy_code,
    pharmacy_name,
    owner_name,
    business_number,
    address,
    phone,
    store_slug,
    commission_rate,
    owner_email,
    owner_password,
    owner_phone,
    settlement_bank,
    settlement_account,
    delivery_policy,
    default_courier
  } = req.body;

  const exists = getOne('SELECT id FROM pharmacies WHERE pharmacy_code = @pharmacy_code OR store_slug = @store_slug', {
    pharmacy_code,
    store_slug
  });
  if (exists) return res.status(409).json({ message: '이미 존재하는 약국 코드 또는 주소입니다.' });

  const emailExists = getOne('SELECT id FROM users WHERE email = @owner_email', { owner_email });
  if (emailExists) return res.status(409).json({ message: '이미 존재하는 운영자 이메일입니다.' });

  const createPharmacy = transaction(() => {
    const storeUrl = `/store.html?pharmacyCode=${encodeURIComponent(pharmacy_code)}`;
    const pharmacyResult = run(
      `INSERT INTO pharmacies (
        pharmacy_code, pharmacy_name, owner_name, business_number, phone, address,
        store_slug, store_url, commission_rate, settlement_bank, settlement_account,
        delivery_policy, default_courier
      ) VALUES (
        @pharmacy_code, @pharmacy_name, @owner_name, @business_number, @phone, @address,
        @store_slug, @store_url, @commission_rate, @settlement_bank, @settlement_account,
        @delivery_policy, @default_courier
      )`,
      {
        pharmacy_code,
        pharmacy_name,
        owner_name,
        business_number,
        phone,
        address,
        store_slug,
        store_url: storeUrl,
        commission_rate: Number(commission_rate || 5),
        settlement_bank,
        settlement_account,
        delivery_policy,
        default_courier
      }
    );

    const pharmacyId = pharmacyResult.lastInsertRowid;
    run(
      `INSERT INTO users (email, password_hash, name, phone, role, pharmacy_id)
       VALUES (@email, @password_hash, @name, @phone, 'PHARMACY_OWNER', @pharmacy_id)`,
      {
        email: owner_email,
        password_hash: bcrypt.hashSync(owner_password || 'owner1234', 10),
        name: owner_name,
        phone: owner_phone || phone,
        pharmacy_id: pharmacyId
      }
    );

    run(
      `INSERT INTO qr_codes (pharmacy_id, qr_url, qr_image_url)
       VALUES (@pharmacy_id, @qr_url, '')`,
      {
        pharmacy_id: pharmacyId,
        qr_url: `/join.html?pharmacyCode=${encodeURIComponent(pharmacy_code)}`
      }
    );

    return getOne('SELECT * FROM pharmacies WHERE id = @id', { id: pharmacyId });
  });

  res.status(201).json({ pharmacy: createPharmacy() });
});

router.patch('/pharmacies/:id/status', (req, res) => {
  const { status } = req.body;
  run('UPDATE pharmacies SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id', {
    id: Number(req.params.id),
    status
  });
  res.json({ pharmacy: getOne('SELECT * FROM pharmacies WHERE id = @id', { id: Number(req.params.id) }) });
});

router.get('/inquiries', (req, res) => {
  const inquiries = getAll(
    `SELECT *
     FROM partnership_inquiries
     ORDER BY
       CASE status WHEN 'NEW' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END,
       id DESC`
  );
  const counts = getOne(
    `SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'NEW' THEN 1 ELSE 0 END) AS new_count,
      SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress_count,
      SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_count
     FROM partnership_inquiries`
  );
  res.json({ inquiries, counts });
});

router.patch('/inquiries/:id', (req, res) => {
  const id = Number(req.params.id);
  const inquiry = getOne('SELECT * FROM partnership_inquiries WHERE id = @id', { id });
  if (!inquiry) return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });

  const status = req.body.status ? String(req.body.status) : inquiry.status;
  const allowed = new Set(['NEW', 'IN_PROGRESS', 'DONE']);
  if (!allowed.has(status)) {
    return res.status(400).json({ message: '지원하지 않는 상태입니다.' });
  }

  const adminNote =
    req.body.admin_note !== undefined ? String(req.body.admin_note || '').trim() : inquiry.admin_note;

  run(
    `UPDATE partnership_inquiries
     SET status = @status,
         admin_note = @admin_note,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id, status, admin_note: adminNote }
  );

  res.json({ inquiry: getOne('SELECT * FROM partnership_inquiries WHERE id = @id', { id }) });
});

router.get('/inquiries/:id/license', (req, res) => {
  const id = Number(req.params.id);
  const inquiry = getOne('SELECT * FROM partnership_inquiries WHERE id = @id', { id });
  if (!inquiry || !inquiry.license_file_path) {
    return res.status(404).json({ message: '등록증 파일을 찾을 수 없습니다.' });
  }

  const absolutePath = path.join(__dirname, '../..', inquiry.license_file_path);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ message: '등록증 파일이 존재하지 않습니다.' });
  }

  res.download(absolutePath, inquiry.license_file_name || path.basename(absolutePath));
});

router.delete('/inquiries/:id', (req, res) => {
  const id = Number(req.params.id);
  const inquiry = getOne('SELECT * FROM partnership_inquiries WHERE id = @id', { id });
  if (!inquiry) return res.status(404).json({ message: '문의를 찾을 수 없습니다.' });

  if (inquiry.license_file_path) {
    const absolutePath = path.join(__dirname, '../..', inquiry.license_file_path);
    if (fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (error) {
        console.error('Failed to delete license file:', error);
      }
    }
  }

  run('DELETE FROM partnership_inquiries WHERE id = @id', { id });
  res.json({ ok: true, id });
});

module.exports = router;
