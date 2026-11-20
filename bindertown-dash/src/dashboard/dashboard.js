/* global dash */
const STATUS_TEXT = {
  closed: 'ยังไม่เปิด', loading: 'กำลังโหลด', online: 'ออนไลน์', disconnected: 'หลุด', demo: 'ตัวอย่าง',
  maintenance: 'ปิดปรับปรุง', crashed: 'หน้าเกมหยุดทำงาน', offline: 'โหลดเกมไม่ได้',
};
const ALERT_TEXT = {
  disconnect: 'หลุดจากเซิร์ฟเวอร์', idle: 'ไม่มีข้อมูลจากเกม · AUTO อาจหยุด',
  crash: 'หน้าเกมค้าง/หยุดทำงาน', maintenance: 'เกมปิดปรับปรุง',
};
const EV_KINDS = [
  ['hit', 'โจมตี', 'var(--c-hit)', '⚔'], ['hurt', 'โดนตี', 'var(--c-hurt)', '🛡'],
  ['loot', 'เก็บของ', 'var(--c-loot)', '✦'], ['exp', 'EXP', 'var(--c-exp)', '★'], ['other', 'อื่น ๆ', 'var(--c-other)', 'ⓘ'],
];
const CHAT_CH = [
  ['world', 'โลก', 'var(--ch-world)'], ['party', 'ปาร์ตี้', 'var(--ch-party)'], ['guild', 'กิลด์', 'var(--ch-guild)'],
  ['whisper', 'กระซิบ', 'var(--ch-whisper)'], ['map', 'แมพ', 'var(--ch-map)'], ['trade', 'เทรด', 'var(--ch-trade)'],
  ['system', 'ระบบ', 'var(--ch-system)'],
];

const $ = (sel) => document.querySelector(sel);
let state = null;
let detail = null;
let selected = null;
let editing = false;
let evFilter = 'all';
let chatFilter = 'all';

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');
function short(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return num(n);
}
const signed = (n) => (typeof n === 'number' ? (n >= 0 ? '+' : '') + short(n) : '-');
const pct = (cur, max) => (typeof cur === 'number' && max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0);
function dur(ms) {
  if (!(ms >= 0)) return '-';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
const hhmmss = (t) => new Date(t).toLocaleTimeString('en-GB');
function setWidth(node, p) { node.style.width = p + '%'; }
function miniBar(kind, p) { const i = document.createElement('i'); setWidth(i, p); return el('div', { class: 'mini ' + kind }, i); }
function color(node, c) { node.style.setProperty('--cc', c); return node; }
// Rebuild a container only when what it shows changed, so clicks aren't lost
// to an element being replaced between mousedown and mouseup.
function rebuild(container, key, build) {
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  container.replaceChildren(...build());
}

// ---------- account list ----------
function accountCard(a) {
  const s = a.summary || {};
  const open = a.status !== 'closed';
  const name = el('span', { class: 'acc-name', title: 'ดับเบิลคลิกเพื่อเปลี่ยนชื่อ' }, s.name ? `${a.name} · ${s.name}` : a.name);
  name.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(a, name); });
  return el('div', {
    class: 'acc' + (a.id === selected ? ' sel' : '') + (a.alerts.length ? ' alert' : ''),
    'data-id': a.id,
  },
  el('div', { class: 'acc-top' }, el('span', { class: 'dot ' + a.status }), name),
  el('div', { class: 'acc-meta' },
    el('span', {}, s.level != null ? `Lv.${s.level}` : STATUS_TEXT[a.status] || a.status, a.memoryMB ? ` · ${num(a.memoryMB)} MB` : ''),
    open && s.expPerHour ? el('span', { class: 'pos' }, `${short(s.expPerHour)}/ชม.`) : null),
  open && s.maxHp ? [miniBar('hp', pct(s.hp, s.maxHp)), miniBar('sp', pct(s.sp, s.maxSp)), miniBar('exp', pct(s.exp, s.maxExp))] : null,
  a.alerts.length ? el('div', { class: 'acc-alert' }, '⚠ ' + a.alerts.map((k) => ALERT_TEXT[k] || k).join(' · ')) : null);
}

