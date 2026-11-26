// The sleep-screen summary (Gold, deaths, level-ups, EXP, potions): plain logic, no game needed.
const assert = require('assert');
const path = require('path');
const { AccountData } = require(path.join(__dirname, '..', 'src', 'session-data.js'));
let n = 0; const ok = (name, fn) => { fn(); n++; };

ok('farm Gold counts small steps, leaves out jumps over 5M', () => {
  const d = new AccountData(); let t = 1000;
  const self = (silver) => d.ingest({ type: 'self', silver, t: (t += 1000) });
  self(1000000); self(1050000); self(1040000); // +50k kills, -10k potions
  self(201040000); // +200M: a market sale / mail -> left out
  self(201100000); // +60k
  const s = d.rates(t).session;
  assert.strictEqual(s.gold, 100000); assert.strictEqual(s.goldJumps, 1);
});
ok('Gold/hour = farm Gold since the game opened, like the sleep screen; nothing before 2 minutes', () => {
  const d = new AccountData(); const t0 = d.startedAt;
  d.ingest({ type: 'self', silver: 1000000, t: t0 + 1000 });
  d.ingest({ type: 'self', silver: 1100000, t: t0 + 60000 });
  assert.strictEqual(d.rates(t0 + 60000).goldPerHour, null);
  d.ingest({ type: 'self', silver: 1200000, t: t0 + 120000 });
  d.ingest({ type: 'self', silver: 900000000, t: t0 + 121000 }); // a market sale: not farming
  assert.strictEqual(Math.round(d.rates(t0 + 3600000).goldPerHour), 200000);
});
ok('one death counted once (the game sends two messages)', () => {
  const d = new AccountData();
  d.ingest({ type: 'death', t: 1000 }); d.ingest({ type: 'death', t: 1500 }); d.ingest({ type: 'death', t: 9000 });
  assert.strictEqual(d.rates(10000).session.deaths, 2);
});
ok('level-ups from the game message, EXP never negative', () => {
  const d = new AccountData();
  d.ingest({ type: 'kill', target: 'x', exp: 500, job: 10, silver: 5, t: 1000 });
  d.ingest({ type: 'kill', target: 'x', exp: -90000, job: 3, silver: 5, t: 2000 }); // the bar started over
  d.ingest({ type: 'levelUp', level: 25, t: 2000 });
  const s = d.rates(3000).session;
  assert.strictEqual(s.exp, 500); assert.strictEqual(s.job, 13); assert.strictEqual(s.levels, 1); assert.strictEqual(s.kills, 2);
});
ok('potions used = what left the bag, sales taken back out', () => {
  const d = new AccountData();
  const bag = (q, t) => d.ingest({ type: 'bag', items: [{ name: 'โพชั่น', qty: q, supply: true, ids: [{ id: 'potion', qty: q }] }], t });
  bag(100, 1000); bag(95, 2000); bag(90, 3000);
  d.ingest({ type: 'sold', id: 'potion', item: 'โพชั่น', qty: 4, silver: 40, t: 3500 }); bag(86, 3600);
  assert.strictEqual(d.rates(4000).session.potions, 10 + 4 - 4);
});
console.log(`session-data tests passed (${n})`);
