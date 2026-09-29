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
    if (!res.ok) throw new Error(data.message || '요청에 실패했습니다.');
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

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.href = '/';
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
    location.href = withPharmacy('/login.html', pharmacyCode);
    return false;
  }
  return true;
}

function orderTypeLabel(type) {
  return (
    {
      DELIVERY: '배송 주문',
      PICKUP: '매장 픽업',
      COUNSEL: '복약상담',
      POS_SALE: '현장 판매',
      POS_REFUND: '현장 반품'
    }[type] || type || '배송 주문'
  );
}

function orderStatusLabel(status) {
  return (
    {
      PAYMENT_COMPLETED: '결제완료',
      SHIPPING: '배송중',
      DELIVERED: '배송완료',
      RESERVED: '예약접수',
      CONFIRMED: '상담확정',
      READY_FOR_PICKUP: '픽업준비',
      PICKED_UP: '픽업완료',
      COMPLETED: '완료',
      CANCELED: '취소',
      PARTIALLY_REFUNDED: '부분반품',
      REFUNDED: '반품완료'
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
