const express = require('express');
const { getAll, getOne, run, transaction } = require('../../db');
const { PosError, audit, cleanText, handle, isOwner, requireOwner, toInt, won } = require('../common');
const { requireOpenDraft } = require('../services/draft-service');
const {
  findByRequest,
  openApprovals,
  parseRequestId,
  publicVan,
  reconcileApproval,
  recordVan,
  requestApproval,
  requireVanAdapter,
  voidApproval
} = require('../services/payment-service');
const { requireOpenSession } = require('../services/session-service');
const { requireTerminal } = require('../services/terminal-service');

const router = express.Router();

/* ---------- 카드·간편결제 승인 (결제 전 판매에 묶음) ---------- */

router.post(
  '/payments/approve',
  handle((req, res) => {
    const { terminal } = requireOpenSession(req);
    const draft = requireOpenDraft(req, terminal, req.body.client_sale_id);
    const { tx, duplicate, bridgeRequest } = requestApproval(req, { terminal, draft, body: req.body });
    if (!duplicate) {
      audit(
        req,
        'POS_VAN_APPROVE',
        'VAN_TRANSACTION',
        tx.id,
        `${tx.payment_method === 'CARD' ? '카드' : '간편결제'} 승인 요청 ${won(tx.amount)} · ${tx.source} · ${tx.status}${tx.is_demo ? ' (데모)' : ''}`
      );
    }
    res.status(duplicate ? 200 : tx.status === 'APPROVED' ? 201 : 202);
    return { van_transaction: publicVan(tx), duplicate: Boolean(duplicate), bridge_request: bridgeRequest };
  })
);

function findApproval(req) {
  const tx = req.body.van_transaction_id
    ? getOne('SELECT * FROM van_transactions WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(req.body.van_transaction_id), pharmacy_id: req.pharmacyId })
    : findByRequest(req.pharmacyId, parseRequestId(req.body.request_id));
  if (!tx || tx.transaction_type !== 'APPROVE') throw new PosError('승인 요청을 찾을 수 없습니다.', 404);
  return tx;
}

// 결과를 모르는 승인을 VAN사·Bridge 조회로 정한다. 절대 다시 승인하지 않는다.
router.post(
  '/payments/reconcile',
  handle((req) => {
    const terminal = requireTerminal(req);
    const before = findApproval(req);
    const { tx, unchanged } = reconcileApproval(req, { terminal, tx: before, body: req.body, owner: isOwner(req) });
    if (!unchanged) {
      audit(
        req,
        req.body.resolution ? 'POS_VAN_RESOLVE' : 'POS_VAN_RECONCILE',
        'VAN_TRANSACTION',
        tx.id,
        `승인 결과 확인 ${won(tx.amount)} · ${before.status} → ${tx.status}${req.body.resolution ? ' (관리자 확인)' : ''}${tx.approval_number && tx.approval_number !== '-' ? ` · 승인번호 ${tx.approval_number}` : ''}`
      );
    }
    return { van_transaction: publicVan(tx), unchanged: Boolean(unchanged) };
  })
);

// 이 카운터에 남은 결과 미확정·미사용 승인. 화면을 다시 열었을 때 이어서 정리한다.
router.get(
  '/payments/pending',
  handle((req) => {
    const terminal = requireTerminal(req);
    return { approvals: openApprovals(terminal.id).map(publicVan) };
  })
);

router.post(
  '/van/transactions/:id/void',
  handle((req) => {
    const terminal = requireTerminal(req);
    const tx = transaction(() => {
      const current = getOne('SELECT * FROM van_transactions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
        id: Number(req.params.id),
        pharmacy_id: req.pharmacyId
      });
      if (!current) throw new PosError('VAN 승인 내역을 찾을 수 없습니다.', 404);
      const voided = voidApproval(req, { terminal, tx: current, body: req.body });
      audit(req, 'POS_VAN_VOID', 'VAN_TRANSACTION', voided.id, `판매 전 승인 취소 ${won(voided.amount)} · ${voided.source || 'SERVER'}`);
      return voided;
    })();
    return { van_transaction: publicVan(tx) };
  })
);

/* ---------- 수동 승인 대조 ---------- */

// 서버가 확인하지 못한 카드·간편결제(승인번호 직접 입력·관리자 확인). 단말기 영수증·VAN 매출 내역과 맞춰 본다.
router.get(
  '/payments/unverified',
  handle((req) => {
    requireOwner(req, '수동 승인 대조');
    const payments = getAll(
      `SELECT p.id, p.order_id, p.payment_method, p.payment_provider, p.paid_amount, p.approval_number, p.card_company,
              p.paid_at, p.pos_session_id, o.order_number, o.order_type, t.terminal_name
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN pos_sessions s ON s.id = p.pos_session_id
       LEFT JOIN pos_terminals t ON t.id = s.terminal_id
       WHERE o.pharmacy_id = @pharmacy_id AND p.verify_status = 'UNVERIFIED'
         AND (@session_id IS NULL OR p.pos_session_id = @session_id)
       ORDER BY p.id ASC
       LIMIT 500`,
      { pharmacy_id: req.pharmacyId, session_id: req.query.session_id ? Number(req.query.session_id) : null }
    );
    return { payments };
  })
);

