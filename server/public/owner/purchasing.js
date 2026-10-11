// MAYDIN 파트너센터 · 거래처·발주
/* ---------- 거래처 · 발주 ---------- */

const PO_STATUS = {
  DRAFT: { text: '작성 중', color: 'gray' },
  ORDERED: { text: '발주 완료', color: 'blue' },
  PARTIAL: { text: '부분 입고', color: 'orange' },
  RECEIVED: { text: '입고 완료', color: 'green' },
  CLOSED: { text: '입고 종료', color: 'gray' },
  CANCELLED: { text: '취소', color: 'red' }
};
const po = { tab: 'orders', filter: 'OPEN', orders: [], suggestions: [], suppliers: [], rule: '', detail: null, editor: null, supplierForm: null };
let allProducts = [];

function poBadge(status) {
  const item = PO_STATUS[status] || { text: status, color: 'gray' };
  return `<span class="badge ${item.color}">${h(item.text)}</span>`;
}

function activeSuppliers() {
  return po.suppliers.filter((s) => s.status === 'ACTIVE');
}

function supplierOptions(selectedId, { allowEmpty = true } = {}) {
  return (allowEmpty ? '<option value="">거래처 선택</option>' : '') +
    activeSuppliers().map((s) => `<option value="${s.id}" ${Number(selectedId) === s.id ? 'selected' : ''}>${h(s.name)}</option>`).join('');
}

async function loadPurchasing() {
  try {
    const [suppliers, suggestions, orders] = await Promise.all([
      api.request('/purchasing/suppliers'),
      api.request('/purchasing/suggestions'),
      api.request(`/purchasing/orders${po.filter === 'OPEN' ? '?status=OPEN' : ''}`)
    ]);
    po.suppliers = suppliers.suppliers;
    po.suggestions = suggestions.suggestions;
    po.rule = suggestions.rule;
    po.orders = orders.orders;
    const count = po.suggestions.length;
    $('#navReorderBadge').hidden = count === 0;
    $('#navReorderBadge').textContent = count;
    $('#poSuggestCount').textContent = count ? count : '';
    if (po.detail) {
      po.detail = await api.request(`/purchasing/orders/${po.detail.order.id}`);
    }
    renderPurchasing();
  } catch (error) {
    $('#purchasingBody').innerHTML = renderEmpty(error.message);
  }
}

function setPoTab(tab) {
  po.tab = tab;
  document.querySelectorAll('[data-po-tab]').forEach((b) => b.classList.toggle('active', b.dataset.poTab === tab));
  renderPurchasing();
}

function renderPurchasing() {
  const body = $('#purchasingBody');
  body.classList.remove('loading');
  if (po.tab === 'suppliers') body.innerHTML = renderSuppliersTab();
  else if (po.tab === 'suggest') body.innerHTML = renderSuggestTab();
  else body.innerHTML = renderOrdersTab();
}

/* 발주서 목록 · 상세 */

