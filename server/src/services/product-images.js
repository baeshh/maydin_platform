const crypto = require('crypto');
const { getAll, getOne, run, transaction } = require('../db');
const store = require('./media-store');

const MAX_IMAGES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const FULL_SIZE = 1200;
const THUMB_SIZE = 480;
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);

class ImageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const mediaUrl = (key) => `/media/${key}`;
const thumbKey = (key) => key.replace(/\.webp$/, '_480.webp');

function publicImage(row) {
  return {
    id: row.id,
    url: mediaUrl(row.image_key),
    thumb_url: mediaUrl(thumbKey(row.image_key)),
    source: row.source,
    width: row.width,
    height: row.height,
    sort_order: row.sort_order
  };
}

function ownedProduct(pharmacyId, productId) {
  const product = getOne('SELECT id, pharmacy_id, barcode, mfds_report_no FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', {
    id: Number(productId),
    pharmacy_id: pharmacyId
  });
  if (!product) throw new ImageError('상품을 찾을 수 없습니다.', 404);
  return product;
}

function listImages(productId) {
  return getAll('SELECT * FROM product_images WHERE product_id = @id AND image_key IS NOT NULL ORDER BY sort_order, id', { id: productId }).map(publicImage);
}

function productImages(pharmacyId, productId) {
  return listImages(ownedProduct(pharmacyId, productId).id);
}

