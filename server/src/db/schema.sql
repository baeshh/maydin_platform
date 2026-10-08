PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pharmacies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_code TEXT NOT NULL UNIQUE,
  pharmacy_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  business_number TEXT,
  phone TEXT,
  address TEXT,
  store_slug TEXT NOT NULL UNIQUE,
  store_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  commission_rate REAL NOT NULL DEFAULT 5,
  settlement_bank TEXT,
  settlement_account TEXT,
  delivery_policy TEXT,
  default_courier TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER', 'PHARMACY_OWNER', 'ADMIN', 'POS_STAFF')),
  pharmacy_id INTEGER REFERENCES pharmacies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT NOT NULL,
  default_address_id INTEGER,
  marketing_agree INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  receiver_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  zip_code TEXT,
  address TEXT NOT NULL,
  address_detail TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  category_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE(pharmacy_id, category_name)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL,
  discount_price INTEGER,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ON_SALE',
  thumbnail_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS carts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT,
  order_type TEXT NOT NULL DEFAULT 'DELIVERY',
  total_product_amount INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  final_amount INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'PAID',
  order_status TEXT NOT NULL DEFAULT 'PAYMENT_COMPLETED',
  delivery_status TEXT NOT NULL DEFAULT 'NOT_SHIPPED',
  preferred_at TEXT,
  memo TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price INTEGER NOT NULL,
  total_price INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_method TEXT NOT NULL DEFAULT 'MOCK_CARD',
  payment_provider TEXT NOT NULL DEFAULT 'MOCK',
  payment_status TEXT NOT NULL DEFAULT 'PAID',
  paid_amount INTEGER NOT NULL,
  paid_at TEXT,
  canceled_at TEXT,
  refunded_at TEXT
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  courier TEXT,
  tracking_number TEXT,
  receiver_name TEXT NOT NULL,
  receiver_phone TEXT NOT NULL,
  zip_code TEXT,
  address TEXT NOT NULL,
  address_detail TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'NOT_SHIPPED',
  shipped_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS inventory_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  settlement_period TEXT NOT NULL,
  total_sales INTEGER NOT NULL DEFAULT 0,
  refund_amount INTEGER NOT NULL DEFAULT 0,
  pg_fee INTEGER NOT NULL DEFAULT 0,
  platform_fee INTEGER NOT NULL DEFAULT 0,
  settlement_amount INTEGER NOT NULL DEFAULT 0,
  settlement_status TEXT NOT NULL DEFAULT 'PENDING',
  settled_at TEXT
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS qr_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL UNIQUE REFERENCES pharmacies(id) ON DELETE CASCADE,
  qr_url TEXT NOT NULL,
  qr_image_url TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  signup_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS partnership_inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  license_number TEXT NOT NULL DEFAULT '',
  license_file_name TEXT,
  license_file_path TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pos_terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  terminal_name TEXT NOT NULL,
  van_company TEXT,
  tid TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pos_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  terminal_id INTEGER NOT NULL REFERENCES pos_terminals(id) ON DELETE RESTRICT,
  business_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opening_cash INTEGER NOT NULL DEFAULT 0,
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expected_cash INTEGER,
  actual_cash INTEGER,
  cash_difference INTEGER,
  summary_json TEXT,
  close_note TEXT,
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES pos_sessions(id) ON DELETE CASCADE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('DEPOSIT', 'WITHDRAW')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  original_order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  refund_order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  refund_type TEXT NOT NULL CHECK (refund_type IN ('CANCEL', 'PARTIAL')),
  refund_amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pos_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  terminal_id INTEGER REFERENCES pos_terminals(id) ON DELETE SET NULL,
  session_id INTEGER REFERENCES pos_sessions(id) ON DELETE SET NULL,
  hold_number INTEGER NOT NULL,
  label TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  counsel_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  items_json TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT,
  status TEXT NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'RECALLED', 'DISCARDED')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS van_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  terminal_id INTEGER REFERENCES pos_terminals(id) ON DELETE SET NULL,
  van_company TEXT,
  tid TEXT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('APPROVE', 'CANCEL', 'CASH_RECEIPT')),
  payment_method TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  installment_months INTEGER NOT NULL DEFAULT 0,
  approval_number TEXT NOT NULL,
  card_company TEXT,
  masked_identity TEXT,
  original_approval_number TEXT,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'USED', 'VOIDED', 'DECLINED')),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  is_demo INTEGER NOT NULL DEFAULT 1,
  message TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('EARN', 'USE', 'EARN_CANCEL', 'USE_RESTORE', 'ADJUST', 'REWARD')),
  points INTEGER NOT NULL CHECK (points != 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lot_number TEXT,
  expiry_date TEXT NOT NULL,
  received_quantity INTEGER NOT NULL CHECK (received_quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  unit_cost INTEGER,
  supplier_id INTEGER,
  purchase_order_id INTEGER,
  received_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_number TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  po_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  expected_date TEXT,
  memo TEXT,
  total_amount INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ordered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ordered_at TEXT,
  received_at TEXT,
  closed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pharmacy_id, po_number)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  barcode TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0 AND received_quantity <= quantity),
  unit_cost INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (purchase_order_id, product_id)
);

