function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // 엑셀에서 수식으로 해석되지 않도록 =,+,-,@로 시작하는 문자열 앞에 작은따옴표를 붙인다.
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function sendCsv(res, rows, { asciiName, filename }) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(csv);
}

module.exports = { csvCell, sendCsv };
