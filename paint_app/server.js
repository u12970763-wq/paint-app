require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // https://paint-app-1.onrender.com

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing');
  process.exit(1);
}
if (!PUBLIC_URL || !PUBLIC_URL.startsWith('https://')) {
  console.error('❌ PUBLIC_URL is missing or not https');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- DB -----
const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      manager_tid TEXT NOT NULL, -- кто создал (manager или director)
      product TEXT NOT NULL,
      color TEXT NOT NULL,
      quantity REAL NOT NULL,
      deadline TEXT,

      status TEXT NOT NULL DEFAULT 'new', -- new | in_progress | completed | archived | canceled
      worker_tid TEXT,

      completed_at TEXT,
      archived_at TEXT,
      canceled_at TEXT,
      cancel_reason TEXT
    )
  `);

  // мягкая миграция (не ломает если колонка уже есть)
  const alter = (sql) => db.run(sql, () => {});
  alter(`ALTER TABLE orders ADD COLUMN completed_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN archived_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN canceled_at TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN cancel_reason TEXT`);
});

// ----- Telegram Bot (WEBHOOK) -----
const bot = new TelegramBot(BOT_TOKEN);
const WEBHOOK_PATH = '/telegram-webhook';

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ----- Helpers -----
function nowIso() {
  return new Date().toISOString();
}

function hoursBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  return (b - a) / (1000 * 60 * 60);
}

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

function getUser(telegramId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM users WHERE telegram_id=?`, [telegramId.toString()], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function getWorkers() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT telegram_id, name FROM users WHERE role='worker'`, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getUserNameByTid(tid) {
  return new Promise((resolve) => {
    db.get(`SELECT name FROM users WHERE telegram_id=?`, [tid?.toString() || ''], (err, row) => {
      resolve(row?.name || null);
    });
  });
}

function getOrderById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM orders WHERE id=?`, [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function enrichOrder(o) {
  return {
    ...o,
    worker_name: o.worker_tid ? await getUserNameByTid(o.worker_tid) : null
  };
}

function listOrdersForManager(managerTid, status, limit = 200) {
  return new Promise((resolve, reject) => {
    const params = [managerTid.toString()];
    let where = `manager_tid=?`;

    if (status && status !== 'all') {
      where += ` AND status=?`;
      params.push(status);
    }

    db.all(
      `SELECT * FROM orders
       WHERE ${where}
       ORDER BY datetime(created_at) DESC
       LIMIT ${Number(limit)}`,
      params,
      async (err, rows) => {
        if (err) return reject(err);
        const out = [];
        for (const r of rows) out.push(await enrichOrder(r));
        resolve(out);
      }
    );
  });
}

function listOrdersForWorker(scopeTid, scope, status, limit = 50) {
  return new Promise((resolve, reject) => {
    const params = [];
    let where = `1=1`;

    if (scope === 'mine') {
      where += ` AND worker_tid=?`;
      params.push(scopeTid.toString());
    }

    if (status && status !== 'all') {
      where += ` AND status=?`;
      params.push(status);
    }

    db.all(
      `SELECT * FROM orders
       WHERE ${where}
       ORDER BY datetime(created_at) DESC
       LIMIT ${Number(limit)}`,
      params,
      async (err, rows) => {
        if (err) return reject(err);
        const out = [];
        for (const r of rows) out.push(await enrichOrder(r));
        resolve(out);
      }
    );
  });
}

// ----- Auto-archive (every 10 min) -----
async function autoArchiveCompleted() {
  db.all(`SELECT id, completed_at FROM orders WHERE status='completed' AND completed_at IS NOT NULL`, [], (err, rows) => {
    if (err) return;
    const now = nowIso();
    rows.forEach((r) => {
      if (hoursBetween(r.completed_at, now) >= 12) {
        db.run(
          `UPDATE orders SET status='archived', archived_at=? WHERE id=? AND status='completed'`,
          [nowIso(), r.id]
        );
      }
    });
  });
}
setInterval(autoArchiveCompleted, 10 * 60 * 1000);

// ----- Bot Menus -----
function roleKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: '🛒 Manager' }, { text: '👔 Director' }, { text: '🛠 Worker' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function workerMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '📋 Все заявки' }, { text: '🧰 Мои заявки' }],
        [{ text: '🗂 Архив' }]
      ],
      resize_keyboard: true
    }
  };
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Выберите роль:', roleKeyboard());
});

bot.on('message', async (msg) => {
  const tid = msg.from.id.toString();
  const text = (msg.text || '').trim();
  if (text.startsWith('/')) return;

  if (text === '🛒 Manager') {
    await upsertUser(tid, 'manager', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Manager. Открыть панель "Заявки":', {
      reply_markup: {
        remove_keyboard: true,
        inline_keyboard: [[{ text: '📱 Открыть "Заявки"', web_app: { url: PUBLIC_URL } }]]
      }
    });
  }

  if (text === '👔 Director') {
    await upsertUser(tid, 'director', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Director. Открыть панель "Заявки":', {
      reply_markup: {
        remove_keyboard: true,
        inline_keyboard: [[{ text: '📱 Открыть "Заявки"', web_app: { url: PUBLIC_URL } }]]
      }
    });
  }

  if (text === '🛠 Worker') {
    await upsertUser(tid, 'worker', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Worker. Меню:', workerMenu());
  }

  // Worker menu
  const user = await getUser(tid).catch(() => null);
  if (user?.role === 'worker') {
    if (text === '📋 Все заявки') {
      const orders = await listOrdersForWorker(tid, 'all', 'all', 10);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'Нет заявок.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, formatOrderForWorker(o), workerOrderKeyboard(o, tid));
      return;
    }

    if (text === '🧰 Мои заявки') {
      const orders = await listOrdersForWorker(tid, 'mine', 'all', 10);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'У вас нет заявок.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, formatOrderForWorker(o), workerOrderKeyboard(o, tid));
      return;
    }

    if (text === '🗂 Архив') {
      const orders = await listOrdersForWorker(tid, 'all', 'archived', 10);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'Архив пуст.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, formatOrderForWorker(o), workerOrderKeyboard(o, tid));
      return;
    }
  }
});

