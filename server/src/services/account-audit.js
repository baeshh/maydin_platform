const bcrypt = require('bcryptjs');
const { KNOWN_DEFAULT_PASSWORDS } = require('./password-policy');

// 예전 init.js가 모든 DB에 만들던 계정. 이메일·비밀번호가 저장소에 공개돼 있다.
// 아래 함수는 better-sqlite3 연결을 받는다. 점검 스크립트가 백업 파일을 읽기 전용으로 열어 같은 검사를 하기 위해서다.
const SEED_ACCOUNTS = [
  { email: 'admin@maydin.kr', password: 'admin1234' },
  { email: 'owner@apharmacy.kr', password: 'owner1234' }
];
const DEMO_PHARMACY_CODE = 'A001';
const STAFF_ROLES = ['ADMIN', 'PHARMACY_OWNER', 'POS_STAFF'];

function seedAccounts(db) {
  const find = db.prepare('SELECT id, email, role, status, password_hash, created_at FROM users WHERE email = ?');
  return SEED_ACCOUNTS.map(({ email, password }) => {
    const user = find.get(email);
    if (!user) return { email, exists: false };
    const { password_hash: hash, ...rest } = user;
    return { ...rest, exists: true, default_password: bcrypt.compareSync(password, hash) };
  });
}

// 서버 시작 때 쓴다. 공개된 계정·비밀번호 조합이 그대로 살아 있으면 운영에서 시작하지 않는다.
function activeSeedAccounts(db) {
  return seedAccounts(db).filter((a) => a.exists && a.status === 'ACTIVE' && a.default_password);
}

// 관리자·약국·직원 계정 전체에서 알려진 초기 비밀번호를 쓰는 계정을 찾는다. 계정마다 bcrypt를 돌려 느리므로 점검 스크립트에서만 쓴다.
function defaultPasswordAccounts(db) {
  const users = db
    .prepare(
      `SELECT id, email, role, status, pharmacy_id, password_hash FROM users
       WHERE role IN (${STAFF_ROLES.map(() => '?').join(', ')}) AND status = 'ACTIVE'
       ORDER BY id`
    )
    .all(...STAFF_ROLES);
  return users
    .filter((u) => KNOWN_DEFAULT_PASSWORDS.some((password) => bcrypt.compareSync(password, u.password_hash)))
    .map(({ password_hash: _hash, ...rest }) => rest);
}

function demoPharmacy(db) {
  const pharmacy = db.prepare('SELECT id, pharmacy_code, pharmacy_name, status FROM pharmacies WHERE pharmacy_code = ?').get(DEMO_PHARMACY_CODE);
  if (!pharmacy) return null;
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE pharmacy_id = ?`).get(pharmacy.id).count;
  return { ...pharmacy, users: count('users'), orders: count('orders'), products: count('products') };
}

module.exports = { DEMO_PHARMACY_CODE, SEED_ACCOUNTS, activeSeedAccounts, defaultPasswordAccounts, demoPharmacy, seedAccounts };
