// MAYDIN POS · 영수증 출력
/* ---------- 영수증 출력 ----------
 * 카운터 설정이 「프린터 직접 출력」이면 서버가 만든 영수증을 이 PC의 Bridge가 영수증 프린터로 바로 뽑고 절단한다.
 * 실패(용지 없음·덮개 열림·연결 끊김)하면 같은 작업으로 다시 보내거나 브라우저 인쇄로 대신한다.
 * 같은 작업은 Bridge가 한 번만 출력하므로, 응답이 끊겨 다시 보내도 영수증이 두 장 나오지 않는다.
 */

const PRINT_ERRORS = {
  PAPER_OUT: '용지가 없습니다',
  PAPER_NEAR_END: '용지가 거의 떨어졌습니다',
  COVER_OPEN: '프린터 덮개가 열려 있습니다',
  OFFLINE: '프린터에 연결할 수 없습니다',
  ERROR: '프린터 오류',
  UNKNOWN_RESULT: '출력 결과를 모릅니다',
  NOT_CONFIGURED: 'Bridge에 프린터가 설정되지 않았습니다'
};

function printerSettings() {
  return state.ctx?.van?.printer || { mode: 'BROWSER', auto_print: false, open_drawer: false };
}

function printsDirect() {
  return printerSettings().mode === 'BRIDGE';
}

// 판매·반품 영수증 출력. 이미 출력한 판매면 서버가 재출력으로 표시한다.
async function printOrder(orderId, { channel } = {}) {
  const data = await api.request(`/pos/sales/${orderId}/print`, { method: 'POST', body: { channel } });
  if (data.receipt) {
    await printReceipt(data.receipt, { reprint: data.job.copy_type === 'REPRINT' });
    return true;
  }
  return runPrintJob(data.job, data.print_request);
}

async function runPrintJob(job, request) {
  let result;
  try {
    result = await VanBridge.print(request);
  } catch (error) {
    refreshPrintJobs();
    showPrintFailure(job, error.message, { unknown: error.timeout });
    return false;
  }
  const saved = await api.request(`/pos/print-jobs/${job.job_id}/result`, { method: 'POST', body: { bridge_result: result } });
  refreshPrintJobs();
  if (saved.job.status === 'PRINTED') {
    toast(`${saved.job.document_type === 'TEST' ? '시험 출력' : saved.job.copy_type === 'REPRINT' ? '영수증 재출력' : '영수증 출력'} 완료${saved.job.message && saved.job.message !== '프린터 출력 완료' ? ` · ${saved.job.message}` : ''}`);
    return true;
  }
  showPrintFailure(saved.job, saved.job.message);
  return false;
}

function showPrintFailure(job, message, { unknown = false } = {}) {
  const reason = PRINT_ERRORS[job.error_code] || '';
  openModal(`
    ${modalHead('영수증 출력 실패')}
    <div class="modal-body">
      <div class="notice danger" style="line-height: 1.6;">
        <b>${h(job.order_number || '시험 출력')}</b> ${job.copy_type === 'REPRINT' ? '재출력' : '영수증'}을 뽑지 못했습니다.${reason ? ` (${h(reason)})` : ''}
        ${message ? `<div style="margin-top: 4px;">${h(message)}</div>` : ''}
      </div>
      <div class="notice" style="margin-top: 10px; line-height: 1.6;">
        ${unknown
          ? '프린터에서 영수증이 나왔는지 먼저 확인하세요. 「다시 출력」은 같은 작업으로 보내므로 이미 나왔다면 또 뽑지 않습니다.'
          : '용지를 넣거나 덮개를 닫은 뒤 「다시 출력」을 누르세요. 프린터를 당장 쓸 수 없으면 브라우저 인쇄로 대신하거나 나중에 미출력 목록에서 뽑을 수 있습니다.'}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="closeModal()">나중에</button>
      ${job.document_type === 'RECEIPT' ? `<button class="btn btn-outline" type="button" onclick="skipPrintJob('${h(job.job_id)}')">출력 안 함</button>` : ''}
      ${job.document_type === 'RECEIPT' ? `<button class="btn btn-outline" type="button" onclick="browserPrintJob('${h(job.job_id)}')">브라우저로 인쇄</button>` : ''}
      <button class="btn btn-primary" type="button" onclick="retryPrintJob('${h(job.job_id)}')" data-autofocus>다시 출력</button>
    </div>
  `);
}

