// Turns messages the game page receives into dashboard stats.
//
// The game's real message format is not mapped yet (the game was in maintenance
// when this was written). Until then this does a best-effort scan of JSON
// messages for common field names. To map the real format:
//   1. Settings › "Debug capture" on, play a few minutes
//   2. Open the capture file (%APPDATA%/BinderDash/captures/acc-<n>.jsonl)
//   3. Replace FIELD_ALIASES / parseMessage below with the real field names
//
// This module only READS data. Nothing here sends anything to the game.
//
// parseMessage() returns a list of normalized events for session-data.js:
//   { type:'self', name, job, level, jobLevel, hp, maxHp, sp, maxSp, exp, maxExp,
//                  silver, gold, str, agi, vit, int, dex, luk, map }   (any subset)
//   { type:'buffs', list:[{ name, until, stacks }] }
//   { type:'hit', target, dmg, crit, skill }   { type:'miss', target }
//   { type:'hurt', from, dmg }                  { type:'kill', target, exp, job }
//   { type:'loot', item, qty }                  { type:'bag', items:[{ name, qty }] }
//   { type:'chat', channel, from, guild, text } { type:'info', text }
//   { type:'world', w, h, self:{x,y}, monsters:[{x,y,name}], players:[...], drops:[...] }
// Only 'self' is produced until the real format is mapped.

const FIELD_ALIASES = {
  name: ['name', 'charName', 'characterName', 'nickname'],
  silver: ['silver'],
  level: ['level', 'lv', 'lvl'],
  hp: ['hp', 'curHp', 'currentHp'],
  maxHp: ['maxHp', 'hpMax', 'mhp'],
  sp: ['sp', 'mp', 'curMp', 'curSp'],
  maxSp: ['maxSp', 'maxMp', 'mpMax', 'spMax'],
  exp: ['exp', 'xp', 'curExp'],
  maxExp: ['maxExp', 'expMax', 'nextExp', 'expToNext'],
  map: ['map', 'mapName', 'zone', 'mapId'],
  gold: ['gold', 'coin', 'coins'],
};

const ALIAS_TO_FIELD = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const a of aliases) ALIAS_TO_FIELD.set(a.toLowerCase(), field);
}

function decode(data) {
  if (typeof data !== 'string') return null;
  let s = data.trim();
  // socket.io style: "42[\"event\",{...}]"
  const m = /^\d+(\[.*|\{.*)$/s.exec(s);
  if (m) s = m[1];
  if (s[0] !== '{' && s[0] !== '[') return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Look for an object that holds at least two known stat fields, up to depth 4.
function scan(node, depth, out) {
  if (!node || typeof node !== 'object' || depth > 4) return;
  if (!Array.isArray(node)) {
    const found = {};
    let statHits = 0;
    for (const [k, v] of Object.entries(node)) {
      const field = ALIAS_TO_FIELD.get(k.toLowerCase());
      if (!field) continue;
      if (typeof v === 'number' && Number.isFinite(v)) {
        found[field] = v;
        if (field !== 'map' && field !== 'name') statHits++;
      } else if (typeof v === 'string' && (field === 'name' || field === 'map') && v.length < 60) {
        found[field] = v;
      }
    }
    if (statHits >= 2) Object.assign(out, found);
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') scan(v, depth + 1, out);
  }
}

function parseMessage(data) {
  const obj = decode(data);
  if (!obj) return [];
  const out = {};
  scan(obj, 0, out);
  return Object.keys(out).length ? [{ type: 'self', ...out }] : [];
}

// Keeps a short history of EXP to estimate EXP/hour and time to level.
class ExpTracker {
  constructor() { this.samples = []; }
  add(exp, level, now = Date.now()) {
    const last = this.samples[this.samples.length - 1];
    if (last && level !== undefined && last.level !== undefined && level !== last.level) {
      this.samples = []; // level up: start over
    }
    this.samples.push({ t: now, exp, level });
    const cutoff = now - 30 * 60 * 1000;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }
  perHour() {
    if (this.samples.length < 2) return null;
    const a = this.samples[0], b = this.samples[this.samples.length - 1];
    const dt = b.t - a.t;
    if (dt < 60 * 1000 || b.exp < a.exp) return null;
    return ((b.exp - a.exp) / dt) * 3600 * 1000;
  }
}

module.exports = { parseMessage, ExpTracker, decode };
