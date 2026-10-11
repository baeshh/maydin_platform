// MAYDIN POS · 장바구니·할인
/* ---------- 장바구니 ---------- */

function findProduct(id) {
  return (
    state.products.find((p) => p.id === id) ||
    state.productCache.get(id) ||
    state.cart.find((line) => line.product.id === id)?.product
  );
}

function addToCart(productId) {
  if (!requireSession()) return;
  const product = findProduct(productId);
  if (!product) return;
  const blocked = posBlockMessage(product);
  if (blocked) return toast(blocked, 'error');
  const line = state.cart.find((item) => item.product.id === productId);
  if (product.status !== 'ON_SALE' || product.stock_quantity <= 0) {
    if (!relaxedStock()) return toast(`${product.product_name}은(는) 품절 상품입니다.`, 'error');
    if (!line) toast(`${product.product_name}: 시스템 재고 ${product.stock_quantity}개 · 실제 건넨 수량대로 기록하고 재고 대사에서 맞춥니다.`);
  }
  if (line) {
    if (!relaxedStock() && line.quantity + 1 > product.stock_quantity) return toast(`재고가 ${product.stock_quantity}개뿐입니다.`, 'error');
    line.quantity += 1;
    line.product = product;
  } else {
    state.cart.push({ product, quantity: 1 });
    if (product.nearest_expiry && daysLeft(product.nearest_expiry) < 0) {
      toast(`${product.product_name}: 유통기한(${product.nearest_expiry})이 지난 재고가 있습니다. 상품의 유통기한을 확인하세요.`, 'error');
    }
  }
  renderCart();
  focusSearch();
}

function daysLeft(date) {
  const today = new Date(`${state.ctx?.today || new Date().toISOString().slice(0, 10)}T00:00:00`);
  return Math.round((new Date(`${date}T00:00:00`) - today) / 86400000);
}

function expiryBadge(date, alertDays = 90) {
  if (!date) return '';
  const days = daysLeft(date);
  if (days < 0) return `<span class="badge red">기한 경과 ${h(date)}</span>`;
  if (days <= alertDays) return `<span class="badge orange">D-${days} · ${h(date)}</span>`;
  return `<span class="badge gray">${h(date)}</span>`;
}

function stockAlertTotal(alerts) {
  return (alerts?.low_count || 0) + (alerts?.expired_count || 0);
}

function changeQty(productId, delta) {
  const line = state.cart.find((item) => item.product.id === productId);
  if (!line) return;
  const next = line.quantity + delta;
  if (next <= 0) return removeLine(productId);
  if (!relaxedStock() && next > line.product.stock_quantity) return toast(`재고가 ${line.product.stock_quantity}개뿐입니다.`, 'error');
  line.quantity = next;
  renderCart();
}

function removeLine(productId) {
  state.cart = state.cart.filter((item) => item.product.id !== productId);
  renderCart();
}

function clearCart(confirmFirst = false) {
  if (confirmFirst && state.cart.length > 0 && !confirm('판매 목록을 모두 비울까요?')) return;
  state.cart = [];
  state.discount = { amount: 0, reason: '' };
  state.customer = null;
  state.customerOrders = [];
  state.counsel = null;
  renderCustomer();
  renderCart();
  focusSearch();
}

function totals() {
  const subtotal = state.cart.reduce((sum, line) => sum + line.product.sale_price * line.quantity, 0);
  const discount = Math.min(state.discount.amount, subtotal);
  return { subtotal, discount, final: subtotal - discount };
}

function pointsEnabled() {
  return !!state.ctx?.point_policy?.enabled;
}

// 서버와 같은 기준: 일반 상품 금액(할인 비례 차감)까지만 포인트로 결제할 수 있다.
function pointEligibleAmount() {
  const t = totals();
  const general = state.cart
    .filter((line) => (line.product.product_type || 'GENERAL') === 'GENERAL')
    .reduce((sum, line) => sum + line.product.sale_price * line.quantity, 0);
  if (t.subtotal === 0) return 0;
  return Math.max(0, general - Math.ceil((t.discount * general) / t.subtotal));
}

function maxUsablePoints() {
  if (!state.customer || !pointsEnabled() || state.payMode !== 'sale') return 0;
  const other = state.payRows.filter((row) => row.method !== 'POINT').reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return Math.max(0, Math.min(state.customer.point_balance || 0, pointEligibleAmount(), payTarget() - other));
}

