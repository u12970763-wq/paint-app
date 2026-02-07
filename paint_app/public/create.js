const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const telegramId = user.id.toString();

const elManager = document.getElementById('manager');
const elNot = document.getElementById('not-manager');

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

async function init() {
  try {
    const me = await api(`/api/me?telegram_id=${telegramId}`);
    if (!['manager','director'].includes(me.role)) {
      elNot.classList.remove('hidden');
      return;
    }

    elManager.classList.remove('hidden');

    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const product = document.getElementById('product').value.trim();
      const color = document.getElementById('color').value.trim();
      const quantity = parseFloat(document.getElementById('quantity').value);
      const deadline = document.getElementById('deadline').value || null;

      try {
        await api(`/api/orders?telegram_id=${telegramId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product, color, quantity, deadline })
        });

        tg.showAlert('✅ Создано');
        window.location.href = '/';
      } catch (err) {
        tg.showAlert(err.message);
      }
    });

  } catch {
    elNot.classList.remove('hidden');
  }
}

init();
