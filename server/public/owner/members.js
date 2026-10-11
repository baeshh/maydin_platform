// MAYDIN 파트너센터 · 회원 분석·회원 기준·명단 내려받기
/* ---------- 회원 분석 ---------- */

const memberState = { page: 1, labels: null, filtersReady: false };

function memberQuery(extra = {}) {
  const params = new URLSearchParams();
  $('#memberFilters').querySelectorAll('input, select').forEach((el) => {
    if (el.type === 'checkbox') {
      if (el.checked) params.set(el.name, el.value);
    } else if (el.value) params.set(el.name, el.value);
  });
  Object.entries(extra).forEach(([key, value]) => params.set(key, value));
  return params.toString();
}

function setupMemberFilters(L) {
  if (memberState.filtersReady) return;
  memberState.filtersReady = true;
  const box = $('#memberFilters');
  const fill = (name, entries) => box.querySelector(`[name=${name}]`).insertAdjacentHTML('beforeend', entries.map(([k, v]) => `<option value="${k}">${h(v)}</option>`).join(''));
  fill('grade', ['VIP', 'GOLD', 'SILVER', 'BASIC'].map((k) => [k, L.grades[k]]));
  fill('status', Object.entries(L.statuses));
  fill('tier', Object.entries(L.tiers));
  fill('age', L.age_bands.map((a) => [a, a]));
  fill('family', Object.entries(L.family_filters));
  let timer;
  box.addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      memberState.page = 1;
      loadMemberList();
    }, event.target.name === 'q' ? 300 : 0);
  });
}

function filterMembersBy(name, value) {
  const box = $('#memberFilters');
  box.querySelectorAll('select').forEach((el) => {
    if (el.name !== 'sort') el.value = '';
  });
  box.querySelectorAll('input[type=checkbox]').forEach((el) => (el.checked = false));
  box.querySelector('[name=q]').value = '';
  const target = box.querySelector(`[name=${name}]`);
  if (target.type === 'checkbox') target.checked = true;
  else target.value = value;
  memberState.page = 1;
  loadMemberList();
  $('#memberFilters').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function countBars(rows, labelOf, colorOf, filterName) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  if (!total) return '<p class="list-meta">회원이 없습니다.</p>';
  return rows.filter((r) => r.count > 0 || r.key !== null).map((r) => {
    const share = r.count / total;
    const clickable = filterName && r.key !== null;
    return `<div class="share-row" ${clickable ? `style="cursor: pointer;" onclick="filterMembersBy('${filterName}', '${h(r.key)}')"` : ''} title="${h(labelOf(r.key))} · ${r.count}명 · 12개월 ${money(r.net_12m)}">
      <span>${h(labelOf(r.key))}</span>
      <div class="track"><div class="fill" style="width:${share * 100}%;${colorOf ? `background:${colorOf(r.key)}` : ''}"></div></div>
      <span>${r.count.toLocaleString()}명 · ${Math.round(share * 1000) / 10}%</span>
    </div>`;
  }).join('');
}

