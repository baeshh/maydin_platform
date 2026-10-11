# MAYDIN POS 구조 (구현 기준)

카운터 화면(`public/pos.html`)과 서버 POS API(`/api/pos`)는 기능별 파일로 나뉘어 있다. 카운터 PC는 **기기 토큰**으로 어느 카운터인지 서버가 정하고, 카드 결제는 **판매를 먼저 서버에 올린 뒤(prepare) 승인(approve) → 확정(confirm)** 순서로만 저장된다. 승인 결과를 모르면 `UNKNOWN`으로 두고 조회(대사)로만 정하며, 절대 자동으로 다시 승인하지 않는다.

> 이 문서는 현재 코드가 하는 일을 적은 것이다. 장애 대응은 [pos-outage-and-backup.md](pos-outage-and-backup.md), Bridge 규격은 [maydin-bridge-spec.md](maydin-bridge-spec.md), 약국 운영 방식(A형·B형)은 [pos-operation-modes.md](pos-operation-modes.md)를 본다.

## 1. 지켜야 할 원칙

- 카드번호·비밀번호·주민번호·간편결제 바코드는 서버에 저장하지 않는다. 현금영수증 식별번호는 가린 값만 남긴다.
- 일반의약품은 대면 현장 판매 기록만 처리한다. 온라인 결제·배송에는 쓰지 않는다.
- 브라우저가 보낸 "승인됨" 문자열만으로 결제를 인정하지 않는다. 서버가 VAN사에서 직접 받았거나, Bridge 서명을 확인했거나, 관리자가 영수증을 보고 정한 것만 인정한다.
- 결과가 불확실한 승인은 `UNKNOWN` → 조회(대사)로만 정한다. 자동 재승인 금지(이중 결제 위험).
- 데모 VAN·데모 Bridge 결제는 화면·영수증에 "(데모)"를 붙인다.

## 2. 파일 배치

### 서버 `server/src/pos/`

| 위치 | 하는 일 |
| --- | --- |
| `index.js` | `/api/pos` 라우터. 로그인·역할(약국 관리자·POS 직원) 확인 뒤 `req.pos = resolveTerminal(req)`로 카운터를 정한다 |
| `common.js` | `PosError(message, status, reason, extra)`, `handle()`(오류를 `{message, reason, ...extra}`로 응답), 감사 기록 등 공용 도구 |
| `routes/` | 화면 단위 API: `context`, `catalog`, `customers`, `sessions`, `sales`, `payments`, `pickups`, `refunds`, `recovery`, `holds`, `inventory`, `counsels`, `reports`, `terminals` |
| `services/` | 판매·결제·환불·영업 세션·카운터·보류·재고 처리. 라우트는 얇게, 규칙은 여기 |
| `integrations/` | VAN 어댑터. `van-adapter.js`(공통 규격) · `manual-adapter.js` · `demo-adapter.js` · `bridge-adapter.js` · `bridge-protocol.js`(서명 규격) · `nice-adapter.js`·`kis-adapter.js`(계약 전 뼈대) |

### 카운터 화면 `server/public/pos/`

클래식 `<script>`로 순서대로 읽고 전역 함수로 서로 부른다. 빌드 단계는 없다.

| 파일 | 하는 일 |
| --- | --- |
| `core.js` | 공통 상수·`state`·모달·화면 도구 |
| `auth.js` | 로그인, `/pos/context` 읽기, 시작(`boot`), 상단 표시 |
| `local-store.js` | 이 기기 보관소(IndexedDB, 안 되면 localStorage) |
| `recovery.js` | 연결 감시, 장애 중 판매 보관·전송, 판매 전송 재시도 |
| `session.js` | 영업 시작·현금 시재·마감 |
| `catalog.js` · `cart.js` · `customer.js` | 상품 검색·바코드, 장바구니, 회원 찾기 |
| `van-bridge.js` | 이 PC의 MAYDIN Bridge 호출(`VanBridge`) |
| `payment.js` | 결제 창: prepare → approve → confirm, 승인 결과 조회·취소 |
| `approvals.js` | 결과 미확정 승인 관리, 수동 승인 대조 |
| `receipt.js` · `refund.js` · `pickup.js` · `hold.js` | 영수증, 취소·반품(Bridge 취소 포함), 픽업 수령, 보류 |
| `inventory.js` · `terminal.js` · `counter.js` · `report.js` | 재고, 카드 결제 방식 설정, 카운터 등록·관리, 리포트 |
| `main.js` | 키보드 단축키·시작 |

