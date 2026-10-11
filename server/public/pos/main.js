// MAYDIN POS · 키보드 단축키·시작
/* ---------- 키보드 ---------- */

document.addEventListener('keydown', (event) => {
  if (document.body.classList.contains('guest')) return;
  if (event.key === 'Escape' && modalOpen()) return closeModal();
  if (event.key === 'F2') {
    event.preventDefault();
    if (!modalOpen()) document.getElementById('searchInput').select();
    return;
  }
  if (event.key === 'F4') {
    event.preventDefault();
    if (!modalOpen()) openCustomerSearch();
    return;
  }
  if (event.key === 'F9') {
    event.preventDefault();
    if (!modalOpen()) openPayment('sale');
    return;
  }
  if (event.key === 'F6') {
    event.preventDefault();
    if (!modalOpen()) openHoldCurrent();
    return;
  }
  if (event.key === 'F8') {
    event.preventDefault();
    if (!modalOpen()) openHolds();
    return;
  }
  const tag = event.target.tagName;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  if (!typing && !modalOpen() && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    document.getElementById('searchInput').focus();
  }
});

document.getElementById('modalBackdrop').addEventListener('mousedown', (event) => {
  if (event.target.id === 'modalBackdrop') closeModal();
});

boot();