function renderMemberSummary(data) {
  const { totals: t, labels: L } = data;
  const pct = (v) => (v == null ? '-' : `${v}%`);
  $('#memberSummary').classList.remove('loading');
  $('#memberSummary').innerHTML = `
    <div class="report-metrics">
      <div class="report-metric"><span>전체 회원</span><strong>${t.members.toLocaleString()}명</strong><small>이번 달 신규 ${t.new_signups_this_month.toLocaleString()}명</small></div>
      <div class="report-metric"><span>최근 90일 구매 회원</span><strong>${t.active_90d.toLocaleString()}명</strong><small>구매 경험 ${t.purchasers.toLocaleString()}명</small></div>
      <div class="report-metric"><span>재구매율</span><strong>${pct(t.repeat_rate)}</strong><small>구매 회원 중 2회 이상 구매</small></div>
      <div class="report-metric"><span>평균 구매 주기</span><strong>${t.median_interval_days == null ? '-' : `${t.median_interval_days}일`}</strong><small>재구매 회원 중앙값</small></div>
      <div class="report-metric"><span>회원 1회 평균 결제</span><strong>${t.avg_ticket == null ? '-' : money(t.avg_ticket)}</strong><small>반품 차감 기준</small></div>
      <div class="report-metric"><span>회원 식별률</span><strong>${pct(t.member_sale_rate)}</strong><small>최근 12개월 결제 중 회원 결제 · 매출 비중 ${pct(t.member_sales_share)}</small></div>
      <div class="report-metric clickable" onclick="filterMembersBy('status', 'AT_RISK')"><span>이탈 위험 · 휴면</span><strong>${t.at_risk.toLocaleString()}명 · ${t.dormant.toLocaleString()}명</strong><small>눌러서 이탈 위험 회원 보기</small></div>
      <div class="report-metric clickable" onclick="filterMembersBy('birthday', '1')"><span>이번 달 생일 · 마케팅 동의</span><strong>${t.birthdays_this_month.toLocaleString()}명 · ${t.marketing_agreed.toLocaleString()}명</strong><small>눌러서 생일 회원 보기</small></div>
      <div class="report-metric clickable" onclick="filterMembersBy('refill', '1')"><span>재구매 예정</span><strong>${t.refill_due.toLocaleString()}명</strong><small>복용 기간상 곧 떨어지는 상품이 있는 회원</small></div>
    </div>
    <div class="member-dist">
      <div class="chart-box"><h4>등급 (최근 12개월 순구매)</h4>${countBars(data.grades, (k) => L.grades[k], (k) => L.grade_colors[k], 'grade')}</div>
      <div class="chart-box"><h4>회원 상태</h4>${countBars(data.statuses, (k) => L.statuses[k], null, 'status')}</div>
      <div class="chart-box"><h4>1회 평균 결제 금액대</h4>${countBars(data.tiers, (k) => L.tiers[k], null, 'tier')}</div>
      <div class="chart-box"><h4>연령대 (입력 회원)</h4>${countBars(data.ages, (k) => k || '미입력', null, 'age')}</div>
      <div class="chart-box"><h4>성별</h4>${countBars(data.genders, (k) => L.genders[k] || '미입력', null, 'gender')}</div>
      <div class="chart-box"><h4>가입 경로 (구매 회원)</h4>${data.channels.length ? data.channels.map((c) => `<div class="share-row">
        <span>${h(c.key || '기본 가입 링크')}</span>
        <div class="track"><div class="fill" style="width:${c.count ? (c.purchasers / c.count) * 100 : 0}%"></div></div>
        <span>${c.purchasers}/${c.count}명</span>
      </div>`).join('') : '<p class="list-meta">회원이 없습니다.</p>'}</div>
    </div>`;
}

