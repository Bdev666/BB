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

// ---- rules (the game's own numbers) ----
const MAX_JOB = 50;
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
function baseBuild(p) {
  return {
    job: p.job, level: p.level, jobLevel: p.jobLevel, c2: p.c2 || '', c2Job: p.c2Job || 50, c2tr: {},
    stats: { ...p.stats }, skills: {}, evo: {}, traits: {}, hotbar: [], gear: {}, cards: [], cardStars: [],
    weapon: '', offhand: '', affixes: [],
    calc: { guild: 0, soulforge: 0, pet: '', night: false, codex: 0, target: p.target, targetLevel: p.targetLevel, debuffed: false, lowHp: false },
    ...loadoutOf(p.loadout),
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
    const id = name.split(/[!+^*~@]/)[0];
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
function score(b, p) {
  evals++;
  let r; try { r = G.calc(b); } catch (e) { return { v: 0, err: String(e && e.message || e) }; }
  const rot = r.rotation || { dps: 0, share: [] };
  let v = rot.dps;
  if (p.mode === 'farm') {
    // damage spread over the pack: each skill's share times how many monsters it hits
    v = 0;
    for (const s of rot.share) v += s.dmg * (s.key === 'basic' ? 1 : targetsOf(s.key, b.skills[s.key] || 1, b.evo[s.key], p.pack));
    v = v / (rot.seconds || 60);
  }
  return { v, r };
}
// hotbar = damaging skills by damage per second of cast time, best 6 (the game rotates in hotbar order)
let curP = null; // the run's settings (farm mode orders the hotbar by damage x monsters hit)
function setHotbar(b) {
  const r = G.calc({ ...b, hotbar: Object.keys(b.skills).filter((s) => b.skills[s] > 0 && !isPassive(s)) });
  const w = (s) => s.dpsAlone * (curP && curP.mode === 'farm' ? targetsOf(s.sid, s.lv, b.evo[s.sid], curP.pack) : 1);
  const dmg = (r.skills || []).filter((s) => s.damages && s.lv > 0).sort((x, y) => w(y) - w(x));
  b.hotbar = dmg.slice(0, 6).map((s) => s.sid);
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
      if (!best) break;
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
  return b;
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
    score: Math.round(s.v), dps: Math.round((r.rotation || {}).dps || 0), ttk: r.ttk, hitsToDie: r.defense && r.defense.hitsToDie,
    c2: b.c2 ? (G.c2defs[b.c2] || {}).name || b.c2 : '',
    skills: Object.entries(b.skills).filter(([, l]) => l > 0).map(([sid, lv]) => ({ sid, name: name(sid), lv, max: maxLv(sid), line: lineName(lineOf(sid)), c2: !!(G.skills[sid] && G.skills[sid].c2), evo: b.evo[sid] ? b.evo[sid].toUpperCase() + ' · ' + evoName(sid, b.evo[sid]) : '', passive: isPassive(sid) })),
    traits: [...Object.entries(b.traits), ...Object.entries(b.c2tr)].map(([l, e]) => lineName(l) + ': ' + e.toUpperCase() + ' · ' + traitName(l, e)),
    hotbar: b.hotbar.map(name),
    share: ((r.rotation || {}).share || []).slice(0, 8).map((x) => ({ name: x.key === 'basic' ? 'โจมตีปกติ' : name(x.key), pct: Math.round(x.dmg / Math.max(1, (r.rotation.share || []).reduce((t, y) => t + y.dmg, 0)) * 100) })),
    notes: [...problems.map((x) => '⚠ ' + x), ...notes].slice(0, 10),
    problems,
    build: { skills: b.skills, evo: b.evo, traits: b.traits, c2tr: b.c2tr, hotbar: b.hotbar, c2: b.c2 },
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
  let r; try { r = G.calc(b); } catch { return { v: 0 }; }
  const rot = r.rotation || { dps: 0, share: [] };
  let dps = rot.dps;
  if (p.goal !== 'boss') { dps = 0; for (const s of rot.share) dps += s.dmg * (s.key === 'basic' ? 1 : targetsOf(s.key, b.skills[s.key] || 1, b.evo[s.key], p.pack)); dps /= rot.seconds || 60; }
  const al = r.album || {};
  const gold = al.gold || 0; const drop = al.drop || 0;
  const v = p.goal === 'gold' ? dps * (1 + gold / 100) * (1 + drop / 200) : dps;
  return { v, dps, gold, drop, r };
}
L.cards = async (p) => {
  await load();
  if (!G.cardDefs || !G.mobs) throw new Error('หาข้อมูลการ์ดของเกมไม่เจอ');
  evals = 0; const t0 = performance.now();
  const goal = p.goal || 'boss';
  const target = pickTarget(goal === 'boss' ? 'boss' : 'farm', p.level, goal === 'boss' ? p.target : '');
  const tmob = G.mobs[target];
  const q = { ...p, goal, pack: Math.max(1, p.pack || 4), mode: goal === 'boss' ? 'boss' : 'farm' };
  curP = q;
  const b = { ...baseBuild({ ...q, target, targetLevel: targetLevelFor(target, goal === 'boss' ? 'boss' : 'farm', p.level) }), ...JSON.parse(JSON.stringify(p.build || {})) };
  const q0 = (b.cards && b.cards.length) ? cardScore(b, q) : null; // the character's own cards now
  const nowCards = q0 ? b.cards.slice() : [];
  b.cards = []; b.cardStars = [];
  const slots = CARD_SLOTS.filter((l) => p.level >= l).length;
  const cap = loadCap(p.level);
  const star = Math.max(1, Math.min(5, p.stars || 5));
  // only the cards this character owns (how many of each, best star), or every card in the game
  const owned = Array.isArray(p.owned) && p.owned.length ? Object.fromEntries(p.owned.map((o) => [o.mob, o])) : null;
  const pool = Object.keys(G.cardDefs).filter((id) => G.mobs[id] && cardLoad(id) <= cap && (!owned || owned[id]));
  const starOf = (id) => (owned && owned[id] ? Math.max(1, Math.min(5, owned[id].stars || 1)) : star);
  const haveLeft = (id) => !owned || b.cards.filter((c) => c === id).length < (owned[id].n || 1);
  const used = () => b.cards.reduce((t, c) => t + cardLoad(c), 0);
  const sc = () => cardScore(b, q).v;
  const base = cardScore(b, q);
  let cur = base.v;
  // greedy: add the card with the best gain per Spirit Load
  while (b.cards.length < slots) {
    let best = null;
    for (const id of pool) {
      if (used() + cardLoad(id) > cap || !haveLeft(id)) continue;
      b.cards.push(id); b.cardStars.push(starOf(id));
      const v = sc(); const g = (v - cur) / cardLoad(id);
      if (!best || g > best.g) best = { id, v, g };
      b.cards.pop(); b.cardStars.pop();
    }
    if (!best || best.v <= cur) break;
    b.cards.push(best.id); b.cardStars.push(starOf(best.id)); cur = best.v;
    await new Promise((r) => setTimeout(r, 0));
  }
  // swaps: replace one card by another while it helps (catches region sets and load trade-offs)
  for (let round = 0; round < 3; round++) {
    let moved = false;
    for (let i = 0; i < b.cards.length; i++) {
      const old = b.cards[i];
      for (const id of pool) {
        if (id === old || used() - cardLoad(old) + cardLoad(id) > cap || !haveLeft(id)) continue;
        const oldStar = b.cardStars[i];
        b.cards[i] = id; b.cardStars[i] = starOf(id); const v = sc();
        if (v > cur * 1.001) { cur = v; moved = true; break; }
        b.cards[i] = old; b.cardStars[i] = oldStar;
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    if (!moved) break;
  }
  const fin = cardScore(b, q);
  const al = (fin.r && fin.r.album) || {};
  const sets = (al.res || []).filter((x) => x.kind === 'region' && x.count >= 3).map((x) => x.name + ' ' + x.count + ' ใบ');
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
    owned: !!owned, poolSize: pool.length,
    now: q0 ? { dps: Math.round(q0.dps), gold: Math.round(q0.gold * 10) / 10, drop: Math.round(q0.drop * 10) / 10, cards: nowCards } : null,
    cards: b.cards.map((id, i) => ({ id, star: b.cardStars[i], why: why[i], proc: (G.cardDefs[id].fx || []).some((f) => f.k !== 'stat' && !/Pct$|^(crit|critDmg|cdr|aspd|armorPen|boss|elite|night|gold|drop|spellAmp|castSpd|hit|flee|def|mdef|matk|atk|maxHp|maxMp|dmgTaken|slayer|ward|wardBoss|wardNight|debuffed|opener|desperate|haste|barrier|spirit|gather|block|lifesteal|magicRes|thorns)$/.test(f.k)), role: G.mobs[id].role, level: G.mobs[id].level, load: cardLoad(id), fx: (G.cardDefs[id].fx || []).map((f) => fxText(f, b.cardStars[i])) })),
    before: { dps: Math.round(base.dps), gold: base.gold, drop: base.drop },
    after: { dps: Math.round(fin.dps), gold: Math.round(fin.gold * 10) / 10, drop: Math.round(fin.drop * 10) / 10 },
    sets, evals, ms: Math.round(performance.now() - t0),
  };
};

// ---------- which map earns the most for a build ----------
// per map: for each monster camp, time to kill (the game's calculator vs that monster, spread over
// the pack for area skills) + walking, silver per kill x card/gear Gold%, capped by respawns
L.maps = async (p) => {
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
      let r; try { r = G.calc(b); evals++; } catch { continue; }
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
    jobs: jobs.map((j) => ({ id: j, name: G.jobs[j].name || j, c2: (G.c2opts[j] || []).map((c) => ({ id: c, name: (G.c2defs[c] || {}).name || c, role: (G.c2defs[c] || {}).role || '' })) })),
    bosses,
  };
};

// p: { job, level, jobLevel, stats, c2Job, c2Points, mode: 'boss'|'farm', pack, target?, paths?: [''|'path'...], current?: build }
L.run = async (p) => {
  await load();
  if (!G.jobs[p.job]) throw new Error('ไม่รู้จักอาชีพ ' + p.job);
  evals = 0;
  const t0 = performance.now();
  const target = pickTarget(p.mode, p.level, p.target);
  const tmob = G.mobs && G.mobs[target];
  const base = { ...p, target, targetLevel: targetLevelFor(target, p.mode, p.level), pack: Math.max(1, p.pack || 4), c2Job: Math.min(MAX_JOB, p.c2Job || 50), jobLevel: Math.min(MAX_JOB, p.jobLevel || MAX_JOB) };
  const paths = p.paths && p.paths.length ? p.paths : ['', ...(G.c2opts[p.job] || [])];
  const yieldNow = () => new Promise((r) => setTimeout(r, 0));
  const results = [];
  for (const c2 of paths) {
    const q = { ...base, c2 };
    const b = await optimize(q, yieldNow);
    results.push(describe(b, q));
  }
  let current = null;
  if (p.current && p.current.skills && Object.keys(p.current.skills).length) {
    const q = { ...base, c2: p.current.c2 || '' };
    curP = q;
    const b = { ...baseBuild(q), skills: { ...p.current.skills }, evo: { ...(p.current.evo || {}) }, traits: { ...(p.current.traits || {}) }, c2tr: { ...(p.current.c2tr || {}) } };
    if (p.current.hotbar && p.current.hotbar.length) b.hotbar = p.current.hotbar.slice(0, 6); else setHotbar(b);
    current = describe(b, q);
  }
  results.sort((a, b) => b.score - a.score);
  return { mode: p.mode, loadout: !!(p.loadout && (Object.keys(p.loadout.equip || {}).length || Object.keys(p.loadout.album || {}).length)), target: { id: target, name: (tmob && tmob.name) || target, level: base.targetLevel }, results, current, evals, ms: Math.round(performance.now() - t0), budget1: c1Budget(p.job, base.jobLevel) };
};
})();`;

module.exports = { LAB_JS };