`public/pos-sw.js`(서비스 워커)는 위 파일과 `pos.html`·`pos/pos.css`·`app.js` 등 **화면 파일만** 보관해 장애 중에도 화면을 다시 열 수 있게 한다. API 응답은 보관하지 않는다. `pos.html`이 읽는 파일이 바뀌면 `SHELL` 목록과 `CACHE` 이름을 함께 바꾼다(`tests/phase16-pos-offline.test.mjs`가 빠진 파일을 잡는다).

### 파트너센터 화면 `server/public/owner/`

`owner.html`은 마크업만 두고 스크립트·스타일은 기능별 파일로 나눴다: `core`(공통 도구) · `dashboard` · `channels`(가입 경로 QR) · `customers` · `members` · `demand` · `points` · `orders` · `products` · `staff` · `report` · `purchasing` · `main`(로그인·시작), `owner.css`. 상품 일괄 등록은 기존대로 `public/owner-import.js`.

## 3. 카운터(단말기)와 기기 토큰

- 약국은 카운터(`pos_terminals`)를 여러 개 둘 수 있다. 관리자가 카운터 PC에서 "이 PC를 카운터로 등록"하면 서버가 기기 토큰(`pdt_…`)을 한 번만 내려 주고, 서버에는 SHA-256 해시만 남긴다.
- 화면은 모든 요청에 `X-POS-Device` 헤더로 토큰을 보낸다. 서버가 정하는 상태:

| 상태 | 뜻 |
| --- | --- |
| `LEGACY` | 약국이 PC를 하나도 등록하지 않음 → 예전처럼 첫 카운터를 함께 씀(도입 전 호환) |
| `REGISTERED` | 토큰이 맞는 PC |
| `UNREGISTERED` | 등록된 PC가 있는 약국에서 토큰 없는 PC → 판매 불가(428 `TERMINAL_REQUIRED`) |
| `UNKNOWN` | 해제됐거나 다른 약국 토큰 → 화면이 토큰을 지운다 |
| `DISABLED` | 사용 중지된 카운터 |

- 영업 세션·판매·승인·환불은 모두 카운터에 묶인다. 다른 카운터의 승인을 확정·취소하려 하면 403.

## 4. 카드 결제 흐름

```
화면                         서버                                    카드 단말기
 │ POST /pos/sales/prepare    │ pos_sale_drafts(OPEN) 생성
 │ ─────────────────────────▶ │ client_sale_id·요청 내용 해시·금액 고정
 │ POST /pos/payments/approve │ van_transactions(REQUESTED, request_id 고유)
 │ ─────────────────────────▶ │ ─ 서버형(데모·VAN API): 서버가 승인 ─────────▶
 │                            │ ─ Bridge형: bridge_request 응답 ─┐
 │ Bridge /v1/approve ◀───────┼──────────────────────────────────┘ (서명 결과)
 │ POST /payments/approve + bridge_result → 서명·금액·요청 번호 확인
 │ POST /pos/sales/confirm    │ 승인을 USED로, 주문·결제 저장, draft CONFIRMED
```

- **prepare**: 장바구니를 서버에 올린다. 승인이 붙은 뒤에는 상품·금액을 바꿀 수 없다(`DRAFT_LOCKED`).
- **approve**: `request_id`(UUID)로 멱등. 같은 번호로 다시 보내면 처음 결과를 돌려준다. 다른 판매에 쓴 번호면 409 `REQUEST_ID_REUSED`. 응답이 끊기면 화면은 **같은 request_id로** 다시 묻는다.
- **confirm**: 승인 금액 합과 결제 내역이 맞아야 저장한다. 결제에 넣지 않은 승인이 있으면 409 `APPROVAL_UNUSED`.
- **확정 전 취소**: 결제 창을 닫으면 붙은 승인을 취소(`/van/transactions/:id/void`, Bridge는 단말기 취소 결과 필요)하고 draft를 취소한다.
- 픽업 수령도 같은 흐름이다(draft에 `pickup_order_id`, 완료는 `/pickups/:id/complete` + `client_sale_id`).
- 현금·포인트만 있는 판매는 예전처럼 `POST /pos/sales` 한 번으로 저장한다.

### 승인 상태 (`van_transactions.status`)

