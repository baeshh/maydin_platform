const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getAll, getOne, run, transaction, dbPath } = require('../db');
const { CustomerError, CONSENT_TYPES, currentConsents, recordConsents, retentionSettings } = require('./customers');
const { decrypt } = require('./secure');
const { recordHistory } = require('./order-flow');

// 건강 정보·상담 내용은 약사(약국 대표 계정)만, 아래 목적 중 하나를 고른 뒤에만 볼 수 있다.
const ACCESS_PURPOSES = {
  COUNSEL: '복약상담',
  SALE_CHECK: '판매 전 함께 먹으면 안 되는 약 확인',
  CUSTOMER_REQUEST: '고객 요청에 따른 확인·정정'
};

// 고객 화면 '내 건강 정보 이용 기록'에 보여 줄 기록.
const ACCESS_ACTIONS = {
  HEALTH_VIEW: '약사 열람',
  HEALTH_UPDATE: '약사 수정',
  COUNSEL_NOTE_VIEW: '상담 내용 열람',
  HEALTH_EXPIRED: '보유기간 만료 삭제',
  HEALTH_CONSENT_WITHDRAWN: '동의 철회로 삭제'
};

const ERASED_NAME = '탈퇴회원';
const REJECTED_NAME = '가입거절(파기)';
const ERASED_TEXT = '(파기)';

// 진행 중인 온라인 주문이 있으면 배송·수령에 연락처가 필요하므로 탈퇴를 미룬다.
const OPEN_ONLINE_STATUSES = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'PREPARING', 'SHIPPING', 'READY_FOR_PICKUP'];
const OPEN_COUNSEL_STATUSES = ['RESERVED', 'CONFIRMED'];

function parsePurpose(value) {
  const purpose = String(value || '').trim().toUpperCase();
  if (!ACCESS_PURPOSES[purpose]) throw new CustomerError('열람 목적을 선택해 주세요.');
  return purpose;
}

function logAccess({ userId = null, pharmacyId, customerId, action, purpose = null, description }) {
  run(
    `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description, purpose)
     VALUES (@user_id, @pharmacy_id, @action, 'CUSTOMER', @target_id, @description, @purpose)`,
    { user_id: userId, pharmacy_id: pharmacyId, action, target_id: customerId, description, purpose }
  );
}

function accessLog(customerId, limit = 50) {
  const actions = Object.keys(ACCESS_ACTIONS);
  return getAll(
    `SELECT l.id, l.action, l.purpose, l.created_at, u.role AS user_role
     FROM admin_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.target_type = 'CUSTOMER' AND l.target_id = @id AND l.action IN (${actions.map((a) => `'${a}'`).join(',')})
     ORDER BY l.id DESC LIMIT @limit`,
    { id: customerId, limit }
  ).map((row) => ({
    id: row.id,
    created_at: row.created_at,
    action: row.action,
    action_label: ACCESS_ACTIONS[row.action],
    purpose: row.purpose,
    purpose_label: ACCESS_PURPOSES[row.purpose] || null,
    by: row.user_role === 'PHARMACY_OWNER' ? '약사' : row.user_role === 'CUSTOMER' ? '본인' : '시스템'
  }));
}

/* ---------- 복약상담 내용 ---------- */

function counselNote(order) {
  if (!order || !order.counsel_note) return null;
  return decrypt(order.counsel_note);
}

// 고객에게 주는 주문 목록에서는 복호화한 본인 상담 내용을, 약국 목록에서는 '있음' 표시만 준다.
function stripCounselNote(order, { reveal = false } = {}) {
  if (!order) return order;
  const { counsel_note: note, ...rest } = order;
  rest.has_counsel_note = Boolean(note);
  if (reveal && note) rest.counsel_note = decrypt(note);
  return rest;
}

function deleteCounselNote(orderId) {
  return run(
    'UPDATE orders SET counsel_note = NULL, counsel_note_purged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND counsel_note IS NOT NULL',
    { id: orderId }
  ).changes;
}

/* ---------- 파기 장부 ---------- */

