// Demo mode: fake events so the dashboard can be previewed without the game.
// Nothing here talks to the game. Turned on in Settings › "โหมดตัวอย่าง".
const MONSTERS = ['Moss Brute', 'Willow Brute', 'Star Raider', 'Cosmic Warden'];
const ITEMS = ['Yellow Potion', 'Blue Potion', 'Copper Ore', 'Equipment Fragment', 'Refine Stone'];
const SKILLS = ['', '', 'Iaigiri', 'Issen'];
const CHANNELS = ['world', 'world', 'party', 'guild', 'whisper', 'system'];
const NAMES = ['Mika', 'Toon', 'Ploy', 'Arthit', 'Nok'];
const LINES = ['มีใครไปบอสไหม', 'ขายแร่ทองแดง', 'ปาร์ตี้ขาดฮีล 1', 'gg', 'แมพนี้มอนเยอะดี'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));

class DemoFeed {
  constructor(seed) {
    this.level = 40 + seed * 7;
    this.maxExp = 500000 * (seed + 1);
    this.exp = Math.floor(this.maxExp * 0.3);
    this.silver = 100000 * (seed + 1);
    this.hp = 3000; this.maxHp = 3000; this.sp = 180; this.maxSp = 180;
    this.bag = Object.fromEntries(ITEMS.map((n) => [n, rnd(10, 300)]));
    this.mobs = Array.from({ length: 14 }, () => ({ x: Math.random(), y: Math.random(), name: pick(MONSTERS) }));
    this.players = Array.from({ length: 4 }, () => ({ x: Math.random(), y: Math.random(), name: pick(NAMES) }));
    this.self = { x: 0.5, y: 0.5 };
    this.tickN = 0;
    this.name = ['Kenji', 'Somchai', 'Lina', 'Pim'][seed % 4];
    this.job = ['Kensei', 'Scout', 'Acolyte', 'Mage'][seed % 4];
  }

  tick() {
    const out = [];
    this.tickN++;
    const target = pick(MONSTERS);
    if (Math.random() < 0.85) {
      const crit = Math.random() < 0.2;
      out.push({ type: 'hit', target, dmg: rnd(100, 5000) * (crit ? 3 : 1), crit, skill: pick(SKILLS) });
    } else out.push({ type: 'miss', target });
    if (Math.random() < 0.2) {
      const dmg = rnd(20, 400);
      this.hp = Math.max(1, this.hp - dmg);
      out.push({ type: 'hurt', from: target, dmg });
    }
    if (Math.random() < 0.15) {
      const exp = rnd(5000, 20000);
      this.exp += exp;
      if (this.exp >= this.maxExp) { this.exp -= this.maxExp; this.level++; }
      out.push({ type: 'kill', target, exp, job: 0 });
      this.silver += rnd(50, 900);
      if (Math.random() < 0.6) {
        const item = pick(ITEMS);
        this.bag[item]++;
        out.push({ type: 'loot', item, qty: 1 });
      }
    }
    if (this.tickN % 10 === 0) {
      this.hp = Math.min(this.maxHp, this.hp + 400);
      this.bag['Yellow Potion'] = Math.max(0, this.bag['Yellow Potion'] - 1);
    }
    if (Math.random() < 0.08) {
      out.push({ type: 'chat', channel: pick(CHANNELS), from: pick(NAMES), guild: Math.random() < 0.5 ? 'Demo' : '', text: pick(LINES) });
    }
    for (const m of this.mobs) { m.x = clamp(m.x + (Math.random() - 0.5) * 0.02); m.y = clamp(m.y + (Math.random() - 0.5) * 0.02); }
    this.self.x = clamp(this.self.x + (Math.random() - 0.5) * 0.03);
    this.self.y = clamp(this.self.y + (Math.random() - 0.5) * 0.03);
    out.push({
      type: 'self', name: this.name, job: this.job, level: this.level, jobLevel: 50, hp: this.hp, maxHp: this.maxHp,
      sp: this.sp, maxSp: this.maxSp, exp: this.exp, maxExp: this.maxExp, silver: this.silver, gold: 260,
      str: 99, agi: 99, vit: 66, int: 1, dex: 30, luk: 1, map: 'Demo Vale Lv.40-50',
    });
    if (this.tickN % 5 === 1) {
      out.push({ type: 'bag', items: Object.entries(this.bag).map(([name, qty]) => ({ name, qty })) });
      out.push({ type: 'buffs', list: [{ name: 'EXP x2', until: Date.now() + 28 * 60 * 1000 }, { name: 'Drop x2', stacks: 1 }] });
      out.push({ type: 'world', w: 1, h: 1, self: { ...this.self }, monsters: this.mobs.map((m) => ({ ...m })), players: this.players, drops: [] });
    }
    return out;
  }
}

function clamp(v) { return Math.max(0.03, Math.min(0.97, v)); }

module.exports = { DemoFeed };
