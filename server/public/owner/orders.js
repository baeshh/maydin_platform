// MAYDIN 파트너센터 · 주문 처리
function renderOrders(orders) {
  if (orders.length === 0) {
    $('#ordersTable').innerHTML = renderEmpty('아직 접수된 주문이 없습니다.');
    return;
  }

  $('#ordersTable').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>주문번호/일시</th>
            <th>유형</th>
            <th>주문자 정보</th>
            <th>결제금액</th>
            <th>상태</th>
            <th>처리</th>
          </tr>
        </thead>
        <tbody>
          ${orders.map((order) => `
            <tr id="order-row-${Number(order.id)}">
              <td>
                <div class="list-title">${h(order.order_number)}</div>
                <div class="list-meta">${h(formatDate(order.created_at))}</div>
              </td>
              <td>${badge('orderType', order.order_type || 'DELIVERY')}</td>
              <td>
                <div class="list-title">${h(order.customer_name || order.contact_name || order.receiver_name || '-')}</div>
                <div class="list-meta">${h(orderDetailMeta(order))}</div>
              </td>
              <td class="list-value" style="text-align:left;">
                ${order.order_type === 'COUNSEL' ? '상담예약' : money(order.final_amount)}
                ${order.payment_label ? `<div class="list-meta" style="${/데모|테스트/.test(order.payment_label) ? 'color:#c92a2a;font-weight:700;' : ''}">${h(order.payment_label)}${/데모|테스트/.test(order.payment_label) ? ' · 실제 입금 없음' : ''}</div>` : ''}
              </td>
              <td>
                ${badge('orderStatus', order.order_status)}
                ${order.order_type === 'DELIVERY' || !order.order_type ? `<div style="margin-top:6px;">${badge('deliveryStatus', order.delivery_status)}</div>` : ''}
              </td>
              <td>${renderOrderActions(order)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function orderDetailMeta(order) {
  if (order.order_type === 'COUNSEL') {
    return `${order.contact_phone || order.customer_phone || ''} · 희망 ${order.preferred_at || '-'}${order.has_counsel_note ? ' · 미리 전한 내용 있음' : ''}`;
  }
  if (order.order_type === 'PICKUP') {
    return `${order.contact_phone || order.customer_phone || ''} · 픽업 ${order.preferred_at || '-'}`;
  }
  return `${order.customer_phone || ''} · ${order.address || ''}`.trim();
}

const ORDER_NEXT_LABELS = {
  PREPARING: '상품 준비 시작',
  READY_FOR_PICKUP: '픽업 준비 완료',
  PICKED_UP: '수령 완료',
  SHIPPING: '배송 시작',
  DELIVERED: '배송 완료',
  CONFIRMED: '상담 확정',
  COMPLETED: '상담 완료'
};

// 서버가 알려 준 다음 단계·취소·환불만 버튼으로 보여 준다. 전환 규칙은 서버에서 한 번 더 확인한다.
function renderOrderActions(order) {
  const id = Number(order.id);
  const next = order.next_statuses || [];
  const buttons = next.map((status, index) =>
    status === 'SHIPPING'
      ? `<button class="btn btn-primary btn-sm" type="button" onclick="ship(${id})">${ORDER_NEXT_LABELS.SHIPPING}</button>`
      : `<button class="btn ${index === 0 ? 'btn-primary' : 'btn-outline'} btn-sm" type="button" onclick="updateOrderStatus(${id}, '${status}')">${ORDER_NEXT_LABELS[status] || status}</button>`
  );
  if (order.can_cancel) buttons.push(`<button class="btn btn-danger btn-sm" type="button" onclick="cancelOnlineOrder(${id})">주문 취소</button>`);
  if (order.can_refund) buttons.push(`<button class="btn btn-danger btn-sm" type="button" onclick="refundOnlineOrder(${id})">환불</button>`);
  if (order.has_counsel_note) buttons.push(`<button class="btn btn-outline btn-sm" type="button" onclick="showCounselNote(${id})">상담 내용</button>`);
  buttons.push(`<button class="btn btn-outline btn-sm" type="button" onclick="toggleOrderHistory(${id})">이력</button>`);
  const shipInputs = next.includes('SHIPPING')
    ? `<div class="ship-grid" style="margin-bottom: 6px;">
        <input id="courier-${id}" class="form-control" placeholder="택배사" value="${h(order.courier || 'CJ대한통운')}" />
        <input id="tracking-${id}" class="form-control" placeholder="송장번호" value="${h(order.tracking_number || '')}" />
      </div>`
    : order.tracking_number ? `<div class="list-meta" style="margin-bottom: 6px;">${h(order.courier || '')} ${h(order.tracking_number)}</div>` : '';
  const closed = ['CANCELED', 'REFUNDED'].includes(order.order_status) && order.refund_reason
    ? `<div class="list-meta" style="margin-bottom: 6px;">사유: ${h(order.refund_reason)}</div>`
    : '';
  const paymentNotice = [
    order.cancel_in_progress ? '<div class="list-meta" style="margin-bottom:6px;color:#8a4b00;font-weight:700;">결제사 취소 결과를 확인하는 중입니다. 자동으로 마무리됩니다.</div>' : '',
    order.payment_alert
      ? `<div class="list-meta" style="margin-bottom:6px;color:#c92a2a;font-weight:700;">${h(order.payment_alert)}
          <button class="btn btn-outline btn-sm" type="button" onclick="resolvePaymentAlert(${id})">확인 완료</button></div>`
      : ''
  ].join('');
  return `${paymentNotice}${shipInputs}${closed}<div class="inline-actions">${buttons.join('')}</div>`;
}

// 고객이 상담 예약 때 적은 증상·복용 약. 열 때마다 열람 기록이 남고 고객 앱에도 보인다.
async function showCounselNote(id) {
  const existing = document.getElementById(`counsel-note-${id}`);
  if (existing) return existing.remove();
  try {
    const { note } = await api.request(`/orders/${id}/counsel-note`);
    const row = document.getElementById(`order-row-${id}`);
    if (!row) return;
    row.insertAdjacentHTML('afterend', `
      <tr id="counsel-note-${id}">
        <td colspan="6" style="background: var(--gray-50, #f9fafb);">
          <strong>미리 전한 내용</strong>
          <p style="margin: 6px 0; white-space: pre-wrap;">${note ? h(note) : '고객이 삭제했거나 보관기간이 지나 파기됐습니다.'}</p>
          <span class="list-meta">복약상담 목적으로만 쓰세요. 열람 기록이 남고 고객도 확인할 수 있습니다.</span>
        </td>
      </tr>`);
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleOrderHistory(id) {
  const existing = document.getElementById(`order-history-${id}`);
  if (existing) return existing.remove();
  try {
    const { history } = await api.request(`/orders/${id}`);
    const row = document.getElementById(`order-row-${id}`);
    if (!row) return;
    const actor = { CUSTOMER: '고객', SYSTEM: '결제 시스템', STAFF: '약국' };
    row.insertAdjacentHTML('afterend', `
      <tr id="order-history-${id}">
        <td colspan="6" style="background: var(--gray-50, #f9fafb);">
          ${history.length === 0 ? '<span class="list-meta">기록된 이력이 없습니다. (이력 기록 전에 접수된 주문)</span>' : `
            <ol style="margin: 0; padding-left: 18px; display: grid; gap: 4px;">
              ${history.map((e) => `
                <li class="list-meta">
                  <strong>${h(formatDate(e.created_at))}</strong> · ${h(e.action_label)}
                  ${e.from_label ? `${h(e.from_label)} → ` : ''}${h(e.to_label)}
                  · ${h(e.created_by_name || actor[e.actor_type] || '')}
                  ${e.amount ? ` · ${money(e.amount)}` : ''}${e.reason ? ` · ${h(e.reason)}` : ''}
                </li>`).join('')}
            </ol>`}
        </td>
      </tr>`);
  } catch (error) {
    showToast(error.message);
  }
}

async function resolvePaymentAlert(id) {
  const note = prompt('결제사 취소를 어떻게 확인·처리했는지 적어 주세요. (예: 고객과 통화 후 반송 처리)');
  if (note === null) return;
  try {
    await api.request(`/payments/orders/${id}/alert/resolve`, { method: 'POST', body: { note } });
    showToast('확인 완료로 기록했습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function cancelOnlineOrder(id) {
  const reason = prompt('주문 취소 사유를 입력해 주세요.\n결제가 취소되고 차감했던 재고가 되돌아갑니다.');
  if (reason === null) return;
  try {
    await api.request(`/orders/${id}/cancel`, { method: 'POST', body: { reason } });
    showToast('주문을 취소했습니다. 결제 취소·재고 원복이 함께 처리되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function refundOnlineOrder(id) {
  const reason = prompt('환불 사유를 입력해 주세요. (전액 환불)');
  if (reason === null) return;
  const restock = confirm('돌려받은 상품을 다시 판매할 수 있나요?\n확인: 재고에 다시 넣기 / 취소: 재고에 넣지 않기 (파손·개봉 등)');
  try {
    await api.request(`/orders/${id}/refund`, { method: 'POST', body: { reason, restock } });
    showToast(`환불했습니다.${restock ? ' 재고에 다시 넣었습니다.' : ''}`);
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function updateOrderStatus(id, orderStatus) {
  try {
    await api.request(`/orders/${id}/status`, { method: 'PATCH', body: { order_status: orderStatus } });
    showToast('상태가 변경되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function ship(id) {
  try {
    await api.request(`/orders/${id}/status`, {
      method: 'PATCH',
      body: {
        order_status: 'SHIPPING',
        courier: $(`#courier-${id}`).value,
        tracking_number: $(`#tracking-${id}`).value
      }
    });
    showToast('배송중으로 변경되었습니다.');
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}
