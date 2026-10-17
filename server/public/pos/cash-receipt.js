// MAYDIN POS · 현금영수증
/* ---------- 현금영수증 ----------
 * 판매를 저장한 뒤 그 판매의 현금·계좌이체 금액으로 발급한다. 금액·과세 구분은 서버가 정한다.
 * 카드 단말기(Bridge) 카운터는 고객이 단말기 키패드에 번호를 누르거나, 직원이 이 화면에 입력한 번호를 Bridge로만 보낸다.
 * 서버에는 가린 번호(010-****-5678)만 남는다. 주민등록번호는 받지 않는다.
 */

const CASH_RECEIPT_CHOICES = {
  NONE: '발급 안 함',
  INCOME: '소득공제',
  EXPENSE: '지출증빙',
  SELF: '자진발급'
};

function newCashReceiptChoice(preset = {}) {
  return { purpose: 'NONE', input: 'TERMINAL', identity: '', approval_number: '', request_id: null, ...preset };
}

function cashReceiptMode() {
  const kind = state.ctx?.van?.kind;
  if (kind === 'BRIDGE') return 'BRIDGE';
  if (kind === 'MANUAL' || !kind) return 'MANUAL';
  return 'SERVER';
}

// 결제창·발급창에서 같이 쓰는 입력 부분. onChange는 선택이 바뀔 때 다시 그리는 함수 이름.
function cashReceiptFieldsHtml(choice, onChange) {
  const mode = cashReceiptMode();
  const pick = (key) =>
    `<button class="chip ${choice.purpose === key ? 'active' : ''}" type="button" onclick="setCashReceiptChoice('purpose', '${key}', '${onChange}')">${CASH_RECEIPT_CHOICES[key]}</button>`;
  let detail = '';
  if (choice.purpose === 'SELF') {
    detail = '<div class="notice">번호를 주지 않은 고객입니다. 국세청 자진발급 번호(010-000-1234)로 발급하며, 고객이 나중에 홈택스에서 본인 것으로 등록할 수 있습니다.</div>';
  } else if (choice.purpose !== 'NONE' && mode === 'MANUAL') {
    detail = `<div class="field"><label class="label">현금영수증 승인번호</label><input class="input" value="${h(choice.approval_number)}" placeholder="기존 단말기에서 발급한 승인번호" oninput="setCashReceiptChoice('approval_number', this.value)" /></div>
      <div class="notice">이 카운터는 수동 승인 방식입니다. 기존 단말기에서 현금영수증을 발급한 뒤 승인번호만 적어 두세요.</div>`;
  } else if (choice.purpose !== 'NONE') {
    const staffInput = mode === 'SERVER' || choice.input === 'POS';
    detail = `
      ${mode === 'BRIDGE'
        ? `<div class="chips" style="margin-bottom: 6px;">
            <button class="chip ${choice.input === 'TERMINAL' ? 'active' : ''}" type="button" onclick="setCashReceiptChoice('input', 'TERMINAL', '${onChange}')">고객이 단말기 키패드로 입력</button>
            <button class="chip ${choice.input === 'POS' ? 'active' : ''}" type="button" onclick="setCashReceiptChoice('input', 'POS', '${onChange}')">직원이 입력</button>
          </div>`
        : ''}
      ${staffInput
        ? `<div class="field"><label class="label">${choice.purpose === 'EXPENSE' ? '사업자등록번호' : '휴대폰번호 · 현금영수증카드'}${mode === 'SERVER' && state.ctx?.van?.is_demo ? ' <span class="demo-tag">데모</span>' : ''}</label>
            <input class="input" value="${h(choice.identity)}" inputmode="numeric" autocomplete="off" placeholder="${choice.purpose === 'EXPENSE' ? '000-00-00000' : '010-0000-0000'}" oninput="setCashReceiptChoice('identity', this.value)" /></div>`
        : ''}
      <div class="notice" style="font-size: 12px;">${mode === 'BRIDGE'
        ? '번호는 이 PC의 카드 단말기(Bridge)로만 보내고 서버에는 가린 번호만 남깁니다. 주민등록번호는 받지 않습니다.'
        : '번호는 가린 값만 저장합니다. 주민등록번호는 받지 않습니다.'}</div>`;
  }
  return `
    <div class="chips" style="margin-bottom: 8px;">${Object.keys(CASH_RECEIPT_CHOICES).map(pick).join('')}</div>
    ${detail}
  `;
}

