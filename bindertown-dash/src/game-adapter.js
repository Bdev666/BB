// Binder Town adapter: turns what the game page receives into dashboard events.
// Read-only: it decodes frames the game already received and reads the page's own
// state (window.__game); it never sends anything to the game server.
//
// Mapped from the live client (build 20261120-084128):
//  * The game is a Colyseus 0.16 client. Server events arrive as ROOM_DATA frames
//    (byte 13), message type "server", payload = msgpack. A payload is one event, a
//    list of events, or a "packed" event: an array whose first item is a code into
//    PACKED below (hits, projectiles, casts ... sent as arrays to save bytes).
//  * Character, mobs and players live in the room state, which the page exposes at
//    window.__game.state() / .me() / .mapId(); SNAPSHOT_JS reads it once a second.
//
// Normalized events for session-data.js:
//   { type:'self', name, job, level, jobLevel, hp, maxHp, sp, maxSp, xp, expPct, jobPct,
//                  silver, gold, str, agi, vit, int, dex, luk, map }   (any subset)
//   { type:'hit', target, dmg, crit, skill }   { type:'miss', target }
//   { type:'hurt', from, dmg }                  { type:'kill', target, exp, job, silver }
//   { type:'loot', item, qty, value }  value = NPC sell price x qty (drops only)
//   { type:'card', mob, level }                  { type:'bag', items:[{ name, qty }] }
//   { type:'chat', channel, from, guild, text, mine, backlog } { type:'info', text }
//   { type:'death', by } { type:'revive' }     { type:'party', from, text }
//   { type:'net', ping, online }              { type:'sold', item, qty, silver }
//   { type:'market', id, item, price, basis }  { type:'premium', until } { type:'rareDrop', item }               { type:'minimap', url }
//   { type:'buffs', list:[{ name, until, stacks }] }
//   { type:'world', w, h, self:{x,y}, monsters:[{x,y,name}], players:[{x,y}], drops:[] }
const { unpack, Packr } = require('msgpackr');
const DROP_NAMES = require('./drop-names');
const NAMES = require('./game-names');
const { MOBS: MOB_TABLE, CATEGORY } = require('./mob-table');

// NPC sell price of a monster drop, same formula as the game client:
// round((3 + level * 0.5) * roleMult * (level >= 65 ? 0.7 : 1)), at least 2
const ROLE_MULT = { trash: 1, pack: 0.9, ambush: 1.2, tank: 1.3, elite: 2.5, 'mini-boss': 6, boss: 12 };
// The shop then pays price / sqrt(economy index) (the server's 'econ' index), at least 1.
function dropPrice(mobType, liveLevel, econIndex = 1) {
  const def = MOB_TABLE[mobType];
  const role = def ? def[0] : 'trash';
  const level = (def && def[1]) || liveLevel || 1;
  const base = Math.max(2, Math.round((3 + level * 0.5) * (ROLE_MULT[role] ?? 1) * (level >= 65 ? 0.7 : 1)));
  return Math.max(1, Math.round(base / Math.sqrt(econIndex > 0 ? econIndex : 1)));
}

const ROOM_DATA = 13;

// Game builds this adapter was checked against (the build comes with every pong).
// A new build that still reads cleanly is fine; one that doesn't is reported.
const KNOWN_BUILDS = ['20261120-084128', '20261120-112144'];
// Server message types the game client handles (build 20261120). A type outside this
// list means the game grew something new: it is logged (name + field names only).
const KNOWN_TYPES = new Set(["friendSearch", "socialState", "socialParty", "raid", "raidUlt", "notice", "humanCheck", "humanResult", "guardInfo", "partyBoard", "guildList", "ranked", "rankedMatch", "rankedBoard", "guildWar", "guildWarFoes", "tradeInvite", "tradeState", "tradeEnd", "joinRequest", "socialNotice", "ranking", "mail", "mailClaimed", "zoneMove", "soulGained", "lantern", "partyRally", "partyGotoCd", "potionCd", "ledger", "sealResult", "forgeResult", "pactResult", "inscribeResult", "infuseResult", "binderStarResult", "rerollResult", "bossMeter", "census", "pong", "cdSync", "gemex", "mapFull", "mapQueue", "channels", "marketGuide", "topupHistory", "intlOrder", "payOrder", "slipResult", "slipClaimToken", "history", "gemexResult", "loginReward", "hw99", "candy", "candyGot", "pets", "petPulled", "hunt", "accountState", "linkRequired", "appearanceResult", "nameRequired", "nameResult", "socialInvite", "debugState", "profile", "myLikes", "ach", "achUnlocked", "promoState", "promoResult", "likeResult", "killGain", "worldBossTop", "worldBossLast", "motherLode", "worldBoss", "hotWeek", "randomEvent", "econ", "gatherResult", "life", "craftTryResult", "lifeLevel", "craftResult", "salvaged", "autoForged", "autoSold", "sold", "bought", "bond", "bindResult", "market", "marketBoard", "marketItem", "commissions", "commissionResult", "crafterNames", "marketResult", "bank", "bankResult", "cardClearPlan", "inv", "repairResult", "refineResult", "pvpKill", "guildFeed", "pvpState", "autoRespawned", "ll", "llBoard", "deathPenalty", "youDied", "cardFound", "spiritGain", "gatherFailed", "pass", "shopResult", "builds", "classes", "gfxNotice", "promo", "welcomeBack", "hit", "castStart", "castCancel", "cast", "mobBolt", "mobBoltEnd", "mobSkill", "bossMech", "classFx", "ccFx", "bossPhase", "mobAttack", "basicAttack", "levelUp", "jobLevelUp", "fieldBosses", "warps", "dialog", "jobChanged", "projectile", "projectileHit", "zone", "died", "respawned", "chat", "chatBacklog", "dashMove", "maintenance", "patchPlan", "drain", "announcement", "chatTyping", "warp", "soulforge"]);

