// MAYDIN 파트너센터 · 수요·함께 산 상품·재입고 알림
/* ---------- 수요 · 함께 산 상품 ---------- */

const demandState = { statuses: {} };

function demandTable(head, rows, empty) {
  return `<div class="table-wrap"><table class="consent-table">
    <thead><tr>${head.map(([label, num]) => `<th class="${num ? 'num' : ''}">${label}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}">${empty}</td></tr>`}</tbody>
  </table></div>`;
}

function renderDemand(basket, demand) {
  demandState.statuses = demand.request_statuses;
  const openRequests = demand.requests.filter((r) => r.status === 'OPEN').length;
  const readyRestock = demand.restock.filter((r) => r.available && r.waiting > 0).length;
  $('#navDemandBadge').hidden = openRequests + readyRestock === 0;
  $('#navDemandBadge').textContent = openRequests + readyRestock;
  $('#demandBody').classList.remove('loading');
  $('#demandBody').innerHTML = `
    <div class="chart-grid" style="grid-template-columns: 1fr 1fr;">
      <div class="chart-box">
        <h4 style="margin: 0 0 4px;">함께 산 상품</h4>
        <p class="list-meta" style="margin: 0 0 10px;">같은 결제에 함께 담긴 조합 · 2개 이상 담은 결제 ${basket.multi_orders.toLocaleString()}건 / 전체 ${basket.orders.toLocaleString()}건. 진열·묶음 할인·POS 추천에 활용하세요.</p>
        ${demandTable(
          [['상품 조합'], ['함께 산 결제', true], ['A 산 사람 중', true], ['B 산 사람 중', true], ['향상도', true]],
          basket.pairs.map((p) => `<tr>
            <td><strong>${h(p.a_name)}</strong> + <strong>${h(p.b_name)}</strong></td>
            <td class="num">${p.together.toLocaleString()}건</td>
            <td class="num">${p.confidence_ab}%</td>
            <td class="num">${p.confidence_ba}%</td>
            <td class="num" title="1보다 크면 우연보다 자주 함께 팔림">${p.lift}배</td>
          </tr>`),
          '2회 이상 함께 팔린 조합이 아직 없습니다.'
        )}
      </div>
      <div class="chart-box">
        <h4 style="margin: 0 0 4px;">찾았지만 없던 상품 (결과 없는 검색어)</h4>
        <p class="list-meta" style="margin: 0 0 10px;">고객 몰 검색과 POS 상품 검색에서 결과가 없던 검색어입니다. 입점 검토 후보로 보세요.</p>
        ${demandTable(
          [['검색어'], ['횟수', true], ['고객 몰 · POS', true], ['최근']],
          demand.searches.map((s) => `<tr>
            <td><strong>${h(s.query)}</strong></td>
            <td class="num">${s.count.toLocaleString()}</td>
            <td class="num">${s.store_count} · ${s.pos_count}</td>
            <td>${h(formatDate(s.last_at))}</td>
          </tr>`),
          '결과 없는 검색어가 없습니다.'
        )}
      </div>
    </div>
    <div class="chart-grid" style="grid-template-columns: 1fr 1fr;">
      <div class="chart-box">
        <h4 style="margin: 0 0 4px;">입고 알림 신청</h4>
        <p class="list-meta" style="margin: 0 0 10px;">품절 상품에 고객이 신청한 입고 알림입니다. 입고 후 고객에게 연락하고 '안내 완료'를 눌러 주세요. (문자 자동 발송은 문자 서비스 계약 후 연결)</p>
        ${demandTable(
          [['상품'], ['대기', true], ['상태'], ['']],
          demand.restock.map((r) => `<tr>
            <td><strong>${h(r.product_name)}</strong><div class="list-meta">재고 ${Number(r.stock_quantity).toLocaleString()}개${r.notified ? ` · 안내 완료 ${r.notified}명` : ''}</div></td>
            <td class="num">${r.waiting.toLocaleString()}명</td>
            <td>${r.available ? '<span class="badge green">입고됨</span>' : '<span class="badge red">품절</span>'}</td>
            <td>
              <button class="muted-link" type="button" onclick="showRestockCustomers(${r.product_id})">신청 고객</button>
              ${r.available && r.waiting ? ` · <button class="muted-link" type="button" onclick="markRestockNotified(${r.product_id})">안내 완료</button>` : ''}
              <div id="restockCustomers-${r.product_id}" class="list-meta"></div>
            </td>
          </tr>`),
          '입고 알림 신청이 없습니다.'
        )}
      </div>
      <div class="chart-box">
        <h4 style="margin: 0 0 4px;">고객 상품 요청 ${openRequests ? `<span class="badge orange">대기 ${openRequests}</span>` : ''}</h4>
        <p class="list-meta" style="margin: 0 0 10px;">고객이 앱에서 요청한 상품입니다. 처리 상태와 답변은 고객 앱에 그대로 보입니다.</p>
        ${demandTable(
          [['요청'], ['처리']],
          demand.requests.map((r) => `<tr>
            <td><strong>${h(r.product_name)}</strong><div class="list-meta">${h(r.customer_name || '탈퇴 회원')} · ${h(formatDate(r.created_at))}${r.memo ? `<br />${h(r.memo)}` : ''}</div></td>
            <td>
              <div class="inline-actions">
                <select id="reqStatus-${r.id}" class="form-control" style="width: auto; padding: 6px 8px;">
                  ${Object.entries(demand.request_statuses).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${h(v)}</option>`).join('')}
                </select>
                <input id="reqReply-${r.id}" class="form-control" style="flex: 1; min-width: 120px; padding: 6px 8px;" maxlength="200" placeholder="고객에게 보일 답변 (선택)" value="${h(r.reply || '')}" />
                <button class="btn btn-outline btn-sm" type="button" onclick="saveProductRequest(${r.id})">저장</button>
              </div>
            </td>
          </tr>`),
          '고객 상품 요청이 없습니다.'
        )}
      </div>
    </div>`;
}

