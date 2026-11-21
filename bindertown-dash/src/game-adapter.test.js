// Run: node src/game-adapter.test.js
const assert = require('assert');
const { pack } = require('msgpackr');
const { decodeFrame, BinderTownAdapter, pretty } = require('./game-adapter');
const { AccountData, ExpTracker } = require('./session-data');

// Build a Colyseus ROOM_DATA frame the way the server does: 13, schema string type, msgpack payload
function frame(type, message) {
  const t = Buffer.from(type, 'utf8');
  return Buffer.concat([Buffer.from([13, 0xa0 | t.length]), t, pack(message)]);
}

assert.deepStrictEqual(decodeFrame(frame('server', { type: 'pong', t: 5, online: 7228 })), { type: 'server', message: { type: 'pong', t: 5, online: 7228 } });
assert.strictEqual(decodeFrame(Buffer.from([14, 1, 2])), null, 'state patches are not ROOM_DATA');
assert.strictEqual(pretty('cosmic_warden'), 'Cosmic Warden');
assert.strictEqual(pretty('yellow_potion~2'), 'Yellow Potion');

const ad = new BinderTownAdapter();
// page snapshot gives the session id, the character and the mobs around
let ev = ad.snapshot({
  ready: true, sessionId: 'me1',
  self: { name: '666', job: 'kensei', level: 116, jobLevel: 70, hp: 6207, maxHp: 6561, mp: 166, maxMp: 182, xp: 5000, silver: 353200, str: 99, x: 10, y: 12, state: 'idle' },
  mobs: { m1: ['cosmic_warden', 115, 11, 12, 'idle', ''], pet: ['wolf', 1, 10, 12, 'idle', 'me1'] },
  players: [[3, 4, 'Other']], mapId: 'starfall_ruins', xpText: 'Lv 116  ·  EXP 97.30%', jobText: 'JOB 70 · 100.00%', mini: 'data:image/png;base64,AAAA',
});
const self = ev.find((e) => e.type === 'self');
assert.strictEqual(self.expPct, 97.3);
assert.strictEqual(self.sp, 166);
assert.strictEqual(self.maxSp, 182);
assert.strictEqual(self.job, 'Kensei');
assert.strictEqual(self.dead, false);
const world = ev.find((e) => e.type === 'world');
assert.strictEqual(world.monsters.length, 1, 'own pet is not a monster');
assert.ok(ev.find((e) => e.type === 'minimap'));

// packed hit from me, my pet's hit, a mob hitting me, a miss, a crit
ev = ad.incoming(frame('server', [[1, 'm1', 19025, 'crit', 'me1', 'iaigiri'], [1, 'm1', 500, '', 'pet'], [1, 'me1', 300, '', 'm1'], [1, 'm1', 0, 'miss', 'me1']]));
assert.deepStrictEqual(ev.map((e) => e.type), ['hit', 'hit', 'hurt', 'miss']);
assert.strictEqual(ev[0].target, 'Cosmic Warden');
assert.strictEqual(ev[0].crit, true);
assert.strictEqual(ev[0].skill, 'Iaigiri');
assert.strictEqual(ev[2].from, 'Cosmic Warden');

// the mob dies, then the kill reward
ev = ad.incoming(frame('server', [{ type: 'died', id: 'm1' }, { type: 'killGain', xp: [100, 18550], job: [0, 0], gold: [0, 120] }]));
assert.deepStrictEqual(ev, [{ type: 'kill', target: 'Cosmic Warden', exp: 18450, job: 0, silver: 120, t: ev[0].t }]);

