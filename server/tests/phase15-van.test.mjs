import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { api, check, done, login } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);
const { sign } = require('../src/pos/integrations/bridge-protocol.js');

const owner = await login('owner@apharmacy.kr', 'owner1234');
const staffEmail = `van-staff-${process.pid}@test.kr`;
await api('/staff', { token: owner, method: 'POST', body: { name: '승인직원', email: staffEmail, password: 'staff1234a' } });
const staff = await login(staffEmail, 'staff1234a');

const pos = (token = owner) => (path, body, method = body === undefined ? 'GET' : 'POST') => api(`/pos${path}`, { token, method, body });
const o = pos(owner);
const s = pos(staff);

const productId = db
  .prepare("INSERT INTO products (pharmacy_id, product_name, price, stock_quantity, status, product_type) VALUES (1, 'VAN 테스트 상품', 10000, 100, 'ON_SALE', 'GENERAL')")
  .run().lastInsertRowid;
const items = (quantity = 1) => [{ product_id: productId, quantity }];
const prepare = (cid, quantity = 1) => o('/sales/prepare', { client_sale_id: cid, items: items(quantity) });
const approve = (cid, body, token = owner) => pos(token)('/payments/approve', { client_sale_id: cid, request_id: randomUUID(), method: 'CARD', amount: 10000, ...body });
const card = (tx, amount = 10000) => [{ method: 'CARD', amount, van_transaction_id: tx.id }];
const confirm = (cid, payments) => o('/sales/confirm', { client_sale_id: cid, payments });
const paymentOf = (orderId) => db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(orderId);

let session = (await o('/sessions/current')).data.session;
if (!session) session = (await o('/sessions/open', { opening_cash: 0 })).data.session;
const terminal = (await o('/van/terminal')).data.terminal;
const originalMode = db.prepare('SELECT van_mode FROM pos_terminals WHERE id = ?').get(terminal.id).van_mode;
const setMode = (mode) => o('/van/terminal', { van_mode: mode }, 'PATCH');