function renderOrdersTab() {
  const filters = [['OPEN', '진행 중'], ['ALL', '전체']]
    .map(([key, text]) => `<button class="tab-btn ${po.filter === key ? 'active' : ''}" type="button" onclick="setPoFilter('${key}')">${text}</button>`)
    .join('');
  const list = po.orders.length === 0
    ? renderEmpty(po.filter === 'OPEN' ? '진행 중인 발주서가 없습니다. 발주 추천 탭에서 부족한 상품을 발주해 보세요.' : '작성한 발주서가 없습니다.')
    : `<div class="table-wrap"><table>
        <thead><tr><th>발주번호</th><th>거래처</th><th>품목 · 입고</th><th>금액</th><th>상태</th></tr></thead>
        <tbody>
          ${po.orders.map((o) => `
            <tr class="clickable ${po.detail?.order.id === o.id ? 'selected' : ''}" onclick="openPurchaseOrder(${o.id})">
              <td><div class="list-title">${h(o.po_number)}</div><div class="list-meta">${h(formatDate(o.created_at))}${o.expected_date ? ` · 입고 예정 ${h(o.expected_date)}` : ''}</div></td>
              <td>${h(o.supplier_name)}</td>
              <td>${o.item_count}품목 · ${o.received_quantity}/${o.total_quantity}개</td>
              <td class="list-value" style="text-align: left;">${money(o.total_amount)}</td>
              <td>${poBadge(o.status)}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`;
  return `
    <div class="inline-actions" style="justify-content: space-between; margin-bottom: 12px;">
      <div class="tab-bar" style="margin: 0;">${filters}</div>
      <button class="btn btn-primary btn-sm" type="button" onclick="newPurchaseOrder()">+ 발주서 작성</button>
    </div>
    ${po.editor ? renderPoEditor() : ''}
    ${list}
    ${po.detail && !po.editor ? renderPoDetail() : ''}
  `;
}

function setPoFilter(filter) {
  po.filter = filter;
  loadPurchasing();
}

async function openPurchaseOrder(id) {
  try {
    po.editor = null;
    po.detail = await api.request(`/purchasing/orders/${id}`);
    renderPurchasing();
    setTimeout(() => $('.po-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
  } catch (error) {
    showToast(error.message);
  }
}

function renderPoDetail() {
  const { order, items, receipts, supplier } = po.detail;
  const receivable = ['ORDERED', 'PARTIAL'].includes(order.status);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const actions = [];
  if (order.status === 'DRAFT') {
    actions.push(`<button class="btn btn-outline btn-sm" type="button" onclick="editPurchaseOrder()">수정</button>`);
    actions.push(`<button class="btn btn-primary btn-sm" type="button" onclick="confirmPurchaseOrder(${order.id})">발주 확정</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" type="button" onclick="cancelPurchaseOrder(${order.id}, true)">작성 취소</button>`);
  }
  if (order.status === 'ORDERED') {
    actions.push(`<button class="btn btn-danger btn-sm" type="button" onclick="cancelPurchaseOrder(${order.id}, false)">발주 취소</button>`);
  }
  if (order.status === 'PARTIAL') {
    actions.push(`<button class="btn btn-outline btn-sm" type="button" onclick="closePurchaseOrder(${order.id})">입고 종료</button>`);
  }
  if (order.status !== 'CANCELLED') {
    actions.push(`<button class="btn btn-outline btn-sm" type="button" onclick="printPurchaseOrder()">발주서 인쇄</button>`);
  }
  return `
    <div class="po-detail">
      <div class="card-header" style="margin-bottom: 8px;">
        <h3>${h(order.po_number)} ${poBadge(order.status)}</h3>
        <button class="muted-link" type="button" onclick="po.detail = null; renderPurchasing()">닫기</button>
      </div>
      <p class="list-meta" style="margin: 0 0 12px;">
        ${h(supplier.name)}${supplier.contact_name ? ` · ${h(supplier.contact_name)}` : ''}${supplier.phone ? ` · ${h(supplier.phone)}` : ''}
        · 작성 ${h(formatDate(order.created_at))}${order.created_by_name ? ` (${h(order.created_by_name)})` : ''}
        ${order.ordered_at ? ` · 발주 ${h(formatDate(order.ordered_at))}` : ''}
        ${order.expected_date ? ` · 입고 예정 ${h(order.expected_date)}` : ''}
        ${order.memo ? `<br />메모: ${h(order.memo)}` : ''}
        ${order.cancel_reason ? `<br />${order.status === 'CLOSED' ? '종료' : '취소'} 사유: ${h(order.cancel_reason)}` : ''}
      </p>
      <div class="inline-actions" style="margin-bottom: 12px;">${actions.join('')}</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>상품</th><th>발주</th><th>입고</th><th>단가</th><th>금액</th>
          ${receivable ? '<th>이번 입고</th><th>유통기한</th><th>로트번호</th><th>입고 단가</th>' : ''}
        </tr></thead>
        <tbody>
          ${items.map((item) => {
            const remaining = item.quantity - item.received_quantity;
            return `<tr>
              <td><div class="list-title">${h(item.product_name)}</div><div class="list-meta">${h(item.barcode || '')} · 현재 재고 ${item.stock_quantity}</div></td>
              <td>${item.quantity}</td>
              <td>${item.received_quantity >= item.quantity ? `<span class="badge green">${item.received_quantity}</span>` : item.received_quantity}</td>
              <td>${money(item.unit_cost)}</td>
              <td>${money(item.quantity * item.unit_cost)}</td>
              ${receivable ? (remaining > 0 ? `
                <td><input class="form-control mini-input" type="number" min="0" max="${remaining}" value="${remaining}" data-receive-item="${item.id}" /></td>
                <td><input class="form-control" style="padding: 7px 8px; min-width: 130px;" type="date" min="${today}" data-receive-expiry="${item.id}" /></td>
                <td><input class="form-control" style="padding: 7px 8px; min-width: 90px;" maxlength="40" placeholder="선택" data-receive-lot="${item.id}" /></td>
                <td><input class="form-control mini-input" style="width: 90px;" type="number" min="0" placeholder="${item.unit_cost}" data-receive-cost="${item.id}" /></td>`
                : '<td colspan="4" class="list-meta">입고 완료</td>') : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      <div class="inline-actions" style="justify-content: space-between; margin-top: 12px;">
        <strong>합계 ${money(order.total_amount)}</strong>
        ${receivable ? `<button class="btn btn-primary" type="button" onclick="receivePurchaseOrder(${order.id})">입고 처리</button>` : ''}
      </div>
      ${receivable ? '<p class="list-meta" style="margin: 8px 0 0;">유통기한을 넣으면 로트로 관리되어 POS에서 임박·경과 알림을 받습니다. 입고 단가를 넣으면 상품 원가도 함께 바뀝니다.</p>' : ''}
      ${receipts.length ? `
        <h4 style="margin: 18px 0 8px; font-size: 14px;">입고 내역</h4>
        <div class="list-stack">
          ${receipts.map((r) => `<div class="list-item"><div><div class="list-title">${h(r.product_name)} +${r.quantity}개</div><div class="list-meta">${h(r.reason || '')}</div></div><div class="list-meta" style="text-align: right;">${h(formatDate(r.created_at))}<br />${h(r.created_by_name || '')}</div></div>`).join('')}
        </div>` : ''}
    </div>
  `;
}

async function poAction(path, body, successText) {
  try {
    po.detail = await api.request(path, { method: 'POST', body: body || {} });
    showToast(successText);
    if (path.endsWith('/receive')) await loadOwner();
    else await loadPurchasing();
  } catch (error) {
    showToast(error.message);
  }
}

function confirmPurchaseOrder(id) {
  if (!confirm('발주를 확정할까요? 확정 후에는 수정할 수 없고 입고를 받을 수 있습니다.')) return;
  poAction(`/purchasing/orders/${id}/confirm`, null, '발주를 확정했습니다. 발주서를 인쇄하거나 거래처에 전달해 주세요.');
}

function cancelPurchaseOrder(id, isDraft) {
  const reason = isDraft ? (confirm('작성 중인 발주서를 취소할까요?') ? '작성 취소' : null) : prompt('발주 취소 사유를 입력해 주세요.');
  if (!reason) return;
  poAction(`/purchasing/orders/${id}/cancel`, { reason }, '발주서를 취소했습니다.');
}

function closePurchaseOrder(id) {
  const reason = prompt('남은 수량을 더 받지 않는 사유를 입력해 주세요. (예: 거래처 품절)');
  if (!reason) return;
  poAction(`/purchasing/orders/${id}/close`, { reason }, '입고를 종료했습니다.');
}

function receivePurchaseOrder(id) {
  const items = [...document.querySelectorAll('[data-receive-item]')].map((input) => {
    const itemId = input.dataset.receiveItem;
    const cost = document.querySelector(`[data-receive-cost="${itemId}"]`).value;
    return {
      item_id: Number(itemId),
      quantity: Number(input.value || 0),
      expiry_date: document.querySelector(`[data-receive-expiry="${itemId}"]`).value,
      lot_number: document.querySelector(`[data-receive-lot="${itemId}"]`).value,
      ...(cost !== '' ? { unit_cost: Number(cost) } : {})
    };
  });
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  if (total === 0) return showToast('입고 수량을 입력해 주세요.');
  if (!confirm(`${items.filter((i) => i.quantity > 0).length}개 품목, 총 ${total}개를 입고할까요? 재고에 바로 반영됩니다.`)) return;
  poAction(`/purchasing/orders/${id}/receive`, { items }, `${total}개를 입고했습니다.`);
}

function printPurchaseOrder() {
  const { order, items, supplier, pharmacy } = po.detail;
  const win = window.open('', '_blank', 'width=820,height=900');
  if (!win) return showToast('팝업이 차단되었습니다. 팝업을 허용해 주세요.');
  win.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8" /><title>${h(order.po_number)} 발주서</title>
    <style>
      body { font-family: -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; color: #191f28; margin: 32px; }
      h1 { text-align: center; letter-spacing: 12px; margin: 0 0 24px; }
      .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; font-size: 13px; }
      .meta div { border: 1px solid #d1d6db; padding: 12px; }
      .meta strong { display: block; font-size: 15px; margin-bottom: 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border: 1px solid #d1d6db; padding: 8px; }
      th { background: #f2f4f6; }
      td.num { text-align: right; }
      .total { text-align: right; font-size: 16px; font-weight: 800; margin-top: 12px; }
      .note { font-size: 12px; color: #6b7684; margin-top: 18px; }
      @media print { body { margin: 12mm; } }
    </style></head><body>
    <h1>발주서</h1>
    <div class="meta">
      <div><strong>수신: ${h(supplier.name)}</strong>
        ${supplier.contact_name ? `담당 ${h(supplier.contact_name)}<br />` : ''}${supplier.phone ? `연락처 ${h(supplier.phone)}<br />` : ''}${supplier.email ? `${h(supplier.email)}<br />` : ''}${supplier.business_number ? `사업자 ${h(supplier.business_number)}` : ''}</div>
      <div><strong>발신: ${h(pharmacy.pharmacy_name)}</strong>
        ${pharmacy.phone ? `연락처 ${h(pharmacy.phone)}<br />` : ''}${pharmacy.address ? `${h(pharmacy.address)}<br />` : ''}${pharmacy.business_number ? `사업자 ${h(pharmacy.business_number)}` : ''}</div>
    </div>
    <p style="font-size: 13px;">발주번호 <b>${h(order.po_number)}</b> · 발주일 ${h((order.ordered_at || order.created_at).slice(0, 10))}${order.expected_date ? ` · 입고 희망일 ${h(order.expected_date)}` : ''}${order.status === 'DRAFT' ? ' · <b style="color:#f04452">(확정 전 초안)</b>' : ''}</p>
    <table>
      <thead><tr><th>No</th><th>상품명</th><th>바코드</th><th>수량</th><th>단가</th><th>금액</th></tr></thead>
      <tbody>${items.map((item, i) => `<tr><td class="num">${i + 1}</td><td>${h(item.product_name)}</td><td>${h(item.barcode || '')}</td><td class="num">${item.quantity}</td><td class="num">${item.unit_cost.toLocaleString('ko-KR')}</td><td class="num">${(item.quantity * item.unit_cost).toLocaleString('ko-KR')}</td></tr>`).join('')}</tbody>
    </table>
    <div class="total">합계 ${order.total_amount.toLocaleString('ko-KR')}원 (${items.reduce((s, i) => s + i.quantity, 0)}개)</div>
    ${order.memo ? `<p class="note">메모: ${h(order.memo)}</p>` : ''}
    <p class="note">MAYDIN 파트너센터에서 발행한 발주서입니다.</p>
    <script>window.onload = () => window.print();<\/script>
    </body></html>`);
  win.document.close();
}

