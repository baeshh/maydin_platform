// MAYDIN 파트너센터 · 포인트
const POINT_ENTRY_LABELS = { EARN: '적립', USE: '사용', EARN_CANCEL: '적립 취소', USE_RESTORE: '사용 복원', ADJUST: '수동 조정', REWARD: '추천 보상' };

async function togglePointPolicy(show) {
  const form = $('#pointPolicyForm');
  form.hidden = show === undefined ? !form.hidden : !show;
  if (form.hidden) return;
  try {
    const { policy } = await api.request('/points/settings');
    $('#pointEnabled').checked = policy.enabled;
    $('#pointEarnRate').value = policy.earn_rate;
    $('#pointMinUse').value = policy.min_use;
  } catch (error) {
    showToast(error.message);
  }
}

$('#pointPolicyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const { policy } = await api.request('/points/settings', {
      method: 'PATCH',
      body: {
        enabled: $('#pointEnabled').checked,
        earn_rate: Number($('#pointEarnRate').value),
        min_use: Number($('#pointMinUse').value)
      }
    });
    showToast(`포인트 정책을 저장했습니다. (${policy.enabled ? `적립 ${policy.earn_rate}%` : '사용 중지'})`);
    togglePointPolicy(false);
  } catch (error) {
    showToast(error.message);
  }
});

function renderPointPanel(data) {
  const { customer, ledger } = data;
  const panel = $('#pointPanel');
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card-header" style="margin-bottom: 10px;">
      <h3 class="card-title" style="font-size: 16px;">${h(customer.name)} · 보유 ${Number(customer.point_balance).toLocaleString()}P</h3>
      <button class="muted-link" type="button" onclick="$('#pointPanel').hidden = true">닫기</button>
    </div>
    <form class="inline-actions" style="margin-bottom: 12px;" onsubmit="adjustPoints(event, ${customer.id})">
      <input class="form-control" name="points" type="number" step="1" placeholder="+500 / -300" style="width: 130px;" required />
      <input class="form-control" name="reason" placeholder="조정 사유 (필수)" style="flex: 1; min-width: 160px;" required />
      <button class="btn btn-primary btn-sm" type="submit">수동 조정</button>
    </form>
    <div class="table-wrap">
      <table>
        <thead><tr><th>일시</th><th>구분</th><th>포인트</th><th>잔액</th></tr></thead>
        <tbody>
          ${
            ledger
              .map(
                (l) => `<tr>
                  <td>${h(formatDate(l.created_at))}</td>
                  <td>${POINT_ENTRY_LABELS[l.entry_type] || h(l.entry_type)}<div class="list-meta">${h(l.order_number || l.reason || '')}${l.created_by_name ? ` · ${h(l.created_by_name)}` : ''}</div></td>
                  <td style="font-weight: 800; color: ${l.points > 0 ? '#3182f6' : '#f04452'};">${l.points > 0 ? '+' : ''}${l.points.toLocaleString()}P</td>
                  <td>${l.balance_after.toLocaleString()}P</td>
                </tr>`
              )
              .join('') || '<tr><td colspan="4">포인트 내역이 없습니다.</td></tr>'
          }
        </tbody>
      </table>
    </div>
  `;
}

async function openCustomerPoints(id) {
  try {
    renderPointPanel(await api.request(`/points/customers/${id}`));
    $('#customerPanel').hidden = true;
    $('#pointPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showToast(error.message);
  }
}

async function adjustPoints(event, id) {
  event.preventDefault();
  const form = event.target;
  try {
    const data = await api.request(`/points/customers/${id}/adjust`, {
      method: 'POST',
      body: { points: Number(form.points.value), reason: form.reason.value }
    });
    showToast(`포인트를 조정했습니다. 잔액 ${data.balance.toLocaleString()}P`);
    renderPointPanel(data);
    const { customers } = await api.request('/dashboard/customers');
    renderCustomers(customers);
  } catch (error) {
    showToast(error.message);
  }
}
