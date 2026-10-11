// MAYDIN 파트너센터 · 매출 리포트
/* ---------- 매출 리포트 ---------- */

const REPORT_TABS = [
  ['products', '상품별'],
  ['categories', '카테고리별'],
  ['staff', '직원별'],
  ['payments', '결제수단별'],
  ['weekday', '요일별'],
  ['hourly', '시간대별'],
  ['trend', '기간별'],
  ['tax', '과세구분']
];
const REPORT_GROUPS = { HOUR: '시간', DAY: '일', WEEK: '주', MONTH: '월', YEAR: '년' };
const REPORT_METRICS = [
  ['net_amount', '순매출'],
  ['sale_count', '판매 건수'],
  ['avg_ticket', '객단가']
];
const report = { period: 'MONTH', anchor: null, group: null, metric: 'net_amount', compare: true, tab: 'products', data: null };

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function setReportPeriod(period) {
  report.period = period;
  report.group = null;
  if (period === 'RANGE' && !$('#reportFrom').value) {
    const d = report.data;
    $('#reportFrom').value = d ? d.from : ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    $('#reportTo').value = d ? (d.to > d.today ? d.today : d.to) : ymd(new Date());
  }
  loadReport();
}

function shiftReport(step) {
  const d = report.data;
  const target = d && (step < 0 ? d.prev_anchor : d.next_anchor);
  if (!target) return;
  report.anchor = target;
  loadReport();
}

function reportToday() {
  report.anchor = null;
  loadReport();
}

function jumpReport(value) {
  if (!value) return;
  report.anchor = value;
  loadReport();
}

function applyReportRange() {
  report.group = null;
  loadReport();
}

function reportLastDays(days) {
  const now = new Date();
  $('#reportFrom').value = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1));
  $('#reportTo').value = ymd(now);
  applyReportRange();
}

function reportQuery() {
  const params = new URLSearchParams({ period: report.period, channel: $('#reportChannel').value });
  if (report.period === 'RANGE') {
    params.set('from', $('#reportFrom').value);
    params.set('to', $('#reportTo').value);
  } else if (report.anchor) {
    params.set('date', report.anchor);
  }
  if (report.group) params.set('group', report.group);
  if (!report.compare) params.set('compare', '0');
  return params.toString();
}

function renderReportControls() {
  const d = report.data;
  const range = report.period === 'RANGE';
  document.querySelectorAll('[data-report-period]').forEach((b) => b.classList.toggle('active', b.dataset.reportPeriod === report.period));
  $('#reportNav').hidden = range;
  $('#reportRange').hidden = !range;
  if (!d) return;
  $('#reportPeriodLabel').textContent = d.period_label;
  $('#reportPrevBtn').disabled = !d.prev_anchor;
  $('#reportNextBtn').disabled = !d.next_anchor;
  if (d.anchor) $('#reportAnchor').value = d.anchor;
}

async function loadReport() {
  renderReportControls();
  try {
    report.data = await api.request(`/reports/sales?${reportQuery()}`);
    report.anchor = report.data.anchor;
    renderReportControls();
    renderReport();
  } catch (error) {
    $('#reportBody').classList.remove('loading');
    $('#reportBody').innerHTML = renderEmpty(error.message);
  }
}

function pct(value) {
  return value == null ? '-' : `${value}%`;
}

function changeRate(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

function deltaHtml(current, previous) {
  if (previous == null) return '';
  const rate = changeRate(current, previous);
  if (rate == null) return current ? '<span class="delta up">신규</span>' : '<span class="delta flat">-</span>';
  if (rate === 0) return '<span class="delta flat">0%</span>';
  return `<span class="delta ${rate > 0 ? 'up' : 'down'}">${rate > 0 ? '▲' : '▼'} ${Math.abs(rate)}%</span>`;
}

function shortMoney(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 100000000) return `${sign}${Math.round(abs / 10000000) / 10}억`;
  if (abs >= 1000000) return `${sign}${Math.round(abs / 10000).toLocaleString()}만`;
  if (abs >= 10000) return `${sign}${Math.round(abs / 1000) / 10}만`;
  return `${sign}${abs.toLocaleString()}`;
}

