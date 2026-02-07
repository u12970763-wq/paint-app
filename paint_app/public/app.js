const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const telegramId = user.id.toString();

const elManager = document.getElementById('manager');
const elNot = document.getElementById('not-manager');
const elList = document.getElementById('list');

let currentStatus = 'new';

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function statusText(s) {
  return ({
    new: 'Новые',
    in_progress: 'В работе',
    completed: 'Готово',
    archived: 'Архив',
    canceled: 'Отменено'
  })[s] || s;
}

function badgeClass(s) {
  return ({
    new: 'b-new',
    in_progress: 'b-progress',
    completed: 'b-done',
    archived: 'b-arch',
    canceled: 'b-cancel'
  })[s] || 'b-new';
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return ''; }
}

async function loadOrders() {
  const orders = await api(`/api/orders?telegram_id=${telegramId}&status=${encodeURIComponent(currentStatus)}`);
  render(orders);
}

function render(orders) {
  elList.innerHTML = orders.length ? '' : `<div class="card muted">Пусто</div>`;

  for (const o of orders) {
    const card = document.createElement('div');
    card.className = 'card order';

    card.innerHTML = `
      <div class="row">
        <div class="order-title">#${o.id} — ${o.product}</div>
        <span class="badge ${badgeClass(o.status)}">${statusText(o.status)}</span>
      </div>

      <div class="grid">
        <div><span class="k">Цвет:</span> ${o.color}</div>
        <div><span class="k">Кол-во:</span> ${o.quantity} л</div>
        ${o.deadline ? `<div><span class="k">Срок:</span> ${formatDate(o.deadline)}</div>` : ''}
        <div><span class="k">Создана:</span> ${formatDate(o.created_at)}</div>
        ${o.worker_name ? `<div><span class="k">Рабочий:</span> ${o.worker_name}</div>` : (o.worker_tid ? `<div><span class="k">Рабочий:</span> ${o.worker_tid}</div>` : '')}
        ${o.cancel_reason ? `<div class="full"><span class="k">Причина отмены:</span> ${o.cancel_reason}</div>` : ''}
      </div>

      <div class="actions" id="actions-${o.id}"></div>
    `;

    const actions = card.querySelector(`#actions-${o.id}`);

    if (o.status === 'completed') {
      actions.appendChild(btn('🗂 В архив', async () => {
        await api(`/api/orders/${o.id}/archive?telegram_id=${telegramId}`, { method: 'POST' });
        await loadOrders();
      }, 'btn'));
    }

    if (o.status === 'archived') {
      actions.appendChild(btn('↩ Вернуть', async () => {
        await api(`/api/orders/${o.id}/unarchive?telegram_id=${telegramId}`, { method: 'POST' });
        await loadOrders();
      }, 'btn'));
    }

    if (o.status !== 'canceled') {
      actions.appendChild(btn('✖ Отменить', async () => {
        const reason = prompt('Причина отмены (необязательно):') || '';
        await api(`/api/orders/${o.id}/cancel?telegram_id=${telegramId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });
        await loadOrders();
      }, 'btn btn-danger'));
    }

    elList.appendChild(card);
  }
}

function btn(text, onClick, cls) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.onclick = (e) => { e.preventDefault(); onClick(); };
  return b;
}

async function init() {
  try {
    const me = await api(`/api/me?telegram_id=${telegramId}`);
    if (!['manager','director'].includes(me.role)) {
      elNot.classList.remove('hidden');
      return;
    }

    elManager.classList.remove('hidden');

    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = async () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        currentStatus = t.dataset.status;
        await loadOrders();
      };
    });

    await loadOrders();
    setInterval(loadOrders, 10000);
  } catch {
    elNot.classList.remove('hidden');
  }
}

init();
