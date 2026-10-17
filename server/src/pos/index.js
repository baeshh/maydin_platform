const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { resolveTerminal } = require('./services/terminal-service');

const contextRoutes = require('./routes/context');
const catalogRoutes = require('./routes/catalog');
const customersRoutes = require('./routes/customers');
const sessionsRoutes = require('./routes/sessions');
const salesRoutes = require('./routes/sales');
const recoveryRoutes = require('./routes/recovery');
const refundsRoutes = require('./routes/refunds');
const pickupsRoutes = require('./routes/pickups');
const counselsRoutes = require('./routes/counsels');
const reportsRoutes = require('./routes/reports');
const holdsRoutes = require('./routes/holds');
const inventoryRoutes = require('./routes/inventory');
const terminalsRoutes = require('./routes/terminals');
const paymentsRoutes = require('./routes/payments');
const printingRoutes = require('./routes/printing');
const offlineRoutes = require('./routes/offline');

const router = express.Router();

router.use(authenticate, requireRole('PHARMACY_OWNER', 'POS_STAFF'), (req, res, next) => {
  if (!req.user.pharmacy_id) return res.status(403).json({ message: '약국이 지정되지 않은 계정입니다.' });
  req.pharmacyId = req.user.pharmacy_id;
  req.pos = resolveTerminal(req);
  return next();
});

router.use(contextRoutes);
router.use(catalogRoutes);
router.use(customersRoutes);
router.use(sessionsRoutes);
router.use(salesRoutes);
router.use(recoveryRoutes);
router.use(refundsRoutes);
router.use(pickupsRoutes);
router.use(counselsRoutes);
router.use(reportsRoutes);
router.use(holdsRoutes);
router.use(inventoryRoutes);
router.use(terminalsRoutes);
router.use(paymentsRoutes);
router.use(printingRoutes);
router.use(offlineRoutes);

module.exports = router;
