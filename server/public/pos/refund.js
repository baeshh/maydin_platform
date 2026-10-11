// MAYDIN POS · 거래내역·판매 취소·반품
/* ---------- 거래내역 · 취소 · 반품 ---------- */

function statusBadge(order) {
  if (order.order_type === 'POS_REFUND') return '<span class="badge red">반품</span>';
  const map = {
    COMPLETED: ['green', '완료'],
    CANCELED: ['gray', '전체취소'],
    PARTIALLY_REFUNDED: ['orange', '부분반품'],
    REFUNDED: ['gray', '반품완료']
  };
  const [color, text] = map[order.order_status] || ['gray', order.order_status];
  return `<span class="badge ${color}">${text}</span>`;
}

function openHistory(date = state.ctx.today, query = '') {
  openModal(
    `
    ${modalHead('거래내역 · 취소 · 반품')}
    <div class="modal-body">
      <div style="display: grid; grid-template-columns: 180px 1fr auto auto; gap: 8px; margin-bottom: 14px;">
        <input id="historyDate" class="input" type="date" value="${h(date)}" />
        <input id="historyQuery" class="input" placeholder="영수증 바코드 스캔 · 거래번호 · 고객명 · 전화번호" value="${h(query)}" data-autofocus />
        <button class="cam-btn" type="button" onclick="scanReceiptWithCamera()">영수증 스캔</button>
        <button class="btn btn-primary" type="button" onclick="loadHistory()">조회</button>
      </div>
      <div id="historyList" class="muted">불러오는 중…</div>
    </div>
  `,
    { size: 'xwide' }
  );
  document.getElementById('historyDate').addEventListener('change', loadHistory);
  document.getElementById('historyQuery').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const code = event.target.value.trim();
    if (code && (await openReceiptByCode(code, { quiet: true }))) return;
    loadHistory();
  });
  loadHistory();
}

async function openReceiptByCode(code, { quiet = false } = {}) {
  try {
    const result = await api.request(`/pos/scan?code=${encodeURIComponent(code)}`);
    if (result.type === 'SALE') {
      openSaleDetail(result.order_id);
      return true;
    }
    if (!quiet) toast('일치하는 POS 거래가 없습니다. 영수증 하단 바코드를 스캔해 주세요.', 'error');
  } catch (error) {
    if (!quiet) toast(error.message, 'error');
  }
  return false;
}

function scanReceiptWithCamera() {
  ScanKit.openCameraScanner({
    title: '영수증 바코드 스캔',
    hint: '영수증 맨 아래 바코드를 비추면 원거래를 바로 엽니다.',
    onResult: (code) => openReceiptByCode(code)
  });
}

