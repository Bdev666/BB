// Everything the dashboard knows about one account, built from normalized
// game events (see game-adapter.js for the event shapes).
// Keeps a short history of a growing number (total EXP, EXP %) to estimate per-hour rates.
class ExpTracker {
  constructor(windowMs = 30 * 60 * 1000) { this.samples = []; this.windowMs = windowMs; }
  add(value, level, now = Date.now()) {
    const last = this.samples[this.samples.length - 1];
    if (last && ((level !== undefined && last.level !== undefined && level !== last.level) || value < last.exp)) {
      this.samples = []; // level up or reset: start over
    }
    if (last && this.samples.length && last.exp === value && now - last.t < 5000) return;
    this.samples.push({ t: now, exp: value, level });
    const cutoff = now - this.windowMs;
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

const MAX_EVENTS = 300;
const MAX_CHAT = 200;
const HOUR = 3600 * 1000;

class AccountData {
  constructor() { this.reset(); }

  reset() {
    this.stats = {};          // name, job, level, jobLevel, hp, maxHp, sp, maxSp, exp, maxExp, silver, gold, str..luk, map
    this.buffs = [];          // [{ name, icon?, until?, stacks? }]
    this.events = [];         // [{ t, kind: hit|hurt|loot|exp|other, text }]
    this.chat = [];           // [{ t, channel, from, guild, text }]
    this.bag = new Map();     // name -> { qty, gainedSince, firstQty, firstAt, watchBelow }
    this.world = null;        // { w, h, self:{x,y}, monsters:[], players:[], drops:[] }
    this.expTracker = new ExpTracker();
    this.pctTracker = new ExpTracker();
    this.net = {};            // { ping, online }
    this.minimap = null;      // data URL of the game's own minimap
    this.startedAt = Date.now();
    this.kills = 0;
    this.silverStart = null;
    this.dmgWindow = [];      // [{ t, dmg }] last 60s of damage dealt
    this.dmgTotal = 0;
    this.hits = 0;
    this.dropValue = 0;       // NPC sell value of drops picked up
    this.cards = [];          // [{ t, mob, level }]
    this.prices = new Map();  // item name -> { price (Gold), basis, at } from the market
    this.premiumUntil = null; // ms epoch, 0 = no Premium
    this.soldSilver = 0;
  }

  log(kind, text, t = Date.now()) {
    this.events.push({ t, kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  ingest(ev) {
    const t = ev.t || Date.now();
    switch (ev.type) {
      case 'self': {
        const { type, t: _t, ...rest } = ev;
        Object.assign(this.stats, rest);
        const total = typeof rest.xp === 'number' ? rest.xp : rest.exp;
        // the game's xp is a running total (doesn't restart at level up); demo exp does
        if (typeof rest.xp === 'number') this.expTracker.add(rest.xp, undefined, t);
        else if (typeof total === 'number') this.expTracker.add(total, this.stats.level, t);
        if (typeof rest.expPct === 'number') this.pctTracker.add(rest.expPct, this.stats.level, t);
        if (typeof rest.silver === 'number' && this.silverStart === null) this.silverStart = rest.silver;
        break;
      }
      case 'buffs': this.buffs = ev.list || []; break;
      case 'net':
        if (typeof ev.ping === 'number') this.net.ping = Math.round(ev.ping);
        if (typeof ev.online === 'number') this.net.online = ev.online;
        break;
      case 'minimap': this.minimap = ev.url; break;
      case 'hit':
        this.hits++;
        this.dmgTotal += ev.dmg || 0;
        this.dmgWindow.push({ t, dmg: ev.dmg || 0 });
        this.log('hit', `ตี ${ev.target} ${fmt(ev.dmg)}${ev.crit ? ' (คริ)' : ''}${ev.skill ? ' · ' + ev.skill : ''}`, t);
        break;
      case 'miss': this.log('hit', `${ev.target} หลบ`, t); break;
      case 'hurt': this.log('hurt', `โดน ${ev.from} ${fmt(ev.dmg)}`, t); break;
      case 'kill':
        this.kills++;
        this.log('exp', `ล้ม ${ev.target}${ev.exp ? ` +${fmt(ev.exp)} EXP` : ''}${ev.job != null ? ` · +${fmt(ev.job)} Job` : ''}${ev.silver ? ` · +${fmt(ev.silver)} Silver` : ''}`, t);
        break;
      case 'loot': {
        this.log('loot', `เก็บ ${ev.item}${ev.qty > 1 ? ' x' + ev.qty : ''}${ev.value ? ` · ${fmt(ev.value)} Silver` : ''}`, t);
        this.dropValue += ev.value || 0;
        const b = this.bagItem(ev.item, t);
        b.gained += ev.qty || 1;
        break;
      }
      case 'bag': {
        const seen = new Set();
        for (const it of ev.items || []) {
          const b = this.bagItem(it.name, t);
          if (b.firstQty === null) b.firstQty = Math.max(0, it.qty - b.gained); // loot already counted
          b.qty = it.qty;
          if (it.ids) b.ids = it.ids;
          if (it.icon) b.icon = it.icon;
          seen.add(it.name);
        }
        for (const [name, b] of this.bag) if (!seen.has(name)) { b.qty = 0; b.ids = []; } // all gone (used up / sold)
        break;
      }
      case 'sold': {
        const b = this.bag.get(ev.item);
        if (b) b.sold += ev.qty || 0;
        this.soldSilver += ev.silver || 0;
        this.log('loot', `ขาย ${ev.item}${ev.qty > 1 ? ' x' + ev.qty : ''}${ev.silver ? ` ได้ ${fmt(ev.silver)} Silver` : ''}`, t);
        break;
      }
      case 'market':
        if (ev.item) this.prices.set(ev.item, { price: ev.price, basis: ev.basis, at: t });
        break;
      case 'premium': this.premiumUntil = ev.until; break;
      case 'rareDrop': this.log('loot', `✨ ดรอปหายาก: ${ev.item}`, t); break;
      case 'chat':
        this.chat.push({ t, channel: ev.channel || 'world', from: ev.from || '', guild: ev.guild || '', to: ev.to || '', text: ev.text || '', mine: !!ev.mine });
        if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
        break;
      case 'world': this.world = { ...this.world, ...ev }; delete this.world.type; break;
      case 'info': this.log('other', ev.text, t); break;
      case 'card':
        this.cards.push({ t, mob: ev.mob, level: ev.level });
        if (this.cards.length > 50) this.cards.shift();
        this.log('loot', `🃏 ได้การ์ด ${ev.mob}${ev.level ? ` Lv ${ev.level}` : ''}`, t);
        break;
      case 'death': this.log('hurt', `ตัวละครตาย${ev.by ? ' · โดย ' + ev.by : ''}`, t); break;
      case 'revive': this.log('other', 'ฟื้นแล้ว', t); break;
      case 'party': this.log('other', ev.text || `${ev.from} ชวน/ขอเข้าปาร์ตี้`, t); break;
      default: break;
    }
  }

  bagRows(hours) {
    return [...this.bag.entries()].filter(([, b]) => b.qty > 0).map(([name, b]) => {
      const usedPerHour = b.firstQty !== null ? Math.max(0, (b.firstQty + b.gained - b.qty - b.sold) / hours) : 0;
      const p = this.prices.get(name);
      return {
        name, qty: b.qty, icon: b.icon, ids: b.ids, gainedPerHour: b.gained / hours, usedPerHour,
        // how long the stack lasts at the current rate (potions, arrows ...), needs a few minutes of data
        minutesLeft: usedPerHour > 0 && hours > 0.08 ? (b.qty / usedPerHour) * 60 : null,
        market: p ? p.price : undefined,
      };
    });
  }

  bagItem(name, t) {
    let b = this.bag.get(name);
    if (!b) { b = { qty: 0, firstQty: null, firstAt: t, gained: 0, sold: 0, ids: [], watchBelow: null }; this.bag.set(name, b); }
    return b;
  }

  rates(now = Date.now()) {
    const hours = Math.max((now - this.startedAt) / HOUR, 1 / 60);
    this.dmgWindow = this.dmgWindow.filter((d) => now - d.t < 60 * 1000);
    const silver = this.stats.silver;
    return {
      playMs: now - this.startedAt,
      ...this.levelEta(),
      expPerHour: this.expTracker.perHour(),
      killsPerHour: this.kills / hours,
      silverPerHour: typeof silver === 'number' && this.silverStart !== null ? (silver - this.silverStart) / hours : null,
      silverToday: typeof silver === 'number' && this.silverStart !== null ? silver - this.silverStart : null,
      dpsNow: this.dmgWindow.reduce((s, d) => s + d.dmg, 0) / 60,
      dropValue: this.dropValue,
      dropValuePerHour: this.dropValue / hours,
      cards: this.cards.length,
      cardsPerHour: this.cards.length / hours,
      // everything earned: silver from kills + what the drops sell for
      incomePerHour: (typeof silver === 'number' && this.silverStart !== null ? (silver - this.silverStart) / hours : 0) + this.dropValue / hours,
      avgHit: this.hits ? this.dmgTotal / this.hits : null,
    };
  }

  // Time to next level and EXP still needed, from how fast EXP % and total EXP grow
  levelEta() {
    const pct = this.stats.expPct;
    const pctRate = this.pctTracker.perHour();
    const xpRate = this.expTracker.perHour();
    const out = {};
    if (typeof pct === 'number' && pctRate > 0) {
      out.levelEtaMs = ((100 - pct) / pctRate) * HOUR;
      if (xpRate > 0) out.expLeft = ((100 - pct) / pctRate) * xpRate;
    }
    return out;
  }

  summary(now = Date.now()) {
    const s = this.stats;
    return {
      name: s.name, job: s.job, level: s.level, map: s.map,
      hp: s.hp, maxHp: s.maxHp, sp: s.sp, maxSp: s.maxSp, exp: s.exp, maxExp: s.maxExp, expPct: s.expPct,
      ping: this.net.ping, online: this.net.online,
      silver: s.silver, ...this.rates(now),
    };
  }

  detail(now = Date.now()) {
    const hours = Math.max((now - this.startedAt) / HOUR, 1 / 60);
    return {
      stats: this.stats,
      net: this.net,
      cards: this.cards.slice(-20),
      minimap: this.minimap,
      buffs: this.buffs,
      rates: this.rates(now),
      events: this.events.slice(-200),
      chat: this.chat.slice(-150),
      world: this.world,
      premiumUntil: this.premiumUntil,
      bag: this.bagRows(hours),
    };
  }
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : '?'; }

module.exports = { AccountData, ExpTracker };
