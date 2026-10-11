// MAYDIN POS · 상품 검색·미등록 바코드 등록
/* ---------- 상품 검색 ---------- */

function renderCategories() {
  const chips = [{ id: null, category_name: '전체' }, ...(state.ctx.categories || [])];
  document.getElementById('categoryChips').innerHTML = chips
    .map(
      (c) =>
        `<button class="chip ${state.categoryId === c.id ? 'active' : ''}" type="button" onclick="selectCategory(${c.id === null ? 'null' : Number(c.id)})">${h(c.category_name)}</button>`
    )
    .join('');
}

function selectCategory(id) {
  state.categoryId = id;
  renderCategories();
  loadProducts();
  focusSearch();
}

async function loadProducts() {
  const query = document.getElementById('searchInput').value.trim();
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (state.categoryId) params.set('category_id', state.categoryId);
  const local = () => {
    const products = searchCatalog(query, state.categoryId);
    state.products = products;
    cacheProducts(products);
    renderProducts();
    return { products, offline: true };
  };
  if (isDown()) return local();
  try {
    const data = await api.request(`/pos/products?${params}`);
    state.products = data.products;
    cacheProducts(data.products);
    renderProducts();
    return data;
  } catch (error) {
    if (!error.status) {
      noteRequestFailure(error);
      return local();
    }
    toast(error.message, 'error');
    return null;
  }
}

function renderProducts() {
  const grid = document.getElementById('productGrid');
  if (state.products.length === 0) {
    grid.innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
    return;
  }
  grid.innerHTML = state.products
    .map((p) => {
      const soldOut = p.status !== 'ON_SALE' || p.stock_quantity <= 0;
      const blockedOtc = Boolean(posBlockMessage(p));
      const low = !soldOut && p.stock_quantity <= Math.max(p.safety_stock || 0, 3);
      return `
        <button class="tile ${(soldOut && !relaxedStock()) || blockedOtc ? 'disabled' : ''}" type="button" onclick="addToCart(${Number(p.id)})">
          <div class="chips">
            ${typeBadge(p)}
            ${soldOut ? '<span class="badge red">품절</span>' : ''}
          </div>
          <div class="tile-name">${h(p.product_name)}</div>
          <div class="tile-price">${won(p.sale_price)}</div>
          <div class="tile-meta">
            <span style="${low ? 'color: var(--danger);' : ''}">재고 ${Number(p.stock_quantity).toLocaleString()}</span>
            <span>${h(p.barcode || '')}</span>
          </div>
        </button>
      `;
    })
    .join('');
}

let searchTimer;
document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadProducts, 180);
});

document.getElementById('searchInput').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  clearTimeout(searchTimer);
  const input = event.target;
  const query = input.value.trim();
  if (!query) return;
  input.value = '';
  const handled = await handleScanCode(query);
  if (handled) {
    loadProducts();
    return;
  }
  input.value = query;
  const data = await loadProducts();
  if (!data) return;
  if (data.products.length === 1) {
    addToCart(data.products[0].id);
    input.value = '';
    loadProducts();
  } else if (data.products.length === 0) {
    if (/^[0-9A-Za-z-]{4,64}$/.test(query)) {
      input.value = '';
      loadProducts();
      openUnknownBarcode(query);
    } else {
      toast(`"${query}"에 해당하는 상품이 없습니다. 찾는 상품 기록에 남겼어요.`, 'error');
      input.select();
      api.request('/demand/search-miss', { method: 'POST', body: { query } }).catch(() => {});
    }
  } else {
    toast(`${data.products.length}개 상품이 검색되었습니다. 담을 상품을 눌러 주세요.`);
  }
});

