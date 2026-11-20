// Everything the dashboard knows about one account, built from normalized
// game events (see game-adapter.js for the event shapes).
const { ExpTracker } = require('./game-adapter');

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
    this.startedAt = Date.now();
    this.kills = 0;
    this.silverStart = null;
    this.dmgWindow = [];      // [{ t, dmg }] last 60s of damage dealt
    this.dmgTotal = 0;
    this.hits = 0;
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
        if (typeof rest.exp === 'number') this.expTracker.add(rest.exp, this.stats.level, t);
        if (typeof rest.silver === 'number' && this.silverStart === null) this.silverStart = rest.silver;
        break;
      }
      case 'buffs': this.buffs = ev.list || []; break;
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
        this.log('exp', `ล้ม ${ev.target}${ev.exp ? ` +${fmt(ev.exp)} EXP` : ''}${ev.job != null ? ` · +${fmt(ev.job)} Job` : ''}`, t);
        break;
      case 'loot': {
        this.log('loot', `เก็บ ${ev.item}${ev.qty > 1 ? ' x' + ev.qty : ''}`, t);
        const b = this.bagItem(ev.item, t);
        b.gained += ev.qty || 1;
        break;
      }
      case 'bag':
        for (const it of ev.items || []) {
          const b = this.bagItem(it.name, t);
          if (b.firstQty === null) b.firstQty = it.qty;
          b.qty = it.qty;
          if (it.icon) b.icon = it.icon;
        }
        break;
      case 'chat':
        this.chat.push({ t, channel: ev.channel || 'world', from: ev.from || '', guild: ev.guild || '', text: ev.text || '' });
        if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
        break;
      case 'world': this.world = { ...this.world, ...ev }; delete this.world.type; break;
      case 'info': this.log('other', ev.text, t); break;
      default: break;
    }
  }

  bagItem(name, t) {
    let b = this.bag.get(name);
    if (!b) { b = { qty: 0, firstQty: null, firstAt: t, gained: 0, watchBelow: null }; this.bag.set(name, b); }
    return b;
  }

  rates(now = Date.now()) {
    const hours = Math.max((now - this.startedAt) / HOUR, 1 / 60);
    this.dmgWindow = this.dmgWindow.filter((d) => now - d.t < 60 * 1000);
    const silver = this.stats.silver;
    return {
      playMs: now - this.startedAt,
      expPerHour: this.expTracker.perHour(),
      killsPerHour: this.kills / hours,
      silverPerHour: typeof silver === 'number' && this.silverStart !== null ? (silver - this.silverStart) / hours : null,
      silverToday: typeof silver === 'number' && this.silverStart !== null ? silver - this.silverStart : null,
      dpsNow: this.dmgWindow.reduce((s, d) => s + d.dmg, 0) / 60,
      avgHit: this.hits ? this.dmgTotal / this.hits : null,
    };
  }

  summary(now = Date.now()) {
    const s = this.stats;
    return {
      name: s.name, job: s.job, level: s.level, map: s.map,
      hp: s.hp, maxHp: s.maxHp, sp: s.sp, maxSp: s.maxSp, exp: s.exp, maxExp: s.maxExp,
      silver: s.silver, ...this.rates(now),
    };
  }

  detail(now = Date.now()) {
    const hours = Math.max((now - this.startedAt) / HOUR, 1 / 60);
    return {
      stats: this.stats,
      buffs: this.buffs,
      rates: this.rates(now),
      events: this.events.slice(-200),
      chat: this.chat.slice(-150),
      world: this.world,
      bag: [...this.bag.entries()].map(([name, b]) => ({
        name, qty: b.qty, icon: b.icon, gainedPerHour: b.gained / hours,
        usedPerHour: b.firstQty !== null ? Math.max(0, (b.firstQty + b.gained - b.qty) / hours) : 0,
      })),
    };
  }
}

function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : '?'; }

module.exports = { AccountData };
