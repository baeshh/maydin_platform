// MAYDIN POS · 회원 확인·건강 정보
/* ---------- 고객 ---------- */

function renderCustomer() {
  const box = document.getElementById('customerBox');
  if (state.customer) {
    const c = state.customer;
    const recent = state.customerOrders[0];
    box.innerHTML = `
      <div class="customer-card member">
        <div>
          <div class="customer-name">${h(c.name)} <span class="badge blue">회원 M${c.id}</span></div>
          <div class="customer-sub">${h(maskPhone(c.phone))} · 구매 ${Number(c.order_count || 0)}회${recent ? ` · 최근 ${fmtDateTime(recent.created_at).slice(0, 12)}` : ''}</div>
          ${memberBadges(c.membership)}
          ${pointsEnabled() ? `<button class="point-chip" type="button" onclick="openPointHistory(${c.id})">포인트 <b>${Number(c.point_balance || 0).toLocaleString()}P</b></button>` : ''}
        </div>
        <div class="chips">
          <button class="btn btn-outline btn-sm" type="button" onclick="openCustomerSearch()">변경</button>
          <button class="btn btn-outline btn-sm" type="button" onclick="unsetCustomer()">비회원</button>
        </div>
      </div>
    `;
  } else {
    box.innerHTML = `
      <div class="customer-card">
        <div>
          <div class="customer-name">비회원 판매</div>
          <div class="customer-sub">회원이면 전화번호로 찾아 구매이력에 남기세요.</div>
        </div>
        <button class="btn btn-soft btn-sm" type="button" onclick="openCustomerSearch()">회원 찾기 (F4)</button>
      </div>
    `;
  }
  document.getElementById('counselBox').innerHTML = state.counsel
    ? `<div class="linked-counsel"><span>복약상담 연결 · ${h(state.counsel.order_number)}</span><button class="line-remove" type="button" onclick="unlinkCounsel()">해제</button></div>`
    : '';
}

function memberBadges(m) {
  if (!m) return '';
  const badges = [];
  const bonus = pointsEnabled() && m.grade_bonus > 0 ? ` +${m.grade_bonus}%p` : '';
  badges.push(`<span class="badge grade" style="background: ${h(m.grade_color)};">${h(m.grade_label)}${bonus}</span>`);
  if (m.birthday_this_month) {
    badges.push(`<span class="badge orange">생일 달${pointsEnabled() && m.birthday_multiplier > 1 ? ` 적립 ${m.birthday_multiplier}배` : ''}</span>`);
  }
  if (m.status === 'AT_RISK') badges.push(`<span class="badge red">이탈 위험 · ${Number(m.days_since_last)}일 만에 방문</span>`);
  if (m.status === 'DORMANT') badges.push(`<span class="badge red">휴면 · ${Number(m.days_since_last)}일 만에 방문</span>`);
  if (m.status === 'NEW') badges.push('<span class="badge green">신규</span>');
  if (m.refill_due.length) {
    badges.push(`<span class="badge blue" title="${h(m.refill_due.join(', '))}">재구매 시기 ${h(m.refill_due[0])}${m.refill_due.length > 1 ? ` 외 ${m.refill_due.length - 1}` : ''}</span>`);
  }
  if (m.family_text) badges.push(`<span class="badge gray">가족 ${h(m.family_text)}</span>`);
  if (m.family_head) badges.push(`<span class="badge gray">${h(m.family_head)} 회원 가족</span>`);
  if (m.has_health) {
    badges.push('<button class="badge red" type="button" style="border: 0; cursor: pointer;" onclick="showCustomerHealth()">알레르기·복용 약 확인</button>');
  }
  return `<div class="member-badges">${badges.join('')}</div>`;
}

const HEALTH_PURPOSES = {
  SALE_CHECK: '판매 전 함께 먹으면 안 되는 약 확인',
  COUNSEL: '복약상담',
  CUSTOMER_REQUEST: '고객 요청에 따른 확인·정정'
};

