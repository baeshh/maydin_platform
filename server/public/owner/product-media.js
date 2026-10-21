// MAYDIN 파트너센터 · 상품 사진과 식약처 건강기능식품 신고 정보. 자동으로 맞춘 것은 약사가 확인·승인해야 고객에게 보인다.
const mediaState = { product: null, images: [], suggestions: [], mfds: null, mfdsMeta: {}, results: null, busy: false };
const UPLOAD_EDGE = 2000;
const MATCH_BASIS_TEXT = {
  NAME_COMPANY: '제품명과 제조사(브랜드)가 모두 식약처 신고 내용과 같아 자동으로 맞췄습니다.',
  NAME_BRAND: '제품명과 브랜드가 식약처 신고 제품명과 같아 자동으로 맞췄습니다. 신고 업체(제조·판매원)는 브랜드와 달라 포장 뒷면 표기와 꼭 비교해 주세요.',
  NAME: '제품명이 식약처 신고 제품명과 같아 자동으로 맞췄습니다. 브랜드(제조사)가 비어 있어 업체명은 확인하지 못했습니다.',
  MANUAL: '약국에서 직접 골라 연결했습니다.'
};
const PHOTO_BASIS_TEXT = { BARCODE: '같은 바코드 상품의 공유 사진', MFDS: '같은 식약처 신고번호 상품의 공유 사진', WEB: '구글 이미지 검색에서 찾은 사진' };

const normName = (value) => String(value || '').toLowerCase().replace(/\(주\)|주식회사|\(구\)|[\s·,()[\]+&/-]/g, '');

function mediaProduct(id) {
  return productState.source.find((p) => p.id === Number(id));
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : date.toLocaleDateString('ko-KR');
}

async function loadMfdsMeta() {
  const { product } = mediaState;
  if (!product.mfds_report_no) {
    mediaState.mfds = null;
    mediaState.mfdsMeta = {};
    return;
  }
  const data = await api.request(`/products/${product.id}/mfds`);
  mediaState.mfds = data.mfds;
  mediaState.mfdsMeta = data;
  product.mfds_verified_at = data.verified_at;
}

