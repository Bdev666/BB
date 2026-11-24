const HUB = require('../core/hub');

// ---------- farm ledger: what one minute of farming is really worth, per map ----------
// Counted: the Silver balance going up while AUTO farms = Silver from kills (the game's own number, so combo and
// Gold cards are already in it) + the game's auto-sell / Soulforge of Normal/Magic gear, minus potions bought and
// respawn fees, + ETC picked up at the NPC price. Never counted: market prices, mail, Pass, bounty rewards (a minute
// with one of those in it is left out), minutes on the road, at a world boss or without a kill.
const FARM_KEEP = 300; // rows (= farming minutes) kept per account + map
const FARM_DAYS = 10;
let farmDirtyStore = false;
function farmBucket(g) {
  const m = Math.floor(Date.now() / 60000);
  if (!g.ledger || g.ledger.m !== m) {
    if (g.ledger) farmClose(g.ledger);
    g.ledger = { m, id: g.accId, map: HUB.mapOf(g), lv: g.data.stats.level || 0, bal: 0, kill: 0, etc: 0, kills: 0, dirty: !!(g.bossTrip || g.travelling) };
  }
  return g.ledger;
}
HUB.farmDirty = HUB.farmDirty = function farmDirty(g) { if (g) farmBucket(g).dirty = true; };;
HUB.farmEvent = HUB.farmEvent = function farmEvent(id, g, ev) {
  if (!g.inGame || g.demo) return;
  const L = farmBucket(g);
  if (ev.type === 'kill') { L.kills++; L.kill += Number(ev.silver) || 0; }
  else if (ev.type === 'loot' && ev.value > 0 && /^drop_/.test(ev.id || '')) { L.etc += ev.value; (g.etcPrice || (g.etcPrice = {}))[HUB.baseOf(ev.id)] = ev.value / (ev.qty || 1); }
  else if (ev.type === 'sold' && ev.auto) { const p = g.etcPrice && g.etcPrice[HUB.baseOf(ev.id || '')]; if (p) L.etc -= p * (ev.qty || 1); } // ETC sold by the game: the balance has it now
  else if (ev.type === 'sold' && !ev.auto) L.dirty = true; // a sale from the sell window (old loot) is not this minute's farming
};;
HUB.farmBalance = HUB.farmBalance = function farmBalance(g) {
  const s = Number(g.data.stats.silver);
  if (!Number.isFinite(s)) return;
  const L = farmBucket(g);
  if (g.lastBal != null) L.bal += s - g.lastBal;
  if (L.map !== HUB.mapOf(g) || (g.claimUntil && Date.now() < g.claimUntil)) L.dirty = true; // changed map inside the minute / rewards coming in
  g.lastBal = s;
};;
function farmClose(L) {
  if (L.dirty || !L.kills || !L.map || HUB.WORLD_ARENAS.has(L.map) || !L.id) return;
  if (L.bal - L.kill > 20000000) { HUB.log.info(`farm ledger acc ${L.id}: +${L.bal} Silver in one minute on ${L.map} (not from kills or sales?) -> left out`); return; } // a claim / trade the dashboard did not see
  const all = HUB.store.data.farm || (HUB.store.data.farm = {});
  const key = `${L.id}:${L.map}`;
  const rows = all[key] || (all[key] = []);
  rows.push([L.m, L.lv, Math.round(L.bal + L.etc), Math.round(L.kill), L.kills]);
  const old = Math.floor(Date.now() / 60000) - FARM_DAYS * 1440;
  while (rows.length && (rows.length > FARM_KEEP || rows[0][0] < old)) rows.shift();
  farmDirtyStore = true;
}
// per map for one account, near its level: Silver per hour (median of the minutes, one bad minute does not swing it)
let farmHistCache = null;
function farmHist() { if (!farmHistCache || Date.now() - farmHistCache.at > 30 * 60000) { let h = {}; try { h = HUB.selftest.farmHistory(14); } catch (e) { HUB.log.warn(`farm history: ${e.message}`); } farmHistCache = { at: Date.now(), h }; } return farmHistCache.h; }
HUB.farmSummary = HUB.farmSummary = function farmSummary(accId, level, sinceMin = 0) {
  const live = farmSummaryLedger(accId, level, sinceMin);
  if (sinceMin) return live; // a measurement window: only what was measured in it
  // + the stats log (every 10 min, 14 days): Silver from kills per map. It has no auto-sell, so maps known only from
  // there get an estimate: their kill Silver x this account's own (profit / kill Silver) from maps measured both ways
  const hist = farmHist(); const byMap = new Map(live.map((x) => [x.map, x]));
  const ratios = live.filter((x) => x.minutes >= 10 && x.killSilverHr > 0).map((x) => x.netHr / x.killSilverHr);
  const ratio = ratios.length ? Math.max(0.8, Math.min(3, ratios.reduce((t, x) => t + x, 0) / ratios.length)) : 1;
  for (const a of Object.values(hist)) {
    if (Number(a.acc) !== accId || HUB.WORLD_ARENAS.has(a.map)) continue;
    const st = a.steps.filter((s) => !level || !s.lv || Math.abs(s.lv - level) <= 5);
    const min = st.reduce((t, s) => t + s.min, 0); if (min < 20) continue;
    const killHr = Math.round(st.reduce((t, s) => t + s.silver, 0) / min * 60); const killsHr = Math.round(st.reduce((t, s) => t + s.kills, 0) / min * 60);
    if (killsHr < 100) continue; // a town / standing around, not a farm
    // deaths cost: respawning in place is 5,000 G each in fields (a log: a Scout dying 45 times an hour paid
    // 2/3 of its kill Silver back in fees); time lost dead is already in the kill numbers
    const deathsHr = +(st.reduce((t, s) => t + (s.deaths || 0), 0) / min * 60).toFixed(1);
    const fee = Math.round(deathsHr * 5000);
    const x = byMap.get(a.map);
    if (x) Object.assign(x, { histMinutes: min, histKillHr: killHr, deathsHr });
    else { const e = { map: a.map, name: HUB.mapName(a.map), minutes: 0, netHr: Math.round(killHr * ratio) - fee, est: true, killSilverHr: killHr, killsHr, deathsHr, histMinutes: min, histKillHr: killHr, last: Math.max(...st.map((s) => s.t)) }; live.push(e); byMap.set(a.map, e); }
  }
  return live.sort((p, q) => q.netHr - p.netHr);
};;
function farmSummaryLedger(accId, level, sinceMin = 0) {
  const out = [];
  for (const [key, rows] of Object.entries(HUB.store.data.farm || {})) {
    const [a, map] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (Number(a) !== accId) continue;
    const r = rows.filter((x) => x[0] >= sinceMin && (!level || !x[1] || Math.abs(x[1] - level) <= 5));
    if (!r.length) continue;
    // the plain average: sales come in lumps, a median would leave them out
    const mean = r.reduce((t, x) => t + x[2], 0) / r.length;
    out.push({ map, name: HUB.mapName(map), minutes: r.length, netHr: Math.round(mean * 60), killSilverHr: Math.round(r.reduce((t, x) => t + x[3], 0) / r.length * 60), killsHr: Math.round(r.reduce((t, x) => t + x[4], 0) / r.length * 60), last: r[r.length - 1][0] * 60000 });
  }
  return out.sort((p, q) => q.netHr - p.netHr);
}
HUB.farmSaveTick = HUB.farmSaveTick = function farmSaveTick() { if (farmDirtyStore) { farmDirtyStore = false; HUB.store.save(); } };;

