// MAYDIN POS · 카운터(PC) 등록·관리
/* ---------- 카운터 등록 ---------- */

// 약국이 카운터 PC를 한 대라도 등록하면, 등록된 PC만 영업·판매를 할 수 있다.
function openCounterRequired() {
  const { device, terminals = [] } = state.ctx;
  const owner = can('can_manage_terminals');
  const free = terminals.filter((t) => t.status === 'ACTIVE' && !t.device_registered);
  openModal(
    `
    ${modalHead('카운터 등록이 필요합니다', { closable: false })}
    <div class="modal-body">
      <div class="notice warn" style="margin-bottom: 14px; line-height: 1.6;">
        이 PC는 <b>${h(device?.label || '등록되지 않은 PC')}</b>입니다. 이 약국은 카운터 PC를 등록해 쓰고 있어, 등록된 PC에서만 영업·판매를 할 수 있습니다.
      </div>
      ${saleQueue().length
        ? `<div class="notice danger" style="margin-bottom: 14px; line-height: 1.6;">이 PC에 서버로 보내지 않은 장애 중 거래 <b>${saleQueue().length}건</b>(${won(saleQueue().reduce((sum, e) => sum + Number(e.summary.total || 0), 0))})이 남아 있습니다. 이 PC를 다시 등록하면 보낼 수 있고, 다른 PC에서 보내려면 파일로 내보내 그 PC에서 가져오세요.
            <div style="margin-top: 8px;"><button class="btn btn-outline btn-sm" type="button" onclick="exportQueue()">파일로 내보내기</button></div></div>`
        : ''}
      ${owner ? counterRegisterForm(free) : '<div class="notice">약국 관리자 계정으로 이 PC에서 로그인해 카운터로 등록해 주세요.</div>'}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="posLogout()">로그아웃</button>
      ${owner ? '<button class="btn btn-primary" type="button" onclick="registerThisPc()">이 PC를 카운터로 등록</button>' : '<button class="btn btn-primary" type="button" onclick="location.reload()">다시 확인</button>'}
    </div>
  `,
    { locked: true }
  );
}

function counterRegisterForm(free) {
  return `
    ${free.length
      ? `<div class="field">
          <label class="label" for="counterTarget">등록할 카운터</label>
          <select id="counterTarget" class="input" onchange="document.getElementById('counterNameField').style.display = this.value ? 'none' : ''">
            <option value="">새 카운터 만들기</option>
            ${free.map((t) => `<option value="${t.id}">${h(t.terminal_name)} (PC 미등록)</option>`).join('')}
          </select>
        </div>`
      : ''}
    <div class="field" id="counterNameField">
      <label class="label" for="counterName">새 카운터 이름</label>
      <input id="counterName" class="input" maxlength="30" placeholder="예: 카운터 2" />
    </div>
    <div class="field">
      <label class="label" for="counterDeviceLabel">PC 메모 (선택)</label>
      <input id="counterDeviceLabel" class="input" maxlength="60" placeholder="예: 입구 쪽 계산대 PC" />
    </div>
    <div class="notice" style="line-height: 1.6;">등록하면 이 PC의 브라우저에 기기 키가 저장됩니다. 브라우저 데이터를 지우면 다시 등록해야 합니다.</div>
  `;
}

function registerThisPc({ terminalId, replace = false, ack = null } = {}) {
  const target = terminalId ?? document.getElementById('counterTarget')?.value;
  const body = {
    terminal_id: target ? Number(target) : null,
    terminal_name: document.getElementById('counterName')?.value.trim() || '',
    device_label: document.getElementById('counterDeviceLabel')?.value.trim() || '',
    replace,
    ...(ack || {})
  };
  withBusy(async () => {
    let data;
    try {
      data = await api.request('/pos/terminals/register', { method: 'POST', body });
    } catch (error) {
      if (error.reason !== 'DEVICE_QUEUE_UNCONFIRMED') throw error;
      return openRetiringCheck(error, '교체', (confirmed) => registerThisPc({ terminalId: body.terminal_id, replace, ack: confirmed }));
    }
    localStorage.setItem(POS_DEVICE_KEY, data.device_token);
    toast(`이 PC를 ${data.terminal.terminal_name}(으)로 등록했습니다.`);
    setTimeout(() => location.reload(), 600);
  });
}

