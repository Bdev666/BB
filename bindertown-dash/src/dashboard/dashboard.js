/* global dash */
const STATUS_TEXT = {
  closed: 'ยังไม่เปิด', loading: 'กำลังโหลด', online: 'ออนไลน์', disconnected: 'หลุด',
  maintenance: 'ปิดปรับปรุง', crashed: 'หน้าเกมหยุดทำงาน', offline: 'โหลดเกมไม่ได้',
};
const ALERT_TEXT = {
  disconnect: 'หลุดจากเซิร์ฟเวอร์', idle: 'ไม่มีข้อมูลจากเกม · AUTO อาจหยุด',
  crash: 'หน้าเกมค้าง/หยุดทำงาน', maintenance: 'เกมปิดปรับปรุง',
};

const $ = (sel) => document.querySelector(sel);
let state = null;
let editing = false; // don't redraw cards while renaming

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

const fmt = (n) => (typeof n === 'number' ? Math.round(n).toLocaleString('th-TH') : '-');

function fill(pct) {
  const i = document.createElement('i');
  i.style.width = `${pct}%`; // CSSOM, allowed by the page's CSP
  return i;
}

function bar(kind, label, cur, max) {
  if (typeof cur !== 'number') return null;
  const pct = typeof max === 'number' && max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : null;
  return el('div', {},
    el('div', { class: 'barlabel' }, el('span', {}, label), el('span', {}, max ? `${fmt(cur)} / ${fmt(max)}` : fmt(cur))),
    pct === null ? null : el('div', { class: `bar ${kind}` }, fill(pct)));
}

function timeToLevel(a) {
  const s = a.stats;
  if (!a.expPerHour || typeof s.exp !== 'number' || typeof s.maxExp !== 'number') return null;
  const hours = (s.maxExp - s.exp) / a.expPerHour;
  if (!(hours >= 0) || hours > 999) return null;
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  return `อัปเลเวลในอีก ~${h} ชม. ${m} นาที`;
}

