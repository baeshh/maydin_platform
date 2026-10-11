const express = require('express');
const { getAll, getOne } = require('../../db');
const { pointPolicy } = require('../../services/points');
const { PAYMENT_METHODS, handle, isOwner, localToday, stockSyncSummary } = require('../common');
const { heldCount } = require('../services/hold-service');
const { inventoryAlerts } = require('../services/inventory-service');
const { findOpenSession, withSummary } = require('../services/session-service');
const { DEVICE_STATES, listTerminals, publicTerminal, vanInfo } = require('../services/terminal-service');

const router = express.Router();

router.get(
  '/context',
  handle((req) => {
    const pharmacy = getOne(
      'SELECT id, pharmacy_code, pharmacy_name, owner_name, business_number, phone, address FROM pharmacies WHERE id = @id',
      { id: req.pharmacyId }
    );
    const { terminal, device } = req.pos;
    const categories = getAll(
      `SELECT c.id, c.category_name
       FROM categories c
       WHERE c.pharmacy_id = @pharmacy_id
         AND EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.status != 'HIDDEN')
       ORDER BY c.category_name`,
      { pharmacy_id: req.pharmacyId }
    );
    return {
      pharmacy,
      user: { id: req.user.id, name: req.user.name, role: req.user.role },
      terminal: publicTerminal(terminal),
      device: { state: device, label: DEVICE_STATES[device] },
      terminals: isOwner(req) ? listTerminals(req.pharmacyId) : undefined,
      van: terminal ? vanInfo(terminal) : null,
      session: terminal ? withSummary(findOpenSession(terminal.id)) : null,
      today: localToday(),
      categories,
      payment_methods: PAYMENT_METHODS,
      point_policy: pointPolicy(req.pharmacyId),
      hold_count: heldCount(req.pharmacyId),
      inventory_alerts: inventoryAlerts(req.pharmacyId),
      stock_sync: stockSyncSummary(req.pharmacyId),
      permissions: {
        can_refund: isOwner(req),
        can_close: isOwner(req),
        can_cash_movement: isOwner(req),
        can_sell_otc: isOwner(req),
        can_view_audit: isOwner(req),
        can_register_product: isOwner(req),
        can_receive_stock: true,
        can_adjust_stock: isOwner(req),
        can_manage_van: isOwner(req),
        can_manage_terminals: isOwner(req)
      }
    };
  })
);

module.exports = router;
