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
    else if (k === 'style') e.style.cssText = v; // CSSOM: allowed by the page's CSP (a style attribute is not)
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
  a.alerts.length ? el('div', { class: 'acc-alert', title: a.alerts.map((k) => (a.alertTexts || {})[k] || alertText(k)).join('\n') }, '⚠ ' + a.alerts.map((k) => { const t = (a.alertTexts || {})[k]; const c = t && t.replace(/\s*\((ตั้งไว้|ช่องลัด)[^)]*\)/g, ''); return c && c.length <= 40 ? c : alertText(k); }).join(' · ')) : null,
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
  // one chip per kind of buff (the game can stack the same one several times), with an icon and what it does
  const BUFF = { Power: ['⚔', 'พลังโจมตีเพิ่ม'], Guard: ['🛡', 'ป้องกันเพิ่ม'], Shield: ['🔰', 'โล่ดูดซับดาเมจ'], Haste: ['💨', 'เร็วขึ้น (โจมตี/เคลื่อนที่)'], Focus: ['🎯', 'สมาธิ: คริ/ความแม่นเพิ่ม'], Item: ['🧪', 'บัฟจากไอเทม'], Xpup: ['📈', 'EXP เพิ่ม'], Regen: ['💚', 'ฟื้น HP'], Mana: ['💧', 'ฟื้น SP'] };
  const merged = new Map();
  for (const b of d.buffs || []) {
    const m = merged.get(b.name) || { name: b.name, n: 0, until: 0, stacks: 0 };
    m.n++; m.until = Math.max(m.until, b.until || 0); m.stacks += b.stacks || 0; merged.set(b.name, m);
  }
  $('#d-buffs').replaceChildren(...[...merged.values()].map((b) => {
    const [ic, what] = BUFF[b.name] || ['✨', 'บัฟ'];
    const left = b.until && b.until > now ? dur(b.until - now) : '';
    const count = b.n > 1 ? b.n : b.stacks > 1 ? b.stacks : 0;
    return el('div', { class: 'buff', title: `${b.name}: ${what}${count ? ` · ซ้อน ${count}` : ''}${left ? ` · เหลือ ${left}` : ''}` },
      el('span', { class: 'bi' }, ic), b.name, count ? el('b', { class: 'bn' }, '×' + count) : null, left ? el('small', {}, left) : null);
  }));

  // what the game's own sleep screen shows, since the game opened (no estimates, nothing added up)
  const S = r.session || {}; const hrs = Math.max(1 / 60, r.playMs / 3600000);
  const ph = (v) => (v && r.playMs > 120000 ? ` (${num(Math.round(v / hrs))}/ชม.)` : '');
  const sg = (v) => (v == null ? '-' : (v >= 0 ? '+' : '') + num(v));
  const lines = [
    `สรุปตั้งแต่เปิดเกม · ${dur(r.playMs)}`,
    `ล้มมอน ${num(S.kills || 0)}${ph(S.kills)} · ตาย ${num(S.deaths || 0)} · เลเวลอัป ${num(S.levels || 0)} · ยาที่ใช้ ${num(S.potions || 0)}`,
    `EXP +${num(S.exp || 0)}${ph(S.exp)} · Job EXP +${num(S.job || 0)} · Gold ${sg(S.gold)}${S.gold ? ph(S.gold) : ''}`,
  ];
  const box = $('#d-tiles');
  if (!box.classList.contains('sleepsum')) { box.className = 'tiles sleepsum'; box.replaceChildren(el('h4', {}), el('p', {}), el('p', {})); }
  lines.forEach((t, k) => { if (box.children[k].textContent !== t) box.children[k].textContent = t; });
  box.title = 'นับแบบหน้าพักจอของเกม: Gold = Silver ในตัวที่เปลี่ยนไประหว่างฟาร์ม (ล้มมอน ขาย/หลอมอัตโนมัติ ลบค่ายา/ค่าเกิด) · เงินก้อนเกิน 5 ล้านในครั้งเดียว (ขายตลาด จดหมาย เทรด) ไม่นับ · ต่อชั่วโมงคิดจากเวลาตั้งแต่เปิดเกม';
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
  const w = detail && detail.stats && detail.stats.weightPct;
  $('#bag-sum').textContent = items.length ? `${items.length} รายการ${typeof w === 'number' ? ` · หนัก ${Math.round(w)}%` : ''}` : '';
  $('#bag-sum').className = 'sum' + (typeof w === 'number' && w >= 90 ? ' bad' : '');
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
  // gear: which grades / pieces are in this row (many pieces share one Thai name); tap to see each piece
  const gear = (it.ids || []).filter((x) => x.gear);
  const grades = gear.length ? ['epic', 'rare', 'magic', 'normal'].map((r) => [r, gear.filter((x) => (x.rarity || 'normal') === r).length]).filter(([, n]) => n) : [];
  const best = grades.length ? grades[0][0] : '';
  const kind = gear.length ? '⚔' : (it.ids || []).some((x) => /^drop_/.test(x.id)) ? '📦' : /potion|elixir|ether|โพชั่น|ยา/.test(it.name + ' ' + ((it.ids || [])[0] || {}).id) ? '🧪' : /card/.test(((it.ids || [])[0] || {}).id || '') ? '🃏' : '•';
  const gradeTxt = grades.map(([r, n]) => `${(RARITIES.find((x) => x[0] === r) || RARITIES[0])[1]} ${n}`).join(' · ');
  const locked = gear.filter((x) => x.locked).length;
  const pieces = gear.length ? el('div', { class: 'pieces', hidden: '' }, ...gear.map((x) => { const lb = gearLabel(x, it.name); const ref = lb.title.slice(it.name.length).trim(); return el('div', { class: 'piece' }, el('span', { class: 'rar r-' + (x.rarity || 'normal') }, (RARITIES.find((r) => r[0] === (x.rarity || 'normal')) || RARITIES[0])[1]), el('span', { class: 'pt', title: lb.title + (lb.sub ? ' · ' + lb.sub : '') }, (x.locked ? '🔒 ล็อก ' : '') + (ref || 'ไม่ตีบวก') + (lb.sub ? ' · ' + lb.sub : ''))); })) : null;
  const row = el('div', { class: 'item' + (low ? ' low' : '') + (best ? ' g-' + best : '') },
    el('div', { class: 'ic' + (best ? ' r-' + best : '') }, kind),
    el('div', { class: 'nm', title: it.name, onclick: pieces ? () => { pieces.hidden = !pieces.hidden; } : null }, el('span', { class: 't' }, it.name + (pieces ? ' ▾' : '')), el('small', {}, [gradeTxt, locked ? `🔒 ${locked}` : '', info].filter(Boolean).join(' · ') || ' '), pieces),
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
  const salvUi = salvageOptsUi();
  openModal(`สั่งทุกบัญชี (${inGame.length} บัญชีในเกม)`, [
    el('p', { class: 'hint' }, 'ทำทีละบัญชีตามลำดับ เหมือนกดเองทีละบัญชี · บัญชีที่เป็นอยู่แล้วจะข้าม'),
    el('div', { class: 'quick' },
      el('button', { onclick: () => run('autoOn', {}, 'เปิด AUTO') }, '▶ AUTO เปิดทุกบัญชี'),
      el('button', { onclick: () => run('autoOff', {}, 'ปิด AUTO') }, '■ AUTO ปิดทุกบัญชี'),
      el('button', { onclick: () => run('sleep', {}, 'พักจอ') }, '☾ พักจอทุกบัญชี')),
    el('div', { class: 'quick' },
      el('button', { onclick: () => { if (confirm('ขายของดรอป (ETC) ทั้งหมดของทุกบัญชีให้ NPC?')) run('sellEtc', {}, 'ขาย ETC'); } }, '🪙 ขาย ETC ทุกบัญชี'),
      el('button', { title: 'รับของในจดหมาย ภารกิจ Pass และ Tier ของ Pass ทุกบัญชี', onclick: async () => { const r = await dash.invoke('claim-rewards-all'); const ok = r.filter((x) => x.ok); showBanner(`🎁 รับของ ${ok.length} บัญชี · จดหมาย ${ok.reduce((t, x) => t + x.mail, 0)} · ภารกิจ ${ok.reduce((t, x) => t + x.daily + x.weekly, 0)}`); setTimeout(() => { $('#banner').hidden = true; }, 3000); } }, '🎁 รับของทุกบัญชี'),
      el('button', { title: 'ทุกบัญชีที่ออนไลน์เริ่มทำค่าหัวรายวันเอง (เดินทาง ล่า รับรางวัล)', onclick: async () => { const r = await dash.invoke('bounty-all', true); showBanner(`📜 เริ่มทำค่าหัว ${r.filter((x) => x.ok).length} บัญชี`); setTimeout(() => { $('#banner').hidden = true; }, 2500); } }, '📜 ทำค่าหัวทุกบัญชี'),
      el('button', { onclick: async () => { await dash.invoke('bounty-all', false); showBanner('หยุดทำค่าหัวทุกบัญชีแล้ว'); setTimeout(() => { $('#banner').hidden = true; }, 2000); } }, '■ หยุดค่าหัว'),
      el('button', { onclick: async () => {
        const rarities = [...document.querySelectorAll('#salv-r input:checked')].map((x) => x.value);
        if (!rarities.length) { out.replaceChildren(el('p', {}, 'เลือกเกรดที่จะย่อยก่อน')); return; }
        const o = salvUi.get();
        out.replaceChildren(el('p', { class: 'hint' }, o.byPrice ? 'กำลังเช็คราคาตลาดกลางของอุปกรณ์ทุกบัญชี…' : 'กำลังนับ…'));
        const pre = await dash.invoke('salvage-preview', rarities, o);
        out.replaceChildren();
        const total = pre.reduce((t, p) => t + p.count, 0);
        const kept = pre.reduce((t, p) => t + (p.kept || 0), 0);
        const label = rarities.map((r) => RARITIES.find((x) => x[0] === r)[1]).join(' + ');
        if (!total) { out.replaceChildren(el('p', {}, `ไม่มีอุปกรณ์เกรด ${label} ที่ย่อยได้${kept ? ` (เก็บไว้ ${kept} ชิ้นเพราะมีราคา/ขายออกบ่อย/ยังไม่รู้ราคา)` : ''}`)); return; }
        if (confirm(`ย่อยอุปกรณ์เกรด ${label} รวม ${total} ชิ้น?${o.byPrice ? `\n(เฉพาะไม่มีราคาหรือต่ำกว่า ${num(o.maxPrice)} G · เก็บไว้ ${kept} ชิ้น)` : ''}\n${pre.map((p) => `${p.name}: ย่อย ${p.count}${p.kept ? ` · เก็บ ${p.kept}` : ''}`).join('\n')}\nย่อยแล้วเอาคืนไม่ได้`)) run('salvageAll', { rarities, ...o }, 'ย่อยของ');
      } }, '🔨 ย่อยของทุกบัญชี')),
    el('div', { class: 'quick', id: 'salv-r' }, el('span', { class: 'hint' }, 'เกรดที่จะย่อย: '),
      RARITIES.map(([r, label]) => el('label', { class: 'rpick' }, el('input', { type: 'checkbox', value: r, ...(r === 'normal' || r === 'magic' ? { checked: '' } : {}) }), ` ${label}`))),
    salvUi.node,
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
    ...b.world.map((w) => ({ cls: w.state === 'live' ? 'up' : '', icon: '🌋', name: w.name, kind: w.kind, live: w.state === 'live',
      sub: w.state === 'live' ? `กำลังสู้ · ${w.fighters} คน${w.hpFrac != null ? ` · HP ${Math.round(w.hpFrac * 100)}%` : ''}` : 'World Boss',
      when: w.state === 'live' ? (w.endsInMs ? `จบใน ${dur(w.endsInMs)}` : 'สด') : w.inMs ? `อีก ${dur(w.inMs)}` : '-' })),
    ...b.field.map((f) => {
      const info = findMap(f.map);
      return { cls: f.up ? 'up' : '', icon: '♛', name: f.name, sub: info ? info.name : f.map, when: f.up ? 'เกิดแล้ว' : `อีก ${dur(f.inMs)}` };
    }),
  ];
  $('#boss-note').textContent = '';
  const up = rows.filter((r) => r.cls === 'up').length;
  $('#boss-sum').textContent = rows.length ? (up ? `เกิดแล้ว ${up}` : `${rows.length} ตัว`) : '';
  $('#boss-sum').className = 'sum' + (up ? ' good' : '');
  if (!rows.length) { rebuild($('#bosses'), 'none', () => [el('div', { class: 'empty' }, 'รอข้อมูลจากเกม · เปิดเกมอย่างน้อย 1 บัญชี')]); return; }
  rebuild($('#bosses'), JSON.stringify(rows), () => rows.map((r) => el('div', { class: 'boss ' + r.cls },
    el('span', { class: 'bi' }, r.icon), el('div', { class: 'bn' }, r.name, el('small', {}, r.sub)), el('b', {}, r.when),
    r.kind && r.live ? el('button', { class: 'tiny primary', title: 'ส่งทุกบัญชีที่ออนไลน์เข้าสนาม World Boss (ฟรี) แล้วเปิด AUTO · จบแล้วพากลับที่เดิม', onclick: async (e) => {
      e.target.disabled = true; const res = await dash.invoke('world-boss-go', r.kind);
      showBanner(res && res.sent ? `⚔ ส่ง ${res.sent} บัญชีไปตี ${r.name} แล้ว` : 'ไม่มีบัญชีที่ออนไลน์'); setTimeout(() => { $('#banner').hidden = true; }, 3000);
    } }, '⚔ ไปตีทุกตัว') : null)));
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
function closeModal() { $('#modal').hidden = true; $('#modal').classList.remove('wide'); }
$('#modal-x').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

async function openFarmMaps(accId) {
  const r = await dash.invoke('farm-maps', accId);
  const rows = (r && r.rows) || [];
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : `${Math.round(m / 1440)} วัน`; };
  openModal('📊 แมพที่เคยฟาร์ม', [
    el('p', { class: 'hint' }, `เลเวล ${r.level} (นับนาทีที่ฟาร์มตอนเลเวลห่างไม่เกิน 5) · รวมผลฟาร์มจาก log สถิติย้อนหลัง 14 วัน (≈ = ประมาณจาก log) · กำไร = Silver จากมอน (รวมคอมโบ/การ์ด Gold) + ขาย/หลอมอัตโนมัติ Normal/Magic + ETC ราคา NPC − ยาที่ซื้อ · ไม่นับราคาตลาด · ตัวเลขแม่นขึ้นเมื่อเปิดขาย/หลอมอัตโนมัติในเกม`),
    rows.length ? el('table', { class: 'lab-table' },
      el('tr', {}, ...['แมพ', 'กำไร/ชม.', 'จากมอน/ชม.', 'ฆ่า/ชม.', 'ตาย/ชม.', 'วัดแล้ว', 'ล่าสุด', ''].map((h) => el('th', {}, h))),
      ...rows.map((x) => el('tr', { class: x.map === r.here ? 'on' : '' },
        el('td', {}, x.name + (x.map === r.here ? ' (อยู่ตอนนี้)' : '')), el('td', { title: x.est ? 'ประมาณ: Silver จากมอนใน log สถิติ × สัดส่วนกำไร/เงินจากมอนของตัวนี้ในแมพที่วัดจริง (log สถิติไม่มีเงินขายอัตโนมัติ)' : 'วัดจริง: Silver ในตัวที่เพิ่มขึ้น + ETC − ยา' }, el('b', {}, (x.est ? '≈ ' : '') + num(x.netHr))), el('td', {}, num(x.killSilverHr)), el('td', {}, num(x.killsHr)), el('td', { class: x.deathsHr >= 5 ? 'neg' : '', title: x.deathsHr ? `ค่าเกิดที่เดิม ~${num(Math.round(x.deathsHr * 5000))} G/ชม. (หักออกจากกำไรแล้ว)` : '' }, x.deathsHr != null ? String(x.deathsHr) : '-'), el('td', {}, [x.minutes ? `วัด ${x.minutes} นาที` : '', x.histMinutes ? `log ${x.histMinutes} นาที` : ''].filter(Boolean).join(' · ')), el('td', {}, ago(x.last)),
        el('td', {}, x.map === r.here ? '' : el('button', { class: 'tiny', onclick: async () => { const g = await dash.invoke('farm-go', accId, x.map); showBanner(g && g.ok ? `🚶 กำลังไป ${x.name} · ถึงแล้วเปิด AUTO ทั้งแมพ` : (g && g.error) || 'ไปไม่ได้'); closeModal(); } }, 'ไปฟาร์ม'))))) : el('p', {}, 'ยังไม่มีข้อมูล · เปิด AUTO ฟาร์มสักพัก หรือกด "🔎 หาที่ฟาร์มคุ้มสุด"'),
  ]);
}

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
  const result = el('div', { class: 'buy-result' });
  const go = el('button', { class: 'primary', onclick: async () => {
    go.disabled = true;
    const want = Number(qty.value) || 0;
    result.replaceChildren(el('p', { class: 'hint' }, `กำลังซื้อ ${want} ชิ้น (ร้านขายครั้งละไม่เกิน 99 จะซื้อเป็นรอบ ๆ)…`));
    const r = await dash.invoke('game-cmd', selected, 'buy', { itemId: sel.value, qty: want });
    await refreshDetail();
    if (r && r.ok) result.replaceChildren(el('p', { class: r.bought >= want ? 'ok' : 'warn' }, `✔ ได้ ${num(r.bought)} / ${num(want)} ชิ้น${r.note ? ' · ' + r.note : ''}`));
    else result.replaceChildren(el('p', { class: 'bad' }, '✖ ' + ((r && r.error) || 'ซื้อไม่สำเร็จ')));
    go.disabled = false; upd();
  } }, 'ซื้อ');
  const quick = el('div', { class: 'quick' }, [10, 50, 100, 300].map((n) => el('button', { class: 'tiny', onclick: () => { qty.value = n; upd(); } }, String(n))));
  openModal('🧪 ซื้อยา HP/MP', [
    el('p', { class: 'hint' }, 'ซื้อจากร้าน NPC ผ่าน HUD โดยไม่ต้องเปิดหน้าเกม (ตามกฎเกม ใช้ได้กับบัญชี Premium)'),
    el('label', {}, 'ยา ', sel), el('label', {}, 'จำนวน ', qty, quick), cost, go, result,
  ]);
}

