const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');

const router = express.Router();

router.use(authenticate, requireRole('CUSTOMER'), requirePharmacyScope);

router.get('/', (req, res) => {
  const addresses = getAll(
    'SELECT * FROM addresses WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id ORDER BY is_default DESC, id DESC',
    { user_id: req.user.id, pharmacy_id: req.pharmacyId }
  );
  res.json({ addresses });
});

router.post('/', (req, res) => {
  const createAddress = transaction(() => {
    if (req.body.is_default) {
      run('UPDATE addresses SET is_default = 0 WHERE user_id = @user_id AND pharmacy_id = @pharmacy_id', {
        user_id: req.user.id,
        pharmacy_id: req.pharmacyId
      });
    }

    const result = run(
      `INSERT INTO addresses (
        user_id, pharmacy_id, receiver_name, phone, zip_code, address, address_detail, is_default
      ) VALUES (
        @user_id, @pharmacy_id, @receiver_name, @phone, @zip_code, @address, @address_detail, @is_default
      )`,
      {
        user_id: req.user.id,
        pharmacy_id: req.pharmacyId,
        receiver_name: req.body.receiver_name,
        phone: req.body.phone,
        zip_code: req.body.zip_code,
        address: req.body.address,
        address_detail: req.body.address_detail,
        is_default: req.body.is_default ? 1 : 0
      }
    );
    return getOne('SELECT * FROM addresses WHERE id = @id', { id: result.lastInsertRowid });
  });

  res.status(201).json({ address: createAddress() });
});

router.delete('/:id', (req, res) => {
  run('DELETE FROM addresses WHERE id = @id AND user_id = @user_id AND pharmacy_id = @pharmacy_id', {
    id: Number(req.params.id),
    user_id: req.user.id,
    pharmacy_id: req.pharmacyId
  });
  res.json({ ok: true });
});

module.exports = router;
