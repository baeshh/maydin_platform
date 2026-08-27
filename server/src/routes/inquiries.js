const fs = require('fs');
const path = require('path');
const express = require('express');
const { getOne, run } = require('../db');

const router = express.Router();

const uploadDir = path.join(__dirname, '../../uploads/inquiries');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function ensureUploadDir() {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

function saveLicenseFile(file) {
  if (!file || !file.data) return { fileName: null, filePath: null };

  const mime = String(file.mime || '').trim();
  const originalName = String(file.name || 'license').trim();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error('약사 등록증은 JPG, PNG, WEBP, PDF만 업로드할 수 있습니다.');
  }

  const base64 = String(file.data).replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('약사 등록증 파일이 비어 있습니다.');
  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error('약사 등록증은 5MB 이하로 업로드해 주세요.');
  }

  ensureUploadDir();
  const ext =
    mime === 'application/pdf'
      ? '.pdf'
      : mime === 'image/png'
        ? '.png'
        : mime === 'image/webp'
          ? '.webp'
          : '.jpg';
  const safeBase = originalName.replace(/[^\w.\-가-힣]/g, '_').slice(0, 40) || 'license';
  const storedName = `${Date.now()}-${Math.floor(Math.random() * 10000)}-${safeBase}${ext}`;
  const absolutePath = path.join(uploadDir, storedName);
  fs.writeFileSync(absolutePath, buffer);

  return {
    fileName: originalName,
    filePath: path.join('uploads/inquiries', storedName).replace(/\\/g, '/')
  };
}

router.post('/', (req, res) => {
  try {
    const pharmacyName = String(req.body.pharmacy_name || '').trim();
    const contactName = String(req.body.contact_name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const email = String(req.body.email || '').trim();
    const licenseNumber = String(req.body.license_number || '').trim();
    const messageText = String(req.body.message || '').trim();

    if (!pharmacyName || !contactName || !phone || !email || !licenseNumber || !messageText) {
      return res.status(400).json({ message: '필수 항목을 모두 입력해 주세요.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다.' });
    }

    if (!req.body.license_file || !req.body.license_file.data) {
      return res.status(400).json({ message: '약사 등록증 파일을 업로드해 주세요.' });
    }

    const saved = saveLicenseFile(req.body.license_file);

    const result = run(
      `INSERT INTO partnership_inquiries (
        pharmacy_name, contact_name, phone, email, license_number,
        license_file_name, license_file_path, message, status
      ) VALUES (
        @pharmacy_name, @contact_name, @phone, @email, @license_number,
        @license_file_name, @license_file_path, @message, 'NEW'
      )`,
      {
        pharmacy_name: pharmacyName,
        contact_name: contactName,
        phone,
        email,
        license_number: licenseNumber,
        license_file_name: saved.fileName,
        license_file_path: saved.filePath,
        message: messageText
      }
    );

    res.status(201).json({
      inquiry: getOne('SELECT * FROM partnership_inquiries WHERE id = @id', {
        id: result.lastInsertRowid
      })
    });
  } catch (error) {
    res.status(400).json({ message: error.message || '문의 접수에 실패했습니다.' });
  }
});

module.exports = router;
