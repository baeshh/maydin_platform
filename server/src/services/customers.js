const crypto = require('crypto');
const { getOne, getAll, run } = require('../db');

const CONSENT_VERSION = '2026-10-08';

const CONSENT_TYPES = {
  TERMS: { label: '이용약관 동의', required: true },
  PRIVACY: { label: '개인정보 수집·이용 동의', required: true },
  // 가입할 때는 꼭 받지만 철회는 막지 않는다. 철회하면 건강 정보를 바로 지운다.
  HEALTH_INFO: { label: '민감정보(알레르기·복용 약) 수집·이용 동의', sensitive: true },
  MARKETING_SMS: { label: '마케팅 문자 수신', marketing: true },
  MARKETING_KAKAO: { label: '마케팅 알림톡 수신', marketing: true },
  MARKETING_NIGHT: { label: '야간(21시~08시) 광고 수신', marketing: true },
  THIRD_PARTY: { label: '제3자 제공 동의' }
};
const MARKETING_CHANNELS = ['MARKETING_SMS', 'MARKETING_KAKAO'];

const CONSENT_SOURCES = {
  SIGNUP: '가입',
  APP: '고객 앱',
  POS: '매장',
  PARTNER: '파트너센터',
  NOTICE: '수신 동의 재확인 안내',
  MIGRATION: '기존 가입 정보'
};

const GENDERS = { F: '여성', M: '남성' };

const CHANNEL_TYPES = {
  COUNTER: '매장 카운터',
  FLYER: '전단·포스터',
  PARTNER: '제휴처',
  ONLINE: '온라인·SNS',
  ETC: '기타'
};

class CustomerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function currentConsents(customerId) {
  const rows = getAll(
    `SELECT cc.consent_type, cc.agreed, cc.version, cc.source, cc.created_at
     FROM customer_consents cc
     WHERE cc.customer_id = @customer_id
       AND cc.id = (SELECT MAX(id) FROM customer_consents WHERE customer_id = cc.customer_id AND consent_type = cc.consent_type)`,
    { customer_id: customerId }
  );
  const byType = new Map(rows.map((row) => [row.consent_type, row]));
  return Object.fromEntries(
    Object.entries(CONSENT_TYPES).map(([type, meta]) => {
      const row = byType.get(type);
      return [
        type,
        {
          label: meta.label,
          required: Boolean(meta.required),
          agreed: row ? row.agreed === 1 : false,
          recorded: Boolean(row),
          version: row ? row.version : null,
          source: row ? row.source : null,
          updated_at: row ? row.created_at : null
        }
      ];
    })
  );
}

function consentHistory(customerId, limit = 100) {
  return getAll(
    `SELECT cc.id, cc.consent_type, cc.agreed, cc.version, cc.source, cc.created_at, u.name AS created_by_name, u.role AS created_by_role
     FROM customer_consents cc
     LEFT JOIN users u ON u.id = cc.created_by
     WHERE cc.customer_id = @customer_id
     ORDER BY cc.id DESC
     LIMIT @limit`,
    { customer_id: customerId, limit }
  );
}

function normalizeConsentChanges(input) {
  if (!input || typeof input !== 'object') return {};
  const changes = {};
  for (const [type, value] of Object.entries(input)) {
    if (!CONSENT_TYPES[type]) throw new CustomerError('알 수 없는 동의 항목입니다.');
    if (value === undefined || value === null) continue;
    changes[type] = value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
  }
  return changes;
}