const RARITIES = [['normal', 'Normal'], ['magic', 'Magic'], ['rare', 'Rare'], ['epic', 'Epic']];
// salvage by market value: the controls (shared by the one-account and all-accounts windows)
function salvageOptsUi(onChange) {
  const st = (state && state.settings) || {};
  const by = el('input', { type: 'checkbox', checked: st.salvageByPrice !== false ? '' : null });
  const max = el('input', { type: 'number', min: '0', step: '100000', value: String(st.salvageMaxPrice ?? 1000000), style: 'width:110px' });
  const vol = el('input', { type: 'number', min: '0', max: '999', value: String(st.salvageKeepVol ?? 3), style: 'width:56px' });
  const unk = el('input', { type: 'checkbox', checked: st.salvageUnknownOk ? '' : null });
  const save = () => { dash.invoke('settings', { salvageByPrice: by.checked, salvageMaxPrice: +max.value || 0, salvageKeepVol: +vol.value || 0, salvageUnknownOk: unk.checked }); if (onChange) onChange(); };
  for (const x of [by, max, vol, unk]) x.addEventListener('change', save);
  return { get: () => ({ byPrice: by.checked, maxPrice: +max.value || 0, keepVol: +vol.value || 0, unknownOk: unk.checked }),
    node: el('div', { class: 'salv-opts' },
      el('label', {}, by, ' ย่อยเฉพาะของที่ไม่มีราคา หรือราคาตลาดกลางต่ำกว่า ', max, ' G'),
      el('label', {}, 'และไม่ย่อยของที่ขายออกบ่อย: ขายจริงใน 7 วัน ≥ ', vol, ' ชิ้น'),
      el('label', {}, unk, ' ของที่ตลาดไม่ตอบราคา (ถามแล้ว 3 รอบ) ให้ถือว่าไม่มีราคา → ย่อยได้'),
      el('small', { class: 'hint' }, 'โปรแกรมถามราคาตลาดให้ทุกชิ้นก่อนเสมอ · ของที่ล็อกในเกมไม่แสดงและไม่ถูกย่อย · ของผูกตัวขายไม่ได้ ย่อยได้ตามปกติ')) };
}
function gearList() {
  return ((detail && detail.bag) || []).flatMap((b) => (b.ids || []).filter((x) => x.gear && !x.locked).map((x) => ({ ...x, name: b.name, market: b.market })));
}
function gearCount() { return gearList().length; }
// which piece is which: Thai name, +refine and its lines (many pieces share one name)
const AFX_TH = { atk: 'ATK', atkpct: 'ATK%', matk: 'MATK', matkpct: 'MATK%', crit: 'คริ', critdmg: 'ดาเมจคริ', cdr: 'คูลดาวน์', aspd: 'สปีดตี', str: 'STR', agi: 'AGI', vit: 'VIT', int: 'INT', dex: 'DEX', luk: 'LUK', hp: 'HP', hppct: 'HP%', vsdebuff: 'ดาเมจใส่ดีบัฟ', guard: 'Guard', spellamp: 'Spell Amp', armorpen: 'เจาะเกราะ', p_bleed: 'Rend', p_echo: 'Echo', p_chain: 'Chain', p_expose: 'Sunder', p_bulwark: 'Bulwark', p_haste: 'Frenzy', p_thorns: 'สะท้อน', sturdy: 'Sturdy', evasive: 'หลบ', move: 'วิ่งเร็ว', leech: 'ดูดเลือด', opener: 'ตีแรก' };
function gearLabel(x, name) {
  const id = String(x.id || '');
  const ref = /\+(\d+)/.exec(id.split('|')[0]);
  const lines = ((/\|([^#]*)/.exec(id) || [])[1] || '').split(',').filter(Boolean).map((a) => { const p = a.split(':'); return `${AFX_TH[p[0]] || p[0]} ${p[2] || ''}`.trim(); });
  return { title: `${name}${ref ? ' +' + ref[1] : ''}`, sub: lines.join(' · ') };
}
// sell chosen pieces to the NPC shop (never locked ones; expensive ones are not ticked)
async function openNpcSell() {
  const min = (state && state.settings.highValueGold) || 5000000;
  const ip = (detail && detail.itemPrices) || {};
  const gear = ((detail && detail.bag) || []).flatMap((b) => (b.ids || []).filter((x) => x.gear && !x.locked).map((x) => ({ ...x, name: b.name })));
  const rows = gear.map((g) => {
    const p = ip[g.id]; const rich = p && p.price >= min; const lb = gearLabel(g, g.name);
    const box = el('input', { type: 'checkbox', value: g.id, 'data-rarity': g.rarity || 'normal', checked: !rich && ['normal', 'magic'].includes(g.rarity || 'normal') ? '' : null });
    return { g, box, row: el('label', { class: 'gearrow' + (rich ? ' rich' : '') }, box,
      el('span', { class: 'rar r-' + (g.rarity || 'normal') }, (RARITIES.find((r) => r[0] === g.rarity) || RARITIES[0])[1]),
      el('span', { class: 'nm' }, (rich ? '💎 ' : '') + lb.title, lb.sub ? el('small', {}, lb.sub) : null),
      el('small', { class: 'pr' }, p && p.price ? `ตลาด ${short(p.price)} G` : g.bound ? 'ผูกตัว (ขายตลาดไม่ได้)' : 'ยังไม่รู้ราคาตลาด')) };
  });
  const count = el('b', {}, '');
  const upd = () => { count.textContent = String(rows.filter((r) => r.box.checked).length); };
  for (const r of rows) r.box.addEventListener('change', upd);
  const pick = (rar, on) => { for (const r of rows) if ((r.g.rarity || 'normal') === rar && !(ip[r.g.id] && ip[r.g.id].price >= min)) r.box.checked = on; upd(); };
  upd();
  openModal('🪙 ขายของให้ NPC', [
    el('p', { class: 'hint' }, `ชื่อภาษาไทยตามเกม · ของที่ล็อกในเกมไม่แสดงและไม่ขาย · 💎 = ราคาตลาด ≥ ${short(min)} G (ไม่ติ๊กให้) · ติ๊ก Normal/Magic ไว้ให้ก่อน`),
    el('div', { class: 'lab-row' }, ...['normal', 'magic', 'rare', 'epic'].map((rar) => el('button', { class: 'tiny', onclick: () => pick(rar, !rows.some((r) => (r.g.rarity || 'normal') === rar && r.box.checked)) }, `เลือก/ไม่เลือก ${(RARITIES.find((r) => r[0] === rar) || RARITIES[0])[1]}`))),
    rows.length ? el('div', { class: 'gearlist' }, ...rows.map((r) => r.row)) : el('p', {}, 'ไม่มีอุปกรณ์ที่ขายได้ (ที่ล็อกไว้ไม่นับ)'),
    el('div', { class: 'lab-row' }, el('button', { class: 'primary', onclick: async () => {
      const items = rows.filter((r) => r.box.checked).map((r) => ({ itemId: r.g.id, qty: r.g.qty || 1 }));
      if (!items.length) return;
      const rich = items.filter((x) => ip[x.itemId] && ip[x.itemId].price >= min).length;
      if (!confirm(`ขาย ${items.length} ชิ้นให้ NPC?${rich ? `\n⚠ มี ${rich} ชิ้นที่ราคาตลาด ≥ ${short(min)} G` : ''}`)) return;
      closeModal(); await cmd('sellNpc', { items }, `กำลังขาย ${items.length} ชิ้นให้ NPC…`);
    } }, 'ขายให้ NPC ', count, ' ชิ้น')),
  ]);
}

async function openSalvage() {
  const gear = gearList();
  const list = el('div', { class: 'gearlist' });
  const out = el('div', {});
  let verdicts = null; // id -> { salvage, why, price, vol7 }
  const rows = gear.map((g) => {
    const box = el('input', { type: 'checkbox', value: g.id, 'data-rarity': g.rarity || 'normal' });
    const why = el('small', { class: 'hint' }, ' · กำลังเช็คราคา…');
    return { g, box, why, row: el('label', { class: 'gear' }, box, el('span', { class: 'rar r-' + (g.rarity || 'normal') }, (RARITIES.find((r) => r[0] === g.rarity) || RARITIES[0])[1]), ` ${g.name}`, why) };
  });
  list.replaceChildren(...(rows.length ? rows.map((r) => r.row) : [el('p', {}, 'ไม่มีอุปกรณ์ในกระเป๋าที่ย่อยได้')]));
  // verdict per piece from its market numbers (same rule as the program's own: no price / under the limit, not a steady seller)
  const judge = (g) => {
    const o = ui.get(); const v = verdicts && verdicts[g.id];
    if (!o.byPrice) return { salvage: true, why: v && v.price ? `ตลาด ~${short(v.price)} G` : '' };
    if (/ผูกตัว/.test((v && v.why) || '')) return { salvage: true, why: v.why };
    if (!v || (v.price == null && /ไม่ตอบราคา/.test(v.why || ''))) return o.unknownOk ? { salvage: true, why: 'ตลาดไม่ตอบราคา → ถือว่าไม่มีราคา' } : { salvage: false, why: 'ตลาดไม่ตอบราคา (เก็บไว้ก่อน)' };
    if (o.keepVol > 0 && (v.vol7 || 0) >= o.keepVol) return { salvage: false, why: `ขายออกบ่อย ${v.vol7} ชิ้นใน 7 วัน` };
    if (v.price && v.price >= o.maxPrice) return { salvage: false, why: `ราคาตลาด ${short(v.price)} G` };
    return { salvage: true, why: v.price ? `ราคาต่ำ ${short(v.price)} G` : 'ไม่มีราคาในตลาด' };
  };
  const refresh = () => {
    for (const r of rows) { const j = judge(r.g); r.why.textContent = ' · ' + (j.salvage ? '✔ ย่อยได้' : '✖ เก็บไว้') + (j.why ? ': ' + j.why : ''); r.row.classList.toggle('keep', !j.salvage); r.box.checked = j.salvage && ['normal', 'magic'].includes(r.g.rarity || 'normal'); }
  };
  const ui = salvageOptsUi(refresh);
  const go = el('button', { class: 'primary', onclick: async () => {
    const ids = rows.filter((r) => r.box.checked).map((r) => r.g.id);
    if (!ids.length) { showBanner('เลือกของที่จะย่อยก่อน'); return; }
    const risky = rows.filter((r) => r.box.checked && !judge(r.g).salvage);
    if (!confirm(`ย่อย ${ids.length} ชิ้น?${risky.length ? `\n⚠ มี ${risky.length} ชิ้นที่ระบบแนะนำให้เก็บ: ${risky.map((r) => r.g.name).join(', ')}` : ''}\nย่อยแล้วเอาคืนไม่ได้`)) return;
    const r = await cmd('salvage', { itemIds: ids }, `กำลังย่อย ${ids.length} ชิ้น…`);
    if (r && r.ok) closeModal();
  } }, 'ย่อยที่เลือก');
  // pick by grade, like the game's salvage window (only pieces the price rule allows, when it is on)
  const byRarity = el('div', { class: 'quick' }, el('span', { class: 'hint' }, 'เลือกทั้งเกรด: '), RARITIES.map(([r, label]) => {
    const n = gear.filter((g) => (g.rarity || 'normal') === r).length;
    return el('button', { class: 'tiny', disabled: n ? null : '', onclick: () => {
      const these = rows.filter((x) => (x.g.rarity || 'normal') === r && judge(x.g).salvage).map((x) => x.box);
      const all = these.length && these.every((x) => x.checked);
      these.forEach((x) => { x.checked = !all; });
    } }, `${label} (${n})`);
  }));
  openModal('🔨 ย่อยของ', [
    el('p', { class: 'hint' }, 'แยกชิ้นอุปกรณ์ในกระเป๋าเป็นวัตถุดิบ · ของที่ล็อกไว้ในเกมไม่แสดงและจะไม่ถูกย่อย'),
    gear.length ? ui.node : null,
    gear.length ? byRarity : null,
    list, out,
    gear.length ? go : null,
  ]);
  if (!rows.length) return;
  out.replaceChildren(el('p', { class: 'hint' }, 'กำลังเช็คราคาตลาดกลางของทุกชิ้น…'));
  try {
    const v = await dash.invoke('salvage-verdicts', selected, ui.get());
    verdicts = v ? Object.fromEntries(v.items.map((x) => [x.id, x])) : {};
    out.replaceChildren(el('p', { class: 'hint' }, `เช็คราคาแล้ว · ย่อยได้ ${rows.filter((r) => judge(r.g).salvage).length} ชิ้น · เก็บไว้ ${rows.filter((r) => !judge(r.g).salvage).length} ชิ้น`));
  } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); verdicts = {}; }
  refresh();
}

// ---------- sell gear on the central market ----------
function tradableGear() {
  return ((detail && detail.bag) || []).flatMap((b) => (b.ids || []).filter((x) => x.gear && !x.locked && !x.bound).map((x) => ({ ...x, name: b.name })));
}

// ---------- high-value gear panel: pieces worth >= highValueGold on the central market ----------
function renderHighValue() {
  const min = (state && state.settings.highValueGold) || 5000000;
  const a = state && state.accounts.find((x) => x.id === selected);
  const live = !!a && a.status === 'online';
  const ip = (detail && detail.itemPrices) || {};
  const gear = tradableGear();
  const rich = gear.map((g) => ({ ...g, p: ip[g.id] })).filter((g) => g.p && g.p.price >= min).sort((x, y) => y.p.price - x.p.price);
  const unknown = gear.filter((g) => !ip[g.id]).length;
  const pending = (detail && detail.pending) || [];
  $('#hv-note').textContent = `≥ ${short(min)} G`;
  $('#hv-sum').textContent = rich.length ? `${rich.length} ชิ้น · ${short(rich.reduce((t, g) => t + g.p.price, 0))} G` : pending.length ? `รอขึ้นตลาด ${pending.length}` : '';
  const key = JSON.stringify([live, min, rich.map((g) => [g.id, g.p.price]), unknown, pending.map((p) => [p.itemId, p.state, Math.ceil(p.left / 60000)])]);
  rebuild($('#hivalue'), key, () => {
    const out = rich.map((g) => el('div', { class: 'item hv' },
      el('span', { class: 'rar r-' + (g.rarity || 'normal') }, (RARITIES.find((r) => r[0] === g.rarity) || RARITIES[0])[1]),
      el('div', { class: 'nm' }, gearLabel(g, g.name).title, el('small', {}, gearLabel(g, g.name).sub), el('small', {}, g.p.basis === 'listed' ? `ตลาดถูกสุด ${short(g.p.price)} G${g.p.last ? ` · ขายล่าสุด ${short(g.p.last)}` : ''} · วางขาย ${g.p.stock}` : `ขายจริงล่าสุด ${short(g.p.price)} G · ตอนนี้ไม่มีคนวางขาย`)),
      live ? el('button', { class: 'tiny', title: 'ลงขายชิ้นนี้ในตลาดกลาง', onclick: () => openMarketSell({ only: [g.id] }) }, '🏪 ขาย') : null));
    if (rich.length > 1 && live) out.push(el('button', { class: 'ctl small', onclick: () => openMarketSell({ only: rich.map((g) => g.id) }) }, `🏪 ลงขายทั้งหมด ${rich.length} ชิ้น`));
    for (const p of pending) {
      const label = { waiting: `⏳ รอขึ้นตลาด ~${Math.max(1, Math.ceil(p.left / 60000))} นาที`, listed: '✔ ขึ้นตลาดแล้ว', notSeen: '❔ ยังไม่เห็นในประกาศของฉัน ลองดูในเกม', failed: '✖ ไม่ได้ลงขาย (ของยังอยู่ในกระเป๋า)' }[p.state] || p.state;
      out.push(el('div', { class: 'item hv pend ' + p.state },
        el('div', { class: 'nm' }, p.name, el('small', {}, `${num(p.unit)} G · ${label}`))));
    }
    if (!out.length) out.push(el('div', { class: 'empty' }, unknown ? `กำลังเช็คราคาตลาดอุปกรณ์ ${unknown} ชิ้น…` : `ไม่มีอุปกรณ์ราคา ≥ ${short(min)} G ในกระเป๋า`));
    else if (unknown) out.push(el('small', { class: 'hint' }, `ยังเช็คราคาไม่ครบ อีก ${unknown} ชิ้น`));
    return out;
  });
}

// ---------- Build Lab: strongest skill build for farming / bosses (the game's own calculator) ----------
let labInfo = null;
let lastLab = null; // the settings of the last Build Lab run (card builds reuse them)
const labPretty = (id) => String(id || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// opt.id: which account to read (default: the selected one) · opt.auto: run at once (skills, then cards)
async function openLab(opt = {}) {
  const out = el('div', { class: 'lab-out' }, el('p', { class: 'hint' }, 'กำลังโหลดตัวคำนวณของเกม…'));
  openModal('🧪 Build Lab · หาชุดสกิลที่แรงที่สุด', [out]);
  $('#modal').classList.add('wide');
  try { labInfo = labInfo || await dash.invoke('lab-info'); } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
  const accId = opt.id || selected;
  const me = accId ? await dash.invoke('lab-me', accId) : null;
  const online = ((state && state.accounts) || []).filter((a) => a.status === 'online');
  const accSel = el('select', {}, el('option', { value: '' }, '— ไม่ใช้ตัวละคร (กรอกเอง) —'),
    ...online.map((a) => el('option', { value: a.id, selected: a.id === accId ? '' : null }, a.name || ('บัญชี ' + a.id))));
  accSel.addEventListener('change', () => openLab({ id: accSel.value ? Number(accSel.value) || accSel.value : -1 }));
  const jobs = labInfo.jobs;
  const myJob = me && jobs.some((j) => j.id === me.job) ? me.job : 'mage';
  const num_ = (v, min, max, step = 1) => el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(v) });
  const job = el('select', {}, ...jobs.map((j) => el('option', { value: j.id, selected: j.id === myJob ? '' : null }, labPretty(j.id))));
  const lv = num_(me && me.job === myJob ? me.level : 100, 1, 200);
  // class 1: Job Lv 50 (all skill points) by default, like class 2; untick to use the character's own Job Lv
  const jlvReal = me && me.job === myJob ? Math.min(50, me.jobLevel) : 50;
  const jlv = num_(50, 1, 50);
  const c1Full = el('input', { type: 'checkbox', checked: me && me.job === myJob ? null : '' }); // a real character: its own Job Lv
  const c1Sync = () => { jlv.disabled = c1Full.checked; jlv.value = String(c1Full.checked ? 50 : jlvReal); };
  c1Full.addEventListener('change', c1Sync); c1Sync();
  const c2i = (me && me.c2info) || {};
  const c2SkillPts = me && me.c2 ? Object.entries(me.skills).filter(([k]) => k.startsWith(me.c2 + '_')).reduce((t, [, v]) => t + v, 0) : 0;
  // class 2: Job Lv 50 and all 70 points by default, so every result is compared on a full class 2
  const c2lv = num_(50, 1, 50);
  const c2pts = num_(70, 0, 70);
  const c2Full = el('input', { type: 'checkbox', checked: me && me.c2 ? null : '' }); // a real character: its own class-2 Job Lv and points
  const c2Real = me && me.c2 ? { lv: c2i.jobLevel || 0, pts: c2SkillPts + (c2i.points || 0) } : null;
  const c2Sync = () => {
    c2lv.disabled = c2pts.disabled = c2Full.checked;
    if (c2Full.checked) { c2lv.value = '50'; c2pts.value = '70'; } else if (c2Real) { c2lv.value = String(c2Real.lv || 50); c2pts.value = String(c2Real.pts || 0); }
  };
  c2Full.addEventListener('change', c2Sync); c2Sync();
  const owned = (me && me.ownedCards) || [];
  const st = {}; for (const k of ['str', 'agi', 'vit', 'int', 'dex', 'luk']) st[k] = num_(me && me.stats ? me.stats[k] || 1 : 1, 0, 999);
  const mode = el('select', {}, el('option', { value: 'boss' }, '👑 ตีบอส (ดาเมจเป้าเดียว)'));
  const pack = num_(4, 1, 12); pack.addEventListener('change', () => { pack.dataset.touched = '1'; });
  const boss = el('select', {}, el('option', { value: '' }, 'บอสเลเวลใกล้ตัวที่สุด'),
    el('option', { value: 'wraithroot_colossus' }, '🌍 World Boss · Wraithroot Colossus (Lv 99)'),
    el('option', { value: 'pearlheart_titan' }, '🌍 World Boss · Pearlheart Titan (Lv 130)'),
    el('option', { value: 'training_dummy' }, '🎯 หุ่นฟางห้องฝึก (เทียบกับ DPS Meter)'),
    ...labInfo.bosses.map((b) => el('option', { value: b.id }, `${labPretty(b.id)} (Lv ${b.level})`)));
  const useCur = el('input', { type: 'checkbox', checked: me && me.job === myJob ? '' : null });
  const lo = me && me.loadout;
  const hasLo = !!lo && (Object.keys(lo.equip || {}).length > 0 || Object.keys(lo.album || {}).length > 0);
  const useGear = el('input', { type: 'checkbox', checked: hasLo ? '' : null, disabled: hasLo ? null : '' });
  const packRow = el('label', { hidden: '' }, 'มอนต่อกลุ่ม ', pack, el('small', { class: 'hint' }, ' ตัว (สกิลวง/ทะลุ/กวาด ตีได้หลายตัว)'));
  // how long the boss fight lasts: the build is scored on its average damage over that time
  let ft = { fights: {}, world: {} }; try { ft = await dash.invoke('fight-times'); } catch { /* none yet */ }
  const win = el('select', { title: 'บิลด์ถูกจัดให้ได้ดาเมจรวมมากที่สุดในเวลาที่ตีบอสจริง (ช่วงเปิดกับช่วงยาวถ่วงตามเวลานั้น)' },
    el('option', { value: 'auto' }, 'อัตโนมัติ (ตามบอส)'), el('option', { value: 'real' }, 'จากการตีจริง'),
    el('option', { value: '30' }, '30 วิ'), el('option', { value: '60' }, '1 นาที'), el('option', { value: '180' }, '3 นาที'), el('option', { value: 'sustain' }, 'ยาวมาก (นาทีที่ 2–3)'));
  const party = num_(1, 1, 30);
  const useCombos = el('input', { type: 'checkbox', checked: '' });
  const realOf = () => { const t = boss.value || ''; const f = ft.fights[t]; return f ? f : null; };
  const ftNote = el('small', { class: 'hint' });
  const updFt = () => { const f = realOf(); const wl = ft.world[boss.value]; ftNote.textContent = f ? ` · ตีจริง ${f.n} ครั้ง ค่ากลาง ${f.sec} วิ` : wl ? ` · กิจกรรมยาว ${Math.round(wl / 60)} นาที` : ''; };
  boss.addEventListener('change', updFt); updFt();
  const bossRow = el('label', {}, me && me.job === myJob ? '' : 'เป้า ', me && me.job === myJob ? '' : boss, ' · ระยะเวลาสู้ ', win, ' · ตีกี่คน ', party, me && me.job === myJob ? '' : ftNote);
  mode.addEventListener('change', () => { packRow.hidden = mode.value !== 'farm'; bossRow.hidden = mode.value !== 'boss'; });
  const go = el('button', { class: 'primary' }, me && me.job === myJob ? `🧪 วิเคราะห์ ${me.name || 'ตัวละคร'} (สกิล + การ์ด)` : 'คำนวณหาบิลด์ที่ดีที่สุด');
  const res = el('div', { class: 'lab-res' });
  go.onclick = async () => {
    go.disabled = true; res.replaceChildren(el('p', { class: 'hint' }, 'กำลังลองชุดสกิล + Evolution + Trait + ช่องลัด ทั้งคลาส 1 และคลาส 2 ทุกสาย…'));
    const p = labParams();
    lastLab = p;
    try {
      const rr = await dash.invoke('lab-run', p);
      if (rr.fight) p.fightSec = rr.fight.sec; // cards are scored over the same fight length
      renderLab(res, rr);
      // a real character: go straight on to the best cards for the winning build
      if (me && me.job === job.value) { const b = res.querySelector('.lab-card.best .lab-cardbtn[data-goal="' + (mode.value === 'boss' ? 'boss' : 'farm') + '"]'); if (b) b.click(); }
    } catch (e) { res.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    go.disabled = false;
  };
  const labParams = () => {
    const rf = realOf();
    const p = { combos: useCombos.checked, fightMode: win.value, window: win.value === 'sustain' ? 'sustain' : 'sustain', party: +party.value || 1, realSec: rf ? rf.sec : 0, realN: rf ? rf.n : 0, worldSec: ft.world[boss.value] || 0, job: job.value, level: +lv.value, jobLevel: +jlv.value, c2Job: +c2lv.value, c2Points: +c2pts.value, mode: mode.value, pack: +pack.value, packSet: pack.dataset.touched === '1', target: mode.value === 'boss' ? boss.value : '',
      stats: Object.fromEntries(Object.entries(st).map(([k, i]) => [k, +i.value || 0])) };
    if (useGear.checked && hasLo) p.loadout = { ...lo, wRefine: me.wRefine, sRefine: me.sRefine };
    p.realC2 = !c2Full.checked && !!c2Real; // the real class 2 points: the lab adds the levels already put past the top of class 1 skills
    if (useCur.checked && me && me.job === job.value) p.current = { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr || {} };
    if (me && me.job === job.value) p.acc = accId; // the character's own learned per-skill factors (from its real hits)
    if (owned.length) p.owned = owned;
    if (me && me.skills) p.basics = me.skills; // the character's real basic-skill levels (the calculator assumes maxed)
    return p;
  };
  // competition mode: skills -> cards -> skills -> cards for the 2 strongest paths, every hotbar order
  const fullStars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
  const full = el('button', { class: 'primary gold', title: 'หาชุดสกิลที่แรงที่สุดก่อน (ไม่นับการ์ด) แล้วหาการ์ดที่ดีที่สุดให้ชุดสกิลนั้น 2 คลาสที่แรงสุด ใช้เวลา 30–90 วิ' }, '🏆 โหมดแข่ง (ละเอียดสุด)');
  full.onclick = async () => {
    full.disabled = true; go.disabled = true;
    const t = Date.now();
    const tick = setInterval(() => { res.firstChild && (res.firstChild.textContent = `🏆 กำลังหาสกิลก่อน แล้วหาการ์ดให้… ${Math.round((Date.now() - t) / 1000)} วิ (ราว 30–90 วิ)`); }, 1000);
    res.replaceChildren(el('p', { class: 'hint' }, '🏆 กำลังหาสกิลก่อน แล้วหาการ์ดให้…'));
    const p = { ...labParams(), stars: +fullStars.value, goal: mode.value === 'boss' ? 'boss' : 'farm' };
    lastLab = p;
    try {
      const f = await dash.invoke('lab-full', p);
      renderLab(res, { mode: p.mode, target: f.out[0].target, results: f.out.map((o) => o.result), current: f.out[0].current, evals: 0, ms: f.ms, loadout: !!p.loadout, full: true });
      res.querySelectorAll('.lab-card').forEach((cardEl, i) => { const box = cardEl.querySelector('.lab-cards'); if (box && f.out[i]) box.replaceChildren(...cardsView(f.out[i].cards, p.goal)); });
      res.prepend(el('p', { class: 'hint' }, `🏆 โหมดแข่ง: เลือกสกิลที่แรงที่สุดก่อน (ไม่นับการ์ด) แล้วค่อยหาการ์ดให้ชุดสกิลนั้น (การ์ดไม่เปลี่ยนสกิลที่เลือก) · ${(f.ms / 1000).toFixed(0)} วิ · DPS ในการ์ดผลลัพธ์รวมการ์ดชุดนี้แล้ว`));
    } catch (e) { res.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    clearInterval(tick); full.disabled = false; go.disabled = false;
  };
  const comboBtn = el('button', { class: 'tiny', onclick: async () => {
    comboBtn.disabled = true;
    try {
      const list = await dash.invoke('lab-combos');
      const kindName = { region: '🗺 เซ็ตภูมิภาค (การ์ดต่างชนิด ภูมิภาคเดียวกัน)', kin: '🐾 คู่สายพันธุ์ (2 ใบต่างชนิด สายพันธุ์เดียวกัน)', color: '🎨 สีการ์ด (ต้อง ★3 ขึ้นไปทุกใบ)' };
      openModal('📖 คอมโบการ์ดทั้งหมด (จากข้อมูลเกม)', [
        el('p', { class: 'hint' }, 'การ์ดซ้ำชนิดเดียวกันได้ผล 100% / 50% / 25% / 0% · คอมโบนับการ์ดต่างชนิดกัน · ค่าในตารางคือโบนัสคอมโบ (ไม่ขึ้นกับดาว)'),
        ...['region', 'kin', 'color'].map((k) => el('div', {}, el('h4', {}, kindName[k]),
          el('table', { class: 'lab-maps' }, el('tr', {}, ...['คอมโบ', 'ใส่กี่ใบ', 'โบนัส', 'การ์ดที่นับ'].map((h) => el('th', {}, h))),
            ...list.filter((x) => x.kind === k).flatMap((x) => (x.tiers.length ? x.tiers : [{ n: '-', fx: [] }]).map((t, i) => el('tr', {},
              el('td', {}, i ? '' : x.name), el('td', {}, String(t.n)), el('td', {}, t.fx.join(' · ')),
              el('td', { class: 'hint' }, i ? '' : `${x.count} ชนิด: ` + x.members.slice(0, 10).map(labPretty).join(', ') + (x.count > 10 ? ' …' : '')))))))),
      ]);
    } catch (e) { alert(e.message); }
    comboBtn.disabled = false;
  } }, '📖 คอมโบการ์ดทั้งหมด');
  const skillPane = el('div', {}, ...[
    el('p', { class: 'hint' }, 'ใช้สูตรดาเมจของเกมเอง (ตัวเดียวกับหน้าบิลด์แนะนำในเกม) ลองลงแต้มสกิล · Evolution A/B · Trait ของสาย · ลำดับช่องลัด แล้วจัดอันดับ คลาส 1 อย่างเดียว เทียบกับคลาส 2 ทั้งสองสาย'),
    me && me.job === myJob ? el('div', { class: 'lab-real' }, el('b', {}, `📊 ใช้ข้อมูลจริงของ ${me.name || 'ตัวละคร'} (อ่านจากเกมตอนนี้)`),
      el('div', { class: 'hint' }, `${labPretty(me.job)} Lv ${me.level} · Job ${me.jobLevel}${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)} Job ${(me.c2info && me.c2info.jobLevel) || '-'} (${c2Real ? c2Real.pts : 0} แต้ม)` : ''} · ` +
        ['str', 'agi', 'vit', 'int', 'dex', 'luk'].map((k) => `${k.toUpperCase()} ${(me.stats || {})[k] || 0}`).join(' ') +
        ` · เกียร์ ${Object.keys((lo && lo.equip) || {}).length} ชิ้น · การ์ด ${Object.keys((lo && lo.album) || {}).length} ใบ · สกิล ${Object.values(me.skills || {}).filter((v) => v > 0).length} ตัว · Trait ${Object.keys(me.traits || {}).length + Object.keys(me.c2tr || {}).length} สาย`),
      el('div', { class: 'lab-form' }, el('label', {}, 'เป้า ', boss), ftNote)) : null,
    me && me.job === myJob ? el('details', { class: 'lab-adv' }, el('summary', {}, '⚙ สมมติค่าเอง (ไม่ใช่ค่าจริง: ลองเปลี่ยนอาชีพ เลเวล สเตตัส Job เต็ม ฯลฯ)'),
    el('div', { class: 'lab-form' },
      el('label', {}, 'อาชีพ ', job), el('label', {}, 'Lv ', lv), el('label', { title: 'ตามเกม: Job คลาส 1 สูงสุด 50 · แต้มสกิลเต็ม' }, c1Full, ' คลาส 1 Job เต็ม'), el('label', {}, 'Job Lv ', jlv),
      el('label', { title: 'ตามเกม: Job คลาส 2 สูงสุด 50 ได้แต้มรวม 70 (ใช้ร่วมกันทั้งสองสาย)' }, c2Full, ' คลาส 2 Job เต็ม (Lv 50 · 70 แต้ม)'),
      el('label', {}, 'Job คลาส 2 ', c2lv), el('label', { title: c2Real ? 'เอาติ๊ก "Job เต็ม" ออกเพื่อใช้ค่าของตัวละคร' : 'แต้มคลาส 2 ทั้งหมด (สูงสุด 70)' }, 'แต้มคลาส 2 ', c2pts),
      el('div', { class: 'lab-stats' }, ...Object.entries(st).map(([k, i]) => el('label', {}, k.toUpperCase() + ' ', i))),
      el('label', {}, 'โหมด ', mode), bossRow, packRow,
      el('label', { title: 'นับคอมโบตามกลไกเกม: เป้าติดสถานะ (สโลว์/ตรึง/หนาว กับเกียร์-การ์ด-สกิลที่แรงขึ้น), Hunter\'s Mark ของ Scout, Chill → Shatter ของ Mage' }, useCombos, ' นับคอมโบ (สถานะ · Mark · Shatter)'),
      me ? el('label', {}, useCur, ' เทียบกับบิลด์ปัจจุบันของตัวละคร') : null,
      el('label', { title: hasLo ? 'อาวุธ/ชุด/ตีบวก/affix และการ์ดที่ใส่อยู่ จากเกม' : 'เปิดเกมของบัญชีนี้ก่อน (ต้องเข้าเกมแล้ว) จึงจะอ่านเกียร์และการ์ดได้' }, useGear,
        hasLo ? ` ใส่เกียร์ ${Object.keys(lo.equip || {}).length} ชิ้น + การ์ด ${Object.keys(lo.album || {}).length} ใบของตัวละคร (แม่นขึ้น)` : ' ใส่เกียร์+การ์ดของตัวละคร (ต้องเปิดเกมบัญชีนี้)'),
      me ? el('small', { class: 'hint' }, ` · มีการ์ด ${owned.length} ชนิด${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)}` : ''}`) : null)) : null,
    me && me.job === myJob ? null : el('div', { class: 'lab-form' },
      el('label', {}, 'อาชีพ ', job), el('label', {}, 'Lv ', lv), el('label', { title: 'ตามเกม: Job คลาส 1 สูงสุด 50 · แต้มสกิลเต็ม' }, c1Full, ' คลาส 1 Job เต็ม'), el('label', {}, 'Job Lv ', jlv),
      el('label', { title: 'ตามเกม: Job คลาส 2 สูงสุด 50 ได้แต้มรวม 70 (ใช้ร่วมกันทั้งสองสาย)' }, c2Full, ' คลาส 2 Job เต็ม (Lv 50 · 70 แต้ม)'),
      el('label', {}, 'Job คลาส 2 ', c2lv), el('label', { title: c2Real ? 'เอาติ๊ก "Job เต็ม" ออกเพื่อใช้ค่าของตัวละคร' : 'แต้มคลาส 2 ทั้งหมด (สูงสุด 70)' }, 'แต้มคลาส 2 ', c2pts),
      el('div', { class: 'lab-stats' }, ...Object.entries(st).map(([k, i]) => el('label', {}, k.toUpperCase() + ' ', i))),
      el('label', {}, 'โหมด ', mode), bossRow, packRow,
      el('label', { title: 'นับคอมโบตามกลไกเกม: เป้าติดสถานะ (สโลว์/ตรึง/หนาว กับเกียร์-การ์ด-สกิลที่แรงขึ้น), Hunter\'s Mark ของ Scout, Chill → Shatter ของ Mage' }, useCombos, ' นับคอมโบ (สถานะ · Mark · Shatter)'),
      me ? el('label', {}, useCur, ' เทียบกับบิลด์ปัจจุบันของตัวละคร') : null,
      el('label', { title: hasLo ? 'อาวุธ/ชุด/ตีบวก/affix และการ์ดที่ใส่อยู่ จากเกม' : 'เปิดเกมของบัญชีนี้ก่อน (ต้องเข้าเกมแล้ว) จึงจะอ่านเกียร์และการ์ดได้' }, useGear,
        hasLo ? ` ใส่เกียร์ ${Object.keys(lo.equip || {}).length} ชิ้น + การ์ด ${Object.keys(lo.album || {}).length} ใบของตัวละคร (แม่นขึ้น)` : ' ใส่เกียร์+การ์ดของตัวละคร (ต้องเปิดเกมบัญชีนี้)'),
      me ? el('small', { class: 'hint' }, ` · มีการ์ด ${owned.length} ชนิด${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)}` : ''}`) : null),
    me ? measureBox(accId, me, () => ({ ...labParams(), job: me.job, level: me.level, jobLevel: me.jobLevel, current: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr || {} } })) : null,
    el('div', { class: 'lab-row' }, go, full, el('small', { class: 'hint' }, ' ดาวการ์ด (โหมดแข่ง ถ้าไม่ใช้เฉพาะที่มี) '), fullStars, comboBtn), res,
    el('p', { class: 'hint' }, 'ติ๊ก "ใส่เกียร์+การ์ด" เพื่อให้ตัวเลขใกล้ของจริง · เทียบความแม่นได้ที่ห้องฝึก: เลือกเป้า "หุ่นฟางห้องฝึก" แล้วดู DPS ของ "บิลด์ปัจจุบัน" เทียบ DPS Meter (เปิด AUTO ตีหุ่น 1 นาที) · สเตตัสใช้ของตัวละครที่เลือก แก้ได้ · คลาส 2 คิดแบบ Job เต็ม (Lv 50 · 70 แต้ม ตามเกม) ถ้าอยากใช้ค่าจริงของตัวละครให้เอาติ๊กออก'),
  ].filter(Boolean));

  // ---- tab: cards from the character's own collection (equipped + bag), for its current skill build ----
  const cardPane = el('div', { hidden: '' });
  const livePane = el('div', { hidden: '' });
  if (me) {
    const cGoal = el('select', {}, el('option', { value: 'boss' }, '👑 DPS ตีบอส'), el('option', { value: 'gold' }, '💰 ฟาร์มเงิน (การ์ด Gold/ดรอป)'));
    const cBoss = el('select', {}, ...[...boss.options].map((o) => el('option', { value: o.value }, o.textContent)));
    const cMine = el('input', { type: 'checkbox', checked: owned.length ? '' : null, disabled: owned.length ? null : '' });
    const cNoCrit = el('input', { type: 'checkbox' });
    const cDup = el('input', { type: 'checkbox' });
    const cStars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
    const cOut = el('div', {});
    const cGo = el('button', { class: 'primary' }, owned.length ? `🃏 จัดการ์ดจาก ${owned.length} ชนิดที่มี` : '🃏 จัดการ์ด');
    cGo.onclick = async () => {
      cGo.disabled = true; cOut.replaceChildren(el('p', { class: 'hint' }, 'กำลังอ่านตัวละครล่าสุดและลองการ์ดทุกคอมโบ…'));
      const meNow = (await dash.invoke('lab-me', accId)) || me;
      const q = { job: meNow.job, level: meNow.level, jobLevel: meNow.jobLevel, stats: meNow.stats, c2Job: (meNow.c2info && meNow.c2info.jobLevel) || 50, c2Points: meNow.c2 ? Object.entries(meNow.skills || {}).filter(([k]) => k.startsWith(meNow.c2 + '_')).reduce((t, [, v]) => t + v, 0) + ((meNow.c2info && meNow.c2info.points) || 0) : 0, guild: meNow.guildLevel || 0, basics: meNow.skills, mode: cGoal.value === 'boss' ? 'boss' : 'farm', pack: +pack.value || 4, packSet: pack.dataset.touched === '1',
        target: cGoal.value === 'boss' ? cBoss.value : '', goal: cGoal.value, stars: +cStars.value, combos: true, acc: accId,
        loadout: { ...(meNow.loadout || {}), wRefine: meNow.wRefine, sRefine: meNow.sRefine },
        build: { skills: meNow.skills, evo: meNow.evo, traits: meNow.traits, c2tr: meNow.c2tr || {}, hotbar: [], c2: meNow.c2 || '' } };
      if (cMine.checked && meNow.ownedCards && meNow.ownedCards.length) q.owned = meNow.ownedCards;
      if (cNoCrit.checked) q.noCrit = true;
      if (cDup.checked) q.allowDup = true;
      try { cOut.replaceChildren(...cardsView(await dash.invoke('lab-cards', q), q.goal)); } catch (e) { cOut.replaceChildren(el('p', {}, '✖ ' + e.message)); }
      cGo.disabled = false;
    };
    cardPane.append(
      el('p', { class: 'hint' }, 'จัดการ์ดให้บิลด์สกิลที่ตัวละครใช้อยู่ตอนนี้ (อ่านจากเกมทุกครั้งที่กด) · ใช้เฉพาะการ์ดที่มีจริง (ที่ใส่อยู่ + ในกระเป๋า) จำนวนและดาวตามจริง · รวมเกียร์และ affix ที่ใส่อยู่'),
      el('div', { class: 'lab-form' }, el('label', {}, 'เป้าหมาย ', cGoal), el('label', {}, 'เป้า ', cBoss),
        el('label', {}, cMine, ` เฉพาะการ์ดที่มี (${owned.length} ชนิด)`), el('label', {}, cNoCrit, ' ไม่เอาการ์ดคริ'), el('label', { title: 'เกมนับการ์ดใบเดียวกัน ใบที่ 2 ได้ 50% ใบที่ 3 ได้ 25% ใบที่ 4 ไม่ได้อะไร และไม่นับเข้าเซ็ต' }, cDup, ' ใส่การ์ดซ้ำได้'), el('label', {}, 'ดาว (ถ้าใช้ทุกใบในเกม) ', cStars)),
      cGo, cOut);

    // ---- tab: the character as it is right now, re-read every 10 s ----
    const lBoss = el('select', {}, ...[...boss.options].map((o) => el('option', { value: o.value }, o.textContent)));
    const lOut = el('div', {}); let lPrev = null; let lTimer = null;
    const lTick = async () => {
      if (livePane.hidden || $('#modal').hidden) return;
      const m2 = await dash.invoke('lab-me', accId); if (!m2) { lOut.replaceChildren(el('p', {}, 'ตัวละครไม่ได้ออนไลน์')); return; }
      let pr; try { pr = await dash.invoke('lab-predict', { weights: true, job: m2.job, level: m2.level, jobLevel: m2.jobLevel, stats: m2.stats, basics: m2.skills, target: lBoss.value, guild: m2.guildLevel || 0, c2Job: (m2.c2info && m2.c2info.jobLevel) || 50, acc: accId, loadout: { ...(m2.loadout || {}), wRefine: m2.wRefine, sRefine: m2.sRefine }, current: { skills: m2.skills, evo: m2.evo, traits: m2.traits, c2: m2.c2, c2tr: m2.c2tr || {} } }); } catch (e) { lOut.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
      const d = lPrev ? pr.withCombos - lPrev : 0; lPrev = pr.withCombos;
      // the real damage per second the character is doing right now (its own hits over the last minute)
      let det = null; try { det = await dash.invoke('detail', accId); } catch { det = null; }
      const realNow = det && det.rates ? Math.round(det.rates.dpsNow || 0) : 0;
      const calcNow = (pr.calib && pr.calib.withCombos) || pr.packDps || pr.withCombos;
      const tgt = det && det.stats ? (det.stats.target || '') : '';
      const sh = pr.sheet || {};
      lOut.replaceChildren(...[
        pr.useless && pr.useless.length ? el('div', { class: 'hint warnline' }, `⚠ แต้มที่ไม่เพิ่มดาเมจตอนตีบอส: ${pr.useless.map((x) => `${x.name} ${x.points} แต้ม (${x.why || 'ไม่เพิ่มดาเมจ'})`).join(' · ')} · ย้ายไปลงสกิลที่ใช้ตีได้ (ดูผล "หาบิลด์" ด้านล่าง) · ถ้าเป็นสกิลเอาตัวรอด (HP/ป้องกัน) อาจตั้งใจเก็บไว้`) : null,
        el('div', { class: 'lab-row' }, el('b', { class: 'lab-score' }, `DPS ตอนนี้ ${num(pr.withCombos)}`), el('small', { class: 'hint' }, ` · ไม่รวมคอมโบ ${num(pr.dps)} · เป้า ${labPretty(pr.target.id)}${pr.packDps ? ` · ตีทั้งฝูง ${pr.pack} ตัว ≈ ${num(pr.packDps)}` : ''}`),
          d ? el('span', { class: 'chip ' + (d > 0 ? 'ok' : 'warnc') }, `${d > 0 ? '▲' : '▼'} ${num(Math.abs(d))} จากรอบก่อน`) : null, el('small', { class: 'hint' }, ` · อ่านเมื่อ ${new Date().toLocaleTimeString('th-TH')}`)),
        el('div', { class: 'lab-row lab-realnow' }, el('b', {}, realNow ? `⚔ ตีจริงตอนนี้ ${num(realNow)}/วิ` : '⚔ ตีจริงตอนนี้: ยังไม่ได้ตีใน 1 นาทีล่าสุด'),
          el('small', { class: 'hint' }, realNow ? ` · ดาเมจของตัวเองใน 1 นาทีล่าสุด (รวมทุกตัวที่โดน และช่วงเดิน/ไม่ได้ตี)${tgt ? ' · กำลังตี ' + tgt : ''} · เทียบที่คำนวณ ${num(calcNow)} = ${Math.round(realNow / Math.max(1, calcNow) * 100)}%` : ' · เปิด AUTO ให้ตีสักพัก ตัวเลขจริงจะขึ้นที่นี่')),
        pr.calib ? el('div', { class: 'lab-row' }, el('span', { class: 'chip ok' }, `ปรับตามดาเมจจริงของตัวละครนี้ ≈ ${num(pr.calib.withCombos)} DPS`), el('small', { class: 'hint' }, ` · ${pr.calib.kind === 'world' ? 'บอสโลก' : 'มอนทั่วไป'}: ดาเมจต่อฮิตจริง ×${pr.calib.k} ของสูตรเกม (รวมคริ)${pr.calib.d ? ` · DPS รวมจริง ×${pr.calib.d}` : ''} · จาก ${pr.calib.runs} รอบบันทึก · การจัดอันดับบิลด์ใช้สูตรเกม`)) : null,
        el('div', { class: 'lab-row' }, ...[['ATK', sh.atk], ['MATK', sh.matk], ['Spell Amp', sh.spellAmp, '%'], ['ลดคูลดาวน์', sh.cdr, '%'], ['ร่ายเร็ว', sh.castSpd, '%'], ['คริ', sh.crit, '%'], ['ดาเมจคริ', sh.critDmg, '%'], ['เจาะเกราะ', sh.armorPen, '%']].filter((x) => x[1] != null).map(([l, v, u]) => el('span', { class: 'chip' }, `${l} ${Number.isInteger(v) ? num(v) : v}${u || ''}`))),
        pr.weights && pr.weights.length ? el('div', { class: 'lab-row' }, el('small', {}, '📈 ควรเพิ่มอะไรต่อ (ตัวละครตอนนี้ หักเพดานเกมแล้ว): '), ...pr.weights.map((w) => el('span', { class: 'chip' + (w.gain > 0.05 ? ' ok' : ''), title: w.note || '' }, `${w.label} → ${w.gain > 0 ? '+' : ''}${w.gain}%`))) : null,
        comboBox(pr.combos) || el('span'),
        el('table', { class: 'lab-maps' }, el('tr', {}, el('th', {}, 'สกิล'), el('th', {}, 'DPS'), el('th', {}, '%')),
          ...pr.perSkill.map((x) => el('tr', {}, el('td', {}, x.name), el('td', {}, num(x.dps)), el('td', {}, pr.dps ? Math.round(x.dps / pr.dps * 100) + '%' : '-')))),
        el('div', { class: 'lab-row' }, el('small', {}, 'เกียร์: '), ...pr.gear.map((g) => el('span', { class: 'chip', title: g.affixes.join(', ') }, `${g.slot}: ${labPretty(g.id)}${g.refine ? ' +' + g.refine : ''}${g.affixes.length ? ` · ${g.affixes.length} affix` : ''}`))),
        el('div', { class: 'lab-row' }, el('small', {}, 'การ์ดที่ใส่: '), ...(pr.cards.length ? pr.cards.map((c) => el('span', { class: 'chip' }, `${labPretty(c.id)} ${'★'.repeat(c.star)}`)) : [el('small', { class: 'hint' }, 'ไม่มี')])),
        el('p', { class: 'hint' }, 'อ่านเกียร์ affix ตีบวก การ์ด สเตตัส สกิล Evolution ของตัวละครจากเกมทุก 10 วิ แล้วคำนวณใหม่ · เปลี่ยนของในเกมแล้วดูตัวเลขขยับได้ทันที')].filter(Boolean));
    };
    lBoss.addEventListener('change', () => { lPrev = null; lTick(); });
    livePane.append(el('div', { class: 'lab-form' }, el('label', {}, 'เป้า ', lBoss)), lOut, abBox(accId));
    livePane.start = () => { lTick(); clearInterval(lTimer); lTimer = setInterval(() => { if ($('#modal').hidden) { clearInterval(lTimer); return; } lTick(); }, 10000); };
  } else {
    cardPane.append(el('p', { class: 'hint' }, 'เลือกตัวละครที่ออนไลน์อยู่ เพื่อจัดการ์ดจากการ์ดที่มี'));
    livePane.append(el('p', { class: 'hint' }, 'เลือกตัวละครที่ออนไลน์อยู่เพื่อดูบิลด์ปัจจุบันแบบสด'));
  }
  const tabs = me ? [['live', '📡 บิลด์ตอนนี้ (สด)', livePane], ['skills', '🧪 หาบิลด์สกิล', skillPane], ['cards', '🃏 จัดการ์ด', cardPane]] : [['skills', '🧪 สกิล', skillPane], ['cards', '🃏 การ์ด', cardPane], ['live', '📡 บิลด์ปัจจุบัน (สด)', livePane]];
  const tabBar = el('div', { class: 'lab-tabs' }, ...tabs.map(([k, label, pane]) => el('button', { class: 'tab' + (k === tabs[0][0] ? ' on' : ''), 'data-k': k, onclick: (e) => {
    for (const [, , p2] of tabs) p2.hidden = p2 !== pane;
    for (const t of tabBar.children) t.classList.toggle('on', t === e.currentTarget);
    if (pane === livePane && livePane.start) livePane.start();
  } }, label)));
  out.replaceChildren(
    el('div', { class: 'lab-form' }, el('label', { title: 'ตัวละครที่ออนไลน์อยู่ · อ่านเลเวล สเตตัส สกิล คลาส 2 เกียร์ และการ์ดจากเกม' }, '👤 ตัวละคร ', accSel),
      me && !jobs.some((j) => j.id === me.job) ? el('small', { class: 'hint' }, `(${labPretty(me.job)} ยังไม่มีอาชีพคลาส 1 · เลือกอาชีพเพื่อจำลอง)`) : null),
    tabBar, skillPane, cardPane, livePane);
  // a real character: the live view first (what it does right now, re-read every 10 s); the others on their tab
  if (me) { skillPane.hidden = true; cardPane.hidden = true; livePane.hidden = false; if (livePane.start) livePane.start(); }
}

// real test: measure this character's own damage for 60 s (training dummy) and compare with the prediction
// real A/B test: measure the build as it is (A), change one thing in the game, measure again (B);
// the minute-by-minute spread decides whether the difference is real
function abBox(accId) {
  const mins = el('select', {}, ...[5, 10, 15, 20, 30].map((m) => el('option', { value: String(m), selected: m === 10 ? '' : null }, `${m} นาที`)));
  const label = el('input', { type: 'text', placeholder: 'เปลี่ยนอะไร เช่น ย้ายแต้ม Smite → Martyrdom', style: 'width:280px;max-width:60vw' });
  const out = el('div', { class: 'hint' }, 'ยังไม่ได้เริ่ม');
  let timer = null;
  const fmtP = (x, name) => (x ? `${name}: ${x.minutes}/${x.of} นาที · DPS ${num(x.dps)}${x.se ? ` ±${num(x.se)}` : ''} · ฆ่า ${x.killsPerMin}/นาที · ${labPretty(x.mob || '-')} @ ${x.map}${x.label ? ` · ${x.label}` : ''}` : `${name}: -`);
  const show = async () => {
    const r = await dash.invoke('ab-get', accId);
    if (!r) return;
    out.replaceChildren(el('div', {}, fmtP(r.A, 'A (แบบเดิม)')), el('div', {}, fmtP(r.B, 'B (แบบใหม่)')),
      r.verdict ? el('div', { class: r.verdict.same && r.verdict.says.startsWith('ดีขึ้น') ? 'pos' : r.verdict.says.startsWith('แย่ลง') ? 'neg' : '' }, el('b', {}, `ผล: ${r.verdict.pct > 0 ? '+' : ''}${r.verdict.pct}% (ความแกว่ง ±${r.verdict.noisePct}%) · ${r.verdict.says}`))
        : el('div', {}, r.phase ? `⏱ กำลังวัด ${r.phase} · ตีตามปกติ (เปิด AUTO ที่แมพเดิม มอนเดิม)` : 'ต้องมีข้อมูลอย่างน้อย 3 นาทีที่ได้ตีทั้ง A และ B'));
    if (!r.phase && timer && r.A && (r.B || r.A.minutes >= r.A.of)) { /* keep showing */ }
  };
  const start = async (phase) => {
    const r = await dash.invoke('ab-start', accId, phase, +mins.value, label.value);
    if (!r || !r.ok) { out.textContent = (r && r.error) || 'เริ่มไม่ได้'; return; }
    clearInterval(timer); timer = setInterval(() => { if ($('#modal').hidden) { clearInterval(timer); return; } show(); }, 5000); show();
  };
  return el('div', { class: 'lab-card' },
    el('div', { class: 'lab-top' }, el('b', {}, '🔬 ทดลองจริง (A/B): ให้เกมตัดสินว่าเปลี่ยนแล้วดีขึ้นจริงไหม')),
    el('p', { class: 'hint' }, '① กด "วัดแบบเดิม" แล้วฟาร์มตามปกติจนครบเวลา ② เปลี่ยนในเกม 1 อย่าง (แต้มสกิล ช่องลัด การ์ด) ③ กด "วัดแบบใหม่" ที่แมพเดิม มอนเดิม · โปรแกรมเทียบ DPS ช่วงที่ตีอยู่ทีละนาที แล้วบอกว่าต่างจริงหรือแค่แกว่ง'),
    el('div', { class: 'lab-row' }, el('label', {}, 'วัดนาน ', mins), label),
    el('div', { class: 'lab-row' }, el('button', { class: 'primary', onclick: () => start('A') }, '① วัดแบบเดิม (A)'), el('button', { class: 'primary', onclick: () => start('B') }, '② เปลี่ยนแล้ว วัดแบบใหม่ (B)'), el('button', { onclick: async () => { await dash.invoke('ab-stop', accId); show(); } }, '■ หยุดวัด')),
    out);
}
function measureBox(accId, me, params) {
  const out = el('div', { class: 'lab-cards' });
  const secs = el('select', {}, ...[30, 60, 120].map((n) => el('option', { value: String(n), selected: n === 60 ? '' : null }, n + ' วิ')));
  let timer = null;
  const go = el('button', { class: 'tiny', onclick: async () => {
    const st = await dash.invoke('measure-start', accId, +secs.value);
    if (!st.ok) { out.replaceChildren(el('p', {}, '✖ ' + st.error)); return; }
    go.disabled = true;
    out.replaceChildren(el('p', { class: 'hint' }, 'พร้อมวัด · เริ่มตีหุ่นฟางได้เลย (เปิด AUTO ก็ได้) · นับจากดาเมจแรก'));
    clearInterval(timer);
    timer = setInterval(async () => {
      const m = await dash.invoke('measure-get', accId);
      if (!m) return;
      if (!m.done) { out.firstChild.textContent = m.started ? `⏱ กำลังวัด ${m.secs}/${m.sec} วิ · DPS ตอนนี้ ${num(m.dps)} · ${m.hits} ฮิต` : 'พร้อมวัด · เริ่มตีหุ่นฟางได้เลย (เปิด AUTO ก็ได้) · นับจากดาเมจแรก'; return; }
      clearInterval(timer); go.disabled = false;
      const mob = Object.entries(m.mobs).sort((a, b) => b[1] - a[1])[0];
      const p = { ...params(), target: mob ? mob[0] : 'training_dummy' };
      let pr = null; try { pr = await dash.invoke('lab-predict', p); } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
      const diff = pr.dps ? Math.round((m.dps / pr.dps - 1) * 1000) / 10 : 0;
      const rows = new Set([...Object.keys(m.perSkill), ...pr.perSkill.map((x) => x.sid)]);
      out.replaceChildren(
        el('div', { class: 'lab-row' }, el('b', {}, `🎯 ของจริง ${num(m.dps)} DPS`), el('span', { class: 'chip' }, `Build Lab คาด ${num(pr.dps)}`),
          el('span', { class: 'chip ' + (Math.abs(diff) <= 5 ? 'ok' : 'warnc') }, `ต่าง ${diff > 0 ? '+' : ''}${diff}%`),
          el('small', { class: 'hint' }, ` · เป้า ${labPretty(pr.target.id)} · ${m.secs} วิ · ${m.hits} ฮิต (คริ ${m.crits})${m.pet ? ` · สัตว์เลี้ยง/อัญเชิญ ${num(Math.round(m.pet / m.secs))}/วิ (ไม่นับ)` : ''}`)),
        el('table', { class: 'lab-maps' }, el('tr', {}, ...['สกิล', 'ของจริง /วิ', 'คาด /วิ'].map((h) => el('th', {}, h))),
          ...[...rows].map((sid) => { const real = Math.round((m.perSkill[sid] || 0) / m.secs); const exp = (pr.perSkill.find((x) => x.sid === sid) || {}).dps || 0;
            return el('tr', {}, el('td', {}, sid === 'basic' ? 'โจมตีปกติ' : pr.names[sid] || labPretty(sid)), el('td', {}, num(real)), el('td', {}, num(exp))); })),
        el('p', { class: 'hint' }, `ลำดับกดที่ Build Lab คิด: ${pr.hotbar.join(' > ')} · ถ้าในเกมจัดช่องลัดต่างไป ดาเมจต่อสกิลจะต่างตาม · ต่างไม่เกิน ±5% ถือว่าตรง`));
    }, 1000);
  } }, '🎯 เริ่มวัด DPS จริง');
  return el('div', { class: 'lab-measure' },
    el('div', { class: 'lab-row' }, el('b', {}, '🎯 ทดสอบกับตัวละครจริง: '), go, secs,
      el('small', { class: 'hint' }, ' ไปห้องฝึก (Portal ข้างรูปปั้นวาร์ปในเมือง) แล้วตีหุ่นฟาง · หุ่นมุมล่างมีค่าป้องกันเท่า Pearlheart Titan')),
    out);
}

// card result: the cards, what each adds, combos on and one card away
function cardsView(r, goal) {
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%` : '');
  return [
        el('div', { class: 'lab-row' }, el('b', {}, `${{ boss: '👑 การ์ด DPS ตีบอส', farm: '🌾 การ์ด DPS ฟาร์ม', gold: '💰 การ์ดฟาร์มเงิน' }[goal]} · ${r.magic ? 'สายเวท' : 'สายกายภาพ'}`),
          el('small', { class: 'hint' }, ` · ${r.cards.length}/${r.slots} ช่อง · Spirit Load ${r.load}/${r.cap} · ${r.owned ? `จากการ์ดที่มี ${r.poolSize} ชนิด` : 'จากการ์ดทุกใบในเกม ' + '★'.repeat(r.star)} · เป้า ${labPretty(r.target.id)} Lv ${r.target.level}`)),
        r.now ? el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, `การ์ดที่ใส่อยู่ตอนนี้: DPS ${num(r.now.dps)}${r.now.gold ? ` · Gold +${r.now.gold}%` : ''} → ชุดใหม่ ${num(r.after.dps)} (${pct(r.after.dps, r.now.dps)})`)) : null,
        el('div', { class: 'lab-row' }, el('span', { class: 'chip' }, `DPS ${num(r.before.dps)} → ${num(r.after.dps)} (${pct(r.after.dps, r.before.dps)})`),
          r.after.gold ? el('span', { class: 'chip' }, `Gold +${r.after.gold}%`) : null, r.after.drop ? el('span', { class: 'chip' }, `Drop +${r.after.drop}%`) : null,
          r.seeds ? el('small', { class: 'hint' }, ` · ลอง ${r.seeds} จุดเริ่ม (ทุกคอมโบ) ${num(r.evals)} แบบ`) : null),
    r.caps ? (() => { const c = r.caps; const t = [];
      if (c.crit != null && c.crit >= 99.5) t.push('คริเต็ม 100% แล้ว: การ์ดโอกาสคริไม่มีผล');
      else if (c.crit != null && c.crit >= 90) t.push(`คริ ${c.crit}% ใกล้เต็ม 100%: การ์ดคริได้ผลแค่ถึง 100%`);
      if (c.cdr != null && c.cdr >= 42) t.push(`ลด CD ${c.cdr}% เลยจุดลดผล 42% แล้ว: ใส่เพิ่มได้ผลแค่ 40% (เต็มที่ 75%)`);
      if (c.armorPen != null && c.armorPen >= 50) t.push(`เจาะเกราะ ${c.armorPen}% เลยจุดลดผล 50% แล้ว`);
      return t.length ? el('div', { class: 'hint warnline' }, '📏 เพดานของเกม (ตัวคำนวณหักให้แล้ว): ' + t.join(' · ')) : null; })() : null,
    r.compare && r.compare.base ? el('div', { class: 'hint' }, `⚖ เทียบทั้งชุด (ดาเมจเพิ่มจากไม่ใส่การ์ด): เน้นเซ็ต +${Math.round((r.compare.sets / r.compare.base - 1) * 100)}% · การ์ดดาเมจตรงสายล้วน +${Math.round((r.compare.direct / r.compare.base - 1) * 100)}% (สลับปรับแล้ว +${Math.round((r.compare.directTuned / r.compare.base - 1) * 100)}%) → เลือก${r.compare.pick === 'direct' ? 'การ์ดตรงสาย' : 'ชุดที่มีเซ็ต'} เพราะดาเมจรวมสูงกว่า`) : null,
    r.sets && r.sets.length ? el('div', { class: 'lab-row' }, el('small', {}, '🔗 คอมโบที่ติด: '), ...r.sets.map((t) => el('span', { class: 'chip combo ' + t.kind, title: t.fx.join(' · ') }, `${t.name} ${t.count} ใบ: ${t.fx.join(', ')}`))) : null,
    r.near && r.near.length ? el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, 'ขาดอีก 1 ใบ: '), ...r.near.map((t) => el('span', { class: 'chip dim' }, `${t.name} ${t.count}/${t.need}`))) : null,
        el('div', { class: 'lab-cardlist' }, ...r.cards.map((c, i) => el('div', { class: 'lab-card1' },
          el('b', {}, `${i + 1}. ${labPretty(c.id)}`), el('small', { class: 'hint' }, ` ${'★'.repeat(c.star || 1)} · ${c.role || ''} Lv ${c.level} · Load ${c.load}`),
          el('div', { class: 'hint' }, ...c.fx.flatMap((t, j) => { const gn = (c.lineGain || [])[j]; const dead = gn != null && gn <= 0.05; return [j ? ' · ' : '', el('span', { class: dead ? 'fx-dead' : '', title: gn == null ? '' : dead ? 'ค่านี้ไม่เพิ่มดาเมจของบิลด์นี้ (ลองเอาออกในตัวคำนวณของเกมแล้วดาเมจเท่าเดิม)' : 'ถ้าเอาค่านี้ออก ดาเมจลดลงเท่านี้' }, gn == null ? t : dead ? `${t} (ไม่มีผล)` : `${t} (+${gn}%)`)]; })),
          c.why && c.why.set && (c.lineGain || []).length && (c.lineGain || []).every((g) => g <= 0.05)
            ? el('div', { class: 'why' }, `🔗 ใส่เพื่อเติมเซ็ต ${c.why.set} เท่านั้น${(() => { const t = (r.sets || []).find((z) => c.why.set.startsWith(z.name)); return t ? ` (เซ็ตให้ ${t.fx.join(', ')})` : ''; })()} · ตัวการ์ดเองไม่เพิ่มดาเมจ แต่ถอดแล้วเสียเซ็ต DPS −${c.why.pct}% · เปลี่ยนเป็นการ์ดใบอื่นทีละใบแล้วไม่มีใบไหนได้ดีกว่า`)
            : null,
          c.why && !(c.why.set && (c.lineGain || []).length && (c.lineGain || []).every((g) => g <= 0.05)) ? el('div', { class: 'why' }, `${goal === 'gold' ? 'คะแนน' : 'DPS'} +${c.why.pct}%${c.why.pctGame != null && goal !== 'gold' ? ` (เครื่องคิดเลขเกม +${c.why.pctGame}% · ส่วนที่โปรแกรมประมาณเพิ่ม ${c.why.pct - c.why.pctGame >= 0 ? '+' : ''}${Math.round((c.why.pct - c.why.pctGame) * 10) / 10}%)` : ''}${c.why.skill ? ` · ช่วย ${c.why.skill} มากสุด${c.why.skillPct ? ` (+${c.why.skillPct}%)` : ''}` : ''}${c.why.set ? ` · ทำให้ครบเซ็ต ${c.why.set}` : ''}`) : null,
          c.proc ? el('div', { class: 'hint' }, '⚠ มีเอฟเฟกต์พิเศษ (proc) ที่เครื่องคิดเลขของเกมคิดแบบเฉลี่ย') : null))),
        el('p', { class: 'hint' }, goal === 'gold' ? 'คะแนนฟาร์มเงิน = ความเร็วฆ่ามอน × (1 + Gold%) × (1 + Drop%/2) · การ์ด slayer(ชนิด) แรงเฉพาะมอนชนิดนั้น (จัดตามเป้าด้านบน) ถ้าฟาร์มแมพอื่นให้เปลี่ยนเป็นการ์ดเพิ่ม ATK/MATK/INT/STR แทน' : 'จัดจากเครื่องคิดเลขของเกม (ตัวเดียวกับหน้าคำนวณดาเมจใน wiki) รวมโบนัสเซ็ตภูมิภาค · "ช่วยสกิลไหน" = สกิลที่ดาเมจหายมากสุดถ้าถอดใบนั้น · ค่าการ์ดตามดาวที่เลือก (wiki แสดง ★1) · ไม่รวมการ์ดบอสโลก')
  ].filter(Boolean);
}

