const api = {
  async request(path, options = {}) {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || '요청에 실패했습니다.');
      error.status = res.status;
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
