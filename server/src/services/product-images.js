const crypto = require('crypto');
const { getAll, getOne, run, transaction } = require('../db');
const store = require('./media-store');
const webImages = require('./web-images');

const MAX_IMAGES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const FULL_SIZE = 1200;
const THUMB_SIZE = 480;
const INPUT_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif', 'avif']);
const WEB_SEARCH_DAYS = 30;
const httpUrl = (value) => (/^https?:\/\//i.test(String(value || '')) ? String(value).slice(0, 1000) : null);

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
    match_basis: row.match_basis || null,
    verified: Boolean(row.verified_at),
    source_url: row.source_url || null,
    source_title: row.source_title || null,
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

// 자동으로 붙은 사진도 바로 보여 주되, 약사가 확인한 사진을 앞에 둔다.
const IMAGE_ORDER = 'ORDER BY verified_at IS NULL, sort_order, id';

function listImages(productId) {
  return getAll(`SELECT * FROM product_images WHERE product_id = @id AND image_key IS NOT NULL ${IMAGE_ORDER}`, { id: productId }).map(publicImage);
}

function productImages(pharmacyId, productId) {
  return listImages(ownedProduct(pharmacyId, productId).id);
}

// 첫 번째 사진(확인된 사진 우선)의 작은 사진을 목록용 대표 사진(thumbnail_url)으로 쓴다. 사진이 없으면 약국이 직접 넣은 주소를 그대로 둔다.
function syncThumbnail(productId) {
  const first = getOne(`SELECT image_key FROM product_images WHERE product_id = @id AND image_key IS NOT NULL ${IMAGE_ORDER} LIMIT 1`, { id: productId });
  if (first) {
    run('UPDATE products SET thumbnail_url = @url, updated_at = CURRENT_TIMESTAMP WHERE id = @id', { id: productId, url: mediaUrl(thumbKey(first.image_key)) });
  } else {
    run("UPDATE products SET thumbnail_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = @id AND thumbnail_url LIKE '/media/products/%'", { id: productId });
  }
}

function addRow(product, { key, source, width, height, userId, verifierId = null, basis = null, sourceUrl = null, sourceTitle = null }) {
  const count = getOne('SELECT COUNT(*) AS n FROM product_images WHERE product_id = @id AND image_key IS NOT NULL', { id: product.id }).n;
  if (count >= MAX_IMAGES) throw new ImageError(`사진은 상품마다 ${MAX_IMAGES}장까지 올릴 수 있습니다.`);
  if (getOne('SELECT 1 AS found FROM product_images WHERE product_id = @id AND image_key = @key', { id: product.id, key })) {
    throw new ImageError('이미 이 상품에 있는 사진입니다.', 409);
  }
  const next = getOne('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM product_images WHERE product_id = @id', { id: product.id }).n;
  run(
    `INSERT INTO product_images (product_id, image_url, image_key, source, match_basis, pharmacy_id, created_by, width, height, sort_order,
                                 verified_at, verified_by, source_url, source_title)
     VALUES (@product_id, @url, @key, @source, @basis, @pharmacy_id, @user_id, @width, @height, @sort_order,
             CASE WHEN @verifier IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END, @verifier, @source_url, @source_title)`,
    {
      product_id: product.id,
      url: mediaUrl(key),
      key,
      source,
      basis,
      pharmacy_id: product.pharmacy_id,
      user_id: userId,
      width,
      height,
      sort_order: next,
      verifier: verifierId,
      source_url: sourceUrl,
      source_title: sourceTitle ? String(sourceTitle).slice(0, 200) : null
    }
  );
  syncThumbnail(product.id);
}

// 사진을 받아 방향을 바로잡고(EXIF 회전), 위치 등 메타데이터를 지운 WebP 두 크기로 저장한다.
// 약사(약국 운영자) 계정이 직접 찍어 올린 사진은 바로 검증된 사진으로 본다.
async function processImage(buffer) {
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
  return { key, width: full.info.width, height: full.info.height };
}

async function uploadImage({ pharmacyId, productId, userId, verifierId = null, buffer }) {
  const product = ownedProduct(pharmacyId, productId);
  const { key, width, height } = await processImage(buffer);
  transaction(() => addRow(product, { key, source: 'UPLOAD', width, height, userId, verifierId }))();
  if (verifierId) shareToOtherPharmacies(product.id);
  return listImages(product.id);
}

async function deleteImage({ pharmacyId, productId, imageId }) {
  const product = ownedProduct(pharmacyId, productId);
  const row = getOne('SELECT * FROM product_images WHERE id = @id AND product_id = @product_id', { id: Number(imageId), product_id: product.id });
  if (!row) throw new ImageError('사진을 찾을 수 없습니다.', 404);
  transaction(() => {
    run('DELETE FROM product_images WHERE id = @id', { id: row.id });
    // 자동으로 붙은 사진을 약국이 지웠으면 같은 사진을 다시 붙이지 않는다.
    if (['SHARED', 'WEB'].includes(row.source) && row.image_key) {
      run('INSERT OR IGNORE INTO product_image_rejections (product_id, image_key, source_url) VALUES (@product_id, @key, @url)', {
        product_id: product.id,
        key: row.image_key,
        url: row.source === 'WEB' ? row.source_url : null
      });
    }
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

// 같은 바코드, 또는 같은 식약처 신고번호(그 약국 약사가 확인한 연결)의 상품에 다른 약국이 올리고 확인한 사진.
// 사진을 올린 약국이 공유를 허락했을 때만 쓴다. 바코드가 같은 사진을 먼저 준다.
function sharedCandidates(product) {
  if (!product.barcode && !product.mfds_report_no) return [];
  return getAll(
    `SELECT pi.image_key, MAX(pi.width) AS width, MAX(pi.height) AS height, MIN(p.product_name) AS product_name,
            COUNT(DISTINCT pi.pharmacy_id) AS pharmacies,
            MAX(CASE WHEN @barcode IS NOT NULL AND p.barcode = @barcode THEN 1 ELSE 0 END) AS by_barcode
     FROM product_images pi
     JOIN products p ON p.id = pi.product_id
     JOIN pharmacies ph ON ph.id = pi.pharmacy_id
     WHERE pi.source = 'UPLOAD' AND pi.image_key IS NOT NULL AND pi.verified_at IS NOT NULL
       AND pi.pharmacy_id != @pharmacy_id AND ph.share_product_photos = 1 AND ph.status = 'ACTIVE'
       AND ((@barcode IS NOT NULL AND p.barcode = @barcode)
            OR (@report_no IS NOT NULL AND p.mfds_report_no = @report_no AND p.mfds_verified_at IS NOT NULL))
       AND pi.image_key NOT IN (SELECT image_key FROM product_images WHERE product_id = @product_id AND image_key IS NOT NULL)
     GROUP BY pi.image_key
     ORDER BY by_barcode DESC, pharmacies DESC, MIN(pi.id)
     LIMIT 12`,
    { pharmacy_id: product.pharmacy_id, product_id: product.id, barcode: product.barcode || null, report_no: product.mfds_report_no || null }
  ).map((row) => ({
    image_key: row.image_key,
    url: mediaUrl(row.image_key),
    thumb_url: mediaUrl(thumbKey(row.image_key)),
    product_name: row.product_name,
    match_basis: row.by_barcode ? 'BARCODE' : 'MFDS',
    pharmacies: row.pharmacies,
    width: row.width,
    height: row.height
  }));
}

function sharedSuggestions({ pharmacyId, productId }) {
  return sharedCandidates(ownedProduct(pharmacyId, productId));
}

function useSharedImage({ pharmacyId, productId, imageKey, userId, verifierId = null }) {
  const product = ownedProduct(pharmacyId, productId);
  const suggestion = sharedCandidates(product).find((s) => s.image_key === imageKey);
  if (!suggestion) throw new ImageError('이 상품에 쓸 수 있는 공유 사진이 아닙니다.', 404);
  transaction(() =>
    addRow(product, { key: imageKey, source: 'SHARED', basis: suggestion.match_basis, width: suggestion.width, height: suggestion.height, userId, verifierId })
  )();
  return listImages(product.id);
}

// 사진이 없는 일반 상품에 가장 확실한 공유 사진 한 장을 미검증으로 붙인다. 약사가 승인해야 고객에게 보인다.
function autoAttachPhoto(productId) {
  const product = getOne('SELECT id, pharmacy_id, barcode, mfds_report_no, product_type, status FROM products WHERE id = @id', { id: productId });
  if (!product || product.product_type !== 'GENERAL' || product.status === 'HIDDEN') return { status: 'SKIPPED' };
  if (getOne('SELECT 1 AS found FROM product_images WHERE product_id = @id AND image_key IS NOT NULL', { id: product.id })) return { status: 'HAS_PHOTO' };
  const rejected = new Set(getAll('SELECT image_key FROM product_image_rejections WHERE product_id = @id', { id: product.id }).map((r) => r.image_key));
  const pick = sharedCandidates(product).find((c) => !rejected.has(c.image_key));
  if (!pick) return { status: 'NOT_FOUND' };
  transaction(() =>
    addRow(product, { key: pick.image_key, source: 'SHARED', basis: pick.match_basis, width: pick.width, height: pick.height, userId: null })
  )();
  return { status: 'ATTACHED', basis: pick.match_basis };
}

// 공유 사진도 없으면 구글 이미지 검색에서 제품명·브랜드가 가장 잘 맞는 사진 한 장을 미검증으로 붙인다.
// 같은 상품은 30일에 한 번만 검색한다(상품명·브랜드·바코드가 바뀌면 다시).
async function attachWebPhoto(productId, want) {
  if (!webImages.enabled()) return { status: 'SKIPPED' };
  const product = getOne(
    `SELECT id, pharmacy_id, product_type, status,
            photo_searched_at IS NOT NULL AND photo_searched_at > datetime('now', '-${WEB_SEARCH_DAYS} days') AS searched
     FROM products WHERE id = @id`,
    { id: productId }
  );
  if (!product || product.product_type !== 'GENERAL' || product.status === 'HIDDEN') return { status: 'SKIPPED' };
  if (product.searched) return { status: 'SEARCHED' };
  if (getOne('SELECT 1 AS found FROM product_images WHERE product_id = @id AND image_key IS NOT NULL', { id: product.id })) return { status: 'HAS_PHOTO' };
  const rejected = getAll('SELECT image_key, source_url FROM product_image_rejections WHERE product_id = @id', { id: product.id });
  const found = await webImages.findProductPhoto(want, { skipUrls: new Set(rejected.map((r) => r.source_url).filter(Boolean)) });
  run('UPDATE products SET photo_searched_at = CURRENT_TIMESTAMP WHERE id = @id', { id: product.id });
  if (!found) return { status: 'NOT_FOUND' };
  let image;
  try {
    image = await processImage(found.buffer);
  } catch {
    return { status: 'NOT_FOUND' };
  }
  if (rejected.some((r) => r.image_key === image.key)) return { status: 'NOT_FOUND' };
  const added = transaction(() => {
    if (getOne('SELECT 1 AS found FROM product_images WHERE product_id = @id AND image_key IS NOT NULL', { id: product.id })) return false;
    addRow(product, {
      key: image.key,
      source: 'WEB',
      basis: 'WEB',
      width: image.width,
      height: image.height,
      userId: null,
      sourceUrl: httpUrl(found.candidate.page) || httpUrl(found.candidate.original),
      sourceTitle: found.candidate.title
    });
    return true;
  })();
  return added ? { status: 'ATTACHED', basis: 'WEB' } : { status: 'HAS_PHOTO' };
}

async function autoFillPhoto(productId, want) {
  const shared = autoAttachPhoto(productId);
  if (shared.status !== 'NOT_FOUND') return shared;
  return attachWebPhoto(productId, want);
}

// 약사가 사진을 올리거나 확인하면, 같은 상품을 파는 다른 약국 중 사진이 없는 곳에 미검증 후보로 바로 보낸다.
function shareToOtherPharmacies(productId) {
  const source = getOne(
    `SELECT p.id, p.pharmacy_id, p.barcode, CASE WHEN p.mfds_verified_at IS NOT NULL THEN p.mfds_report_no END AS report_no, ph.share_product_photos
     FROM products p JOIN pharmacies ph ON ph.id = p.pharmacy_id WHERE p.id = @id`,
    { id: productId }
  );
  if (!source || !Number(source.share_product_photos) || (!source.barcode && !source.report_no)) return 0;
  const targets = getAll(
    `SELECT p.id FROM products p
     WHERE p.pharmacy_id != @pharmacy_id AND p.product_type = 'GENERAL' AND p.status != 'HIDDEN'
       AND ((@barcode IS NOT NULL AND p.barcode = @barcode) OR (@report_no IS NOT NULL AND p.mfds_report_no = @report_no))
       AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id AND pi.image_key IS NOT NULL)
     LIMIT 200`,
    { pharmacy_id: source.pharmacy_id, barcode: source.barcode || null, report_no: source.report_no || null }
  );
  return targets.filter((t) => autoAttachPhoto(t.id).status === 'ATTACHED').length;
}

// 바코드가 바뀌면 다른 상품일 수 있으니 사진도 약사가 다시 확인하게 한다.
function markRecheck(productId) {
  run('UPDATE product_images SET verified_at = NULL, verified_by = NULL WHERE product_id = @id AND image_key IS NOT NULL', { id: productId });
  syncThumbnail(productId);
}

function verifyImages(productId, imageIds, userId) {
  let changed = 0;
  for (const imageId of imageIds) {
    changed += run(
      'UPDATE product_images SET verified_at = CURRENT_TIMESTAMP, verified_by = @user_id WHERE id = @id AND product_id = @product_id AND verified_at IS NULL',
      { id: Number(imageId), product_id: productId, user_id: userId }
    ).changes;
  }
  syncThumbnail(productId);
  return changed;
}

module.exports = {
  ImageError,
  MAX_BYTES,
  autoAttachPhoto,
  autoFillPhoto,
  deleteImage,
  listImages,
  makePrimary,
  markRecheck,
  productImages,
  publicImage,
  shareToOtherPharmacies,
  sharedSuggestions,
  uploadImage,
  useSharedImage,
  verifyImages
};