function renderMemberTable(data) {
  const L = data.labels;
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  $('#memberTable').innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>회원</th><th>등급 · 상태</th><th>최근 구매</th><th class="num">구매 횟수</th><th class="num">12개월 순구매</th><th class="num">1회 평균</th><th class="num">평균 주기</th><th class="num">포인트</th><th>수신</th></tr></thead>
      <tbody>${data.members.map((m) => `<tr class="clickable-row" onclick="openCustomerInfo(${m.id}, '#memberDetail')">
        <td><strong>${h(m.name)}</strong>${m.birthday_this_month ? ' <span class="badge orange">생일</span>' : ''}${m.refill_due.length ? ` <span class="badge blue" title="${h(m.refill_due.map((r) => `${r.product_name} ${r.runout_date}`).join(', '))}">재구매 ${m.refill_due.length}</span>` : ''}<div class="list-meta">${h(m.member_code || '')}${m.family_text ? ` · 가족 ${h(m.family_text)}` : ''}</div></td>
        <td>${gradeBadge(m.grade, L)} ${statusBadge(m.status, L)}</td>
        <td>${daysAgoText(m.days_since_last)}</td>
        <td class="num">${m.visit_count.toLocaleString()}</td>
        <td class="num">${money(m.net_12m)}</td>
        <td class="num">${m.avg_ticket == null ? '-' : money(m.avg_ticket)}</td>
        <td class="num">${m.avg_interval_days == null ? '-' : `${m.avg_interval_days}일`}</td>
        <td class="num">${m.point_balance.toLocaleString()}P</td>
        <td>${m.marketing_agree ? '<span class="badge green">동의</span>' : '<span class="badge gray">미동의</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="9">조건에 맞는 회원이 없습니다.</td></tr>'}</tbody>
    </table></div>
    <div class="inline-actions" style="justify-content: space-between; margin-top: 10px;">
      <span class="list-meta">${data.total.toLocaleString()}명 중 ${data.total ? (data.page - 1) * data.page_size + 1 : 0}~${Math.min(data.total, data.page * data.page_size)}</span>
      <span class="inline-actions">
        <button class="btn btn-outline btn-sm" type="button" ${data.page <= 1 ? 'disabled' : ''} onclick="memberState.page -= 1; loadMemberList()">이전</button>
        <span class="list-meta">${data.page} / ${pages}</span>
        <button class="btn btn-outline btn-sm" type="button" ${data.page >= pages ? 'disabled' : ''} onclick="memberState.page += 1; loadMemberList()">다음</button>
      </span>
    </div>`;
}

async function loadMemberList() {
  try {
    renderMemberTable(await api.request(`/members?${memberQuery({ page: memberState.page })}`));
  } catch (error) {
    $('#memberTable').innerHTML = renderEmpty(error.message);
  }
}

async function loadMembers() {
  try {
    const summary = await api.request('/members/summary');
    memberState.labels = summary.labels;
    setupMemberFilters(summary.labels);
    renderMemberSummary(summary);
    await loadMemberList();
  } catch (error) {
    $('#memberSummary').innerHTML = renderEmpty(error.message);
  }
}

const POLICY_GROUPS = [
  ['등급 기준 (최근 12개월 순구매, 원)', ['silver_min', 'gold_min', 'vip_min'], 1000],
  ['등급별 추가 적립률 (%p, 기본 적립률에 더함)', ['silver_bonus', 'gold_bonus', 'vip_bonus'], 0.1],
  ['회원 상태 기준', ['new_days', 'churn_multiplier', 'dormant_days'], null],
  ['혜택', ['birthday_multiplier', 'referral_reward'], null]
];
const POLICY_STEPS = { new_days: 1, churn_multiplier: 0.1, dormant_days: 1, birthday_multiplier: 0.1, referral_reward: 100 };

async function toggleMemberPolicy() {
  const form = $('#memberPolicyForm');
  form.hidden = !form.hidden;
  if (form.hidden) return;
  try {
    const { policy, labels: L } = await api.request('/members/policy');
    form.innerHTML = `
      ${POLICY_GROUPS.map(([title, keys, step]) => `
        <h4>${h(title)}</h4>
        <div class="policy-grid">
          ${keys.map((key) => `<div class="form-group" style="margin: 0;">
            <label class="form-label">${h(L.policy_fields[key])}</label>
            <input class="form-control" name="${key}" type="number" step="${step || POLICY_STEPS[key]}" value="${policy[key]}" required />
          </div>`).join('')}
        </div>`).join('')}
      <p class="list-meta" style="margin: 0 0 12px;">
        신규: 첫 구매 후 정한 기간 이내 · 이탈 위험: 평소 구매 간격의 정한 배수가 지나도록 구매 없음 · 휴면: 정한 일수 이상 구매 없음.
        생일 달에는 POS 적립 포인트에 배수가 적용되고, 추천 보상은 추천받아 가입한 회원의 첫 구매 후 두 사람에게 지급됩니다. 일반의약품과 분류 전 상품은 적립 대상이 아닙니다.
      </p>
      <div class="inline-actions">
        <button class="btn btn-primary btn-sm" type="submit">저장</button>
        <button class="btn btn-outline btn-sm" type="button" onclick="$('#memberPolicyForm').hidden = true">닫기</button>
      </div>`;
  } catch (error) {
    showToast(error.message);
  }
}

async function saveMemberPolicy(event) {
  event.preventDefault();
  const body = Object.fromEntries([...new FormData(event.target).entries()].map(([k, v]) => [k, Number(v)]));
  try {
    await api.request('/members/policy', { method: 'PATCH', body });
    showToast('등급·혜택 기준을 저장했습니다.');
    $('#memberPolicyForm').hidden = true;
    loadMembers();
  } catch (error) {
    showToast(error.message);
  }
}

async function downloadMembersCsv() {
  try {
    const res = await fetch(`/api/members/export.csv?${memberQuery()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'CSV를 내려받지 못했습니다.');
    const match = (res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/);
    const filename = match ? decodeURIComponent(match[1]) : 'members.csv';
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${filename} 파일을 내려받았습니다. 연락처는 마케팅 수신 동의 회원만 포함됩니다.`);
  } catch (error) {
    showToast(error.message);
  }
}
