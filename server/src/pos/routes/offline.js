const express = require('express');
const { transaction } = require('../../db');
const { parseClientSaleId } = require('../../services/pos-recovery');
const { PosError, audit, cleanText, handle, requireOwner, won } = require('../common');
const { saveDirectSale } = require('../services/direct-sale-service');
const { deviceQueueStatus, openSealed, reportDeviceQueue, resolveDeviceQueue } = require('../services/offline-service');

const router = express.Router();

// 장애 중 기기에 잠가 둔 거래를 서버가 풀어 저장한다. 같은 거래 고유번호는 한 번만 저장된다.
router.post(
  '/offline-sales',
  handle((req, res) => {
    const clientSaleId = parseClientSaleId(req.body.client_sale_id);
    if (!clientSaleId) throw new PosError('거래 고유번호가 필요합니다.');
    const { payload } = openSealed(req.pharmacyId, clientSaleId, req.body.sealed);
    const { recovery: _ignored, ...saleBody } = payload.body;
    const body = {
      ...saleBody,
      client_sale_id: clientSaleId,
      recovery: { source: 'OFFLINE_QUEUE', occurred_at: payload.occurred_at, outage_id: req.body.outage_id }
    };
    let receipt;
    try {
      receipt = saveDirectSale(req, body);
    } catch (error) {
      // 결제 직전 서버가 저장하고 응답만 못 준 거래: 처음 보낸 내용과 같으면 그 거래로 확인된다.
      if (error.reason !== 'CLIENT_SALE_CONFLICT' || !payload.first_body) throw error;
      receipt = saveDirectSale(req, { ...payload.first_body, client_sale_id: clientSaleId });
    }
    res.status(receipt.duplicate ? 200 : 201);
    return receipt;
  })
);

// 이 PC에 남은 보관 거래(번호·시각·금액·상태)를 알린다. 이미 서버에 있는 거래 번호를 돌려주면 PC가 지운다.
router.post(
  '/offline-queue/report',
  handle((req) => transaction(() => reportDeviceQueue(req, req.body))())
);

router.get(
  '/offline-queue/status',
  handle((req) => {
    requireOwner(req, '카운터별 미전송 거래 확인');
    return deviceQueueStatus(req.pharmacyId);
  })
);

// 교체·해제한 PC의 남은 거래를 모두 확인(전송·수기 복구·판매 안 함)했다고 기록한다.
router.post(
  '/offline-queue/devices/:id/resolve',
  handle((req) => {
    requireOwner(req, '보관 거래 확인 완료');
    const note = cleanText(req.body.note, 300);
    return transaction(() => {
      const device = resolveDeviceQueue(req, req.params.id, note);
      audit(
        req,
        'POS_DEVICE_QUEUE_RESOLVE',
        'POS_TERMINAL',
        device.terminal_id,
        `${device.terminal_name || '카운터 없음'} PC ${device.install} 보관 거래 확인 완료 · 남았던 거래 ${device.entries.length}건(${won(device.total_amount)}) · 서버에 없음 ${device.missing_count}건${note ? ` · ${note}` : ''}`
      );
      return deviceQueueStatus(req.pharmacyId);
    })();
  })
);

module.exports = router;
