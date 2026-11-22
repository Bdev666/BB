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
assert.strictEqual(pretty('frost_fang'), 'Frost Fang');
assert.strictEqual(pretty('potion~2'), 'โพชั่น');

const ad = new BinderTownAdapter();
// page snapshot gives the session id, the character and the mobs around
let ev = ad.snapshot({
  ready: true, sessionId: 'me1',
  self: { name: '666', job: 'mage', level: 116, jobLevel: 70, hp: 6207, maxHp: 6561, mp: 166, maxMp: 182, xp: 5000, silver: 353200, str: 99, x: 10, y: 12, state: 'idle' },
  mobs: { m1: ['frost_fang', 115, 11, 12, 'idle', ''], pet: ['wolf', 1, 10, 12, 'idle', 'me1'] },
  players: [[3, 4, 'Other']], mapId: 'frostpeak_slopes', xpText: 'Lv 116  ·  EXP 97.30%', jobText: 'JOB 70 · 100.00%', mini: 'data:image/png;base64,AAAA',
});
const self = ev.find((e) => e.type === 'self');
assert.strictEqual(self.expPct, 97.3);
assert.strictEqual(self.sp, 166);
assert.strictEqual(self.maxSp, 182);
assert.strictEqual(self.job, 'Mage');
assert.strictEqual(self.dead, false);
const world = ev.find((e) => e.type === 'world');
assert.strictEqual(world.monsters.length, 1, 'own pet is not a monster');
assert.ok(ev.find((e) => e.type === 'minimap'));

// packed hit from me, my pet's hit, a mob hitting me, a miss, a crit
ev = ad.incoming(frame('server', [[1, 'm1', 19025, 'crit', 'me1', 'bolt'], [1, 'm1', 500, '', 'pet'], [1, 'me1', 300, '', 'm1'], [1, 'm1', 0, 'miss', 'me1']]));
assert.deepStrictEqual(ev.map((e) => e.type), ['hit', 'hit', 'hurt', 'miss']);
assert.strictEqual(ev[0].target, 'Frost Fang');
assert.strictEqual(ev[0].crit, true);
assert.strictEqual(ev[0].skill, 'Spirit Bolt');
assert.strictEqual(ev[2].from, 'Frost Fang');

// the mob dies, then the kill reward
ev = ad.incoming(frame('server', [{ type: 'died', id: 'm1' }, { type: 'killGain', xp: [100, 18550], job: [0, 0], gold: [0, 120] }]));
assert.deepStrictEqual(ev, [{ type: 'kill', target: 'Frost Fang', exp: 18450, job: 0, silver: 120, t: ev[0].t }]);

