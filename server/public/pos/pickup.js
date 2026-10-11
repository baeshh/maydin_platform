// MAYDIN POS · 픽업·복약상담
/* ---------- 픽업 ---------- */

function openPickups(scope = 'pending', selectId = null) {
  state.pickup = null;
  openModal(
    `
    ${modalHead('온라인 픽업 주문')}
    <div class="modal-body">
      <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 8px; margin-bottom: 12px;">
        <input id="pickupQuery" class="input" placeholder="픽업 바코드 스캔 · 주문번호 · 고객명 · 전화번호 뒷자리" data-autofocus />
        <button class="cam-btn" type="button" onclick="scanPickupWithCamera('${scope}')">바코드 스캔</button>
        <div class="tabs" style="margin: 0;">
          <button class="chip ${scope === 'pending' ? 'active' : ''}" type="button" onclick="openPickups('pending')">수령 대기</button>
          <button class="chip ${scope === 'all' ? 'active' : ''}" type="button" onclick="openPickups('all')">전체</button>
        </div>
      </div>
      <div class="split">
        <div class="list" id="pickupList" style="align-content: start; max-height: 60vh; overflow-y: auto;"></div>
        <div id="pickupDetail"><div class="notice">왼쪽에서 주문을 선택하세요.</div></div>
      </div>
    </div>
  `,
    { size: 'wide' }
  );
  let timer;
  const input = document.getElementById('pickupQuery');
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadPickups(scope), 200);
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    if (await selectPickupByCode(input.value.trim())) input.value = '';
    else loadPickups(scope);
  });
  loadPickups(scope).then(() => {
    if (selectId) selectPickup(selectId, document.querySelector(`#pickupList [data-pickup="${selectId}"]`));
  });
}

async function selectPickupByCode(code) {
  if (!code) return false;
  try {
    const result = await api.request(`/pos/scan?code=${encodeURIComponent(code)}`);
    if (result.type !== 'PICKUP') return false;
    await selectPickup(result.order_id, document.querySelector(`#pickupList [data-pickup="${result.order_id}"]`));
    return true;
  } catch (error) {
    return false;
  }
}

function scanPickupWithCamera(scope) {
  ScanKit.openCameraScanner({
    title: '픽업 주문 바코드 스캔',
    hint: '고객 앱 주문 내역의 픽업 바코드를 비춰 주세요.',
    onResult: async (code) => {
      if (!(await selectPickupByCode(code))) toast('일치하는 픽업 주문이 없습니다.', 'error');
    }
  });
}