// 백업에서 복원하면 이미 지운 개인정보가 되살아난다. 파기한 회원 번호를 DB 밖에 따로 적어 두고,
// 복원 뒤 보유기간 작업이 돌 때 다시 지운다. 장부에는 회원 번호와 시각만 남긴다.
function erasureLedgerPath() {
  return process.env.PRIVACY_ERASURE_LEDGER || path.join(path.dirname(dbPath), 'privacy-erasures.jsonl');
}

function appendErasure(customerId, kind) {
  const file = erasureLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ customer_id: customerId, kind, erased_at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

function readErasures() {
  const file = erasureLedgerPath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && Number.isInteger(row.customer_id));
}

/* ---------- 회원 정보 파기 ---------- */

// 거래 기록(주문·결제·포인트 내역)은 법정 보존기간 동안 남기고, 사람을 알아볼 수 있는 정보만 지운다.
// 주문에 적힌 연락처·배송지는 보존기간이 끝날 때 runRetention이 지운다.
function erasePersonal(customer, { kind, userId = null }) {
  const placeholderEmail = `erased-${customer.user_id}@erased.local`;
  const name = kind === 'REJECTED' ? REJECTED_NAME : ERASED_NAME;
  const randomPassword = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 4);

  if (customer.point_balance > 0) {
    run(
      `INSERT INTO point_ledger (pharmacy_id, customer_id, entry_type, points, balance_after, reason, created_by)
       VALUES (@pharmacy_id, @customer_id, 'ADJUST', @points, 0, @reason, @user_id)`,
      {
        pharmacy_id: customer.pharmacy_id,
        customer_id: customer.id,
        points: -customer.point_balance,
        reason: kind === 'WITHDRAWN' ? '회원 탈퇴로 소멸' : '개인정보 파기로 소멸',
        user_id: userId
      }
    );
  }

  run(
    `UPDATE users SET email = @email, name = @name, phone = NULL, password_hash = @password,
       status = @status, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id: customer.user_id, email: placeholderEmail, name, password: randomPassword, status: kind }
  );
  run(
    `UPDATE customers SET name = @name, phone = NULL, email = @email,
       birth_year = NULL, birth_month = NULL, birth_day = NULL, gender = NULL,
       health_info = NULL, health_updated_at = NULL, health_updated_by = NULL,
       pin_hash = NULL, pin_failed_count = 0, pin_locked_until = NULL,
       marketing_agree = 0, signup_ip_hash = NULL, approval_note = NULL,
       default_address_id = NULL, point_balance = 0,
       personal_purged_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id: customer.id, name, email: placeholderEmail }
  );
  run('DELETE FROM addresses WHERE user_id = @user_id', { user_id: customer.user_id });
  run('DELETE FROM carts WHERE user_id = @user_id', { user_id: customer.user_id });
  run('DELETE FROM family_members WHERE head_customer_id = @id OR linked_customer_id = @id', { id: customer.id });
  run('DELETE FROM restock_alerts WHERE customer_id = @id', { id: customer.id });
  run('UPDATE product_requests SET customer_id = NULL WHERE customer_id = @id', { id: customer.id });
  run("UPDATE verification_codes SET status = 'REVOKED' WHERE customer_id = @id AND status = 'ACTIVE'", { id: customer.id });
  run(
    `UPDATE orders SET counsel_note = NULL, counsel_note_purged_at = CURRENT_TIMESTAMP
     WHERE customer_id = @id AND counsel_note IS NOT NULL`,
    { id: customer.id }
  );
}

function openOnlineOrders(customerId) {
  return getAll(
    `SELECT order_number, order_status FROM orders
     WHERE customer_id = @id AND order_type IN ('DELIVERY', 'PICKUP')
       AND order_status IN (${OPEN_ONLINE_STATUSES.map((s) => `'${s}'`).join(',')})`,
    { id: customerId }
  );
}

