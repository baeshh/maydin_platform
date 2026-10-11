// MAYDIN POS · 영수증
/* ---------- 영수증 ---------- */

function receiptHtml(r, { reprint = false } = {}) {
  const { pharmacy, order, items, payments } = r;
  const isRefund = order.order_type === 'POS_REFUND';
  const hasOtc = items.some((i) => i.product_type === 'OTC');
  return `
    <div class="receipt">
      <h3>${h(pharmacy?.pharmacy_name || '')}</h3>
      <div class="center">${h(pharmacy?.address || '')}</div>
      <div class="center">대표 ${h(pharmacy?.owner_name || '')}${pharmacy?.business_number ? ` · 사업자 ${h(pharmacy.business_number)}` : ''}</div>
      ${pharmacy?.phone ? `<div class="center">TEL ${h(pharmacy.phone)}</div>` : ''}
      <div class="title-tag">${isRefund ? '반품(취소) 영수증' : '영수증'}${reprint ? ' · 재출력' : ''}</div>
      <div class="row"><span>거래번호</span><span>${h(order.order_number)}</span></div>
      ${isRefund ? `<div class="row"><span>원거래</span><span>${h(order.original_order_number || '-')}</span></div>` : ''}
      <div class="row"><span>일시</span><span>${fmtDateTime(order.created_at)}</span></div>
      <div class="row"><span>판매자</span><span>${h(order.cashier_name || '-')}</span></div>
      <div class="row"><span>고객</span><span>${order.customer_id ? `${h(order.customer_name)} ${h(maskPhone(order.customer_phone))}` : '비회원'}</span></div>
      <div class="hr"></div>
      ${items
        .map(
          (i) => `
          <div class="bold">${i.tax_type === 'EXEMPT' ? '*' : ''}${h(i.product_name)}${i.product_type === 'OTC' ? ' [일반의약품]' : ''}</div>
          <div class="row"><span>${won(i.price)} × ${Math.abs(i.quantity)}</span><span>${signedWon(i.total_price)}</span></div>
          ${!isRefund && i.refunded_quantity > 0 ? `<div class="row"><span>  └ 반품 ${i.refunded_quantity}개</span><span>-${won(i.refunded_amount)}</span></div>` : ''}
        `
        )
        .join('')}
      <div class="hr"></div>
      <div class="row"><span>상품 합계</span><span>${signedWon(order.total_product_amount)}</span></div>
      ${order.discount_amount ? `<div class="row"><span>할인${order.discount_reason ? `(${h(order.discount_reason)})` : ''}</span><span>${signedWon(-order.discount_amount)}</span></div>` : ''}
      <div class="row big"><span>${isRefund ? '환불 금액' : '결제 금액'}</span><span>${signedWon(order.final_amount)}</span></div>
      ${r.tax ? `
        <div class="row"><span>과세 물품가액</span><span>${signedWon(r.tax.supply)}</span></div>
        <div class="row"><span>부가세</span><span>${signedWon(r.tax.vat)}</span></div>
        ${r.tax.exempt ? `<div class="row"><span>면세 물품가액 (*)</span><span>${signedWon(r.tax.exempt)}</span></div>` : ''}` : ''}
      <div class="hr"></div>
      ${payments
        .map(
          (p) => `
          <div class="row"><span>${METHOD_LABELS[p.payment_method] || h(p.payment_method)}${p.card_company ? `(${h(p.card_company)})` : ''}${p.is_demo ? ' [데모]' : ''}</span><span>${signedWon(p.paid_amount)}</span></div>
          ${p.payment_method === 'CARD' && p.paid_amount > 0 && p.installment_months != null ? `<div class="row"><span>  할부</span><span>${p.installment_months ? `${p.installment_months}개월` : '일시불'}</span></div>` : ''}
          ${p.approval_number ? `<div class="row"><span>  ${p.paid_amount < 0 ? '취소 승인번호' : '승인번호'}</span><span>${h(p.approval_number)}</span></div>` : ''}
          ${p.received_amount ? `<div class="row"><span>  받은 금액</span><span>${won(p.received_amount)}</span></div><div class="row"><span>  거스름돈</span><span>${won(p.change_amount)}</span></div>` : ''}
          ${p.cash_receipt_number ? `<div class="row"><span>  현금영수증</span><span>${h(p.cash_receipt_number)}</span></div>` : ''}
        `
        )
        .join('')}
      ${
        r.points && (r.points.earned || r.points.reward || payments.some((p) => p.payment_method === 'POINT'))
          ? `<div class="hr"></div>
             ${r.points.earned ? `<div class="row"><span>${r.points.earned > 0 ? '적립 포인트' : '적립 취소'}</span><span>${r.points.earned > 0 ? '+' : ''}${r.points.earned.toLocaleString()}P</span></div>` : ''}
             ${r.points.reward ? `<div class="row"><span>친구 추천 보상</span><span>+${r.points.reward.toLocaleString()}P</span></div>` : ''}
             ${r.points.balance != null ? `<div class="row"><span>현재 포인트 잔액</span><span>${r.points.balance.toLocaleString()}P</span></div>` : ''}`
          : ''
      }
      ${order.order_status === 'CANCELED' ? '<div class="title-tag">전체 취소된 거래</div>' : ''}
      ${order.refund_reason && isRefund ? `<div>사유: ${h(order.refund_reason)}</div>` : ''}
      <div class="hr"></div>
      ${payments.some((p) => p.is_demo) ? '<div class="center bold">※ VAN 데모 승인 거래 · 실제 결제 아님</div>' : ''}
      ${hasOtc ? '<div class="center">일반의약품은 약사와 상담 후 용법·용량을 지켜 복용하세요.</div>' : ''}
      <div class="center">이용해 주셔서 감사합니다.</div>
      <svg class="rcpt-barcode" data-barcode="${h(order.order_number)}" data-height="42" data-width="1.4"></svg>
      ${isRefund ? '' : '<div class="center" style="font-size: 11px;">교환·반품 시 이 바코드를 보여 주세요</div>'}
      ${r.signup_code ? `
        <div class="hr"></div>
        <div class="center bold">멤버십 가입 코드</div>
        <div class="rcpt-code">${h(r.signup_code.code)}</div>
        <div class="rcpt-qr" data-qr="${h(`${location.origin}/join.html?pharmacyCode=${encodeURIComponent(pharmacy?.pharmacy_code || '')}&code=${encodeURIComponent(r.signup_code.raw)}`)}"></div>
        <div class="center" style="font-size: 11px;">QR을 찍고 가입하면 이번 구매도 포인트로 적립돼요<br />${fmtDateTime(r.signup_code.expires_at)}까지 · 1회용</div>` : ''}
    </div>
  `;
}

async function printReceipt(r, options = {}) {
  const area = document.getElementById('printArea');
  area.innerHTML = receiptHtml(r, options);
  await renderCodes(area);
  setTimeout(() => window.print(), 50);
}

function showReceipt(r, { fresh = false } = {}) {
  window.__lastReceipt = r;
  const changeRow = r.payments.find((p) => p.change_amount);
  openModal(`
    ${modalHead(fresh ? '결제 완료' : '영수증')}
    <div class="modal-body" style="background: var(--bg-canvas);">
      ${fresh ? `<div class="notice" style="background: var(--success-soft); color: var(--success); margin-bottom: 14px; font-size: 15px;">판매가 저장되었습니다 · ${won(r.order.final_amount)}${changeRow ? ` · 거스름돈 <b>${won(changeRow.change_amount)}</b>` : ''}</div>` : ''}
      ${receiptHtml(r)}
    </div>
    <div class="modal-foot">
      <button class="btn btn-outline" type="button" onclick="printReceipt(window.__lastReceipt)">영수증 인쇄</button>
      <button class="btn btn-primary" type="button" onclick="closeModal()" data-autofocus>${fresh ? '다음 판매 (Enter)' : '닫기'}</button>
    </div>
  `);
}
