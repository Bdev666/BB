'use strict';
// Build Lab: finds the strongest skill build (levels, Evolution A/B, line traits, class 2 path,
// hotbar order) for farming or for bosses, using the game's OWN damage calculator.
//
// The game ships its build calculator in its shared module (the one its build-guide pages use).
// We load that module in a hidden window on the game's site and call it directly, so the numbers
// are the game's numbers. Minified names change every game update, so every piece is found by
// what it looks like, not by name.
//
// LAB_JS runs inside that page and defines window.__bdLab.

const LAB_JS = String.raw`(() => {
if (window.__bdLab) return;
const L = window.__bdLab = {};
let G = null; // the game's pieces

async function load() {
  if (G) return G;
  const html = await (await fetch('/', { cache: 'no-store' })).text();
  const mains = [...new Set([...html.matchAll(/\/?assets\/(main-[\w-]+\.js)/g)].map((m) => m[1]))];
  const idx = new Set();
  for (const m of mains) {
    const t = await (await fetch('/assets/' + m)).text();
    for (const x of t.matchAll(/index-[\w-]+\.js/g)) idx.add(x[0]);
  }
  for (const f of idx) {
    let mod; try { mod = await import('/assets/' + f); } catch { continue; }
    const r = detect(mod);
    if (r.calc && r.skills && r.jobs) { r.file = f; G = r; return G; }
  }
  throw new Error('หาตัวคำนวณของเกมไม่เจอ (เกมอาจอัปเดตรูปแบบไฟล์)');
}

function detect(mod) {
  const r = {};
  for (const v of Object.values(mod)) {
    if (typeof v === 'function') {
      let src = ''; try { src = Function.prototype.toString.call(v); } catch { continue; }
      if (src.includes('dpsAlone') && src.includes('rotation')) r.calc = v;
      else if (src.includes('prereqLevel') && src.includes('jobLevel:') && src.length < 700) r.unlock = v;
      else if (src.includes('bp[0].patch')) r.def = v;
      else if (src.includes('.role!=="boss"') && src.includes('startsWith') && src.length < 2500 && v.length === 2) r.mob = v;
      else if (src.includes('problems') && src.includes('skills') && src.includes('hotbar') && src.includes('evo')) r.validate = v;
    } else if (Array.isArray(v) && !r.maps && v.length > 20 && v.slice(0, 5).every((m) => m && m.id && Array.isArray(m.levelBand))) {
      r.maps = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      try {
        if (v.bolt && typeof v.bolt.dmgMult === 'number') r.skills = v;
        else if (v.mage && Array.isArray(v.mage.skills)) r.jobs = v;
        else if (v.bolt && v.bolt.mods) r.evo = v;
        else if (Array.isArray(v.mage) && v.knight && v.mage.every((x) => typeof x === 'string')) r.c2opts = v;
        else if (v.stormcaller && Array.isArray(v.stormcaller.lines)) r.c2defs = v;
        else if (v.blade && v.blade.a && v.blade.a.perk) r.traits = v;
        else if (!r.cardDefs && Object.keys(v).length > 20 && Object.values(v).slice(0, 25).every((x) => x && Array.isArray(x.fx))) r.cardDefs = v;
        else if (!r.mobs) {
          const vals = Object.values(v);
          if (vals.length > 30 && vals.slice(0, 40).some((m) => m && typeof m === 'object' && m.role && typeof m.hp === 'number')) r.mobs = v;
        }
      } catch { /* getters */ }
    }
  }
  return r;
}

// The calculator counts the Novice basic skills (Tough Skin, Keen Edge, ...) as maxed - right for a
// wiki guide, wrong for a real character. With b.basics set, the calculation runs with the character's
// real basic levels (the lab window is ours alone, so the table is set for the call and put back).
// the game keeps every trait choice in one list; the calculator reads class-2 lines from c2tr: move them there
// (they were left out before: a character's class-2 traits did nothing in the lab)
function c2TraitsIn(b) {
  if (!b || !b.c2 || !b.traits || !G.c2defs || !G.c2defs[b.c2]) return;
  b.c2tr = b.c2tr || {};
  for (const l of G.c2defs[b.c2].lines || []) if (b.traits[l.id] && !b.c2tr[l.id]) b.c2tr[l.id] = b.traits[l.id];
}
function calc(b) {
  c2TraitsIn(b);
  const bas = b && b.basics;
  if (!bas || !G.jobs.novice) return G.calc(b, (b && b.__opts) || {});
  const saved = [];
  for (const sid of G.jobs.novice.skills) { const d = G.skills[sid]; if (!d) continue; saved.push([d, d.maxLevel]); d.maxLevel = bas[sid] || 0; }
  try { return G.calc(b, (b && b.__opts) || {}); } finally { for (const [d, m] of saved) d.maxLevel = m; }
}

// training dummies: the server does not give the level-gap bonus on them (measured: Lv 13 vs the Lv 1
// dummy, calculator x1.24 = 57 DPS, real 46 = without it). Undo that one factor for dummy targets.
function dummyAdj(b, r) {
  if (!r || !String((b.calc || {}).target || '').startsWith('training_dummy')) return 1;
  const f = (r.factors || []).find((x) => /ช่องว่างเลเวล|level gap/i.test(x.label || ''));
  return f && f.x ? 1 / f.x : 1;
}

// ---- rules (the game's own numbers) ----
const MAX_JOB = 50;      // class 1 and class 2 job levels both stop at 50
const C2_POINTS = 70;    // class 2 skill points at class 2 Job Lv 50 (shared by both paths)
const ptsAt = (lv) => (lv <= 1 ? 0 : lv <= 40 ? 1 : lv <= 48 ? 2 : 3);
const TRAIT_AT = 10; // line points for a class 1 / class 2 line trait
const maxLv = (sid) => (G.skills[sid] && G.skills[sid].maxLevel) || 5;
const evoAt = (sid) => Math.ceil(maxLv(sid) / 2);
const hasEvo = (sid) => !!(G.evo && G.evo[sid] && G.evo[sid].mods);
const isPassive = (sid) => (G.skills[sid] || {}).kind === 'passive';
const lineOf = (sid) => (G.skills[sid] || {}).line || '';

function c1Lines(job) {
  const out = [];
  for (const s of G.jobs[job].skills) { const l = lineOf(s); let x = out.find((y) => y.id === l); if (!x) out.push(x = { id: l, skills: [] }); x.skills.push(s); }
  return out;
}
function c1Budget(job, jobLevel) {
  let p = 0; for (let l = 2; l <= jobLevel; l++) p += ptsAt(l);
  return p + c1Lines(job).filter((l) => l.id && l.id !== 'basics').length;
}
function c1Req(job, sid) {
  if (G.unlock) { try { return G.unlock(G.jobs[job].skills, sid) || {}; } catch { /* fall through */ } }
  return {};
}
function c2Skills(path) {
  const d = G.c2defs[path]; if (!d) return [];
  // "inherit" paths list class 1 skills inside their lines too: only true class 2 skills take class 2 points
  return d.lines.flatMap((l) => { const own = l.skills.filter((x) => G.skills[x] && G.skills[x].c2); return own.map((sid, i) => ({ sid, line: l.id, prev: i ? own[i - 1] : null })); });
}

// ---- evaluation ----
// a Novice's basic skills are counted twice by the calculator (as job skills and as basics): take one copy off
function noviceFix(job, stats) {
  const st = { ...stats };
  if (job === 'novice' && G.jobs.novice) for (const sid of G.jobs.novice.skills) { const d = G.skills[sid] || {}; for (const [k, v] of Object.entries(d.passive || {})) st[k] = (st[k] || 0) - v * (d.maxLevel || 0); }
  return st;
}
function baseBuild(p) {
  return {
    job: p.job, level: p.level, jobLevel: p.jobLevel, c2: p.c2 || '', c2Job: p.c2Job || 50, c2tr: {},
    stats: noviceFix(p.job, p.stats), skills: {}, evo: {}, traits: {}, hotbar: [], gear: {}, cards: [], cardStars: [],
    weapon: '', offhand: '', affixes: [],
    calc: { guild: Number(p.guild) || 0, soulforge: 0, pet: '', night: false, codex: 0, target: p.target, targetLevel: p.targetLevel, debuffed: false, lowHp: false },
    ...loadoutOf(p.loadout),
    ...(p.basics ? { basics: p.basics } : {}),
  };
}
// the character's worn gear and cards (from the game's inventory message), in the calculator's shape
const GEAR_SLOTS = ['weapon', 'offhand', 'armor', 'headgear', 'face', 'mouth', 'necklace', 'belt', 'boots', 'accessory', 'accessory2'];
function loadoutOf(lo) {
  if (!lo) return {};
  const out = {};
  const gear = {};
  for (const [slot, item] of Object.entries(lo.equip || {})) {
    if (!GEAR_SLOTS.includes(slot) || typeof item !== 'string') continue;
    const head = item.split('#')[0];
    const bar = head.indexOf('|');
    const name = bar >= 0 ? head.slice(0, bar) : head;
    // the game's item string: id, then &seal / $ (extra row) / * / !set / ^inscription / ~quality / +refine
    const id = name.split(/[&$!+^*~@]/)[0];
    const plus = /\+(\d+)/.exec(name);
    const affixes = bar >= 0 ? head.slice(bar + 1).split(',').filter(Boolean) : [];
    let refine = plus ? Number(plus[1]) : 0;
    if (slot === 'weapon' && lo.wRefine) refine = Math.max(refine, lo.wRefine);
    if (slot === 'offhand' && lo.sRefine) refine = Math.max(refine, lo.sRefine);
    gear[slot] = { id, affixes, refine };
  }
  if (Object.keys(gear).length) out.gear = gear;
  // album: card slot -> "spirit_card+N|monster" (N+1 stars)
  const cards = []; const stars = [];
  const al = lo.album || {};
  const keys = Object.keys(al).sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
  for (const k of keys) {
    const v = String(al[k] || ''); const bar = v.indexOf('|'); if (bar < 0) continue;
    const plus = /\+(\d+)/.exec(v.slice(0, bar));
    cards.push(v.slice(bar + 1)); stars.push((plus ? Number(plus[1]) : 0) + 1);
  }
  if (cards.length) { out.cards = cards; out.cardStars = stars; }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
const WORLD = { wraithroot_colossus: 99, pearlheart_titan: 130 };
function targetLevelFor(target, mode, level) {
  if (WORLD[target]) return WORLD[target];
  if (String(target).startsWith('training_dummy')) return level;
  const m = G.mobs && G.mobs[target];
  return mode === 'boss' && m && m.level ? m.level : level;
}
function targetsOf(sid, lv, evo, pack) {
  let d = G.skills[sid] || {};
  if (G.def) { try { d = G.def(sid, lv, evo || undefined) || d; } catch { /* keep */ } }
  if (d.maxTargets) return Math.min(d.maxTargets, pack);
  if (d.kind === 'zone' || d.zoneRadius || d.aoeDmgMult || d.dashRadius) return pack;
  if (d.arc && d.arc >= Math.PI / 2) return Math.min(pack, 4);
  if (d.pierce || d.fanShare || d.chain) return Math.min(pack, 3);
  return 1;
}
let evals = 0;
// ---------- combo conditions the game's calculator leaves out (or only has as an on/off switch) ----------
// Numbers are the game's own (its in-game guide text): Chill 1 stack per hit of a chilling skill, 3 stacks =
// frozen 1.6 s, a skill hit on a frozen target = Shatter x2.2 + 30% splash, Field Boss / Mini-boss never freeze
// and are not stunned. Hunter's Mark: +pct per stack for every hit on the marked target, 3 stacks (Markbow 6,
// at 6 = Apex +30%). "Target under status" bonuses (gear affix, cards, class 2) come from the calculator itself,
// weighted by how much of the fight this build keeps the target slowed / rooted / chilled.
const CHILL_FREEZE = 3; const FREEZE_MS = 1600; const SHATTER = 2.2; const SHATTER_SPLASH = 0.3; const CHILL_MS = 3000; const APEX = 1.3;
function isBossTarget(b) { const t = String((b.calc || {}).target || ''); const m = G.mobs && G.mobs[t]; return !!WORLD[t] || /^training_dummy:/.test(t) || (m && (m.role === 'boss' || m.role === 'mini-boss')); }
function defOf(b, sid) { let d = G.skills[sid] || {}; if (G.def) { try { d = G.def(sid, b.skills[sid] || 1, b.evo[sid] || undefined) || d; } catch { /* keep */ } } return d; }
function comboOf(b, p, r) {
  const rot = rotationOf(r, b.hotbar, SUSTAIN.DL, SUSTAIN.FROM);
  const secs = rot.secs || 120;
  const boss = isBossTarget(b);
  const parts = []; let mult = 1;
  const rate = (sid) => ((rot.per[sid] || {}).n || 0) / secs; // casts per second over the long fight
  // 0) gear proc affixes (suffixes like Chain Spark, Rend, Echo Strike...): the calculator leaves them out.
  // The game's proc table: trigger, chance, internal cooldown; the affix value is the % in its text.
  const PROC = { chain: { on: 'hit', ch: 0.10, icd: 600 }, bleed: { on: 'crit', ch: 0.50, icd: 300 }, frost: { on: 'hit', ch: 0.08, icd: 800 }, echo: { on: 'hit', ch: 0.12, icd: 700 }, expose: { on: 'hit', ch: 0.08, icd: 4000 }, haste: { on: 'crit', ch: 0.30, icd: 8000 } };
  const procVal = {};
  for (const it of Object.values(b.gear || {})) for (const a of (it && it.affixes) || []) { const m = /^p_(\w+):\d+:(\d+)$/.exec(a); if (m && PROC[m[1]]) procVal[m[1]] = (procVal[m[1]] || 0) + Number(m[2]); }
  let procUp = 0;
  if (Object.keys(procVal).length && rot.total) {
    const sh0 = r.sheet || {};
    const hitsPS = rot.ae.reduce((t, x) => t + rate(x.sid) * Math.max(1, x.perCast || 1), 0) + rate('basic');
    const avgHit = hitsPS ? rot.total / secs / hitsPS : 0;
    // crits: basic attacks and physical skill hits can crit (magic hits use Spell Amp instead)
    const physShare = rot.total ? (((rot.per.basic || {}).dmg || 0) + rot.ae.filter((x) => !x.magic).reduce((t, x) => t + ((rot.per[x.sid] || {}).dmg || 0), 0)) / rot.total : 0;
    const critPS = hitsPS * Math.min(1, sh0.crit || 0) * physShare;
    const fire = (k, per) => Math.min(per * PROC[k].ch, 1000 / PROC[k].icd);
    const dps = rot.total / secs; let add = 0; const bits = [];
    if (procVal.chain) { const n = boss ? 0 : Math.min(3, Math.max(0, (p.pack || 1) - 1)); const a = fire('chain', hitsPS) * avgHit * procVal.chain / 100 * n; add += a; bits.push('Chain Spark ' + (n ? '+' + Math.round(a / dps * 1000) / 10 + '%' : '(ไม่มีมอนข้างๆ ให้เด้ง)')); }
    if (procVal.echo) { const a = fire('echo', hitsPS) * avgHit * procVal.echo / 100; add += a; bits.push('Echo Strike +' + Math.round(a / dps * 1000) / 10 + '%'); }
    if (procVal.bleed) { const a = fire('bleed', critPS) * avgHit * (sh0.critDmg || 1.5) * procVal.bleed / 100; add += a; bits.push('Rend +' + Math.round(a / dps * 1000) / 10 + '%'); }
    let m = 1 + add / dps;
    if (procVal.expose) { const upE = Math.min(1, fire('expose', hitsPS) * 4); const g = upE * procVal.expose / 100 * 0.5; m *= 1 + g; bits.push('Sunder ~+' + Math.round(g * 1000) / 10 + '%'); }
    if (procVal.haste) { const upH = Math.min(1, fire('haste', critPS) * 4); const g = upH * procVal.haste / 100 * ((rot.per.basic || {}).dmg || 0) / rot.total; m *= 1 + g; bits.push('Frenzy +' + Math.round(g * 1000) / 10 + '%'); }
    if (procVal.frost) { procUp = Math.min(1, fire('frost', hitsPS) * 2); bits.push('Frostbite สโลว์ ' + Math.round(procUp * 100) + '% ของเวลา'); }
    mult *= m;
    parts.push({ k: 'proc', name: 'Proc จากเกียร์', gain: Math.round((m - 1) * 1000) / 10, list: bits });
  }
  // farming: a monster lives only a few seconds, so anything that has to be put on it first (a status, Hunter's
  // Mark stacks) is there only for part of its life. Real logs (Lv 100+): a Scout farming at ~1 kill a second hit
  // with no Mark or status bonus at all, a Warrior that bleeds targets on its first crit hit with the full status bonus.
  const ttk = (() => { if (boss) return Infinity; const hp = (r.target && r.target.hp) || 0; const d = rot.total / secs * mult; return hp > 0 && d > 0 ? hp / d * Math.max(1, p.lifePack || p.pack || 1) : Infinity; })(); // in a pack the damage is shared: each one lives longer
  const lifeShare = (appsPerSec) => (ttk === Infinity ? 1 : appsPerSec > 0 ? Math.max(0, 1 - 1 / (appsPerSec * ttk)) : 0); // part of a life after the first application
  // 1) target under status: how much of the time, and what the calculator's "debuffed" switch is worth
  let up = procUp; const ccSk = procUp ? ['Frostbite (เกียร์)'] : []; let apps = procUp ? 1000 / PROC.frost.icd * PROC.frost.ch : 0;
  for (const sid of b.hotbar) {
    const d = defOf(b, sid); const n = rate(sid); if (!n) continue;
    let ms = 0;
    if (!boss) ms = Math.max(ms, d.stunMs || 0, d.rootMs || 0, d.anchorRootMs || 0, d.freezeMs || 0);
    ms = Math.max(ms, d.slowPct ? (d.slowMs || 2000) : 0, d.chill ? CHILL_MS : 0);
    if (ms) { up += n * ms / 1000; apps += n; ccSk.push(d.name || sid); }
  }
  // gear bleed (Rend) is a status too: on a crit, so with a high crit rate the target bleeds from the first hits
  if (procVal.bleed && rot.total) { const sh0 = r.sheet || {}; const hitsPS = rot.ae.reduce((t, x) => t + rate(x.sid) * Math.max(1, x.perCast || 1), 0) + rate('basic'); const per = hitsPS * Math.min(1, sh0.crit || 0) * PROC.bleed.ch; const bl = Math.min(per, 1000 / PROC.bleed.icd); up += bl * 3; apps += per; /* a new target bleeds from its first crits (the cooldown is the character's, not the target's) */ ccSk.push('Rend (เกียร์)'); }
  up = Math.min(1, up) * lifeShare(apps);
  if (up > 0) {
    let on = null; try { on = calc({ ...b, calc: { ...b.calc, debuffed: true } }); } catch { on = null; }
    const off = (r.rotation || {}).dps || 0; const onD = on ? (on.rotation || {}).dps || 0 : off;
    let gain = off ? (onD / off - 1) : 0;
    // skills that hit harder on a target under status (not in the calculator)
    for (const x of rot.ae) { const d = defOf(b, x.sid); if (d.bonusVsStatusMult && rot.total) gain += ((rot.per[x.sid] || {}).dmg || 0) / rot.total * (d.bonusVsStatusMult - 1); }
    if (gain > 0.0005) { mult *= 1 + gain * up; parts.push({ k: 'status', name: 'เป้าติดสถานะ', up: Math.round(up * 100), full: Math.round(gain * 1000) / 10, gain: Math.round(gain * up * 1000) / 10, skills: ccSk }); }
    else parts.push({ k: 'status', name: 'เป้าติดสถานะ', up: Math.round(up * 100), full: 0, gain: 0, skills: ccSk });
  }
  // 2) Hunter's Mark (scout): stacks kept up by the marking skills
  if (b.job === 'scout') {
    let apps = 0; let pct = 0; let markRate = 0;
    for (const sid of b.hotbar) { const d = defOf(b, sid); if (d.huntMark && rate(sid)) { apps += rate(sid) * (d.huntMark.ms || 8000) / 1000; markRate += rate(sid); pct = Math.max(pct, d.huntMark.pct || 0); } }
    if (apps > 0 && pct > 0) {
      const cap = b.c2 === 'markbow' ? 6 : 3;
      // farming: stacks build on each new monster from zero (average over its life)
      const stacks = ttk === Infinity ? Math.min(cap, apps) : Math.min(cap, markRate * ttk / 2, apps);
      let m = 1 + stacks * pct; if (cap === 6 && stacks >= 6) m *= APEX;
      mult *= m;
      parts.push({ k: 'mark', name: "Hunter's Mark", stacks: Math.round(stacks * 10) / 10, cap, gain: Math.round((m - 1) * 1000) / 10, apex: cap === 6 && stacks >= 6 });
    }
  }
  // 3) Chill -> freeze -> Shatter (mage): only monsters that can freeze
  if (b.job === 'mage') {
    let stacks = 0; const chillers = [];
    for (const sid of b.hotbar) { const d = defOf(b, sid); if (d.chill && rate(sid)) { stacks += rate(sid) * d.chill * Math.min(p.pack || 1, d.maxTargets || 1, 1); chillers.push(d.name || sid); } }
    stacks += rate('basic'); // a mage's basic attack chills too (game guide)
    if (boss) { if (chillers.length) parts.push({ k: 'shatter', name: 'Chill → Shatter', boss: true, skills: chillers, gain: 0 }); }
    else if (stacks > 0 && rot.total) {
      // Shatter breaks on ONE skill hit, so use damage per hit (a zone cast lands several hits)
      const hitsPerSec = rot.ae.reduce((t, x) => t + rate(x.sid) * Math.max(1, x.perCast || 1), 0);
      const skillDmg = rot.ae.reduce((t, x) => t + ((rot.per[x.sid] || {}).dmg || 0), 0) / secs;
      const freezes = Math.min(stacks / CHILL_FREEZE, 1000 / FREEZE_MS, rot.ae.reduce((t, x) => t + rate(x.sid), 0));
      const avgHit = hitsPerSec ? skillDmg / hitsPerSec : 0;
      // extra from the shattering hit itself, per target (the 30% splash around it is left out: conservative)
      const add = freezes * avgHit * (SHATTER - 1);
      const m = 1 + add / (rot.total / secs);
      mult *= m;
      parts.push({ k: 'shatter', name: 'Chill → Shatter', perMin: Math.round(freezes * 60), skills: chillers, gain: Math.round((m - 1) * 1000) / 10 });
    }
  }
  // 4) class 2 path resources and class 1 mechanics (numbers from the game's own guide text)
  const dps0 = rot.total / secs; if (!dps0) return { mult, parts };
  const dummy = String((b.calc || {}).target || '').startsWith('training_dummy');
  const basicRate = rate('basic');
  const hitRate = rot.ae.reduce((t, x) => t + rate(x.sid) * Math.max(1, x.perCast || 1), 0) + basicRate;
  const castAll = rot.ae.reduce((t, x) => t + rate(x.sid), 0);
  const pBase = ((r.basic || {}).avg || 0) * (r.factorTotal || 1) * dummyAdj(b, r); // a 100% hit, no armor, no crit
  const sh = r.sheet || {};
  const basicShare = rot.total ? ((rot.per.basic || {}).dmg || 0) / rot.total : 0;
  const critEdge = (dc) => { const c = Math.min(1, sh.crit || 0); const cd = sh.critDmg || 1.5; return dc * (cd - 1) / (1 + c * (cd - 1)); }; // per +1.0 crit chance
  const c2d = b.c2 && G.c2defs[b.c2]; const res = c2d && c2d.res;
  const c2sk = rot.ae.filter((x) => { const c = (G.skills[x.sid] || {}).c2; return c && c.path === b.c2; });
  const fmt = (x) => Math.round(x * 1000) / 10;
  const steady = (gainPerSec, ms, max) => Math.min(max, gainPerSec * ms / 1000 >= 1 ? max : gainPerSec * ms / 1000);
  if (res && res.on === 'self' && (res.dmg || res.crit || res.aspd)) {
    // stacks on yourself: Null Charge from every hit; Focus / Souls from class 2 skills (1 per cast unless the skill says more)
    const gain = res.name === 'Null Charge' ? hitRate : c2sk.reduce((t, x) => t + rate(x.sid) * (((G.skills[x.sid] || {}).c2 || {}).gain || 1), 0);
    const spenders = c2sk.filter((x) => ((G.skills[x.sid] || {}).c2 || {}).spend);
    const spendRate = spenders.reduce((t, x) => t + rate(x.sid), 0);
    let avg;
    if (spendRate > 0 && gain > 0) { const T = 1 / spendRate; const fill = res.max / gain; avg = fill < T ? (res.max * (T - fill) + res.max / 2 * fill) / T : gain * T / 2; }
    else avg = gain > 0 ? steady(gain, res.keepMs || 12000, res.max) : 0;
    if (res.loseHalfOnHit && !dummy) avg *= 0.6; // hit by the target now and then
    let m = 1 + avg * (res.dmg || 0);
    if (res.crit) m *= 1 + critEdge(avg * res.crit) * 0.5; // crit helps the hits that can crit (about half of them)
    if (res.aspd) m *= 1 + basicShare * avg * res.aspd;
    mult *= m;
    parts.push({ k: 'res', name: res.name, stacks: Math.round(avg * 10) / 10, cap: res.max, gain: fmt(m - 1), spend: spenders.length > 0 });
  }
  if (b.c2 === 'venomblade' && res && res.dot) {
    const gain = basicRate + c2sk.reduce((t, x) => t + rate(x.sid) * (((G.skills[x.sid] || {}).c2 || {}).st || 1), 0);
    const st = steady(gain, res.ms || 8000, res.max);
    const add = st * res.dot * pBase;
    mult *= 1 + add / dps0;
    parts.push({ k: 'res', name: 'Poison', stacks: Math.round(st * 10) / 10, cap: res.max, gain: fmt(add / dps0) });
  }
  if (b.c2 === 'inquisitor' && res && res.vuln) {
    const gain = c2sk.reduce((t, x) => t + rate(x.sid) * (((G.skills[x.sid] || {}).c2 || {}).st || 1), 0);
    const st = steady(gain, res.ms || 10000, res.max);
    let m = 1 + st * res.vuln; if (st >= res.max && res.fullDot) m += res.fullDot * pBase / dps0;
    mult *= m;
    parts.push({ k: 'res', name: 'Sin', stacks: Math.round(st * 10) / 10, cap: res.max, gain: fmt(m - 1) });
  }
  if ((b.c2 === 'stormcaller' || b.c2 === 'scribe') && res && res.pop) {
    const gain = c2sk.reduce((t, x) => t + rate(x.sid) * (((G.skills[x.sid] || {}).c2 || {}).st || (b.c2 === 'stormcaller' ? 1 : 0)), 0);
    if (gain > 0) { const add = gain / res.max * res.pop * pBase; mult *= 1 + add / dps0; parts.push({ k: 'res', name: 'Static', perMin: Math.round(gain / res.max * 60), gain: fmt(add / dps0) }); }
  }
  if (b.c2 === 'trapper') {
    // every skill drops a trap: 500% when the target steps on it (counted for half of them: a boss doesn't walk over all)
    const add = castAll * 0.5 * 5 * pBase; mult *= 1 + add / dps0;
    parts.push({ k: 'res', name: 'กับดัก', perMin: Math.round(castAll * 30), gain: fmt(add / dps0) });
  }
  if (b.c2 === 'dusk') {
    // Combo to 8 -> Dusk 4 s: every hit crits, +50% damage
    const gain = basicRate + castAll; const cycle = gain > 0 ? 8 / gain + 4 : 0;
    if (cycle) { const up = 4 / cycle; const m = 1 + up * (0.5 + critEdge(1 - Math.min(1, sh.crit || 0))); mult *= m; parts.push({ k: 'res', name: 'Dusk', up: Math.round(up * 100), gain: fmt(m - 1) }); }
  }
  if (b.job === 'warrior') {
    // Sunder: warrior skill hits take 4% DEF / MDEF per stack off the target (5 stacks, 6 s)
    const skillHits = hitRate - basicRate; const st = steady(skillHits, 6000, 5);
    // what lower DEF/MDEF is worth: let the calculator take st x 4% armor pierce (same effect on its armor step)
    let m = 1;
    if (st > 0.05 && !p.__inner) { const q = { ...p, combos: false, __inner: true }; const v0 = score(b, q).v; const v1 = withExtra(b, 'armorPen', st * 4, (nb) => score(nb, q).v); m = v0 ? v1 / v0 : 1; }
    if (m > 1.0005) { mult *= m; parts.push({ k: 'res', name: 'Sunder', stacks: Math.round(st * 10) / 10, cap: 5, gain: fmt(m - 1) }); }
  }
  if (b.job === 'rogue') {
    // Execute: +30% on targets under 35% HP (half on bosses) - that part of every kill
    const m = 1 + 0.35 * 0.3 * (boss ? 0.5 : 1); mult *= m;
    parts.push({ k: 'res', name: 'Execute', gain: fmt(m - 1) });
  }
  return { mult, parts };
}

function score(b, p) {
  evals++;
  let r; try { r = calc(b); } catch (e) { return { v: 0, err: String(e && e.message || e) }; }
  const rot = r.rotation || { dps: 0, share: [] };
  const adj = dummyAdj(b, r);
  let v = (Object.keys(SKILL_ADJ).length ? (rot.share || []).reduce((t, s) => t + s.dmg * sAdj(s.key), 0) / (rot.seconds || 60) : rot.dps) * adj;
  if (p.mode === 'boss') v = p.fightSec ? windowDps(b, r, p.fightSec) : p.window === 'burst' ? v : sustainedDps(b, r);
  if (p.mode === 'farm') {
    // damage spread over the pack: each skill's share times how many monsters it hits
    v = 0;
    for (const s of rot.share) v += s.dmg * sAdj(s.key) * (s.key === 'basic' ? 1 : targetsOf(s.key, b.skills[s.key] || 1, b.evo[s.key], p.pack));
    v = v / (rot.seconds || 60);
  }
  if (p.combos !== false) { try { v *= comboOf(b, p, r).mult; } catch { /* leave as is */ } }
  return { v, r };
}
// hotbar = damaging skills by damage per second of cast time, best 6 (the game rotates in hotbar order)
let curP = null; // the run's settings (farm mode orders the hotbar by damage x monsters hit)
function setHotbar(b) {
  const r = calc({ ...b, hotbar: Object.keys(b.skills).filter((s) => b.skills[s] > 0 && !isPassive(s)) });
  const w = (s) => s.dpsAlone * sAdj(s.sid) * (curP && curP.mode === 'farm' ? targetsOf(s.sid, s.lv, b.evo[s.sid], curP.pack) : 1);
  const dmg = (r.skills || []).filter((s) => s.damages && s.lv > 0).sort((x, y) => w(y) - w(x));
  b.hotbar = dmg.slice(0, hotbarSize(b)).map((s) => s.sid);
  return b;
}
function bestEvoAndTraits(b, p) {
  // Evolution A/B per skill and trait A/B per line: try each, keep the better
  for (const sid of Object.keys(b.skills)) {
    if (!hasEvo(sid) || b.skills[sid] < evoAt(sid)) { delete b.evo[sid]; continue; }
    let best = null;
    for (const e of ['a', 'b']) { b.evo[sid] = e; const s = score(b, p).v; if (!best || s > best.s) best = { e, s }; }
    b.evo[sid] = best.e;
  }
  const lp = {}; for (const [s, l] of Object.entries(b.skills)) lp[lineOf(s)] = (lp[lineOf(s)] || 0) + l;
  // a class 2 line counts every skill listed in it (inherit paths include class 1 skills)
  if (b.c2 && G.c2defs[b.c2]) for (const l of G.c2defs[b.c2].lines) lp[l.id] = l.skills.reduce((t, x) => t + (b.skills[x] || 0), 0);
  for (const l of Object.keys(lp)) {
    const c2line = b.c2 && G.c2defs[b.c2] && G.c2defs[b.c2].lines.find((x) => x.id === l);
    const has = c2line ? !!c2line.tr : !!(G.traits && G.traits[l]);
    const box = c2line ? b.c2tr : b.traits;
    if (!has || lp[l] < TRAIT_AT) { delete box[l]; continue; }
    let best = null;
    for (const e of ['a', 'b']) { box[l] = e; const s = score(b, p).v; if (!best || s > best.s) best = { e, s }; }
    box[l] = best.e;
  }
}

// can this skill take one more point? (class 1: job level + previous skill in line at Lv 3; class 2: its job level + previous skill learnt)
function canRaise(b, sid, p, c2map) {
  const lv = b.skills[sid] || 0;
  if (lv >= maxLv(sid)) return false;
  if (c2map[sid]) {
    const d = G.skills[sid] || {};
    if (d.c2 && d.c2.job && p.c2Job < d.c2.job) return false;
    const prev = c2map[sid].prev;
    return !prev || (b.skills[prev] || 0) >= 1;
  }
  const q = c1Req(p.job, sid);
  if (q.jobLevel && p.jobLevel < q.jobLevel) return false;
  if (q.prereq && (b.skills[q.prereq] || 0) < (q.prereqLevel || 1)) return false;
  return true;
}

// start from the character's own build and its real hotbar, and move single skill points while it helps
// (1%+ a step). With real per-skill numbers in hand, points only go to skills that have real numbers.
function tuneFrom(b, p) {
  const c1 = G.jobs[p.job].skills;
  const c2list = p.c2 ? c2Skills(p.c2) : [];
  const c2map = Object.fromEntries(c2list.map((x) => [x.sid, x]));
  const known = Object.keys(SKILL_ADJ).length ? new Set(Object.keys(SKILL_ADJ)) : null;
  let cur = score(b, p).v; const start = cur;
  const moves = [];
  // the game accepted this build; when the lab's own rules disagree, the rules do not block moves
  const okRules = stillValid(b, p, c2map);
  const valid = () => !okRules || stillValid(b, p, c2map);
  for (let n = 0; n < 12; n++) {
    let best = null;
    for (const ids of [c1, c2list.map((x) => x.sid)]) {
      for (const from of ids) {
        if (!(b.skills[from] > 0)) continue;
        for (const to of ids) {
          if (to === from) continue;
          b.skills[from]--;
          if (canRaise(b, to, p, c2map) && valid()) {
            b.skills[to] = (b.skills[to] || 0) + 1;
            const hb = b.hotbar;
            b.hotbar = hb.filter((s) => b.skills[s] > 0);
            if (!b.hotbar.includes(to) && !isPassive(to) && b.hotbar.length < hotbarSize(b)) b.hotbar.push(to);
            // a skill without real numbers has to win by more (its number is the formula's guess)
            const need = known && !known.has(to) ? 1.05 : 1.01;
            const sv = valid() ? score(b, p).v : 0;
            if (sv > cur * need && (!best || sv / need > best.v / best.need)) best = { from, to, v: sv, need, hb: b.hotbar.slice() };
            b.hotbar = hb; b.skills[to]--; if (!b.skills[to]) delete b.skills[to];
          }
          b.skills[from]++;
        }
      }
    }
    if (!best) break;
    b.skills[best.from]--; if (!b.skills[best.from]) delete b.skills[best.from];
    b.skills[best.to] = (b.skills[best.to] || 0) + 1; b.hotbar = best.hb;
    moves.push({ from: best.from, to: best.to, gainPct: Math.round((best.v / cur - 1) * 1000) / 10, guess: !!(known && !known.has(best.to)) });
    cur = best.v;
  }
  // why nothing moved: every skill with real numbers at its max, or the build does not pass the lab's rules
  const why = { rulesOk: okRules, raisable: [...c1, ...c2list.map((x) => x.sid)].filter((sid) => canRaise(b, sid, p, c2map)).length };
  return { moves, gainPct: Math.round((cur / start - 1) * 1000) / 10, why };
}
async function optimize(p, onStep) {
  curP = p;
  const b = baseBuild(p);
  const c1 = G.jobs[p.job].skills;
  const c2list = p.c2 ? c2Skills(p.c2) : [];
  const c2map = Object.fromEntries(c2list.map((x) => [x.sid, x]));
  for (const l of c1Lines(p.job)) if (l.id && l.id !== 'basics') b.skills[l.skills[0]] = 1; // the free first skill of each line
  let left1 = c1Budget(p.job, p.jobLevel) - Object.values(b.skills).reduce((t, x) => t + x, 0);
  let left2 = p.c2 ? p.c2Points : 0;
  const pool = (cls) => (cls === 1 ? c1 : c2list.map((x) => x.sid));
  setHotbar(b);
  let cur = score(b, p).v;
  // greedy: spend points one step at a time on whatever adds the most; a step may be a chain
  // (raise the skill before it to the level needed, then this one) so locked skills get a fair look
  const stepOptions = (cls) => {
    const out = [];
    for (const sid of pool(cls)) {
      const path = [];
      const tmp = { ...b, skills: { ...b.skills } };
      let guard = 0; let broken = false;
      while (!canRaise(tmp, sid, p, c2map) && guard++ < 12) {
        let need = null;
        if (c2map[sid]) { const pr = c2map[sid].prev; if (pr && (tmp.skills[pr] || 0) < 1) need = pr; }
        else { const q = c1Req(p.job, sid); if (q.prereq && (tmp.skills[q.prereq] || 0) < (q.prereqLevel || 1)) need = q.prereq; }
        if (!need || !canRaise(tmp, need, p, c2map)) { broken = true; break; }
        tmp.skills[need] = (tmp.skills[need] || 0) + 1; path.push(need);
      }
      if (broken || !canRaise(tmp, sid, p, c2map)) continue;
      path.push(sid);
      out.push(path);
    }
    return out;
  };
  for (const cls of [1, 2]) {
    let n = 0;
    while ((cls === 1 ? left1 : left2) > 0) {
      const left = cls === 1 ? left1 : left2;
      let best = null;
      for (const path of stepOptions(cls)) {
        if (path.length > left) continue;
        for (const s of path) b.skills[s] = (b.skills[s] || 0) + 1;
        const hb = b.hotbar; setHotbar(b);
        const sv = score(b, p).v;
        const gain = (sv - cur) / path.length;
        if (!best || gain > best.gain) best = { path, gain, sv, hotbar: b.hotbar };
        for (const s of path) { b.skills[s] -= 1; if (!b.skills[s]) delete b.skills[s]; }
        b.hotbar = hb;
      }
      if (!best) break; // spend everything first (a skill can be worth it only after the one before it); pruneUseless takes back what adds nothing
      for (const s of best.path) b.skills[s] = (b.skills[s] || 0) + 1;
      b.hotbar = best.hotbar; cur = best.sv;
      if (cls === 1) left1 -= best.path.length; else left2 -= best.path.length;
      if (++n % 5 === 0) { bestEvoAndTraits(b, p); cur = score(b, p).v; if (onStep) await onStep(); }
    }
  }
  bestEvoAndTraits(b, p); setHotbar(b); cur = score(b, p).v;
  // polish: move single points between skills of the same class while it helps
  for (let round = 0; round < 4; round++) {
    let moved = false;
    for (const cls of [1, 2]) {
      const ids = pool(cls);
      for (const from of ids) {
        if (!(b.skills[from] > 0)) continue;
        for (const to of ids) {
          if (!(b.skills[from] > 0)) break; // its points are all moved already
          if (to === from) continue;
          b.skills[from]--; const fromLv = b.skills[from];
          const ok = canRaise(b, to, p, c2map) && stillValid(b, p, c2map);
          if (ok) {
            b.skills[to] = (b.skills[to] || 0) + 1;
            const hb = b.hotbar; setHotbar(b);
            const sv = score(b, p).v;
            if (sv > cur * 1.002 && stillValid(b, p, c2map)) { cur = sv; moved = true; if (!fromLv) delete b.skills[from]; continue; }
            b.skills[to]--; if (!b.skills[to]) delete b.skills[to]; b.hotbar = hb;
          }
          b.skills[from]++;
        }
      }
      if (onStep) await onStep();
    }
    bestEvoAndTraits(b, p); setHotbar(b); cur = score(b, p).v;
    if (!moved) break;
  }
  pruneUseless(b, p, c2map);
  bestHotbar(b, p);
  return b;
}
// skills whose points add (almost) no damage: give the points back (the free first skill of a line stays,
// and so does anything another skill needs). Returns what was taken back.
function uselessSkills(b, p, c2map, apply) {
  const free = new Set(c1Lines(p.job).filter((l) => l.id && l.id !== 'basics').map((l) => l.skills[0]));
  const base = score(b, p).v; const out = [];
  for (const sid of Object.keys(b.skills)) {
    const lv = b.skills[sid]; if (!(lv > 0)) continue;
    const keep = free.has(sid) ? 1 : 0; if (lv <= keep) continue;
    const hb = b.hotbar;
    b.skills[sid] = keep; if (!keep) delete b.skills[sid];
    const valid = stillValid(b, p, c2map);
    let sv = 0; if (valid) { setHotbar(b); sv = score(b, p).v; }
    if (valid && sv >= base * 0.998) out.push({ sid, name: (G.skills[sid] || {}).name || sid, points: lv - keep, c2: !!c2map[sid], why: !isPassive(sid) && !(hb || []).includes(sid) ? 'ไม่อยู่ในช่องลัด ไม่ถูกใช้' : 'ไม่เพิ่มดาเมจ' });
    if (!(apply && valid && sv >= base * 0.998)) { b.skills[sid] = lv; b.hotbar = hb; }
  }
  if (apply && out.length) setHotbar(b);
  return out;
}
function pruneUseless(b, p, c2map) { b.freed = uselessSkills(b, p, c2map, true); }
// hotbar slots: 6 for class 1, 8 once the character is class 2
const hotbarSize = (b) => (b && b.c2 ? 8 : 6);
// the game rotates skills in hotbar order: try every order of the slots (6 slots = 720), or pair swaps until
// nothing improves (8 slots), and swapping in left-out damaging skills
function bestHotbar(b, p, noExtra = false) {
  const r = calc({ ...b, hotbar: Object.keys(b.skills).filter((s) => b.skills[s] > 0 && !isPassive(s)) });
  const dmg = (r.skills || []).filter((s) => s.damages && s.lv > 0).sort((x, y) => y.dpsAlone - x.dpsAlone).map((s) => s.sid);
  let best = { v: score(b, p).v, hb: b.hotbar.slice() };
  // a hotbar holds each skill once (an earlier version could put one skill in two or three slots)
  const tryHb = (hb) => { if (new Set(hb).size !== hb.length) return; b.hotbar = hb; const v = score(b, p).v; if (v > best.v + 1e-9) best = { v, hb: hb.slice() }; };
  if (!noExtra) for (const extra of dmg.filter((s) => !best.hb.includes(s)).slice(0, 3)) for (let i = 0; i < best.hb.length; i++) { if (best.hb.includes(extra)) break; const hb = best.hb.slice(); hb[i] = extra; tryHb(hb); }
  const a = best.hb.slice(); const n = a.length; const c = new Array(n).fill(0);
  if (n > 1 && n <= 6) { let i = 0; while (i < n) { if (c[i] < i) { const k = i % 2 ? c[i] : 0; [a[k], a[i]] = [a[i], a[k]]; tryHb(a.slice()); c[i]++; i = 0; } else { c[i] = 0; i++; } } }
  else if (n > 6) {
    for (let round = 0; round < 6; round++) {
      const start = best.v;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const hb = best.hb.slice(); [hb[i], hb[j]] = [hb[j], hb[i]]; tryHb(hb); }
      // moving one skill to another spot catches orders a single swap can't reach
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i === j) continue; const hb = best.hb.slice(); const [x] = hb.splice(i, 1); hb.splice(j, 0, x); tryHb(hb); }
      if (best.v <= start + 1e-9) break;
    }
  }
  b.hotbar = best.hb;
}
function stillValid(b, p, c2map) {
  for (const [sid, lv] of Object.entries(b.skills)) {
    if (!lv) continue;
    if (c2map[sid]) { const pr = c2map[sid].prev; if (pr && !(b.skills[pr] >= 1)) return false; continue; }
    const q = c1Req(p.job, sid);
    if (q.prereq && (b.skills[q.prereq] || 0) < (q.prereqLevel || 1)) return false;
  }
  for (const l of c1Lines(p.job)) if (l.id && l.id !== 'basics' && !(b.skills[l.skills[0]] >= 1)) return false;
  return true;
}

// ---------- every stat: the sheet the game computes, and what each stat is worth for this build ----------
// Base stats go in through the calculator's own "add stats" option. Bonus stats (Spell Amp, cooldown, cast
// speed, crit, ...) go in as an extra effect on one card for the call, so the game's own sheet adds them
// exactly as it adds a real card's effect (the lab window is ours; the card table is put back after).
const STAT_TRY = [
  ['str', 'STR', 10, 'stat'], ['agi', 'AGI', 10, 'stat'], ['vit', 'VIT', 10, 'stat'], ['int', 'INT', 10, 'stat'], ['dex', 'DEX', 10, 'stat'], ['luk', 'LUK', 10, 'stat'],
  ['atkPct', 'ATK %', 5], ['matkPct', 'MATK %', 5], ['spellAmp', 'Spell Amp %', 5], ['cdr', 'ลดคูลดาวน์ %', 5], ['castSpd', 'ร่ายเร็ว %', 5],
  ['crit', 'โอกาสคริ %', 5], ['critDmg', 'ดาเมจคริ %', 10], ['aspd', 'ความเร็วโจมตี %', 5], ['armorPen', 'เจาะเกราะ %', 5], ['boss', 'ดาเมจใส่บอส %', 10],
];
function withExtra(b, key, val, fn) {
  const host = (b.cards && b.cards[0]) || Object.keys(G.cardDefs || {}).find((id) => G.mobs[id]);
  const def = G.cardDefs && G.cardDefs[host]; if (!def) return fn(b);
  const saved = def.fx; const nb = b.cards && b.cards.length ? b : { ...b, cards: [host], cardStars: [5] };
  def.fx = [...saved, { k: key, v: [val, val] }];
  try { return fn(nb); } finally { def.fx = saved; }
}
function statWeights(b, p) {
  const base = score(b, p).v; if (!base) return [];
  return STAT_TRY.map(([k, label, n, kind]) => {
    let v;
    if (kind === 'stat') v = score({ ...b, __opts: { addStats: { [k]: n } } }, p).v;
    else if (k === 'castSpd') {
      // cast speed only comes from a face / mouth gear affix: compare the same face piece with and without it
      // same face piece with a 4% and a 6% cast-speed affix (same grade either way), scaled to +n%
      // (tier 3 rolls 4-6%: the game drops an affix whose value is outside its tier)
      const face = (b.gear && b.gear.face) || { id: 'glasses', affixes: [], refine: 0 };
      const withCs = (x) => score({ ...b, gear: { ...(b.gear || {}), face: { ...face, affixes: [...(face.affixes || []), 'castspd:3:' + x] } } }, p).v;
      const v4 = withCs(4); const v6 = withCs(6);
      const g = v4 ? Math.round((v6 / v4 - 1) / 2 * n * 1000) / 10 : 0;
      return { key: k, label: '+' + n + ' ' + label, gain: g, note: g <= 0 ? 'เครื่องคิดเลขของเกม: ร่ายเร็วขึ้นไม่เพิ่มดาเมจบิลด์นี้ (จังหวะกดสกิลเปลี่ยน) / สายไม่มีแถบร่าย' : '' };
    } else v = withExtra(b, k, n, (nb) => score(nb, p).v);
    return { key: k, label: '+' + n + ' ' + label, gain: Math.round((v / base - 1) * 1000) / 10 };
  }).sort((a, c) => (c.gain == null ? -1e9 : c.gain) - (a.gain == null ? -1e9 : a.gain));
}
function sheetOf(r) {
  const c = (r && r.sheet) || {}; const pc = (x) => (x == null ? null : Math.round(x * 1000) / 10);
  return { atk: c.atk, matk: c.matk, spellAmp: pc(c.spellAmp), cdr: pc(c.cdr), castSpd: pc(c.castSpd), crit: pc(c.crit), critDmg: pc(c.critDmg), aspd: c.aspd, armorPen: pc(c.armorPen), hit: c.hit, maxHp: c.maxHp };
}

// ---------- skill order: replay the game's own rotation (same loop as its calculator) ----------
// every 50 ms over 60 s: if not busy casting, cast the first hotbar skill that is ready (charges, cooldown),
// otherwise swing a basic attack when its timer allows. Repeat charges hit for 50%.
// per-skill factors learned from this character's real hits (relative to its median skill): skills the
// game's planner formula under- or over-rates (e.g. at world bosses). Empty = the game's formula as is.
let SKILL_ADJ = {};
const sAdj = (k) => SKILL_ADJ[k] || 1;
function useSkillAdj(p) { SKILL_ADJ = (p && p.skillAdj && typeof p.skillAdj === 'object') ? p.skillAdj : {}; }
function rotationOf(r, hotbar, DL = 60000, FROM = 0) {
  const V = (r && r.skills) || [];
  const ae = hotbar.map((sid) => V.find((x) => x.sid === sid && x.damages && x.hit)).filter(Boolean);
  const st = new Map(ae.map((x) => [x.sid, { left: x.charges || 1, refill: 0, first: true }]));
  const basic = (r && r.basic) || { cdMs: 1000, vsTarget: 0 };
  const STEP = 50; const REPEAT = 0.5;
  let busy = 0; let nextBasic = 0; const casts = []; const per = {}; let total = 0;
  for (let t = 0; t < DL; t += STEP) {
    if (t < busy) continue;
    const we = ae.find((x) => { const s = st.get(x.sid); if (s.left <= 0 && t >= s.refill) { s.left = x.charges || 1; s.first = true; } return s.left > 0; });
    if (we) {
      const s = st.get(we.sid);
      const dmg = (we.hit.vsTarget * we.perCast + (we.dot || 0)) * (s.first ? 1 : REPEAT) * sAdj(we.sid);
      s.first = false; s.left--; s.refill = t + we.cdMs;
      casts.push({ t, sid: we.sid, dmg });
      if (t >= FROM) { total += dmg; const q = per[we.sid] || (per[we.sid] = { n: 0, dmg: 0 }); q.n++; q.dmg += dmg; }
      busy = t + Math.max(STEP, we.castMs || 0);
      if (we.castMs > 0) continue;
    }
    if (t >= nextBasic && basic.cdMs) { if (t >= FROM) { const bd = (basic.vsTarget || 0) * sAdj('basic'); total += bd; const q = per.basic || (per.basic = { n: 0, dmg: 0 }); q.n++; q.dmg += bd; } nextBasic = Math.max(t, nextBasic) + basic.cdMs; }
  }
  return { casts, per, total, ae, secs: (DL - FROM) / 1000 };
}
// long-fight damage: minutes 2-3 of a 3-minute rotation (no opening burst where every skill is ready at once)
const SUSTAIN = { DL: 180000, FROM: 60000 };
// average damage per second over a fight of T seconds from the first hit (opening burst included)
function windowDps(b, r, T) { const x = rotationOf(r, b.hotbar, Math.max(5, T) * 1000, 0); return x.total / Math.max(5, T) * dummyAdj(b, r); }
function sustainedDps(b, r) { const x = rotationOf(r, b.hotbar, SUSTAIN.DL, SUSTAIN.FROM); return x.total / x.secs * dummyAdj(b, r); }
// skills that put the target under crowd control (root / stun / slow / freeze / chill)
const ccOf = (d) => [d.rootMs && 'ตรึง ' + d.rootMs / 1000 + ' วิ', d.stunMs && 'สตัน ' + d.stunMs / 1000 + ' วิ', d.freezeMs && 'แช่แข็ง ' + d.freezeMs / 1000 + ' วิ', d.slowPct && 'สโลว์ ' + Math.round(d.slowPct * 100) + '%', d.chill && 'หนาว'].filter(Boolean);
function skillOrder(b, p, r) {
  const name = (sid) => (sid === 'basic' ? 'โจมตีปกติ' : (G.skills[sid] || {}).name || sid);
  const rot = rotationOf(r, b.hotbar, SUSTAIN.DL, SUSTAIN.FROM); // rank over the long fight (minutes 2-3)
  const open = rotationOf(r, b.hotbar);                            // first 15 s for the opening sequence
  const adj = dummyAdj(b, r);
  const V = (r && r.skills) || [];
  const rank = Object.entries(rot.per).map(([sid, q]) => {
    const v = V.find((x) => x.sid === sid) || {};
    return { sid, name: name(sid), casts: Math.round(q.n / rot.secs * 60), perCast: Math.round(q.dmg / Math.max(1, q.n) * adj), share: rot.total ? Math.round(q.dmg / rot.total * 1000) / 10 : 0,
      cdMs: sid === 'basic' ? Math.round(((r.basic || {}).cdMs || 0)) : Math.round(v.cdMs || 0), castMs: Math.round(v.castMs || 0), charges: v.charges || 1,
      slot: b.hotbar.indexOf(sid) + 1 };
  }).sort((a, c) => c.share - a.share);
  const opener = open.casts.filter((c) => c.t < 15000).map((c) => ({ t: Math.round(c.t / 100) / 10, name: name(c.sid) }));
  // crowd-control combo: what the "target is debuffed / under CC" bonuses are worth for this build
  let combo = null;
  const cc = b.hotbar.map((sid) => { let d = G.skills[sid] || {}; if (G.def) { try { d = G.def(sid, b.skills[sid] || 1, b.evo[sid] || undefined) || d; } catch { /* keep */ } } return { sid, name: name(sid), what: ccOf(d), ms: d.rootMs || d.stunMs || d.freezeMs || d.slowMs || (d.chill ? 2000 : 0), cd: d.cdMs || 0 }; }).filter((x) => x.what.length);
  if (cc.length) {
    let on; try { on = calc({ ...b, calc: { ...b.calc, debuffed: true } }); } catch { on = null; }
    const base = (r.rotation || {}).dps || 0; const up = on ? (on.rotation || {}).dps || 0 : 0;
    const gain = base ? (up / base - 1) : 0;
    // how much of the fight the target is under CC from these skills (duration / cooldown, capped at 100%)
    const uptime = Math.min(1, cc.reduce((t, x) => t + (x.cd ? x.ms / x.cd : 0), 0));
    combo = { skills: cc.map((x) => ({ name: x.name, what: x.what.join(' · ') })), fullGain: Math.round(gain * 1000) / 10, uptime: Math.round(uptime * 100), realGain: Math.round(gain * uptime * 1000) / 10, opener: cc[0].name };
  }
  // why this hotbar order: compare with the plain "biggest hit first" order
  let naive = null;
  try {
    const byHit = rank.filter((x) => x.sid !== 'basic').sort((a, c) => c.perCast - a.perCast).map((x) => x.sid);
    if (byHit.join() !== b.hotbar.join()) {
      const rn = calc({ ...b, hotbar: byHit });
      const d0 = sustainedDps(b, r); const d1 = sustainedDps({ ...b, hotbar: byHit }, rn);
      naive = { order: byHit.map(name), gain: d1 ? Math.round((d0 / d1 - 1) * 1000) / 10 : 0 };
    }
  } catch { /* skip */ }
  const filler = rank.filter((x) => x.sid !== 'basic').sort((a, c) => c.casts - a.casts)[0];
  return { rank, opener, combo, naive, filler: filler ? filler.name : '' };
}

function describe(b, p) {
  const s = score(b, p);
  const r = s.r || {};
  const name = (sid) => (G.skills[sid] || {}).name || sid;
  const evoName = (sid, e) => { try { return G.evo[sid].mods[e].name || e.toUpperCase(); } catch { return e.toUpperCase(); } };
  const traitName = (line, e) => {
    const c2line = b.c2 && G.c2defs[b.c2] && G.c2defs[b.c2].lines.find((x) => x.id === line);
    if (c2line && c2line.tr) return (c2line.tr[e === 'a' ? 0 : 1] || {}).name || e;
    try { return G.traits[line][e].name; } catch { return e; }
  };
  const lineName = (line) => {
    const c2line = b.c2 && G.c2defs[b.c2] && G.c2defs[b.c2].lines.find((x) => x.id === line);
    return c2line ? c2line.name : ((Object.values(G.skills).find((x) => x.line === line) || {}).lineName || line);
  };
  const notes = new Set(); for (const k of r.skills || []) if (b.skills[k.sid]) for (const n of k.notes || []) notes.add(name(k.sid) + ': ' + n);
  for (const n of r.notes || []) notes.add(n);
  const isC2 = (sid) => !!(G.skills[sid] && G.skills[sid].c2);
  // the game's own build-guide checker on the class 1 part (points, job levels, prerequisites)
  let problems = [];
  if (G.validate) {
    try {
      const c1only = Object.fromEntries(Object.entries(b.skills).filter(([sid, l]) => l > 0 && !isC2(sid)));
      const v = G.validate({ title: 'BinderDash Lab', modes: [], job: p.job, level: p.level, jobLevel: p.jobLevel, skills: c1only, evo: b.evo, traits: b.traits, hotbar: b.hotbar, stats: {} });
      problems = ((v && v.problems) || []).filter((x) => /แต้มสกิล|Job Lv|ต้องอัป/.test(x));
    } catch { /* checker changed shape: skip */ }
  }
  const used = (c2) => Object.entries(b.skills).filter(([sid]) => isC2(sid) === c2).reduce((t, [, l]) => t + l, 0);
  return {
    points: { c1: used(false), c1Max: c1Budget(p.job, p.jobLevel), c2: used(true), c2Max: b.c2 ? p.c2Points : 0 },
    score: Math.round(s.v), dps: Math.round(((r.rotation || {}).dps || 0) * dummyAdj(b, r)),
    sustained: (() => { try { return Math.round(sustainedDps(b, r)); } catch { return 0; } })(), window: p.window === 'burst' ? 'burst' : 'sustain',
    fightSec: p.fightSec || 0, fightDps: p.fightSec ? Math.round(windowDps(b, r, p.fightSec)) : 0, bossHp: (r.target && r.target.hp) || 0, ttk: r.ttk, hitsToDie: r.defense && r.defense.hitsToDie,
    c2: b.c2 ? (G.c2defs[b.c2] || {}).name || b.c2 : '',
    skills: Object.entries(b.skills).filter(([, l]) => l > 0).map(([sid, lv]) => ({ sid, name: name(sid), lv, max: maxLv(sid), line: lineName(lineOf(sid)), c2: !!(G.skills[sid] && G.skills[sid].c2), evo: b.evo[sid] ? b.evo[sid].toUpperCase() + ' · ' + evoName(sid, b.evo[sid]) : '', passive: isPassive(sid) })),
    traits: [...Object.entries(b.traits), ...Object.entries(b.c2tr)].map(([l, e]) => lineName(l) + ': ' + e.toUpperCase() + ' · ' + traitName(l, e)),
    hotbar: b.hotbar.map(name), hotbarIds: b.hotbar.slice(),
    // damaging hotbar skills this character has never been measured with: their numbers are the formula only
    unmeasured: Object.keys(SKILL_ADJ).length ? b.hotbar.filter((sid) => SKILL_ADJ[sid] == null).map(name) : [],
    freed: (b.freed || []).map((x) => x.name + ' ' + x.points + ' แต้ม (' + x.why + ')'),
    measured: Object.keys(SKILL_ADJ).length > 0,
    share: ((r.rotation || {}).share || []).slice(0, 8).map((x) => ({ name: x.key === 'basic' ? 'โจมตีปกติ' : name(x.key), pct: Math.round(x.dmg / Math.max(1, (r.rotation.share || []).reduce((t, y) => t + y.dmg, 0)) * 100) })),
    notes: [...problems.map((x) => '⚠ ' + x), ...notes].slice(0, 10),
    problems,
    build: { skills: b.skills, evo: b.evo, traits: b.traits, c2tr: b.c2tr, hotbar: b.hotbar, c2: b.c2 },
    order: (() => { try { return skillOrder(b, p, r); } catch (e) { return null; } })(),
    combos: (() => { try { return comboOf(b, p, r).parts; } catch { return []; } })(),
    sheet: sheetOf(r),
    weights: (() => { try { return statWeights(b, p); } catch { return []; } })(),
  };
}

function pickTarget(mode, level, want) {
  const mobs = G.mobs ? Object.entries(G.mobs) : [];
  if (want && (mobs.some(([k]) => k === want) || WORLD[want] || String(want).startsWith('training_dummy'))) return want;
  const role = mode === 'boss' ? 'boss' : 'trash';
  const list = mobs.filter(([, m]) => m && m.role === role && typeof m.level === 'number');
  list.sort((a, b) => Math.abs(a[1].level - level) - Math.abs(b[1].level - level));
  return list.length ? list[0][0] : 'sprout';
}

// ---------- card builds ----------
const FX_TH = { atkPct: 'ATK', matkPct: 'MATK', critDmg: 'ดาเมจคริ', crit: 'โอกาสคริ', cdr: 'คูลดาวน์ −', aspd: 'ความเร็วโจมตี', maxHpPct: 'HP', dmgTaken: 'รับดาเมจ −', gold: 'Gold', drop: 'ดรอป', spirit: 'Spirit', gather: 'เก็บของ', boss: 'ดาเมจใส่บอส', debuffed: 'ดาเมจใส่เป้าติดดีบัฟ', thorns: 'สะท้อน', opener: 'ดาเมจตีแรก' };
const comboFx = (f) => (f.k === 'stat' ? (f.stat || '').toUpperCase() + ' +' + f.v : (FX_TH[f.k] || f.k) + (/−$/.test(FX_TH[f.k] || '') ? '' : ' +') + f.v + '%');
// 9 slots open at these levels; Spirit Load: boss 5, mini-boss 3, elite 2, others 1; cap by level
const CARD_SLOTS = [12, 18, 25, 32, 40, 50, 60, 70, 85];
const cardLoad = (id) => { const r = (G.mobs[id] || {}).role; return r === 'boss' ? 5 : r === 'mini-boss' ? 3 : r === 'elite' ? 2 : 1; };
const loadCap = (lv) => (lv < 12 ? 0 : Math.min(18, 4 + Math.floor((lv - 12) / 6)));
const fxText = (f, star) => {
  const v = f.v ? f.v[0] + (f.v[1] - f.v[0]) * (Math.max(1, Math.min(5, star)) - 1) / 4 : f.a;
  const n = f.k === 'stat' ? Math.round(v) : Math.round(v * 10) / 10;
  return f.k === 'stat' ? (f.stat || '').toUpperCase() + ' +' + n : f.k + (f.species ? '(' + f.species + ')' : '') + ' +' + n + (f.k === 'stat' ? '' : '%');
};
function cardScore(b, p) {
  evals++;
  let r; try { r = calc(b); } catch { return { v: 0 }; }
  const rot = r.rotation || { dps: 0, share: [] };
  let dps = rot.dps * dummyAdj(b, r);
  if (p.goal === 'boss') dps = p.fightSec ? windowDps(b, r, p.fightSec) : p.window === 'burst' ? dps : sustainedDps(b, r);
  if (p.goal !== 'boss') { dps = 0; for (const s of rot.share) dps += s.dmg * (s.key === 'basic' ? 1 : targetsOf(s.key, b.skills[s.key] || 1, b.evo[s.key], p.pack)); dps /= rot.seconds || 60; }
  const al = r.album || {};
  const gold = al.gold || 0; const drop = al.drop || 0;
  if (p.combos !== false) { try { dps *= comboOf(b, { ...p, mode: p.goal === 'boss' ? 'boss' : 'farm' }, r).mult; } catch { /* leave */ } }
  const v = p.goal === 'gold' ? dps * (1 + gold / 100) * (1 + drop / 200) : dps;
  return { v, dps, gold, drop, r };
}
L.cards = async (p) => {
  await load(); useSkillAdj(p);
  if (!G.cardDefs || !G.mobs) throw new Error('หาข้อมูลการ์ดของเกมไม่เจอ');
  evals = 0; const t0 = performance.now();
  const goal = p.goal || 'boss';
  const target = pickTarget(goal === 'boss' ? 'boss' : 'farm', p.level, p.target || ''); // farming: the monster this character really farms (from its logs) when known
  const tmob = G.mobs[target];
  const q = { ...p, goal, pack: Math.max(1, p.pack || 4), mode: goal === 'boss' ? 'boss' : 'farm' };
  curP = q;
  const b = { ...baseBuild({ ...q, target, targetLevel: targetLevelFor(target, goal === 'boss' ? 'boss' : 'farm', p.level) }), ...JSON.parse(JSON.stringify(p.build || {})) };
  if (!b.hotbar || !b.hotbar.length) { setHotbar(b); bestHotbar(b, { ...q, mode: q.mode }); } // a character's build: order its hotbar like the game would
  const q0 = (b.cards && b.cards.length) ? cardScore(b, q) : null; // the character's own cards now
  const nowCards = q0 ? b.cards.slice() : [];
  b.cards = []; b.cardStars = [];
  const slots = CARD_SLOTS.filter((l) => p.level >= l).length;
  const cap = loadCap(p.level);
  const star = Math.max(1, Math.min(5, p.stars || 5));
  // only the cards this character owns (how many of each, best star), or every card in the game
  const owned = Array.isArray(p.owned) && p.owned.length ? Object.fromEntries(p.owned.map((o) => [o.mob, o])) : null;
  // a "crit card": its main effect is crit chance / crit damage (p.noCrit leaves them out)
  const isCritCard = (id) => { const fx = (G.cardDefs[id] || {}).fx || []; return !!fx.length && (fx[0].k === 'crit' || fx[0].k === 'critDmg'); };
  const pool = Object.keys(G.cardDefs).filter((id) => G.mobs[id] && cardLoad(id) <= cap && (!owned || owned[id]) && !(p.noCrit && isCritCard(id)));
  const starOf = (id) => (owned && owned[id] ? Math.max(1, Math.min(5, owned[id].stars || 1)) : star);
  // the game counts copies of one card (its "true" form included) at 100% / 50% / 25% / 0%, and a copy adds
  // nothing to region / kin / colour sets: by default a card goes in once (p.allowDup lets copies in)
  const grp = (id) => ((G.cardDefs[id] || {}).trueOf) || String(id).replace(/^true_/, ''); // True Wraithroot = Wraithroot (the game's trueOf)
  const copies = (id) => b.cards.filter((c) => grp(c) === grp(id)).length;
  const haveLeft = (id) => (p.allowDup ? true : copies(id) === 0) && (!owned || b.cards.filter((c) => c === id).length < (owned[id].n || 1));
  const used = () => b.cards.reduce((t, c) => t + cardLoad(c), 0);
  const sc = () => cardScore(b, q).v;
  const base = cardScore(b, q);
  let cur = base.v;
  // 1) each card alone: its value, and which combos it belongs to (region / kin / colour, read from the game's album)
  const groups = new Map(); // "kind:key" -> { kind, key, name, need: [..], members: [] }
  const single = [];
  for (const id of pool) {
    b.cards = [id]; b.cardStars = [starOf(id)];
    const r = cardScore(b, q);
    single.push({ id, v: r.v - cur });
    for (const x of ((r.r && r.r.album && r.r.album.res) || [])) {
      if (!x.count) continue;
      const k = x.kind + ':' + x.key;
      let g = groups.get(k);
      if (!g) groups.set(k, g = { kind: x.kind, key: x.key, name: x.name, need: x.kind === 'region' ? [3, 5] : [x.need || 2], members: [] });
      g.members.push(id);
    }
  }
  b.cards = []; b.cardStars = [];
  await new Promise((r) => setTimeout(r, 0));
  const val = Object.fromEntries(single.map((x) => [x.id, x.v]));
  single.sort((a, b2) => b2.v - a.v);
  // candidates: the strongest cards on their own + the best members of every combo
  const cand = new Set(single.slice(0, 45).map((x) => x.id));
  for (const g of groups.values()) for (const id of g.members.slice().sort((a, c) => val[c] - val[a]).slice(0, 7)) cand.add(id);
  const C = [...cand];
  const fill = (list) => {
    // greedy fill from the candidates (gain per Spirit Load), then swaps over the candidates
    let v = sc();
    while (b.cards.length < slots) {
      let best = null;
      for (const id of list) {
        if (used() + cardLoad(id) > cap || !haveLeft(id)) continue;
        b.cards.push(id); b.cardStars.push(starOf(id));
        const nv = sc(); const g = (nv - v) / cardLoad(id);
        if (!best || g > best.g) best = { id, v: nv, g };
        b.cards.pop(); b.cardStars.pop();
      }
      if (!best || best.v <= v) break;
      b.cards.push(best.id); b.cardStars.push(starOf(best.id)); v = best.v;
    }
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (let i = 0; i < b.cards.length; i++) {
        const old = b.cards[i]; const oldStar = b.cardStars[i];
        let best = null;
        for (const id of list) {
          if (id === old || used() - cardLoad(old) + cardLoad(id) > cap) continue;
          b.cards[i] = id; b.cardStars[i] = starOf(id);
          const okDup = p.allowDup || b.cards.filter((c, j) => j !== i && grp(c) === grp(id)).length === 0;
          if (okDup && (haveLeft(id) || b.cards.filter((c) => c === id).length <= ((owned && owned[id] && owned[id].n) || 99))) { const nv = sc(); if (nv > v * 1.0005 && (!best || nv > best.v)) best = { id, v: nv }; }
          b.cards[i] = old; b.cardStars[i] = oldStar;
        }
        if (best) { b.cards[i] = best.id; b.cardStars[i] = starOf(best.id); v = best.v; moved = true; }
      }
      if (!moved) break;
    }
    return v;
  };
  // 2) start points: nothing forced, and every combo (region 3 and 5, kin pair, colour set) forced in with its best members
  const seeds = [[]];
  for (const g of groups.values()) {
    const mem = g.members.filter((id) => !owned || owned[id]).sort((a, c) => val[c] - val[a]);
    for (const n of g.need) if (mem.length >= n) seeds.push(mem.slice(0, n));
  }
  let best = null;
  for (const seed of seeds) {
    b.cards = []; b.cardStars = [];
    let ok = true;
    for (const id of seed) { if (b.cards.length >= slots || used() + cardLoad(id) > cap || !haveLeft(id)) { ok = false; break; } b.cards.push(id); b.cardStars.push(starOf(id)); }
    if (!ok) continue;
    const v = fill(C);
    if (!best || v > best.v) best = { v, cards: b.cards.slice(), stars: b.cardStars.slice() };
    await new Promise((r) => setTimeout(r, 0));
  }
  b.cards = best ? best.cards : []; b.cardStars = best ? best.stars : [];
  // 3) last polish over every card in the game (or every card owned)
  cur = fill(pool);
  const tried = seeds.length;
  const combos = ((cardScore(b, q).r || {}).album || {}).res || [];
  const sets = combos.filter((x) => x.on).map((x) => ({ kind: x.kind, name: x.name, count: x.count, need: x.need, tier: x.tier, fx: (x.fx || []).map(comboFx) }));
  const near = combos.filter((x) => !x.on && x.count > 0 && x.count + 1 >= (x.kind === 'region' ? 3 : x.need)).map((x) => ({ kind: x.kind, name: x.name, count: x.count, need: x.kind === 'region' ? 3 : x.need }));
  const fin = cardScore(b, q);
  // why each card: damage lost without it, and the skill it lifts the most
  const shareOf = (r) => Object.fromEntries((((r && r.rotation) || {}).share || []).map((x) => [x.key, x.dmg]));
  const fullShare = shareOf(fin.r);
  const setsOf = (r) => ((((r && r.album) || {}).res) || []).filter((x) => x.kind === 'region' && x.count >= 3).map((x) => ({ name: x.name, tier: x.count >= 5 ? 5 : 3 }));
  const fullSets = setsOf(fin.r);
  const keepC = b.cards; const keepS = b.cardStars;
  const why = keepC.map((id, i) => {
    b.cards = keepC.filter((_, j) => j !== i); b.cardStars = keepS.filter((_, j) => j !== i);
    const w = cardScore(b, q);
    b.cards = keepC; b.cardStars = keepS;
    const lost = fullSets.filter((x) => !setsOf(w.r).some((y) => y.name === x.name && y.tier === x.tier)).map((x) => x.name + ' ' + x.tier + ' ใบ');
    const ws = shareOf(w.r);
    let top = null;
    for (const [k, v] of Object.entries(fullShare)) { const g = v - (ws[k] || 0); if (!top || g > top.g) top = { k, g, base: ws[k] || 0 }; }
    const name = top ? (top.k === 'basic' ? 'โจมตีปกติ' : (G.skills[top.k] || {}).name || top.k) : '';
    return { set: lost.join(', '), pct: fin.v ? Math.round((fin.v - w.v) / fin.v * 1000) / 10 : 0, skill: top && top.g > 0 ? name : '', skillPct: top && top.base ? Math.round(top.g / top.base * 100) : 0 };
  });
  const magic = !!(fin.r && fin.r.basic && fin.r.basic.usesMatk) || ((fin.r && fin.r.skills) || []).filter((x) => x.magic && b.skills[x.sid]).length > ((fin.r && fin.r.skills) || []).filter((x) => !x.magic && x.damages && b.skills[x.sid]).length;
  return {
    goal, target: { id: target, level: b.calc.targetLevel }, slots, cap, load: used(), star, magic,
    owned: !!owned, poolSize: pool.length, noCrit: !!p.noCrit,
    critCards: [...new Set(b.cards.filter(isCritCard))],
    // skills in this build that always crit (an Evolution that says so) - the only magic damage crit cards help
    sureCrit: Object.keys(b.skills || {}).filter((sid) => b.skills[sid] > 0 && b.evo && b.evo[sid]).map((sid) => {
      const d = G.skills[sid] || {}; const i = b.evo[sid] === 'a' ? 0 : 1;
      const t = (d.c2 && d.c2.evo && d.c2.evo[i]) || null;
      return t && /คริแน่นอน/.test(t[1] || '') ? (d.name || sid) + ' (Evo ' + b.evo[sid].toUpperCase() + ' · ' + t[0] + ')' : null;
    }).filter(Boolean),
    now: q0 ? { dps: Math.round(q0.dps), gold: Math.round(q0.gold * 10) / 10, drop: Math.round(q0.drop * 10) / 10, cards: nowCards } : null,
    cards: b.cards.map((id, i) => ({ id, star: b.cardStars[i], why: why[i], proc: (G.cardDefs[id].fx || []).some((f) => f.k !== 'stat' && !/Pct$|^(crit|critDmg|cdr|aspd|armorPen|boss|elite|night|gold|drop|spellAmp|castSpd|hit|flee|def|mdef|matk|atk|maxHp|maxMp|dmgTaken|slayer|ward|wardBoss|wardNight|debuffed|opener|desperate|haste|barrier|spirit|gather|block|lifesteal|magicRes|thorns)$/.test(f.k)), role: G.mobs[id].role, level: G.mobs[id].level, load: cardLoad(id), fx: (G.cardDefs[id].fx || []).map((f) => fxText(f, b.cardStars[i])) })),
    before: { dps: Math.round(base.dps), gold: base.gold, drop: base.drop },
    after: { dps: Math.round(fin.dps), gold: Math.round(fin.gold * 10) / 10, drop: Math.round(fin.drop * 10) / 10 },
    sets, near, seeds: tried, evals, ms: Math.round(performance.now() - t0),
  };
};

// ---------- prediction for the character as it is now (to compare with a real measurement) ----------
L.predict = async (p) => {
  await load(); useSkillAdj(p);
  if (!G.jobs[p.job]) throw new Error('ไม่รู้จักอาชีพ ' + p.job);
  const target = pickTarget('boss', p.level, p.target);
  const q = { ...p, mode: 'boss', target, targetLevel: targetLevelFor(target, 'boss', p.level), c2: (p.current && p.current.c2) || '' };
  curP = q;
  const cur = p.current || {};
  const b = { ...baseBuild(q), skills: { ...(cur.skills || {}) }, evo: { ...(cur.evo || {}) }, traits: { ...(cur.traits || {}) }, c2tr: { ...(cur.c2tr || {}) } };
  // the hotbar the character really fights with (when known), else the best one the lab finds
  const realHb = cur.hotbar && Array.isArray(cur.hotbar) ? [...new Set(cur.hotbar)].filter((sid) => (b.skills[sid] || 0) > 0 && !isPassive(sid)).slice(0, hotbarSize(b)) : [];
  let reorder = null;
  if (realHb.length) {
    b.hotbar = realHb;
    // p.reorder: the best order of the same skills (nothing added or dropped)
    if (p.reorder) { const before = score(b, q).v; bestHotbar(b, q, true); const after = score(b, q).v; reorder = { gainPct: Math.round((after / Math.max(1e-9, before) - 1) * 1000) / 10 }; }
  } else { setHotbar(b); bestHotbar(b, q); }
  // the character's own points that add no boss damage (and nothing needs): worth moving elsewhere
  let useless = [];
  try { const hb0 = b.hotbar.slice(); const c2map = Object.fromEntries((b.c2 ? c2Skills(b.c2) : []).map((x) => [x.sid, x])); useless = uselessSkills(b, q, c2map, false).map((x) => ({ name: x.name, points: x.points, why: x.why })); b.hotbar = hb0; } catch { useless = []; }
  const r = calc(b);
  const rot0 = r.rotation || { dps: 0, share: [], seconds: 60 };
  const adj = dummyAdj(b, r);
  const rot = { ...rot0, share: (rot0.share || []).map((x) => ({ ...x, dmg: x.dmg * adj * sAdj(x.key) })) };
  rot.dps = Object.keys(SKILL_ADJ).length ? rot.share.reduce((t, x) => t + x.dmg, 0) / (rot0.seconds || 60) : rot0.dps * adj;
  const name = (sid) => (sid === 'basic' ? 'โจมตีปกติ' : (G.skills[sid] || {}).name || sid);
  const bs = r.basic || {}; const sh = r.sheet || {};
  let cmb = { mult: 1, parts: [] }; try { cmb = comboOf(b, { ...q, pack: 1, lifePack: Math.max(1, Math.min(8, Number(p.pack) || 4)) }, r); } catch { /* none */ }
  // field monsters come in packs: the damage really done counts every monster a zone / cleave / pierce hits
  // (real logs of AoE builds did 2.5-3x the one-target number). Bosses stay one target.
  let packDps = null; const pack = Math.max(1, Math.min(8, Number(p.pack) || 4)); // may be fractional (learned from real logs)
  let packCurve = null;
  if (!isBossTarget(b)) {
    const tot = rot.share.reduce((t, x) => t + x.dmg, 0);
    const at = (n) => Math.round(rot.dps * cmb.mult * rot.share.reduce((t, x) => t + x.dmg * (x.key === 'basic' ? 1 : targetsOf(x.key, b.skills[x.key] || 1, b.evo[x.key], n)), 0) / tot);
    if (tot > 0) { packCurve = [1, 2, 3, 4, 5, 6, 7, 8].map(at); const lo = Math.floor(pack); const hi = Math.min(8, lo + 1); packDps = Math.round(packCurve[lo - 1] + (packCurve[hi - 1] - packCurve[lo - 1]) * (pack - lo)); }
  }
  return {
    useless,
    withCombos: Math.round(rot.dps * cmb.mult), packDps, pack: packDps ? pack : null, packCurve, combos: cmb.parts, sheet: sheetOf(r),
    gear: Object.entries(b.gear || {}).map(([slot, it]) => ({ slot, id: it.id, name: (G.mobs && false) || it.id, affixes: it.affixes || [], refine: it.refine || 0 })),
    cards: (b.cards || []).map((c, i) => ({ id: c, star: (b.cardStars || [])[i] || 1 })),
    debug: { sources: r.sources, basic: { avg: bs.avg, vsTarget: bs.vsTarget, cdMs: bs.cdMs, perSec: bs.perSec, power: bs.power, armor: bs.armor, hitChance: bs.hitChance, critChance: bs.critChance, usesMatk: bs.usesMatk }, sheet: { atk: sh.atk, matk: sh.matk, aspd: sh.aspd, crit: sh.crit, critDmg: sh.critDmg, level: sh.level }, factors: (r.factors || []).map((f) => f.label + ' x' + Math.round(f.x * 1000) / 1000), eff: r.eff, gear: Object.keys(b.gear || {}) },
    target: { id: target, level: q.targetLevel }, dps: Math.round(rot.dps),
    perSkill: rot.share.map((x) => ({ sid: x.key, name: name(x.key), dps: Math.round(x.dmg / (rot.seconds || 60)) })),
    // per skill: the game's own numbers for one use (to set against real hits from the combat log)
    perHit: ((r && r.skills) || []).map((v) => ({ sid: v.sid, hit: typeof v.hit === 'number' ? Math.round(v.hit * adj) : v.hit, hits: v.hits, perCast: v.perCast, damages: v.damages, cdMs: Math.round(v.cdMs || 0), dmgMult: v.dmgMult, lvMult: v.lvMult, lineMult: v.lineMult })),
    hotbar: b.hotbar.map(name), hotbarIds: b.hotbar.slice(), reorder, notes: (r.notes || []).slice(0, 5), names: Object.fromEntries(Object.keys(G.skills).map((k) => [k, G.skills[k].name || k])),
  };
};

// ---------- every card combo in the game, read from the game's album rules ----------
L.combos = async () => {
  await load();
  if (!G.cardDefs || !G.mobs) throw new Error('หาข้อมูลการ์ดของเกมไม่เจอ');
  const b = baseBuild({ job: 'mage', level: 100, jobLevel: 50, stats: {}, target: 'training_dummy', targetLevel: 100 });
  const groups = new Map();
  for (const id of Object.keys(G.cardDefs)) {
    if (!G.mobs[id]) continue;
    b.cards = [id]; b.cardStars = [5];
    let r; try { r = calc(b); } catch { continue; }
    for (const x of ((r.album && r.album.res) || [])) {
      if (!x.count) continue;
      const k = x.kind + ':' + x.key;
      let g = groups.get(k);
      if (!g) groups.set(k, g = { kind: x.kind, key: x.key, name: x.name, members: [] });
      g.members.push(id);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const tiers = [];
    for (const n of g.kind === 'region' ? [3, 5] : g.kind === 'kin' ? [2] : [2, 3]) {
      if (g.members.length < n) continue;
      b.cards = g.members.slice(0, n); b.cardStars = b.cards.map(() => 5);
      let r; try { r = calc(b); } catch { continue; }
      const x = ((r.album && r.album.res) || []).find((y) => y.kind === g.kind && y.key === g.key);
      if (x && x.on && !tiers.some((t) => t.n === x.count && t.fx.join() === (x.fx || []).map(comboFx).join())) tiers.push({ n, fx: (x.fx || []).map(comboFx) });
      if (x && x.on && g.kind !== 'region') break;
    }
    out.push({ kind: g.kind, name: g.name, count: g.members.length, tiers, members: g.members });
  }
  const order = { region: 0, kin: 1, color: 2 };
  out.sort((a, c) => order[a.kind] - order[c.kind] || a.name.localeCompare(c.name));
  return out;
};

// ---------- competition mode: skills and cards tuned together ----------
// skills -> best cards -> skills again with those cards -> cards again, for the strongest paths
const toAlbum = (cards, stars) => Object.fromEntries(cards.map((m, i) => ['s' + (i + 1), 'spirit_card' + ((stars[i] || 1) > 1 ? '+' + ((stars[i] || 1) - 1) : '') + '|' + m]));
L.full = async (p) => {
  useSkillAdj(p);
  await load();
  const t0 = performance.now();
  const goal = p.goal || (p.mode === 'boss' ? 'boss' : 'farm');
  const first = await L.run({ ...p, current: null });
  const out = [];
  for (const res of first.results.slice(0, p.paths && p.paths.length === 1 ? 1 : 2)) {
    const path = res.build.c2 || '';
    let build = res.build; let cards = null; let lo = p.loadout ? { ...p.loadout } : {};
    for (let round = 0; round < 2; round++) {
      cards = await L.cards({ ...p, loadout: lo, build, goal });
      lo = { ...lo, album: toAlbum(cards.cards.map((c) => c.id), cards.cards.map((c) => c.star)) };
      const again = await L.run({ ...p, loadout: lo, paths: [path], current: null });
      build = again.results[0].build;
    }
    cards = await L.cards({ ...p, loadout: lo, build, goal });
    lo = { ...lo, album: toAlbum(cards.cards.map((c) => c.id), cards.cards.map((c) => c.star)) };
    const fin = await L.run({ ...p, loadout: lo, paths: [path], current: p.current });
    out.push({ result: fin.results[0], cards, current: fin.current, target: fin.target });
  }
  out.sort((a, b) => b.result.score - a.result.score);
  return { mode: p.mode, goal, out, ms: Math.round(performance.now() - t0) };
};

// ---------- which map earns the most for a build ----------
// per map: for each monster camp, time to kill (the game's calculator vs that monster, spread over
// the pack for area skills) + walking, silver per kill x card/gear Gold%, capped by respawns
L.maps = async (p) => {
  useSkillAdj(p);
  await load();
  if (!G.maps) throw new Error('หาข้อมูลแมพของเกมไม่เจอ');
  evals = 0; const t0 = performance.now();
  const q = { ...p, mode: 'farm', pack: Math.max(1, p.pack || 3) };
  curP = q;
  const b = { ...baseBuild({ ...q, target: 'sprout', targetLevel: p.level }), ...JSON.parse(JSON.stringify(p.build || {})) };
  if (p.cards && p.cards.length) { b.cards = p.cards; b.cardStars = p.cards.map(() => p.stars || 5); }
  const mobInfo = (type) => { try { return (G.mob ? G.mob(type) : null) || G.mobs[type] || {}; } catch { return G.mobs[type] || {}; } };
  const walkS = p.walkS || 1.5;
  const rows = [];
  let gold = 0;
  for (const map of G.maps) {
    if (!map.mobs || !map.mobs.length || map.danger === 'safe' || /^ll_|training/.test(map.id)) continue;
    const camps = {};
    for (const m of map.mobs) if (m && m.type) camps[m.type] = (camps[m.type] || 0) + (m.count || 1);
    let silver = 0; let time = 0; let killsCap = 0; let worst = Infinity; let n = 0; const mobs = [];
    for (const [type, count] of Object.entries(camps)) {
      const mi = mobInfo(type);
      if (!mi || mi.role === 'boss' || mi.worldEvent) continue;
      b.calc = { ...b.calc, target: type, targetLevel: mi.level || p.level };
      let r; try { r = calc(b); evals++; } catch { continue; }
      const rot = r.rotation || { dps: 0, share: [] };
      let eff = 0; for (const s of rot.share) eff += s.dmg * (s.key === 'basic' ? 1 : targetsOf(s.key, b.skills[s.key] || 1, b.evo[s.key], Math.min(q.pack, count))); eff /= rot.seconds || 60;
      if (!(eff > 0)) continue;
      const hp = (r.target && r.target.hp) || mi.hp || 1;
      const ttk = hp / eff;
      const sv = ((mi.silverMin || 0) + (mi.silverMax || 0)) / 2;
      silver += count * sv; time += count * (ttk + walkS); n += count;
      killsCap += count * 3600000 / Math.max(3000, mi.respawnMs || 15000);
      worst = Math.min(worst, (r.defense && r.defense.hitsToDie) || Infinity);
      gold = (r.album && r.album.gold) || 0;
      mobs.push({ type, count, level: mi.level, ttk: Math.round(ttk * 10) / 10, silver: Math.round(sv) });
    }
    if (!n || !time) continue;
    const killsHr = Math.min(3600 * n / time, killsCap);
    const perKill = silver / n * (1 + gold / 100);
    rows.push({ id: map.id, name: map.name || map.id, band: map.levelBand, danger: map.danger, killsHr: Math.round(killsHr), perKill: Math.round(perKill), silverHr: Math.round(killsHr * perKill), hitsToDie: worst === Infinity ? null : Math.round(worst * 10) / 10, mobs });
    if (rows.length % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  rows.sort((a, b) => b.silverHr - a.silverHr);
  return { rows: rows.slice(0, p.top || 15), total: rows.length, gold, evals, ms: Math.round(performance.now() - t0) };
};

L.info = async () => {
  await load();
  const jobs = Object.keys(G.c2opts || {}).filter((j) => G.jobs[j]);
  const bosses = G.mobs ? Object.entries(G.mobs).filter(([, m]) => m && m.role === 'boss').map(([id, m]) => ({ id, name: m.name || id, level: m.level })).sort((a, b) => a.level - b.level) : [];
  return {
    file: G.file, have: Object.keys(G).filter((k) => G[k]),
    novice: G.jobs.novice ? G.jobs.novice.skills.map((sid) => ({ sid, max: (G.skills[sid] || {}).maxLevel, kind: (G.skills[sid] || {}).kind, line: (G.skills[sid] || {}).line, passive: JSON.stringify((G.skills[sid] || {}).passive || (G.skills[sid] || {}).passiveBonus || '') })) : null,
    jobs: jobs.map((j) => ({ id: j, name: G.jobs[j].name || j, c2: (G.c2opts[j] || []).map((c) => ({ id: c, name: (G.c2defs[c] || {}).name || c, role: (G.c2defs[c] || {}).role || '' })) })),
    bosses,
  };
};

// p: { job, level, jobLevel, stats, c2Job, c2Points, mode: 'boss'|'farm', pack, target?, paths?: [''|'path'...], current?: build }
L.run = async (p) => {
  useSkillAdj(p);
  await load();
  if (!G.jobs[p.job]) throw new Error('ไม่รู้จักอาชีพ ' + p.job);
  evals = 0;
  const t0 = performance.now();
  const target = pickTarget(p.mode, p.level, p.target);
  const tmob = G.mobs && G.mobs[target];
  const base = { ...p, target, targetLevel: targetLevelFor(target, p.mode, p.level), pack: Math.max(1, p.pack || 4), c2Job: Math.min(MAX_JOB, p.c2Job || 50), c2Points: Math.max(0, Math.min(C2_POINTS, p.c2Points == null ? C2_POINTS : p.c2Points)), jobLevel: Math.min(MAX_JOB, p.jobLevel || MAX_JOB) };
  const paths = p.paths && p.paths.length ? p.paths : ['', ...(G.c2opts[p.job] || [])];
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  // fight length used to score builds (boss mode): set by the player, recorded from real fights,
  // the world boss event length, or this boss's HP / (damage per second x players hitting it)
  let fight = null;
  if (p.mode === 'boss' && p.fightMode && p.fightMode !== 'sustain' && p.fightMode !== 'burst') {
    if (/^\d+$/.test(String(p.fightMode))) fight = { sec: +p.fightMode, why: 'ตั้งเอง' };
    else if (p.fightMode === 'real' && p.realSec) fight = { sec: p.realSec, why: 'จากการตีจริง ' + (p.realN || 0) + ' ครั้ง (ค่ากลาง)' };
    else if (WORLD[target]) fight = { sec: p.worldSec || 300, why: p.worldSec ? 'ความยาวกิจกรรม World Boss ที่เห็นจริง' : 'ประมาณ 5 นาที (ยังไม่เคยเห็นกิจกรรมนี้)' };
    else {
      // first a long-fight build to know the damage, then the time this boss takes to fall
      const q0 = { ...base, c2: paths[paths.length > 1 ? 1 : 0] };
      const b0 = await optimize(q0, yieldNow);
      const r0 = calc(b0);
      const dps0 = sustainedDps(b0, r0) * Math.max(1, p.party || 1);
      const hp = (r0.target && r0.target.hp) || 0;
      const sec = hp && dps0 ? Math.max(10, Math.min(900, Math.round(hp / dps0))) : 60;
      fight = { sec, why: 'HP บอส ' + Math.round(hp).toLocaleString() + ' ÷ DPS ' + Math.round(dps0).toLocaleString() + ((p.party || 1) > 1 ? ' (' + p.party + ' คน)' : ''), hp };
    }
    base.fightSec = fight.sec;
  }
  const results = [];
  for (const c2 of paths) {
    const q = { ...base, c2 };
    let b = await optimize(q, yieldNow);
    // boss fights: the search is greedy and can stop at a weaker build, so also search by the other
    // time scales (long fight, first 60 s), re-order each one's hotbar for this fight, keep the best
    if (q.mode === 'boss') {
      const others = [];
      if (q.fightSec || q.window === 'burst') others.push({ ...q, fightSec: 0, window: 'sustain' });
      if (q.fightSec || q.window !== 'burst') others.push({ ...q, fightSec: 0, window: 'burst' });
      let best = score(b, q).v;
      for (const o of others) {
        const alt = await optimize(o, yieldNow);
        curP = q; bestHotbar(alt, q);
        const v = score(alt, q).v;
        if (v > best) { best = v; b = alt; }
      }
    }
    results.push(describe(b, q));
  }
  let current = null;
  if (p.current && p.current.skills && Object.keys(p.current.skills).length) {
    const q = { ...base, c2: p.current.c2 || '' };
    curP = q;
    const b = { ...baseBuild(q), skills: { ...p.current.skills }, evo: { ...(p.current.evo || {}) }, traits: { ...(p.current.traits || {}) }, c2tr: { ...(p.current.c2tr || {}) } };
    if (p.current.hotbar && p.current.hotbar.length) b.hotbar = p.current.hotbar.slice(0, hotbarSize(b)); else setHotbar(b);
    current = describe(b, q);
    // a gentle version: the character's own build, a few single points moved (what the real numbers back up)
    const t = tuneFrom(b, q);
    if (t.moves.length) { const name = (sid) => (G.skills[sid] || {}).name || sid; current.tuned = { ...describe(b, q), moves: t.moves.map((m) => ({ ...m, fromName: name(m.from), toName: name(m.to) })), gainPct: t.gainPct, realBacked: Object.keys(SKILL_ADJ).length > 0 }; }
    else current.tuned = { moves: [], gainPct: 0, realBacked: Object.keys(SKILL_ADJ).length > 0, why: t.why };
  }
  results.sort((a, b) => b.score - a.score);
  return { fight, mode: p.mode, loadout: !!(p.loadout && (Object.keys(p.loadout.equip || {}).length || Object.keys(p.loadout.album || {}).length)), target: { id: target, name: (tmob && tmob.name) || target, level: base.targetLevel }, results, current, evals, ms: Math.round(performance.now() - t0), budget1: c1Budget(p.job, base.jobLevel) };
};
})();`;

module.exports = { LAB_JS };
