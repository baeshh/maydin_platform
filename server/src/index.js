require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { migrate } = require('./db');

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
const posRoutes = require('./routes/pos');
const staffRoutes = require('./routes/staff');
const pointRoutes = require('./routes/points');
const purchasingRoutes = require('./routes/purchasing');
const reportRoutes = require('./routes/reports');
const customerRoutes = require('./routes/customers');
const memberRoutes = require('./routes/members');
const demandRoutes = require('./routes/demand');

const app = express();
const port = Number(process.env.PORT || 3001);

migrate();

// 같은 서버의 리버스 프록시(nginx 등)를 거칠 때만 X-Forwarded-For를 믿는다. 가입·로그인 실패 제한이 IP 기준이다.
app.set('trust proxy', 'loopback');
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'maydin-closed-mall', time: new Date().toISOString() });
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

const nodeModules = path.join(__dirname, '../node_modules');
const vendorFiles = {
  'jsbarcode.min.js': path.join(nodeModules, 'jsbarcode/dist/JsBarcode.all.min.js'),
  'qrcode.js': path.join(nodeModules, 'qrcode-generator/dist/qrcode.js'),
  'html5-qrcode.min.js': path.join(nodeModules, 'html5-qrcode/html5-qrcode.min.js')
};
app.get('/vendor/:file', (req, res, next) => {
  const file = vendorFiles[req.params.file];
  if (!file) return next();
  res.set('Cache-Control', 'public, max-age=86400');
  return res.sendFile(file);
});

app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
});

app.listen(port, () => {
  console.log(`Maydin closed mall server running on http://localhost:${port}`);
});
