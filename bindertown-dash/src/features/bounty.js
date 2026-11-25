const HUB = require('../core/hub');

// ---------- daily bounties (ค่าหัว): claim what is done, then go and hunt the next one ----------
// Everything goes through the game's own hunt window: its list (map, monster, progress), its
// "go to map" button and the world map's "travel" button (the game walks there by itself),
// then the monster is looked up on the map, AUTO goes on next to it, and the reward is claimed at 40/40.
const MOB_BY_NAME = (() => { const m = require('../game-names').mobs || {}; const o = {}; for (const [id, nm] of Object.entries(m)) if (!o[nm]) o[nm] = id; return o; })();
const BOUNTY_LIST_JS = `(() => { const win = document.getElementById('huntwin'); if (!win) return null;
  const wasOpen = win.style.display === 'block'; if (!wasOpen) { const b = document.getElementById('openhunt'); if (!b) return null; b.click(); }
  const tab = win.querySelector('[data-htab="bounty"]'); if (tab && !tab.classList.contains('on')) tab.click();
  const out = [...document.querySelectorAll('#huntbody .hu1b')].map((x) => { const go = x.querySelector('[data-goto]'); const cl = x.querySelector('[data-claim]'); const sm = [...x.querySelectorAll('.hu1tx small')].map((e) => e.textContent);
    const band = /Lv\\s*(\\d+)\\D+(\\d+)/.exec(sm[0] || ''); const pr = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(sm[1] || '');
    return { id: cl ? cl.dataset.claim : '', map: go ? go.dataset.goto : '', name: ((x.querySelector('.hu1tx b') || {}).textContent || '').replace(/\\s*×\\s*\\d+\\s*$/, '').trim(),
      lo: band ? +band[1] : 0, hi: band ? +band[2] : 0, prog: pr ? +pr[1] : 0, need: pr ? +pr[2] : 40, claimed: x.classList.contains('claimed'), done: x.classList.contains('done') }; });
  if (!wasOpen) win.style.display = 'none';
  return out; })()`;
// the game's "warp to X (then walk on)?" box: warp when it is free (Premium), else walk (never pays Gold)
const WARP_CONFIRM_JS = `(() => { const box = document.getElementById('buyconfirm'); if (!box || box.style.display === 'none' || !box.offsetParent && getComputedStyle(box).display === 'none') return { box: false };
  const text = box.innerText || ''; if (!/วาร์ป/.test(text)) return { box: true, warp: false };
  const free = /ฟรี/.test(text); const b = document.getElementById(free ? 'bcyes' : 'bcno'); if (!b || b.disabled) return { box: true, warp: true, free, pressed: false };
  b.click(); return { box: true, warp: true, free, pressed: true }; })()`;
HUB.answerWarpBox = async function answerWarpBox(id, g) {
  for (let i = 0; i < 8; i++) { // the box comes after the server answers (a moment)
    let r; try { r = await g.win.webContents.executeJavaScript(WARP_CONFIRM_JS, true); } catch { r = null; } // eslint-disable-line no-await-in-loop
    if (r && r.pressed) { HUB.log.info(`acc ${id}: travel -> ${r.free ? 'warp (free)' : 'walk (warp would cost Gold)'}`); return r; }
    await HUB.sleep(500); // eslint-disable-line no-await-in-loop
  }
  return null;
};
// the game's own AUTO settings "targets on this map" (one switch per monster kind, off = AUTO never hits it):
// keep only the bounty monster on, or put back the ones BinderDash switched off. Bosses are left alone.
const MOB_FILTER_JS = (mode, names) => `(async () => { const win = document.getElementById('autoopts'); const open = document.getElementById('autoopt'); if (!win || !open) return { ok: false, why: 'no auto settings' };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const was = win.style.display === 'block'; if (!was) open.click();
  await wait(400);
  const mode = ${JSON.stringify(mode)}; const names = ${JSON.stringify(names)}; const changed = []; let found = false;
  for (let guard = 0; guard < 40; guard++) {
    const btns = [...document.querySelectorAll('#au-targets .autg')];
    const pick = btns.find((b) => { const nm = ((b.querySelector('.autgn b') || {}).textContent || '').trim(); if (b.querySelector('em.r-boss')) return false;
      const on = b.classList.contains('on');
      if (mode === 'only') { if (nm === names[0]) { found = true; return !on; } return on && !changed.includes(nm); }
      return names.includes(nm) && !on; });
    if (!pick) break;
    const nm = ((pick.querySelector('.autgn b') || {}).textContent || '').trim();
    pick.click(); if (!(mode === 'only' && nm === names[0])) changed.push(nm);
    await wait(60);
  }
  if (!was) win.style.display = 'none';
  return { ok: true, changed, found: mode === 'only' ? found || [...document.querySelectorAll('#au-targets .autg .autgn b')].some((b) => b.textContent.trim() === names[0]) : true }; })()`;
