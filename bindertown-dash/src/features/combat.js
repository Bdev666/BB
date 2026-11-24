const HUB = require('../core/hub');

// ---------- real boss fights: how long they take (Build Lab scores builds over that time) ----------
const __m2 = require('../mob-table'); HUB.MOB_ROLES = __m2.MOBS;
HUB.WORLD_TYPES = { vale: 'wraithroot_colossus', nacreon: 'pearlheart_titan' };
HUB.WORLD_ARENAS = new Set(['rootfall_barrow', 'nacre_lagoon']); // the world bosses' maps (client table)
const isBossType = (t) => !!t && (Object.values(HUB.WORLD_TYPES).includes(t) || /^true_/.test(t) || ['boss', 'mini-boss'].includes((HUB.MOB_ROLES[t] || [])[0]));
HUB.fightHit = HUB.fightHit = function fightHit(g, ev) {
  if (!isBossType(ev.mob) || ev.pet) return;
  const now = Date.now();
  if (!g.fight || g.fight.mob !== ev.mob) { HUB.fightEnd(g); g.fight = { mob: ev.mob, start: now, last: now, dmg: 0, hits: 0 }; }
  g.fight.last = now; g.fight.dmg += ev.dmg || 0; g.fight.hits++;
};;
HUB.fightEnd = HUB.fightEnd = function fightEnd(g, killed = false) {
  const f = g.fight; g.fight = null;
  if (!f || f.hits < 5) return;
  const sec = Math.round((f.last - f.start) / 1000);
  if (sec < 5) return;
  const list = HUB.store.data.fights || (HUB.store.data.fights = []);
  list.push({ acc: g.accId, mob: f.mob, sec, dmg: f.dmg, dps: Math.round(f.dmg / sec), killed, at: Date.now() });
  if (list.length > 600) list.splice(0, list.length - 600);
  HUB.store.save();
  HUB.log.info(`boss fight: acc ${g.accId} ${f.mob} ${sec}s ${f.dmg} dmg (${Math.round(f.dmg / sec)}/s)${killed ? ' (killed)' : ''}`);
};;
HUB.fightTick = HUB.fightTick = function fightTick() {
  for (const [, g] of HUB.games) if (g.fight && Date.now() - g.fight.last > 20000) HUB.fightEnd(g);
};;
HUB.fightTimes = HUB.fightTimes = function fightTimes() {
  const by = {};
  for (const f of HUB.store.data.fights || []) (by[f.mob] || (by[f.mob] = [])).push(f.sec);
  const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
  const out = {};
  for (const [mob, a] of Object.entries(by)) out[mob] = { sec: med(a), n: a.length };
  return { fights: out, world: HUB.store.data.worldLen || {} };
};;

// deaths this session and what respawning in place cost (Gold per death in fields, the game's fee),
// next to what the character earns: a spot where it dies a lot can earn less than it seems
HUB.deathCost = HUB.deathCost = function deathCost(id, g) {
  const c = HUB.selftest.counters.get(id) || {};
  const hours = Math.max(1 / 60, (Date.now() - (g.data.startedAt || Date.now())) / 3600000);
  const deaths = c.deaths || 0;
  if (!deaths) return null;
  const fee = (g.autoRespawns || 0) * 5000 + (c.respawnPress || 0) * 5000 * (HUB.WORLD_ARENAS.has(HUB.mapOf(g)) ? 0 : 1);
  const rate = g.data.rates(Date.now());
  return { perHour: +(deaths / hours).toFixed(1), feePerHour: Math.round(fee / hours), silverPerHour: Math.round(rate.silverPerHour || 0) };
};;

