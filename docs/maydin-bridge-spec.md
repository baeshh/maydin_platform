# MAYDIN Bridge 규격 — `maydin-bridge/1`

MAYDIN Bridge는 **카운터 PC에서 도는 로컬 프로그램**이다. 카드 단말기·VAN Agent와 통신해 승인·취소·조회를 하고, 결과를 카운터마다 발급한 **Bridge 키로 HMAC 서명**해 POS 화면에 돌려준다. POS 화면은 서명된 결과를 서버에 그대로 넘길 뿐이고, **서버가 서명·카운터·요청 번호·금액을 모두 확인한 결과만 결제로 인정한다.** 브라우저가 만든 "승인됨" 문자열은 인정하지 않는다.

> 현재 저장소에는 데모 Bridge(`server/scripts/demo-bridge.js`)만 있다. 실제 단말기용 Bridge는 VAN사 계약·SDK를 받은 뒤 이 규격대로 만든다. 서버 쪽 검증은 `server/src/pos/integrations/bridge-adapter.js`, 서명 규격은 `bridge-protocol.js`, 화면 쪽 호출은 `server/public/pos/van-bridge.js`.

## 1. 구성

```
[카드 단말기] ⇄ [VAN Agent/SDK] ⇄ [MAYDIN Bridge :18181] ⇄ [POS 화면(브라우저)] ⇄ [MAYDIN 서버]
                                   (127.0.0.1에서만 대기)       서명 결과 전달        서명 검증·기록
```

- Bridge는 `127.0.0.1`에서만 연결을 받는다. 기본 주소 `http://127.0.0.1:18181`. 다른 주소를 쓰면 POS 카운터 설정에서 바꾼다(브라우저 localStorage `maydin_bridge_url`).
- 허용한 POS 주소(Origin)에서 온 요청만 받는다. 공개 주소의 POS 화면이 로컬 주소로 요청할 때를 위해 `Access-Control-Allow-Private-Network: true`를 보낸다.
- **카드번호·결제 바코드는 Bridge 밖으로 내보내지도, 저장하지도 않는다.** 거래 기록(journal)에는 요청 번호·금액·승인번호·카드사만 남긴다.

## 2. 연결(페어링)

1. 약국 관리자가 그 카운터 PC의 POS에서 "카드 결제 방식 → MAYDIN Bridge 연동 → Bridge 연결"을 누른다.
2. 화면이 `GET /v1/status`로 Bridge가 켜져 있는지 확인한다.
3. 서버 `POST /api/pos/van/bridge-key`(관리자만)가 32바이트 키(base64url)를 만들어 **암호화해 저장**(`pos_terminals.bridge_key_enc`)하고 한 번만 내려 준다. 다시 발급하면 예전 키는 바로 무효다.
4. 화면이 `POST /v1/pair {terminal_id, bridge_key, server_origin}`로 Bridge에 키를 넣는다. 키는 브라우저에 남기지 않는다.
5. 화면이 카운터 방식을 `BRIDGE`로 저장한다.

Bridge는 한 카운터에만 묶인다. 다른 `terminal_id` 요청은 409로 거절하고, 카운터가 바뀌면 거래 기록을 비운다.

## 3. Bridge HTTP API

모두 JSON. 오류는 `{ "message": "..." }`와 4xx/5xx.

