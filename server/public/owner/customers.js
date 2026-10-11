// MAYDIN 파트너센터 · 회원 목록·회원 정보·동의·건강 정보·가입 승인
function renderCustomers(customers) {
  $('#customerListCount').textContent = `${customers.length.toLocaleString()}명`;
  loadSignupRequests();
  if (customers.length === 0) {
    $('#customerList').innerHTML = renderEmpty('아직 가입한 고객이 없습니다.');
    return;
  }

  $('#customerList').innerHTML = `
    <div class="list-stack">
      ${customers.slice(0, 6).map((customer) => `
        <div class="list-item">
          <div>
            <div class="list-title">${h(customer.name)}</div>
            <div class="list-meta">${h(customer.phone || customer.email)}<br />주문 ${Number(customer.order_count || 0).toLocaleString()}건 · 최근 ${h(formatDate(customer.last_order_at))}</div>
          </div>
          <div class="list-value" style="text-align: right;">
            누적 ${money(customer.total_purchase_amount)}
            <div>
              <button class="muted-link" type="button" onclick="openCustomerInfo(${customer.id}, '#customerPanel')">회원 정보</button>
              · <button class="muted-link" type="button" onclick="openCustomerPoints(${customer.id})">포인트 ${Number(customer.point_balance || 0).toLocaleString()}P</button>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  loadConsentRenewals();
}

/* ---------- 회원 정보 · 동의 ---------- */

let customerLabels = null;

function consentStatus(c) {
  if (!c.recorded) return '<span class="badge gray">기록 없음</span>';
  return c.agreed ? '<span class="badge green">동의</span>' : '<span class="badge red">미동의</span>';
}

function birthdayText(customer) {
  return customer.birth_month ? `${customer.birth_month}월 ${customer.birth_day}일` : '-';
}

let customerPanelTarget = '#customerPanel';

function gradeBadge(grade, L) {
  return `<span class="grade-badge" style="background:${L.grade_colors[grade]}">${h(L.grades[grade])}</span>`;
}

function statusBadge(status, L) {
  const color = { NEW: 'blue', ACTIVE: 'green', ONE_TIME: 'gray', AT_RISK: 'orange', DORMANT: 'red', NO_PURCHASE: 'gray' }[status];
  return `<span class="badge ${color}">${h(L.statuses[status])}</span>`;
}

function daysAgoText(days) {
  if (days == null) return '-';
  return days === 0 ? '오늘' : `${days.toLocaleString()}일 전`;
}

