# 운영 배포

운영 서버: `maydinstore.co.kr` (EC2 `15.164.219.110`, Ubuntu, nginx → `127.0.0.1:3001`, PM2 `maydin-platform`)
앱 위치: `/home/ubuntu/apps/maydin_platform`, DB: `server/data/maydin-platform.db`, 백업: `/home/ubuntu/db-backups`

## 배포하는 방법

GitHub Actions의 **Deploy production**을 수동으로 실행한다. 운영에는 main에 들어간 커밋만 배포된다.

```bash
gh workflow run deploy-production.yml -f ref=main      # 또는 -f ref=<커밋 SHA>
gh run watch                                           # 진행 상황
```

순서:

1. 전체 테스트(`node tests/run.mjs`)를 그 커밋으로 다시 돌린다. 실패하면 배포하지 않는다.
2. GitHub가 OIDC로 AWS 배포 역할을 받아, **SSM Run Command**로 서버에서 그 커밋의 `server/scripts/deploy.sh`를 실행한다. SSH·22번 포트·IP 등록이 필요 없고, 서버 키를 GitHub에 두지 않는다.
3. `deploy.sh`
   - 서버 코드에 커밋 안 된 수정이 있으면 멈춘다.
   - DB(SQLite 백업 API, 무결성 검사)와 `.env`를 `~/db-backups`에 백업한다(최근 20개 보관).
   - 코드를 그 커밋으로 바꾸고 `npm ci --omit=dev`.
   - `npm run security:check`(비밀키·초기 계정·암호문 키)가 통과하지 않으면 **재시작하지 않고** 코드만 원래대로 돌린다. 실행 중인 서버는 그대로다.
   - `pm2 restart` 후 `/api/health`가 `db: ok`가 될 때까지 최대 60초 기다린다.
   - 실패하면 이전 커밋으로 돌리고 **배포 직전 백업 DB를 복원**한 뒤 다시 띄운다(배포 실패로 끝난다).
4. 공개 주소에서 `/api/health`, 주요 화면, 토큰 없는 `/api/auth/me` = 401을 확인한다.

DB 구조 변경(새 열·표)은 서버가 시작할 때 자동으로 적용된다. 되돌릴 때 DB를 백업으로 복원하므로, 실패한 배포 동안(재시작~확인, 1분 이내) 들어온 주문은 사라질 수 있다. 영업 중 배포는 피한다.

## 처음 한 번 설정 (완료 상태는 아래 표)

| 항목 | 내용 |
|---|---|
| EC2 인스턴스 역할 | `maydin-ec2` (`AmazonSSMManagedInstanceCore`) — SSM 에이전트가 명령을 받는다 |
| GitHub OIDC 공급자 | `token.actions.githubusercontent.com` |
| 배포 역할 | `maydin-github-deploy` — `repo:baeshh/maydin_platform:environment:production`만 받을 수 있고, 이 인스턴스에 `AWS-RunShellScript` 보내기·결과 읽기만 허용 |
| GitHub `production` 환경 변수 | `AWS_DEPLOY_ROLE_ARN`, `EC2_INSTANCE_ID`, `APP_URL=https://maydinstore.co.kr` |

배포 전에 사람 승인을 받으려면 GitHub → Settings → Environments → production → Required reviewers를 켠다.

## 직접 확인·복구

```bash
# SSM으로 서버 셸 (session-manager-plugin 필요) — SSH 대신
aws ssm start-session --target <EC2_INSTANCE_ID> --region ap-northeast-2

# 서버에서
pm2 ls && pm2 logs maydin-platform --lines 50
ls -lt ~/db-backups | head
```

수동 복구: PM2를 멈추고(`pm2 stop maydin-platform`), `git reset --hard <이전 SHA>` → `npm ci --omit=dev` → 백업 DB를 `DB_PATH`로 복사(`-wal`, `-shm` 삭제) → `pm2 restart maydin-platform`.