// card build for one Build Lab result: best cards for boss DPS, farm DPS or gold farming
function cardBox(x) {
  const out = el('div', { class: 'lab-cards' });
  const stars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
  const hasOwned = !!(lastLab && lastLab.owned && lastLab.owned.length);
  const onlyMine = el('input', { type: 'checkbox', checked: hasOwned ? '' : null, disabled: hasOwned ? null : '' });
  const noCrit = el('input', { type: 'checkbox' });
  const allowDup = el('input', { type: 'checkbox' });
  const run = async (goal, btn) => {
    for (const b of out.parentNode.querySelectorAll('.lab-cardbtn')) b.disabled = true;
    out.replaceChildren(el('p', { class: 'hint' }, 'กำลังลองการ์ดทุกใบในเกม ตามช่องที่เปิดและ Spirit Load…'));
    try {
      const q = { ...lastLab, build: x.build, goal, stars: +stars.value };
      if (!onlyMine.checked) delete q.owned;
      if (noCrit.checked) q.noCrit = true;
      if (allowDup.checked) q.allowDup = true;
      const r = await dash.invoke('lab-cards', q);
      out.replaceChildren(...cardsView(r, goal));
      // magic build that got crit cards: say why, and work out the same search without them to compare
      if (r.magic && r.critCards.length && !q.noCrit) {
        const why = r.sureCrit.length
          ? `สกิลเวทปกติไม่คริ (ใช้ Spell Amp แทน) · การ์ดคริช่วยเฉพาะ ${r.sureCrit.join(', ')} ที่เกมบอกว่า "คริแน่นอน" (ดาเมจ × 1 + (ดาเมจคริ − 1) × 0.6)`
          : 'สกิลเวทปกติไม่คริ (ใช้ Spell Amp แทน) · การ์ดคริในชุดนี้ช่วยโจมตีปกติและค่าอื่นของการ์ด (เช่น ดาเมจใส่บอส)';
        const cmp = el('div', { class: 'lab-crit' }, el('div', {}, '💡 ' + why), el('div', { class: 'hint' }, 'กำลังลองชุดที่ไม่มีการ์ดคริเทียบ…'));
        out.insertBefore(cmp, out.children[2] || null);
        try {
          const r2 = await dash.invoke('lab-cards', { ...q, noCrit: true });
          const d = r.after.dps ? Math.round((r2.after.dps / r.after.dps - 1) * 1000) / 10 : 0;
          cmp.lastChild.replaceWith(el('div', {}, `ถ้าไม่ใส่การ์ดคริ: DPS ${num(r2.after.dps)} (${d > 0 ? '+' : ''}${d}%) · ใช้ ${r2.cards.map((c) => labPretty(c.id)).join(', ')}`,
            el('button', { class: 'tiny', onclick: () => out.replaceChildren(...cardsView(r2, goal)) }, 'ดูชุดนี้')));
        } catch { cmp.lastChild.textContent = ''; }
      }
    } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    for (const b of out.parentNode.querySelectorAll('.lab-cardbtn')) b.disabled = false;
  };
  return el('div', {},
    el('div', { class: 'lab-row' }, el('small', {}, '🃏 จัดการ์ดให้บิลด์นี้: '),
      el('button', { class: 'tiny lab-cardbtn', 'data-goal': 'boss', onclick: (e) => run('boss', e.target) }, '👑 DPS ตีบอส'),
      el('button', { class: 'tiny lab-cardbtn', 'data-goal': 'gold', onclick: (e) => run('gold', e.target) }, '💰 ฟาร์มเงิน'),
      el('label', { class: 'hint', title: 'ไม่ใช้การ์ดที่ค่าหลักเป็นโอกาสคริ / ดาเมจคริ (สายเวทปกติไม่คริ)' }, noCrit, ' ไม่เอาการ์ดคริ'),
      el('label', { class: 'hint', title: 'เกมนับการ์ดใบเดียวกัน ใบที่ 2 ได้ 50% ใบที่ 3 ได้ 25% ใบที่ 4 ไม่ได้อะไร และไม่นับเข้าเซ็ต · ปกติไม่ใส่ซ้ำ' }, allowDup, ' ใส่การ์ดซ้ำได้'),
      el('label', { class: 'hint', title: hasOwned ? 'จัดจากการ์ดที่ตัวละครมี (ใส่อยู่ + ในกระเป๋า) จำนวนและดาวตามจริง' : 'ต้องวิเคราะห์จากตัวละครที่ออนไลน์อยู่' }, onlyMine, ' เฉพาะการ์ดที่มี'),
      el('small', { class: 'hint' }, ' · ดาว (ถ้าใช้ทุกใบ) '), stars),
    out);
}