function memberInsightHtml(insight) {
  if (!insight) return '';
  const { metrics: m, behavior: b, labels: L } = insight;
  const join = (rows, fmt) => (rows && rows.length ? rows.map(fmt).join(', ') : '-');
  return `
    <div class="insight-box">
      <div class="inline-actions" style="margin-bottom: 10px;">
        ${gradeBadge(m.grade, L)} ${statusBadge(m.status, L)}
        ${m.birthday_this_month ? '<span class="badge orange">이번 달 생일</span>' : ''}
        <span class="list-meta">
          ${m.next_grade ? `${h(m.next_grade.label)}까지 ${money(m.next_grade.remaining)} 남음` : '최고 등급'}
          ${m.grade_bonus ? ` · 추가 적립 +${m.grade_bonus}%p` : ''}
        </span>
      </div>
      <div class="profile-grid" style="margin-bottom: 0;">
        <div><span>최근 12개월 순구매</span><strong>${money(m.net_12m)}</strong></div>
        <div><span>누적 순구매</span><strong>${money(m.net_total)}</strong></div>
        <div><span>구매 횟수 (12개월)</span><strong>${m.visit_count.toLocaleString()}회 (${m.visits_12m}회)</strong></div>
        <div><span>1회 평균 결제</span><strong>${m.avg_ticket == null ? '-' : `${money(m.avg_ticket)} · ${h(L.tiers[m.amount_tier])}`}</strong></div>
        <div><span>월 평균 지출</span><strong>${money(m.monthly_spend)}</strong></div>
        <div><span>평균 구매 주기</span><strong>${m.avg_interval_days == null ? '-' : `${m.avg_interval_days}일`}</strong></div>
        <div><span>최근 구매</span><strong>${daysAgoText(m.days_since_last)}</strong></div>
        <div><span>다음 방문 예상</span><strong>${h(m.expected_next_at || '-')}</strong></div>
        ${b ? `
          <div><span>선호 채널</span><strong>${join(b.channels, (c) => `${h(c.label)} ${c.count}`)}</strong></div>
          <div><span>주 결제수단</span><strong>${join(b.payments.slice(0, 2), (p) => `${h(p.label)} ${p.count}`)}</strong></div>
          <div><span>자주 오는 때</span><strong>${join(b.weekdays, (w) => `${w.label}요일`)}${b.hour_bands[0] ? ` · ${h(b.hour_bands[0].key)}` : ''}</strong></div>
          <div><span>할인·포인트 사용</span><strong>${b.discount_rate}%</strong></div>
          <div style="grid-column: span 2;"><span>선호 카테고리</span><strong>${join(b.top_categories, (c) => `${h(c.name)} (${money(c.amount)})`)}</strong></div>
          <div style="grid-column: span 2;"><span>선호 브랜드</span><strong>${join(b.top_brands, (c) => h(c.name))}</strong></div>` : ''}
      </div>
      ${b && b.refills.length ? `
        <div style="margin-top: 12px;">
          <span class="list-meta" style="font-weight: 800;">다음 구매 예상 (복용·사용 기간 기준)</span>
          <div class="inline-actions" style="margin-top: 6px;">
            ${b.refills.map((r) => `<span class="badge ${r.due ? 'orange' : 'gray'}" title="마지막 구매 ${h(formatDate(r.last_purchase_at))} · ${r.qty}개 × ${r.supply_days}일">
              ${h(r.product_name)} · ${h(r.runout_date)} (${r.days_left >= 0 ? `${r.days_left}일 남음` : `${-r.days_left}일 지남`})
            </span>`).join('')}
          </div>
        </div>` : ''}
      ${b && b.recent_orders.length ? `
        <details style="margin-top: 10px;">
          <summary class="muted-link" style="cursor: pointer;">최근 구매 ${b.recent_orders.length}건</summary>
          <div class="table-wrap" style="margin-top: 8px;">
            <table class="consent-table">
              <thead><tr><th>일시</th><th>상품</th><th>금액</th></tr></thead>
              <tbody>${b.recent_orders.map((o) => `<tr>
                <td>${h(formatDate(o.created_at))}</td>
                <td>${h(o.items || '-')}${o.item_count > 3 ? ` 외 ${o.item_count - 3}건` : ''}</td>
                <td style="font-weight: 800; color: ${o.final_amount < 0 ? '#f04452' : 'inherit'};">${money(o.final_amount)}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </details>` : ''}
    </div>`;
}

function renderCustomerPanel(data, insight) {
  const { customer, consents, consent_history: history, labels: L } = data;
  customerLabels = L;
  const panel = $(customerPanelTarget);
  if (customerPanelTarget === '#customerPanel') $('#pointPanel').hidden = true;
  panel.hidden = false;
  const withdrawable = Object.entries(consents).filter(([, c]) => !c.required && c.agreed);
  const marketingAgreed = Object.entries(consents).some(([type, c]) => c.agreed && ['MARKETING_SMS', 'MARKETING_KAKAO'].includes(type));
  panel.innerHTML = `
    <div class="card-header" style="margin-bottom: 10px;">
      <h3 class="card-title" style="font-size: 16px;">${h(customer.name)} · ${h(customer.member_code || '')}</h3>
      <button class="muted-link" type="button" onclick="$('${customerPanelTarget}').hidden = true">닫기</button>
    </div>
    ${memberInsightHtml(insight)}
    <div class="profile-grid">
      <div><span>휴대폰</span><strong>${h(customer.phone || '-')}</strong></div>
      <div><span>가입일</span><strong>${h(formatDate(customer.created_at))}</strong></div>
      <div><span>생일</span><strong>${h(birthdayText(customer))}</strong></div>
      <div><span>출생연도 · 성별</span><strong>${customer.birth_year ? `${customer.birth_year}년` : '-'} · ${h(L.genders[customer.gender] || '-')}</strong></div>
      <div><span>가입 경로</span><strong>${h(customer.signup_channel_name || '기본 가입 링크')}</strong></div>
      <div><span>추천인</span><strong>${h(customer.referrer_name || '-')}</strong></div>
      <div><span>추천 코드 · 추천한 회원</span><strong>${h(customer.referral_code || '-')} · ${Number(customer.referred_count || 0)}명</strong></div>
      <div><span>가입 상태</span><strong>${approvalText(customer)}</strong></div>
      <div><span>로그인 PIN</span><strong>${pinStatusText(customer)}</strong></div>
      <div><span>온라인 주문</span><strong>${data.online_order?.allowed ? '<span class="badge green">가능</span>' : '<span class="badge gray">매장 구매 인증 전</span>'}</strong></div>
    </div>
    ${customer.withdrawn_at ? `<p class="list-meta" style="margin: 0 0 14px;">${h(formatDate(customer.withdrawn_at))} 탈퇴한 회원입니다. 개인정보는 파기됐고, 거래 기록만 법정 보존기간 동안 남아 있습니다.</p>` : `
    <div class="inline-actions" style="margin-bottom: 14px;">
      ${customer.approval_status === 'APPROVED' ? `<button class="btn btn-outline btn-sm" type="button" onclick="issuePinCode(${customer.id}, ${customer.pin_set ? 1 : 0})">${customer.pin_set ? 'PIN 재설정 코드 발급' : 'PIN 설정 코드 발급'}</button>` : ''}
      ${customer.has_health || consents.HEALTH_INFO?.agreed
        ? `<button class="btn btn-outline btn-sm" type="button" onclick="showCustomerHealth(${customer.id})">알레르기·복용 약 ${customer.has_health ? '보기' : '입력'}</button>`
        : '<span class="list-meta">건강 정보 없음 (고객이 앱에서 동의하지 않음)</span>'}
      <button class="btn btn-outline btn-sm" type="button" onclick="showHealthAccessLog(${customer.id})">건강 정보 이용 기록</button>
    </div>`}
    <div id="pinCodeBox-${customer.id}"></div>
    <div id="healthBox-${customer.id}"></div>
    <div id="healthLogBox-${customer.id}"></div>
    <details style="margin-bottom: 14px;">
      <summary class="muted-link" style="cursor: pointer;">선택 정보 수정 (고객이 요청한 경우)</summary>
      <form class="inline-actions" style="margin-top: 10px;" onsubmit="saveCustomerProfile(event, ${customer.id})">
        <input class="form-control" name="birth_month" type="number" min="1" max="12" placeholder="월" value="${customer.birth_month || ''}" style="width: 70px;" />
        <input class="form-control" name="birth_day" type="number" min="1" max="31" placeholder="일" value="${customer.birth_day || ''}" style="width: 70px;" />
        <input class="form-control" name="birth_year" type="number" min="1900" max="${new Date().getFullYear()}" placeholder="출생연도" value="${customer.birth_year || ''}" style="width: 100px;" />
        <select class="form-control" name="gender" style="width: auto;">
          <option value="">성별 선택 안 함</option>
          ${Object.entries(L.genders).map(([key, label]) => `<option value="${key}" ${customer.gender === key ? 'selected' : ''}>${h(label)}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" type="submit">저장</button>
      </form>
    </details>
    ${familyHtml(data.family, customer.id, L)}
    <div class="table-wrap">
      <table class="consent-table">
        <thead><tr>${withdrawable.length ? '<th></th>' : ''}<th>동의 항목</th><th>상태</th><th>최근 변경</th></tr></thead>
        <tbody>
          ${Object.entries(consents).map(([type, c]) => `<tr>
            ${withdrawable.length ? `<td>${!c.required && c.agreed ? `<input type="checkbox" data-withdraw="${type}" />` : ''}</td>` : ''}
            <td>${c.required ? '<b>[필수]</b> ' : ''}${h(c.label)}</td>
            <td>${consentStatus(c)}</td>
            <td>${c.recorded ? `${h(formatDate(c.updated_at))}<div class="list-meta">${h(L.consent_sources[c.source] || c.source)} · ${h(c.version)}</div>` : '-'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="inline-actions" style="margin: 10px 0 14px;">
      ${withdrawable.length ? `<button class="btn btn-outline btn-sm" type="button" onclick="withdrawConsents(${customer.id})">선택 항목 철회 (고객 요청)</button>` : ''}
      ${marketingAgreed ? `<button class="btn btn-outline btn-sm" type="button" onclick="noticeConsents(${customer.id})">수신 동의 재확인 안내 완료</button>` : ''}
    </div>
    <p class="list-meta" style="margin: 0 0 12px;">
      약국에서는 고객이 요청한 철회만 대신 처리할 수 있습니다. 동의는 고객이 앱의 내 정보에서 직접 해야 합니다.
      마케팅 수신 동의는 2년마다 고객에게 동의 사실을 안내해야 하며, 안내 후 '재확인 안내 완료'를 눌러 기록해 주세요.
    </p>
    <details>
      <summary class="muted-link" style="cursor: pointer;">동의 변경 이력 ${history.length}건</summary>
      <div class="table-wrap" style="margin-top: 8px;">
        <table class="consent-table">
          <thead><tr><th>일시</th><th>항목</th><th>내용</th><th>경로</th></tr></thead>
          <tbody>
            ${history.map((row) => `<tr>
              <td>${h(formatDate(row.created_at))}</td>
              <td>${h(L.consent_types[row.consent_type] || row.consent_type)}</td>
              <td>${row.source === 'NOTICE' ? '재확인 안내' : row.agreed ? '동의' : row.source === 'SIGNUP' ? '미동의' : '철회'}</td>
              <td>${h(L.consent_sources[row.source] || row.source)}${row.created_by_name ? ` · ${h(row.created_by_name)}` : ''}</td>
            </tr>`).join('') || '<tr><td colspan="4">기록이 없습니다.</td></tr>'}
          </tbody>
        </table>
      </div>
    </details>
    ${customer.withdrawn_at || customer.approval_status !== 'APPROVED' ? '' : `
    <details style="margin-top: 14px;">
      <summary class="muted-link" style="cursor: pointer;">회원 탈퇴 처리 (고객 요청)</summary>
      <form style="margin-top: 10px;" onsubmit="withdrawCustomer(event, ${customer.id})">
        <p class="list-meta" style="margin: 0 0 8px;">
          고객이 방문·전화로 탈퇴를 요청한 경우에만 처리합니다. 이름·연락처·생년월일·건강 정보·상담 내용·포인트·주소가 바로 파기되고 되돌릴 수 없습니다.
          거래 기록은 이름·연락처 없이 법정 보존기간 동안 남습니다. 고객은 앱의 내 정보에서 직접 탈퇴할 수도 있습니다.
        </p>
        <div class="inline-actions">
          <input class="form-control" name="reason" maxlength="200" placeholder="요청 경로 (예: 매장 방문, 전화)" required style="flex: 1; min-width: 180px;" />
          <label class="list-meta" style="display: inline-flex; gap: 6px; align-items: center;"><input type="checkbox" name="identity_checked" required /> 본인 확인함</label>
          <button class="btn btn-danger btn-sm" type="submit">탈퇴 처리</button>
        </div>
      </form>
    </details>`}
  `;
}

async function withdrawCustomer(event, id) {
  event.preventDefault();
  const form = event.target;
  if (!confirm('이 회원을 탈퇴 처리할까요?\n개인정보와 포인트가 바로 파기되며 되돌릴 수 없습니다.')) return;
  try {
    await api.request(`/customers/${id}/withdraw`, {
      method: 'POST',
      body: { reason: form.reason.value, identity_checked: form.identity_checked.checked }
    });
    showToast('탈퇴 처리했습니다.');
    openCustomerInfo(id);
  } catch (error) {
    showToast(error.message);
  }
}

function familyHtml(family, customerId, L) {
  if (!family) return '';
  const relationOptions = Object.entries(L.relations).map(([key, label]) => `<option value="${key}">${h(label)}</option>`).join('');
  const year = new Date().getFullYear();
  let yearOptions = '<option value="">출생연도</option>';
  for (let y = year; y >= 1920; y -= 1) yearOptions += `<option value="${y}">${y}년</option>`;
  if (family.linked_to) {
    return `
      <div class="insight-box" style="margin-bottom: 14px;">
        <strong>가족</strong>
        <p class="list-meta" style="margin: 6px 0 0;">
          ${h(family.linked_to.head_name)}(${h(family.linked_to.head_member_code || '')}) 회원의 ${h(family.linked_to.relation_label)}(으)로 연결되어 있습니다.
          <button class="muted-link" type="button" onclick="openCustomerInfo(${family.linked_to.head_id})">대표 회원 보기</button>
        </p>
      </div>`;
  }
  return `
    <div class="insight-box" style="margin-bottom: 14px;">
      <div class="card-header" style="margin-bottom: 6px;">
        <strong>가족 ${family.members.length}명</strong>
        ${family.household ? `<span class="list-meta">가족 합산 12개월 구매 ${money(family.household.net_12m)} (연결 회원 포함, 참고용)</span>` : ''}
      </div>
      ${family.members.length ? `
        <div class="table-wrap">
          <table class="consent-table">
            <thead><tr><th>관계</th><th>이름·호칭</th><th>나이</th><th>회원 연결</th><th></th></tr></thead>
            <tbody>${family.members.map((f) => `<tr>
              <td>${h(f.relation_label)}</td>
              <td>${h(f.name)}${f.gender ? ` <span class="list-meta">${h(L.genders[f.gender])}</span>` : ''}</td>
              <td>${f.age != null ? `${f.age}세` : '-'}</td>
              <td>${f.linked_customer_id ? `<button class="muted-link" type="button" onclick="openCustomerInfo(${f.linked_customer_id})">${h(f.linked_member_code || `M${f.linked_customer_id}`)}</button>` : '<span class="list-meta">계정 없음</span>'}</td>
              <td><button class="muted-link" type="button" onclick="removeFamilyMember(${customerId}, ${f.id})">해제</button></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '<p class="list-meta" style="margin: 0 0 8px;">등록된 가족이 없습니다. 자녀·부모님 정보를 남겨 두면 상담과 맞춤 안내에 도움이 됩니다.</p>'}
      ${family.members.length < family.max ? `
        <details style="margin-top: 8px;">
          <summary class="muted-link" style="cursor: pointer;">가족 추가</summary>
          <form class="inline-actions" style="margin-top: 8px; flex-wrap: wrap;" onsubmit="addFamilyMember(event, ${customerId})">
            <select class="form-control" name="relation" style="width: auto;" required><option value="">관계</option>${relationOptions}</select>
            <input class="form-control" name="name" placeholder="이름 또는 호칭 (예: 첫째)" maxlength="20" style="width: 170px;" />
            <select class="form-control" name="birth_year" style="width: auto;">${yearOptions}</select>
            <select class="form-control" name="gender" style="width: auto;"><option value="">성별</option><option value="F">여성</option><option value="M">남성</option></select>
            <input class="form-control" name="link_query" placeholder="가입한 가족이면 전화번호·회원코드" style="width: 220px;" />
            <button class="btn btn-primary btn-sm" type="submit">추가</button>
          </form>
          <p class="list-meta" style="margin: 6px 0 0;">이미 가입한 회원을 연결할 때는 본인 동의를 받은 뒤 진행해 주세요. 등급과 포인트는 회원마다 따로 쌓입니다.</p>
        </details>` : ''}
    </div>`;
}

async function addFamilyMember(event, customerId) {
  event.preventDefault();
  const f = event.target;
  try {
    await api.request(`/customers/${customerId}/family`, {
      method: 'POST',
      body: { relation: f.relation.value, name: f.name.value, birth_year: f.birth_year.value, gender: f.gender.value, link_query: f.link_query.value }
    });
    showToast('가족을 등록했습니다.');
    openCustomerInfo(customerId);
  } catch (error) {
    showToast(error.message);
  }
}

async function removeFamilyMember(customerId, familyId) {
  if (!confirm('이 가족을 목록에서 해제할까요?')) return;
  try {
    await api.request(`/customers/${customerId}/family/${familyId}`, { method: 'DELETE' });
    showToast('가족 연결을 해제했습니다.');
    openCustomerInfo(customerId);
  } catch (error) {
    showToast(error.message);
  }
}

async function openCustomerInfo(id, target) {
  if (target) customerPanelTarget = target;
  try {
    const [data, insight] = await Promise.all([api.request(`/customers/${id}`), api.request(`/members/${id}`).catch(() => null)]);
    renderCustomerPanel(data, insight);
    if (target) $(customerPanelTarget).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showToast(error.message);
  }
}

async function saveCustomerProfile(event, id) {
  event.preventDefault();
  const f = event.target;
  try {
    await api.request(`/customers/${id}/profile`, {
      method: 'PATCH',
      body: { birth_month: f.birth_month.value, birth_day: f.birth_day.value, birth_year: f.birth_year.value, gender: f.gender.value }
    });
    showToast('선택 정보를 저장했습니다.');
    openCustomerInfo(id);
  } catch (error) {
    showToast(error.message);
  }
}

async function withdrawConsents(id) {
  const types = [...document.querySelectorAll('[data-withdraw]:checked')].map((box) => box.dataset.withdraw);
  if (!types.length) return showToast('철회할 항목을 선택해 주세요.');
  const names = types.map((type) => customerLabels.consent_types[type]).join(', ');
  if (!confirm(`고객이 요청한 철회가 맞나요?\n${names}`)) return;
  try {
    await api.request(`/customers/${id}/consents/withdraw`, { method: 'POST', body: { types } });
    showToast('동의 철회를 기록했습니다.');
    openCustomerInfo(id);
    loadConsentRenewals();
  } catch (error) {
    showToast(error.message);
  }
}

async function noticeConsents(id) {
  if (!confirm('고객에게 마케팅 수신 동의 사실을 안내했나요?\n안내 일시가 기록되고 2년 주기가 다시 시작됩니다.')) return;
  try {
    await api.request(`/customers/${id}/consents/notice`, { method: 'POST' });
    showToast('재확인 안내를 기록했습니다.');
    openCustomerInfo(id);
    loadConsentRenewals();
  } catch (error) {
    showToast(error.message);
  }
}

function approvalText(customer) {
  if (customer.approval_status === 'PENDING') return '<span class="badge orange">승인 대기</span>';
  if (customer.approval_status === 'REJECTED') return `<span class="badge red">거절</span> <span class="list-meta">${h(customer.approval_note || '')}</span>`;
  if (customer.approval_status === 'WITHDRAWN') return '<span class="badge gray">탈퇴</span>';
  return customer.signup_order_id ? '<span class="badge green">구매 인증 가입</span>' : '<span class="badge gray">기존 가입</span>';
}

function pinStatusText(customer) {
  if (!customer.pin_set) return '<span class="badge gray">미설정</span>';
  if (customer.pin_failed_count >= 10) return '<span class="badge red">잠김 (재설정 필요)</span>';
  if (customer.pin_locked_until && new Date(`${customer.pin_locked_until.replace(' ', 'T')}Z`) > new Date()) {
    return '<span class="badge orange">일시 잠김</span>';
  }
  return '<span class="badge green">설정됨</span>';
}

async function issuePinCode(id, hasPin) {
  const action = hasPin ? '재설정' : '설정';
  if (!confirm(`고객 본인인지 확인했나요?\n(방문 시 신분증, 전화는 가입 정보 대조)\n\nPIN ${action} 코드를 발급하면 이전에 발급한 코드는 무효가 됩니다.`)) return;
  try {
    const data = await api.request(`/customers/${id}/pin-reset-code`, { method: 'POST' });
    $(`#pinCodeBox-${id}`).innerHTML = `
      <div class="insight-box" style="margin-bottom: 14px;">
        <strong style="font-size: 22px; letter-spacing: 3px;">${h(data.code)}</strong>
        <p class="list-meta" style="margin: 6px 0 0;">
          고객에게 이 코드를 알려 주세요. 로그인 화면의 'PIN을 잊었거나…'에서 휴대폰 번호와 함께 입력하면 새 PIN을 정할 수 있습니다.
          ${h(formatDate(data.expires_at))}까지 한 번만 쓸 수 있고, 잠긴 계정도 함께 풀립니다.
        </p>
      </div>`;
  } catch (error) {
    showToast(error.message);
  }
}

const HEALTH_PURPOSES = {
  COUNSEL: '복약상담',
  SALE_CHECK: '판매 전 함께 먹으면 안 되는 약 확인',
  CUSTOMER_REQUEST: '고객 요청에 따른 확인·정정'
};

// 민감정보는 목적을 먼저 고른 뒤에 연다. 목적과 열람 기록은 고객 앱에도 보인다.
function showCustomerHealth(id) {
  const box = $(`#healthBox-${id}`);
  if (box.innerHTML) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="insight-box" style="margin-bottom: 14px;">
      <strong>열람 목적을 골라 주세요</strong>
      <div class="inline-actions" style="margin: 8px 0;">
        ${Object.entries(HEALTH_PURPOSES).map(([key, label]) => `<button class="btn btn-outline btn-sm" type="button" onclick="viewCustomerHealth(${id}, '${key}')">${h(label)}</button>`).join('')}
      </div>
      <p class="list-meta" style="margin: 0;">누가 언제 어떤 목적으로 열람했는지 기록되고, 고객도 앱에서 확인할 수 있습니다.</p>
    </div>`;
}

async function viewCustomerHealth(id, purpose) {
  const box = $(`#healthBox-${id}`);
  try {
    const { health, agreed } = await api.request(`/customers/${id}/health?purpose=${purpose}`);
    const field = (name, label, value) => `
      <div class="form-group full" style="margin-bottom: 8px;">
        <label class="form-label">${label} <span class="list-meta"><input type="checkbox" name="${name}_none" ${health && !value ? 'checked' : ''} /> 없음</span></label>
        <textarea class="form-control" name="${name}" maxlength="300" rows="2">${h(value || '')}</textarea>
      </div>`;
    box.innerHTML = `
      <div class="insight-box" style="margin-bottom: 14px;">
        <div class="profile-grid" style="margin-bottom: 6px;">
          <div style="grid-column: span 2;"><span>알레르기</span><strong>${health ? (health.allergy ? h(health.allergy) : '없음') : '입력 전'}</strong></div>
          <div style="grid-column: span 2;"><span>지금 복용 중인 약</span><strong>${health ? (health.medications ? h(health.medications) : '없음') : '입력 전'}</strong></div>
        </div>
        <p class="list-meta" style="margin: 0 0 8px;">
          열람 목적: ${h(HEALTH_PURPOSES[purpose])} ·
          ${health ? `마지막 ${health.updated_by === 'PHARMACIST' ? '약사 수정' : '고객 입력'} ${h(formatDate(health.updated_at))} · ${h(formatDate(health.expires_at))}에 자동 삭제` : '아직 입력된 내용이 없습니다.'}
        </p>
        ${agreed ? `
          <details>
            <summary class="muted-link" style="cursor: pointer;">상담 내용으로 고치기</summary>
            <form style="margin-top: 8px;" onsubmit="saveCustomerHealth(event, ${id})">
              ${field('allergy', '알레르기', health?.allergy)}
              ${field('medications', '지금 복용 중인 약', health?.medications)}
              <button class="btn btn-primary btn-sm" type="submit">저장</button>
            </form>
          </details>` : '<p class="list-meta" style="margin: 0;">고객이 보관 동의를 하지 않아 약국에서 입력할 수 없습니다.</p>'}
      </div>`;
  } catch (error) {
    showToast(error.message);
  }
}

async function saveCustomerHealth(event, id) {
  event.preventDefault();
  const f = event.target;
  try {
    await api.request(`/customers/${id}/health`, {
      method: 'PUT',
      body: { allergy: f.allergy.value, allergy_none: f.allergy_none.checked, medications: f.medications.value, medications_none: f.medications_none.checked }
    });
    showToast('건강 정보를 고쳤습니다. 고객 앱의 이용 기록에도 남습니다.');
    viewCustomerHealth(id, 'COUNSEL');
  } catch (error) {
    showToast(error.message);
  }
}

async function showHealthAccessLog(id) {
  const box = $(`#healthLogBox-${id}`);
  if (box.innerHTML) {
    box.innerHTML = '';
    return;
  }
  try {
    const { access_log: log, retention } = await api.request(`/customers/${id}/privacy`);
    box.innerHTML = `
      <div class="insight-box" style="margin-bottom: 14px;">
        <strong>건강 정보 이용 기록</strong>
        <div class="table-wrap" style="margin-top: 8px;">
          <table class="consent-table">
            <thead><tr><th>일시</th><th>내용</th><th>누가</th><th>목적</th></tr></thead>
            <tbody>
              ${log.map((l) => `<tr><td>${h(formatDate(l.created_at))}</td><td>${h(l.action_label)}</td><td>${h(l.by)}</td><td>${h(l.purpose_label || '-')}</td></tr>`).join('') || '<tr><td colspan="4">기록이 없습니다.</td></tr>'}
            </tbody>
          </table>
        </div>
        <p class="list-meta" style="margin: 8px 0 0;">보유기간: 건강 정보는 마지막 확인 뒤 ${retention.health_months}개월, 상담 문의 내용은 ${retention.counsel_days}일 뒤 자동 삭제됩니다.</p>
      </div>`;
  } catch (error) {
    showToast(error.message);
  }
}

async function loadSignupRequests() {
  try {
    const { requests } = await api.request('/customers/signup-requests');
    $('#signupRequestBtn').hidden = requests.length === 0;
    $('#signupRequestCount').textContent = requests.length;
    return requests;
  } catch (error) {
    return [];
  }
}

async function openSignupRequests() {
  const requests = await loadSignupRequests();
  const panel = $('#customerPanel');
  $('#pointPanel').hidden = true;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card-header" style="margin-bottom: 10px;">
      <h3 class="card-title" style="font-size: 16px;">가입 승인 대기 ${requests.length}명</h3>
      <button class="muted-link" type="button" onclick="$('#customerPanel').hidden = true">닫기</button>
    </div>
    <p class="list-meta" style="margin: 0 0 10px;">
      영수증 코드는 맞지만 이상 징후가 있어 자동 승인하지 않은 가입입니다. 인증한 구매 내역과 사유를 보고, 필요하면 고객에게 연락해 확인한 뒤 처리해 주세요.
    </p>
    <div class="list-stack">
      ${requests.map((r) => `
        <div class="list-item" style="align-items: flex-start;">
          <div>
            <div class="list-title">${h(r.name)} <span class="list-meta">${h(r.phone || '')}</span></div>
            <div class="list-meta">
              ${r.birth_year}.${String(r.birth_month).padStart(2, '0')}.${String(r.birth_day).padStart(2, '0')} · ${r.gender === 'F' ? '여성' : '남성'} · 신청 ${h(formatDate(r.created_at))}${r.referrer_name ? ` · 추천인 ${h(r.referrer_name)}` : ''}<br />
              인증 구매 ${h(r.order_number || '-')} · ${money(r.order_amount)} · ${h(formatDate(r.order_created_at))}${r.order_items ? ` · ${h(r.order_items)}` : ''}
            </div>
            <div style="margin-top: 6px;"><span class="badge orange">${h(r.approval_note || '확인 필요')}</span></div>
          </div>
          <div class="inline-actions" style="flex-shrink: 0;">
            <button class="btn btn-primary btn-sm" type="button" onclick="decideSignup(${r.id}, true)">승인</button>
            <button class="btn btn-outline btn-sm" type="button" onclick="decideSignup(${r.id}, false)">거절</button>
          </div>
        </div>`).join('') || renderEmpty('승인 대기 중인 가입이 없습니다.')}
    </div>
  `;
}

async function decideSignup(id, approve) {
  let body;
  if (approve) {
    if (!confirm('이 가입을 승인할까요? 인증한 구매가 회원 이력으로 옮겨지고 적립됩니다.')) return;
  } else {
    const reason = prompt('거절 사유를 적어 주세요. (예: 중복 가입, 본인 확인 불가)');
    if (!reason || !reason.trim()) return;
    body = { reason };
  }
  try {
    await api.request(`/customers/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body });
    showToast(approve ? '가입을 승인했습니다.' : '가입을 거절했습니다. 입력한 건강 정보는 삭제됩니다.');
    await openSignupRequests();
    loadOwner();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadConsentRenewals() {
  try {
    const { renewals } = await api.request('/customers/consent-renewals');
    $('#renewalBtn').hidden = renewals.length === 0;
    $('#renewalCount').textContent = renewals.length;
    return renewals;
  } catch (error) {
    return [];
  }
}

async function openConsentRenewals() {
  const renewals = await loadConsentRenewals();
  const panel = $('#customerPanel');
  $('#pointPanel').hidden = true;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card-header" style="margin-bottom: 10px;">
      <h3 class="card-title" style="font-size: 16px;">마케팅 수신 동의 재확인 대상 ${renewals.length}명</h3>
      <button class="muted-link" type="button" onclick="$('#customerPanel').hidden = true">닫기</button>
    </div>
    <p class="list-meta" style="margin: 0 0 10px;">동의일(또는 마지막 안내일)로부터 2년이 되기 전에 동의 사실을 안내해야 합니다. 30일 안에 기한이 오는 회원까지 보여 줍니다.</p>
    <div class="list-stack">
      ${renewals.map((r) => `
        <div class="list-item">
          <div>
            <div class="list-title">${h(r.name)}</div>
            <div class="list-meta">${h(r.phone || '')} · 기한 ${h(formatDate(r.due_at))}</div>
          </div>
          <button class="muted-link" type="button" onclick="openCustomerInfo(${r.id}, '#customerPanel')">회원 정보</button>
        </div>`).join('') || renderEmpty('재확인할 회원이 없습니다.')}
    </div>
  `;
}