function retryPrintJob(jobId) {
  withBusy(async () => {
    const data = await api.request(`/pos/print-jobs/${jobId}/retry`, { method: 'POST' });
    closeModal();
    await runPrintJob(data.job, data.print_request);
  });
}

function browserPrintJob(jobId) {
  withBusy(async () => {
    const data = await api.request(`/pos/print-jobs/${jobId}/browser`, { method: 'POST' });
    closeModal();
    refreshPrintJobs();
    await printReceipt(data.receipt, { reprint: data.job.copy_type === 'REPRINT' });
  });
}

function skipPrintJob(jobId) {
  if (!confirm('이 영수증을 출력하지 않을까요? 필요하면 거래내역에서 재출력할 수 있습니다.')) return;
  withBusy(async () => {
    await api.request(`/pos/print-jobs/${jobId}/skip`, { method: 'POST' });
    closeModal();
    refreshPrintJobs();
    toast('미출력 목록에서 뺐습니다.');
  });
}

/* ---------- 미출력 영수증 ---------- */

async function refreshPrintJobs() {
  const chip = document.getElementById('printChip');
  if (!chip || !state.ctx?.terminal || !printsDirect()) {
    if (chip) chip.style.display = 'none';
    return [];
  }
  try {
    const { jobs } = await api.request('/pos/print-jobs/open');
    chip.style.display = jobs.length ? '' : 'none';
    chip.innerHTML = `<span class="dot" style="background: var(--warning, #d97706);"></span><span>미출력 영수증 ${jobs.length}건</span>`;
    return jobs;
  } catch {
    return [];
  }
}

