const { getOne, run } = require('../db');
const { CustomerError } = require('../services/customers');
const { LotError } = require('../services/lots');
const { PointError } = require('../services/points');
const { RecoveryError } = require('../services/pos-recovery');
const { ImportError, syncStatus } = require('../services/product-import');
const { VanError } = require('./integrations/van-adapter');

const PAYMENT_METHODS = {
  CARD: '카드',
  CASH: '현금',
  TRANSFER: '계좌이체',
  EASY_PAY: '간편결제',
  POINT: '포인트'
};

const PICKUP_DONE_STATUSES = ['PICKED_UP', 'COMPLETED', 'CANCELED', 'REFUNDED'];

// 카운터에서 건넬 수 있는 픽업 주문. 결제 대기 주문은 카운터에서 결제한 뒤 건넨다.
const PICKUP_HANDOVER_STATUSES = ['PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'PREPARING', 'READY_FOR_PICKUP'];

const COUNSEL_OPEN_STATUSES = ['RESERVED', 'CONFIRMED'];

const PHONE_DIGITS_SQL = (column) => `REPLACE(REPLACE(REPLACE(COALESCE(${column}, ''), '-', ''), ' ', ''), '.', '')`;

class PosError extends Error {
  constructor(message, status = 400, reason = null, extra = null) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (
        error instanceof PosError ||
        error instanceof VanError ||
        error instanceof PointError ||
        error instanceof LotError ||
        error instanceof CustomerError ||
        error instanceof ImportError ||
        error instanceof RecoveryError
      ) {
        const body = { message: error.message };
        if (error.reason) body.reason = error.reason;
        if (error.extra) Object.assign(body, error.extra);
        return res.status(error.status).json(body);
      }
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(400).json({ message: error.message });
      }
      console.error(error);
      return res.status(500).json({ message: 'POS 처리 중 오류가 발생했습니다.' });
    }
  };
}

function won(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function cleanText(value, maxLength = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function toInt(value, label, { min = 0, max = 100000000 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PosError(`${label}이(가) 올바르지 않습니다.`);
  }
  return number;
}

function stockSyncSummary(pharmacyId) {
  const sync = syncStatus(pharmacyId);
  return { stock_master: sync.stock_master, stale: sync.stale, online_paused: sync.online_paused, last_sync_at: sync.last_sync_at };
}

function isOwner(req) {
  return req.user.role === 'PHARMACY_OWNER';
}

function requireOwner(req, action) {
  if (!isOwner(req)) throw new PosError(`${action}은(는) 약국 관리자만 처리할 수 있습니다.`, 403);
}

function localToday() {
  return getOne("SELECT date('now', 'localtime') AS today").today;
}

function assertDate(value, fallback) {
  const date = String(value || '').trim() || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PosError('날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)');
  return date;
}

function audit(req, action, targetType, targetId, description) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
     VALUES (@user_id, @pharmacy_id, @action, @target_type, @target_id, @description)`,
    {
      user_id: req.user.id,
      pharmacy_id: req.pharmacyId,
      action,
      target_type: targetType,
      target_id: targetId,
      description
    }
  );
}

function nextOrderNumber(prefix, pharmacyId) {
  const ymd = getOne("SELECT substr(strftime('%Y%m%d', 'now', 'localtime'), 3) AS ymd").ymd;
  const base = `${prefix}${pharmacyId}-${ymd}-`;
  const last = getOne(
    'SELECT order_number FROM orders WHERE order_number LIKE @pattern ORDER BY order_number DESC LIMIT 1',
    { pattern: `${base}%` }
  );
  const seq = last ? Number(last.order_number.slice(base.length)) + 1 : 1;
  return `${base}${String(seq).padStart(4, '0')}`;
}

function parseMemberCode(code) {
  const match = String(code || '').trim().match(/^(?:MAYDIN-MEMBER:)?(MD\d{10})$/i);
  return match ? match[1].toUpperCase() : null;
}

module.exports = {
  PAYMENT_METHODS,
  PICKUP_DONE_STATUSES,
  PICKUP_HANDOVER_STATUSES,
  COUNSEL_OPEN_STATUSES,
  PHONE_DIGITS_SQL,
  PosError,
  handle,
  won,
  digits,
  cleanText,
  toInt,
  stockSyncSummary,
  isOwner,
  requireOwner,
  localToday,
  assertDate,
  audit,
  nextOrderNumber,
  parseMemberCode
};
