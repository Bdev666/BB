const HUB = require('../core/hub');

// ---------- skill spam: press the chosen hotbar keys (1-9) over and over, like a player tapping them ----------
// The game's AUTO keeps choosing targets and walking; the keys only make the chosen skills go off the moment they are
// ready (AUTO waits between skills). Keys go in as real key presses (they reach a hidden window too: tested).
// It presses only while AUTO fights: not dead, not asleep, not on a trip (travel, way back, crowd move …), and never
// while a text box in the game has the cursor (chat), so nothing gets typed into a message.
const DEFAULT = { on: false, slots: [], everyMs: 300 };
HUB.spamCfg = (id) => ({ ...DEFAULT, ...(((HUB.store.data.spam || {})[id]) || {}) });
HUB.spamSet = (id, cfg) => {
  const all = HUB.store.data.spam || (HUB.store.data.spam = {});
  const c = {
    on: !!cfg.on,
    slots: [...new Set((cfg.slots || []).map(Number).filter((n) => n >= 1 && n <= 9))].sort((a, b) => a - b),
    everyMs: Math.max(150, Math.min(2000, Number(cfg.everyMs) || 300)),
  };
  all[id] = c; HUB.store.save();
  HUB.log.info(`acc ${id}: skill spam ${c.on ? 'on' : 'off'} · keys ${c.slots.join(',') || '-'} · every ${c.everyMs} ms`);
  HUB.pushState();
  return c;
};
const TYPING_JS = `(() => { const a = document.activeElement; return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable); })()`;
// why the keys wait right now ('' = press): only while AUTO fights, alive, awake, not on a trip of any kind
HUB.spamPause = function spamPause(g) {
  const st = (g.data && g.data.stats) || {};
  if (!g.inGame || g.demo || g.status !== 'online' || !g.win || (g.win.isDestroyed && g.win.isDestroyed())) return 'เกมไม่ออนไลน์';
  if (st.dead) return 'ตายอยู่';
  if (st.sleeping) return 'พักจออยู่';
  if (!st.auto) return 'AUTO ปิด';
  if (g.travelling) return 'กำลังเดินทาง';
  const dr = HUB.driverOf ? HUB.driverOf(g) : null;
  if (dr && dr !== 'boss' && dr !== 'bounty') return 'กำลังทำ ' + dr;
  return '';
};
HUB.spamTick = function spamTick() {
  const now = Date.now();
  for (const [id, g] of HUB.games) {
    const c = HUB.spamCfg(id);
    if (!c.on || !c.slots.length) { g.spamState = ''; continue; }
    let why = HUB.spamPause(g);
    if (!why) {
      // the text-box check is a page call: once a second is enough (and it starts as "typing" = safe until known)
      if (!g.spamPage || now - g.spamPage.at > 1000) {
        if (!g.spamPage) g.spamPage = { at: now, typing: true }; else g.spamPage.at = now;
        g.win.webContents.executeJavaScript(TYPING_JS, true).then((t) => { g.spamPage = { at: Date.now(), typing: !!t }; }).catch(() => {});
      }
      if (g.spamPage.typing) why = 'มีช่องพิมพ์ในเกมเปิดอยู่';
    }
    g.spamState = why ? `พัก: ${why}` : 'กดอยู่';
    if (why || (g.spamAt && now - g.spamAt < c.everyMs)) continue;
    g.spamAt = now;
    const wc = g.win.webContents;
    try { for (const n of c.slots) { const k = String(n); wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); } } catch { /* window closing */ }
    g.spamPresses = (g.spamPresses || 0) + c.slots.length;
  }
};