function startRename(a, node) {
  const input = el('input', { class: 'rename', value: a.name, maxlength: '40' });
  const done = (save) => {
    if (!editing) return;
    editing = false;
    if (save && input.value.trim()) dash.invoke('rename', a.id, input.value);
    render();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  editing = true;
  node.replaceWith(input);
  input.focus();
  input.select();
}

// ---------- detail ----------
function profileButtons(a) {
  const b = [];
  if (a.status === 'closed' || a.status === 'demo') {
    b.push(el('button', { class: 'primary', title: 'เปิดหน้าต่างเกมของบัญชีนี้', onclick: async () => {
      const r = await dash.invoke('open', a.id);
      if (r && r.warnFreeLimit) showBanner('เปิดเกิน 3 ตัวแล้ว: ตรวจกฎของเกมเรื่องจำนวนตัวละครต่อ IP ด้วย');
    } }, 'เปิดเกม'));
  } else {
    b.push(el('button', { title: 'โหลดหน้าเกมใหม่ (เหมือน Ctrl+R) ตอนเกมค้าง', onclick: () => dash.invoke('reload', a.id) }, '⟳ รีเฟรช'));
    b.push(a.hidden
      ? el('button', { title: 'ไปที่หน้าต่างเกมของบัญชีนี้', onclick: () => dash.invoke('show', a.id) }, '⧉ ไปที่เกม')
      : el('button', { title: 'ซ่อนแล้วเกมยังเล่นต่อ เรียกกลับได้ที่นี่ หรือที่ไอคอน BinderDash มุมขวาล่าง', onclick: () => dash.invoke('hide', a.id) }, '◌ ซ่อนเกม'));
    b.push(el('button', { class: 'danger', title: 'ตัวละครออกจากเกม Auto Play หยุด (บัญชียังอยู่ในรายการ)', onclick: () => {
      if (confirm(`ปิดเกมของ ${a.name}? ตัวละครจะออกจากเกม`)) dash.invoke('close', a.id);
    } }, '✕ ปิดเกม'));
  }
  b.push(el('button', { class: 'danger', title: 'ลบบัญชีออกจากรายการ', onclick: () => {
    if (confirm(`ลบ ${a.name} ออกจากรายการ? การล็อกอินของบัญชีนี้จะถูกลบด้วย`)) { dash.invoke('remove', a.id); selected = null; }
  } }, 'ลบ'));
  return b;
}

function renderProfile(a) {
  const d = detail || { stats: {}, rates: {}, buffs: [] };
  const s = d.stats || {};
  const r = d.rates || {};
  $('#d-avatar').textContent = (s.name || a.name || '?').slice(0, 1).toUpperCase();
  $('#d-name').textContent = s.name || a.name;
  const badge = $('#d-status');
  badge.className = 'badge ' + a.status;
  badge.textContent = STATUS_TEXT[a.status] || a.status;
  const sub = $('#d-sub');
  sub.replaceChildren(...[
    s.job ? s.job : null,
    s.level != null ? ` · Lv.${s.level}` : null,
    s.jobLevel != null ? el('span', {}, '  Job ', el('b', {}, String(s.jobLevel))) : null,
    s.silver != null ? el('span', {}, '  Silver ', el('b', {}, short(s.silver))) : null,
    s.gold != null ? el('span', {}, '  Gold ', el('b', {}, num(s.gold))) : null,
    s.name ? null : a.status === 'closed' ? 'กด "เปิดเกม" เพื่อเริ่ม' : 'ยังอ่านข้อมูลตัวละครไม่ได้',
  ].filter(Boolean));
  rebuild($('#d-buttons'), `${a.id}:${a.status}:${a.hidden}`, () => profileButtons(a));

  setWidth($('#d-hp'), pct(s.hp, s.maxHp));
  setWidth($('#d-sp'), pct(s.sp, s.maxSp));
  setWidth($('#d-exp'), pct(s.exp, s.maxExp));
  $('#d-hp-t').textContent = s.maxHp ? `${num(s.hp)} / ${num(s.maxHp)}` : '';
  $('#d-sp-t').textContent = s.maxSp ? `${num(s.sp)} / ${num(s.maxSp)}` : '';
  $('#d-exp-t').textContent = s.maxExp ? pct(s.exp, s.maxExp).toFixed(2) + '%' : '';
  let eta = '';
  if (s.maxExp && typeof s.exp === 'number') {
    const left = s.maxExp - s.exp;
    eta = `Lv.${(s.level || 0) + 1}`;
    if (r.expPerHour > 0) eta += ` อีก ~${dur((left / r.expPerHour) * 3600000)}`;
    eta += ` · ขาด ${short(left)}`;
  }
  $('#d-exp-eta').textContent = eta;

  const attrs = ['str', 'agi', 'vit', 'int', 'dex', 'luk'].filter((k) => s[k] != null);
  $('#d-attrs').replaceChildren(...attrs.map((k) => el('div', { class: 'attr' }, el('span', {}, k.toUpperCase()), el('b', {}, String(s[k])))));
  const now = Date.now();
  $('#d-buffs').replaceChildren(...(d.buffs || []).map((b) => el('div', { class: 'buff' }, b.name,
    b.until ? el('small', {}, dur(b.until - now)) : b.stacks ? el('small', {}, '×' + b.stacks) : null)));

  const tiles = [
    ['เวลาเล่น', dur(r.playMs)], ['ดาเมจ/วิ ตอนนี้', short(r.dpsNow)], ['ดาเมจเฉลี่ย/ครั้ง', short(r.avgHit)],
    ['EXP/ชม.', short(r.expPerHour)], ['Kill/ชม.', short(r.killsPerHour)], ['Silver/ชม.', short(r.silverPerHour), 'pos'],
  ];
  $('#d-tiles').replaceChildren(...tiles.map(([l, v, c]) => el('div', { class: 'tile' + (c ? ' ' + c : '') }, el('span', {}, l), el('b', {}, v))));
}

function chips(container, list, current, onPick) {
  if (container.dataset.key === current) return;
  container.dataset.key = current;
  const all = el('button', { class: 'chip all' + (current === 'all' ? ' on' : ''), onclick: () => onPick('all') }, 'ทั้งหมด');
  container.replaceChildren(all, ...list.map(([k, label, c]) =>
    color(el('button', { class: 'chip' + (current === k ? ' on' : ''), onclick: () => onPick(k) }, label), c)));
}

function fillLines(box, rows) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const key = rows.length + ':' + (rows.length ? rows[rows.length - 1].t : 0) + ':' + evFilter + chatFilter;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...(rows.length ? rows.map((r) => r.node) : [el('div', { class: 'empty' }, 'ยังไม่มีข้อมูล')]));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  const d = detail || { events: [], chat: [] };
  chips($('#ev-chips'), EV_KINDS, evFilter, (k) => { evFilter = k; renderLogs(); });
  chips($('#chat-chips'), CHAT_CH, chatFilter, (k) => { chatFilter = k; renderLogs(); });
  const kinds = Object.fromEntries(EV_KINDS.map((k) => [k[0], k]));
  fillLines($('#ev-lines'), d.events.filter((e) => evFilter === 'all' || e.kind === evFilter).map((e) => {
    const k = kinds[e.kind] || kinds.other;
    return { t: e.t, node: color(el('div', { class: 'line' }, el('time', {}, hhmmss(e.t)), el('span', { class: 'k' }, k[3]), el('span', {}, e.text)), k[2]) };
  }));
  const chans = Object.fromEntries(CHAT_CH.map((c) => [c[0], c]));
  fillLines($('#chat-lines'), d.chat.filter((c) => chatFilter === 'all' || c.channel === chatFilter).map((c) => {
    const ch = chans[c.channel] || ['', c.channel, 'var(--muted)'];
    return { t: c.t, node: color(el('div', { class: 'line' }, el('time', {}, hhmmss(c.t)),
      el('span', { class: 'from' }, ch[1]),
      el('span', {}, c.guild ? el('span', { class: 'guild' }, `[${c.guild}] `) : null, c.from ? el('b', {}, c.from + ': ') : null, c.text)), ch[2]) };
  }));
}

