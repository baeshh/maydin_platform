# 운영 보안 설정 · 초기 계정 점검

운영 서버는 `NODE_ENV=production`으로 띄운다. 이때 서버(`npm start`)와 DB 초기화(`npm run init-db`)는 아래를 지키지 않으면 **시작하지 않는다**.

| 조건 | 막는 이유 |
| --- | --- |
| `JWT_SECRET`이 있고 32자 이상, 개발용 값(`dev-secret-change-me` 등)이 아님 | 개발용 값은 저장소에 공개돼 있어 누구나 관리자 토큰을 만들 수 있다 |
| `DATA_ENCRYPTION_KEY`가 64자리 hex | 예전에는 없으면 JWT_SECRET(또는 공개된 개발용 값)에서 키를 만들었다 |
| 지금 키로 DB의 기존 암호문을 풀 수 있음 | 다른 키로 띄우면 새 암호문과 옛 암호문이 섞여 한쪽을 영영 못 읽는다 |
| 초기 계정 `admin@maydin.kr`·`owner@apharmacy.kr`이 공개된 비밀번호로 활성 상태가 아님 | 비밀번호가 저장소에 공개돼 있다 |
| 스테이징 DB를 운영으로, 운영 DB를 스테이징(`MAYDIN_STAGING=true`)으로 띄우지 않음 | 시험 결제가 실제 매출·재고에 섞인다([payment-test-policy.md](payment-test-policy.md)) |

데모 약국(A001)이나 데모·테스트 결제가 남아 있으면 시작은 하되 경고를 남긴다. 운영 서버는 데모 VAN, 데모 Bridge, 데모 결제사, 결제사 테스트 키를 받지 않는다. 개발·테스트(`NODE_ENV`가 production이 아님)에서는 예전처럼 개발용 값과 데모 데이터를 쓴다.

## 새 운영 DB 만들기

```bash
cd server
cp .env.example .env      # JWT_SECRET, DATA_ENCRYPTION_KEY, INITIAL_ADMIN_* 채우기
npm run init-db           # 데모 약국·계정·상품은 만들지 않고, 활성 관리자가 없으면 INITIAL_ADMIN_*로 하나 만든다
# INITIAL_ADMIN_PASSWORD를 .env에서 지운다
npm start
```

- 관리자 비밀번호는 12자 이상, 영문·숫자 포함, 공개된 초기 비밀번호(`admin1234`·`owner1234`) 금지.
- 약국을 만들 때 운영자 임시 비밀번호를 반드시 정해야 한다(예전에는 비우면 `owner1234`). 직원 비밀번호도 공개된 값은 받지 않는다.
- 로그인 화면(`pos.html`·`owner.html`·`admin.html`)에 미리 채워 두던 계정·비밀번호는 지웠다.

## 이미 운영 중인 DB 점검

운영 서버에서(운영 `.env`로) 실행한다. DB는 읽기 전용으로 연다. 비밀키 값은 출력하지 않는다.

```bash
npm run security:check                                  # 기본 DB (DB_PATH)
npm run security:check -- --db /경로/백업.db --db ...    # 백업 파일도 함께
```

| 결과 | 할 일 |
| --- | --- |
| `JWT_SECRET 없음`/개발용 값 | 새 무작위 값을 넣는다. 기존 로그인 토큰은 모두 무효가 되어 다시 로그인한다 |
| `DATA_ENCRYPTION_KEY 없음` | **새 키를 만들지 말고** `npm run security:check -- --print-legacy-data-key`가 보여 주는 지금까지의 키를 넣는다. 그다음 JWT_SECRET을 바꿔도 암호문은 그대로 읽힌다 |
| `초기 계정 … 공개된 비밀번호 그대로` / `알려진 초기 비밀번호를 씁니다` | `npm run security:check -- --disable-default-accounts`로 사용 중지(감사 기록 `SECURITY_DISABLE_DEFAULT_ACCOUNT`). 관리자가 하나도 안 남으면 `INITIAL_ADMIN_*`를 넣고 `npm run init-db`로 새 관리자를 만든다. 약국 운영자는 관리자 화면에서 새 계정으로 다시 만든다 |
| `데모 약국 A001 있음` | 실제 약국이 아니면 주문·회원이 없는지 확인한 뒤 정리한다(자동 삭제하지 않음) |
| `데모·테스트 결제가 매출·재고에 잡혀 있음` | [payment-test-policy.md](payment-test-policy.md)의 정리 절차대로 약국과 확인해 취소·환불하거나 남겨 둔 사유를 기록한다(DB에서 직접 지우지 않음) |

순서: **키 넣기 → 점검 → 계정 사용 중지 → 다시 점검(문제 없음) → `NODE_ENV=production`으로 시작.** 백업 파일에도 초기 계정이 들어 있으므로, 그 백업으로 복구하면 같은 점검을 다시 한다(운영 모드 복구 훈련은 초기 계정이 살아 있으면 서버가 뜨지 않아 실패로 기록된다).