async function bountyFilterOn(id, g, map, name) {
  let r; try { r = await g.win.webContents.executeJavaScript(MOB_FILTER_JS('only', [name]), true); } catch (e) { r = { ok: false, why: e.message }; }
  if (r && r.ok && r.changed.length) { g.mobFilter = { map, names: [...new Set([...((g.mobFilter && g.mobFilter.map === map && g.mobFilter.names) || []), ...r.changed])] }; HUB.store.data.mobFilter = { ...(HUB.store.data.mobFilter || {}), [id]: g.mobFilter }; HUB.store.save(); }
  HUB.log.info(`acc ${id}: bounty -> AUTO only on ${name}${r && r.ok ? ` (${r.changed.length} other kind(s) switched off)` : ` (could not set: ${(r && r.why) || '?'})`}`);
  return r;
}
async function bountyFilterOff(id, g) {
  const f = g.mobFilter || (HUB.store.data.mobFilter || {})[id];
  if (!f || !f.names || !f.names.length || HUB.mapOf(g) !== f.map || !g.win || g.win.isDestroyed()) return false;
  let r; try { r = await g.win.webContents.executeJavaScript(MOB_FILTER_JS('restore', f.names), true); } catch { r = null; }
  if (r && r.ok) { g.mobFilter = null; const all = HUB.store.data.mobFilter || {}; delete all[id]; HUB.store.save(); HUB.log.info(`acc ${id}: AUTO targets back as they were (${r.changed.length} kind(s) on again)`); return true; }
  return false;
}
const MOB_SPOT_JS = (type) => `(() => { try { const g = window.__game; const me = g.me(); const all = []; g.state().mobs.forEach((m) => all.push(m));
  const want = all.filter((m) => (m.mobType || m.type) === ${JSON.stringify(type)} && m.hp > 0).map((m) => ({ x: m.x, y: m.y, d: Math.hypot(m.x - me.x, m.y - me.y) })).sort((a, b) => a.d - b.d);
  return want.length ? { x: Math.round(want[0].x), y: Math.round(want[0].y), d: want[0].d, n: want.length } : { n: 0 }; } catch (e) { return null; } })()`;
// the game's AUTO range (AUTO settings: N tiles around the start point, or 0 = whole map); returns the old one
const FARM_R_JS = (v) => `(() => { const box = document.getElementById('au-farm'); if (!box) return null; const on = box.querySelector('[data-farm].on'); const prev = on ? Number(on.dataset.farm) : null;
  const b = box.querySelector('[data-farm="' + ${JSON.stringify(String(v))} + '"]'); if (b && prev !== ${Number(v)}) b.click(); return prev; })()`;
HUB.setFarmRange = async function setFarmRange(g, v) { try { return await g.win.webContents.executeJavaScript(FARM_R_JS(v), true); } catch { return null; } };
async function bountyRestore(g, id) {
  if (id != null) await bountyFilterOff(id, g); const B = g.bounty; if (B && B.prevFarm != null && g.win && !g.win.isDestroyed()) { await HUB.setFarmRange(g, B.prevFarm); B.prevFarm = null; } }
