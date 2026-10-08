const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '../../data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'maydin-platform.db');
const schemaPath = path.join(__dirname, 'schema.sql');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function tableDefinitionFromSchema(schema, table) {
  const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`schema.sql에서 ${table} 테이블 정의를 찾을 수 없습니다.`);
  return match[1];
}

// SQLite는 CHECK·NOT NULL·UNIQUE 제약을 ALTER로 바꿀 수 없어서 새 정의로 테이블을 다시 만든다.
function rebuildTable(schema, table) {
  const tempTable = `${table}__rebuild`;
  const oldColumns = tableColumns(table);
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table)
    .map((row) => row.sql);

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS ${tempTable}`);
      db.exec(`CREATE TABLE ${tempTable} (${tableDefinitionFromSchema(schema, table)}\n)`);

      const newNames = new Set(tableColumns(tempTable).map((col) => col.name));
      for (const col of oldColumns) {
        if (newNames.has(col.name)) continue;
        const defaultClause = col.dflt_value === null ? '' : ` DEFAULT ${col.dflt_value}`;
        db.exec(`ALTER TABLE ${tempTable} ADD COLUMN ${col.name} ${col.type || 'TEXT'}${defaultClause}`);
      }

      const columnList = oldColumns.map((col) => col.name).join(', ');
      db.exec(`INSERT INTO ${tempTable} (${columnList}) SELECT ${columnList} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${tempTable} RENAME TO ${table}`);
      for (const sql of indexes) db.exec(sql);

      const violations = db.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(`${table} 재생성 후 외래키 무결성 오류 ${violations.length}건`);
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function needsUsersRebuild() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  return row && !row.sql.includes("'POS_STAFF'");
}

function needsOrdersRebuild() {
  const customerId = tableColumns('orders').find((col) => col.name === 'customer_id');
  return customerId && customerId.notnull === 1;
}

function needsPaymentsRebuild() {
  return db
    .prepare('PRAGMA index_list(payments)')
    .all()
    .some((index) => {
      if (!index.unique || index.origin === 'pk') return false;
      const columns = db.prepare(`PRAGMA index_info(${index.name})`).all();
      return columns.length === 1 && columns[0].name === 'order_id';
    });
}

// 회원 QR·바코드에 쓰는 추측하기 어려운 코드. 순번(M12)만으로는 다른 회원을 사칭할 수 있다.
function assignMemberCode(customerId) {
  const existing = db.prepare('SELECT member_code FROM customers WHERE id = ?').get(customerId);
  if (!existing) return null;
  if (existing.member_code) return existing.member_code;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = `MD${String(crypto.randomInt(0, 1e10)).padStart(10, '0')}`;
    const taken = db.prepare('SELECT 1 FROM customers WHERE member_code = ?').get(code);
    if (taken) continue;
    db.prepare('UPDATE customers SET member_code = ? WHERE id = ? AND member_code IS NULL').run(code, customerId);
    return db.prepare('SELECT member_code FROM customers WHERE id = ?').get(customerId).member_code;
  }
  throw new Error('회원 코드를 만들지 못했습니다.');
}

const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 친구에게 알려 주는 추천 코드. 헷갈리기 쉬운 문자(0/O, 1/I)는 뺀다.
function assignReferralCode(customerId) {
  const existing = db.prepare('SELECT referral_code FROM customers WHERE id = ?').get(customerId);
  if (!existing) return null;
  if (existing.referral_code) return existing.referral_code;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 6 }, () => REFERRAL_ALPHABET[crypto.randomInt(0, REFERRAL_ALPHABET.length)]).join('');
    const taken = db.prepare('SELECT 1 FROM customers WHERE referral_code = ?').get(code);
    if (taken) continue;
    db.prepare('UPDATE customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(code, customerId);
    return db.prepare('SELECT referral_code FROM customers WHERE id = ?').get(customerId).referral_code;
  }
  throw new Error('추천 코드를 만들지 못했습니다.');
}

function migrateCustomerData() {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_referral_code
      ON customers(referral_code) WHERE referral_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_customers_referred_by ON customers(referred_by_customer_id);
    CREATE INDEX IF NOT EXISTS idx_customers_signup_channel ON customers(signup_channel_id);
    CREATE INDEX IF NOT EXISTS idx_signup_channels_pharmacy ON signup_channels(pharmacy_id, status);
    CREATE INDEX IF NOT EXISTS idx_customer_consents_customer ON customer_consents(customer_id, consent_type, id DESC);
  `);

  for (const row of db.prepare('SELECT id FROM customers WHERE referral_code IS NULL').all()) assignReferralCode(row.id);

  // 동의 이력이 생기기 전에 가입한 회원은 마케팅 동의 값만 남아 있다. 약관 동의는 증명할 수 없어서 기록하지 않는다.
  db.exec(`
    INSERT INTO customer_consents (pharmacy_id, customer_id, consent_type, agreed, version, source, created_at)
    SELECT c.pharmacy_id, c.id, 'MARKETING_SMS', 1, 'legacy', 'MIGRATION', c.created_at
    FROM customers c
    WHERE c.marketing_agree = 1
      AND NOT EXISTS (SELECT 1 FROM customer_consents cc WHERE cc.customer_id = c.id)
  `);
}

