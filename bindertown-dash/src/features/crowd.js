const HUB = require('../core/hub');

// ---------- crowded spot: move to the quietest channel of the same map, back to the same spot, AUTO on ----------
// Off by default. Counts other players inside the AUTO circle; N or more for M minutes while AUTO farms =
// ask the game for the players per channel (its own channel list), switch to the quietest normal one
// (never the PvP channel), walk back to where the character stood, AUTO on again. 10 minutes apart at least.
const PVP_CH = 10;
const CROWD_JS = `(() => { try { const g = window.__game; const me = g.me(); const st = g.state(); if (!me || !st) return null;
  const on = document.querySelector('#au-farm [data-farm].on'); const R = on ? Number(on.dataset.farm) || 0 : 16;
  let near = 0; st.players.forEach((p, id) => { if (p === me || (p.name && p.name === me.name)) return; if (R === 0 || Math.hypot(p.x - me.x, p.y - me.y) <= R) near++; });
  const ch = parseInt(((document.getElementById('chbtn') || {}).textContent || '').replace(/[^0-9]+/g, ' ').trim(), 10) || 0;
  return { near, R, ch, x: Math.round(me.x), y: Math.round(me.y), map: g.mapId() }; } catch (e) { return null; } })()`;
async function crowdCheck(id, g) {
  const s = HUB.store.data.settings;
  if (!s.crowdSwitch || !g.inGame || g.demo || g.status !== 'online' || !g.win || g.win.isDestroyed() || g.crowdBusy) return;
  if (HUB.driverOf(g)) { g.crowdSince = 0; g.crowdHist = []; return; } // only while the character just farms
  if (!(await HUB.liveUi(id)).auto) { g.crowdSince = 0; g.crowdHist = []; return; } // only while AUTO farms
  let c = await HUB.pageRun(g, CROWD_JS, 'CROWD_JS');
  if (!c || !c.ch || c.ch === PVP_CH) { g.crowdSince = 0; g.crowdHist = []; return; }
  const need = Math.max(1, Number(s.crowdPlayers) || 3);
  // most of the last N minutes, not every check: players walk in and out of the circle all the time, and one
  // quiet check used to start the count over (a log showed 4 players around for minutes and no move)
  const win = Math.max(1, Number(s.crowdMinutes) || 2) * 60000; const now0 = Date.now();
  const H = (g.crowdHist = (g.crowdHist || []).filter(([t]) => now0 - t <= win)); H.push([now0, c.near, c.ch]);
  if (H.some(([, , ch]) => ch !== c.ch)) { g.crowdHist = [[now0, c.near, c.ch]]; return; } // changed channel meanwhile
  const busy = H.filter(([, n]) => n >= need).length;
  if (c.near >= need && (!g.crowdLogAt || now0 - g.crowdLogAt > 60000)) { g.crowdLogAt = now0; HUB.log.info(`acc ${id}: ${c.near} other player(s) in the AUTO circle (CH ${c.ch}) · crowded ${busy}/${H.length} checks in the last ${Math.round((now0 - H[0][0]) / 60000)} min`); }
  if (now0 - H[0][0] < win * 0.85 || busy / H.length < 0.7 || c.near < need) return;
  g.crowdSince = H[0][0];
  if (g.crowdMovedAt && Date.now() - g.crowdMovedAt < 10 * 60000) return;
  g.crowdBusy = true;
  try {
    const asked = Date.now();
    await HUB.sendInput(id, { type: 'channelQuery' });
    for (let i = 0; i < 20 && !(g.channels && g.channels.at >= asked); i++) await HUB.sleep(250); // eslint-disable-line no-await-in-loop
    const counts = (g.channels && g.channels.at >= asked && g.channels.counts) || [];
    if (!counts.length) { HUB.log.info(`acc ${id}: crowded, but the channel list did not come`); return; }
    if (g.channels.lockMs > 30000) { HUB.log.info(`acc ${id}: crowded, channel change locked for ${Math.ceil(g.channels.lockMs / 1000)} s`); return; }
    if (g.channels.lockMs > 0) await HUB.sleep(g.channels.lockMs + 600); // the game's short lock after arriving
    const here = counts[c.ch - 1] ?? 999;
    let best = 0;
    for (let ch = 1; ch <= counts.length; ch++) { if (ch === c.ch || ch === PVP_CH) continue; if (!best || (counts[ch - 1] ?? 999) < (counts[best - 1] ?? 999)) best = ch; }
    if (!best || (counts[best - 1] ?? 999) > here - 2) { HUB.log.info(`acc ${id}: crowded, but no quieter channel (here ${here}, quietest CH ${best} ${counts[best - 1]})`); g.crowdMovedAt = Date.now(); return; }
    g.crowdMovedAt = Date.now(); g.crowdSince = 0; g.crowdHist = [];
    HUB.log.info(`acc ${id}: crowded (${c.near} in the circle, CH ${c.ch} ${here} players) -> CH ${best} (${counts[best - 1]} players), back to ${c.x},${c.y}`);
    await HUB.sendInput(id, { type: 'switchChannel', channel: best });
    // wait for the new channel, then walk back to the same spot and fight there again
    let now = null;
    for (let i = 0; i < 40; i++) { await HUB.sleep(1000); now = await HUB.pageRun(g, CROWD_JS, 'CROWD_JS'); if (now && now.ch === best && now.map === c.map) break; } // eslint-disable-line no-await-in-loop
    if (!now || now.ch !== best) {
      // not moved: try again in ~2 minutes, not 10 (a log: "did not change" at 12:39, the next try at 12:49, 3 players in the circle all that time)
      g.crowdMovedAt = Date.now() - 8 * 60000; g.crowdFails = (g.crowdFails || 0) + 1;
      if (g.crowdFails >= 4) { g.crowdMovedAt = Date.now(); g.crowdFails = 0; }
      HUB.log.info(`acc ${id}: channel did not change (still CH ${now && now.ch})`); return;
    }
    g.crowdFails = 0;
    if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); // off while walking back (it would fight on the way)
    for (let i = 0; i < 15; i++) { // eslint-disable-line no-await-in-loop
      let p = await HUB.pageRun(g, CROWD_JS, 'CROWD_JS'); // eslint-disable-line no-await-in-loop
      if (!p || Math.hypot(p.x - c.x, p.y - c.y) <= 3) break;
      await HUB.sendInput(id, { type: 'moveTo', x: c.x, y: c.y }); // eslint-disable-line no-await-in-loop
      await HUB.sleep(2000); // eslint-disable-line no-await-in-loop
    }
    if (!(await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
    HUB.selftest.count(id, 'crowdMoves');
    HUB.notify(id, 'crowd', `👥 คนเยอะ (${c.near} คนในวง) · ย้าย CH ${c.ch} → CH ${best} (${counts[best - 1]} คน) กลับจุดเดิมแล้วเปิด AUTO`);
  } catch (err) { HUB.log.warn(`acc ${id}: crowd move: ${err.message}`); } finally { g.crowdBusy = false; }
}
HUB.crowdTick = function crowdTick() { for (const [id, g] of HUB.games) crowdCheck(id, g).catch(() => {}); };
