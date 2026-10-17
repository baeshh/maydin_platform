const crypto = require('crypto');
const { getAll, getOne, run } = require('../../db');
const { decrypt, encrypt } = require('../../services/secure');
const { CLIENT_SALE_ID_PATTERN, recoveryRefOf } = require('../../services/pos-recovery');
const { PosError } = require('../common');

/* ---------- 장애 중 기기 보관 거래 잠금(봉인) ----------
 * 카운터마다 RSA-OAEP 키 쌍을 둔다. 기기는 공개키만 받아 거래마다 새 AES-256-GCM 키로 잠그고, 그 키를 공개키로 감싼다.
 * 개인키는 서버 DB에 암호문(DATA_ENCRYPTION_KEY)으로만 있으므로, 기기 저장소·내보낸 파일을 가져가도 서버 없이는 풀 수 없다.
 * 추가 인증 데이터(AAD)에 약국·거래 고유번호를 묶어 다른 거래로 바꿔 보내면 풀리지 않는다.
 */
const SEAL_FORMAT = 'maydin-offline/1';
const SEAL_ALG = 'RSA-OAEP-256/A256GCM';
const MAX_SEALED_BYTES = 512 * 1024;

const sealAad = (pharmacyId, clientSaleId) => `${SEAL_FORMAT}:${pharmacyId}:${clientSaleId}`;

function publicSealKey(terminal) {
  return { key_id: terminal.seal_key_id, public_key: terminal.seal_public_key, alg: SEAL_ALG, format: SEAL_FORMAT };
}

function ensureSealKey(terminal) {
  if (terminal.seal_key_id && terminal.seal_public_key) return publicSealKey(terminal);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  run(
    `UPDATE pos_terminals SET seal_key_id = @key_id, seal_public_key = @public_key, seal_private_key_enc = @private_key
     WHERE id = @id AND seal_key_id IS NULL`,
    { id: terminal.id, key_id: `k${crypto.randomBytes(8).toString('hex')}`, public_key: publicKey.toString('base64'), private_key: encrypt(privateKey) }
  );
  return publicSealKey(getOne('SELECT seal_key_id, seal_public_key FROM pos_terminals WHERE id = @id', { id: terminal.id }));
}

const sealedInvalid = (message = '잠긴 거래를 열 수 없습니다. 내용이 바뀌었거나 다른 약국·카운터의 거래입니다.') =>
  new PosError(message, 400, 'SEALED_INVALID');

function openSealed(pharmacyId, clientSaleId, sealed) {
  if (!sealed || typeof sealed !== 'object' || sealed.alg !== SEAL_ALG) throw sealedInvalid('잠금 형식이 올바르지 않습니다.');
  const parts = ['wrapped_key', 'iv', 'ciphertext'].map((field) => String(sealed[field] || ''));
  if (parts.some((part) => !part) || parts[2].length > MAX_SEALED_BYTES) throw sealedInvalid('잠금 형식이 올바르지 않습니다.');
  const terminal = getOne('SELECT id, seal_private_key_enc FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND seal_key_id = @key_id', {
    pharmacy_id: pharmacyId,
    key_id: String(sealed.key_id || '')
  });
  if (!terminal) throw sealedInvalid('이 약국 카운터의 키로 잠근 거래가 아닙니다.');
  let payload;
  try {
    const aesKey = crypto.privateDecrypt(
      { key: decrypt(terminal.seal_private_key_enc), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(parts[0], 'base64')
    );
    const data = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(parts[1], 'base64'));
    decipher.setAAD(Buffer.from(sealAad(pharmacyId, clientSaleId)));
    decipher.setAuthTag(data.subarray(data.length - 16));
    payload = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8'));
  } catch {
    throw sealedInvalid();
  }
  if (!payload || payload.client_sale_id !== clientSaleId || Number(payload.pharmacy_id) !== Number(pharmacyId) || !payload.body) throw sealedInvalid();
  return { payload, sealTerminalId: terminal.id };
}

/* ---------- 기기별 미전송 거래 보고 ----------
 * 브라우저마다 설치 번호(install_id)를 두고, 보관 중인 거래의 번호·시각·금액·상태만 보고받는다(상품·결제 내용은 받지 않는다).
 * 서버는 이 보고로 카운터·PC마다 남은 거래를 보여 주고, 마감·재고 대사·PC 교체 때 확인한다.
 */
const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
const MAX_ENTRIES = 500;
const REPORT_RECENT_DAYS = 30;

