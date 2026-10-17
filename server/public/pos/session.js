// MAYDIN POS · 영업 시작·현금 시재·일마감
/* ---------- 영업 시작 ---------- */

function openSessionStart() {
  openModal(
    `
    ${modalHead('영업 시작', { closable: false })}
    <div class="modal-body">
      <p style="margin: 0 0 16px; color: var(--text-sub); line-height: 1.6;">
        카운터 금고에 있는 <b>시작 현금(시재)</b>을 입력하면 오늘 영업이 시작됩니다.<br />
        일마감 때 이 금액을 기준으로 현금 차액을 계산합니다.
      </p>
      <div class="field">
        <label class="label" for="openingCash">시작 시재</label>
        <input id="openingCash" class="input big" type="number" min="0" step="100" value="0" data-autofocus />
      </div>
      <div class="chips" style="margin-bottom: 4px;">
        ${[0, 50000, 100000, 200000, 300000].map((v) => `<button class="chip" type="button" onclick="document.getElementById('openingCash').value=${v}">${won(v)}</button>`).join('')}
      </div>
    </div>
    <div class="modal-foot">
      <a class="btn btn-outline" href="/owner.html">파트너센터로</a>
      <button class="btn btn-primary" type="button" onclick="startSession()">영업 시작</button>
    </div>
  `,
    { locked: true }
  );
}

function startSession() {
  withBusy(async () => {
    const openingCash = Number(document.getElementById('openingCash').value || 0);
    const data = await api.request('/pos/sessions/open', { method: 'POST', body: { opening_cash: openingCash } });
    state.session = data.session;
    renderTopbar();
    closeModal(true);
    toast(`영업을 시작했습니다. 시작 시재 ${won(openingCash)}`);
  });
}

function requireSession() {
  if (state.session) return true;
  openSessionStart();
  return false;
}

/* ---------- 현금 시재 ---------- */

function sessionKv(summary, session) {
  return `
    <div class="kv"><span>시작 시재</span><span>${won(session.opening_cash)}</span></div>
    <div class="kv"><span>현금 결제 (순액)</span><span>${signedWon(summary.cash_net)}</span></div>
    <div class="kv"><span>현금 입금</span><span>+${won(summary.deposits)}</span></div>
    <div class="kv"><span>현금 출금</span><span>-${won(summary.withdrawals)}</span></div>
    <div class="kv strong"><span>예상 시재</span><span>${won(summary.expected_cash)}</span></div>
  `;
}

async function openCash() {
  if (!requireSession()) return;
  await refreshSession();
  const { summary } = state.session;
  openModal(`
    ${modalHead('현금 시재 · 입출금')}
    <div class="modal-body">
      ${sessionKv(summary, state.session)}
      ${can('can_cash_movement')
        ? `
        <div class="section-title">입출금 등록</div>
        <div class="tabs">
          <label class="chip"><input type="radio" name="moveType" value="DEPOSIT" checked /> 입금 (잔돈 보충 등)</label>
          <label class="chip"><input type="radio" name="moveType" value="WITHDRAW" /> 출금 (소모품·은행 입금 등)</label>
        </div>
        <div class="pay-row-grid">
          <div><label class="label">금액</label><input id="moveAmount" class="input" type="number" min="1" step="100" /></div>
          <div><label class="label">사유 (필수)</label><input id="moveReason" class="input" /></div>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top: 12px;" type="button" onclick="saveMovement()">등록</button>
      `
        : '<div class="notice" style="margin-top: 12px;">현금 입출금은 약국 관리자 계정으로 등록할 수 있습니다.</div>'}
      ${summary.movements.length
        ? `<div class="section-title">오늘 입출금 내역</div>
           ${summary.movements
             .map(
               (m) => `<div class="kv"><span>${fmtTime(m.created_at)} · ${m.movement_type === 'DEPOSIT' ? '입금' : '출금'} · ${h(m.reason)} <span class="muted">(${h(m.created_by_name || '')})</span></span><span>${m.movement_type === 'DEPOSIT' ? '+' : '-'}${won(m.amount)}</span></div>`
             )
             .join('')}`
        : ''}
    </div>
  `);
}