async function openProductMedia(id) {
  const product = mediaProduct(id);
  if (!product) return;
  Object.assign(mediaState, { product, images: [], suggestions: [], mfds: null, mfdsMeta: {}, results: null, query: null, company: null });
  $('#productMediaName').textContent = `${product.product_name}${product.brand ? ` · ${product.brand}` : ''}${product.barcode ? ` · 바코드 ${product.barcode}` : ''}`;
  $('#productMediaModal').hidden = false;
  document.body.classList.add('modal-open');
  $('#productMediaBody').innerHTML = '<div class="loading">불러오는 중입니다.</div>';
  try {
    const [images, suggestions] = await Promise.all([
      api.request(`/products/${product.id}/images`),
      api.request(`/products/${product.id}/image-suggestions`),
      loadMfdsMeta()
    ]);
    mediaState.images = images.images;
    mediaState.suggestions = suggestions.suggestions;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
  // 아직 연결이 없으면 제품명·브랜드로 후보를 바로 찾아 보여 준다(같은 이름이 여러 업체일 때 고르기 쉽게).
  if (product.product_type === 'GENERAL' && !product.mfds_report_no && String(product.product_name || '').trim().length >= 2) {
    mediaState.query = product.product_name;
    mediaState.company = product.brand || '';
    try {
      mediaState.results = (await api.request(`/products/mfds/search?q=${encodeURIComponent(mediaState.query)}&company=${encodeURIComponent(mediaState.company)}`)).results;
    } catch {
      mediaState.results = null;
    }
    if (mediaState.product === product) renderProductMedia();
  }
}

function closeProductMedia() {
  $('#productMediaModal').hidden = true;
  document.body.classList.remove('modal-open');
  if (mediaState.changed) loadOwner();
  mediaState.changed = false;
}

const pendingImages = () => mediaState.images.filter((img) => !img.verified);
const ingredientsPending = () => Boolean(mediaState.product.mfds_report_no) && !mediaState.product.mfds_verified_at;

function renderVerifyBar() {
  const photos = pendingImages().length;
  const ingredients = ingredientsPending();
  if (!photos && !ingredients) return '';
  const items = [ingredients && '성분 정보', photos && `사진 ${photos}장`].filter(Boolean).join(' · ');
  return `<div class="verify-bar">
    <span class="badge orange">미검증 제품</span>
    <span style="flex: 1; min-width: 200px;">자동으로 맞춘 항목: <b>${items}</b>. 실제 상품과 제조사·제품명·포장이 같은지 아래에서 확인하고 승인해 주세요. 사진은 승인 전에도 고객 화면에 '참고 이미지'로 보이고, 성분 정보는 승인해야 보입니다.</span>
    <button class="btn btn-primary btn-sm" type="button" onclick="verifyMedia({ all: true })">확인했어요 · 모두 승인</button>
  </div>`;
}

function renderProductMedia() {
  const { product, images, suggestions, results } = mediaState;
  const imageGrid = images.length
    ? `<div class="media-grid">${images
        .map(
          (img, index) => `
          <figure class="media-tile ${img.verified ? '' : 'pending'}">
            <img src="${h(img.thumb_url)}" alt="" loading="lazy" />
            <figcaption>
              ${img.verified
                ? index === 0 ? '<span class="badge green">대표</span>' : `<button class="muted-link" type="button" onclick="setPrimaryImage(${Number(img.id)})">대표로</button>`
                : `<span class="badge orange">미검증</span><button class="btn btn-primary btn-sm" type="button" onclick="verifyMedia({ imageIds: [${Number(img.id)}] })">승인</button>`}
              ${img.source === 'SHARED' ? `<span class="list-meta">${h(PHOTO_BASIS_TEXT[img.match_basis] || '공유 사진')}</span>` : ''}
              ${img.source === 'WEB'
                ? `<span class="list-meta">${h(PHOTO_BASIS_TEXT.WEB)}${img.source_url ? ` · <a href="${h(img.source_url)}" target="_blank" rel="noopener noreferrer">출처</a>` : ''} · 저작권 확인 필요</span>`
                : ''}
              <button class="muted-link danger" type="button" onclick="removeProductImage(${Number(img.id)}, ${img.verified ? 'false' : 'true'})">${img.verified ? '삭제' : '다른 상품이에요(삭제)'}</button>
            </figcaption>
          </figure>`
        )
        .join('')}</div>`
    : '<p class="list-meta">아직 사진이 없습니다. 다른 MAYDIN 약국의 공유 사진이나 구글 이미지 검색에서 맞는 사진을 찾으면 자동으로 붙습니다. 직접 찍으려면 상품 정면이 잘 보이게, 밝은 곳에서 배경을 단순하게 찍어 주세요.</p>';

  const shared = suggestions.length
    ? `<div class="media-section">
        <h3 class="media-heading">같은 상품의 공유 사진 <span class="list-meta">다른 MAYDIN 약국이 공유를 허락한 사진</span></h3>
        <div class="media-grid">${suggestions
          .map(
            (s) => `
            <figure class="media-tile">
              <img src="${h(s.thumb_url)}" alt="" loading="lazy" />
              <figcaption>
                <span class="list-meta">${h(PHOTO_BASIS_TEXT[s.match_basis] || '')}</span>
                <button class="btn btn-outline btn-sm" type="button" onclick="useSharedImage('${h(s.image_key)}')">이 사진 쓰기</button>
              </figcaption>
            </figure>`
          )
          .join('')}</div>
        <p class="list-meta">실제 판매하는 상품과 포장·용량이 같은지 꼭 확인한 뒤 고르세요.</p>
      </div>`
    : '';

  $('#productMediaBody').className = '';
  $('#productMediaBody').innerHTML = `
    ${renderVerifyBar()}
    <div class="media-section">
      <h3 class="media-heading">상품 사진 <span class="list-meta">${images.length}/10장 · 승인한 첫 번째 사진이 목록에 보입니다</span></h3>
      ${imageGrid}
      <div class="inline-actions" style="margin-top: 10px; flex-wrap: wrap;">
        <label class="btn btn-primary btn-sm">카메라로 찍기<input type="file" accept="image/*" capture="environment" hidden onchange="uploadProductImages(this.files); this.value = ''" /></label>
        <label class="btn btn-outline btn-sm">사진 파일 올리기<input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onchange="uploadProductImages(this.files); this.value = ''" /></label>
        <span class="list-meta" id="mediaProgress"></span>
      </div>
      <p class="list-meta" style="margin-top: 6px;">사진은 자동으로 크기를 줄이고, 촬영 위치 같은 정보는 지운 뒤 저장합니다. 직접 찍었거나 사용 권한이 있는 사진만 올려 주세요.</p>
    </div>
    ${shared}
    ${product.product_type === 'GENERAL' ? mfdsSectionHtml(product, results) : '<div class="media-section"><p class="list-meta">식약처 건강기능식품 정보는 일반 상품(건강기능식품)에만 연결합니다.</p></div>'}
  `;
}

// 우리 상품 정보와 식약처 신고 내용을 나란히 보여 줘서 약사가 같은 제품인지 판단하게 한다.
function compareHtml(product, record) {
  const sameName = [normName(product.product_name), product.brand ? normName(`${product.brand}${product.product_name}`) : null].includes(normName(record.product_name));
  const brand = normName(product.brand);
  const makerMark = !brand
    ? '<span class="diff">확인 필요</span>'
    : normName(record.company).includes(brand)
      ? '<span class="ok">제조사 일치</span>'
      : normName(record.product_name).includes(brand)
        ? '<span class="diff">브랜드 일치 · 업체 확인</span>'
        : '<span class="diff">다름</span>';
  return `<table class="verify-compare">
    <tr><th></th><td><b>우리 상품</b></td><td><b>식약처 신고</b></td><td></td></tr>
    <tr><th>제품명</th><td>${h(product.product_name)}</td><td>${h(record.product_name)}</td><td>${sameName ? '<span class="ok">일치</span>' : '<span class="diff">다름</span>'}</td></tr>
    <tr><th>제조사</th><td>${h(product.brand || '(브랜드 미입력)')}</td><td>${h(record.company || '-')}</td><td>${makerMark}</td></tr>
    <tr><th>신고번호</th><td>-</td><td>${h(record.report_no)}</td><td></td></tr>
  </table>`;
}

function mfdsSectionHtml(product, results) {
  const record = mediaState.mfds;
  const meta = mediaState.mfdsMeta || {};
  const pending = ingredientsPending();
  const current = product.mfds_report_no
    ? `<div class="mfds-linked ${pending ? 'pending' : ''}">
        <div>${pending ? '<span class="badge orange">미검증</span> 고객에게 아직 보이지 않습니다' : `<span class="badge green">검증 완료</span> ${h(meta.verified_by || '')} ${h(shortDate(meta.verified_at))}`}</div>
        ${record ? compareHtml(product, record) : `<div class="list-meta">신고번호 ${h(product.mfds_report_no)}</div>`}
        ${record?.main_function ? `<div class="list-meta" style="margin-top: 6px;">기능성: ${h(record.main_function)}</div>` : ''}
        ${meta.match_basis ? `<p class="list-meta" style="margin-top: 6px;">${h(MATCH_BASIS_TEXT[meta.match_basis] || '')}</p>` : ''}
        <div class="inline-actions" style="margin-top: 8px;">
          ${pending ? '<button class="btn btn-primary btn-sm" type="button" onclick="verifyMedia({ ingredients: true })">같은 제품이 맞아요 · 승인</button>' : ''}
          <button class="muted-link danger" type="button" onclick="unlinkMfds()">${pending ? '다른 제품이에요 (연결 해제)' : '연결 해제'}</button>
        </div>
      </div>`
    : `<p class="list-meta">${product.mfds_link_source === 'REMOVED' ? '약국에서 연결을 해제한 상품이라 자동으로 다시 연결하지 않습니다.' : '제품명과 브랜드(제조사)가 식약처 신고 내용과 하나로 맞으면 자동으로 연결합니다. 같은 이름 제품이 여러 개면 아래에서 직접 골라 주세요.'} 승인한 성분 정보만 고객 상품 상세에 보입니다.</p>`;
  const list = results === null
    ? ''
    : results.length
      ? `<div class="list-stack" style="margin-top: 10px;">${results
          .map(
            (r) => `
            <div class="list-item">
              <div>
                <div class="list-title">${h(r.product_name)}</div>
                <div class="list-meta">${h(r.company || '')} · 신고번호 ${h(r.report_no)}</div>
                ${r.main_function ? `<div class="list-meta">${h(r.main_function.slice(0, 90))}${r.main_function.length > 90 ? '…' : ''}</div>` : ''}
              </div>
              <button class="btn btn-outline btn-sm" type="button" onclick="linkMfds('${h(r.report_no)}')">이 제품으로 연결</button>
            </div>`
          )
          .join('')}</div>`
      : '<p class="list-meta" style="margin-top: 10px;">검색 결과가 없습니다. 포장에 적힌 제품명 그대로 검색해 보세요.</p>';
  return `
    <div class="media-section">
      <h3 class="media-heading">식약처 건강기능식품 정보</h3>
      ${current}
      <form class="inline-actions" style="margin-top: 10px;" onsubmit="searchMfds(event)">
        <input id="mfdsQuery" class="form-control" style="flex: 1; min-width: 180px;" placeholder="포장에 적힌 제품명" value="${h(mediaState.query ?? product.product_name)}" />
        <input id="mfdsCompany" class="form-control" style="width: 150px;" placeholder="제조사 (선택)" value="${h(mediaState.company ?? product.brand ?? '')}" />
        <button class="btn btn-outline btn-sm" type="submit">식약처에서 찾기</button>
      </form>
      ${list}
    </div>`;
}

// 휴대폰 원본(수 MB)을 그대로 보내지 않고 긴 변 2000px JPEG로 줄여 보낸다. 서버가 다시 1200px WebP로 만든다.
async function shrinkForUpload(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, UPLOAD_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.9));
  } catch {
    return file;
  }
}

