// MAYDIN POS · 보류 판매
/* ---------- 보류 판매 ---------- */

function holdPayload(label) {
  return {
    label,
    customer_id: state.customer?.id || null,
    counsel_order_id: state.counsel?.id || null,
    items: state.cart.map((line) => ({ product_id: line.product.id, quantity: line.quantity })),
    discount_amount: totals().discount,
    discount_reason: state.discount.reason
  };
}

function openHoldCurrent() {
  if (!requireSession()) return;
  if (state.cart.length === 0) return toast('보류할 상품이 없습니다.', 'error');
  const t = totals();
  openModal(`
    ${modalHead('판매 보류')}
    <div class="modal-body">
      <div class="pay-total"><span class="muted" style="font-weight: 700;">${state.cart.length}종 · ${state.cart.reduce((s, l) => s + l.quantity, 0)}개</span><div class="amount">${won(t.final)}</div></div>
      <div class="field">
        <label class="label" for="holdLabel">구분 메모 (선택)</label>
        <input id="holdLabel" class="input" maxlength="30" placeholder="예: 파란 점퍼 고객, 처방전 대기" data-autofocus onkeydown="if (event.key === 'Enter') confirmHold()" />
      </div>
      ${reasonChips('holdLabel', ['처방전 대기', '추가 상품 고르는 중', '결제수단 가지러 감', '약사 상담 중'])}
      <div class="notice">보류해도 재고는 차감되지 않습니다. 보류 번호를 고객에게 알려 주고 다음 고객을 받으세요.</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="closeModal()">취소</button>
      <button class="btn btn-primary" type="button" onclick="confirmHold()">보류하기</button>
    </div>
  `);
}

function confirmHold() {
  withBusy(async () => {
    const label = document.getElementById('holdLabel')?.value.trim() || '';
    const data = await api.request('/pos/holds', { method: 'POST', body: holdPayload(label) });
    clearCart();
    closeModal();
    setBadge('holdCount', data.hold_count);
    toast(`보류 #${data.hold.hold_number} 저장 · ${won(data.hold.total_amount - data.hold.discount_amount)}`);
  });
}

async function openHolds() {
  try {
    const data = await api.request('/pos/holds');
    setBadge('holdCount', data.holds.length);
    openModal(
      `
      ${modalHead('보류 목록')}
      <div class="modal-body">
        <div class="list">
          ${data.holds.length
            ? data.holds
                .map(
                  (hold) => `
                  <div class="list-item" style="align-items: flex-start;">
                    <div style="min-width: 0;">
                      <div style="font-weight: 900; font-size: 17px;">#${hold.hold_number} ${hold.label ? `<span style="font-weight: 700; font-size: 15px;">· ${h(hold.label)}</span>` : ''}</div>
                      <div class="muted" style="font-size: 13px; font-weight: 600; margin: 3px 0 6px;">${fmtTime(hold.created_at)} · ${h(hold.created_by_name || '')} · ${hold.customer_name ? `회원 ${h(hold.customer_name)}` : '비회원'}${hold.counsel_order_number ? ` · 상담 ${h(hold.counsel_order_number)}` : ''}</div>
                      <div style="font-size: 14px; line-height: 1.5;">${hold.items.map((i) => `${h(i.product_name)} ×${i.quantity}`).join(', ')}</div>
                    </div>
                    <div style="flex-shrink: 0; text-align: right; display: grid; gap: 6px;">
                      <strong style="font-size: 17px;">${won(hold.total_amount - hold.discount_amount)}</strong>
                      <button class="btn btn-primary btn-sm" type="button" onclick="recallHold(${hold.id})">불러오기</button>
                      <button class="btn btn-danger-soft btn-sm" type="button" onclick="discardHold(${hold.id}, ${hold.hold_number})">폐기</button>
                    </div>
                  </div>`
                )
                .join('')
            : '<div class="empty">보류 중인 판매가 없습니다.<br />판매 목록에서 <b>보류</b>(F6)를 누르면 여기에 저장됩니다.</div>'}
        </div>
      </div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

function recallHold(id) {
  withBusy(async () => {
    if (state.cart.length > 0) {
      if (!confirm('현재 판매 목록을 먼저 보류하고 불러올까요?')) return;
      const saved = await api.request('/pos/holds', { method: 'POST', body: holdPayload('자동 보류') });
      toast(`현재 판매를 보류 #${saved.hold.hold_number}(으)로 저장했습니다.`);
    }
    const data = await api.request(`/pos/holds/${id}/recall`, { method: 'POST' });
    clearCart();
    cacheProducts(data.items.map((item) => item.product));
    state.cart = data.items.map((item) => ({ product: item.product, quantity: item.quantity }));
    state.discount = data.discount.amount > 0 ? { amount: data.discount.amount, reason: data.discount.reason || '보류 할인' } : { amount: 0, reason: '' };
    state.counsel = data.counsel;
    if (data.customer) await selectCustomer(data.customer.id, { silent: true });
    renderCustomer();
    renderCart();
    closeModal();
    setBadge('holdCount', data.hold_count);
    if (data.warnings.length) {
      openModal(`
        ${modalHead(`보류 #${data.hold.hold_number} 불러오기 · 변경 사항`)}
        <div class="modal-body">
          <div class="notice warn" style="margin-bottom: 10px;">보류 이후 상품 정보가 바뀌었습니다. 판매 목록을 확인해 주세요.</div>
          ${data.warnings.map((w) => `<div class="kv"><span>${h(w)}</span></div>`).join('')}
        </div>
        <div class="modal-foot"><button class="btn btn-primary" type="button" onclick="closeModal()" data-autofocus>확인</button></div>
      `);
    } else {
      toast(`보류 #${data.hold.hold_number}을(를) 불러왔습니다.`);
    }
  });
}

function discardHold(id, number) {
  if (!confirm(`보류 #${number}을(를) 폐기할까요? 되돌릴 수 없습니다.`)) return;
  withBusy(async () => {
    await api.request(`/pos/holds/${id}/discard`, { method: 'POST' });
    toast(`보류 #${number}을(를) 폐기했습니다.`);
    openHolds();
  });
}
