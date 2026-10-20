// MAYDIN 파트너센터 · 첫 화면 불러오기·요약·가입 QR
async function loadOwner() {
  try {
    setGuestMode(false);
    const [dash, qr, products, orders, customers, staff] = await Promise.all([
      api.request('/dashboard/pharmacy'),
      api.request('/qrcodes/mine'),
      api.request('/products'),
      api.request('/orders'),
      api.request('/dashboard/customers'),
      api.request('/staff')
    ]);

    allProducts = products.products;
    loadImport();
    loadPurchasing();
    loadReport();
    loadMembers();
    loadDemand();
    renderStaff(staff.staff);
    renderHeader(qr.qr);
    renderSummary(dash.summary);
    renderQr(qr.qr);
    renderCustomers(customers.customers);
    renderOrders(orders.orders);
    renderProducts(products.products);
    renderPopularProducts(dash.popularProducts);
  } catch (error) {
    showToast(error.message);
    if (error.message.includes('인증') || error.message.includes('권한') || error.message.includes('토큰')) {
      setGuestMode(true);
    }
  }
}

function renderHeader(qr) {
  const user = currentUser();
  window.ownerPharmacyCode = qr.pharmacy_code || user?.pharmacy_code || '';
  $('#sidebarPharmacyName').textContent = qr.pharmacy_name || '약국';
  $('#pagePharmacyName').textContent = qr.pharmacy_name || '약국';
  $('#sidebarUser').textContent = user?.email ? `운영자 계정 (${user.email})` : '운영자 계정';
}

function renderSummary(summary) {
  $('#todaySales').textContent = money(summary.today_sales);
  $('#monthSales').textContent = money(summary.month_sales);
  $('#pendingDeliveryCount').textContent = `${Number(summary.pending_delivery_count || 0).toLocaleString()}건`;
  $('#customerCount').textContent = `${Number(summary.customer_count || 0).toLocaleString()}명`;
  $('#todayOrders').textContent = `오늘 주문 ${Number(summary.today_order_count || 0).toLocaleString()}건`;
  $('#monthOrders').textContent = `이번 달 주문 ${Number(summary.month_order_count || 0).toLocaleString()}건`;
  $('#deliveredCount').textContent = `배송 완료 ${Number(summary.delivered_count || 0).toLocaleString()}건`;
  $('#stockWarnings').textContent =
    `재고 부족 ${Number(summary.low_stock_count || 0).toLocaleString()}개 / 품절 ${Number(summary.sold_out_count || 0).toLocaleString()}개` +
    (summary.expiry_alert_count ? ` / 유통기한 임박·경과 ${Number(summary.expiry_alert_count).toLocaleString()}개` : '');
  $('#navPendingBadge').textContent = Number(summary.pending_delivery_count || 0).toLocaleString();
}

function renderQr(qr) {
  latestQrUrl = new URL(qr.qr_url, location.origin).href;
  const imageUrl = qr.qr_image_url || `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(latestQrUrl)}`;
  $('#qrContent').innerHTML = `
    <div class="qr-box">
      <img class="qr-image" src="${h(imageUrl)}" alt="${h(qr.pharmacy_name)} 가입 QR코드" />
      <div class="qr-info">
        <h3>${h(qr.pharmacy_name)} 폐쇄몰 가입 링크</h3>
        <p><a href="${h(latestQrUrl)}" target="_blank" rel="noreferrer">${h(latestQrUrl)}</a></p>
        <div class="inline-actions">
          <span class="stat-badge">누적 스캔 ${Number(qr.scan_count || 0).toLocaleString()}회</span>
          <span class="stat-badge">가입 성공 ${Number(qr.signup_count || 0).toLocaleString()}명</span>
          <button class="btn btn-outline btn-sm" type="button" onclick="copyJoinLink()">링크 복사</button>
        </div>
      </div>
    </div>
    <div id="channelBox" class="loading" style="margin-top: 18px;">가입 경로를 불러오는 중입니다.</div>
  `;
  loadChannels();
}

async function copyJoinLink() {
  if (!latestQrUrl) return showToast('복사할 가입 링크가 없습니다.');
  try {
    await navigator.clipboard.writeText(latestQrUrl);
    showToast('가입 링크가 복사되었습니다.');
  } catch (error) {
    showToast(latestQrUrl);
  }
}
