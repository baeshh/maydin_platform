// MAYDIN POS · 단말기·VAN 설정
/* ---------- 단말기 · VAN ---------- */

const VAN_TX_LABELS = { APPROVE: '승인', CANCEL: '취소', CASH_RECEIPT: '현금영수증' };
const VAN_TX_STATUS = {
  REQUESTED: ['orange', '응답 대기'],
  UNKNOWN: ['red', '결과 모름'],
  APPROVED: ['blue', '승인(미사용)'],
  USED: ['green', '판매 반영'],
  VOIDED: ['gray', '판매 전 취소'],
  DECLINED: ['red', '거절'],
  NOT_FOUND: ['gray', '승인 없음 확인']
};
const VAN_MODE_HELP = {
  MANUAL: '기존 카드 단말기에서 단독 승인하고 승인번호만 입력합니다. 마감 전에 단말기 영수증과 대조해야 합니다.',
  DEMO: '실제 VAN 계약 전 연습용입니다. 모의 승인번호가 발급되며 실제 돈은 결제되지 않습니다.',
  BRIDGE: '이 PC에서 도는 MAYDIN Bridge가 카드 단말기와 통신합니다. 서버는 Bridge가 서명한 결과만 승인으로 인정합니다.',
  NICE: 'NICE정보통신 직접 연동. VAN 계약·인증 정보가 서버에 등록되면 켤 수 있습니다.',
  KIS: 'KIS정보통신 직접 연동. VAN 계약·인증 정보가 서버에 등록되면 켤 수 있습니다.'
};

async function openVanSettings() {
  try {
    const data = await api.request('/pos/van/terminal');
    const { terminal, van, van_companies: companies, transactions, modes } = data;
    const owner = can('can_manage_van');
    state.vanModeDraft = van.mode;
    state.vanInfo = van;
    openModal(
      `
      ${modalHead(`단말기 · VAN 설정${van.is_demo ? ' <span class="demo-tag">데모</span>' : ''}`)}
      <div class="modal-body">
        ${can('can_manage_terminals') ? '<button class="btn btn-outline btn-block" type="button" style="margin-bottom: 14px;" onclick="openCounterManager()">카운터 관리 · 이 PC 등록</button>' : ''}
        <div class="split">
          <div>
            <div class="field"><label class="label" for="vanTerminalName">카운터 이름</label><input id="vanTerminalName" class="input" value="${h(terminal.terminal_name)}" ${owner ? '' : 'disabled'} /></div>
            <label class="label">카드 승인 방식</label>
            <div id="vanModeList" style="display: grid; gap: 6px; margin-bottom: 12px;">
              ${modes
                .map(
                  (m) => `<label class="pay-row" style="display: flex; gap: 10px; align-items: flex-start; padding: 10px; margin: 0; cursor: ${owner && (m.available || m.mode === van.mode) ? 'pointer' : 'not-allowed'}; opacity: ${m.available || m.mode === van.mode ? 1 : 0.55};">
                    <input type="radio" name="vanMode" value="${m.mode}" ${m.mode === van.mode ? 'checked' : ''} ${owner && (m.available || m.mode === van.mode) ? '' : 'disabled'} onchange="pickVanMode('${m.mode}')" />
                    <span><b>${h(m.label)}</b>${m.is_demo ? ' <span class="demo-tag">데모</span>' : ''}${m.available ? '' : ' <span class="badge gray">계약 정보 필요</span>'}
                      <div class="muted" style="font-size: 12px; line-height: 1.5;">${h(VAN_MODE_HELP[m.mode] || '')}${m.available || !m.requirements.length ? '' : `<br />필요한 것: ${h(m.requirements.join(', '))}`}</div></span>
                  </label>`
                )
                .join('')}
            </div>
            <div id="bridgeBox">${bridgeBoxHtml(van, owner)}</div>
            <div class="pay-row-grid">
              <div class="field"><label class="label" for="vanCompany">VAN사</label>
                <select id="vanCompany" class="input" ${owner ? '' : 'disabled'}><option value="">선택 안 함</option>${companies.map((c) => `<option ${terminal.van_company === c ? 'selected' : ''}>${h(c)}</option>`).join('')}</select></div>
              <div class="field"><label class="label" for="vanTid">TID</label><input id="vanTid" class="input" value="${h(terminal.tid || '')}" placeholder="VAN사가 발급한 단말기 번호" ${owner ? '' : 'disabled'} /></div>
            </div>
            ${owner ? '<button class="btn btn-primary btn-block" type="button" onclick="saveVanSettings()">저장</button>' : '<div class="notice">단말기 설정은 약국 관리자만 바꿀 수 있습니다.</div>'}
            ${van.is_demo ? '<div class="notice" style="margin-top: 12px;">데모 규칙: 5만원 미만 할부는 카드사 거절로 처리됩니다. 간편결제 바코드는 숫자 16~24자리(28로 시작=카카오페이, 29=네이버페이, 30=토스페이, 31=페이코)로 인식합니다.</div>' : ''}
          </div>
          <div>
            <div class="section-title" style="margin-top: 0;">오늘 이 카운터 승인 기록</div>
            ${transactions.length
              ? `<table><thead><tr><th>시간</th><th>구분</th><th class="num">금액</th><th>승인번호</th><th>상태</th></tr></thead><tbody>${transactions
                  .map((t) => {
                    const [color, label] = VAN_TX_STATUS[t.status] || ['gray', t.status];
                    return `<tr><td>${fmtTime(t.created_at)}</td><td>${VAN_TX_LABELS[t.transaction_type] || h(t.transaction_type)} · ${METHOD_LABELS[t.payment_method] || h(t.payment_method)}${t.is_demo ? ' <span class="demo-tag">데모</span>' : ''}${t.card_company ? `<div class="muted" style="font-size: 12px;">${h(t.card_company)}</div>` : ''}</td><td class="num">${won(t.amount)}</td><td style="font-size: 13px;">${h(t.approval_number === '-' ? '' : t.approval_number)}${t.order_number ? `<div class="muted" style="font-size: 12px;">${h(t.order_number)}</div>` : ''}</td><td><span class="badge ${color}">${label}</span></td></tr>`;
                  })
                  .join('')}</tbody></table>`
              : '<div class="muted">기록이 없습니다.</div>'}
          </div>
        </div>
      </div>
    `,
      { size: 'wide' }
    );
    if (van.kind === 'BRIDGE') checkBridgeStatus();
  } catch (error) {
    if (error.reason === 'TERMINAL_REQUIRED' && can('can_manage_terminals')) return openCounterManager();
    toast(error.message, 'error');
  }
}

