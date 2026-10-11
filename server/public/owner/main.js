// MAYDIN 파트너센터 · 로그인·시작
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api.login($('#loginForm').email.value, $('#loginForm').password.value);
    if (data.user.role !== 'PHARMACY_OWNER') {
      throw new Error('약국 운영자 계정으로 로그인해 주세요.');
    }
    saveSession(data);
    showToast('로그인되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.target.id === 'productBarcode' || event.target.classList.contains('barcode-input'))) {
    event.preventDefault();
  }
});

if (currentUser()?.role === 'PHARMACY_OWNER') {
  loadOwner();
} else {
  setGuestMode(true);
}
