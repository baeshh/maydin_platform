const express = require('express');
const { getOne, run } = require('../db');

const router = express.Router();

router.get('/by-code/:pharmacyCode', (req, res) => {
  const pharmacy = getOne(
    `SELECT id, pharmacy_code, pharmacy_name, phone, address, store_slug, store_url, status
     FROM pharmacies
     WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'`,
    { pharmacyCode: req.params.pharmacyCode }
  );

  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  res.json({ pharmacy });
});

router.post('/by-code/:pharmacyCode/scan', (req, res) => {
  const pharmacy = getOne("SELECT id FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'", {
    pharmacyCode: req.params.pharmacyCode
  });
  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  run('UPDATE qr_codes SET scan_count = scan_count + 1 WHERE pharmacy_id = @pharmacy_id', {
    pharmacy_id: pharmacy.id
  });
  res.json({ ok: true });
});

module.exports = router;
