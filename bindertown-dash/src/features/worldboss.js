const HUB = require('../core/hub');

// ---------- world boss mode: every online account into the arena (the game's own "join (free)") ----------
// joins with the game's worldBossWarp, turns AUTO on in the arena, and when the event ends takes the
// accounts that BinderDash sent back to where they were (the game's "leave") with AUTO on again
HUB.mapOf = (g) => (g.data && g.data.stats && g.data.stats.map) || '';
HUB.worldBossGo = HUB.worldBossGo = async function worldBossGo(kind, reason = 'ปุ่ม') {
  const out = [];
  for (const [id, g] of HUB.openGames()) {
    if (!g.inGame || g.demo || g.status !== 'online') continue;
    const name = g.data.stats.name || HUB.account(id).name;
    const before = HUB.mapOf(g);
    const me = (g.data.world && g.data.world.self) || {};
    g.bossTrip = { kind, from: before, x: me.x, y: me.y, at: Date.now() };
    HUB.log.info(`acc ${id}: world boss -> ${HUB.WORLD_ARENAS.has(before) ? 'already in the arena (went in by hand)' : `asked the game to warp in, from ${before}${me.x != null ? ` at ${Math.round(me.x)},${Math.round(me.y)}` : ''}`}`);
    await HUB.sendInput(id, { type: 'worldBossWarp', enter: true, kind }); // eslint-disable-line no-await-in-loop
    out.push({ id, name, from: before });
    await HUB.sleep(400); // eslint-disable-line no-await-in-loop
  }
  HUB.log.info(`world boss ${kind}: sent ${out.length} account(s) in (${reason})`);
  // once there: walk up to the boss first (AUTO only fights inside 16 tiles of where it was switched on,
  // and the arena's warp-in point is farther than that), then AUTO on; say who did not get in
  // a log showed 2 of 3 accounts still loading the arena at 7 s: they were taken as "did not get in",
  // so nobody walked them to the boss or took them back after (one stood idle 16 minutes in the arena)
  // each account on its own: as soon as it is in the arena, walk it to the boss (3 minutes at most, asking again
  // every 30 s: a warp asked before the start may only go through when the boss starts)
  const missed = [];
  Promise.all(out.map(async (o) => {
    const g = HUB.games.get(o.id); if (!g) return;
    for (let i = 0; i < 90; i++) {
      if (!g.bossTrip) return; // stopped meanwhile
      if (HUB.WORLD_ARENAS.has(HUB.mapOf(g))) { await HUB.walkToBossThenAuto(o.id, kind); return; }
      if (i && i % 15 === 0) await HUB.sendInput(o.id, { type: 'worldBossWarp', enter: true, kind });
      await HUB.sleep(2000); // eslint-disable-line no-await-in-loop
    }
    missed.push(o.name); g.bossTrip = null; HUB.log.info(`acc ${o.id}: world boss -> not in the arena after 3 min`);
  })).then(() => { if (missed.length) HUB.notify(null, 'worldBoss', `🌋 เข้า World Boss ไม่ได้: ${missed.join(', ')} (เลเวลไม่ถึง / วาร์ปไม่สำเร็จใน 3 นาที)`); }).catch((e) => HUB.log.warn(`world boss go: ${e.message}`));
  return { ok: true, sent: out.length, accounts: out };
};;
// where to stand: next to the world boss; if it is not in sight, the middle of the monsters around
const BOSS_SPOT_JS = (type) => `(() => { try { const g = window.__game; const st = g.state(); const me = g.me(); if (!st || !me) return null;
  const all = []; st.mobs.forEach((m) => all.push(m));
  const kind = (m) => m.mobType || m.type || '';
  const biggest = all.slice().sort((a, b) => (b.maxHp || 0) - (a.maxHp || 0))[0];
  const boss = all.find((m) => kind(m) === ${JSON.stringify(type)}) || all.find((m) => /colossus|titan/i.test(kind(m))) || (biggest && biggest.maxHp > 1e6 ? biggest : null);
  let x, y, how;
  if (boss) { x = boss.x; y = boss.y; how = 'boss'; } else if (all.length) { x = all.reduce((t, m) => t + m.x, 0) / all.length; y = all.reduce((t, m) => t + m.y, 0) / all.length; how = 'mobs'; } else return { me: [me.x, me.y], none: true };
  return { x: Math.round(x), y: Math.round(y), how, d: Math.hypot(x - me.x, y - me.y), me: [Math.round(me.x), Math.round(me.y)] }; } catch (e) { return null; } })()`;
