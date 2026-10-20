// MAYDIN 파트너센터 · 온라인 몰 설정(배송·픽업·배송비·공지)
function mallSettingsBody() {
  return {
    delivery_enabled: $('#mallDelivery').checked,
    pickup_enabled: $('#mallPickup').checked,
    delivery_fee: Number($('#mallDeliveryFee').value || 0),
    free_delivery_min: Number($('#mallFreeMin').value || 0),
    notice: $('#mallNoticeInput').value
  };
}

function renderMallSettingsPreview() {
  $('#mallSettingsPreview').textContent = `고객 몰에는 이렇게 보입니다: ${shippingSummary(mallSettingsBody()) || '주문 방식을 하나 이상 켜 주세요.'}`;
}

async function toggleMallSettings(show) {
  const form = $('#mallSettingsForm');
  form.hidden = show === undefined ? !form.hidden : !show;
  if (form.hidden) return;
  try {
    const { mall } = await api.request('/pharmacies/me/mall-settings');
    $('#mallDelivery').checked = mall.delivery_enabled;
    $('#mallPickup').checked = mall.pickup_enabled;
    $('#mallDeliveryFee').value = mall.delivery_fee;
    $('#mallFreeMin').value = mall.free_delivery_min;
    $('#mallNoticeInput').value = mall.notice;
    renderMallSettingsPreview();
  } catch (error) {
    showToast(error.message);
  }
}

$('#mallSettingsForm').addEventListener('input', renderMallSettingsPreview);

$('#mallSettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api.request('/pharmacies/me/mall-settings', { method: 'PATCH', body: mallSettingsBody() });
    showToast('온라인 몰 설정을 저장했습니다.');
    toggleMallSettings(false);
  } catch (error) {
    showToast(error.message);
  }
});
