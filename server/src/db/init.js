require('dotenv').config();

const { SecretConfigError, assertSecrets, isProduction } = require('../services/secrets');

try {
  assertSecrets();
} catch (error) {
  if (!(error instanceof SecretConfigError)) throw error;
  console.error(`[보안] ${error.message}`);
  process.exit(1);
}

const bcrypt = require('bcryptjs');
const { db, migrate, getOne, run } = require('./index');
const { passwordProblem } = require('../services/password-policy');
const { environmentProblem, markDataEnvironment } = require('../services/payment-policy');

// 운영 DB에는 데모 약국·계정을 만들지 않는다. 첫 플랫폼 관리자는 환경변수로 받은 이메일·비밀번호로만 만든다.
function seedInitialAdmin() {
  if (getOne("SELECT id FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' LIMIT 1")) {
    console.log('플랫폼 관리자 계정이 이미 있어 새로 만들지 않았습니다.');
    return;
  }
  const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  if (!email || !password) {
    console.log('플랫폼 관리자 계정이 없습니다. INITIAL_ADMIN_EMAIL·INITIAL_ADMIN_PASSWORD를 넣고 다시 실행하면 만듭니다.');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('INITIAL_ADMIN_EMAIL 형식이 올바르지 않습니다.');
  const problem = passwordProblem(password, { minLength: 12 });
  if (problem) throw new Error(`INITIAL_ADMIN_PASSWORD: ${problem}`);
  if (getOne('SELECT id FROM users WHERE email = @email', { email })) throw new Error(`${email}은(는) 이미 다른 계정이 쓰는 이메일입니다.`);
  run(
    `INSERT INTO users (email, password_hash, name, role, status)
     VALUES (@email, @password_hash, '플랫폼 관리자', 'ADMIN', 'ACTIVE')`,
    { email, password_hash: bcrypt.hashSync(password, 12) }
  );
  console.log(`플랫폼 관리자 ${email}을(를) 만들었습니다. 환경변수에서 INITIAL_ADMIN_PASSWORD를 지워 주세요.`);
}

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
        pharmacy_id, category_id, product_name, description, price, discount_price, stock_quantity, thumbnail_url,
        product_type, online_visible
      ) VALUES (
        @pharmacy_id, @category_id, @product_name, @description, @price, @discount_price, @stock_quantity, @thumbnail_url,
        'GENERAL', 1
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

const environmentError = environmentProblem(db);
if (environmentError) {
  console.error(`[보안] ${environmentError}`);
  process.exit(1);
}

migrate();
markDataEnvironment(db);
if (isProduction()) {
  seedInitialAdmin();
  console.log('DB initialized (운영 · 데모 약국·계정은 만들지 않음)');
} else {
  const pharmacyId = seedDemoPharmacy();
  seedAdmin();
  seedOwner(pharmacyId);
  seedProducts(pharmacyId);
  console.log('DB initialized (개발용 데모 데이터)');
  console.log('Admin: admin@maydin.kr / admin1234');
  console.log('Owner: owner@apharmacy.kr / owner1234');
}