function bridgeBoxHtml(van, owner) {
  if ((state.vanModeDraft || van.mode) !== 'BRIDGE') return '';
  return `
    <div class="notice" style="margin-bottom: 12px; line-height: 1.6;">
      <b>MAYDIN Bridge 연결</b> · ${van.bridge_paired ? `연결됨 (${fmtDateTime(van.bridge_paired_at)})` : '아직 연결하지 않았습니다.'}
      <div id="bridgeStatus" class="muted" style="font-size: 12px;">이 PC의 Bridge 확인 중…</div>
      <div class="field" style="margin: 6px 0;"><label class="label" for="bridgeUrl">이 PC의 Bridge 주소</label><input id="bridgeUrl" class="input" value="${h(VanBridge.url())}" onchange="VanBridge.setUrl(this.value); checkBridgeStatus()" /></div>
      ${owner ? `<button class="btn btn-outline btn-sm" type="button" onclick="pairBridge()">${van.bridge_paired ? 'Bridge 키 다시 발급 · 연결' : 'Bridge 키 발급 · 이 PC Bridge에 연결'}</button>` : ''}
      <div class="muted" style="font-size: 12px; margin-top: 6px;">키는 이 PC의 Bridge에만 넣고 화면·브라우저에는 남기지 않습니다. 다시 발급하면 예전 키로 서명한 결과는 인정되지 않습니다.</div>
    </div>
  `;
}

async function checkBridgeStatus() {
  const el = document.getElementById('bridgeStatus');
  if (!el) return;
  try {
    const status = await VanBridge.status();
    const sameCounter = String(status.terminal_id) === String(state.ctx.terminal?.id);
    el.innerHTML = status.paired
      ? `Bridge 응답 정상${status.demo ? ' <span class="demo-tag">데모</span>' : ''} · ${sameCounter ? '이 카운터와 연결됨' : `<b style="color: var(--danger);">다른 카운터(#${h(status.terminal_id)})와 연결됨</b>`}`
      : `Bridge 응답 정상${status.demo ? ' <span class="demo-tag">데모</span>' : ''} · 아직 키가 없습니다.`;
  } catch (error) {
    el.textContent = error.message;
  }
}

function pickVanMode(mode) {
  state.vanModeDraft = mode;
  const box = document.getElementById('bridgeBox');
  if (box) {
    box.innerHTML = bridgeBoxHtml(state.vanInfo || {}, can('can_manage_van'));
    if (mode === 'BRIDGE') checkBridgeStatus();
  }
}

function pairBridge() {
  if (state.vanInfo?.bridge_paired && !confirm('Bridge 키를 다시 발급할까요? 예전 키로 연결된 Bridge는 더 이상 쓸 수 없습니다.')) return;
  withBusy(async () => {
    await VanBridge.status();
    const data = await api.request('/pos/van/bridge-key', { method: 'POST' });
    await VanBridge.pair({ terminalId: data.terminal_id, bridgeKey: data.bridge_key, serverOrigin: location.origin });
    // 고른 방식(Bridge)도 함께 저장해 바로 쓸 수 있게 한다.
    await persistVanSettings();
    toast('이 PC의 Bridge와 연결했습니다.');
  });
}

async function persistVanSettings() {
  const data = await api.request('/pos/van/terminal', {
    method: 'PATCH',
    body: {
      terminal_name: document.getElementById('vanTerminalName').value.trim(),
      van_mode: state.vanModeDraft,
      van_company: document.getElementById('vanCompany').value,
      tid: document.getElementById('vanTid').value.trim()
    }
  });
  state.ctx.terminal = data.terminal;
  state.ctx.van = data.van;
  renderTopbar();
  await openVanSettings();
  return data;
}

function saveVanSettings() {
  withBusy(async () => {
    const data = await persistVanSettings();
    toast(`${data.van.mode_label} 모드로 저장했습니다.`);
  });
}