function migratePos(schema) {
  if (needsUsersRebuild()) rebuildTable(schema, 'users');
  if (needsOrdersRebuild()) rebuildTable(schema, 'orders');
  if (needsPaymentsRebuild()) rebuildTable(schema, 'payments');

  addColumnIfMissing('products', 'barcode', 'TEXT');
  addColumnIfMissing('products', 'product_type', "TEXT NOT NULL DEFAULT 'GENERAL'");
  addColumnIfMissing('products', 'safety_stock', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('products', 'cost_price', 'INTEGER');
  addColumnIfMissing('products', 'pos_sale_enabled', 'INTEGER NOT NULL DEFAULT 1');

  addColumnIfMissing('orders', 'sales_channel', "TEXT NOT NULL DEFAULT 'ONLINE'");
  addColumnIfMissing('orders', 'pos_terminal_id', 'INTEGER');
  addColumnIfMissing('orders', 'pos_session_id', 'INTEGER');
  addColumnIfMissing('orders', 'cashier_user_id', 'INTEGER');
  addColumnIfMissing('orders', 'original_order_id', 'INTEGER');
  addColumnIfMissing('orders', 'counsel_order_id', 'INTEGER');
  addColumnIfMissing('orders', 'refund_reason', 'TEXT');
  addColumnIfMissing('orders', 'discount_reason', 'TEXT');
  addColumnIfMissing('orders', 'picked_up_at', 'TEXT');
  addColumnIfMissing('orders', 'picked_up_by', 'INTEGER');

  addColumnIfMissing('order_items', 'product_type', 'TEXT');
  addColumnIfMissing('order_items', 'discount_amount', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('order_items', 'discount_reason', 'TEXT');
  addColumnIfMissing('order_items', 'refunded_quantity', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('order_items', 'refunded_amount', 'INTEGER NOT NULL DEFAULT 0');

  addColumnIfMissing('payments', 'approval_number', 'TEXT');
  addColumnIfMissing('payments', 'terminal_id', 'TEXT');
  addColumnIfMissing('payments', 'card_company', 'TEXT');
  addColumnIfMissing('payments', 'cash_receipt_number', 'TEXT');
  addColumnIfMissing('payments', 'received_amount', 'INTEGER');
  addColumnIfMissing('payments', 'change_amount', 'INTEGER');
  addColumnIfMissing('payments', 'pos_session_id', 'INTEGER');
  addColumnIfMissing('payments', 'created_by', 'INTEGER');

  addColumnIfMissing('inventory_logs', 'reference_type', 'TEXT');
  addColumnIfMissing('inventory_logs', 'reference_id', 'INTEGER');
  addColumnIfMissing('admin_logs', 'pharmacy_id', 'INTEGER');

  addColumnIfMissing('customers', 'member_code', 'TEXT');
  addColumnIfMissing('pos_terminals', 'van_mode', "TEXT NOT NULL DEFAULT 'MANUAL'");
  addColumnIfMissing('pos_terminals', 'updated_at', 'TEXT');
  addColumnIfMissing('payments', 'van_transaction_id', 'INTEGER');
  addColumnIfMissing('payments', 'installment_months', 'INTEGER');

  addColumnIfMissing('pharmacies', 'point_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'point_earn_rate', 'REAL NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'point_min_use', 'INTEGER NOT NULL DEFAULT 1000');
  addColumnIfMissing('customers', 'point_balance', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('orders', 'points_earned', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('products', 'supplier_id', 'INTEGER');
  addColumnIfMissing('products', 'tax_type', "TEXT NOT NULL DEFAULT 'TAXABLE'");
  addColumnIfMissing('order_items', 'tax_type', 'TEXT');

  addColumnIfMissing('customers', 'birth_year', 'INTEGER');
  addColumnIfMissing('customers', 'birth_month', 'INTEGER');
  addColumnIfMissing('customers', 'birth_day', 'INTEGER');
  addColumnIfMissing('customers', 'gender', 'TEXT');
  addColumnIfMissing('customers', 'referral_code', 'TEXT');
  addColumnIfMissing('customers', 'referred_by_customer_id', 'INTEGER');
  addColumnIfMissing('customers', 'signup_channel_id', 'INTEGER');
  migrateCustomerData();

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_suppliers_pharmacy ON suppliers(pharmacy_id, status);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_pharmacy ON purchase_orders(pharmacy_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_purchase_order_items_product ON purchase_order_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_point_ledger_customer ON point_ledger(customer_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_product_lots_product ON product_lots(product_id, expiry_date);
    CREATE INDEX IF NOT EXISTS idx_product_lots_expiry ON product_lots(pharmacy_id, expiry_date) WHERE remaining_quantity > 0;

    -- 재고가 줄면 로트 합계가 재고를 넘지 않도록 유통기한이 늦은 로트부터 남기고 나머지를 차감한다.
    -- 로트 없이 들어온 재고(유통기한 미등록분)가 먼저 빠지고, 로트는 유통기한이 빠른 것부터 줄어든다.
    CREATE TRIGGER IF NOT EXISTS trg_products_consume_lots
    AFTER UPDATE OF stock_quantity ON products
    WHEN NEW.stock_quantity < OLD.stock_quantity
      AND (SELECT COALESCE(SUM(remaining_quantity), 0) FROM product_lots WHERE product_id = NEW.id) > NEW.stock_quantity
    BEGIN
      UPDATE product_lots
      SET remaining_quantity = MAX(0, MIN(remaining_quantity, NEW.stock_quantity - (
            SELECT COALESCE(SUM(l2.remaining_quantity), 0)
            FROM product_lots l2
            WHERE l2.product_id = product_lots.product_id
              AND (l2.expiry_date > product_lots.expiry_date
                   OR (l2.expiry_date = product_lots.expiry_date AND l2.id > product_lots.id))
          ))),
          updated_at = CURRENT_TIMESTAMP
      WHERE product_id = NEW.id AND remaining_quantity > 0;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_customers_no_negative_points
    BEFORE UPDATE OF point_balance ON customers
    WHEN NEW.point_balance < 0
    BEGIN
      SELECT RAISE(ABORT, '포인트 잔액이 부족합니다.');
    END;
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_member_code
      ON customers(member_code) WHERE member_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pos_holds_pharmacy ON pos_holds(pharmacy_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_van_transactions_pharmacy ON van_transactions(pharmacy_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_inventory_logs_product ON inventory_logs(product_id, id DESC);
  `);

  const missingCodes = db.prepare('SELECT id FROM customers WHERE member_code IS NULL').all();
  for (const row of missingCodes) assignMemberCode(row.id);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_pharmacy_barcode
      ON products(pharmacy_id, barcode) WHERE barcode IS NOT NULL AND barcode != '';
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(pos_session_id);
    CREATE INDEX IF NOT EXISTS idx_orders_channel_created ON orders(pharmacy_id, sales_channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_original ON orders(original_order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_sessions_one_open
      ON pos_sessions(terminal_id) WHERE status = 'OPEN';
    CREATE INDEX IF NOT EXISTS idx_admin_logs_pharmacy ON admin_logs(pharmacy_id, id DESC);

    CREATE TRIGGER IF NOT EXISTS trg_products_no_negative_stock
    BEFORE UPDATE OF stock_quantity ON products
    WHEN NEW.stock_quantity < 0
    BEGIN
      SELECT RAISE(ABORT, '재고가 부족합니다.');
    END;
  `);
}

function migrate() {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  addColumnIfMissing('orders', 'order_type', "TEXT NOT NULL DEFAULT 'DELIVERY'");
  addColumnIfMissing('orders', 'preferred_at', 'TEXT');
  addColumnIfMissing('orders', 'memo', 'TEXT');
  addColumnIfMissing('orders', 'contact_name', 'TEXT');
  addColumnIfMissing('orders', 'contact_phone', 'TEXT');
  addColumnIfMissing('partnership_inquiries', 'license_number', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('partnership_inquiries', 'license_file_name', 'TEXT');
  addColumnIfMissing('partnership_inquiries', 'license_file_path', 'TEXT');

  migratePos(schema);
}

function getOne(sql, params = {}) {
  return db.prepare(sql).get(params);
}

function getAll(sql, params = {}) {
  return db.prepare(sql).all(params);
}

function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

module.exports = {
  db,
  migrate,
  assignMemberCode,
  assignReferralCode,
  getOne,
  getAll,
  run,
  transaction: (fn) => db.transaction(fn)
};