function setCashReceiptChoice(field, value, rerender) {
  const choice = state.cashReceiptEdit;
  if (!choice) return;
  choice[field] = value;
  if (field === 'purpose' || field === 'input') {
    choice.request_id = null;
    if (rerender && typeof window[rerender] === 'function') window[rerender]();
  } else if (state.payOpen) {
    renderPaymentStatus();
  }
}

// 결제창: 현금·계좌이체가 있는 판매면 발급 여부를 고른다. 판매 저장 뒤 발급한다.
function cashReceiptPanelHtml() {
  if (state.payMode !== 'sale' || state.payContext !== 'normal') return '';
  if (!state.payRows.some((row) => ['CASH', 'TRANSFER'].includes(row.method))) return '';
  state.cashReceiptChoice ||= newCashReceiptChoice();
  state.cashReceiptEdit = state.cashReceiptChoice;
  return `
    <div class="pay-row" data-cash-receipt-panel>
      <div class="pay-row-head"><span>현금영수증</span></div>
      ${cashReceiptFieldsHtml(state.cashReceiptChoice, 'renderPayment')}
      ${state.cashReceiptChoice.purpose !== 'NONE' ? '<div class="muted" style="font-size: 12px;">결제를 완료하면 현금·계좌이체 금액으로 발급합니다.</div>' : ''}
    </div>
  `;
}

function cashReceiptChoiceReady(choice) {
  if (!choice || choice.purpose === 'NONE' || choice.purpose === 'SELF') return true;
  const mode = cashReceiptMode();
  if (mode === 'MANUAL') return Boolean(String(choice.approval_number).trim());
  if (mode === 'SERVER' || choice.input === 'POS') return String(choice.identity).replace(/\D/g, '').length >= 10;
  return true;
}

async function issueCashReceiptForSale(orderId, choice) {
  const mode = cashReceiptMode();
  choice.request_id ||= newSaleId();
  const self = choice.purpose === 'SELF';
  const body = {
    request_id: choice.request_id,
    purpose: self ? 'INCOME' : choice.purpose,
    identity_input: self ? 'SELF' : mode === 'BRIDGE' ? choice.input : 'POS'
  };
  if (mode === 'MANUAL') body.approval_number = String(choice.approval_number).trim();
  else if (mode === 'SERVER' && !self) body.identity = choice.identity;
  const path = `/pos/sales/${orderId}/cash-receipt`;
  let data = await api.request(path, { method: 'POST', body });
  if (data.bridge_request) {
    toast(body.identity_input === 'TERMINAL' ? '고객에게 카드 단말기 키패드로 휴대폰번호(또는 현금영수증카드)를 입력하게 해 주세요.' : '카드 단말기에서 현금영수증을 발급하는 중…');
    let result;
    try {
      result = await VanBridge.cashReceipt({ ...data.bridge_request, ...(body.identity_input === 'POS' ? { identity: choice.identity } : {}) });
    } catch (error) {
      refreshPendingApprovals();
      throw error;
    }
    data = await api.request(path, { method: 'POST', body: { ...body, bridge_result: result } });
  }
  choice.identity = '';
  return data.van_transaction;
}

