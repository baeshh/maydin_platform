const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { OUTAGE_KINDS, createOutage, listOutages, outageDetail } = require('../../services/pos-recovery');
const { syncSettings } = require('../../services/product-import');
const { PosError, audit, cleanText, handle, requireOwner, toInt } = require('../common');
const { logStock } = require('../services/inventory-service');
const { outageDeviceCheck } = require('../services/offline-service');

const router = express.Router();

function unconfirmedLabel(item) {
  const name = item.terminal_name || '카운터 없음';
  if (item.kind === 'LOST') return `${name} 교체한 PC ${item.install}(서버에 없는 거래 ${item.missing_count}건)`;
  if (item.kind === 'UNREPORTED') return `${name}(보고 없음)`;
  return `${name} PC ${item.install}(마지막 보고 ${item.reported_at})`;
}

// 장애 때 단말기에 보관할 상품 목록. 바코드·가격·구분만 담고 고객 정보는 넣지 않는다.
router.get(
  '/offline-catalog',
  handle((req) => {
    const products = getAll(
      `SELECT p.id, p.product_name, p.barcode, p.price, p.discount_price, COALESCE(p.discount_price, p.price) AS sale_price,
              COALESCE(p.product_type, 'GENERAL') AS product_type, p.status, p.stock_quantity, p.category_id, c.category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.pharmacy_id = @pharmacy_id AND p.status != 'HIDDEN' AND COALESCE(p.pos_sale_enabled, 1) = 1
         AND COALESCE(p.product_type, 'GENERAL') != 'ETC'
       ORDER BY p.product_name ASC`,
      { pharmacy_id: req.pharmacyId }
    );
    return { products, generated_at: new Date().toISOString() };
  })
);

router.get(
  '/outages',
  handle((req) => ({ outages: listOutages(req.pharmacyId), kinds: OUTAGE_KINDS }))
);

router.post(
  '/outages',
  handle((req, res) => {
    const outage = transaction(() => {
      const created = createOutage({
        pharmacyId: req.pharmacyId,
        userId: req.user.id,
        kind: req.body.kind,
        startedAt: req.body.started_at,
        endedAt: req.body.ended_at,
        note: req.body.note
      });
      audit(req, 'POS_OUTAGE', 'OUTAGE', created.id, `장애 기록 · ${OUTAGE_KINDS[created.kind]} · ${created.started_at} ~ ${created.ended_at} UTC${created.note ? ` · ${created.note}` : ''}`);
      return created;
    })();
    res.status(201);
    return { outage };
  })
);

function withDeviceCheck(pharmacyId, detail) {
  return { ...detail, device_check: detail.outage.status === 'RECONCILED' ? null : outageDeviceCheck(pharmacyId, detail.outage) };
}

router.get(
  '/outages/:id',
  handle((req) => ({ ...withDeviceCheck(req.pharmacyId, outageDetail(req.pharmacyId, req.params.id)), legacy_stock: syncSettings(req.pharmacyId).enabled }))
);

// 장애 뒤 재고 대사: 복구 거래에 나온 상품을 모두 세어 시스템 재고를 실제 수량으로 맞추고 장애를 닫는다.
// 기존 POS가 재고 기준이면 수량은 기존 POS에서 맞추므로 확인만 기록한다.
router.post(
  '/outages/:id/reconcile',
  handle((req) => {
    requireOwner(req, '장애 후 재고 대사');
    const legacy = syncSettings(req.pharmacyId).enabled;
    const note = cleanText(req.body.note, 300);
    const counts = new Map((Array.isArray(req.body.counts) ? req.body.counts : []).map((c) => [Number(c.product_id), c.counted_quantity]));

    return transaction(() => {
      const detail = outageDetail(req.pharmacyId, req.params.id);
      if (detail.outage.status === 'RECONCILED') throw new PosError('이미 재고 대사를 마친 장애입니다.', 409);
      // 다른 PC에 아직 안 들어온 장애 중 거래가 있으면 센 수량과 시스템 재고가 맞지 않는다.
      const deviceCheck = outageDeviceCheck(req.pharmacyId, detail.outage);
      if (deviceCheck.pending.length) {
        const count = deviceCheck.pending.reduce((sum, d) => sum + d.unsent_count, 0);
        throw new PosError(`서버로 보내지 않은 장애 중 거래가 ${count}건 남은 PC가 있습니다(${deviceCheck.pending.map((d) => d.terminal_name || `PC ${d.install}`).join(', ')}). 먼저 보낸 뒤 대사해 주세요.`, 409, 'OFFLINE_QUEUE_PENDING', {
          device_check: deviceCheck
        });
      }
      if (deviceCheck.unconfirmed.length && req.body.confirm_devices !== true) {
        throw new PosError('장애가 끝난 뒤 보관 거래를 확인하지 못한 PC가 있습니다. 그 PC에 남은 거래가 없는지 직접 확인한 뒤 대사해 주세요.', 409, 'DEVICES_UNCONFIRMED', {
          device_check: deviceCheck
        });
      }
      const adjusted = [];
      if (!legacy) {
        for (const item of detail.products) {
          if (!counts.has(item.product_id) || counts.get(item.product_id) === '' || counts.get(item.product_id) === null) {
            throw new PosError(`${item.product_name}의 실제 재고를 세어 입력해 주세요.`);
          }
          const after = toInt(counts.get(item.product_id), `${item.product_name} 실사 수량`, { min: 0, max: 100000 });
          const before = getOne('SELECT stock_quantity FROM products WHERE id = @id', { id: item.product_id }).stock_quantity;
          if (after === before) continue;
          run(
            `UPDATE products
             SET stock_quantity = @after,
                 status = CASE
                   WHEN @after > 0 AND status = 'SOLD_OUT' THEN 'ON_SALE'
                   WHEN @after <= 0 AND status = 'ON_SALE' THEN 'SOLD_OUT'
                   ELSE status END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = @id AND stock_quantity = @before`,
            { id: item.product_id, before, after }
          );
          logStock(req, item.product_id, before, after, 'COUNT_ADJUST', `장애 #${detail.outage.id} 후 재고 대사${note ? ` · ${note}` : ''}`);
          adjusted.push({ product_id: item.product_id, product_name: item.product_name, before, after });
        }
      }
      run(
        `UPDATE pos_outages
         SET status = 'RECONCILED', reconciled_at = CURRENT_TIMESTAMP, reconciled_by = @user_id, reconcile_note = @note
         WHERE id = @id AND status != 'RECONCILED'`,
        { id: detail.outage.id, user_id: req.user.id, note: note || null }
      );
      audit(
        req,
        'POS_OUTAGE_RECONCILE',
        'OUTAGE',
        detail.outage.id,
        `장애 #${detail.outage.id} 재고 대사 완료 · 상품 ${detail.products.length}종 확인${legacy ? ' (기존 POS 재고 기준 — 수량은 기존 POS에서 조정)' : ` · 조정 ${adjusted.length}종`}${adjusted.length ? ` (${adjusted.map((a) => `${a.product_name} ${a.before}→${a.after}`).join(', ')})` : ''}${deviceCheck.unconfirmed.length ? ` · 관리자가 직접 확인한 PC: ${deviceCheck.unconfirmed.map(unconfirmedLabel).join(', ')}` : ''}`
      );
      return { ...outageDetail(req.pharmacyId, detail.outage.id), adjusted, legacy_stock: legacy };
    })();
  })
);

module.exports = router;
