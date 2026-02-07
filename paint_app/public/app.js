const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const telegramId = user.id.toString();

const elManager = document.getElementById('manager');
const elNot = document.getElementById('not-manager');
const elList = document.getElementById('list');

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function statusText(s) {
  if (s === 'new') return 'Новый';
  if (s === 'in_progress') return 'В работе';
  if (s === 'completed') return 'Готово';
  return s;
}

async function loadOrders() {
  const orders = await api(`/api/orders?telegram_id=${telegramId}`);
  elList.innerHTML = orders.length ? '' : '<div>Заказов пока нет.</div>';

  for (const o of orders) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div><b>#${o.id}</b> — ${o.product}</div>
      <div>Цвет: ${o.color}</div>
      <div>Количество: ${o.quantity} л</div>
      <div>Статус: <span class="badge ${o.status}">${statusText(o.status)}</span></div>
      ${o.deadline ? `<div>Срок: ${new Date(o.deadline).toLocaleString()}</div>` : ''}
      ${o.worker_tid ? `<div>Рабочий TG ID: ${o.worker_tid}</div>` : ''}
    `;
    elList.appendChild(div);
  }
}

function setupForm() {
  const form = document.getElementById('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const product = document.getElementById('product').value.trim();
    const color = document.getElementById('color').value.trim();
    const quantity = parseFloat(document.getElementById('quantity').value);
    const deadline = document.getElementById('deadline').value || null;

    try {
      await api('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegram_id: telegramId, product, color, quantity, deadline })
      });
      tg.showAlert('Заказ создан. Рабочие уведомлены.');
      form.reset();
      await loadOrders();
    } catch (err) {
      tg.showAlert(err.message);
    }
  });
}

async function init() {
  try {
    const me = await api(`/api/me?telegram_id=${telegramId}`);
    if (me.role !== 'manager') {
      elNot.classList.remove('hidden');
      return;
    }
    elManager.classList.remove('hidden');
    setupForm();
    await loadOrders();
    setInterval(loadOrders, 5000);
  } catch (e) {
    elNot.classList.remove('hidden');
  }
}

init();