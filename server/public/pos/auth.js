// MAYDIN POS · 로그인·POS 컨텍스트
/* ---------- 로그인 / 컨텍스트 ---------- */

function posLogout() {
  const pending = state.ctx ? saleQueue().length : 0;
  if (pending && !confirm(`이 기기에 서버로 보내지 않은 장애 중 판매 ${pending}건이 있습니다. 로그아웃해도 거래는 이 기기에 남지만, 같은 약국 계정으로 다시 로그인해야 전송됩니다. 로그아웃할까요?`)) return;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.href = '/pos.html';
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api.login(event.target.email.value, event.target.password.value);
    if (!ALLOWED_ROLES.includes(data.user.role)) {
      throw new Error('약국 관리자 또는 POS 직원 계정만 POS를 사용할 수 있습니다.');
    }
    saveSession(data);
    await boot();
  } catch (error) {
    toast(error.message, 'error');
  }
});

async function boot() {
  const user = currentUser();
  if (!user || !ALLOWED_ROLES.includes(user.role)) {
    document.body.classList.add('guest');
    return;
  }
  registerPosShell();
  let offlineBoot = false;
  try {
    state.ctx = await api.request('/pos/context');
    // 해제됐거나 다른 약국의 기기 키는 다시 쓸 일이 없다.
    if (state.ctx.device?.state === 'UNKNOWN') localStorage.removeItem(POS_DEVICE_KEY);
    // 장애 중에 다시 열 때 쓸 최소 정보만 남긴다(다른 카운터 목록 등은 빼고).
    if (state.ctx.terminal) {
      const { terminals: _terminals, ...offlineCtx } = state.ctx;
      localStorage.setItem('maydin_pos_ctx', JSON.stringify(offlineCtx));
    }
  } catch (error) {
    // 장애 중에 화면을 다시 열었으면 마지막으로 받은 약국·영업 정보로 장애 중 판매를 이어 간다.
    const cached = !error.status ? JSON.parse(localStorage.getItem('maydin_pos_ctx') || 'null') : null;
    if (!cached || cached.user?.id !== user.id) {
      document.body.classList.add('guest');
      toast(error.status ? error.message : '서버에 연결할 수 없습니다. 이 기기에서 한 번도 로그인하지 않았다면 장애 중 판매를 시작할 수 없습니다.', 'error');
      return;
    }
    state.ctx = cached;
    offlineBoot = true;
  }
  await LocalStore.open(state.ctx.pharmacy?.id || user.pharmacy_id || 'x');
  document.body.classList.remove('guest');
  state.session = state.ctx.session;
  renderTopbar();
  renderCategories();
  renderCustomer();
  renderCart();
  if (offlineBoot) setConnection('down', navigator.onLine ? 'UNREACHABLE' : 'NETWORK');
  else checkConnection();
  scheduleCheck();
  renderConnection();
  await loadProducts();
  if (!offlineBoot) {
    refreshBadges();
    refreshPendingApprovals();
    refreshPrintJobs();
    refreshCatalog();
    setInterval(refreshCatalog, 10 * 60 * 1000);
    await sealPlainQueue().catch(() => {});
    // 서버가 PC마다 남은 장애 중 거래를 알 수 있게 켤 때와 5분마다 알린다(마감·재고 대사·PC 교체 때 확인).
    if (saleQueue().length && state.session) syncQueue({ auto: true });
    else reportQueue();
    setInterval(reportQueue, 5 * 60 * 1000);
  }
  if (!state.ctx.terminal) openCounterRequired();
  else if (!state.session) openSessionStart();
  else focusSearch();
}

function renderTopbar() {
  const { pharmacy, user, terminal, today } = state.ctx;
  document.getElementById('pharmacyName').textContent = pharmacy?.pharmacy_name || '약국';
  document.getElementById('businessDate').textContent = state.session?.business_date || today;
  document.getElementById('cashierName').textContent = `${user.name} (${user.role === 'PHARMACY_OWNER' ? '관리자' : '직원'})`;
  document.getElementById('terminalName').textContent = terminal?.terminal_name || 'PC 미등록';
  const van = state.ctx.van || { mode: 'MANUAL' };
  document.getElementById('vanModeLabel').innerHTML =
    van.kind === 'BRIDGE'
      ? `카드 단말기 연동${van.bridge_paired ? '' : ' · 연결 안 됨'}`
      : van.is_demo
        ? `VAN 자동 승인${van.van_company ? ` · ${h(van.van_company)}` : ''} <span class="demo-tag">데모</span>`
        : van.kind === 'MANUAL' || !van.kind
          ? '카드 수동 승인'
          : h(van.mode_label);
  document.querySelector('#terminalChip .dot').className = `dot ${van.kind === 'MANUAL' || (van.kind === 'BRIDGE' && !van.bridge_paired) ? 'idle' : ''}`;
  const sync = state.ctx.stock_sync || { stock_master: 'MAYDIN' };
  const stockChip = document.getElementById('stockMasterChip');
  stockChip.style.display = sync.stock_master === 'LEGACY_POS' ? '' : 'none';
  stockChip.innerHTML = sync.online_paused
    ? '<span class="dot idle"></span><span>재고 기준 기존 POS · 온라인 주문 멈춤</span>'
    : '<span class="dot"></span><span>재고 기준 기존 POS</span>';
  stockChip.title = sync.online_paused
    ? '기존 POS 재고 파일이 늦어 온라인 주문을 멈췄습니다. 파트너센터에서 재고 파일을 올려 주세요.'
    : '입고·폐기·재고 실사는 기존 POS에서 하고, 재고 파일로 MAYDIN 재고를 맞춥니다.';
  const chip = document.getElementById('sessionChip');
  chip.innerHTML = state.session
    ? `<span class="dot"></span><span>영업 중 · ${fmtTime(state.session.opened_at)} 시작</span>`
    : '<span class="dot idle"></span><span>영업 전</span>';
  document.title = `${pharmacy?.pharmacy_name || ''} POS`;
}