// ---------- real A/B test: the build before a change (A) against after it (B), same map, measured per minute ----------
// The game is the judge: active DPS (time between own hits of 3 s or less) and kills, minute by minute, so the
// spread between minutes says how much a difference has to be before it is real.
HUB.abBucket = HUB.abBucket = function abBucket(g) {
  const P = g.ab[g.ab.phase]; const m = Math.floor((Date.now() - P.start) / 60000);
  while (P.mins.length <= m) P.mins.push({ dmg: 0, activeMs: 0, kills: 0, hits: 0 });
  return P.mins[m];
};;
HUB.abHit = HUB.abHit = function abHit(g, ev) {
  const A = g.ab; if (!A || !A.phase || ev.pet || !(ev.dmg > 0)) return;
  const P = A[A.phase];
  if (Date.now() - P.start > P.minutes * 60000) { A.phase = null; HUB.log.info(`A/B: phase ${A.last} done`); return; }
  const b = HUB.abBucket(g); const now = Date.now();
  b.dmg += ev.dmg; b.hits++; if (P.lastHit && now - P.lastHit <= 3000) b.activeMs += now - P.lastHit; P.lastHit = now;
  if (ev.mob) P.mobs[ev.mob] = (P.mobs[ev.mob] || 0) + 1;
};;
function abStats(P) {
  if (!P) return null;
  const full = P.mins.filter((x) => x.activeMs > 10000); // minutes with enough fighting in them
  const dps = full.map((x) => x.dmg / (x.activeMs / 1000));
  const n = dps.length; const mean = n ? dps.reduce((t, x) => t + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(dps.reduce((t, x) => t + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const kills = P.mins.reduce((t, x) => t + x.kills, 0); const mins = Math.max(1 / 60, Math.min(P.minutes, (Date.now() - P.start) / 60000));
  const mob = Object.entries(P.mobs).sort((a, b) => b[1] - a[1])[0];
  return { minutes: +mins.toFixed(1), of: P.minutes, n, dps: Math.round(mean), sd: Math.round(sd), se: n > 1 ? Math.round(sd / Math.sqrt(n)) : null, killsPerMin: +(kills / mins).toFixed(1), map: P.map, mob: mob ? mob[0] : '', label: P.label };
}
HUB.abResult = HUB.abResult = function abResult(g) {
  const A = g.ab; if (!A) return null;
  const a = abStats(A.A); const b = abStats(A.B);
  let verdict = null;
  if (a && b && a.n >= 3 && b.n >= 3) {
    const diff = b.dps - a.dps; const noise = 2 * Math.sqrt((a.se || 0) ** 2 + (b.se || 0) ** 2);
    const pct = a.dps ? Math.round(diff / a.dps * 1000) / 10 : 0;
    const same = a.map === b.map && a.mob === b.mob;
    verdict = { pct, noisePct: a.dps ? Math.round(noise / a.dps * 1000) / 10 : 0, same,
      says: !same ? 'วัดคนละแมพ/มอน เทียบกันไม่ได้' : Math.abs(diff) <= noise ? 'ยังบอกไม่ได้: ต่างน้อยกว่าความแกว่งของข้อมูล (วัดนานขึ้นอีกหน่อย)' : diff > 0 ? 'ดีขึ้นจริง ✅ เก็บแบบใหม่ไว้' : 'แย่ลงจริง ❌ กลับไปแบบเดิม' };
  }
  return { phase: A.phase, A: a, B: b, verdict };
};;
HUB.abStart = HUB.abStart = async function abStart(id, phase, minutes, label) {
  const g = HUB.games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!['A', 'B'].includes(phase)) return { ok: false, error: 'phase' };
  g.ab = g.ab || {};
  const running = g.ab.phase && g.ab[g.ab.phase] && Date.now() - g.ab[g.ab.phase].start < g.ab[g.ab.phase].minutes * 60000;
  if (running) { const P = g.ab[g.ab.phase]; return { ok: false, error: `กำลังวัด ${g.ab.phase} อยู่ อีก ~${Math.ceil((P.start + P.minutes * 60000 - Date.now()) / 60000)} นาที · รอให้ครบก่อน (หรือกดหยุด)` }; }
  if (phase === 'B') { const a = abStats(g.ab.A); if (!a || a.n < 3) return { ok: false, error: 'ต้องวัดแบบเดิม (A) ให้ได้อย่างน้อย 3 นาทีที่ตีจริงก่อน แล้วค่อยเปลี่ยนและวัด B' }; }
  if (phase === 'A') g.ab.B = null;
  g.ab[phase] = { start: Date.now(), minutes: Math.max(2, Math.min(60, Number(minutes) || 10)), mins: [], mobs: {}, map: HUB.mapOf(g), label: String(label || '').slice(0, 80), lastHit: 0 };
  g.ab.phase = phase; g.ab.last = phase;
  HUB.log.info(`acc ${id}: A/B measuring ${phase} for ${g.ab[phase].minutes} min on ${HUB.mapOf(g)}${label ? ` (${label})` : ''}`);
  return { ok: true };
};;
