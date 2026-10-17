// 영수증 문서(서버가 만든 줄 목록)를 ESC/POS 명령으로 바꾼다. Bridge가 카운터 PC에서 쓴다.
// 문서 줄 종류: text · pair(왼쪽·오른쪽) · rule(구분선) · barcode(CODE128) · qr · feed
// 한글은 CP949로 보낸다(국내 영수증 프린터 기본). 프린터가 UTF-8 모드면 encoding을 바꾼다.
const iconv = require('iconv-lite');

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

const ALIGN = { left: 0, center: 1, right: 2 };

// 영수증 프린터에서 한글·한자 등은 두 칸을 차지한다.
function charWidth(ch) {
  return ch.codePointAt(0) > 0x7f ? 2 : 1;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch);
  return width;
}

// 칸 수에 맞춰 자른다. 가능하면 띄어쓰기에서 줄을 바꾸고, 한 글자가 반만 걸치지 않게 한다.
function wrap(text, columns) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    let width = 0;
    let broken = false;
    for (const word of paragraph.split(/(?<= )/)) {
      const wordWidth = displayWidth(word);
      if (width > 0 && width + displayWidth(word.trimEnd()) > columns && wordWidth <= columns) {
        lines.push(line.trimEnd());
        line = '';
        width = 0;
        broken = true;
      }
      for (const ch of word) {
        const w = charWidth(ch);
        if (width + w > columns) {
          lines.push(line.trimEnd());
          line = '';
          width = 0;
          broken = true;
        }
        if (broken && width === 0 && ch === ' ') continue;
        line += ch;
        width += w;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function padTo(text, columns, align) {
  const space = Math.max(0, columns - displayWidth(text));
  if (align === 'right') return ' '.repeat(space) + text;
  if (align === 'center') return ' '.repeat(Math.floor(space / 2)) + text;
  return text;
}

// 왼쪽·오른쪽 값을 한 줄에. 넘치면 왼쪽을 먼저 쓰고 오른쪽은 다음 줄 끝에 붙인다.
function pairLines(left, right, columns) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  if (displayWidth(l) + displayWidth(r) + 1 <= columns) {
    return [l + ' '.repeat(columns - displayWidth(l) - displayWidth(r)) + r];
  }
  return [...wrap(l, columns), padTo(r, columns, 'right')];
}

// 문서를 글자만으로 그린다. 파일 출력(미리보기)과 테스트에 쓴다.
function renderText(document, { columns = 42 } = {}) {
  const out = [];
  for (const line of document.lines || []) {
    const width = line.size === 2 ? Math.floor(columns / 2) : columns;
    if (line.type === 'text') for (const part of wrap(line.text, width)) out.push(padTo(part, width, line.align || 'left'));
    else if (line.type === 'pair') out.push(...pairLines(line.left, line.right, columns));
    else if (line.type === 'rule') out.push((line.char || '-').repeat(columns));
    else if (line.type === 'barcode') out.push(padTo(`|| ${line.data} ||`, columns, 'center'));
    else if (line.type === 'qr') out.push(padTo('[QR]', columns, 'center'));
    else if (line.type === 'feed') for (let i = 0; i < (line.lines || 1); i += 1) out.push('');
  }
  if (document.cut !== false) out.push('- - - - - - - - (절단) - - - - - - - -');
  return out.join('\n');
}

function qrBytes(data) {
  const payload = Buffer.from(String(data), 'utf8');
  const length = payload.length + 3;
  return Buffer.concat([
    Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]), // 모델 2
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x05]), // 칸 크기
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]), // 오류 정정 M
    Buffer.from([GS, 0x28, 0x6b, length & 0xff, length >> 8, 0x31, 0x50, 0x30]),
    payload,
    Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]) // 인쇄
  ]);
}

function barcodeBytes(data) {
  const payload = Buffer.from(`{B${String(data).replace(/[^\x20-\x7e]/g, '')}`, 'ascii');
  return Buffer.concat([
    Buffer.from([GS, 0x68, 60]), // 높이
    Buffer.from([GS, 0x77, 2]), // 굵기
    Buffer.from([GS, 0x48, 2]), // 숫자는 바코드 아래
    Buffer.from([GS, 0x6b, 73, payload.length]),
    payload,
    Buffer.from([LF])
  ]);
}

// 돈통 열기: 2번 핀, 50ms 켬 · 500ms 끔.
const DRAWER_KICK = Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);
// 4줄 올린 뒤 부분 절단.
const FEED_AND_CUT = Buffer.from([ESC, 0x64, 0x04, GS, 0x56, 0x42, 0x00]);

function render(document, { columns = 42, encoding = 'cp949', koreanMode = true } = {}) {
  const chunks = [Buffer.from([ESC, 0x40])];
  if (koreanMode && encoding.toLowerCase() !== 'utf8') chunks.push(Buffer.from([ESC, 0x52, 13, FS, 0x26])); // 국가 한국 · 2바이트 문자
  if (document.open_drawer) chunks.push(DRAWER_KICK);
  const text = (value) => iconv.encode(String(value), encoding);
  const style = ({ align = 'left', bold = false, size = 1 } = {}) =>
    Buffer.from([ESC, 0x61, ALIGN[align] ?? 0, ESC, 0x45, bold ? 1 : 0, GS, 0x21, size === 2 ? 0x11 : 0x00]);

  for (const line of document.lines || []) {
    if (line.type === 'text') {
      const width = line.size === 2 ? Math.floor(columns / 2) : columns;
      chunks.push(style(line));
      for (const part of wrap(line.text, width)) chunks.push(text(part), Buffer.from([LF]));
    } else if (line.type === 'pair') {
      chunks.push(style({ bold: line.bold }));
      for (const part of pairLines(line.left, line.right, columns)) chunks.push(text(part), Buffer.from([LF]));
    } else if (line.type === 'rule') {
      chunks.push(style(), text((line.char || '-').repeat(columns)), Buffer.from([LF]));
    } else if (line.type === 'barcode') {
      chunks.push(style({ align: 'center' }), barcodeBytes(line.data));
    } else if (line.type === 'qr') {
      chunks.push(style({ align: 'center' }), qrBytes(line.data), Buffer.from([LF]));
    } else if (line.type === 'feed') {
      chunks.push(Buffer.from([ESC, 0x64, Math.min(10, line.lines || 1)]));
    }
  }
  chunks.push(style());
  if (document.cut !== false) chunks.push(FEED_AND_CUT);
  return Buffer.concat(chunks);
}

module.exports = { DRAWER_KICK, FEED_AND_CUT, displayWidth, render, renderText, wrap };
