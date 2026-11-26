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
let chain = Promise.resolve(); const pending = []; const t = (name, fn) => { n++; chain = chain.then(() => fn()); pending.length = 0; pending.push(chain); }; // one after the other (some share HUB)

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
// ---- warps are paced together ----
t('warp gap: waits until the last warp is old enough, a named cooldown stretches it', async () => {
  require(path.join(__dirname, '..', 'src', 'features', 'commands'));
  HUB.sleep = HUB.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const g = { lastWarpAt: Date.now() - 3500 };
  const t0 = Date.now(); await HUB.warpGap(g, 4000); assert.ok(Date.now() - t0 >= 400 && Date.now() - t0 < 1500);
  const g2 = { lastWarpAt: Date.now() - 10000 }; const t1 = Date.now(); await HUB.warpGap(g2, 4000); assert.ok(Date.now() - t1 < 100);
});
// ---- turbo refine: next strike right after each result, stops at the target / a refusal / a drop ----
require(path.join(__dirname, '..', 'src', 'features', 'refine'));
const turbo = async (replies, opts) => {
  const g = { inGame: true, demo: false, status: 'online', win: { isDestroyed: () => false }, data: { stats: { silver: 1e9 } } };
  HUB.games = new Map([[7, g]]); HUB.notify = () => {}; HUB.pushState = () => {};
  HUB.pageRun = async () => ({ id: 'blacksmith', x: 1, y: 1, me: [1, 1] }); HUB.liveUi = async () => ({ auto: false }); HUB.gameCommand = async () => true; // already next to the smith
  const sent = []; let i = 0;
  HUB.sendInput = async (id, o) => { sent.push(o); const r = replies[i++]; if (r) setTimeout(() => HUB.refineResult(g, r), 5); return true; };
  const t0 = Date.now(); await HUB.refineStart(7, opts);
  for (let k = 0; k < 400 && g.turbo.running; k++) await new Promise((r) => setTimeout(r, 10));
  return { g, sent, ms: Date.now() - t0 };
};
t('turbo refine: strikes until the target, each right after the last result', async () => {
  const rs = [3, 4, 5].map((l) => ({ ok: true, itemId: `robe_t10+${l}#u`, level: l, reason: '' }));
  const { g, sent, ms } = await turbo(rs, { itemId: 'robe_t10+2#u', target: 5 });
  assert.strictEqual(g.turbo.level, 5, JSON.stringify(g.turbo)); assert.strictEqual(sent.length, 3); assert.strictEqual(sent[1].itemId, 'robe_t10+3#u'); assert.ok(ms < 1500, 'fast: ' + ms);
  assert.strictEqual(g.turbo.why, 'ถึง +5 แล้ว');
});
t('turbo refine: stops on a refusal and on a drop', async () => {
  let r = await turbo([{ ok: true, itemId: 'a+3#u', level: 3 }, { ok: false, itemId: 'a+3#u', level: 3, reason: 'Gold ไม่พอ' }], { itemId: 'a+2#u', target: 9 });
  assert.strictEqual(r.g.turbo.why, 'Gold ไม่พอ'); assert.strictEqual(r.g.turbo.n, 2);
  r = await turbo([{ ok: false, itemId: 'a+4#u', level: 4, reason: '' }], { itemId: 'a+5#u', target: 9, stopOnDrop: true });
  assert.ok(/ตก/.test(r.g.turbo.why)); assert.strictEqual(r.g.turbo.drop, 1);
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
Promise.all(pending).then(() => console.log(`feature tests passed (${n})`)).catch((e) => { console.error(e); process.exit(1); });