HUB.walkToBossThenAuto = HUB.walkToBossThenAuto = async function walkToBossThenAuto(id, kind, again = false) {
  const g = HUB.games.get(id); if (!g || !g.win || g.win.isDestroyed()) return;
  const type = HUB.WORLD_TYPES[kind] || '';
  let spot = null;
  if (again) { // got up again: only walk when it woke up out of AUTO's reach (16 tiles) of the boss
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; }
    if (!spot || spot.how !== 'boss' || spot.d <= 12) { if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); return; }
    HUB.log.info(`acc ${id}: world boss -> up again ${Math.round(spot.d)} tiles from the boss, walking back`);
  }
  if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); // AUTO off while walking (it would stop to fight on the way)
  // in early (before it spawns): wait for the boss to show up, up to ~3 minutes
  for (let i = 0; i < (again ? 3 : 60); i++) {
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; } // eslint-disable-line no-await-in-loop
    if (spot && spot.how === 'boss') break;
    if (i === 0) HUB.log.info(`acc ${id}: world boss not in sight yet -> waiting for it`);
    await HUB.sleep(3000); // eslint-disable-line no-await-in-loop
  }
  for (let i = 0; i < 15; i++) { // up to ~30 s
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; } // eslint-disable-line no-await-in-loop
    if (!spot || spot.none) { await HUB.sleep(2000); continue; } // eslint-disable-line no-await-in-loop
    if (spot.d <= 5) break;
    await HUB.sendInput(id, { type: 'moveTo', x: spot.x + (spot.how === 'boss' ? 2 : 0), y: spot.y }); // eslint-disable-line no-await-in-loop
    await HUB.sleep(2000); // eslint-disable-line no-await-in-loop
  }
  HUB.log.info(`acc ${id}: world boss -> walked to the ${spot && spot.how ? spot.how : 'arena'}${spot && spot.d != null ? ` (${Math.round(spot.d)} tiles left)` : ''}, AUTO on`);
  if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
};;
async function worldBossLeave(kind) {
  for (const [id, g] of HUB.openGames()) {
    const inArena = g.inGame && !g.demo && HUB.WORLD_ARENAS.has(HUB.mapOf(g));
    if (!(g.bossTrip && g.bossTrip.kind === kind) && !inArena) continue;
    await HUB.sendInput(id, { type: 'worldBossWarp', enter: false, kind }); // eslint-disable-line no-await-in-loop
    HUB.log.info(`acc ${id}: world boss over -> left the arena (back toward ${g.bossTrip ? g.bossTrip.from : 'town'})`);
    if (g.bossTrip && g.bossTrip.from && !HUB.WORLD_ARENAS.has(g.bossTrip.from)) g.loopBack = { map: g.bossTrip.from, x: g.bossTrip.x, y: g.bossTrip.y, at: Date.now(), done: false, why: 'boss' };
    g.bossTrip = null;
    setTimeout(async () => { if (!(await HUB.liveUi(id)).auto) HUB.gameCommand(id, 'auto', {}); }, 8000);
    await HUB.sleep(400); // eslint-disable-line no-await-in-loop
  }
}

HUB.onWorldBoss = HUB.onWorldBoss = function onWorldBoss(v) {
  // the event's real length (start -> end) for the Build Lab
  if (v.state === 'live' && v.startAt && v.endsAt && v.endsAt > v.startAt && HUB.WORLD_TYPES[v.kind]) {
    const wl = HUB.store.data.worldLen || (HUB.store.data.worldLen = {});
    const sec = Math.round((v.endsAt - v.startAt) / 1000);
    if (wl[HUB.WORLD_TYPES[v.kind]] !== sec) { wl[HUB.WORLD_TYPES[v.kind]] = sec; HUB.store.save(); }
  }
  const before = HUB.bosses.world.get(v.kind);
  HUB.bosses.world.set(v.kind, { ...v, seenAt: Date.now(), goneFor: before && before.goneFor });
  if (before && before.state !== 'live' && v.state === 'live') {
    HUB.notify(null, 'worldBoss', `🌋 World Boss ${v.name} เริ่มแล้ว · เข้าร่วม ${v.fighters} คน${HUB.store.data.settings.worldBossAuto ? ' · ส่งทุกบัญชีไปตีแล้ว' : ''}`);
    if (HUB.store.data.settings.worldBossAuto && !(before.goneFor && Math.abs((v.startAt || 0) - before.goneFor) < 5 * 60 * 1000)) HUB.worldBossGo(v.kind, 'เริ่มเอง');
  }
  if (before && before.state === 'live' && v.state !== 'live' && HUB.store.data.settings.worldBossReturn !== false) worldBossLeave(v.kind);
  HUB.pushState();
};;