async function bountyList(id) {
  const g = HUB.games.get(id); if (!g || !g.win || g.win.isDestroyed()) return null;
  try { return await g.win.webContents.executeJavaScript(BOUNTY_LIST_JS, true); } catch { return null; }
}
HUB.bountyStatus = function bountyStatus(g) { const b = g.bounty; return b ? { on: !!b.on, phase: b.phase, target: b.cur ? `${b.cur.name} @ ${b.cur.map}` : '', done: b.claimedN || 0, note: b.note || '' } : null; };
HUB.bountyStart = async function bountyStart(id, on = true) {
  const g = HUB.games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!on) { if (g.bounty) { g.bounty.on = false; g.bounty.phase = 'off'; await bountyRestore(g, id); } HUB.log.info(`acc ${id}: bounties off`); HUB.pushState(); return { ok: true }; }
  g.bounty = { on: true, phase: 'start', claimedN: 0, skip: [], at: Date.now(), note: '' };
  await HUB.sendInput(id, { type: 'huntQuery' });
  HUB.log.info(`acc ${id}: bounties on`);
  HUB.pushState();
  setTimeout(() => bountyStep(id), 1500);
  return { ok: true };
};
async function bountyClaimDone(id, list) {
  const g = HUB.games.get(id); let n = 0;
  for (const b of list || []) {
    if (!b.id || b.claimed || b.prog < b.need) continue;
    HUB.farmDirty(g); await HUB.sendInput(id, { type: 'bountyClaim', id: b.id }); // eslint-disable-line no-await-in-loop
    n++; HUB.log.info(`acc ${id}: bounty claimed ${b.id} (${b.name || b.map || ''})`);
    await HUB.sleep(500); // eslint-disable-line no-await-in-loop
  }
  if (n) { if (g.bounty) g.bounty.claimedN = (g.bounty.claimedN || 0) + n; HUB.selftest.count(id, 'bountyClaims', n); await HUB.sendInput(id, { type: 'huntQuery' }); }
  return n;
}
async function bountyStep(id) {
  const g = HUB.games.get(id); const B = g && g.bounty;
  if (!B || !B.on || !g.inGame || g.demo || !g.win || g.win.isDestroyed() || B.busy) return;
  if (!HUB.mayAct(g, 'bounty')) { B.note = HUB.waitNote(g) || 'พักไว้'; return; } // a world boss (or the way back from it) first
  B.busy = true;
  try {
    const list = await bountyList(id);
    if (!list || !list.length) { B.note = 'อ่านหน้าค่าหัวไม่ได้'; return; }
    // the hunt window shows the last progress it got: merge the server's numbers in
    if (g.hunt) for (const b of list) { if (g.hunt.prog[b.id] != null) b.prog = Math.min(b.need, g.hunt.prog[b.id]); if (g.hunt.claimed.includes(b.id)) b.claimed = true; }
    await bountyClaimDone(id, list);
    const lv = Number(g.data.stats.level) || 0; const here = HUB.mapOf(g);
    B.later = B.later || {};
    const doable = list.filter((b) => b.map && !b.claimed && b.prog < b.need && !B.skip.includes(b.id) && (!b.hi || b.hi <= lv + 2));
    // set aside for 30 min: no progress for 8 min (e.g. a monster that only comes out at night)
    const fresh = doable.filter((b) => !B.later[b.id] || Date.now() - B.later[b.id] > 30 * 60 * 1000);
    const open = fresh.length ? fresh : [];
    if (!fresh.length && doable.length) { await bountyFilterOff(id, g); B.phase = 'wait'; B.note = `รอมอนเกิด ${doable.length} ใบ (เช่นมอนกลางคืน) · ลองใหม่ทุก 30 นาที · AUTO ต่อ`; if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); return; }
    if (!open.length) {
      const hard = list.filter((b) => b.map && !b.claimed && b.prog < b.need && b.hi > lv + 2).length;
      B.on = false; B.phase = 'done';
      B.note = hard ? `ทำครบที่ทำได้แล้ว · เหลือ ${hard} ใบที่มอนเลเวลสูงเกิน` : 'ทำค่าหัวครบทุกใบแล้ว';
      HUB.log.info(`acc ${id}: bounties finished (${B.claimedN || 0} claimed${hard ? `, ${hard} too hard` : ''})`);
      await bountyRestore(g, id);
      HUB.notify(id, 'bounty', `📜 ${B.note} · อยู่ที่ ${HUB.mapName(here)} AUTO ต่อ`);
      if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
      return;
    }
    // stay on the current one while it is not finished; else the one on this map; else the easiest
    let cur = B.cur && open.find((b) => b.id === B.cur.id);
    if (!cur) cur = open.find((b) => b.map === here) || open.slice().sort((a, b) => a.hi - b.hi)[0];
    if (!B.cur || B.cur.id !== cur.id) { B.cur = cur; B.phase = 'pick'; B.travelAt = 0; B.progAt = Date.now(); HUB.log.info(`acc ${id}: bounty -> ${cur.name} x${cur.need} at ${cur.map} (${cur.prog}/${cur.need})`); }
    if (B.cur.prog !== cur.prog || !B.progAt) B.progAt = Date.now();
    B.cur.prog = cur.prog;
    if (B.phase === 'hunt' && here === cur.map && Date.now() - B.progAt > 8 * 60 * 1000) {
      B.later[cur.id] = Date.now(); B.cur = null; B.progAt = 0; B.phase = 'pick';
      await bountyFilterOff(id, g); // its monster is not around: AUTO may hit everything again meanwhile
      B.note = `${cur.name} ไม่ขึ้นเลย 8 นาที (อาจเกิดเฉพาะกลางคืน) · ไปใบอื่นก่อน`;
      HUB.log.info(`acc ${id}: bounty ${cur.id} no progress for 8 min -> later`);
      return;
    }
    if (here !== cur.map) {
      if (B.phase === 'travel' && Date.now() - B.travelAt < 6 * 60 * 1000) { B.note = `กำลังเดินทางไป ${HUB.mapName(cur.map)}`; await HUB.answerWarpBox(id, g); return; }
      if (B.phase === 'travel') { B.skip.push(cur.id); B.cur = null; B.note = `ไป ${HUB.mapName(cur.map)} ไม่ถึงใน 6 นาที · ข้ามใบนี้`; HUB.log.info(`acc ${id}: bounty travel timed out -> skip ${cur.id}`); return; }
      await bountyFilterOff(id, g); // the targets switched off on this map come back before leaving it
      const r = await HUB.travelTo(id, g, cur.map); // AUTO off, the game's world-map travel, free warp or walk
      if (!r.ok) { B.skip.push(cur.id); B.cur = null; B.note = `${r.error} · ข้ามใบนี้`; return; }
      B.phase = 'travel'; B.travelAt = Date.now(); B.note = `กำลังเดินทางไป ${HUB.mapName(cur.map)}`;
      HUB.log.info(`acc ${id}: bounty travel ${here} -> ${cur.map}`);
      // the moment it is on the map: the next step at once (the 20-s tick left it standing there)
      const to = cur.map; const t0 = Date.now();
      let looking = false;
      const watch = setInterval(async () => {
        if (!g.bounty || !g.bounty.on || g.bounty.phase !== 'travel' || Date.now() - t0 > 6 * 60000 || !g.win || g.win.isDestroyed()) { clearInterval(watch); return; }
        if (looking) return; looking = true;
        let m = HUB.mapOf(g); try { m = await g.win.webContents.executeJavaScript('window.__game && window.__game.mapId()', true); } catch { /* page busy: use the last snapshot */ }
        looking = false;
        if (m === to) { clearInterval(watch); g.travelling = null;
          // AUTO on the moment it lands; the bounty step then keeps it to the bounty monster
          await HUB.sleep(800); { const prev = await HUB.setFarmRange(g, 0); if (prev != null && prev !== 0 && g.bounty && g.bounty.prevFarm == null) g.bounty.prevFarm = prev; } if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); g.bountyArrivedAt = Date.now(); HUB.log.info(`acc ${id}: bounty arrived at ${to} (${Math.round((Date.now() - t0) / 1000)} s)`); const kick = (n) => { if (g.bounty && g.bounty.busy && n < 40) { setTimeout(() => kick(n + 1), 500); return; } bountyStep(id).catch(() => {}); }; setTimeout(() => kick(0), 300); } // the step may be busy (another tick): try again shortly
      }, 1000);
      return;
    }
    // on the map: stand next to the bounty monster and fight there
    const type = MOB_BY_NAME[cur.name] || '';
    if (B.phase !== 'hunt' || !(await HUB.liveUi(id)).auto) {
      // AUTO on at once over the whole map (it walks to the monsters itself), then keep it to the bounty monster.
      // (it used to walk to the monster with AUTO off first: up to 20 s more of standing around)
      { const prev = await HUB.setFarmRange(g, 0); if (prev != null && prev !== 0 && B.prevFarm == null) B.prevFarm = prev; } // whole map while on a bounty
      if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
      if (HUB.store.data.settings.bountyOnlyTarget !== false) await bountyFilterOn(id, g, cur.map, cur.name); // AUTO hits only the bounty monster
      let spot = null; try { spot = await g.win.webContents.executeJavaScript(MOB_SPOT_JS(type), true); } catch { spot = null; }
      if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); // the settings window can pause it: make sure
      B.phase = 'hunt';
      HUB.log.info(`acc ${id}: bounty hunting ${cur.name} at ${cur.map}${spot && spot.n ? '' : ' (none in sight: AUTO here)'}${g.bountyArrivedAt ? ` · AUTO ${((Date.now() - g.bountyArrivedAt) / 1000).toFixed(1)} s after arriving` : ''}`); g.bountyArrivedAt = 0;
    }
    B.note = `ล่า ${cur.name} ${cur.prog}/${cur.need} ที่ ${HUB.mapName(cur.map)}`;
  } catch (err) { HUB.log.warn(`acc ${id}: bounty step: ${err.message}`); } finally { if (g.bounty) g.bounty.busy = false; HUB.pushState(); }
}
HUB.bountyTick = function bountyTick() {
  for (const [id, g] of HUB.games) {
    if (!g.inGame || g.demo) continue;
    if (g.bounty && g.bounty.on) { HUB.sendInput(id, { type: 'huntQuery' }); setTimeout(() => bountyStep(id), 1500); continue; }
    if (!g.mobFilter && (HUB.store.data.mobFilter || {})[id]) g.mobFilter = HUB.store.data.mobFilter[id];
    if (g.mobFilter && HUB.mapOf(g) === g.mobFilter.map) bountyFilterOff(id, g).catch(() => {});
    // claim finished bounties by themselves (free, setting on by default): ask for fresh numbers every 5 min
    if (HUB.store.data.settings.bountyAutoClaim !== false && (!g.huntAskAt || Date.now() - g.huntAskAt > 5 * 60 * 1000)) { g.huntAskAt = Date.now(); HUB.sendInput(id, { type: 'huntQuery' }); }
    if (HUB.store.data.settings.bountyAutoClaim !== false && g.hunt && g.hunt.at > (g.huntClaimAt || 0)) {
      g.huntClaimAt = Date.now();
      // straight from the server's numbers (no game window opened: it would close what the player has open)
      const NEED = { logging: 60, mining: 60, herbalism: 60, fishing: 30, spirit: 40 };
      const list = Object.entries(g.hunt.prog || {}).map(([bid, prog]) => { const line = /#g:(\w+)$/.exec(bid); return { id: bid, prog, need: line ? NEED[line[1]] || 999 : 40, claimed: g.hunt.claimed.includes(bid) }; });
      bountyClaimDone(id, list).catch(() => {});
    }
  }
};