function card(a) {
  const s = a.stats || {};
  const open = a.status !== 'closed';
  const hasStats = Object.keys(s).length > 0;
  const name = el('span', { class: 'name', title: 'ดับเบิลคลิกเพื่อเปลี่ยนชื่อ' }, a.name);
  name.addEventListener('dblclick', () => {
    const input = el('input', { class: 'rename', value: a.name, maxlength: '40' });
    const done = (save) => {
      if (save && input.value.trim()) dash.invoke('rename', a.id, input.value);
      editing = false;
      render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
    editing = true;
    name.replaceWith(input);
    input.focus();
    input.select();
  });

  const buttons = [];
  if (!open) {
    buttons.push(el('button', { class: 'primary', onclick: async () => {
      const r = await dash.invoke('open', a.id);
      if (r && r.warnFreeLimit) showBanner('เปิดเกิน 3 ตัวแล้ว: ตรวจกฎของเกมเรื่องจำนวนตัวละครต่อ IP ด้วย');
    } }, 'เปิด'));
  } else {
    buttons.push(a.hidden
      ? el('button', { onclick: () => dash.invoke('show', a.id) }, 'ไปที่เกม')
      : el('button', { onclick: () => dash.invoke('hide', a.id) }, 'ซ่อนเกม'));
    buttons.push(el('button', { class: 'danger', onclick: () => {
      if (confirm(`ปิดเกมของ ${a.name}? ตัวละครจะออกจากเกม`)) dash.invoke('close', a.id);
    } }, 'ปิดเกม'));
  }
  buttons.push(el('button', { class: 'danger', onclick: () => {
    if (confirm(`ลบ ${a.name} ออกจากรายการ? การล็อกอินของบัญชีนี้จะถูกลบด้วย`)) dash.invoke('remove', a.id);
  } }, 'ลบ'));

  const ago = a.lastMsgAgo != null && open ? ` · ข้อมูลล่าสุด ${a.lastMsgAgo} วิ.ที่แล้ว` : '';
  return el('div', { class: 'card' + (a.alerts.length ? ' alert' : '') },
    el('div', { class: 'card-head' }, el('span', { class: `dot ${a.status}` }), name,
      el('span', { class: 'status' }, (STATUS_TEXT[a.status] || a.status) + ago)),
    (s.name || s.level || s.map)
      ? el('div', { class: 'char' }, [s.name, s.level != null ? `Lv.${s.level}` : null, s.map].filter(Boolean).join(' · '))
      : null,
    hasStats ? [
      bar('hp', 'HP', s.hp, s.maxHp),
      bar('sp', 'SP', s.sp, s.maxSp),
      bar('exp', 'EXP', s.exp, s.maxExp),
      el('div', { class: 'barlabel' },
        el('span', {}, a.expPerHour ? `EXP/ชม. ${fmt(a.expPerHour)}` : ''),
        el('span', {}, timeToLevel(a) || '')),
      typeof s.gold === 'number' ? el('div', { class: 'barlabel' }, el('span', {}, `Gold ${fmt(s.gold)}`)) : null,
    ] : (open ? el('div', { class: 'empty-stats' }, 'ยังอ่านค่าตัวละครไม่ได้ (ยังไม่ได้แมปข้อมูลเกม)') : null),
    a.alerts.length ? el('ul', { class: 'alerts' }, a.alerts.map((k) => el('li', {}, '⚠ ' + (ALERT_TEXT[k] || k)))) : null,
    el('div', { class: 'buttons' }, buttons));
}

function render() {
  if (!state || editing) return;
  $('#cards').replaceChildren(...state.accounts.map(card));
  $('#add').disabled = state.accounts.length >= state.maxAccounts;

  const st = state.settings;
  if (document.activeElement?.tagName !== 'INPUT') {
    for (const box of document.querySelectorAll('[data-notify]')) box.checked = !!st.notify[box.dataset.notify];
    $('#idleMinutes').value = st.idleMinutes;
    $('#disconnectSeconds').value = st.disconnectSeconds;
    $('#debugCapture').checked = !!st.debugCapture;
  }
  $('#tg-on').hidden = !st.telegram.connected;
  $('#tg-off').hidden = st.telegram.connected;
}

function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => { b.hidden = true; }, 10000);
}

$('#add').addEventListener('click', async () => {
  const id = await dash.invoke('add');
  if (id === false) showBanner('เพิ่มได้สูงสุด 10 บัญชี');
});
$('#toggle-settings').addEventListener('click', () => { $('#settings').hidden = !$('#settings').hidden; });
for (const box of document.querySelectorAll('[data-notify]')) {
  box.addEventListener('change', () => dash.invoke('settings', { notify: { [box.dataset.notify]: box.checked } }));
}
$('#idleMinutes').addEventListener('change', (e) => dash.invoke('settings', { idleMinutes: e.target.value }));
$('#disconnectSeconds').addEventListener('change', (e) => dash.invoke('settings', { disconnectSeconds: e.target.value }));
$('#debugCapture').addEventListener('change', (e) => dash.invoke('settings', { debugCapture: e.target.checked }));
$('#open-captures').addEventListener('click', () => dash.invoke('open-captures'));
$('#test-notify').addEventListener('click', () => dash.invoke('test-notify'));
$('#tg-connect').addEventListener('click', async () => {
  $('#tg-msg').textContent = 'กำลังเชื่อมต่อ...';
  const r = await dash.invoke('telegram-connect', $('#tg-token').value);
  $('#tg-msg').textContent = r.ok ? 'เชื่อมต่อแล้ว บอทส่งข้อความทักทายไปแล้ว' : r.error;
  if (r.ok) $('#tg-token').value = '';
});
$('#tg-disconnect').addEventListener('click', () => dash.invoke('telegram-disconnect'));

dash.onState((s) => { state = s; render(); });
dash.invoke('state').then((s) => { state = s; render(); });
setInterval(() => dash.invoke('state').then((s) => { state = s; render(); }), 5000);
