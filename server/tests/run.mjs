// 임시 DB로 서버를 띄우고 tests/*.test.mjs 를 차례로 실행한다. 실제 DB(server/data)는 건드리지 않는다.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.dirname(testsDir);
const filter = process.argv[2] || '';

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

async function waitForServer(base, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error('테스트 서버가 시작하지 못했습니다.');
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('테스트 서버 응답 대기 시간 초과');
}

const tempDir = mkdtempSync(path.join(tmpdir(), 'maydin-test-'));
const env = { ...process.env, DB_PATH: path.join(tempDir, 'test.db'), PORT: String(await freePort()), NODE_ENV: 'test' };
const base = `http://127.0.0.1:${env.PORT}`;

const init = spawnSync(process.execPath, ['src/db/init.js'], { cwd: serverDir, env, encoding: 'utf8' });
if (init.status !== 0) {
  console.error(init.stdout, init.stderr);
  process.exit(1);
}

const server = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

let failed = 0;
try {
  await waitForServer(base, server);
  const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs') && name.includes(filter)).sort();
  for (const file of files) {
    console.log(`\n▶ ${file}`);
    const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
      cwd: serverDir,
      env: { ...env, BASE: base },
      stdio: 'inherit'
    });
    if (result.status !== 0) failed += 1;
  }
} catch (error) {
  console.error(error.message);
  failed += 1;
} finally {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n✗ 실패한 테스트 파일 ${failed}개`);
  if (process.env.SHOW_SERVER_LOG) console.error(serverLog);
  process.exit(1);
}
console.log('\n✓ 모든 테스트 통과');