// every stat the game computes for this build, and which stat adds the most damage
function statBox(sh, w) {
  if (!sh) return null;
  const chip = (label, v, unit = '') => (v == null ? null : el('span', { class: 'chip' }, `${label} ${typeof v === 'number' ? (Number.isInteger(v) ? num(v) : v) : v}${unit}`));
  return el('details', { class: 'lab-order' },
    el('summary', {}, `📈 ค่าสเตตัส และค่าที่คุ้มที่สุด${w && w.length && w[0].gain != null ? ` · ${w[0].label} = DPS +${w[0].gain}%` : ''}`),
    el('div', { class: 'lab-row' }, ...[chip('ATK', sh.atk), chip('MATK', sh.matk), chip('Spell Amp', sh.spellAmp, '%'), chip('ลดคูลดาวน์', sh.cdr, '%'), chip('ร่ายเร็ว', sh.castSpd, '%'),
      chip('คริ', sh.crit, '%'), chip('ดาเมจคริ', sh.critDmg, '%'), chip('ความเร็วโจมตี', sh.aspd), chip('เจาะเกราะ', sh.armorPen, '%'), chip('HIT', sh.hit), chip('HP', sh.maxHp)].filter(Boolean)),
    w && w.length ? el('table', { class: 'lab-maps' }, el('tr', {}, el('th', {}, 'ถ้าเพิ่ม'), el('th', {}, 'DPS'), el('th', {}, '')),
      ...w.map((x) => el('tr', {}, el('td', {}, x.label), el('td', { class: 'gold' }, x.gain == null ? '-' : (x.gain > 0 ? '+' : '') + x.gain + '%'), el('td', { class: 'hint' }, x.note || '')))) : null,
    el('p', { class: 'hint' }, 'ค่าจากเครื่องคิดเลขของเกม (รวมเกียร์ การ์ด ตีบวก และสกิลพาสซีฟ) · ตาราง = ใส่ค่านั้นเพิ่มเข้าไปจริงแล้วคำนวณใหม่ทั้งบิลด์ (รวมคอมโบ) · สเตตัสหลัก +10 แต้ม · ค่า % ตามที่เขียน'));
}

