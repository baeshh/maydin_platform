#!/usr/bin/env bash
# 운영 서버에서 ubuntu 사용자로 실행한다: deploy.sh <커밋 SHA>
# DB·.env 백업 → 보안 점검 → 코드 전환 → 패키지 설치 → 재시작 → 상태 확인. 실패하면 이전 코드와 백업 DB로 되돌린다.
# GitHub Actions(SSM)는 대상 커밋의 이 파일을 꺼내 실행하므로, 이 스크립트를 고친 배포에도 새 내용이 쓰인다.
set -euo pipefail

SHA="${1:?배포할 커밋 SHA를 주세요}"
APP_DIR="${MAYDIN_APP_DIR:-$HOME/apps/maydin_platform}"
PM2_NAME="${MAYDIN_PM2_NAME:-maydin-platform}"
BACKUP_DIR="${MAYDIN_DEPLOY_BACKUP_DIR:-$HOME/db-backups}"
HEALTH_URL="${MAYDIN_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
KEEP_BACKUPS="${MAYDIN_KEEP_BACKUPS:-20}"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { log "실패: $*"; exit 1; }

export npm_config_update_notifier=false
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
command -v node >/dev/null || fail "node를 찾을 수 없습니다"
command -v pm2 >/dev/null || fail "pm2를 찾을 수 없습니다"

cd "$APP_DIR"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "서버 코드에 커밋되지 않은 수정이 있습니다. 확인 후 다시 배포하세요: $(git status --porcelain --untracked-files=no | head -5 | tr '\n' ' ')"
git fetch --quiet origin
git cat-file -e "${SHA}^{commit}" 2>/dev/null || fail "GitHub에 없는 커밋입니다: $SHA"
git merge-base --is-ancestor "$SHA" origin/main || fail "main에 들어간 커밋만 운영에 배포합니다: $SHA"
PREV="$(git rev-parse HEAD)"
TARGET="$(git rev-parse "$SHA")"
log "현재 $(git rev-parse --short "$PREV") → 배포 $(git rev-parse --short "$TARGET")"
if [ "$PREV" = "$TARGET" ]; then
  log "이미 이 버전입니다. 상태만 확인합니다."
fi

cd "$APP_DIR/server"
DB_PATH="$(sed -n 's/^DB_PATH=//p' .env | tail -1)"
[ -n "$DB_PATH" ] && [ -f "$DB_PATH" ] || fail ".env의 DB_PATH 파일을 찾을 수 없습니다"

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
DB_BACKUP="$BACKUP_DIR/maydin-before-$(git rev-parse --short "$TARGET")-$STAMP.db"
# 서버가 쓰는 중에도 일관된 사본을 만드는 SQLite 백업 API를 쓴다.
node -e "
const Database = require('better-sqlite3');
const src = new Database(process.argv[1], { readonly: true });
src.backup(process.argv[2]).then(() => {
  const copy = new Database(process.argv[2], { readonly: true });
  const ok = copy.pragma('integrity_check', { simple: true });
  if (ok !== 'ok') { console.error('백업 무결성 검사 실패: ' + ok); process.exit(1); }
}).catch((e) => { console.error(e.message); process.exit(1); });
" "$DB_PATH" "$DB_BACKUP" || fail "DB 백업 실패"
chmod 600 "$DB_BACKUP"
cp -p .env "$BACKUP_DIR/env-$STAMP.bak" && chmod 600 "$BACKUP_DIR/env-$STAMP.bak"
log "DB 백업 $DB_BACKUP"
ls -1t "$BACKUP_DIR"/maydin-before-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
ls -1t "$BACKUP_DIR"/env-*.bak 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f

health_ok() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"db":"ok"'; then return 0; fi
    sleep 2
  done
  return 1
}

switch_to() {
  cd "$APP_DIR"
  git checkout --quiet main
  git reset --quiet --hard "$1"
  cd "$APP_DIR/server"
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
}

rollback() {
  log "되돌리는 중: 코드 $(git -C "$APP_DIR" rev-parse --short "$PREV"), DB 백업 복원"
  pm2 stop "$PM2_NAME" >/dev/null 2>&1 || true
  switch_to "$PREV"
  cp -p "$DB_BACKUP" "$DB_PATH"
  rm -f "$DB_PATH-wal" "$DB_PATH-shm"
  pm2 restart "$PM2_NAME" --update-env >/dev/null
  if health_ok; then
    log "이전 버전으로 되돌렸습니다. 서비스 정상."
  else
    log "되돌린 뒤에도 상태 확인 실패. 즉시 직접 확인이 필요합니다: pm2 logs $PM2_NAME"
  fi
  pm2 logs "$PM2_NAME" --lines 30 --nostream 2>&1 | tail -30 || true
  exit 1
}

switch_to "$TARGET" || { log "코드 전환·패키지 설치 실패"; switch_to "$PREV" || true; exit 1; }

# 새 버전의 보안 점검(비밀키·초기 계정·암호문 키)이 통과해야 재시작한다. 통과하지 못하면 서버는 이전 버전 그대로다.
if ! npm run -s security:check; then
  log "보안 점검 실패 — 재시작하지 않고 이전 코드로 돌립니다(실행 중인 서버는 그대로)."
  switch_to "$PREV" || true
  exit 1
fi

pm2 restart "$PM2_NAME" --update-env >/dev/null
if ! health_ok; then
  log "새 버전 상태 확인 실패"
  pm2 logs "$PM2_NAME" --lines 30 --nostream 2>&1 | tail -30 || true
  rollback
fi
pm2 save >/dev/null
log "배포 완료 $(git -C "$APP_DIR" rev-parse --short HEAD) · $(curl -fsS -m 5 "$HEALTH_URL")"