router.post(
  '/payments/:id/verify',
  handle((req) => {
    requireOwner(req, '수동 승인 대조');
    const result = String(req.body.result || '').toUpperCase();
    if (!['MATCHED', 'MISMATCH'].includes(result)) throw new PosError('대조 결과를 선택해 주세요.');
    const note = cleanText(req.body.note, 200);
    if (result === 'MISMATCH' && !note) throw new PosError('영수증과 다른 내용을 적어 주세요.');
    const payment = getOne(
      `SELECT p.*, o.order_number FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.id = @id AND o.pharmacy_id = @pharmacy_id`,
      { id: Number(req.params.id), pharmacy_id: req.pharmacyId }
    );
    if (!payment) throw new PosError('결제를 찾을 수 없습니다.', 404);
    if (payment.verify_status !== 'UNVERIFIED') throw new PosError('이미 대조한 결제입니다.', 409);
    transaction(() => {
      run(
        `UPDATE payments SET verify_status = @status, verified_by = @user_id, verified_at = CURRENT_TIMESTAMP, verify_note = @note
         WHERE id = @id AND verify_status = 'UNVERIFIED'`,
        { id: payment.id, status: result, user_id: req.user.id, note }
      );
      audit(
        req,
        result === 'MATCHED' ? 'POS_PAYMENT_VERIFY' : 'POS_PAYMENT_MISMATCH',
        'ORDER',
        payment.order_id,
        `${payment.order_number} 승인번호 ${payment.approval_number || '-'} ${won(Math.abs(payment.paid_amount))} · ${result === 'MATCHED' ? '단말기 영수증과 일치' : `불일치: ${note}`}`
      );
    })();
    return { payment: getOne('SELECT id, verify_status, verified_at, verify_note FROM payments WHERE id = @id', { id: payment.id }) };
  })
);

// 마감 때 단말기 영수증 묶음과 한 번에 맞춰 본 결제들. 다른 결과는 한 건씩 적는다.
router.post(
  '/payments/verify-matched',
  handle((req) => {
    requireOwner(req, '수동 승인 대조');
    const ids = [...new Set((Array.isArray(req.body.payment_ids) ? req.body.payment_ids : []).map(Number).filter(Number.isInteger))];
    if (!ids.length || ids.length > 500) throw new PosError('대조한 결제를 선택해 주세요.');
    const verified = transaction(() => {
      let count = 0;
      for (const id of ids) {
        const payment = getOne(
          `SELECT p.id, p.order_id, p.verify_status FROM payments p JOIN orders o ON o.id = p.order_id
           WHERE p.id = @id AND o.pharmacy_id = @pharmacy_id`,
          { id, pharmacy_id: req.pharmacyId }
        );
        if (!payment) throw new PosError('결제를 찾을 수 없습니다.', 404);
        if (payment.verify_status !== 'UNVERIFIED') continue;
        run(
          `UPDATE payments SET verify_status = 'MATCHED', verified_by = @user_id, verified_at = CURRENT_TIMESTAMP
           WHERE id = @id AND verify_status = 'UNVERIFIED'`,
          { id, user_id: req.user.id }
        );
        count += 1;
      }
      if (count) audit(req, 'POS_PAYMENT_VERIFY', 'PAYMENT', null, `수동 승인 ${count}건 단말기 영수증과 일치 확인`);
      return count;
    })();
    return { verified };
  })
);

/* ---------- 현금영수증 (데모) ---------- */

router.post(
  '/van/cash-receipt',
  handle((req, res) => {
    const { terminal, adapter } = requireVanAdapter(req);
    const amount = toInt(req.body.amount, '현금영수증 금액', { min: 1, max: 100000000 });
    const purpose = req.body.purpose === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
    const result = adapter.issueCashReceipt({ identity: req.body.identity, purpose });
    const tx = recordVan(req, terminal, {
      transaction_type: 'CASH_RECEIPT',
      payment_method: 'CASH',
      amount,
      approval_number: result.approvalNumber,
      masked_identity: result.maskedIdentity,
      status: 'APPROVED',
      message: result.message
    });
    res.status(201);
    return { van_transaction: { ...publicVan(tx), masked_identity: tx.masked_identity } };
  })
);

module.exports = router;
