const express = require('express');
const { getOne, run, transaction } = require('../../db');
const { PosError, audit, cleanText, handle, requireOwner, toInt, won } = require('../common');
const { unsentForTerminal } = require('../services/offline-service');
const { openApprovals, publicVan } = require('../services/payment-service');
const { findOpenSession, requireOpenSession, sessionSummary, withSummary } = require('../services/session-service');
const { publicTerminal, requireTerminal } = require('../services/terminal-service');

const router = express.Router();

router.get(
  '/sessions/current',
  handle((req) => {
    const terminal = requireTerminal(req);
    return { terminal: publicTerminal(terminal), session: withSummary(findOpenSession(terminal.id)) };
  })
);

router.post(
  '/sessions/open',
  handle((req, res) => {
    const openingCash = toInt(req.body.opening_cash ?? 0, '시작 시재');
    const terminal = requireTerminal(req);
    if (findOpenSession(terminal.id)) throw new PosError('이미 영업 중인 카운터입니다.', 409);

    const session = transaction(() => {
      let result;
      try {
        result = run(
          `INSERT INTO pos_sessions (pharmacy_id, terminal_id, business_date, opening_cash, opened_by)
           VALUES (@pharmacy_id, @terminal_id, date('now', 'localtime'), @opening_cash, @user_id)`,
          { pharmacy_id: req.pharmacyId, terminal_id: terminal.id, opening_cash: openingCash, user_id: req.user.id }
        );
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new PosError('이미 영업 중인 카운터입니다.', 409);
        throw error;
      }
      audit(req, 'POS_SESSION_OPEN', 'POS_SESSION', result.lastInsertRowid, `영업 시작 · ${terminal.terminal_name} · 시작 시재 ${won(openingCash)}`);
      return getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: result.lastInsertRowid });
    })();

    res.status(201);
    return { session: withSummary(session) };
  })
);

router.post(
  '/sessions/:id/cash-movements',
  handle((req, res) => {
    requireOwner(req, '현금 입출금');
    const { session } = requireOpenSession(req);
    if (session.id !== Number(req.params.id)) throw new PosError('현재 영업 중인 세션이 아닙니다.', 409);

    const movementType = String(req.body.movement_type || '').toUpperCase();
    if (!['DEPOSIT', 'WITHDRAW'].includes(movementType)) throw new PosError('입금/출금 구분을 선택해 주세요.');
    const amount = toInt(req.body.amount, '금액', { min: 1 });
    const reason = cleanText(req.body.reason);
    if (!reason) throw new PosError('입출금 사유를 입력해 주세요.');

    if (movementType === 'WITHDRAW') {
      const available = sessionSummary(session).expected_cash;
      if (amount > available) throw new PosError(`현재 예상 시재(${won(available)})보다 많이 출금할 수 없습니다.`);
    }

    transaction(() => {
      const result = run(
        `INSERT INTO cash_movements (pharmacy_id, session_id, movement_type, amount, reason, created_by)
         VALUES (@pharmacy_id, @session_id, @movement_type, @amount, @reason, @user_id)`,
        {
          pharmacy_id: req.pharmacyId,
          session_id: session.id,
          movement_type: movementType,
          amount,
          reason,
          user_id: req.user.id
        }
      );
      audit(
        req,
        'POS_CASH_MOVEMENT',
        'CASH_MOVEMENT',
        result.lastInsertRowid,
        `${movementType === 'DEPOSIT' ? '현금 입금' : '현금 출금'} ${won(amount)} · ${reason}`
      );
    })();

    res.status(201);
    return { session: withSummary(getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: session.id })) };
  })
);

