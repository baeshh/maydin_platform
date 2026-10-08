// 화면 확인용 임시 DB에 회원·구매 샘플을 넣는다. 사용: DB_PATH=/tmp/x.db BASE=http://127.0.0.1:3011 node tests/seed-demo.mjs
import { createRequire } from 'node:module';
import { api, signupMember } from './lib.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH);

const names = ['김하나', '이두리', '박세나', '최민준', '정서윤', '강도윤', '조하은', '윤지호', '장예린', '임태오', '한지우', '오서준', '서아린', '신유나', '권도현', '황시우', '안채원', '송민서', '류하준', '홍지안'];
const products = db.prepare('SELECT id, product_name, price FROM products WHERE pharmacy_id = 1').all();
let seq = 0;

function order(customerId, daysAgo) {
  const picks = products.filter(() => Math.random() < 0.6);
  const items = picks.length ? picks : [products[0]];
  const amount = items.reduce((sum, p) => sum + p.price * (1 + Math.floor(Math.random() * 3)), 0);
  seq += 1;
  const created = db.prepare("SELECT datetime('now', ?, ?) AS at").get(`-${daysAgo} days`, `-${Math.floor(Math.random() * 600)} minutes`).at;
  const id = db
    .prepare(
      `INSERT INTO orders (order_number, pharmacy_id, customer_id, order_type, sales_channel, total_product_amount, final_amount, order_status, created_at)
       VALUES (?, 1, ?, 'POS_SALE', 'POS', ?, ?, 'COMPLETED', ?)`
    )
    .run(`DEMO-${Date.now()}-${seq}`, customerId, amount, amount, created).lastInsertRowid;
  for (const p of items) db.prepare('INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total_price) VALUES (?, ?, ?, 1, ?, ?)').run(id, p.id, p.product_name, p.price, p.price);
  db.prepare("INSERT INTO payments (order_id, payment_method, payment_status, paid_amount) VALUES (?, ?, 'PAID', ?)").run(id, Math.random() < 0.7 ? 'CARD' : 'CASH', amount);
}

for (const [i, name] of names.entries()) {
  const res = await signupMember(db, {
    name,
    phone: `0109${String(1000000 + i * 7919).slice(-7)}`,
    consents: { TERMS: true, PRIVACY: true, HEALTH_INFO: true, MARKETING_SMS: i % 3 !== 0 },
    birth_month: (i % 12) + 1,
    birth_day: 10,
    birth_year: 1950 + i * 3,
    gender: i % 4 === 1 ? 'F' : 'M',
    ...(i % 4 === 0 ? { allergy_none: false, allergy: '페니실린', medications_none: false, medications: '혈압약(암로디핀)' } : {})
  });
  const { customer } = (await api('/customers/me', { token: res.data.token })).data;
  const visits = i % 5 === 4 ? 0 : 1 + (i % 7);
  const gap = 15 + (i % 4) * 20;
  const lastAgo = [3, 20, 75, 200, 40][i % 5];
  for (let v = 0; v < visits; v += 1) order(customer.id, lastAgo + v * gap);
}
console.log('seeded', names.length);