function saveMovement() {
  withBusy(async () => {
    const movement_type = document.querySelector('input[name="moveType"]:checked').value;
    const amount = Number(document.getElementById('moveAmount').value);
    const reason = document.getElementById('moveReason').value.trim();
    if (!amount || amount <= 0) throw new Error('금액을 입력해 주세요.');
    if (!reason) throw new Error('사유를 입력해 주세요.');
    await api.request(`/pos/sessions/${state.session.id}/cash-movements`, { method: 'POST', body: { movement_type, amount, reason } });
    toast(`${movement_type === 'DEPOSIT' ? '입금' : '출금'} ${won(amount)} 등록`);
    openCash();
  });
}

/* ---------- 일마감 ---------- */

const DENOMS = [50000, 10000, 5000, 1000, 500, 100, 50, 10];

async function openClose() {
  if (!requireSession()) return;
  await refreshSession();
  const { summary } = state.session;
  const owner = can('can_close');
  const holdCount = Number(document.getElementById('holdCount').textContent) || 0;
  const approvals = await refreshPendingApprovals();
  await reportQueue();
  const queued = saleQueue().length;
  openModal(
    `
    ${modalHead('일마감')}
    <div class="modal-body">
      ${queued ? `<div class="notice danger" style="margin-bottom: 14px;">이 PC에 서버로 보내지 않은 장애 중 거래가 ${queued}건 있어 마감할 수 없습니다. 보내지 않으면 그 매출·현금이 이 영업에 빠집니다. <button class="discount-link" type="button" onclick="openRecovery()">장애 · 복구</button></div>` : ''}
      ${approvals.length ? `<div class="notice danger" style="margin-bottom: 14px;">정리되지 않은 카드 승인이 ${approvals.length}건 있어 마감할 수 없습니다. <button class="discount-link" type="button" onclick="openApprovalManager()">승인 정리</button></div>` : ''}
      ${summary.unverified_count ? `<div class="notice danger" style="margin-bottom: 14px;">단말기 영수증과 대조하지 않은 수동 승인이 ${summary.unverified_count}건 있어 마감할 수 없습니다.${owner ? ' <button class="discount-link" type="button" onclick="openUnverifiedPayments()">수동 승인 대조</button>' : ' 약국 관리자가 대조해야 합니다.'}</div>` : ''}
      ${holdCount ? `<div class="notice warn" style="margin-bottom: 14px;">보류 중인 판매가 ${holdCount}건 있습니다. 마감해도 보류는 남지만, 결제하지 않은 보류는 매출에 포함되지 않습니다. <button class="discount-link" type="button" onclick="openHolds()">보류 목록 보기</button></div>` : ''}
      <div class="metrics">
        <div class="metric"><span>판매</span><strong>${summary.sale_count}건 · ${won(summary.gross_sales)}</strong></div>
        <div class="metric"><span>반품 · 취소</span><strong style="color: var(--danger);">${summary.refund_count}건 · ${signedWon(summary.refund_total)}</strong></div>
        <div class="metric"><span>할인</span><strong>${won(summary.discount_total)}</strong></div>
        <div class="metric"><span>순매출</span><strong style="color: var(--toss-blue);">${signedWon(summary.net_sales)}</strong></div>
      </div>
      <div class="split">
        <div>
          <div class="section-title">결제수단별</div>
          ${summary.payments.length
            ? summary.payments
                .map(
                  (p) => `<div class="kv"><span>${METHOD_LABELS[p.payment_method] || h(p.payment_method)} <span class="muted">(${p.pay_count}건${p.refunded_amount ? ` · 환불 ${signedWon(p.refunded_amount)}` : ''})</span></span><span>${signedWon(p.net_amount)}</span></div>`
                )
                .join('')
            : '<div class="muted">결제 내역이 없습니다.</div>'}
          <div class="section-title">현금 시재</div>
          ${sessionKv(summary, state.session)}
        </div>
        <div>
          ${owner
            ? `
            <div class="section-title">실제 현금 세기</div>
            <div class="denoms">
              ${DENOMS.map((d) => `<div class="denom"><label>${d.toLocaleString()}원</label><input class="input" type="number" min="0" data-denom="${d}" placeholder="0" oninput="sumDenoms()" /></div>`).join('')}
            </div>
            <div class="field" style="margin-top: 14px;">
              <label class="label" for="actualCash">실제 현금 합계</label>
              <input id="actualCash" class="input big" type="number" min="0" value="${summary.expected_cash}" oninput="renderDiff()" />
            </div>
            <div class="remain" id="closeDiff"></div>
            <div class="field"><label class="label" for="closeNote">차액 사유 · 메모</label><input id="closeNote" class="input" placeholder="차액이 있으면 필수" /></div>
            <button class="btn btn-primary btn-block btn-lg" type="button" onclick="confirmClose()">마감 확정</button>
            <div class="notice" style="margin-top: 10px;">마감 후에는 이 영업에 판매를 추가할 수 없습니다. 다음 영업은 새 시재로 시작합니다.</div>
          `
            : '<div class="notice warn">일마감은 약국 관리자 계정으로 확정할 수 있습니다.</div>'}
        </div>
      </div>
    </div>
  `,
    { size: 'wide' }
  );
  if (owner) renderDiff();
}