function renderCart() {
  const box = document.getElementById('cartLines');
  if (state.cart.length === 0) {
    box.innerHTML = '<div class="empty" style="padding-top: 64px;">바코드를 스캔하거나<br />상품을 눌러 담아 주세요.</div>';
  } else {
    box.innerHTML = state.cart
      .map(
        ({ product, quantity }) => `
        <div class="line">
          <div>
            <div class="line-name">${h(product.product_name)} ${typeBadge(product)}</div>
            <div class="line-unit">${won(product.sale_price)} · 재고 ${product.stock_quantity}</div>
          </div>
          <div class="line-total">${won(product.sale_price * quantity)}</div>
          <div class="qty">
            <button type="button" onclick="changeQty(${product.id}, -1)" aria-label="수량 줄이기">−</button>
            <span>${quantity}</span>
            <button type="button" onclick="changeQty(${product.id}, 1)" aria-label="수량 늘리기">+</button>
          </div>
          <div style="text-align: right;"><button class="line-remove" type="button" onclick="removeLine(${product.id})">삭제</button></div>
        </div>
      `
      )
      .join('');
  }
  const t = totals();
  if (state.discount.amount > t.subtotal) state.discount.amount = t.subtotal;
  document.getElementById('subtotal').textContent = won(t.subtotal);
  document.getElementById('discountView').textContent = t.discount > 0 ? `-${won(t.discount)} (${state.discount.reason})` : '0원';
  document.getElementById('finalAmount').textContent = won(t.final);
  document.getElementById('payButton').disabled = state.cart.length === 0;
  document.getElementById('holdButton').disabled = state.cart.length === 0;
}

/* ---------- 할인 ---------- */

function openDiscount() {
  const t = totals();
  if (t.subtotal === 0) return toast('먼저 상품을 담아 주세요.', 'error');
  const presets = ['단골 할인', '행사 할인', '유통기한 임박', '직원 할인', '가격 조정'];
  openModal(`
    ${modalHead('할인 적용')}
    <div class="modal-body">
      <div class="pay-total"><span class="muted" style="font-weight: 700;">상품 합계</span><div class="amount">${won(t.subtotal)}</div></div>
      <div class="field">
        <label class="label" for="discountAmount">할인 금액</label>
        <input id="discountAmount" class="input big" type="number" min="0" max="${t.subtotal}" step="100" value="${state.discount.amount || ''}" placeholder="0" data-autofocus />
      </div>
      <div class="chips" style="margin-bottom: 16px;">
        ${[5, 10, 15, 20].map((p) => `<button class="chip" type="button" onclick="document.getElementById('discountAmount').value=${Math.floor((t.subtotal * p) / 100 / 10) * 10}">${p}%</button>`).join('')}
        <button class="chip" type="button" onclick="document.getElementById('discountAmount').value=${t.subtotal % 1000}">천원 미만 절사</button>
      </div>
      <div class="field">
        <label class="label" for="discountReason">할인 사유 (필수)</label>
        <input id="discountReason" class="input" value="${h(state.discount.reason)}" placeholder="할인 사유를 입력하세요" />
      </div>
      <div class="chips" style="margin-bottom: 14px;">
        ${presets.map((r) => `<button class="chip" type="button" onclick="document.getElementById('discountReason').value='${r}'">${r}</button>`).join('')}
      </div>
      <div class="notice">처리자 <b>${h(state.ctx.user.name)}</b> 이름으로 할인 사유와 함께 감사 로그에 기록됩니다.</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="applyDiscount(true)">할인 해제</button>
      <button class="btn btn-primary" type="button" onclick="applyDiscount()">적용</button>
    </div>
  `);
}

function applyDiscount(clear = false) {
  if (clear) {
    state.discount = { amount: 0, reason: '' };
  } else {
    const amount = Number(document.getElementById('discountAmount').value || 0);
    const reason = document.getElementById('discountReason').value.trim();
    const { subtotal } = totals();
    if (!Number.isInteger(amount) || amount < 0) return toast('할인 금액을 확인해 주세요.', 'error');
    if (amount > subtotal) return toast('할인 금액이 상품 합계보다 클 수 없습니다.', 'error');
    if (amount > 0 && !reason) return toast('할인 사유를 입력해 주세요.', 'error');
    state.discount = { amount, reason: amount > 0 ? reason : '' };
  }
  renderCart();
  closeModal();
}
