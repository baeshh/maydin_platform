// MAYDIN 파트너센터 · 직원 관리
function toggleStaffForm(show) {
  if (show) openModal('staffModal', 'staffName');
  else closeModal('staffModal');
}

const STAFF_PAGE_SIZE = 10;
const staffState = { all: [], query: '', page: 1 };

function staffName(id) {
  return staffState.all.find((s) => s.id === id)?.name || '직원';
}

function renderStaff(staff) {
  staffState.all = staff;
  renderStaffPage();
}

function searchStaff(value) {
  staffState.query = value.trim().toLowerCase();
  staffState.page = 1;
  renderStaffPage();
}

function goStaffPage(page) {
  staffState.page = page;
  renderStaffPage();
  $('#staff').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderStaffPage() {
  const { all, query } = staffState;
  const { items, totalPages, start, pageItems } = paginate(
    staffState,
    (s, q) => {
      const digits = q.replace(/\D/g, '');
      return [s.name, s.email].some((value) => String(value || '').toLowerCase().includes(q)) ||
        (digits.length >= 3 && String(s.phone || '').replace(/\D/g, '').includes(digits));
    },
    STAFF_PAGE_SIZE
  );
  const active = all.filter((s) => s.status === 'ACTIVE').length;
  $('#staffListCount').textContent = query
    ? `검색 결과 ${items.length.toLocaleString()}명 / 전체 ${all.length.toLocaleString()}명`
    : `전체 ${all.length.toLocaleString()}명 · 사용 중 ${active.toLocaleString()}명`;
  if (all.length === 0) {
    $('#staffTable').innerHTML = renderEmpty('등록된 POS 직원이 없습니다. 카운터 직원 계정을 만들어 주세요.');
    return;
  }
  if (items.length === 0) {
    $('#staffTable').innerHTML = renderEmpty(`'${query}'에 맞는 직원이 없습니다.`);
    return;
  }
  $('#staffTable').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="row-no">번호</th><th>직원</th><th>로그인 이메일</th><th>상태</th><th>오늘 판매</th><th>최근 POS 활동</th><th>관리</th></tr></thead>
        <tbody>
          ${pageItems.map((s, index) => `
            <tr>
              <td class="row-no">${start + index + 1}</td>
              <td><div class="list-title">${h(s.name)}</div><div class="list-meta">${h(s.phone || '연락처 없음')}</div></td>
              <td>${h(s.email)}</td>
              <td>${s.status === 'ACTIVE' ? '<span class="badge green">사용 중</span>' : '<span class="badge gray">사용 중지</span>'}</td>
              <td>${Number(s.today_sale_count || 0).toLocaleString()}건</td>
              <td class="list-meta">${h(formatDate(s.last_pos_activity_at))}</td>
              <td>
                <div class="inline-actions">
                  <button class="btn btn-outline btn-sm" type="button" onclick="resetStaffPassword(${Number(s.id)})">비밀번호 재설정</button>
                  ${s.status === 'ACTIVE'
                    ? `<button class="btn btn-danger btn-sm" type="button" onclick="setStaffStatus(${Number(s.id)}, 'INACTIVE')">사용 중지</button>`
                    : `<button class="btn btn-primary btn-sm" type="button" onclick="setStaffStatus(${Number(s.id)}, 'ACTIVE')">사용 재개</button>`}
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ${pagerHtml(staffState.page, totalPages, 'goStaffPage')}
  `;
}

async function reloadStaff() {
  const data = await api.request('/staff');
  renderStaff(data.staff);
}

async function setStaffStatus(id, status) {
  const name = staffName(id);
  const text = status === 'INACTIVE' ? `${name} 직원 계정을 사용 중지할까요? 즉시 POS에 로그인할 수 없게 됩니다.` : `${name} 직원 계정을 다시 사용할까요?`;
  if (!confirm(text)) return;
  try {
    await api.request(`/staff/${id}`, { method: 'PATCH', body: { status } });
    showToast(status === 'INACTIVE' ? '계정을 사용 중지했습니다.' : '계정을 다시 사용합니다.');
    reloadStaff();
  } catch (error) {
    showToast(error.message);
  }
}

async function resetStaffPassword(id) {
  const password = prompt(`${staffName(id)} 직원의 새 비밀번호 (영문+숫자 8자 이상)`);
  if (!password) return;
  try {
    await api.request(`/staff/${id}/reset-password`, { method: 'POST', body: { password } });
    showToast('비밀번호를 재설정했습니다. 직원에게 새 비밀번호를 전달해 주세요.');
  } catch (error) {
    showToast(error.message);
  }
}

$('#staffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api.request('/staff', { method: 'POST', body: serializeForm(event.target) });
    event.target.reset();
    toggleStaffForm(false);
    showToast(`${data.staff.name} 직원 계정을 만들었습니다. POS 로그인: ${data.staff.email}`);
    reloadStaff();
  } catch (error) {
    showToast(error.message);
  }
});