// The game's own "open the world map on this map" (its main module exports it as openWorldMap), found once per page.
// Text for page scripts: an async function that returns true once window.__bdOpenWorld is there.
const FIND_WORLD_MAP = `async () => { if (window.__bdOpenWorld) return true;
  const urls = [...new Set([...performance.getEntriesByType('resource').map((e) => e.name), ...[...document.scripts].map((x) => x.src)].filter((u) => /\\/assets\\/main-[\\w-]+\\.js(\\?|$)/.test(u || '')))];
  for (const u of urls) { try { const m = await import(u); if (m && typeof m.openWorldMap === 'function') { window.__bdOpenWorld = m.openWorldMap; return true; } } catch (e) {} }
  return false; }`;

// ---------- does this game build still have what each automation uses? ----------
const UI_CHECK_JS = `(async () => { const g = window.__game; const has = (id) => !!document.getElementById(id);
  const fn = (k) => !!(g && typeof g[k] === 'function');
  const world = await (${FIND_WORLD_MAP})();
  return { api: fn('me') && fn('state') && fn('mapId'), sell: fn('sell'), autoPanel: has('autoopt') && has('autoopts'), farmRange: has('au-farm'), targets: has('au-targets'), respawnBox: has('au-respawn'),
    hunt: has('openhunt') && has('huntwin'), channel: has('chbtn'), worldMap: world, worldBtn: has('worldbtn') }; })()`;
