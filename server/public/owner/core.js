// MAYDIN 파트너센터 · 공통 상수·화면 도구·쪽 나누기
let latestQrUrl = '';

const labels = {
  productStatus: {
    ON_SALE: { text: '판매중', color: 'green' },
    SOLD_OUT: { text: '품절', color: 'red' },
    STOPPED: { text: '판매중지', color: 'gray' },
    HIDDEN: { text: '숨김', color: 'gray' }
  },
  orderStatus: {
    PAYMENT_PENDING: { text: '결제대기', color: 'gray' },
    PAYMENT_COMPLETED: { text: '결제완료', color: 'blue' },
    PREPARING: { text: '상품준비', color: 'orange' },
    SHIPPING: { text: '배송중', color: 'orange' },
    DELIVERED: { text: '배송완료', color: 'green' },
    RESERVED: { text: '예약접수', color: 'blue' },
    CONFIRMED: { text: '상담확정', color: 'orange' },
    READY_FOR_PICKUP: { text: '픽업준비', color: 'orange' },
    PICKED_UP: { text: '픽업완료', color: 'green' },
    COMPLETED: { text: '완료', color: 'green' },
    CANCELED: { text: '취소', color: 'gray' },
    PARTIALLY_REFUNDED: { text: '부분반품', color: 'orange' },
    REFUNDED: { text: '반품완료', color: 'gray' }
  },
  deliveryStatus: {
    NOT_SHIPPED: { text: '미배송', color: 'red' },
    SHIPPING: { text: '배송중', color: 'blue' },
    DELIVERED: { text: '배송완료', color: 'green' },
    READY_FOR_PICKUP: { text: '픽업대기', color: 'orange' },
    PICKED_UP: { text: '픽업완료', color: 'green' },
    NOT_APPLICABLE: { text: '현장 수령', color: 'gray' },
    CANCELED: { text: '배송취소', color: 'gray' }
  },
  orderType: {
    DELIVERY: { text: '배송', color: 'blue' },
    PICKUP: { text: '픽업', color: 'green' },
    COUNSEL: { text: '상담', color: 'orange' },
    POS_SALE: { text: '현장 판매', color: 'blue' },
    POS_REFUND: { text: '현장 반품', color: 'red' },
    ONLINE_REFUND: { text: '온라인 취소·환불', color: 'red' }
  },
  paymentStatus: {
    PAID: { text: '결제완료', color: 'blue' },
    READY: { text: '결제대기', color: 'gray' },
    CANCELED: { text: '결제취소', color: 'gray' },
    REFUNDED: { text: '환불완료', color: 'gray' },
    PARTIALLY_REFUNDED: { text: '부분환불', color: 'orange' }
  }
};

function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function badge(group, value) {
  const item = labels[group][value] || { text: value || '-', color: 'gray' };
  return `<span class="badge ${item.color}">${h(item.text)}</span>`;
}

function formatDate(value) {
  if (!value) return '-';
  const text = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function showToast(text) {
  message(text);
  const target = $('#message');
  target.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => target.classList.remove('show'), 2600);
}

function setGuestMode(isGuest) {
  document.body.classList.toggle('guest', isGuest);
}

function renderEmpty(text) {
  return `<div class="empty">${h(text)}</div>`;
}

function openModal(id, focusId) {
  $(`#${id}`).hidden = false;
  document.body.classList.add('modal-open');
  setTimeout(() => $(`#${focusId}`)?.focus(), 50);
}

function closeModal(id) {
  $(`#${id}`).hidden = true;
  if (!document.querySelector('.modal-backdrop:not([hidden])')) document.body.classList.remove('modal-open');
}

const openProductModal = () => openModal('productModal', 'productName');
const closeProductModal = () => closeModal('productModal');

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  document.querySelectorAll('.modal-backdrop:not([hidden])').forEach((modal) => closeModal(modal.id));
});

function pageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  return sorted.flatMap((p, i) => (i > 0 && p - sorted[i - 1] > 1 ? ['gap', p] : [p]));
}

function pagerHtml(current, total, goFn) {
  if (total <= 1) return '';
  return `
    <div class="pager">
      <button type="button" ${current <= 1 ? 'disabled' : ''} onclick="${goFn}(${current - 1})">이전</button>
      ${pageNumbers(current, total)
        .map((p) => (p === 'gap' ? '<span class="gap">…</span>' : `<button type="button" class="${p === current ? 'active' : ''}" onclick="${goFn}(${p})">${p}</button>`))
        .join('')}
      <button type="button" ${current >= total ? 'disabled' : ''} onclick="${goFn}(${current + 1})">다음</button>
    </div>`;
}

// 검색어로 거른 뒤 현재 페이지 조각과 시작 번호를 돌려준다. 페이지가 범위를 벗어나면 맞춰 준다.
function paginate(state, matches, pageSize) {
  const items = state.query ? state.all.filter((item) => matches(item, state.query)) : state.all;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const start = (state.page - 1) * pageSize;
  return { items, totalPages, start, pageItems: items.slice(start, start + pageSize) };
}
