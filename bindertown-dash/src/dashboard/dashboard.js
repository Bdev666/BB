/* global dash */
const STATUS_TEXT = {
  closed: 'ยังไม่เปิด', loading: 'กำลังโหลด', reconnecting: 'กำลังต่อใหม่…', lobby: 'ยังไม่เข้าเกม (ล็อกอิน/โหลด)', online: 'ออนไลน์', disconnected: 'หลุด', demo: 'ตัวอย่าง',
  maintenance: 'ปิดปรับปรุง', crashed: 'หน้าเกมหยุดทำงาน', offline: 'โหลดเกมไม่ได้',
};
const ALERT_TEXT = {
  disconnect: 'หลุดจากเซิร์ฟเวอร์', idle: 'ไม่มีข้อมูลจากเกม · AUTO อาจหยุด',
  crash: 'หน้าเกมค้าง/หยุดทำงาน', maintenance: 'เกมปิดปรับปรุง',
  death: 'ตัวละครตาย', weight: 'กระเป๋าใกล้เต็ม', weightFull: 'กระเป๋าเต็ม', premium: 'Premium ใกล้หมด',
  elsewhere: 'ถูกเปิดที่อื่น', staff: 'ถูกตัดโดยทีมงาน', login: 'ต้องล็อกอินใหม่', human: 'เกมขอยืนยันว่าเป็นคน',
  reconnectLimit: 'ต่อใหม่ครบโควตาชั่วโมงนี้',
};
const alertText = (k) => ALERT_TEXT[k] || (k.startsWith('potion:') ? `${k.slice(7)} ใกล้หมด` : k.startsWith('item:') ? `${k.slice(5)} เหลือน้อย` : k);
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
  container.replaceChildren(...build().flat().filter((n) => n != null && n !== false));
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
    title: 'คลิก = ดูบัญชีนี้ · ดับเบิลคลิก = ไปที่เกม · Ctrl+1–9 เลือกบัญชี',
  },
  el('div', { class: 'acc-top' }, el('span', { class: 'dot ' + a.status }), name),
  el('div', { class: 'acc-meta' },
    el('span', {}, s.level != null ? `Lv.${s.level}` : STATUS_TEXT[a.status] || a.status, a.memoryMB ? ` · ${num(a.memoryMB)} MB` : '', s.ping != null ? ` · ${s.ping} ms` : ''),
    open && s.rewards ? el('span', { class: 'gift', title: 'มีของรอรับ (Pass / จดหมาย)' }, `🎁 ${s.rewards}`) : null,
    open && s.expPerHour ? el('span', { class: 'pos' }, `${short(s.expPerHour)}/ชม.`) : null),
  open && s.maxHp ? [miniBar('hp', pct(s.hp, s.maxHp)), miniBar('sp', pct(s.sp, s.maxSp)), miniBar('exp', expPctOf(s))] : null,
  a.alerts.length ? el('div', { class: 'acc-alert' }, '⚠ ' + a.alerts.map(alertText).join(' · ')) : null,
  a.compat && !a.compat.ok ? el('div', { class: 'acc-alert' }, '⚠ อ่านข้อมูลเกมไม่ครบ (เกมอัปเดต)') : null);
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

