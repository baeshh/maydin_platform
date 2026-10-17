// MAYDIN POS · 결제
/* ---------- 결제 ----------
 * 카드·간편결제 승인을 서버(데모·실 VAN)나 카운터 PC의 Bridge가 받는 카운터는
 *   ① 판매 내용을 서버에 먼저 올리고(prepare) ② 그 판매에 승인을 붙인 뒤 ③ 서버에 올린 내용으로 확정(confirm)한다.
 * 승인 요청마다 요청 번호를 붙여, 응답이 끊겨 다시 보내도 서버·Bridge가 두 번 승인하지 않는다.
 * 결과를 모르는 승인은 다시 승인하지 않고 "결과 조회"로만 정한다.
 */

const PENDING_VAN = ['REQUESTED', 'UNKNOWN'];

function payTarget() {
  if (state.payMode === 'pickup') return state.pickup.order.final_amount;
  return totals().final;
}

function openPayment(mode = 'sale') {
  if (mode === 'sale') {
    if (!requireSession()) return;
    if (state.cart.length === 0) return toast('판매할 상품을 담아 주세요.', 'error');
  }
  // normal: 서버 저장 · offline: 장애 중 판매(기기 보관) · manual: 약사의 수기 거래 복구
  state.payContext = mode === 'sale' && state.manual ? 'manual' : mode === 'sale' && isDown() ? 'offline' : 'normal';
  if (mode === 'pickup' && isDown()) return toast('장애 중에는 픽업 주문을 처리할 수 없습니다. 복구 후 처리해 주세요.', 'error');
  state.payMode = mode;
  state.payRows = [];
  state.payDraft = null;
  state.cashReceiptChoice = null;
  renderPayment();
}

