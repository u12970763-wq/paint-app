const tg = window.Telegram?.WebApp;
if (!tg) { alert('Откройте внутри Telegram'); throw new Error('No Telegram WebApp'); }
tg.expand();

const user = tg.initDataUnsafe?.user;
if (!user?.id) { tg.showAlert('Нет Telegram ID'); throw new Error('No user'); }
const tid = user.id.toString();

const elApp = document.getElementById('app');
const elNo = document.getElementById('noaccess');
const elItems = document.getElementById('items');

async function api(url, options){
  const res = await fetch(url, options);
  const data = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

function addRow(init = {product:'', color:'', quantity:''}){
  const wrap = document.createElement('div');
  wrap.className = 'item-row';
  wrap.innerHTML = `
    <div class="item-grid">
      <div>
        <label>Продукт</label>
        <input class="p" placeholder="Festek ... / PlasterSil ..." value="${init.product || ''}">
      </div>
      <div>
        <label>Цвет</label>
        <input class="c" placeholder="RAL 9003" value="${init.color || ''}">
      </div>
      <div>
        <label>Количество (кг)</label>
        <input class="q" type="number" step="0.1" min="0.1" value="${init.quantity || ''}">
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-danger del">Удалить</button>
    </div>
  `;
  wrap.querySelector('.del').onclick = (e)=>{ e.preventDefault(); wrap.remove(); };
  elItems.appendChild(wrap);
}

function collectItems(){
  const rows = [...document.querySelectorAll('.item-row')];
  return rows.map(r => ({
    product: r.querySelector('.p').value.trim(),
    color: r.querySelector('.c').value.trim(),
    quantity: parseFloat(r.querySelector('.q').value)
  })).filter(it => it.product && it.color && Number.isFinite(it.quantity) && it.quantity > 0);
}

async function init(){
  try{
    const me = await api(`/api/me?telegram_id=${tid}`);
    if (!['manager','director'].includes(me.role)){
      elNo.classList.remove('hidden');
      return;
    }
    elApp.classList.remove('hidden');

    addRow();

    document.getElementById('add').onclick = (e)=>{ e.preventDefault(); addRow(); };

    document.getElementById('submit').onclick = async (e)=>{
      e.preventDefault();
      const urgent = document.getElementById('urgent').checked;
      const deadline = document.getElementById('deadline').value || null;
      const items = collectItems();

      if (!items.length) return tg.showAlert('Добавьте хотя бы одну строку (продукт/цвет/кг).');

      try{
        await api(`/api/orders?telegram_id=${tid}`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ urgent, deadline, items })
        });
        tg.showAlert('✅ Заявка создана');
        window.location.href = '/';
      }catch(err){
        tg.showAlert(err.message);
      }
    };
  }catch{
    elNo.classList.remove('hidden');
  }
}

init();