// Battle Pass tasks (client tables): daily and weekly
const PASS_DAILY = [
  { id: 'login', label: 'เข้าเกมวันนี้', goal: 1 },
  { id: 'kills', label: 'กำจัดมอนสเตอร์ 40 ตัว', goal: 40 },
  { id: 'gathers', label: 'เก็บเกี่ยว 15 ครั้ง', goal: 15 },
  { id: 'crafts', label: 'ทำอาหารหรือปรุงยา 3 อย่าง', goal: 3 },
];
const PASS_WEEKLY = [
  { id: 'wlogin', label: 'เข้าเกม 5 วันในสัปดาห์นี้', goal: 5 },
  { id: 'wkills', label: 'กำจัดมอนสเตอร์ 1,500 ตัว', goal: 1500 },
  { id: 'wgathers', label: 'เก็บเกี่ยว 300 ครั้ง', goal: 300 },
  { id: 'wcrafts', label: 'ทำอาหารหรือปรุงยา 30 อย่าง', goal: 30 },
  { id: 'wdaily', label: 'รับรางวัลภารกิจรายวัน 15 ครั้ง', goal: 15 },
  { id: 'wbounty', label: 'รับรางวัลค่าหัว (Bounty) 6 ครั้ง', goal: 6 },
];
// Random world events (client table)
const RANDOM_EVENTS = {
  gathering_time: { name: 'Gathering Time', perks: ['Gathering + Fishing เร็วขึ้น 15%', 'EXP สาย Gathering +20%'] },
  elite_surge: { name: 'Elite Surge', perks: ['Elite เกิดใหม่เร็วขึ้น ×2'] },
  golden_hour: { name: 'Golden Hour', perks: ['Gold จากมอน +15%'] },
  spirit_tide: { name: 'Spirit Tide', perks: ['โอกาสได้วิญญาณมอน +30%'] },
  lucky_find: { name: 'Lucky Find', perks: ['โอกาสดรอปไอเทม +10%'] },
  hunters_breeze: { name: "Hunter's Breeze", perks: ['EXP + Job EXP จากมอน +10%'] },
};
const HOT_WEEK_LABEL = { xp: 'EXP', drop: 'ดรอป', spirit: 'วิญญาณ', gatherXp: 'EXP Gathering', gatherFast: 'Gathering ไว', gold: 'Gold' };

// Character fields the Dashboard needs from window.__game.me()
const REQUIRED_FIELDS = ['name', 'level', 'hp', 'maxHp', 'mp', 'maxMp', 'xp', 'silver', 'job'];

// Packed server events (from the client's own table; index + 1 = code)
const PACKED = [
  ['hit', 'targetId', 'amount', 'kind', 'actorId', 'skillId', 'sm', 'gz'],
  ['projectile', 'id', 'x@p', 'y@p', 'dx@u', 'dy@u', 'speed@c', 'skillId', 'owner', 'target', 'small'],
  ['projectileHit', 'id', 'x@p', 'y@p', 'skillId', 'owner'],
  ['cast', 'id', 'skillId', 'x@p', 'y@p', 'fx@u', 'fy@u'],
  ['castStart', 'id', 'skillId', 'durationMs', 'tx@p', 'ty@p'],
  ['mobAttack', 'id', 'mobType', 'x@p', 'y@p', 'fx@u', 'fy@u', 'durationMs', 'tx@p', 'ty@p'],
  ['zone', 'id', 'x@p', 'y@p', 'radius@c', 'skillId', 'ttlMs', 'owner', 'fx@p', 'fy@p', 'fuse', 'wave'],
];

function unpackEvent(arr) {
  const def = PACKED[arr[0] - 1];
  if (!def) return null;
  const out = { type: def[0] };
  def.slice(1).forEach((key, i) => {
    const v = arr[i + 1];
    if (v != null) out[key.split('@')[0]] = v; // positions keep their wire scale; we don't use them
  });
  return out;
}

// @colyseus/schema string: msgpack-style str header + utf8
function readSchemaString(buf, it) {
  const prefix = buf[it.offset++];
  let len;
  if (prefix < 0xc0) len = prefix & 0x1f;
  else if (prefix === 0xd9) len = buf[it.offset++];
  else if (prefix === 0xda) { len = buf.readUInt16LE(it.offset); it.offset += 2; }
  else if (prefix === 0xdb) { len = buf.readUInt32LE(it.offset); it.offset += 4; }
  else return null;
  const s = buf.toString('utf8', it.offset, it.offset + len);
  it.offset += len;
  return s;
}
function isSchemaString(b) { return (b >= 0xa0 && b <= 0xbf) || b === 0xd9 || b === 0xda || b === 0xdb; }

// Decode one WebSocket frame (Buffer). Returns { type, message } for ROOM_DATA frames, else null.
function decodeFrame(buf) {
  if (!buf || buf.length < 2 || buf[0] !== ROOM_DATA) return null;
  const it = { offset: 1 };
  if (!isSchemaString(buf[1])) return null; // numeric message types aren't used by the game
  const type = readSchemaString(buf, it);
  if (type == null) return null;
  let message;
  if (buf.length > it.offset) {
    try { message = unpack(buf.subarray(it.offset)); } catch { return { type, message: undefined, bad: true }; }
  }
  return { type, message };
}