/* PC 교체·해제 전 확인: 기존 PC에 서버로 보내지 않은 장애 중 거래가 남았거나 보고가 없으면,
   기존 PC에서 보내거나 파일로 내보내는 것이 먼저다. 그럴 수 없을 때만 사유를 적고 진행한다(유실 목록에 남는다). */
function openRetiringCheck(error, action, proceed) {
  const check = error.data?.device_check || { state: 'UNREPORTED', devices: [] };
  const unsent = check.devices.reduce((sum, d) => sum + d.unsent_count, 0);
  state.retiringProceed = proceed;
  openModal(`
    ${modalHead(`기존 PC ${action} 전 확인`)}
    <div class="modal-body">
      <div class="notice danger" style="margin-bottom: 12px; line-height: 1.6;">${h(error.message)}</div>
      ${check.devices.length
        ? `<table style="margin-bottom: 12px;"><thead><tr><th>PC</th><th class="num">미전송</th><th class="num">금액</th><th>마지막 보고</th></tr></thead><tbody>${check.devices
            .map((d) => `<tr><td>PC ${h(d.install)}${d.plain_count ? ' <span class="badge red">잠기지 않음 있음</span>' : ''}</td><td class="num">${d.unsent_count}건</td><td class="num">${won(d.total_amount)}</td><td>${d.reported_at ? fmtDateTime(d.reported_at) : '-'}</td></tr>`)
            .join('')}</tbody></table>`
        : ''}
      <div class="notice" style="margin-bottom: 12px; line-height: 1.7;">
        <b>권장 순서</b><br />
        1. 기존 PC를 켜고 인터넷에 연결 → 「장애 · 복구」에서 서버로 보내기<br />
        2. 인터넷이 안 되면 기존 PC에서 「파일로 내보내기」 → 새 PC에서 「다른 PC 파일 가져오기」<br />
        3. 기존 PC가 켜지지 않으면 아래에 사유를 적고 진행 → 「장애 · 복구」의 유실 목록에서 임시번호로 수기 복구
      </div>
      <div class="field"><label class="label" for="retireNote">기존 PC를 확인하지 않고 ${action}하는 사유</label><input id="retireNote" class="input" maxlength="300" placeholder="예: 기존 PC 저장장치 고장 · 종이 장부로 복구 예정" /></div>
      <label><input type="checkbox" id="retireAck" /> ${check.state === 'PENDING' ? `기존 PC의 미전송 ${unsent}건이 서버에 들어오지 않을 수 있음을 알고 진행합니다` : '기존 PC에 남은 거래가 있을 수 있음을 알고 진행합니다'}</label>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="closeModal()">취소</button>
      <button class="btn btn-danger" type="button" onclick="confirmRetiring()">확인하고 ${action}</button>
    </div>
  `);
}

function confirmRetiring() {
  const note = document.getElementById('retireNote').value.trim();
  if (!document.getElementById('retireAck').checked) return toast('유실 가능성을 확인했다고 표시해 주세요.', 'error');
  if (!note) return toast('사유를 적어 주세요.', 'error');
  const proceed = state.retiringProceed;
  state.retiringProceed = null;
  closeModal(true);
  proceed?.({ acknowledge_unsent: true, note });
}

/* ---------- 카운터 관리 (약국 관리자) ---------- */

