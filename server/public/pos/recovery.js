// MAYDIN POS · 장애 감지·기기 임시 보관·수기 복구
/* ---------- 장애 감지 · 단말기 임시 저장 ----------
   인터넷·서버가 끊기면 판매를 이 기기(IndexedDB, local-store.js)에 거래 고유번호와 함께 보관하고,
   연결이 돌아오면 장애 기록에 묶어 서버로 보낸다. 같은 고유번호는 서버가 한 번만 저장한다.
   카드번호·간편결제 바코드·고객 이름은 보관하지 않고 단말기 영수증의 승인번호만 남긴다. 보낸 거래는 바로 지운다. */

const OUTAGE_REASONS = { NETWORK: '인터넷 끊김', UNREACHABLE: '서버 연결 안 됨', SERVER: '서버 오류' };
const OUTAGE_KIND_LABELS = { NETWORK: '인터넷 끊김', SERVER: '서버 장애', POWER: '정전·PC 장애', OTHER: '기타' };
const conn = { status: 'online', reason: '', checkedAt: null, timer: null, checking: null };

function readStore(name, fallback = null) {
  return LocalStore.get(name, fallback);
}

// 화면이 읽는 사본은 바로 바뀌고, 기기 저장이 끝나면 true를 돌려준다. 저장에 실패하면 사본도 되돌린다.
async function writeStore(name, value) {
  const ok = await LocalStore.set(name, value);
  if (!ok) toast('이 기기에 저장하지 못했습니다(저장 공간 부족 등). 장애 중 판매는 종이 장부에 함께 적어 두세요.', 'error');
  return ok;
}

function saleQueue() {
  return readStore('queue', []);
}

function newSaleId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isDown() {
  return conn.status === 'down';
}

// 장애 중이거나 수기 복구 중이면 이미 건넨 상품이므로 시스템 재고로 막지 않는다.
function relaxedStock() {
  return isDown() || !!state.manual;
}

async function checkConnection() {
  if (conn.checking) return conn.checking;
  conn.checking = (async () => {
    let status = 'online';
    let reason = '';
    if (!navigator.onLine) {
      status = 'down';
      reason = 'NETWORK';
    } else {
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.db !== 'ok') {
          status = 'down';
          reason = 'SERVER';
        }
      } catch {
        status = 'down';
        reason = 'UNREACHABLE';
      }
    }
    setConnection(status, reason);
  })().finally(() => {
    conn.checking = null;
  });
  return conn.checking;
}

function scheduleCheck() {
  clearTimeout(conn.timer);
  conn.timer = setTimeout(async () => {
    await checkConnection();
    scheduleCheck();
  }, isDown() ? 5000 : 15000);
}

// 요청이 네트워크 오류로 실패하면 다음 주기를 기다리지 않고 바로 확인한다.
function noteRequestFailure(error) {
  if (error && !error.status) checkConnection();
}

function setConnection(status, reason) {
  const was = conn.status;
  conn.status = status;
  conn.reason = reason;
  conn.checkedAt = new Date();
  if (status === 'down') {
    if (!readStore('outage')) writeStore('outage', { started_at: new Date().toISOString(), kind: reason === 'SERVER' ? 'SERVER' : 'NETWORK' });
    if (was !== 'down') {
      toast(`${OUTAGE_REASONS[reason]} · 장애 중 판매로 계속 판매할 수 있습니다. 결제 후 영수증을 꼭 확인하세요.`, 'error');
      scheduleCheck();
    }
  } else if (was === 'down') {
    toast('서버 연결이 복구되었습니다.');
    scheduleCheck();
    afterReconnect();
  }
  renderConnection();
}

async function afterReconnect() {
  const outage = readStore('outage');
  if (saleQueue().length > 0 && state.session) {
    await syncQueue({ auto: true });
  } else {
    if (outage && !saleQueue().length) {
      const minutes = (Date.now() - Date.parse(outage.started_at)) / 60000;
      if (minutes >= 3 && !outage.server_id) await registerOutage(outage).catch(() => {});
      writeStore('outage', null);
    }
    reportQueue();
  }
  refreshCatalog();
  if (state.ctx && !modalOpen()) {
    refreshSession().catch(() => {});
    loadProducts();
    refreshBadges();
  }
}

function renderConnection() {
  const chip = document.getElementById('networkChip');
  const pending = saleQueue().length;
  const failed = saleQueue().filter((entry) => entry.status === 'FAILED').length;
  if (isDown()) {
    chip.className = 'status-chip down';
    chip.innerHTML = `<span class="dot off"></span><span>${OUTAGE_REASONS[conn.reason]} · 장애 중 판매${pending ? ` ${pending}건 보관` : ''}</span>`;
  } else if (pending) {
    chip.className = 'status-chip pending';
    chip.innerHTML = `<span class="dot warn"></span><span>온라인 · 미전송 ${pending}건${failed ? ` (확인 필요 ${failed})` : ''}</span>`;
  } else {
    chip.className = 'status-chip';
    chip.innerHTML = '<span class="dot"></span><span>온라인</span>';
  }
  setBadge('recoveryCount', pending);
  renderModeBanner();
}

function renderModeBanner() {
  const box = document.getElementById('modeBanner');
  if (!box) return;
  if (state.manual) {
    box.innerHTML = `<div class="mode-banner manual"><span>수기 거래 복구 중 · 장애 #${Number(state.manual.outage_id)} · 판매 시각 ${h(fmtLocalInput(state.manual.occurred_at))}${state.manual.ref ? ` · 임시번호 ${h(state.manual.ref.toUpperCase())}` : ''}</span><button class="btn btn-outline btn-sm" type="button" onclick="endManualRecovery()">끝내기</button></div>`;
  } else if (isDown()) {
    const outage = readStore('outage');
    box.innerHTML = `<div class="mode-banner offline"><span>장애 중 판매 · ${outage ? `${fmtTime(outage.started_at)}부터 ` : ''}이 기기에 보관 후 복구되면 자동 전송합니다. 카드는 단말기 단독 승인 후 승인번호를 입력하세요.</span></div>`;
  } else {
    box.innerHTML = '';
  }
}

