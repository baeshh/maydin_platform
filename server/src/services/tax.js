const TAX_TYPE_LABELS = { TAXABLE: '과세', EXEMPT: '면세' };

// 판매가는 부가세 포함 금액이다. 부가세 = 과세 금액의 1/11 (원 단위 반올림), 공급가액 = 나머지.
function splitVat(taxableAmount) {
  const amount = Number(taxableAmount || 0);
  const vat = Math.round(amount / 11);
  return { supply: amount - vat, vat };
}

function taxBreakdown(items, extraTaxable = 0) {
  let taxable = extraTaxable;
  let exempt = 0;
  for (const item of items) {
    const net = Number(item.total_price || 0) - Number(item.discount_amount || 0);
    if ((item.tax_type || 'TAXABLE') === 'EXEMPT') exempt += net;
    else taxable += net;
  }
  return { taxable, exempt, ...splitVat(taxable) };
}

module.exports = { TAX_TYPE_LABELS, splitVat, taxBreakdown };