// 첫 번째 사진의 작은 사진을 목록용 대표 사진(thumbnail_url)으로 쓴다. 사진이 없으면 약국이 직접 넣은 주소를 그대로 둔다.
function syncThumbnail(productId) {
  const first = getOne('SELECT image_key FROM product_images WHERE product_id = @id AND image_key IS NOT NULL ORDER BY sort_order, id LIMIT 1', { id: productId });
  if (first) {
    run('UPDATE products SET thumbnail_url = @url, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: productId, url: mediaUrl(thumbKey(first.image_key)) });
  } else {
    run("UPDATE products SET thumbnail_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND thumbnail_url LIKE '/media/products/%'", { id: productId });
  }
}

function addRow(product, { key, source, width, height, userId }) {
  const count = getOne('SELECT COUNT(*) AS n FROM product_images WHERE product_id = @id AND image_key IS NOT NULL', { id: product.id }).n;
  if (count >= MAX_IMAGES) throw new ImageError(`사진은 상품마다 ${MAX_IMAGES}장까지 올릴 수 있습니다.`);
  if (getOne('SELECT 1 AS found FROM product_images WHERE product_id = @id AND image_key = @key', { id: product.id, key })) {
    throw new ImageError('이미 이 상품에 있는 사진입니다.', 409);
  }
  const next = getOne('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_images WHERE product_id = @id', { id: product.id }).n;
  run(
    `INSERT INTO product_images (product_id, image_url, image_key, source, pharmacy_id, created_by, width, height, sort_order)
     VALUES (@product_id, @url, @key, @source, @pharmacy_id, @user_id, @width, @height, @sort_order)`,
    { product_id: product.id, url: mediaUrl(key), key, source, pharmacy_id: product.pharmacy_id, user_id: userId, width, height, sort_order: next }
  );
  syncThumbnail(product.id);
}

// 사진을 받아 방향을 바로잡고(EXIF 회전), 위치 등 메타데이터를 지운 WebP 두 크기로 저장한다.
async function uploadImage({ pharmacyId, productId, userId, buffer }) {
  const product = ownedProduct(pharmacyId, productId);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImageError('사진 파일을 보내 주세요.');
  if (buffer.length > MAX_BYTES) throw new ImageError('사진은 10MB 이하로 올려 주세요.', 413);
  const sharp = require('sharp');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new ImageError('사진 파일을 읽을 수 없습니다. JPG·PNG·WEBP·HEIC 사진을 올려 주세요.');
  }
  if (!INPUT_FORMATS.has(meta.format)) throw new ImageError('JPG·PNG·WEBP·HEIC 사진만 올릴 수 있습니다.');
  const base = () => sharp(buffer, { limitInputPixels: 50_000_000 }).rotate();
  const full = await base().resize({ width: FULL_SIZE, height: FULL_SIZE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const thumb = await base().resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  const key = `products/${crypto.createHash('sha256').update(full.data).digest('hex')}.webp`;
  await store.putObject(key, full.data);
  await store.putObject(thumbKey(key), thumb);
  transaction(() => addRow(product, { key, source: 'UPLOAD', width: full.info.width, height: full.info.height, userId }))();
  return listImages(product.id);
}

async function deleteImage({ pharmacyId, productId, imageId }) {
  const product = ownedProduct(pharmacyId, productId);
  const row = getOne('SELECT * FROM product_images WHERE id = @id AND product_id = @product_id', { id: Number(imageId), product_id: product.id });
  if (!row) throw new ImageError('사진을 찾을 수 없습니다.', 404);
  transaction(() => {
    run('DELETE FROM product_images WHERE id = @id', { id: row.id });
    syncThumbnail(product.id);
  })();
  // 다른 약국이 공유받아 쓰는 사진이면 파일은 남긴다.
  if (row.image_key && !getOne('SELECT 1 AS found FROM product_images WHERE image_key = @key', { key: row.image_key })) {
    await store.deleteObject(row.image_key).catch(() => {});
    await store.deleteObject(thumbKey(row.image_key)).catch(() => {});
  }
  return listImages(product.id);
}

function makePrimary({ pharmacyId, productId, imageId }) {
  const product = ownedProduct(pharmacyId, productId);
  const rows = getAll('SELECT id FROM product_images WHERE product_id = @id AND image_key IS NOT NULL ORDER BY sort_order, id', { id: product.id });
  if (!rows.some((r) => r.id === Number(imageId))) throw new ImageError('사진을 찾을 수 없습니다.', 404);
  transaction(() => {
    [Number(imageId), ...rows.map((r) => r.id).filter((id) => id !== Number(imageId))].forEach((id, index) => {
      run('UPDATE product_images SET sort_order = @n WHERE id = @id', { id, n: index });
    });
    syncThumbnail(product.id);
  })();
  return listImages(product.id);
}

// 같은 바코드나 같은 식약처 신고번호의 상품에 다른 약국이 올린 사진. 사진을 올린 약국이 공유를 허락했을 때만 보인다.
function sharedSuggestions({ pharmacyId, productId }) {
  const product = ownedProduct(pharmacyId, productId);
  if (!product.barcode && !product.mfds_report_no) return [];
  return getAll(
    `SELECT pi.image_key, MAX(pi.width) AS width, MAX(pi.height) AS height, MIN(p.product_name) AS product_name,
            COUNT(DISTINCT pi.pharmacy_id) AS pharmacies
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id
     JOIN pharmacies ph ON ph.id = pi.pharmacy_id
     WHERE pi.source = 'UPLOAD' AND pi.image_key IS NOT NULL
       AND pi.pharmacy_id != @pharmacy_id AND ph.share_product_photos = 1 AND ph.status = 'ACTIVE'
       AND ((@barcode IS NOT NULL AND p.barcode = @barcode) OR (@report_no IS NOT NULL AND p.mfds_report_no = @report_no))
       AND pi.image_key NOT IN (SELECT image_key FROM product_images WHERE product_id = @product_id AND image_key IS NOT NULL)
     GROUP BY pi.image_key
     ORDER BY pharmacies DESC, MIN(pi.id)
     LIMIT 12`,
    { pharmacy_id: pharmacyId, product_id: product.id, barcode: product.barcode || null, report_no: product.mfds_report_no || null }
  ).map((row) => ({
    image_key: row.image_key,
    url: mediaUrl(row.image_key),
    thumb_url: mediaUrl(thumbKey(row.image_key)),
    product_name: row.product_name,
    width: row.width,
    height: row.height
  }));
}

function useSharedImage({ pharmacyId, productId, imageKey, userId }) {
  const product = ownedProduct(pharmacyId, productId);
  const suggestion = sharedSuggestions({ pharmacyId, productId }).find((s) => s.image_key === imageKey);
  if (!suggestion) throw new ImageError('이 상품에 쓸 수 있는 공유 사진이 아닙니다.', 404);
  transaction(() => addRow(product, { key: imageKey, source: 'SHARED', width: suggestion.width, height: suggestion.height, userId }))();
  return listImages(product.id);
}

module.exports = {
  ImageError,
  MAX_BYTES,
  deleteImage,
  listImages,
  makePrimary,
  productImages,
  publicImage,
  sharedSuggestions,
  uploadImage,
  useSharedImage
};