// 판매 저장 직후 결제창에서 고른 현금영수증을 발급한다. 실패해도 판매는 그대로이며 거래 상세에서 다시 발급할 수 있다.
async function issueChosenCashReceipt(receipt) {
  const choice = state.cashReceiptChoice;
  state.cashReceiptChoice = null;
  state.cashReceiptEdit = null;
  if (!choice || choice.purpose === 'NONE' || receipt.cash_receipts?.length || !receipt.permissions?.can_issue_cash_receipt) return receipt;
  try {
    const tx = await issueCashReceiptForSale(receipt.order.id, choice);
    toast(`현금영수증 발급 완료${tx.is_demo ? ' (데모)' : ''} · 승인번호 ${tx.approval_number}`);
    return await api.request(`/pos/sales/${receipt.order.id}`);
  } catch (error) {
    toast(`판매는 저장됐지만 현금영수증을 발급하지 못했습니다. ${error.message} 거래내역에서 다시 발급할 수 있습니다.`, 'error');
    return receipt;
  }
}

/* ---------- 거래 상세에서 발급 · 반품 후 재발급 ---------- */

async function openCashReceiptModal(orderId, preset = {}) {
  try {
    const { amounts } = await api.request(`/pos/sales/${orderId}/cash-receipt`);
    state.cashReceiptEdit = newCashReceiptChoice({ purpose: 'INCOME', ...preset });
    state.cashReceiptModal = { orderId, amounts };
    renderCashReceiptModal();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderCashReceiptModal() {
  const { orderId, amounts } = state.cashReceiptModal || {};
  if (!orderId) return;
  openModal(`
    ${modalHead('현금영수증 발급')}
    <div class="modal-body">
      <div class="pay-total"><span class="muted" style="font-weight: 700;">현금·계좌이체 금액</span><div class="amount">${won(amounts.amount)}</div>
        <div class="muted" style="font-size: 13px;">공급가액 ${won(amounts.supply_amount)} · 부가세 ${won(amounts.vat_amount)}${amounts.tax_free_amount ? ` · 면세 ${won(amounts.tax_free_amount)}` : ''}</div></div>
      ${cashReceiptFieldsHtml(state.cashReceiptEdit, 'renderCashReceiptModal')}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="openSaleDetail(${Number(orderId)})">돌아가기</button>
      <button class="btn btn-primary" type="button" onclick="submitCashReceipt()">발급</button>
    </div>
  `);
}

function submitCashReceipt() {
  const { orderId } = state.cashReceiptModal || {};
  const choice = state.cashReceiptEdit;
  if (!orderId || !choice) return;
  if (choice.purpose === 'NONE') return openSaleDetail(orderId);
  if (!cashReceiptChoiceReady(choice)) return toast(cashReceiptMode() === 'MANUAL' ? '단말기에서 발급한 승인번호를 입력해 주세요.' : '식별번호를 입력해 주세요.', 'error');
  withBusy(async () => {
    try {
      const tx = await issueCashReceiptForSale(orderId, choice);
      toast(`현금영수증 발급 완료${tx.is_demo ? ' (데모)' : ''} · 승인번호 ${tx.approval_number}`);
      state.cashReceiptModal = null;
      refreshPendingApprovals();
      await openSaleDetail(orderId);
    } catch (error) {
      refreshPendingApprovals();
      if (error.reason === 'CASH_RECEIPT_PENDING') {
        toast(error.message, 'error');
        return openApprovalManager();
      }
      throw error;
    }
  });
}

// 반품·취소 응답의 현금영수증 안내: 수동 발급분 취소 안내, 남은 금액 재발급 제안.
function handleCashReceiptAftermath(data) {
  for (const notice of data.cash_receipt_notices || []) toast(notice, 'error');
  const reissue = data.cash_receipt_reissue;
  if (!reissue) return;
  setTimeout(() => {
    if (confirm(`현금영수증을 취소했습니다. 남은 현금·계좌이체 ${won(reissue.amount)}으로 다시 발급할까요?`)) {
      openCashReceiptModal(reissue.order_id, { purpose: reissue.self_issued ? 'SELF' : reissue.purpose });
    }
  }, 300);
}