bot.onText(/\/open/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Открыть панель "Заявки":', {
    reply_markup: { inline_keyboard: [[{ text: '📱 Открыть', web_app: { url: PUBLIC_URL } }]] }
  });
});

// ----- Formatting & keyboards -----
function statusRu(s) {
  return ({
    new: 'Новые',
    in_progress: 'В работе',
    completed: 'Готово',
    archived: 'Архив',
    canceled: 'Отменено'
  })[s] || s;
}

function formatOrderForWorker(o) {
  const deadline = o.deadline ? `\n⏱ Срок: ${new Date(o.deadline).toLocaleString()}` : '';
  const worker = o.worker_name ? `\n👷 Рабочий: ${o.worker_name}` : (o.worker_tid ? `\n👷 Рабочий: ${o.worker_tid}` : '');
  return `#${o.id} — ${statusRu(o.status)}
🧾 Продукт: ${o.product}
🎨 Цвет: ${o.color}
📦 Кол-во: ${o.quantity} л${deadline}${worker}`;
}

function workerOrderKeyboard(o, myTid) {
  const buttons = [];
  if (o.status === 'new') buttons.push([{ text: '✅ Взять', callback_data: `take:${o.id}` }]);
  if (o.status === 'in_progress' && o.worker_tid === myTid) buttons.push([{ text: '🏁 Готово', callback_data: `complete:${o.id}` }]);
  if (o.status === 'completed') buttons.push([{ text: '🗂 В архив', callback_data: `archive:${o.id}` }]);
  return buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
}

// ----- Callbacks -----
bot.on('callback_query', async (q) => {
  const tid = q.from.id.toString();
  const [action, idStr] = (q.data || '').split(':');
  const orderId = Number(idStr);

  await bot.answerCallbackQuery(q.id);
  if (!orderId) return;

  if (action === 'take') {
    const user = await getUser(tid).catch(() => null);
    if (user?.role !== 'worker') return bot.sendMessage(tid, 'Только Worker может брать заявки.');

    db.run(
      `UPDATE orders SET status='in_progress', worker_tid=? WHERE id=? AND status='new'`,
      [tid, orderId],
      async function (err) {
        if (err) return bot.sendMessage(tid, '❌ Ошибка БД');
        if (this.changes === 0) return bot.sendMessage(tid, `❌ Нельзя взять #${orderId}`);

        const o = await enrichOrder(await getOrderById(orderId));
        await bot.editMessageText(formatOrderForWorker(o), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          ...workerOrderKeyboard(o, tid)
        });
      }
    );
  }

  if (action === 'complete') {
    const user = await getUser(tid).catch(() => null);
    if (user?.role !== 'worker') return bot.sendMessage(tid, 'Только Worker.');

    db.run(
      `UPDATE orders SET status='completed', completed_at=? 
       WHERE id=? AND worker_tid=? AND status='in_progress'`,
      [nowIso(), orderId, tid],
      async function (err) {
        if (err) return bot.sendMessage(tid, '❌ Ошибка БД');
        if (this.changes === 0) return bot.sendMessage(tid, `❌ Нельзя завершить #${orderId}`);

        const order = await enrichOrder(await getOrderById(orderId));
        await bot.editMessageText(formatOrderForWorker(order), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          ...workerOrderKeyboard(order, tid)
        });

        // Уведомление создателю (manager/director) — ТОЛЬКО ему
        const workerName = order.worker_name || tid;
        await bot.sendMessage(
          order.manager_tid,
          `✅ Заявка #${orderId} готова!\nРабочий: ${workerName}\nПродукт: ${order.product}\nЦвет: ${order.color}\nКоличество: ${order.quantity} л`
        );
      }
    );
  }

  if (action === 'archive') {
    // менеджер/директор и рабочий могут архивировать completed
    db.run(
      `UPDATE orders SET status='archived', archived_at=? WHERE id=? AND status='completed'`,
      [nowIso(), orderId],
      async function (err) {
        if (err) return bot.sendMessage(tid, '❌ Ошибка БД');
        if (this.changes === 0) return bot.sendMessage(tid, `❌ Нельзя архивировать #${orderId}`);

        const o = await enrichOrder(await getOrderById(orderId));
        await bot.editMessageText(formatOrderForWorker(o), {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
        });
      }
    );
  }
});

// ----- API permissions: manager or director -----
function requireManagerOrDirector(req, res, next) {
  const tid = (req.query.telegram_id || req.body.telegram_id || '').toString();
  if (!tid) return res.status(400).json({ error: 'telegram_id required' });

  db.get(`SELECT role FROM users WHERE telegram_id=?`, [tid], (err, row) => {
    if (err) return res.status(500).json({ error: err.message 
