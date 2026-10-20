const fs = require('fs');
const path = require('path');

// 상품 사진 저장소. MEDIA_BUCKET이 있으면 S3(운영), 없으면 서버 디스크(개발·테스트).
// 키는 내용의 sha256이라 같은 사진은 한 번만 저장되고, 여러 약국이 같은 키를 함께 쓸 수 있다.
const KEY_PATTERN = /^products\/[0-9a-f]{64}(_480)?\.webp$/;

let s3 = null;
function s3Client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({ region: process.env.MEDIA_REGION || process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return s3;
}

const bucket = () => process.env.MEDIA_BUCKET || '';
const localDir = () => process.env.MEDIA_DIR || path.join(__dirname, '../../uploads/media');

function assertKey(key) {
  if (!KEY_PATTERN.test(key)) throw new Error('잘못된 사진 키입니다.');
}

async function putObject(key, body, contentType = 'image/webp') {
  assertKey(key);
  if (bucket()) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(
      new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' })
    );
    return;
  }
  const file = path.join(localDir(), key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// { body: Buffer|Readable, contentType } 또는 없으면 null
async function getObject(key) {
  assertKey(key);
  if (bucket()) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const res = await s3Client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      return { body: res.Body, contentType: res.ContentType || 'image/webp' };
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }
  const file = path.join(localDir(), key);
  return fs.existsSync(file) ? { body: fs.readFileSync(file), contentType: 'image/webp' } : null;
}

async function deleteObject(key) {
  assertKey(key);
  if (bucket()) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
    return;
  }
  fs.rmSync(path.join(localDir(), key), { force: true });
}

module.exports = { KEY_PATTERN, deleteObject, getObject, putObject, storageKind: () => (bucket() ? 'S3' : 'LOCAL') };
