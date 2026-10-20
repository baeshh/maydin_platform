const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

// 백업 파일에는 회원 이름·연락처 같은 개인정보가 들어 있다. 저장소(git)에 올리지 않고(.gitignore) 소유자만 읽게 둔다.
const SERVER_DIR = path.join(__dirname, '../..');
const MANIFEST = 'manifest.json';
const KEY_TABLES = [
  'pharmacies',
  'users',
  'products',
  'product_lots',
  'orders',
  'order_items',
  'payments',
  'inventory_logs',
  'order_status_history',
  'pos_outages',
  'admin_logs'
];

function backupDir() {
  return process.env.BACKUP_DIR || path.join(SERVER_DIR, 'backups');
}

function liveDbPath() {
  return process.env.DB_PATH || path.join(SERVER_DIR, 'data/maydin-platform.db');
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function settings() {
  const testing = process.env.NODE_ENV === 'test';
  return {
    dir: backupDir(),
    interval_hours: numberEnv('BACKUP_INTERVAL_HOURS', testing ? 0 : 6),
    keep: Math.max(3, Math.floor(numberEnv('BACKUP_KEEP', 30))),
    drill_days: numberEnv('BACKUP_DRILL_DAYS', testing ? 0 : 7)
  };
}

function ensureDir() {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readManifest() {
  const file = path.join(backupDir(), MANIFEST);
  if (!fs.existsSync(file)) return { backups: [], drills: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { backups: parsed.backups || [], drills: parsed.drills || [] };
  } catch {
    return { backups: [], drills: [] };
  }
}

function writeManifest(manifest) {
  const dir = ensureDir();
  const file = path.join(dir, MANIFEST);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function updateManifest(fn) {
  const manifest = readManifest();
  fn(manifest);
  writeManifest(manifest);
  return manifest;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function stamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

// 파일을 읽기 전용으로 열어 손상 여부·외래키·주요 테이블 건수를 확인한다.
function inspectDatabase(file) {
  const handle = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = handle.pragma('integrity_check').map((row) => row.integrity_check);
    const foreignKeyErrors = handle.pragma('foreign_key_check').length;
    const existing = new Set(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const counts = {};
    for (const table of KEY_TABLES) {
      if (existing.has(table)) counts[table] = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    return {
      integrity: integrity.length === 1 && integrity[0] === 'ok' ? 'ok' : integrity.slice(0, 5).join('; '),
      foreign_key_errors: foreignKeyErrors,
      counts
    };
  } finally {
    handle.close();
  }
}

function inspectionProblems(inspection) {
  const problems = [];
  if (inspection.integrity !== 'ok') problems.push(`무결성 검사 실패: ${inspection.integrity}`);
  if (inspection.foreign_key_errors > 0) problems.push(`외래키 오류 ${inspection.foreign_key_errors}건`);
  if (!inspection.counts.pharmacies) problems.push('약국 데이터가 없습니다.');
  return problems;
}

function resolveBackup(file) {
  const dir = backupDir();
  const manifest = readManifest();
  if (!file) {
    const latest = [...manifest.backups].reverse().find((entry) => entry.ok && fs.existsSync(path.join(dir, entry.file)));
    if (!latest) throw new Error('검사를 통과한 백업 파일이 없습니다. 먼저 백업을 만드세요.');
    return { entry: latest, full: path.join(dir, latest.file) };
  }
  const full = path.isAbsolute(file) ? file : fs.existsSync(path.join(dir, file)) ? path.join(dir, file) : path.resolve(file);
  if (!fs.existsSync(full)) throw new Error(`백업 파일을 찾을 수 없습니다: ${file}`);
  const entry = manifest.backups.find((item) => path.join(dir, item.file) === full) || null;
  return { entry, full };
}

// 백업 파일이 만들어질 때와 같은지(체크섬)와 열어서 읽을 수 있는지 확인한다.
async function verifyBackup(file) {
  const { entry, full } = resolveBackup(file);
  const sha256 = await sha256File(full);
  const inspection = inspectDatabase(full);
  const problems = inspectionProblems(inspection);
  if (entry && entry.sha256 !== sha256) problems.unshift('체크섬 불일치: 백업 후 파일이 바뀌었거나 손상되었습니다.');
  return { file: full, entry, sha256, ...inspection, problems, ok: problems.length === 0 };
}

function prune(manifest, keep) {
  const dir = backupDir();
  const lastDrilled = [...manifest.drills].reverse().find((drill) => drill.ok);
  const protectedFile = lastDrilled ? path.basename(lastDrilled.file) : null;
  const regular = manifest.backups.filter((entry) => entry.reason !== 'pre-restore');
  const excess = regular.length - keep;
  if (excess <= 0) return [];
  const removed = [];
  for (const entry of regular) {
    if (removed.length >= excess) break;
    if (entry.file === protectedFile) continue;
    fs.rmSync(path.join(dir, entry.file), { force: true });
    removed.push(entry.file);
  }
  manifest.backups = manifest.backups.filter((entry) => !removed.includes(entry.file));
  return removed;
}

// 운영 중인 DB를 SQLite 온라인 백업 API로 복사한다(쓰기 중이어도 일관된 시점의 사본이 나온다).
async function createBackup(db, { reason = 'scheduled' } = {}) {
  const dir = ensureDir();
  const file = `maydin-${stamp()}.db`;
  const full = path.join(dir, file);
  const started = Date.now();
  await db.backup(full);
  fs.chmodSync(full, 0o600);
  const inspection = inspectDatabase(full);
  const problems = inspectionProblems(inspection);
  const entry = {
    file,
    reason,
    created_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    size: fs.statSync(full).size,
    sha256: await sha256File(full),
    ...inspection,
    problems,
    ok: problems.length === 0
  };
  let removed = [];
  updateManifest((manifest) => {
    manifest.backups.push(entry);
    removed = prune(manifest, settings().keep);
  });
  return { ...entry, removed };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { ok: false, reason: `복구 서버가 종료되었습니다(코드 ${child.exitCode}).` };
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.db === 'ok') return { ok: true };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, reason: '복구 서버가 제한 시간 안에 응답하지 않았습니다.' };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
  });
}

// 복구 훈련: 백업을 임시 위치에 풀어 실제 서버를 그 파일로 띄워 본다.
// 서버가 마이그레이션을 마치고 DB 확인까지 통과하고, 건수가 백업 시점과 같아야 성공으로 기록한다.
async function runRestoreDrill({ file, timeoutMs = 30000 } = {}) {
  const startedAt = new Date().toISOString();
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok, detail: detail || '' });
  let target = file;
  let tempDir = null;
  let child = null;
  let log = '';
  let ok = false;
  let error = null;
  try {
    const verified = await verifyBackup(file);
    target = verified.file;
    step('체크섬·무결성 확인', verified.ok, verified.ok ? `sha256 ${verified.sha256.slice(0, 12)}…` : verified.problems.join(' / '));
    if (!verified.ok) throw new Error(verified.problems.join(' / '));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maydin-drill-'));
    const restored = path.join(tempDir, 'restored.db');
    fs.copyFileSync(target, restored);
    step('임시 위치로 복원', true, restored);

    const port = await freePort();
    child = spawn(process.execPath, ['src/index.js'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        DB_PATH: restored,
        PORT: String(port),
        BACKUP_DIR: path.join(tempDir, 'backups'),
        BACKUP_INTERVAL_HOURS: '0',
        BACKUP_DRILL_DAYS: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    const health = await waitForHealth(`http://127.0.0.1:${port}`, child, timeoutMs);
    step('복원본으로 서버 기동', health.ok, health.ok ? `포트 ${port} · DB 응답 정상` : health.reason);
    if (!health.ok) throw new Error(`${health.reason}\n${log.slice(-800)}`);
    await stopChild(child);
    child = null;

    const after = inspectDatabase(restored);
    const problems = inspectionProblems(after);
    const mismatched = Object.entries(verified.counts).filter(([table, count]) => after.counts[table] !== count);
    if (mismatched.length) problems.push(`건수 불일치: ${mismatched.map(([t, c]) => `${t} ${c}→${after.counts[t]}`).join(', ')}`);
    step('기동 후 데이터 대조', problems.length === 0, problems.length ? problems.join(' / ') : Object.entries(after.counts).map(([t, c]) => `${t} ${c}`).join(', '));
    if (problems.length) throw new Error(problems.join(' / '));
    ok = true;
  } catch (err) {
    error = err.message;
  } finally {
    if (child) await stopChild(child);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  const drill = {
    file: target ? path.basename(target) : null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok,
    steps,
    error
  };
  updateManifest((manifest) => {
    manifest.drills.push(drill);
    manifest.drills = manifest.drills.slice(-50);
  });
  return drill;
}

async function serverIsRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

// 실제 복구: 서버를 멈춘 상태에서만 실행한다. 현재 DB는 pre-restore 사본으로 남긴 뒤 교체한다.
async function restoreBackup(file, { port = process.env.PORT || 3001 } = {}) {
  if (!file) throw new Error('복구할 백업 파일을 지정하세요.');
  if (await serverIsRunning(port)) throw new Error(`포트 ${port}에서 서버가 실행 중입니다. 서버를 멈춘 뒤 복구하세요.`);
  const verified = await verifyBackup(file);
  if (!verified.ok) throw new Error(`백업 검사 실패: ${verified.problems.join(' / ')}`);

  const live = liveDbPath();
  const dir = ensureDir();
  let preRestore = null;
  if (fs.existsSync(live)) {
    preRestore = `pre-restore-${stamp()}.db`;
    const current = new Database(live, { fileMustExist: true });
    try {
      await current.backup(path.join(dir, preRestore));
    } finally {
      current.close();
    }
    fs.chmodSync(path.join(dir, preRestore), 0o600);
    const sha256 = await sha256File(path.join(dir, preRestore));
    updateManifest((manifest) => {
      manifest.backups.push({ file: preRestore, reason: 'pre-restore', created_at: new Date().toISOString(), sha256, ok: true, counts: {} });
    });
  }

  fs.mkdirSync(path.dirname(live), { recursive: true });
  const staging = `${live}.restoring`;
  fs.copyFileSync(verified.file, staging);
  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${live}${suffix}`, { force: true });
  fs.renameSync(staging, live);
  const after = inspectDatabase(live);
  return { restored_from: verified.file, live, pre_restore: preRestore, ...after, problems: inspectionProblems(after) };
}

function status() {
  const manifest = readManifest();
  const dir = backupDir();
  const backups = manifest.backups
    .filter((entry) => entry.reason !== 'pre-restore')
    .map((entry) => ({ ...entry, exists: fs.existsSync(path.join(dir, entry.file)) }))
    .reverse();
  const lastDrill = manifest.drills[manifest.drills.length - 1] || null;
  const lastGoodDrill = [...manifest.drills].reverse().find((drill) => drill.ok) || null;
  return {
    settings: settings(),
    backups,
    last_backup: backups[0] || null,
    last_drill: lastDrill,
    last_good_drill: lastGoodDrill,
    drills: manifest.drills.slice(-10).reverse()
  };
}

let running = false;

async function tick(db, log = console) {
  if (running) return;
  running = true;
  try {
    const cfg = settings();
    const current = status();
    const last = current.last_backup ? Date.parse(current.last_backup.created_at) : 0;
    if (cfg.interval_hours > 0 && Date.now() - last >= cfg.interval_hours * 3600 * 1000 * 0.95) {
      const entry = await createBackup(db, { reason: 'scheduled' });
      if (entry.ok) log.log(`[backup] ${entry.file} (${Math.round(entry.size / 1024)}KB) 저장`);
      else log.error(`[backup] ${entry.file} 검사 실패: ${entry.problems.join(' / ')}`);
    }
    const lastDrill = current.last_drill ? Date.parse(current.last_drill.started_at) : 0;
    if (cfg.drill_days > 0 && Date.now() - lastDrill >= cfg.drill_days * 86400 * 1000) {
      const drill = await runRestoreDrill();
      if (drill.ok) log.log(`[backup] 복구 훈련 성공: ${drill.file}`);
      else log.error(`[backup] 복구 훈련 실패: ${drill.error}`);
    }
  } catch (error) {
    log.error('[backup] 예약 작업 실패:', error.message);
  } finally {
    running = false;
  }
}

function startSchedule(db, log = console) {
  const cfg = settings();
  if (cfg.interval_hours <= 0 && cfg.drill_days <= 0) return null;
  const first = setTimeout(() => tick(db, log), 60 * 1000);
  first.unref();
  const timer = setInterval(() => tick(db, log), 15 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  KEY_TABLES,
  createBackup,
  inspectDatabase,
  restoreBackup,
  runRestoreDrill,
  settings,
  startSchedule,
  status,
  verifyBackup
};