function parseEntries(raw) {
  if (!Array.isArray(raw)) throw new PosError('보관 거래 목록이 올바르지 않습니다.');
  if (raw.length > MAX_ENTRIES) throw new PosError(`보관 거래가 ${MAX_ENTRIES}건을 넘습니다. 먼저 서버로 보내거나 파일로 내보내 주세요.`);
  return raw.map((entry) => {
    const id = String(entry?.id || '');
    if (!CLIENT_SALE_ID_PATTERN.test(id)) throw new PosError('보관 거래 번호 형식이 올바르지 않습니다.');
    const occurred = new Date(String(entry.occurred_at || ''));
    return {
      id,
      occurred_at: Number.isNaN(occurred.getTime()) ? null : occurred.toISOString(),
      amount: Math.max(0, Math.round(Number(entry.amount) || 0)),
      status: entry.status === 'FAILED' ? 'FAILED' : 'PENDING',
      sealed: entry.sealed === true
    };
  });
}

// 보고한 거래 가운데 서버에 이미 있는 것(전송됨)과 임시번호로 수기 복구한 것.
function entryStates(pharmacyId, entries) {
  if (!entries.length) return new Map();
  const ids = JSON.stringify(entries.map((e) => e.id));
  const saved = new Map(
    getAll('SELECT client_sale_id, order_number FROM orders WHERE pharmacy_id = @pharmacy_id AND client_sale_id IN (SELECT value FROM json_each(@ids))', {
      pharmacy_id: pharmacyId,
      ids
    }).map((row) => [row.client_sale_id, row.order_number])
  );
  const manual = new Map(
    getAll(
      `SELECT recovery_ref, order_number FROM orders
       WHERE pharmacy_id = @pharmacy_id AND recovery_source = 'MANUAL' AND recovery_ref IN (SELECT value FROM json_each(@refs))`,
      { pharmacy_id: pharmacyId, refs: JSON.stringify(entries.map((e) => recoveryRefOf(e.id))) }
    ).map((row) => [row.recovery_ref, row.order_number])
  );
  return new Map(
    entries.map((e) => {
      if (saved.has(e.id)) return [e.id, { state: 'SAVED', order_number: saved.get(e.id) }];
      if (manual.has(recoveryRefOf(e.id))) return [e.id, { state: 'MANUAL', order_number: manual.get(recoveryRefOf(e.id)) }];
      return [e.id, { state: 'MISSING', order_number: null }];
    })
  );
}

function reportDeviceQueue(req, body) {
  const installId = String(body.install_id || '');
  if (!INSTALL_ID.test(installId)) throw new PosError('이 PC의 설치 번호가 올바르지 않습니다.');
  const entries = parseEntries(body.entries);
  const { terminal, device } = req.pos;
  const deviceHash = device === 'REGISTERED' ? terminal.device_key_hash : null;
  const existing = getOne('SELECT * FROM pos_device_queues WHERE pharmacy_id = @pharmacy_id AND install_id = @install_id', {
    pharmacy_id: req.pharmacyId,
    install_id: installId
  });
  // 교체·해제된 PC는 새로 등록되기 전까지 그 카운터 기록으로 남긴다(남은 거래를 유실 목록에서 확인).
  const reRegistered = existing?.retired_at && deviceHash && deviceHash !== existing.device_key_hash;
  const keepRetired = existing?.retired_at && !reRegistered;
  const fields = {
    pharmacy_id: req.pharmacyId,
    install_id: installId,
    terminal_id: keepRetired ? existing.terminal_id : terminal ? terminal.id : existing?.terminal_id ?? null,
    device_key_hash: keepRetired ? existing.device_key_hash : deviceHash,
    storage: ['indexeddb', 'local', 'memory'].includes(body.storage) ? body.storage : null,
    pending_count: entries.filter((e) => e.status === 'PENDING').length,
    failed_count: entries.filter((e) => e.status === 'FAILED').length,
    plain_count: entries.filter((e) => !e.sealed).length,
    total_amount: entries.reduce((sum, e) => sum + e.amount, 0),
    oldest_at: entries.map((e) => e.occurred_at).filter(Boolean).sort()[0] || null,
    entries_json: JSON.stringify(entries),
    user_agent: String(req.get('user-agent') || '').slice(0, 160),
    reported_by: req.user.id
  };
  if (existing) {
    run(
      `UPDATE pos_device_queues
       SET terminal_id = @terminal_id, device_key_hash = @device_key_hash, storage = @storage, pending_count = @pending_count,
           failed_count = @failed_count, plain_count = @plain_count, total_amount = @total_amount, oldest_at = @oldest_at,
           entries_json = @entries_json, user_agent = @user_agent, reported_by = @reported_by, reported_at = CURRENT_TIMESTAMP,
           retired_at = CASE WHEN @reopen = 1 THEN NULL ELSE retired_at END,
           resolved_at = CASE WHEN @reopen = 1 THEN NULL ELSE resolved_at END
       WHERE id = @id`,
      { ...fields, id: existing.id, reopen: reRegistered ? 1 : 0 }
    );
  } else {
    run(
      `INSERT INTO pos_device_queues (pharmacy_id, install_id, terminal_id, device_key_hash, storage, pending_count, failed_count, plain_count,
                                      total_amount, oldest_at, entries_json, user_agent, reported_by)
       VALUES (@pharmacy_id, @install_id, @terminal_id, @device_key_hash, @storage, @pending_count, @failed_count, @plain_count,
               @total_amount, @oldest_at, @entries_json, @user_agent, @reported_by)`,
      fields
    );
  }
  const states = entryStates(req.pharmacyId, entries);
  return {
    saved_ids: entries.filter((e) => states.get(e.id).state === 'SAVED').map((e) => e.id),
    manual: entries.filter((e) => states.get(e.id).state === 'MANUAL').map((e) => ({ id: e.id, order_number: states.get(e.id).order_number })),
    retired: Boolean(keepRetired)
  };
}

