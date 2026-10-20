const express = require('express');
const { getOne, run } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { findChannel } = require('../services/customers');
const { MallPolicyError, mallPolicy, photoSharing, sellerInfo, updateMallPolicy } = require('../services/mall-policy');

const router = express.Router();

// 몰 첫 화면·가입·로그인에서 쓴다. 배송 정책과 전자상거래 판매자 표시 정보는 공개 정보다.
router.get('/by-code/:pharmacyCode', (req, res) => {
  const pharmacy = getOne(
    `SELECT id, pharmacy_code, pharmacy_name, phone, address, store_slug, store_url, status
     FROM pharmacies
     WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'`,
    { pharmacyCode: req.params.pharmacyCode }
  );

  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  res.json({ pharmacy, mall: mallPolicy(pharmacy.id), seller: sellerInfo(pharmacy.id) });
});

router.post('/by-code/:pharmacyCode/scan', (req, res) => {
  const pharmacy = getOne("SELECT id FROM pharmacies WHERE pharmacy_code = @pharmacyCode AND status = 'ACTIVE'", {
    pharmacyCode: req.params.pharmacyCode
  });
  if (!pharmacy) return res.status(404).json({ message: '약국을 찾을 수 없습니다.' });

  run('UPDATE qr_codes SET scan_count = scan_count + 1 WHERE pharmacy_id = @pharmacy_id', {
    pharmacy_id: pharmacy.id
  });
  const channel = findChannel(pharmacy.id, req.body && req.body.channel);
  if (channel) run('UPDATE signup_channels SET scan_count = scan_count + 1 WHERE id = @id', { id: channel.id });
  res.json({ ok: true, channel: channel ? { name: channel.name } : null });
});

router.get('/me/mall-settings', authenticate, requireRole('PHARMACY_OWNER'), (req, res) => {
  res.json({ mall: mallPolicy(req.user.pharmacy_id), share_product_photos: photoSharing(req.user.pharmacy_id), seller: sellerInfo(req.user.pharmacy_id) });
});

router.patch('/me/mall-settings', authenticate, requireRole('PHARMACY_OWNER'), (req, res) => {
  try {
    const before = mallPolicy(req.user.pharmacy_id);
    const sharedBefore = photoSharing(req.user.pharmacy_id);
    const mall = updateMallPolicy(req.user.pharmacy_id, req.body || {});
    const shared = photoSharing(req.user.pharmacy_id);
    const fee = (p) => `배송 ${p.delivery_enabled ? `${p.delivery_fee.toLocaleString()}원${p.free_delivery_min ? `(${p.free_delivery_min.toLocaleString()}원 이상 무료)` : ''}` : '안 함'} · 픽업 ${p.pickup_enabled ? '함' : '안 함'}`;
    run(
      `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
       VALUES (@user_id, @pharmacy_id, 'MALL_SETTINGS', 'PHARMACY', @pharmacy_id, @description)`,
      {
        user_id: req.user.id,
        pharmacy_id: req.user.pharmacy_id,
        description: `온라인 몰 설정 변경 · ${fee(before)} → ${fee(mall)}${before.notice !== mall.notice ? ' · 공지 변경' : ''}${sharedBefore !== shared ? ` · 상품 사진 공유 ${shared ? '허락' : '중단'}` : ''}`
      }
    );
    res.json({ mall, share_product_photos: shared, seller: sellerInfo(req.user.pharmacy_id) });
  } catch (error) {
    if (error instanceof MallPolicyError) return res.status(400).json({ message: error.message });
    throw error;
  }
});

module.exports = router;