const UI_USES = { api: 'อ่านข้อมูลตัวละคร (ทุกระบบ)', sell: 'ขายของให้ NPC', autoPanel: 'ตั้งค่า AUTO (ระยะฟาร์ม, เลือกมอน, เกิดที่เดิม)', farmRange: 'ระยะฟาร์ม (ค่าหัว / หาที่ฟาร์ม)', targets: 'ตีเฉพาะมอนค่าหัว', respawnBox: 'เปิดเกิดที่เดิมอัตโนมัติ', hunt: 'ทำค่าหัว', channel: 'ย้าย CH เมื่อคนเยอะ', worldMap: 'เดินทางไปแมพ (หาที่ฟาร์ม / ไปฟาร์ม / กลับจุดเดิม)', worldBtn: 'แผนที่โลก' };
HUB.uiCheck = HUB.uiCheck = async function uiCheck(id, g) {
  if (!g.win || g.win.isDestroyed() || !g.inGame || g.demo) return;
  let r; try { r = await g.win.webContents.executeJavaScript(UI_CHECK_JS, true); } catch { return; }
  if (!r) return;
  const missing = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  g.uiMissing = missing;
  if (missing.length) {
    HUB.log.warn(`acc ${id}: this game build lacks what some automations use: ${missing.join(', ')}`);
    HUB.setAlert(id, 'uiMissing', true, `⚠ เกมอัปเดต: ระบบเหล่านี้อาจใช้ไม่ได้ · ${missing.map((k) => UI_USES[k] || k).join(' · ')} · ส่ง log ให้ผู้พัฒนา`);
  } else { if (g.alerts.has('uiMissing')) HUB.setAlert(id, 'uiMissing', false); HUB.log.info(`acc ${id}: game buttons used by the automations: all there`); }
};;

// ---------- who drives this character now ----------
// Every system that walks, travels or presses AUTO asks mayAct() first. Order: world boss (and the way back
// from it) > bounty > farm finder / a map chosen in the Dashboard / back after a death > crowded-channel move >
// AUTO-stuck fix / RAM reload. A higher one pauses the lower ones; equal or lower ones wait.
const DRIVE_PRIO = { boss: 5, bossReturn: 5, bounty: 4, finder: 3, travel: 3, deathReturn: 3, crowd: 1, stuck: 1, ram: 0 };
HUB.DRIVE_TH = { boss: 'ตีบอสโลก', bossReturn: 'กลับจุดฟาร์มหลังบอส', bounty: 'ทำค่าหัว', finder: 'หาที่ฟาร์ม', travel: 'เดินทางไปแมพที่เลือก', deathReturn: 'กลับจุดฟาร์มหลังตาย', crowd: 'ย้าย CH', stuck: 'แก้ AUTO ค้าง', ram: 'คืนแรม' };
HUB.driverOf = HUB.driverOf = function driverOf(g) {
  const now = Date.now(); const list = [];
  if (g.bossTrip || HUB.WORLD_ARENAS.has(HUB.mapOf(g))) list.push('boss');
  if (g.loopBack && !g.loopBack.done) list.push(g.loopBack.why === 'boss' ? 'bossReturn' : 'deathReturn');
  if (g.bounty && g.bounty.on) list.push('bounty');
  if (g.finder && g.finder.on) list.push('finder');
  if (g.travelling && now - g.travelling.at < 8 * 60000) list.push('travel');
  if (g.crowdBusy) list.push('crowd');
  if (g.ramReloadAt && now - g.ramReloadAt < 90 * 1000) list.push('ram');
  list.sort((a, b) => DRIVE_PRIO[b] - DRIVE_PRIO[a]);
  return list[0] || null;
};;
// who may go ahead: nobody else drives, or it is itself, or it outranks the one driving
HUB.mayAct = HUB.mayAct = function mayAct(g, who) {
  const d = HUB.driverOf(g);
  return !d || d === who || DRIVE_PRIO[who] > DRIVE_PRIO[d];
};;
HUB.waitNote = HUB.waitNote = function waitNote(g) { const d = HUB.driverOf(g); return d ? `รอ: กำลัง${HUB.DRIVE_TH[d]}` : ''; };;