// EXP % straight from the game's HUD when there, else exp / maxExp (demo)
function expPctOf(s) {
  if (typeof s.expPct === 'number') return Math.max(0, Math.min(100, s.expPct));
  return pct(s.exp, s.maxExp);
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
    d.net && d.net.ping != null ? el('span', { class: 'ping' }, `  ${d.net.ping} ms`) : null,
    d.premiumUntil > Date.now() ? el('span', { class: 'prem', title: 'Premium' }, `  ♛ ${dur(d.premiumUntil - Date.now())}`) : null,
    typeof s.weightPct === 'number' ? el('span', { class: s.weightPct >= 90 ? 'heavy' : '', title: 'น้ำหนักกระเป๋า' }, `  🎒 ${Math.round(s.weightPct)}%`) : null,
    s.name ? null : a.status === 'closed' ? 'กด "เปิดเกม" เพื่อเริ่ม' : 'ยังอ่านข้อมูลตัวละครไม่ได้',
  ].filter(Boolean));
  rebuild($('#d-buttons'), `${a.id}:${a.status}:${a.hidden}`, () => profileButtons(a));

  const ep = expPctOf(s);
  const hasExp = typeof s.expPct === 'number' || !!s.maxExp;
  setWidth($('#d-exp'), ep);
  setWidth($('#d-hp'), pct(s.hp, s.maxHp));
  setWidth($('#d-sp'), pct(s.sp, s.maxSp));
  $('#d-hp-t').textContent = s.maxHp ? `${num(s.hp)} / ${num(s.maxHp)}` : '';
  $('#d-sp-t').textContent = s.maxSp ? `${num(s.sp)} / ${num(s.maxSp)}` : '';
  $('#d-exp-t').textContent = hasExp ? ep.toFixed(2) + '%' : '';
  let eta = '';
  if (hasExp) {
    eta = `Lv.${(s.level || 0) + 1}`;
    // real game: from how fast EXP % grows; demo: from exp / maxExp
    const left = typeof s.expPct === 'number' ? r.expLeft : s.maxExp - s.exp;
    const ms = typeof s.expPct === 'number' ? r.levelEtaMs : (r.expPerHour > 0 ? (left / r.expPerHour) * 3600000 : null);
    if (ms > 0) eta += ` อีก ~${dur(ms)}`;
    if (left > 0) eta += ` · ขาด ${short(left)}`;
  }
  $('#d-exp-eta').textContent = eta;

  const attrs = ['str', 'agi', 'vit', 'int', 'dex', 'luk'].filter((k) => s[k] != null);
  $('#d-attrs').replaceChildren(...attrs.map((k) => el('div', { class: 'attr' }, el('span', {}, k.toUpperCase()), el('b', {}, String(s[k])))));
  const now = Date.now();
  $('#d-buffs').replaceChildren(...(d.buffs || []).map((b) => el('div', { class: 'buff' }, b.name,
    b.until ? el('small', {}, dur(b.until - now)) : b.stacks ? el('small', {}, '×' + b.stacks) : null)));

  const tiles = [
    ['เวลาเล่น', dur(r.playMs), '', 'นับตั้งแต่เปิดเกมในบัญชีนี้'],
    ['EXP/ชม.', short(r.expPerHour)],
    ['Kill/ชม.', short(r.killsPerHour)],
    ['ดาเมจ/วิ', short(r.dpsNow), '', `ดาเมจที่ตีได้ใน 1 นาทีล่าสุด · เฉลี่ยต่อครั้ง ${short(r.avgHit)}`],
    ['Silver/ชม.', short(r.silverPerHour), 'pos', 'Silver ที่ได้จากการล้มมอน'],
    ['ขายดรอป/ชม.', short(r.dropValuePerHour), 'pos', `มูลค่าของดรอปถ้าขาย NPC (คำนวณแบบเดียวกับเกม) · รวม ${num(r.dropValue)}`],
    ['รายได้รวม/ชม.', short(r.incomePerHour), 'gold', 'Silver/ชม. + ขายดรอป/ชม.'],
    ['การ์ด', r.cards ? `${num(r.cards)} · ${r.cardsPerHour.toFixed(1)}/ชม.` : '0', 'card', (d.cards || []).slice(-5).map((c) => c.mob).join(', ') || 'ยังไม่ได้การ์ด'],
  ];
  // update text in place (no DOM rebuild every second)
  const box = $('#d-tiles');
  if (box.children.length !== tiles.length) {
    box.replaceChildren(...tiles.map(([l, , c]) => el('div', { class: 'tile' + (c ? ' ' + c : '') }, el('span', {}, l), el('b', {}))));
  }
  tiles.forEach(([, v, , tip], i) => {
    const t = box.children[i];
    if (t.lastChild.textContent !== v) t.lastChild.textContent = v;
    t.title = tip || '';
  });
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
  // the game's own minimap (map art + dots) when the game is running; wiki art otherwise
  const live = d.minimap || '';
  const src = live || (info ? MAP_IMG + info.id + '.webp' : '');
  img.classList.toggle('live', !!live);
  if (live) { if (img.dataset.src !== src) { img.dataset.src = src; img.src = src; } img.hidden = false; }
  else if (img.dataset.src !== src) {
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
  if (live) return; // already has the game's dots
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

let watchEditing = null; // item name whose limit / sell amount is being typed
function renderBag() {
  if (watchEditing) return;
  const watch = (state && state.settings.itemWatch) || {};
  const a = state && state.accounts.find((x) => x.id === selected);
  const live = !!a && a.status === 'online';
  const items = ((detail && detail.bag) || []).slice().sort((x, y) => y.qty - x.qty);
  const key = JSON.stringify([live, canSell(), watch, items.map((it) => [it.name, it.qty, Math.round(it.usedPerHour), Math.round(it.gainedPerHour), it.minutesLeft && Math.round(it.minutesLeft), it.market])]);
  rebuild($('#bag'), key, () => (items.length ? items.map((it) => bagRow(it, watch[it.name], live)) : [el('div', { class: 'empty' }, 'ยังไม่มีข้อมูลกระเป๋า')]));
}

function bagRow(it, limit, live) {
  const low = (limit != null && it.qty < limit) || (it.minutesLeft != null && it.minutesLeft < ((state && state.settings.potionMinutes) || 30));
  const id = it.ids && it.ids.length === 1 ? it.ids[0].id : null; // one stack: can sell / price it
  const info = [
    it.minutesLeft != null ? `หมดใน ~${dur(it.minutesLeft * 60000)}` : null,
    it.usedPerHour > 0 ? `ใช้ ${short(it.usedPerHour)}/ชม.` : null,
    it.gainedPerHour > 0 ? `เก็บได้ ${short(it.gainedPerHour)}/ชม.` : null,
    it.market != null ? `ตลาด ~${short(it.market)} G` : null,
    limit != null ? `เตือน < ${num(limit)}` : null,
  ].filter(Boolean).join(' · ');
  const row = el('div', { class: 'item' + (low ? ' low' : '') },
    el('div', { class: 'ic' }, it.name.slice(0, 1)),
    el('div', { class: 'nm' }, it.name, el('small', {}, info || ' ')),
    el('div', { class: 'q' }, num(it.qty)),
    el('div', { class: 'acts' },
      el('button', { class: 'tiny', title: 'ตั้งเตือนเมื่อเหลือน้อยกว่า…', onclick: () => editAmount(row, it.name, 'watch', limit) }, '🔔'),
      live && id ? el('button', { class: 'tiny', title: 'ดูราคาตลาด (Gold)', onclick: () => cmd('price', { itemId: id }, 'กำลังถามราคาตลาด…') }, 'G?') : null,
      live && id ? el('button', { class: 'tiny', disabled: canSell() ? null : '', title: canSell() ? 'ขายให้ NPC' : SELL_RULE, onclick: () => editAmount(row, it.name, 'sell', it.qty, id) }, 'ขาย') : null));
  return row;
}

// inline number box on a bag row: alert limit or how many to sell
function editAmount(row, name, mode, value, itemId) {
  watchEditing = name;
  const input = el('input', { type: 'number', min: '0', class: 'watch', value: value != null ? String(value) : '' });
  const done = async (save) => {
    if (!watchEditing) return;
    watchEditing = null;
    if (save && mode === 'watch') dash.invoke('item-watch', name, input.value === '' || input.value === '0' ? null : input.value);
    if (save && mode === 'sell' && Number(input.value) > 0) {
      if (confirm(`ขาย ${name} x${input.value} ให้ NPC?`)) await cmd('sell', { itemId, qty: Number(input.value) }, `ขาย ${name}…`);
    }
    $('#bag').dataset.key = '';
    renderBag();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(mode === 'watch'));
  row.querySelector('.acts').replaceWith(el('div', { class: 'acts' }, el('small', { class: 'hint' }, mode === 'sell' ? 'ขายกี่ชิ้น ' : 'เตือนเมื่อ < '), input));
  input.focus();
  input.select();
}

// ---------- game version / read health ----------
function renderCompat(a) {
  const c = a.compat;
  const box = $('#compat');
  if (!c || (c.ok && c.knownBuild)) { box.hidden = true; return; }
  const key = JSON.stringify(c);
  if (box.dataset.key === key && !box.hidden) return;
  box.dataset.key = key;
  box.className = 'compat' + (c.ok ? ' info' : ' warn');
  box.replaceChildren(...[
    el('span', {}, c.ok
      ? `ℹ เกมอัปเดตเป็น build ${c.build} · BinderDash อ่านข้อมูลได้ปกติ`
      : `⚠ เกม build ${c.build || '?'} · ${c.problems.join(' · ')} — ตัวเลขบางส่วนอาจผิด รออัปเดต BinderDash`),
    c.ok ? null : el('button', { class: 'tiny', onclick: async () => { await dash.invoke('make-report'); showBanner('สร้างรายงานแล้ว ส่งไฟล์ในโฟลเดอร์ที่เปิดขึ้นมาให้ผู้พัฒนาได้เลย'); } }, 'สร้างรายงานปัญหา'),
  ].filter(Boolean));
  box.hidden = false;
}

// ---------- world events strip ----------
function renderEvents() {
  const ev = (state && state.events) || [];
  const box = $('#events');
  box.hidden = !ev.length;
  rebuild(box, JSON.stringify(ev.map((e) => [e.name, e.perks, Math.round((e.endsInMs || e.startsInMs) / 60000)])), () => ev.map((e) => el('span', { class: 'ev' + (e.live ? ' live' : '') },
    e.live ? '🔥 ' : '⏳ ', el('b', {}, e.name), e.perks.length ? ` · ${e.perks.join(' · ')}` : '',
    e.live ? (e.endsInMs ? ` · เหลือ ${dur(e.endsInMs)}` : '') : ` · เริ่มในอีก ${dur(e.startsInMs)}`)));
}

// ---------- daily checklist ----------
function dailySummary(c) {
  if (!c || (!c.pass && !c.mail && !c.hunt)) return null;
  const daily = c.pass ? c.pass.daily : [];
  const done = daily.filter((x) => x.claimed).length;
  const ready = c.pass ? [...c.pass.daily, ...c.pass.weekly].filter((x) => x.ready).length : 0;
  return { done, total: daily.length, ready, gifts: c.mail ? c.mail.gifts : 0, bounty: c.hunt ? c.hunt.claimed : null };
}
function renderDaily() {
  const c = detail && detail.checklist;
  const sum = dailySummary(c);
  rebuild($('#d-daily'), JSON.stringify(sum), () => (sum ? [
    el('span', {}, '📋 รายวัน '),
    el('span', { class: 'chip-d' }, `Pass ${sum.done}/${sum.total}`),
    sum.ready ? el('span', { class: 'chip-d hot' }, `🎁 รอกดรับ ${sum.ready}`) : null,
    sum.gifts ? el('span', { class: 'chip-d hot' }, `✉ จดหมายมีของ ${sum.gifts}`) : null,
    sum.bounty != null ? el('span', { class: 'chip-d' }, `Bounty รับแล้ว ${sum.bounty}`) : null,
    el('button', { class: 'tiny', onclick: openDaily }, 'ดูทั้งหมด'),
  ] : [el('span', { class: 'hint' }, '📋 รายวัน: รอข้อมูลจากเกม')]));
}
function openDaily() {
  const c = (detail && detail.checklist) || {};
  const row = (x) => el('div', { class: 'task' + (x.ready ? ' ready' : x.claimed ? ' done' : '') },
    el('span', {}, x.claimed ? '✔' : x.ready ? '🎁' : '○'), el('span', { class: 'tl' }, x.label), el('b', {}, `${num(x.prog)}/${num(x.goal)}`));
  openModal('📋 เช็กลิสต์รายวัน', [
    el('p', { class: 'hint' }, 'กดรับรางวัลในเกม (Pass / จดหมาย) · 🎁 = ทำครบแล้วยังไม่กดรับ'),
    el('h4', {}, 'Pass รายวัน'), ...(c.pass ? c.pass.daily.map(row) : [el('p', { class: 'hint' }, 'ยังไม่มีข้อมูล')]),
    el('h4', {}, 'Pass รายสัปดาห์'), ...(c.pass ? c.pass.weekly.map(row) : []),
    el('h4', {}, 'จดหมาย'), el('p', {}, c.mail ? (c.mail.gifts ? `มีของรอรับ ${c.mail.gifts} ฉบับ: ${c.mail.titles.join(' · ')}` : 'ไม่มีของรอรับ') : 'ยังไม่มีข้อมูล'),
    el('h4', {}, 'Bounty (ค่าหัว)'), el('p', {}, c.hunt ? `รับรางวัลแล้ว ${c.hunt.claimed} · กำลังทำ ${c.hunt.active}` : 'ยังไม่มีข้อมูล'),
  ]);
}

// ---------- every account at once ----------
async function openAll() {
  potionList = potionList || await dash.invoke('potions');
  const inGame = state.accounts.filter((a) => a.status === 'online');
  const out = el('div', { class: 'results' });
  const run = async (cmd, arg, label) => {
    out.replaceChildren(el('p', { class: 'hint' }, `${label}…`));
    const res = await dash.invoke('game-cmd-all', cmd, arg);
    out.replaceChildren(...(res.length ? res.map((r) => el('div', { class: 'res ' + (r.ok ? 'ok' : 'bad') },
      `${r.ok ? (r.skipped ? '–' : '✔') : '✖'} ${r.name}${r.skipped && !r.error ? ' (เป็นอยู่แล้ว)' : ''}${r.count ? ` · ${r.count} ชิ้น` : ''}${r.error ? ` · ${r.error}` : ''}`)) : [el('p', {}, 'ไม่มีบัญชีที่อยู่ในเกม')]));
  };
  const sel = el('select', {}, potionList.map((p) => el('option', { value: p.id }, `${p.kind === 'hp' ? '❤' : '💧'} ${p.name} · ${p.price} Silver`)));
  const qty = el('input', { type: 'number', min: '1', max: '999', value: '50' });
  openModal(`สั่งทุกบัญชี (${inGame.length} บัญชีในเกม)`, [
    el('p', { class: 'hint' }, 'ทำทีละบัญชีตามลำดับ เหมือนกดเองทีละบัญชี · บัญชีที่เป็นอยู่แล้วจะข้าม'),
    el('div', { class: 'quick' },
      el('button', { onclick: () => run('autoOn', {}, 'เปิด AUTO') }, '▶ AUTO เปิดทุกบัญชี'),
      el('button', { onclick: () => run('autoOff', {}, 'ปิด AUTO') }, '■ AUTO ปิดทุกบัญชี'),
      el('button', { onclick: () => run('sleep', {}, 'พักจอ') }, '☾ พักจอทุกบัญชี')),
    el('div', { class: 'quick' },
      el('button', { onclick: () => { if (confirm('ขายของดรอป (ETC) ทั้งหมดของทุกบัญชีให้ NPC?')) run('sellEtc', {}, 'ขาย ETC'); } }, '🪙 ขาย ETC ทุกบัญชี'),
      el('button', { onclick: async () => {
        const pre = await dash.invoke('salvage-preview');
        const total = pre.reduce((t, p) => t + p.count, 0);
        if (!total) { out.replaceChildren(el('p', {}, 'ไม่มีอุปกรณ์ที่ย่อยได้ในบัญชีไหนเลย (ของที่ล็อกไว้ไม่นับ)')); return; }
        if (confirm(`ย่อยอุปกรณ์ที่ไม่ได้ล็อกทั้งหมด ${total} ชิ้น?\n${pre.map((p) => `${p.name}: ${p.count} ชิ้น`).join('\n')}\nย่อยแล้วเอาคืนไม่ได้ (ล็อกของที่อยากเก็บในเกมก่อน)`)) run('salvageAll', {}, 'ย่อยของ');
      } }, '🔨 ย่อยของทุกบัญชี')),
    el('label', {}, '🧪 ซื้อยา ', sel, qty, el('button', { onclick: () => run('buy', { itemId: sel.value, qty: Number(qty.value) }, 'ซื้อยา') }, 'ซื้อทุกบัญชี')),
    el('p', { class: 'hint' }, 'ซื้อ/ขายจากระยะไกลใช้ได้เฉพาะบัญชี Premium (กฎของเกม)'),
    out,
  ]);
}
$('#all-btn').addEventListener('click', openAll);

// ---------- bosses ----------
function renderBosses() {
  const b = (state && state.bosses) || { field: [], world: [] };
  const rows = [
    ...b.world.map((w) => ({ cls: w.state === 'live' ? 'up' : '', icon: '🌋', name: w.name,
      sub: w.state === 'live' ? `กำลังสู้ · ${w.fighters} คน${w.hpFrac != null ? ` · HP ${Math.round(w.hpFrac * 100)}%` : ''}` : 'World Boss',
      when: w.state === 'live' ? (w.endsInMs ? `จบใน ${dur(w.endsInMs)}` : 'สด') : w.inMs ? `อีก ${dur(w.inMs)}` : '-' })),
    ...b.field.map((f) => {
      const info = findMap(f.map);
      return { cls: f.up ? 'up' : '', icon: '♛', name: f.name, sub: info ? info.name : f.map, when: f.up ? 'เกิดแล้ว' : `อีก ${dur(f.inMs)}` };
    }),
  ];
  $('#boss-note').textContent = rows.length ? '' : 'รอข้อมูลจากเกม (เปิดเกมอย่างน้อย 1 บัญชี)';
  rebuild($('#bosses'), JSON.stringify(rows), () => rows.map((r) => el('div', { class: 'boss ' + r.cls },
    el('span', { class: 'bi' }, r.icon), el('div', { class: 'bn' }, r.name, el('small', {}, r.sub)), el('b', {}, r.when))));
}

// ---------- game controls ----------
async function cmd(name, arg, pending) {
  if (pending) showBanner(pending);
  const r = await dash.invoke('game-cmd', selected, name, arg);
  if (!r || !r.ok) showBanner((r && r.error) || 'ทำไม่สำเร็จ');
  else if (pending) setTimeout(() => { $('#banner').hidden = true; }, 1200);
  refreshDetail();
  return r;
}

// the game's rule: selling from anywhere (HUD) is Premium only, otherwise at an NPC shop in town
const SELL_RULE = 'ขายจากระยะไกลได้เฉพาะบัญชี Premium (กฎของเกม) · ไม่มี Premium ต้องไปขายกับร้านค้า NPC ในเมือง';
function canSell() { return !!(detail && detail.stats && detail.stats.premium); }

// ---------- modal: buy potions / salvage gear ----------
function openModal(title, body) {
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(...body.filter((n) => n != null && n !== false));
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }
$('#modal-x').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

let potionList = null;
async function openBuy() {
  potionList = potionList || await dash.invoke('potions');
  const s = (detail && detail.stats) || {};
  const have = Object.fromEntries(((detail && detail.bag) || []).flatMap((b) => (b.ids || []).map((x) => [x.id, x.qty])));
  const sel = el('select', { id: 'buy-item' }, potionList.map((p) => el('option', { value: p.id }, `${p.kind === 'hp' ? '❤ HP' : '💧 MP'} · ${p.name} · ${p.price} Silver${have[p.id] ? ` · มี ${have[p.id]}` : ''}`)));
  const qty = el('input', { type: 'number', id: 'buy-qty', min: '1', max: '999', value: '50' });
  const cost = el('p', { class: 'hint' });
  const upd = () => {
    const p = potionList.find((x) => x.id === sel.value);
    cost.textContent = `ราคาประมาณ ${num(p.price * (Number(qty.value) || 0))} Silver (ราคาจริงตามดัชนีเศรษฐกิจของเซิร์ฟ) · Silver ที่มี ${num(s.silver)}`;
  };
  sel.addEventListener('change', upd); qty.addEventListener('input', upd); upd();
  const go = el('button', { class: 'primary', onclick: async () => {
    const r = await cmd('buy', { itemId: sel.value, qty: Number(qty.value) }, 'กำลังซื้อยา…');
    if (r && r.ok) closeModal();
  } }, 'ซื้อ');
  const quick = el('div', { class: 'quick' }, [10, 50, 100, 300].map((n) => el('button', { class: 'tiny', onclick: () => { qty.value = n; upd(); } }, String(n))));
  openModal('🧪 ซื้อยา HP/MP', [
    el('p', { class: 'hint' }, 'ซื้อจากร้าน NPC ผ่าน HUD โดยไม่ต้องเปิดหน้าเกม (ตามกฎเกม ใช้ได้กับบัญชี Premium)'),
    el('label', {}, 'ยา ', sel), el('label', {}, 'จำนวน ', qty, quick), cost, go,
  ]);
}

function gearList() {
  return ((detail && detail.bag) || []).flatMap((b) => (b.ids || []).filter((x) => x.gear && !x.locked).map((x) => ({ ...x, name: b.name, market: b.market })));
}
function gearCount() { return gearList().length; }

function openSalvage() {
  const gear = gearList();
  const boxes = gear.map((g) => {
    const box = el('input', { type: 'checkbox', value: g.id });
    return el('label', { class: 'gear' }, box, ` ${g.name}`, g.market != null ? el('small', {}, ` · ตลาด ~${short(g.market)} G`) : null,
      el('button', { class: 'tiny', type: 'button', title: 'ดูราคาตลาดก่อนย่อย', onclick: (e) => { e.preventDefault(); cmd('price', { itemId: g.id }, 'กำลังถามราคาตลาด…'); } }, 'G?'));
  });
  const go = el('button', { class: 'primary', onclick: async () => {
    const ids = boxes.map((b) => b.querySelector('input')).filter((x) => x.checked).map((x) => x.value);
    if (!ids.length) { showBanner('เลือกของที่จะย่อยก่อน'); return; }
    if (!confirm(`ย่อย ${ids.length} ชิ้น? ย่อยแล้วเอาคืนไม่ได้`)) return;
    const r = await cmd('salvage', { itemIds: ids }, `กำลังย่อย ${ids.length} ชิ้น…`);
    if (r && r.ok) closeModal();
  } }, 'ย่อยที่เลือก');
  openModal('🔨 ย่อยของ', [
    el('p', { class: 'hint' }, 'แยกชิ้นอุปกรณ์ในกระเป๋าเป็นวัตถุดิบ · ของที่ล็อกไว้ในเกมไม่แสดงและจะไม่ถูกย่อย · ดูราคาตลาดก่อนได้ด้วยปุ่ม G?'),
    gear.length ? el('div', { class: 'gearlist' }, boxes) : el('p', {}, 'ไม่มีอุปกรณ์ในกระเป๋าที่ย่อยได้'),
    gear.length ? go : null,
  ]);
}

function renderControls(a) {
  const s = (detail && detail.stats) || {};
  const live = a.status === 'online';
  const etc = ((detail && detail.bag) || []).filter((it) => it.ids && it.ids.some((x) => /^drop_/.test(x.id)));
  const etcQty = etc.reduce((t, it) => t + it.qty, 0);
  const key = JSON.stringify([a.id, live, s.auto, s.sleeping, s.dead, etcQty, !!s.premium, gearCount()]);
  rebuild($('#d-controls'), key, () => (live ? [
    el('button', { class: 'ctl' + (s.auto ? ' on' : ''), title: 'เปิด/ปิด AUTO ของเกม (เหมือนกดปุ่ม AUTO ในเกม)', onclick: () => cmd('auto') }, s.auto ? '■ AUTO เปิดอยู่' : '▶ AUTO ปิดอยู่'),
    el('button', { class: 'ctl', title: 'โหมดพักจอของเกม: จอมืด ประหยัดเครื่อง AUTO ทำงานต่อ (กลับมาได้ที่หน้าเกม กดค้าง 3 วิ)', onclick: () => cmd('sleep') }, s.sleeping ? '☾ พักจออยู่' : '☾ พักจอ'),
    s.dead ? el('button', { class: 'ctl danger', title: 'กดปุ่มฟื้นในหน้าเกม', onclick: () => cmd('respawn') }, '✚ ฟื้นคืนชีพ') : null,
    el('button', { class: 'ctl', disabled: canSell() ? null : '', title: canSell() ? 'ซื้อยา HP/MP จากร้าน NPC โดยไม่ต้องเปิดหน้าเกม' : SELL_RULE, onclick: () => openBuy() }, '🧪 ซื้อยา'),
    el('button', { class: 'ctl', disabled: gearCount() ? null : '', title: 'แยกชิ้นอุปกรณ์ในกระเป๋า (ของที่ล็อกไว้ในเกมจะไม่ถูกย่อย)', onclick: () => openSalvage() }, `🔨 ย่อยของ (${gearCount()})`),
    el('button', { class: 'ctl', disabled: etcQty && canSell() ? null : '', title: canSell() ? 'ขายของดรอปจากมอน (ETC) ทั้งหมดให้ NPC' : SELL_RULE, onclick: () => {
      if (confirm(`ขายของดรอปทั้งหมด ${num(etcQty)} ชิ้นให้ NPC?`)) cmd('sellEtc', {}, 'กำลังขายของดรอป…');
    } }, `🪙 ขาย ETC ทั้งหมด (${num(etcQty)})`),
  ] : [el('span', { class: 'hint' }, a.status === 'closed' ? 'เปิดเกมเพื่อใช้ปุ่มควบคุม' : 'ปุ่มควบคุมใช้ได้เมื่อเข้าเกมแล้ว')]));
}

// ---------- top level ----------
// Draw at most once per animation frame, whatever triggered it
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}