async function openPrintJobs() {
  try {
    const jobs = await refreshPrintJobs();
    openModal(
      `
      ${modalHead('미출력 영수증')}
      <div class="modal-body">
        <div class="notice" style="margin-bottom: 12px; line-height: 1.6;">
          프린터 문제로 뽑지 못했거나 결과를 모르는 영수증입니다. 「다시 출력」은 같은 작업으로 보내므로 이미 나온 영수증은 또 뽑지 않습니다.
        </div>
        ${jobs.length
          ? `<table><thead><tr><th>시간</th><th>거래</th><th>상태</th><th></th></tr></thead><tbody>${jobs
              .map(
                (job) => `<tr>
                  <td>${fmtTime(job.created_at)}</td>
                  <td><b>${h(job.order_number || '시험 출력')}</b>${job.copy_type === 'REPRINT' ? ' <span class="badge gray">재출력</span>' : ''}</td>
                  <td><span class="badge ${job.status === 'FAILED' ? 'red' : 'orange'}">${job.status === 'FAILED' ? '실패' : '결과 모름'}</span>
                    <div class="muted" style="font-size: 12px;">${h(PRINT_ERRORS[job.error_code] || job.message || '')} · 시도 ${job.attempts}회</div></td>
                  <td style="white-space: nowrap;">
                    <button class="btn btn-primary btn-sm" type="button" onclick="retryPrintJob('${h(job.job_id)}')">다시 출력</button>
                    ${job.document_type === 'RECEIPT' ? `<button class="btn btn-outline btn-sm" type="button" onclick="browserPrintJob('${h(job.job_id)}')">브라우저</button>` : ''}
                    <button class="btn btn-outline btn-sm" type="button" onclick="skipPrintJob('${h(job.job_id)}')">출력 안 함</button>
                  </td>
                </tr>`
              )
              .join('')}</tbody></table>`
          : '<div class="notice">미출력 영수증이 없습니다.</div>'}
      </div>
      <div class="modal-foot"><button class="btn btn-outline" type="button" onclick="closeModal()">닫기</button></div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------- 프린터 설정 (단말기 설정 화면) ---------- */

function printerBoxHtml(van, owner) {
  const printer = van.printer || printerSettings();
  const modes = van.printer_modes || { BROWSER: '브라우저 인쇄', BRIDGE: '영수증 프린터 직접 출력 (Bridge)' };
  return `
    <div class="section-title">영수증 프린터</div>
    <div class="field"><label class="label" for="printerMode">출력 방법</label>
      <select id="printerMode" class="input" ${owner ? '' : 'disabled'}>${Object.entries(modes)
        .map(([mode, label]) => `<option value="${mode}" ${printer.mode === mode ? 'selected' : ''}>${h(label)}</option>`)
        .join('')}</select></div>
    <label style="display: flex; gap: 8px; align-items: center; font-weight: 700; margin-bottom: 6px;"><input id="printerAuto" type="checkbox" ${printer.auto_print ? 'checked' : ''} ${owner ? '' : 'disabled'} /> 결제가 끝나면 영수증 자동 출력</label>
    <label style="display: flex; gap: 8px; align-items: center; font-weight: 700; margin-bottom: 10px;"><input id="printerDrawer" type="checkbox" ${printer.open_drawer ? 'checked' : ''} ${owner ? '' : 'disabled'} /> 현금 거래 영수증을 뽑을 때 돈통 열기 (프린터 직접 출력)</label>
    <div class="notice" style="font-size: 12px; line-height: 1.6; margin-bottom: 8px;">
      프린터 직접 출력은 이 PC의 MAYDIN Bridge가 영수증 프린터(네트워크 9100 포트·USB)로 바로 보내고 용지를 자릅니다.
      용지 없음·덮개 열림이면 보내지 않고 알려 주며, 미출력 목록에서 다시 뽑을 수 있습니다.
      <div id="printerStatus" class="muted" style="margin-top: 4px;"></div>
    </div>
    <div style="display: flex; gap: 6px; flex-wrap: wrap;">
      ${owner ? '<button class="btn btn-primary btn-sm" type="button" onclick="savePrinterSettings()">프린터 설정 저장</button>' : ''}
      ${printer.mode === 'BRIDGE' ? '<button class="btn btn-outline btn-sm" type="button" onclick="checkPrinterStatus()">프린터 상태</button><button class="btn btn-outline btn-sm" type="button" onclick="printTestPage()">시험 출력</button>' : ''}
    </div>
  `;
}

function savePrinterSettings() {
  withBusy(async () => {
    const data = await api.request('/pos/printer/settings', {
      method: 'PATCH',
      body: {
        mode: document.getElementById('printerMode').value,
        auto_print: document.getElementById('printerAuto').checked,
        open_drawer: document.getElementById('printerDrawer').checked
      }
    });
    state.ctx.van = { ...state.ctx.van, printer: data.printer };
    toast('프린터 설정을 저장했습니다.');
    refreshPrintJobs();
    await openVanSettings();
  });
}

async function checkPrinterStatus() {
  const el = document.getElementById('printerStatus');
  if (el) el.textContent = '프린터 확인 중…';
  try {
    const status = await VanBridge.printerStatus();
    if (el) el.innerHTML = `${status.state === 'READY' ? '✓' : '⚠'} ${h(status.message)}${status.detail ? ` · ${h(status.detail)}` : ''}`;
  } catch (error) {
    if (el) el.textContent = error.message;
  }
}

function printTestPage() {
  withBusy(async () => {
    const data = await api.request('/pos/printer/test', { method: 'POST' });
    await runPrintJob(data.job, data.print_request);
  });
}
