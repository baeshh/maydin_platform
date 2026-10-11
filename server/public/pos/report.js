// MAYDIN POS · 리포트·감사 로그
/* ---------- 리포트 · 감사 로그 ---------- */

async function openReport(from = state.ctx.today, to = from, tab = 'sales') {
  const wasLocked = state.modalLocked && !state.session;
  try {
    const data = await api.request(`/pos/reports/daily?from=${from}&to=${to}`);
    let audit = null;
    if (tab === 'audit' && can('can_view_audit')) audit = (await api.request('/pos/audit-logs')).logs;
    const t = data.totals;
    const body =
      tab === 'audit'
        ? `
          <table>
            <thead><tr><th>일시</th><th>구분</th><th>처리자</th><th>내용</th></tr></thead>
            <tbody>${(audit || [])
              .map(
                (l) => `<tr><td style="white-space: nowrap;">${fmtDateTime(l.created_at)}</td><td><span class="badge ${['POS_CANCEL', 'POS_REFUND'].includes(l.action) ? 'red' : l.action === 'POS_DISCOUNT' ? 'orange' : 'gray'}">${AUDIT_LABELS[l.action] || h(l.action)}</span></td><td>${h(l.user_name || '-')}</td><td style="font-size: 13px;">${h(l.description)}</td></tr>`
              )
              .join('') || '<tr><td colspan="4" class="muted">기록이 없습니다.</td></tr>'}</tbody>
          </table>`
        : `
          <div class="metrics">
            <div class="metric"><span>전체 순매출</span><strong>${signedWon(t.net_amount)}</strong></div>
            <div class="metric"><span>매장 POS 순매출</span><strong style="color: var(--toss-blue);">${signedWon(t.pos_net_amount)}</strong></div>
            <div class="metric"><span>POS 할인</span><strong>${won(t.discount_amount)}</strong></div>
            <div class="metric"><span>POS 반품·취소</span><strong style="color: var(--danger);">${t.pos_refund_count}건 · ${signedWon(t.pos_refund_amount)}</strong></div>
          </div>
          <div class="split">
            <div>
              <div class="section-title">채널별 매출</div>
              <table><thead><tr><th>채널</th><th class="num">건수</th><th class="num">반품</th><th class="num">순매출</th></tr></thead>
              <tbody>${data.channels.map((c) => `<tr><td>${CHANNEL_LABELS[c.channel] || h(c.channel)}</td><td class="num">${c.order_count}</td><td class="num">${signedWon(c.refund_amount)}</td><td class="num" style="font-weight: 800;">${signedWon(c.net_amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">매출 없음</td></tr>'}</tbody></table>
              <div class="section-title">결제수단별</div>
              <table><thead><tr><th>수단</th><th class="num">결제</th><th class="num">환불</th><th class="num">순액</th></tr></thead>
              <tbody>${data.payments.map((p) => `<tr><td>${METHOD_LABELS[p.payment_method] || h(p.payment_method)}</td><td class="num">${won(p.paid_amount)}</td><td class="num">${signedWon(p.refunded_amount)}</td><td class="num" style="font-weight: 800;">${signedWon(p.net_amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">결제 없음</td></tr>'}</tbody></table>
              <div class="section-title">판매자별 (POS)</div>
              <table><thead><tr><th>판매자</th><th class="num">판매</th><th class="num">반품</th><th class="num">순매출</th></tr></thead>
              <tbody>${data.cashiers.map((c) => `<tr><td>${h(c.cashier_name)}</td><td class="num">${c.sale_count}</td><td class="num">${c.refund_count}</td><td class="num" style="font-weight: 800;">${signedWon(c.net_amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">판매 없음</td></tr>'}</tbody></table>
            </div>
            <div>
              <div class="section-title">POS 상품 판매 순위</div>
              <table><thead><tr><th>상품</th><th class="num">수량</th><th class="num">순매출</th></tr></thead>
              <tbody>${data.products.map((p) => `<tr><td>${h(p.product_name)} ${typeBadge(p)}</td><td class="num">${p.net_quantity}</td><td class="num" style="font-weight: 800;">${signedWon(p.net_amount)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">판매 없음</td></tr>'}</tbody></table>
              <div class="section-title">영업 · 마감 기록</div>
              <table><thead><tr><th>영업일</th><th>상태</th><th class="num">예상</th><th class="num">실제</th><th class="num">차액</th></tr></thead>
              <tbody>${data.sessions.map((s) => `<tr><td>${h(s.business_date)}<div class="muted" style="font-size: 12px;">${fmtTime(s.opened_at)}~${s.closed_at ? fmtTime(s.closed_at) : ''} · ${h(s.opened_by_name || '')}</div></td><td>${s.status === 'OPEN' ? '<span class="badge green">영업 중</span>' : '<span class="badge gray">마감</span>'}</td><td class="num">${s.expected_cash == null ? '-' : won(s.expected_cash)}</td><td class="num">${s.actual_cash == null ? '-' : won(s.actual_cash)}</td><td class="num" style="${s.cash_difference ? 'color: var(--danger); font-weight: 800;' : ''}">${s.cash_difference == null ? '-' : signedWon(s.cash_difference)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">기록 없음</td></tr>'}</tbody></table>
            </div>
          </div>`;

    openModal(
      `
      ${modalHead('매출 리포트', { closable: !wasLocked })}
      <div class="modal-body">
        <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 16px;">
          <input id="reportFrom" class="input" style="width: 170px;" type="date" value="${h(from)}" />
          <span class="muted">~</span>
          <input id="reportTo" class="input" style="width: 170px;" type="date" value="${h(to)}" />
          <button class="btn btn-primary" type="button" onclick="openReport(document.getElementById('reportFrom').value, document.getElementById('reportTo').value, '${tab}')">조회</button>
          <div style="flex: 1;"></div>
          <button class="chip ${tab === 'sales' ? 'active' : ''}" type="button" onclick="openReport('${from}', '${to}', 'sales')">매출</button>
          ${can('can_view_audit') ? `<button class="chip ${tab === 'audit' ? 'active' : ''}" type="button" onclick="openReport('${from}', '${to}', 'audit')">감사 로그</button>` : ''}
          ${can('can_view_audit') ? '<a class="chip" style="text-decoration: none;" href="/owner.html#reports" target="_blank" rel="noopener">상세 리포트 ↗</a>' : ''}
        </div>
        ${body}
      </div>
      ${wasLocked ? '<div class="modal-foot"><button class="btn btn-primary" type="button" onclick="openSessionStart()">새 영업 시작</button></div>' : ''}
    `,
      { size: 'xwide', locked: wasLocked }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}
