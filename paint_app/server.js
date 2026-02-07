require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) {
  console.error('❌ Нет BOT_TOKEN в .env / Env Vars');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, -- manager | worker
      name TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      manager_tid TEXT NOT NULL,
      product TEXT NOT NULL,
      color TEXT NOT NULL,
      quantity REAL NOT NULL,
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'new', -- new | in_progress | completed
      worker_tid TEXT
    )
  `);
});

// ---- BOT ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function upsertUser(telegramId, role, name) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO users (telegram_id, role, name)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_id) DO UPDATE SET role=excluded.role, name=excluded.name`,
      [telegramId.toString(), role, name || ''],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getWorkers() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT telegram_id FROM users WHERE role='worker'`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.telegram_id));
    });
  });
}

// /start -> кнопки
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Выберите роль:', {
    reply_markup: {
      keyboard: [[{ text: '🛒 Manager' }, { text: '🛠 Worker' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
});

// Нажатие кнопок Manager/Worker
bot.on('message', async (msg) => {
  const text = (msg.text || '').trim();

  if (text === '🛒 Manager') {
    await upsertUser(msg.from.id, 'manager', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы менеджер. Откройте mini‑app:', {
      reply_markup: {
        remove_keyboard: true,
        inline_keyboard: [[{ text: '📱 Открыть mini‑app', web_app: { url: PUBLIC_URL } }]]
      }
    });
  }

  if (text === '🛠 Worker') {
    await upsertUser(msg.from.id, 'worker', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы рабочий. Ждите уведомления о заказах.', {
      reply_markup: { remove_keyboard: true }
    });
  }
});

// /open (если надо)
bot.onText(/\/open/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Открыть mini‑app:', {
    reply_markup: { inline_keyboard: [[{ text: '📱 Открыть', web_app: { url: PUBLIC_URL } }]] }
  });
});

// Кнопки “Взять/Готово”
bot.on('callback_query', async (q) => {
  const tid = q.from.id.toString();
  const [action, idStr] = (q.data || '').split(':');
  const orderId = Number(idStr);

  await bot.answerCallbackQuery(q.id);
  if (!orderId) return;

  if (action === 'take') {
    db.run(
      `UPDATE orders SET status='in_progress', worker_tid=?
       WHERE id=? AND status='new'`,
      [tid, orderId],
      async function (err) {
        if (err) return bot.sendMessage(tid, '❌ Ошибка БД');
        if (this.changes === 0) return bot.sendMessage(tid, `❌ Заказ #${orderId} уже взят/не найден`);

        await bot.editMessageText(`Заказ #${orderId} взят в работу ✅`, {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: 'Готово', callback_data: `complete:${orderId}` }]] }
        });
      }
    );
  }

  if (action === 'complete') {
    db.run(
      `UPDATE orders SET status='completed'
       WHERE id=? AND worker_tid=? AND status='in_progress'`,
      [orderId, tid],
      async function (err) {
        if (err) return bot.sendMessage(tid, '❌ Ошибка БД');
        if (this.changes === 0) return bot.sendMessage(tid, `❌ Нельзя завершить #${orderId}`);

        await bot.editMessageText(`Заказ #${orderId} завершён 🎉`, {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
        });
      }
    );
  }
});

// ---- API ----
app.get('/api/me', (req, res) => {
  const telegram_id = req.query.telegram_id?.toString();
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  db.get(`SELECT role, name FROM users WHERE telegram_id=?`, [telegram_id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'not registered' });
    res.json(row);
  });
});

app.post('/api/orders', (req, res) => {
  const { telegram_id, product, color, quantity, deadline } = req.body || {};
  if (!telegram_id || !product || !color || !quantity) {
    return res.status(400).json({ error: 'telegram_id, product, color, quantity required' });
  }

  db.get(`SELECT role FROM users WHERE telegram_id=?`, [telegram_id.toString()], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user || user.role !== 'manager') return res.status(403).json({ error: 'only manager' });

    db.run(
      `INSERT INTO orders (manager_tid, product, color, quantity, deadline) VALUES (?, ?, ?, ?, ?)`,
      [telegram_id.toString(), product, color, Number(quantity), deadline || null],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });

        const orderId = this.lastID;
        const workers = await getWorkers();

        for (const w of workers) {
          await bot.sendMessage(
            w,
            `🔔 Новый заказ #${orderId}\nПродукт: ${product}\nЦвет: ${color}\nКол-во: ${quantity} л`,
            { reply_markup: { inline_keyboard: [[{ text: 'Взять', callback_data: `take:${orderId}` }]] } }
          );
        }

        res.json({ success: true, id: orderId });
      }
    );
  });
});

app.get('/api/orders', (req, res) => {
  const telegram_id = req.query.telegram_id?.toString();
  if (!telegram_id) return res.status(400).json({ error: 'telegram_id required' });

  db.all(
    `SELECT * FROM orders WHERE manager_tid=? ORDER BY created_at DESC`,
    [telegram_id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));