// ---------- AUTO on but nothing hit for 3 minutes: switch AUTO off and on again (at most 4 times an hour) ----------
async function stuckCheck(id, g) {
  if (!HUB.store.data.settings.stuckFix || !g.inGame || g.demo || g.status !== 'online' || g.alerts.has('death') || g.humanCheck) return;
  const d0 = HUB.driverOf(g); if (d0 && d0 !== 'bounty' && d0 !== 'finder') return; // something is moving it (a bounty / finder standing on its map may be helped)
  if (g.bounty && g.bounty.on && g.bounty.phase === 'travel') return;
  const now = Date.now(); const last = Math.max(g.lastHitAt || 0, g.inGameAt || 0, g.autoSeenOffAt || 0);
  if (now - last < 3 * 60000) return;
  const ui = await HUB.liveUi(id);
  if (!ui.auto || ui.sleeping) { g.autoSeenOffAt = now; return; } // the player switched AUTO off: leave it
  g.kicks = (g.kicks || []).filter((t) => now - t < 3600000);
  if (g.kicks.length >= 4 || (g.kicks.length && now - g.kicks[g.kicks.length - 1] < 4 * 60000)) return;
  g.kicks.push(now);
  HUB.log.info(`acc ${id}: AUTO on but no hit for ${Math.round((now - last) / 60000)} min on ${HUB.mapOf(g)} -> AUTO off/on (${g.kicks.length} this hour)`);
  g.data.log('other', '🔧 AUTO เปิดอยู่แต่ไม่ได้ตี 3 นาที · ปิดแล้วเปิด AUTO ใหม่');
  HUB.selftest.count(id, 'stuckFix');
  await HUB.gameCommand(id, 'auto', {}); await HUB.sleep(1500);
  if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
  g.autoSeenOffAt = now; // give it 3 more minutes
}

// ---------- after a death-loop pause: back to the farming spot, AUTO on (once an hour; a second loop = stay, say so) ----------
async function loopBackCheck(id, g) {
  const L = g.loopBack;
  if (!L || L.done || L.busy || !g.inGame || g.demo || g.status !== 'online' || !L.map) return;
  if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return;
  if (L.giveUp) { L.done = true; HUB.notify(id, 'death', `☠ ตายวนซ้ำอีกรอบใน 1 ชม. ที่ ${HUB.mapName(L.map)} · ไม่พากลับแล้ว รอคุณดู (ลองแมพที่มอนเบาลง หรือเช็คยา/อุปกรณ์)`); HUB.log.info(`acc ${id}: death loop again at ${L.map} -> not going back`); return; }
  if (HUB.WORLD_ARENAS.has(HUB.mapOf(g)) && !g.bossTrip && Date.now() - L.at < 3 * 60000) return; // still leaving the arena
  if (g.bossTrip || HUB.WORLD_ARENAS.has(HUB.mapOf(g))) return; // a new boss trip: wait for it
  // a bounty or the finder took the character meanwhile: they decide where it goes now
  if ((g.bounty && g.bounty.on) || (g.finder && g.finder.on)) { L.done = true; HUB.log.info(`acc ${id}: back to farm: not needed, ${g.bounty && g.bounty.on ? 'bounty' : 'farm finder'} runs it`); return; }
  L.busy = true;
  try {
    if (HUB.mapOf(g) !== L.map) {
      HUB.log.info(`acc ${id}: ${L.why === 'boss' ? 'world boss done' : 'death-loop pause over'}, in ${HUB.mapOf(g)} -> back to ${L.map}`);
      const r = await travelTo(id, g, L.map);
      if (!r.ok) { L.done = true; HUB.log.info(`acc ${id}: back to farm: ${r.error}`); return; }
      if (!r.here && !(await arrive(id, g, L.map, 6 * 60000, true))) { L.done = true; HUB.log.info(`acc ${id}: back to farm: did not arrive`); return; }
    }
    if (L.x != null) {
      if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
      // up to ~3 minutes: the spot can be across a big map from where the warp lands
      let left = null;
      for (let i = 0; i < 70; i++) { // eslint-disable-line no-await-in-loop
        const st = (g.data.world && g.data.world.self) || {};
        if (st.x == null) { await HUB.sleep(1500); continue; } // eslint-disable-line no-await-in-loop
        left = Math.hypot(st.x - L.x, st.y - L.y);
        if (left <= 3 || HUB.mapOf(g) !== L.map) break;
        await HUB.sendInput(id, { type: 'moveTo', x: L.x, y: L.y }); // eslint-disable-line no-await-in-loop
        await HUB.sleep(2500); // eslint-disable-line no-await-in-loop
      }
      HUB.log.info(`acc ${id}: walked back to ${Math.round(L.x)},${Math.round(L.y)} on ${L.map}${left != null ? ` (${Math.round(left)} tiles left)` : ' (position unknown)'}`);
    }
    if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
    g.autoSeenOffAt = Date.now();
    L.done = true;
    HUB.log.info(`acc ${id}: back at the farming spot on ${L.map}${L.why === 'boss' ? ' after the world boss' : ''}, AUTO on`);
    g.data.log('other', `↩ กลับจุดฟาร์ม${L.why === 'boss' ? 'หลังตีบอสโลก' : 'หลังพักเกิดที่เดิม 10 นาที'} · ${HUB.mapName(L.map)} · เปิด AUTO`);
  } finally { L.busy = false; }
}

