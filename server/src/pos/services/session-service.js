const { getAll, getOne } = require('../../db');
const { PosError } = require('../common');
const { requireTerminal } = require('./terminal-service');

function findOpenSession(terminalId) {
  return getOne("SELECT * FROM pos_sessions WHERE terminal_id = @terminal_id AND status = 'OPEN'", {
    terminal_id: terminalId
  });
}

function requireOpenSession(req) {
  const terminal = requireTerminal(req);
  const session = findOpenSession(terminal.id);
  if (!session) throw new PosError('영업이 시작되지 않았습니다. 시재를 입력하고 영업을 시작해 주세요.', 409);
  return { terminal, session };
}

function sessionSummary(session) {
  const payments = getAll(
    `SELECT payment_method,
      COUNT(CASE WHEN paid_amount > 0 THEN 1 END) AS pay_count,
      COALESCE(SUM(CASE WHEN paid_amount > 0 THEN paid_amount ELSE 0 END), 0) AS paid_amount,
      COALESCE(SUM(CASE WHEN paid_amount < 0 THEN paid_amount ELSE 0 END), 0) AS refunded_amount,
      COALESCE(SUM(paid_amount), 0) AS net_amount
     FROM payments
     WHERE pos_session_id = @id
     GROUP BY payment_method
     ORDER BY payment_method`,
    { id: session.id }
  );

  const sales = getOne(
    `SELECT
      COUNT(CASE WHEN order_type = 'POS_SALE' THEN 1 END) AS sale_count,
      COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN final_amount ELSE 0 END), 0) AS gross_sales,
      COALESCE(SUM(CASE WHEN order_type = 'POS_SALE' THEN discount_amount ELSE 0 END), 0) AS discount_total,
      COUNT(CASE WHEN order_type = 'POS_REFUND' THEN 1 END) AS refund_count,
      COALESCE(SUM(CASE WHEN order_type = 'POS_REFUND' THEN final_amount ELSE 0 END), 0) AS refund_total,
      COUNT(CASE WHEN order_type = 'PICKUP' THEN 1 END) AS pickup_paid_count
     FROM orders
     WHERE pos_session_id = @id`,
    { id: session.id }
  );

  const movements = getAll(
    `SELECT m.*, u.name AS created_by_name
     FROM cash_movements m
     LEFT JOIN users u ON u.id = m.created_by
     WHERE m.session_id = @id
     ORDER BY m.id ASC`,
    { id: session.id }
  );
  const deposits = movements.filter((m) => m.movement_type === 'DEPOSIT').reduce((sum, m) => sum + m.amount, 0);
  const withdrawals = movements.filter((m) => m.movement_type === 'WITHDRAW').reduce((sum, m) => sum + m.amount, 0);
  const cashNet = payments.find((p) => p.payment_method === 'CASH')?.net_amount || 0;
  const unverified = getOne("SELECT COUNT(*) AS count FROM payments WHERE pos_session_id = @id AND verify_status = 'UNVERIFIED'", {
    id: session.id
  }).count;

  return {
    payments,
    unverified_count: unverified,
    ...sales,
    net_sales: sales.gross_sales + sales.refund_total,
    cash_net: cashNet,
    deposits,
    withdrawals,
    movements,
    expected_cash: session.opening_cash + cashNet + deposits - withdrawals
  };
}

function withSummary(session) {
  if (!session) return null;
  const opener = getOne('SELECT name FROM users WHERE id = @id', { id: session.opened_by });
  return { ...session, opened_by_name: opener?.name || null, summary: sessionSummary(session) };
}

module.exports = {
  findOpenSession,
  requireOpenSession,
  sessionSummary,
  withSummary
};