async function openCounterManager() {
  try {
    await reportQueue();
    const [{ terminals, current_terminal_id: currentId }, queues] = await Promise.all([
      api.request('/pos/terminals'),
      api.request('/pos/offline-queue/status').catch(() => null)
    ]);
    const queueOf = new Map((queues?.terminals || []).map((q) => [q.terminal_id, q]));
    const thisPcRegistered = state.ctx.device?.state === 'REGISTERED';
    const rows = terminals
      .map((t) => {
        const here = t.id === currentId && thisPcRegistered;
        const status = t.status !== 'ACTIVE'
          ? '<span class="badge gray">사용 중지</span>'
          : t.open_session_id
            ? `<span class="badge green">영업 중</span><div class="muted" style="font-size: 12px;">${fmtTime(t.session_opened_at)} · ${h(t.session_opened_by_name || '')}</div>`
            : '<span class="badge blue">영업 전</span>';
        const queue = queueOf.get(t.id);
        const unsent = queue?.unsent_count
          ? `<div style="font-size: 12px; color: var(--danger);"><b>장애 중 미전송 ${queue.unsent_count}건</b></div>`
          : queue?.unreported
            ? '<div style="font-size: 12px; color: var(--warning, #b45309);">보관 거래 보고 없음</div>'
            : '';
        const pc = t.device_registered
          ? `${here ? '<b>이 PC</b> · ' : ''}${h(t.device_label || 'PC 등록됨')}<div class="muted" style="font-size: 12px;">등록 ${fmtDateTime(t.device_registered_at)}${t.last_seen_at ? ` · 최근 ${fmtDateTime(t.last_seen_at)}` : ''}</div>${unsent}`
          : `<span class="muted">PC 미등록</span>${unsent}`;
        const actions = [
          t.status === 'ACTIVE' && !here
            ? `<button class="btn btn-sm btn-outline" type="button" onclick="registerThisPcTo(${t.id}, ${t.device_registered})">${t.device_registered ? '이 PC로 교체' : '이 PC 등록'}</button>`
            : '',
          t.device_registered ? `<button class="btn btn-sm btn-outline" type="button" onclick="revokeCounterDevice(${t.id})">PC 해제</button>` : '',
          `<button class="btn btn-sm btn-outline" type="button" onclick="toggleCounterStatus(${t.id}, '${t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'}')">${t.status === 'ACTIVE' ? '사용 중지' : '다시 사용'}</button>`
        ].join(' ');
        return `<tr><td><b>${h(t.terminal_name)}</b></td><td>${status}</td><td>${pc}</td><td style="white-space: nowrap;">${actions}</td></tr>`;
      })
      .join('');
    const legacy = state.ctx.device?.state === 'LEGACY';
    openModal(
      `
      ${modalHead('카운터 관리')}
      <div class="modal-body">
        <div class="notice" style="margin-bottom: 12px; line-height: 1.6;">
          카운터마다 영업 시작·일마감·시재가 따로 관리됩니다. 관리자가 카운터로 쓸 PC에서 직접 <b>이 PC 등록</b>을 누르세요.
          ${legacy ? '<br /><b>아직 등록된 PC가 없어</b> 모든 PC가 첫 카운터를 함께 씁니다. 한 대라도 등록하면 그때부터는 등록된 PC만 판매할 수 있습니다.' : ''}
        </div>
        <table><thead><tr><th>카운터</th><th>영업</th><th>PC</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        ${thisPcRegistered ? '' : `<div class="section-title">이 PC를 새 카운터로 등록</div>${counterRegisterForm([])}<button class="btn btn-primary btn-block" type="button" onclick="registerThisPc()">이 PC를 새 카운터로 등록</button>`}
      </div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

function registerThisPcTo(terminalId, replace) {
  if (replace && !confirm('이 카운터에 등록된 PC는 더 이상 판매할 수 없게 됩니다. 이 PC로 교체할까요?')) return;
  registerThisPc({ terminalId, replace });
}

function revokeCounterDevice(terminalId, ack = null) {
  if (!ack && !confirm('이 카운터의 PC 등록을 해제할까요? 해제된 PC에서는 다시 등록하기 전까지 판매할 수 없습니다.')) return;
  withBusy(async () => {
    const here = terminalId === state.ctx.terminal?.id && state.ctx.device?.state === 'REGISTERED';
    if (here) await reportQueue();
    try {
      await api.request(`/pos/terminals/${terminalId}/revoke-device`, { method: 'POST', body: ack || {} });
    } catch (error) {
      if (error.reason !== 'DEVICE_QUEUE_UNCONFIRMED') throw error;
      return openRetiringCheck(error, '해제', (confirmed) => revokeCounterDevice(terminalId, confirmed));
    }
    if (here) {
      localStorage.removeItem(POS_DEVICE_KEY);
      location.reload();
      return;
    }
    toast('PC 등록을 해제했습니다.');
    openCounterManager();
  });
}

function toggleCounterStatus(terminalId, status) {
  withBusy(async () => {
    await api.request(`/pos/terminals/${terminalId}`, { method: 'PATCH', body: { status } });
    toast(status === 'ACTIVE' ? '카운터를 다시 사용합니다.' : '카운터 사용을 중지했습니다.');
    openCounterManager();
  });
}
