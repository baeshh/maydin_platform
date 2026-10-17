const crypto = require('crypto');

// 운영(NODE_ENV=production)에서는 비밀키가 없거나 약하면 서버를 띄우지 않는다.
// 개발·테스트에서만 아래 개발용 값을 쓴다. 이 값은 저장소에 공개돼 있어 운영에서 쓰면 누구나 토큰을 위조할 수 있다.
const DEV_JWT_SECRET = 'dev-secret-change-me';
const WEAK_SECRETS = new Set([DEV_JWT_SECRET, 'change-me', 'changeme', 'secret', 'jwt-secret', 'your-secret', 'maydin']);
const MIN_JWT_SECRET_LENGTH = 32;

class SecretConfigError extends Error {}

const isProduction = () => process.env.NODE_ENV === 'production';

function jwtSecret() {
  const value = String(process.env.JWT_SECRET || '');
  if (!isProduction()) return value || DEV_JWT_SECRET;
  if (!value) throw new SecretConfigError('JWT_SECRET이 설정되지 않았습니다. 운영에서는 32자 이상 무작위 값을 넣어야 서버가 시작됩니다.');
  if (value.length < MIN_JWT_SECRET_LENGTH || WEAK_SECRETS.has(value.toLowerCase())) {
    throw new SecretConfigError(`JWT_SECRET이 너무 짧거나 알려진 값입니다. ${MIN_JWT_SECRET_LENGTH}자 이상 무작위 값으로 바꿔 주세요.`);
  }
  return value;
}

// 예전 버전은 DATA_ENCRYPTION_KEY가 없으면 JWT_SECRET에서 키를 만들었다. 개발 DB 호환용으로만 남긴다.
function legacyDataKey(secret) {
  return crypto.createHash('sha256').update(`maydin-data:${secret}`).digest();
}

function dataEncryptionKey() {
  const hex = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new SecretConfigError('DATA_ENCRYPTION_KEY는 64자리 hex(32바이트)여야 합니다.');
    if (/^(.)\1+$/.test(hex)) throw new SecretConfigError('DATA_ENCRYPTION_KEY가 같은 글자만 반복됩니다. 무작위 값으로 바꿔 주세요.');
    return Buffer.from(hex, 'hex');
  }
  if (isProduction()) {
    throw new SecretConfigError(
      'DATA_ENCRYPTION_KEY가 설정되지 않았습니다. 운영에서는 64자리 hex 키를 따로 넣어야 서버가 시작됩니다. ' +
        '이미 운영 중인 DB라면 `npm run security:check -- --print-legacy-data-key`로 지금까지 쓰던 키를 확인해 그 값을 넣어 주세요.'
    );
  }
  return legacyDataKey(jwtSecret());
}

// 서버 시작 전에 부른다. 문제가 있으면 SecretConfigError를 던진다.
function assertSecrets() {
  jwtSecret();
  dataEncryptionKey();
}

module.exports = { DEV_JWT_SECRET, SecretConfigError, assertSecrets, dataEncryptionKey, isProduction, jwtSecret, legacyDataKey };