function publicDeviceQueue(row, { withEntries = false } = {}) {
  const entries = JSON.parse(row.entries_json || '[]');
  const base = {
    id: row.id,
    install: row.install_id.slice(0, 8).toUpperCase(),
    terminal_id: row.terminal_id,
    terminal_name: row.terminal_name || null,
    current: Boolean(row.device_key_hash && row.device_key_hash === row.current_hash),
    registered: Boolean(row.device_key_hash),
    storage: row.storage,
    pending_count: row.pending_count,
    failed_count: row.failed_count,
    plain_count: row.plain_count,
    unsent_count: row.pending_count + row.failed_count,
    total_amount: row.total_amount,
    oldest_at: row.oldest_at,
    reported_at: row.reported_at,
    reported_by_name: row.reported_by_name || null,
    user_agent: row.user_agent,
    retired_at: row.retired_at,
    retire_note: row.retire_note,
    resolved_at: row.resolved_at,
    resolve_note: row.resolve_note
  };
  if (!withEntries) return base;
  const states = entryStates(row.pharmacy_id, entries);
  const listed = entries.map((e) => ({ ...e, temp_number: recoveryRefOf(e.id).toUpperCase(), ...states.get(e.id) }));
  return { ...base, entries: listed, missing_count: listed.filter((e) => e.state === 'MISSING').length };
}

const QUEUE_SELECT = `
  SELECT q.*, t.terminal_name, t.device_key_hash AS current_hash, u.name AS reported_by_name
  FROM pos_device_queues q
  LEFT JOIN pos_terminals t ON t.id = q.terminal_id
  LEFT JOIN users u ON u.id = q.reported_by`;

// 카운터·PC별 미전송 현황. 교체·해제한 PC는 남아 있던 거래가 서버에 들어왔는지(전송·수기 복구·없음)까지 보여 준다.
function deviceQueueStatus(pharmacyId) {
  const rows = getAll(
    `${QUEUE_SELECT}
     WHERE q.pharmacy_id = @pharmacy_id AND q.resolved_at IS NULL
       AND (q.retired_at IS NOT NULL OR q.pending_count + q.failed_count > 0 OR q.reported_at >= datetime('now', '-${REPORT_RECENT_DAYS} days'))
     ORDER BY q.terminal_id, q.reported_at DESC`,
    { pharmacy_id: pharmacyId }
  );
  const devices = rows.map((row) => publicDeviceQueue(row, { withEntries: Boolean(row.retired_at) || row.pending_count + row.failed_count > 0 }));
  const terminals = getAll(
    "SELECT id, terminal_name, device_key_hash, device_label, last_seen_at FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND status = 'ACTIVE' ORDER BY id",
    { pharmacy_id: pharmacyId }
  ).map((t) => {
    const mine = rows.filter((row) => row.terminal_id === t.id && !row.retired_at);
    const current = t.device_key_hash ? mine.find((row) => row.device_key_hash === t.device_key_hash) : null;
    return {
      terminal_id: t.id,
      terminal_name: t.terminal_name,
      device_label: t.device_label,
      device_registered: Boolean(t.device_key_hash),
      last_seen_at: t.last_seen_at,
      unsent_count: mine.reduce((sum, row) => sum + row.pending_count + row.failed_count, 0),
      plain_count: mine.reduce((sum, row) => sum + row.plain_count, 0),
      reported_at: current?.reported_at || mine[0]?.reported_at || null,
      unreported: Boolean(t.device_key_hash) && !current
    };
  });
  return { terminals, devices };
}

function unsentForTerminal(terminalId) {
  return getAll(`${QUEUE_SELECT} WHERE q.terminal_id = @terminal_id AND q.retired_at IS NULL AND q.pending_count + q.failed_count > 0`, {
    terminal_id: terminalId
  }).map((row) => publicDeviceQueue(row));
}