// ---------- travel to any map with the game's own world-map "travel" button ----------
// The game opens its world map on a map from the hunt window's "ไปที่แมพ" buttons; the button reads the map when
// clicked, so any of them can open the world map on another map. Then the game's "เดินทางไป …" (warp when free).
// The game's own "open the world map on this map" (its module exports it as openWorldMap; the hunt window, the
// guide and the atlas all call it), then the game's "เดินทางไป …" button: warps when free, else walks.
// Fallback when the module cannot be reached: a hunt-window "ไปที่แมพ" button pointed at the map (needs a bounty left).
const TRAVEL_JS = (map) => `(async () => { const MAP = ${JSON.stringify(map)}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let how = '';
  try { if (await (${FIND_WORLD_MAP})()) { window.__bdOpenWorld(MAP, true); how = 'worldmap'; } } catch (e) {}
  if (!how) {
    const win = document.getElementById('huntwin'); const open = document.getElementById('openhunt'); if (!win || !open) return { ok: false, why: 'no world map and no hunt window' };
    if (win.style.display !== 'block') open.click();
    await wait(600);
    let b = document.querySelector('#huntwin [data-goto]');
    if (!b) { for (const t of win.querySelectorAll('[data-htab]')) { t.click(); await wait(400); b = document.querySelector('#huntwin [data-goto]'); if (b) break; } }
    if (!b) { win.style.display = 'none'; return { ok: false, why: 'no map button' }; }
    b.dataset.goto = MAP; b.click(); how = 'hunt';
  }
  let go = null; for (let i = 0; i < 10 && !go; i++) { await wait(300); go = document.querySelector('.wdgo'); }
  if (!go) return { ok: false, why: 'no travel button (' + how + ')' };
  go.click(); return { ok: true, how }; })()`;
HUB.travelTo = travelTo; // the bounty travels the same way
async function travelTo(id, g, map) {
  if (HUB.mapOf(g) === map) return { ok: true, here: true };
  if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); // the game's travel walks; AUTO would fight on the way
  let r; try { r = await g.win.webContents.executeJavaScript(TRAVEL_JS(map), true); } catch (e) { r = { ok: false, why: e.message }; }
  if (!r || !r.ok) return { ok: false, error: `เดินทางไม่ได้ (${(r && r.why) || '?'})` };
  g.travelling = { map, at: Date.now() }; HUB.farmDirty(g);
  HUB.log.info(`acc ${id}: travel ${HUB.mapOf(g)} -> ${map} (${r.how})`);
  await HUB.answerWarpBox(id, g);
  return { ok: true };
}
// wait until the character is on the map (6 minutes at most), then AUTO on over the whole map
async function arrive(id, g, map, maxMs = 6 * 60000, keepRange = false) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!g.win || g.win.isDestroyed()) return false;
    if (HUB.mapOf(g) === map) {
      await HUB.sleep(2500);
      g.travelling = null;
      if (keepRange) return true; // the caller walks to its spot and starts AUTO there
      await HUB.setFarmRange(g, 0);
      if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
      g.autoSeenOffAt = Date.now();
      return true;
    }
    if ((Date.now() - t0) % 20000 < 2100) await HUB.answerWarpBox(id, g);
    await HUB.sleep(2000); // eslint-disable-line no-await-in-loop
  }
  g.travelling = null;
  return false;
}