// Build the frame the game's own client sends for room.send("input", obj).
// A fresh Packr per frame gives byte-identical output to the client (verified
// against 422 recorded frames).
function encodeInput(obj) {
  const type = Buffer.from('input', 'utf8');
  return Buffer.concat([Buffer.from([ROOM_DATA, 0xa0 | type.length]), type, new Packr().pack(obj)]);
}

// Market price the way the game's sell window estimates it: cheapest listing if
// any, else the median of real sales in the last 14 days. Gold per unit.
function marketPrice(guide, now = Date.now()) {
  const listed = (guide.listed || []).map(Number).filter((n) => n > 0);
  if (listed.length) return { price: Math.min(...listed), basis: 'listed', listed: listed.length };
  const sales = (guide.sales || []).filter((x) => x && x.unit > 0 && now - x.t <= 14 * 864e5).map((x) => x.unit).sort((a, b) => a - b);
  if (!sales.length) return null;
  const m = sales.length >> 1;
  return { price: sales.length % 2 ? sales[m] : (sales[m - 1] + sales[m]) / 2, basis: 'sales', sales: sales.length };
}

// The NPC shop's potions (from the client's vendor table, Silver, before the economy index)
const NAMES_POT = (id) => NAMES.items[id] || id;
const POTIONS = [
  // lv = the level the shop starts selling it (the client's potion table)
  { id: 'potion', name: NAMES_POT('potion'), kind: 'hp', price: 12, lv: 1 },
  { id: 'hi_potion', name: NAMES_POT('hi_potion'), kind: 'hp', price: 32, lv: 15 },
  { id: 'mega_potion', name: NAMES_POT('mega_potion'), kind: 'hp', price: 75, lv: 30 },
  { id: 'elixir', name: NAMES_POT('elixir'), kind: 'hp', price: 150, lv: 45 },
  { id: 'grand_elixir', name: NAMES_POT('grand_elixir'), kind: 'hp', price: 260, lv: 60 },
  { id: 'pearl_elixir', name: NAMES_POT('pearl_elixir'), kind: 'hp', price: 400, lv: 80 },
  { id: 'sovereign_elixir', name: NAMES_POT('sovereign_elixir'), kind: 'hp', price: 560, lv: 95 },
  { id: 'mana_potion', name: NAMES_POT('mana_potion'), kind: 'mp', price: 16, lv: 1 },
  { id: 'ether', name: NAMES_POT('ether'), kind: 'mp', price: 40, lv: 30 },
  { id: 'high_ether', name: NAMES_POT('high_ether'), kind: 'mp', price: 100, lv: 55 },
  { id: 'pearl_ether', name: NAMES_POT('pearl_ether'), kind: 'mp', price: 150, lv: 80 },
  { id: 'sovereign_ether', name: NAMES_POT('sovereign_ether'), kind: 'mp', price: 210, lv: 95 },
];

// Items that are everyday supplies, not loot worth a market check
const SUPPLIES = /^(potion|mana_potion|.*_potion|.*elixir|.*ether|arrow.*|.*_arrow|bullet.*|.*_bullets?|throwing_.*|fly_wing|butterfly_wing|herb_leaf|raw_fish|field_ration|grilled_fish|campfire_kit|repair_kit)$/;
// something the character uses up (potions, ammo …): only these get a "runs out in N minutes" clock
function isSupply(id) { return SUPPLIES.test(baseOf(id)); }

