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

  // soft migrations if you had old schema
  const alter = (sql) => db.run(sql, () => {});
  alter(`ALTER TABLE orders ADD COLUMN items_json TEXT`);
  alter(`ALTER TABLE orders ADD COLUMN urgent INTEGER DEFAULT 0`);
  alter(`ALTER TABLE order_notifications ADD COLUMN type TEXT`);
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

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

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
        [{ text: '🔥 Срочно' }, { text: '📋 Новые' }],
        [{ text: '🧰 Мои' }, { text: '✅ Готово' }]
      ],
      resize_keyboard: true
    }
  };
}

function statusRu(s) {
  return ({ new:'Новые', in_progress:'В работе', completed:'Готово', archived:'Архив', canceled:'Отменено' })[s] || s;
}

function orderText(o) {
  const urgent = o.urgent ? '🔥 СРОЧНО\n' : '';
  const items = (o.items || []).map((it, idx) => `• ${it.product} | ${it.color} | ${it.quantity} л`).join('\n');
  const deadline = o.deadline ? `\n⏱ Срок: ${new Date(o.deadline).toLocaleString()}` : '';
  const worker = o.worker_name ? `\n👷 Рабочий: ${o.worker_name}` : (o.worker_tid ? `\n👷 Рабочий: ${o.worker_tid}` : '');
  return `${urgent}#${o.id} — ${statusRu(o.status)}${deadline}${worker}\n${items}`;
}

function workerButtons(o, myTid) {
  const kb = [];
  if (o.status === 'new') kb.push([{ text: '✅ Принять в работу', callback_data: `take:${o.id}` }]);
  if (o.status === 'in_progress' && o.worker_tid === myTid) kb.push([{ text: '🏁 Готово', callback_data: `complete:${o.id}` }]);
  return kb.length ? { reply_markup: { inline_keyboard: kb } } : {};
}

async function deleteSafe(chatId, messageId) {
  try { await bot.deleteMessage(chatId, messageId); } catch {}
}

// ---- Notifications table helpers ----
function saveNotification({ order_id, worker_tid, chat_id, message_id, type }) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO order_notifications (order_id, worker_tid, chat_id, message_id, type) VALUES (?, ?, ?, ?, ?)`,
      [order_id, worker_tid.toString(), chat_id.toString(), Number(message_id), type],
      () => resolve()
    );
  });
}

function getNotifications(orderId, type = null) {
  return new Promise((resolve, reject) => {
    const params = [Number(orderId)];
    let where = `order_id=?`;
    if (type) { where += ` AND type=?`; params.push(type); }

    db.all(`SELECT * FROM order_notifications WHERE ${where}`, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function clearNotifications(orderId, type = null) {
  return new Promise((resolve) => {
    const params = [Number(orderId)];
    let where = `order_id=?`;
    if (type) { where += ` AND type=?`; params.push(type); }
    db.run(`DELETE FROM order_notifications WHERE ${where}`, params, () => resolve());
  });
}

// ---- Scheduled jobs ----

// completed -> archived after 12h
function autoArchiveJob() {
  db.all(`SELECT id, completed_at FROM orders WHERE status='completed' AND completed_at IS NOT NULL`, [], (err, rows) => {
    if (err) return;
    const now = nowIso();
    rows.forEach(r => {
      if (hoursDiff(r.completed_at, now) >= ARCHIVE_AFTER_HOURS) {
        db.run(`UPDATE orders SET status='archived', archived_at=? WHERE id=? AND status='completed'`, [nowIso(), r.id]);
      }
    });
  });
}
setInterval(autoArchiveJob, 10 * 60 * 1000);

// delete archived older than 30 days (once per day)
function cleanupJob() {
  db.all(`SELECT id, archived_at FROM orders WHERE status='archived' AND archived_at IS NOT NULL`, [], (err, rows) => {
    if (err) return;
    const now = nowIso();
    rows.forEach(r => {
      if (daysDiff(r.archived_at, now) >= ARCHIVE_KEEP_DAYS) {
        db.run(`DELETE FROM orders WHERE id=?`, [r.id]);
        db.run(`DELETE FROM order_notifications WHERE order_id=?`, [r.id]);
      }
    });
  });

  // also cleanup orphan notifications older than 7 days
  db.run(`
    DELETE FROM order_notifications
    WHERE created_at < datetime('now', '-7 days')
  `);
}
setInterval(cleanupJob, 24 * 60 * 60 * 1000);

// ---- BOT commands ----
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Выберите роль:', roleKeyboard());
});

bot.on('message', async (msg) => {
  const tid = msg.from.id.toString();
  const text = (msg.text || '').trim();
  if (text.startsWith('/')) return;

  if (text === '🛒 Manager') {
    await upsertUser(tid, 'manager', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Manager. Открыть "Заявки":', {
      reply_markup: { remove_keyboard: true, inline_keyboard: [[{ text: '📱 Открыть "Заявки"', web_app: { url: PUBLIC_URL } }]] }
    });
  }

  if (text === '👔 Director') {
    await upsertUser(tid, 'director', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Director. Открыть "Заявки":', {
      reply_markup: { remove_keyboard: true, inline_keyboard: [[{ text: '📱 Открыть "Заявки"', web_app: { url: PUBLIC_URL } }]] }
    });
  }

  if (text === '🛠 Worker') {
    await upsertUser(tid, 'worker', msg.from.first_name);
    return bot.sendMessage(msg.chat.id, '✅ Вы Worker. Меню:', workerMenu());
  }

  // Worker menu (only актуальные + готово)
  const user = await getUser(tid).catch(() => null);
  if (user?.role === 'worker') {
    if (text === '🔥 Срочно') {
      const orders = await listWorkerUrgentNewAndMine(tid, 15);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'Нет срочных актуальных заявок.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, orderText(o), workerButtons(o, tid));
      return;
    }

    if (text === '📋 Новые') {
      const orders = await listWorkerNew(tid, 15);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'Нет новых заявок.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, orderText(o), workerButtons(o, tid));
      return;
    }

    if (text === '🧰 Мои') {
      const orders = await listWorkerMineInProgress(tid, 15);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'У вас нет заявок в работе.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, orderText(o), workerButtons(o, tid));
      return;
    }

    if (text === '✅ Готово') {
      const orders = await listWorkerMineCompleted(tid, 15);
      if (!orders.length) return bot.sendMessage(msg.chat.id, 'У вас нет готовых заявок.', workerMenu());
      for (const o of orders) await bot.sendMessage(msg.chat.id, orderText(o));
      return;
    }
  }
});

// Worker lists with required filtering
function listOrders(where, params) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM orders WHERE ${where} ORDER BY urgent DESC, datetime(created_at) DESC LIMIT 200`,
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

