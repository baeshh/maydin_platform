// MAYDIN 파트너센터 · 상품 관리
const PRODUCT_PAGE_SIZE = 10;
const productState = { all: [], source: [], query: '', page: 1, filter: 'all' };
const PRODUCT_TYPE_LABELS = { GENERAL: '일반 상품', OTC: '일반의약품', ETC: '전문의약품', UNCLASSIFIED: '분류 전' };
const PRODUCT_TYPE_BADGES = {
  OTC: '<span class="badge orange">일반의약품 · 현장 판매 전용</span>',
  ETC: '<span class="badge red">전문의약품 · 판매 불가</span>',
  UNCLASSIFIED: '<span class="badge orange">분류 전 · 온라인 판매 불가</span>'
};
// 자동으로 맞춘 성분(식약처)이나 사진을 약사가 아직 승인하지 않은 상품. 승인 전에는 고객 화면에 보이지 않는다.
const mfdsPending = (p) => Boolean(p.mfds_report_no) && !p.mfds_verified_at;
const isUnverified = (p) => p.status !== 'HIDDEN' && (mfdsPending(p) || Number(p.photo_pending) > 0);
const PRODUCT_FILTERS = {
  all: { label: '전체', match: () => true },
  unverified: { label: '미검증', match: isUnverified },
  unclassified: { label: '분류 전', match: (p) => p.status !== 'HIDDEN' && p.product_type === 'UNCLASSIFIED' },
  offline: { label: '온라인 판매 꺼짐', match: (p) => p.status !== 'HIDDEN' && p.product_type === 'GENERAL' && !Number(p.online_visible) },
  posOff: { label: 'POS 판매 중지', match: (p) => p.status !== 'HIDDEN' && p.product_type !== 'ETC' && !Number(p.pos_sale_enabled ?? 1) }
};

function syncProductFormChannels() {
  const type = $('#productType').value;
  const online = $('#productOnlineSale');
  online.disabled = type !== 'GENERAL';
  online.checked = type === 'GENERAL';
  $('#productPosSale').disabled = type === 'ETC';
  $('#productChannelHint').textContent = {
    GENERAL: '온라인몰과 POS에서 모두 팔 수 있습니다. 필요 없는 채널은 꺼 두세요.',
    OTC: '일반의약품은 온라인에서 팔 수 없고, POS에서는 약사(관리자) 계정으로만 판매합니다.',
    ETC: '전문의약품은 MAYDIN에서 판매하지 않습니다. 재고 기록용으로만 등록됩니다.',
    UNCLASSIFIED: '분류 전 상품은 온라인에서 팔 수 없고, POS에서는 약사(관리자) 계정으로만 판매합니다.'
  }[type] || '일반 상품으로 분류해야 온라인몰에서 팔 수 있습니다.';
}

function syncRowChannels(id) {
  const type = $(`#type-${id}`).value;
  const online = $(`#online-${id}`);
  online.disabled = type !== 'GENERAL';
  if (type !== 'GENERAL') online.checked = false;
  $(`#pos-${id}`).disabled = type === 'ETC';
}

function renderProducts(products) {
  productState.source = products;
  applyProductFilter();
}

function applyProductFilter() {
  productState.all = productState.source.filter(PRODUCT_FILTERS[productState.filter].match);
  renderProductPage();
}

