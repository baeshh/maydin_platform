const crypto = require('crypto');
const { getOne } = require('../../db');
const { PAYMENT_METHODS, won } = require('../common');

// 서버가 만드는 영수증 문서. 프린터 명령이 아니라 줄 목록이라, Bridge가 프린터 폭·명령에 맞춰 출력한다.
// 화면 영수증(public/pos/receipt.js)과 같은 내용을 담는다.

const CASH_RECEIPT_PURPOSE = { INCOME: '소득공제', EXPENSE: '지출증빙' };

function signedWon(value) {
  return `${value < 0 ? '-' : ''}${won(Math.abs(value))}`;
}

function localTime(value) {
  if (!value) return '-';
  return getOne("SELECT strftime('%Y-%m-%d %H:%M', @value, 'localtime') AS t", { value }).t || String(value);
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length < 8 ? '' : `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

const text = (value, options = {}) => ({ type: 'text', text: String(value ?? ''), ...options });
const pair = (left, right, options = {}) => ({ type: 'pair', left: String(left ?? ''), right: String(right ?? ''), ...options });
const rule = (char = '-') => ({ type: 'rule', char });

function receiptDocument(receipt, { copyType = 'ORIGINAL', printedAt = null, openDrawer = false, origin = '' } = {}) {
  const { pharmacy, order, items, payments } = receipt;
  const isRefund = order.order_type === 'POS_REFUND';
  const lines = [];

  lines.push(text(pharmacy?.pharmacy_name || '', { align: 'center', bold: true, size: 2 }));
  if (pharmacy?.address) lines.push(text(pharmacy.address, { align: 'center' }));
  lines.push(text(`대표 ${pharmacy?.owner_name || ''}${pharmacy?.business_number ? ` · 사업자 ${pharmacy.business_number}` : ''}`, { align: 'center' }));
  if (pharmacy?.phone) lines.push(text(`TEL ${pharmacy.phone}`, { align: 'center' }));
  lines.push(rule('='));
  lines.push(text(isRefund ? '반품(취소) 영수증' : '영수증', { align: 'center', bold: true, size: 2 }));
  if (copyType === 'REPRINT') lines.push(text(`[재출력] ${localTime(printedAt)}`, { align: 'center', bold: true }));
  lines.push(rule('='));
  lines.push(pair('거래번호', order.order_number));
  if (isRefund) lines.push(pair('원거래', order.original_order_number || '-'));
  lines.push(pair('일시', localTime(order.created_at)));
  lines.push(pair('판매자', order.cashier_name || '-'));
  lines.push(pair('고객', order.customer_id ? `${order.customer_name || ''} ${maskPhone(order.customer_phone)}`.trim() : '비회원'));
  lines.push(rule());

  for (const item of items) {
    lines.push(text(`${item.tax_type === 'EXEMPT' ? '*' : ''}${item.product_name}${item.product_type === 'OTC' ? ' [일반의약품]' : ''}`, { bold: true }));
    lines.push(pair(`  ${won(item.price)} x ${Math.abs(item.quantity)}`, signedWon(item.total_price)));
    if (!isRefund && item.refunded_quantity > 0) lines.push(pair(`  └ 반품 ${item.refunded_quantity}개`, `-${won(item.refunded_amount)}`));
  }
  lines.push(rule());
  lines.push(pair('상품 합계', signedWon(order.total_product_amount)));
  if (order.discount_amount) lines.push(pair(`할인${order.discount_reason ? `(${order.discount_reason})` : ''}`, signedWon(-order.discount_amount)));
  lines.push(pair(isRefund ? '환불 금액' : '결제 금액', signedWon(order.final_amount), { bold: true }));
  if (receipt.tax) {
    lines.push(pair('과세 물품가액', signedWon(receipt.tax.supply)));
    lines.push(pair('부가세', signedWon(receipt.tax.vat)));
    if (receipt.tax.exempt) lines.push(pair('면세 물품가액 (*)', signedWon(receipt.tax.exempt)));
  }
  lines.push(rule());

  for (const p of payments) {
    lines.push(pair(`${PAYMENT_METHODS[p.payment_method] || p.payment_method}${p.card_company ? `(${p.card_company})` : ''}${p.is_demo ? ' [데모]' : ''}`, signedWon(p.paid_amount)));
    if (p.payment_method === 'CARD' && p.paid_amount > 0 && p.installment_months != null) {
      lines.push(pair('  할부', p.installment_months ? `${p.installment_months}개월` : '일시불'));
    }
    if (p.approval_number) lines.push(pair(`  ${p.paid_amount < 0 ? '취소 승인번호' : '승인번호'}`, p.approval_number));
    if (p.received_amount) {
      lines.push(pair('  받은 금액', won(p.received_amount)));
      lines.push(pair('  거스름돈', won(p.change_amount)));
    }
  }
  for (const cr of receipt.cash_receipts || []) {
    lines.push(rule());
    const canceled = cr.kind === 'CANCEL';
    lines.push(text(`${canceled ? '현금영수증 취소' : `현금영수증 (${CASH_RECEIPT_PURPOSE[cr.purpose] || '소득공제'})`}${cr.is_demo ? ' [데모]' : ''}`, { bold: true }));
    lines.push(pair('  승인번호', cr.approval_number === '-' ? '단말기에서 취소' : cr.approval_number));
    if (canceled) lines.push(pair('  원승인번호', cr.original_approval_number || '-'));
    if (cr.masked_identity) lines.push(pair('  식별번호', cr.masked_identity));
    lines.push(pair('  금액', won(cr.amount)));
  }
  if (!receipt.cash_receipts?.length) {
    for (const p of payments) if (p.cash_receipt_number) lines.push(pair('  현금영수증', p.cash_receipt_number));
  }

  const points = receipt.points;
  if (points && (points.earned || points.reward || payments.some((p) => p.payment_method === 'POINT'))) {
    lines.push(rule());
    if (points.earned) lines.push(pair(points.earned > 0 ? '적립 포인트' : '적립 취소', `${points.earned > 0 ? '+' : ''}${points.earned.toLocaleString('ko-KR')}P`));
    if (points.reward) lines.push(pair('친구 추천 보상', `+${points.reward.toLocaleString('ko-KR')}P`));
    if (points.balance != null) lines.push(pair('현재 포인트 잔액', `${points.balance.toLocaleString('ko-KR')}P`));
  }
  if (order.order_status === 'CANCELED') lines.push(text('전체 취소된 거래', { align: 'center', bold: true }));
  if (isRefund && order.refund_reason) lines.push(text(`사유: ${order.refund_reason}`));
  lines.push(rule());
  if (payments.some((p) => p.is_demo)) lines.push(text('※ VAN 데모 승인 거래 · 실제 결제 아님', { align: 'center', bold: true }));
  if (items.some((i) => i.product_type === 'OTC')) lines.push(text('일반의약품은 약사와 상담 후 용법·용량을 지켜 복용하세요.', { align: 'center' }));
  lines.push(text('이용해 주셔서 감사합니다.', { align: 'center' }));
  lines.push({ type: 'barcode', format: 'CODE128', data: order.order_number });
  if (!isRefund) lines.push(text('교환·반품 시 이 바코드를 보여 주세요', { align: 'center' }));

  const signup = receipt.signup_code;
  if (signup) {
    lines.push(rule());
    lines.push(text('멤버십 가입 코드', { align: 'center', bold: true }));
    lines.push(text(signup.code, { align: 'center', bold: true, size: 2 }));
    lines.push({ type: 'qr', data: `${origin}/join.html?pharmacyCode=${encodeURIComponent(pharmacy?.pharmacy_code || '')}&code=${encodeURIComponent(signup.raw)}` });
    lines.push(text('QR을 찍고 가입하면 이번 구매도 포인트로 적립돼요', { align: 'center' }));
    lines.push(text(`${localTime(signup.expires_at)}까지 · 1회용`, { align: 'center' }));
  }

  return { version: 1, kind: 'RECEIPT', copy_type: copyType, open_drawer: Boolean(openDrawer), cut: true, lines };
}

function testDocument({ terminalName, printedAt }) {
  return {
    version: 1,
    kind: 'TEST',
    copy_type: 'ORIGINAL',
    open_drawer: false,
    cut: true,
    lines: [
      text('MAYDIN 영수증 프린터 시험 출력', { align: 'center', bold: true }),
      rule(),
      pair('카운터', terminalName || '-'),
      pair('시각', localTime(printedAt)),
      text('가나다라마바사 ABC 0123456789'),
      pair('왼쪽 정렬', '오른쪽 정렬'),
      { type: 'barcode', format: 'CODE128', data: 'MAYDIN-TEST' },
      text('한글이 깨지면 Bridge 인코딩(BRIDGE_PRINTER_ENCODING)을 확인하세요.', { align: 'center' })
    ]
  };
}

// Bridge가 받은 문서를 그대로 출력했는지 맞춰 보는 값. JSON 직렬화 순서가 고정되도록 문서는 서버에서만 만든다.
function documentHash(document) {
  return crypto.createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

module.exports = { CASH_RECEIPT_PURPOSE, documentHash, receiptDocument, testDocument };
