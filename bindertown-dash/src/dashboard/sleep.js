// sleep view: every account at a glance.
// Loaded before dashboard.js: only declarations here; they run when dashboard.js calls them.

let sleepOn = false; let sleepClock = null;

function renderSleep() {
  const now = new Date();
  $('#sl-clock').textContent = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const accs = ((state && state.accounts) || []).filter((a) => a.status === 'online' || a.status === 'reconnecting' || a.status === 'disconnected');
  $('#sl-sub').textContent = accs.length ? `${accs.length} บัญชีกำลังเล่น · เกมยังเล่นต่อระหว่างพักจอ` : 'ยังไม่มีบัญชีที่เปิดเกมอยู่';
  const grid = $('#sl-grid');
  const cards = accs.map((a) => {
    const s = a.summary || {}; const S = s.session || {};
    const hrs = Math.max(1 / 60, (s.playMs || 0) / 3600000);
    const ph = (v) => (v && s.playMs > 120000 ? ` (${num(Math.round(v / hrs))}/ชม.)` : '');
    const warn = [];
    if (a.status !== 'online') warn.push('ขาดการเชื่อมต่อ · กำลังต่อใหม่');
    if (s.dead) warn.push('ตัวละครตาย');
    else if (s.maxHp && s.hp / s.maxHp < 0.3) warn.push('HP ต่ำ');
    if (typeof s.weightPct === 'number' && s.weightPct >= 90) warn.push('กระเป๋า / น้ำหนักเต็ม');
    if (!s.auto && a.status === 'online' && !s.dead) warn.push('AUTO หยุด');
    for (const al of a.alerts || []) if (/^(potion|item)/.test(al)) { warn.push('ยาใกล้หมด'); break; }
    let card = grid.querySelector(`[data-acc="${a.id}"]`);
    if (!card) {
      card = el('div', { class: 'sl-card', 'data-acc': String(a.id) },
        el('div', { class: 'sl-name' }), el('div', { class: 'sl-map' }), el('div', { class: 'sl-auto' }),
        el('div', { class: 'sl-bar hp' }, el('i', {})), el('div', { class: 'sl-bar sp' }, el('i', {})),
        el('div', { class: 'sl-warn' }), el('div', { class: 'sl-sum' }, el('h4', {}), el('p', {}), el('p', {})));
      card.addEventListener('click', () => { setSleep(false); selectAccount(a.id); });
    }
    const set = (sel, t) => { const n = card.querySelector(sel); if (n.textContent !== t) n.textContent = t; };
    set('.sl-name', `${s.name || a.name}${s.level ? ' · Lv.' + s.level : ''}`);
    set('.sl-map', mapLabel(s.map));
    set('.sl-auto', s.dead ? '☠ ตาย' : s.auto ? `AUTO กำลังทำงาน${s.target ? ' · ' + s.target : ''}` : 'AUTO ปิดอยู่');
    card.querySelector('.sl-auto').className = 'sl-auto ' + (s.dead ? 'bad' : s.auto ? 'ok' : 'off');
    card.querySelector('.sl-bar.hp i').style.width = pct(s.hp, s.maxHp) + '%';
    card.querySelector('.sl-bar.sp i').style.width = pct(s.sp, s.maxSp) + '%';
    const w = card.querySelector('.sl-warn'); w.replaceChildren(...warn.map((x) => el('span', {}, x))); w.hidden = !warn.length;
    card.classList.toggle('alert', warn.length > 0);
    const lines = [`สรุปตั้งแต่เปิดเกม · ${dur(s.playMs || 0)}`,
      `ล้มมอน ${num(S.kills || 0)}${ph(S.kills)} · ตาย ${num(S.deaths || 0)} · เลเวลอัป ${num(S.levels || 0)} · ยาที่ใช้ ${num(S.potions || 0)}`,
      `EXP +${num(S.exp || 0)}${ph(S.exp)} · Job EXP +${num(S.job || 0)} · Gold ${S.gold == null ? '-' : (S.gold >= 0 ? '+' : '') + num(S.gold)}${S.gold ? ph(S.gold) : ''}`];
    card.querySelectorAll('.sl-sum > *').forEach((n, k) => { if (n.textContent !== lines[k]) n.textContent = lines[k]; });
    return card;
  });
  if (cards.length !== grid.children.length || cards.some((c, i) => grid.children[i] !== c)) grid.replaceChildren(...cards);
  grid.dataset.n = String(Math.min(cards.length, 4));
}

function mapLabel(id) { return id ? String(id).split('_').map((w) => w && w[0].toUpperCase() + w.slice(1)).join(' ') : '-'; }

function setSleep(on) {
  sleepOn = on; $('#sleep').hidden = !on; document.body.classList.toggle('sleeping-view', on);
  dash.invoke('sleep-mode', on);
  clearInterval(sleepClock);
  if (on) { renderSleep(); sleepClock = setInterval(renderSleep, 1000); }
}