async function loadHistory() {
  const date = document.getElementById('historyDate').value;
  const query = document.getElementById('historyQuery').value.trim();
  try {
    const params = new URLSearchParams({ date });
    if (query) params.set('query', query);
    const data = await api.request(`/pos/sales?${params}`);
    const box = document.getElementById('historyList');
    if (!box) return;
    if (data.sales.length === 0) {
      box.innerHTML = '<div class="empty">거래가 없습니다.</div>';
      return;
    }
    const net = data.sales.reduce((sum, s) => sum + s.final_amount, 0);
    box.innerHTML = `
      <div class="muted" style="font-weight: 700; margin-bottom: 8px;">${data.sales.length}건 · 순매출 ${signedWon(net)}</div>
      <table>
        <thead><tr><th>시간</th><th>거래번호</th><th>구분</th><th>고객</th><th>상품</th><th>결제</th><th class="num">금액</th><th>판매자</th></tr></thead>
        <tbody>
          ${data.sales
            .map(
              (s) => `
              <tr class="clickable" onclick="openSaleDetail(${s.id})">
                <td>${query ? fmtDateTime(s.created_at) : fmtTime(s.created_at)}</td>
                <td style="font-weight: 700;">${h(s.order_number)}${s.original_order_number ? `<div class="muted" style="font-size: 12px;">원거래 ${h(s.original_order_number)}</div>` : ''}</td>
                <td>${statusBadge(s)}</td>
                <td>${h(s.customer_name)}</td>
                <td style="max-width: 280px; font-size: 13px;">${h(s.items_summary || '')}</td>
                <td style="font-size: 13px;">${(s.payment_methods || '').split(',').filter(Boolean).map((m) => METHOD_LABELS[m] || m).join(' + ')}</td>
                <td class="num" style="font-weight: 800; ${s.final_amount < 0 ? 'color: var(--danger);' : ''}">${signedWon(s.final_amount)}</td>
                <td>${h(s.cashier_name || '-')}</td>
              </tr>
            `
            )
            .join('')}
        </tbody>
      </table>
    `;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openSaleDetail(id) {
  try {
    const r = await api.request(`/pos/sales/${id}`);
    window.__detail = r;
    const { order, refunds, permissions } = r;
    openModal(
      `
      ${modalHead(`거래 상세 · ${h(order.order_number)}`)}
      <div class="modal-body">
        <div class="split">
          <div style="background: var(--bg-canvas); border-radius: 16px; padding: 16px;">${receiptHtml(r)}</div>
          <div>
            <div class="section-title">처리</div>
            <div class="list">
              <button class="btn btn-outline btn-block" type="button" onclick="reprint(${order.id})">영수증 재출력</button>
              ${permissions.can_issue_signup_code ? `<button class="btn btn-outline btn-block" type="button" onclick="reissueSignupCode(${order.id}, ${Boolean(r.signup_code)})">${r.signup_code ? '가입 코드 재발급' : '가입 코드 발급'}</button>` : ''}
              ${permissions.can_cancel ? `<button class="btn btn-danger-soft btn-block" type="button" onclick="openCancel()">당일 전체 취소</button>` : ''}
              ${permissions.can_refund ? `<button class="btn btn-soft btn-block" type="button" onclick="openRefund()">부분 반품</button>` : ''}
              ${order.original_order_id ? `<button class="btn btn-outline btn-block" type="button" onclick="openSaleDetail(${order.original_order_id})">원거래 보기</button>` : ''}
            </div>
            ${!isOwner() && order.order_type === 'POS_SALE' ? '<div class="notice" style="margin-top: 10px;">취소·반품은 약국 관리자 계정으로 처리할 수 있습니다.</div>' : ''}
            ${order.order_type === 'POS_SALE' && order.order_status === 'COMPLETED' && !permissions.can_cancel && isOwner() ? '<div class="notice" style="margin-top: 10px;">지난 거래는 전체 취소 대신 부분 반품으로 처리합니다.</div>' : ''}
            ${refunds.length
              ? `<div class="section-title">반품 · 취소 이력</div>
                 <div class="list">${refunds
                   .map(
                     (rf) => `
                     <button class="list-item" type="button" onclick="openSaleDetail(${rf.id})">
                       <div><div style="font-weight: 800;">${rf.refund_type === 'CANCEL' ? '전체 취소' : '부분 반품'} · ${h(rf.order_number)}</div>
                       <div class="muted" style="font-size: 13px;">${fmtDateTime(rf.created_at)} · ${h(rf.created_by_name || '')} · ${h(rf.refund_reason || '')}</div></div>
                       <strong style="color: var(--danger);">${signedWon(rf.final_amount)}</strong>
                     </button>`
                   )
                   .join('')}</div>`
              : ''}
            <div style="margin-top: 16px;"><button class="btn btn-outline btn-block" type="button" onclick="openHistory()">← 거래내역으로</button></div>
          </div>
        </div>
      </div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

function reissueSignupCode(id, hasCode) {
  if (hasCode && !confirm('새 코드를 발급하면 지금 영수증의 코드는 쓸 수 없게 됩니다. 계속할까요?')) return;
  withBusy(async () => {
    const r = await api.request(`/pos/sales/${id}/signup-code`, { method: 'POST' });
    await openSaleDetail(id);
    toast(`가입 코드 ${r.issued.code} (7일 유효)를 발급했습니다. 영수증을 다시 출력해 전달해 주세요.`);
  });
}

function reprint(id) {
  withBusy(async () => {
    const r = await api.request(`/pos/sales/${id}/reprint`, { method: 'POST' });
    printReceipt(r, { reprint: true });
    toast('영수증을 재출력합니다.');
  });
}

function reasonChips(targetId, reasons) {
  return `<div class="chips" style="margin-bottom: 14px;">${reasons
    .map((r) => `<button class="chip" type="button" onclick="document.getElementById('${targetId}').value='${r}'">${r}</button>`)
    .join('')}</div>`;
}

function openCancel() {
  const r = window.__detail;
  const hasCard = r.payments.some((p) => p.payment_method === 'CARD' && p.paid_amount > 0 && !['VAN_DEMO', 'VAN_BRIDGE'].includes(p.payment_provider));
  const hasVanDemo = r.payments.some((p) => p.paid_amount > 0 && p.payment_provider === 'VAN_DEMO');
  const hasBridge = r.payments.some((p) => p.paid_amount > 0 && p.payment_provider === 'VAN_BRIDGE');
  openModal(`
    ${modalHead('당일 전체 취소')}
    <div class="modal-body">
      <div class="pay-total"><span class="muted" style="font-weight: 700;">${h(r.order.order_number)} 환불 금액</span><div class="amount" style="color: var(--danger);">${won(r.order.final_amount)}</div></div>
      ${r.payments
        .filter((p) => p.paid_amount > 0)
        .map((p) => `<div class="kv"><span>${METHOD_LABELS[p.payment_method]}${p.approval_number ? ` (승인 ${h(p.approval_number)})` : ''}</span><span>${won(p.paid_amount)} 환불</span></div>`)
        .join('')}
      ${hasCard ? `<div class="notice warn" style="margin: 10px 0;">카드 결제분은 기존 단말기에서 먼저 <b>승인 취소</b>한 뒤 진행하세요.</div>
        <div class="field"><label class="label" for="cancelApproval">카드 취소 승인번호 (선택)</label><input id="cancelApproval" class="input" placeholder="단말기 취소 영수증의 승인번호" /></div>` : ''}
      ${hasVanDemo ? '<div class="notice" style="margin: 10px 0; background: #f3e8ff; color: #6d28d9;">VAN 자동 승인(데모) 결제분은 확정 시 <b>VAN 자동 취소 (데모)</b>로 취소 승인번호가 발급됩니다.</div>' : ''}
      ${hasBridge ? '<div class="notice" style="margin: 10px 0;">카드 단말기 연동 결제분은 확정하면 <b>이 카운터의 카드 단말기에서 승인 취소</b>를 진행합니다. 고객 카드를 준비해 주세요.</div>' : ''}
      <div class="field" style="margin-top: 12px;"><label class="label" for="cancelReason">취소 사유 (필수)</label><input id="cancelReason" class="input" data-autofocus /></div>
      ${reasonChips('cancelReason', ['고객 변심', '결제 수단 변경', '금액 입력 오류', '상품 불량'])}
      <label style="display: flex; gap: 8px; align-items: center; font-weight: 700;"><input id="cancelRestock" type="checkbox" checked /> 상품을 재고로 되돌리기 (재입고)</label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="openSaleDetail(${r.order.id})">돌아가기</button>
      <button class="btn btn-danger" type="button" onclick="confirmCancel()">전체 취소 확정</button>
    </div>
  `);
}

// 카드 단말기(Bridge)로 승인한 결제는 단말기에서 먼저 취소하고, 서명된 취소 결과를 붙여 다시 보낸다.
// 취소 요청 번호를 남겨 두어, 서버 저장이 실패해 다시 보내도 단말기에서 두 번 취소하지 않는다.
async function postWithVanCancels(path, body) {
  const cancels = (state.vanCancelResults ||= {});
  for (let round = 0; round < 2; round += 1) {
    try {
      return await api.request(path, { method: 'POST', body: { ...body, van_cancels: Object.values(cancels).filter((c) => c.path === path).map(({ path: _p, ...c }) => c) } });
    } catch (error) {
      if (error.reason !== 'VAN_CANCEL_REQUIRED' || !error.data?.cancels?.length || round > 0) throw error;
      for (const request of error.data.cancels) {
        const key = `${path}:${request.original_approval_number}`;
        if (cancels[key]) continue;
        const requestIds = (state.vanCancelRequestIds ||= {});
        requestIds[key] ||= newSaleId();
        toast(`카드 단말기에서 ${won(request.amount)} 승인 취소 중… 고객 카드를 단말기에 꽂아 주세요.`);
        const result = await VanBridge.cancel({ ...request, request_id: requestIds[key] });
        cancels[key] = { path, original_approval_number: request.original_approval_number, bridge_result: result };
      }
    }
  }
  return null;
}

function forgetVanCancels(path) {
  for (const [key, value] of Object.entries(state.vanCancelResults || {})) if (value.path === path) delete state.vanCancelResults[key];
  for (const key of Object.keys(state.vanCancelRequestIds || {})) if (key.startsWith(`${path}:`)) delete state.vanCancelRequestIds[key];
}

function confirmCancel() {
  const r = window.__detail;
  withBusy(async () => {
    const reason = document.getElementById('cancelReason').value.trim();
    if (!reason) throw new Error('취소 사유를 입력해 주세요.');
    const path = `/pos/sales/${r.order.id}/cancel`;
    const data = await postWithVanCancels(path, {
      reason,
      restock: document.getElementById('cancelRestock').checked,
      card_cancel_approval_number: document.getElementById('cancelApproval')?.value.trim() || undefined
    });
    forgetVanCancels(path);
    await Promise.all([refreshSession(), loadProducts()]);
    toast(`전체 취소 완료 · ${won(-data.refund.order.final_amount)} 환불`);
    showReceipt(data.refund);
  });
}

function estimateRefund(item, qty) {
  if (!qty) return 0;
  const net = item.total_price - (item.discount_amount || 0);
  const remaining = item.quantity - (item.refunded_quantity || 0);
  return qty === remaining ? net - (item.refunded_amount || 0) : Math.floor((net * qty) / item.quantity);
}

function openRefund() {
  const r = window.__detail;
  const balances = Object.entries(r.payment_balances || {}).filter(([, v]) => v > 0);
  const multi = balances.length > 1;
  openModal(
    `
    ${modalHead('부분 반품')}
    <div class="modal-body">
      <table>
        <thead><tr><th>상품</th><th class="num">판매</th><th class="num">반품 가능</th><th class="num">반품 수량</th><th class="num">환불 예정</th></tr></thead>
        <tbody>
          ${r.items
            .map(
              (item) => `
              <tr>
                <td style="font-weight: 700;">${h(item.product_name)}<div class="muted" style="font-size: 12px;">${won(item.price)}${item.discount_amount ? ` · 할인 안분 ${won(item.discount_amount)}` : ''}</div></td>
                <td class="num">${item.quantity}</td>
                <td class="num">${item.refundable_quantity}</td>
                <td class="num"><input class="input" style="width: 84px; text-align: center; padding: 8px;" type="number" min="0" max="${item.refundable_quantity}" value="0" data-item="${item.id}" oninput="updateRefundPreview()" ${item.refundable_quantity === 0 ? 'disabled' : ''} /></td>
                <td class="num" id="refund-est-${item.id}">0원</td>
              </tr>
            `
            )
            .join('')}
        </tbody>
      </table>
      <div class="remain" style="margin: 14px 0;"><span>환불 금액</span><span id="refundTotal">0원</span></div>
      ${multi
        ? `<div class="notice warn" style="margin-bottom: 10px;">복합결제 거래입니다. 결제수단별 환불 금액을 나눠 입력하세요.</div>
           <div class="pay-row-grid" style="margin-bottom: 14px;">
             ${balances
               .map(
                 ([method, balance]) => `<div><label class="label">${METHOD_LABELS[method]} 환불 (최대 ${won(balance)})</label><input class="input" type="number" min="0" max="${balance}" data-refund-method="${method}" value="0" /></div>`
               )
               .join('')}
           </div>`
        : balances.length === 1
          ? `<div class="notice" style="margin-bottom: 14px;">${METHOD_LABELS[balances[0][0]]}(으)로 환불됩니다.${
              r.payments.some((p) => p.payment_method === balances[0][0] && p.payment_provider === 'VAN_DEMO')
                ? ' VAN 자동 부분취소 (데모)로 처리됩니다.'
                : r.payments.some((p) => p.payment_method === balances[0][0] && p.payment_provider === 'VAN_BRIDGE')
                  ? ' 이 카운터의 카드 단말기에서 부분 취소를 진행합니다.'
                  : balances[0][0] === 'CARD'
                  ? ' 카드는 단말기에서 부분 취소 후 진행하세요.'
                  : ''
            }</div>`
          : ''}
      <div class="field"><label class="label" for="refundReason">반품 사유 (필수)</label><input id="refundReason" class="input" /></div>
      ${reasonChips('refundReason', ['상품 불량', '고객 변심', '유통기한 문제', '오판매'])}
      <label style="display: flex; gap: 8px; align-items: center; font-weight: 700;"><input id="refundRestock" type="checkbox" checked /> 반품 상품을 재고로 되돌리기 (재입고)</label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="openSaleDetail(${r.order.id})">돌아가기</button>
      <button class="btn btn-primary" type="button" onclick="confirmRefund()">반품 확정</button>
    </div>
  `,
    { size: 'wide' }
  );
}

function refundSelection() {
  const r = window.__detail;
  return [...document.querySelectorAll('[data-item]')]
    .map((input) => {
      const item = r.items.find((i) => i.id === Number(input.dataset.item));
      const qty = Math.max(0, Math.min(Number(input.value) || 0, item.refundable_quantity));
      return { item, qty };
    })
    .filter((row) => row.qty > 0);
}

function updateRefundPreview() {
  const r = window.__detail;
  let total = 0;
  for (const item of r.items) {
    const input = document.querySelector(`[data-item="${item.id}"]`);
    const qty = Math.max(0, Math.min(Number(input?.value) || 0, item.refundable_quantity));
    const amount = estimateRefund(item, qty);
    total += amount;
    const cell = document.getElementById(`refund-est-${item.id}`);
    if (cell) cell.textContent = won(amount);
  }
  document.getElementById('refundTotal').textContent = won(total);
  const methodInputs = document.querySelectorAll('[data-refund-method]');
  if (methodInputs.length > 1) {
    const cash = [...methodInputs].find((i) => i.dataset.refundMethod === 'CASH');
    const others = [...methodInputs].filter((i) => i !== cash);
    let left = total;
    for (const input of others) {
      const value = Math.min(Number(input.max), left);
      input.value = value;
      left -= value;
    }
    if (cash) cash.value = Math.min(Number(cash.max), left);
  }
}

function confirmRefund() {
  const r = window.__detail;
  withBusy(async () => {
    const selection = refundSelection();
    if (selection.length === 0) throw new Error('반품할 수량을 입력해 주세요.');
    const reason = document.getElementById('refundReason').value.trim();
    if (!reason) throw new Error('반품 사유를 입력해 주세요.');
    const methodInputs = [...document.querySelectorAll('[data-refund-method]')];
    const payments =
      methodInputs.length > 1
        ? methodInputs
            .map((input) => ({ method: input.dataset.refundMethod, amount: Number(input.value) || 0 }))
            .filter((p) => p.amount > 0)
        : undefined;
    const path = `/pos/sales/${r.order.id}/refunds`;
    const data = await postWithVanCancels(path, {
      reason,
      restock: document.getElementById('refundRestock').checked,
      items: selection.map((row) => ({ order_item_id: row.item.id, quantity: row.qty })),
      payments
    });
    forgetVanCancels(path);
    await Promise.all([refreshSession(), loadProducts()]);
    toast(`반품 완료 · ${won(-data.refund.order.final_amount)} 환불`);
    showReceipt(data.refund);
  });
}