const MAP_IMG = 'https://wiki.bindertowngame.com/img/gen/map/';
const KIND_TEXT = { town: 'เมือง', boss: 'ถ้ำ Field Boss', special: 'แมพพิเศษ' };
function findMap(name) {
  if (!name || !window.BT_MAPS) return null;
  const key = String(name).toLowerCase().replace(/\s*lv.*$/, '').trim();
  return window.BT_MAPS.find((m) => m.id === key || m.name.toLowerCase() === key || m.id === key.replace(/[^a-z0-9]+/g, '_')) || null;
}

function renderMap() {
  const d = detail || {};
  const w = d.world;
  const name = d.stats && d.stats.map;
  const info = findMap(name);
  $('#d-map').textContent = info ? info.name : name || 'แผนที่';
  $('#d-map-sub').textContent = info
    ? [info.region.replace(/^Region [A-Z] · /, ''), info.min != null ? `Lv.${info.min}–${info.max}` : KIND_TEXT[info.kind]].filter(Boolean).join(' · ')
    : '';
  const img = $('#map-bg');
  const src = info ? MAP_IMG + info.id + '.webp' : '';
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.hidden = true;
    if (src) { img.onload = () => { img.hidden = false; }; img.onerror = () => { img.hidden = true; }; img.src = src; }
  }
  const cv = $('#minimap');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  $('#c-mon').textContent = w && w.monsters ? w.monsters.length : 0;
  $('#c-ply').textContent = w && w.players ? w.players.length : 0;
  $('#c-drop').textContent = w && w.drops ? w.drops.length : 0;
  if (!w) {
    if (src) return;
    ctx.fillStyle = '#8f89ad';
    ctx.font = '13px Segoe UI, Tahoma';
    ctx.textAlign = 'center';
    ctx.fillText('ยังไม่มีข้อมูลแผนที่', cv.width / 2, cv.height / 2);
    return;
  }
  const sx = cv.width / (w.w || 1), sy = cv.height / (w.h || 1);
  const dot = (p, r, c) => { ctx.beginPath(); ctx.arc(p.x * sx, p.y * sy, r, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); };
  for (const p of w.drops || []) dot(p, 3, '#ffc233');
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffffaa';
  for (const p of w.monsters || []) { dot(p, 4, '#ff4d6d'); ctx.stroke(); }
  for (const p of w.players || []) { dot(p, 4, '#38bdf8'); ctx.stroke(); }
  if (w.self) { dot(w.self, 9, '#ffb54766'); dot(w.self, 5.5, '#ffffff'); ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 2.5; ctx.stroke(); }
}