// 한 입력창에서 상품 바코드·영수증 바코드·회원 QR·픽업 주문 바코드를 모두 받는다.
async function handleScanCode(code) {
  const scanLocal = () => {
    const product = catalogByBarcode(code);
    if (product) {
      cacheProducts([product]);
      addToCart(product.id);
    } else {
      toast('장애 중에는 이 기기에 받아 둔 상품 바코드만 찾을 수 있습니다. 상품명으로 검색해 주세요.', 'error');
    }
    return true;
  };
  if (isDown()) return scanLocal();
  let result;
  try {
    result = await api.request(`/pos/scan?code=${encodeURIComponent(code)}`);
  } catch (error) {
    if (!error.status) {
      noteRequestFailure(error);
      return scanLocal();
    }
    toast(error.message, 'error');
    return true;
  }
  switch (result.type) {
    case 'PRODUCT':
      cacheProducts([result.product]);
      addToCart(result.product.id);
      return true;
    case 'CUSTOMER':
      await selectCustomer(result.customer_id, { silent: true });
      toast(`${result.customer_name} 회원을 연결했습니다.`);
      return true;
    case 'SALE':
      openSaleDetail(result.order_id);
      return true;
    case 'PICKUP':
      openPickups('all', result.order_id);
      return true;
    case 'ORDER':
      toast(result.message, 'error');
      return true;
    default:
      if (result.message) {
        toast(result.message, 'error');
        return true;
      }
      return false;
  }
}

function scanWithCamera() {
  ScanKit.openCameraScanner({
    title: '카메라 스캔',
    hint: '상품 바코드, 영수증 바코드, 회원 QR, 픽업 주문 바코드를 비춰 주세요.',
    onResult: async (code) => {
      const handled = await handleScanCode(code);
      if (!handled) openUnknownBarcode(code);
    }
  });
}

/* ---------- 미등록 바코드 등록 ---------- */

function openUnknownBarcode(code, { onDone } = {}) {
  state.unknown = { code, tab: can('can_register_product') ? 'link' : 'sell', onDone };
  renderUnknownBarcode();
}

function renderUnknownBarcode() {
  const { code, tab } = state.unknown;
  const owner = can('can_register_product');
  const categories = state.ctx.categories || [];
  const body =
    tab === 'create'
      ? `
        <div class="pay-row-grid">
          <div class="field" style="grid-column: 1 / -1;"><label class="label" for="newName">상품명 (필수)</label><input id="newName" class="input" data-autofocus /></div>
          <div class="field"><label class="label" for="newPrice">판매가 (필수)</label><input id="newPrice" class="input" type="number" min="0" step="10" /></div>
          <div class="field"><label class="label" for="newStock">현재 재고</label><input id="newStock" class="input" type="number" min="0" value="1" /></div>
          <div class="field"><label class="label" for="newSafety">안전재고</label><input id="newSafety" class="input" type="number" min="0" value="0" /></div>
          <div class="field"><label class="label" for="newType">상품 구분</label>
            <select id="newType" class="input"><option value="UNCLASSIFIED">분류 전 (나중에 확인)</option><option value="GENERAL">일반 상품</option><option value="OTC">일반의약품 (현장 판매 전용)</option></select></div>
          <div class="field" style="grid-column: 1 / -1;"><label class="label" for="newCategory">카테고리</label>
            <select id="newCategory" class="input"><option value="">선택 안 함</option>${categories.map((c) => `<option value="${c.id}">${h(c.category_name)}</option>`).join('')}</select></div>
        </div>
        <div class="notice">등록하면 바로 판매 목록에 담깁니다. 사진·설명은 파트너센터 상품 관리에서 추가하세요.</div>
      `
      : `
        <input id="unknownQuery" class="input" placeholder="상품명으로 찾기" data-autofocus />
        <div class="list" id="unknownResults" style="margin-top: 10px; max-height: 44vh; overflow-y: auto;"></div>
        ${tab === 'sell' ? '<div class="notice warn" style="margin-top: 10px;">바코드 등록은 약국 관리자만 할 수 있습니다. 오늘은 상품을 찾아 판매하고, 관리자에게 바코드 등록을 요청하세요.</div>' : ''}
      `;
  openModal(`
    ${modalHead('등록되지 않은 바코드')}
    <div class="modal-body">
      <div class="pay-total" style="display: flex; justify-content: space-between; align-items: center;">
        <div><span class="muted" style="font-weight: 700;">스캔한 코드</span><div style="font-size: 22px; font-weight: 900; letter-spacing: 0.5px;">${h(code)}</div></div>
        <svg data-barcode="${h(code)}" data-height="36" data-label="off" style="max-width: 180px;"></svg>
      </div>
      ${owner
        ? `<div class="seg">
            <button type="button" class="${tab === 'link' ? 'active' : ''}" onclick="switchUnknownTab('link')">기존 상품에 연결</button>
            <button type="button" class="${tab === 'create' ? 'active' : ''}" onclick="switchUnknownTab('create')">새 상품으로 등록</button>
          </div>`
        : ''}
      ${body}
    </div>
    ${tab === 'create'
      ? `<div class="modal-foot"><button class="btn btn-outline" type="button" onclick="closeModal()">취소</button><button class="btn btn-primary" type="button" onclick="createFromBarcode()">등록하고 담기</button></div>`
      : ''}
  `);
  if (tab !== 'create') {
    const input = document.getElementById('unknownQuery');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(searchUnknownProducts, 180);
    });
    searchUnknownProducts();
  }
}

