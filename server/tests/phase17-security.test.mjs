import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = mkdtempSync(path.join(tmpdir(), 'maydin-security-'));

const JWT_SECRET = randomBytes(32).toString('hex');
const DATA_KEY = randomBytes(32).toString('hex');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function prodEnv(dbName, extra = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DB_PATH: path.join(tempDir, dbName),
    BACKUP_DIR: path.join(tempDir, `${dbName}-backups`),
    JWT_SECRET,
    DATA_ENCRYPTION_KEY: DATA_KEY,
    ...extra
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

const run = (script, env, args = []) => spawnSync(process.execPath, [script, ...args], { cwd: serverDir, env, encoding: 'utf8', timeout: 20000 });
const output = (res) => `${res.stdout || ''}${res.stderr || ''}`;

// 서버가 바로 끝나면 그 출력, 뜨면 /api/health 응답을 돌려주고 끈다.
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => (log += chunk));
  child.stderr.on('data', (chunk) => (log += chunk));
  try {
    for (let i = 0; i < 100; i += 1) {
      if (child.exitCode !== null) return { started: false, code: child.exitCode, log };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return { started: true, log };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { started: false, code: null, log };
  } finally {
    child.kill();
  }
}

try {
  console.log('[운영 — 비밀키가 없거나 약하면 시작하지 않음]');
  {
    let res = await startServer(prodEnv('a.db', { JWT_SECRET: undefined }));
    check('JWT_SECRET 없으면 시작 안 함', !res.started && res.code === 1 && /JWT_SECRET/.test(res.log), res.log);
    res = await startServer(prodEnv('a.db', { JWT_SECRET: 'dev-secret-change-me' }));
    check('개발용 공개 값이면 시작 안 함', !res.started && /JWT_SECRET/.test(res.log), res.log);
    res = await startServer(prodEnv('a.db', { JWT_SECRET: 'short-secret' }));
    check('짧은 JWT_SECRET이면 시작 안 함', !res.started && /32자/.test(res.log), res.log);
    res = await startServer(prodEnv('a.db', { DATA_ENCRYPTION_KEY: undefined }));
    check('DATA_ENCRYPTION_KEY 없으면 시작 안 함', !res.started && /DATA_ENCRYPTION_KEY/.test(res.log), res.log);
    res = await startServer(prodEnv('a.db', { DATA_ENCRYPTION_KEY: '0'.repeat(64) }));
    check('같은 글자만 반복한 키는 거절', !res.started && /DATA_ENCRYPTION_KEY/.test(res.log), res.log);
    const init = run('src/db/init.js', prodEnv('a.db', { JWT_SECRET: undefined }));
    check('init-db도 비밀키 없으면 중단', init.status === 1 && /JWT_SECRET/.test(output(init)), output(init));
  }

  console.log('[운영 DB 초기화 — 데모 약국·계정 안 만듦]');
  {
    let init = run('src/db/init.js', prodEnv('prod.db'));
    check('운영 init-db 성공', init.status === 0, output(init));
    let db = new Database(path.join(tempDir, 'prod.db'), { readonly: true });
    check('사용자 없음', db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0);
    check('데모 약국 없음', db.prepare('SELECT COUNT(*) AS n FROM pharmacies').get().n === 0);
    check('상품 없음', db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0);
    db.close();
    check('공개 비밀번호를 출력하지 않음', !/admin1234|owner1234/.test(output(init)), output(init));

    init = run('src/db/init.js', prodEnv('prod.db', { INITIAL_ADMIN_EMAIL: 'ops@maydin.kr', INITIAL_ADMIN_PASSWORD: 'admin1234' }));
    check('공개된 비밀번호로는 관리자 안 만듦', init.status !== 0 && /비밀번호/.test(output(init)), output(init));
    init = run('src/db/init.js', prodEnv('prod.db', { INITIAL_ADMIN_EMAIL: 'ops@maydin.kr', INITIAL_ADMIN_PASSWORD: 'short1a' }));
    check('12자 미만 관리자 비밀번호 거절', init.status !== 0 && /12자/.test(output(init)), output(init));
    init = run('src/db/init.js', prodEnv('prod.db', { INITIAL_ADMIN_EMAIL: 'ops@maydin.kr', INITIAL_ADMIN_PASSWORD: 'Strong-Admin-2026' }));
    check('환경변수로 첫 관리자 생성', init.status === 0 && /ops@maydin\.kr/.test(output(init)), output(init));
    init = run('src/db/init.js', prodEnv('prod.db', { INITIAL_ADMIN_EMAIL: 'other@maydin.kr', INITIAL_ADMIN_PASSWORD: 'Strong-Admin-2026' }));
    db = new Database(path.join(tempDir, 'prod.db'), { readonly: true });
    check('관리자가 있으면 또 만들지 않음', db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN'").get().n === 1, output(init));
    check('초기 계정 이메일 없음', !db.prepare("SELECT 1 FROM users WHERE email IN ('admin@maydin.kr', 'owner@apharmacy.kr')").get());
    db.close();

    const res = await startServer(prodEnv('prod.db'));
    check('깨끗한 운영 DB로는 시작', res.started, res.log);
  }

  console.log('[운영 — 공개된 초기 계정이 살아 있으면 시작하지 않음]');
  {
    const seeded = run('src/db/init.js', prodEnv('seeded.db', { NODE_ENV: 'development' }));
    check('(준비) 개발용 데모 DB', seeded.status === 0, output(seeded));
    let res = await startServer(prodEnv('seeded.db'));
    check('초기 계정 그대로면 운영 시작 안 함', !res.started && /admin@maydin\.kr/.test(res.log) && /owner@apharmacy\.kr/.test(res.log), res.log);

    let check1 = run('scripts/security-check.js', prodEnv('seeded.db'), ['--db', path.join(tempDir, 'seeded.db')]);
    check('점검 스크립트가 초기 계정을 찾음(종료 코드 1)', check1.status === 1 && /공개된 비밀번호 그대로/.test(output(check1)), output(check1));
    check('점검 스크립트는 비밀키 값을 출력하지 않음', !output(check1).includes(JWT_SECRET) && !output(check1).includes(DATA_KEY));

    const fix = run('scripts/security-check.js', prodEnv('seeded.db'), ['--db', path.join(tempDir, 'seeded.db'), '--disable-default-accounts']);
    check('초기 계정 사용 중지', fix.status === 0 && /사용 중지/.test(output(fix)), output(fix));
    const db = new Database(path.join(tempDir, 'seeded.db'), { readonly: true });
    check('두 계정 모두 INACTIVE', db.prepare("SELECT COUNT(*) AS n FROM users WHERE email IN ('admin@maydin.kr', 'owner@apharmacy.kr') AND status = 'INACTIVE'").get().n === 2);
    check('사용 중지 감사 기록', db.prepare("SELECT COUNT(*) AS n FROM admin_logs WHERE action = 'SECURITY_DISABLE_DEFAULT_ACCOUNT'").get().n === 2);
    db.close();

    res = await startServer(prodEnv('seeded.db'));
    check('막은 뒤에는 시작 · 데모 약국은 경고', res.started && /데모 약국/.test(res.log), res.log);
    const login = await (async () => {
      const port = await freePort();
      const child = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env: { ...prodEnv('seeded.db'), PORT: String(port) }, stdio: 'ignore' });
      try {
        for (let i = 0; i < 100; i += 1) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: 'admin@maydin.kr', password: 'admin1234' })
            });
            return r.status;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        return null;
      } finally {
        child.kill();
      }
    })();
    check('사용 중지된 초기 관리자로 로그인 불가', login === 401, login);
  }

  console.log('[운영 — 다른 키로는 기존 암호문 DB를 열지 않음]');
  {
    process.env.DATA_ENCRYPTION_KEY = DATA_KEY;
    const { encrypt } = require('../src/services/secure.js');
    const db = new Database(path.join(tempDir, 'prod.db'));
    db.prepare("INSERT INTO pharmacies (pharmacy_code, pharmacy_name, owner_name, store_slug, store_url) VALUES ('K001', '키약국', '김약사', 'k-pharmacy', '/store.html?pharmacyCode=K001')").run();
    db.prepare("INSERT INTO pos_terminals (pharmacy_id, terminal_name, bridge_key_enc) VALUES ((SELECT id FROM pharmacies WHERE pharmacy_code = 'K001'), '카운터 1', ?)").run(encrypt('bridge-key'));
    db.close();
    let res = await startServer(prodEnv('prod.db', { DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex') }));
    check('키가 다르면 시작 안 함', !res.started && /pos_terminals\.bridge_key_enc/.test(res.log), res.log);
    res = await startServer(prodEnv('prod.db'));
    check('맞는 키로는 시작', res.started, res.log);
  }

  console.log('[새 비밀번호 — 공개된 초기 비밀번호 금지]');
  {
    const admin = await login('admin@maydin.kr', 'admin1234');
    const code = `S7${String(Date.now()).slice(-5)}`;
    const body = { pharmacy_code: code, pharmacy_name: '보안약국', owner_name: '박약사', store_slug: `sec-${code.toLowerCase()}`, owner_email: `${code.toLowerCase()}@sec.kr` };
    let res = await api('/admin/pharmacies', { token: admin, method: 'POST', body });
    check('운영자 비밀번호 없이 약국 생성 불가(400)', res.status === 400, res.data);
    res = await api('/admin/pharmacies', { token: admin, method: 'POST', body: { ...body, owner_password: 'owner1234' } });
    check('공개된 비밀번호로 약국 생성 불가(400)', res.status === 400 && /초기 비밀번호/.test(res.data.message), res.data);
    res = await api('/admin/pharmacies', { token: admin, method: 'POST', body: { ...body, owner_password: 'SecOwner2026' } });
    check('정한 비밀번호로 약국 생성', res.status === 201, res.data);

    const owner = await login('owner@apharmacy.kr', 'owner1234');
    res = await api('/staff', { token: owner, method: 'POST', body: { name: '보안직원', email: `sec-staff-${process.pid}@test.kr`, password: 'Owner1234' } });
    check('직원 비밀번호도 공개된 값 금지(대소문자 무관)', res.status === 400 && /초기 비밀번호/.test(res.data.message), res.data);
  }

  console.log('[화면 — 로그인 칸에 계정 미리 채우지 않음]');
  for (const page of ['pos.html', 'owner.html', 'admin.html']) {
    const html = readFileSync(path.join(serverDir, 'public', page), 'utf8');
    check(`${page}: 초기 계정·비밀번호 없음`, !/admin1234|owner1234|value="[^"]*@(maydin\.kr|apharmacy\.kr|bpharmacy\.kr)"/.test(html));
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

done();