// inventory: full, then a delta with a pickup and a used potion
ev = ad.incoming(frame('server', { type: 'inv', items: [{ id: 'potion', qty: 10 }, { id: 'hi_potion', qty: 2 }] }));
const strip = (items) => items.map(({ name, qty }) => ({ name, qty }));
assert.deepStrictEqual(strip(ev[0].items), [{ name: 'โพชั่น', qty: 10 }, { name: 'ไฮโพชั่น', qty: 2 }]);
assert.deepStrictEqual(ev[0].items[0].ids, [{ id: 'potion', qty: 10, gear: false, locked: false, bound: false }]);
// gear instances and locks
{
  const a2 = new BinderTownAdapter();
  const e2 = a2.incoming(frame('server', { type: 'inv', items: [{ id: 'chipped_blade#u1', qty: 1 }, { id: 'buckler#u2', qty: 1 }], locks: ['buckler#u2'] }));
  assert.deepStrictEqual(e2[0].items.map((i) => [i.name, i.ids[0].gear, i.ids[0].locked]), [['ดาบบิ่น', true, false], ['โล่จิ๋ว', true, true]]);
}
// grades as the game computes them, from real market ids
{
  const { rarityOf, baseOf, isSupply } = require('./game-adapter');
  assert.strictEqual(rarityOf('sword_t11|crit:7:6,int:8:12#78c8'), 'magic');
  assert.strictEqual(rarityOf('amulet_t12|hit:8:34,str:7:11,manatide:4:76#5c19'), 'rare');
  assert.strictEqual(rarityOf('ring_t10|int:8:13,crit:6:5,cdr:8:8,luk:6:9#ef36'), 'epic');
  assert.strictEqual(rarityOf('chipped_blade#u1'), 'normal');
  assert.strictEqual(rarityOf('dagger_t3|sharp:1:2#u'), 'magic', 'one classic affix');
  assert.strictEqual(rarityOf('dagger_t3|sharp:1:2,of_the_fox:1:2#u'), 'rare', 'two classic affixes');
  assert.strictEqual(baseOf('belt_t10*@58596069+10|hppct:6:20#58ba'), 'belt_t10');
  assert.strictEqual(baseOf('robe_t10^ins_shatterwall|p_bulwark:7:45#2abe'), 'robe_t10');
  assert.ok(isSupply('potion') && isSupply('high_ether') && isSupply('iron_arrow') && !isSupply('staff_t10|a:1:1#x') && !isSupply('drop_sprout'));
  // market item view -> price for that kind + grade (cheapest now, like the market board)
  const a6 = new BinderTownAdapter();
  const ev6 = a6.incoming(frame('server', { type: 'marketItem', view: { key: 'robe_t10|epic', itemId: 'robe_t10|p_gust:4:21,bossres:8:8,dex:7:13,magicres:3:5#e316', low: 10000, last: 450000, vol7: 61, stock: 56 } }));
  assert.deepStrictEqual([ev6[0].item, ev6[0].price, ev6[0].basis, ev6[0].key], ['เสื้อคลุมผู้คุมหุบเขา (Epic)', 10000, 'listed', 'robe_t10|epic']);
  // auto-sold gear is 'sold', not 'used': no "runs out" clock for gear
  const a7 = new BinderTownAdapter();
  const d7 = new AccountData(); d7.startedAt = 1;
  for (const x of a7.incoming(frame('server', { type: 'inv', items: [{ id: 'staff_t10|a:1:1,b:1:1#s1', qty: 1 }, { id: 'potion', qty: 50 }] }), 2)) d7.ingest(x);
  for (const x of a7.incoming(frame('server', [{ type: 'autoSold', itemId: 'staff_t10|a:1:1,b:1:1#s1', qty: 1 }, { type: 'inv', d: 1, items: [{ id: 'potion', qty: 20 }], gone: ['staff_t10|a:1:1,b:1:1#s1'] }]), 3600 * 1000)) d7.ingest(x);
  const rows = d7.bagRows(1);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.minutesLeft != null]), [['โพชั่น', true]], 'only the potion gets a clock; sold staff is gone');
}
ev = ad.incoming(frame('server', { type: 'inv', d: 1, items: [{ id: 'potion', qty: 9 }, { id: 'stone_maul', qty: 1 }], gone: ['hi_potion'] }));
assert.deepStrictEqual(ev.map((e) => e.type), ['loot', 'bag']);
assert.strictEqual(ev[0].item, 'ค้อนหิน');
assert.deepStrictEqual(strip(ev[1].items), [{ name: 'โพชั่น', qty: 9 }, { name: 'ค้อนหิน', qty: 1 }]);
assert.strictEqual(ev[0].worthChecking, true, 'non-drop, non-supply loot gets a market check');

// chat, whisper, party invite, death, ping
ev = ad.incoming(frame('server', [
  { type: 'chat', id: 'x', name: 'Pooh', channel: 'world', guild: '420power', text: 'hi [[0]]', items: ['fly_wing'] },
  { type: 'chat', id: 'x', name: 'Mika', channel: 'whisper', text: 'psst' },
  { type: 'socialInvite', kind: 'party', from: 'Six', partyName: 'GODZONE' },
  { type: 'youDied', cause: { kind: 'mob', mobType: 'frost_wisp' } },
]));
assert.strictEqual(ev[0].text, 'hi [Fly Wing]');
assert.strictEqual(ev[0].guild, '420power');
assert.strictEqual(ev[1].channel, 'whisper');
assert.strictEqual(ev[2].type, 'party');
assert.deepStrictEqual([ev[3].type, ev[3].by], ['death', 'Frost Wisp']);
ad.outgoing(frame('input', { type: 'ping', t: 1234.5 }), 1000);
ev = ad.incoming(frame('server', { type: 'pong', t: 1234.5, online: 7219 }), 1070);
assert.deepStrictEqual([ev[0].ping, ev[0].online], [70, 7219]);

