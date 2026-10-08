const crypto = require('crypto');

// 건강 정보(민감정보)는 DB에 암호문으로만 둔다. 운영에서는 DATA_ENCRYPTION_KEY(32바이트 hex)를 꼭 따로 설정한다.
// 키를 바꾸거나 잃어버리면 기존 암호문은 복구할 수 없다.
const KEY = process.env.DATA_ENCRYPTION_KEY
  ? Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex')
  : crypto.createHash('sha256').update(`maydin-data:${process.env.JWT_SECRET || 'dev-secret-change-me'}`).digest();
if (KEY.length !== 32) throw new Error('DATA_ENCRYPTION_KEY는 64자리 hex(32바이트)여야 합니다.');

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

function decrypt(value) {
  if (!value) return null;
  const raw = Buffer.from(String(value).replace(/^v1:/, ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// IP는 그대로 저장하지 않고 같은 기기 반복 가입을 알아볼 수 있을 만큼만 남긴다.
function hashIp(ip) {
  return crypto.createHmac('sha256', KEY).update(String(ip || '')).digest('hex').slice(0, 24);
}

module.exports = { encrypt, decrypt, hashIp };