/* 발주서 작성 · 수정 */

function newPurchaseOrder(prefill) {
  if (activeSuppliers().length === 0) {
    showToast('먼저 거래처를 등록해 주세요.');
    return setPoTab('suppliers');
  }
  po.detail = null;
  po.editor = prefill || { id: null, supplier_id: '', memo: '', expected_date: '', items: [] };
  setPoTab('orders');
  setTimeout(() => $('#poEditor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
}

function editPurchaseOrder() {
  const { order, items } = po.detail;
  po.editor = {
    id: order.id,
    po_number: order.po_number,
    supplier_id: order.supplier_id,
    memo: order.memo || '',
    expected_date: order.expected_date || '',
    items: items.map((i) => ({ product_id: i.product_id, product_name: i.product_name, barcode: i.barcode, quantity: i.quantity, unit_cost: i.unit_cost }))
  };
  renderPurchasing();
}

function productOptionLabel(p) {
  return `${p.product_name} · ${p.barcode || `#${p.id}`}`;
}

function renderPoEditor() {
  const e = po.editor;
  const total = e.items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.unit_cost || 0), 0);
  const choices = allProducts.filter((p) => p.status !== 'HIDDEN' && !e.items.some((i) => i.product_id === p.id));
  return `
    <div class="po-detail" id="poEditor" style="margin: 0 0 16px;">
      <div class="card-header" style="margin-bottom: 12px;">
        <h3>${e.id ? `${h(e.po_number)} 수정` : '새 발주서'}</h3>
        <button class="muted-link" type="button" onclick="po.editor = null; renderPurchasing()">닫기</button>
      </div>
      <div class="form-grid" style="margin-bottom: 12px;">
        <div class="form-group"><label class="form-label">거래처</label><select class="form-control" onchange="po.editor.supplier_id = this.value">${supplierOptions(e.supplier_id)}</select></div>
        <div class="form-group"><label class="form-label">입고 희망일</label><input class="form-control" type="date" value="${h(e.expected_date)}" onchange="po.editor.expected_date = this.value" /></div>
        <div class="form-group full"><label class="form-label">메모</label><input class="form-control" maxlength="200" value="${h(e.memo)}" placeholder="거래처 전달 사항 (선택)" oninput="po.editor.memo = this.value" /></div>
      </div>
      <div class="inline-actions" style="margin-bottom: 12px;">
        <input id="poProductPicker" class="form-control" list="poProductOptions" placeholder="상품명 또는 바코드를 입력하고 Enter" style="flex: 1; min-width: 220px;"
          onkeydown="if (event.key === 'Enter') { event.preventDefault(); addEditorProduct(); }" onchange="addEditorProduct()" />
        <datalist id="poProductOptions">${choices.map((p) => `<option value="${h(productOptionLabel(p))}"></option>`).join('')}</datalist>
      </div>
      ${e.items.length === 0 ? renderEmpty('발주할 상품을 추가해 주세요.') : `
        <div class="table-wrap"><table>
          <thead><tr><th>상품</th><th>수량</th><th>매입 단가</th><th>금액</th><th></th></tr></thead>
          <tbody>
            ${e.items.map((item, idx) => `<tr>
              <td><div class="list-title">${h(item.product_name)}</div><div class="list-meta">${h(item.barcode || '')}</div></td>
              <td><input class="form-control mini-input" type="number" min="1" value="${item.quantity}" onchange="updateEditorItem(${idx}, 'quantity', this.value)" /></td>
              <td><input class="form-control mini-input" style="width: 100px;" type="number" min="0" value="${item.unit_cost}" onchange="updateEditorItem(${idx}, 'unit_cost', this.value)" /></td>
              <td>${money(item.quantity * item.unit_cost)}</td>
              <td><button class="muted-link" type="button" onclick="po.editor.items.splice(${idx}, 1); renderPurchasing()">삭제</button></td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
      <div class="inline-actions" style="justify-content: space-between; margin-top: 12px;">
        <strong>합계 ${money(total)}</strong>
        <button class="btn btn-primary" type="button" onclick="savePurchaseOrder()">${e.id ? '수정 저장' : '발주서 저장 (작성 중)'}</button>
      </div>
    </div>
  `;
}

function addEditorProduct() {
  const input = $('#poProductPicker');
  const value = input.value.trim();
  if (!value) return;
  const product = allProducts.find((p) => p.status !== 'HIDDEN' && (productOptionLabel(p) === value || p.barcode === value));
  if (!product) return showToast('목록에서 상품을 선택하거나 바코드를 정확히 입력해 주세요.');
  if (po.editor.items.some((i) => i.product_id === product.id)) return showToast('이미 추가된 상품입니다.');
  const target = product.safety_stock > 0 ? Math.max(1, product.safety_stock * 2 - product.stock_quantity) : 10;
  po.editor.items.push({ product_id: product.id, product_name: product.product_name, barcode: product.barcode, quantity: target, unit_cost: product.cost_price || 0 });
  if (!po.editor.supplier_id && product.supplier_id && activeSuppliers().some((s) => s.id === product.supplier_id)) {
    po.editor.supplier_id = product.supplier_id;
  }
  renderPurchasing();
  setTimeout(() => $('#poProductPicker')?.focus(), 20);
}

function updateEditorItem(idx, key, value) {
  po.editor.items[idx][key] = Math.max(key === 'quantity' ? 1 : 0, Math.floor(Number(value) || 0));
  renderPurchasing();
}

async function savePurchaseOrder() {
  const e = po.editor;
  if (!e.supplier_id) return showToast('거래처를 선택해 주세요.');
  const body = {
    supplier_id: Number(e.supplier_id),
    memo: e.memo,
    expected_date: e.expected_date,
    items: e.items.map((i) => ({ product_id: i.product_id, quantity: Number(i.quantity), unit_cost: Number(i.unit_cost) }))
  };
  try {
    po.detail = await api.request(e.id ? `/purchasing/orders/${e.id}` : '/purchasing/orders', { method: e.id ? 'PATCH' : 'POST', body });
    po.editor = null;
    showToast(`${po.detail.order.po_number} 발주서를 저장했습니다. 내용을 확인하고 발주 확정해 주세요.`);
    await loadPurchasing();
  } catch (error) {
    showToast(error.message);
  }
}

/* 발주 추천 */

function renderSuggestTab() {
  if (po.suggestions.length === 0) {
    return renderEmpty('재고가 안전재고 이하이거나 품절인 상품이 없습니다. 안전재고는 POS 재고 처리 화면에서 상품별로 정할 수 있습니다.');
  }
  const noSupplier = activeSuppliers().length === 0;
  return `
    <p class="list-meta" style="margin: 0 0 12px;">${h(po.rule)}</p>
    ${noSupplier ? '<p class="notice show" style="position: static; margin-bottom: 12px;">등록된 거래처가 없습니다. 거래처 탭에서 먼저 거래처를 추가해 주세요.</p>' : ''}
    <div class="table-wrap"><table>
      <thead><tr><th><input type="checkbox" checked onchange="document.querySelectorAll('[data-sug-check]').forEach((c) => (c.checked = this.checked))" /></th>
        <th>상품</th><th>재고 / 안전재고</th><th>진행 중 발주</th><th>거래처</th><th>발주 수량</th><th>매입 단가</th></tr></thead>
      <tbody>
        ${po.suggestions.map((s) => `<tr>
          <td><input type="checkbox" checked data-sug-check="${s.product_id}" /></td>
          <td><div class="list-title">${h(s.product_name)}</div><div class="list-meta">${h(s.barcode || '')}${s.product_type && s.product_type !== 'GENERAL' ? ` · ${PRODUCT_TYPE_LABELS[s.product_type] || s.product_type}` : ''}</div></td>
          <td>${s.stock_quantity <= 0 ? '<span class="badge red">품절</span>' : s.stock_quantity} / ${s.safety_stock || '-'}</td>
          <td>${s.incoming ? `${s.incoming}개` : '-'}</td>
          <td><select class="form-control" style="padding: 7px 8px; min-width: 130px;" data-sug-supplier="${s.product_id}">${supplierOptions(s.supplier_id)}</select></td>
          <td><input class="form-control mini-input" type="number" min="1" value="${s.suggested_quantity}" data-sug-qty="${s.product_id}" /></td>
          <td><input class="form-control mini-input" style="width: 100px;" type="number" min="0" value="${s.unit_cost}" data-sug-cost="${s.product_id}" /></td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <div class="inline-actions" style="justify-content: flex-end; margin-top: 12px;">
      <button class="btn btn-outline" type="button" onclick="autoPurchaseOrders()" ${noSupplier ? 'disabled' : ''}>기본 거래처로 자동 작성</button>
      <button class="btn btn-primary" type="button" onclick="createFromSuggestions()" ${noSupplier ? 'disabled' : ''}>선택 상품 발주서 작성</button>
    </div>
    <p class="list-meta" style="margin: 8px 0 0;">거래처별로 발주서가 나뉘어 '작성 중'으로 저장됩니다. 내용을 확인한 뒤 발주 확정해 주세요.</p>
  `;
}

async function createFromSuggestions() {
  const groups = new Map();
  for (const check of document.querySelectorAll('[data-sug-check]:checked')) {
    const id = check.dataset.sugCheck;
    const supplierId = document.querySelector(`[data-sug-supplier="${id}"]`).value;
    const name = po.suggestions.find((s) => String(s.product_id) === id)?.product_name;
    if (!supplierId) return showToast(`${name}의 거래처를 선택해 주세요.`);
    if (!groups.has(supplierId)) groups.set(supplierId, []);
    groups.get(supplierId).push({
      product_id: Number(id),
      quantity: Number(document.querySelector(`[data-sug-qty="${id}"]`).value),
      unit_cost: Number(document.querySelector(`[data-sug-cost="${id}"]`).value || 0)
    });
  }
  if (groups.size === 0) return showToast('발주할 상품을 선택해 주세요.');
  const created = [];
  try {
    for (const [supplierId, items] of groups) {
      const data = await api.request('/purchasing/orders', { method: 'POST', body: { supplier_id: Number(supplierId), items } });
      created.push(data.order.po_number);
    }
    showToast(`발주서 ${created.length}장을 작성했습니다. (${created.join(', ')})`);
  } catch (error) {
    showToast(created.length ? `${created.length}장 작성 후 오류: ${error.message}` : error.message);
  }
  po.detail = null;
  po.filter = 'OPEN';
  setPoTab('orders');
  await loadPurchasing();
}

async function autoPurchaseOrders() {
  if (!confirm('기본 거래처가 정해진 부족 상품으로 거래처별 발주서를 자동 작성할까요?')) return;
  try {
    const data = await api.request('/purchasing/orders/auto', { method: 'POST' });
    const skipped = data.skipped_without_supplier ? ` 거래처가 없는 ${data.skipped_without_supplier}개 상품은 제외했습니다.` : '';
    showToast(`발주서 ${data.orders.length}장을 작성했습니다.${skipped}`);
    po.detail = null;
    po.filter = 'OPEN';
    setPoTab('orders');
    await loadPurchasing();
  } catch (error) {
    showToast(error.message);
  }
}

/* 거래처 */

function renderSuppliersTab() {
  const f = po.supplierForm;
  const form = f ? `
    <form class="form-grid po-detail" style="margin: 0 0 16px;" onsubmit="saveSupplier(event)">
      <div class="form-group"><label class="form-label">거래처 이름</label><input class="form-control" name="name" required maxlength="60" value="${h(f.name || '')}" placeholder="예: 한국의약품도매" /></div>
      <div class="form-group"><label class="form-label">사업자등록번호</label><input class="form-control" name="business_number" value="${h(f.business_number || '')}" placeholder="000-00-00000 (선택)" /></div>
      <div class="form-group"><label class="form-label">담당자</label><input class="form-control" name="contact_name" maxlength="40" value="${h(f.contact_name || '')}" placeholder="선택" /></div>
      <div class="form-group"><label class="form-label">연락처</label><input class="form-control" name="phone" maxlength="20" value="${h(f.phone || '')}" placeholder="선택" /></div>
      <div class="form-group"><label class="form-label">이메일</label><input class="form-control" name="email" type="email" maxlength="100" value="${h(f.email || '')}" placeholder="발주서 전달용 (선택)" /></div>
      <div class="form-group"><label class="form-label">메모</label><input class="form-control" name="memo" maxlength="200" value="${h(f.memo || '')}" placeholder="배송 요일, 최소 주문 금액 등" /></div>
      <div class="form-group full inline-actions">
        <button class="btn btn-primary" type="submit">${f.id ? '수정 저장' : '거래처 등록'}</button>
        <button class="btn btn-outline" type="button" onclick="po.supplierForm = null; renderPurchasing()">취소</button>
      </div>
    </form>` : '';
  const list = po.suppliers.length === 0
    ? renderEmpty('등록된 거래처가 없습니다. 도매상·제약사 거래처를 추가해 주세요.')
    : `<div class="table-wrap"><table>
        <thead><tr><th>거래처</th><th>담당 · 연락처</th><th>기본 상품</th><th>진행 발주</th><th>최근 발주</th><th>상태</th><th>관리</th></tr></thead>
        <tbody>
          ${po.suppliers.map((s) => `<tr>
            <td><div class="list-title">${h(s.name)}</div><div class="list-meta">${h(s.business_number || '')}${s.memo ? ` · ${h(s.memo)}` : ''}</div></td>
            <td>${h(s.contact_name || '-')}<div class="list-meta">${h([s.phone, s.email].filter(Boolean).join(' · '))}</div></td>
            <td>${s.product_count}개</td>
            <td>${s.open_order_count ? `${s.open_order_count}건` : '-'}</td>
            <td class="list-meta">${h(formatDate(s.last_ordered_at))}</td>
            <td>${s.status === 'ACTIVE' ? '<span class="badge green">거래 중</span>' : '<span class="badge gray">거래 중지</span>'}</td>
            <td><div class="inline-actions">
              <button class="btn btn-outline btn-sm" type="button" onclick="editSupplier(${s.id})">수정</button>
              ${s.status === 'ACTIVE'
                ? `<button class="btn btn-danger btn-sm" type="button" onclick="setSupplierStatus(${s.id}, 'INACTIVE')">거래 중지</button>`
                : `<button class="btn btn-primary btn-sm" type="button" onclick="setSupplierStatus(${s.id}, 'ACTIVE')">거래 재개</button>`}
            </div></td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;
  return `
    <div class="inline-actions" style="justify-content: space-between; margin-bottom: 12px;">
      <p class="list-meta" style="margin: 0;">상품을 처음 발주한 거래처가 그 상품의 기본 거래처로 저장되어 자동 발주에 쓰입니다.</p>
      ${f ? '' : '<button class="btn btn-primary btn-sm" type="button" onclick="po.supplierForm = {}; renderPurchasing()">+ 거래처 추가</button>'}
    </div>
    ${form}
    ${list}
  `;
}

function editSupplier(id) {
  po.supplierForm = { ...po.suppliers.find((s) => s.id === id) };
  renderPurchasing();
}

async function saveSupplier(event) {
  event.preventDefault();
  const body = serializeForm(event.target);
  const id = po.supplierForm?.id;
  try {
    const data = await api.request(id ? `/purchasing/suppliers/${id}` : '/purchasing/suppliers', { method: id ? 'PATCH' : 'POST', body });
    po.supplierForm = null;
    showToast(`${data.supplier.name} 거래처를 ${id ? '수정' : '등록'}했습니다.`);
    await loadPurchasing();
  } catch (error) {
    showToast(error.message);
  }
}

async function setSupplierStatus(id, status) {
  const supplier = po.suppliers.find((s) => s.id === id);
  if (status === 'INACTIVE' && !confirm(`${supplier.name} 거래처와 거래를 중지할까요? 새 발주서를 작성할 수 없게 됩니다.`)) return;
  try {
    await api.request(`/purchasing/suppliers/${id}`, { method: 'PATCH', body: { status } });
    showToast(status === 'ACTIVE' ? '거래를 재개했습니다.' : '거래를 중지했습니다.');
    await loadPurchasing();
  } catch (error) {
    showToast(error.message);
  }
}