// combo conditions counted in the score: target under status, Hunter's Mark, Chill -> Shatter
function comboBox(parts) {
  if (!parts || !parts.length) return null;
  const line = (c) => {
    if (c.k === 'status') return c.full > 0
      ? `🧊 เป้าติดสถานะ ${c.up}% ของเวลา (จาก ${c.skills.join(', ')}) · ถ้าติดตลอด +${c.full}% → ได้จริง +${c.gain}%`
      : `🧊 เป้าติดสถานะ ${c.up}% ของเวลา (จาก ${c.skills.join(', ')}) · ยังไม่มีเกียร์/การ์ด/สกิลที่แรงขึ้นใส่เป้าติดสถานะ (เช่น affix "ดาเมจใส่เป้าติดดีบัฟ", การ์ด Bramble Pact)`;
    if (c.k === 'mark') return `🎯 Hunter's Mark ค้างได้ ${c.stacks}/${c.cap} สแตก${c.apex ? ' · Apex ทั้งปาร์ตี้ +30%' : ''} → ดาเมจ +${c.gain}%`;
    if (c.k === 'shatter') return c.boss ? `❄️ Chill → Shatter: บอส/มินิบอสไม่แข็ง จึงไม่มี Shatter (ได้แค่สโลว์จาก ${c.skills.join(', ')})` : `❄️ Chill → Shatter ~${c.perMin} ครั้ง/นาที ต่อมอน 1 ตัว (จาก ${c.skills.join(', ')}) → ดาเมจ +${c.gain}% (ไม่นับระเบิดรอบตัว 30%)`;
    if (c.k === 'proc') return `🎲 Proc จากเกียร์ → ดาเมจ +${c.gain}% (${c.list.join(' · ')})`;
    if (c.k === 'res') {
      const bits = [c.stacks != null ? `ค้าง ${c.stacks}/${c.cap}` : '', c.perMin != null ? `${c.perMin} ครั้ง/นาที` : '', c.up != null ? `ติด ${c.up}% ของเวลา` : '', c.spend ? 'มีสกิลใช้สแตก' : ''].filter(Boolean).join(' · ');
      return `⚡ ${c.name}${bits ? ' ' + bits : ''} → ดาเมจ +${c.gain}%`;
    }
    return c.name;
  };
  return el('div', { class: 'lab-crit' }, el('b', {}, '🔗 คอมโบที่นับในคะแนน'), ...parts.map((c) => el('div', {}, line(c))));
}

