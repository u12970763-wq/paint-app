const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const tid = user.id.toString();

const elApp = document.getElementById('app');
const elNo = document.getElementById('noaccess');
const elList = document.getElementById('list');

let tab = 'urgent';

async function api(url, options){
  const res = await fetch(url, options);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function esc(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function statusRu(s){ return ({new:'Новые',in_progress:'В работе',completed:'Готово'})[s] || s; }
function badgeClass(s){ return ({new:'b-new',in_progress:'b-progress',completed:'b-done'})[s] || 'b-new'; }

function itemsHtml(items){
  if (!items?.length) return '';
  return `<div class="items">${items.map(it => `<div class="li">• ${esc(it.product)} <span class="dim">|</span> ${esc(it.color)} <span class="dim">|</span> <b>${it.quantity}</b> л</div>`).join('')}</div>`;
}

async function load(){
  const orders = await api(`/api/worker/orders?telegram_id=${tid}&tab=${encodeURIComponent(tab)}`);
  render(orders);
}

function render(orders){
  elList.innerHTML = orders.length ? '' : `<div class="card muted">Пусто</div>`;

  for (const o of orders){
    const urgent = o.urgent ? `<span class="pill pill-urgent">🔥 Срочно</span>` : '';
    const me = o.worker_tid === tid ? `<span class="pill pill-worker">👷 Это вы</span>` : '';
    const deadline = o.deadline ? `<span class="pill pill-deadline">⏱ ${new Date(o.deadline).toLocaleString()}</span>` : '';

    const card = document.createElement('div');
    card.className='card order';

    card.innerHTML = `
      <div class="row">
        <div class="order-title">#${o.id}</div>
        <span class="badge ${badgeClass(o.status)}">${statusRu(o.status)}</span>
      </div>
      <div class="pills">${urgent}${me}${deadline}</div>
      ${itemsHtml(o.items)}
      <div class="actions" id="a-${o.id}"></div>
    `;

    const a = card.querySelector(`#a-${o.id}`);

    if (o.status === 'new'){
      a.appendChild(btn('✅ Принять', ()=>doTake(o.id), 'btn'));
    }
    if (o.status === 'in_progress' && o.worker_tid === tid){
      a.appendChild(btn('🏁 Готово', ()=>doComplete(o.id), 'btn btn-primary'));
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

async function doTake(orderId){
  // Берём через бот? Мы делаем простой API? 
  // Для минимальных изменений используем Telegram callback не можем.
  // Поэтому сделаем через fetch на специальный endpoint worker action:
  await api(`/api/worker/take`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ telegram_id: tid, order_id: orderId })
  });
  await load();
}

async function doComplete(orderId){
  await api(`/api/worker/complete`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ telegram_id: tid, order_id: orderId })
  });
  await load();
}

async function init(){
  try{
    const me = await api(`/api/me?telegram_id=${tid}`);
    if (me.role !== 'worker'){
      elNo.classList.remove('hidden');
      return;
    }
    elApp.classList.remove('hidden');

    document.querySelectorAll('.tab').forEach(t=>{
      t.onclick=async ()=>{
        document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        tab = t.dataset.tab;
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
