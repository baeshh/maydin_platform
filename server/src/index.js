require('dotenv').config();

const { SecretConfigError, assertSecrets } = require('./services/secrets');

try {
  assertSecrets();
} catch (error) {
  if (!(error instanceof SecretConfigError)) throw error;
  console.error(`[보안] ${error.message}`);
  process.exit(1);
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const { db, getOne, migrate } = require('./db');
const { startSchedule: startBackupSchedule } = require('./services/backup');
const { startRetentionSchedule } = require('./services/privacy');
const { startPaymentSchedule } = require('./services/online-payments');
const { markDataEnvironment } = require('./services/payment-policy');
const { startupProblems } = require('./services/startup-checks');
const mediaStore = require('./services/media-store');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const pharmacyRoutes = require('./routes/pharmacies');
const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const addressRoutes = require('./routes/addresses');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');
const qrCodeRoutes = require('./routes/qrcodes');
const inquiryRoutes = require('./routes/inquiries');
const posRoutes = require('./pos');
const staffRoutes = require('./routes/staff');
const pointRoutes = require('./routes/points');
const purchasingRoutes = require('./routes/purchasing');
const reportRoutes = require('./routes/reports');
const customerRoutes = require('./routes/customers');
const memberRoutes = require('./routes/members');
const demandRoutes = require('./routes/demand');
const productImportRoutes = require('./routes/product-import');
const paymentRoutes = require('./routes/payments');

const app = express();
const port = Number(process.env.PORT || 3001);

{
  const { errors, warnings } = startupProblems();
  for (const warning of warnings) console.warn(`[보안] ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`[보안] ${error}`);
    console.error('[보안] 위 문제 때문에 서버를 시작하지 않습니다.');
    process.exit(1);
  }
}

migrate();
markDataEnvironment(db);

// 같은 서버의 리버스 프록시(nginx 등)를 거칠 때만 X-Forwarded-For를 믿는다. 가입·로그인 실패 제한이 IP 기준이다.
app.set('trust proxy', 'loopback');
app.use(cors());
// 2만 행 일괄 등록 본문이 8MB를 넘을 수 있어 이 경로만 한도를 늘린다.
app.use('/api/product-import', express.json({ limit: '25mb' }));
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// POS가 15초마다 부르는 장애 감지용 확인. 프로세스만 살아 있고 DB를 못 읽으면 503으로 알린다.
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    getOne('SELECT 1 AS ok');
    res.json({ ok: true, service: 'maydin-closed-mall', db: 'ok', time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ ok: false, service: 'maydin-closed-mall', db: 'error', time: new Date().toISOString() });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/pharmacies', pharmacyRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/qrcodes', qrCodeRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/points', pointRoutes);
app.use('/api/purchasing', purchasingRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/demand', demandRoutes);
app.use('/api/product-import', productImportRoutes);
app.use('/api/payments', paymentRoutes);

const nodeModules = path.join(__dirname, '../node_modules');
const vendorFiles = {
  'jsbarcode.min.js': path.join(nodeModules, 'jsbarcode/dist/JsBarcode.all.min.js'),
  'qrcode.js': path.join(nodeModules, 'qrcode-generator/dist/qrcode.js'),
  'html5-qrcode.min.js': path.join(nodeModules, 'html5-qrcode/html5-qrcode.min.js'),
  'xlsx.full.min.js': path.join(nodeModules, 'xlsx/dist/xlsx.full.min.js')
};
for (const dir of ['build', 'cmaps', 'standard_fonts']) {
  app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(nodeModules, 'pdfjs-dist', dir), { index: false, maxAge: '1d' }));
}
app.get('/vendor/:file', (req, res, next) => {
  const file = vendorFiles[req.params.file];
  if (!file) return next();
  res.set('Cache-Control', 'public, max-age=86400');
  return res.sendFile(file);
});

// 상품 사진. 키가 내용의 해시라 한 번 받은 사진은 바뀌지 않는다.
app.get('/media/products/:file', async (req, res, next) => {
  const key = `products/${req.params.file}`;
  if (!mediaStore.KEY_PATTERN.test(key)) return res.status(404).end();
  try {
    const object = await mediaStore.getObject(key);
    if (!object) return res.status(404).end();
    res.set({ 'Content-Type': object.contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    if (Buffer.isBuffer(object.body)) return res.end(object.body);
    object.body.on('error', next).pipe(res);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, next) => {
  // 본문 해석 오류(잘못된 JSON·너무 큰 파일)는 요청 쪽 문제다.
  if (err.type === 'entity.too.large') return res.status(413).json({ message: '보낸 파일이나 내용이 너무 큽니다.' });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ message: '요청 형식이 올바르지 않습니다.' });
  console.error(err);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

app.listen(port, () => {
  console.log(`Maydin closed mall server running on http://localhost:${port}`);
  startBackupSchedule(db);
  startRetentionSchedule();
  startPaymentSchedule();
});