// 열람 목적을 먼저 고른다. 목적과 열람 기록은 고객 앱에도 보인다.
function showCustomerHealth() {
  if (!state.customer) return;
  openModal(`
    ${modalHead(`${h(state.customer.name)}님 건강 정보 열람`)}
    <div class="modal-body">
      <div class="section-title">열람 목적</div>
      <div class="list">
        ${Object.entries(HEALTH_PURPOSES).map(([key, label], i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-outline'}" type="button" onclick="viewCustomerHealth('${key}')" ${i === 0 ? 'data-autofocus' : ''}>${h(label)}</button>`).join('')}
      </div>
      <div class="notice" style="margin-top: 12px;">누가 언제 어떤 목적으로 열람했는지 기록되고, 고객도 앱에서 확인할 수 있습니다.</div>
    </div>
    <div class="modal-foot"><button class="btn btn-outline" type="button" onclick="closeModal()">닫기</button></div>
  `);
}

function viewCustomerHealth(purpose) {
  if (!state.customer) return;
  withBusy(async () => {
    const { health, agreed } = await api.request(`/pos/customers/${state.customer.id}/health?purpose=${purpose}`);
    openModal(`
      ${modalHead(`${h(state.customer.name)}님 건강 정보`)}
      <div class="modal-body">
        <form id="posHealthForm" onsubmit="savePosHealth(event)">
          <div class="section-title">알레르기</div>
          <textarea class="input" name="allergy" maxlength="300" rows="2" style="width: 100%; font-size: 16px; font-weight: 700;" placeholder="없음" ${agreed ? '' : 'readonly'}>${h(health?.allergy || '')}</textarea>
          <div class="section-title" style="margin-top: 12px;">지금 복용 중인 약</div>
          <textarea class="input" name="medications" maxlength="300" rows="2" style="width: 100%; font-size: 16px; font-weight: 700;" placeholder="없음" ${agreed ? '' : 'readonly'}>${h(health?.medications || '')}</textarea>
        </form>
        <div class="notice" style="margin-top: 12px;">
          열람 목적: ${h(HEALTH_PURPOSES[purpose])}${health ? ` · ${health.updated_by === 'PHARMACIST' ? '약사 수정' : '고객 입력'} ${h(fmtDateTime(health.updated_at))} · ${h(fmtDateTime(health.expires_at))} 자동 삭제` : ''}.
          비워 두면 '없음'으로 저장됩니다. 복약 상담 외의 목적으로 쓰지 마세요.
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" type="button" onclick="closeModal()" data-autofocus>닫기</button>
        ${agreed ? '<button class="btn btn-primary" type="submit" form="posHealthForm">상담 내용으로 저장</button>' : ''}
      </div>
    `);
  });
}

function savePosHealth(event) {
  event.preventDefault();
  const f = event.target;
  withBusy(async () => {
    await api.request(`/pos/customers/${state.customer.id}/health`, {
      method: 'PUT',
      body: {
        allergy: f.allergy.value,
        allergy_none: !f.allergy.value.trim(),
        medications: f.medications.value,
        medications_none: !f.medications.value.trim()
      }
    });
    closeModal();
    toast('건강 정보를 고쳤습니다.');
  });
}

function showCounselNote(id) {
  withBusy(async () => {
    const { note } = await api.request(`/pos/counsels/${id}/note`);
    openModal(`
      ${modalHead('미리 전한 상담 내용')}
      <div class="modal-body">
        <p style="font-size: 16px; line-height: 1.6; white-space: pre-wrap; margin: 0 0 12px;">${note ? h(note) : '고객이 삭제했거나 보관기간이 지나 파기됐습니다.'}</p>
        <div class="notice">복약상담 목적으로만 쓰세요. 열람 기록이 남고 고객도 확인할 수 있습니다.</div>
      </div>
      <div class="modal-foot"><button class="btn btn-outline" type="button" onclick="openCounsels()" data-autofocus>목록으로</button></div>
    `);
  });
}

function unsetCustomer() {
  state.customer = null;
  state.customerOrders = [];
  renderCustomer();
  focusSearch();
}

function unlinkCounsel() {
  state.counsel = null;
  renderCustomer();
}

function openCustomerSearch() {
  openModal(`
    ${modalHead('회원 찾기')}
    <div class="modal-body">
      <div class="field inline-scan">
        <input id="customerQuery" class="input big" placeholder="전화번호 뒷자리 · 이름 · 회원 QR 스캔" data-autofocus />
        <button class="cam-btn" type="button" onclick="scanMemberWithCamera()">QR 스캔</button>
      </div>
      <div class="list" id="customerResults"><div class="muted" style="padding: 12px 2px;">이름 2자 또는 전화번호 3자리 이상 입력하면 검색됩니다. 고객 앱의 멤버십 QR을 스캔하면 바로 연결됩니다.</div></div>
    </div>
  `);
  let timer;
  const input = document.getElementById('customerQuery');
  input.addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => searchCustomers(event.target.value), 200);
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    const customers = await searchCustomers(input.value);
    if (customers?.length === 1) selectCustomer(customers[0].id);
  });
}

function scanMemberWithCamera() {
  ScanKit.openCameraScanner({
    title: '회원 QR 스캔',
    hint: '고객 앱 멤버십 화면의 QR 또는 바코드를 비춰 주세요.',
    onResult: async (code) => {
      const customers = await searchCustomers(code);
      if (customers?.length === 1) selectCustomer(customers[0].id);
      else toast('일치하는 회원이 없습니다.', 'error');
    }
  });
}

async function searchCustomers(query) {
  const box = document.getElementById('customerResults');
  if (!box) return;
  if (query.trim().length < 2) {
    box.innerHTML = '<div class="muted" style="padding: 12px 2px;">이름 2자 또는 전화번호 3자리 이상 입력하면 검색됩니다.</div>';
    return;
  }
  try {
    const data = await api.request(`/pos/customers?query=${encodeURIComponent(query.trim())}`);
    window.__customerResults = data.customers;
    box.innerHTML = data.customers.length
      ? data.customers
          .map(
            (c) => `
            <button class="list-item" type="button" onclick="selectCustomer(${c.id})">
              <div>
                <div style="font-weight: 800;">${h(c.name)} <span class="badge gray">M${c.id}</span></div>
                <div class="muted" style="font-size: 13px; font-weight: 600; margin-top: 2px;">${h(c.phone)}</div>
              </div>
              <div style="text-align: right; font-size: 13px; font-weight: 700;">
                구매 ${Number(c.order_count)}회<br /><span class="muted">${won(c.total_amount)}</span>${pointsEnabled() ? `<br /><span style="color: var(--toss-blue);">${Number(c.point_balance || 0).toLocaleString()}P</span>` : ''}
              </div>
            </button>
          `
          )
          .join('')
      : '<div class="muted" style="padding: 12px 2px;">일치하는 회원이 없습니다. 비회원으로 판매하세요.</div>';
    return data.customers;
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

async function selectCustomer(id, { silent = false } = {}) {
  try {
    const data = await api.request(`/pos/customers/${id}`);
    const summary = (window.__customerResults || []).find((c) => c.id === id);
    state.customer = {
      ...data.customer,
      membership: data.membership,
      order_count: summary?.order_count ?? data.orders.filter((o) => o.order_type !== 'POS_REFUND').length
    };
    state.customerOrders = data.orders;
    renderCustomer();
    if (!silent) {
      closeModal();
      toast(`${data.customer.name} 회원으로 판매합니다.`);
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openPointHistory(customerId) {
  try {
    const data = await api.request(`/points/customers/${customerId}`);
    const policy = state.ctx.point_policy;
    openModal(`
      ${modalHead(`${h(data.customer.name)} 회원 포인트`)}
      <div class="modal-body">
        <div class="pay-total">
          <span class="muted" style="font-weight: 700;">보유 포인트</span>
          <div class="amount">${Number(data.customer.point_balance).toLocaleString()}P</div>
          <div class="muted" style="font-size: 13px; font-weight: 600;">기본 적립 ${policy.earn_rate}% (등급·생일 달 추가) · ${Number(policy.min_use).toLocaleString()}P 이상부터 1P = 1원으로 사용 · 일반의약품·분류 전 상품은 적립·사용 제외</div>
        </div>
        <table class="table">
          <thead><tr><th>일시</th><th>구분</th><th class="num">포인트</th><th class="num">잔액</th></tr></thead>
          <tbody>
            ${
              data.ledger
                .map(
                  (l) => `<tr><td>${fmtDateTime(l.created_at)}</td><td>${POINT_ENTRY_LABELS[l.entry_type] || h(l.entry_type)}${l.order_number ? `<div class="muted" style="font-size: 12px;">${h(l.order_number)}</div>` : ''}${l.reason && ['ADJUST', 'REWARD', 'EARN'].includes(l.entry_type) ? `<div class="muted" style="font-size: 12px;">${h(l.reason)}</div>` : ''}</td><td class="num" style="font-weight: 800; color: ${l.points > 0 ? 'var(--toss-blue)' : 'var(--danger)'};">${l.points > 0 ? '+' : ''}${l.points.toLocaleString()}P</td><td class="num">${l.balance_after.toLocaleString()}P</td></tr>`
                )
                .join('') || '<tr><td colspan="4" class="muted">포인트 내역이 없습니다.</td></tr>'
            }
          </tbody>
        </table>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" type="button" onclick="closeModal()">닫기</button></div>
    `);
  } catch (error) {
    toast(error.message, 'error');
  }
}
