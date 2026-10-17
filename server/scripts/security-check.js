#!/usr/bin/env node
// 운영 보안 점검. DB는 읽기 전용으로 열고, --disable-default-accounts 를 줄 때만 고친다.
// 사용법
//   npm run security:check                                   비밀키 설정·초기 계정·데모 약국·데모 결제 점검(DB_PATH 또는 data/maydin-platform.db)
//   npm run security:check -- --db 파일 [--db 파일 ...]        다른 DB·백업 파일 점검
//   npm run security:check -- --disable-default-accounts      공개된 비밀번호를 쓰는 계정을 사용 중지(INACTIVE)
//   npm run security:check -- --print-legacy-data-key         DATA_ENCRYPTION_KEY 없이 운영하던 DB의 기존 키 출력(운영 서버에서만)
// 문제가 있으면 종료 코드 1.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DEV_JWT_SECRET, dataEncryptionKey, isProduction, legacyDataKey } = require('../src/services/secrets');
const audit = require('../src/services/account-audit');
const policy = require('../src/services/payment-policy');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const dbFiles = args.flatMap((arg, i) => (arg === '--db' && args[i + 1] ? [path.resolve(args[i + 1])] : []));
const fixAccounts = flag('--disable-default-accounts');

let problems = 0;
const bad = (text) => {
  problems += 1;
  console.log(`  ✗ ${text}`);
};
const ok = (text) => console.log(`  ✓ ${text}`);
const note = (text) => console.log(`  · ${text}`);

if (flag('--print-legacy-data-key')) {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET이 없습니다. 운영 서버의 환경변수로 실행해 주세요.');
    process.exit(1);
  }
  console.log(legacyDataKey(process.env.JWT_SECRET).toString('hex'));
  console.error('위 값을 DATA_ENCRYPTION_KEY로 넣으면 지금까지의 암호문을 그대로 읽습니다. 이 값은 화면·로그에 남기지 마세요.');
  process.exit(0);
}

console.log(`[비밀키] NODE_ENV=${process.env.NODE_ENV || '(없음)'}`);
if (!isProduction()) note('NODE_ENV가 production이 아니라 운영 보호(비밀키 필수·초기 계정 차단·데모 결제 차단)가 꺼져 있습니다. 운영 서버는 production으로 실행하세요.');
else if (policy.isStaging()) note('MAYDIN_STAGING=true — 스테이징 서버입니다. 데모·테스트 결제를 받습니다. 운영 서버에서는 지우세요.');
const secret = String(process.env.JWT_SECRET || '');
if (!secret) bad('JWT_SECRET 없음 — 저장소에 공개된 개발용 값으로 로그인 토큰을 서명합니다.');
else if (secret === DEV_JWT_SECRET) bad('JWT_SECRET이 저장소에 공개된 개발용 값입니다.');
else if (secret.length < 32) bad(`JWT_SECRET이 ${secret.length}자로 짧습니다(32자 이상).`);
else ok(`JWT_SECRET 설정됨(${secret.length}자)`);

let keyReady = false;
if (!process.env.DATA_ENCRYPTION_KEY) bad('DATA_ENCRYPTION_KEY 없음 — JWT_SECRET에서 만든 키로 민감정보를 암호화합니다.');
try {
  dataEncryptionKey();
  keyReady = true;
  if (process.env.DATA_ENCRYPTION_KEY) ok('DATA_ENCRYPTION_KEY 설정됨');
} catch (error) {
  if (process.env.DATA_ENCRYPTION_KEY) bad(error.message);
}
// 키를 읽을 수 있을 때만 암호문 검사를 한다(secure.js는 불러올 때 키를 읽는다).
const secure = keyReady ? require('../src/services/secure') : null;

const targets = dbFiles.length ? dbFiles : [process.env.DB_PATH || path.join(__dirname, '..', 'data', 'maydin-platform.db')];
if (fixAccounts && targets.length !== 1) {
  console.error('--disable-default-accounts는 DB 하나에만 쓸 수 있습니다.');
  process.exit(1);
}