CREATE TABLE IF NOT EXISTS signup_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'ETC' CHECK (channel_type IN ('COUNTER', 'FLYER', 'PARTNER', 'ONLINE', 'ETC')),
  memo TEXT,
  scan_count INTEGER NOT NULL DEFAULT 0,
  signup_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS member_policies (
  pharmacy_id INTEGER PRIMARY KEY REFERENCES pharmacies(id) ON DELETE CASCADE,
  silver_min INTEGER NOT NULL DEFAULT 100000,
  gold_min INTEGER NOT NULL DEFAULT 300000,
  vip_min INTEGER NOT NULL DEFAULT 700000,
  silver_bonus REAL NOT NULL DEFAULT 0.5,
  gold_bonus REAL NOT NULL DEFAULT 1,
  vip_bonus REAL NOT NULL DEFAULT 2,
  churn_multiplier REAL NOT NULL DEFAULT 2,
  dormant_days INTEGER NOT NULL DEFAULT 180,
  new_days INTEGER NOT NULL DEFAULT 30,
  birthday_multiplier REAL NOT NULL DEFAULT 2,
  referral_reward INTEGER NOT NULL DEFAULT 1000,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('STORE', 'POS')),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restock_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING', 'NOTIFIED', 'DONE', 'CANCELED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at TEXT,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS product_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ORDERED', 'STOCKED', 'REJECTED')),
  reply TEXT,
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 대표 회원 아래 가족. 계정 없는 가족(자녀·부모)은 호칭·출생연도만, 이미 가입한 회원은 linked_customer_id로 연결한다.
CREATE TABLE IF NOT EXISTS family_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  head_customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  linked_customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('SPOUSE', 'CHILD', 'PARENT', 'GRANDPARENT', 'SIBLING', 'ETC')),
  birth_year INTEGER,
  gender TEXT CHECK (gender IN ('F', 'M')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 1회용 인증 코드. SIGNUP은 비회원 현장 구매 영수증에, PIN_RESET은 약국이 기존 회원에게 발급한다.
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('SIGNUP', 'PIN_RESET')),
  code TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'REVOKED')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL
    CHECK (consent_type IN ('TERMS', 'PRIVACY', 'HEALTH_INFO', 'MARKETING_SMS', 'MARKETING_KAKAO', 'MARKETING_NIGHT', 'THIRD_PARTY')),
  agreed INTEGER NOT NULL CHECK (agreed IN (0, 1)),
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('SIGNUP', 'APP', 'POS', 'PARTNER', 'NOTICE', 'MIGRATION')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_role_pharmacy ON users(role, pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_products_pharmacy ON products(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_orders_pharmacy ON orders(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_carts_user ON carts(user_id, pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_partnership_inquiries_status ON partnership_inquiries(status, id DESC);