// source: APP(본인) · PARTNER(약국이 본인 요청을 확인하고 대신 처리)
function withdrawCustomer({ customerId, pharmacyId, source, userId = null, reason = null }) {
  const customer = getOne('SELECT * FROM customers WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: customerId,
    pharmacy_id: pharmacyId
  });
  if (!customer) throw new CustomerError('회원을 찾을 수 없습니다.', 404);
  if (customer.withdrawn_at || customer.approval_status === 'WITHDRAWN') throw new CustomerError('이미 탈퇴한 회원입니다.', 409);
  const open = openOnlineOrders(customer.id);
  if (open.length) {
    throw new CustomerError(
      `진행 중인 주문(${open.map((o) => o.order_number).join(', ')})이 있어요. 수령하거나 취소한 뒤 탈퇴할 수 있어요.`,
      409
    );
  }

  transaction(() => {
    const counsels = getAll(
      `SELECT * FROM orders WHERE customer_id = @id AND order_type = 'COUNSEL'
         AND order_status IN (${OPEN_COUNSEL_STATUSES.map((s) => `'${s}'`).join(',')})`,
      { id: customer.id }
    );
    for (const order of counsels) {
      run("UPDATE orders SET order_status = 'CANCELED', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = @id", {
        id: order.id
      });
      recordHistory({
        order,
        action: 'CANCEL',
        from: order.order_status,
        to: 'CANCELED',
        reason: '회원 탈퇴',
        actorType: source === 'APP' ? 'CUSTOMER' : 'STAFF',
        userId
      });
    }

    const agreed = currentConsents(customer.id);
    const changes = {};
    for (const type of Object.keys(CONSENT_TYPES)) if (agreed[type] && agreed[type].agreed) changes[type] = false;
    if (Object.keys(changes).length) {
      recordConsents({ pharmacyId: customer.pharmacy_id, customerId: customer.id, changes, source, userId });
    }

    erasePersonal(customer, { kind: 'WITHDRAWN', userId });
    run(
      `UPDATE customers SET approval_status = 'WITHDRAWN', withdrawn_at = CURRENT_TIMESTAMP, withdrawal_source = @source
       WHERE id = @id`,
      { id: customer.id, source }
    );
    run(
      `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
       VALUES (@user_id, @pharmacy_id, 'CUSTOMER_WITHDRAW', 'CUSTOMER', @id, @description)`,
      {
        user_id: userId,
        pharmacy_id: customer.pharmacy_id,
        id: customer.id,
        description: `회원 탈퇴 ${customer.member_code || `#${customer.id}`} (${source === 'APP' ? '본인' : '약국 대리'})${reason ? ` · ${reason}` : ''}`
      }
    );
  })();
  appendErasure(customer.id, 'WITHDRAWN');
  return { withdrawn: true };
}

/* ---------- 보유기간 파기 ---------- */

function sqlTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// 매일 한 번 돈다. now는 테스트에서 시간을 앞당길 때만 넘긴다.
function runRetention({ now = new Date() } = {}) {
  const settings = retentionSettings();
  const at = sqlTime(now);
  const result = { health: 0, counsel_notes: 0, rejected: 0, order_contacts: 0, reapplied: 0 };
  const rejectedIds = [];

  transaction(() => {
    const expiredHealth = getAll(
      `SELECT id, pharmacy_id FROM customers
       WHERE health_info IS NOT NULL AND health_updated_at <= datetime(@at, @span)`,
      { at, span: `-${settings.health_months} months` }
    );
    for (const row of expiredHealth) {
      run('UPDATE customers SET health_info = NULL, health_updated_at = @at, health_updated_by = NULL WHERE id = @id', { id: row.id, at });
      logAccess({
        pharmacyId: row.pharmacy_id,
        customerId: row.id,
        action: 'HEALTH_EXPIRED',
        description: `건강 정보 보유기간(${settings.health_months}개월) 만료 삭제`
      });
    }
    result.health = expiredHealth.length;

    result.counsel_notes = run(
      `UPDATE orders SET counsel_note = NULL, counsel_note_purged_at = @at
       WHERE order_type = 'COUNSEL' AND counsel_note IS NOT NULL
         AND COALESCE(updated_at, created_at) <= datetime(@at, @span)`,
      { at, span: `-${settings.counsel_days} days` }
    ).changes;

    const rejected = getAll(
      `SELECT * FROM customers
       WHERE approval_status = 'REJECTED' AND personal_purged_at IS NULL
         AND COALESCE(approved_at, created_at) <= datetime(@at, @span)`,
      { at, span: `-${settings.rejected_days} days` }
    );
    for (const customer of rejected) {
      erasePersonal(customer, { kind: 'REJECTED' });
      rejectedIds.push(customer.id);
    }
    result.rejected = rejected.length;

    // 탈퇴·거절 회원의 거래 기록은 보존기간이 지나면 연락처·배송지까지 지운다. 금액·품목은 매출 통계로 남는다.
    const span = `-${settings.transaction_years} years`;
    const orderScope = `customer_id IN (SELECT id FROM customers WHERE personal_purged_at IS NOT NULL)
                        AND created_at <= datetime(@at, @span)`;
    run(
      `UPDATE deliveries SET receiver_name = '${ERASED_TEXT}', receiver_phone = '', zip_code = NULL,
         address = '${ERASED_TEXT}', address_detail = NULL
       WHERE receiver_name != '${ERASED_TEXT}' AND order_id IN (SELECT id FROM orders WHERE ${orderScope})`,
      { at, span }
    );
    result.order_contacts = run(
      `UPDATE orders SET contact_name = NULL, contact_phone = NULL, memo = NULL
       WHERE (contact_name IS NOT NULL OR contact_phone IS NOT NULL OR memo IS NOT NULL) AND ${orderScope}`,
      { at, span }
    ).changes;

    const erased = new Set(readErasures().map((row) => row.customer_id));
    for (const id of erased) {
      const customer = getOne('SELECT * FROM customers WHERE id = @id AND personal_purged_at IS NULL', { id });
      if (!customer) continue;
      erasePersonal(customer, { kind: customer.approval_status === 'REJECTED' ? 'REJECTED' : 'WITHDRAWN' });
      if (customer.approval_status !== 'REJECTED') {
        run("UPDATE customers SET approval_status = 'WITHDRAWN', withdrawn_at = COALESCE(withdrawn_at, @at) WHERE id = @id", { id, at });
      }
      result.reapplied += 1;
    }

    const total = Object.values(result).reduce((sum, n) => sum + n, 0);
    if (total > 0) {
      run(
        `INSERT INTO admin_logs (action, target_type, description)
         VALUES ('PRIVACY_RETENTION', 'SYSTEM', @description)`,
        {
          description: `보유기간 파기: 건강 정보 ${result.health}명 · 상담 내용 ${result.counsel_notes}건 · 거절 가입 ${result.rejected}명 · 주문 연락처 ${result.order_contacts}건 · 복원 후 재파기 ${result.reapplied}명`
        }
      );
    }
  })();

  for (const id of rejectedIds) appendErasure(id, 'REJECTED');
  return result;
}

function startRetentionSchedule(logger = console) {
  const hours = Number(process.env.RETENTION_INTERVAL_HOURS ?? (process.env.NODE_ENV === 'test' ? 0 : 24));
  if (!hours) return null;
  const tick = () => {
    try {
      const result = runRetention();
      if (Object.values(result).some(Boolean)) logger.log('[privacy] 보유기간 파기', result);
    } catch (error) {
      logger.error('[privacy] 보유기간 파기 실패', error);
    }
  };
  // 백업 복원은 서버를 멈춘 뒤에만 하므로, 켜질 때 바로 한 번 돌려 되살아난 파기 대상을 다시 지운다.
  tick();
  const timer = setInterval(tick, hours * 3600 * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = {
  ACCESS_PURPOSES,
  ACCESS_ACTIONS,
  ERASED_NAME,
  parsePurpose,
  logAccess,
  accessLog,
  counselNote,
  stripCounselNote,
  deleteCounselNote,
  erasureLedgerPath,
  withdrawCustomer,
  runRetention,
  startRetentionSchedule
};