// session data turns events into the dashboard's numbers
const d = new AccountData();
d.ingest({ type: 'self', silver: 100, xp: 0, level: 1, expPct: 10 });
d.ingest({ type: 'hit', target: 'Sprout', dmg: 50, crit: true });
d.ingest({ type: 'kill', target: 'Sprout', exp: 10, job: 1, silver: 5 });
d.ingest({ type: 'loot', item: 'โพชั่น', qty: 2 });
d.ingest({ type: 'bag', items: [{ name: 'โพชั่น', qty: 2, ids: [{ id: 'potion', qty: 2 }] }] });
d.ingest({ type: 'chat', channel: 'world', from: 'A', text: 'hi' });
d.ingest({ type: 'net', ping: 69.6, online: 7211 });
const det = d.detail();
assert.strictEqual(det.events.length, 3);
assert.strictEqual(det.events[0].text, 'ตี Sprout 50 (คริ)');
assert.strictEqual(det.bag[0].name, 'โพชั่น');
// potion clock: 60 used in an hour with 30 left -> 30 minutes
const d4 = new AccountData(); d4.startedAt = 1;
d4.ingest({ type: 'bag', items: [{ name: 'โพชั่น', qty: 90, supply: true }], t: 2 });
d4.ingest({ type: 'bag', items: [{ name: 'โพชั่น', qty: 30, supply: true }], t: 3600 * 1000 });
d4.ingest({ type: 'market', item: 'โพชั่น', price: 7, t: 3 });
const pot = d4.bagRows(1)[0];
assert.strictEqual(Math.round(pot.minutesLeft), 30);
assert.strictEqual(pot.market, 7);
// buying 99 more does not hide the use: still 60/h, now 129 left -> ~129 minutes
d4.ingest({ type: 'bag', items: [{ name: 'โพชั่น', qty: 129, supply: true }], t: 3600 * 1000 + 1 });
assert.strictEqual(Math.round(d4.bagRows(1)[0].minutesLeft), 129);
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
assert.strictEqual(dropPrice('sprout', 2, 1.4714772602586597), 3, 'shop pays price / sqrt(econ index): 54 Sprout drops sold for 162 in the live game');
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
d3.ingest({ type: 'kill', target: 'Sprout', exp: 1, silver: 60, t: 4 });
d3.ingest({ type: 'self', silver: 20, t: 3600 * 1000 + 1 }); // spent on potions: income stays what the kills paid
const r3 = d3.rates(3600 * 1000 + 1);
assert.strictEqual(r3.silverToday, 60, 'silver from kills only');
assert.strictEqual(r3.silverNet, -80, 'net change still known');
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
ev = ad.incoming(frame('server', [{ type: 'sold', itemId: 'drop_sprout', qty: 5, silver: 20 }, { type: 'marketGuide', itemId: 'mana_potion', listed: [300], sales: [] }, { type: 'pass', premiumUntil: 123 }]));
assert.deepStrictEqual(ev.map((e) => e.type), ['sold', 'market', 'premium']);
assert.strictEqual(ev[1].price, 300);

// game version / read health
{
  const a3 = new BinderTownAdapter();
  assert.strictEqual(a3.health().ok, true);
  a3.incoming(frame('server', { type: 'pong', t: 1, build: '20991231-000000' }));
  assert.deepStrictEqual([a3.health().build, a3.health().knownBuild, a3.health().ok], ['20991231-000000', false, true], 'new build that reads fine: info only');
  a3.snapshot({ ready: true, sessionId: 's', self: { name: 'x', level: 1 }, mobs: {}, players: [], xpText: '' });
  const h = a3.health();
  assert.strictEqual(h.ok, false);
  assert.ok(h.problems[0].includes('hp') && h.problems[0].includes('EXP%'), 'missing fields are named');
  for (let i = 0; i < 5; i++) a3.incoming(frame('server', [[99, 'x']]));
  assert.ok(a3.health().problems.some((p) => p.includes('รูปแบบข้อความใหม่')), 'unknown packed codes counted');
}
// bosses
{
  const a4 = new BinderTownAdapter();
  const e4 = a4.incoming(frame('server', [
    { type: 'worldBossTop', kind: 'nacreon', boss: 'Pearlheart Titan', top: [] },
    { type: 'fieldBosses', now: 1000, list: [{ pin: 'ember_hollow', type: 'cinder_plume_roc', until: 61000, killer: 'A' }, { pin: 'riverside', type: 'bloom_crowned_stag', until: 0 }] },
    { type: 'worldBoss', view: { kind: 'nacreon', state: 'live', frac: 0.2, fighters: 355, startAt: 5, endsAt: 9, nextAt: 0 } },
  ]), 2000);
  assert.deepStrictEqual(e4[0].list.map((b) => [b.name, b.map, b.until]), [['Cinder Plume Roc', 'ember_hollow', 62000], ['Bloom Crowned Stag', 'riverside', 0]], 'server time shifted to ours');
  assert.deepStrictEqual([e4[1].name, e4[1].state, e4[1].fighters], ['Pearlheart Titan', 'live', 355]);
}

