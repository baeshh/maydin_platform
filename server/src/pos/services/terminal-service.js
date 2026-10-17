const crypto = require('crypto');
const { getAll, getOne, run } = require('../../db');
const { encrypt } = require('../../services/secure');
const { PosError } = require('../common');
const { newBridgeKey } = require('../integrations/bridge-protocol');
const { adapterFor } = require('../integrations');

const DEVICE_HEADER = 'X-POS-Device';

const DEVICE_STATES = {
  REGISTERED: '등록된 카운터 PC',
  LEGACY: '카운터 등록 전 (단일 카운터)',
  UNREGISTERED: '등록되지 않은 PC',
  UNKNOWN: '해제됐거나 다른 약국의 PC',
  DISABLED: '사용 중지된 카운터'
};

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function ensureTerminal(pharmacyId) {
  const terminal = getOne(
    "SELECT * FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1",
    { pharmacy_id: pharmacyId }
  );
  if (terminal) return terminal;
  const result = run("INSERT INTO pos_terminals (pharmacy_id, terminal_name) VALUES (@pharmacy_id, '카운터 1')", {
    pharmacy_id: pharmacyId
  });
  return getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: result.lastInsertRowid });
}

function hasRegisteredDevice(pharmacyId) {
  return Boolean(
    getOne('SELECT 1 AS found FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND device_key_hash IS NOT NULL LIMIT 1', {
      pharmacy_id: pharmacyId
    })
  );
}

function touchTerminal(terminalId) {
  run(
    `UPDATE pos_terminals SET last_seen_at = CURRENT_TIMESTAMP
     WHERE id = @id AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 seconds'))`,
    { id: terminalId }
  );
}

// 요청한 PC가 어느 카운터인지 정한다.
// 약국이 PC를 하나도 등록하지 않았으면 예전처럼 첫 카운터 하나를 함께 쓴다(도입 전 호환).
// PC를 한 대라도 등록한 뒤에는 기기 토큰이 맞는 PC만 카운터로 인정한다.
function resolveTerminal(req) {
  const token = req.get(DEVICE_HEADER);
  if (token) {
    const terminal = getOne('SELECT * FROM pos_terminals WHERE device_key_hash = @hash AND pharmacy_id = @pharmacy_id', {
      hash: hashDeviceToken(token),
      pharmacy_id: req.pharmacyId
    });
    if (terminal && terminal.status === 'ACTIVE') {
      touchTerminal(terminal.id);
      return { terminal, device: 'REGISTERED' };
    }
    if (terminal) return { terminal: null, device: 'DISABLED' };
    if (hasRegisteredDevice(req.pharmacyId)) return { terminal: null, device: 'UNKNOWN' };
  }
  if (!hasRegisteredDevice(req.pharmacyId)) return { terminal: ensureTerminal(req.pharmacyId), device: 'LEGACY' };
  return { terminal: null, device: 'UNREGISTERED' };
}

function requireTerminal(req) {
  const { terminal, device } = req.pos || resolveTerminal(req);
  if (terminal) return terminal;
  const message =
    device === 'DISABLED'
      ? '사용이 중지된 카운터입니다. 약국 관리자에게 카운터 설정을 확인해 달라고 해 주세요.'
      : '이 PC는 카운터로 등록되지 않았습니다. 약국 관리자가 이 PC에서 "이 PC를 카운터로 등록"을 눌러 주세요.';
  throw new PosError(message, 428, 'TERMINAL_REQUIRED');
}

function publicTerminal(terminal) {
  if (!terminal) return null;
  const { device_key_hash: deviceKeyHash, bridge_key_enc: bridgeKey, seal_private_key_enc: _sealKey, seal_public_key: _sealPublic, ...rest } = terminal;
  return { ...rest, device_registered: Boolean(deviceKeyHash), bridge_paired: Boolean(bridgeKey) };
}

// Bridge 키는 이 응답에서 한 번만 보여 주고 DB에는 암호문으로만 둔다. 다시 발급하면 이전 키로 서명한 결과는 거절된다.
function issueBridgeKey(terminalId) {
  const key = newBridgeKey();
  run(
    'UPDATE pos_terminals SET bridge_key_enc = @enc, bridge_paired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
    { id: terminalId, enc: encrypt(key) }
  );
  return key;
}

