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
  if (columns.some((col) => col.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
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
    CREATE INDEX IF NOT EXISTS idx_search_misses_pharmacy ON search_misses(pharmacy_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_restock_alerts_product ON restock_alerts(product_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_restock_alerts_waiting
      ON restock_alerts(customer_id, product_id) WHERE status = 'WAITING';
    CREATE INDEX IF NOT EXISTS idx_product_requests_pharmacy ON product_requests(pharmacy_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS idx_family_members_head ON family_members(head_customer_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_family_members_linked
      ON family_members(linked_customer_id) WHERE linked_customer_id IS NOT NULL;
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

function needsPointLedgerRebuild() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'point_ledger'").get();
  return row && !row.sql.includes("'REWARD'");
}

function needsConsentsRebuild() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_consents'").get();
  return row && !row.sql.includes("'HEALTH_INFO'");
}

// 구매 인증 가입·PIN 로그인. 이 기능 전에 가입한 회원은 승인된 상태로 두고, PIN은 약국에서 받은 코드로 처음 설정한다.
function migrateMemberAuth(schema) {
  if (needsConsentsRebuild()) rebuildTable(schema, 'customer_consents');
  addColumnIfMissing('customers', 'approval_status', "TEXT NOT NULL DEFAULT 'APPROVED'");
  addColumnIfMissing('customers', 'approval_note', 'TEXT');
  addColumnIfMissing('customers', 'approved_at', 'TEXT');
  addColumnIfMissing('customers', 'approved_by', 'INTEGER');
  addColumnIfMissing('customers', 'signup_order_id', 'INTEGER');
  addColumnIfMissing('customers', 'signup_ip_hash', 'TEXT');
  addColumnIfMissing('customers', 'pin_hash', 'TEXT');
  addColumnIfMissing('customers', 'pin_failed_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('customers', 'pin_locked_until', 'TEXT');
  addColumnIfMissing('customers', 'health_info', 'TEXT');
  addColumnIfMissing('customers', 'health_updated_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_approval ON customers(pharmacy_id, approval_status);
    CREATE INDEX IF NOT EXISTS idx_customers_signup_ip ON customers(pharmacy_id, signup_ip_hash, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_signup_order
      ON customers(signup_order_id) WHERE signup_order_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_codes_active_order
      ON verification_codes(order_id) WHERE status = 'ACTIVE' AND purpose = 'SIGNUP';
    CREATE INDEX IF NOT EXISTS idx_verification_codes_customer ON verification_codes(customer_id, purpose, status);
  `);
}

function migrateProductImport() {
  addColumnIfMissing('products', 'external_code', 'TEXT');
  addColumnIfMissing('products', 'online_visible', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('products', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('pharmacies', 'pos_sync_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('pharmacies', 'pos_sync_reflected_until', 'TEXT');
  addColumnIfMissing('pharmacies', 'pos_sync_reflected_log_id', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('import_batches', 'reflected_log_id', 'INTEGER');
  addColumnIfMissing('pharmacies', 'online_stock_buffer', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'pos_sync_interval_hours', 'INTEGER NOT NULL DEFAULT 24');
  addColumnIfMissing('pharmacies', 'pos_sync_pause_when_stale', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'pos_sync_started_batch_id', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_products_pharmacy_external_code
      ON products(pharmacy_id, external_code) WHERE external_code IS NOT NULL AND external_code != '';
    CREATE INDEX IF NOT EXISTS idx_import_batches_pharmacy ON import_batches(pharmacy_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch ON import_batch_rows(batch_id, row_no);
    CREATE INDEX IF NOT EXISTS idx_inventory_logs_pharmacy_created ON inventory_logs(pharmacy_id, created_at);
    -- 상품을 지울 때 외래 키 검사가 표 전체를 훑지 않도록 상품을 가리키는 열마다 인덱스를 둔다.
    CREATE INDEX IF NOT EXISTS idx_import_batch_rows_product ON import_batch_rows(product_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
    CREATE INDEX IF NOT EXISTS idx_carts_product ON carts(product_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);
  `);
  migrateProductKinds();
}

// 예전 "구분 확인 필요" 표시는 "분류 전"으로 옮기고, 일반 상품이 아닌 상품은 온라인 판매를 끈다.
function migrateProductKinds() {
  db.exec(`
    UPDATE products SET product_type = 'UNCLASSIFIED'
      WHERE product_type IS NULL OR product_type NOT IN ('GENERAL', 'OTC', 'ETC', 'UNCLASSIFIED');
    UPDATE products SET product_type = 'UNCLASSIFIED', online_visible = 0, needs_review = 0
      WHERE needs_review = 1;
    UPDATE products SET online_visible = 0
      WHERE online_visible != 0 AND product_type != 'GENERAL';
  `);
}

// 판매 시점 원가 기록. 열을 처음 만들 때 한 번만, 그때까지의 판매 줄을 당시 상품 원가로 고정한다(BACKFILL = 추정치).
function migrateOrderFlow() {
  addColumnIfMissing('order_items', 'unit_cost', 'REAL');
  addColumnIfMissing('order_items', 'cost_amount', 'INTEGER');
  const added = addColumnIfMissing('order_items', 'cost_source', 'TEXT');
  if (added) {
    db.exec(`
      UPDATE order_items
      SET unit_cost = (SELECT cost_price FROM products WHERE products.id = order_items.product_id),
          cost_amount = (SELECT ROUND(order_items.quantity * cost_price) FROM products WHERE products.id = order_items.product_id),
          cost_source = 'BACKFILL'
      WHERE (SELECT cost_price FROM products WHERE products.id = order_items.product_id) IS NOT NULL;
    `);
  }
  addColumnIfMissing('orders', 'canceled_at', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, id);
    UPDATE orders SET order_status = 'PAYMENT_COMPLETED'
      WHERE order_type = 'PICKUP' AND order_status = 'RESERVED';
  `);
}

// 장애 대응: 같은 판매를 두 번 저장하지 않도록 단말기가 만든 거래 고유번호를 받고, 복구한 거래를 표시한다.
function migratePosRecovery() {
  addColumnIfMissing('orders', 'client_sale_id', 'TEXT');
  addColumnIfMissing('orders', 'client_sale_hash', 'TEXT');
  addColumnIfMissing('orders', 'recovery_source', 'TEXT');
  addColumnIfMissing('orders', 'recovered_at', 'TEXT');
  addColumnIfMissing('orders', 'outage_id', 'INTEGER');
  addColumnIfMissing('order_items', 'stock_shortage', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_sale
      ON orders(pharmacy_id, client_sale_id) WHERE client_sale_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_outage ON orders(outage_id) WHERE outage_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pos_outages_pharmacy ON pos_outages(pharmacy_id, id DESC);
  `);
}

// 회원 탈퇴·보유기간 파기와 복약상담 내용 암호화.
// 예전 상담 예약은 문의 내용(증상·복용 약)을 일반 메모에 평문으로 두었으므로 암호문으로 옮기고 메모를 비운다.
function migratePrivacy() {
  addColumnIfMissing('customers', 'withdrawn_at', 'TEXT');
  addColumnIfMissing('customers', 'withdrawal_source', 'TEXT');
  addColumnIfMissing('customers', 'personal_purged_at', 'TEXT');
  addColumnIfMissing('customers', 'health_updated_by', 'INTEGER');
  addColumnIfMissing('orders', 'counsel_note', 'TEXT');
  addColumnIfMissing('orders', 'counsel_consent_at', 'TEXT');
  addColumnIfMissing('orders', 'counsel_note_purged_at', 'TEXT');
  addColumnIfMissing('admin_logs', 'purpose', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_type, target_id, action)');

  const { encrypt } = require('../services/secure');
  const legacy = db.prepare("SELECT id, memo FROM orders WHERE order_type = 'COUNSEL' AND memo IS NOT NULL AND TRIM(memo) != ''").all();
  const move = db.prepare('UPDATE orders SET counsel_note = @note, memo = NULL WHERE id = @id');
  db.transaction(() => {
    for (const row of legacy) move.run({ id: row.id, note: encrypt(row.memo) });
  })();
}

// 온라인 결제: 결제 요청(주문서)과 결제사 승인을 분리한다. 주문은 결제사 승인을 서버가 확인한 뒤에만 만든다.
// 카드번호 등 결제수단 정보는 저장하지 않고 결제사가 준 결제 키·영수증 주소만 둔다.
function migratePayments() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_checkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      order_type TEXT NOT NULL,
      pg_order_id TEXT NOT NULL UNIQUE,
      order_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      total_product_amount INTEGER NOT NULL,
      delivery_fee INTEGER NOT NULL DEFAULT 0,
      cart_hash TEXT NOT NULL,
      client_key TEXT,
      payload TEXT,
      provider TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'READY',
      payment_key TEXT,
      order_id INTEGER REFERENCES orders(id),
      fail_code TEXT,
      fail_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      confirm_started_at TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_online_checkouts_client
      ON online_checkouts(customer_id, client_key) WHERE client_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_online_checkouts_status ON online_checkouts(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_online_checkouts_pharmacy ON online_checkouts(pharmacy_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_online_checkouts_payment_key ON online_checkouts(payment_key) WHERE payment_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS payment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT,
      pg_order_id TEXT,
      payment_key TEXT,
      result TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at TEXT,
      UNIQUE(provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS pg_demo_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_key TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL,
      order_name TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      scenario TEXT NOT NULL DEFAULT 'APPROVE',
      approved_at TEXT,
      canceled_at TEXT,
      cancel_reason TEXT,
      cancel_transaction_key TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pg_demo_payments_order ON pg_demo_payments(order_id);
  `);
  addColumnIfMissing('pg_demo_payments', 'method_label', 'TEXT');
  addColumnIfMissing('payments', 'payment_key', 'TEXT');
  addColumnIfMissing('payments', 'pg_order_id', 'TEXT');
  addColumnIfMissing('payments', 'payment_mode', 'TEXT');
  addColumnIfMissing('payments', 'approved_at', 'TEXT');
  addColumnIfMissing('payments', 'receipt_url', 'TEXT');
  addColumnIfMissing('payments', 'cancel_transaction_key', 'TEXT');
  addColumnIfMissing('orders', 'cancel_lock_at', 'TEXT');
  addColumnIfMissing('orders', 'cancel_request', 'TEXT');
  addColumnIfMissing('orders', 'payment_alert', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_key
      ON payments(payment_provider, payment_key) WHERE payment_key IS NOT NULL AND paid_amount > 0;
    CREATE INDEX IF NOT EXISTS idx_orders_cancel_lock ON orders(cancel_lock_at) WHERE cancel_lock_at IS NOT NULL;
  `);
}

function needsVanTransactionsRebuild() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'van_transactions'").get();
  return row && !row.sql.includes("'CASH_RECEIPT_CANCEL'");
}

// 카드 승인은 요청 번호(request_id) 하나에 한 번만. 결과를 모르면 UNKNOWN으로 두고 대사로만 정한다.
// 수동 입력 승인번호는 단말기 영수증과 대조하기 전까지 '미대조'로 남긴다.
function migrateVan(schema) {
  if (needsVanTransactionsRebuild()) rebuildTable(schema, 'van_transactions');
  addColumnIfMissing('payments', 'verify_status', 'TEXT');
  addColumnIfMissing('payments', 'verified_by', 'INTEGER');
  addColumnIfMissing('payments', 'verified_at', 'TEXT');
  addColumnIfMissing('payments', 'verify_note', 'TEXT');
  addColumnIfMissing('pos_terminals', 'bridge_key_enc', 'TEXT');
  addColumnIfMissing('pos_terminals', 'bridge_paired_at', 'TEXT');
  addColumnIfMissing('pos_sale_drafts', 'pickup_order_id', 'INTEGER');
  for (const column of ['cash_receipt_purpose', 'identity_type', 'original_approved_at', 'cancel_reason']) {
    addColumnIfMissing('van_transactions', column, 'TEXT');
  }
  // 카운터 영수증 프린터: BROWSER(브라우저 인쇄) · BRIDGE(이 PC Bridge로 직접 출력)
  addColumnIfMissing('pos_terminals', 'printer_mode', "TEXT NOT NULL DEFAULT 'BROWSER'");
  addColumnIfMissing('pos_terminals', 'printer_auto_print', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('pos_terminals', 'printer_open_drawer', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pos_print_jobs_order ON pos_print_jobs(order_id);
    CREATE INDEX IF NOT EXISTS idx_pos_print_jobs_open ON pos_print_jobs(terminal_id, status) WHERE status IN ('REQUESTED', 'FAILED');
    CREATE INDEX IF NOT EXISTS idx_van_transactions_order ON van_transactions(order_id) WHERE order_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_van_transactions_request
      ON van_transactions(pharmacy_id, request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_van_transactions_draft ON van_transactions(sale_draft_id);
    CREATE INDEX IF NOT EXISTS idx_payments_verify ON payments(verify_status) WHERE verify_status = 'UNVERIFIED';
  `);
}

// 카운터마다 등록된 PC를 하나씩 둔다. 기기 토큰 원문은 저장하지 않고 해시만 둔다.
function migrateTerminals() {
  addColumnIfMissing('pos_terminals', 'device_key_hash', 'TEXT');
  addColumnIfMissing('pos_terminals', 'device_label', 'TEXT');
  addColumnIfMissing('pos_terminals', 'device_registered_at', 'TEXT');
  addColumnIfMissing('pos_terminals', 'device_registered_by', 'INTEGER');
  addColumnIfMissing('pos_terminals', 'last_seen_at', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_terminals_device
      ON pos_terminals(device_key_hash) WHERE device_key_hash IS NOT NULL;
    DROP INDEX IF EXISTS idx_pos_sessions_open_terminal;
  `);
}

// 장애 중 기기 보관 거래 보존.
// 카운터마다 RSA 키 쌍을 두고 기기는 공개키로만 잠근다(개인키는 서버에 암호문으로). 기기마다 미전송 거래 목록(번호·시각·금액)을 보고받는다.
function migrateOfflinePreservation() {
  addColumnIfMissing('pos_terminals', 'seal_key_id', 'TEXT');
  addColumnIfMissing('pos_terminals', 'seal_public_key', 'TEXT');
  addColumnIfMissing('pos_terminals', 'seal_private_key_enc', 'TEXT');
  addColumnIfMissing('orders', 'recovery_ref', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pos_device_queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
      install_id TEXT NOT NULL,
      terminal_id INTEGER REFERENCES pos_terminals(id) ON DELETE SET NULL,
      device_key_hash TEXT,
      storage TEXT,
      pending_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      plain_count INTEGER NOT NULL DEFAULT 0,
      total_amount INTEGER NOT NULL DEFAULT 0,
      oldest_at TEXT,
      entries_json TEXT NOT NULL DEFAULT '[]',
      user_agent TEXT,
      reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      retired_at TEXT,
      retired_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      retire_note TEXT,
      resolved_at TEXT,
      resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolve_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pharmacy_id, install_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pos_device_queues_terminal ON pos_device_queues(terminal_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_terminals_seal_key ON pos_terminals(seal_key_id) WHERE seal_key_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_recovery_ref ON orders(pharmacy_id, recovery_ref) WHERE recovery_ref IS NOT NULL;
  `);
}

function migratePos(schema) {
  if (needsUsersRebuild()) rebuildTable(schema, 'users');
  if (needsOrdersRebuild()) rebuildTable(schema, 'orders');
  if (needsPaymentsRebuild()) rebuildTable(schema, 'payments');
  if (needsPointLedgerRebuild()) rebuildTable(schema, 'point_ledger');

  addColumnIfMissing('products', 'barcode', 'TEXT');
  addColumnIfMissing('products', 'product_type', "TEXT NOT NULL DEFAULT 'UNCLASSIFIED'");
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
  addColumnIfMissing('customers', 'referral_rewarded_at', 'TEXT');
  addColumnIfMissing('products', 'brand', 'TEXT');
  addColumnIfMissing('products', 'supply_days', 'INTEGER');
  migrateCustomerData();
  migrateMemberAuth(schema);
  migrateProductImport();
  migrateOrderFlow();
  migratePosRecovery();
  migratePrivacy();
  migratePayments();
  migrateTerminals();
  migrateOfflinePreservation();
  migrateMallSettings();
  migrateVan(schema);

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

// 약국마다 다른 온라인 몰 정책. 기본값은 예전에 모든 약국에 고정돼 있던 값(배송비 3,000원, 5만원 이상 무료)이다.
function migrateMallSettings() {
  addColumnIfMissing('pharmacies', 'delivery_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'delivery_fee', 'INTEGER NOT NULL DEFAULT 3000');
  addColumnIfMissing('pharmacies', 'free_delivery_min', 'INTEGER NOT NULL DEFAULT 50000');
  addColumnIfMissing('pharmacies', 'pickup_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('pharmacies', 'mall_notice', 'TEXT');
  migrateProductMedia();
}

// 상품 사진(약국이 찍은 사진, 다른 약국이 공유한 사진)과 식약처 건강기능식품 신고 정보 연결.
function migrateProductMedia() {
  addColumnIfMissing('product_images', 'image_key', 'TEXT');
  addColumnIfMissing('product_images', 'source', "TEXT NOT NULL DEFAULT 'UPLOAD'");
  addColumnIfMissing('product_images', 'pharmacy_id', 'INTEGER');
  addColumnIfMissing('product_images', 'created_by', 'INTEGER');
  addColumnIfMissing('product_images', 'width', 'INTEGER');
  addColumnIfMissing('product_images', 'height', 'INTEGER');
  // 내가 올린 사진을 같은 상품(바코드·신고번호)을 파는 다른 MAYDIN 약국이 쓰도록 허락하는지. 기본은 허락 안 함.
  addColumnIfMissing('pharmacies', 'share_product_photos', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('products', 'mfds_report_no', 'TEXT');
  // MANUAL: 약국이 고름 · AUTO: 이름이 하나로 맞아 자동 연결(약국 확인 전) · REMOVED: 약국이 해제(다시 자동 연결 안 함)
  addColumnIfMissing('products', 'mfds_link_source', 'TEXT');
  addColumnIfMissing('products', 'mfds_checked_at', 'TEXT');
  // NAME_COMPANY: 제품명·제조사 일치 · NAME_BRAND: 제품명·브랜드 일치(신고 업체는 다름) · NAME: 제품명만 일치(브랜드 미입력) · MANUAL: 약국이 골라 연결
  addColumnIfMissing('products', 'mfds_match_basis', 'TEXT');
  // 약사(약국 운영자 계정)가 확인한 시각. 비어 있으면 미검증이라 고객 화면에 보이지 않는다.
  if (addColumnIfMissing('products', 'mfds_verified_at', 'TEXT')) {
    db.exec("UPDATE products SET mfds_verified_at = COALESCE(mfds_checked_at, CURRENT_TIMESTAMP) WHERE mfds_report_no IS NOT NULL AND COALESCE(mfds_link_source, 'MANUAL') != 'AUTO'");
  }
  addColumnIfMissing('products', 'mfds_verified_by', 'INTEGER');
  // BARCODE · MFDS: 다른 약국 공유 사진을 같은 바코드/신고번호로 자동으로 붙인 사진
  addColumnIfMissing('product_images', 'match_basis', 'TEXT');
  if (addColumnIfMissing('product_images', 'verified_at', 'TEXT')) {
    db.exec('UPDATE product_images SET verified_at = created_at WHERE image_key IS NOT NULL');
  }
  addColumnIfMissing('product_images', 'verified_by', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_image_rejections (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      image_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (product_id, image_key)
    );`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_product_images_key ON product_images(image_key);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_mfds ON products(mfds_report_no);
    CREATE TABLE IF NOT EXISTS mfds_htfs (
      report_no TEXT PRIMARY KEY,
      product_name TEXT NOT NULL,
      company TEXT,
      main_function TEXT,
      intake_method TEXT,
      intake_caution TEXT,
      storage TEXT,
      shelf_life TEXT,
      appearance TEXT,
      standard TEXT,
      registered_at TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
  dbPath,
  migrate,
  assignMemberCode,
  assignReferralCode,
  getOne,
  getAll,
  run,
  transaction: (fn) => db.transaction(fn)
};
