// MAYDIN POS · 공통 상수·상태·화면 도구
const ALLOWED_ROLES = ['PHARMACY_OWNER', 'POS_STAFF'];
const METHOD_LABELS = {
  CARD: '카드',
  CASH: '현금',
  TRANSFER: '계좌이체',
  EASY_PAY: '간편결제',
  POINT: '포인트',
  MOCK_CARD: '온라인 카드',
  NONE: '결제 없음'
};
const CHANNEL_LABELS = { POS: '매장 POS', ONLINE: '온라인', PICKUP_COUNTER: '픽업 카운터 결제' };
const AUDIT_LABELS = {
  POS_SESSION_OPEN: '영업 시작',
  POS_SESSION_CLOSE: '일마감',
  POS_SALE: '판매',
  POS_DISCOUNT: '할인',
  POS_CANCEL: '전체 취소',
  POS_REFUND: '부분 반품',
  POS_CASH_MOVEMENT: '현금 입출금',
  POS_PICKUP_COMPLETE: '픽업 수령',
  POS_RECEIPT_REPRINT: '영수증 재출력',
  POS_COUNSEL_COMPLETE: '상담 완료',
  POS_PRODUCT_CREATE: '상품 등록',
  POS_BARCODE_LINK: '바코드 연결',
  POS_HOLD: '보류',
  POS_HOLD_RECALL: '보류 불러오기',
  POS_HOLD_DISCARD: '보류 폐기',
  POS_STOCK_RECEIVE: '입고',
  POS_STOCK_DISPOSE: '폐기',
  POS_STOCK_COUNT: '실사 조정',
  POS_SAFETY_STOCK: '안전재고',
  POS_VAN_SETTING: 'VAN 설정',
  POS_STAFF_CREATE: '직원 등록',
  POS_STAFF_UPDATE: '직원 수정',
  POS_STAFF_DEACTIVATE: '직원 중지',
  POS_STAFF_PASSWORD_RESET: '직원 비밀번호',
  POINT_SETTING: '포인트 정책',
  POINT_ADJUST: '포인트 조정',
  POINT_SHORTFALL: '포인트 미회수',
  SUPPLIER_CREATE: '거래처 등록',
  SUPPLIER_UPDATE: '거래처 수정',
  PO_CREATE: '발주서 작성',
  PO_UPDATE: '발주서 수정',
  PO_CONFIRM: '발주 확정',
  PO_CANCEL: '발주 취소',
  PO_RECEIVE: '발주 입고',
  PO_CLOSE: '입고 종료'
};
const POINT_ENTRY_LABELS = { EARN: '적립', USE: '사용', EARN_CANCEL: '적립 취소', USE_RESTORE: '사용 복원', ADJUST: '수동 조정', REWARD: '추천 보상' };
const STOCK_LOG_LABELS = {
  RECEIVE: '입고',
  DISPOSE: '폐기',
  COUNT_ADJUST: '실사 조정',
  POS_SALE: '현장 판매',
  POS_REFUND: '반품 재입고',
  ADJUST: '상품 수정',
  ORDER: '온라인 주문',
  CANCEL: '주문 취소'
};

const state = {
  ctx: null,
  session: null,
  products: [],
  categoryId: null,
  cart: [],
  customer: null,
  customerOrders: [],
  counsel: null,
  discount: { amount: 0, reason: '' },
  payMode: 'sale',
  payRows: [],
  pickup: null,
  payOpen: false,
  productCache: new Map(),
  inventory: { filter: 'all', selectedId: null, adjustType: 'RECEIVE' },
  modalLocked: false,
  busy: false,
  payContext: 'normal',
  pendingSale: null,
  payDraft: null,
  failedSale: null,
  failedSalePath: null,
  manual: null,
  outages: [],
  syncing: false
};

function cacheProducts(list) {
  for (const product of list || []) state.productCache.set(product.id, product);
}

function h(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function won(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

function signedWon(value) {
  const number = Number(value || 0);
  return number < 0 ? `-${won(-number)}` : won(number);
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function maskPhone(phone) {
  const d = onlyDigits(phone);
  if (d.length < 8) return phone || '';
  return `${d.slice(0, 3)}-****-${d.slice(-4)}`;
}

function parseDate(value) {
  if (!value) return null;
  return new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
}

function fmtDateTime(value) {
  const date = parseDate(value);
  if (!date || Number.isNaN(date.getTime())) return value || '-';
  return date.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtTime(value) {
  const date = parseDate(value);
  if (!date || Number.isNaN(date.getTime())) return value || '-';
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function isOwner() {
  return state.ctx?.user?.role === 'PHARMACY_OWNER';
}

function can(permission) {
  return !!state.ctx?.permissions?.[permission];
}

const TYPE_BADGES = {
  OTC: '<span class="badge orange">일반의약품</span>',
  ETC: '<span class="badge red">전문의약품</span>',
  UNCLASSIFIED: '<span class="badge orange">분류 전</span>'
};

function typeBadge(product) {
  return TYPE_BADGES[product.product_type] || '';
}

// 서버와 같은 기준으로 현장 판매를 막는다.
function posBlockMessage(product) {
  if (product.product_type === 'ETC') return '전문의약품은 POS에서 판매할 수 없습니다. 처방 조제 프로그램에서 처리해 주세요.';
  if (can('can_sell_otc')) return '';
  if (product.product_type === 'OTC') return '일반의약품은 약사(관리자) 계정으로만 판매할 수 있습니다.';
  if (product.product_type === 'UNCLASSIFIED') return '분류 전 상품은 약사(관리자) 계정으로만 판매할 수 있습니다. 파트너센터에서 구분을 정해 주세요.';
  return '';
}

let toastTimer;
function toast(text, type = '') {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

function openModal(html, { size = '', locked = false } = {}) {
  state.modalLocked = locked;
  const modal = document.getElementById('modal');
  modal.className = `modal ${size}`;
  modal.innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('open');
  const focusTarget = modal.querySelector('[data-autofocus]');
  if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
  renderCodes(modal);
}

function renderCodes(root) {
  return Promise.all([
    ScanKit.renderBarcodes(root).catch(() => {}),
    ...[...root.querySelectorAll('[data-qr]')].map((el) => ScanKit.renderQr(el, el.dataset.qr, { cellSize: 3 }).catch(() => {}))
  ]);
}

function closeModal(force = false) {
  if (state.modalLocked && !force) return;
  if (state.payOpen) {
    if (!canLeavePayment()) return;
    state.payOpen = false;
    abandonPayment();
  }
  state.modalLocked = false;
  document.getElementById('modalBackdrop').classList.remove('open');
  document.getElementById('modal').innerHTML = '';
  focusSearch();
}

function modalOpen() {
  return document.getElementById('modalBackdrop').classList.contains('open');
}

function modalHead(title, { closable = true } = {}) {
  return `
    <div class="modal-head">
      <h2>${title}</h2>
      ${closable ? '<button class="modal-close" type="button" onclick="closeModal()" aria-label="닫기">×</button>' : ''}
    </div>
  `;
}

function focusSearch() {
  if (!modalOpen()) document.getElementById('searchInput')?.focus();
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  try {
    return await fn();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.busy = false;
  }
}
