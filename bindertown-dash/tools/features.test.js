// Tests for the automation decisions that need no game: they run with a plain shared object (HUB) and fake accounts.
const assert = require('assert');
const path = require('path');
const HUB = require(path.join(__dirname, '..', 'src', 'core', 'hub'));
HUB.store = { data: { settings: {} }, save() {} };
HUB.log = { info() {}, warn() {}, error() {} };
HUB.pushState = () => {};
require(path.join(__dirname, '..', 'src', 'features', 'combat')); // WORLD_ARENAS
require(path.join(__dirname, '..', 'src', 'features', 'spam'));
require(path.join(__dirname, '..', 'src', 'features', 'worldboss'));
let n = 0;
const t = (name, fn) => { fn(); n++; };

// ---- skill spam: presses only while AUTO fights ----
const acc = (over = {}) => ({ inGame: true, status: 'online', win: { isDestroyed: () => false }, data: { stats: { auto: true, dead: false, sleeping: false } }, ...over });
HUB.driverOf = (g) => g.driver || null;
t('spam presses while AUTO farms', () => assert.strictEqual(HUB.spamPause(acc()), ''));
t('spam waits when AUTO is off', () => assert.strictEqual(HUB.spamPause(acc({ data: { stats: { auto: false } } })), 'AUTO ปิด'));
t('spam waits when dead', () => assert.strictEqual(HUB.spamPause(acc({ data: { stats: { auto: true, dead: true } } })), 'ตายอยู่'));
t('spam waits while travelling', () => assert.strictEqual(HUB.spamPause(acc({ travelling: { to: 'x' } })), 'กำลังเดินทาง'));
t('spam waits on the way back after a boss', () => assert.strictEqual(HUB.spamPause(acc({ driver: 'bossReturn' })), 'กำลังทำ bossReturn'));
t('spam runs at a world boss and on a bounty', () => { assert.strictEqual(HUB.spamPause(acc({ driver: 'boss' })), ''); assert.strictEqual(HUB.spamPause(acc({ driver: 'bounty' })), ''); });
t('spam waits when the game is not online', () => assert.strictEqual(HUB.spamPause(acc({ status: 'disconnected' })), 'เกมไม่ออนไลน์'));
t('spam settings are cleaned', () => { const c = HUB.spamSet(1, { on: true, slots: [4, 2, 2, 12, 0, '9'], everyMs: 10 }); assert.deepStrictEqual(c, { on: true, slots: [2, 4, 9], everyMs: 150 }); assert.deepStrictEqual(HUB.spamCfg(1).slots, [2, 4, 9]); });

// ---- world boss: where to come back to ----
t('boss origin: where it stands', () => assert.deepStrictEqual(HUB.bossOrigin({}, 'bellglass_cathedral', { x: 5, y: 6 }), { from: 'bellglass_cathedral', x: 5, y: 6 }));
t('boss origin: two bosses back to back keep the farm spot, not the map passed through', () => {
  const g = { loopBack: { why: 'boss', map: 'bellglass_cathedral', x: 38, y: 93, arrived: false } };
  assert.deepStrictEqual(HUB.bossOrigin(g, 'crown_of_tides', { x: 15, y: 35 }), { from: 'bellglass_cathedral', x: 38, y: 93 });
});
t('boss origin: a way back that arrived is old news', () => {
  const g = { loopBack: { why: 'boss', map: 'bellglass_cathedral', x: 38, y: 93, arrived: true } };
  assert.deepStrictEqual(HUB.bossOrigin(g, 'drowned_forum', { x: 1, y: 2 }), { from: 'drowned_forum', x: 1, y: 2 });
});
t('boss origin: already in the arena keeps the trip start', () => {
  const g = { bossTrip: { from: 'drowned_forum', x: 30, y: 26 } };
  assert.deepStrictEqual(HUB.bossOrigin(g, 'rootfall_barrow', { x: 0, y: 0 }), { from: 'drowned_forum', x: 30, y: 26 });
});
// ---- world boss: the town to warp to first ----
t('town before a world boss: the region town, or the one the game used last time', () => {
  assert.strictEqual(HUB.townFor('bellglass_cathedral'), 'tidehaven');
  assert.strictEqual(HUB.townFor('duskgate_pass'), 'ashford');
  HUB.store.data.bossTowns = { bellglass_cathedral: 'crown_of_tides' };
  assert.strictEqual(HUB.townFor('bellglass_cathedral'), 'crown_of_tides');
  assert.strictEqual(HUB.townFor('valebrook'), 'valebrook');
  assert.ok(HUB.isTown('tidehaven') && !HUB.isTown('drowned_forum'));
});
// ---- Premium: the player's tick wins, else what the game says, unknown = Premium ----
require(path.join(__dirname, '..', 'src', 'features', 'premium'));
t('premium: auto follows the game, unknown counts as Premium, the tick overrides', () => {
  const accs = [{ id: 1 }, { id: 2, premium: 'no' }, { id: 3, premium: 'yes' }];
  HUB.account = (id) => accs.find((a) => a.id === id);
  const g = (p) => ({ data: { stats: { premium: p }, premiumUntil: null } });
  assert.strictEqual(HUB.isPremium(1, g(undefined)), true);
  assert.strictEqual(HUB.isPremium(1, g(false)), false);
  assert.strictEqual(HUB.isPremium(1, g(true)), true);
  assert.strictEqual(HUB.isPremium(2, g(true)), false);
  assert.strictEqual(HUB.isPremium(3, g(false)), true);
});
// ---- farm ledger: a minute of spending is not farming ----
t('farm ledger leaves out a minute where Silver fell by 41M', () => {
  require(path.join(__dirname, '..', 'src', 'features', 'farm'));
  HUB.store.data.farm = {}; HUB.WORLD_ARENAS = HUB.WORLD_ARENAS || new Set();
  const g = { accId: 2, inGame: true, demo: false, data: { stats: { level: 111, silver: 1000000000, map: 'gullrock_rookery' } } };
  HUB.mapOf = (x) => x.data.stats.map;
  HUB.farmEvent(2, g, { type: 'kill', silver: 100 }); HUB.farmBalance(g);
  g.data.stats.silver -= 41000000; HUB.farmBalance(g); // a refine / market buy in the same minute
  g.ledger.m -= 1; HUB.farmBalance(g); // next minute closes this one
  assert.strictEqual((HUB.store.data.farm['2:gullrock_rookery'] || []).length, 0);
});
// ---- settings and learned data are saved apart (config.json small, stats.json the rest); an old config hands them over ----
t('store: stats move out of config.json and come back on load', () => {
  const fs = require('fs'); const os = require('os');
  const { Store } = require(path.join(__dirname, '..', 'src', 'store'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-store-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ accounts: [{ id: 1, name: 'a' }], settings: {}, fights: [{ mob: 'x' }], calib: { k: 1 } }));
  let st = new Store(d); st.save();
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.fights, undefined); assert.strictEqual(cfg.calib, undefined); assert.strictEqual(cfg.accounts.length, 1);
  st = new Store(d);
  assert.deepStrictEqual(st.data.fights, [{ mob: 'x' }]); assert.deepStrictEqual(st.data.calib, { k: 1 });
  fs.rmSync(d, { recursive: true, force: true });
});
console.log(`feature tests passed (${n})`);
