const { getOne, run } = require('../../db');
const { parseClientSaleId } = require('../../services/pos-recovery');
const { PosError } = require('../common');
const { PENDING_STATUSES, draftApprovals, publicVan } = require('./payment-service');

function findDraft(pharmacyId, clientSaleId) {
  return getOne('SELECT * FROM pos_sale_drafts WHERE pharmacy_id = @pharmacy_id AND client_sale_id = @id', {
    pharmacy_id: pharmacyId,
    id: clientSaleId
  });
}

function requireClientSaleId(value) {
  const id = parseClientSaleId(value);
  if (!id) throw new PosError('거래 고유번호가 필요합니다.');
  return id;
}

// 이 카운터에서 결제 중인 판매. 다른 카운터의 판매에는 승인을 붙일 수 없다.
function requireOpenDraft(req, terminal, clientSaleId) {
  const draft = findDraft(req.pharmacyId, requireClientSaleId(clientSaleId));
  if (!draft) throw new PosError('결제 준비된 판매를 찾을 수 없습니다. 결제를 다시 시작해 주세요.', 404, 'DRAFT_NOT_FOUND');
  if (draft.terminal_id !== terminal.id) throw new PosError('다른 카운터에서 준비한 판매입니다.', 403);
  if (draft.status !== 'OPEN') throw new PosError(draft.status === 'CONFIRMED' ? '이미 완료된 판매입니다.' : '취소된 판매입니다.', 409, `DRAFT_${draft.status}`);
  return draft;
}

// 확정하기 전 확인: 결과 모르는 승인이 없고, 받은 승인은 모두 결제에 넣었고, 카드·간편결제는 모두 승인을 거쳤다.
function assertDraftPayable(draft, payments) {
  const approvals = draftApprovals(draft.id);
  const pending = approvals.filter((tx) => PENDING_STATUSES.includes(tx.status));
  if (pending.length) {
    throw new PosError('결과를 아직 모르는 승인이 있습니다. 승인 결과를 먼저 확인해 주세요.', 409, 'APPROVAL_PENDING', { pending: pending.map(publicVan) });
  }
  const list = Array.isArray(payments) ? payments : [];
  if (list.some((p) => ['CARD', 'EASY_PAY'].includes(String(p.method || '').toUpperCase()) && !p.van_transaction_id)) {
    throw new PosError('카드·간편결제는 승인 요청을 거친 결제만 넣을 수 있습니다.');
  }
  const used = new Set(list.map((p) => Number(p.van_transaction_id)).filter(Boolean));
  const unused = approvals.filter((tx) => tx.status === 'APPROVED' && !used.has(tx.id));
  if (unused.length) {
    throw new PosError('결제에 넣지 않은 승인이 있습니다. 결제에 넣거나 승인을 취소해 주세요.', 409, 'APPROVAL_UNUSED', { approvals: unused.map(publicVan) });
  }
}

function publicDraft(draft) {
  return draft && {
    id: draft.id,
    client_sale_id: draft.client_sale_id,
    pickup_order_id: draft.pickup_order_id,
    amount: draft.amount,
    status: draft.status,
    order_id: draft.order_id,
    terminal_id: draft.terminal_id,
    created_at: draft.created_at,
    approvals: draftApprovals(draft.id).map(publicVan)
  };
}

// 끝난 판매 초안은 상품 목록을 지운다. 판매 내용은 주문에 남는다.
function closeDraft(draftId, status, orderId = null) {
  run(
    `UPDATE pos_sale_drafts
     SET status = @status, order_id = @order_id, request_json = NULL, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND status = 'OPEN'`,
    { id: draftId, status, order_id: orderId }
  );
}

module.exports = { assertDraftPayable, closeDraft, findDraft, publicDraft, requireClientSaleId, requireOpenDraft };