// inventory: full, then a delta with a pickup and a used potion
ev = ad.incoming(frame('server', { type: 'inv', items: [{ id: 'yellow_potion', qty: 10 }, { id: 'refine_stone', qty: 2 }] }));
const strip = (items) => items.map(({ name, qty }) => ({ name, qty }));
assert.deepStrictEqual(strip(ev[0].items), [{ name: 'Yellow Potion', qty: 10 }, { name: 'Refine Stone', qty: 2 }]);
assert.deepStrictEqual(ev[0].items[0].ids, [{ id: 'yellow_potion', qty: 10 }]);
ev = ad.incoming(frame('server', { type: 'inv', d: 1, items: [{ id: 'yellow_potion', qty: 9 }, { id: 'warden_shard', qty: 1 }], gone: ['refine_stone'] }));
assert.deepStrictEqual(ev.map((e) => e.type), ['loot', 'bag']);
assert.strictEqual(ev[0].item, 'Warden Shard');
assert.deepStrictEqual(strip(ev[1].items), [{ name: 'Yellow Potion', qty: 9 }, { name: 'Warden Shard', qty: 1 }]);
assert.strictEqual(ev[0].worthChecking, true, 'non-drop, non-supply loot gets a market check');

// chat, whisper, party invite, death, ping
ev = ad.incoming(frame('server', [
  { type: 'chat', id: 'x', name: 'Pooh', channel: 'world', guild: '420power', text: 'hi [[0]]', items: ['fly_wing'] },
  { type: 'chat', id: 'x', name: 'Mika', channel: 'whisper', text: 'psst' },
  { type: 'socialInvite', kind: 'party', from: 'Six', partyName: 'GODZONE' },
  { type: 'youDied', cause: { kind: 'mob', mobType: 'star_raider' } },
]));
assert.strictEqual(ev[0].text, 'hi [Fly Wing]');
assert.strictEqual(ev[0].guild, '420power');
assert.strictEqual(ev[1].channel, 'whisper');
assert.strictEqual(ev[2].type, 'party');
assert.deepStrictEqual([ev[3].type, ev[3].by], ['death', 'Star Raider']);
ad.outgoing(frame('input', { type: 'ping', t: 1234.5 }), 1000);
ev = ad.incoming(frame('server', { type: 'pong', t: 1234.5, online: 7219 }), 1070);
assert.deepStrictEqual([ev[0].ping, ev[0].online], [70, 7219]);

// session data turns events into the dashboard's numbers
const d = new AccountData();
d.ingest({ type: 'self', silver: 100, xp: 0, level: 1, expPct: 10 });
d.ingest({ type: 'hit', target: 'Slime', dmg: 50, crit: true });
d.ingest({ type: 'kill', target: 'Slime', exp: 10, job: 1, silver: 5 });
d.ingest({ type: 'loot', item: 'Potion', qty: 2 });
d.ingest({ type: 'bag', items: [{ name: 'Potion', qty: 2, ids: [{ id: 'potion', qty: 2 }] }] });
d.ingest({ type: 'chat', channel: 'world', from: 'A', text: 'hi' });
d.ingest({ type: 'net', ping: 69.6, online: 7211 });
const det = d.detail();
assert.strictEqual(det.events.length, 3);
assert.strictEqual(det.events[0].text, 'ตี Slime 50 (คริ)');
assert.strictEqual(det.bag[0].name, 'Potion');
// potion clock: 60 used in an hour with 30 left -> 30 minutes
const d4 = new AccountData(); d4.startedAt = 1;
d4.ingest({ type: 'bag', items: [{ name: 'Potion', qty: 90 }], t: 2 });
d4.ingest({ type: 'bag', items: [{ name: 'Potion', qty: 30 }], t: 3600 * 1000 });
d4.ingest({ type: 'market', item: 'Potion', price: 7, t: 3 });
const pot = d4.bagRows(1)[0];
assert.strictEqual(Math.round(pot.minutesLeft), 30);
assert.strictEqual(pot.market, 7);
assert.deepStrictEqual(det.net, { ping: 70, online: 7211 });
assert.strictEqual(d.kills, 1);
// level ETA from EXP % growth: 10% -> 20% in 1h, at 20% => 8h left
const d2 = new AccountData();
d2.ingest({ type: 'self', level: 5, xp: 1000, expPct: 10, t: 1 });
d2.ingest({ type: 'self', level: 5, xp: 2000, expPct: 20, t: 3600 * 1000 + 1 });
const eta = d2.levelEta();
assert.strictEqual(Math.round(eta.levelEtaMs / 3600000), 8);
assert.strictEqual(Math.round(eta.expLeft), 8000);

