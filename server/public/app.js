// 카운터로 등록된 PC의 기기 토큰. 로그인한 사람이 아니라 PC에 묶이므로 로그아웃해도 지우지 않는다.
const POS_DEVICE_KEY = 'maydin_pos_device';

const api = {
  async request(path, options = {}) {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const device = path.startsWith('/pos/') ? localStorage.getItem(POS_DEVICE_KEY) : null;
    if (device) headers['X-POS-Device'] = device;

    const res = await fetch(`/api${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || '요청에 실패했습니다.');
      error.status = res.status;
      if (data.reason) error.reason = data.reason;
      error.data = data;
      throw error;
    }
    return data;
  },

  login(email, password) {
    return this.request('/auth/login', { method: 'POST', body: { email, password } });
  }
};

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// http(s) 주소와 이 서버의 경로만 통과시킨다. javascript:·data: 등은 빈 문자열이 된다.
function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\\]/.test(raw)) return '';
  try {
    const url = new URL(raw, location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (error) {
    return '';
  }
}

// 서버에서 온 값은 textContent·속성으로만 넣어 HTML로 해석되지 않게 한다.
// 이벤트는 함수로만 받고, src·href는 safeUrl을 통과한 값만 넣는다.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) {
      if (typeof value !== 'function') throw new TypeError(`${key}에는 함수만 넣을 수 있습니다.`);
      node.addEventListener(key.slice(2), value);
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'src' || key === 'href') {
      const url = safeUrl(value);
      if (url) node.setAttribute(key, url);
    } else if (key === 'value' && 'value' in node) {
      node.value = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function money(value) {
  return `${Number(value || 0).toLocaleString()}원`;
}

function message(text) {
  const target = $('#message');
  if (target) target.textContent = text;
}

function saveSession(data) {
  localStorage.setItem('token', data.token);
  localStorage.setItem('user', JSON.stringify(data.user));
}

function logout(to = '/') {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.href = to;
}

function currentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch (error) {
    return null;
  }
}

function serializeForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function pharmacyCodeFromUrl(fallback = 'A001') {
  return new URLSearchParams(location.search).get('pharmacyCode') || fallback;
}

function withPharmacy(path, pharmacyCode = pharmacyCodeFromUrl()) {
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}pharmacyCode=${encodeURIComponent(pharmacyCode)}`;
}

function requireCustomerLogin(pharmacyCode = pharmacyCodeFromUrl()) {
  const user = currentUser();
  if (!user || user.role !== 'CUSTOMER') {
    sendToMallLogin(pharmacyCode);
    return false;
  }
  return true;
}

function sendToMallLogin(pharmacyCode = pharmacyCodeFromUrl(), notice = '이 약국몰은 회원 전용이에요. 로그인하거나 영수증 코드로 가입해 주세요.') {
  sessionStorage.setItem('loginNotice', notice);
  location.replace(withPharmacy('/login.html', pharmacyCode));
}

function requireMallLogin(pharmacyCode = pharmacyCodeFromUrl()) {
  const user = currentUser();
  if (!user || !localStorage.getItem('token') || !['CUSTOMER', 'PHARMACY_OWNER', 'POS_STAFF', 'ADMIN'].includes(user.role)) {
    sendToMallLogin(pharmacyCode);
    return false;
  }
  return true;
}

function handleMallAuthError(error, pharmacyCode = pharmacyCodeFromUrl()) {
  if (error.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sendToMallLogin(pharmacyCode, '로그인이 만료됐어요. 다시 로그인해 주세요.');
    return true;
  }
  if (error.status === 403) {
    sendToMallLogin(pharmacyCode, error.message);
    return true;
  }
  return false;
}

let onlineOrderAllowed = false;

function onlineOrderReady() {
  return onlineOrderAllowed;
}

function setOrderControls(controls, enabled) {
  for (const control of controls) {
    if ('disabled' in control) control.disabled = !enabled;
    if (control.tagName === 'A') {
      if (!enabled && control.hasAttribute('href')) {
        control.dataset.href = control.getAttribute('href');
        control.removeAttribute('href');
      }
      if (enabled && control.dataset.href) control.setAttribute('href', control.dataset.href);
    }
    control.setAttribute('aria-disabled', String(!enabled));
    control.style.opacity = enabled ? '' : '0.45';
    control.style.pointerEvents = enabled ? '' : 'none';
  }
}

function showOrderGuardNotice(parent, text, retry) {
  const notice = document.createElement('div');
  notice.dataset.orderGuard = '';
  notice.setAttribute('role', 'alert');
  notice.style.cssText =
    'background:#fff4e5;border:1px solid #ffd8a8;border-radius:16px;color:#8a4b00;font-size:14px;font-weight:700;line-height:1.55;padding:14px 16px;';
  notice.textContent = text;
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '다시 확인';
    button.style.cssText = 'display:block;width:auto;margin:10px 0 0;padding:8px 14px;background:#fff;color:#8a4b00;border:1px solid #ffd8a8;';
    button.addEventListener('click', retry);
    notice.append(button);
  }
  parent.prepend(notice);
}

// 주문 자격을 확인하기 전·확인에 실패했을 때는 주문 버튼을 막아 둔다. 서버도 주문 시 다시 확인한다.
async function guardOnlineOrder(noticeParent, controls = []) {
  const targets = controls.filter(Boolean);
  onlineOrderAllowed = false;
  setOrderControls(targets, false);
  noticeParent.querySelector('[data-order-guard]')?.remove();

  let status;
  try {
    status = await api.request('/orders/eligibility');
  } catch (error) {
    if (handleMallAuthError(error)) return false;
    showOrderGuardNotice(noticeParent, '주문 가능 여부를 확인하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.', () =>
      guardOnlineOrder(noticeParent, controls)
    );
    return false;
  }
  if (status.allowed) {
    onlineOrderAllowed = true;
    setOrderControls(targets, true);
    return true;
  }
  showOrderGuardNotice(noticeParent, status.message);
  return false;
}

/* ---------- 온라인 결제 ---------- */

let paymentSettings = null;

// 결제 모드 안내를 붙이고, 결제가 닫혀 있으면 주문 버튼을 막는다. 서버도 결제 요청 때 다시 막는다.
async function showPaymentMode(parent, controls = []) {
  try {
    paymentSettings = await api.request('/payments/config');
  } catch (error) {
    paymentSettings = null;
  }
  const notice = document.createElement('div');
  notice.dataset.paymentMode = '';
  notice.style.cssText = 'border-radius:16px;font-size:14px;font-weight:700;line-height:1.55;padding:14px 16px;';
  if (!paymentSettings || !paymentSettings.enabled) {
    notice.style.cssText += 'background:#fff4e5;border:1px solid #ffd8a8;color:#8a4b00;';
    notice.textContent = paymentSettings?.message || '결제 설정을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    setOrderControls(controls.filter(Boolean), false);
  } else if (paymentSettings.mode !== 'LIVE') {
    notice.style.cssText += 'background:#fff0f0;border:1px solid #ffc9c9;color:#c92a2a;';
    notice.textContent = paymentSettings.message || `${paymentSettings.label} — 실제 결제가 아닙니다.`;
  } else {
    return paymentSettings;
  }
  parent.querySelector('[data-payment-mode]')?.remove();
  parent.prepend(notice);
  return paymentSettings;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('결제창을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'));
    document.head.append(script);
  });
}