function renderNow() {
  if (!state || editing) return;
  if (!state.accounts.some((a) => a.id === selected)) selected = state.accounts.length ? state.accounts[0].id : null;
  // account list: rebuild only when something on it changed
  const listKey = JSON.stringify([selected, state.accounts.map((a) => [a.id, a.name, a.status, a.alerts, a.memoryMB, a.compat && a.compat.ok, a.summary && a.summary.rewards, a.summary && [a.summary.name, a.summary.level, a.summary.ping, Math.round(a.summary.expPerHour || 0), Math.round(pct(a.summary.hp, a.summary.maxHp)), Math.round(pct(a.summary.sp, a.summary.maxSp)), Math.round(expPctOf(a.summary))]])]);
  rebuild($('#accounts'), listKey, () => state.accounts.map(accountCard));
  $('#add').disabled = state.accounts.length >= state.maxAccounts;

  const live = state.accounts.filter((a) => a.status === 'online' || a.status === 'demo');
  $('#k-online').textContent = `${live.length} / ${state.accounts.length}`;
  const sum = (f) => live.reduce((t, a) => t + (typeof a.summary[f] === 'number' ? a.summary[f] : 0), 0);
  $('#k-silver').textContent = live.length ? num(sum('silver')) : '-';
  $('#k-silver-run').textContent = live.length ? signed(sum('silverToday')) : '-';
  const u = state.update || {};
  const ub = $('#update-btn');
  ub.hidden = !['available', 'downloading', 'ready'].includes(u.status);
  ub.textContent = u.status === 'downloading' ? `กำลังโหลด ${u.percent}%` : u.status === 'ready' ? 'กำลังติดตั้ง…' : `อัปเดต v${u.version}`;
  $('#k-income').textContent = live.length ? short(sum('incomePerHour')) : '-';
  const online = Math.max(0, ...state.accounts.map((x) => (x.summary && x.summary.online) || 0));
  $('#k-server').textContent = online ? num(online) : '-';

  const a = state.accounts.find((x) => x.id === selected);
  $('#detail').hidden = !a;
  if (a) {
    renderCompat(a);
    renderProfile(a);
    renderControls(a);
    renderLogs();
    renderMap();
    renderBag();
    renderDaily();
  }
  renderBosses();
  renderEvents();

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

$('#update-btn').addEventListener('click', () => dash.invoke('update-now'));
// send chat from the Dashboard
function syncChatTo() { $('#chat-to').hidden = $('#chat-ch').value !== 'whisper'; }
$('#chat-ch').addEventListener('change', syncChatTo);
$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#chat-text').value.trim();
  if (!text) return;
  const r = await cmd('chat', { channel: $('#chat-ch').value, text, to: $('#chat-to').value });
  if (r && r.ok) $('#chat-text').value = '';
});
syncChatTo();
// double-click an account = go to its game (opens it if closed)
$('#accounts').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.acc');
  if (!card || e.target.closest('.acc-name')) return;
  dash.invoke('show', Number(card.dataset.id));
});
// Ctrl+1..9: pick an account
addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.shiftKey || !/^[1-9]$/.test(e.key) || !state) return;
  const a = state.accounts[Number(e.key) - 1];
  if (a) { selected = a.id; detail = null; render(); refreshDetail(); e.preventDefault(); }
});
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
// Chat panel can be collapsed to a slim strip (remembered on this PC)
function setChatMin(on) {
  document.querySelector('.logs').classList.toggle('chat-min', on);
  $('#chat-toggle').textContent = on ? '◂ แชท' : 'ย่อ ▸';
  try { localStorage.setItem('chatMin', on ? '1' : ''); } catch { /* storage off */ }
}
$('#chat-toggle').addEventListener('click', (e) => { e.stopPropagation(); setChatMin(!document.querySelector('.logs').classList.contains('chat-min')); });
$('#chat-panel').addEventListener('click', () => { if (document.querySelector('.logs').classList.contains('chat-min')) setChatMin(false); });
try { setChatMin(localStorage.getItem('chatMin') === '1'); } catch { /* storage off */ }

$('#toggle-all').addEventListener('click', () => dash.invoke('toggle-all'));
$('#toggle-settings').addEventListener('click', () => dash.invoke('open-settings'));

dash.onState((s) => { state = s; render(); });
dash.invoke('state').then((s) => { state = s; render(); refreshDetail(); });
setInterval(refreshDetail, 1000);