function listTerminals(pharmacyId) {
  return getAll(
    `SELECT t.*, s.id AS open_session_id, s.opened_at AS session_opened_at, u.name AS session_opened_by_name,
            r.name AS device_registered_by_name
     FROM pos_terminals t
     LEFT JOIN pos_sessions s ON s.terminal_id = t.id AND s.status = 'OPEN'
     LEFT JOIN users u ON u.id = s.opened_by
     LEFT JOIN users r ON r.id = t.device_registered_by
     WHERE t.pharmacy_id = @pharmacy_id
     ORDER BY t.id ASC`,
    { pharmacy_id: pharmacyId }
  ).map(publicTerminal);
}

// 관리자가 카운터 PC에서 직접 등록한다. 토큰 원문은 이 응답에서 한 번만 내려가고 서버에는 해시만 남는다.
function registerDevice({ pharmacyId, terminalId, terminalName, deviceLabel, replace, userId }) {
  let terminal;
  if (terminalId) {
    terminal = getOne('SELECT * FROM pos_terminals WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: terminalId, pharmacy_id: pharmacyId });
    if (!terminal) throw new PosError('카운터를 찾을 수 없습니다.', 404);
    if (terminal.status !== 'ACTIVE') throw new PosError('사용 중지된 카운터에는 PC를 등록할 수 없습니다.', 409);
    if (terminal.device_key_hash && !replace) {
      throw new PosError('이미 다른 PC가 등록된 카운터입니다. 그 PC를 바꾸려면 교체로 등록해 주세요.', 409, 'DEVICE_ALREADY_REGISTERED');
    }
  } else {
    const name = terminalName || `카운터 ${getOne('SELECT COUNT(*) AS count FROM pos_terminals WHERE pharmacy_id = @id', { id: pharmacyId }).count + 1}`;
    if (getOne('SELECT 1 AS found FROM pos_terminals WHERE pharmacy_id = @pharmacy_id AND terminal_name = @name', { pharmacy_id: pharmacyId, name })) {
      throw new PosError(`"${name}" 이름의 카운터가 이미 있습니다. 다른 이름을 써 주세요.`, 409);
    }
    const result = run('INSERT INTO pos_terminals (pharmacy_id, terminal_name) VALUES (@pharmacy_id, @name)', { pharmacy_id: pharmacyId, name });
    terminal = getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: result.lastInsertRowid });
  }

  const token = `pdt_${crypto.randomBytes(24).toString('base64url')}`;
  run(
    `UPDATE pos_terminals
     SET device_key_hash = @hash, device_label = @label, device_registered_at = CURRENT_TIMESTAMP,
         device_registered_by = @user_id, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`,
    { id: terminal.id, hash: hashDeviceToken(token), label: deviceLabel, user_id: userId }
  );
  return {
    terminal: publicTerminal(getOne('SELECT * FROM pos_terminals WHERE id = @id', { id: terminal.id })),
    device_token: token,
    replaced: Boolean(terminal.device_key_hash)
  };
}

function revokeDevice(pharmacyId, terminalId) {
  const result = run(
    `UPDATE pos_terminals
     SET device_key_hash = NULL, device_label = NULL, device_registered_at = NULL, device_registered_by = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = @id AND pharmacy_id = @pharmacy_id AND device_key_hash IS NOT NULL`,
    { id: terminalId, pharmacy_id: pharmacyId }
  );
  if (result.changes === 0) throw new PosError('PC가 등록된 카운터를 찾을 수 없습니다.', 404);
}

const PRINTER_MODES = {
  BROWSER: '브라우저 인쇄 (window.print)',
  BRIDGE: '영수증 프린터 직접 출력 (Bridge)'
};

function printerSettings(terminal) {
  return {
    mode: PRINTER_MODES[terminal?.printer_mode] ? terminal.printer_mode : 'BROWSER',
    auto_print: terminal?.printer_auto_print === 1,
    open_drawer: terminal?.printer_open_drawer === 1
  };
}

function vanInfo(terminal) {
  const adapter = adapterFor(terminal);
  return {
    mode: adapter.mode,
    mode_label: adapter.label,
    kind: adapter.kind,
    van_company: terminal.van_company || null,
    tid: terminal.tid || null,
    is_demo: adapter.isDemo,
    bridge_paired: Boolean(terminal.bridge_key_enc),
    bridge_paired_at: terminal.bridge_paired_at || null,
    printer: printerSettings(terminal),
    printer_modes: PRINTER_MODES
  };
}

module.exports = {
  DEVICE_HEADER,
  DEVICE_STATES,
  PRINTER_MODES,
  ensureTerminal,
  issueBridgeKey,
  listTerminals,
  printerSettings,
  publicTerminal,
  registerDevice,
  requireTerminal,
  resolveTerminal,
  revokeDevice,
  vanInfo
};
