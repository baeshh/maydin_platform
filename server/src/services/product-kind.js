// 상품 구분과 판매 채널 규칙. 온라인 판매는 "약국이 일반 상품으로 분류하고 온라인 판매를 켠 상품"만 허용한다.
const PRODUCT_TYPES = ['GENERAL', 'OTC', 'ETC', 'UNCLASSIFIED'];

const PRODUCT_TYPE_LABELS = {
  GENERAL: '일반 상품',
  OTC: '일반의약품',
  ETC: '전문의약품',
  UNCLASSIFIED: '분류 전'
};

// 일반의약품일 수도 있는 상품은 약사(관리자)만 현장 판매하고 포인트 적립·사용에서 뺀다.
const PHARMACIST_ONLY_TYPES = new Set(['OTC', 'UNCLASSIFIED']);

class ProductKindError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function normalizeProductType(value, fallback = 'UNCLASSIFIED') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const type = String(value).trim().toUpperCase();
  if (!PRODUCT_TYPES.includes(type)) throw new ProductKindError('상품 구분이 올바르지 않습니다.');
  return type;
}

function onlineSellableSql(alias = 'p') {
  return `${alias}.product_type = 'GENERAL' AND COALESCE(${alias}.online_visible, 0) = 1 AND ${alias}.status != 'HIDDEN'`;
}

function isOnlineSellable(product) {
  return Boolean(product) && product.product_type === 'GENERAL' && Number(product.online_visible) === 1 && product.status !== 'HIDDEN';
}

function onlineBlockedMessage(product) {
  if (product.product_type === 'OTC') return `${product.product_name} 상품은 일반의약품으로 온라인 결제가 불가합니다. 약국 방문 시 구매해 주세요.`;
  if (product.product_type === 'ETC') return `${product.product_name} 상품은 전문의약품이라 온라인에서 판매하지 않습니다.`;
  return `${product.product_name} 상품은 온라인에서 판매하지 않는 상품입니다.`;
}

// 현장(POS) 판매 가능 여부. 막히면 이유를, 가능하면 null을 돌려준다.
function posSaleBlockReason(product, { isPharmacist }) {
  if (product.product_type === 'ETC') {
    return { message: `${product.product_name}은(는) 전문의약품이라 POS에서 판매할 수 없습니다. 처방 조제 프로그램에서 처리해 주세요.`, status: 400 };
  }
  if (Number(product.pos_sale_enabled ?? 1) === 0) return { message: `${product.product_name}은(는) POS 판매가 중지된 상품입니다.`, status: 400 };
  if (PHARMACIST_ONLY_TYPES.has(product.product_type) && !isPharmacist) {
    const reason = product.product_type === 'OTC' ? '일반의약품이라' : '아직 분류하지 않은 상품이라';
    return { message: `${product.product_name}은(는) ${reason} 약사(관리자) 계정으로만 판매할 수 있습니다.`, status: 403 };
  }
  return null;
}

function isPointEligible(productType) {
  return (productType || 'GENERAL') === 'GENERAL';
}

// 저장할 온라인 판매 값을 정한다. 일반 상품이 아니면 항상 끈다.
function resolveOnlineVisible(productType, requested, current = 0) {
  const wanted = requested === undefined ? Number(current) === 1 : requested === true || Number(requested) === 1;
  if (!wanted) return 0;
  if (productType !== 'GENERAL') {
    if (requested === undefined) return 0;
    throw new ProductKindError(`${PRODUCT_TYPE_LABELS[productType]}은(는) 온라인에서 판매할 수 없습니다. 일반 상품으로 분류한 뒤 켜 주세요.`);
  }
  return 1;
}

module.exports = {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  PHARMACIST_ONLY_TYPES,
  ProductKindError,
  normalizeProductType,
  onlineSellableSql,
  isOnlineSellable,
  onlineBlockedMessage,
  posSaleBlockReason,
  isPointEligible,
  resolveOnlineVisible
};