function newCheckoutKey() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

// 결제 요청을 만들고 결제창으로 보낸다. 주문은 결제사 승인을 서버가 확인한 뒤에 만들어진다.
async function startOnlinePayment(body, pharmacyCode = pharmacyCodeFromUrl()) {
  const checkoutKey = newCheckoutKey();
  let created;
  try {
    created = await api.request('/payments/checkouts', { method: 'POST', body: { ...body, checkout_key: checkoutKey } });
  } catch (error) {
    if (error.status === 409 && /이미 결제했습니다/.test(error.message)) {
      if (!confirm(`${error.message}\n\n같은 상품을 한 번 더 주문할까요?`)) return null;
      created = await api.request('/payments/checkouts', { method: 'POST', body: { ...body, allow_duplicate: true } });
    } else {
      throw error;
    }
  }
  const checkout = created.checkout;
  const resultUrl = new URL(withPharmacy('/pay-result.html', pharmacyCode), location.origin);
  resultUrl.searchParams.set('checkout', checkout.id);

  if (checkout.provider === 'DEMO') {
    const demoUrl = new URL(withPharmacy('/pay-demo.html', pharmacyCode), location.origin);
    demoUrl.searchParams.set('checkout', checkout.id);
    location.href = demoUrl.toString();
    return checkout;
  }
  if (checkout.provider === 'TOSS') {
    if (!checkout.client_key) throw new Error('결제 설정이 바뀌었어요. 새로고침 후 다시 시도해 주세요.');
    if (!window.TossPayments) await loadScript('https://js.tosspayments.com/v2/standard');
    const failUrl = new URL(resultUrl);
    failUrl.searchParams.set('fail', '1');
    const payment = window.TossPayments(checkout.client_key).payment({ customerKey: window.TossPayments.ANONYMOUS });
    await payment.requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: checkout.amount },
      orderId: checkout.pg_order_id,
      orderName: checkout.order_name,
      successUrl: resultUrl.toString(),
      failUrl: failUrl.toString()
    });
    return checkout;
  }
  throw new Error('지원하지 않는 결제 방식입니다.');
}

function orderTypeLabel(type) {
  return (
    {
      DELIVERY: '배송 주문',
      PICKUP: '매장 픽업',
      COUNSEL: '복약상담',
      POS_SALE: '현장 판매',
      POS_REFUND: '현장 반품',
      ONLINE_REFUND: '온라인 취소·환불'
    }[type] || type || '배송 주문'
  );
}

function orderStatusLabel(status) {
  return (
    {
      PAYMENT_PENDING: '결제대기',
      PAYMENT_COMPLETED: '결제완료',
      PREPARING: '상품준비중',
      SHIPPING: '배송중',
      DELIVERED: '배송완료',
      RESERVED: '예약접수',
      CONFIRMED: '상담확정',
      READY_FOR_PICKUP: '픽업준비',
      PICKED_UP: '픽업완료',
      COMPLETED: '완료',
      CANCELED: '취소',
      PARTIALLY_REFUNDED: '부분반품',
      REFUNDED: '환불완료'
    }[status] || status || '-'
  );
}

function deliveryStatusLabel(status) {
  return (
    {
      NOT_SHIPPED: '출고대기',
      SHIPPING: '배송중',
      DELIVERED: '배송완료',
      READY_FOR_PICKUP: '픽업대기',
      PICKED_UP: '픽업완료',
      NOT_APPLICABLE: '현장 수령'
    }[status] || status || '-'
  );
}
