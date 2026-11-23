// System test + stats log, run on the player's own PC with their own characters.
// - runSelfTest(id, opts): checks each part of BinderDash against the real game, one after another,
//   and writes the result to logs/selftest/*.json (nothing is spent unless opts.allowSpend).
// - statsTick(): every 10 minutes one line per online account into logs/stats/stats-YYYY-MM.jsonl,
//   numbers used to see what should be improved (price answers, auto-buy, respawn, DPS accuracy ...).
// Nothing here leaves the PC. No chat text, names of other players, tokens or passwords are written.
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function create(deps) {
  const { games, log, version } = deps;
  const S = () => deps.store().data.settings;
  const dirOf = (sub) => { const d = path.join(log.dir(), sub); fs.mkdirSync(d, { recursive: true }); return d; };
  const js = (g, code) => g.win.webContents.executeJavaScript(code, true);

  // counters the rest of the app bumps (main.js), kept per account for the stats log
  const counters = new Map();
  function count(id, key, n = 1) {
    const c = counters.get(id) || {}; c[key] = (c[key] || 0) + n; counters.set(id, c);
  }

  // the Build Lab's own query for the character as it is (same as the "this character" button)
  const predictFor = (me, target, hotbar) => deps.labPredict({ job: me.job, level: me.level, jobLevel: me.jobLevel, stats: me.stats, basics: me.skills, target, guild: me.guildLevel || 0, c2Job: (me.c2info && me.c2info.jobLevel) || 50,
    loadout: { ...(me.loadout || {}), wRefine: me.wRefine, sRefine: me.sRefine }, current: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr, ...(hotbar ? { hotbar } : {}) } });

  // ---------- real combat, per skill, kept with the build and the simulator's answer ----------
  // own hits are summed per skill; "active" time = gaps between own hits of 3 s or less (walking to
  // the next monster does not count), so active DPS compares with the simulator's steady DPS
  const combat = new Map();
  function combatHit(id, ev) {
    if (!ev || !(ev.dmg > 0)) return;
    const now = Date.now();
    let c = combat.get(id);
    if (!c) { c = { start: now, last: 0, active: 0, skills: {}, mobs: {}, pet: 0, hits: 0 }; combat.set(id, c); }
    if (ev.pet) { c.pet += ev.dmg; return; }
    if (c.last && now - c.last <= 3000) c.active += now - c.last;
    c.last = now; c.hits++;
    const k = ev.sid || 'basic';
    const x = c.skills[k] || (c.skills[k] = { dmg: 0, hits: 0, crits: 0, max: 0, critDmg: 0 });
    x.dmg += ev.dmg; x.hits++; if (ev.crit) { x.crits++; x.critDmg += ev.dmg; } if (ev.dmg > x.max) x.max = ev.dmg;
    if (ev.mob) c.mobs[ev.mob] = (c.mobs[ev.mob] || 0) + 1;
  }
  async function combatFlush(id, force = false) {
    const c = combat.get(id);
    if (!c || (!force && (c.hits < 30 || c.active < 20000))) return null;
    combat.delete(id);
    const sec = Math.max(1, c.active / 1000);
    const total = Object.values(c.skills).reduce((t, x) => t + x.dmg, 0);
    const mob = Object.entries(c.mobs).sort((a, b) => b[1] - a[1])[0];
    const rec = { t: new Date().toISOString(), app: version(), acc: id, minutes: Math.round((Date.now() - c.start) / 60000), activeSec: Math.round(sec), hits: c.hits, realDps: Math.round(total / sec), petDmg: c.pet, mobs: c.mobs, mainMob: mob ? mob[0] : null,
      skills: Object.fromEntries(Object.entries(c.skills).map(([k, x]) => [k, { dmg: x.dmg, hits: x.hits, avg: Math.round(x.dmg / x.hits), max: x.max, critRate: +(x.crits / x.hits).toFixed(3), avgCrit: x.crits ? Math.round(x.critDmg / x.crits) : null, avgNonCrit: x.hits > x.crits ? Math.round((x.dmg - x.critDmg) / (x.hits - x.crits)) : null, share: +(x.dmg / (total || 1)).toFixed(3), dps: Math.round(x.dmg / sec) }])) };
    try {
      const me = deps.labMe ? await deps.labMe(id) : null;
      if (me) {
        rec.build = { job: me.job, c2: me.c2, level: me.level, jobLevel: me.jobLevel, stats: me.stats, skills: me.skills, evo: me.evo, traits: me.traits, c2tr: me.c2tr, equip: (me.loadout || {}).equip, album: (me.loadout || {}).album, refine: (me.loadout || {}).refineStacks, wRefine: me.wRefine, sRefine: me.sRefine };
        if (rec.mainMob) {
          const p = await predictFor(me, rec.mainMob);
          if (p) {
            rec.sim = { target: p.target, dps: p.dps, withCombos: p.withCombos, hotbar: p.hotbar, perSkill: p.perSkill, sheet: p.sheet, factors: p.debug && p.debug.factors, basic: p.debug && p.debug.basic };
            // split the gap: damage per hit (formula) vs hits per second (rotation, walking, overkill)
            const rb = rec.skills.basic; const sb = rec.sim.basic || {};
            if (rb && sb.vsTarget) rec.basicCheck = { realAvgNonCrit: rb.avgNonCrit, simPerHit: Math.round(sb.vsTarget), perHitRatio: rb.avgNonCrit ? +(rb.avgNonCrit / sb.vsTarget).toFixed(3) : null, realPerSec: +(rb.hits / sec).toFixed(2), simPerSec: sb.perSec != null ? +Number(sb.perSec).toFixed(2) : null, realCritRate: rb.critRate, simCrit: sb.critChance };
            if (p.packCurve && rec.realDps) {
              const c = p.packCurve; let n = 1;
              if (rec.realDps >= c[c.length - 1]) n = c.length;
              else if (rec.realDps > c[0]) { for (let i = 1; i < c.length; i++) if (rec.realDps <= c[i]) { n = i + (c[i] > c[i - 1] ? (rec.realDps - c[i - 1]) / (c[i] - c[i - 1]) : 0); break; } }
              rec.pack = +n.toFixed(2);
            }
            // the ratio against the curve at that pack: below one monster's worth it is the formula being high
            const curveAt = (c, n) => { const lo = Math.max(1, Math.min(c.length, Math.floor(n))); const hi = Math.min(c.length, lo + 1); return c[lo - 1] + (c[hi - 1] - c[lo - 1]) * (n - lo); };
            const pred = p.packCurve && rec.pack ? curveAt(p.packCurve, rec.pack) : (p.packDps || p.withCombos || p.dps);
            rec.sim.packDps = p.packDps || null;
            rec.ratio = pred ? +(rec.realDps / pred).toFixed(3) : null;
            // one hit, real against the formula, per skill (non-crit hits; 20+ hits): which skills are off and by how much
            // one hit, real against the formula, per skill (20+ hits). Compared with the formula's EXPECTED hit,
            // crits included: magic hits always carry the crit multiplier in this game but never show as a crit
            rec.hitCheck = {};
            for (const h of p.perHit || []) {
              const real = rec.skills[h.sid]; const hit = h.hit;
              if (!real || !hit || !hit.vsTarget || real.hits < 20 || !real.avg) continue;
              const cc = Math.min(1, Math.max(0, hit.critChance || 0)); const cm = hit.critMult || 1;
              const expect = hit.vsTarget * (1 + cc * (cm - 1));
              rec.hitCheck[h.sid] = { real: real.avg, sim: Math.round(expect), x: +(real.avg / expect).toFixed(3), realCrit: real.critRate, simCrit: +cc.toFixed(3) };
            }
            const xs = Object.values(rec.hitCheck).map((v) => v.x).sort((a, b2) => a - b2);
            rec.targetKind = /^(wraithroot_colossus|pearlheart_titan)$/.test(rec.mainMob || '') ? 'world' : 'field';
            if (xs.length >= 3) {
              rec.calib = +xs[Math.floor(xs.length / 2)].toFixed(3);
              let rel = Object.fromEntries(Object.entries(rec.hitCheck).map(([sid, v]) => [sid, +(v.x / rec.calib).toFixed(3)]));
              // better: each skill's real DPS against the formula's, with the skills really used as the hotbar
              // (covers how often a skill really goes off, not only how hard it hits)
              try {
                const used = Object.entries(rec.skills).filter(([k]) => !/^(basic|proc_|c2_|atk_)/.test(k) && ((me.skills || {})[k] || 0) > 0).sort((a, b2) => b2[1].dmg - a[1].dmg).map(([k]) => k);
                if (used.length >= 3) {
                  const p2 = await predictFor(me, rec.mainMob, used);
                  const f = {};
                  for (const x of (p2 && p2.perSkill) || []) { const real = (rec.skills[x.sid] || {}).dps; if (real && x.dps > 0 && (x.sid === 'basic' || used.includes(x.sid))) f[x.sid] = real / x.dps; }
                  const fv = Object.values(f).sort((a, b2) => a - b2);
                  if (fv.length >= 3) { const m = fv[Math.floor(fv.length / 2)]; rel = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +(v / m).toFixed(3)])); rec.dpsCheck = { median: +m.toFixed(3), rel }; }
                }
              } catch { /* keep the per-hit numbers */ }
              if (deps.saveCalib) deps.saveCalib(id, { v: 2, k: rec.calib, d: rec.ratio, pack: rec.pack || null, n: xs.length, job: me.job, c2: me.c2, kind: rec.targetKind, rel, mob: rec.mainMob, at: Date.now() });
            }
            const simTotal = (p.perSkill || []).reduce((t, x) => t + x.dps, 0) || 1;
            rec.shareDiff = Object.fromEntries((p.perSkill || []).map((x) => [x.sid, +(((rec.skills[x.sid] || {}).share || 0) - x.dps / simTotal).toFixed(3)]));
          }
        }
      }
    } catch (err) { rec.simError = String(err && err.message || err); }
    const d = new Date();
    try { fs.appendFileSync(path.join(dirOf('combat'), `combat-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`), JSON.stringify(rec) + '\n'); } catch (err) { log.once('combat-write', 600000, 'warn', 'combat write:', err.message); }
    log.info(`combat acc ${id}: ${rec.hits} hits, ${rec.activeSec}s active, real ${rec.realDps} DPS vs sim ${rec.sim ? (rec.sim.packDps || rec.sim.withCombos || rec.sim.dps) : '-'} on ${rec.mainMob}`);
    return rec;
  }
  const lastCombat = new Map();

  async function step(out, name, fn) {
    const t0 = Date.now();
    try {
      const r = (await fn()) || {};
      out.push({ step: name, ok: r.ok !== false, warn: !!r.warn, skipped: !!r.skipped, detail: r.detail || '', data: r.data || null, ms: Date.now() - t0 });
    } catch (err) {
      out.push({ step: name, ok: false, detail: 'ผิดพลาด: ' + (err && err.message ? err.message : String(err)), ms: Date.now() - t0 });
    }
    if (deps.onProgress) deps.onProgress(out[out.length - 1]);
  }

  async function runSelfTest(id, opts = {}) {
    const g = games.get(id);
    if (!g || !g.inGame || g.demo || !g.win || g.win.isDestroyed()) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
    const out = [];
    const startedAt = Date.now();
    let page = {};

    await step(out, 'ตัวละครและบัญชี', async () => {
      page = await js(g, `(() => { const m = window.__game && window.__game.me() || {}; const ar = document.getElementById('au-respawn'); const la = document.getElementById('linkalert');
        return { job: m.job, level: m.level, silver: m.silver, map: window.__game.mapId ? window.__game.mapId() : '', hp: m.hp, maxHp: m.maxHp,
          premium: ar ? !ar.disabled : null, guest: la ? !la.hidden : null }; })()`);
      return { detail: `${page.job} Lv ${page.level} · แมพ ${page.map} · Silver ${Number(page.silver || 0).toLocaleString('en-US')} · ${page.premium ? 'Premium' : 'ไม่ใช่ Premium'} · ${page.guest ? 'Guest' : 'ผูกบัญชีแล้ว'}`, data: page };
    });

    await step(out, 'ถอดข้อความจากเกม', async () => {
      const h = g.adapter.health();
      return { ok: h.ok, warn: !h.knownBuild, detail: h.ok ? `ปกติ · ${h.frames} ข้อความ${h.knownBuild ? '' : ' · เกมอัปเดตเวอร์ชันใหม่ ' + h.build}` : h.problems.join(' · '), data: h };
    });

    await step(out, 'กระเป๋า ล็อค และของผูกตัว', async () => {
      const inv = g.adapter.inv ? [...g.adapter.inv.keys()] : [];
      const gear = inv.filter((x) => x.includes('#'));
      const locked = gear.filter((x) => g.adapter.locks.has(x));
      const bound = gear.filter((x) => g.adapter.bound.has(x));
      const salv = deps.salvageable(g, ['normal', 'magic', 'rare', 'epic']);
      const leak = salv.filter((x) => g.adapter.locks.has(x));
      return { ok: leak.length === 0, detail: `อุปกรณ์ ${gear.length} ชิ้น · ล็อค ${locked.length} · ผูกตัว ${bound.length}${leak.length ? ` · ❌ ของล็อค ${leak.length} ชิ้นหลุดเข้าหน้าย่อย` : ' · ของล็อคไม่อยู่ในหน้าย่อย ✓'}`, data: { gear: gear.length, locked: locked.length, bound: bound.length, leak: leak.length } };
    });

    let priced = [];
    await step(out, 'ราคาตลาดของในกระเป๋า', async () => {
      const ids = deps.tradableGear(g).slice(0, 8);
      if (!ids.length) return { skipped: true, detail: 'ไม่มีอุปกรณ์ที่ขายได้ในกระเป๋า' };
      const t0 = Date.now();
      for (const x of ids) g.data.itemPrices.delete(x);
      await deps.priceGear(id, ids);
      priced = ids.map((x) => ({ id: x.split('#')[0], ...(g.data.itemPrices.get(x) || {}) }));
      const got = priced.filter((p) => p.at);
      // two different pieces with exactly the same numbers = possibly paired with the wrong answer
      const sig = new Map(); let same = 0;
      for (const p of got) { const k = `${p.price}|${p.vol7}|${p.stock}`; if (p.price && sig.has(k) && sig.get(k) !== p.key) same++; sig.set(k, p.key); }
      const rate = got.length / ids.length;
      return { ok: rate >= 0.75, warn: same > 0 || rate < 1, detail: `ตลาดตอบ ${got.length}/${ids.length} ชิ้น ใน ${((Date.now() - t0) / 1000).toFixed(1)} วิ${same ? ` · ⚠ ${same} ชิ้นได้ตัวเลขซ้ำกับชิ้นอื่น` : ''}`, data: { asked: ids.length, answered: got.length, sameNumbers: same, rows: priced.map((p) => ({ id: p.id, price: p.price, vol7: p.vol7, key: p.key })) } };
    });

    await step(out, 'ย่อยตามราคา (ดูอย่างเดียว ไม่ย่อย)', async () => {
      const opt = deps.salvageOpts({});
      const all = deps.salvageable(g, ['normal', 'magic', 'rare', 'epic']);
      const v = all.map((x) => deps.salvageVerdict(g, x, opt));
      const n = (f) => v.filter(f).length;
      return { detail: `ย่อยได้ ${n((x) => x.salvage)} · เก็บไว้ ${n((x) => !x.salvage)} · ตลาดไม่ตอบ ${n((x) => /ไม่ตอบ/.test(x.why))}`, data: { total: v.length, salvage: n((x) => x.salvage), unknown: n((x) => /ไม่ตอบ/.test(x.why)) } };
    });

    await step(out, 'สิทธิ์ตลาดกลาง', async () => {
      const t0 = Date.now();
      await deps.sendInput(id, { ...deps.MARKET_FILTER, type: 'marketQuery', sort: 'def', off: 0 });
      for (let i = 0; i < 25; i++) { await wait(200); if ((g.myListings && g.myListings.at >= t0) || (g.lastMarket && g.lastMarket.at >= t0)) break; } // eslint-disable-line no-await-in-loop
      if (g.lastMarket && g.lastMarket.at >= t0 && !g.lastMarket.ok) return { ok: false, warn: true, detail: g.lastMarket.reason || 'ตลาดไม่ให้ใช้' };
      if (g.myListings && g.myListings.at >= t0) {
        if (page.guest) return { warn: true, detail: 'ดูตลาดและราคาได้ · ลงขายไม่ได้จนกว่าจะผูกบัญชี Google / Discord (Guest)', data: { listings: 0, guest: true } };
        return { detail: `ดูและลงขายได้ · ของที่ลงขายอยู่ ${g.myListings.list.length} ชิ้น`, data: { listings: g.myListings.list.length } };
      }
      return { ok: false, warn: true, detail: 'ตลาดไม่ตอบใน 5 วิ' };
    });

    await step(out, 'ซื้อยา 1 ขวด', async () => {
      if (!opts.allowSpend) return { skipped: true, detail: 'ข้าม (ไม่ได้อนุญาตให้ใช้เงิน)' };
      const before = page.silver;
      const r = await deps.runCommand(id, 'buy', { itemId: 'potion', qty: 1 });
      const after = await js(g, '(window.__game.me() || {}).silver');
      let unit = typeof before === 'number' && typeof after === 'number' ? before - after : null;
      if (unit != null && unit <= 0) unit = null; // Silver from kills came in meanwhile
      return { ok: r.ok, detail: r.ok ? `ซื้อได้ ${r.bought} ขวด · ${unit != null ? `จ่ายจริง ${unit} Silver/ขวด` : 'วัดราคาไม่ได้ (ได้ Silver จากมอนระหว่างซื้อ)'}${page.premium ? ' (Premium ซื้อจาก HUD)' : ''}` : `ซื้อไม่ได้: ${r.error}`, data: { ok: r.ok, unit, premium: page.premium, error: r.error || '' } };
    });

    await step(out, 'เกิดที่เดิม', async () => {
      const s = await js(g, `(() => { const c = document.getElementById('au-respawn'); const o = document.getElementById('deathoverlay');
        return { box: !!c, checked: c ? c.checked : null, disabled: c ? c.disabled : null, overlay: !!o, deadNow: o ? getComputedStyle(o).display !== 'none' : null }; })()`);
      const on = S().autoRespawnHere !== false;
      const c = counters.get(id) || {};
      let detail = s.box ? (s.disabled ? 'ตัวเลือกของเกมล็อคอยู่ (ต้อง Premium)' : s.checked ? 'ตัวเลือก "เกิดที่เดิมอัตโนมัติ" ของเกมติ๊กอยู่ ✓' : 'ตัวเลือกของเกมยังไม่ติ๊ก') : 'ไม่พบตัวเลือกในหน้าเกม (เกมอาจเปลี่ยน)';
      detail += ` · หน้าจอตาย${s.overlay ? 'เจอ' : 'ไม่เจอ'} · ตั้งค่าโปรแกรม${on ? 'เปิด' : 'ปิด'}`;
      if (c.deaths) detail += ` · ตายรอบนี้ ${c.deaths} · เกม respawn ให้ ${c.autoRespawned || 0} · โปรแกรมกดเอง ${c.respawnPress || 0} (สำเร็จ ${c.respawnOk || 0})${c.deathLoops ? ` · ตายวนซ้ำ ${c.deathLoops} ครั้ง (พักเกิดที่เดิม)` : ''}${c.revives ? ` · ตายแล้วลุกเฉลี่ย ${(c.deadMs / c.revives / 1000).toFixed(1)} วิ` : ''}`;
      return { ok: s.box && s.overlay, warn: (on && s.box && !s.disabled && !s.checked) || !!s.disabled, detail, data: { ...s, counters: { deaths: c.deaths || 0, autoRespawned: c.autoRespawned || 0, press: c.respawnPress || 0, pressOk: c.respawnOk || 0, avgDeadSec: c.revives ? +(c.deadMs / c.revives / 1000).toFixed(1) : null } } };
    });

    await step(out, 'ยาและอัตราใช้', async () => {
      const belt = (g.belt || []).filter(Boolean);
      const rows = belt.map((b) => { const c = g.data.supplyClock(b) || { qty: 0, perHour: 0, minutesLeft: null }; return { name: b, qty: c.qty, usedPerHour: c.perHour, minutesLeft: c.minutesLeft, ids: [{ id: b }] }; });
      const ab = S().autoBuy || {};
      const c = counters.get(id) || {};
      const txt = rows.map((r) => `${r.name} ${r.qty}${r.usedPerHour ? ` (ใช้ ~${Math.round(r.usedPerHour)}/ชม.${r.minutesLeft != null ? `, หมดใน ~${Math.round(r.minutesLeft)} นาที` : ''})` : ''}`).join(' · ') || 'อ่านช่องลัดไม่ได้';
      const beltTxt = `ช่องลัด: ${belt.join(', ') || '(ว่าง)'} · `;
      return { detail: `${beltTxt}${txt} · ซื้ออัตโนมัติ${ab.on ? `เปิด ${ab.rounds}×99 เก็บ ${Number(ab.keepSilver ?? 5000).toLocaleString('en-US')} Silver` : 'ปิด'}${c.autoBuy ? ` · ซื้อเองแล้ว ${c.autoBuy} ครั้ง (${c.autoBuyQty || 0} ขวด, ไม่สำเร็จ ${c.autoBuyFail || 0})` : ''}`, data: { rows: rows.map((r) => ({ id: (r.ids && r.ids[0] && r.ids[0].id) || '', qty: r.qty, perHour: Math.round(r.usedPerHour || 0), minutesLeft: r.minutesLeft })), autoBuy: ab, counters: { n: c.autoBuy || 0, qty: c.autoBuyQty || 0, fail: c.autoBuyFail || 0 }, belt } };
    });

    await step(out, 'Build Lab เทียบดาเมจจริง', async () => {
      const me = deps.labMe ? await deps.labMe(id) : null;
      if (!me) return { skipped: true, detail: 'อ่านข้อมูลตัวละครไม่ได้' };
      const live = await combatFlush(id, (combat.get(id) || {}).hits >= 10);
      if (live) lastCombat.set(id, live);
      const lc = lastCombat.get(id);
      if (lc && lc.sim) {
        const ratio = lc.ratio;
        const bc = lc.basicCheck;
        const hc = Object.entries(lc.hitCheck || {}).sort((a, b2) => Math.abs(b2[1].x - 1) - Math.abs(a[1].x - 1));
        const hitTxt = lc.calib ? ` · ดาเมจต่อฮิตจริง/สูตร ×${lc.calib} (${hc.length} สกิล${hc.length ? `, ต่างสุด ${hc[0][0]} ×${hc[0][1].x}` : ''})` : '';
        return { warn: lc.calib != null ? Math.abs(lc.calib - 1) > 0.25 : (ratio != null && Math.abs(ratio - 1) > 0.15), detail: `ตีจริง ${lc.mainMob}${hitTxt} · ${lc.realDps.toLocaleString('en-US')} DPS (ช่วงที่ตีอยู่ ${lc.activeSec} วิ, ${lc.hits} ครั้ง) · Simulator คาด ${(lc.sim.packDps || lc.sim.withCombos || lc.sim.dps).toLocaleString('en-US')} · จริง/คาด ${ratio != null ? Math.round(ratio * 100) + '%' : '-'}${bc ? ` · ตีปกติต่อครั้ง จริง ${bc.realAvgNonCrit} / คาด ${bc.simPerHit} · ครั้ง/วิ จริง ${bc.realPerSec} / คาด ${bc.simPerSec}` : ''}`, data: { job: me.job, level: me.level, predicted: lc.sim.withCombos || lc.sim.dps, measured: lc.realDps, ratio, hitRatio: lc.calib, mob: lc.mainMob, kind: lc.targetKind, hitCheck: lc.hitCheck } };
      }
      const p = await predictFor(me, 'training_dummy');
      const pred = p && (p.packDps || p.withCombos || p.dps);
      const r = g.data.rates(Date.now());
      const m = g.lastMeasure;
      let detail = `คาด ${pred ? Math.round(pred).toLocaleString('en-US') : '-'} DPS (หุ่นฝึก)`;
      let ratio = null;
      if (m && m.dps) { ratio = pred ? m.dps / pred : null; detail += ` · วัดจริงล่าสุด ${Math.round(m.dps)} DPS${ratio ? ` (จริง/คาด ${(ratio * 100).toFixed(0)}%)` : ''}`; }
      else if (r.dpsNow > 0) detail += ` · ตีอยู่ตอนนี้ ${Math.round(r.dpsNow)} DPS (มอนจริง ไม่ใช่หุ่น เทียบตรงไม่ได้)`;
      else detail += ' · ยังไม่มีดาเมจจริงพอเทียบ (ตีมอนสักพักแล้วทดสอบใหม่ หรือวัดกับหุ่นฝึกใน Build Lab)';
      return { warn: ratio != null && Math.abs(ratio - 1) > 0.15, detail, data: { job: me.job, level: me.level, predicted: pred || null, measured: m ? m.dps : null, ratio, dpsNow: r.dpsNow } };
    });

    await step(out, 'สถิติรอบนี้', async () => {
      const r = g.data.rates(Date.now());
      const h = Math.max(1, r.playMs / 60000);
      return { detail: `เล่น ${Math.round(h)} นาที · ฆ่า ${Math.round(r.killsPerHour)}/ชม. · Silver จากมอน ${Math.round(r.silverPerHour).toLocaleString('en-US')}/ชม. · รายได้รวม ${Math.round(r.incomePerHour).toLocaleString('en-US')}/ชม.`, data: { minutes: Math.round(h), killsPerHour: Math.round(r.killsPerHour), silverPerHour: Math.round(r.silverPerHour), incomePerHour: Math.round(r.incomePerHour), expPerHour: Math.round(r.expPerHour || 0) } };
    });

    await step(out, 'ข้อผิดพลาดใน log (24 ชม.)', async () => {
      const top = logProblems();
      return { warn: top.total > 0, detail: top.total ? `${top.total} บรรทัด · ${top.list.slice(0, 3).map((x) => `${x.n}× ${x.msg}`).join(' · ')}` : 'ไม่มี', data: top };
    });

    const report = { app: version(), at: new Date(startedAt).toISOString(), ms: Date.now() - startedAt, account: id, allowSpend: !!opts.allowSpend, steps: out, improve: suggest(out) };
    const file = path.join(dirOf('selftest'), `selftest-${day()}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}-acc${id}.json`);
    try { fs.writeFileSync(file, JSON.stringify(report, null, 2)); } catch (err) { log.warn('selftest write:', err.message); }
    log.info(`selftest acc ${id}: ${out.filter((s) => s.ok && !s.warn).length}/${out.length} ok, ${out.filter((s) => s.warn).length} warn, ${out.filter((s) => !s.ok).length} fail -> ${path.basename(file)}`);
    return { ok: true, file, ...report };
  }

  // what the numbers say should be looked at next (shown in the app and kept in the report)
  function suggest(steps) {
    const by = Object.fromEntries(steps.map((s) => [s.step, s]));
    const out = [];
    const p = by['ราคาตลาดของในกระเป๋า'];
    if (p && p.data && p.data.asked && p.data.answered < p.data.asked) out.push(`ตลาดตอบราคาไม่ครบ ${p.data.answered}/${p.data.asked}: ควรถามช้าลงหรือถามซ้ำมากขึ้น`);
    if (p && p.data && p.data.sameNumbers) out.push('มีของต่างชิ้นได้ราคาเดียวกันเป๊ะ: ควรตรวจการจับคู่คำตอบจากตลาด');
    const d = by['ถอดข้อความจากเกม'];
    if (d && d.data && !d.data.knownBuild) out.push(`เกมเวอร์ชันใหม่ (${d.data.build}): ควรตรวจว่าทุกระบบยังอ่านข้อมูลถูก`);
    if (d && !d.ok) out.push('ถอดข้อความจากเกมมีปัญหา: ต้องอัปเดตตัวอ่านข้อมูล');
    const b = by['Build Lab เทียบดาเมจจริง'];
    if (b && b.data && b.data.hitRatio != null && Math.abs(b.data.hitRatio - 1) > 0.25) out.push(`ดาเมจต่อฮิตจริงต่างจากสูตร ×${b.data.hitRatio} (${b.data.kind === 'world' ? 'บอสโลก' : 'มอนทั่วไป'}): Build Lab แท็บ "สด" ปรับให้ตามจริงแล้ว · ส่ง log ให้ผู้พัฒนาเพื่อแก้สูตรของ ${b.data.job}`);
    else if (b && b.data && b.data.hitRatio == null && b.data.ratio != null && Math.abs(b.data.ratio - 1) > 0.15) out.push(`DPS ที่คาดต่างจากจริง ${Math.round((b.data.ratio - 1) * 100)}%: ควรปรับสูตรของอาชีพ ${b.data.job}`);
    const y = by['ยาและอัตราใช้'];
    if (y && y.data && y.data.counters.fail) out.push(`ซื้อยาอัตโนมัติไม่สำเร็จ ${y.data.counters.fail} ครั้ง: ดูเหตุผลใน log`);
    const r = by['เกิดที่เดิม'];
    if (r && r.data && r.data.counters.press > r.data.counters.pressOk) out.push('กดเกิดที่เดิมแล้วยังไม่ลุก: ปุ่มหน้าจอตายอาจเปลี่ยน');
    if (r && r.warn && r.data && r.data.disabled) out.push('เกิดที่เดิมอัตโนมัติต้อง Premium: ทดสอบการตายด้วยบัญชี Premium');
    else if (r && r.warn) out.push('เปิดตั้งค่าเกิดที่เดิมไว้ แต่ตัวเลือกของเกมยังไม่ติ๊ก');
    const m = by['สิทธิ์ตลาดกลาง'];
    if (m && (!m.ok || (m.data && m.data.guest))) out.push('บัญชีนี้ลงขายในตลาดกลางไม่ได้ (Guest ต้องผูกบัญชีก่อน): ทดสอบการขายด้วยบัญชีที่ผูกแล้ว');
    const l = by['ข้อผิดพลาดใน log (24 ชม.)'];
    if (l && l.data && l.data.total) out.push(`มี warn/error ใน log ${l.data.total} บรรทัด: ดูอันที่เจอบ่อยสุดก่อน`);
    for (const s of steps) if (!s.ok && !s.skipped && !out.some((x) => x.includes(s.step))) out.push(`${s.step}: ${s.detail}`);
    return out;
  }

  // warn / error lines of the last 24 h, grouped (numbers and ids taken out so the same problem groups together)
  function logProblems() {
    const groups = new Map(); let total = 0;
    const since = Date.now() - 24 * 3600 * 1000;
    for (const f of ['binderdash.log.1', 'binderdash.log']) {
      let text = ''; try { text = fs.readFileSync(path.join(log.dir(), f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ \[(warn|error)\] (.*)$/.exec(line);
        if (!m || new Date(m[1].replace(' ', 'T')).getTime() < since) continue;
        if (/debugger detached: target closed/.test(m[3])) continue; // a game window closing: normal
        total++;
        const key = m[3].replace(/\d+/g, '#').slice(0, 90);
        groups.set(key, (groups.get(key) || 0) + 1);
      }
    }
    return { total, list: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([msg, n]) => ({ msg, n })) };
  }

  // ---------- stats log: one line per online account every 10 minutes ----------
  function statsTick() {
    if (S().statsLog === false) return;
    for (const [id, g] of games) if (g.inGame && !g.demo) combatFlush(id).then((r) => { if (r) lastCombat.set(id, r); }).catch(() => {});
    const lines = [];
    for (const [id, g] of games) {
      if (!g.inGame || g.demo || g.status !== 'online') continue;
      try {
        const r = g.data.rates(Date.now());
        const st = g.data.stats || {};
        const pots = g.data.detail(Date.now()).bag.filter((b) => (b.minutesLeft != null || b.usedPerHour > 0) && (b.ids || []).some((x) => /potion|elixir|ether/.test(x.id))).map((b) => ({ id: (b.ids && b.ids[0] && b.ids[0].id) || '', qty: b.qty, perHour: Math.round(b.usedPerHour) }));
        const h = g.adapter.health();
        lines.push(JSON.stringify({
          t: new Date().toISOString(), app: version(), acc: id, job: st.job, level: st.level, map: st.map,
          min: Math.round(r.playMs / 60000), killsH: Math.round(r.killsPerHour), expH: Math.round(r.expPerHour || 0),
          silverH: Math.round(r.silverPerHour), incomeH: Math.round(r.incomePerHour), dpsNow: Math.round(r.dpsNow), avgHit: r.avgHit ? Math.round(r.avgHit) : null,
          pots, decodeOk: h.ok, build: h.build, alerts: [...(g.alerts || [])].map((a) => String(a).split(':')[0]),
          c: counters.get(id) || {},
        }));
      } catch (err) { log.once('stats-line', 600000, 'warn', 'stats line:', err.message); }
    }
    if (!lines.length) return;
    const d = new Date();
    const file = path.join(dirOf('stats'), `stats-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`);
    try { fs.appendFileSync(file, lines.join('\n') + '\n'); } catch (err) { log.once('stats-write', 600000, 'warn', 'stats write:', err.message); }
  }

  // summary of the stats log for the app (last N days)
  function statsSummary(days = 7) {
    const since = Date.now() - days * 24 * 3600 * 1000;
    const rows = [];
    let files = []; try { files = fs.readdirSync(dirOf('stats')).filter((f) => /^stats-.*\.jsonl$/.test(f)).sort().slice(-2); } catch { /* none */ }
    for (const f of files) {
      let text = ''; try { text = fs.readFileSync(path.join(dirOf('stats'), f), 'utf8'); } catch { continue; }
      for (const l of text.split('\n')) { if (!l) continue; try { const o = JSON.parse(l); if (Date.parse(o.t) >= since) rows.push(o); } catch { /* skip */ } }
    }
    const by = {};
    for (const o of rows) {
      const k = `${o.acc}`; const a = by[k] || (by[k] = { acc: o.acc, job: o.job, level: o.level, n: 0, killsH: 0, silverH: 0, incomeH: 0, decodeBad: 0, last: {} });
      a.n++; a.killsH += o.killsH || 0; a.silverH += o.silverH || 0; a.incomeH += o.incomeH || 0; if (!o.decodeOk) a.decodeBad++;
      a.job = o.job; a.level = o.level; a.last = o.c || {};
    }
    return { rows: rows.length, accounts: Object.values(by).map((a) => ({ ...a, killsH: Math.round(a.killsH / a.n), silverH: Math.round(a.silverH / a.n), incomeH: Math.round(a.incomeH / a.n) })) };
  }

  // one text file for the developer: app info, recent system tests, 30 days of stats and the log.
  // Account and character names are replaced by "acc N"; tokens / chat ids are never in it.
  function bundle(outDir, extra = {}) {
    const st = deps.store().data;
    const names = [];
    for (const a of st.accounts || []) if (a.name) names.push([a.name, `acc ${a.id}`]);
    for (const [id, g] of games) { const n = g.data && g.data.stats && g.data.stats.name; if (n) names.push([n, `acc ${id}`]); }
    names.sort((a, b) => b[0].length - a[0].length);
    const clean = (t) => { let x = String(t); for (const [n, r] of names) if (n.length >= 2) x = x.split(n).join(r); return x.replace(/(token|chatId|password|secret)("?\s*[:=]\s*"?)[^",\s}]+/gi, '$1$2***'); };
    const part = (title, body) => `\n===== ${title} =====\n${body}\n`;
    let out = `BinderDash log for the developer · ${new Date().toISOString()}\n`;
    const settings = { ...st.settings }; delete settings.telegram; delete settings.gameUrl;
    out += part('app', JSON.stringify({ app: version(), ...extra, accounts: (st.accounts || []).map((a) => { const g = games.get(a.id); const x = g && g.data && g.data.stats; return { acc: a.id, status: g ? g.status : 'closed', job: x && x.job, level: x && x.level, map: x && x.map, belt: g && g.belt }; }), settings }, null, 1));
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    let tests = []; try { tests = fs.readdirSync(dirOf('selftest')).filter((f) => f.endsWith('.json')).sort().slice(-5); } catch { /* none */ }
    for (const f of tests) out += part('selftest ' + f.replace(/acc\d+/, ''), clean(read(path.join(dirOf('selftest'), f))));
    let statFiles = []; try { statFiles = fs.readdirSync(dirOf('stats')).filter((f) => f.endsWith('.jsonl')).sort().slice(-2); } catch { /* none */ }
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const statLines = statFiles.flatMap((f) => read(path.join(dirOf('stats'), f)).split('\n').filter((l) => { try { return l && Date.parse(JSON.parse(l).t) >= since; } catch { return false; } }));
    out += part(`stats (30 days, ${statLines.length} lines)`, clean(statLines.join('\n')));
    let combatFiles = []; try { combatFiles = fs.readdirSync(dirOf('combat')).filter((f) => f.endsWith('.jsonl')).sort().slice(-2); } catch { /* none */ }
    const combatLines = combatFiles.flatMap((f) => read(path.join(dirOf('combat'), f)).split('\n').filter((l) => { try { return l && Date.parse(JSON.parse(l).t) >= since; } catch { return false; } }));
    out += part(`combat: real damage per skill + build + simulator (30 days, ${combatLines.length} records)`, clean(combatLines.join('\n')));
    out += part('binderdash.log', clean(read(path.join(log.dir(), 'binderdash.log.1')) + read(path.join(log.dir(), 'binderdash.log'))).slice(-6 * 1024 * 1024));
    const d = new Date(); const p2 = (x) => String(x).padStart(2, '0');
    const file = path.join(outDir, `BinderDash-log-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.txt`);
    fs.writeFileSync(file, out);
    log.info(`log bundle written (${Math.round(out.length / 1024)} KB)`);
    return { ok: true, file, kb: Math.round(out.length / 1024) };
  }

  return { runSelfTest, statsTick, statsSummary, count, counters, logProblems, bundle, combatHit, combatFlush };
}

module.exports = { create };