// ---------- find the farm that pays most: try the best few maps for real, then stay on the winner ----------
// Candidates: Build Lab's map list for this character (its level, safe enough: 5+ hits to die) + maps it already
// farmed. Each new one is farmed N minutes and judged by the ledger above; maps with enough recent minutes are not
// tried again. Free travel only (walks when a warp would cost Gold). Stops for world bosses and bounties.
HUB.finderStatus = HUB.finderStatus = function finderStatus(g) { const f = g.finder; return f ? { on: !!f.on, note: f.note || '', i: f.i, n: (f.list || []).length, best: f.best || null } : null; };;
HUB.finderStart = HUB.finderStart = async function finderStart(id, on) {
  const g = HUB.games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!on) { if (g.finder) { g.finder.on = false; g.finder.note = 'หยุดแล้ว'; } g.travelling = null; HUB.log.info(`acc ${id}: farm finder stopped`); HUB.pushState(); return { ok: true }; }
  if (g.bounty && g.bounty.on) return { ok: false, error: 'กำลังทำค่าหัวอยู่ · หยุดค่าหัวก่อน' };
  const me = HUB.labMeRef && await HUB.labMeRef(id);
  if (!me) return { ok: false, error: 'อ่านข้อมูลตัวละครไม่ได้' };
  let sim = null;
  try {
    sim = await HUB.labCall(`window.__bdLab.maps(${JSON.stringify({ job: me.job, level: me.level, jobLevel: me.jobLevel, stats: me.stats, basics: me.skills, guild: me.guildLevel || 0, c2Job: (me.c2info && me.c2info.jobLevel) || 50,
      loadout: { ...(me.loadout || {}), wRefine: me.wRefine, sRefine: me.sRefine }, build: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr }, pack: 3, top: 40 })})`);
  } catch (e) { HUB.log.warn(`acc ${id}: farm finder maps: ${e.message}`); }
  const lv = me.level;
  const minutes = Math.max(5, Math.min(30, Number(HUB.store.data.settings.farmTrialMinutes) || 10));
  const known = new Map([...HUB.farmSummary(id, lv).filter((x) => x.est && x.histMinutes >= 30), ...HUB.farmSummary(id, lv, Math.floor(Date.now() / 60000) - 3 * 1440).filter((x) => x.minutes >= minutes)].map((x) => [x.map, x]));
  // safe first (5+ hits to die); if that leaves fewer than 3 other maps, take 3+ hits, then any in the level band
  const inBand = ((sim && sim.rows) || []).filter((r) => r.band && r.band[0] <= lv + 3 && !HUB.WORLD_ARENAS.has(r.id));
  let rows = inBand.filter((r) => r.hitsToDie == null || r.hitsToDie >= 5);
  if (rows.filter((r) => r.id !== HUB.mapOf(g)).length < 3) rows = inBand.filter((r) => r.hitsToDie == null || r.hitsToDie >= 3);
  if (rows.filter((r) => r.id !== HUB.mapOf(g)).length < 3) rows = inBand;
  if (!sim) HUB.log.info(`acc ${id}: farm finder: Build Lab map list not available, only maps farmed before`);
  const list = [];
  const here = HUB.mapOf(g);
  if (!known.has(here) && !HUB.WORLD_ARENAS.has(here)) list.push({ map: here, sim: (rows.find((r) => r.id === here) || {}).silverHr || 0 });
  for (const r of rows) { if (list.length >= 4) break; if (!known.has(r.id) && !list.some((x) => x.map === r.id)) list.push({ map: r.id, sim: r.silverHr }); }
  if (!list.length && !known.size) return { ok: false, error: 'หาแมพที่จะลองไม่ได้ (Build Lab ไม่ตอบ และยังไม่เคยฟาร์มที่ไหน) · ลองใหม่อีกครั้ง' };
  if (list.length <= 1 && known.size === 0) HUB.log.info(`acc ${id}: farm finder: only ${list.length} map to try`);
  g.finder = { on: true, list, i: 0, phase: 'go', minutes, lv, note: 'เริ่ม', start: 0, deaths0: 0, tries: {} };
  HUB.log.info(`acc ${id}: farm finder start (Lv ${lv}, ${minutes} min each): try ${list.map((x) => x.map).join(', ') || '-'}; known ${[...known.keys()].join(', ') || '-'}`);
  finderStep(id).catch((e) => HUB.log.warn(`acc ${id}: farm finder: ${e.message}`));
  HUB.pushState();
  return { ok: true, trying: list.map((x) => HUB.mapName(x.map)), known: [...known.values()].map((x) => x.name) };
};;
async function finderStep(id) {
  const g = HUB.games.get(id); const f = g && g.finder;
  if (!f || !f.on || f.busy || !g.inGame || g.demo || g.status !== 'online') return;
  if (g.bounty && g.bounty.on) { f.on = false; f.note = 'หยุด: เริ่มทำค่าหัว'; return; }
  if (!HUB.mayAct(g, 'finder')) { f.note = HUB.waitNote(g) || f.note; return; } // a world boss (or the way back from it) first
  f.busy = true;
  try {
    const deaths = (HUB.selftest.counters.get(id) || {}).deaths || 0;
    if (f.phase === 'go') {
      const c = f.list[f.i];
      if (!c) { f.phase = 'pick'; return; }
      f.note = `ไปลองฟาร์ม ${HUB.mapName(c.map)} (${f.i + 1}/${f.list.length})`;
      const r = await travelTo(id, g, c.map);
      if (!r.ok) { HUB.log.info(`acc ${id}: farm finder: ${r.error} -> skip ${c.map}`); f.i++; return; }
      if (!r.here && !(await arrive(id, g, c.map))) { HUB.log.info(`acc ${id}: farm finder: did not reach ${c.map} -> skip`); f.i++; return; }
      if (r.here) { await HUB.setFarmRange(g, 0); if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); }
      f.phase = 'measure';
      if (f.back) { f.back = false; f.at += Date.now() - f.leftAt; return; } // back after dying in town: keep counting
      f.start = Math.floor(Date.now() / 60000) + 1; f.deaths0 = deaths; f.at = Date.now();
      HUB.log.info(`acc ${id}: farm finder measuring ${c.map} for ${f.minutes} min`);
      return;
    }
    if (f.phase === 'measure') {
      const c = f.list[f.i];
      const got = (HUB.farmSummary(id, 0, f.start).find((x) => x.map === c.map) || {}).minutes || 0;
      f.note = `วัดผล ${HUB.mapName(c.map)} ${got}/${f.minutes} นาที (${f.i + 1}/${f.list.length})`;
      // dying already shows in the measured profit (time lost); with respawn in place it is no reason to skip a map,
      // only a death loop is (the respawn guard's own limit). Without it every death is a walk back from town.
      if (deaths - f.deaths0 >= (g.autoRespawn && g.autoRespawn.on ? 8 : 3)) { HUB.log.info(`acc ${id}: farm finder: ${deaths - f.deaths0} deaths on ${c.map} -> not safe, next`); c.unsafe = true; f.i++; f.phase = 'go'; return; }
      if (got >= f.minutes || Date.now() - f.at > f.minutes * 2 * 60000) { f.i++; f.phase = 'go'; return; }
      // died and woke up in town (no respawn in place): go back to the map being tried
      if (HUB.mapOf(g) !== c.map && !g.travelling && !g.alerts.has('death')) { HUB.log.info(`acc ${id}: farm finder: in ${HUB.mapOf(g)} instead of ${c.map} (died?) -> back`); f.back = true; f.leftAt = Date.now(); f.phase = 'go'; }
      return;
    }
    if (f.phase === 'pick') {
      const unsafe = new Set(f.list.filter((x) => x.unsafe).map((x) => x.map));
      // measured in the last 3 days, plus maps known from the stats log (estimated); the measured number wins per map
      const recent = HUB.farmSummary(id, f.lv, Math.floor(Date.now() / 60000) - 3 * 1440).filter((x) => x.minutes >= 3);
      const fromLog = HUB.farmSummary(id, f.lv).filter((x) => x.est && x.histMinutes >= 30 && !recent.some((y) => y.map === x.map));
      const all = [...recent, ...fromLog].filter((x) => !unsafe.has(x.map) && !HUB.WORLD_ARENAS.has(x.map)).sort((p, q) => q.netHr - p.netHr);
      const best = all[0];
      if (!best) { f.on = false; f.note = 'ยังไม่มีข้อมูลพอ (ไม่ได้ฟาร์มครบนาทีในแมพไหนเลย)'; return; }
      f.best = { map: best.map, name: best.name, netHr: best.netHr };
      f.note = `ไปฟาร์มที่ดีสุด ${best.name}`;
      const r = await travelTo(id, g, best.map);
      if (r.ok && !r.here) await arrive(id, g, best.map);
      else if (r.here) { if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); }
      f.on = false;
      f.note = `ดีสุด: ${best.name} ~${Math.round(best.netHr).toLocaleString('en-US')} Silver/ชม.`;
      const top = all.slice(0, 4).map((x, k) => `${k + 1}. ${x.name} ${Math.round(x.netHr / 1000)}k/ชม.`).join(' · ');
      HUB.log.info(`acc ${id}: farm finder done -> ${best.map} (${best.netHr}/h); ${all.map((x) => `${x.map} ${x.netHr} (${x.minutes} min)`).join(', ')}`);
      HUB.notify(id, 'farm', `🔎 หาที่ฟาร์มเสร็จ · ${top}${unsafe.size ? ` · ตายบ่อย ข้าม: ${[...unsafe].map(HUB.mapName).join(', ')}` : ''}`);
    }
  } finally { f.busy = false; HUB.pushState(); }
}
HUB.farmGo = HUB.farmGo = async function farmGo(id, map) {
  const g = HUB.games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!HUB.mayAct(g, 'travel')) return { ok: false, error: HUB.waitNote(g) || 'ตัวละครกำลังทำอย่างอื่นอยู่' };
  if (g.finder && g.finder.on) { g.finder.on = false; g.finder.note = 'หยุด: คุณเลือกแมพเอง'; } // the player's choice wins over the finder
  const r = await travelTo(id, g, map);
  if (!r.ok) return r;
  if (r.here) { if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); return { ok: true }; }
  arrive(id, g, map).then((ok) => HUB.log.info(`acc ${id}: go farm ${map}: ${ok ? 'arrived, AUTO on' : 'did not arrive'}`)).catch(() => {});
  return { ok: true };
};;
// dying a lot on a farm map costs real money (5,000 G a respawn): say so once in a while, with a better map
function deathRateCheck(id, g) {
  const now = Date.now(); const map = HUB.mapOf(g);
  if (!map || HUB.WORLD_ARENAS.has(map) || g.bossTrip) return;
  const n = (g.deathLog || []).filter((t) => now - t < 3600000).length;
  if (n < 20 || (g.deathWarnAt && now - g.deathWarnAt < 6 * 3600000) || HUB.store.data.settings.notify.deathRate === false) return;
  if (g.inGameAt && now - g.inGameAt < 45 * 60000) return; // an hour's worth first
  g.deathWarnAt = now;
  const lv = g.data.stats.level || 0;
  const rows = HUB.farmSummary(id, lv).filter((x) => !HUB.WORLD_ARENAS.has(x.map));
  const here = rows.find((x) => x.map === map);
  const better = rows.filter((x) => x.map !== map && (x.deathsHr == null || x.deathsHr < n / 2) && (!here || x.netHr > here.netHr))[0];
  HUB.log.info(`acc ${id}: ${n} deaths in the last hour on ${map} (~${n * 5000} G in respawns)${better ? ` -> suggest ${better.map} (${better.netHr}/h)` : ''}`);
  HUB.notify(id, 'deathRate', `☠ ตาย ${n} ครั้งใน 1 ชม. ที่ ${HUB.mapName(map)} · ค่าเกิด ~${(n * 5000).toLocaleString('en-US')} G/ชม.${here ? ` (เงินจากมอน ~${Math.round(here.killSilverHr / 1000)}k/ชม.)` : ''}${better ? ` · แมพที่คุ้มกว่า: ${better.name} ~${Math.round(better.netHr / 1000)}k/ชม. (กด 📊 แมพที่เคยฟาร์ม → ไปฟาร์ม)` : ''}`);
}
HUB.farmTick = HUB.farmTick = function farmTick() {
  for (const [id, g] of HUB.games) {
    if (!g.inGame || g.demo) continue;
    farmBucket(g); // closes the minute that just ended
    stuckCheck(id, g).catch(() => {});
    deathRateCheck(id, g);
    loopBackCheck(id, g).catch((e) => HUB.log.warn(`acc ${id}: back to farm: ${e.message}`));
    finderStep(id).catch((e) => HUB.log.warn(`acc ${id}: farm finder: ${e.message}`));
  }
};;