router.post(
  '/sessions/:id/close',
  handle((req) => {
    requireOwner(req, '일마감');
    const session = getOne('SELECT * FROM pos_sessions WHERE id = @id AND pharmacy_id = @pharmacy_id', {
      id: Number(req.params.id),
      pharmacy_id: req.pharmacyId
    });
    if (!session) throw new PosError('영업 세션을 찾을 수 없습니다.', 404);
    if (session.status !== 'OPEN') throw new PosError('이미 마감된 영업입니다.', 409);
    // 시재는 그 카운터 금고에서 세므로 마감도 그 카운터 PC에서만 한다. PC가 고장 났으면 다른 PC를 그 카운터로 교체 등록한다.
    if (requireTerminal(req).id !== session.terminal_id) {
      throw new PosError('다른 카운터의 영업입니다. 마감은 그 카운터 PC에서 해 주세요.', 403);
    }
    // 돈이 빠져나갔을 수 있는 승인(결과 모름·판매에 안 씀)이 남아 있으면 마감하지 않는다.
    const approvals = openApprovals(session.terminal_id);
    if (approvals.length) {
      throw new PosError(`정리되지 않은 카드 승인이 ${approvals.length}건 있습니다. 승인 결과를 확인하거나 취소한 뒤 마감해 주세요.`, 409, 'VAN_APPROVALS_OPEN', {
        approvals: approvals.map(publicVan)
      });
    }
    // 장애 중 판매가 PC에 남아 있으면 그 매출·현금이 이 영업에 아직 안 들어왔다.
    const unsent = unsentForTerminal(session.terminal_id);
    if (unsent.length) {
      const count = unsent.reduce((sum, d) => sum + d.unsent_count, 0);
      throw new PosError(`이 카운터 PC에 서버로 보내지 않은 장애 중 거래가 ${count}건 있습니다. 「장애 · 복구」에서 보낸 뒤 마감해 주세요.`, 409, 'OFFLINE_QUEUE_PENDING', {
        devices: unsent
      });
    }
    const unverified = getOne("SELECT COUNT(*) AS count FROM payments WHERE pos_session_id = @id AND verify_status = 'UNVERIFIED'", { id: session.id }).count;
    if (unverified > 0) {
      throw new PosError(`단말기 영수증과 대조하지 않은 수동 승인이 ${unverified}건 있습니다. 대조한 뒤 마감해 주세요.`, 409, 'MANUAL_APPROVALS_UNCHECKED', {
        unverified_count: unverified
      });
    }

    const actualCash = toInt(req.body.actual_cash, '실제 현금');
    const note = cleanText(req.body.note, 500);

    const closed = transaction(() => {
      const summary = sessionSummary(session);
      const difference = actualCash - summary.expected_cash;
      if (difference !== 0 && !note) {
        throw new PosError(`시재 차액 ${won(difference)}이(가) 있습니다. 차액 사유를 입력해 주세요.`);
      }
      const result = run(
        `UPDATE pos_sessions
         SET status = 'CLOSED', expected_cash = @expected_cash, actual_cash = @actual_cash,
             cash_difference = @difference, summary_json = @summary_json, close_note = @note,
             closed_by = @user_id, closed_at = CURRENT_TIMESTAMP
         WHERE id = @id AND status = 'OPEN'`,
        {
          id: session.id,
          expected_cash: summary.expected_cash,
          actual_cash: actualCash,
          difference,
          summary_json: JSON.stringify(summary),
          note,
          user_id: req.user.id
        }
      );
      if (result.changes === 0) throw new PosError('이미 마감된 영업입니다.', 409);
      audit(
        req,
        'POS_SESSION_CLOSE',
        'POS_SESSION',
        session.id,
        `일마감 · 순매출 ${won(summary.net_sales)} · 예상 시재 ${won(summary.expected_cash)} · 실제 ${won(actualCash)} · 차액 ${won(difference)}${note ? ` · ${note}` : ''}`
      );
      return getOne('SELECT * FROM pos_sessions WHERE id = @id', { id: session.id });
    })();

    return { session: { ...closed, summary: JSON.parse(closed.summary_json) } };
  })
);

module.exports = router;
