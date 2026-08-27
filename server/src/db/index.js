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
  getOne,
  getAll,
  run,
  transaction: (fn) => db.transaction(fn)
};
