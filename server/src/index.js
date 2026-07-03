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

const app = express();
const port = Number(process.env.PORT || 3001);

migrate();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

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
