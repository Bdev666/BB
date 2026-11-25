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
  // the same picture the log writes every 30 minutes: what it farms now and what it earns there (last hour on this map)
  open && a.farmNow ? el('div', { class: 'acc-meta acc-health', title: 'ชั่วโมงล่าสุดบนแมพนี้ (เงินสุทธิ = เงินจากมอน + ของขาย NPC − ค่าตาย) · ตัวขับ = ระบบที่คุมตัวละครอยู่' },
    el('span', {}, `💰 ${short(a.farmNow.netHr || 0)}/ชม.`), a.farmNow.deathsHr ? el('span', { class: 'neg' }, ` ☠ ${a.farmNow.deathsHr}/ชม.`) : null,
    a.driver ? el('span', { class: 'hint' }, ` · ${a.driver}`) : null) : null,
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
function canSell() { const a = state && state.accounts && state.accounts.find((x) => x.id === selected); return a && a.premium !== undefined ? !!a.premium : !!(detail && detail.stats && detail.stats.premium); }

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
$('#sleep-btn').addEventListener('click', () => setSleep(true));
$('#sl-exit').addEventListener('click', () => setSleep(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sleepOn) setSleep(false); });
