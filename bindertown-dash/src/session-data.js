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

const baseId = (id) => String(id || '').replace(/^cash:/, '').split(/[|#+^*~@]/)[0];

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
    this.killSilver = 0; // Silver from killing monsters only (spending never counts against it)
    this.dmgWindow = [];      // [{ t, dmg }] last 60s of damage dealt
    this.dmgTotal = 0;
    this.hits = 0;
    this.dropValue = 0;       // NPC sell value of drops picked up
    this.cards = [];          // [{ t, mob, level }]
    this.prices = new Map();  // item name -> { price (Gold), basis, at } from the market
    this.itemPrices = new Map(); // item id -> market view for that piece (kind + grade)
    this.premiumUntil = null; // ms epoch, 0 = no Premium
    this.soldSilver = 0;
    this.checklist = { pass: null, mail: null, hunt: null }; // daily things to do / collect
  }

  log(kind, text, t = Date.now()) {
    this.events.push({ t, kind, text });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  ingest(ev) {
    const t = ev.t || Date.now();
    if (!this.lastT || t > this.lastT) this.lastT = t;
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
        {
          // like the game's own damage numbers: hits of one skill on one target close together show as one total
          const last = this.events[this.events.length - 1];
          const g = last && last.hit;
          if (g && g.target === ev.target && g.skill === (ev.skill || '') && t - g.at <= 1500) {
            g.dmg += ev.dmg; g.n++; if (ev.crit) g.crits++; g.at = t;
            last.text = `ตี ${g.target} ${fmt(g.dmg)}${g.crits ? (g.n > 1 ? ` (คริ ${g.crits})` : ' (คริ)') : ''}${g.skill ? ' · ' + g.skill : ''}${g.n > 1 ? ` ×${g.n}` : ''}`;
          } else {
            this.log('hit', `ตี ${ev.target} ${fmt(ev.dmg)}${ev.crit ? ' (คริ)' : ''}${ev.skill ? ' · ' + ev.skill : ''}`, t);
            this.events[this.events.length - 1].hit = { target: ev.target, skill: ev.skill || '', dmg: ev.dmg, n: 1, crits: ev.crit ? 1 : 0, at: t };
          }
        }
        break;
      case 'miss': this.log('hit', `${ev.target} หลบ`, t); break;
      case 'hurt': this.log('hurt', `โดน ${ev.from} ${fmt(ev.dmg)}`, t); break;
      case 'kill':
        this.kills++;
        this.killSilver += Number(ev.silver) || 0;
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
        this.ingestBase(ev.items || [], t);
        const seen = new Set();
        for (const it of ev.items || []) {
          const b = this.bagItem(it.name, t);
          if (b.firstQty === null) b.firstQty = Math.max(0, it.qty - b.gained); // loot already counted
          else if (it.qty < b.qty) b.useLog.push([t, b.qty - it.qty]); // used up (sales are taken back out below)
          b.qty = it.qty;
          if (it.ids) b.ids = it.ids;
          b.supply = !!it.supply;
          if (it.icon) b.icon = it.icon;
          seen.add(it.name);
        }
        for (const [name, b] of this.bag) if (!seen.has(name)) { if (b.qty > 0) b.useLog.push([t, b.qty]); b.qty = 0; b.ids = []; } // all gone (used up / sold)
        for (const b of this.bag.values()) if (b.useLog.length > 400) { const old = b.useLog.splice(0, 200); b.useLog.unshift([old[old.length - 1][0], old.reduce((n, [, q]) => n + q, 0)]); }
        break;
      }
      case 'sold': {
        const b = this.bag.get(ev.item);
        if (b) { b.sold += ev.qty || 0; b.useLog.push([t, -(ev.qty || 0)]); }
        if (ev.id) { const s = this.baseItem(baseId(ev.id)); s.useLog.push([t, -(ev.qty || 0)]); } // a sale is not use (it may come before or after the bag drops)
        this.soldSilver += ev.silver || 0;
        this.log(ev.auto ? 'other' : 'loot', `${ev.forged ? 'หลอมอัตโนมัติ' : ev.auto ? 'ขายอัตโนมัติ' : 'ขาย'} ${ev.item}${ev.qty > 1 ? ' x' + ev.qty : ''}${ev.silver ? ` ได้ ${fmt(ev.silver)} Silver` : ''}`, t);
        break;
      }
      case 'market':
        if (ev.bagName || ev.item) this.prices.set(ev.bagName || ev.item, { price: ev.price, basis: ev.basis, at: t });
        // per piece (gear differs by grade): what the market board shows for its kind + grade
        if (ev.id) this.itemPrices.set(ev.id, { price: ev.price, basis: ev.basis, last: ev.last || 0, stock: ev.stock || 0, vol7: ev.vol7 || 0, key: ev.key || '', name: ev.item, at: t });
        break;
      case 'premium': this.premiumUntil = ev.until; break;
      case 'pass': this.checklist.pass = { day: ev.day, daily: ev.daily, weekly: ev.weekly, at: t }; break;
      case 'mail': this.checklist.mail = { gifts: ev.gifts, titles: ev.titles, unread: ev.unread, at: t }; break;
      case 'hunt': this.checklist.hunt = { claimed: ev.claimed, active: ev.active, at: t }; break;
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

  // per base id ("hi_potion" = hi_potion + hi_potion~1 + hi_potion~2): what the game's hotbar uses up
  baseItem(id) {
    this.base = this.base || new Map();
    let s = this.base.get(id);
    if (!s) { s = { qty: null, useLog: [] }; this.base.set(id, s); }
    return s;
  }
  ingestBase(items, t) {
    const sum = new Map();
    for (const it of items) for (const x of it.ids || []) { const b = baseId(x.id); sum.set(b, (sum.get(b) || 0) + (x.qty || 0)); }
    for (const [b, s] of this.base || []) if (!sum.has(b)) sum.set(b, 0);
    for (const [b, q] of sum) {
      const s = this.baseItem(b);
      if (s.qty !== null && q < s.qty) s.useLog.push([t, s.qty - q]);
      s.qty = q;
      if (s.useLog.length > 400) { const old = s.useLog.splice(0, 200); s.useLog.unshift([old[old.length - 1][0], old.reduce((n, [, x]) => n + x, 0)]); }
    }
  }
  // stock and "runs out in" for one base id at the current pace (at least 10 minutes counted)
  supplyClock(id, now = Date.now()) {
    const s = this.base && this.base.get(id);
    if (!s || s.qty === null) return null;
    const hours = (now - this.startedAt) / HOUR;
    const used = Math.max(0, s.useLog.reduce((n, [, x]) => n + x, 0));
    const perHour = hours > 0 ? used / Math.max(hours, 1 / 6) : 0;
    return { qty: s.qty, perHour, minutesLeft: perHour > 0 && (hours > 0.08 || used >= 10) ? (s.qty / perHour) * 60 : null };
  }

  bagRows(hours) {
    return [...this.bag.entries()].filter(([, b]) => b.qty > 0).map(([name, b]) => {
      // use rate from how much LEFT the stack: buying or picking up more never hides use
      const used = b.useLog.reduce((t, [, n]) => t + n, 0);
      const usedPerHour = hours > 0 ? Math.max(0, used / Math.max(hours, 1 / 6)) : 0; // at least 10 minutes: a quick burst at the start is not the real pace
      const p = this.prices.get(name);
      return {
        name, qty: b.qty, icon: b.icon, ids: b.ids, gainedPerHour: b.gained / hours, usedPerHour,
        // how long the stack lasts at the current rate (potions, arrows ...), needs a few minutes of data
        // only for supplies (potions, ammo …): gear/materials leave the bag by being sold or salvaged
        minutesLeft: b.supply && usedPerHour > 0 && (hours > 0.08 || b.useLog.reduce((n, [, q]) => n + q, 0) >= 10) ? (b.qty / usedPerHour) * 60 : null,
        market: p ? p.price : undefined,
      };
    });
  }

  bagItem(name, t) {
    let b = this.bag.get(name);
    if (!b) { b = { qty: 0, firstQty: null, firstAt: t, gained: 0, sold: 0, ids: [], watchBelow: null, useLog: [] }; this.bag.set(name, b); }
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
      // earned from monsters only, like the game's sleep-mode summary (buying potions etc. never makes it negative)
      silverPerHour: this.killSilver / hours,
      silverToday: this.killSilver,
      silverNet: typeof silver === 'number' && this.silverStart !== null ? silver - this.silverStart : null,
      dpsNow: this.dmgWindow.reduce((s, d) => s + d.dmg, 0) / 60,
      dropValue: this.dropValue,
      dropValuePerHour: this.dropValue / hours,
      cards: this.cards.length,
      cardsPerHour: this.cards.length / hours,
      // everything earned: silver from kills + what the drops sell for
      incomePerHour: this.killSilver / hours + this.dropValue / hours,
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

  // rewards waiting to be collected: pass tasks done but not claimed + mails with gifts
  rewardsWaiting() {
    const c = this.checklist;
    const pass = c.pass ? [...c.pass.daily, ...c.pass.weekly].filter((x) => x.ready).length : 0;
    return { pass, mail: c.mail ? c.mail.gifts : 0, total: pass + (c.mail ? c.mail.gifts : 0) };
  }

  summary(now = Date.now()) {
    const s = this.stats;
    return {
      name: s.name, job: s.job, level: s.level, map: s.map,
      hp: s.hp, maxHp: s.maxHp, sp: s.sp, maxSp: s.maxSp, exp: s.exp, maxExp: s.maxExp, expPct: s.expPct,
      ping: this.net.ping, online: this.net.online, rewards: this.rewardsWaiting().total,
      silver: s.silver, ...this.rates(now),
    };
  }

  detail(now = Date.now()) {
    const hours = Math.max((now - this.startedAt) / HOUR, 1 / 60);
    return {
      stats: this.stats,
      net: this.net,
      cards: this.cards.slice(-20),
      checklist: this.checklist,
      itemPrices: Object.fromEntries(this.itemPrices),
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