async function listWorkerNew(tid, limit = 15) {
  const rows = await listOrders(`status='new'`, []);
  return rows.slice(0, limit);
}
async function listWorkerMineInProgress(tid, limit = 15) {
  const rows = await listOrders(`status='in_progress' AND worker_tid=?`, [tid.toString()]);
  return rows.slice(0, limit);
}
async function listWorkerMineCompleted(tid, limit = 15) {
  const rows = await listOrders(`status='completed' AND worker_tid=?`, [tid.toString()]);
  return rows.slice(0, limit);
}
async function listWorkerUrgentNewAndMine(tid, limit = 15) {
  const rows = await listOrders(
    `(urgent=1) AND ((status='new') OR (status='in_progress' AND worker_tid=?))`,
    [tid.toString()]
  );
  return rows.slice(0, limit);
}

// ---- Callback buttons ----
bot.on('callback_query', async (q) => {
  const tid = q.from.id.toString();
  const [action, idStr] = (q.data || '').split(':');
  const orderId = Number(idStr);
  await bot.answerCallbackQuery(q.id);
  if (!orderId) return;

  if (action === 'take') {
    const user = await getUser(tid).catch(() => null);
    if (user?.role !== 'worker') return;

    // try take atomically
    db.run(
      `UPDATE orders SET status='in_progress', worker_tid=? WHERE id=? AND status='new'`,
      [tid, orderId],
      async function (err) {
        if (err || this.changes === 0) {
          // someone else took it -> delete this message for current worker
          await deleteSafe(q.message.chat.id, q.message.message_id);
          return;
        }

        // delete "new order" messages for all workers (including current one)
        const notes = await getNotifications(orderId, 'new').catch(() => []);
        for (const n of notes) await deleteSafe(n.chat_id, n.message_id);
        await clearNotifications(orderId, 'new');

        // send new "in_progress" message only to taker, store it so we can delete on complete
        const order = await enrichOrder(await getOrder(orderId));
        const sent = await bot.sendMessage(q.message.chat.id, orderText(order), workerButtons(order, tid));
        await saveNotification({
          order_id: orderId,
          worker_tid: tid,
          chat_id: q.message.chat.id.toString(),
          message_id: sent.message_id,
          type: 'in_progress'
        });
      }
    );
  }

  if (action === 'complete') {
    const user = await getUser(tid).catch(() => null);
    if (user?.role !== 'worker') return;

    db.run(
      `UPDATE orders SET status='completed', completed_at=? 
       WHERE id=? AND worker_tid=? AND status='in_progress'`,
      [nowIso(), orderId, tid],
      async function (err) {
        if (err || this.changes === 0) return;

        // delete worker "in_progress" message(s)
        const notes = await getNotifications(orderId, 'in_progress').catch(() => []);
        for (const n of notes) {
          if (n.worker_tid === tid) await deleteSafe(n.chat_id, n.message_id);
        }
        await clearNotifications(orderId, 'in_progress');

        // notify creator (manager/director) only
        const order = await enrichOrder(await getOrder(orderId));
        const workerName = order.worker_name || tid;
        await bot.sendMessage(
          order.manager_tid,
          `✅ Заявка #${orderId} готова!\nРабочий: ${workerName}\n${orderText(order)}`
        );
      }
    );
  }
});

