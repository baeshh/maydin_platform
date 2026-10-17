const { getOne, run, transaction } = require('../../db');
const { assertOutageOpen, parseClientSaleId, parseRecovery, recoveryRefOf, saleFingerprint } = require('../../services/pos-recovery');
const { PosError, requireOwner } = require('../common');
const { createPosSale, parseSaleRequest } = require('./checkout-service');
const { findDraft } = require('./draft-service');
const { buildReceipt } = require('./sale-service');
const { requireOpenSession } = require('./session-service');

function orderByClientId(pharmacyId, clientSaleId) {
  return getOne('SELECT id, client_sale_hash FROM orders WHERE pharmacy_id = @pharmacy_id AND client_sale_id = @id', {
    pharmacy_id: pharmacyId,
    id: clientSaleId
  });
}

// 기기에 보관했던 거래와 수기 복구 거래가 같은 판매를 두 번 기록하지 않게, 임시번호(거래 고유번호 앞 8자리)로 맞춰 본다.
function assertNotRecoveredTwice(req, recovery, clientSaleId) {
  if (recovery.source === 'OFFLINE_QUEUE') {
    const manual = getOne(
      "SELECT order_number FROM orders WHERE pharmacy_id = @pharmacy_id AND recovery_source = 'MANUAL' AND recovery_ref = @ref",
      { pharmacy_id: req.pharmacyId, ref: recoveryRefOf(clientSaleId) }
    );
    if (manual) {
      throw new PosError(
        `이 거래(임시번호 ${recoveryRefOf(clientSaleId).toUpperCase()})는 이미 수기로 복구했습니다(${manual.order_number}). 두 번 기록하지 않도록 이 기기의 보관 거래는 약국 관리자가 확인한 뒤 지워 주세요.`,
        409,
        'RECOVERED_MANUALLY',
        { order_number: manual.order_number }
      );
    }
  }
  if (recovery.source === 'MANUAL' && recovery.ref) {
    const saved = getOne(
      'SELECT order_number FROM orders WHERE pharmacy_id = @pharmacy_id AND client_sale_id IS NOT NULL AND LOWER(SUBSTR(client_sale_id, 1, 8)) = @ref',
      { pharmacy_id: req.pharmacyId, ref: recovery.ref }
    );
    if (saved) {
      throw new PosError(`임시번호 ${recovery.ref.toUpperCase()} 거래는 이미 서버에 저장돼 있습니다(${saved.order_number}). 다시 입력하지 마세요.`, 409, 'ALREADY_SAVED', {
        order_number: saved.order_number
      });
    }
    const manual = getOne("SELECT order_number FROM orders WHERE pharmacy_id = @pharmacy_id AND recovery_source = 'MANUAL' AND recovery_ref = @ref", {
      pharmacy_id: req.pharmacyId,
      ref: recovery.ref
    });
    if (manual) {
      throw new PosError(`임시번호 ${recovery.ref.toUpperCase()} 거래는 이미 수기로 복구했습니다(${manual.order_number}).`, 409, 'ALREADY_RECOVERED', {
        order_number: manual.order_number
      });
    }
  }
}

// 현금·계좌이체·수동 승인번호 판매와 장애 복구 판매를 저장한다. 같은 거래 고유번호는 한 번만 저장한다.
function saveDirectSale(req, body) {
  const { terminal, session } = requireOpenSession(req);
  const clientSaleId = parseClientSaleId(body.client_sale_id);
  const recovery = parseRecovery(body.recovery, req.pharmacyId);
  if (recovery) {
    if (!clientSaleId) throw new PosError('장애 복구 거래에는 거래 고유번호가 필요합니다.');
    if (recovery.source === 'MANUAL') requireOwner(req, '수기 거래 복구');
  }
  const request = parseSaleRequest(body, { recovery });
  const fingerprint = clientSaleId
    ? saleFingerprint({
        items: request.items,
        discountAmount: request.discountAmount,
        payments: body.payments,
        customerId: request.customerId,
        occurredAt: recovery?.occurredAt
      })
    : null;

  return transaction(() => {
    if (clientSaleId) {
      const existing = orderByClientId(req.pharmacyId, clientSaleId);
      if (existing) {
        if (existing.client_sale_hash !== fingerprint) {
          throw new PosError('같은 거래 고유번호로 내용이 다른 거래가 이미 저장되어 있습니다. 판매 내역을 확인해 주세요.', 409, 'CLIENT_SALE_CONFLICT');
        }
        return { ...buildReceipt(req, existing.id), duplicate: true };
      }
      if (findDraft(req.pharmacyId, clientSaleId)) {
        throw new PosError('결제를 준비한 판매는 결제 완료로 저장해 주세요.', 409, 'DRAFT_EXISTS');
      }
    }
    if (recovery) {
      assertOutageOpen(recovery.outage);
      assertNotRecoveredTwice(req, recovery, clientSaleId);
    }
    const { orderId, receipt } = createPosSale(req, { terminal, session, request, payments: body.payments, clientSaleId, fingerprint, recovery });
    if (recovery?.ref) {
      run('UPDATE orders SET recovery_ref = @ref WHERE id = @id', { id: orderId, ref: recovery.ref });
      return buildReceipt(req, orderId);
    }
    return receipt;
  })();
}

module.exports = { orderByClientId, saveDirectSale };
