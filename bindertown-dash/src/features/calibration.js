const HUB = require('../core/hub');

// ---------- Build Lab calibration: from every real-damage record, and from every boss fight ----------
// Build Lab numbers from every real-damage record kept, at start and every hour
HUB.calibFromHistory = () => {
  try {
    const h = HUB.selftest.calibHistory(45); const all = HUB.store.data.calib || (HUB.store.data.calib = {});
    let n = 0;
    for (const [key, c] of Object.entries(h)) { const old = all[key]; if (!old || old.v !== 3 || old.job !== c.job || (old.runs || 0) <= c.runs) { all[key] = c; n++; } }
    if (n) { HUB.store.save(); HUB.log.info(`calibration from the combat history: ${n} entr${n === 1 ? 'y' : 'ies'} · ${Object.entries(h).filter(([k]) => !k.includes(':mob:')).map(([k, c]) => `${k} k=${c.k} pack=${c.pack} n=${c.n}`).join(', ')}`); }
  } catch (e) { HUB.log.warn(`calibration from history: ${e.message}`); }
};
// boss fights (field and world bosses): real damage per second against the lab's prediction for that boss,
// per account + boss (needs the character in game for its build); 3 fights at least
HUB.calibFromBossFights = async () => {
  const all = HUB.store.data.calib || (HUB.store.data.calib = {}); const since = Date.now() - 30 * 864e5;
  const by = {};
  for (const f of HUB.store.data.fights || []) if (f.acc != null && f.at >= since && f.sec >= 20 && f.dps > 0) (by[`${f.acc}|${f.mob}`] || (by[`${f.acc}|${f.mob}`] = [])).push(f);
  for (const [key, fs] of Object.entries(by)) {
    if (fs.length < 3) continue;
    const [acc, mob] = [Number(key.split('|')[0]), key.split('|')[1]];
    const g = HUB.games.get(acc); if (!g || !g.inGame || g.demo || !HUB.labMeRef) continue;
    let me; try { me = await HUB.labMeRef(acc); } catch { me = null; } if (!me) continue;
    let pr; try { pr = await HUB.labCall(`window.__bdLab.predict(${JSON.stringify({ job: me.job, level: me.level, jobLevel: me.jobLevel, stats: me.stats, basics: me.skills, target: mob, guild: me.guildLevel || 0, c2Job: (me.c2info && me.c2info.jobLevel) || 50, loadout: { ...(me.loadout || {}), wRefine: me.wRefine, sRefine: me.sRefine }, current: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr } })})`); } catch { pr = null; }
    if (!pr || !(pr.withCombos > 0)) continue;
    const xs = fs.map((f) => f.dps).sort((a, b) => a - b); const real = xs[xs.length >> 1];
    const base = all[`${acc}:world`] || {};
    all[`${acc}:mob:${mob}`] = { ...base, v: 3, job: me.job, kind: 'world', d: +(real / pr.withCombos).toFixed(3), k: base.k || 1, mob, n: fs.length, runs: fs.length, fromBossFights: true, realDps: real, at: Date.now() };
    HUB.log.info(`boss calibration acc ${acc} ${mob}: real ${real}/s over ${fs.length} fights vs lab ${pr.withCombos}/s -> x${(real / pr.withCombos).toFixed(2)}`);
  }
  HUB.store.save();
};
