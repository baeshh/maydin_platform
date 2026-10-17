const crypto = require('crypto');
const { dataEncryptionKey } = require('./secrets');

// 건강 정보(민감정보)는 DB에 암호문으로만 둔다. 운영에서는 DATA_ENCRYPTION_KEY(32바이트 hex)가 없으면 시작하지 않는다.
// 키를 바꾸거나 잃어버리면 기존 암호문은 복구할 수 없다.
const KEY = dataEncryptionKey();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

function decrypt(value) {
  if (!value) return null;
  const raw = Buffer.from(String(value).replace(/^v1:/, ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// IP는 그대로 저장하지 않고 같은 기기 반복 가입을 알아볼 수 있을 만큼만 남긴다.
function hashIp(ip) {
  return crypto.createHmac('sha256', KEY).update(String(ip || '')).digest('hex').slice(0, 24);
}

const ENCRYPTED_COLUMNS = [
  ['customers', 'health_info'],
  ['orders', 'counsel_note'],
  ['online_checkouts', 'payload'],
  ['pos_terminals', 'bridge_key_enc'],
  ['pos_terminals', 'seal_private_key_enc']
];

function hasColumn(conn, table, column) {
  return Boolean(conn.prepare(`SELECT 1 AS found FROM pragma_table_info('${table}') WHERE name = ?`).get(column));
}

// 지금 키로 기존 암호문을 풀 수 있는지 칸마다 한 건씩 확인한다(better-sqlite3 연결을 받는다).
// 다른 키로 서버를 띄우면 새 암호문과 옛 암호문이 섞여 한쪽은 영영 읽을 수 없게 된다.
function undecryptableColumns(conn) {
  return ENCRYPTED_COLUMNS.filter(([table, column]) => {
    if (!hasColumn(conn, table, column)) return false;
    const row = conn.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} LIKE 'v1:%' LIMIT 1`).get();
    if (!row) return false;
    try {
      decrypt(row.value);
      return false;
    } catch {
      return true;
    }
  }).map(([table, column]) => `${table}.${column}`);
}

module.exports = { encrypt, decrypt, hasColumn, hashIp, undecryptableColumns };
