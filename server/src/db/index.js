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

function migrate() {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
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