try {
  let res = await setMode('DEMO');
  check('데모 승인 켜기', res.status === 200 && res.data.van.mode === 'DEMO' && res.data.van.is_demo === true, res.data);

  console.log('[① 결제 전 판매 등록 → ② 승인 → ③ 확정]');
  const cid1 = randomUUID();
  let tx1;
  let order1;
  {
    res = await o('/sales/prepare', { items: items() });
    check('거래 고유번호 없으면 거절', res.status === 400, res.data);
    res = await prepare(cid1, 2);
    check('판매 등록 — 서버가 금액 계산', res.status === 201 && res.data.draft?.amount === 20000 && res.data.draft.status === 'OPEN', res.data);
    res = await prepare(cid1, 1);
    check('승인 전에는 상품 바꿀 수 있음', res.status === 201 && res.data.draft.amount === 10000, res.data);

    const requestId = randomUUID();
    res = await approve(cid1, { request_id: requestId });
    tx1 = res.data.van_transaction;
    check('데모 승인 201', res.status === 201 && tx1?.status === 'APPROVED' && tx1.source === 'SERVER' && tx1.is_demo === true && /^\d{8}$/.test(tx1.approval_number), res.data);
    res = await approve(cid1, { request_id: requestId });
    check('같은 요청 번호 재전송 → 다시 승인 안 함', res.status === 200 && res.data.duplicate === true && res.data.van_transaction.id === tx1.id, res.data);
    check('승인 기록은 한 건', db.prepare('SELECT COUNT(*) AS n FROM van_transactions WHERE request_id = ?').get(requestId).n === 1);
    res = await approve(cid1, { request_id: requestId, amount: 5000 });
    check('같은 요청 번호로 다른 금액 → 409', res.status === 409 && res.data.reason === 'REQUEST_ID_REUSED', res.data);
    res = await approve(cid1, { amount: 1000 });
    check('승인 합계가 판매 금액 초과 → 거절', res.status === 400, res.data);
    res = await approve(cid1, { request_id: 'short' });
    check('요청 번호 형식 검사', res.status === 400, res.data);
    res = await prepare(cid1, 3);
    check('승인 뒤 상품 변경 → 409 DRAFT_LOCKED', res.status === 409 && res.data.reason === 'DRAFT_LOCKED', res.data);

    res = await confirm(cid1, [{ method: 'CASH', amount: 10000 }]);
    check('받은 승인을 안 넣고 확정 → 409 APPROVAL_UNUSED', res.status === 409 && res.data.reason === 'APPROVAL_UNUSED', res.data);
    res = await confirm(cid1, [{ method: 'CARD', amount: 10000, approval_number: '99998888' }]);
    check('승인 없이 승인번호만 적은 카드 → 거절', res.status === 400, res.data);
    res = await confirm(cid1, card(tx1));
    order1 = res.data.order;
    check('확정 201', res.status === 201 && order1?.final_amount === 10000, res.data);
    const [payment] = paymentOf(order1.id);
    check('결제 = 데모 VAN · 서버 확인', payment.payment_provider === 'VAN_DEMO' && payment.verify_status === 'VERIFIED' && payment.approval_number === tx1.approval_number, payment);
    const draft = db.prepare('SELECT * FROM pos_sale_drafts WHERE client_sale_id = ?').get(cid1);
    check('끝난 판매 초안은 상품 목록 지움', draft.status === 'CONFIRMED' && draft.order_id === order1.id && draft.request_json === null, draft);
    res = await confirm(cid1, card(tx1));
    check('확정 재전송 → 같은 주문(중복 저장 없음)', res.status === 200 && res.data.duplicate === true && res.data.order.id === order1.id, res.data);
    res = await o(`/sales/by-client-id/${cid1}`);
    check('거래 고유번호 조회 = 저장됨', res.data.status === 'SAVED' && res.data.order?.order.id === order1.id, res.data);
    res = await o(`/sales/by-client-id/${randomUUID()}`);
    check('없는 거래 = NOT_FOUND', res.data.status === 'NOT_FOUND', res.data);
    res = await o('/sales', { client_sale_id: randomUUID(), items: items(), payments: card(tx1) });
    check('이미 쓴 승인은 다른 판매에 못 씀', res.status === 409, res.data);
  }

  console.log('[응답 끊김 — VAN사에선 승인됨 → 대사로 승인 확인]');
  {
    const cid = randomUUID();
    await prepare(cid);
    const requestId = randomUUID();
    res = await approve(cid, { request_id: requestId, simulate: 'TIMEOUT_APPROVED' });
    const tx = res.data.van_transaction;
    check('결과 모름 202 UNKNOWN', res.status === 202 && tx?.status === 'UNKNOWN' && tx.approval_number === null, res.data);
    res = await approve(cid, {});
    check('결과 모르는 승인이 있으면 새 승인 막음(이중 결제 방지)', res.status === 409 && res.data.reason === 'APPROVAL_PENDING', res.data);
    res = await confirm(cid, card(tx));
    check('결과 모르는 채로 확정 불가', res.status === 409 && res.data.reason === 'APPROVAL_PENDING', res.data);
    res = await o(`/sales/drafts/${cid}/cancel`, {});
    check('결과 모르는 판매는 취소도 막음', res.status === 409 && res.data.reason === 'DRAFT_LOCKED', res.data);
    res = await o(`/van/transactions/${tx.id}/void`, {});
    check('결과 모르는 승인은 취소 대신 조회 먼저', res.status === 409, res.data);
    res = await o('/payments/pending');
    check('정리할 승인 목록에 보임', res.data.approvals.some((a) => a.id === tx.id), res.data);
    res = await o(`/sessions/${session.id}/close`, { actual_cash: 0 });
    check('정리 안 된 승인이 있으면 마감 불가', res.status === 409 && res.data.reason === 'VAN_APPROVALS_OPEN', res.data);

    res = await o('/payments/reconcile', { request_id: requestId });
    const fixed = res.data.van_transaction;
    const ledger = db.prepare('SELECT * FROM van_demo_ledger WHERE request_id = ?').get(requestId);
    check('대사 → VAN사 기록대로 승인', res.status === 200 && fixed.status === 'APPROVED' && fixed.approval_number === ledger.approval_number, res.data);
    check('대사는 다시 승인하지 않음(VAN사 기록 1건)', db.prepare('SELECT COUNT(*) AS n FROM van_demo_ledger WHERE request_id = ?').get(requestId).n === 1);
    res = await o('/payments/reconcile', { request_id: requestId });
    check('끝난 승인은 다시 대사해도 그대로', res.data.unchanged === true, res.data);
    res = await confirm(cid, card(fixed));
    check('대사로 확인된 승인으로 확정', res.status === 201, res.data);
    check('서버 조회로 확인 = 대조 불필요', paymentOf(res.data.order.id)[0].verify_status === 'VERIFIED');
    check('대사 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_VAN_RECONCILE' AND target_id = ?").get(tx.id)));
  }

  console.log('[응답 끊김 — VAN사에 안 닿음 → 미승인 확인 후 다시 승인]');
  {
    const cid = randomUUID();
    await prepare(cid);
    const requestId = randomUUID();
    res = await approve(cid, { request_id: requestId, simulate: 'TIMEOUT_NOT_APPROVED' });
    check('결과 모름', res.data.van_transaction?.status === 'UNKNOWN', res.data);
    res = await o('/payments/reconcile', { van_transaction_id: res.data.van_transaction.id });
    check('대사 → 승인 없음(NOT_FOUND)', res.data.van_transaction?.status === 'NOT_FOUND', res.data);
    res = await approve(cid, {});
    const again = res.data.van_transaction;
    check('미승인 확인 뒤에는 새 승인 가능', res.status === 201 && again.status === 'APPROVED', res.data);
    res = await o(`/sales/drafts/${cid}/cancel`, {});
    check('승인이 남은 판매는 취소 불가', res.status === 409 && res.data.reason === 'DRAFT_LOCKED', res.data);
    res = await s(`/van/transactions/${again.id}/void`, {});
    check('판매 전 승인 취소', res.status === 200 && res.data.van_transaction.status === 'VOIDED', res.data);
    res = await o(`/sales/drafts/${cid}/cancel`, {});
    check('그 뒤 판매 취소', res.status === 200 && res.data.draft.status === 'CANCELED', res.data);
    res = await o(`/sales/by-client-id/${cid}`);
    check('거래 고유번호 조회 = 취소됨', res.data.status === 'CANCELED', res.data);
    res = await approve(cid, {});
    check('취소된 판매에는 승인 불가', res.status === 409 && res.data.reason === 'DRAFT_CANCELED', res.data);
  }

  console.log('[조회도 안 될 때 — 관리자가 단말기 영수증 보고 확정]');
  {
    const cid = randomUUID();
    await prepare(cid);
    res = await approve(cid, { simulate: 'TIMEOUT_NOT_APPROVED' });
    const tx = res.data.van_transaction;
    res = await s('/payments/reconcile', { van_transaction_id: tx.id, resolution: 'APPROVED', approval_number: '55554444' });
    check('직원은 직접 확정 불가(403)', res.status === 403, res.data);
    res = await o('/payments/reconcile', { van_transaction_id: tx.id, resolution: 'APPROVED', approval_number: '4111111111111111' });
    check('카드번호로 보이는 값 거절', res.status === 400, res.data);
    res = await o('/payments/reconcile', { van_transaction_id: tx.id, resolution: 'APPROVED', approval_number: '55554444' });
    check('관리자 확인 → 승인', res.data.van_transaction?.status === 'APPROVED' && res.data.van_transaction.approval_number === '55554444', res.data);
    check('관리자 확인 감사 기록', Boolean(db.prepare("SELECT 1 FROM admin_logs WHERE action = 'POS_VAN_RESOLVE' AND target_id = ?").get(tx.id)));
    res = await confirm(cid, card({ id: tx.id }));
    check('관리자 확인 승인 = 영수증 대조 필요', res.status === 201 && paymentOf(res.data.order.id)[0].verify_status === 'UNVERIFIED', res.data);
  }

  console.log('[수동 승인번호 입력 — 단말기 영수증과 대조해야 마감]');
  {
    const cid = randomUUID();
    await prepare(cid);
    res = await approve(cid, { manual: true, approval_number: '1234-5678-9012-3456' });
    check('카드번호 형태 승인번호 거절', res.status === 400, res.data);
    res = await approve(cid, { manual: true, approval_number: 'AB1234', card_company: '신한카드' });
    const tx = res.data.van_transaction;
    check('수동 승인 기록', res.status === 201 && tx.source === 'MANUAL' && tx.is_demo === false, res.data);
    res = await confirm(cid, card(tx));
    const payment = paymentOf(res.data.order.id)[0];
    check('수동 승인 결제 = 대조 필요', payment.payment_provider === 'VAN_MANUAL' && payment.verify_status === 'UNVERIFIED', payment);

    res = await o(`/sessions/${session.id}/close`, { actual_cash: 0 });
    check('대조 안 된 수동 승인이 있으면 마감 불가', res.status === 409 && res.data.reason === 'MANUAL_APPROVALS_UNCHECKED' && res.data.unverified_count >= 2, res.data);
    res = await o('/sessions/current');
    check('영업 요약에 대조 필요 건수', res.data.session.summary.unverified_count >= 2, res.data.session.summary);
    res = await s('/payments/unverified');
    check('직원은 대조 목록 불가(403)', res.status === 403, res.data);
    res = await o(`/payments/unverified?session_id=${session.id}`);
    const list = res.data.payments;
    check('대조 목록', list.some((p) => p.id === payment.id && p.approval_number === 'AB1234'), list);
    res = await o(`/payments/${payment.id}/verify`, { result: 'MISMATCH' });
    check('불일치는 내용 필요', res.status === 400, res.data);
    res = await o(`/payments/${payment.id}/verify`, { result: 'MATCHED' });
    check('한 건 대조', res.status === 200 && res.data.payment.verify_status === 'MATCHED', res.data);
    res = await o(`/payments/${payment.id}/verify`, { result: 'MATCHED' });
    check('이미 대조한 결제 409', res.status === 409, res.data);
    res = await o('/payments/verify-matched', { payment_ids: list.map((p) => p.id) });
    check('나머지 한 번에 대조', res.status === 200 && res.data.verified === list.length - 1, res.data);
    res = await o('/sessions/current');
    check('대조 필요 0건', res.data.session.summary.unverified_count === 0, res.data.session.summary);
  }

  console.log('[MAYDIN Bridge — 서명된 단말기 결과만 인정]');
  let bridgeKey;
  let bridgeOrder;
  let bridgeApproved;
  {
    res = await setMode('BRIDGE');
    check('Bridge 모드', res.status === 200 && res.data.van.kind === 'BRIDGE', res.data);
    const cid = randomUUID();
    await prepare(cid);
    db.prepare('UPDATE pos_terminals SET bridge_key_enc = NULL WHERE id = ?').run(terminal.id);
    res = await approve(cid, {});
    check('Bridge 키 없으면 승인 요청 불가', res.status === 409 && res.data.reason === 'BRIDGE_NOT_PAIRED', res.data);
    res = await s('/van/bridge-key', {});
    check('직원은 Bridge 키 발급 불가(403)', res.status === 403, res.data);
    res = await o('/van/bridge-key', {});
    bridgeKey = res.data.bridge_key;
    check('Bridge 키 발급(한 번만 보여 줌)', res.status === 201 && res.data.protocol === 'maydin-bridge/1' && bridgeKey?.length >= 40, res.data);
    const row = db.prepare('SELECT bridge_key_enc FROM pos_terminals WHERE id = ?').get(terminal.id);
    check('DB에는 키 원문 없음(암호화)', row.bridge_key_enc && !row.bridge_key_enc.includes(bridgeKey));
    res = await o('/van/terminal');
    check('카운터 정보에 키 안 보냄', !JSON.stringify(res.data).includes(bridgeKey) && res.data.van.bridge_paired === true, res.data.van);

    const requestId = randomUUID();
    res = await approve(cid, { request_id: requestId });
    const pending = res.data.van_transaction;
    const request = res.data.bridge_request;
    check('승인 요청 → Bridge에 보낼 요청', res.status === 202 && pending.status === 'REQUESTED' && request?.request_id === requestId && request.amount === 10000 && request.terminal_id === terminal.id, res.data);

    const result = (extra = {}) => {
      const payload = {
        protocol: 'maydin-bridge/1',
        terminal_id: terminal.id,
        request_id: requestId,
        transaction_type: 'APPROVE',
        status: 'APPROVED',
        method: 'CARD',
        amount: 10000,
        installment_months: 0,
        approval_number: 'B1234567',
        card_company: '신한카드',
        occurred_at: new Date().toISOString(),
        demo: true,
        ...extra
      };
      return { ...payload, signature: sign(bridgeKey, payload) };
    };
    res = await approve(cid, { request_id: requestId, bridge_result: { ...result(), amount: 1000 } });
    check('서명 뒤 금액 바꾸면 거절', res.status === 400 && res.data.reason === 'BRIDGE_RESULT_INVALID', res.data);
    res = await approve(cid, { request_id: requestId, bridge_result: result({ amount: 1000 }) });
    check('서명은 맞아도 요청과 금액 다르면 거절', res.status === 400 && /금액/.test(res.data.message), res.data);
    const forged = result();
    forged.signature = sign('d3Jvbmcta2V5LXdyb25nLWtleS13cm9uZy1rZXktd3Jvbmc', { ...forged });
    res = await approve(cid, { request_id: requestId, bridge_result: forged });
    check('다른 키로 서명한 결과 거절', res.status === 400 && res.data.reason === 'BRIDGE_RESULT_INVALID', res.data);
    res = await confirm(cid, card(pending));
    check('Bridge 결과 전에는 확정 불가', res.status === 409 && res.data.reason === 'APPROVAL_PENDING', res.data);

    const signed = result();
    res = await approve(cid, { request_id: requestId, bridge_result: signed });
    bridgeApproved = res.data.van_transaction;
    check('서명된 결과 → 승인', res.status === 201 && bridgeApproved?.status === 'APPROVED' && bridgeApproved.approval_number === 'B1234567' && bridgeApproved.id === pending.id, res.data);
    const other = randomUUID();
    await prepare(other);
    res = await approve(other, { request_id: requestId, bridge_result: signed });
    check('같은 결과를 다른 판매에 재사용 불가', res.status === 409 && res.data.reason === 'REQUEST_ID_REUSED', res.data);
    await o(`/sales/drafts/${other}/cancel`, {});

    res = await confirm(cid, card(bridgeApproved));
    bridgeOrder = res.data.order;
    const payment = paymentOf(bridgeOrder.id)[0];
    check('Bridge 결제 = 단말기 확인', res.status === 201 && payment.payment_provider === 'VAN_BRIDGE' && payment.verify_status === 'VERIFIED', payment);

    console.log('[Bridge 결제 취소 — 단말기에서 먼저 취소]');
    res = await o(`/sales/${bridgeOrder.id}/cancel`, { reason: '고객 변심' });
    const cancels = res.data.cancels;
    check('단말기 취소 결과 없으면 409 VAN_CANCEL_REQUIRED', res.status === 409 && res.data.reason === 'VAN_CANCEL_REQUIRED' && cancels?.[0]?.original_approval_number === 'B1234567', res.data);
    const cancelPayload = {
      protocol: 'maydin-bridge/1',
      terminal_id: terminal.id,
      request_id: randomUUID(),
      transaction_type: 'CANCEL',
      status: 'APPROVED',
      method: 'CARD',
      amount: 10000,
      approval_number: 'C7654321',
      original_approval_number: 'B1234567',
      occurred_at: new Date().toISOString(),
      demo: true
    };
    const cancelResult = { ...cancelPayload, signature: sign(bridgeKey, cancelPayload) };
    const otherCancel = { ...cancelPayload, request_id: randomUUID(), original_approval_number: 'X0000000' };
    res = await o(`/sales/${bridgeOrder.id}/cancel`, {
      reason: '고객 변심',
      van_cancels: [{ original_approval_number: 'B1234567', bridge_result: { ...otherCancel, signature: sign(bridgeKey, otherCancel) } }]
    });
    check('다른 원승인 취소 결과는 안 받음', res.status === 400 && /원승인번호/.test(res.data.message), res.data);
    check('거절되면 판매 그대로', db.prepare('SELECT order_status FROM orders WHERE id = ?').get(bridgeOrder.id).order_status === 'COMPLETED');
    res = await o(`/sales/${bridgeOrder.id}/cancel`, { reason: '고객 변심', van_cancels: [{ original_approval_number: 'B1234567', bridge_result: cancelResult }] });
    check('서명된 단말기 취소로 판매 취소', res.status === 200 && res.data.original.order.order_status === 'CANCELED', res.data);
    const refund = paymentOf(res.data.refund.order.id)[0];
    check('환불 결제 = Bridge 취소 승인번호', refund.payment_provider === 'VAN_BRIDGE' && refund.approval_number === 'C7654321' && refund.paid_amount === -10000, refund);

    console.log('[Bridge 결과 조회]');
    const cid2 = randomUUID();
    await prepare(cid2);
    const rid = randomUUID();
    res = await approve(cid2, { request_id: rid });
    res = await o('/payments/reconcile', { request_id: rid });
    check('Bridge 승인 조회는 Bridge 결과 필요', res.status === 409 && res.data.reason === 'BRIDGE_RESULT_REQUIRED' && res.data.bridge_request?.transaction_type === 'INQUIRE', res.data);
    const notFound = { protocol: 'maydin-bridge/1', terminal_id: terminal.id, request_id: rid, transaction_type: 'APPROVE', status: 'NOT_FOUND', method: 'CARD', amount: 10000, occurred_at: new Date().toISOString() };
    res = await o('/payments/reconcile', { request_id: rid, bridge_result: { ...notFound, signature: sign(bridgeKey, notFound) } });
    check('단말기에 승인 없음 → NOT_FOUND', res.data.van_transaction?.status === 'NOT_FOUND', res.data);
    res = await o(`/sales/drafts/${cid2}/cancel`, {});
    check('판매 취소', res.status === 200, res.data);
  }

  console.log('[실 VAN 연동 뼈대 — 계약 정보 없으면 못 켬]');
  {
    res = await setMode('NICE');
    check('NICE 계약 정보 없으면 409', res.status === 409 && res.data.reason === 'VAN_NOT_CONFIGURED' && /가맹점 번호/.test(res.data.message), res.data);
    res = await setMode('KIS');
    check('KIS 계약 정보 없으면 409', res.status === 409 && res.data.reason === 'VAN_NOT_CONFIGURED', res.data);
    res = await o('/van/terminal');
    check('승인 방식 목록', ['MANUAL', 'DEMO', 'BRIDGE', 'NICE', 'KIS'].every((m) => res.data.modes.some((x) => x.mode === m)), res.data.modes);
  }

  console.log('[현금영수증 (데모) — 식별번호는 가려서만 저장]');
  {
    await setMode('DEMO');
    res = await o('/van/cash-receipt', { amount: 5000, identity: '010-1234-5678' });
    check('발급', res.status === 201 && res.data.van_transaction.masked_identity === '010-****-5678', res.data);
    const row = db.prepare('SELECT * FROM van_transactions WHERE id = ?').get(res.data.van_transaction.id);
    check('원래 번호 저장 안 함', !JSON.stringify(row).includes('12345678'), row);
    await setMode('MANUAL');
    res = await o('/van/cash-receipt', { amount: 5000, identity: '01012345678' });
    check('데모가 아니면 단말기에서 발급하라고 안내(409)', res.status === 409, res.data);
  }

  console.log('[픽업 주문 카운터 결제 — 승인은 그 픽업 주문에 묶음]');
  {
    await setMode('DEMO');
    const pickupId = db
      .prepare(
        `INSERT INTO orders (order_number, pharmacy_id, order_type, total_product_amount, final_amount, order_status, payment_status)
         VALUES (?, 1, 'PICKUP', 7000, 7000, 'READY_FOR_PICKUP', 'UNPAID')`
      )
      .run(`PK-${process.pid}-${Date.now()}`).lastInsertRowid;
    const cid = randomUUID();
    res = await o('/sales/prepare', { client_sale_id: cid, pickup_order_id: pickupId });
    check('픽업 결제 준비 = 주문 금액', res.status === 201 && res.data.draft.amount === 7000 && res.data.draft.pickup_order_id === pickupId, res.data);
    res = await approve(cid, { amount: 7000 });
    const tx = res.data.van_transaction;
    check('픽업 승인', res.status === 201 && tx.status === 'APPROVED', res.data);
    res = await confirm(cid, card(tx, 7000));
    check('픽업은 판매 확정으로 저장 안 함', res.status === 409, res.data);
    res = await o(`/pickups/${pickupId}/complete`, { payments: card(tx, 7000) });
    check('준비 없이 승인만 붙이면 거절', res.status === 409, res.data);
    res = await o(`/pickups/${pickupId}/complete`, { client_sale_id: cid, payments: card(tx, 7000) });
    check('수령 완료 + 결제', res.status === 200, res.data);
    const payment = paymentOf(pickupId)[0];
    check('픽업 결제 = 데모 VAN 승인', payment?.payment_provider === 'VAN_DEMO' && payment.van_transaction_id === tx.id, payment);
    check('판매 초안 완료', db.prepare('SELECT status FROM pos_sale_drafts WHERE client_sale_id = ?').get(cid).status === 'CONFIRMED');
  }

  console.log('[마감 — 정리 끝나면 마감됨]');
  {
    res = await o('/payments/pending');
    check('정리할 승인 없음', res.data.approvals.length === 0, res.data.approvals);
    const expected = (await o('/sessions/current')).data.session.summary.expected_cash;
    res = await o(`/sessions/${session.id}/close`, { actual_cash: expected });
    check('마감', res.status === 200, res.data);
  }
} finally {
  db.prepare('UPDATE pos_terminals SET van_mode = ?, bridge_key_enc = NULL WHERE id = ?').run(originalMode, terminal.id);
}

done();