// skill order: ranking, the opening sequence as the game casts it
function orderBox(o) {
  if (!o || !o.rank) return null;
  const sec = (ms) => (ms ? (ms / 1000).toFixed(ms % 1000 ? 1 : 0) + ' วิ' : '-');
  return el('details', { class: 'lab-order' },
    el('summary', {}, `⚔️ อันดับสกิลและลำดับการปล่อย · ${o.rank.filter((r) => r.sid !== 'basic').map((r) => r.name).slice(0, 3).join(' > ')}`),
    el('div', { class: 'lab-row' }, el('small', {}, [
      o.naive ? `ลำดับช่องลัดนี้แรงกว่าเรียงตามดาเมจต่อครั้ง (${o.naive.order.join(' > ')}) ${o.naive.gain >= 0 ? '+' : ''}${o.naive.gain}%` : 'ลำดับนี้ตรงกับการเรียงตามดาเมจต่อครั้ง',
      o.filler ? ` · ${o.filler} เป็นสกิลตีถี่ เติมช่องว่างระหว่างคูลดาวน์ของสกิลแรง` : '',
    ].join(''))),
    el('div', { class: 'lab-row' }, el('small', {}, 'ลำดับช่วงเปิด 15 วิแรก (เกมกดตามช่องลัด สกิลไหนพร้อมก่อนในลำดับ กดก่อน): ')),
    el('div', { class: 'lab-timeline' }, ...o.opener.map((c) => el('span', { class: 'tl' }, el('small', {}, c.t + 's'), ' ', c.name))),
    el('table', { class: 'lab-maps' },
      el('tr', {}, ...['#', 'สกิล', 'ช่อง', '% ดาเมจ', 'ดาเมจ/ครั้ง', 'ครั้ง/นาที', 'คูลดาวน์', 'ร่าย', 'ชาร์จ'].map((h) => el('th', {}, h))),
      ...o.rank.map((r, i) => el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, r.name), el('td', {}, r.slot > 0 ? String(r.slot) : '-'),
        el('td', { class: 'gold' }, r.share + '%'), el('td', {}, num(r.perCast), r.dot ? el('small', { class: 'hint' }, ` (DoT ${r.dot}%)`) : ''), el('td', {}, String(r.casts)), el('td', {}, sec(r.cdMs)), el('td', {}, sec(r.castMs)), el('td', {}, String(r.charges))))),
    el('p', { class: 'hint' }, 'อันดับและครั้ง/นาทีคิดจากนาทีที่ 2–3 (ตีบอสยาว) · ลำดับช่วงเปิดคือ 15 วิแรก · จำลองแบบเดียวกับเครื่องคิดเลขของเกม: ทุก 50 ms ถ้าไม่ได้ร่ายอยู่ กดสกิลแรกในช่องลัดที่พร้อม ไม่งั้นตีปกติ · ชาร์จที่ 2 ขึ้นไปแรง 50% · ดาเมจ/ครั้งรวม DoT (เลือดไหล/พิษ/เผา ทุกติ๊กจนหมดเวลา) แล้ว วงเล็บคือส่วนที่มาจาก DoT · ลำดับช่องลัดที่แสดงคือแบบที่ดีที่สุดจากการลองทุกลำดับ'));
}

// which map earns the most silver per hour with this build (+ the cards picked for gold farming, if any)
function mapBox(x) {
  const out = el('div', { class: 'lab-cards' });
  const pack = el('input', { type: 'number', min: '1', max: '8', value: '3', style: 'width:52px' }); pack.addEventListener('change', () => { pack.dataset.touched = '1'; });
  const go = el('button', { class: 'tiny', onclick: async () => {
    go.disabled = true; out.replaceChildren(el('p', { class: 'hint' }, 'กำลังคำนวณทุกแมพ…'));
    try {
      const r = await dash.invoke('lab-maps', { ...lastLab, build: x.build, pack: +pack.value, packSet: pack.dataset.touched === '1' });
      const lvl = lastLab.level;
      out.replaceChildren(
        el('p', { class: 'hint' }, `คิดจากดาเมจของบิลด์นี้กับมอนแต่ละชนิดในแมพ (เครื่องคิดเลขของเกม) · Silver/ตัว × Gold% · ฆ่า/ชม. จำกัดด้วยเวลาเกิดใหม่ · ${r.total} แมพ ใน ${(r.ms / 1000).toFixed(1)} วิ`),
        el('table', { class: 'lab-maps' },
          el('tr', {}, ...['#', 'แมพ', 'เลเวล', 'Silver/ชม.', 'ฆ่า/ชม.', 'Silver/ตัว', 'โดนตีกี่ทีตาย', 'มอน'].map((h) => el('th', {}, h))),
          ...r.rows.map((m, i) => el('tr', { class: (m.hitsToDie != null && m.hitsToDie < 6 ? 'risky' : '') + (lvl > m.band[1] + 10 ? ' low' : '') },
            el('td', {}, String(i + 1)), el('td', {}, m.name), el('td', {}, `${m.band[0]}–${m.band[1]}`), el('td', { class: 'gold' }, num(m.silverHr)),
            el('td', {}, num(m.killsHr)), el('td', {}, num(m.perKill)), el('td', {}, m.hitsToDie == null ? '-' : String(m.hitsToDie) + (m.hitsToDie < 6 ? ' ⚠' : '')),
            el('td', { class: 'hint' }, m.mobs.map((o) => `${labPretty(o.type)} ×${o.count} (${o.ttk}s)`).join(', '))))),
        el('p', { class: 'hint' }, 'ตัวเลขเป็นค่าประมาณเพื่อเทียบแมพ (ไม่รวมของดรอป/การ์ดดรอป, เวลาเดินคิด 1.5 วิ/ตัว) · ⚠ = โดนตีไม่กี่ทีก็ตาย'));
    } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    go.disabled = false;
  } }, '🗺 หาแมพทำเงิน');
  return el('div', {}, el('div', { class: 'lab-row' }, go, el('small', { class: 'hint' }, ' มอนต่อกลุ่มที่ลากตีพร้อมกัน '), pack), out);
}

function renderLab(box, r) {
  const best = r.results[0];
  const cur = r.current;
  const head = el('p', {}, `${r.mode === 'boss' ? '👑 ตีบอส' : '🌾 ฟาร์ม'} · เป้า ${labPretty(r.target.id)} Lv ${r.target.level}${r.fight ? ` · คิดจากการสู้ ${r.fight.sec >= 120 ? (r.fight.sec / 60).toFixed(1) + ' นาที' : r.fight.sec + ' วิ'} (${r.fight.why})` : ''} · ${r.full ? 'รวมการ์ดชุดที่จัดให้' + (r.loadout ? ' + เกียร์ของตัวละคร' : '') : r.loadout ? 'รวมเกียร์+การ์ดของตัวละคร' : 'ไม่รวมเกียร์/การ์ด'}${r.evals ? ` · ลอง ${num(r.evals)} แบบ` : ''} ใน ${(r.ms / 1000).toFixed(1)} วิ`);
  const card = (x, i) => el('div', { class: 'lab-card' + (i === 0 ? ' best' : '') },
    x.extended && x.extended.length ? el('div', { class: 'hint okline' }, `⬆ อัปคลาส 1 ให้เต็มเพื่อต่อยอดคลาส 2 (คุ้มกว่า): ${x.extended.join(' · ')}`) : null,
    x.freed && x.freed.length ? el('div', { class: 'hint okline' }, `♻ ไม่ลงแต้มสกิลที่ไม่เพิ่มดาเมจ · เก็บแต้มไว้: ${x.freed.join(' · ')}`) : null,
    x.measured ? el('div', { class: 'hint ' + (x.unmeasured && x.unmeasured.length ? 'warnline' : 'okline') }, x.unmeasured && x.unmeasured.length ? `⚠ สกิลที่ยังไม่เคยวัดดาเมจจริง: ${x.unmeasured.join(', ')} · ตัวเลขของสกิลพวกนี้มาจากสูตรอย่างเดียว ลองใช้จริงแล้ววัดด้วย A/B ก่อนเชื่อ` : '✓ ทุกสกิลในช่องลัดปรับตามดาเมจจริงของตัวละครนี้แล้ว') : null,
    el('div', { class: 'lab-top' }, el('b', {}, `${i === 0 ? '🏆 ' : ''}${x.c2 ? 'คลาส 2 · ' + x.c2 : 'คลาส 1 อย่างเดียว'}`),
      el('span', { class: 'lab-score' }, `${r.mode === 'boss' ? (x.fightSec ? `DPS เฉลี่ย ${x.fightSec >= 120 ? (x.fightSec / 60).toFixed(1) + ' นาที' : x.fightSec + ' วิ'}` : x.window === 'burst' ? 'DPS 60 วิแรก' : 'DPS ยาว') : 'ดาเมจรวม/วิ'} ${num(x.score)}`),
      x.fightSec && x.bossHp && r.mode === 'boss' && !/^training/.test(r.target.id) ? el('small', { class: 'hint' }, ` · ล้มบอสคนเดียวใน ~${Math.round(x.bossHp / Math.max(1, x.score))} วิ`) : null,
      r.mode === 'boss' ? el('small', { class: 'hint', title: 'ดาเมจยาว = นาทีที่ 2–3 ของการตีต่อเนื่อง (ไม่มีช่วงเปิดที่ทุกสกิลพร้อมพร้อมกัน) · 60 วิแรก = รวมช่วงเปิด' },
        x.window === 'burst' ? ` · ดาเมจยาว ${num(x.sustained)}` : ` · 60 วิแรก ${num(x.dps)} (ช่วงเปิด +${x.sustained ? Math.round((x.dps / x.sustained - 1) * 100) : 0}%)`) : null,
      i ? el('small', { class: 'hint' }, ` (${Math.round((x.score / best.score - 1) * 100)}%)`) : null,
      cur ? el('small', { class: x.score >= cur.score ? 'pos' : 'neg' }, ` · ${x.score >= cur.score ? '+' : ''}${Math.round((x.score / Math.max(1, cur.score) - 1) * 100)}% จากบิลด์ปัจจุบัน`) : null),
    el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, `แต้มคลาส 1 ${x.points.c1}/${x.points.c1Max}${x.c2 ? ` · แต้มคลาส 2 ${x.points.c2}/${x.points.c2Max}` : ''}`)),
    x.extras && x.extras.length ? el('details', { class: 'lab-ext', open: x.extras.some((e) => e.used > 0) ? '' : null },
      el('summary', {}, `⬆ ต่อยอดคลาส 2 · ใช้ ${x.extras.reduce((t, e) => t + e.used, 0)} แต้มคลาส 2 กับ ${x.extras.filter((e) => e.used > 0).length} สกิล`),
      el('p', { class: 'hint' }, 'ต้องอัปสกิลคลาส 1 ให้เต็มก่อน (เช่น 10/10) แล้วเลเวลที่เกินเต็มใช้แต้มคลาส 2 ทีละ 1 · ตัวเลข "เป้า" คือเลเวลที่ควรอัปในหน้าสกิลของเกม (รวมส่วนคลาส 1)'),
      el('table', { class: 'lab-maps' },
        el('tr', {}, ...['สกิล', 'ควรอัปถึง', 'คลาส 1', 'ต่อยอด', 'หมายเหตุ'].map((h) => el('th', {}, h))),
        ...x.extras.map((e) => el('tr', {},
          el('td', {}, e.name + (e.game ? ' → ' + e.game : '')),
          el('td', { class: e.used ? 'gold' : '' }, `${e.lv}/${e.base + e.plus}`),
          el('td', {}, `${Math.min(e.lv, e.base)}/${e.base}`),
          el('td', {}, e.used ? `+${e.used}/${e.plus}` : `0/${e.plus}`),
          el('td', {}, e.used ? (e.used >= e.plus ? 'เต็ม' : '') : e.why || ''))))) : null,
    el('div', { class: 'lab-row' }, el('small', {}, 'ช่องลัด (ลำดับกด): '), x.hotbar.map((h, k) => el('span', { class: 'chip' }, `${k + 1}. ${h}`))),
    el('div', { class: 'lab-skills' }, ...x.skills.sort((a, b) => (a.c2 - b.c2) || a.line.localeCompare(b.line)).map((s) => el('div', { class: 'lab-sk' + (s.c2 ? ' c2' : '') + (s.passive ? ' pas' : '') },
      el('span', {}, s.name), el('b', {}, `${s.lv}/${s.max}`), s.ext ? el('small', { class: 'evo', title: 'เลเวลเกินเต็มของสกิลคลาส 1 ใช้แต้มคลาส 2 (ต้องเต็มก่อน และ Job คลาส 2 ถึงเกณฑ์)' }, '⬆ ต่อยอดคลาส 2 ' + (s.ext.trim() || '+' + (s.lv - s.base))) : null, s.evo ? el('small', { class: 'evo' }, 'Evo ' + s.evo) : null, el('small', { class: 'hint' }, s.line)))),
    x.traits.length ? el('div', { class: 'lab-row' }, el('small', {}, 'Trait: '), ...x.traits.map((t) => el('span', { class: 'chip' }, t))) : null,
    el('div', { class: 'lab-row' }, el('small', {}, 'สัดส่วนดาเมจ: '), ...x.share.map((s) => el('span', { class: 'chip' }, `${s.name} ${s.pct}%`))),
    comboBox(x.combos),
    statBox(x.sheet, x.weights),
    orderBox(x.order),
    cardBox(x),
    mapBox(x),
    x.notes.length ? el('details', {}, el('summary', {}, `ข้อสังเกต ${x.notes.length} ข้อ (ส่วนที่เครื่องคิดเลขของเกมไม่ได้นับ)`), ...x.notes.map((n) => el('div', { class: 'hint' }, '· ' + n))) : null);
  box.replaceChildren(...[head,
    cur ? el('p', { class: 'hint' }, `บิลด์ปัจจุบัน: ${r.mode === 'boss' ? 'DPS' : 'ดาเมจรวม/วิ'} ${num(cur.score)}`) : null,
    cur && cur.tuned ? tunedBox(cur.tuned) : null,
    ...r.results.map(card)].filter(Boolean));
}
// the gentle way: the character's own build with a few single points moved, backed by its real hits
function tunedBox(t) {
  const head = el('b', {}, '🔧 ปรับจากบิลด์ที่ใช้อยู่ (ทีละแต้ม)');
  if (!t.moves.length) {
    return el('div', { class: 'lab-card best' }, el('div', { class: 'lab-top' }, head),
      el('p', {}, t.realBacked ? '✅ บิลด์ปัจจุบันดีแล้ว: ย้ายแต้มจุดไหนก็ไม่แรงขึ้นเกิน 1% ตามดาเมจจริงที่บันทึกไว้' : 'บิลด์ปัจจุบันดีแล้วตามสูตรเกม (ยังไม่มีดาเมจจริงของตัวละครนี้ · ฟาร์ม/ตีบอสสัก 10 นาทีแล้วคำนวณใหม่จะแม่นขึ้น)'));
  }
  return el('div', { class: 'lab-card best' }, el('div', { class: 'lab-top' }, head, el('span', { class: 'lab-score pos' }, ` +${t.gainPct}%`)),
    el('p', { class: 'hint' }, t.realBacked ? 'คิดจากดาเมจจริงต่อสกิลของตัวละครนี้ · ทำตามทีละขั้นแล้ววัดใหม่ได้' : 'คิดจากสูตรเกม (ยังไม่มีดาเมจจริงของตัวละครนี้)'),
    el('ol', {}, ...t.moves.map((m) => el('li', {}, `ย้าย 1 แต้ม: ${m.fromName} → ${m.toName} (+${m.gainPct}%)`, m.guess ? el('small', { class: 'warnc', title: 'สกิลนี้ยังไม่เคยใช้ จึงไม่มีดาเมจจริง ตัวเลขมาจากสูตรเกมซึ่งมักคลาด · ลองแล้วตีจริงสัก 10 นาทีเพื่อยืนยัน' }, ' ⚠ ยังไม่มีข้อมูลจริง') : null))),
    el('div', { class: 'lab-row' }, el('small', {}, 'ช่องลัดหลังปรับ: '), ...(t.hotbar || []).map((h, k) => el('span', { class: 'chip' }, `${k + 1}. ${h}`))));
}