function paidSum() {
  return state.payRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

// 승인을 서버·Bridge가 받는 카운터. 장애 중·수기 복구 결제는 단말기 단독 승인번호를 직접 받는다.
function vanAuto() {
  const van = state.ctx?.van;
  return !!van && van.kind !== 'MANUAL' && (state.payContext || 'normal') === 'normal';
}

function vanBridge() {
  return vanAuto() && state.ctx.van.kind === 'BRIDGE';
}

function vanDemo() {
  return vanAuto() && !!state.ctx.van.is_demo;
}

function demoTag(tx) {
  return (tx ? tx.is_demo : vanDemo()) ? ' <span class="demo-tag">데모</span>' : '';
}

function rowPending(row) {
  return !!row.lost || (!!row.van && PENDING_VAN.includes(row.van.status));
}

function rowLocked(row) {
  return !!row.van || !!row.lost;
}

function addPointRow() {
  const policy = state.ctx.point_policy;
  if (state.payRows.some((row) => row.method === 'POINT')) return toast('포인트는 한 번만 추가할 수 있습니다.', 'error');
  if ((state.customer?.point_balance || 0) < policy.min_use) {
    return toast(`보유 포인트가 ${Number(policy.min_use).toLocaleString()}P 미만이라 사용할 수 없습니다.`, 'error');
  }
  const usable = Math.min(state.customer.point_balance, pointEligibleAmount(), payTarget());
  if (usable < policy.min_use) return toast('포인트로 결제할 수 있는 금액이 부족합니다. (일반의약품·분류 전 상품 제외)', 'error');

  let excess = paidSum() + usable - payTarget();
  for (const row of state.payRows) {
    if (excess <= 0) break;
    if (rowLocked(row) || row.cash_receipt_number) continue;
    const cut = Math.min(excess, Number(row.amount) || 0);
    row.amount = (Number(row.amount) || 0) - cut;
    excess -= cut;
  }
  state.payRows = state.payRows.filter((row) => rowLocked(row) || Number(row.amount) > 0);
  state.payRows.unshift({ method: 'POINT', amount: excess > 0 ? usable - excess : usable });
  renderPayment();
}

function useMaxPoints(index) {
  const row = state.payRows[index];
  row.amount = maxUsablePoints();
  renderPayment();
}

function pointRowHtml(row, index) {
  const policy = state.ctx.point_policy;
  return `<div class="notice">보유 <b>${Number(state.customer?.point_balance || 0).toLocaleString()}P</b> · 이번 결제 최대 <b>${maxUsablePoints().toLocaleString()}P</b> · ${Number(policy.min_use).toLocaleString()}P 이상부터 사용 · 일반의약품·분류 전 상품 금액은 포인트 결제 불가 <button class="discount-link" type="button" onclick="useMaxPoints(${index})">최대 사용</button></div><div class="notice" id="point-warn-${index}" style="display: none;"></div>`;
}

function addPayRow(method, fillRemaining = true) {
  if (method === 'POINT') return addPointRow();
  const remaining = payTarget() - paidSum();
  state.payRows.push({
    method,
    amount: fillRemaining && remaining > 0 ? remaining : '',
    approval_number: '',
    card_company: '',
    received_amount: '',
    cash_receipt_number: '',
    installment_months: 0,
    easy_barcode: '',
    resolve_number: '',
    van: null,
    request_id: null,
    lost: false,
    manual: !vanAuto()
  });
  renderPayment();
  const inputs = document.querySelectorAll(`[data-row="${state.payRows.length - 1}"]`);
  const focusField = { CARD: vanAuto() ? null : 'approval_number', CASH: 'received_amount', EASY_PAY: vanAuto() && !vanBridge() ? 'easy_barcode' : null }[method];
  const focus = focusField ? [...inputs].find((i) => i.dataset.field === focusField) : null;
  if (focus) setTimeout(() => focus.focus(), 30);
}

/* ---------- 결제 전 판매 등록 ---------- */

function saleRequestBody() {
  return {
    customer_id: state.customer?.id || null,
    counsel_order_id: state.counsel?.id || null,
    items: state.cart.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
    discount_amount: totals().discount,
    discount_reason: state.discount.reason
  };
}

// 승인을 받기 전에 판매 내용을 서버에 올린다. 같은 결제 화면에서는 같은 거래 고유번호를 쓴다.
async function ensureDraft() {
  const body = state.payMode === 'pickup' ? { pickup_order_id: state.pickup.order.id } : saleRequestBody();
  const key = JSON.stringify(body);
  if (state.payDraft?.key === key) return state.payDraft.client_sale_id;
  const clientSaleId = state.payDraft?.client_sale_id || newSaleId();
  await api.request('/pos/sales/prepare', { method: 'POST', body: { ...body, client_sale_id: clientSaleId } });
  state.payDraft = { client_sale_id: clientSaleId, key };
  return clientSaleId;
}

/* ---------- 승인 ---------- */

function setRowStatus(index, html) {
  const el = document.getElementById(`van-status-${index}`);
  if (el) el.innerHTML = `<div class="notice">${html}</div>`;
}

function approvalBody(row, extra = {}) {
  return {
    client_sale_id: state.payDraft.client_sale_id,
    request_id: row.request_id,
    method: row.method,
    amount: Number(row.amount),
    installment_months: row.method === 'CARD' ? Number(row.installment_months) || 0 : 0,
    barcode: row.method === 'EASY_PAY' && row.easy_barcode ? row.easy_barcode : undefined,
    ...extra
  };
}

function postApproval(body) {
  return api.request('/pos/payments/approve', { method: 'POST', body });
}

// 서버가 알려 준 승인 결과를 결제 줄에 반영한다.
function applyApproval(row, tx) {
  row.lost = false;
  if (['NOT_FOUND', 'DECLINED', 'VOIDED'].includes(tx.status)) {
    row.van = null;
    row.request_id = null;
    const reason = tx.status === 'NOT_FOUND' ? '승인되지 않은 것으로 확인했습니다.' : tx.status === 'VOIDED' ? '이미 취소한 승인입니다.' : `승인이 거절됐습니다.${tx.message ? ` (${tx.message})` : ''}`;
    toast(`${reason} 다시 승인할 수 있습니다.`, tx.status === 'DECLINED' ? 'error' : undefined);
    return;
  }
  row.van = tx;
  if (tx.status === 'APPROVED') {
    row.approval_number = tx.approval_number;
    row.card_company = tx.card_company || '';
    row.easy_barcode = '';
    toast(`${tx.card_company || ''} 승인 완료${tx.is_demo ? ' (데모)' : ''} · ${tx.approval_number}`);
  } else {
    toast('승인 결과를 받지 못했습니다. 카드를 다시 승인하지 말고 「결과 조회」를 눌러 주세요.', 'error');
  }
}

function requestVanApproval(index) {
  const row = state.payRows[index];
  const amount = Number(row.amount);
  if (!Number.isInteger(amount) || amount <= 0) return toast('결제 금액을 먼저 입력해 주세요.', 'error');
  if (row.method === 'EASY_PAY' && !vanBridge() && !String(row.easy_barcode).trim()) return toast('고객 앱의 결제 바코드를 스캔해 주세요.', 'error');
  withBusy(async () => {
    setRowStatus(index, vanBridge() ? '카드 단말기에 승인 요청 중… 고객에게 카드를 꽂거나 태그해 달라고 안내하세요.' : `승인 요청 중…${demoTag()}`);
    try {
      await ensureDraft();
      row.request_id = row.request_id || newSaleId();
      let data;
      try {
        data = await postApproval(approvalBody(row));
      } catch (error) {
        // 서버 응답을 못 받으면 승인 요청이 닿았는지 모른다. 같은 요청 번호로만 다시 확인한다.
        if (!error.status) row.lost = true;
        throw error;
      }
      if (data.bridge_request) {
        row.van = data.van_transaction;
        renderPayment();
        setRowStatus(index, '카드 단말기에서 승인 중… 고객에게 카드를 꽂거나 태그해 달라고 안내하세요.');
        const bridgeResult = await VanBridge.approve(data.bridge_request);
        data = await postApproval(approvalBody(row, { bridge_result: bridgeResult }));
      }
      applyApproval(row, data.van_transaction);
      renderPayment();
    } catch (error) {
      if (error.reason === 'VAN_DECLINED') {
        row.van = null;
        row.request_id = null;
        row.lost = false;
      }
      renderPayment();
      throw error;
    }
  });
}

// 결과를 모르는 승인을 VAN사·Bridge 기록으로 확인한다. 절대 새로 승인하지 않는다.
function checkVanResult(index) {
  const row = state.payRows[index];
  withBusy(async () => {
    try {
      if (!row.van) {
        // 서버가 요청을 받았는지도 모를 때: 같은 요청 번호로 보내면 서버는 처음 기록을 돌려준다.
        const data = await postApproval(approvalBody(row));
        if (!data.bridge_request) return applyApproval(row, data.van_transaction);
        row.van = data.van_transaction;
      }
      const body = { request_id: row.van.request_id };
      if (row.van.source === 'BRIDGE') {
        body.bridge_result = await VanBridge.inquire({
          protocol: 'maydin-bridge/1',
          terminal_id: state.ctx.terminal.id,
          request_id: row.van.request_id,
          transaction_type: 'APPROVE',
          method: row.van.payment_method,
          amount: row.van.amount
        });
      }
      const data = await api.request('/pos/payments/reconcile', { method: 'POST', body });
      applyApproval(row, data.van_transaction);
    } finally {
      renderPayment();
    }
  });
}

// 조회도 안 될 때 약국 관리자가 단말기 영수증을 보고 정한다.
function resolveVanResult(index, approved) {
  const row = state.payRows[index];
  if (!row.van) return toast('먼저 「결과 조회」를 눌러 주세요.', 'error');
  const number = String(row.resolve_number || '').trim();
  if (approved && !number) return toast('단말기 영수증의 승인번호를 입력해 주세요.', 'error');
  withBusy(async () => {
    const data = await api.request('/pos/payments/reconcile', {
      method: 'POST',
      body: { van_transaction_id: row.van.id, resolution: approved ? 'APPROVED' : 'NOT_APPROVED', approval_number: approved ? number : undefined }
    });
    applyApproval(row, data.van_transaction);
    renderPayment();
  });
}

// 판매에 쓰기 전 승인을 취소한다. Bridge 승인은 카드 단말기에서 먼저 취소한다.
async function voidApproval(tx, row = null) {
  const body = {};
  if (tx.source === 'BRIDGE') {
    const cancelRequestId = row?.cancel_request_id || newSaleId();
    if (row) row.cancel_request_id = cancelRequestId;
    body.bridge_result = await VanBridge.cancel({
      protocol: 'maydin-bridge/1',
      terminal_id: state.ctx.terminal.id,
      request_id: cancelRequestId,
      transaction_type: 'CANCEL',
      method: tx.payment_method,
      amount: tx.amount,
      original_approval_number: tx.approval_number
    });
  }
  return api.request(`/pos/van/transactions/${tx.id}/void`, { method: 'POST', body });
}

function payAll(method) {
  if (state.payRows.some(rowLocked)) return toast('승인된 결제가 있습니다. 승인을 먼저 취소(삭제)한 뒤 바꿔 주세요.', 'error');
  state.payRows = state.payRows.filter((row) => row.method === 'POINT');
  addPayRow(method);
}

function removePayRow(index) {
  const row = state.payRows[index];
  if (rowPending(row)) return toast('결과를 모르는 승인은 지울 수 없습니다. 「결과 조회」로 먼저 확인해 주세요.', 'error');
  if (!row.van) {
    state.payRows.splice(index, 1);
    return renderPayment();
  }
  withBusy(async () => {
    await voidApproval(row.van, row);
    state.payRows.splice(state.payRows.indexOf(row), 1);
    toast(`승인을 취소했습니다.${row.van.is_demo ? ' (데모)' : ''}`);
    renderPayment();
  });
}

// 결제 화면을 닫을 수 있는지. 결과를 모르는 승인이 있으면 닫지 않는다.
function canLeavePayment() {
  if (!state.payRows.some(rowPending)) return true;
  toast('결과를 모르는 승인이 있어 닫을 수 없습니다. 「결과 조회」로 먼저 확인해 주세요.', 'error');
  return false;
}

// 결제를 그만두면 받은 승인을 취소하고 판매 등록을 지운다. 실패한 것은 「승인 정리」에 남는다.
function abandonPayment() {
  const approvals = state.payRows.filter((row) => row.van?.status === 'APPROVED');
  const draft = state.payDraft;
  state.payDraft = null;
  if (!approvals.length && !draft) return;
  (async () => {
    try {
      for (const row of approvals) await voidApproval(row.van, row);
      if (draft) await api.request(`/pos/sales/drafts/${draft.client_sale_id}/cancel`, { method: 'POST' });
      if (approvals.length) toast(`결제를 취소해 승인 ${approvals.length}건을 취소했습니다.`);
    } catch (error) {
      toast(`승인 취소를 마치지 못했습니다: ${error.message} · 상단 「승인 정리」에서 이어서 처리해 주세요.`, 'error');
    } finally {
      refreshPendingApprovals();
    }
  })();
}

function toggleManual(index) {
  const row = state.payRows[index];
  if (rowLocked(row)) return;
  row.manual = !row.manual;
  row.approval_number = '';
  row.card_company = '';
  renderPayment();
}

function scanEasyPayWithCamera(index) {
  ScanKit.openCameraScanner({
    title: '간편결제 바코드 스캔 (데모)',
    hint: '고객 휴대폰의 카카오페이·네이버페이 등 결제 바코드를 비춰 주세요.',
    onResult: (code) => {
      const row = state.payRows[index];
      if (!row) return;
      row.easy_barcode = code;
      requestVanApproval(index);
    }
  });
}

function updatePayRow(input) {
  const row = state.payRows[Number(input.dataset.row)];
  row[input.dataset.field] = input.value;
  renderPaymentStatus();
}

/* ---------- 화면 ---------- */

function installmentOptions(row, common) {
  const months = [0, 2, 3, 4, 5, 6, 10, 12];
  return `<select class="input" ${common.replace('oninput', 'onchange')} data-field="installment_months">${months
    .map((m) => `<option value="${m}" ${Number(row.installment_months) === m ? 'selected' : ''}>${m === 0 ? '일시불' : `${m}개월 할부`}</option>`)
    .join('')}</select>`;
}

function vanApprovedBox(row) {
  const tx = row.van;
  const source = tx.source === 'MANUAL' ? ' · 수동 입력(영수증 대조 필요)' : tx.source === 'BRIDGE' ? ' · 카드 단말기' : '';
  return `<div class="van-ok">승인 완료${demoTag(tx)} · ${h(tx.card_company || '')} · 승인번호 <b>${h(tx.approval_number)}</b>${row.method === 'CARD' ? ` · ${tx.installment_months ? `${tx.installment_months}개월 할부` : '일시불'}` : ''}${source}</div>`;
}

function vanPendingBox(row, index) {
  const owner = isOwner() && row.van;
  return `
    <div class="notice danger">
      <b>승인 결과를 모릅니다.</b> 카드를 다시 승인하지 마세요. 카드사에서 승인됐을 수 있습니다.
      ${row.van?.message ? `<div class="muted" style="margin-top: 4px;">${h(row.van.message)}</div>` : ''}
    </div>
    <button class="btn btn-primary btn-block" type="button" style="margin-top: 8px;" onclick="checkVanResult(${index})">결과 조회</button>
    ${owner
      ? `<div class="notice" style="margin-top: 8px;">조회가 안 되면 단말기 영수증·VAN 매출 내역을 보고 관리자가 정합니다.
          <div class="pay-row-grid" style="margin-top: 6px;">
            <input class="input" data-row="${index}" oninput="updatePayRow(this)" data-field="resolve_number" value="${h(row.resolve_number)}" placeholder="영수증 승인번호" />
            <div style="display: flex; gap: 6px;"><button class="btn btn-outline btn-sm" type="button" onclick="resolveVanResult(${index}, true)">승인됨</button><button class="btn btn-outline btn-sm" type="button" onclick="resolveVanResult(${index}, false)">승인 안 됨</button></div>
          </div></div>`
      : ''}
  `;
}

function vanStatusBox(row, index) {
  if (rowPending(row)) return vanPendingBox(row, index);
  if (row.van) return vanApprovedBox(row);
  return '';
}

function vanModeNotice() {
  if (vanBridge()) return '카드 단말기 연동 (MAYDIN Bridge) · 승인 결과는 단말기 서명을 서버가 확인한 것만 인정합니다.';
  return `VAN 자동 승인${demoTag()} · 실제 카드 결제 없이 모의 승인번호가 발급됩니다.`;
}

function cardRowHtml(row, index, common) {
  const status = vanStatusBox(row, index);
  if (status) return status;
  if (vanAuto() && !row.manual) {
    return `
      <div class="pay-row-grid">
        <div><label class="label">할부</label>${installmentOptions(row, common)}</div>
        <div style="display: flex; align-items: flex-end;"><button class="btn btn-primary btn-block" type="button" onclick="requestVanApproval(${index})">단말기 승인 요청${demoTag()}</button></div>
      </div>
      <div id="van-status-${index}"><div class="notice">${vanModeNotice()} <button class="discount-link" type="button" onclick="toggleManual(${index})">승인번호 직접 입력</button></div></div>
    `;
  }
  return `
    <div class="pay-row-grid">
      <div><label class="label">승인번호 (필수)</label><input class="input" ${common} data-field="approval_number" value="${h(row.approval_number)}" placeholder="단말기 영수증의 승인번호" inputmode="numeric" /></div>
      <div><label class="label">카드사</label><input class="input" ${common} data-field="card_company" value="${h(row.card_company)}" placeholder="선택" /></div>
    </div>
    <div class="notice">기존 카드 단말기에서 먼저 승인한 뒤 승인번호만 입력하세요. 카드번호는 입력·저장하지 않습니다. 수동 입력은 마감 전에 단말기 영수증과 대조해야 합니다.${vanAuto() ? ` <button class="discount-link" type="button" onclick="toggleManual(${index})">자동 승인으로</button>` : ''}</div>
  `;
}

function easyPayRowHtml(row, index, common) {
  const status = vanStatusBox(row, index);
  if (status) return status;
  if (!vanAuto()) return '<div class="notice">고객 앱 결제는 기존 단말기에서 승인한 뒤 금액만 기록합니다. 마감 전에 단말기 영수증과 대조해야 합니다.</div>';
  if (vanBridge()) {
    return `
      <button class="btn btn-primary btn-block" type="button" onclick="requestVanApproval(${index})">단말기로 간편결제 승인 요청</button>
      <div id="van-status-${index}"><div class="notice">고객 휴대폰 바코드는 카드 단말기(또는 단말기에 연결된 스캐너)로 읽습니다. 바코드 값은 서버로 보내지 않습니다.</div></div>
    `;
  }
  return `
    <div><label class="label">고객 결제 바코드${demoTag()}</label>
      <div class="inline-scan">
        <input class="input" ${common} data-field="easy_barcode" value="${h(row.easy_barcode)}" placeholder="스캐너로 고객 휴대폰 바코드를 찍으세요" autocomplete="off" onkeydown="if (event.key === 'Enter') { event.preventDefault(); requestVanApproval(${index}); }" />
        <button class="cam-btn" type="button" onclick="scanEasyPayWithCamera(${index})">카메라</button>
      </div>
    </div>
    <div id="van-status-${index}"><div class="notice">카카오페이·네이버페이 등 결제 바코드를 스캔하면 모의 승인됩니다${demoTag()}. 바코드 값은 저장하지 않습니다.</div></div>
  `;
}

function cashRowHtml(row, index, common) {
  // 서버에 바로 저장하는 판매는 저장 뒤 현금영수증을 발급한다(아래 현금영수증 칸). 장애 중·수기 복구 판매만 단말기 승인번호를 적는다.
  const receipt =
    state.payContext === 'normal' && state.payMode === 'sale'
      ? ''
      : `<div><label class="label">현금영수증 승인번호</label><input class="input" ${common} data-field="cash_receipt_number" value="${h(row.cash_receipt_number)}" placeholder="단말기에서 발급한 경우 (선택)" /></div>`;
  return `
    <div><label class="label">받은 금액</label><input class="input" type="number" min="0" step="100" ${common} data-field="received_amount" value="${h(row.received_amount)}" placeholder="선택" /></div>
    <div class="notice" id="change-${index}"></div>
    ${receipt}
  `;
}

function renderPayment() {
  const target = payTarget();
  state.payOpen = true;
  const title = state.payMode === 'pickup' ? '픽업 주문 카운터 결제' : '결제';
  const rowsHtml = state.payRows
    .map((row, index) => {
      const common = `data-row="${index}" oninput="updatePayRow(this)"`;
      const extra =
        row.method === 'CARD'
          ? cardRowHtml(row, index, common)
          : row.method === 'CASH'
            ? cashRowHtml(row, index, common)
            : row.method === 'EASY_PAY'
              ? easyPayRowHtml(row, index, common)
              : row.method === 'POINT'
                ? pointRowHtml(row, index)
                : '';
      const removeLabel = rowPending(row) ? '' : row.van ? '승인 취소 · 삭제' : '삭제';
      return `
        <div class="pay-row">
          <div class="pay-row-head">
            <span>${METHOD_LABELS[row.method]}</span>
            ${removeLabel ? `<button class="line-remove" type="button" onclick="removePayRow(${index})">${removeLabel}</button>` : ''}
          </div>
          <div><label class="label">결제 금액</label><input class="input big" type="number" min="0" ${common} data-field="amount" value="${h(row.amount)}" ${rowLocked(row) ? 'readonly' : ''} /></div>
          ${extra}
        </div>
      `;
    })
    .join('');

  openModal(
    `
    ${modalHead(title)}
    <div class="modal-body">
      <div class="pay-total">
        <span class="muted" style="font-weight: 700;">결제할 금액</span>
        <div class="amount">${won(target)}</div>
        ${state.payMode === 'sale' && state.discount.amount > 0 ? `<div class="muted" style="font-size: 13px; font-weight: 600;">할인 ${won(state.discount.amount)} 적용 (${h(state.discount.reason)})</div>` : ''}
      </div>
      <div class="chips" style="margin-bottom: 10px;">
        <button class="chip" type="button" onclick="payAll('CARD')">전액 카드</button>
        <button class="chip" type="button" onclick="payAll('CASH')">전액 현금</button>
        <button class="chip" type="button" onclick="payAll('EASY_PAY')">전액 간편결제</button>
      </div>
      ${vanDemo() ? '<div class="notice" style="margin-bottom: 10px; background: #f3e8ff; color: #6d28d9;">VAN 자동 승인 <b>(데모)</b> 모드입니다. 실제 VAN 계약 전이라 승인번호를 모의로 발급하며, 실제 돈은 결제되지 않습니다.</div>' : ''}
      ${vanBridge() && state.ctx.van.bridge_paired === false ? '<div class="notice danger" style="margin-bottom: 10px;">이 카운터에 연결된 Bridge가 없습니다. 단말기 설정에서 Bridge를 연결하거나, 승인번호 직접 입력으로 받아 주세요.</div>' : ''}
      ${state.payContext === 'offline' ? '<div class="notice danger" style="margin-bottom: 10px;"><b>장애 중 판매</b> · 이 기기에 보관했다가 복구되면 서버로 보냅니다. 카드·간편결제는 단말기에서 단독 승인한 뒤 승인번호를 입력하세요. 포인트는 쓸 수 없습니다.</div>' : ''}
      ${state.payContext === 'manual' ? `<div class="notice" style="margin-bottom: 10px; background: #f3e8ff; color: #6d28d9;"><b>수기 거래 복구</b> · 장애 #${Number(state.manual.outage_id)}에 묶어 실제 판매 시각으로 저장합니다.
        <div style="margin-top: 6px; display: flex; gap: 8px;"><div style="flex: 1;"><label class="label" for="manualOccurredPay">실제 판매 시각</label><input id="manualOccurredPay" class="input" type="datetime-local" value="${toLocalInput(new Date(state.manual.occurred_at))}" onchange="setManualOccurred(this.value)" /></div>
        <div style="width: 150px;"><label class="label" for="manualRefPay">임시번호 (있으면)</label><input id="manualRefPay" class="input" maxlength="8" placeholder="8자리" value="${h((state.manual.ref || '').toUpperCase())}" style="text-transform: uppercase;" onchange="setManualRef(this.value)" /></div></div></div>` : ''}
      <label class="label">결제수단 추가 (여러 개 선택하면 복합결제)</label>
      <div class="method-grid">
        ${['CARD', 'CASH', 'TRANSFER', 'EASY_PAY', ...(state.payMode === 'sale' && state.payContext === 'normal' && state.customer && pointsEnabled() ? ['POINT'] : [])]
          .map((m) => `<button class="method-btn" type="button" onclick="addPayRow('${m}')">${m === 'POINT' ? `포인트 <span class="muted" style="font-size: 12px;">${Number(state.customer.point_balance || 0).toLocaleString()}P</span>` : METHOD_LABELS[m]}</button>`)
          .join('')}
      </div>
      ${rowsHtml || '<div class="notice">결제수단을 선택하세요.</div>'}
      ${cashReceiptPanelHtml()}
      <div class="remain" id="payRemain"></div>
      <div id="payRetry"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="closeModal()">취소</button>
      <button class="btn btn-primary btn-lg" id="payConfirm" type="button" onclick="confirmPayment()">${state.payContext === 'offline' ? '이 기기에 보관' : state.payContext === 'manual' ? '복구 거래 저장' : '결제 완료'}</button>
    </div>
  `,
    { size: '' }
  );
  renderPaymentStatus();
}

function renderPaymentStatus() {
  const target = payTarget();
  const sum = paidSum();
  const remaining = target - sum;
  const el = document.getElementById('payRemain');
  if (!el) return;
  if (remaining === 0 && (state.payRows.length > 0 || target === 0)) {
    el.className = 'remain ok';
    el.innerHTML = '<span>결제 금액 일치</span><span>✓</span>';
  } else if (remaining > 0) {
    el.className = 'remain bad';
    el.innerHTML = `<span>남은 금액</span><span>${won(remaining)}</span>`;
  } else {
    el.className = 'remain bad';
    el.innerHTML = `<span>초과 금액</span><span>${won(-remaining)}</span>`;
  }
  state.payRows.forEach((row, index) => {
    const changeEl = document.getElementById(`change-${index}`);
    if (!changeEl) return;
    const received = Number(row.received_amount);
    const amount = Number(row.amount) || 0;
    if (!row.received_amount) changeEl.textContent = '받은 금액을 입력하면 거스름돈을 계산합니다.';
    else if (received < amount) changeEl.textContent = `받은 금액이 ${won(amount - received)} 부족합니다.`;
    else changeEl.innerHTML = `거스름돈 <b style="font-size: 16px;">${won(received - amount)}</b>`;
  });
  const cardMissing = state.payRows.some((row) => row.method === 'CARD' && !row.van && !String(row.approval_number).trim());
  const easyMissing = vanAuto() && state.payRows.some((row) => row.method === 'EASY_PAY' && !row.van);
  const pending = state.payRows.some(rowPending);
  let pointInvalid = false;
  state.payRows.forEach((row, index) => {
    if (row.method !== 'POINT') return;
    const warn = document.getElementById(`point-warn-${index}`);
    const amount = Number(row.amount) || 0;
    const policy = state.ctx.point_policy;
    const message =
      amount > (state.customer?.point_balance || 0)
        ? '보유 포인트보다 많이 사용할 수 없습니다.'
        : amount > pointEligibleAmount()
          ? '일반 상품 금액까지만 포인트로 결제할 수 있습니다.'
          : amount < policy.min_use
            ? `${Number(policy.min_use).toLocaleString()}P 이상부터 사용할 수 있습니다.`
            : '';
    if (message) pointInvalid = true;
    if (warn) {
      warn.style.display = message ? '' : 'none';
      warn.className = 'notice danger';
      warn.textContent = message;
    }
  });
  const receiptMissing = Boolean(document.querySelector('.modal [data-cash-receipt-panel]')) && !cashReceiptChoiceReady(state.cashReceiptChoice);
  document.getElementById('payConfirm').disabled =
    remaining !== 0 || (state.payRows.length === 0 && target !== 0) || cardMissing || easyMissing || pending || pointInvalid || receiptMissing;
}

function payloadPayments() {
  return state.payRows.map((row) => ({
    method: row.method,
    amount: Number(row.amount),
    van_transaction_id: row.van?.id,
    approval_number: row.van ? undefined : row.approval_number || undefined,
    card_company: row.van ? undefined : row.card_company || undefined,
    received_amount: row.received_amount === '' ? undefined : Number(row.received_amount),
    cash_receipt_number: row.cash_receipt_number || undefined
  }));
}

// 서버에 올린 판매에는 승인을 거친 카드만 넣을 수 있다. 직접 입력한 승인번호도 그 판매의 (수동) 승인으로 등록한다.
async function registerManualApprovals() {
  for (const row of state.payRows) {
    if (row.method !== 'CARD' || row.van) continue;
    row.request_id = row.request_id || newSaleId();
    const data = await postApproval(approvalBody(row, { manual: true, approval_number: row.approval_number, card_company: row.card_company || undefined }));
    row.van = data.van_transaction;
  }
}

function confirmPayment() {
  withBusy(async () => {
    document.getElementById('payConfirm').disabled = true;
    if (state.payMode === 'pickup') {
      const body = { payments: payloadPayments() };
      if (state.payDraft) {
        await registerManualApprovals();
        Object.assign(body, { client_sale_id: state.payDraft.client_sale_id, payments: payloadPayments() });
      }
      await api.request(`/pos/pickups/${state.pickup.order.id}/complete`, { method: 'POST', body });
      state.payOpen = false;
      state.payDraft = null;
      toast('결제와 픽업 수령이 완료되었습니다.');
      state.pickup = null;
      await refreshSession();
      refreshBadges();
      openPickups();
      return;
    }

    if (state.payContext === 'offline') return queueSale();

    let body;
    let path = '/api/pos/sales';
    if (state.payDraft) {
      await ensureDraft();
      await registerManualApprovals();
      body = { client_sale_id: state.payDraft.client_sale_id, payments: payloadPayments() };
      path = '/api/pos/sales/confirm';
    } else {
      body = {
        ...saleRequestBody(),
        counsel_order_id: state.payContext === 'manual' ? null : state.counsel?.id || null,
        items: state.cart.map((line) => ({
          product_id: line.product.id,
          quantity: line.quantity,
          ...(state.payContext === 'manual' ? { price: line.product.sale_price } : {})
        })),
        payments: payloadPayments(),
        ...(state.payContext === 'manual'
          ? { recovery: { source: 'MANUAL', occurred_at: state.manual.occurred_at, outage_id: state.manual.outage_id, note: state.manual.note, ...(state.manual.ref ? { ref: state.manual.ref } : {}) } }
          : {})
      };
      body.client_sale_id = saleIdFor(body);
    }
    let receipt;
    try {
      receipt = await sendSale(body, {
        path,
        onRetry: (n, total) => setPayStatus(`서버 응답이 없어 다시 보내는 중… (${n}/${total}) 같은 거래 번호로 보내므로 두 번 저장되지 않습니다. <b>카드를 다시 승인하지 마세요.</b>`)
      });
    } catch (error) {
      setPayStatus('');
      if (error.retryable && state.payContext !== 'manual') return openSaleFailure(body, error, path);
      throw error;
    }
    await finishSale(receipt);
  }).finally(() => {
    const button = document.getElementById('payConfirm');
    if (button) renderPaymentStatus();
  });
}
