require('dotenv').config();

const bcrypt = require('bcryptjs');
const { migrate, getOne, run } = require('./index');

function seedAdmin() {
  const email = 'admin@maydin.kr';
  const existing = getOne('SELECT id FROM users WHERE email = @email', { email });
  if (existing) return;

  run(
    `INSERT INTO users (email, password_hash, name, phone, role, status)
     VALUES (@email, @password_hash, @name, @phone, 'ADMIN', 'ACTIVE')`,
    {
      email,
      password_hash: bcrypt.hashSync('admin1234', 10),
      name: '플랫폼 관리자',
      phone: '010-0000-0000'
    }
  );
}

function seedDemoPharmacy() {
  const existing = getOne('SELECT id FROM pharmacies WHERE pharmacy_code = @code', { code: 'A001' });
  if (existing) return existing.id;

  const result = run(
    `INSERT INTO pharmacies (
      pharmacy_code, pharmacy_name, owner_name, business_number, phone, address,
      store_slug, store_url, commission_rate, delivery_policy, default_courier
    ) VALUES (
      @pharmacy_code, @pharmacy_name, @owner_name, @business_number, @phone, @address,
      @store_slug, @store_url, @commission_rate, @delivery_policy, @default_courier
    )`,
    {
      pharmacy_code: 'A001',
      pharmacy_name: 'A약국',
      owner_name: '홍길동',
      business_number: '123-45-67890',
      phone: '02-1234-5678',
      address: '서울시 강남구 테스트로 1',
      store_slug: 'a-pharmacy',
      store_url: '/store.html?pharmacyCode=A001',
      commission_rate: 5,
      delivery_policy: '5만원 이상 무료배송',
      default_courier: 'CJ대한통운'
    }
  );

  const pharmacyId = result.lastInsertRowid;
  run(
    `INSERT INTO qr_codes (pharmacy_id, qr_url, qr_image_url)
     VALUES (@pharmacy_id, @qr_url, @qr_image_url)`,
    {
      pharmacy_id: pharmacyId,
      qr_url: '/join.html?pharmacyCode=A001',
      qr_image_url: ''
    }
  );

  return pharmacyId;
}

function seedOwner(pharmacyId) {
  const email = 'owner@apharmacy.kr';
  const existing = getOne('SELECT id FROM users WHERE email = @email', { email });
  if (existing) return;

  run(
    `INSERT INTO users (email, password_hash, name, phone, role, pharmacy_id, status)
     VALUES (@email, @password_hash, @name, @phone, 'PHARMACY_OWNER', @pharmacy_id, 'ACTIVE')`,
    {
      email,
      password_hash: bcrypt.hashSync('owner1234', 10),
      name: 'A약국 운영자',
      phone: '010-1111-2222',
      pharmacy_id: pharmacyId
    }
  );
}

function seedProducts(pharmacyId) {
  const count = getOne('SELECT COUNT(*) AS count FROM products WHERE pharmacy_id = @pharmacy_id', {
    pharmacy_id: pharmacyId
  }).count;
  if (count > 0) return;

  const category = run(
    `INSERT INTO categories (pharmacy_id, category_name, sort_order)
     VALUES (@pharmacy_id, '건강기능식품', 1)`,
    { pharmacy_id: pharmacyId }
  );

  const items = [
    ['비타민C 1000', '하루 한 알 비타민 보충', 18000, 15000, 50],
    ['프로바이오틱스', '장 건강을 위한 유산균', 32000, 29000, 30],
    ['오메가3', '혈행 건강 관리', 28000, 25000, 20]
  ];

  for (const [product_name, description, price, discount_price, stock_quantity] of items) {
    run(
      `INSERT INTO products (
        pharmacy_id, category_id, product_name, description, price, discount_price, stock_quantity, thumbnail_url
      ) VALUES (
        @pharmacy_id, @category_id, @product_name, @description, @price, @discount_price, @stock_quantity, @thumbnail_url
      )`,
      {
        pharmacy_id: pharmacyId,
        category_id: category.lastInsertRowid,
        product_name,
        description,
        price,
        discount_price,
        stock_quantity,
        thumbnail_url: ''
      }
    );
  }
}

migrate();
const pharmacyId = seedDemoPharmacy();
seedAdmin();
seedOwner(pharmacyId);
seedProducts(pharmacyId);

console.log('DB initialized');
console.log('Admin: admin@maydin.kr / admin1234');
console.log('Owner: owner@apharmacy.kr / owner1234');
