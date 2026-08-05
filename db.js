const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'dashboard.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'viewer',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS profit_estimation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT '',
      batch TEXT,
      product_code TEXT,
      sku TEXT NOT NULL,
      product_name TEXT,
      fram_model TEXT,
      estimated_price REAL,
      redline_price REAL,
      dd_value REAL,
      material_ratio REAL,
      tax_ratio REAL,
      first_leg_ratio REAL,
      last_leg_ratio REAL,
      warehouse_ratio REAL,
      purchase_price REAL,
      purchase_price_ex_tax REAL,
      est_first_leg_fee REAL,
      est_last_leg_fee REAL,
      est_promotion_rate REAL DEFAULT 0.1769,
      est_refund_rate REAL DEFAULT 0.0336,
      competitor_detail TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS profit_loss (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT '',
      sku TEXT NOT NULL,
      month TEXT,
      sales_volume REAL DEFAULT 0,
      sales_revenue REAL DEFAULT 0,
      gross_profit REAL DEFAULT 0,
      gross_margin REAL DEFAULT 0,
      material_ratio REAL DEFAULT 0,
      first_leg_ratio REAL DEFAULT 0,
      last_leg_ratio REAL DEFAULT 0,
      refund_rate REAL DEFAULT 0,
      warehouse_ratio REAL DEFAULT 0,
      promotion_ratio REAL DEFAULT 0,
      unit_price REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT DEFAULT '',
      sku TEXT NOT NULL,
      brand TEXT,
      fba_first_arrival TEXT,
      fba_available_stock INTEGER DEFAULT 0,
      fba_in_transit INTEGER DEFAULT 0,
      total_stock INTEGER DEFAULT 0,
      sales_7d REAL DEFAULT 0,
      sales_14d REAL DEFAULT 0,
      sales_30d REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS upload_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT,
      file_type TEXT,
      category TEXT DEFAULT '',
      rows_imported INTEGER DEFAULT 0,
      uploaded_by TEXT,
      uploaded_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS category_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, category)
    );

    INSERT OR IGNORE INTO users (name, role) VALUES ('admin', 'admin');
    INSERT OR IGNORE INTO categories (name) VALUES ('滤清组套');
  `);

  // Add category column to existing tables if missing (migration)
  try { db.exec('ALTER TABLE profit_estimation ADD COLUMN category TEXT DEFAULT ""'); } catch(e) {}
  try { db.exec('ALTER TABLE profit_loss ADD COLUMN category TEXT DEFAULT ""'); } catch(e) {}
  try { db.exec('ALTER TABLE inventory ADD COLUMN category TEXT DEFAULT ""'); } catch(e) {}
  try { db.exec('ALTER TABLE upload_log ADD COLUMN category TEXT DEFAULT ""'); } catch(e) {}

  // Update existing data with default category
  db.exec("UPDATE profit_estimation SET category='滤清组套' WHERE category='' OR category IS NULL");
  db.exec("UPDATE profit_loss SET category='滤清组套' WHERE category='' OR category IS NULL");
  db.exec("UPDATE inventory SET category='滤清组套' WHERE category='' OR category IS NULL");
  db.exec("UPDATE upload_log SET category='滤清组套' WHERE category='' OR category IS NULL");

  console.log('Database initialized successfully');
  return db;
}

module.exports = { getDb, initDb };