// "robe_t10+12|vit:6:9,dex:7:12#uuid" -> "robe_t10" (refine, inscription, quality and instance stripped)
function baseOf(id) { return String(id || '').replace(/^cash:/, '').split(/[|#+^*~@]/)[0]; }
// Item grade the way the game computes it (client: affix count; the 20 classic affixes count one step higher)
const CLASSIC_AFFIXES = new Set(['sharp', 'heavy', 'keen', 'precise', 'swift', 'fleet', 'runed', 'arcane', 'cruel', 'deadly', 'of_the_bear', 'of_the_ox', 'of_the_fox', 'of_fortune', 'of_the_sage', 'of_the_owl', 'of_the_wind', 'of_stone', 'of_the_monk', 'of_the_hawk']);
function rarityOf(id) {
  const m = /\|([^#]*)/.exec(String(id || ''));
  const names = m && m[1] ? m[1].split(',').map((a) => a.split(':')[0]).filter(Boolean) : [];
  if (!names.length) return 'normal';
  if (names.every((a) => CLASSIC_AFFIXES.has(a))) return ['normal', 'magic', 'rare', 'epic'][Math.min(names.length, 3)];
  return names.length >= 4 ? 'epic' : names.length >= 3 ? 'rare' : 'magic';
}
const RARITY_LABEL = { normal: 'Normal', magic: 'Magic', rare: 'Rare', epic: 'Epic' };
// what the market's item view asks for (the game sends its board filter along)
// The game keeps item locks (and bound items) by the item's "#uuid" part, not the whole id:
// a set that answers for either form, so a locked piece is never offered for salvage or sale.
class ItemKeySet extends Set {
  has(k) { if (super.has(k)) return true; const s = String(k || ''); const i = s.indexOf('#'); return i >= 0 && super.has(s.slice(i)); }
}
const MARKET_FILTER = { q: '', field: 'all', rarity: '', cat: 'all', sub: 'all', lvMin: 0, lvMax: 0, affix: '', tierMin: 0, lines: 0, mark: '', refMin: 0, qual: 0, job: '', hand: '', codexNew: 0 };

// Server payload -> list of plain events (mirrors the client's onServer)
function serverEvents(message) {
  const one = (m) => (Array.isArray(m) && typeof m[0] === 'number' ? unpackEvent(m) : m);
  if (Array.isArray(message) && typeof message[0] !== 'number') return message.map(one).filter(Boolean);
  const e = one(message);
  return e ? [e] : [];
}

const titleCase = (id) => String(id || '?')
  .split(/[_\s]+/).filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
// item / mob / skill id -> display name ("yellow_potion" -> "Yellow Potion", drop_<mob> -> the drop's name)
function pretty(id) {
  const base = String(id || '?').replace(/[~#^|+].*$/, '').replace(/^cash:/, '');
  const drop = /^drop_(.+)$/.exec(base);
  if (drop) {
    // same as the game: a named drop, else "<Mob> · <category>"
    if (DROP_NAMES[drop[1]]) return DROP_NAMES[drop[1]];
    const def = MOB_TABLE[drop[1]];
    const cat = def && CATEGORY[def[2]];
    return cat ? `${titleCase(drop[1])} · ${cat}` : `${titleCase(drop[1])} (ดรอป)`;
  }
  // the game's own names (items in Thai as the game shows them, monsters, skills, jobs)
  const real = NAMES.items[base] || NAMES.mobs[base] || NAMES.skills[base] || NAMES.jobs[base];
  return real || titleCase(base);
}

function announcementText(e) {
  if (e.text) return String(e.text);
  if (e.kind === 'epic' && e.item) return `${e.name} ได้ ${e.item}${e.mob ? ` จาก ${pretty(e.mob)}${e.mobLevel ? ` Lv ${e.mobLevel}` : ''}` : ''}${e.map ? ` (${e.map})` : ''}`;
  if (e.kind === 'refine' && e.item) return `${e.name} ตีบวก ${e.item} +${e.level} สำเร็จ`;
  if (e.name && e.item) return `${e.name} · ${e.item}`;
  return '';
}

// Runs in the game page (main world). Read-only: reads window.__game and two HUD texts.
const SNAPSHOT_JS = `(() => {
  // what the game is showing on top: its disconnect boxes (title text) or the sign-in screen
  const veil = [...document.querySelectorAll('.wbveil .cwtitle')].filter((e) => e.offsetParent).map((e) => e.textContent.trim()).join('|');
  const login = !!document.body && document.body.innerText.includes('เข้าสู่ระบบด้วย Google');
  const screen = { veil, login };
  const g = window.__game;
  if (!g || typeof g.me !== 'function') return { ready: false, screen };
  let me, st;
  try { me = g.me(); st = g.state(); } catch (e) { return { ready: false, screen }; }
  if (!me || !st) return { ready: false, loading: true, screen };
  const prim = (o) => { const r = {}; for (const k in o) { const v = o[k]; if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') r[k] = v; } return r; };
  let self = {}; try { self = prim(me.toJSON ? me.toJSON() : me); } catch (e) {}
  for (const k of ['x', 'y', 'state']) { try { self[k] = me[k]; } catch (e) {} }
  let sessionId = '';
  const players = [];
  try { st.players.forEach((p, id) => { if (p === me) sessionId = id; else players.push([+p.x || 0, +p.y || 0, p.name || '']); }); } catch (e) {}
  const mobs = {};
  try { st.mobs.forEach((m, id) => { mobs[id] = [m.mobType || '', m.level || 0, +m.x || 0, +m.y || 0, m.state || '', m.ownerId || '']; }); } catch (e) {}
  const loots = [];
  try { st.loots && st.loots.forEach((l) => loots.push([+l.x || 0, +l.y || 0])); } catch (e) {}
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : ''; };
  let mapId = ''; try { mapId = g.mapId(); } catch (e) {}
  let mini = '';
  if (window.__bdWantMini !== false && (window.__bdMiniAt === undefined || Date.now() - window.__bdMiniAt > 3000)) {
    window.__bdMiniAt = Date.now();
    try { const c = document.getElementById('minimap'); if (c && c.width) mini = c.toDataURL('image/png'); } catch (e) {}
  }
  const wf = document.querySelector('.wfill');
  const dead = document.getElementById('deathoverlay');
  const ui = {
    auto: document.body.classList.contains('auto-on'), // the game's own flag while AUTO runs
    sleeping: document.body.classList.contains('sleeping'),
    weightPct: wf && wf.style.width ? parseFloat(wf.style.width) : null,
    deadScreen: !!(dead && dead.offsetParent),
  };
  return { ready: true, screen, sessionId, self, players, mobs, loots, mapId, ui, xpText: txt('xpbaset'), jobText: txt('xpjobt'), mini };
})()`;

// One per account: keeps what's needed to give events names and owners.
class BinderTownAdapter {
  constructor() { this.reset(); }

  reset() {
    this.sessionId = '';
    this.uid = '';
    this.name = '';
    this.mobs = new Map();       // id -> { type, level, owner }
    this.myHits = new Map();     // mob id -> last time I hit it
    this.lastKill = '';
    this.inv = null;             // Map itemId -> qty
    this.pings = new Map();      // t -> sentAt
    this.mobLevels = new Map();  // mobType -> level seen on the map
    this.locks = new ItemKeySet();      // item ids the player locked in the game
    this.bound = new ItemKeySet();      // item ids bound to the character (no market)
    this.loadout = { equip: {}, album: {}, refineStacks: {} }; // worn gear + cards, for the Build Lab
    this.build = '';             // the game's build (from pong)
    this.econIndex = 1;           // server economy index (NPC prices follow it)
    this.newTypes = new Map();   // server message types the client table didn't have -> field names
    this.stats = { frames: 0, decodeErrors: 0, unknownPacked: 0, snapshots: 0 };
    this.missing = [];           // required character fields the page didn't have
    // kind -> boss name (client table; worldBossTop/Last update it)
    this.worldBossNames = { vale: 'Wraithroot Colossus', nacreon: 'Pearlheart Titan' };
  }

  mobName(id) {
    const m = this.mobs.get(id);
    return m ? pretty(m.type) : null;
  }
  isMine(id) {
    if (!id) return false;
    if (id === this.sessionId) return true;
    const m = this.mobs.get(id);
    return !!m && !!m.owner && m.owner === this.sessionId; // my summon / pet
  }

  // A frame the page sent (only used to time pings)
  outgoing(buf, at = Date.now()) {
    const f = decodeFrame(buf);
    if (!f || f.type !== 'input' || !f.message || f.message.type !== 'ping') return;
    this.pings.set(f.message.t, at);
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value);
  }

  // A frame the page received -> normalized events
  incoming(buf, at = Date.now()) {
    const f = decodeFrame(buf);
    if (f && f.bad) this.stats.decodeErrors++;
    if (!f || f.type !== 'server' || f.message === undefined) return [];
    this.stats.frames++;
    const out = [];
    const raw = Array.isArray(f.message) && typeof f.message[0] !== 'number' ? f.message : [f.message];
    for (const m of raw) if (Array.isArray(m) && typeof m[0] === 'number' && !PACKED[m[0] - 1]) this.stats.unknownPacked++;
    for (const e of serverEvents(f.message)) {
      if (e && e.type && !KNOWN_TYPES.has(e.type) && !this.newTypes.has(e.type)) {
        this.newTypes.set(e.type, Object.keys(e).filter((k) => k !== 'type').slice(0, 20));
        out.push({ type: 'newType', name: String(e.type).slice(0, 40), fields: this.newTypes.get(e.type), t: at });
      }
      this.server(e, at, out);
    }
    return out;
  }

  // Is the game still the shape this adapter expects?
  health() {
    const s = this.stats;
    const problems = [];
    if (this.missing.length) problems.push(`ไม่พบข้อมูลตัวละคร: ${this.missing.join(', ')}`);
    if (s.decodeErrors > 3 && s.decodeErrors > s.frames * 0.02) problems.push(`ถอดข้อความจากเกมไม่ได้ ${s.decodeErrors} ครั้ง`);
    if (s.unknownPacked > 3) problems.push(`เจอรูปแบบข้อความใหม่ ${s.unknownPacked} ครั้ง`);
    return {
      build: this.build,
      knownBuild: !this.build || KNOWN_BUILDS.includes(this.build),
      ok: problems.length === 0,
      problems,
      frames: s.frames,
    };
  }

  server(e, at, out) {
    switch (e.type) {
      case 'hit': {
        const amount = Number(e.amount) || 0;
        if (this.isMine(e.actorId) && e.targetId !== this.sessionId) {
          if (e.kind === 'heal') break;
          this.myHits.set(e.targetId, at);
          const target = this.mobName(e.targetId) || 'เป้าหมาย';
          if (e.kind === 'miss' || amount === 0) out.push({ type: 'miss', target, t: at });
          else { const tm = this.mobs.get(e.targetId); out.push({ type: 'hit', target, dmg: amount, crit: e.kind === 'crit', skill: e.skillId ? pretty(e.skillId) : '', sid: e.skillId || '', mob: tm ? tm.type : '', pet: e.actorId !== this.sessionId, t: at }); }
        } else if (e.targetId === this.sessionId && amount > 0 && e.kind !== 'heal') {
          out.push({ type: 'hurt', from: this.mobName(e.actorId) || 'ผู้เล่น', dmg: amount, t: at });
        }
        break;
      }
      case 'died':
        if (e.id === this.sessionId) out.push({ type: 'death', t: at });
        else if (this.myHits.has(e.id)) { this.lastKill = this.mobName(e.id) || ''; this.myHits.delete(e.id); }
        break;
      case 'youDied': {
        const c = e.cause || {};
        out.push({ type: 'death', by: c.kind === 'mob' ? pretty(c.mobType) : c.name || '', t: at });
        break;
      }
      case 'respawned':
        if (e.id === this.sessionId) out.push({ type: 'revive', t: at });
        break;
      case 'autoRespawned': out.push({ type: 'revive', here: true, fee: Number(e.fee) || 0, t: at }); break;
      case 'killGain': {
        const d = (p) => (Array.isArray(p) ? (p[1] || 0) - (p[0] || 0) : 0);
        out.push({ type: 'kill', target: this.lastKill || 'มอน', exp: d(e.xp), job: d(e.job), silver: d(e.gold), t: at });
        this.lastKill = '';
        break;
      }
      case 'levelUp':
        if (e.id === this.sessionId) out.push({ type: 'info', text: `เลเวลอัป! Lv ${e.level}`, t: at });
        break;
      case 'jobLevelUp':
        if (e.id === this.sessionId) out.push({ type: 'info', text: `Job เลเวลอัป! Job ${e.level}`, t: at });
        break;
      case 'chat': out.push(this.chat(e, at, false)); break;
      case 'chatBacklog':
        for (const l of e.lines || []) out.push(this.chat(l, l.at || at, true));
        break;
      case 'announcement': {
        const text = announcementText(e);
        if (e.kind === 'epic' && this.name && e.name === this.name) out.push({ type: 'rareDrop', item: e.item, t: at });
        if (text) out.push({ type: 'chat', channel: 'system', from: '', text, backlog: false, t: at });
        break;
      }
      case 'humanCheck': out.push({ type: 'humanCheck', why: String(e.why || ''), t: at }); break;
      case 'humanResult': out.push({ type: 'humanResult', ok: !!e.ok, t: at }); break;
      case 'notice': if (e.text) out.push({ type: 'info', notice: true, text: String(e.text), t: at }); break;
      case 'maintenance': out.push({ type: 'info', text: 'เกมแจ้งปิดปรับปรุง', t: at }); break;
      case 'socialInvite':
        if (e.kind === 'party') out.push({ type: 'party', from: e.from, text: `${e.from} ชวนเข้า Party${e.partyName ? ` "${e.partyName}"` : ''}`, t: at });
        break;
      case 'joinRequest': {
        const r = e.request || {};
        if (r.kind === 'party') out.push({ type: 'party', from: r.name, text: `${r.name} ขอเข้า Party`, t: at });
        break;
      }
      case 'tradeInvite': out.push({ type: 'info', text: `${e.from} ขอเทรด`, t: at }); break;
      case 'inv': this.inventory(e, at, out); break;
      case 'autoSold':
        // gone from the bag because it was sold, not used up
        out.push({ type: 'sold', id: String(e.itemId || ''), item: pretty(e.itemId), qty: e.qty || 1, auto: true, t: at });
        break;
      case 'autoForged':
        out.push({ type: 'sold', id: String(e.itemId || ''), item: pretty(e.itemId), qty: e.qty || 1, auto: true, forged: true, t: at });
        break;
      case 'sold':
        out.push({ type: 'sold', id: e.itemId === '*' ? '' : String(e.itemId || ''), item: e.itemId === '*' ? 'ของหลายชิ้น' : pretty(e.itemId), qty: e.qty, silver: e.silver, t: at });
        break;
      case 'marketItem': {
        // the market board's own row for this item kind + grade: "cheapest now" is what the board shows
        const v = e.view || {};
        if (!v.itemId) break;
        const gear = String(v.itemId).includes('|') || String(v.itemId).includes('#');
        const price = v.low > 0 ? v.low : v.vol7 > 0 && v.last > 0 ? v.last : null;
        out.push({
          type: 'market', id: v.itemId, key: v.key || '', fromBoard: true, t: at,
          item: gear ? `${pretty(v.itemId)} (${RARITY_LABEL[rarityOf(v.itemId)]})` : pretty(v.itemId),
          bagName: pretty(v.itemId),
          price, basis: v.low > 0 ? 'listed' : price ? 'sales' : null, last: v.last || 0, vol7: v.vol7 || 0, stock: v.stock || 0,
        });
        break;
      }
      case 'market':
        // the market board answer to marketQuery: "mine" = this character's own listings
        // "mine" holds listing ids (or rows); the rows themselves are in "listings"
        if (Array.isArray(e.mine)) {
          const ids = new Set(e.mine.map((m) => (m && typeof m === 'object' ? m.id : m)));
          const rows = [...e.mine.filter((m) => m && typeof m === 'object'), ...(e.listings || []).filter((l) => l && ids.has(l.id))];
          out.push({ type: 'myListings', t: at, ids: [...ids], list: rows.map((m) => ({ id: m.id, itemId: String(m.itemId || ''), qty: m.qty || 1, price: m.price || 0 })) });
        }
        break;
      case 'linkRequired':
        out.push({ type: 'marketResult', ok: false, linkRequired: true, reason: `ต้องผูกบัญชี (ไม่ใช่ Guest) ก่อนจึงจะ${e.what || 'ใช้ตลาดกลาง'}ได้`, t: at });
        break;
      case 'marketResult':
        out.push({ type: 'marketResult', ok: !!e.ok, reason: e.reason ? String(e.reason) : '', t: at });
        break;
      case 'marketGuide': {
        const p = marketPrice(e, at);
        out.push({ type: 'market', id: e.itemId, item: pretty(e.itemId), ...(p || { price: null }), t: at });
        break;
      }
      case 'pass': {
        const st = e.state || {};
        const rows = (defs, prog, done) => defs.map((d) => {
          const p = Math.min(d.goal, Number((prog || {})[d.id]) || 0);
          return { ...d, prog: p, claimed: (done || []).includes(d.id), ready: p >= d.goal && !(done || []).includes(d.id) };
        });
        if (typeof e.premiumUntil === 'number') out.push({ type: 'premium', until: e.premiumUntil, t: at });
        if (e.state) out.push({ type: 'pass', t: at, day: st.day || '', daily: rows(PASS_DAILY, st.daily, st.dailyDone), weekly: rows(PASS_WEEKLY, st.weekly, st.weeklyDone) });
        break;
      }
      case 'mail':
        if (Array.isArray(e.list)) {
          const gifts = e.list.filter((m) => !m.claimed && ((m.items && m.items.length) || m.gold || m.crystals));
          out.push({ type: 'mail', t: at, gifts: gifts.length, giftIds: gifts.map((m) => m.id), titles: gifts.slice(0, 5).map((m) => String(m.title || '').slice(0, 60)), unread: e.list.filter((m) => !m.read).length });
        }
        break;
      case 'channels':
        // players per channel on this map (index = channel - 1) and the switch cooldown
        out.push({ type: 'channels', t: at, counts: Array.isArray(e.counts) ? e.counts : [], lockMs: (e.lock && Number(e.lock.ms)) || 0 });
        break;
      case 'hunt': {
        const b = (e.view && e.view.bounty) || {};
        out.push({ type: 'hunt', t: at, claimed: (b.claimed || []).length, active: Object.keys(b.prog || {}).length,
          day: b.day || (e.view && e.view.date) || '', progById: b.prog || {}, claimedIds: Array.isArray(b.claimed) ? b.claimed : [] });
        break;
      }
      case 'hotWeek': {
        const n = e.now;
        out.push({
          type: 'worldEvent', key: 'hotWeek', t: at,
          active: n ? { id: n.id, name: n.name || n.nameEn || 'Hot Week', perks: Object.entries(n.pct || {}).filter(([, v]) => v).map(([k, v]) => `${HOT_WEEK_LABEL[k] || k} +${v}%`), endsAt: at + (n.endInMs || 0) } : null,
          next: e.next ? { name: e.next.name || 'Hot Week', startsAt: at + (e.next.startInMs || 0) } : null,
          fresh: !!e.fresh,
        });
        break;
      }
      case 'randomEvent': {
        const def = e.id ? RANDOM_EVENTS[e.id] || { name: pretty(e.id), perks: [] } : null;
        out.push({ type: 'worldEvent', key: 'random', t: at, active: def ? { id: e.id, name: def.name, perks: def.perks, endsAt: at + (e.leftMs || 0) } : null, fresh: !!e.fresh });
        break;
      }
      case 'motherLode':
        out.push({ type: 'worldEvent', key: 'motherLode', t: at, active: e.view ? { id: 'motherLode', name: 'Mother Lode', perks: ['แหล่งแร่ใหญ่ปรากฏ'], endsAt: e.view.endsAt || e.view.until || 0 } : null, fresh: false });
        break;
      case 'econ':
        if (e.state && e.state.index > 0) this.econIndex = e.state.index;
        break;
      case 'fieldBosses': {
        const skew = typeof e.now === 'number' ? at - e.now : 0; // server clock -> ours
        out.push({
          type: 'fieldBosses', t: at,
          list: (e.list || []).map((b) => ({
            mobType: b.type, name: pretty(b.type), map: b.pin || '', killer: b.killer || '',
            closed: !!b.closed, until: b.until ? b.until + skew : 0, // 0 = up now
          })),
        });
        break;
      }
      case 'worldBossTop':
      case 'worldBossLast':
        if (e.kind && e.boss) this.worldBossNames[e.kind] = e.boss;
        break;
      case 'worldBoss': {
        const v = e.view || {};
        if (!v.kind) break;
        out.push({
          type: 'worldBoss', t: at, kind: v.kind, name: this.worldBossNames[v.kind] || pretty(v.kind),
          state: v.state, startAt: v.startAt || 0, endsAt: v.endsAt || 0, nextAt: v.nextAt || 0,
          fighters: v.fighters || 0, hpFrac: typeof v.frac === 'number' ? v.frac : null,
        });
        break;
      }
      case 'salvaged': {
        const ok = e.ok !== false;
        const gains = Object.entries(e).filter(([k, v]) => typeof v === 'number' && !['qty'].includes(k)).map(([k, v]) => `${pretty(k)} ${v}`).join(' · ');
        out.push({ type: 'info', text: ok ? `ย่อยของแล้ว${e.itemId ? ` ${pretty(e.itemId)}` : ''}${gains ? ` · ${gains}` : ''}` : `ย่อยไม่ได้: ${e.reason || ''}`, t: at });
        break;
      }

      case 'cardFound': out.push({ type: 'card', mob: pretty(e.mob), level: e.level, t: at }); break;
      case 'pong': {
        const sent = this.pings.get(e.t);
        const ev = { type: 'net', t: at };
        if (sent !== undefined) { ev.ping = Math.max(0, at - sent); this.pings.delete(e.t); }
        if (typeof e.online === 'number') ev.online = e.online;
        if (e.build) { this.build = String(e.build); ev.build = this.build; }
        out.push(ev);
        break;
      }
      default: break;
    }
  }

  chat(e, at, backlog) {
    const mine = !!(e.id && e.id === this.sessionId) || !!(e.uid && this.uid && e.uid === this.uid);
    let text = String(e.text || '');
    if (Array.isArray(e.items)) text = text.replace(/\[\[(\d)\]\]/g, (_m, i) => `[${pretty(e.items[+i])}]`);
    return {
      type: 'chat', channel: e.channel || 'map', from: e.name || '', guild: e.guild || '',
      to: e.to || '', text, mine, backlog, t: at,
    };
  }

  inventory(e, at, out) {
    const items = Array.isArray(e.items) ? e.items : [];
    if (Array.isArray(e.locks)) this.locks = new ItemKeySet(e.locks);
    if (Array.isArray(e.bound)) this.bound = new ItemKeySet(e.bound); // bound to the character: can't be traded
    if (e.equip && typeof e.equip === 'object') this.loadout.equip = { ...e.equip };
    if (e.album && typeof e.album === 'object') this.loadout.album = { ...e.album };
    if (e.refineStacks && typeof e.refineStacks === 'object') this.loadout.refineStacks = { ...e.refineStacks };
    if (!e.d || !this.inv) {
      this.inv = new Map(items.map((i) => [i.id, i.qty]));
    } else {
      for (const id of e.gone || []) this.inv.delete(id);
      for (const i of items) {
        const before = this.inv.get(i.id) || 0;
        if (i.qty > before) {
          const qty = i.qty - before;
          const drop = /^drop_([a-z0-9_]+)/.exec(i.id);
          const value = drop ? dropPrice(drop[1], this.mobLevels.get(drop[1]), this.econIndex) * qty : 0;
          out.push({ type: 'loot', id: i.id, item: pretty(i.id), qty, value, worthChecking: !drop && !SUPPLIES.test(i.id.replace(/[~#].*$/, '')), t: at });
        }
        this.inv.set(i.id, i.qty);
      }
    }
    // merge variants (id~grade) under one name for the bag list
    const merged = new Map();
    for (const [id, qty] of this.inv) {
      const name = pretty(id);
      const m = merged.get(name) || { name, qty: 0, ids: [] };
      m.qty += Number(qty) || 0;
      // gear pieces are single instances "<item>#<uuid>"; locked ones can't be sold or salvaged
      const gear = id.includes('#');
      m.ids.push({ id, qty: Number(qty) || 0, gear, locked: this.locks.has(id), bound: this.bound.has(id), ...(gear ? { rarity: rarityOf(id) } : {}) });
      if (isSupply(id)) m.supply = true;
      merged.set(name, m);
    }
    out.push({ type: 'bag', items: [...merged.values()], t: at });
  }

  // Page snapshot (SNAPSHOT_JS result) -> events
  snapshot(s, at = Date.now()) {
    if (!s || !s.ready) return [];
    const out = [];
    this.stats.snapshots++;
    this.missing = REQUIRED_FIELDS.filter((k) => !(k in (s.self || {})));
    if (!/%/.test(s.xpText || '')) this.missing.push('EXP% (HUD)');
    this.sessionId = s.sessionId || this.sessionId;
    const me = s.self || {};
    if (me.uid) this.uid = String(me.uid);
    if (me.name) this.name = String(me.name);
    this.mobs.clear();
    const monsters = [];
    for (const [id, m] of Object.entries(s.mobs || {})) {
      this.mobs.set(id, { type: m[0], level: m[1], owner: m[5] });
      if (m[0] && m[1]) this.mobLevels.set(m[0], m[1]);
      if (m[4] !== 'dead' && !m[5]) monsters.push({ x: m[2], y: m[3], name: pretty(m[0]) });
    }
    const pct = (t) => { const m = /([\d.]+)\s*%/.exec(t || ''); return m ? Number(m[1]) : undefined; };
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const self = {
      type: 'self', t: at,
      name: me.name, job: me.job ? pretty(me.job) : undefined, level: num(me.level), jobLevel: num(me.jobLevel),
      hp: num(me.hp), maxHp: num(me.maxHp), sp: num(me.mp ?? me.sp), maxSp: num(me.maxMp ?? me.maxSp),
      xp: num(me.xp), expPct: pct(s.xpText), jobPct: pct(s.jobText),
      silver: num(me.silver), gold: num(me.gold ?? me.gems),
      str: num(me.str), agi: num(me.agi), vit: num(me.vit), int: num(me.int), dex: num(me.dex), luk: num(me.luk),
      map: s.mapId || undefined, dead: me.state === 'dead',
      auto: s.ui ? s.ui.auto ?? undefined : undefined, sleeping: s.ui ? s.ui.sleeping : undefined,
      weightPct: s.ui && typeof s.ui.weightPct === 'number' ? s.ui.weightPct : undefined, premium: typeof me.premium === 'boolean' ? me.premium : undefined,
    };
    for (const k of Object.keys(self)) if (self[k] === undefined) delete self[k];
    out.push(self);
    // world: positions in map tiles; the dashboard scales by the map's bounds
    const xs = [me.x, ...monsters.map((m) => m.x), ...(s.players || []).map((p) => p[0])].filter((v) => typeof v === 'number');
    const ys = [me.y, ...monsters.map((m) => m.y), ...(s.players || []).map((p) => p[1])].filter((v) => typeof v === 'number');
    out.push({
      type: 'world', t: at,
      w: Math.max(1, ...xs) + 2, h: Math.max(1, ...ys) + 2,
      self: typeof me.x === 'number' ? { x: me.x, y: me.y } : null,
      monsters, players: (s.players || []).map((p) => ({ x: p[0], y: p[1], name: p[2] })),
      drops: (s.loots || []).map((l) => ({ x: l[0], y: l[1] })),
    });
    if (s.mini) out.push({ type: 'minimap', url: s.mini, t: at });
    // buffs / effects: a JSON list of { kind, until, stacks }
    try {
      const list = JSON.parse(me.effects || '[]')
        .filter((x) => x && x.kind && x.kind !== 'offready')
        .map((x) => ({ name: pretty(x.kind), until: x.until > 0 ? x.until : undefined, stacks: x.stacks > 1 ? x.stacks : undefined }));
      out.push({ type: 'buffs', list, t: at });
    } catch { /* not JSON */ }
    return out;
  }
}

module.exports = { MARKET_FILTER, rarityOf, baseOf, isSupply, KNOWN_TYPES, KNOWN_BUILDS, POTIONS, encodeInput, marketPrice, decodeFrame, serverEvents, unpackEvent, BinderTownAdapter, SNAPSHOT_JS, pretty, dropPrice };