| 상태 | 뜻 | 다음 |
| --- | --- | --- |
| `REQUESTED` | 요청함, 결과 아직 없음 | 결과 반영 또는 조회 |
| `APPROVED` | 승인됨, 판매에 아직 안 씀 | confirm → `USED`, 취소 → `VOIDED` |
| `UNKNOWN` | 응답 끊김 — 승인됐는지 모름 | **조회(`/payments/reconcile`)로만** 정함 |
| `NOT_FOUND` | 조회해 보니 승인 없음 | 새 승인 요청 가능 |
| `DECLINED` | 거절 | — |
| `USED` · `VOIDED` | 판매에 씀 · 판매 전 취소 | — |

- 조회할 수 없는 방식(수동·계약 전 VAN)은 **약국 관리자만** 단말기 영수증을 보고 "승인됨(승인번호)" 또는 "승인 없음"으로 정한다(`resolution`, 직원은 403).
- 화면 상단의 "승인 확인 필요" 표시(`#approvalChip`)는 이 카운터의 미확정·미사용 승인을 보여 주고, 다시 열어도 이어서 정리할 수 있다(`GET /payments/pending`).

### 결제 확인 상태 (`payments.verify_status`)

| 값 | 뜻 |
| --- | --- |
| `VERIFIED` | 서버가 VAN사·Bridge 서명으로 확인한 결제 |
| `UNVERIFIED` | 승인번호 직접 입력·관리자 확인 — 서버가 확인하지 못함 |
| `MATCHED` · `MISMATCH` | 관리자가 단말기 영수증·VAN 매출 내역과 맞춰 본 결과(다르면 사유 필수) |

### 마감 막기

일마감(`/sessions/:id/close`)은 다음이 남아 있으면 409로 막고, 화면은 해당 정리 창을 연다.

- `VAN_APPROVALS_OPEN`: 이 카운터에 결과 미확정·미사용 승인이 있음
- `MANUAL_APPROVALS_UNCHECKED`: 이 영업의 `UNVERIFIED` 결제를 대조하지 않음(`/payments/unverified`에서 한 건씩 또는 `/payments/verify-matched`로 한 번에)

## 5. 카드 결제 방식(카운터별)

| 모드 | 종류 | 설명 |
| --- | --- | --- |
| `MANUAL` | 수동 | 기존 단말기에서 단독 승인 → 승인번호만 입력. `UNVERIFIED`로 남아 마감 때 대조 |
| `DEMO` | 서버 | VAN 자동 승인 (데모). 실제 돈이 움직이지 않음. 응답 끊김·거절을 흉내 낼 수 있음 |
| `BRIDGE` | Bridge | 카운터 PC의 MAYDIN Bridge가 단말기와 통신, 서버는 서명만 확인 |
| `NICE` · `KIS` | Bridge + 서버 조회 | 계약 전 뼈대. 가맹점 번호·TID·API 키 환경변수가 없으면 고를 수 없음 |

## 6. 이 기기 보관소 (장애 중 판매)

- `local-store.js`가 IndexedDB `maydin_pos`(store `kv`, 키 `약국ID:이름`)에 **장애 중 판매 대기열 · 장애 시작 기록 · 장애 대비 상품 목록**만 둔다. IndexedDB를 못 쓰면 localStorage에 둔다. 예전 버전이 localStorage에 둔 값은 처음 열 때 옮긴다.
- 대기열에는 서버에 다시 보낼 판매 내용과 임시 영수증용 상품명만 남긴다. **고객 이름·카드번호·결제 바코드는 남기지 않는다.** 결제에서 VAN 거래 번호도 뺀다(장애 중에는 단말기 단독 승인만).
- 화면은 메모리 사본을 바로 읽고, 쓰기는 기기 저장이 끝난 뒤에 "보관 완료"를 띄운다. 저장에 실패하면 사본도 되돌리고 종이 장부를 쓰라고 알린다.
- 서버에 저장된 거래는 바로 지우고, 빈 목록·끝난 장애 기록은 키째 지운다.
- 장애 중 다시 열 때 쓰는 로그인 정보(`maydin_pos_ctx`)에는 다른 카운터 목록을 남기지 않는다.

## 7. 시험

`cd server && node tests/run.mjs [이름 일부]` — 임시 DB로 서버를 띄워 `tests/*.test.mjs`를 이름순으로 돈다.

- `phase14-pos-terminals` — 카운터 등록·기기 토큰·카운터별 권한
- `phase15-van` — prepare/approve/confirm, 멱등·잠금, UNKNOWN 대사, 관리자 확인, 수동 대조, 마감 막기, Bridge 서명·재전송·취소, 픽업
- `phase16-pos-offline` — 서비스 워커 파일 목록, 이 기기 보관소(최소 정보·삭제·약국별 분리)