| 요청 | 본문 | 응답 |
| --- | --- | --- |
| `GET /v1/status` | — | `{protocol, paired, terminal_id, device, demo, printer, features}` |
| `POST /v1/pair` | `{terminal_id, bridge_key, server_origin}` | `{paired: true, terminal_id}` |
| `POST /v1/approve` | 승인 요청(아래) | 서명 결과 |
| `POST /v1/cancel` | 승인 요청 + `original_approval_number` | 서명 결과(`transaction_type: CANCEL`) |
| `POST /v1/inquire` | 승인·현금영수증 요청 | 서명 결과(`APPROVED`/`DECLINED`/`NOT_FOUND`) |
| `POST /v1/cash-receipt` | 현금영수증 발급·취소 요청([§10](#10-현금영수증)) | 서명 결과(`CASH_RECEIPT`/`CASH_RECEIPT_CANCEL`) |
| `POST /v1/print` | 출력 요청([§11](#11-영수증-프린터-직접-출력)) | 서명 결과(`transaction_type: PRINT`) |
| `POST /v1/print/status` | `{job_id}` | 그 작업의 마지막 서명 결과 또는 `{status: NOT_FOUND}` |
| `GET /v1/printer/status` | — | `{state, message, detail}` (`READY`·`PAPER_NEAR_END`·`PAPER_OUT`·`COVER_OPEN`·`OFFLINE`·`UNKNOWN`·`NOT_CONFIGURED`) |

### 요청 (서버가 만들어 화면이 그대로 전달)

```json
{
  "protocol": "maydin-bridge/1",
  "terminal_id": 3,
  "request_id": "7f0c2e0a-5b1d-4f7e-9c2a-1d3b4e5f6a7b",
  "transaction_type": "APPROVE",
  "method": "CARD",
  "amount": 12000,
  "installment_months": 0
}
```

- `request_id`: 영문·숫자·하이픈 16~64자. **같은 request_id는 다시 승인하지 않고 처음 결과를 돌려준다**(Bridge는 journal로 멱등을 지켜야 한다).
- `method`: `CARD` 또는 `EASY_PAY`. 간편결제 바코드는 화면 → Bridge로만 가고 서버에는 가지 않는다.
- 승인 요청은 서버 `POST /api/pos/payments/approve` 응답의 `bridge_request`, 조회 요청은 `/payments/reconcile`의 409 `BRIDGE_RESULT_REQUIRED` 응답, 취소 요청은 409 `VAN_CANCEL_REQUIRED` 응답(`bridge_request` 또는 `cancels[]`)에 들어 있다. 취소 요청의 `request_id`는 화면이 새로 만든다.

### 결과 (Bridge가 서명)

```json
{
  "protocol": "maydin-bridge/1",
  "terminal_id": 3,
  "request_id": "7f0c2e0a-5b1d-4f7e-9c2a-1d3b4e5f6a7b",
  "transaction_type": "APPROVE",
  "status": "APPROVED",
  "method": "CARD",
  "amount": 12000,
  "installment_months": 0,
  "approval_number": "30012345",
  "original_approval_number": null,
  "card_company": "신한카드",
  "van_reference": "BRG-7f0c2e0a",
  "occurred_at": "2026-10-11T06:31:12.000Z",
  "demo": false,
  "message": "승인 완료",
  "signature": "hex…"
}
```

| `status` | 뜻 |
| --- | --- |
| `APPROVED` | 승인(취소 요청이면 취소 완료). `approval_number` 필수(영문·숫자·하이픈 4~20자) |
| `DECLINED` | 카드사 거절 |
| `UNKNOWN` | 단말기 응답 없음 — 승인됐는지 모름 |
| `NOT_FOUND` | 조회 결과 그 요청의 승인 없음 |

## 4. 서명

```
서명 대상 = "maydin-bridge/1" 과 아래 필드 값을 이 순서대로 "\n"으로 이은 문자열
  terminal_id, request_id, transaction_type, status, method, amount, installment_months,
  approval_number, original_approval_number, card_company, van_reference, occurred_at, demo,
  purpose, identity_type, masked_identity, original_approved_at, cancel_reason,
  error_code, document_hash
  (없는 값·null은 빈 문자열, 나머지는 String(값))
signature = hex( HMAC-SHA256( base64url_decode(bridge_key), 서명 대상 ) )
```

`message`는 서명 대상이 아니다(표시용, 서버가 200자로 자른다).

## 5. 서버가 확인하는 것

결과 하나라도 맞지 않으면 400 `BRIDGE_RESULT_INVALID`로 거절하고 결제로 인정하지 않는다.

1. 서명이 이 카운터의 Bridge 키와 맞는다(상수 시간 비교).
2. `terminal_id` = 요청한 카운터, `request_id`·`transaction_type`·`method`·`amount`가 서버가 만든 요청과 같다. 취소면 `original_approval_number`도 같다.
3. `status`가 네 값 중 하나, `occurred_at`이 미래로 5분 넘게 앞서지 않는다(카운터 PC 시계 확인).
4. `APPROVED`면 승인번호 형식이 맞다.
5. 같은 취소 결과(`request_id`)를 두 번 반영하지 않는다(409 `REQUEST_ID_REUSED`).

`demo: true`인 결과는 개발·스테이징 서버에서만 데모 결제로 기록되어 화면·영수증에 "(데모)"가 붙는다. 운영 서버(`NODE_ENV=production`)는 데모 승인을 거절(`DECLINED`)로 남기고, 실제 승인을 데모 취소로 환불하는 것도 막는다(409 `TEST_PAYMENTS_DISABLED`). 정책은 [payment-test-policy.md](payment-test-policy.md).

## 6. 응답이 끊겼을 때

- 화면은 승인 요청을 90초 기다린다. 끊기면 **같은 request_id로 `/v1/inquire`**를 불러 결과를 서버 `/payments/reconcile`에 넘긴다. 다시 승인하지 않는다.
- Bridge가 조회에도 답하지 못하면 승인은 `UNKNOWN`/`REQUESTED`로 남고 마감이 막힌다. 약국 관리자가 단말기 영수증을 보고 "승인됨(승인번호)" 또는 "승인 없음"으로 정한다.
- Bridge가 꺼져 있으면 화면은 "이 PC의 MAYDIN Bridge에 연결할 수 없습니다"를 띄운다. 이때 카드는 기존 단말기에서 단독 승인하고 카운터 방식을 수동으로 바꿔 승인번호를 입력한다(마감 때 대조).

## 7. 취소·환불

- **판매 확정 전**: 결제 창을 닫거나 승인을 지우면 화면이 `/v1/cancel`로 단말기 취소 → 서명 결과를 `/van/transactions/:id/void`에 보낸다.
- **판매 확정 후(취소·반품)**: 서버가 409 `VAN_CANCEL_REQUIRED`와 필요한 취소 목록(`cancels[]`)을 준다. 화면이 각각 `/v1/cancel`을 부른 뒤 `van_cancels: [{original_approval_number, bridge_result}]`를 붙여 다시 보낸다. 화면은 취소 요청 번호를 기억해 두어 재시도 때 같은 번호를 쓴다(이중 취소 방지).

## 8. 데모 Bridge 쓰기

```bash
cd server
npm run bridge:demo        # http://127.0.0.1:18181
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `BRIDGE_PORT` | `18181` | 대기 포트 |
| `BRIDGE_STORE` | `data/demo-bridge.json` | 키·거래 기록 파일(권한 600, git 제외) |
| `BRIDGE_ALLOWED_ORIGINS` | `http://localhost:3001,http://127.0.0.1:3001` | 허용 POS 주소(쉼표 구분) |
| `BRIDGE_SIMULATE` | — | 모든 승인에 `DECLINE` · `TIMEOUT_APPROVED`(승인 후 응답 끊김) · `TIMEOUT_NOT_APPROVED`(승인 없이 끊김) |
| `BRIDGE_PRINTER` | `file:<BRIDGE_STORE 폴더>/bridge-prints` | 영수증 프린터. `tcp://192.168.0.50:9100` · `device:/dev/usb/lp0` · `file:/폴더` |
| `BRIDGE_PRINTER_COLUMNS` | `42` | 한 줄 칸 수(80mm 42, 58mm 32) |
| `BRIDGE_PRINTER_ENCODING` | `cp949` | 한글 인코딩 |

`file:` 프린터는 ESC/POS 바이트(`.bin`)와 사람이 읽는 미리보기(`.txt`)를 함께 저장한다.

다음 한 건만 흉내 내려면:

```bash
curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"next":"TIMEOUT_APPROVED"}'
# 다음 출력 한 번 실패: PAPER_OUT · COVER_OPEN · OFFLINE, 출력 후 응답 끊김: HANG
curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"next_print":"PAPER_OUT"}'
# 다음 현금영수증에서 고객이 단말기 키패드에 누를 번호
curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"keypad_identity":"01012345678"}'
```

`GET /v1/demo/prints`는 작업 번호별 실제 출력 횟수를 돌려준다(중복 출력 확인용).

데모 Bridge 결과는 항상 `demo: true`다. 개발·스테이징 서버에서는 "(데모)" 표시와 함께 판매로 저장되어 매출·재고에 잡히므로, 운영 DB에는 연결하지 않는다(운영 서버는 거절한다).

## 9. 실제 Bridge를 만들 때 지킬 것

- 이 문서의 요청·결과·서명 규격과 멱등(같은 request_id → 같은 결과)을 그대로 지킨다.
- 응답을 못 받았으면 `UNKNOWN`으로 돌려주고, 조회 요청에는 VAN Agent의 거래 조회로 답한다. 스스로 재승인하지 않는다.
- Bridge 키는 OS 보호 저장소(Windows DPAPI 등)에 둔다. 카드번호·바코드·서명 이미지는 저장하지 않는다.
- `127.0.0.1`에서만 대기하고 허용 Origin을 설정으로 받는다.
- NICE·KIS 등 서버 조회 API가 있는 VAN은 Bridge 결과를 받은 뒤 서버가 한 번 더 조회하도록 어댑터(`nice-adapter.js`·`kis-adapter.js`)를 채운다. 필요한 것: 가맹점 번호, 카운터별 TID, 거래 조회 API 인증키, VAN Agent 연동 규격서.
- 실제 Bridge 결과에는 `demo`를 넣지 않는다(또는 `false`).
- 현금영수증 식별번호(휴대폰·사업자·현금영수증카드 번호)는 VAN Agent에만 넘기고 저장·기록하지 않는다. 결과에는 가린 번호만 담는다.
- 출력 기록(journal `print:<job_id>`)은 작업 번호·상태·해시만 남기고 영수증 내용은 남기지 않는다.
- 운영에 켜기 전에 [pos-field-verification.md](pos-field-verification.md)의 실물 단말기 검증을 모두 통과해야 한다.

## 10. 현금영수증

판매를 저장한 **뒤** 그 판매의 현금·계좌이체 금액으로 발급한다. 금액·공급가액·부가세·면세 금액은 서버가 판매 품목(반품분 제외)과 과세 구분으로 계산하며 화면이 바꿀 수 없다.

### 흐름

1. 화면 → 서버 `POST /api/pos/sales/:id/cash-receipt {request_id, purpose, identity_input}`
   - `purpose`: `INCOME`(소득공제) · `EXPENSE`(지출증빙)
   - `identity_input`: `TERMINAL`(고객이 단말기 키패드로 입력) · `POS`(직원이 화면에 입력) · `SELF`(자진발급, 소득공제만)
   - Bridge 카운터에서 본문에 `identity`(번호)를 넣으면 400. **번호는 서버로 보내지 않는다.**
2. 서버가 `REQUESTED` 기록을 남기고 `bridge_request`를 돌려준다.
3. 화면 → Bridge `POST /v1/cash-receipt` (직원 입력이면 이때만 `identity`를 붙인다)
4. 화면 → 서버 같은 주소에 `{...같은 본문, bridge_result}` → 서버가 검증해 판매에 연결(`USED`)하고 결제의 현금영수증 번호를 채운다.

### 발급 요청 (서버가 만듦)

```json
{
  "protocol": "maydin-bridge/1",
  "terminal_id": 3,
  "request_id": "0d4b…",
  "transaction_type": "CASH_RECEIPT",
  "method": "CASH",
  "amount": 16000,
  "supply_amount": 10000,
  "vat_amount": 1000,
  "tax_free_amount": 5000,
  "purpose": "INCOME",
  "identity_input": "TERMINAL"
}
```

### 결과 (Bridge가 서명) — 카드 결과에 아래 필드가 더해진다

| 필드 | 값 |
| --- | --- |
| `purpose` | 요청과 같아야 한다 |
| `identity_type` | `PHONE` · `BUSINESS` · `CARD` · `SELF` |
| `masked_identity` | **가린 번호만.** `010-****-5678` · `123-**-***90` · `****-****-****-5678`. 자진발급은 `010-000-1234` 그대로 |

서버는 `APPROVED` 결과의 `masked_identity`에 `*`가 없거나 숫자가 8자리 넘게 보이면 거절한다. 13자리 숫자(주민등록번호 형태)는 Bridge·데모 모두 식별번호로 받지 않는다.

### 취소 (반품·판매 취소)

현금·계좌이체를 돌려주는 반품·취소에서 발급된 현금영수증이 있으면, 서버는 409 `CASH_RECEIPT_CANCEL_REQUIRED`와 `cash_receipt_cancels[]`를 준다. 금액이 바뀌므로 **원래 현금영수증 전체를 취소**하고, 남은 금액은 다시 발급한다(응답의 `cash_receipt_reissue`).

```json
{
  "transaction_type": "CASH_RECEIPT_CANCEL",
  "method": "CASH",
  "amount": 16000,
  "purpose": "INCOME",
  "original_approval_number": "06417502",
  "original_approved_at": "20261012",
  "cancel_reason": "1"
}
```

- `cancel_reason`: `1` 거래취소 · `2` 오류발급 · `3` 기타. 반품은 `1`.
- 화면이 `request_id`를 만들어 `/v1/cash-receipt`를 부르고, 결과를 `cash_receipt_cancels: [{original_approval_number, bridge_result}]`로 붙여 반품 요청을 다시 보낸다. 카드 취소(`van_cancels`)와 함께 올 수 있다.
- 취소 결과가 `APPROVED`가 아니면 반품을 저장하지 않는다(409 `VAN_CANCEL_FAILED`).
- 수동 승인 카운터에서 적어 둔 현금영수증은 서버가 취소 기록만 남기고 "기존 단말기에서 직접 취소" 안내를 돌려준다.

### 응답이 끊겼을 때

- 화면은 90초 기다린다(고객 키패드 입력 시간 포함). 끊기면 그 발급은 `REQUESTED`로 남아 「승인 정리」 목록에 나오고, **같은 판매에 새 발급을 막는다**(409 `CASH_RECEIPT_PENDING`, 이중 발급 방지). 마감도 막힌다.
- 「승인 정리」에서 조회하면 서버가 409 `BRIDGE_RESULT_REQUIRED`와 조회 요청(`transaction_type: CASH_RECEIPT`)을 주고, 화면이 Bridge `/v1/inquire` 결과를 `/payments/reconcile`에 넘긴다. 발급돼 있으면 판매에 연결, `NOT_FOUND`면 새로 발급할 수 있다.
- Bridge가 답하지 못하면 약국 관리자가 단말기 영수증을 보고 "발급됨(승인번호)" 또는 "발급 안 됨"으로 정한다.

| 서버 오류 | 뜻 |
| --- | --- |
| 400 | 용도·입력 방법 오류, 현금·계좌이체 금액 없음, Bridge 카운터에 번호를 보냄 |
| 402 `VAN_DECLINED` | 국세청·VAN 거절 (기록은 `DECLINED`로 남음) |
| 409 `CASH_RECEIPT_EXISTS` | 이미 발급한 판매 — 바꾸려면 반품·취소 후 재발급 |
| 409 `CASH_RECEIPT_PENDING` | 결과 모르는 발급이 있음 — 조회 먼저 |
| 409 `REQUEST_ID_REUSED` | 다른 판매에 쓴 요청 번호 |

## 11. 영수증 프린터 직접 출력

브라우저 인쇄(`window.print()`) 대신 Bridge가 영수증 프린터(ESC/POS)로 바로 보내 **용지 절단·돈통 열기·상태 확인**까지 한다. 카운터별로 고른다(카운터 관리 → 영수증 프린터).

| 출력 방법 | 동작 |
| --- | --- |
| `BROWSER` | 지금처럼 브라우저 인쇄. 서버는 출력 기록만 남긴다 |
| `BRIDGE` | 서버가 만든 영수증 문서를 Bridge가 프린터로 출력. Bridge가 연결된 카운터만 켤 수 있다 |

옵션: `auto_print`(결제가 끝나면 자동 출력), `open_drawer`(현금이 오간 판매의 **첫 원본 출력**에서만 돈통 열기 — 재출력·재시도에는 열지 않는다).

### 흐름

1. 화면 → 서버 `POST /api/pos/sales/:id/print {channel}` → 출력 작업(`job_id`, UUID)과 `bridge_request`. 이미 출력한 판매면 `copy_type: REPRINT`(영수증 제목 아래 "[재출력] 시각" 표시).
2. 화면 → Bridge `POST /v1/print` (30초 대기)
3. 화면 → 서버 `POST /api/pos/print-jobs/:jobId/result {bridge_result}`

### 출력 요청 (서버가 만듦)

```json
{
  "protocol": "maydin-bridge/1",
  "terminal_id": 3,
  "job_id": "9d2057f5-c598-44cc-b8a6-75adfa116e22",
  "transaction_type": "PRINT",
  "document": { "version": 1, "kind": "RECEIPT", "copy_type": "ORIGINAL", "open_drawer": true, "cut": true, "lines": [ … ] },
  "document_hash": "sha256(JSON.stringify(document)) hex"
}
```

`document.lines` 종류: `text{text, align, bold, size}` · `pair{left, right}` · `rule{char}` · `barcode{data}`(CODE128) · `qr{data}` · `feed{lines}`. Bridge는 칸 수(80mm 42칸·58mm 32칸)에 맞춰 줄을 바꾸고(한글 2칸), CP949로 인코딩하고, 끝에 용지 이송·부분 절단(`ESC d 4`, `GS V 66 0`)을 붙인다. `open_drawer`면 맨 앞에 돈통 열기(`ESC p 0 25 250`).

### 결과 (Bridge가 서명)

`request_id = job_id`, `transaction_type = PRINT`, `status = PRINTED | FAILED`, `error_code`, `document_hash`(Bridge가 받은 문서로 직접 계산). 서버는 해시가 그 작업에 보낸 문서와 같아야 인정한다.

- 출력 전에 프린터 상태를 조회한다(TCP 9100이면 `DLE EOT 1·2·4`). `PAPER_OUT`·`COVER_OPEN`·`OFFLINE`이면 **보내지 않고** `FAILED`. 출력 뒤 다시 조회해 중간에 용지가 떨어졌는지 확인한다. `PAPER_NEAR_END`는 출력하되 알린다.
- **같은 `job_id`는 한 번만 출력한다.** 이미 `PRINTED`면 다시 뽑지 않고 처음 결과를 돌려준다. 출력 중에 같은 작업이 또 오면 409.
- 응답이 끊기면 화면은 `/v1/print/status`로 확인한다. 기록이 없으면 출력 실패로 본다.

### 실패 대응 (화면)

출력이 실패하면 「영수증 출력 실패」 창: **다시 출력**(같은 작업 번호 → 중복 출력 없음) · **브라우저로 인쇄** · **출력 안 함** · **나중에**. 뽑지 못한 영수증은 상단 「미출력 영수증 N건」에 남는다(최근 2일).

| 서버 주소 | 쓰임 |
| --- | --- |
| `POST /print-jobs/:jobId/retry` | 같은 작업 다시 보내기(이미 출력됐으면 409 `ALREADY_PRINTED`) |
| `POST /print-jobs/:jobId/browser` | 브라우저 인쇄로 대신 — 영수증 데이터를 돌려주고 작업은 출력 완료로 기록 |
| `POST /print-jobs/:jobId/skip` | 출력 안 함(고객이 영수증을 원하지 않음) |
| `GET /print-jobs/open` | 미출력 목록 |
| `POST /printer/test` | 시험 출력 |
| `PATCH /printer/settings` | 출력 방법·자동 출력·돈통(약국 관리자만) |

재출력·출력 실패·브라우저 대체·출력 안 함·설정 변경은 감사 기록에 남는다.
