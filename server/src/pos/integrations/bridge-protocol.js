const crypto = require('crypto');

// MAYDIN Bridge ↔ 서버 결과 서명 규격 (maydin-bridge/1).
// Bridge는 카운터 PC에서 카드 단말기·VAN Agent와 통신하고, 결과를 카운터 등록 때 받은 Bridge 키로 서명해 POS 화면에 돌려준다.
// POS 화면은 결과를 그대로 서버에 전달만 한다. 서명이 맞지 않으면 서버는 승인으로 인정하지 않는다.
// 서명 대상 문자열 = 아래 필드를 순서대로 줄바꿈으로 이은 값. 없는 값은 빈 문자열.
const BRIDGE_PROTOCOL = 'maydin-bridge/1';
const SIGNED_FIELDS = [
  'terminal_id',
  'request_id',
  'transaction_type',
  'status',
  'method',
  'amount',
  'installment_months',
  'approval_number',
  'original_approval_number',
  'card_company',
  'van_reference',
  'occurred_at',
  'demo'
];

function canonical(payload) {
  return [BRIDGE_PROTOCOL, ...SIGNED_FIELDS.map((field) => (payload[field] === undefined || payload[field] === null ? '' : String(payload[field])))].join('\n');
}

function sign(key, payload) {
  return crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(canonical(payload)).digest('hex');
}

function signatureMatches(key, payload) {
  const expected = Buffer.from(sign(key, payload), 'hex');
  const given = Buffer.from(String(payload.signature || ''), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function newBridgeKey() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = { BRIDGE_PROTOCOL, SIGNED_FIELDS, canonical, newBridgeKey, sign, signatureMatches };