let watchEditing = null; // item name whose limit is being edited
function renderBag() {
  if (watchEditing) return;
  const watch = (state && state.settings.itemWatch) || {};
  const items = ((detail && detail.bag) || []).slice().sort((a, b) => b.qty - a.qty);
  $('#bag').replaceChildren(...(items.length ? items.map((it) => {
    const limit = watch[it.name];
    const low = limit != null && it.qty < limit;
    const row = el('div', { class: 'item' + (low ? ' low' : ''), title: 'กดเพื่อตั้งเตือนใกล้หมด' },
      el('div', { class: 'ic' }, it.name.slice(0, 1)),
      el('div', { class: 'nm' }, it.name, el('small', {},
        [limit != null ? `เตือนเมื่อ < ${num(limit)}` : null,
          it.usedPerHour > 0 ? `ใช้ ${short(it.usedPerHour)}/ชม.` : null,
          it.gainedPerHour > 0 ? `เก็บได้ ${short(it.gainedPerHour)}/ชม.` : null]
          .filter(Boolean).join(' · ') || ' ')),
      el('div', { class: 'q' }, num(it.qty)));
    row.addEventListener('click', () => editWatch(row, it.name, limit));
    return row;
  }) : [el('div', { class: 'empty' }, 'ยังไม่มีข้อมูลกระเป๋า')]));
}

function editWatch(row, name, limit) {
  watchEditing = name;
  const input = el('input', { type: 'number', min: '0', class: 'watch', placeholder: 'จำนวน', value: limit != null ? String(limit) : '' });
  const done = (save) => {
    if (!watchEditing) return;
    watchEditing = null;
    if (save) dash.invoke('item-watch', name, input.value === '' || input.value === '0' ? null : input.value);
    renderBag();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
  row.lastChild.replaceWith(el('div', { class: 'q' }, el('small', { class: 'hint' }, 'เตือนเมื่อน้อยกว่า '), input));
  input.focus();
  input.select();
}

// ---------- top level ----------
function render() {
  if (!state || editing) return;
  if (!state.accounts.some((a) => a.id === selected)) selected = state.accounts.length ? state.accounts[0].id : null;
  $('#accounts').replaceChildren(...state.accounts.map(accountCard));
  $('#add').disabled = state.accounts.length >= state.maxAccounts;

  const live = state.accounts.filter((a) => a.status === 'online' || a.status === 'demo');
  $('#k-online').textContent = `${live.length} / ${state.accounts.length}`;
  const sum = (f) => live.reduce((t, a) => t + (typeof a.summary[f] === 'number' ? a.summary[f] : 0), 0);
  $('#k-silver').textContent = live.length ? num(sum('silver')) : '-';
  $('#k-silver-run').textContent = live.length ? signed(sum('silverToday')) : '-';

  const a = state.accounts.find((x) => x.id === selected);
  $('#detail').hidden = !a;
  if (a) {
    renderProfile(a);
    renderLogs();
    renderMap();
    renderBag();
  }

}

async function refreshDetail() {
  if (selected == null) { detail = null; return; }
  const id = selected;
  const d = await dash.invoke('detail', id);
  if (id === selected) { detail = d; render(); }
}

function showBanner(text) {
  const b = $('#banner');
  b.textContent = text;
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => { b.hidden = true; }, 10000);
}

// select an account on pointerdown (cards are redrawn often)
$('#accounts').addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.acc');
  if (!card || e.target.tagName === 'INPUT') return;
  const id = Number(card.dataset.id);
  if (id !== selected) { selected = id; detail = null; render(); refreshDetail(); }
});
$('#add').addEventListener('click', async () => {
  const id = await dash.invoke('add');
  if (id === false) showBanner('เพิ่มได้สูงสุด 10 บัญชี');
  else { selected = id; refreshDetail(); }
});
$('#toggle-all').addEventListener('click', () => dash.invoke('toggle-all'));
$('#toggle-settings').addEventListener('click', () => dash.invoke('open-settings'));

dash.onState((s) => { state = s; render(); });
dash.invoke('state').then((s) => { state = s; render(); refreshDetail(); });
setInterval(refreshDetail, 1000);