async function loadPickups(scope) {
  const query = document.getElementById('pickupQuery')?.value.trim() || '';
  try {
    const data = await api.request(`/pos/pickups?scope=${scope}&query=${encodeURIComponent(query)}`);
    const box = document.getElementById('pickupList');
    if (!box) return;
    box.innerHTML = data.pickups.length
      ? data.pickups
          .map(
            (o) => `
            <button class="list-item" type="button" data-pickup="${o.id}" onclick="selectPickup(${o.id}, this)">
              <div>
                <div style="font-weight: 800;">${h(o.customer_name || '-')} <span class="muted" style="font-size: 13px;">${h(maskPhone(o.customer_phone || o.contact_phone))}</span></div>
                <div class="muted" style="font-size: 13px; font-weight: 600; margin-top: 2px;">${h(o.order_number)} · 희망 ${h(o.preferred_at || '-')}</div>
              </div>
              <div style="text-align: right;">
                ${['PICKED_UP', 'COMPLETED'].includes(o.order_status) ? '<span class="badge green">수령 완료</span>' : o.order_status === 'CANCELED' ? '<span class="badge gray">취소</span>' : o.order_status === 'REFUNDED' ? '<span class="badge gray">환불</span>' : o.payment_status === 'PAID' ? '<span class="badge blue">결제완료</span>' : '<span class="badge orange">현장결제</span>'}
                <div style="font-weight: 800; margin-top: 4px;">${won(o.final_amount)}</div>
              </div>
            </button>
          `
          )
          .join('')
      : '<div class="empty">픽업 주문이 없습니다.</div>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function selectPickup(id, el) {
  document.querySelectorAll('#pickupList .list-item').forEach((item) => item.classList.remove('selected'));
  el?.classList.add('selected');
  try {
    const data = await api.request(`/pos/pickups/${id}`);
    state.pickup = data;
    const { order, items } = data;
    const done = ['PICKED_UP', 'COMPLETED', 'CANCELED', 'REFUNDED'].includes(order.order_status);
    document.getElementById('pickupDetail').innerHTML = `
      <div class="section-title">${h(order.order_number)}</div>
      <div class="kv"><span>수령인</span><span>${h(order.contact_name || order.customer_name || '-')}</span></div>
      <div class="kv"><span>연락처</span><span>${h(order.contact_phone || order.customer_phone || '-')}</span></div>
      <div class="kv"><span>희망 픽업</span><span>${h(order.preferred_at || '-')}</span></div>
      <div class="kv"><span>주문 일시</span><span>${fmtDateTime(order.created_at)}</span></div>
      ${order.memo ? `<div class="kv"><span>요청사항</span><span>${h(order.memo)}</span></div>` : ''}
      <div class="section-title">상품</div>
      ${items.map((i) => `<div class="kv"><span>${h(i.product_name)} × ${i.quantity}</span><span>${won(i.total_price)}</span></div>`).join('')}
      <div class="kv strong"><span>${order.payment_status === 'PAID' ? '결제 완료 금액' : '카운터 결제 금액'}</span><span>${won(order.final_amount)}</span></div>
      ${done
        ? `<div class="notice" style="margin-top: 12px;">${order.order_status === 'CANCELED' ? '취소된 주문입니다.' : order.order_status === 'REFUNDED' ? '환불된 주문입니다.' : `수령 완료 · ${fmtDateTime(order.picked_up_at)}`}</div>`
        : `
          <label style="display: flex; gap: 8px; align-items: center; font-weight: 700; margin: 14px 0;">
            <input id="pickupVerified" type="checkbox" /> 수령인 이름과 연락처 뒷자리를 확인했습니다
          </label>
          <button class="btn btn-primary btn-block btn-lg" type="button" onclick="completePickup()">${order.payment_status === 'PAID' ? '수령 완료 처리' : '결제 후 수령 완료'}</button>
        `}
    `;
  } catch (error) {
    toast(error.message, 'error');
  }
}

function completePickup() {
  if (!document.getElementById('pickupVerified').checked) return toast('수령인 본인 확인을 체크해 주세요.', 'error');
  const { order } = state.pickup;
  if (order.payment_status !== 'PAID') {
    if (!requireSession()) return;
    return openPayment('pickup');
  }
  withBusy(async () => {
    await api.request(`/pos/pickups/${order.id}/complete`, { method: 'POST', body: {} });
    toast(`${order.order_number} 수령 완료`);
    refreshBadges();
    openPickups();
  });
}

/* ---------- 복약상담 ---------- */

async function openCounsels() {
  try {
    const data = await api.request('/pos/counsels');
    openModal(
      `
      ${modalHead('복약상담 예약')}
      <div class="modal-body">
        <div class="notice" style="margin-bottom: 12px;">일반의약품은 온라인 결제 없이 상담 예약만 받습니다. 상담 후 구매하면 <b>판매 연결</b>을 눌러 현장 판매로 이어가세요.</div>
        <div class="list">
          ${data.counsels.length
            ? data.counsels
                .map(
                  (c) => `
                  <div class="list-item" style="align-items: flex-start;">
                    <div style="min-width: 0;">
                      <div style="font-weight: 800;">${h(c.customer_name || c.contact_name || '-')} <span class="muted" style="font-size: 13px;">${h(c.contact_phone || c.customer_phone || '')}</span></div>
                      <div class="muted" style="font-size: 13px; font-weight: 600; margin: 2px 0 6px;">${h(c.order_number)} · 희망 ${h(c.preferred_at || '-')}</div>
                      ${c.has_note
                        ? isOwner()
                          ? `<button class="btn btn-outline btn-sm" type="button" onclick="showCounselNote(${c.id})">미리 전한 내용 보기</button>`
                          : '<div class="muted" style="font-size: 13px;">미리 전한 내용 있음 · 약사만 열람</div>'
                        : ''}
                    </div>
                    <div class="list" style="flex-shrink: 0;">
                      <button class="btn btn-primary btn-sm" type="button" onclick='linkCounsel(${JSON.stringify({ id: c.id, order_number: c.order_number, customer_id: c.customer_id })})'>판매 연결</button>
                      <button class="btn btn-outline btn-sm" type="button" onclick="completeCounsel(${c.id})">상담만 완료</button>
                    </div>
                  </div>
                `
                )
                .join('')
            : '<div class="empty">대기 중인 상담 예약이 없습니다.</div>'}
        </div>
      </div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function linkCounsel(counsel) {
  state.counsel = counsel;
  if (counsel.customer_id) await selectCustomer(counsel.customer_id, { silent: true });
  renderCustomer();
  closeModal();
  toast('상담 예약을 연결했습니다. 상품을 담아 판매하세요.');
}

function completeCounsel(id) {
  if (!confirm('구매 없이 상담을 완료 처리할까요?')) return;
  withBusy(async () => {
    await api.request(`/pos/counsels/${id}/complete`, { method: 'POST' });
    toast('상담을 완료 처리했습니다.');
    refreshBadges();
    openCounsels();
  });
}