const tr = new ExpTracker();
tr.add(1000, 5, 0);
assert.strictEqual(tr.perHour(), null);
tr.add(1500, 5, 30 * 60 * 1000);
assert.strictEqual(Math.round(tr.perHour()), 1000);
tr.add(10, 6, 31 * 60 * 1000);
assert.strictEqual(tr.perHour(), null, 'resets on level up');

// drop prices follow the game's formula; cards are counted
const { dropPrice } = require('./game-adapter');
assert.strictEqual(dropPrice('sprout'), 4, 'trash Lv 2: (3 + 1) x 1');
assert.strictEqual(dropPrice('storm_petrel'), 46, 'trash Lv 124: (3 + 62) x 0.7');
assert.strictEqual(dropPrice('elder_sprout'), 14, 'elite Lv 5: (3 + 2.5) x 2.5');
assert.strictEqual(dropPrice('unknown_mob', 10), 8, 'unknown: live level, trash');
ev = ad.incoming(frame('server', { type: 'inv', d: 1, items: [{ id: 'drop_sprout', qty: 3 }] }));
assert.deepStrictEqual([ev[0].item, ev[0].qty, ev[0].value], ['Sprout · เยลลี่ต้นอ่อน', 3, 12]);
assert.strictEqual(ev[0].value, 12);
ev = ad.incoming(frame('server', { type: 'cardFound', mob: 'sprout', level: 2 }));
assert.deepStrictEqual([ev[0].type, ev[0].mob], ['card', 'Sprout']);
const d3 = new AccountData();
d3.startedAt = 1;
d3.ingest({ type: 'self', silver: 100, t: 1 });
d3.ingest({ type: 'loot', item: 'X', qty: 3, value: 12, t: 2 });
d3.ingest({ type: 'card', mob: 'Sprout', level: 2, t: 3 });
d3.ingest({ type: 'self', silver: 160, t: 3600 * 1000 + 1 });
const r3 = d3.rates(3600 * 1000 + 1);
assert.strictEqual(Math.round(r3.dropValuePerHour), 12);
assert.strictEqual(r3.cards, 1);
assert.strictEqual(Math.round(r3.incomePerHour), 72, '60 silver + 12 drop value in an hour');

// commands are encoded exactly like the client's room.send("input", ...)
const { encodeInput, marketPrice } = require('./game-adapter');
const real = Buffer.from('0da5696e707574d4724092a474797065a174a470696e67cb40f0b37666666666', 'hex'); // recorded ping
assert.ok(encodeInput({ type: 'ping', t: decodeFrame(real).message.t }).equals(real));
// market: cheapest listing wins, else median of recent sales
assert.deepStrictEqual(marketPrice({ listed: [120, 90], sales: [] }), { price: 90, basis: 'listed', listed: 2 });
assert.strictEqual(marketPrice({ listed: [], sales: [{ t: Date.now(), unit: 10 }, { t: Date.now(), unit: 30 }, { t: Date.now(), unit: 20 }] }).price, 20);
assert.strictEqual(marketPrice({ listed: [], sales: [{ t: 0, unit: 10 }] }), null, 'sales older than 14 days ignored');
ev = ad.incoming(frame('server', [{ type: 'sold', itemId: 'drop_sprout', qty: 5, silver: 20 }, { type: 'marketGuide', itemId: 'warden_shard', listed: [300], sales: [] }, { type: 'pass', premiumUntil: 123 }]));
assert.deepStrictEqual(ev.map((e) => e.type), ['sold', 'market', 'premium']);
assert.strictEqual(ev[1].price, 300);

console.log('game-adapter tests passed');
