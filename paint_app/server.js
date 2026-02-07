require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN missing'); process.exit(1); }
if (!PUBLIC_URL || !PUBLIC_URL.startsWith('https://')) { console.error('❌ PUBLIC_URL missing/invalid'); process.exit(1); }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

// ---- DB init + soft migrations ----
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, -- manager | director | worker
      name TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      manager_tid TEXT NOT NULL,

      items_json TEXT NOT NULL,      -- JSON array [{product,color,quantity}]
      urgent INTEGER DEFAULT 0,      -- 1 срочно

      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'new',  -- new | in_progress | completed | archived | canceled
      worker_tid TEXT,

      completed_at TEXT,
      archived_at TEXT,
      canceled_at TEXT,
      cancel_reason TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      worker_tid TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'new' | 'in_progress'
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // soft migrations (ignore errors)
  const alter = (sql) => db.run(sql, () => {});
  alter(`ALTER TABLE orders ADD COLUMN items_json TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN urgent INTEGER DEFAULT 0`);
  alter(`ALTER TABLE orders ADD COLUMN completed_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN archived_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN canceled_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN cancel_reason TEXT`);
});

// ---- Telegram Bot (WEBHOOK) ----
const bot = new TelegramBot(BOT_TOKEN);
const WEBHOOK_PATH = '/telegram-webhook';
app.post(WEBHOOK_PATH, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

// ---- Helpers ----
const ARCHIVE_AFTER_HOURS = 12;
const ARCHIVE_KEEP_DAYS = 30;

function nowIso() { return new Date().toISOString(); }
function hoursDiff(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / 36e5; }
function daysDiff(a, b) { return (new Date(b).getTime() - new Date(a).getTime()) / (36e5 * 24); }

function safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

function upsertUser(tid, role, name) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO users (telegram_id, role, name)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET role=excluded.role, name=excluded.name`,
      [tid.toString(), role, name || ''],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getUser(tid) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE telegram_id=?`, [tid.toString()], (err, row) => err ? reject(err) : resolve(row));
  });
}

function getUserName(tid) {
  return new Promise((resolve) => {
    db.get(`SELECT name FROM users WHERE telegram_id=?`, [tid?.toString() || ''], (err, row) => resolve(row?.name || null));
  });
}

function getWorkers() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT telegram_id, name FROM users WHERE role='worker'`, [], (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function getOrder(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM orders WHERE id=?`, [id], (err, row) => err ? reject(err) : resolve(row));
  });
}

async function enrichOrder(o) {
  return {
    ...o,
    items: safeJsonParse(o.items_json, []),
    worker_name: o.worker_tid ? await getUserName(o.worker_tid) : null
  };
}

function statusRu(s) {
  return ({ new:'Новые', in_progress:'В работе', completed:'Готово', archived:'Архив', canceled:'Отменено' })[s] || s;
}

function orderText(o) {
  const urgent = o.urgent ? '🔥 СРОЧНО\n' : '';
  const items = 