HUB.bossUp = HUB.bossUp = function bossUp(b) {
  // one heads-up per boss and map per 20 minutes: the game re-estimates the spawn time every minute,
  // so a key with the time in it said the same boss again every minute (seen 6 times in a row in a log)
  const key = `${b.mobType}@${b.map}`;
  HUB.bosses.lastUp = HUB.bosses.lastUp || new Map();
  if (HUB.bosses.lastUp.has(key) && Date.now() - HUB.bosses.lastUp.get(key) < 20 * 60 * 1000) return;
  HUB.bosses.lastUp.set(key, Date.now());
  HUB.notify(null, 'fieldBoss', `♛ บอสสนาม ${b.name} เกิดแล้ว · ${HUB.mapName(b.map)}`);
};;

// map id -> name, from the same map table the Dashboard uses (one JSON object per line)
const MAP_NAMES = (() => {
  try {
    return Object.fromEntries(HUB.fs.readFileSync(HUB.path.join(require('path').join(__dirname, '..'), 'dashboard', 'maps.js'), 'utf8').split('\n')
      .filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l.trim().replace(/,$/, ''))).map((m) => [m.id, m.name]));
  } catch { return {}; }
})();
HUB.mapName = HUB.mapName = function mapName(id) { return MAP_NAMES[id] || String(id || '?').split('_').map((w) => w && w[0].toUpperCase() + w.slice(1)).join(' '); };;

// timers: "about to spawn" heads-up, and spawns we can tell from the clock alone
HUB.bossTick = HUB.bossTick = function bossTick() {
  const s = HUB.store.data.settings;
  const now = Date.now();
  const lead = s.bossLeadMinutes * 60000;
  for (const b of HUB.bosses.field.values()) {
    if (b.closed || !b.until) continue;
    const left = b.until - now;
    const soon = `${b.mobType}@${b.map}`; // not the time: the game re-estimates it every minute
    HUB.bosses.lastSoon = HUB.bosses.lastSoon || new Map();
    if (left > 0 && left <= lead && !(HUB.bosses.lastSoon.has(soon) && now - HUB.bosses.lastSoon.get(soon) < 20 * 60 * 1000)) {
      HUB.bosses.lastSoon.set(soon, now);
      HUB.notify(null, 'fieldBoss', `♛ บอสสนาม ${b.name} จะเกิดในอีก ~${Math.max(1, Math.round(left / 60000))} นาที · ${HUB.mapName(b.map)}`);
    }
    if (left <= 0 && left > -60000) HUB.bossUp(b);
  }
  for (const w of HUB.bosses.world.values()) {
    const start = w.state === 'live' ? 0 : w.nextAt || w.startAt;
    const left = start - now;
    const soon = `wsoon:${w.kind}:${start}`;
    if (start && left > 0 && left <= lead && !HUB.bosses.sent.has(soon)) {
      HUB.bosses.sent.add(soon);
      HUB.notify(null, 'worldBoss', `🌋 World Boss ${w.name} จะเริ่มในอีก ~${Math.max(1, Math.round(left / 60000))} นาที`);
    }
    // go in 1 minute early: the trip in (back to town first, then the warp) can take a while
    const early = `wgo:${w.kind}:${start}`;
    if (s.worldBossAuto && start && left > 0 && left <= 75000 && !HUB.bosses.sent.has(early)) {
      HUB.bosses.sent.add(early); w.goneFor = start;
      HUB.worldBossGo(w.kind, 'ก่อนเกิด 1 นาที');
    }
  }
  if (HUB.bosses.sent.size > 500) HUB.bosses.sent.clear();
  // ask the game for the field-boss board (what its atlas map asks), from one account, once a minute
  if (now - HUB.bosses.queriedAt > 60000 && (s.notify.fieldBoss || HUB.visible(HUB.dashboard))) {
    const first = HUB.openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
    if (first) { HUB.bosses.queriedAt = now; HUB.sendInput(first[0], { type: 'fieldBossQuery' }); }
  }
};;

HUB.bossView = HUB.bossView = function bossView() {
  const now = Date.now();
  return {
    field: [...HUB.bosses.field.values()]
      .filter((b) => !b.closed)
      .map((b) => ({ name: b.name, map: b.map, up: !b.until || b.until <= now, inMs: b.until ? Math.max(0, b.until - now) : 0, killer: b.killer }))
      .sort((a, b) => (a.up === b.up ? a.inMs - b.inMs : a.up ? -1 : 1)),
    world: [...HUB.bosses.world.values()].map((w) => ({
      name: w.name, kind: w.kind, state: w.state, fighters: w.fighters, hpFrac: w.hpFrac,
      inMs: w.state === 'live' ? 0 : Math.max(0, (w.nextAt || w.startAt) - now), endsInMs: w.endsAt ? Math.max(0, w.endsAt - now) : 0,
    })),
  };
};;