function switchUnknownTab(tab) {
  state.unknown.tab = tab;
  renderUnknownBarcode();
}

async function searchUnknownProducts() {
  const query = document.getElementById('unknownQuery')?.value.trim() || '';
  try {
    const data = await api.request(`/pos/products?query=${encodeURIComponent(query)}`);
    cacheProducts(data.products);
    const box = document.getElementById('unknownResults');
    if (!box) return;
    const list = [...data.products].sort((a, b) => (a.barcode ? 1 : 0) - (b.barcode ? 1 : 0));
    const linking = state.unknown.tab === 'link';
    box.innerHTML = list.length
      ? list
          .map(
            (p) => `
            <button class="list-item" type="button" onclick="${linking ? `linkBarcode(${p.id})` : `sellWithoutBarcode(${p.id})`}">
              <div>
                <div style="font-weight: 800;">${h(p.product_name)} ${typeBadge(p)}</div>
                <div class="muted" style="font-size: 13px; font-weight: 600;">${p.barcode ? `현재 바코드 ${h(p.barcode)}` : '바코드 없음'} · 재고 ${p.stock_quantity}</div>
              </div>
              <div style="text-align: right;"><strong>${won(p.sale_price)}</strong><div class="muted" style="font-size: 12px; font-weight: 700;">${linking ? '이 상품에 연결' : '담기'}</div></div>
            </button>`
          )
          .join('')
      : '<div class="empty">검색 결과가 없습니다.</div>';
  } catch (error) {
    toast(error.message, 'error');
  }
}

function finishUnknown(product) {
  const onDone = state.unknown?.onDone;
  state.unknown = null;
  cacheProducts([product]);
  closeModal();
  if (onDone) return onDone(product);
  loadProducts();
  if (product.status === 'ON_SALE' && product.stock_quantity > 0) addToCart(product.id);
}

function linkBarcode(productId) {
  const product = state.productCache.get(productId);
  const { code } = state.unknown;
  if (product?.barcode && !confirm(`${product.product_name}의 기존 바코드(${product.barcode})를 ${code}(으)로 바꿀까요?`)) return;
  withBusy(async () => {
    const data = await api.request(`/pos/products/${productId}/barcode`, { method: 'POST', body: { barcode: code } });
    toast(`${data.product.product_name}에 바코드를 연결했습니다.`);
    finishUnknown(data.product);
  });
}

function sellWithoutBarcode(productId) {
  state.unknown = null;
  closeModal();
  addToCart(productId);
}

function createFromBarcode() {
  withBusy(async () => {
    const body = {
      barcode: state.unknown.code,
      product_name: document.getElementById('newName').value.trim(),
      price: Number(document.getElementById('newPrice').value),
      stock_quantity: Number(document.getElementById('newStock').value || 0),
      safety_stock: Number(document.getElementById('newSafety').value || 0),
      product_type: document.getElementById('newType').value,
      category_id: document.getElementById('newCategory').value || null
    };
    if (!body.product_name) throw new Error('상품명을 입력해 주세요.');
    if (!document.getElementById('newPrice').value) throw new Error('판매가를 입력해 주세요.');
    const data = await api.request('/pos/products/quick', { method: 'POST', body });
    toast(`${data.product.product_name}을(를) 등록했습니다.`);
    finishUnknown(data.product);
    refreshBadges();
  });
}
