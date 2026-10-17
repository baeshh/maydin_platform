// MAYDIN POS · 승인 정리 · 수동 승인 대조
/* ---------- 결과 모름 · 판매에 안 쓴 승인 ----------
 * 결제 도중 화면이 닫히거나 응답이 끊기면 승인이 판매 없이 남을 수 있다. 일마감 전에 모두 정리해야 한다.
 */

const APPROVAL_STATUS = {
  REQUESTED: ['orange', '단말기 응답 대기'],
  UNKNOWN: ['red', '결과 모름'],
  APPROVED: ['blue', '판매에 안 씀']
};

async function refreshPendingApprovals() {
  const chip = document.getElementById('approvalChip');
  if (!chip || !state.ctx?.terminal) return [];
  try {
    const { approvals } = await api.request('/pos/payments/pending');
    chip.style.display = approvals.length ? '' : 'none';
    chip.innerHTML = `<span class="dot" style="background: var(--danger);"></span><span>승인 정리 ${approvals.length}건</span>`;
    return approvals;
  } catch {
    return [];
  }
}

async function openApprovalManager() {
  try {
    const approvals = await refreshPendingApprovals();
    const owner = isOwner();
    openModal(
      `
      ${modalHead('승인 정리 (카드 · 현금영수증)')}
      <div class="modal-body">
        <div class="notice" style="margin-bottom: 12px; line-height: 1.6;">
          결과를 모르는 승인·현금영수증 발급은 <b>다시 요청하지 말고</b> 「결과 조회」로 확인하세요. 판매에 안 쓴 승인은 고객에게 돈이 빠져나간 상태이므로 취소해야 합니다.
          모두 정리해야 일마감할 수 있습니다.
        </div>
        ${approvals.length
          ? `<table><thead><tr><th>시간</th><th>결제</th><th class="num">금액</th><th>상태</th><th></th></tr></thead><tbody>${approvals
              .map((tx) => {
                const [color, label] = APPROVAL_STATUS[tx.status] || ['gray', tx.status];
                const pending = PENDING_VAN.includes(tx.status);
                return `<tr>
                  <td>${fmtTime(tx.created_at)}</td>
                  <td>${tx.transaction_type === 'CASH_RECEIPT' ? '현금영수증 발급' : METHOD_LABELS[tx.payment_method] || h(tx.payment_method)}${demoTag(tx)}${tx.approval_number ? `<div class="muted" style="font-size: 12px;">승인번호 ${h(tx.approval_number)}${tx.card_company ? ` · ${h(tx.card_company)}` : ''}</div>` : ''}</td>
                  <td class="num">${won(tx.amount)}</td>
                  <td><span class="badge ${color}">${label}</span>${tx.message ? `<div class="muted" style="font-size: 12px;">${h(tx.message)}</div>` : ''}</td>
                  <td style="min-width: 220px;">${pending
                    ? `<button class="btn btn-primary btn-sm" type="button" onclick="checkApproval(${tx.id})">결과 조회</button>
                       ${owner
                         ? `<div style="display: flex; gap: 4px; margin-top: 6px;"><input id="resolve-${tx.id}" class="input" style="padding: 6px 8px;" placeholder="영수증 승인번호" />
                            <button class="btn btn-outline btn-sm" type="button" onclick="resolveApproval(${tx.id}, true)">승인됨</button>
                            <button class="btn btn-outline btn-sm" type="button" onclick="resolveApproval(${tx.id}, false)">승인 안 됨</button></div>`
                         : ''}`
                    : `<button class="btn btn-outline btn-sm" type="button" onclick="cancelApproval(${tx.id})">승인 취소</button>`}</td>
                </tr>`;
              })
              .join('')}</tbody></table>`
          : '<div class="notice">정리할 승인이 없습니다.</div>'}
      </div>
      <div class="modal-foot"><button class="btn btn-outline" type="button" onclick="closeModal()">닫기</button></div>
    `,
      { size: 'wide' }
    );
    return approvals;
  } catch (error) {
    toast(error.message, 'error');
    return [];
  }
}

async function findPendingApproval(id) {
  const { approvals } = await api.request('/pos/payments/pending');
  const tx = approvals.find((item) => item.id === id);
  if (!tx) throw new Error('이미 정리된 승인입니다.');
  return tx;
}

function checkApproval(id) {
  withBusy(async () => {
    try {
      const tx = await findPendingApproval(id);
      const body = { van_transaction_id: id };
      const cashReceipt = tx.transaction_type === 'CASH_RECEIPT';
      if (tx.source === 'BRIDGE') {
        body.bridge_result = await VanBridge.inquire({
          protocol: 'maydin-bridge/1',
          terminal_id: state.ctx.terminal.id,
          request_id: tx.request_id,
          transaction_type: cashReceipt ? 'CASH_RECEIPT' : 'APPROVE',
          method: tx.payment_method,
          amount: tx.amount,
          ...(cashReceipt ? { purpose: tx.cash_receipt_purpose } : {})
        });
      }
      const data = await api.request('/pos/payments/reconcile', { method: 'POST', body });
      const status = data.van_transaction.status;
      toast(
        cashReceipt
          ? status === 'USED'
            ? '발급된 것으로 확인해 판매에 연결했습니다.'
            : status === 'NOT_FOUND'
              ? '발급되지 않았습니다. 거래내역에서 다시 발급할 수 있습니다.'
              : '아직 결과를 모릅니다.'
          : status === 'APPROVED'
            ? '승인된 것으로 확인했습니다. 판매에 쓰지 않으면 취소해 주세요.'
            : status === 'NOT_FOUND'
              ? '승인되지 않은 것으로 확인했습니다.'
              : '아직 결과를 모릅니다.'
      );
    } finally {
      await openApprovalManager();
    }
  });
}

