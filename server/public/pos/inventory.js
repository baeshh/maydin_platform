// MAYDIN POS · 재고 처리
/* ---------- 재고 처리 ---------- */

async function openInventory(filter = state.inventory.filter, selectId = state.inventory.selectedId) {
  state.inventory.filter = filter;
  openModal(
    `
    ${modalHead('재고 처리 · 입고 · 폐기 · 실사')}
    <div class="modal-body">
      <div style="display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 20px;">
        <div>
          <div class="inline-scan" style="margin-bottom: 10px;">
            <input id="invQuery" class="input" placeholder="바코드 스캔 또는 상품명 (스캔하면 바로 입고 준비)" data-autofocus autocomplete="off" />
            <button class="cam-btn" type="button" onclick="scanInventoryWithCamera()">카메라</button>
          </div>
          <div class="chips" id="invFilters" style="margin-bottom: 10px;"></div>
          <div id="invList" style="max-height: 58vh; overflow-y: auto;"><div class="muted">불러오는 중…</div></div>
        </div>
        <div id="invDetail"><div class="notice">왼쪽에서 상품을 선택하거나 바코드를 스캔하세요.<br />입고는 직원도, 폐기·실사 조정·안전재고 설정은 관리자만 할 수 있습니다.</div></div>
      </div>
    </div>
  `,
    { size: 'xwide' }
  );
  const input = document.getElementById('invQuery');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(loadInventory, 200);
  });
  input.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    await inventoryScan(input.value.trim());
  });
  await loadInventory();
  if (selectId) selectInventoryProduct(selectId);
}

async function inventoryScan(code) {
  if (!code) return;
  const input = document.getElementById('invQuery');
  const data = await loadInventory(code);
  if (!data) return;
  const target = data.exact_match_id || (data.products.length === 1 ? data.products[0].id : null);
  if (target) {
    if (input) input.value = '';
    await loadInventory('');
    state.inventory.adjustType = 'RECEIVE';
    selectInventoryProduct(target, { focusQty: true });
  } else if (data.products.length === 0 && /^[0-9A-Za-z-]{4,64}$/.test(code) && can('can_register_product')) {
    if (confirm(`${code}은(는) 등록되지 않은 바코드입니다. 지금 상품으로 등록할까요?`)) {
      openUnknownBarcode(code, {
        onDone: (product) => {
          state.inventory.adjustType = 'RECEIVE';
          openInventory('all', product.id);
        }
      });
    }
  } else if (data.products.length === 0) {
    toast('일치하는 상품이 없습니다.', 'error');
  }
}

function scanInventoryWithCamera() {
  ScanKit.openCameraScanner({ title: '입고 상품 스캔', onResult: (code) => inventoryScan(code) });
}

