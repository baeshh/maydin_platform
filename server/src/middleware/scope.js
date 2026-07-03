function requirePharmacyScope(req, res, next) {
  if (req.user.role === 'ADMIN') {
    const pharmacyId = Number(req.params.pharmacyId || req.query.pharmacyId || req.body.pharmacy_id);
    if (pharmacyId) req.pharmacyId = pharmacyId;
    return next();
  }

  if (!req.user.pharmacy_id) {
    return res.status(403).json({ message: '약국에 연결된 계정이 아닙니다.' });
  }

  req.pharmacyId = req.user.pharmacy_id;
  return next();
}

function assertSamePharmacy(req, res, next) {
  const requested = Number(req.params.pharmacyId || req.body.pharmacy_id || req.query.pharmacyId);
  if (req.user.role !== 'ADMIN' && requested && requested !== req.user.pharmacy_id) {
    return res.status(403).json({ message: '다른 약국 데이터에는 접근할 수 없습니다.' });
  }
  return next();
}

module.exports = {
  requirePharmacyScope,
  assertSamePharmacy
};
