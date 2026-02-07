const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const tid = user.id.toString();

const elApp = document.getElementById('app');
const elNo = document.getElementById('noaccess');
const elList = document.getElementById('list');

let mode = 'urgent';

async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function badgeClass(status){
  return ({ new:'b-new', in_progress:'b-progress', completed:'b-done', archived:'b-arch' })[status] || 'b-new';
}
function statusRu(status){
  return ({new:'Новые',in_progress:'В работе',completed:'Готово',archived:'Архив'})[status] || status;
}

function esc(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

function itemsHtml(items){
  if (!items?.length) return '';
  const lines = items.slice(0,3).map(it => `<div class="li">• ${esc(it.product)} <span class="dim">|</span> ${esc(it.color)} <span class="dim">|</span> <b>${it.quantity}</b> кг</div>`).join('');
  const more = items.length > 3 ? `<div class="dim">ещё ${items.length-3}...</div>` : '';
  return `<div class="items">${lines}${more}</div>`;
}

async function load(){
  let url;
  if (mode === 'urgent') url = `/api/orders?telegram_id=${tid}&urgent=1&status=all`;
  else url = `/api/orders?telegram_id=${tid}&status=${encodeURIComponent(mode)}`;

  const orders = await api(url);
  render(orders);
}

function render(orders){
  elList.innerHTML = orders.length ? '' : `<div class="card muted">Пусто</div>`;

  for (const o of orders){
    const urgent = o.urgent ? `<span class="pill pill-urgent">🔥 Срочно</span>` : '';
    const worker = o.worker_name ? `<span class="pill pill-worker">👷 ${esc(o.worker_name)}</span>` : '';
    const deadline = o.deadline ? `<span class="pill pill-deadline">⏱ ${new Date(o.deadline).toLocaleString()}</span>` : '';

    const card = document.createElement('div');
    card.className = 'card order';

    card.innerHTML = `
      <div class="row">
        <div class="order-title">#${o.id}</div>
        <span class="badge ${badgeClass(o.status)}">${statusRu(o.status)}</span>
      </div>

      <div class="pills">${urgent}${worker}${deadline}</div>
      ${itemsHtml(o.items)}
      <div class="actions" id="a-${o.id}"></div>
    `;

    const a = card.querySelector(`#a-${o.id}`);

    if (o.status === 'completed'){
      a.appendChild(btn('🗂 В архив', async ()=>{
        await api(`/api/orders/${o.id}/archive?telegram_id=${tid}`, {method:'POST'});
        await load();
      }, 'btn'));
    }

    if (o.status === 'archived'){
      a.appendChild(btn('↩ Вернуть', async ()=>{
        await api(`/api/orders/${o.id}/unarchive?telegram_id=${tid}`, {method:'POST'});
        await load();
      }, 'btn'));
    }

    if (o.status !== 'archived'){
      a.appendChild(btn('✖ Отменить', async ()=>{
        const reason = prompt('Причина отмены (необязательно):') || '';
        await api(`/api/orders/${o.id}/cancel?telegram_id=${tid}`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({reason})
        });
        await load();
      }, 'btn btn-danger'));
    }

    elList.appendChild(card);
  }
}

function btn(text, onClick, cls){
  const b=document.createElement('button');
  b.className=cls;
  b.textContent=text;
  b.onclick=(e)=>{e.preventDefault(); onClick();};
  return b;
}

async function init(){
  try{
    const me = await api(`/api/me?telegram_id=${tid}`);
    if (!['manager','director'].includes(me.role)){
      elNo.classList.remove('hidden');
      return;
    }
    elApp.classList.remove('hidden');

    document.querySelectorAll('.tab').forEach(t=>{
      t.onclick=async ()=>{
        document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        mode = t.dataset.mode;
        await load();
      };
    });

    await load();
    setInterval(load, 10000);
  }catch{
    elNo.classList.remove('hidden');
  }
}

init();