async function loadDemand() {
  const days = $('#demandDays').value;
  try {
    const [basket, demand] = await Promise.all([api.request(`/reports/basket?days=${days}`), api.request(`/demand/summary?days=${days}`)]);
    renderDemand(basket, demand);
  } catch (error) {
    $('#demandBody').innerHTML = renderEmpty(error.message);
  }
}

async function showRestockCustomers(productId) {
  const box = $(`#restockCustomers-${productId}`);
  if (box.innerHTML) {
    box.innerHTML = '';
    return;
  }
  try {
    const { customers } = await api.request(`/demand/restock-alerts/${productId}/customers`);
    box.innerHTML = customers.map((c) => `${h(c.name)} ${h(c.phone || '')}${c.status === 'NOTIFIED' ? ' (안내 완료)' : ''}`).join('<br />') || '신청 고객이 없습니다.';
  } catch (error) {
    showToast(error.message);
  }
}

async function markRestockNotified(productId) {
  if (!confirm('입고 알림을 신청한 고객에게 연락했나요?\n대기 중인 신청이 모두 안내 완료로 바뀝니다.')) return;
  try {
    const { notified } = await api.request(`/demand/restock-alerts/${productId}/notified`, { method: 'POST' });
    showToast(`${notified}명을 안내 완료로 표시했습니다.`);
    loadDemand();
  } catch (error) {
    showToast(error.message);
  }
}

async function saveProductRequest(id) {
  try {
    await api.request(`/demand/product-requests/${id}`, {
      method: 'PATCH',
      body: { status: $(`#reqStatus-${id}`).value, reply: $(`#reqReply-${id}`).value }
    });
    showToast('요청 처리 상태를 저장했습니다.');
    loadDemand();
  } catch (error) {
    showToast(error.message);
  }
}
