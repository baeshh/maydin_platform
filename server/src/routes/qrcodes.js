const express = require('express');
const { getAll, getOne, run, transaction } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { CHANNEL_TYPES, CustomerError, generateChannelCode } = require('../services/customers');

const router = express.Router();
const MAX_CHANNELS = 50;

router.use(authenticate, requireRole('PHARMACY_OWNER', 'ADMIN'), requirePharmacyScope);

function audit(req, action, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, 'SIGNUP_CHANNEL', @target_id, @description)`,
    { user_id: req.user.id, pharmacy_id: req.pharmacyId, action, target_id: targetId, description }
  );
}

function fail(res, error) {
  if (error instanceof CustomerError) return res.status(error.status).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: '가입 경로를 처리하는 중 오류가 발생했습니다.' });
}

const MEMBER_STATS = `
  COUNT(c.id) AS member_count,
  COUNT(CASE WHEN EXISTS (
    SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.final_amount > 0 AND o.order_type != 'COUNSEL'
  ) THEN 1 END) AS purchaser_count,
  COALESCE(SUM((SELECT COALESCE(SUM(o.final_amount), 0) FROM orders o WHERE o.customer_id = c.id AND o.order_type != 'COUNSEL')), 0) AS net_sales`;

function channelList(pharmacyId) {
  const qr = getOne('SELECT scan_count, signup_count FROM qr_codes WHERE pharmacy_id = @pharmacy_id', { pharmacy_id: pharmacyId });
  const channels = getAll(
    `SELECT ch.*, ${MEMBER_STATS}
     FROM signup_channels ch
     LEFT JOIN customers c ON c.signup_channel_id = ch.id
     WHERE ch.pharmacy_id = @pharmacy_id
     GROUP BY ch.id
     ORDER BY ch.status = 'ACTIVE' DESC, ch.id DESC`,
    { pharmacy_id: pharmacyId }
  );
  const base = getOne(
    `SELECT ${MEMBER_STATS} FROM customers c WHERE c.pharmacy_id = @pharmacy_id AND c.signup_channel_id IS NULL`,
    { pharmacy_id: pharmacyId }
  );
  const channelScans = channels.reduce((sum, ch) => sum + ch.scan_count, 0);
  const basic = {
    id: null,
    code: null,
    name: '기본 가입 링크',
    channel_type: 'BASIC',
    status: 'ACTIVE',
    scan_count: Math.max(0, (qr ? qr.scan_count : 0) - channelScans),
    ...base
  };
  return [basic, ...channels].map((row) => ({
    ...row,
    signup_rate: row.scan_count ? Math.round((row.member_count / row.scan_count) * 1000) / 10 : null,
    purchase_rate: row.member_count ? Math.round((row.purchaser_count / row.member_count) * 1000) / 10 : null
  }));
}

function parseChannelInput(body, { partial = false } = {}) {
  const input = {};
  if (!partial || 'name' in body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 40) throw new CustomerError('QR 이름을 1~40자로 입력해 주세요.');
    input.name = name;
  }
  if (!partial || 'channel_type' in body) {
    const type = String(body.channel_type || 'ETC').toUpperCase();
    if (!CHANNEL_TYPES[type]) throw new CustomerError('가입 경로 종류가 올바르지 않습니다.');
    input.channel_type = type;
  }
  if (!partial || 'memo' in body) input.memo = String(body.memo || '').trim().slice(0, 200) || null;
  if ('status' in body) {
    const status = String(body.status || '').toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new CustomerError('상태 값이 올바르지 않습니다.');
    input.status = status;
  }
  return input;
}

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

router.get('/channels', (req, res) => {
  res.json({ channels: channelList(req.pharmacyId), types: CHANNEL_TYPES });
});

router.post('/channels', (req, res) => {
  try {
    const input = parseChannelInput(req.body);
    const channel = transaction(() => {
      const count = getOne('SELECT COUNT(*) AS count FROM signup_channels WHERE pharmacy_id = @pharmacy_id', {
        pharmacy_id: req.pharmacyId
      }).count;
      if (count >= MAX_CHANNELS) throw new CustomerError(`가입 경로 QR은 최대 ${MAX_CHANNELS}개까지 만들 수 있습니다.`);
      if (getOne('SELECT 1 FROM signup_channels WHERE pharmacy_id = @pharmacy_id AND name = @name', { pharmacy_id: req.pharmacyId, name: input.name })) {
        throw new CustomerError('같은 이름의 QR이 이미 있습니다.', 409);
      }
      const result = run(
        `INSERT INTO signup_channels (pharmacy_id, code, name, channel_type, memo, created_by)
         VALUES (@pharmacy_id, @code, @name, @channel_type, @memo, @created_by)`,
        { pharmacy_id: req.pharmacyId, code: generateChannelCode(), ...input, created_by: req.user.id }
      );
      audit(req, 'CHANNEL_CREATE', result.lastInsertRowid, `가입 경로 QR 생성 · ${input.name} (${CHANNEL_TYPES[input.channel_type]})`);
      return getOne('SELECT * FROM signup_channels WHERE id = @id', { id: result.lastInsertRowid });
    })();
    return res.status(201).json({ channel, channels: channelList(req.pharmacyId) });
  } catch (error) {
    return fail(res, error);
  }
});

router.patch('/channels/:id', (req, res) => {
  try {
    const input = parseChannelInput(req.body, { partial: true });
    if (!Object.keys(input).length) throw new CustomerError('변경할 내용이 없습니다.');
    transaction(() => {
      const channel = getOne('SELECT * FROM signup_channels WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!channel) throw new CustomerError('가입 경로 QR을 찾을 수 없습니다.', 404);
      if (input.name && input.name !== channel.name &&
          getOne('SELECT 1 FROM signup_channels WHERE pharmacy_id = @pharmacy_id AND name = @name AND id != @id', { pharmacy_id: req.pharmacyId, name: input.name, id: channel.id })) {
        throw new CustomerError('같은 이름의 QR이 이미 있습니다.', 409);
      }
      const sets = Object.keys(input).map((key) => `${key} = @${key}`).join(', ');
      run(`UPDATE signup_channels SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`, { ...input, id: channel.id });
      const changes = [
        input.name && input.name !== channel.name ? `이름 ${channel.name} → ${input.name}` : null,
        input.status && input.status !== channel.status ? (input.status === 'ACTIVE' ? '다시 사용' : '사용 중지') : null
      ].filter(Boolean);
      audit(req, 'CHANNEL_UPDATE', channel.id, `가입 경로 QR 수정 · ${channel.name}${changes.length ? ` · ${changes.join(' · ')}` : ''}`);
    })();
    return res.json({ channels: channelList(req.pharmacyId) });
  } catch (error) {
    return fail(res, error);
  }
});

module.exports = router;