function sumDenoms() {
  const total = [...document.querySelectorAll('[data-denom]')].reduce((sum, input) => sum + Number(input.dataset.denom) * (Number(input.value) || 0), 0);
  document.getElementById('actualCash').value = total;
  renderDiff();
}

function renderDiff() {
  const expected = state.session.summary.expected_cash;
  const actual = Number(document.getElementById('actualCash').value || 0);
  const diff = actual - expected;
  const el = document.getElementById('closeDiff');
  el.className = `remain ${diff === 0 ? 'ok' : 'bad'}`;
  el.innerHTML = `<span>차액 (실제 - 예상)</span><span>${diff === 0 ? '0원 ✓' : signedWon(diff)}</span>`;
}

function confirmClose() {
  withBusy(async () => {
    const actual = Number(document.getElementById('actualCash').value);
    const note = document.getElementById('closeNote').value.trim();
    const diff = actual - state.session.summary.expected_cash;
    if (diff !== 0 && !note) throw new Error('차액 사유를 입력해 주세요.');
    if (!confirm(`실제 현금 ${won(actual)}으로 마감할까요?`)) return;
    let data;
    try {
      data = await api.request(`/pos/sessions/${state.session.id}/close`, { method: 'POST', body: { actual_cash: actual, note } });
    } catch (error) {
      if (error.reason === 'VAN_APPROVALS_OPEN') openApprovalManager();
      if (error.reason === 'MANUAL_APPROVALS_UNCHECKED') openUnverifiedPayments();
      if (error.reason === 'OFFLINE_QUEUE_PENDING') openRecovery();
      throw error;
    }
    const closed = data.session;
    state.session = null;
    renderTopbar();
    openModal(
      `
      ${modalHead('마감 완료', { closable: false })}
      <div class="modal-body">
        <div class="metrics" style="grid-template-columns: repeat(2, 1fr);">
          <div class="metric"><span>순매출</span><strong>${signedWon(closed.summary.net_sales)}</strong></div>
          <div class="metric"><span>시재 차액</span><strong style="color: ${closed.cash_difference ? 'var(--danger)' : 'var(--success)'};">${signedWon(closed.cash_difference)}</strong></div>
        </div>
        <div class="kv"><span>예상 시재</span><span>${won(closed.expected_cash)}</span></div>
        <div class="kv"><span>실제 시재</span><span>${won(closed.actual_cash)}</span></div>
        ${closed.close_note ? `<div class="kv"><span>메모</span><span>${h(closed.close_note)}</span></div>` : ''}
        <div class="kv"><span>마감 시각</span><span>${fmtDateTime(closed.closed_at)}</span></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" type="button" onclick="openReport()">매출 리포트</button>
        <button class="btn btn-primary" type="button" onclick="openSessionStart()">새 영업 시작</button>
      </div>
    `,
      { locked: true }
    );
  });
}