function metricText(metric, value) {
  return metric === 'sale_count' ? `${Number(value || 0).toLocaleString()}건` : money(value);
}

function niceStep(range, count) {
  const raw = range / count;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

function mdLabel(date) {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function weekdayOf(date) {
  return ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00`).getDay()];
}

function slotAxisLabel(group, row, multiDay, multiYear) {
  switch (group) {
    case 'HOUR':
      return multiDay ? `${mdLabel(row.period)} ${Number(row.period.slice(11))}시` : `${Number(row.period.slice(11))}시`;
    case 'DAY':
      return mdLabel(row.period);
    case 'WEEK':
      return multiYear ? `${row.start.slice(2, 4)}.${mdLabel(row.start).replace('/', '.')}` : `${mdLabel(row.start)}~`;
    case 'MONTH':
      return multiYear ? `${row.period.slice(2, 4)}.${Number(row.period.slice(5))}` : `${Number(row.period.slice(5))}월`;
    default:
      return `${row.period}년`;
  }
}

function slotTitle(group, row) {
  switch (group) {
    case 'HOUR': {
      const date = row.period.slice(0, 10);
      return `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일 (${weekdayOf(date)}) ${row.period.slice(11)}:00~${row.period.slice(11)}:59`;
    }
    case 'DAY':
      return `${row.period.slice(0, 4)}년 ${Number(row.period.slice(5, 7))}월 ${Number(row.period.slice(8))}일 (${weekdayOf(row.period)})`;
    case 'WEEK':
      return `${row.start.slice(0, 4)}년 ${mdLabel(row.start)} ~ ${mdLabel(row.end)}`;
    case 'MONTH':
      return `${row.period.slice(0, 4)}년 ${Number(row.period.slice(5))}월`;
    default:
      return `${row.period}년`;
  }
}

function trendChart(d) {
  const metric = report.metric;
  const rows = d.trend;
  const prev = d.comparison ? d.comparison.trend.slice(0, rows.length) : [];
  const stacked = metric === 'net_amount' && d.channel === 'ALL';
  const W = 1000;
  const H = 300;
  const pad = { left: 62, right: 12, top: 14, bottom: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const values = rows.filter((r) => !r.future).map((r) => r[metric]);
  const all = [0, ...values, ...prev.map((r) => r[metric])];
  const step = niceStep(Math.max(1, Math.max(...all) - Math.min(...all)), 4);
  const top = Math.max(step, Math.ceil(Math.max(...all) / step) * step);
  const bottom = Math.min(0, Math.floor(Math.min(...all) / step) * step);
  const y = (v) => pad.top + ((top - v) / (top - bottom)) * plotH;
  const slotW = plotW / rows.length;
  const barW = Math.max(1, Math.min(44, slotW * 0.68));
  const cx = (i) => pad.left + slotW * (i + 0.5);
  const zero = y(0);
  const multiDay = d.granularity === 'HOUR' && rows.length > 24;
  const multiYear = d.from.slice(0, 4) !== d.to.slice(0, 4);
  const labelEvery = Math.max(1, Math.ceil(rows.length / 12));

  const grid = [];
  for (let v = bottom; v <= top + step / 2; v += step) {
    grid.push(`<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? '#c9ced4' : '#eef0f2'}" />`);
    grid.push(`<text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#8b95a1">${metric === 'sale_count' ? `${v.toLocaleString()}건` : shortMoney(v)}</text>`);
  }

  const bars = rows.map((r, i) => {
    if (r.future) return `<rect x="${cx(i) - barW / 2}" y="${zero - 2}" width="${barW}" height="2" rx="1" fill="#eef0f2" />`;
    const v = r[metric];
    const x = cx(i) - barW / 2;
    if (stacked && r.pos_amount >= 0 && r.online_amount >= 0 && v > 0) {
      const posTop = y(r.pos_amount);
      return `<rect x="${x}" y="${posTop}" width="${barW}" height="${zero - posTop}" fill="#3182f6" />` +
        (r.online_amount ? `<rect x="${x}" y="${y(v)}" width="${barW}" height="${posTop - y(v)}" fill="#8cc2ff" />` : '');
    }
    if (!v) return '';
    const yTop = y(Math.max(v, 0));
    const height = Math.max(1, Math.abs(y(v) - zero));
    return `<rect x="${x}" y="${yTop}" width="${barW}" height="${height}" fill="${v < 0 ? '#f04452' : '#3182f6'}" />`;
  }).join('');

  const prevPoints = prev.map((r, i) => `${cx(i)},${y(r[metric])}`);
  const prevLine = prev.length
    ? `<polyline points="${prevPoints.join(' ')}" fill="none" stroke="#8b95a1" stroke-width="1.6" stroke-dasharray="5 4" />` +
      (rows.length <= 60 ? prev.map((r, i) => `<circle cx="${cx(i)}" cy="${y(r[metric])}" r="2.5" fill="#8b95a1" />`).join('') : '')
    : '';

  const labels = rows.map((r, i) =>
    i % labelEvery === 0 ? `<text x="${cx(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#8b95a1">${h(slotAxisLabel(d.granularity, r, multiDay, multiYear))}</text>` : ''
  ).join('');
  const hits = rows.map((r, i) => `<rect class="hit" data-i="${i}" x="${pad.left + slotW * i}" y="${pad.top}" width="${slotW}" height="${plotH}" fill="transparent" />`).join('');

  return `
    <div class="chart-legend">
      ${stacked ? '<span><i style="background:#3182f6"></i>매장 POS</span><span><i style="background:#8cc2ff"></i>온라인</span>' : `<span><i style="background:#3182f6"></i>${REPORT_METRICS.find(([k]) => k === metric)[1]}</span>`}
      ${prev.length ? `<span><i class="line"></i>${h(d.compare_label)} (${h(d.comparison.from)} ~ ${h(d.comparison.to)})</span>` : ''}
      <span><i style="background:#f04452"></i>반품이 더 많은 구간</span>
    </div>
    <div class="svg-chart" id="trendChart" onmousemove="trendHover(event)" onmouseleave="trendHover(null)">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(d.period_label)} 매출 추이">
        ${grid.join('')}${bars}${prevLine}${labels}${hits}
      </svg>
      <div class="chart-tooltip" id="trendTooltip" hidden></div>
    </div>`;
}