// 동의 이력은 지우지 않고 쌓는다. 요청에 들어온 항목 중 값이 바뀌었거나 처음 기록되는 것만 새 행으로 남긴다.
function recordConsents({ pharmacyId, customerId, changes, source, userId = null }) {
  const current = currentConsents(customerId);
  const next = Object.fromEntries(Object.entries(current).map(([type, value]) => [type, value.agreed]));
  Object.assign(next, changes);
  if (changes.MARKETING_NIGHT && !MARKETING_CHANNELS.some((type) => next[type])) {
    throw new CustomerError('야간 광고 수신은 문자 또는 알림톡 수신에 동의한 경우에만 선택할 수 있습니다.');
  }
  const touched = new Set(Object.keys(changes));
  if (!MARKETING_CHANNELS.some((type) => next[type]) && next.MARKETING_NIGHT) {
    next.MARKETING_NIGHT = false;
    touched.add('MARKETING_NIGHT');
  }

  const written = [];
  for (const type of Object.keys(CONSENT_TYPES)) {
    if (!touched.has(type)) continue;
    if (current[type].recorded && current[type].agreed === next[type]) continue;
    run(
      `INSERT INTO customer_consents (pharmacy_id, customer_id, consent_type, agreed, version, source, created_by)
       VALUES (@pharmacy_id, @customer_id, @consent_type, @agreed, @version, @source, @created_by)`,
      {
        pharmacy_id: pharmacyId,
        customer_id: customerId,
        consent_type: type,
        agreed: next[type] ? 1 : 0,
        version: CONSENT_VERSION,
        source,
        created_by: userId
      }
    );
    written.push(type);
  }
  run('UPDATE customers SET marketing_agree = @agree WHERE id = @id', {
    id: customerId,
    agree: MARKETING_CHANNELS.some((type) => next[type]) ? 1 : 0
  });
  return written;
}

// 광고성 정보 수신 동의는 2년마다 수신 동의 사실을 다시 알려야 한다. 안내 후에는 그 시점부터 다시 2년을 센다.
function recordConsentNotice({ pharmacyId, customerId, userId }) {
  const current = currentConsents(customerId);
  const agreed = Object.keys(CONSENT_TYPES).filter((type) => CONSENT_TYPES[type].marketing && current[type].agreed);
  for (const type of agreed) {
    run(
      `INSERT INTO customer_consents (pharmacy_id, customer_id, consent_type, agreed, version, source, created_by)
       VALUES (@pharmacy_id, @customer_id, @consent_type, 1, @version, 'NOTICE', @created_by)`,
      { pharmacy_id: pharmacyId, customer_id: customerId, consent_type: type, version: current[type].version || CONSENT_VERSION, created_by: userId }
    );
  }
  return agreed;
}

function optionalInt(value, min, max, message) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new CustomerError(message);
  return number;
}

function normalizeProfile(body, currentYear) {
  const profile = {};
  if ('birth_year' in body) profile.birth_year = optionalInt(body.birth_year, 1900, currentYear, '출생연도를 확인해 주세요.');
  if ('birth_month' in body) profile.birth_month = optionalInt(body.birth_month, 1, 12, '생일(월)을 확인해 주세요.');
  if ('birth_day' in body) profile.birth_day = optionalInt(body.birth_day, 1, 31, '생일(일)을 확인해 주세요.');
  if ('gender' in body) {
    const gender = body.gender ? String(body.gender).toUpperCase() : null;
    if (gender && !GENDERS[gender]) throw new CustomerError('성별 값이 올바르지 않습니다.');
    profile.gender = gender;
  }
  return profile;
}

function validateBirthday(month, day) {
  if ((month == null) !== (day == null)) throw new CustomerError('생일은 월과 일을 함께 입력해 주세요.');
  if (month == null) return;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) throw new CustomerError('생일 날짜를 확인해 주세요.');
}

function generateChannelCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8).toLowerCase();
    if (code.length < 8) continue;
    if (!getOne('SELECT 1 FROM signup_channels WHERE code = @code', { code })) return code;
  }
  throw new CustomerError('QR 코드를 만들지 못했습니다. 다시 시도해 주세요.', 500);
}

function findChannel(pharmacyId, code) {
  if (!code) return null;
  return (
    getOne(
      "SELECT * FROM signup_channels WHERE pharmacy_id = @pharmacy_id AND code = @code AND status = 'ACTIVE'",
      { pharmacy_id: pharmacyId, code: String(code).trim().toLowerCase() }
    ) || null
  );
}

module.exports = {
  CONSENT_VERSION,
  CONSENT_TYPES,
  CONSENT_SOURCES,
  MARKETING_CHANNELS,
  GENDERS,
  CHANNEL_TYPES,
  CustomerError,
  currentConsents,
  consentHistory,
  normalizeConsentChanges,
  recordConsents,
  recordConsentNotice,
  normalizeProfile,
  validateBirthday,
  generateChannelCode,
  findChannel
};