async function openMarketSell(opt = {}) {
  const gear = tradableGear().filter((g) => !opt.only || opt.only.includes(g.id));
  const minBox = el('input', { type: 'number', min: '0', step: '100000', value: String(opt.only ? 0 : (state && state.settings.valuableMinGold) || 1000000) });
  const list = el('div', { class: 'gearlist mklist' });
  const out = el('div', { class: 'results' });
  const rows = gear.map((g) => {
    const box = el('input', { type: 'checkbox' });
    const price = el('input', { type: 'number', min: '1', step: '1000', class: 'mkprice', placeholder: 'ราคา' });
    const info = el('small', { class: 'hint' }, 'กำลังถามราคาตลาด…');
    const res = el('small', {});
    const row = el('div', { class: 'mkrow' }, box, el('span', { class: 'rar r-' + (g.rarity || 'normal') }, (RARITIES.find((r) => r[0] === g.rarity) || RARITIES[0])[1]),
      el('div', { class: 'bn' }, g.name, info, res), price, el('span', { class: 'hint' }, 'G'));
    return { g, box, price, info, res, row, filled: false };
  });
  list.replaceChildren(...(rows.length ? rows.map((r) => r.row) : [el('p', {}, 'ไม่มีอุปกรณ์ที่ลงขายได้ (ของที่ล็อกหรือผูกตัวไม่แสดง)')]));
  const G = (n) => num(n) + ' G';
  const fill = () => {
    const ip = (detail && detail.itemPrices) || {};
    const min = Number(minBox.value) || 0;
    for (const r of rows) {
      const p = ip[r.g.id];
      if (!p || r.filled) continue;
      r.filled = true;
      r.info.textContent = p.price ? `ตลาด: ถูกสุด ${G(p.price)}${p.last ? ` · ขายล่าสุด ${G(p.last)}` : ''} · วางขาย ${p.stock} · ขาย 7 วัน ${p.vol7}` : 'ยังไม่มีคนขายชนิด+เกรดนี้ในตลาด ตั้งราคาเอง';
      if (p.price) r.price.value = String(Math.max(1, (p.basis === 'listed' ? p.price - 1 : p.price))); // just under the cheapest
      r.box.checked = !!p.price && p.price >= min;
    }
  };
  minBox.addEventListener('change', () => { for (const r of rows) r.filled = false; fill(); });
  const go = el('button', { class: 'primary', onclick: async () => {
    const pick = rows.filter((r) => r.box.checked);
    if (!pick.length) { out.replaceChildren(el('p', {}, 'เลือกของที่จะลงขายก่อน')); return; }
    const bad = pick.find((r) => !(Number(r.price.value) >= 1));
    if (bad) { out.replaceChildren(el('p', {}, `ใส่ราคาให้ ${bad.g.name} ก่อน`)); return; }
    const total = pick.reduce((t, r) => t + Number(r.price.value), 0);
    if (!confirm(`ลงขายในตลาดกลาง ${pick.length} ชิ้น รวม ${G(total)}?\n${pick.map((r) => `${r.g.name}: ${G(Number(r.price.value))}`).join('\n')}\n(ภาษีตลาดตามกฎเกม · ยกเลิกประกาศได้ในหน้าตลาดของเกม)`)) return;
    for (const r of pick) {
      r.res.textContent = ' · กำลังลงขาย…';
      // eslint-disable-next-line no-await-in-loop
      const x = await dash.invoke('game-cmd', selected, 'marketList', { itemId: r.g.id, qty: 1, unitPrice: Number(r.price.value) });
      r.res.textContent = x && x.ok ? (x.unsure ? ' · ⏳ ส่งแล้ว รอตลาดยืนยัน (~5 นาที)' : ' · ✔ ส่งลงขายแล้ว ขึ้นตลาดใน ~5 นาที') : ` · ✖ ${(x && x.error) || 'ไม่สำเร็จ'}`;
      r.res.className = x && x.ok ? 'res ok' : 'res bad';
      r.box.checked = false;
    }
    out.replaceChildren(el('p', { class: 'hint' }, 'เสร็จแล้ว · ตลาดใช้เวลาราว 5 นาทีกว่าประกาศจะขึ้น โปรแกรมจะเช็ค "ประกาศของฉัน" ให้เองหลังครบเวลา ดูสถานะได้ในช่อง 💎 ของมีค่า'));
  } }, 'ลงขายที่เลือก');
  openModal('🏪 ลงขายตลาดกลาง', [
    el('p', { class: 'hint' }, 'ราคาตลาดตามชนิด+เกรด (ถูกสุดตอนนี้ / ขายจริงล่าสุด) · ราคาตั้งต้น = ต่ำกว่าถูกสุด 1 G แก้ได้ · ติ๊กให้อัตโนมัติเมื่อมูลค่าตั้งแต่'),
    el('label', {}, 'ติ๊กอัตโนมัติเมื่อราคาตลาด ≥ ', minBox, ' G'),
    list, rows.length ? go : null, out,
  ]);
  if (rows.length) {
    await dash.invoke('game-cmd', selected, 'priceAll', {});
    for (let i = 0; i < 20 && rows.some((r) => !r.filled); i++) { await refreshDetail(); fill(); await new Promise((r) => setTimeout(r, 700)); } // eslint-disable-line no-await-in-loop
    for (const r of rows) if (!r.filled) r.info.textContent = 'ตลาดไม่ตอบ ตั้งราคาเอง';
  }
}

// skill spam: which hotbar keys to press over and over, and how often
function openSpam(a) {
  const cur = a.spam || { on: false, slots: [], everyMs: 300 };
  const picks = new Set(cur.slots || []);
  const chips = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
    const b = el('button', { class: 'ctl spam-key' + (picks.has(n) ? ' on' : ''), title: n === 9 ? 'ช่อง 9 = Ultimate ของคลาส 2' : `ปุ่ม ${n} บนแถบสกิล` }, n === 9 ? '9 (Ult)' : String(n));
    b.onclick = () => { if (picks.has(n)) picks.delete(n); else picks.add(n); b.classList.toggle('on', picks.has(n)); };
    return b;
  });
  const speed = el('select', {}, ...[[200, 'ถี่มาก (0.2 วิ)'], [300, 'ปกติ (0.3 วิ)'], [500, 'ช้า (0.5 วิ)'], [1000, 'ช้ามาก (1 วิ)']].map(([v, t]) => el('option', { value: String(v), selected: Number(cur.everyMs) === v ? '' : null }, t)));
  const save = async (on) => { await dash.invoke('spam-set', a.id, { on, slots: [...picks], everyMs: +speed.value }); closeModal(); }; // the button on the account shows the new state
  openModal(`⚡ สแปมสกิล · ${a.name}`, [
    el('p', { class: 'hint' }, 'เลือกปุ่มบนแถบสกิลของเกมที่จะกดซ้ำๆ ให้ร่ายทันทีที่คูลดาวน์หมด (AUTO ของเกมยังเลือกเป้าและเดินเอง) · ปุ่มที่ไม่เลือก AUTO ใช้ตามปกติ'),
    el('div', { class: 'ctl-row' }, ...chips),
    el('label', {}, 'ความถี่ ', speed),
    el('p', { class: 'hint' }, 'กดเฉพาะตอน AUTO เปิดและกำลังฟาร์ม/ตีบอส/ทำค่าหัว · หยุดเองตอนตาย พักจอ เดินทาง กลับจุดฟาร์ม หรือมีช่องพิมพ์แชทเปิดอยู่ · ตั้งต่อบัญชี จำไว้หลังปิดโปรแกรม'),
    el('div', { class: 'ctl-row' },
      el('button', { class: 'primary', onclick: () => save(true) }, picks.size || cur.on ? '✓ เปิด / บันทึก' : '✓ เปิด'),
      el('button', { class: 'ctl', onclick: () => save(false) }, '■ ปิด')),
  ]);
}

function renderControls(a) {
  const s = (detail && detail.stats) || {};
  const live = a.status === 'online';
  const etc = ((detail && detail.bag) || []).filter((it) => it.ids && it.ids.some((x) => /^drop_/.test(x.id)));
  const etcQty = etc.reduce((t, it) => t + it.qty, 0);
  const key = JSON.stringify([a.id, live, s.auto, s.sleeping, s.dead, etcQty, !!s.premium, gearCount(), tradableGear().length, a.autoRespawn, a.bounty, a.deaths && a.deaths.perHour, a.finder, a.driver, a.spam]);
  rebuild($('#d-controls'), key, () => (live ? [
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '▶ การเล่น'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl' + (s.auto ? ' on' : ''), title: 'เปิด/ปิด AUTO ของเกม (เหมือนกดปุ่ม AUTO ในเกม)', onclick: () => cmd('auto') }, s.auto ? '■ AUTO เปิดอยู่' : '▶ AUTO ปิดอยู่'),
      el('button', { class: 'ctl', title: 'โหมดพักจอของเกม: จอมืด ประหยัดเครื่อง AUTO ทำงานต่อ (กลับมาได้ที่หน้าเกม กดค้าง 3 วิ)', onclick: () => cmd('sleep') }, s.sleeping ? '☾ พักจออยู่' : '☾ พักจอ'),
      s.dead ? el('button', { class: 'ctl danger', title: 'กดปุ่มฟื้นในหน้าเกม', onclick: () => cmd('respawn') }, '✚ ฟื้นคืนชีพ') : null,
      el('button', { class: 'ctl' + (a.spam && a.spam.on ? ' on' : ''), title: 'กดปุ่มสกิลที่เลือก (1–9) ซ้ำๆ ให้ร่ายทันทีที่พร้อม ระหว่างที่ AUTO ตีอยู่' + (a.spam && a.spam.on && a.spam.state ? ` · ตอนนี้: ${a.spam.state}` : ''), onclick: () => openSpam(a) },
        a.spam && a.spam.on ? `⚡ สแปมสกิล ${a.spam.slots.join(' ')}${a.spam.state && a.spam.state !== 'กดอยู่' ? ' · ' + a.spam.state : ''}` : '⚡ สแปมสกิล'),
      a.autoRespawn ? el('span', { class: 'ctl-chip' + (a.autoRespawn.on ? ' on' : ''), title: a.autoRespawn.on ? 'ตัวเลือก "เกิดที่เดิมอัตโนมัติ" ของเกมเปิดอยู่ · ตายตอน AUTO ในแมพฟิลด์ = ลุกที่เดิม' : 'เปิดตัวเลือกของเกมไม่ได้' }, a.autoRespawn.on ? `↺ เกิดที่เดิม: เปิด${a.autoRespawn.count ? ` (${a.autoRespawn.count} ครั้ง)` : ''}` : (a.autoRespawn.why === 'premium' ? '↺ เกิดที่เดิม: ต้อง Premium' : '↺ เกิดที่เดิม: -')) : null,
      el('button', { class: 'ctl' + (a.bounty && a.bounty.on ? ' on' : ''), title: 'ทำค่าหัวรายวันเอง: เดินทางไปแมพของแต่ละใบ (ปุ่มเดินทางของเกม) ยืนข้างมอนแล้วเปิด AUTO ครบ 40 ตัวรับรางวัลแล้วไปใบต่อไป · ข้ามใบที่มอนเลเวลสูงกว่าตัวละคร', onclick: () => dash.invoke('bounty', a.id, !(a.bounty && a.bounty.on)) }, a.bounty && a.bounty.on ? '■ หยุดทำค่าหัว' : '📜 ทำค่าหัวอัตโนมัติ'),
      el('button', { class: 'ctl' + (a.finder && a.finder.on ? ' on' : ''), title: 'ลองฟาร์มจริงแมพที่น่าจะคุ้มสุด 3–4 แมพ (เลือกจาก Build Lab ตามเลเวลและความปลอดภัย) แมพละ 10 นาที แล้วพาไปฟาร์มแมพที่ได้ Silver สุทธิมากสุด · นับ Silver จากมอน + ขาย/หลอม Normal/Magic + ETC ราคา NPC − ยา · ไม่นับราคาตลาด · เดินทางฟรีเท่านั้น · แมพที่เคยวัดแล้วใน 3 วันไม่ต้องลองซ้ำ', onclick: async () => { const on = !(a.finder && a.finder.on); const r = await dash.invoke('farm-find', a.id, on); if (r && !r.ok) showBanner(r.error); else if (on && r) showBanner(`🔎 จะลอง: ${r.trying.join(', ') || '-'}${r.known.length ? ` · ใช้ผลเดิม: ${r.known.join(', ')}` : ''}`); } }, a.finder && a.finder.on ? '■ หยุดหาที่ฟาร์ม' : '🔎 หาที่ฟาร์มคุ้มสุด'),
      el('button', { class: 'ctl', title: 'กำไรต่อชั่วโมงของทุกแมพที่ตัวละครนี้เคยฟาร์ม (ใกล้เลเวลตอนนี้) · กดไปฟาร์มแมพไหนก็ได้', onclick: () => openFarmMaps(a.id) }, '📊 แมพที่เคยฟาร์ม'),
      el('button', { class: 'ctl', title: 'รับของในจดหมาย ภารกิจรายวัน/รายสัปดาห์ของ Pass และรางวัล Tier ของ Pass ที่พร้อมรับ (เหมือนกดปุ่มรับในเกม)', onclick: async (e) => { e.target.disabled = true; const r = await dash.invoke('claim-rewards', a.id); showBanner(r && r.ok ? `🎁 รับแล้ว: จดหมาย ${r.mail} · ภารกิจ ${r.daily + r.weekly} · Tier ของ Pass` : (r && r.error) || 'รับของไม่สำเร็จ'); setTimeout(() => { $('#banner').hidden = true; }, 3000); e.target.disabled = false; } }, '🎁 รับของทั้งหมด'))),
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '💰 ของและเงิน'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl', disabled: canSell() ? null : '', title: canSell() ? 'ซื้อยา HP/MP จากร้าน NPC โดยไม่ต้องเปิดหน้าเกม' : SELL_RULE, onclick: () => openBuy() }, '🧪 ซื้อยา'),
      el('button', { class: 'ctl', disabled: tradableGear().length ? null : '', title: 'ลงขายอุปกรณ์ในตลาดกลาง ดูราคาตลาดตามชนิด+เกรดก่อน', onclick: () => openMarketSell() }, `🏪 ลงขายตลาดกลาง (${tradableGear().length})`),
      el('button', { class: 'ctl', disabled: gearCount() ? null : '', title: 'แยกชิ้นอุปกรณ์ในกระเป๋า (ของที่ล็อกไว้ในเกมจะไม่ถูกย่อย)', onclick: () => openSalvage() }, `🔨 ย่อยของ (${gearCount()})`),
      el('button', { class: 'ctl', disabled: etcQty && canSell() ? null : '', title: canSell() ? 'ขายของดรอปจากมอน (ETC) ทั้งหมดให้ NPC' : SELL_RULE, onclick: () => {
      if (confirm(`ขายของดรอปทั้งหมด ${num(etcQty)} ชิ้นให้ NPC?`)) cmd('sellEtc', {}, 'กำลังขายของดรอป…');
    } }, `🪙 ขาย ETC ทั้งหมด (${num(etcQty)})`),
      el('button', { class: 'ctl', disabled: gearCount() && canSell() ? null : '', title: canSell() ? 'เลือกอุปกรณ์ที่ล้นกระเป๋าขายให้ NPC (ชื่อไทย มี +ตีบวก และออฟชั่นบอกว่าชิ้นไหน · ของล็อกไม่แสดง · ของแพงไม่ติ๊กให้)' : SELL_RULE, onclick: () => openNpcSell() }, `🪙 ขายอุปกรณ์ให้ NPC (${gearCount()})`))),
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '🧪 บิลด์'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl', title: 'วิเคราะห์บิลด์ของตัวละครนี้: ดาเมจตอนนี้จากเกียร์+การ์ดที่ใส่ แล้วหาชุดสกิลและการ์ดที่แรงที่สุด', onclick: () => openLab({ id: a.id, auto: true }) }, '🧪 วิเคราะห์บิลด์'))),
    a.driver || (a.deaths && a.deaths.perHour >= 5) || (a.bounty && (a.bounty.on || a.bounty.note)) || (a.finder && a.finder.note) ? el('div', { class: 'ctl-status' }, a.driver ? el('span', { class: 'ctl-chip on', title: 'ระบบที่กำลังคุมตัวละครนี้อยู่ ระบบอื่นที่สำคัญน้อยกว่าจะรอ: บอสโลก > ค่าหัว > หาที่ฟาร์ม/เดินทาง > ย้าย CH > แก้ AUTO ค้าง/คืนแรม' }, `🎮 กำลัง${a.driver}`) : null, a.finder && a.finder.note ? el('span', { class: 'ctl-chip' + (a.finder.on ? ' on' : ''), title: 'หาที่ฟาร์มคุ้มสุด' }, `🔎 ${a.finder.note}`) : null, a.deaths && a.deaths.perHour >= 5 ? el('span', { class: 'ctl-chip' + (a.deaths.feePerHour > a.deaths.silverPerHour * 0.1 ? ' warn' : ''), title: 'ตายบ่อยในแมพนี้: ทุกครั้งที่ตายเสียเวลาตี และเกิดที่เดิมในแมพฟิลด์เสีย 5,000 G ต่อครั้ง · ถ้าค่าเกิดเกิน 10% ของรายได้ ลองเพิ่ม HP/VIT หรือย้ายไปแมพที่มอนเบาลง' }, `☠ ตาย ${a.deaths.perHour}/ชม. · ค่าเกิด ~${num(a.deaths.feePerHour)} G/ชม.${a.deaths.silverPerHour ? ` (${Math.round(a.deaths.feePerHour / a.deaths.silverPerHour * 100)}% ของรายได้)` : ''}`) : null, a.bounty && (a.bounty.on || a.bounty.note) ? el('span', { class: 'ctl-chip' + (a.bounty.on ? ' on' : ''), title: 'ค่าหัวรายวัน' }, `📜 ${a.bounty.note || a.bounty.phase}${a.bounty.done ? ` · รับแล้ว ${a.bounty.done}` : ''}`) : null) : null,
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
  renderUpdate(u);
  if (u.current) $('#app-ver').textContent = 'v' + u.current;
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
  renderHighValue();
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

