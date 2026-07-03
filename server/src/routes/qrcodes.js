const express = require('express');
const { getOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

router.use(authenticate, requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope);

router.get('/mine', (req, res) => {
  const qr = getOne(
    `SELECT q.*, p.pharmacy_code, p.pharmacy_name
     FROM qr_codes q
     JOIN pharmacies p ON p.id = q.pharmacy_id
     WHERE q.pharmacy_id = @pharmacy_id`,
    { pharmacy_id: req.pharmacyId }
  );
  if (!qr) return res.status(404).json({ message: 'QR코드를 찾을 수 없습니다.' });
  res.json({ qr });
});

module.exports = router;