async function loadInventory(queryOverride) {
  const input = document.getElementById('invQuery');
  const query = queryOverride ?? input?.value.trim() ?? '';
  try {
    const data = await api.request(`/pos/inventory?filter=${state.inventory.filter}&query=${encodeURIComponent(query)}`);
    cacheProducts(data.products);
    window.__inventory = data.products;
    setBadge('stockAlertCount', stockAlertTotal(data.alerts));
    const filters = document.getElementById('invFilters');
    if (filters) {
      filters.innerHTML = [
        ['all', '전체'],
        ['low', `부족 · 품절 ${data.alerts.low_count}`],
        ['out', `품절 ${data.alerts.out_count}`],
        ['expiring', `유통기한 임박 ${data.alerts.expiring_count}`],
        ['expired', `기한 경과 ${data.alerts.expired_count}`]
      ]
        .map(([key, label]) => `<button class="chip ${state.inventory.filter === key ? 'active' : ''}" type="button" onclick="setInventoryFilter('${key}')">${label}</button>`)
        .join('');
    }
    const box = document.getElementById('invList');
    if (!box) return data;
    box.innerHTML = data.products.length
      ? `<table>
          <thead><tr><th>상품</th><th class="num">재고</th><th class="num">안전재고</th><th>상태</th></tr></thead>
          <tbody>${data.products
            .map(
              (p) => `
              <tr class="clickable" onclick="selectInventoryProduct(${p.id})" style="${state.inventory.selectedId === p.id ? 'background: var(--blue-soft);' : ''}">
                <td><div style="font-weight: 700;">${h(p.product_name)} ${typeBadge(p)}</div><div class="muted" style="font-size: 12px;">${p.barcode ? h(p.barcode) : '바코드 없음'}${p.nearest_expiry ? ` · ${expiryBadge(p.nearest_expiry, data.alerts.expiry_alert_days)}` : ''}</div></td>
                <td class="num" style="font-weight: 900; ${p.is_low ? 'color: var(--danger);' : ''}">${p.stock_quantity}</td>
                <td class="num">${p.safety_stock || '-'}</td>
                <td>${p.stock_quantity <= 0 ? '<span class="badge red">품절</span>' : p.has_expired ? '<span class="badge red">기한 경과</span>' : p.is_low ? '<span class="badge orange">부족</span>' : '<span class="badge green">정상</span>'}</td>
              </tr>`
            )
            .join('')}</tbody>
        </table>`
      : '<div class="empty">상품이 없습니다.</div>';
    return data;
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

function setInventoryFilter(filter) {
  state.inventory.filter = filter;
  loadInventory();
}

async function selectInventoryProduct(id, { focusQty = false } = {}) {
  state.inventory.selectedId = id;
  loadInventory();
  try {
    const data = await api.request(`/pos/inventory/products/${id}/logs`);
    renderInventoryDetail(data.product, data.logs, data.lots || [], data.expiry_alert_days);
    if (focusQty) setTimeout(() => document.getElementById('adjQty')?.focus(), 30);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function lotsSectionHtml(product, lots, alertDays, adjustAllowed) {
  const tracked = lots.reduce((sum, lot) => sum + lot.remaining_quantity, 0);
  const untracked = product.stock_quantity - tracked;
  return `
    <div class="section-title">유통기한 · 로트</div>
    ${lots.length
      ? `<table><thead><tr><th>로트</th><th>유통기한</th><th class="num">남은 수량</th>${adjustAllowed ? '<th></th>' : ''}</tr></thead><tbody>${lots
          .map(
            (lot) => `<tr><td>${h(lot.lot_number || '-')}<div class="muted" style="font-size: 12px;">입고 ${fmtDateTime(lot.created_at).slice(0, 12)} · ${lot.received_quantity}개</div></td><td>${expiryBadge(lot.expiry_date, alertDays)}</td><td class="num" style="font-weight: 800;">${lot.remaining_quantity}</td>${adjustAllowed ? `<td><button class="btn btn-outline btn-sm" type="button" onclick="disposeLot(${product.id}, ${lot.id})">폐기</button></td>` : ''}</tr>`
          )
          .join('')}</tbody></table>`
      : '<div class="muted" style="font-size: 13px;">등록된 로트가 없습니다. 입고할 때 유통기한을 입력하면 임박·경과 알림을 받을 수 있습니다.</div>'}
    ${untracked > 0 && lots.length ? `<div class="muted" style="font-size: 12px; margin-top: 6px;">유통기한 미등록 재고 ${untracked}개 (판매 시 먼저 차감)</div>` : ''}
  `;
}

function disposeLot(productId, lotId) {
  state.inventory.adjustType = 'DISPOSE';
  state.inventory.disposeLotId = lotId;
  selectInventoryProduct(productId, { focusQty: true });
}

function renderInventoryDetail(product, logs, lots = [], alertDays = 90) {
  const box = document.getElementById('invDetail');
  if (!box) return;
  const adjustAllowed = can('can_adjust_stock');
  if (!adjustAllowed) state.inventory.adjustType = 'RECEIVE';
  const type = state.inventory.adjustType;
  const typeInfo = {
    RECEIVE: { qtyLabel: '입고 수량', reasons: ['정기 입고', '도매상 입고', '반품 재입고', '이동 입고'], button: '입고 처리' },
    DISPOSE: { qtyLabel: '폐기 수량', reasons: ['유통기한 경과', '파손', '변질', '분실'], button: '폐기 처리' },
    COUNT: { qtyLabel: '실제 센 수량', reasons: ['정기 실사', '전산 오류 정정', '분실 확인'], button: '실사 반영' }
  }[type];
  box.innerHTML = `
    <div class="section-title" style="margin-top: 0;">${h(product.product_name)}</div>
    <div class="muted" style="font-size: 13px; font-weight: 600; margin-bottom: 10px;">${product.barcode ? `바코드 ${h(product.barcode)}` : '바코드 없음'} · ${won(product.sale_price)}</div>
    <div style="display: flex; gap: 12px; margin-bottom: 14px;">
      <div class="metric" style="flex: 1;"><span>현재 재고</span><strong class="stock-big" style="${product.stock_quantity <= Math.max(product.safety_stock || 0, 0) ? 'color: var(--danger);' : ''}">${product.stock_quantity}</strong></div>
      <div class="metric" style="flex: 1;"><span>안전재고</span>
        ${adjustAllowed
          ? `<div style="display: flex; gap: 6px; margin-top: 6px;"><input id="safetyInput" class="input" type="number" min="0" value="${product.safety_stock || 0}" style="padding: 8px 10px;" /><button class="btn btn-outline btn-sm" type="button" onclick="saveSafetyStock(${product.id})">저장</button></div>`
          : `<strong>${product.safety_stock || 0}</strong>`}
      </div>
    </div>
    <div class="seg">
      <button type="button" class="${type === 'RECEIVE' ? 'active' : ''}" onclick="setAdjustType('RECEIVE', ${product.id})">입고</button>
      <button type="button" class="${type === 'DISPOSE' ? 'active' : ''}" onclick="setAdjustType('DISPOSE', ${product.id})" ${adjustAllowed ? '' : 'disabled title="관리자 전용"'}>폐기</button>
      <button type="button" class="${type === 'COUNT' ? 'active' : ''}" onclick="setAdjustType('COUNT', ${product.id})" ${adjustAllowed ? '' : 'disabled title="관리자 전용"'}>실사 조정</button>
    </div>
    <div class="pay-row-grid">
      <div class="field"><label class="label" for="adjQty">${typeInfo.qtyLabel}</label><input id="adjQty" class="input big" type="number" min="0" value="${type === 'COUNT' ? product.stock_quantity : ''}" oninput="previewAdjust(${product.stock_quantity})" onkeydown="if (event.key === 'Enter') submitAdjust(${product.id})" /></div>
      <div class="field"><label class="label">처리 후 재고</label><div class="input big" id="adjPreview" style="background: var(--bg-canvas);">${product.stock_quantity}</div></div>
    </div>
    ${type === 'RECEIVE'
      ? `<div class="pay-row-grid">
          <div class="field"><label class="label" for="adjExpiry">유통기한 (권장)</label><input id="adjExpiry" class="input" type="date" min="${h(state.ctx.today)}" /></div>
          <div class="field"><label class="label" for="adjLot">로트번호 (선택)</label><input id="adjLot" class="input" maxlength="40" placeholder="제조번호" /></div>
        </div>`
      : ''}
    ${type === 'DISPOSE' && lots.length
      ? `<div class="field"><label class="label" for="adjLotId">폐기할 로트</label><select id="adjLotId" class="input">
          <option value="">로트 지정 안 함 (미등록 재고부터)</option>
          ${lots.map((lot) => `<option value="${lot.id}" ${state.inventory.disposeLotId === lot.id ? 'selected' : ''}>${h(lot.lot_number || '로트번호 없음')} · ${h(lot.expiry_date)}${lot.days_left < 0 ? ' (경과)' : ''} · 남은 ${lot.remaining_quantity}개</option>`).join('')}
        </select></div>`
      : ''}
    <div class="field"><label class="label" for="adjReason">사유${type === 'RECEIVE' ? ' (선택)' : ' (필수)'}</label><input id="adjReason" class="input" value="${type === 'DISPOSE' && lots.find((lot) => lot.id === state.inventory.disposeLotId)?.days_left < 0 ? '유통기한 경과' : ''}" /></div>
    ${reasonChips('adjReason', typeInfo.reasons)}
    <button class="btn ${type === 'DISPOSE' ? 'btn-danger' : 'btn-primary'} btn-block btn-lg" type="button" onclick="submitAdjust(${product.id})">${typeInfo.button}</button>
    ${lotsSectionHtml(product, lots, alertDays, adjustAllowed)}
    <div class="section-title">재고 변동 이력</div>
    <div style="max-height: 26vh; overflow-y: auto;">
      ${logs.length
        ? logs
            .map((l) => {
              const diff = l.quantity_after - l.quantity_before;
              return `<div class="kv" style="font-size: 13px;"><span>${fmtDateTime(l.created_at)} · <b>${STOCK_LOG_LABELS[l.change_type] || h(l.change_type)}</b> · ${h(l.reason || '')} <span class="muted">${h(l.created_by_name || '')}</span></span><span style="white-space: nowrap; ${diff < 0 ? 'color: var(--danger);' : diff > 0 ? 'color: var(--success);' : ''}">${diff > 0 ? '+' : ''}${diff} → ${l.quantity_after}</span></div>`;
            })
            .join('')
        : '<div class="muted">이력이 없습니다.</div>'}
    </div>
  `;
  previewAdjust(product.stock_quantity);
}

function setAdjustType(type, productId) {
  state.inventory.adjustType = type;
  state.inventory.disposeLotId = null;
  selectInventoryProduct(productId, { focusQty: true });
}

function previewAdjust(current) {
  const input = document.getElementById('adjQty');
  const preview = document.getElementById('adjPreview');
  if (!input || !preview) return;
  const qty = Number(input.value || 0);
  const type = state.inventory.adjustType;
  const next = type === 'RECEIVE' ? current + qty : type === 'DISPOSE' ? current - qty : qty;
  preview.textContent = `${next}${next !== current ? ` (${next - current > 0 ? '+' : ''}${next - current})` : ''}`;
  preview.style.color = next < 0 ? 'var(--danger)' : '';
}

function submitAdjust(productId) {
  withBusy(async () => {
    const quantity = document.getElementById('adjQty').value;
    if (quantity === '') throw new Error('수량을 입력해 주세요.');
    const data = await api.request('/pos/inventory/adjust', {
      method: 'POST',
      body: {
        product_id: productId,
        adjust_type: state.inventory.adjustType,
        quantity: Number(quantity),
        reason: document.getElementById('adjReason').value.trim(),
        expiry_date: document.getElementById('adjExpiry')?.value || undefined,
        lot_number: document.getElementById('adjLot')?.value.trim() || undefined,
        lot_id: Number(document.getElementById('adjLotId')?.value) || undefined
      }
    });
    state.inventory.disposeLotId = null;
    toast(`${data.product.product_name} 재고 ${data.product.stock_quantity}개로 반영`);
    setBadge('stockAlertCount', stockAlertTotal(data.alerts));
    loadProducts();
    await selectInventoryProduct(productId);
    document.getElementById('invQuery')?.focus();
  });
}

function saveSafetyStock(productId) {
  withBusy(async () => {
    const value = Number(document.getElementById('safetyInput').value);
    const data = await api.request(`/pos/inventory/products/${productId}/safety-stock`, { method: 'PATCH', body: { safety_stock: value } });
    toast(`안전재고 ${data.product.safety_stock}개로 설정`);
    setBadge('stockAlertCount', stockAlertTotal(data.alerts));
    await selectInventoryProduct(productId);
  });
}
