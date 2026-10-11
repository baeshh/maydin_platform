const express = require('express');
const { getOne } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePharmacyScope } = require('../middleware/scope');
const { sendCsv } = require('../services/csv');
const imports = require('../services/product-import');

const router = express.Router();

router.use(authenticate, requireRole('PHARMACY_OWNER'), requirePharmacyScope);

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof imports.ImportError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error(error);
      return res.status(500).json({ message: '일괄 등록 처리 중 오류가 발생했습니다.' });
    }
  };
}

function localTime(utc) {
  return utc ? getOne("SELECT datetime(@t, 'localtime') AS t", { t: utc }).t : '';
}

router.get('/template.csv', (req, res) => {
  sendCsv(
    res,
    [
      ['상품명', '바코드', '상품코드', '판매가', '할인가', '매입가', '재고', '분류', '구분', '과세구분', '브랜드', '거래처', '유통기한', '로트번호', '안전재고'],
      ['비타민C 1000', '8801234567893', 'A-1001', '15000', '', '9000', '30', '건강기능식품', '건강기능식품', '과세', '메이딘랩', '한빛약품', '2027-06-30', 'L2406', '5'],
      ['소화제 정', '8809876543217', 'A-2001', '4500', '', '2800', '12', '소화기', '일반의약품', '면세', '', '한빛약품', '', '', '3']
    ],
    { asciiName: 'maydin-product-template.csv', filename: 'MAYDIN_상품등록_양식.csv' }
  );
});

router.get('/profiles', handle((req) => ({ profiles: imports.profiles(req.pharmacyId) })));
router.post('/profiles', handle((req) => ({ profiles: imports.saveProfile(req.pharmacyId, req.user.id, req.body) })));
router.delete('/profiles/:id', handle((req) => ({ profiles: imports.deleteProfile(req.pharmacyId, req.params.id) })));

router.post(
  '/preview',
  handle((req, res) => {
    const result = imports.preview({
      pharmacyId: req.pharmacyId,
      userId: req.user.id,
      mode: String(req.body.mode || '').toUpperCase(),
      rows: req.body.rows,
      options: req.body.options,
      fileName: req.body.file_name,
      sourceType: req.body.source_type,
      snapshotAt: req.body.snapshot_at
    });
    res.status(201);
    return result;
  })
);

router.get('/batches', handle((req) => ({ batches: imports.batches(req.pharmacyId) })));

router.get(
  '/batches/:id',
  handle((req) =>
    imports.batchRows(req.pharmacyId, req.params.id, {
      filter: String(req.query.filter || 'ALL').toUpperCase(),
      q: String(req.query.q || '').slice(0, 60),
      page: req.query.page,
      pageSize: req.query.page_size
    })
  )
);

router.get('/batches/:id/rows.csv', (req, res) => {
  try {
    const { batch, rows } = imports.batchRows(req.pharmacyId, req.params.id, {
      filter: String(req.query.filter || 'ERROR').toUpperCase(),
      pageSize: 200,
      page: 1
    });
    const all = [];
    for (let page = 1; ; page += 1) {
      const chunk = page === 1 ? rows : imports.batchRows(req.pharmacyId, req.params.id, { filter: String(req.query.filter || 'ERROR').toUpperCase(), pageSize: 200, page }).rows;
      all.push(...chunk);
      if (chunk.length < 200 || all.length >= 20000) break;
    }
    return sendCsv(
      res,
      [
        ['행 번호', '결과', '상품명', '바코드', '상품코드', '내용'],
        ...all.map((row) => [row.row_no || '파일에 없음', row.action, row.product_name, row.barcode, row.external_code, row.messages.map((m) => m.text).join(' / ')])
      ],
      { asciiName: `import-${batch.id}-rows.csv`, filename: `일괄등록_${batch.id}_행결과.csv` }
    );
  } catch (error) {
    const status = error instanceof imports.ImportError ? error.status : 500;
    return res.status(status).json({ message: error.message });
  }
});

router.post(
  '/batches/:id/apply',
  handle((req) => imports.apply({ pharmacyId: req.pharmacyId, userId: req.user.id, batchId: req.params.id }))
);

router.post(
  '/batches/:id/revert',
  handle((req) => imports.revert({ pharmacyId: req.pharmacyId, userId: req.user.id, batchId: req.params.id }))
);

/* ---------- 기존 POS 병행 ---------- */

router.get('/sync', handle((req) => imports.syncStatus(req.pharmacyId)));
router.patch('/sync', handle((req) => imports.updateSync(req.pharmacyId, req.user.id, req.body)));
router.get('/sync/outflow', handle((req) => imports.outflow(req.pharmacyId, req.query.until_log_id)));
router.post('/sync/reflected', handle((req) => imports.markReflected(req.pharmacyId, req.user.id, req.body)));

router.get('/sync/outflow.csv', (req, res) => {
  try {
    const { from, until, items } = imports.outflow(req.pharmacyId, req.query.until_log_id);
    const period = `${localTime(from)} ~ ${localTime(until)}`;
    return sendCsv(
      res,
      [
        ['바코드', '상품코드', '상품명', 'MAYDIN 출고 수량', '기간'],
        ...items.map((item) => [item.barcode || '', item.external_code || '', item.product_name, item.quantity_out, period])
      ],
      { asciiName: 'maydin-outflow.csv', filename: `MAYDIN_판매출고_${localTime(until).slice(0, 10)}.csv` }
    );
  } catch (error) {
    const status = error instanceof imports.ImportError ? error.status : 500;
    return res.status(status).json({ message: error.message });
  }
});

module.exports = router;
