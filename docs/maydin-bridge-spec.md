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
| `GET /v1/status` | — | `{protocol, paired, terminal_id, device, demo}` |
| `POST /v1/pair` | `{terminal_id, bridge_key, server_origin}` | `{paired: true, terminal_id}` |
| `POST /v1/approve` | 승인 요청(아래) | 서명 결과 |
| `POST /v1/cancel` | 승인 요청 + `original_approval_number` | 서명 결과(`transaction_type: CANCEL`) |
| `POST /v1/inquire` | 승인 요청 | 서명 결과(`APPROVED`/`DECLINED`/`NOT_FOUND`) |

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
  approval_number, original_approval_number, card_company, van_reference, occurred_at, demo
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

`demo: true`인 결과는 데모 결제로 기록되어 화면·영수증에 "(데모)"가 붙는다.

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

다음 한 건만 흉내 내려면:

```bash
curl -X POST localhost:18181/v1/demo/simulate -H 'Content-Type: application/json' -d '{"next":"TIMEOUT_APPROVED"}'
```

데모 Bridge 결과는 항상 `demo: true`라 실제 결제로 기록되지 않는다.

## 9. 실제 Bridge를 만들 때 지킬 것

- 이 문서의 요청·결과·서명 규격과 멱등(같은 request_id → 같은 결과)을 그대로 지킨다.
- 응답을 못 받았으면 `UNKNOWN`으로 돌려주고, 조회 요청에는 VAN Agent의 거래 조회로 답한다. 스스로 재승인하지 않는다.
- Bridge 키는 OS 보호 저장소(Windows DPAPI 등)에 둔다. 카드번호·바코드·서명 이미지는 저장하지 않는다.
- `127.0.0.1`에서만 대기하고 허용 Origin을 설정으로 받는다.
- NICE·KIS 등 서버 조회 API가 있는 VAN은 Bridge 결과를 받은 뒤 서버가 한 번 더 조회하도록 어댑터(`nice-adapter.js`·`kis-adapter.js`)를 채운다. 필요한 것: 가맹점 번호, 카운터별 TID, 거래 조회 API 인증키, VAN Agent 연동 규격서.
