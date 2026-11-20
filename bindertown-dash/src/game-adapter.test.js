// Run: node src/game-adapter.test.js
const assert = require('assert');
const { parseMessage, ExpTracker } = require('./game-adapter');

assert.deepStrictEqual(
  parseMessage('{"type":"stats","player":{"name":"Aya","hp":120,"maxHp":200,"level":12}}'),
  [{ type: 'self', name: 'Aya', hp: 120, maxHp: 200, level: 12 }],
);
assert.deepStrictEqual(
  parseMessage('42["update",{"hp":5,"mp":7,"mapName":"The Vale"}]'),
  [{ type: 'self', hp: 5, sp: 7, map: 'The Vale' }],
);
assert.deepStrictEqual(parseMessage('{"hp":5}'), [], 'one stat alone is too weak a signal');
assert.deepStrictEqual(parseMessage('not json'), []);
assert.deepStrictEqual(parseMessage(new ArrayBuffer(4)), []);

const { AccountData } = require('./session-data');
const d = new AccountData();
d.ingest({ type: 'self', silver: 100, exp: 0, level: 1 });
d.ingest({ type: 'hit', target: 'Slime', dmg: 50, crit: true });
d.ingest({ type: 'kill', target: 'Slime', exp: 10, job: 1 });
d.ingest({ type: 'loot', item: 'Potion', qty: 2 });
d.ingest({ type: 'chat', channel: 'world', from: 'A', text: 'hi' });
const det = d.detail();
assert.strictEqual(det.events.length, 3);
assert.strictEqual(det.events[0].text, 'ตี Slime 50 (คริ)');
assert.strictEqual(det.bag[0].name, 'Potion');
assert.strictEqual(det.chat.length, 1);
assert.strictEqual(d.kills, 1);

const t = new ExpTracker();
t.add(1000, 5, 0);
assert.strictEqual(t.perHour(), null);
t.add(1500, 5, 30 * 60 * 1000);
assert.strictEqual(Math.round(t.perHour()), 1000);
t.add(10, 6, 31 * 60 * 1000);
assert.strictEqual(t.perHour(), null, 'resets on level up');

console.log('game-adapter tests passed');