function fmtLocalInput(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

window.addEventListener('online', checkConnection);
window.addEventListener('offline', () => setConnection('down', 'NETWORK'));

/* 장애 대비 상품 목록: 바코드·판매가·구분만 이 기기에 보관한다. */

async function refreshCatalog() {
  if (!state.ctx || isDown()) return;
  try {
    const data = await api.request('/pos/offline-catalog');
    writeStore('catalog', { generated_at: data.generated_at, products: data.products });
  } catch (error) {
    noteRequestFailure(error);
  }
}

function catalogProducts() {
  return readStore('catalog', { products: [] }).products || [];
}

function searchCatalog(query, categoryId) {
  const q = String(query || '').trim().toLowerCase();
  return catalogProducts()
    .filter((p) => (!categoryId || p.category_id === Number(categoryId)) && (!q || p.barcode === query || String(p.product_name).toLowerCase().includes(q) || String(p.barcode || '').includes(q)))
    .slice(0, 80);
}

function catalogByBarcode(code) {
  return catalogProducts().find((p) => p.barcode && p.barcode === String(code).trim());
}

/* 판매 저장: 같은 내용이면 같은 거래 고유번호로 다시 보내 서버가 한 번만 저장하게 한다. */

function saleIdFor(body) {
  const key = JSON.stringify(body);
  if (!state.pendingSale || state.pendingSale.key !== key) state.pendingSale = { id: newSaleId(), key };
  return state.pendingSale.id;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendSale(body, { attempts = 3, onRetry, path = '/api/pos/sales' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
          ...(localStorage.getItem(POS_DEVICE_KEY) ? { 'X-POS-Device': localStorage.getItem(POS_DEVICE_KEY) } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      lastError = Object.assign(new Error(data.message || '판매 저장에 실패했습니다.'), { status: res.status, reason: data.reason, data });
      if (res.status < 500) throw Object.assign(lastError, { final: true });
    } catch (error) {
      if (error.final) throw error;
      lastError = error.status ? error : Object.assign(new Error('서버에 연결할 수 없습니다.'), { network: true });
    }
    if (attempt < attempts) {
      onRetry?.(attempt + 1, attempts);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  noteRequestFailure(lastError.network ? lastError : null);
  throw Object.assign(lastError, { retryable: true });
}

function setPayStatus(html) {
  const el = document.getElementById('payRetry');
  if (el) el.innerHTML = html ? `<div class="notice warn" style="margin-top: 8px;">${html}</div>` : '';
}

// 서버에 끝내 저장하지 못한 판매. 장애 중 판매로 보관하거나 다시 시도한다.
function openSaleFailure(body, error, path = '/api/pos/sales') {
  state.failedSale = body;
  state.failedSalePath = path;
  // 서버에 올린 판매(승인 포함)는 서버에서 확정해야 하므로 기기에 보관할 수 없다.
  const canQueue = path === '/api/pos/sales' && !state.payRows.some((row) => row.van || row.method === 'POINT');
  openModal(
    `
    ${modalHead('판매가 서버에 저장되지 않았습니다', { closable: false })}
    <div class="modal-body">
      <div class="notice danger" style="margin-bottom: 10px;">${h(error.message)} · 3번 다시 보냈지만 응답을 받지 못했습니다.</div>
      <div class="notice" style="margin-bottom: 10px;">거래 고유번호 <b>${h(body.client_sale_id.slice(0, 8))}</b>로 보냈습니다. 서버가 이미 저장했더라도 같은 번호로 다시 보내면 <b>한 번만 저장</b>됩니다. 카드는 <b>다시 승인하지 마세요</b>.</div>
      ${canQueue
        ? '<div class="notice warn">손님을 기다리게 할 수 없으면 <b>장애 중 판매로 보관</b>하세요. 이 기기에 보관했다가 연결이 돌아오면 같은 번호로 자동 전송합니다.</div>'
        : '<div class="notice warn">VAN 데모 승인·포인트가 포함된 결제는 기기에 보관할 수 없습니다. 다시 시도하거나 결제 화면으로 돌아가 승인을 취소한 뒤 현금·단말기 단독 승인으로 받아 주세요.</div>'}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="state.failedSale = null; renderPayment()">결제 화면으로</button>
      ${canQueue ? '<button class="btn btn-outline" type="button" onclick="queueFailedSale()">장애 중 판매로 보관</button>' : ''}
      <button class="btn btn-primary" type="button" onclick="retryFailedSale()" data-autofocus>다시 시도</button>
    </div>
  `,
    { locked: true }
  );
}

function retryFailedSale() {
  const body = state.failedSale;
  if (!body) return;
  withBusy(async () => {
    openModal(`${modalHead('다시 보내는 중', { closable: false })}<div class="modal-body"><div class="notice">같은 거래 고유번호 ${h(body.client_sale_id.slice(0, 8))}로 다시 보내는 중…</div></div>`, { locked: true });
    try {
      const receipt = await sendSale(body, { path: state.failedSalePath || undefined });
      await finishSale(receipt);
    } catch (error) {
      if (error.retryable) return openSaleFailure(body, error, state.failedSalePath || undefined);
      state.modalLocked = false;
      renderPayment();
      throw error;
    }
  });
}

function queueFailedSale() {
  const body = state.failedSale;
  if (!body) return;
  state.failedSale = null;
  queueSale({ firstBody: body, clientSaleId: body.client_sale_id });
}

async function finishSale(receipt) {
  // 임시번호는 한 거래에만 붙인다. 다음 거래는 새로 넣는다.
  if (state.manual) state.manual.ref = null;
  state.pendingSale = null;
  state.payDraft = null;
  state.failedSale = null;
  state.failedSalePath = null;
  state.payOpen = false;
  state.payRows = [];
  state.modalLocked = false;
  clearCart();
  await Promise.all([refreshSession().catch(() => {}), loadProducts()]);
  refreshBadges();
  const finished = await issueChosenCashReceipt(receipt);
  refreshPendingApprovals();
  showReceipt(finished, { fresh: true });
  if (receipt.duplicate) toast('이미 저장된 거래였습니다. 한 번만 기록되었습니다.');
}

function entrySummary(entry) {
  return {
    total: entry.summary.total,
    count: entry.summary.lines ? entry.summary.lines.reduce((sum, line) => sum + line.quantity, 0) : entry.summary.count,
    methods: entry.body ? entry.body.payments.map((p) => p.method) : entry.summary.methods
  };
}

// 기기에 남길 모양으로 바꾼다. 상품·결제·승인번호는 카운터 공개키로 잠그고 금액·건수만 평문으로 둔다.
// 잠글 수 없으면(https 아님·키 없음) 평문으로 두고 plain 표시를 남겨 서버 현황에 보이게 한다.
async function storedEntry(entry) {
  const key = state.ctx?.offline_key;
  const pharmacyId = state.ctx?.pharmacy?.id;
  if (pharmacyId && OfflineSeal.available(key)) {
    try {
      const sealed = await OfflineSeal.seal(key, pharmacyId, entry.client_sale_id, {
        v: 1,
        pharmacy_id: pharmacyId,
        terminal_id: state.ctx.terminal?.id || null,
        client_sale_id: entry.client_sale_id,
        occurred_at: entry.occurred_at,
        cashier: entry.cashier,
        body: entry.body,
        first_body: entry.first_body || null
      });
      return {
        client_sale_id: entry.client_sale_id,
        occurred_at: entry.occurred_at,
        status: entry.status,
        error: entry.error,
        outage_id: entry.outage_id,
        imported: entry.imported,
        sealed,
        summary: entrySummary(entry)
      };
    } catch {
      /* 잠금 실패: 아래 평문 보관 */
    }
  }
  return { ...entry, plain: true };
}

// 예전에 평문으로 보관한 거래를 지금 키로 잠근다(키를 받은 뒤, 서버 연결 중).
async function sealPlainQueue() {
  const queue = saleQueue();
  if (!queue.some((e) => !e.sealed) || !OfflineSeal.available(state.ctx?.offline_key)) return;
  const sealed = await Promise.all(queue.map((e) => (e.sealed ? e : storedEntry(e))));
  if (sealed.every((e, i) => e === queue[i] || e.plain)) return;
  const current = saleQueue();
  const byId = new Map(sealed.map((e) => [e.client_sale_id, e]));
  await writeStore('queue', current.map((e) => (!e.sealed && byId.get(e.client_sale_id)?.sealed ? byId.get(e.client_sale_id) : e)));
}

// 이 기기에 판매를 보관한다. 결제는 단말기 단독 승인 번호·현금만, 가격은 판매 당시 값을 그대로 남긴다.
async function queueSale({ firstBody = null, clientSaleId = newSaleId() } = {}) {
  const t = totals();
  const entry = {
    client_sale_id: clientSaleId,
    occurred_at: new Date().toISOString(),
    cashier: state.ctx.user.name,
    body: {
      customer_id: state.customer?.id || null,
      items: state.cart.map((line) => ({ product_id: line.product.id, quantity: line.quantity, price: line.product.sale_price })),
      discount_amount: t.discount,
      discount_reason: state.discount.reason,
      payments: payloadPayments().map(({ van_transaction_id, ...payment }) => payment)
    },
    first_body: firstBody,
    summary: {
      total: t.final,
      lines: state.cart.map((line) => ({ name: line.product.product_name, quantity: line.quantity, price: line.product.sale_price, product_type: line.product.product_type }))
    },
    status: 'PENDING',
    error: null
  };
  const queue = saleQueue();
  queue.push(await storedEntry(entry));
  if (!(await writeStore('queue', queue))) return;

  const catalog = readStore('catalog');
  for (const line of state.cart) {
    line.product.stock_quantity = Math.max(0, Number(line.product.stock_quantity || 0) - line.quantity);
    const cached = catalog?.products.find((p) => p.id === line.product.id);
    if (cached) cached.stock_quantity = Math.max(0, cached.stock_quantity - line.quantity);
  }
  if (catalog) writeStore('catalog', catalog);

  state.pendingSale = null;
  state.payOpen = false;
  state.payRows = [];
  state.modalLocked = false;
  clearCart();
  renderConnection();
  renderProducts();
  showQueuedReceipt(entry);
}

function queuedReceiptHtml(entry) {
  const pharmacy = state.ctx.pharmacy;
  return `
    <div class="receipt">
      <h3>${h(pharmacy?.pharmacy_name || '')}</h3>
      <div class="center">${h(pharmacy?.address || '')}</div>
      <div class="title-tag">임시 영수증 · 장애 중 판매</div>
      <div class="row"><span>임시번호</span><span>${h(entry.client_sale_id.slice(0, 8).toUpperCase())}</span></div>
      <div class="row"><span>일시</span><span>${fmtDateTime(entry.occurred_at)}</span></div>
      <div class="row"><span>판매자</span><span>${h(entry.cashier)}</span></div>
      <div class="hr"></div>
      ${entry.summary.lines
        .map((line) => `<div class="bold">${h(line.name)}${line.product_type === 'OTC' ? ' [일반의약품]' : ''}</div><div class="row"><span>${won(line.price)} × ${line.quantity}</span><span>${won(line.price * line.quantity)}</span></div>`)
        .join('')}
      <div class="hr"></div>
      ${entry.body.discount_amount ? `<div class="row"><span>할인</span><span>-${won(entry.body.discount_amount)}</span></div>` : ''}
      <div class="row big"><span>결제 금액</span><span>${won(entry.summary.total)}</span></div>
      ${entry.body.payments
        .map((p) => `<div class="row"><span>${METHOD_LABELS[p.method]}${p.card_company ? `(${h(p.card_company)})` : ''}</span><span>${won(p.amount)}</span></div>${p.approval_number ? `<div class="row"><span>  승인번호</span><span>${h(p.approval_number)}</span></div>` : ''}${p.received_amount ? `<div class="row"><span>  받은 금액</span><span>${won(p.received_amount)}</span></div><div class="row"><span>  거스름돈</span><span>${won(p.received_amount - p.amount)}</span></div>` : ''}`)
        .join('')}
      <div class="hr"></div>
      <div class="center">인터넷 장애로 임시 발행한 영수증입니다.<br />복구 후 정식 거래번호가 부여되며, 교환·반품은 그 뒤에 가능합니다.</div>
    </div>
  `;
}

function showQueuedReceipt(entry) {
  window.__lastQueued = entry;
  const change = entry.body.payments.find((p) => p.received_amount);
  openModal(`
    ${modalHead('장애 중 판매 보관 완료')}
    <div class="modal-body" style="background: var(--bg-canvas);">
      <div class="notice warn" style="margin-bottom: 14px; font-size: 15px;">이 기기에 보관했습니다 · ${won(entry.summary.total)}${change ? ` · 거스름돈 <b>${won(change.received_amount - change.amount)}</b>` : ''}<br />연결이 돌아오면 자동으로 서버에 저장합니다. 브라우저 데이터를 지우지 마세요.<br />종이 장부에 <b>임시번호 ${h(tempNumber(entry.client_sale_id))}</b>·금액을 함께 적어 두세요. PC가 고장 나면 이 번호로 수기 복구합니다.${OfflineSeal.available(state.ctx?.offline_key) ? '' : '<br /><b>이 PC는 보관 거래를 잠글 수 없어(https 아님) 평문으로 보관했습니다.</b>'}</div>
      ${queuedReceiptHtml(entry)}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="printQueuedReceipt(window.__lastQueued)">임시 영수증 인쇄</button>
      <button class="btn btn-primary" type="button" onclick="closeModal()" data-autofocus>다음 판매 (Enter)</button>
    </div>
  `);
}

function printQueuedReceipt(entry) {
  document.getElementById('printArea').innerHTML = queuedReceiptHtml(entry);
  setTimeout(() => window.print(), 50);
}

async function registerOutage(outage, earliest) {
  const startedAt = earliest && Date.parse(earliest) < Date.parse(outage.started_at) ? earliest : outage.started_at;
  const data = await api.request('/pos/outages', {
    method: 'POST',
    body: { kind: outage.kind || 'NETWORK', started_at: startedAt, ended_at: new Date().toISOString(), note: `단말기 자동 기록 · ${state.ctx.terminal?.terminal_name || ''}` }
  });
  return data.outage.id;
}

// 보관한 판매를 순서대로 보낸다. 실패한 거래는 지우지 않고 남겨서 사람이 확인하게 한다.
async function syncQueue({ auto = false } = {}) {
  if (state.syncing) return;
  const queue = saleQueue();
  if (!queue.length) return;
  if (!state.session) {
    if (!auto) toast('영업을 시작한 뒤에 보낼 수 있습니다.', 'error');
    return;
  }
  state.syncing = true;
  let saved = 0;
  let duplicates = 0;
  try {
    let outage = readStore('outage') || { started_at: queue[0].occurred_at, kind: 'NETWORK' };
    if (!outage.server_id) {
      const earliest = queue.map((e) => e.occurred_at).sort()[0];
      outage = { ...outage, server_id: await registerOutage(outage, earliest) };
      writeStore('outage', outage);
    }
    for (const entry of queue) {
      entry.outage_id = entry.outage_id || outage.server_id;
      try {
        let receipt;
        if (entry.sealed) {
          // 잠긴 거래는 서버가 풀어 저장한다(처음 보낸 내용 확인도 서버에서).
          receipt = await sendSale({ client_sale_id: entry.client_sale_id, sealed: entry.sealed, outage_id: entry.outage_id }, { attempts: 2, path: '/api/pos/offline-sales' });
        } else {
          const body = {
            ...entry.body,
            client_sale_id: entry.client_sale_id,
            recovery: { source: 'OFFLINE_QUEUE', occurred_at: entry.occurred_at, outage_id: entry.outage_id }
          };
          try {
            receipt = await sendSale(body, { attempts: 2 });
          } catch (error) {
            // 결제 직전 서버가 이미 저장하고 응답만 못 준 거래면, 처음 보낸 내용 그대로 확인한다.
            if (error.status === 409 && error.reason === 'CLIENT_SALE_CONFLICT' && entry.first_body) receipt = await sendSale(entry.first_body, { attempts: 1 });
            else throw error;
          }
        }
        if (receipt.duplicate) duplicates += 1;
        saved += 1;
        entry.done = true;
      } catch (error) {
        if (error.retryable) break;
        entry.status = 'FAILED';
        entry.error = error.message;
        // 장애를 먼저 닫아 버린 경우: 다음 전송 때 새 장애로 기록한다.
        if (error.status === 409 && /재고 대사를 마친/.test(error.message)) {
          entry.outage_id = null;
          outage = { ...outage, server_id: null };
        }
      }
    }
    // 서버에 저장된 거래는 이 기기에서 바로 지운다. 보내는 동안 새로 보관한 거래는 그대로 둔다.
    const sent = new Map(queue.map((entry) => [entry.client_sale_id, entry]));
    const rest = saleQueue()
      .filter((entry) => !sent.get(entry.client_sale_id)?.done)
      .map((entry) => (sent.has(entry.client_sale_id) ? minimizeQueued(sent.get(entry.client_sale_id)) : entry));
    await writeStore('queue', rest);
    await writeStore('outage', rest.length || isDown() ? outage : null);
  } catch (error) {
    noteRequestFailure(error);
    if (!auto) toast(error.message, 'error');
  } finally {
    state.syncing = false;
    renderConnection();
  }
  await reportQueue();
  const left = saleQueue().length;
  if (saved) {
    toast(`장애 중 판매 ${saved}건을 서버에 저장했습니다${duplicates ? ` (이미 저장돼 있던 ${duplicates}건 포함)` : ''}.${left ? ` 남은 ${left}건은 확인이 필요합니다.` : ' 재고 대사를 진행해 주세요.'}`);
    refreshSession().catch(() => {});
    loadProducts();
    refreshBadges();
  } else if (left && !auto) {
    toast(`보내지 못한 거래 ${left}건이 남아 있습니다.`, 'error');
  }
  if (document.getElementById('recoveryPanel')) openRecovery();
}

function removeQueued(id) {
  if (!isOwner()) return toast('보관 거래 삭제는 약사(관리자)만 할 수 있습니다.', 'error');
  const entry = saleQueue().find((e) => e.client_sale_id === id);
  if (!entry) return;
  if (!confirm(`이 거래(임시번호 ${tempNumber(id)} · ${won(entry.summary.total)})를 서버에 기록하지 않고 지울까요?\n수기 거래 복구로 따로 입력했거나 실제로 판매하지 않은 경우에만 지우세요.`)) return;
  writeStore('queue', saleQueue().filter((e) => e.client_sale_id !== id)).then(async () => {
    renderConnection();
    await reportQueue();
    openRecovery();
  });
}

const tempNumber = (clientSaleId) => String(clientSaleId).slice(0, 8).toUpperCase();

/* ---------- PC별 보관 거래 보고 ----------
   이 브라우저의 설치 번호로 남은 거래의 번호·시각·금액·상태만 서버에 알린다(상품·결제 내용은 보내지 않는다).
   서버에 이미 있는 거래(전송 후 응답을 못 받았거나 다른 PC에서 가져와 보낸 것)는 서버 답을 보고 지운다. */

const POS_INSTALL_KEY = 'maydin_pos_install';

function installId() {
  let id = localStorage.getItem(POS_INSTALL_KEY);
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id || '')) {
    id = newSaleId();
    localStorage.setItem(POS_INSTALL_KEY, id);
  }
  return id;
}

async function reportQueue() {
  if (!state.ctx || isDown() || state.reporting) return null;
  state.reporting = true;
  try {
    const data = await api.request('/pos/offline-queue/report', {
      method: 'POST',
      body: {
        install_id: installId(),
        storage: LocalStore.backend,
        entries: saleQueue().map((e) => ({ id: e.client_sale_id, occurred_at: e.occurred_at, amount: e.summary.total, status: e.status, sealed: Boolean(e.sealed) }))
      }
    });
    state.queueReport = { ...data, at: new Date() };
    if (data.saved_ids.length) {
      const saved = new Set(data.saved_ids);
      await writeStore('queue', saleQueue().filter((e) => !saved.has(e.client_sale_id)));
      toast(`서버에 이미 저장된 보관 거래 ${data.saved_ids.length}건을 이 PC에서 지웠습니다.`);
      renderConnection();
    }
    return data;
  } catch (error) {
    noteRequestFailure(error);
    return null;
  } finally {
    state.reporting = false;
  }
}

/* ---------- 보관 거래 파일 내보내기·가져오기 ----------
   PC 교체·고장 때 남은 거래를 USB 등으로 옮긴다. 잠긴 거래는 서버 없이는 열 수 없지만, 가져와 보낸 뒤 파일은 지운다. */

const QUEUE_FILE_FORMAT = 'maydin-offline-queue/1';

function exportQueue() {
  const queue = saleQueue();
  if (!queue.length) return toast('내보낼 보관 거래가 없습니다.', 'error');
  const plain = queue.filter((e) => !e.sealed).length;
  if (plain && !confirm(`잠기지 않은 거래 ${plain}건은 파일에 상품·결제 내용이 그대로 들어갑니다. 파일을 옮긴 뒤 반드시 지워 주세요. 내보낼까요?`)) return;
  const file = {
    format: QUEUE_FILE_FORMAT,
    pharmacy_id: state.ctx.pharmacy?.id,
    terminal_name: state.ctx.terminal?.terminal_name || null,
    install: installId().slice(0, 8).toUpperCase(),
    exported_at: new Date().toISOString(),
    entries: queue
  };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  link.download = `maydin-보관거래-${(file.terminal_name || 'PC').replace(/[^\w가-힣-]/g, '')}-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`보관 거래 ${queue.length}건을 파일로 내보냈습니다. 이 PC의 거래는 서버로 보내질 때까지 그대로 둡니다.`);
}

function pickQueueFile() {
  if (!isOwner()) return toast('보관 거래 가져오기는 약사(관리자)만 할 수 있습니다.', 'error');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = () => input.files[0] && importQueue(input.files[0]);
  input.click();
}

async function importQueue(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('보관 거래 파일을 읽을 수 없습니다.', 'error');
  }
  if (data?.format !== QUEUE_FILE_FORMAT || !Array.isArray(data.entries)) return toast('MAYDIN 보관 거래 파일이 아닙니다.', 'error');
  if (Number(data.pharmacy_id) !== Number(state.ctx.pharmacy?.id)) return toast('다른 약국의 보관 거래 파일입니다.', 'error');
  const valid = data.entries.filter((e) => /^[0-9a-f-]{36}$/i.test(e?.client_sale_id || '') && (e.sealed || e.body) && Number.isFinite(Number(e.summary?.total)));
  const known = new Set(saleQueue().map((e) => e.client_sale_id));
  const fresh = valid.filter((e) => !known.has(e.client_sale_id));
  if (!fresh.length) return toast(`가져올 새 거래가 없습니다${valid.length ? ` (이미 이 PC에 있는 거래 ${valid.length}건)` : ''}.`, 'error');
  const total = fresh.reduce((sum, e) => sum + Number(e.summary.total), 0);
  if (!confirm(`${data.terminal_name || '다른 PC'}(${data.install || '-'})에서 ${fmtDateTime(data.exported_at)}에 내보낸 거래 ${fresh.length}건(${won(total)})을 가져와 서버로 보낼까요?\n이미 서버에 있는 거래는 한 번만 기록됩니다.`)) return;
  const entries = await Promise.all(fresh.map((e) => (e.sealed ? minimizeQueued({ ...e, status: 'PENDING', error: null, imported: true }) : storedEntry({ ...e, status: 'PENDING', error: null, imported: true }))));
  if (!(await writeStore('queue', [...saleQueue(), ...entries]))) return;
  renderConnection();
  toast(`보관 거래 ${fresh.length}건을 가져왔습니다. 서버로 보냅니다.`);
  await syncQueue();
}

/* 장애 · 복구 화면 */

function queueRows() {
  const queue = saleQueue();
  if (!queue.length) return '<div class="muted">이 기기에 보관 중인 거래가 없습니다.</div>';
  return `<table><thead><tr><th>판매 시각</th><th>임시번호</th><th>상품</th><th class="num">금액</th><th>결제</th><th>상태</th><th></th></tr></thead><tbody>${queue
    .map(
      (e) => `<tr>
        <td>${fmtDateTime(e.occurred_at)}${e.cashier ? `<div class="muted" style="font-size: 12px;">${h(e.cashier)}</div>` : ''}</td>
        <td><b>${h(tempNumber(e.client_sale_id))}</b>${e.imported ? '<div class="muted" style="font-size: 12px;">파일에서 가져옴</div>' : ''}</td>
        <td>${e.sealed ? `<span class="badge">잠김</span> ${entrySummary(e).count}개` : `<span class="badge red">잠기지 않음</span> ${h(e.summary.lines.map((l) => `${l.name} ×${l.quantity}`).join(', '))}`}</td>
        <td class="num">${won(e.summary.total)}</td>
        <td>${h(entrySummary(e).methods.map((m) => METHOD_LABELS[m] || m).join('+'))}</td>
        <td>${e.status === 'FAILED' ? `<span class="badge red">확인 필요</span><div style="font-size: 12px; color: var(--danger);">${h(e.error || '')}</div>` : '<span class="badge orange">전송 대기</span>'}</td>
        <td>${isOwner() ? `<button class="btn btn-outline btn-sm" type="button" onclick="removeQueued('${h(e.client_sale_id)}')">삭제</button>` : ''}</td>
      </tr>`
    )
    .join('')}</tbody></table>`;
}

function thisDeviceLine() {
  const sealing = OfflineSeal.available(state.ctx?.offline_key);
  const report = state.queueReport;
  return [
    `이 PC 설치번호 ${h(installId().slice(0, 8).toUpperCase())}`,
    `저장소 ${{ indexeddb: 'IndexedDB', local: 'localStorage', memory: '메모리(저장 안 됨)' }[LocalStore.backend] || '-'}`,
    sealing ? '보관 거래 잠금 사용' : '<b style="color: var(--danger);">보관 거래 잠금 불가(https 아님·키 없음) — 평문 보관</b>',
    report ? `서버 보고 ${report.at.toLocaleTimeString('ko-KR', { hour12: false })}` : '서버 보고 전'
  ].join(' · ');
}

const ENTRY_STATES = {
  SAVED: '<span class="badge green">서버에 저장됨</span>',
  MANUAL: '<span class="badge green">수기 복구함</span>',
  MISSING: '<span class="badge red">서버에 없음</span>'
};

async function loadDeviceStatus() {
  const box = document.getElementById('deviceStatus');
  if (!box) return;
  try {
    await reportQueue();
    const data = await api.request('/pos/offline-queue/status');
    state.deviceStatus = data;
    box.className = '';
    box.innerHTML = deviceStatusHtml(data);
  } catch (error) {
    noteRequestFailure(error);
    box.textContent = error.message;
  }
}

function deviceStatusHtml({ terminals, devices }) {
  const counters = `<table><thead><tr><th>카운터</th><th>등록 PC</th><th class="num">미전송</th><th>마지막 보고</th><th>상태</th></tr></thead><tbody>${terminals
    .map(
      (t) => `<tr>
        <td>${h(t.terminal_name)}</td>
        <td>${t.device_registered ? h(t.device_label || '등록됨') : '<span class="muted">등록 안 함</span>'}</td>
        <td class="num">${t.unsent_count ? `<b style="color: var(--danger);">${t.unsent_count}건</b>` : '0'}${t.plain_count ? `<div style="font-size: 12px; color: var(--danger);">잠기지 않음 ${t.plain_count}</div>` : ''}</td>
        <td>${t.reported_at ? fmtDateTime(t.reported_at) : '-'}</td>
        <td>${t.unsent_count ? '<span class="badge red">그 PC에서 보내야 함</span>' : t.unreported ? '<span class="badge orange">보고 없음 · PC를 켜서 확인</span>' : '<span class="badge green">남은 거래 없음</span>'}</td>
      </tr>`
    )
    .join('')}</tbody></table>`;
  const watched = devices.filter((d) => d.retired_at || d.unsent_count > 0);
  return `${counters}${watched.length ? `<h4 style="margin: 14px 0 6px;">확인할 PC ${watched.length}대</h4>${watched.map(deviceCardHtml).join('')}` : ''}`;
}

function deviceCardHtml(d) {
  const entries = d.entries || [];
  return `<div class="notice ${d.missing_count ? 'danger' : 'warn'}" style="margin-bottom: 10px;">
    <div><b>${h(d.terminal_name || '카운터 없음')} · PC ${h(d.install)}</b>${d.retired_at ? ` · ${fmtDateTime(d.retired_at)} 교체·해제${d.retire_note ? ` (${h(d.retire_note)})` : ''}` : ' · 사용 중'} · 마지막 보고 ${d.reported_at ? fmtDateTime(d.reported_at) : '-'}</div>
    ${entries.length
      ? `<table style="margin-top: 6px;"><thead><tr><th>임시번호</th><th>판매 시각</th><th class="num">금액</th><th>서버</th><th></th></tr></thead><tbody>${entries
          .map(
            (e) => `<tr>
              <td><b>${h(e.temp_number)}</b>${e.sealed ? '' : ' <span class="badge red">잠기지 않음</span>'}</td>
              <td>${e.occurred_at ? fmtDateTime(e.occurred_at) : '-'}</td>
              <td class="num">${won(e.amount)}</td>
              <td>${ENTRY_STATES[e.state] || ''}${e.order_number ? `<div class="muted" style="font-size: 12px;">${h(e.order_number)}</div>` : ''}</td>
              <td>${d.retired_at && e.state === 'MISSING' ? `<button class="btn btn-outline btn-sm" type="button" onclick="recoverMissing('${h(e.temp_number)}', '${h(e.occurred_at || '')}')">수기 복구</button>` : ''}</td>
            </tr>`
          )
          .join('')}</tbody></table>`
      : '<div class="muted" style="margin-top: 4px;">마지막 보고에 남은 거래 없음</div>'}
    ${d.retired_at
      ? `<div style="margin-top: 8px;">${d.missing_count ? `서버에 없는 거래 ${d.missing_count}건: 그 PC에서 파일로 내보내 가져오거나, 종이 장부·카드 단말기 기록으로 <b>임시번호를 넣어</b> 수기 복구하세요. ` : '남았던 거래가 모두 서버에 있습니다. '}<button class="btn btn-outline btn-sm" type="button" onclick="resolveDevice(${d.id}, ${d.missing_count})">확인 완료</button></div>`
      : '<div style="margin-top: 8px;">그 PC를 켜고 인터넷에 연결하면 자동으로 보냅니다. PC가 고장 났으면 카운터 관리에서 PC를 교체·해제한 뒤 이 목록에서 복구하세요.</div>'}
  </div>`;
}

function resolveDevice(id, missing) {
  let note = '';
  if (missing) {
    note = prompt(`서버에 없는 거래 ${missing}건이 남아 있습니다. 수기 복구하지 않고 확인을 마치는 사유를 적어 주세요.\n(예: 실제 판매 없음 확인 · 종이 장부 대조)`);
    if (!note?.trim()) return;
  } else if (!confirm('이 PC의 보관 거래 확인을 마칠까요? 목록에서 사라집니다.')) {
    return;
  }
  withBusy(async () => {
    const data = await api.request(`/pos/offline-queue/devices/${id}/resolve`, { method: 'POST', body: { note: note.trim() } });
    state.deviceStatus = data;
    const box = document.getElementById('deviceStatus');
    if (box) box.innerHTML = deviceStatusHtml(data);
    toast('보관 거래 확인을 기록했습니다.');
  });
}

function recoverMissing(ref, occurredAt) {
  openManualRecovery({ ref, occurred_at: occurredAt });
}

async function openRecovery() {
  if (!state.ctx) return;
  const outage = readStore('outage');
  const pending = saleQueue().length;
  openModal(
    `
    ${modalHead('장애 대응 · 복구')}
    <div class="modal-body" id="recoveryPanel">
      <div class="recovery-section">
        <h3>연결 상태</h3>
        <div class="notice ${isDown() ? 'danger' : ''}">${isDown() ? `${OUTAGE_REASONS[conn.reason]} · 장애 중 판매 모드` : '서버 정상'}${outage ? ` · 장애 시작 ${fmtDateTime(outage.started_at)}` : ''}${conn.checkedAt ? ` · 마지막 확인 ${conn.checkedAt.toLocaleTimeString('ko-KR', { hour12: false })}` : ''}
          <button class="discount-link" type="button" onclick="checkConnection().then(openRecovery)">지금 확인</button></div>
      </div>
      <div class="recovery-section">
        <h3>이 PC에 보관한 거래 ${pending}건</h3>
        <div class="muted" style="font-size: 12px; margin-bottom: 8px;">${thisDeviceLine()}</div>
        ${queueRows()}
        <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
          ${pending ? `<button class="btn btn-primary" type="button" onclick="syncQueue()" ${isDown() ? 'disabled' : ''}>서버로 보내기</button>` : ''}
          ${pending ? '<button class="btn btn-outline" type="button" onclick="exportQueue()">파일로 내보내기</button>' : ''}
          ${isOwner() ? `<button class="btn btn-outline" type="button" onclick="pickQueueFile()" ${isDown() ? 'disabled' : ''}>다른 PC 파일 가져오기</button>` : ''}
          ${pending && isDown() ? '<span class="muted" style="align-self: center;">연결이 돌아오면 자동으로 보냅니다. PC를 바꿔야 하면 먼저 파일로 내보내세요.</span>' : ''}
        </div>
      </div>
      ${isOwner() ? `
      <div class="recovery-section">
        <h3>카운터별 미전송 거래</h3>
        <div id="deviceStatus" class="muted">${isDown() ? '서버에 연결되면 볼 수 있습니다.' : '불러오는 중…'}</div>
      </div>` : ''}
      <div class="recovery-section">
        <h3>장애 기록 · 재고 대사</h3>
        <div id="outageList" class="muted">${isDown() ? '서버에 연결되면 볼 수 있습니다.' : '불러오는 중…'}</div>
      </div>
      ${isOwner() ? `
      <div class="recovery-section">
        <h3>수기 거래 복구</h3>
        <div class="notice" style="margin-bottom: 10px;">POS를 쓸 수 없어 종이 장부에 적은 거래, 고장 난 PC에서 꺼내지 못한 보관 거래를 실제 판매 시각으로 입력합니다. 임시 영수증이 있던 거래는 <b>임시번호</b>를 함께 넣으면 서버가 이미 저장된 거래인지 확인하고, 나중에 그 PC의 거래가 들어와도 두 번 기록하지 않습니다.</div>
        <button class="btn btn-outline" type="button" onclick="openManualRecovery()" ${isDown() ? 'disabled' : ''}>수기 거래 복구 시작</button>
      </div>` : ''}
    </div>
  `,
    { size: 'xwide' }
  );
  if (isDown()) return;
  if (isOwner()) loadDeviceStatus();
  try {
    const data = await api.request('/pos/outages');
    state.outages = data.outages;
    const box = document.getElementById('outageList');
    if (!box) return;
    box.className = '';
    box.innerHTML = data.outages.length
      ? `<table><thead><tr><th>장애</th><th>기간</th><th class="num">복구 거래</th><th class="num">재고 부족</th><th>상태</th><th></th></tr></thead><tbody>${data.outages
          .map(
            (o) => `<tr>
              <td>#${o.id} ${h(o.kind_label)}<div class="muted" style="font-size: 12px;">${h(o.note || '')}</div></td>
              <td>${fmtDateTime(o.started_at)} ~ ${o.ended_at ? fmtTime(o.ended_at) : '-'}</td>
              <td class="num">${o.sale_count}건 · ${won(o.sale_amount)}</td>
              <td class="num">${o.shortage_quantity ? `<b style="color: var(--danger);">${o.shortage_quantity}개</b>` : '0'}</td>
              <td>${o.status === 'RECONCILED' ? `<span class="badge green">대사 완료</span><div class="muted" style="font-size: 12px;">${h(o.reconciled_by_name || '')} ${fmtDateTime(o.reconciled_at)}</div>` : '<span class="badge orange">대사 필요</span>'}</td>
              <td><button class="btn btn-outline btn-sm" type="button" onclick="openOutage(${o.id})">${o.status === 'RECONCILED' ? '보기' : '재고 대사'}</button></td>
            </tr>`
          )
          .join('')}</tbody></table>`
      : '<div class="muted">기록된 장애가 없습니다.</div>';
  } catch (error) {
    noteRequestFailure(error);
    const box = document.getElementById('outageList');
    if (box) box.textContent = error.message;
  }
}

function unconfirmedText(item) {
  const name = `<b>${h(item.terminal_name || '카운터 없음')}</b>`;
  if (item.kind === 'LOST') return `${name} 교체한 PC ${h(item.install)}의 서버에 없는 거래 ${item.missing_count}건`;
  if (item.kind === 'UNREPORTED') return `${name}${item.device_label ? `(${h(item.device_label)})` : ''} 보고 없음`;
  return `${name} PC ${h(item.install)} 마지막 보고 ${fmtDateTime(item.reported_at)}`;
}

async function openOutage(id) {
  // 이 PC 상태를 먼저 알려야 대사 확인에 반영된다.
  await reportQueue();
  let data;
  try {
    data = await api.request(`/pos/outages/${id}`);
  } catch (error) {
    noteRequestFailure(error);
    return toast(error.message, 'error');
  }
  const { outage, sales, products, legacy_stock: legacy, device_check: deviceCheck } = data;
  const open = outage.status !== 'RECONCILED';
  const editable = open && isOwner() && !legacy;
  const pendingDevices = deviceCheck?.pending || [];
  const unconfirmed = deviceCheck?.unconfirmed || [];
  openModal(
    `
    ${modalHead(`장애 #${outage.id} · ${h(outage.kind_label)}`)}
    <div class="modal-body">
      <div class="notice" style="margin-bottom: 12px;">${fmtDateTime(outage.started_at)} ~ ${outage.ended_at ? fmtDateTime(outage.ended_at) : '-'}${outage.note ? ` · ${h(outage.note)}` : ''}</div>
      <h3 style="font-size: 15px; margin: 0 0 8px;">복구한 거래 ${sales.length}건</h3>
      ${sales.length
        ? `<table style="margin-bottom: 16px;"><thead><tr><th>실제 판매 시각</th><th>거래번호</th><th>상품</th><th class="num">금액</th><th>방식</th></tr></thead><tbody>${sales
            .map((s) => `<tr><td>${fmtDateTime(s.created_at)}</td><td>${h(s.order_number)}${s.temp_number || s.recovery_ref ? `<div class="muted" style="font-size: 12px;">임시번호 ${h((s.recovery_ref || s.temp_number).toUpperCase())}</div>` : ''}</td><td>${h(s.items_summary || '')}</td><td class="num">${won(s.final_amount)}</td><td>${h(s.source_label)}</td></tr>`)
            .join('')}</tbody></table>`
        : '<div class="muted" style="margin-bottom: 16px;">이 장애에 묶인 거래가 없습니다.</div>'}
      <h3 style="font-size: 15px; margin: 0 0 8px;">재고 대사</h3>
      ${open && saleQueue().length ? `<div class="notice danger" style="margin-bottom: 10px;">이 PC에 아직 서버로 보내지 않은 거래가 ${saleQueue().length}건 있습니다. 먼저 보낸 뒤 대사하세요.</div>` : ''}
      ${open && pendingDevices.length ? `<div class="notice danger" style="margin-bottom: 10px;">보내지 않은 장애 중 거래가 남은 PC가 있어 대사할 수 없습니다: ${pendingDevices.map((d) => `<b>${h(d.terminal_name || '카운터 없음')}</b> PC ${h(d.install)} ${d.unsent_count}건`).join(', ')}. 그 PC를 인터넷에 연결하거나 파일로 내보내 가져오세요.</div>` : ''}
      ${open && unconfirmed.length ? `<div class="notice warn" style="margin-bottom: 10px;">장애 뒤 보관 거래를 확인하지 못한 PC: ${unconfirmed.map(unconfirmedText).join(', ')}.<br />그 PC를 켜서 「장애 · 복구」 화면을 열면 자동으로 확인됩니다. 켤 수 없으면 종이 장부·카드 단말기 기록과 대조한 뒤 아래에 표시하세요.
        ${isOwner() ? '<label style="display: block; margin-top: 6px;"><input type="checkbox" id="confirmDevices" /> 위 PC에 남은 거래가 없음을 직접 확인했습니다</label>' : ''}</div>` : ''}
      ${open
        ? legacy
          ? '<div class="notice warn" style="margin-bottom: 10px;">재고 기준이 기존 POS입니다. 수량은 기존 POS에서 실사·조정하고, 여기서는 확인 완료만 기록합니다.</div>'
          : '<div class="notice warn" style="margin-bottom: 10px;">장애 중 팔린 상품을 매대·창고에서 직접 세어 <b>실제 수량</b>을 입력하세요. 시스템 재고를 그 수량으로 맞추고 이력을 남깁니다.</div>'
        : `<div class="notice" style="margin-bottom: 10px;">${h(outage.reconcile_note || '')} · ${fmtDateTime(outage.reconciled_at)} 대사 완료</div>`}
      ${products.length
        ? `<table><thead><tr><th>상품</th><th class="num">장애 중 판매</th><th class="num">시스템 부족분</th><th class="num">현재 시스템 재고</th>${editable ? '<th class="num">실제 센 수량</th>' : ''}</tr></thead><tbody>${products
            .map(
              (p) => `<tr>
                <td>${h(p.product_name)}<div class="muted" style="font-size: 12px;">${h(p.barcode || '')}</div></td>
                <td class="num">${p.sold_quantity}</td>
                <td class="num">${p.shortage_quantity ? `<b style="color: var(--danger);">${p.shortage_quantity}</b>` : '0'}</td>
                <td class="num">${p.stock_quantity}</td>
                ${editable ? `<td class="num"><input class="input" style="width: 96px; text-align: right;" type="number" min="0" data-count="${p.product_id}" /></td>` : ''}
              </tr>`
            )
            .join('')}</tbody></table>`
        : '<div class="muted">대사할 상품이 없습니다.</div>'}
      ${open && isOwner() ? '<div class="field" style="margin-top: 12px;"><label class="label" for="reconcileNote">메모</label><input id="reconcileNote" class="input" placeholder="예: 매대·창고 실사, 담당 홍길동" /></div>' : ''}
      ${open && !isOwner() ? '<div class="notice" style="margin-top: 12px;">재고 대사는 약사(관리자) 계정으로 진행합니다.</div>' : ''}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="openRecovery()">목록으로</button>
      ${open && isOwner() ? `<button class="btn btn-primary" type="button" onclick="reconcileOutage(${outage.id})">${legacy ? '확인 완료 기록' : '재고 대사 완료'}</button>` : ''}
    </div>
  `,
    { size: 'xwide' }
  );
}

function reconcileOutage(id) {
  const inputs = [...document.querySelectorAll('[data-count]')];
  const empty = inputs.find((input) => input.value === '');
  if (empty) {
    empty.focus();
    return toast('모든 상품의 실제 수량을 세어 입력해 주세요.', 'error');
  }
  const confirmBox = document.getElementById('confirmDevices');
  if (confirmBox && !confirmBox.checked) {
    confirmBox.focus();
    return toast('보관 거래를 확인하지 못한 PC가 있습니다. 직접 확인한 뒤 표시해 주세요.', 'error');
  }
  if (!confirm('입력한 수량으로 시스템 재고를 맞추고 이 장애를 닫을까요? 닫은 뒤에는 이 장애에 거래를 추가할 수 없습니다.')) return;
  withBusy(async () => {
    const data = await api.request(`/pos/outages/${id}/reconcile`, {
      method: 'POST',
      body: {
        confirm_devices: Boolean(confirmBox?.checked),
        note: document.getElementById('reconcileNote')?.value || '',
        counts: inputs.map((input) => ({ product_id: Number(input.dataset.count), counted_quantity: Number(input.value) }))
      }
    });
    toast(data.adjusted.length ? `재고 대사 완료 · ${data.adjusted.length}개 상품 재고를 맞췄습니다.` : '재고 대사 완료 · 조정할 차이가 없었습니다.');
    loadProducts();
    refreshBadges();
    openOutage(id);
  });
}

function toLocalInput(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

function openManualRecovery(prefill = {}) {
  const openOutages = (state.outages || []).filter((o) => o.status !== 'RECONCILED');
  const now = new Date();
  const occurred = prefill.occurred_at && !Number.isNaN(Date.parse(prefill.occurred_at)) ? new Date(prefill.occurred_at) : new Date(now.getTime() - 1800000);
  openModal(
    `
    ${modalHead('수기 거래 복구 시작')}
    <div class="modal-body">
      <div class="field"><label class="label" for="manualOutage">어느 장애의 거래인가요?</label>
        <select id="manualOutage" class="input" onchange="document.getElementById('newOutageFields').style.display = this.value === 'new' ? '' : 'none'">
          ${openOutages.map((o) => `<option value="${o.id}">#${o.id} ${h(o.kind_label)} · ${fmtDateTime(o.started_at)}</option>`).join('')}
          <option value="new" ${openOutages.length ? '' : 'selected'}>새 장애 기록</option>
        </select></div>
      <div id="newOutageFields" style="${openOutages.length ? 'display: none;' : ''}">
        <div class="pay-row-grid">
          <div class="field"><label class="label" for="outageKind">장애 종류</label><select id="outageKind" class="input">${Object.entries(OUTAGE_KIND_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="field"><label class="label" for="outageNote">메모</label><input id="outageNote" class="input" placeholder="예: 정전 · 종이 장부 사용" /></div>
          <div class="field"><label class="label" for="outageStart">시작</label><input id="outageStart" class="input" type="datetime-local" value="${toLocalInput(new Date(now.getTime() - 3600000))}" /></div>
          <div class="field"><label class="label" for="outageEnd">종료</label><input id="outageEnd" class="input" type="datetime-local" value="${toLocalInput(now)}" /></div>
        </div>
      </div>
      <div class="field"><label class="label" for="manualOccurred">첫 거래의 실제 판매 시각</label><input id="manualOccurred" class="input" type="datetime-local" value="${toLocalInput(occurred)}" /></div>
      <div class="field"><label class="label" for="manualRef">첫 거래의 임시번호 (임시 영수증·유실 목록에 있으면)</label><input id="manualRef" class="input" maxlength="8" placeholder="예: 3FA85F64" value="${h(prefill.ref || '')}" style="text-transform: uppercase;" />
        <div class="muted" style="font-size: 12px; margin-top: 4px;">장애 중 판매로 보관했다가 PC 고장 등으로 사라진 거래면 꼭 넣으세요. 나중에 그 PC의 거래가 들어와도 두 번 기록되지 않습니다.</div></div>
      <div class="field"><label class="label" for="manualNote">장부 메모 (선택)</label><input id="manualNote" class="input" placeholder="예: 종이 장부 2쪽" /></div>
      <div class="notice">시작하면 상품을 담고 결제를 입력해 한 건씩 저장합니다. 카드는 단말기 영수증의 승인번호를 입력하고, 재고가 모자라도 기록한 뒤 재고 대사에서 맞춥니다. 판매 시각 7일 이내 거래만 복구할 수 있습니다.</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="openRecovery()">취소</button>
      <button class="btn btn-primary" type="button" onclick="startManualRecovery()">시작</button>
    </div>
  `
  );
}

function startManualRecovery() {
  withBusy(async () => {
    let outageId = document.getElementById('manualOutage').value;
    const occurred = new Date(document.getElementById('manualOccurred').value);
    if (Number.isNaN(occurred.getTime())) throw new Error('실제 판매 시각을 입력해 주세요.');
    const ref = parseManualRef(document.getElementById('manualRef').value);
    if (outageId === 'new') {
      const start = new Date(document.getElementById('outageStart').value);
      const end = new Date(document.getElementById('outageEnd').value);
      const data = await api.request('/pos/outages', {
        method: 'POST',
        body: {
          kind: document.getElementById('outageKind').value,
          started_at: start.toISOString(),
          ended_at: end.toISOString(),
          note: document.getElementById('outageNote').value
        }
      });
      outageId = data.outage.id;
    }
    clearCart();
    state.manual = { outage_id: Number(outageId), occurred_at: occurred.toISOString(), note: document.getElementById('manualNote').value.trim(), ref };
    closeModal(true);
    renderConnection();
    renderProducts();
    toast('수기 거래 복구를 시작합니다. 상품을 담고 결제를 입력하세요.');
  });
}

function endManualRecovery() {
  if (state.cart.length && !confirm('담긴 상품을 비우고 수기 복구를 끝낼까요?')) return;
  state.manual = null;
  clearCart();
  renderConnection();
  renderProducts();
}

function parseManualRef(value) {
  const ref = String(value || '').trim().toLowerCase();
  if (!ref) return null;
  if (!/^[0-9a-f]{8}$/.test(ref)) throw new Error('임시번호는 임시 영수증에 적힌 8자리(0-9, A-F)입니다.');
  return ref;
}

function setManualRef(value) {
  if (!state.manual) return;
  try {
    state.manual.ref = parseManualRef(value);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function setManualOccurred(value) {
  const date = new Date(value);
  if (!state.manual || Number.isNaN(date.getTime())) return;
  state.manual.occurred_at = date.toISOString();
  renderModeBanner();
}

function registerPosShell() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/pos-sw.js').catch(() => {});
}

async function refreshSession() {
  const data = await api.request('/pos/sessions/current');
  state.session = data.session;
  renderTopbar();
}

function setBadge(id, count) {
  const el = document.getElementById(id);
  el.textContent = count;
  el.hidden = !count;
}

async function refreshBadges() {
  try {
    const [pickups, counsels, holds, inventory] = await Promise.all([
      api.request('/pos/pickups'),
      api.request('/pos/counsels'),
      api.request('/pos/holds'),
      api.request('/pos/inventory?filter=low')
    ]);
    setBadge('holdCount', holds.holds.length);
    setBadge('stockAlertCount', stockAlertTotal(inventory.alerts));
    const pickupCount = document.getElementById('pickupCount');
    pickupCount.textContent = pickups.pickups.length;
    pickupCount.hidden = pickups.pickups.length === 0;
    const counselCount = document.getElementById('counselCount');
    counselCount.textContent = counsels.counsels.length;
    counselCount.hidden = counsels.counsels.length === 0;
  } catch (error) {
    /* 배지는 실패해도 판매에 영향 없음 */
  }
}
