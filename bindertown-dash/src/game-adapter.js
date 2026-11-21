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
const { MOBS: MOB_TABLE, CATEGORY } = require('./mob-table');

// NPC sell price of a monster drop, same formula as the game client:
// round((3 + level * 0.5) * roleMult * (level >= 65 ? 0.7 : 1)), at least 2
const ROLE_MULT = { trash: 1, pack: 0.9, ambush: 1.2, tank: 1.3, elite: 2.5, 'mini-boss': 6, boss: 12 };
function dropPrice(mobType, liveLevel) {
  const def = MOB_TABLE[mobType];
  const role = def ? def[0] : 'trash';
  const level = (def && def[1]) || liveLevel || 1;
  return Math.max(2, Math.round((3 + level * 0.5) * (ROLE_MULT[role] ?? 1) * (level >= 65 ? 0.7 : 1)));
}

const ROOM_DATA = 13;

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
const POTIONS = [
  { id: 'potion', name: 'โพชั่น', kind: 'hp', price: 12 },
  { id: 'hi_potion', name: 'ไฮโพชั่น', kind: 'hp', price: 32 },
  { id: 'mega_potion', name: 'เมก้าโพชั่น', kind: 'hp', price: 75 },
  { id: 'elixir', name: 'Elixir', kind: 'hp', price: 150 },
  { id: 'grand_elixir', name: 'Grand Elixir', kind: 'hp', price: 260 },
  { id: 'pearl_elixir', name: 'Pearl Elixir', kind: 'hp', price: 400 },
  { id: 'sovereign_elixir', name: 'Sovereign Elixir', kind: 'hp', price: 560 },
  { id: 'mana_potion', name: 'ยามานา', kind: 'mp', price: 16 },
  { id: 'ether', name: 'Ether', kind: 'mp', price: 40 },
  { id: 'high_ether', name: 'High Ether', kind: 'mp', price: 100 },
  { id: 'pearl_ether', name: 'Pearl Ether', kind: 'mp', price: 150 },
  { id: 'sovereign_ether', name: 'Sovereign Ether', kind: 'mp', price: 210 },
];

// Items that are everyday supplies, not loot worth a market check
const SUPPLIES = /^(potion|mana_potion|.*_potion|arrow.*|bullet.*|throwing_.*|fly_wing|butterfly_wing|herb_leaf|raw_fish)$/;

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
  return titleCase(base);
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
  const g = window.__game;
  if (!g || typeof g.me !== 'function') return { ready: false };
  let me, st;
  try { me = g.me(); st = g.state(); } catch (e) { return { ready: false }; }
  if (!me || !st) return { ready: false, loading: true };
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
  return { ready: true, sessionId, self, players, mobs, loots, mapId, ui, xpText: txt('xpbaset'), jobText: txt('xpjobt'), mini };
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
    this.locks = new Set();      // item ids the player locked in the game
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
    if (!f || f.type !== 'server' || f.message === undefined) return [];
    const out = [];
    for (const e of serverEvents(f.message)) this.server(e, at, out);
    return out;
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
          else out.push({ type: 'hit', target, dmg: amount, crit: e.kind === 'crit', skill: e.skillId ? pretty(e.skillId) : '', t: at });
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
      case 'autoRespawned': out.push({ type: 'revive', t: at }); break;
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
      case 'notice': if (e.text) out.push({ type: 'info', text: String(e.text), t: at }); break;
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
      case 'autoSold': out.push({ type: 'info', text: `ขายอัตโนมัติ ${pretty(e.itemId)} x${e.qty}`, t: at }); break;
      case 'sold':
        out.push({ type: 'sold', item: e.itemId === '*' ? 'ของหลายชิ้น' : pretty(e.itemId), qty: e.qty, silver: e.silver, t: at });
        break;
      case 'marketGuide': {
        const p = marketPrice(e, at);
        out.push({ type: 'market', id: e.itemId, item: pretty(e.itemId), ...(p || { price: null }), t: at });
        break;
      }
      case 'salvaged': {
        const ok = e.ok !== false;
        const gains = Object.entries(e).filter(([k, v]) => typeof v === 'number' && !['qty'].includes(k)).map(([k, v]) => `${pretty(k)} ${v}`).join(' · ');
        out.push({ type: 'info', text: ok ? `ย่อยของแล้ว${e.itemId ? ` ${pretty(e.itemId)}` : ''}${gains ? ` · ${gains}` : ''}` : `ย่อยไม่ได้: ${e.reason || ''}`, t: at });
        break;
      }
      case 'pass':
        if (typeof e.premiumUntil === 'number') out.push({ type: 'premium', until: e.premiumUntil, t: at });
        break;
      case 'cardFound': out.push({ type: 'card', mob: pretty(e.mob), level: e.level, t: at }); break;
      case 'pong': {
        const sent = this.pings.get(e.t);
        const ev = { type: 'net', t: at };
        if (sent !== undefined) { ev.ping = Math.max(0, at - sent); this.pings.delete(e.t); }
        if (typeof e.online === 'number') ev.online = e.online;
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
    if (Array.isArray(e.locks)) this.locks = new Set(e.locks);
    if (!e.d || !this.inv) {
      this.inv = new Map(items.map((i) => [i.id, i.qty]));
    } else {
      for (const id of e.gone || []) this.inv.delete(id);
      for (const i of items) {
        const before = this.inv.get(i.id) || 0;
        if (i.qty > before) {
          const qty = i.qty - before;
          const drop = /^drop_([a-z0-9_]+)/.exec(i.id);
          const value = drop ? dropPrice(drop[1], this.mobLevels.get(drop[1])) * qty : 0;
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
      m.ids.push({ id, qty: Number(qty) || 0, gear: id.includes('#'), locked: this.locks.has(id) });
      merged.set(name, m);
    }
    out.push({ type: 'bag', items: [...merged.values()], t: at });
  }

  // Page snapshot (SNAPSHOT_JS result) -> events
  snapshot(s, at = Date.now()) {
    if (!s || !s.ready) return [];
    const out = [];
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

module.exports = { POTIONS, encodeInput, marketPrice, decodeFrame, serverEvents, unpackEvent, BinderTownAdapter, SNAPSHOT_JS, pretty, dropPrice };