function trendHover(event) {
  const tip = $('#trendTooltip');
  if (!tip) return;
  const i = event && event.target.dataset ? event.target.dataset.i : undefined;
  if (i === undefined) {
    tip.hidden = true;
    return;
  }
  const d = report.data;
  const r = d.trend[Number(i)];
  const p = d.comparison && d.comparison.trend[Number(i)];
  const line = (label, value, cls = '') => `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`;
  tip.innerHTML = `
    <b>${h(slotTitle(d.granularity, r))}</b>
    ${r.future ? line('아직 지나지 않은 기간', '', 'sub') : `
      ${line('순매출', money(r.net_amount))}
      ${line('판매 건수 · 객단가', `${r.sale_count}건 · ${money(r.avg_ticket)}`)}
      ${d.channel === 'ALL' ? line('매장 · 온라인', `${shortMoney(r.pos_amount)} · ${shortMoney(r.online_amount)}`, 'sub') : ''}
      ${r.refund_amount ? line('반품·취소', money(r.refund_amount), 'sub') : ''}`}
    ${p ? `${line(`${h(d.compare_label)} · ${h(slotTitle(d.granularity, p))}`, '', 'sub')}
      ${line(REPORT_METRICS.find(([k]) => k === report.metric)[1], metricText(report.metric, p[report.metric]), 'sub')}
      ${r.future ? '' : line('증감', deltaHtml(r[report.metric], p[report.metric]) || '-')}` : ''}`;
  tip.hidden = false;
  const box = $('#trendChart').getBoundingClientRect();
  const x = event.clientX - box.left;
  const left = x + tip.offsetWidth + 16 > box.width ? x - tip.offsetWidth - 12 : x + 12;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, event.clientY - box.top - tip.offsetHeight / 2)}px`;
}

function shareBars(rows) {
  const total = rows.reduce((sum, r) => sum + Math.max(0, r.value), 0);
  if (!total) return '<p class="list-meta">판매 내역이 없습니다.</p>';
  return rows.map((r) => {
    const share = Math.max(0, r.value) / total;
    return `<div class="share-row" title="${h(r.label)} · ${money(r.value)}">
      <span>${h(r.label)}</span>
      <div class="track"><div class="fill" style="width:${share * 100}%;${r.color ? `background:${r.color}` : ''}"></div></div>
      <span>${Math.round(share * 1000) / 10}% · ${shortMoney(r.value)}</span>
    </div>`;
  }).join('');
}

function miniCharts(d) {
  const boxes = [];
  if (d.granularity !== 'HOUR') {
    boxes.push(['시간대별 순매출', barChart(d.hourly, 'net_amount', (r) => r.hour, (r) => `${r.hour}시 · ${money(r.net_amount)} · ${r.sale_count}건`, { labelEvery: 3 })]);
  }
  if (d.weekdays.reduce((sum, w) => sum + w.days, 0) >= 7) {
    boxes.push(['요일별 일평균 순매출', barChart(d.weekdays, 'avg_net_amount', (r) => r.label, (r) => `${r.label}요일 · 일평균 ${money(r.avg_net_amount)} (${r.days}일)`)]);
  }
  if (d.channel === 'ALL') {
    boxes.push(['판매 채널', shareBars(d.channels.map((c) => ({ label: d.channel_labels[c.channel] || c.channel, value: c.net_amount, color: c.channel === 'POS' ? '#3182f6' : '#8cc2ff' })))]);
  }
  boxes.push(['결제수단', shareBars(d.payments.map((p) => ({ label: d.method_labels[p.payment_method] || p.payment_method, value: p.net_amount })))]);
  boxes.push(['카테고리 TOP 5', shareBars(d.categories.slice(0, 5).map((c) => ({ label: c.category_name, value: c.net_amount })))]);
  return `<div class="mini-charts">${boxes.map(([title, body]) => `<div class="chart-box"><h4>${title}</h4>${body}</div>`).join('')}</div>`;
}

function barChart(rows, valueKey, labelFn, titleFn, { labelEvery = 1 } = {}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r[valueKey])));
  return `
    <div class="bar-chart">
      ${rows.map((r) => `<div class="bar ${r[valueKey] < 0 ? 'negative' : ''}" style="height: ${Math.max(r[valueKey] ? 2 : 0, (Math.abs(r[valueKey]) / max) * 100)}%;" title="${h(titleFn(r))}"></div>`).join('')}
    </div>
    <div class="bar-labels">${rows.map((r, i) => `<span>${i % labelEvery === 0 ? h(labelFn(r)) : ''}</span>`).join('')}</div>
  `;
}

function renderReport() {
  const d = report.data;
  const t = d.totals;
  const c = d.comparison ? d.comparison.totals : null;
  const compareNote = d.comparison
    ? `${d.compare_label} ${d.comparison.partial ? '같은 시점' : ''} 대비 · ${d.comparison.from} ~ ${d.comparison.partial ? d.comparison.until.slice(0, 16) : d.comparison.to}`
    : '';
  const vs = (value) => (c ? ` · ${d.compare_label} ${value}` : '');
  $('#reportBody').classList.remove('loading');
  $('#reportBody').innerHTML = `
    <div class="report-metrics">
      <div class="report-metric"><span>순매출 ${c ? deltaHtml(t.net_amount, c.net_amount) : ''}</span><strong style="color: var(--toss-blue);">${money(t.net_amount)}</strong><small>총매출 ${money(t.gross_amount)} · 반품 ${money(t.refund_amount)}${vs(shortMoney(c ? c.net_amount : 0))}</small></div>
      <div class="report-metric"><span>판매 건수 ${c ? deltaHtml(t.sale_count, c.sale_count) : ''}</span><strong>${t.sale_count.toLocaleString()}건</strong><small>회원 ${t.member_count}명 · 비회원 ${t.walk_in_count}건${vs(`${c ? c.sale_count : 0}건`)}</small></div>
      <div class="report-metric"><span>객단가 ${c ? deltaHtml(t.avg_ticket, c.avg_ticket) : ''}</span><strong>${money(t.avg_ticket)}</strong><small>할인 ${money(t.discount_amount)}${vs(money(c ? c.avg_ticket : 0))}</small></div>
      <div class="report-metric"><span>과세 매출 (부가세 포함)</span><strong>${money(d.tax.taxable_amount)}</strong><small>공급가 ${money(d.tax.supply_amount)} · 부가세 ${money(d.tax.vat_amount)}</small></div>
      <div class="report-metric"><span>면세 매출</span><strong>${money(d.tax.exempt_amount)}</strong><small>면세 상품은 상품 관리에서 지정</small></div>
      <div class="report-metric"><span>매출총이익</span><strong>${d.margin.margin_amount == null ? '-' : money(d.margin.margin_amount)}</strong><small>이익률 ${pct(d.margin.margin_rate)} · 원가 기록 매출 ${pct(d.margin.coverage_rate)}${d.margin.estimated_net ? ' · 일부 추정' : ''}</small></div>
    </div>
    <div class="chart-box trend-box">
      <div class="trend-head">
        <h4>${h(d.period_label)} · ${REPORT_GROUPS[d.granularity]} 단위 추이</h4>
        <div class="inline-actions">
          <div class="segmented small">
            ${REPORT_METRICS.map(([key, label]) => `<button type="button" class="${report.metric === key ? 'active' : ''}" onclick="report.metric = '${key}'; renderReport()">${label}</button>`).join('')}
          </div>
          <div class="segmented small" title="차트 단위">
            ${Object.entries(REPORT_GROUPS).map(([key, label]) => `<button type="button" class="${d.granularity === key ? 'active' : ''}" ${d.groups_allowed.includes(key) ? '' : 'disabled'} onclick="report.group = '${key}'; loadReport()">${label}</button>`).join('')}
          </div>
          <label class="list-meta" style="display: inline-flex; gap: 4px; align-items: center; cursor: pointer;">
            <input type="checkbox" ${report.compare ? 'checked' : ''} onchange="report.compare = this.checked; loadReport()" /> ${h(d.compare_label)} 비교
          </label>
        </div>
      </div>
      ${trendChart(d)}
      ${compareNote ? `<p class="list-meta" style="margin: 6px 0 0;">증감률: ${h(compareNote)}</p>` : ''}
    </div>
    ${miniCharts(d)}
    <div class="inline-actions" style="justify-content: space-between; margin-bottom: 12px;">
      <div class="tab-bar" style="margin: 0;">
        ${REPORT_TABS.map(([key, label]) => `<button class="tab-btn ${report.tab === key ? 'active' : ''}" type="button" onclick="report.tab = '${key}'; renderReport()">${label}</button>`).join('')}
      </div>
      <button class="btn btn-outline btn-sm" type="button" onclick="downloadReportCsv(report.tab)">CSV 내려받기 (엑셀)</button>
    </div>
    ${renderReportTable(d)}
    <p class="list-meta" style="margin: 12px 0 0;">
      반품·취소는 처리한 날짜의 매출에서 차감됩니다. 부가세는 과세 매출(부가세 포함가)의 1/11로 계산한 참고값이며, 신고는 세무 대리인과 확인해 주세요.
      매출총이익은 판매 순간에 기록한 원가(유통기한 로트별 입고 단가, 없으면 그때의 상품 원가) 기준이라 나중에 원가를 바꿔도 지난 이익이 달라지지 않습니다. 반품·취소분은 원가까지 함께 차감합니다.${d.margin.estimated_net ? ` 원가 기록을 시작하기 전 판매 ${money(d.margin.estimated_net)}는 기록 시작 시점 원가로 추정했습니다.` : ''}
    </p>
  `;
}

function renderReportTable(d) {
  const table = (head, rows, empty) => `
    <div class="table-wrap"><table>
      <thead><tr>${head.map(([label, num]) => `<th class="${num ? 'num' : ''}">${label}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}">${empty}</td></tr>`}</tbody>
    </table></div>`;
  const tr = (cells) => `<tr>${cells.map(([value, num, style]) => `<td class="${num ? 'num' : ''}" ${style ? `style="${style}"` : ''}>${value}</td>`).join('')}</tr>`;
  const bold = 'font-weight: 800;';
  switch (report.tab) {
    case 'categories':
      return table(
        [['카테고리'], ['상품 수', 1], ['순수량', 1], ['순매출', 1], ['비중', 1], ['매출총이익', 1], ['이익률', 1]],
        d.categories.map((c) => tr([[h(c.category_name)], [c.product_count, 1], [c.net_quantity, 1], [money(c.net_amount), 1, bold], [pct(c.share), 1], [c.margin_amount == null ? '-' : money(c.margin_amount), 1], [pct(c.margin_rate), 1]])),
        '판매 내역이 없습니다.'
      );
    case 'staff':
      return table(
        [['판매자'], ['판매', 1], ['반품', 1], ['총매출', 1], ['반품액', 1], ['순매출', 1], ['할인', 1], ['객단가', 1]],
        d.staff.map((s) => tr([[`${h(s.staff_name)}${s.role === 'POS_STAFF' ? ' <span class="badge gray">직원</span>' : ''}`], [s.sale_count, 1], [s.refund_count, 1], [money(s.gross_amount), 1], [money(s.refund_amount), 1], [money(s.net_amount), 1, bold], [money(s.discount_amount), 1], [money(s.avg_ticket), 1]])),
        d.channel === 'ONLINE' ? '온라인 주문은 판매자 구분이 없습니다.' : '매장 POS 판매 내역이 없습니다.'
      );
    case 'payments':
      return table(
        [['결제수단'], ['건수', 1], ['결제', 1], ['환불', 1], ['순액', 1]],
        d.payments.map((p) => tr([[h(d.method_labels[p.payment_method] || p.payment_method)], [p.pay_count, 1], [money(p.paid_amount), 1], [money(p.refunded_amount), 1], [money(p.net_amount), 1, bold]])),
        '결제 내역이 없습니다.'
      );
    case 'weekday':
      return table(
        [['요일'], ['일수', 1], ['판매 건수', 1], ['순매출', 1], ['일평균 순매출', 1]],
        d.weekdays.map((w) => tr([[`${w.label}요일`], [w.days, 1], [w.sale_count, 1], [money(w.net_amount), 1, bold], [money(w.avg_net_amount), 1]])),
        '-'
      );
    case 'hourly':
      return table(
        [['시간대'], ['판매 건수', 1], ['순매출', 1]],
        d.hourly.filter((r) => r.sale_count || r.net_amount).map((r) => tr([[`${String(r.hour).padStart(2, '0')}:00 ~ ${String(r.hour).padStart(2, '0')}:59`], [r.sale_count, 1], [money(r.net_amount), 1, bold]])),
        '판매 내역이 없습니다.'
      );
    case 'trend': {
      const prevOf = (i) => d.comparison && d.comparison.trend[i];
      return table(
        [
          [REPORT_GROUPS[d.granularity]],
          ['판매 건수', 1],
          ['총매출', 1],
          ['반품', 1],
          ['순매출', 1],
          ['객단가', 1],
          ['매장 POS', 1],
          ['온라인', 1],
          ...(d.comparison ? [[`${h(d.compare_label)} 순매출`, 1], ['증감', 1]] : [])
        ],
        d.trend
          .map((r, i) => [r, i])
          .filter(([r, i]) => !r.future && (r.sale_count || r.net_amount || r.refund_amount || (prevOf(i) && prevOf(i).net_amount)))
          .map(([r, i]) => tr([
            [h(slotTitle(d.granularity, r))],
            [r.sale_count, 1],
            [money(r.gross_amount), 1],
            [money(r.refund_amount), 1],
            [money(r.net_amount), 1, bold],
            [money(r.avg_ticket), 1],
            [money(r.pos_amount), 1],
            [money(r.online_amount), 1],
            ...(d.comparison ? (prevOf(i) ? [[money(prevOf(i).net_amount), 1], [deltaHtml(r.net_amount, prevOf(i).net_amount) || '-', 1]] : [['-', 1], ['-', 1]]) : [])
          ])),
        '판매 내역이 없습니다.'
      );
    }
    case 'tax':
      return table(
        [['구분'], ['금액', 1]],
        [
          tr([['과세 매출 (부가세 포함)'], [money(d.tax.taxable_amount), 1, bold]]),
          tr([['&nbsp;&nbsp;공급가액'], [money(d.tax.supply_amount), 1]]),
          tr([['&nbsp;&nbsp;부가세'], [money(d.tax.vat_amount), 1]]),
          ...(d.tax.delivery_fee ? [tr([['&nbsp;&nbsp;(배송비 포함분)'], [money(d.tax.delivery_fee), 1]])] : []),
          tr([['면세 매출'], [money(d.tax.exempt_amount), 1, bold]]),
          tr([['합계'], [money(d.tax.taxable_amount + d.tax.exempt_amount), 1, bold]])
        ],
        '-'
      );
    default:
      return table(
        [['상품'], ['과세'], ['판매', 1], ['반품', 1], ['순매출', 1], ['비중', 1], ['매출원가', 1], ['매출총이익', 1], ['이익률', 1]],
        d.products.map((p) => tr([
          [`<div class="list-title">${h(p.product_name)}</div><div class="list-meta">${h(p.category_name)}${p.product_type && p.product_type !== 'GENERAL' ? ` · ${PRODUCT_TYPE_LABELS[p.product_type] || p.product_type}` : ''}</div>`],
          [p.tax_type === 'EXEMPT' ? '<span class="badge green">면세</span>' : '<span class="badge gray">과세</span>'],
          [p.sold_quantity, 1],
          [p.refunded_quantity || '-', 1],
          [money(p.net_amount), 1, bold],
          [pct(p.share), 1],
          [p.cost_lines ? money(p.cost_amount) : '<span class="list-meta">원가 미기록</span>', 1],
          [p.margin_amount == null ? '-' : money(p.margin_amount), 1],
          [pct(p.margin_rate), 1]
        ])),
        '판매 내역이 없습니다.'
      );
  }
}

async function downloadReportCsv(type) {
  try {
    const res = await fetch(`/api/reports/sales.csv?type=${encodeURIComponent(type)}&${reportQuery()}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'CSV를 내려받지 못했습니다.');
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    const filename = match ? decodeURIComponent(match[1]) : `sales-${type}.csv`;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${filename} 파일을 내려받았습니다.`);
  } catch (error) {
    showToast(error.message);
  }
}
