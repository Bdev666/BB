const HUB = require('../core/hub');

// ---------- respawn in place when dead while hidden (Premium) ----------
// The game has its own "Auto Respawn" option (AUTO settings, Premium): dying in a field map with AUTO on
// = up again on the spot for a Gold fee. BinderDash ticks that option for every account (through the
// game's own checkbox, so the game saves it and tells the server), and as a backup presses the game's
// respawn button when a hidden character still lies dead (other maps, AUTO off).
const AUTO_RESPAWN_JS = (premium) => `(() => { const c = document.getElementById('au-respawn'); if (!c) return { ok: false, why: 'none' };
  if (c.checked) return { ok: true, on: true };
  let unlocked = false; if (c.disabled) { if (!${premium ? 'true' : 'false'}) return { ok: false, why: 'premium' }; c.disabled = false; unlocked = true; }
  c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true, on: c.checked, changed: true, unlocked }; })()`;
// death loop: up on the spot, killed again, again (seen: 8 deaths in a minute, 5,000 G each).
// 4 deaths within 2 minutes = turn the game's "respawn in place" off for this account for 10 minutes,
// so the next death goes back to town like normal, and say so
HUB.deathLoopCheck = function deathLoopCheck() { /* removed in 1.5.1 at the player's request: always respawn at once */ };
async function ensureAutoRespawn(id) {
  const g = HUB.games.get(id);
  if (!g || !g.inGame || g.demo || !g.win || g.win.isDestroyed()) return;
  if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return; // death loop pause
  if (g.autoRespawnAt && Date.now() - g.autoRespawnAt < 60000) return;
  g.autoRespawnAt = Date.now();
  const premium = g.data.stats.premium === true || (g.data.premiumUntil && g.data.premiumUntil > Date.now());
  let r; try { r = await g.win.webContents.executeJavaScript(AUTO_RESPAWN_JS(premium), true); } catch { return; }
  const before = g.autoRespawn && g.autoRespawn.on;
  g.autoRespawn = r;
  if (r.changed) { HUB.log.info(`acc ${id}: turned on the game's Auto Respawn (respawn in place)${r.unlocked ? ' · its box was greyed out by the game (drawn before Premium was known)' : ''}`); g.data.log('other', '↺ เปิด "เกิดที่เดิมอัตโนมัติ" ของเกมคืนให้แล้ว'); }
  if (!r.ok && r.why === 'premium' && !g.autoRespawnWarned) { g.autoRespawnWarned = true; HUB.log.info(`acc ${id}: Auto Respawn needs Premium`); }
  if (before !== r.on) HUB.pushState();
}
// Press the death screen's "respawn here" button right away. The game's own Auto Respawn waits about
// 3 s and only works in field maps with AUTO on; boss maps / world bosses never get up by themselves
// (there the button is free). Same price as the game's own (5,000 G in fields, free at world bosses).
const RESPAWN_HERE_JS = `(() => { const o = document.getElementById('deathoverlay'); const shown = !!(o && getComputedStyle(o).display !== 'none');
  let me = null; try { me = window.__game && window.__game.me(); } catch {}
  const meDead = !!(me && (me.state === 'dead' || me.hp <= 0));
  if (shown && me && !meDead && me.hp > 0) { o.style.display = 'none'; return { dead: false, stale: true }; } // alive behind a left-over death screen
  const dead = shown || meDead;
  if (!dead) return { dead: false };
  const h = shown ? document.getElementById('drespawnhere') : null;
  if (!h) return { dead: true, waiting: true }; // the death screen comes ~2 s after the death
  const free = /ฟรี|free/i.test(h.textContent || ''); if (h.disabled) return { dead: true, disabled: true, free, why: h.title || '' };
  h.click(); return { dead: true, clicked: true, free }; })()`;
// on a death: send the same "respawn here" the button sends at once (the button itself only shows ~2 s
// later), then keep looking every 0.3 s and press the button when it is there, until up
HUB.backupRespawn = function backupRespawn(id, delay = 150) {
  if (HUB.store.data.settings.autoRespawnHere === false) return;
  const g = HUB.games.get(id); if (!g || g.demo || g.respawnPending) return;
  g.respawnPending = true;
  setTimeout(async () => {
    g.respawnPending = false;
    if (!g.win || g.win.isDestroyed()) return;
    if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return; // death loop pause: let it go to town
    let r; try { r = await g.win.webContents.executeJavaScript(RESPAWN_HERE_JS, true); } catch { r = null; }
    if (!r) { g.respawnTries = (g.respawnTries || 0) + 1; if (g.respawnTries < 40) HUB.backupRespawn(id, 300); return; } // page busy: look again, do not give up
    if (r.stale) { HUB.log.info(`acc ${id}: death screen left over while alive -> closed it`); HUB.selftest.count(id, 'staleDeathScreen'); if (g.autoAtDeath || g.bossTrip) setTimeout(async () => { if (!(await HUB.liveUi(id)).auto) HUB.gameCommand(id, 'auto', {}); }, 800); }
    if (!r.dead) { if (g.respawnTries) HUB.log.info(`acc ${id}: up again after ${((Date.now() - (g.deadSince || g.lastDeathAt || Date.now())) / 1000).toFixed(1)} s`); g.respawnTries = 0; return; } // up already
    const since = ((Date.now() - (g.deadSince || g.lastDeathAt || Date.now())) / 1000).toFixed(1);
    if (!g.respawnTries || (g.respawnTries % 5 === 0 && !r.clicked)) { // at once, then again every ~1.5 s while still down
      await HUB.sendInput(id, { type: 'respawn', here: true });
      g.respawnSends = (g.respawnSends || 0) + 1;
      if (!g.respawnTries) { HUB.selftest.count(id, 'respawnPress'); HUB.log.info(`acc ${id}: dead -> sent respawn here after ${since} s`); }
    }
    if (r.free) g.freeRespawnAt = Date.now();
    if (r.clicked && !g.respawnClicked) { g.respawnClicked = true; HUB.log.info(`acc ${id}: still dead -> pressed the respawn-here button${r.free ? ' (free)' : ''} after ${since} s`); }
    else if (r.disabled && !g.respawnWhy) { g.respawnWhy = true; HUB.log.info(`acc ${id}: respawn here not possible: ${r.why || 'button off'}`); }
    g.respawnTries = (g.respawnTries || 0) + 1;
    if (g.respawnTries < 40) HUB.backupRespawn(id, 300); // up to ~12 s, then the 15 s check takes over
    else g.respawnTries = 0;
  }, delay);
};
async function liveDead(id) {
  const g = HUB.games.get(id);
  // a death screen over a living character counts too: backupRespawn closes it
  try { return await g.win.webContents.executeJavaScript(`(() => { try { const o = document.getElementById('deathoverlay'); if (o && getComputedStyle(o).display !== 'none') return true; const m = window.__game && window.__game.me(); return !!(m && (m.state === 'dead' || m.hp <= 0)); } catch { return false; } })()`, true); } catch { return false; }
}
HUB.autoRespawnTick = function autoRespawnTick() {
  if (HUB.store.data.settings.autoRespawnHere === false) return;
  for (const [id, g] of HUB.games) {
    if (!g.inGame || g.demo) continue;
    ensureAutoRespawn(id);
    // a death the event stream missed: look at the screen too
    liveDead(id).then((dead) => { if (dead) HUB.backupRespawn(id, 0); else if (!g.respawnPending) g.respawnTries = 0; });
  }
};