function showProductFilter(filter) {
  productState.filter = filter;
  productState.page = 1;
  applyProductFilter();
  $('#products').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function setProductsOnline(ids, visible) {
  if (!ids.length) return;
  if (visible && !confirm(`${ids.length.toLocaleString()}개 상품의 온라인 판매를 켤까요? 가격·구분·설명을 확인한 뒤 켜 주세요.`)) return;
  try {
    const { updated, skipped } = await api.request('/products/bulk-visibility', { method: 'POST', body: { ids, online_visible: visible } });
    if (visible && productState.filter === 'offline') productState.filter = 'all';
    showToast(
      `${updated.toLocaleString()}개 상품의 온라인 판매를 ${visible ? '켰습니다' : '껐습니다'}.${skipped ? ` 일반 상품이 아닌 ${skipped.toLocaleString()}개는 건너뛰었습니다.` : ''}`
    );
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

function publishFilteredProducts() {
  const { items } = paginate(productState, productMatches, PRODUCT_PAGE_SIZE);
  setProductsOnline(items.filter((p) => p.product_type === 'GENERAL').map((p) => p.id), true);
}

async function classifyFilteredProducts() {
  const type = $('#bulkProductType').value;
  if (!type) return showToast('바꿀 구분을 골라 주세요.');
  const { items } = paginate(productState, productMatches, PRODUCT_PAGE_SIZE);
  if (!items.length) return;
  const warning = type === 'GENERAL' ? ' 일반의약품·전문의약품이 섞여 있지 않은지 꼭 확인해 주세요.' : '';
  if (!confirm(`${items.length.toLocaleString()}개 상품을 "${PRODUCT_TYPE_LABELS[type]}"(으)로 분류할까요?${warning} 온라인 판매는 분류한 뒤 따로 켭니다.`)) return;
  try {
    const { updated } = await api.request('/products/bulk-type', { method: 'POST', body: { ids: items.map((p) => p.id), product_type: type } });
    // 일반 상품은 이어서 온라인 판매를 켜야 고객 몰에 보이므로 그 목록으로 넘어간다.
    if (type === 'GENERAL') productState.filter = 'offline';
    showToast(`${updated.toLocaleString()}개 상품을 ${PRODUCT_TYPE_LABELS[type]}(으)로 분류했습니다.${type === 'GENERAL' ? ' 이제 온라인 판매를 켜면 고객 몰에 보입니다.' : ''}`);
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

function productMatches(p, q) {
  return [p.product_name, p.category_name, p.brand, p.barcode, p.external_code].some((value) => String(value || '').toLowerCase().includes(q));
}

function verificationLine(p) {
  const ingredients = !p.mfds_report_no ? '성분 없음' : p.mfds_verified_at ? '성분 검증됨' : '<b class="text-warn">성분 미검증</b>';
  const verified = Number(p.photo_verified || 0);
  const pending = Number(p.photo_pending || 0);
  const photos = [verified && `사진 ${verified}장`, pending && `<b class="text-warn">사진 미검증 ${pending}장</b>`].filter(Boolean).join(' · ') || '사진 없음';
  return `${ingredients} · ${photos}`;
}

const isMallVisible = (p) => p.product_type === 'GENERAL' && Number(p.online_visible) === 1 && p.status !== 'HIDDEN';

// 고객 몰에는 "일반 상품 + 온라인 판매 켬"만 보인다. 몇 개가 왜 안 보이는지 상품 목록 위에 늘 보여 준다.
function renderMallVisibility() {
  const live = productState.source.filter((p) => p.status !== 'HIDDEN');
  if (!live.length) return '';
  const count = (match) => live.filter(match).length;
  const visible = count(isMallVisible);
  const unclassified = count((p) => p.product_type === 'UNCLASSIFIED');
  const offline = count((p) => p.product_type === 'GENERAL' && !Number(p.online_visible));
  const otc = count((p) => p.product_type === 'OTC');
  const etc = count((p) => p.product_type === 'ETC');
  const reasons = [
    unclassified && `<span>분류 전 <b>${unclassified.toLocaleString()}개</b> <button class="btn btn-outline btn-sm" type="button" onclick="showProductFilter('unclassified')">분류하기</button></span>`,
    offline && `<span>일반 상품이지만 온라인 판매 꺼짐 <b>${offline.toLocaleString()}개</b> <button class="btn btn-outline btn-sm" type="button" onclick="showProductFilter('offline')">켜기</button></span>`,
    otc && `<span>일반의약품 <b>${otc.toLocaleString()}개</b> · 온라인 판매 불가(매장 판매만)</span>`,
    etc && `<span>전문의약품 <b>${etc.toLocaleString()}개</b> · 판매 불가</span>`
  ].filter(Boolean);
  const unverified = count(isUnverified);
  const missing = count((p) => p.product_type === 'GENERAL' && ((!p.mfds_report_no && p.mfds_link_source !== 'REMOVED') || !(Number(p.photo_verified) + Number(p.photo_pending))));
  if (unverified) {
    reasons.push(
      `<span>미검증 제품 <b>${unverified.toLocaleString()}개</b> · 자동으로 붙은 사진은 바로 보이고, 성분 정보는 약사가 승인해야 보여요 <button class="btn btn-primary btn-sm" type="button" onclick="showProductFilter('unverified')">미검증만 보기</button></span>`
    );
  }
  if (missing) {
    reasons.push(
      `<span>성분 정보나 사진이 없는 일반 상품 <b>${missing.toLocaleString()}개</b> <button class="btn btn-outline btn-sm" type="button" onclick="autoMatchProducts(this)">제조사·제품명으로 자동 매칭</button></span>`
    );
  }
  const preview = window.ownerPharmacyCode
    ? `<a class="btn btn-outline btn-sm" href="/store.html?pharmacyCode=${encodeURIComponent(window.ownerPharmacyCode)}" target="_blank" rel="noopener">고객 몰 미리보기</a>`
    : '';
  return `<div class="mall-visibility ${visible ? '' : 'is-empty'}">
    <div class="mall-visibility-head"><strong>고객 몰에 보이는 상품 ${visible.toLocaleString()}개</strong>${live.length > visible ? ` <span class="list-meta">· 안 보이는 상품 ${(live.length - visible).toLocaleString()}개</span>` : ''}<span style="flex: 1;"></span>${preview}</div>
    ${reasons.length ? `<div class="mall-visibility-reasons">${reasons.join('')}</div>` : ''}
    ${visible ? '' : '<p class="list-meta">고객 몰이 비어 있습니다. 건강기능식품·웰니스 제품은 "일반 상품"으로 분류하고 온라인 판매를 켜 주세요.</p>'}
  </div>`;
}

function renderProductFilters() {
  const counts = Object.fromEntries(Object.entries(PRODUCT_FILTERS).map(([key, f]) => [key, productState.source.filter(f.match).length]));
  const chips = Object.entries(PRODUCT_FILTERS)
    .filter(([key]) => key === 'all' || counts[key] || productState.filter === key)
    .map(([key, f]) => `<button class="tab-btn ${productState.filter === key ? 'active' : ''}" type="button" onclick="showProductFilter('${key}')">${f.label} ${counts[key].toLocaleString()}</button>`)
    .join('');
  const bulkActions = {
    unverified: '<span class="list-meta">상품마다 \'검증하기\'를 눌러 제조사·제품명·사진이 실제 상품과 같은지 확인한 뒤 승인해 주세요.</span>',
    offline: `<button class="btn btn-primary btn-sm" type="button" onclick="publishFilteredProducts()">이 목록 모두 온라인 판매 켜기</button>`,
    unclassified: `<span class="inline-actions">
        <select id="bulkProductType" class="form-control" style="width: 130px; padding: 7px 8px;">
          <option value="">구분 선택</option>
          <option value="GENERAL">일반 상품</option>
          <option value="OTC">일반의약품</option>
          <option value="ETC">전문의약품</option>
        </select>
        <button class="btn btn-primary btn-sm" type="button" onclick="classifyFilteredProducts()">이 목록 모두 분류</button>
      </span>`
  };
  const bulk = productState.all.length ? bulkActions[productState.filter] || '' : '';
  return `${renderMallVisibility()}<div class="tab-bar" style="align-items: center;">${chips}<span style="flex: 1;"></span>${bulk}</div>`;
}

function searchProducts(value) {
  productState.query = value.trim().toLowerCase();
  productState.page = 1;
  renderProductPage();
}

function goProductPage(page) {
  productState.page = page;
  renderProductPage();
  $('#products').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderProductPage() {
  const { all, query } = productState;
  const { items: products, totalPages, start, pageItems } = paginate(productState, productMatches, PRODUCT_PAGE_SIZE);
  const filters = renderProductFilters();
  const syncing = Boolean(window.posSyncEnabled);

  $('#productListCount').textContent = query
    ? `검색 결과 ${products.length.toLocaleString()}개 / 전체 ${all.length.toLocaleString()}개`
    : `전체 ${all.length.toLocaleString()}개`;
  if (productState.source.length === 0) {
    $('#productsTable').innerHTML = renderEmpty('등록된 상품이 없습니다. 첫 상품을 등록하거나 상품 일괄 등록으로 한 번에 넣어 보세요.');
    return;
  }
  if (products.length === 0) {
    $('#productsTable').innerHTML = filters + renderEmpty(query ? `'${query}'에 맞는 상품이 없습니다.` : '해당하는 상품이 없습니다.');
    return;
  }

  $('#productsTable').innerHTML = `
    ${filters}
    ${syncing ? '<p class="list-meta" style="margin-bottom: 8px;">기존 POS와 병행 중이라 재고는 기존 POS 파일로만 바뀝니다.</p>' : ''}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="row-no">번호</th>
            <th>상품명/카테고리</th>
            <th>가격/상태</th>
            <th>재고/상태수정</th>
            <th>관리</th>
          </tr>
        </thead>
        <tbody>
          ${pageItems.map((product, index) => `
            <tr>
              <td class="row-no">${start + index + 1}</td>
              <td>
                <div class="product-name-cell">
                  ${product.thumbnail_url ? `<img class="product-thumb" src="${h(product.thumbnail_url)}" alt="" loading="lazy" />` : '<span class="product-thumb empty">사진 없음</span>'}
                  <div class="list-title">${h(product.product_name)}</div>
                </div>
                ${product.brand ? `<div class="list-meta">${h(product.brand)}</div>` : ''}
                <span class="badge gray">${h(product.category_name || '미분류')}</span>
                ${PRODUCT_TYPE_BADGES[product.product_type] || ''}
                ${isUnverified(product) ? '<span class="badge orange">미검증 제품</span>' : ''}
                ${product.product_type === 'GENERAL' && !Number(product.online_visible) ? '<span class="badge gray">온라인 판매 꺼짐</span>' : ''}
                ${isMallVisible(product) ? '<span class="badge green">고객 몰에 보임</span>' : ''}
                ${product.product_type !== 'ETC' && !Number(product.pos_sale_enabled ?? 1) ? '<span class="badge gray">POS 판매 중지</span>' : ''}
                <div class="list-meta">${product.barcode ? `바코드 ${h(product.barcode)}` : '바코드 미등록'}${product.external_code ? ` · 기존 코드 ${h(product.external_code)}` : ''}</div>
              </td>
              <td>
                <div class="list-title">${money(product.discount_price || product.price)}</div>
                ${product.discount_price ? `<div class="list-meta">정가 ${money(product.price)}</div>` : ''}
                ${badge('productStatus', product.status)}
              </td>
              <td>
                <div class="inline-actions">
                  <input id="stock-${product.id}" class="form-control mini-input" type="number" min="0" value="${Number(product.stock_quantity || 0)}" ${syncing ? 'readonly title="기존 POS와 병행 중에는 기존 POS 파일로만 재고가 바뀝니다."' : ''} />
                  <select id="status-${product.id}" class="form-control" style="width: 118px; padding: 7px 8px;">
                    <option value="ON_SALE" ${product.status === 'ON_SALE' ? 'selected' : ''}>판매중</option>
                    <option value="SOLD_OUT" ${product.status === 'SOLD_OUT' ? 'selected' : ''}>품절</option>
                    <option value="STOPPED" ${product.status === 'STOPPED' ? 'selected' : ''}>판매중지</option>
                  </select>
                </div>
                <div class="inline-actions" style="margin-top: 6px;">
                  <input id="barcode-${product.id}" class="form-control barcode-input" style="width: 150px; padding: 7px 8px;" placeholder="바코드" value="${h(product.barcode || '')}" />
                  <select id="type-${product.id}" class="form-control" style="width: 118px; padding: 7px 8px;" onchange="syncRowChannels(${Number(product.id)})">
                    ${Object.entries(PRODUCT_TYPE_LABELS)
                      .map(([value, label]) => `<option value="${value}" ${product.product_type === value ? 'selected' : ''}>${label}</option>`)
                      .join('')}
                  </select>
                </div>
                <div class="inline-actions" style="margin-top: 6px;">
                  <input id="cost-${product.id}" class="form-control" style="width: 150px; padding: 7px 8px;" type="number" min="0" placeholder="매입 원가 (선택)" value="${product.cost_price ?? ''}" />
                  <select id="tax-${product.id}" class="form-control" style="width: 118px; padding: 7px 8px;">
                    <option value="TAXABLE" ${product.tax_type !== 'EXEMPT' ? 'selected' : ''}>과세</option>
                    <option value="EXEMPT" ${product.tax_type === 'EXEMPT' ? 'selected' : ''}>면세</option>
                  </select>
                </div>
                <div class="inline-actions" style="margin-top: 6px;">
                  <input id="brand-${product.id}" class="form-control" style="width: 150px; padding: 7px 8px;" maxlength="40" placeholder="브랜드 (선택)" value="${h(product.brand || '')}" />
                  <input id="supply-${product.id}" class="form-control" style="width: 118px; padding: 7px 8px;" type="number" min="1" max="365" placeholder="복용 기간(일)" title="1개를 다 먹거나 쓰는 데 걸리는 일수" value="${product.supply_days ?? ''}" />
                </div>
              </td>
              <td>
                <div class="inline-actions">
                  <button class="btn btn-outline btn-sm" type="button" onclick="updateProduct(${Number(product.id)})">저장</button>
                  <button class="btn ${isUnverified(product) ? 'btn-primary' : 'btn-outline'} btn-sm" type="button" onclick="openProductMedia(${Number(product.id)})">${isUnverified(product) ? '검증하기' : '사진·성분'}</button>
                  <button class="btn btn-danger btn-sm" type="button" onclick="hideProduct(${Number(product.id)})">숨김</button>
                </div>
                ${product.product_type === 'GENERAL' ? `<div class="list-meta" style="margin-top: 4px;">${verificationLine(product)}</div>` : ''}
                <div class="inline-actions" style="margin-top: 6px; flex-wrap: wrap;">
                  <label class="check-chip" title="현장(POS) 판매"><input id="pos-${product.id}" type="checkbox" ${Number(product.pos_sale_enabled ?? 1) ? 'checked' : ''} ${product.product_type === 'ETC' ? 'disabled' : ''} /> POS 판매</label>
                  <label class="check-chip" title="일반 상품만 온라인에서 팔 수 있습니다"><input id="online-${product.id}" type="checkbox" ${product.product_type === 'GENERAL' && Number(product.online_visible) ? 'checked' : ''} ${product.product_type !== 'GENERAL' ? 'disabled' : ''} /> 온라인 판매</label>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${pagerHtml(productState.page, totalPages, 'goProductPage')}
  `;
}

function renderPopularProducts(products) {
  if (!products || products.length === 0) {
    $('#popularProducts').innerHTML = renderEmpty('아직 판매 집계가 없습니다.');
    return;
  }

  $('#popularProducts').innerHTML = `
    <div class="list-stack">
      ${products.map((product) => `
        <div class="list-item">
          <div>
            <div class="list-title">${h(product.product_name)}</div>
            <div class="list-meta">판매 수량 ${Number(product.sold_quantity || 0).toLocaleString()}개</div>
          </div>
          <div class="list-value">${money(product.sales)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function updateProduct(id) {
  try {
    await api.request(`/products/${id}`, {
      method: 'PATCH',
      body: {
        stock_quantity: $(`#stock-${id}`).value,
        status: $(`#status-${id}`).value,
        barcode: $(`#barcode-${id}`).value,
        product_type: $(`#type-${id}`).value,
        pos_sale_enabled: $(`#pos-${id}`).checked,
        online_visible: $(`#type-${id}`).value === 'GENERAL' && $(`#online-${id}`).checked,
        tax_type: $(`#tax-${id}`).value,
        cost_price: $(`#cost-${id}`).value,
        brand: $(`#brand-${id}`).value,
        supply_days: $(`#supply-${id}`).value
      }
    });
    showToast('상품 정보가 저장되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function hideProduct(id) {
  if (!confirm('이 상품을 고객 몰에서 숨길까요?')) return;
  try {
    await api.request(`/products/${id}`, { method: 'DELETE' });
    showToast('상품이 숨김 처리되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

function scanBarcodeInto(inputId) {
  ScanKit.openCameraScanner({
    title: '상품 바코드 스캔',
    hint: '상품 포장의 바코드를 네모 칸 안에 맞춰 주세요.',
    onResult: (code) => {
      const input = document.getElementById(inputId);
      input.value = code;
      input.focus();
      showToast(`바코드 ${code}을(를) 입력했습니다.`);
    }
  });
}

$('#productForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const body = serializeForm(event.target);
    if (!body.discount_price) delete body.discount_price;
    if (!body.thumbnail_url) delete body.thumbnail_url;
    if (!body.supply_days) delete body.supply_days;
    body.pos_sale_enabled = $('#productPosSale').checked;
    body.online_visible = body.product_type === 'GENERAL' && $('#productOnlineSale').checked;
    await api.request('/products', { method: 'POST', body });
    event.target.reset();
    event.target.category_name.value = '건강기능식품';
    event.target.stock_quantity.value = '10';
    event.target.status.value = 'ON_SALE';
    event.target.product_type.value = '';
    event.target.tax_type.value = 'TAXABLE';
    syncProductFormChannels();
    closeProductModal();
    showToast('상품이 등록되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
});