function disableDefaultAccounts(db) {
  const weak = audit.defaultPasswordAccounts(db);
  const disable = db.prepare("UPDATE users SET status = 'INACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE'");
  const log = db.prepare(
    "INSERT INTO admin_logs (user_id, action, target_type, target_id, description) VALUES (NULL, 'SECURITY_DISABLE_DEFAULT_ACCOUNT', 'USER', ?, ?)"
  );
  db.transaction(() => {
    for (const user of weak) {
      disable.run(user.id);
      log.run(user.id, `보안 점검: 알려진 초기 비밀번호를 쓰는 ${user.role} 계정 ${user.email} 사용 중지`);
    }
  })();
  return weak;
}

for (const file of targets) {
  console.log(`\n[DB] ${file}`);
  if (!fs.existsSync(file)) {
    bad('파일이 없습니다.');
    continue;
  }
  const db = new Database(file, { readonly: !fixAccounts, fileMustExist: true });
  try {
    if (fixAccounts) {
      const disabled = disableDefaultAccounts(db);
      for (const user of disabled) console.log(`  → ${user.email}(${user.role}) 사용 중지`);
      if (disabled.length) note('필요한 계정은 새 비밀번호로 다시 만들어 주세요(관리자는 INITIAL_ADMIN_* 환경변수 + npm run init-db).');
    }

    const seeds = audit.seedAccounts(db);
    for (const account of seeds) {
      if (!account.exists) ok(`초기 계정 ${account.email} 없음`);
      else if (account.status !== 'ACTIVE') ok(`초기 계정 ${account.email} 있음 · 사용 중지됨(${account.status})`);
      else if (account.default_password) bad(`초기 계정 ${account.email}(${account.role}) 사용 중 · 공개된 비밀번호 그대로`);
      else note(`초기 계정 ${account.email}(${account.role}) 사용 중 · 비밀번호는 바뀜. 실제로 쓰는 계정인지 확인하세요.`);
    }

    const weak = audit.defaultPasswordAccounts(db);
    for (const user of weak.filter((u) => !seeds.some((s) => s.email === u.email))) {
      bad(`${user.email}(${user.role}) 계정이 알려진 초기 비밀번호를 씁니다.`);
    }
    if (!weak.length) ok('알려진 초기 비밀번호를 쓰는 관리자·약국·직원 계정 없음');

    const demo = audit.demoPharmacy(db);
    if (demo) note(`데모 약국 ${demo.pharmacy_code} ${demo.pharmacy_name} 있음 · 계정 ${demo.users} · 상품 ${demo.products} · 주문 ${demo.orders}`);
    else ok('데모 약국(A001) 없음');

    const environment = policy.dataEnvironment(db);
    const environmentError = policy.environmentProblem(db);
    if (environmentError) bad(environmentError);
    else if (environment) ok(`DB 용도 표시: ${environment === 'STAGING' ? '스테이징(데모·테스트 결제 허용)' : '운영'}`);
    else note('DB 용도 표시 없음 · 운영(production)·스테이징 서버가 처음 띄울 때 남깁니다.');

    const testPayments = policy.testPaymentSummary(db);
    if (!testPayments.length) ok('데모·테스트 결제 없음');
    else if (environment === 'STAGING' || !isProduction() || policy.isStaging()) note(`데모·테스트 결제: ${policy.describeTestPayments(testPayments)}`);
    else bad(`실제 돈이 오가지 않은 데모·테스트 결제가 매출·재고에 잡혀 있음: ${policy.describeTestPayments(testPayments)}`);

    if (secure) {
      const broken = secure.undecryptableColumns(db);
      if (broken.length) bad(`현재 키로 풀 수 없는 암호문: ${broken.join(', ')}`);
      else ok('현재 키로 기존 암호문을 읽을 수 있음');
    }
  } finally {
    db.close();
  }
}

console.log(problems > 0 ? `\n문제 ${problems}건` : '\n문제 없음');
process.exit(problems > 0 ? 1 : 0);