// 장애 재고 대사 전에 확인할 PC들.
//  pending: 아직 보내지 않은 거래를 가진 PC → 대사 불가
//  unconfirmed: 장애가 끝난 뒤 보고가 없는 PC, 보고한 적 없는 등록 PC, 교체한 PC에서 찾지 못한 거래 → 관리자가 직접 확인했다고 표시해야 대사
function outageDeviceCheck(pharmacyId, outage) {
  const { terminals, devices } = deviceQueueStatus(pharmacyId);
  const live = devices.filter((d) => !d.retired_at);
  const endedAt = outage.ended_at || outage.started_at;
  // 장애 직전까지 쓰던 PC만 본다(카운터 PC는 쓰는 동안 몇 분마다 보고한다). 며칠 안 쓴 노트북 등은 제외.
  const inUseSince = new Date(Date.parse(`${outage.started_at.replace(' ', 'T')}Z`) - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const pending = live.filter((d) => d.unsent_count > 0);
  const unconfirmed = [
    ...live
      .filter((d) => d.terminal_id && d.unsent_count === 0 && d.reported_at >= inUseSince && d.reported_at < endedAt)
      .map((d) => ({ kind: 'STALE', id: d.id, terminal_name: d.terminal_name, install: d.install, reported_at: d.reported_at })),
    ...terminals
      .filter((t) => t.unreported)
      .map((t) => ({ kind: 'UNREPORTED', terminal_id: t.terminal_id, terminal_name: t.terminal_name, device_label: t.device_label, last_seen_at: t.last_seen_at })),
    ...devices
      .filter((d) => d.retired_at && d.missing_count > 0)
      .map((d) => ({ kind: 'LOST', id: d.id, terminal_name: d.terminal_name, install: d.install, missing_count: d.missing_count, retired_at: d.retired_at }))
  ];
  return { pending, unconfirmed };
}

// PC를 교체·해제하기 전에 그 PC가 보낸 마지막 보고를 본다. 남은 거래가 있거나 보고가 없으면 관리자가 유실 가능성을 확인해야 한다.
function retiringDeviceCheck(terminal) {
  if (!terminal.device_key_hash) return { state: 'NONE', devices: [] };
  const devices = getAll(`${QUEUE_SELECT} WHERE q.terminal_id = @terminal_id AND q.device_key_hash = @hash AND q.retired_at IS NULL`, {
    terminal_id: terminal.id,
    hash: terminal.device_key_hash
  }).map((row) => publicDeviceQueue(row));
  if (!devices.length) return { state: 'UNREPORTED', devices };
  return { state: devices.some((d) => d.unsent_count > 0) ? 'PENDING' : 'CLEAR', devices };
}

function retireDeviceQueues(terminal, userId, note) {
  if (!terminal.device_key_hash) return 0;
  return run(
    `UPDATE pos_device_queues SET retired_at = CURRENT_TIMESTAMP, retired_by = @user_id, retire_note = @note
     WHERE terminal_id = @terminal_id AND device_key_hash = @hash AND retired_at IS NULL`,
    { terminal_id: terminal.id, hash: terminal.device_key_hash, user_id: userId, note: note || null }
  ).changes;
}

function resolveDeviceQueue(req, id, note) {
  const row = getOne(`${QUEUE_SELECT} WHERE q.id = @id AND q.pharmacy_id = @pharmacy_id`, { id: Number(id), pharmacy_id: req.pharmacyId });
  if (!row) throw new PosError('PC 기록을 찾을 수 없습니다.', 404);
  if (row.resolved_at) throw new PosError('이미 확인을 마친 PC입니다.', 409);
  const device = publicDeviceQueue(row, { withEntries: true });
  if (!device.retired_at && device.unsent_count > 0) {
    throw new PosError('아직 이 PC에 보내지 않은 거래가 있습니다. 그 PC에서 보내거나 PC를 교체·해제한 뒤 확인해 주세요.', 409);
  }
  if (device.missing_count > 0 && !note) {
    throw new PosError(`서버에 없는 거래가 ${device.missing_count}건 있습니다. 수기로 복구하거나, 실제로 판매하지 않았다면 그 사유를 적어 주세요.`);
  }
  run('UPDATE pos_device_queues SET resolved_at = CURRENT_TIMESTAMP, resolved_by = @user_id, resolve_note = @note WHERE id = @id', {
    id: row.id,
    user_id: req.user.id,
    note: note || null
  });
  return device;
}

module.exports = {
  SEAL_ALG,
  SEAL_FORMAT,
  deviceQueueStatus,
  ensureSealKey,
  openSealed,
  outageDeviceCheck,
  reportDeviceQueue,
  resolveDeviceQueue,
  retireDeviceQueues,
  retiringDeviceCheck,
  sealAad,
  unsentForTerminal
};
