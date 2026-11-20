// Run: node src/game-adapter.test.js
const assert = require('assert');
const { parseMessage, ExpTracker } = require('./game-adapter');

assert.deepStrictEqual(
  parseMessage('{"type":"stats","player":{"name":"Aya","hp":120,"maxHp":200,"level":12}}'),
  { name: 'Aya', hp: 120, maxHp: 200, level: 12 },
);
assert.deepStrictEqual(
  parseMessage('42["update",{"hp":5,"mp":7,"mapName":"The Vale"}]'),
  { hp: 5, sp: 7, map: 'The Vale' },
);
assert.strictEqual(parseMessage('{"hp":5}'), null, 'one stat alone is too weak a signal');
assert.strictEqual(parseMessage('not json'), null);
assert.strictEqual(parseMessage(new ArrayBuffer(4)), null);

const t = new ExpTracker();
t.add(1000, 5, 0);
assert.strictEqual(t.perHour(), null);
t.add(1500, 5, 30 * 60 * 1000);
assert.strictEqual(Math.round(t.perHour()), 1000);
t.add(10, 6, 31 * 60 * 1000);
assert.strictEqual(t.perHour(), null, 'resets on level up');

console.log('game-adapter tests passed');