async function uploadProductImages(files) {
  const list = [...(files || [])];
  if (!list.length || mediaState.busy) return;
  mediaState.busy = true;
  try {
    for (const [index, file] of list.entries()) {
      $('#mediaProgress').textContent = `올리는 중 ${index + 1}/${list.length}`;
      const blob = await shrinkForUpload(file);
      const res = await fetch(`/api/products/${mediaState.product.id}/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}`, 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '사진을 올리지 못했습니다.');
      mediaState.images = data.images;
      mediaState.changed = true;
    }
    showToast('사진을 저장했습니다.');
  } catch (error) {
    showToast(error.message);
  } finally {
    mediaState.busy = false;
    renderProductMedia();
  }
}

async function mediaAction(request, message) {
  try {
    const data = await request();
    if (data.images) mediaState.images = data.images;
    mediaState.changed = true;
    if (message) showToast(message);
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

function setPrimaryImage(imageId) {
  mediaAction(() => api.request(`/products/${mediaState.product.id}/images/${imageId}`, { method: 'PATCH', body: { primary: true } }), '대표 사진을 바꿨습니다.');
}

function removeProductImage(imageId, pending) {
  if (!confirm(pending ? '이 사진을 지울까요? 같은 사진은 다시 자동으로 붙이지 않습니다.' : '이 사진을 지울까요?')) return;
  mediaAction(() => api.request(`/products/${mediaState.product.id}/images/${imageId}`, { method: 'DELETE' }), '사진을 지웠습니다.');
}

async function useSharedImage(imageKey) {
  await mediaAction(() => api.request(`/products/${mediaState.product.id}/images/shared`, { method: 'POST', body: { image_key: imageKey } }), '공유 사진을 추가했습니다.');
  mediaState.suggestions = mediaState.suggestions.filter((s) => s.image_key !== imageKey);
  renderProductMedia();
}

// 약사 승인. all이면 지금 보이는 미검증 성분 정보와 사진을 한꺼번에 승인한다.
async function verifyMedia({ all = false, ingredients = false, imageIds = [] } = {}) {
  const body = {
    ingredients: all ? ingredientsPending() : ingredients,
    image_ids: all ? pendingImages().map((img) => img.id) : imageIds
  };
  try {
    const result = await api.request(`/products/${mediaState.product.id}/verify`, { method: 'POST', body });
    mediaState.images = (await api.request(`/products/${mediaState.product.id}/images`)).images;
    await loadMfdsMeta();
    mediaState.product.photo_pending = result.photo_pending;
    mediaState.changed = true;
    showToast(result.unverified ? '승인했습니다. 아직 확인할 항목이 남아 있어요.' : '승인했습니다. 이제 고객 화면에 보입니다.');
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

async function searchMfds(event) {
  event.preventDefault();
  mediaState.query = $('#mfdsQuery').value.trim();
  mediaState.company = $('#mfdsCompany').value.trim();
  try {
    mediaState.results = (await api.request(`/products/mfds/search?q=${encodeURIComponent(mediaState.query)}&company=${encodeURIComponent(mediaState.company)}`)).results;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

async function linkMfds(reportNo) {
  try {
    const { mfds } = await api.request(`/products/${mediaState.product.id}/mfds`, { method: 'POST', body: { report_no: reportNo } });
    mediaState.product.mfds_report_no = mfds.report_no;
    mediaState.product.mfds_link_source = 'MANUAL';
    await loadMfdsMeta();
    mediaState.results = null;
    mediaState.changed = true;
    showToast(mediaState.product.mfds_verified_at ? '식약처 정보를 연결했습니다. 직접 고른 제품이라 바로 검증 완료로 표시됩니다.' : '식약처 정보를 연결했습니다.');
    // 신고번호가 생기면 같은 신고번호로 공유된 사진도 찾을 수 있다.
    const [images, suggestions] = await Promise.all([
      api.request(`/products/${mediaState.product.id}/images`),
      api.request(`/products/${mediaState.product.id}/image-suggestions`)
    ]);
    mediaState.images = images.images;
    mediaState.suggestions = suggestions.suggestions;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

// 성분 정보나 사진이 없는 일반 상품을 제조사·제품명·바코드로 한꺼번에 맞춘다. 맞춘 것은 모두 미검증으로 들어간다.
async function autoMatchProducts(button) {
  if (button) button.disabled = true;
  try {
    const result = await api.request('/products/auto-match', { method: 'POST' });
    const parts = [`성분 ${result.linked.length}개`, `사진 ${result.photos.length}개 자동 매칭`];
    if (result.ambiguous.length) parts.push(`${result.ambiguous.length}개는 같은 이름 제품이 여러 업체라 브랜드(제조사)를 넣거나 직접 골라야 함(${result.ambiguous.slice(0, 3).map((p) => p.product_name).join(', ')}${result.ambiguous.length > 3 ? ' 등' : ''})`);
    if (result.not_found.length) parts.push(`${result.not_found.length}개는 식약처 건강기능식품에서 찾지 못함`);
    showToast(`${parts.join(' · ')}. 자동 매칭된 상품은 '미검증'에서 확인·승인해 주세요.`);
    if (result.linked.length || result.photos.length) productState.filter = 'unverified';
    loadOwner();
  } catch (error) {
    showToast(error.message);
    if (button) button.disabled = false;
  }
}

async function unlinkMfds() {
  if (!confirm('식약처 정보 연결을 해제할까요? 고객 상세 화면에서 신고 정보가 사라지고, 다시 자동으로 연결하지 않습니다.')) return;
  try {
    await api.request(`/products/${mediaState.product.id}/mfds`, { method: 'DELETE' });
    mediaState.product.mfds_report_no = null;
    mediaState.product.mfds_link_source = 'REMOVED';
    mediaState.product.mfds_verified_at = null;
    mediaState.mfds = null;
    mediaState.mfdsMeta = {};
    mediaState.changed = true;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}
