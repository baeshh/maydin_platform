// 데모·테스트 결제 운영 정책.
// 운영 서버(NODE_ENV=production)의 DB에는 실제 돈이 오간 결제만 들어간다. 데모 VAN·데모 Bridge·데모 결제사·결제사 테스트 키는
// 개발 서버와 스테이징 서버(MAYDIN_STAGING=true, 운영과 다른 DB)에서만 받는다.
// 데모·테스트 결제도 판매로 저장되면 매출·재고 차감·출고 내보내기에 그대로 잡히므로, 운영 DB에 들어오지 않게 막는 것이 기준이다.

const TEST_PAYMENTS_DISABLED =
  '운영 서버에서는 데모·테스트 결제를 받지 않습니다. 실제 돈이 오가지 않는 결제가 매출·재고에 잡히기 때문입니다. 시험은 스테이징 서버(별도 DB)에서 해 주세요.';

const isStaging = (env = process.env) => env.NODE_ENV === 'production' && env.MAYDIN_STAGING === 'true';

function testPaymentsAllowed(env = process.env) {
  return env.NODE_ENV !== 'production' || isStaging(env);
}

/* ---------- DB가 어느 서버용인지 표시 ---------- */

// 운영 DB를 스테이징 설정으로 띄우거나, 시험 결제가 섞인 스테이징 DB를 운영으로 띄우는 것을 막는다.
const ENVIRONMENT_KEY = 'data_environment';

function tableExists(conn, table) {
  return Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(conn, table, column) {
  return tableExists(conn, table) && conn.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

function dataEnvironment(conn) {
  if (!tableExists(conn, 'system_settings')) return null;
  return conn.prepare('SELECT value FROM system_settings WHERE key = ?').get(ENVIRONMENT_KEY)?.value || null;
}

function expectedEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production') return null;
  return isStaging(env) ? 'STAGING' : 'PRODUCTION';
}

// 운영·스테이징 서버가 처음 연 DB에 그 서버 종류를 남긴다. 개발·테스트 서버는 남기지 않는다.
function markDataEnvironment(conn, env = process.env) {
  const expected = expectedEnvironment(env);
  if (!expected || dataEnvironment(conn)) return;
  conn.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)').run(ENVIRONMENT_KEY, expected);
}

function environmentProblem(conn, env = process.env) {
  const expected = expectedEnvironment(env);
  const marked = dataEnvironment(conn);
  if (!expected || !marked || marked === expected) return null;
  if (marked === 'STAGING') {
    return '이 DB는 스테이징 서버(데모·테스트 결제 허용)에서 쓰던 DB라 운영 서버로 띄울 수 없습니다. 시험 결제가 실제 매출에 섞입니다. 운영은 새 DB로 시작해 주세요.';
  }
  return '이 DB는 운영 DB라 MAYDIN_STAGING=true(데모·테스트 결제 허용)로 띄울 수 없습니다. 스테이징은 별도 DB로 띄워 주세요.';
}

/* ---------- 이미 들어 있는 데모·테스트 결제 ---------- */

// MOCK: 예전 온라인 주문의 가짜 결제, DEMO·TEST: 데모 결제사·결제사 테스트 키, VAN_DEMO·데모 Bridge: 데모 카드 승인.
function testPaymentSummary(conn) {
  if (!tableExists(conn, 'payments')) return [];
  const conditions = ["p.payment_provider IN ('MOCK', 'DEMO', 'VAN_DEMO')"];
  if (columnExists(conn, 'payments', 'payment_mode')) conditions.push("p.payment_mode IN ('DEMO', 'TEST')");
  const joinVan = columnExists(conn, 'payments', 'van_transaction_id') && columnExists(conn, 'van_transactions', 'is_demo');
  if (joinVan) conditions.push('v.is_demo = 1');
  return conn
    .prepare(
      `SELECT p.payment_provider AS provider, ${columnExists(conn, 'payments', 'payment_mode') ? 'p.payment_mode' : 'NULL'} AS mode,
              COUNT(*) AS count, SUM(p.paid_amount) AS amount, MIN(p.paid_at) AS first_at, MAX(p.paid_at) AS last_at
       FROM payments p
       ${joinVan ? 'LEFT JOIN van_transactions v ON v.id = p.van_transaction_id' : ''}
       WHERE p.paid_amount <> 0 AND (${conditions.join(' OR ')})
       GROUP BY 1, 2
       ORDER BY 3 DESC`
    )
    .all();
}

function describeTestPayments(rows) {
  return rows
    .map((row) => `${row.provider}${row.mode ? `/${row.mode}` : ''} ${row.count}건 ${Number(row.amount).toLocaleString('ko-KR')}원 (${String(row.first_at).slice(0, 10)}~${String(row.last_at).slice(0, 10)})`)
    .join(', ');
}

module.exports = {
  TEST_PAYMENTS_DISABLED,
  dataEnvironment,
  describeTestPayments,
  environmentProblem,
  isStaging,
  markDataEnvironment,
  testPaymentSummary,
  testPaymentsAllowed
};
