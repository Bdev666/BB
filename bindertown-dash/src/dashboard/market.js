// real-time market watch.
// Loaded before dashboard.js: only declarations here; they run when dashboard.js calls them.

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

// every second while you use the Dashboard; every 3 s while you play in a game window; not at all in the sleep view
// (each refresh is work for the app while the games run)
let lastDetailAt = 0;