$('#update-btn').addEventListener('click', () => { updSkip = ''; renderUpdate((state && state.update) || {}); });
// ---------- update card ----------
let updSkip = (() => { try { return localStorage.getItem('upd-skip') || ''; } catch { return ''; } })();
function renderUpdate(u) {
  const box = $('#upd');
  const show = (u.status === 'available' || u.status === 'downloading' || u.status === 'ready') && updSkip !== u.version; // 'later' hides it for that version (it still installs when the app closes)
  box.hidden = !show;
  if (!show) return;
  $('#upd-cur').textContent = 'v' + (u.current || '');
  $('#upd-new').textContent = 'v' + (u.version || '');
  const notes = (u.notes || '').split(/\n+/).map((x) => x.replace(/^[-*•]\s*/, '').trim()).filter((x) => x && !/^(Co-Authored-By|Claude-Session)/i.test(x) && !/^BinderDash \d/.test(x)).slice(0, 12);
  $('#upd-notes').replaceChildren(...(notes.length ? [el('div', { class: 'upd-sub' }, 'มีอะไรใหม่'), el('ul', {}, ...notes.map((n) => el('li', {}, n)))] : [el('div', { class: 'hint' }, 'ปรับปรุงและแก้ไขข้อผิดพลาด · ดูรายละเอียดบน GitHub')]));
  const busy = u.status === 'downloading' || u.status === 'ready';
  $('#upd-bar').hidden = !busy;
  $('#upd-fill').style.width = (u.status === 'ready' ? 100 : u.percent || 0) + '%';
  $('#upd-status').textContent = u.status === 'downloading' ? `กำลังดาวน์โหลด ${u.percent || 0}%…` : u.status === 'ready' ? 'ดาวน์โหลดเสร็จแล้ว · กดติดตั้ง (โปรแกรมเปิดใหม่ เกมทุกตัวเปิดกลับเองในราว 1 นาที) หรือปล่อยไว้ จะติดตั้งตอนปิดโปรแกรม' : 'อัปเดตแล้วโปรแกรมจะติดตั้งและเปิดใหม่เองในราว 1 นาที · บัญชีที่เปิดอยู่จะเปิดกลับให้';
  $('#upd-go').disabled = u.status === 'downloading'; $('#upd-later').disabled = u.status === 'downloading';
  $('#upd-go').textContent = u.status === 'ready' ? '🔄 ติดตั้งเลย' : u.status === 'downloading' ? 'กำลังดาวน์โหลด…' : 'อัปเดตตอนนี้';
  if (u.manualOnly) { $('#upd-status').textContent = 'macOS: กดแล้วจะเปิดหน้าดาวน์โหลด · โหลดไฟล์ .dmg ใหม่ ปิดโปรแกรม แล้วลาก BinderDash ทับของเดิมในโฟลเดอร์ Applications'; $('#upd-go').textContent = 'ดาวน์โหลด .dmg ใหม่'; }
}
$('#upd-go').addEventListener('click', () => dash.invoke('update-now'));
$('#upd-later').addEventListener('click', () => { const v = state && state.update && state.update.version; updSkip = v || ''; try { localStorage.setItem('upd-skip', updSkip); } catch { /* */ } $('#upd').hidden = true; });
$('#upd-notes-link').addEventListener('click', () => dash.invoke('open-release'));
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
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || !/^[1-9]$/.test(e.key) || !state) return;
  const a = state.accounts[Number(e.key) - 1];
  if (a) { selected = a.id; detail = null; render(); refreshDetail(); e.preventDefault(); }
});
function selectAccount(id) { if (id !== selected) { selected = id; detail = null; render(); refreshDetail(); } }
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

$('#lab-btn').addEventListener('click', () => openLab());
$('#mkt-btn').addEventListener('click', () => openMarketWatch());

// ---------- real-time market watch ----------
let mwTimer = null;
function spark(points) {
  // lowest listing over time (falls back to last sale), as a small line
  const ys = points.map((p) => p[1] || p[2]).filter((v) => v > 0);
  if (ys.length < 2) return el('span', { class: 'hint' }, ys.length ? '·' : '');
  const W = 110; const H = 26; const mn = Math.min(...ys); const mx = Math.max(...ys); const span = mx - mn || 1;
  const pts = ys.map((v, i) => `${(i / (ys.length - 1) * (W - 2) + 1).toFixed(1)},${(H - 2 - (v - mn) / span * (H - 4)).toFixed(1)}`).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('class', 'spark');
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', pts); pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', up ? '#3ccf91' : '#ff6b81'); pl.setAttribute('stroke-width', '1.8');
  svg.append(pl); return svg;
}
// list a watched item for sale from whichever account holds it (one piece / one stack per press)
function sellCell(w, v, list) {
  if (!list.length) return el('span', { class: 'hint' }, '-');
  const total = list.reduce((t, x) => t + x.qty, 0);
  const pick = list[0];
  const suggest = v && v.low ? Math.max(1, v.low - 1) : v && v.last ? v.last : 0;
  const price = el('input', { type: 'number', min: '1', value: suggest ? String(suggest) : '', placeholder: 'ราคา/ชิ้น', style: 'width:96px' });
  const qty = el('input', { type: 'number', min: '1', max: String(pick.qty), value: String(pick.qty), style: 'width:56px', title: 'จำนวน (ของซ้อนได้)' });
  const res = el('small', {});
  const go = el('button', { class: 'tiny', onclick: async () => {
    const unit = Math.floor(+price.value || 0); const n = Math.max(1, Math.min(pick.qty, Math.floor(+qty.value || 1)));
    if (unit < 1) { res.textContent = ' ใส่ราคาก่อน'; return; }
    if (!confirm(`ลงขาย ${w.name} x${n} ราคา ${num(unit)} G/ชิ้น (รวม ${num(unit * n)} G) จาก ${pick.name}?\nภาษีตลาดตามกฎเกม · ตลาดใช้ราว 5 นาทีกว่าประกาศจะขึ้น`)) return;
    go.disabled = true; res.textContent = ' กำลังลงขาย…';
    const r = await dash.invoke('game-cmd', pick.acc, 'marketList', { itemId: pick.itemId, qty: n, unitPrice: unit });
    res.textContent = r && r.ok ? ' ✔ ส่งลงขายแล้ว (ขึ้นตลาดใน ~5 นาที)' : ` ✖ ${(r && r.error) || 'ไม่สำเร็จ'}`;
    go.disabled = false;
  } }, 'ขาย');
  return el('div', { class: 'mw-sell' }, el('div', { class: 'hint' }, `${num(total)} ชิ้น · ${[...new Set(list.map((x) => x.name))].join(', ')}`), price, pick.itemId.includes('#') ? null : qty, go, res);
}
async function openMarketWatch() {
  const q = el('input', { type: 'text', placeholder: 'ค้นชื่อไอเทม (ไทย/อังกฤษ) เช่น ไฮโพชั่น, robe_t10, sky_sentinel', style: 'width:440px;max-width:60vw' });
  const grade = el('select', {}, ...[['normal', 'Normal'], ['magic', 'Magic'], ['rare', 'Rare'], ['epic', 'Epic'], ['stack', 'ของซ้อนได้ / การ์ด']].map(([v, l]) => el('option', { value: v }, l)));
  const found = el('div', { class: 'mw-found' });
  const checkOut = el('div', { class: 'mw-check' });
  const table = el('div', {});
  const every = el('input', { type: 'number', min: '1', max: '60', style: 'width:52px' });
  const status = el('small', { class: 'hint' });
  const G = (n) => (n ? num(Math.round(n)) : '-');
  const add = async (it) => { const r = await dash.invoke('mw-add', { id: it.id, name: it.name, grade: grade.value === 'stack' ? 'normal' : grade.value, gear: grade.value !== 'stack' }); if (r && !r.ok && r.error) showBanner(r.error); load(); };
  const check = async (it) => {
    checkOut.replaceChildren(el('p', { class: 'hint' }, `กำลังเช็คราคา ${it.name}…`));
    const r = await dash.invoke('mw-check', { id: it.id, grade: grade.value === 'stack' ? 'normal' : grade.value, gear: grade.value !== 'stack' });
    checkOut.replaceChildren(r && r.ok
      ? el('div', { class: 'lab-row' }, el('b', {}, it.name + ' '), el('span', { class: 'chip' }, `${r.key || ''}`), el('span', { class: 'chip' }, `ถูกสุดตอนนี้ ${r.basis === 'listed' ? G(r.price) : '-'}`), el('span', { class: 'chip' }, `ขายล่าสุด ${G(r.last)}`), el('span', { class: 'chip' }, `วางขาย ${num(r.stock || 0)}`), el('span', { class: 'chip' }, `ขาย 7 วัน ${num(r.vol7 || 0)}`), el('button', { class: 'tiny', onclick: () => add(it) }, '+ ติดตาม'))
      : el('p', {}, '✖ ' + ((r && r.error) || 'เช็คไม่ได้')));
  };
  let tq = null;
  q.addEventListener('input', () => { clearTimeout(tq); tq = setTimeout(async () => {
    const list = await dash.invoke('mw-search', q.value);
    found.replaceChildren(...list.map((it) => el('span', { class: 'chip mw-item' }, it.name, el('small', { class: 'hint' }, ' ' + it.id), el('button', { class: 'tiny', onclick: () => check(it) }, 'เช็คราคา'), el('button', { class: 'tiny', onclick: () => add(it) }, '+ ติดตาม'))));
  }, 250); });
  // quick add from the selected character's bag (gear keeps its grade)
  const bagGear = tradableGear().slice(0, 12);
  const fromBag = bagGear.length ? el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, 'จากกระเป๋า: '), ...bagGear.map((g) => el('button', { class: 'tiny', onclick: async () => { const r = await dash.invoke('mw-add', { id: g.id, name: g.name, grade: g.rarity || 'normal', gear: true }); if (r && !r.ok && r.error) showBanner(r.error); load(); } }, `${g.name} (${(RARITIES.find((x) => x[0] === (g.rarity || 'normal')) || RARITIES[0])[1]})`))) : null;
  const load = async () => {
    const d = await dash.invoke('mw-list');
    let holders = {}; try { holders = await dash.invoke('mw-holders'); } catch { /* none */ }
    if (document.activeElement !== every) every.value = String(d.every);
    status.textContent = d.online ? `อัปเดตทุก ${d.every} นาที ทีละรายการ ผ่านบัญชีที่ออนไลน์` : '⚠ ไม่มีบัญชีออนไลน์ ราคาจะไม่อัปเดตจนกว่าจะเปิดเกมอย่างน้อย 1 บัญชี';
    if (!d.watch.length) { table.replaceChildren(el('p', { class: 'hint' }, 'ยังไม่ได้ติดตามอะไร · ค้นชื่อไอเทมด้านบนแล้วกด "+ ติดตาม"')); return; }
    const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.mw-table');
    if (active) return; // don't rebuild while typing a price
    table.replaceChildren(el('table', { class: 'lab-maps mw-table' },
      el('tr', {}, ...['ไอเทม', 'ถูกสุดตอนนี้', 'เปลี่ยน', 'ขายล่าสุด', 'วางขาย', 'ขาย 7 วัน', 'กราฟ', 'เตือนเมื่อ ≤', 'เตือนเมื่อ ≥', 'ในกระเป๋า', 'อัปเดต', ''].map((h) => el('th', {}, h))),
      ...d.watch.map((w) => {
        const k = w.key || w.itemId; const v = d.live[k]; const h = d.hist[k] || [];
        const prev = h.length > 1 ? h[h.length - 2] : null;
        const nowP = v ? (v.low || v.last) : 0; const prevP = prev ? (prev[1] || prev[2]) : 0;
        const ch = nowP && prevP ? (nowP / prevP - 1) * 100 : null;
        const below = el('input', { type: 'number', min: '0', value: w.below ? String(w.below) : '', placeholder: '-', style: 'width:96px' });
        const above = el('input', { type: 'number', min: '0', value: w.above ? String(w.above) : '', placeholder: '-', style: 'width:96px' });
        below.addEventListener('change', () => dash.invoke('mw-set', w.itemId, { below: +below.value || 0 }));
        above.addEventListener('change', () => dash.invoke('mw-set', w.itemId, { above: +above.value || 0 }));
        const ago = v ? Math.round((Date.now() - v.at) / 1000) : null;
        return el('tr', {},
          el('td', {}, w.name, el('div', { class: 'hint' }, k)),
          el('td', { class: 'gold' }, v ? (v.low ? G(v.low) : 'ไม่มีคนวางขาย') : '…'),
          el('td', { class: ch == null ? '' : ch > 0 ? 'pos' : ch < 0 ? 'neg' : '' }, ch == null ? '-' : `${ch > 0 ? '▲' : ch < 0 ? '▼' : '='} ${Math.abs(ch).toFixed(1)}%`),
          el('td', {}, v ? G(v.last) : '…'), el('td', {}, v ? num(v.stock) : '…'), el('td', {}, v ? num(v.vol7) : '…'),
          el('td', {}, spark(h.slice(-60))), el('td', {}, below), el('td', {}, above),
          el('td', {}, sellCell(w, v, holders[w.itemId] || [])),
          el('td', { class: 'hint' }, ago == null ? 'รอ' : ago < 60 ? `${ago} วิ` : `${Math.round(ago / 60)} นาที`),
          el('td', {}, el('button', { class: 'tiny', title: 'อัปเดตตอนนี้', onclick: () => { dash.invoke('mw-now', w.itemId); } }, '⟳'), el('button', { class: 'tiny', title: 'เลิกติดตาม', onclick: async () => { await dash.invoke('mw-remove', w.itemId); load(); } }, '✕')));
      })));
  };
  every.addEventListener('change', async () => { await dash.invoke('mw-every', +every.value || 2); load(); });
  openModal('📈 ตลาดกลางเรียลไทม์', [
    el('div', { class: 'lab-row' }, q, el('small', { class: 'hint' }, ' เกรด '), grade),
    found, checkOut, fromBag,
    el('div', { class: 'lab-row' }, el('small', {}, 'อัปเดตทุก '), every, el('small', {}, ' นาที · '), status),
    table,
    el('p', { class: 'hint' }, 'ราคาตามชนิด + เกรด เหมือนตารางตลาดในเกม · ถูกสุดตอนนี้ = ประกาศที่ถูกที่สุด · ขายล่าสุด = ราคาที่ขายได้จริงครั้งล่าสุด · แจ้งเตือนผ่าน Windows และ Telegram (ถ้าเปิดไว้) เมื่อราคาข้ามเส้นที่ตั้ง'),
  ]);
  $('#modal').classList.add('wide');
  load();
  clearInterval(mwTimer);
  mwTimer = setInterval(() => { if ($('#modal').hidden || !document.querySelector('.mw-table, .mw-found')) { clearInterval(mwTimer); return; } load(); }, 3000);
}
// the bag can take the whole right column (other panels step aside) and come back
{
  let max = false; try { max = localStorage.getItem('bag-max') === '1'; } catch { /* */ }
  const apply = () => { document.querySelector('.rightcol').classList.toggle('bag-max', max); $('#bag-max').textContent = max ? '⤡' : '⤢'; if (max) document.querySelector('.bag').classList.remove('folded'); };
  $('#bag-max').addEventListener('click', (e) => { e.stopPropagation(); max = !max; try { localStorage.setItem('bag-max', max ? '1' : ''); } catch { /* */ } apply(); });
  apply();
}
// right-column panels fold by clicking their title (remembered per panel)
for (const sec of document.querySelectorAll('[data-fold]')) {
  const key = 'fold-' + sec.dataset.fold;
  const h = sec.querySelector('h3');
  const set = (on) => { sec.classList.toggle('folded', on); try { localStorage.setItem(key, on ? '1' : ''); } catch { /* private window */ } };
  let saved = false; try { saved = localStorage.getItem(key) === '1'; } catch { /* ignore */ }
  set(saved);
  h.classList.add('foldable'); h.title = 'คลิกเพื่อย่อ/ขยาย';
  h.addEventListener('click', (e) => { if (e.target.closest('button,input')) return; set(!sec.classList.contains('folded')); });
}
$('#toggle-all').addEventListener('click', () => dash.invoke('toggle-all'));
$('#toggle-settings').addEventListener('click', () => dash.invoke('open-settings'));

dash.onState((s) => { state = s; render(); if (sleepOn) renderSleep(); });
dash.invoke('state').then((s) => { state = s; render(); refreshDetail(); });
// every second while you use the Dashboard; every 3 s while you play in a game window; not at all in the sleep view
// (each refresh is work for the app while the games run)
let lastDetailAt = 0;
setInterval(() => {
  if (typeof sleepOn !== 'undefined' && sleepOn) return;
  if (!document.hasFocus() && Date.now() - lastDetailAt < 3000) return;
  lastDetailAt = Date.now(); refreshDetail();
}, 1000);

// macOS: shortcuts use Cmd, and "start with Windows" means start at login
if (dash.platform === 'darwin') {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/Ctrl|พร้อม Windows|มุมขวาล่าง/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/Ctrl\+/g, 'Cmd+').replace(/พร้อม Windows/g, 'ตอนเปิด Mac').replace(/มุมขวาล่าง/g, 'บนแถบเมนูด้านบน');
}

// fold up / down (remembered): the numbers block and the events (damage) log
{
  const fold = (btn, box, cls, key, on, offTxt, onTxt) => { box.classList.toggle(cls, on); btn.textContent = on ? onTxt : offTxt; try { localStorage.setItem(key, on ? '1' : ''); } catch { /* storage off */ } };
  const tb = $('#tiles-fold'); const prof = document.querySelector('.profile');
  const tSet = (on) => fold(tb, prof, 'tiles-min', 'tilesMin', on, '📊 สรุป ▴', '📊 สรุป ▾');
  tb.addEventListener('click', () => tSet(!prof.classList.contains('tiles-min')));
  const eb = $('#ev-fold'); const logs = document.querySelector('.logs');
  const eSet = (on) => fold(eb, logs, 'ev-min', 'evMin', on, 'ย่อ ▴', 'ขยาย ▾');
  eb.addEventListener('click', () => eSet(!logs.classList.contains('ev-min')));
  try { tSet(localStorage.getItem('tilesMin') === '1'); eSet(localStorage.getItem('evMin') === '1'); } catch { /* storage off */ }
}

// ---------- sleep view: every account at a glance, like the game's own sleep screen, live ----------
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
$('#sleep-btn').addEventListener('click', () => setSleep(true));
$('#sl-exit').addEventListener('click', () => setSleep(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sleepOn) setSleep(false); });