// ---- API permissions ----
function requireManagerOrDirector(req, res, next) {
  const tid = (req.query.telegram_id || req.body.telegram_id || '').toString();
  if (!tid) return res.status(400).json({ error: 'telegram_id required' });

  db.get(`SELECT role FROM users WHERE telegram_id=?`, [tid], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || !['manager', 'director'].includes(row.role)) return res.status(403).json({ error: 'only manager/director' });
    req.manager_tid = tid;
    next();
  });
}

// ---- API: me ----
app.get('/api/me', async (req, res) => {
  const tid = (req.query.telegram_id || '').toString();
  if (!tid) return res.status(400).json({ error: 'telegram_id required' });
  const u = await getUser(tid).catch(() => null);
  if (!u) return res.status(404).json({ error: 'not registered' });
  res.json({ role: u.role, name: u.name });
});

// ---- API: manager/director list orders ----
app.get('/api/orders', requireManagerOrDirector, async (req, res) => {
  const status = (req.query.status || 'new').toString();
  const urgent = (req.query.urgent || '0').toString() === '1';

  const whereParts = [`manager_tid=?`];
  const params = [req.manager_tid];

  // status filter
  if (status !== 'all') {
    whereParts.push(`status=?`);
    params.push(status);
  } else {
    // all means except canceled (since you removed canceled tab)
    whereParts.push(`status != 'canceled'`);
  }

  if (urgent) {
    whereParts.push(`urgent=1`);
    // urgent list should be only актуальные: exclude archived
    whereParts.push(`status != 'archived'`);
    whereParts.push(`status != 'canceled'`);
  }

  const where = whereParts.join(' AND ');
  db.all(
    `SELECT * FROM orders WHERE ${where} ORDER BY urgent DESC, datetime(created_at) DESC LIMIT 500`,
    params,
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const out = [];
      for (const r of rows) out.push(await enrichOrder(r));
      res.json(out);
    }
  );
});

// ---- API: create order (items unlimited + urgent) ----
app.post('/api/orders', requireManagerOrDirector, async (req, res) => {
  const urgent = req.body?.urgent ? 1 : 0;
  const deadline = req.body?.deadline || null;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const cleanItems = items
    .map(it => ({
      product: (it.product || '').toString().trim(),
      color: (it.color || '').toString().trim(),
      quantity: Number(it.quantity)
    }))
    .filter(it => it.product && it.color && Number.isFinite(it.quantity) && it.quantity > 0);

  if (!cleanItems.length) return res.status(400).json({ error: 'items required' });

  const items_json = JSON.stringify(cleanItems);

  db.run(
    `INSERT INTO orders (manager_tid, items_json, urgent, deadline) VALUES (?, ?, ?, ?)`,
    [req.manager_tid, items_json, urgent, deadline],
    async function (err) {
      if (err) return res.status(500).json({ error: err.message });

      const orderId = this.lastID;
      const order = await enrichOrder(await getOrder(orderId));

      // notify all workers about NEW order and store message_id for deletion
      const workers = await getWorkers();
      for (const w of workers) {
        const sent = await bot.sendMessage(
          w.telegram_id,
          orderText(order),
          { reply_markup: { inline_keyboard: [[{ text: '✅ Принять в работу', callback_data: `take:${orderId}` }]] } }
        );
        await saveNotification({
          order_id: orderId,
          worker_tid: w.telegram_id,
          chat_id: w.telegram_id, // in private chat chat_id 