function resolveApproval(id, approved) {
  const number = document.getElementById(`resolve-${id}`)?.value.trim();
  if (approved && !number) return toast('단말기 영수증의 승인번호를 입력해 주세요.', 'error');
  withBusy(async () => {
    await api.request('/pos/payments/reconcile', {
      method: 'POST',
      body: { van_transaction_id: id, resolution: approved ? 'APPROVED' : 'NOT_APPROVED', approval_number: approved ? number : undefined }
    });
    toast(approved ? '승인으로 확정했습니다. 판매에 쓰지 않으면 취소해 주세요.' : '승인 안 됨으로 확정했습니다.');
    await openApprovalManager();
  });
}

function cancelApproval(id) {
  if (!confirm('이 승인을 취소할까요? 판매에 쓰지 않은 승인만 취소합니다.')) return;
  withBusy(async () => {
    try {
      const tx = await findPendingApproval(id);
      await voidApproval(tx);
      toast(`승인을 취소했습니다.${tx.is_demo ? ' (데모)' : ''}`);
    } finally {
      await openApprovalManager();
    }
  });
}

/* ---------- 수동 승인 대조 ----------
 * 승인번호를 직접 입력했거나 관리자가 확정한 카드·간편결제는 서버가 VAN으로 확인하지 못했다.
 * 마감 전에 단말기 영수증·VAN 매출 내역과 맞춰 본다.
 */

async function openUnverifiedPayments() {
  try {
    const { payments } = await api.request(`/pos/payments/unverified?session_id=${state.session.id}`);
    openModal(
      `
      ${modalHead('수동 승인 대조')}
      <div class="modal-body">
        <div class="notice" style="margin-bottom: 12px; line-height: 1.6;">
          아래 결제는 승인번호를 직접 입력해 서버가 카드사 승인을 확인하지 못했습니다. <b>단말기 영수증(또는 VAN 매출 내역)</b>과 금액·승인번호를 맞춰 보세요.
          다르면 「다름」으로 내용을 남기고 단말기에서 취소·재승인 등으로 바로잡아 주세요.
        </div>
        ${payments.length
          ? `<table><thead><tr><th>시간</th><th>거래</th><th>결제</th><th class="num">금액</th><th>승인번호</th><th></th></tr></thead><tbody>${payments
              .map(
                (p) => `<tr>
                  <td>${fmtTime(p.paid_at)}</td>
                  <td>${h(p.order_number)}${p.paid_amount < 0 ? ' <span class="badge red">환불</span>' : ''}</td>
                  <td>${METHOD_LABELS[p.payment_method] || h(p.payment_method)}${p.card_company ? `<div class="muted" style="font-size: 12px;">${h(p.card_company)}</div>` : ''}</td>
                  <td class="num">${signedWon(p.paid_amount)}</td>
                  <td><b>${h(p.approval_number || '-')}</b></td>
                  <td style="white-space: nowrap;">
                    <button class="btn btn-outline btn-sm" type="button" onclick="verifyPayment(${p.id}, 'MATCHED')">일치</button>
                    <button class="btn btn-outline btn-sm" type="button" onclick="verifyPayment(${p.id}, 'MISMATCH')">다름</button>
                  </td>
                </tr>`
              )
              .join('')}</tbody></table>`
          : '<div class="notice">대조할 결제가 없습니다.</div>'}
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" type="button" onclick="openClose()">마감 화면으로</button>
        ${payments.length ? `<button class="btn btn-primary" type="button" onclick='verifyAllPayments(${JSON.stringify(payments.map((p) => p.id))})'>${payments.length}건 모두 영수증과 일치</button>` : ''}
      </div>
    `,
      { size: 'wide' }
    );
  } catch (error) {
    toast(error.message, 'error');
  }
}

function verifyPayment(id, result) {
  let note;
  if (result === 'MISMATCH') {
    note = prompt('영수증과 무엇이 다른지 적어 주세요. (예: 승인번호 다름, 금액 다름)');
    if (!note) return;
  }
  withBusy(async () => {
    await api.request(`/pos/payments/${id}/verify`, { method: 'POST', body: { result, note } });
    toast(result === 'MATCHED' ? '대조 완료' : '불일치로 기록했습니다.');
    await openUnverifiedPayments();
  });
}

function verifyAllPayments(ids) {
  if (!confirm(`${ids.length}건 모두 단말기 영수증과 승인번호·금액이 일치하는 것을 확인했나요?`)) return;
  withBusy(async () => {
    const data = await api.request('/pos/payments/verify-matched', { method: 'POST', body: { payment_ids: ids } });
    toast(`${data.verified}건 대조 완료`);
    await refreshSession();
    openClose();
  });
}