// daily checklist, world events, new message types
{
  const a5 = new BinderTownAdapter();
  const e5 = a5.incoming(frame('server', [
    { type: 'pass', state: { day: '2026-11-21', daily: { login: 1, kills: 40, gathers: 3 }, dailyDone: ['login'], weekly: { wlogin: 2 }, weeklyDone: [] }, premiumUntil: 0 },
    { type: 'mail', list: [{ title: 'gift', items: [{ item: 'x', qty: 1 }], claimed: false, read: false }, { title: 'news', items: [], claimed: false, read: true }, { title: 'old', items: [{ item: 'y', qty: 1 }], claimed: true, read: true }] },
    { type: 'hunt', view: { bounty: { prog: { a: 1 }, claimed: ['b', 'c'] } } },
    { type: 'hotWeek', now: { id: 'h1', name: 'ชดเชย', pct: { xp: 100, drop: 50, gold: 0 }, endInMs: 3600000 }, next: null, fresh: false },
    { type: 'randomEvent', id: 'golden_hour', leftMs: 1500000, fresh: true },
    { type: 'brandNewThing', foo: 1, bar: 2 },
  ]), 1000);
  const byType = (t) => e5.filter((x) => x.type === t);
  const pass = byType('pass')[0];
  assert.deepStrictEqual(pass.daily.map((x) => [x.id, x.prog, x.claimed, x.ready]), [['login', 1, true, false], ['kills', 40, false, true], ['gathers', 3, false, false], ['crafts', 0, false, false]]);
  assert.strictEqual(byType('premium')[0].until, 0, 'premium still read from pass');
  assert.deepStrictEqual([byType('mail')[0].gifts, byType('mail')[0].titles], [1, ['gift']]);
  assert.deepStrictEqual([byType('hunt')[0].claimed, byType('hunt')[0].active], [2, 1]);
  const ev = byType('worldEvent');
  assert.deepStrictEqual(ev[0].active.perks, ['EXP +100%', 'ดรอป +50%']);
  assert.deepStrictEqual([ev[1].active.name, ev[1].active.endsAt, ev[1].fresh], ['Golden Hour', 1501000, true]);
  assert.deepStrictEqual(byType('newType'), [{ type: 'newType', name: 'brandNewThing', fields: ['foo', 'bar'], t: 1000 }]);
  assert.strictEqual(a5.incoming(frame('server', { type: 'brandNewThing', foo: 3 })).filter((x) => x.type === 'newType').length, 0, 'reported once');
  const d5 = new AccountData();
  for (const x of e5) d5.ingest(x);
  assert.deepStrictEqual(d5.rewardsWaiting(), { pass: 1, mail: 1, total: 2 });
}

{
  const lr = new BinderTownAdapter().incoming(frame('server', { type: 'linkRequired', what: 'ลงขายในตลาดโลก' })).find((e) => e.type === 'marketResult');
  assert.ok(lr && lr.ok === false && lr.linkRequired && /ผูกบัญชี/.test(lr.reason), 'guest market listing is refused with a clear reason');
}

{
  const ml = new BinderTownAdapter().incoming(frame('server', { type: 'market', mine: [7], listings: [{ id: 7, itemId: 'robe#a', qty: 1, price: 5 }, { id: 8, itemId: 'x', qty: 1, price: 1 }] })).find((e) => e.type === 'myListings');
  assert.deepStrictEqual(ml.list, [{ id: 7, itemId: 'robe#a', qty: 1, price: 5 }], 'own listings picked out of the board');
}

{
  // the game lists locks by the item's "#uuid" part: a locked piece must show as locked
  const a = new BinderTownAdapter();
  const ev2 = a.incoming(frame('server', { type: 'inv', items: [{ id: 'cat_ears#abc', qty: 1 }, { id: 'beanie#def', qty: 1 }], locks: ['#abc'], bound: ['#def'] }));
  const bag = ev2.find((e) => e.type === 'bag');
  const ids = bag.items.flatMap((i) => i.ids);
  assert.deepStrictEqual(ids.map((x) => [x.id, x.locked, x.bound]), [['cat_ears#abc', true, false], ['beanie#def', false, true]], 'locks/bound by #uuid');
  assert.ok(a.locks.has('cat_ears#abc') && !a.locks.has('beanie#def'));
}

console.log('game-adapter tests passed');
