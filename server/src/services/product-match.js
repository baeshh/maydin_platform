const { getAll, getOne, run, transaction } = require('../db');
const mfds = require('./mfds');
const images = require('./product-images');

class MatchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function photoQuery(productId) {
  const product = getOne(
    `SELECT p.product_name, p.brand, m.product_name AS mfds_name, m.company
     FROM products p LEFT JOIN mfds_htfs m ON m.report_no = p.mfds_report_no WHERE p.id = @id`,
    { id: productId }
  );
  if (!product) return { name: '' };
  return { name: String(product.mfds_name || product.product_name || '').trim(), brand: product.brand || null, company: product.company || null };
}

// 성분(식약처)과 사진을 자동으로 맞춘다. 자동으로 맞춘 것은 모두 미검증이고, 약사가 승인해야 고객에게 보인다.
async function autoMatchProduct(productId) {
  let ingredients;
  try {
    ingredients = await mfds.autoLinkProduct(productId);
  } catch {
    ingredients = { status: 'ERROR' };
  }
  // 성분이 연결되면 같은 신고번호의 공유 사진도 찾을 수 있고, 신고 제품명·업체명으로 사진을 더 정확히 찾을 수 있어 사진은 그 뒤에 맞춘다.
  let photo;
  try {
    photo = await images.autoFillPhoto(productId, photoQuery(productId));
  } catch {
    photo = { status: 'ERROR' };
  }
  return { ingredients, photo };
}

function autoMatchLater(productId) {
  setImmediate(() => autoMatchProduct(productId).catch(() => {}));
}

async function autoMatchPharmacy(pharmacyId, limit = 200) {
  const products = getAll(
    `SELECT p.id, p.product_name FROM products p
     WHERE p.pharmacy_id = @pharmacy_id AND p.product_type = 'GENERAL' AND p.status != 'HIDDEN'
       AND ((p.mfds_report_no IS NULL AND COALESCE(p.mfds_link_source, '') != 'REMOVED')
            OR NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id AND pi.image_key IS NOT NULL))
     ORDER BY p.online_visible DESC, p.id DESC LIMIT @limit`,
    { pharmacy_id: pharmacyId, limit }
  );
  const result = { linked: [], ambiguous: [], not_found: [], photos: [], no_photo: [] };
  for (const product of products) {
    const { ingredients, photo } = await autoMatchProduct(product.id);
    const base = { id: product.id, product_name: product.product_name };
    if (ingredients.status === 'LINKED') result.linked.push({ ...base, mfds_name: ingredients.product_name, company: ingredients.company, basis: ingredients.basis });
    else if (ingredients.status === 'AMBIGUOUS') result.ambiguous.push({ ...base, candidates: ingredients.candidates });
    else if (ingredients.status === 'NOT_FOUND') result.not_found.push(base);
    if (photo.status === 'ATTACHED') result.photos.push({ ...base, basis: photo.basis });
    else if (photo.status === 'NOT_FOUND') result.no_photo.push(base);
  }
  return result;
}

// 상품명·브랜드(제조사)·바코드가 바뀌면 다른 제품일 수 있으니 다시 맞추고, 약사가 다시 확인하게 한다.
function onIdentityChange(before, after) {
  const changed = (key) => String(before[key] ?? '').trim() !== String(after[key] ?? '').trim();
  const nameChanged = changed('product_name') || changed('brand') || changed('barcode');
  if (nameChanged) {
    mfds.markRecheck(before.id);
    run('UPDATE products SET photo_searched_at = NULL WHERE id = @id', { id: before.id });
  }
  if (changed('barcode')) images.markRecheck(before.id);
  return nameChanged;
}

function pharmacyProduct(pharmacyId, productId) {
  const product = getOne('SELECT * FROM products WHERE id = @id AND pharmacy_id = @pharmacy_id', { id: Number(productId), pharmacy_id: pharmacyId });
  if (!product) throw new MatchError('상품을 찾을 수 없습니다.', 404);
  return product;
}

function verificationState(product) {
  const pending = getOne(
    'SELECT COUNT(*) AS n FROM product_images WHERE product_id = @id AND image_key IS NOT NULL AND verified_at IS NULL',
    { id: product.id }
  ).n;
  const mfdsPending = Boolean(product.mfds_report_no) && !product.mfds_verified_at;
  return { mfds_pending: mfdsPending, photo_pending: pending, unverified: mfdsPending || pending > 0 };
}

// 약사(약국 운영자 계정)가 성분 연결과 사진을 확인한다. 누가 언제 승인했는지 남긴다.
function verifyProduct({ pharmacyId, productId, user, ingredients = false, imageIds = [] }) {
  const product = pharmacyProduct(pharmacyId, productId);
  const ids = [...new Set((Array.isArray(imageIds) ? imageIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ingredients && !ids.length) throw new MatchError('승인할 성분 정보나 사진을 골라 주세요.');
  if (ingredients && !product.mfds_report_no) throw new MatchError('연결된 성분 정보가 없습니다.', 404);
  const done = transaction(() => {
    let mfdsVerified = false;
    if (ingredients && !product.mfds_verified_at) {
      mfds.verifyLink(pharmacyId, product.id, user.id);
      mfdsVerified = true;
    }
    const photos = ids.length ? images.verifyImages(product.id, ids, user.id) : 0;
    const parts = [mfdsVerified && `성분 정보(신고번호 ${product.mfds_report_no})`, photos && `사진 ${photos}장`].filter(Boolean);
    if (parts.length) {
      run(
        `INSERT INTO admin_logs (user_id, pharmacy_id, action, target_type, target_id, description)
         VALUES (@user_id, @pharmacy_id, 'PRODUCT_VERIFY', 'PRODUCT', @product_id, @description)`,
        { user_id: user.id, pharmacy_id: pharmacyId, product_id: product.id, description: `${product.product_name}: ${parts.join(', ')} 승인` }
      );
    }
    return { mfdsVerified, photos };
  })();
  if (done.photos || done.mfdsVerified) images.shareToOtherPharmacies(product.id);
  return { ...done, ...verificationState(pharmacyProduct(pharmacyId, product.id)) };
}

module.exports = {
  MatchError,
  autoMatchLater,
  autoMatchPharmacy,
  autoMatchProduct,
  onIdentityChange,
  verificationState,
  verifyProduct
};
