// MAYDIN 파트너센터 · 상품 사진(촬영·업로드·공유 사진)과 식약처 건강기능식품 신고 정보 연결
const mediaState = { product: null, images: [], suggestions: [], mfds: null, results: null, busy: false };
const UPLOAD_EDGE = 2000;

function mediaProduct(id) {
  return productState.source.find((p) => p.id === Number(id));
}

async function openProductMedia(id) {
  const product = mediaProduct(id);
  if (!product) return;
  Object.assign(mediaState, { product, images: [], suggestions: [], mfds: null, results: null, query: null, company: null });
  $('#productMediaName').textContent = `${product.product_name}${product.barcode ? ` · 바코드 ${product.barcode}` : ''}`;
  $('#productMediaModal').hidden = false;
  document.body.classList.add('modal-open');
  $('#productMediaBody').innerHTML = '<div class="loading">불러오는 중입니다.</div>';
  try {
    const [images, suggestions, linked] = await Promise.all([
      api.request(`/products/${product.id}/images`),
      api.request(`/products/${product.id}/image-suggestions`),
      product.mfds_report_no ? api.request(`/products/${product.id}/mfds`) : Promise.resolve({ mfds: null })
    ]);
    mediaState.images = images.images;
    mediaState.suggestions = suggestions.suggestions;
    mediaState.mfds = linked.mfds;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

function closeProductMedia() {
  $('#productMediaModal').hidden = true;
  document.body.classList.remove('modal-open');
  if (mediaState.changed) loadOwner();
  mediaState.changed = false;
}

function renderProductMedia() {
  const { product, images, suggestions, results } = mediaState;
  const imageGrid = images.length
    ? `<div class="media-grid">${images
        .map(
          (img, index) => `
          <figure class="media-tile">
            <img src="${h(img.thumb_url)}" alt="" loading="lazy" />
            <figcaption>
              ${index === 0 ? '<span class="badge green">대표</span>' : `<button class="muted-link" type="button" onclick="setPrimaryImage(${Number(img.id)})">대표로</button>`}
              ${img.source === 'SHARED' ? '<span class="badge gray">공유 사진</span>' : ''}
              <button class="muted-link danger" type="button" onclick="removeProductImage(${Number(img.id)})">삭제</button>
            </figcaption>
          </figure>`
        )
        .join('')}</div>`
    : '<p class="list-meta">아직 사진이 없습니다. 상품 정면이 잘 보이게, 밝은 곳에서 배경을 단순하게 찍어 주세요.</p>';

  const shared = suggestions.length
    ? `<div class="media-section">
        <h3 class="media-heading">같은 상품의 공유 사진 <span class="list-meta">다른 MAYDIN 약국이 공유를 허락한 사진 · 같은 바코드/신고번호</span></h3>
        <div class="media-grid">${suggestions
          .map(
            (s) => `
            <figure class="media-tile">
              <img src="${h(s.thumb_url)}" alt="" loading="lazy" />
              <figcaption><button class="btn btn-outline btn-sm" type="button" onclick="useSharedImage('${h(s.image_key)}')">이 사진 쓰기</button></figcaption>
            </figure>`
          )
          .join('')}</div>
        <p class="list-meta">실제 판매하는 상품과 포장·용량이 같은지 꼭 확인한 뒤 고르세요.</p>
      </div>`
    : '';

  $('#productMediaBody').className = '';
  $('#productMediaBody').innerHTML = `
    <div class="media-section">
      <h3 class="media-heading">상품 사진 <span class="list-meta">${images.length}/10장 · 첫 번째 사진이 목록에 보입니다</span></h3>
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

function mfdsSectionHtml(product, results) {
  const linked = mediaState.mfds;
  const auto = product.mfds_link_source === 'AUTO';
  const current = product.mfds_report_no
    ? `<div class="mfds-linked">
        <div><strong>${auto ? '자동 연결됨 · 확인 필요' : '연결됨'}</strong> · 신고번호 ${h(product.mfds_report_no)}${linked ? ` · ${h(linked.product_name)} (${h(linked.company || '')})` : ''}</div>
        ${linked?.main_function ? `<div class="list-meta" style="margin-top: 4px;">${h(linked.main_function)}</div>` : ''}
        ${auto ? '<p class="list-meta" style="margin-top: 6px;">상품명이 식약처 신고 제품명과 하나로 맞아 자동으로 연결했습니다. 실제 판매하는 제품(제조사·용량)과 같은지 확인해 주세요.</p>' : ''}
        <div class="inline-actions" style="margin-top: 6px;">
          ${auto ? '<button class="btn btn-primary btn-sm" type="button" onclick="confirmMfds()">맞습니다</button>' : ''}
          <button class="muted-link danger" type="button" onclick="unlinkMfds()">${auto ? '다른 제품이에요 (연결 해제)' : '연결 해제'}</button>
        </div>
      </div>`
    : '<p class="list-meta">연결하면 고객 상품 상세에 식약처 신고 내용(기능성·섭취 방법·주의사항·보관 방법)이 짧게 보입니다.</p>';
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

function removeProductImage(imageId) {
  if (!confirm('이 사진을 지울까요?')) return;
  mediaAction(() => api.request(`/products/${mediaState.product.id}/images/${imageId}`, { method: 'DELETE' }), '사진을 지웠습니다.');
}

async function useSharedImage(imageKey) {
  await mediaAction(() => api.request(`/products/${mediaState.product.id}/images/shared`, { method: 'POST', body: { image_key: imageKey } }), '공유 사진을 추가했습니다.');
  mediaState.suggestions = mediaState.suggestions.filter((s) => s.image_key !== imageKey);
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
    mediaState.mfds = mfds;
    mediaState.results = null;
    mediaState.changed = true;
    showToast('식약처 정보를 연결했습니다.');
    // 신고번호가 생기면 같은 신고번호로 공유된 사진도 찾을 수 있다.
    mediaState.suggestions = (await api.request(`/products/${mediaState.product.id}/image-suggestions`)).suggestions;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

async function confirmMfds() {
  try {
    await api.request(`/products/${mediaState.product.id}/mfds/confirm`, { method: 'POST' });
    mediaState.product.mfds_link_source = 'MANUAL';
    mediaState.changed = true;
    showToast('식약처 정보를 확인했습니다.');
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}

// 식약처 정보가 없는 일반 상품을 이름으로 한꺼번에 맞춘다. 같은 이름이 여러 제품이면 연결하지 않는다.
async function autoLinkMfds(button) {
  if (button) button.disabled = true;
  try {
    const result = await api.request('/products/mfds/auto-link', { method: 'POST' });
    const parts = [`${result.linked.length}개 연결`];
    if (result.ambiguous.length) parts.push(`${result.ambiguous.length}개는 같은 이름 제품이 여러 개라 직접 골라야 함(${result.ambiguous.slice(0, 3).map((p) => p.product_name).join(', ')}${result.ambiguous.length > 3 ? ' 등' : ''})`);
    if (result.not_found.length) parts.push(`${result.not_found.length}개는 식약처 건강기능식품에서 찾지 못함`);
    showToast(`식약처 자동 연결: ${parts.join(' · ')}. 직접 고르려면 상품의 '사진·성분'을 눌러 주세요.`);
    loadOwner();
  } catch (error) {
    showToast(error.message);
    if (button) button.disabled = false;
  }
}

async function unlinkMfds() {
  if (!confirm('식약처 정보 연결을 해제할까요? 고객 상세 화면에서 신고 정보가 사라집니다.')) return;
  try {
    await api.request(`/products/${mediaState.product.id}/mfds`, { method: 'DELETE' });
    mediaState.product.mfds_report_no = null;
    mediaState.product.mfds_link_source = 'REMOVED';
    mediaState.mfds = null;
    mediaState.changed = true;
  } catch (error) {
    showToast(error.message);
  }
  renderProductMedia();
}
