// BinderDash: fan-made multi-account launcher + dashboard for Binder Town.
// Unofficial. Read-only: it watches the game, it never plays for you.
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage,
  powerSaveBlocker, shell, dialog, session,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const telegram = require('./telegram');
const icons = require('./icons');
const { BinderTownAdapter, SNAPSHOT_JS, encodeInput, POTIONS, KNOWN_BUILDS, MARKET_FILTER, rarityOf, baseOf, pretty } = require('./game-adapter');
const { AccountData } = require('./session-data');
const { DemoFeed } = require('./demo');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
const updater = require('./updater');
const log = require('./logger');

const DEFAULT_GAME_URL = 'https://play.bindertowngame.com/';
let gameUrl = DEFAULT_GAME_URL; // read from settings once at startup
const GAME_HOSTS = ['bindertowngame.com'];
const MAX_ACCOUNTS = 10;

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.fanmade.binderdash');
// Keep hidden/minimized game windows running at full speed
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let store;
let dashboard = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let sleepBlocker = null;
const games = new Map(); // accountId -> runtime state
let labMeRef = null;
const selftest = require('./selftest').create({
  games, log, store: () => store, version: () => app.getVersion(),
  salvageable: (...a) => salvageable(...a), tradableGear: (...a) => tradableGear(...a), priceGear: (...a) => priceGear(...a),
  salvageOpts: (...a) => salvageOpts(...a), salvageVerdict: (...a) => salvageVerdict(...a), sendInput: (...a) => sendInput(...a),
  runCommand: (...a) => runCommand(...a), MARKET_FILTER, labMe: (id) => (labMeRef ? labMeRef(id) : null),
  labPredict: (p) => labCall(`window.__bdLab.predict(${JSON.stringify(p)})`),
  // per character: real hit / formula hit (median over skills), eased in over time
  // kept apart for world bosses and everything else (the world boss takes damage differently from what the formula says)
  saveCalib: (id, c) => {
    const all = store.data.calib || (store.data.calib = {}); const key = `${id}:${c.kind || 'field'}`; const old = all[key];
    if (c.k < 0.2 || c.k > 8) { log.info(`calib acc ${id} ${c.kind}: x${c.k} ignored (out of range)`); return; }
    const ease = (a, b) => (a && b ? +(a * 0.6 + b * 0.4).toFixed(3) : b || a || null);
    if (c.d != null && (c.d < 0.2 || c.d > 20)) c.d = null; // whole-DPS ratio: real / formula (hits per second, focus, splash included)
    const relOf = (a, b) => { const out = { ...(a || {}) }; for (const [sid, x] of Object.entries(b || {})) out[sid] = out[sid] ? +(out[sid] * 0.6 + x * 0.4).toFixed(3) : x; return out; };
    if (c.pack != null && !(c.pack >= 1 && c.pack <= 8)) c.pack = null; // monsters really hit at once (from real DPS over the pack curve)
    // v3: class-2 traits are in the lab now; numbers learned without them start over
    all[key] = old && old.job === c.job && old.v === c.v ? { ...c, k: ease(old.k, c.k), d: ease(old.d, c.d), pack: ease(old.pack, c.pack), rel: relOf(old.rel, c.rel), runs: (old.runs || 1) + 1 } : { ...c, runs: 1 };
    // field monsters differ a lot (weak ones die in one hit, and overkill is not reported): also per monster
    if (c.kind !== 'world' && c.mob) { const mk = `${id}:mob:${c.mob}`; const om = all[mk]; all[mk] = om && om.job === c.job && om.v === c.v ? { ...c, k: ease(om.k, c.k), d: ease(om.d, c.d), pack: ease(om.pack, c.pack), rel: relOf(om.rel, c.rel), runs: (om.runs || 1) + 1 } : { ...c, runs: 1 }; }
    store.save();
  },
  onProgress: (st) => { for (const w of [dashboard, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('dash:selftest-step', st); },
});

// ---------- runtime state ----------
function blankRuntime() {
  return {
    win: null,
    status: 'closed', // closed | loading | online | disconnected | maintenance | crashed | offline
    sockets: new Set(),
    closedSince: null,
    lastMsgAt: null,
    data: new AccountData(),
    adapter: new BinderTownAdapter(),
    valuableWait: new Map(), // item name -> { qty } waiting for a market price
    pending: [], // central-market listings sent, waiting to show up (the market takes ~5 min)
    myListings: null, // last 'mine' list from the market board
    demo: null,
    alerts: new Set(), // active problems, e.g. 'disconnect', 'idle'
    loadedAt: null,
  };
}
function rt(id) {
  if (!games.has(id)) games.set(id, { ...blankRuntime(), accId: id });
  return games.get(id);
}
function account(id) { return store.data.accounts.find((a) => a.id === id); }

function publicState() {
  const now = Date.now();
  return {
    settings: { ...store.data.settings, telegram: { connected: !!(store.data.settings.telegram.token && store.data.settings.telegram.chatId) } },
    maxAccounts: MAX_ACCOUNTS,
    update: { ...updater.state(), current: app.getVersion() },
    bosses: bossView(),
    events: eventsView(),
    accounts: store.data.accounts.map((a) => {
      const g = rt(a.id);
      return {
        id: a.id,
        name: a.name,
        status: g.demo ? 'demo' : g.status,
        hidden: !!(g.win && !g.win.isVisible()),
        summary: g.data.summary(now),
        memoryMB: g.memoryMB || null,
        compat: g.inGame && !g.demo ? g.adapter.health() : null,
        bounty: bountyStatus(g),
        finder: finderStatus(g),
        driver: (() => { const d = driverOf(g); return d ? DRIVE_TH[d] : ''; })(),
        silverUpHr: (() => { const B = g.balHist; if (!B || B.length < 6) return null; const a = B[0]; const b = B[B.length - 1]; return { perHour: Math.round((b[1] - a[1]) / Math.max(1, b[0] - a[0]) * 60), minutes: b[0] - a[0] }; })(),
        farmNow: g.inGame && !g.demo ? (farmSummary(a.id, g.data.stats.level || 0, Math.floor(now / 60000) - 60).find((x) => x.map === mapOf(g)) || null) : null,
        deaths: deathCost(a.id, g),
        autoRespawn: g.autoRespawn ? { on: !!g.autoRespawn.on, why: g.autoRespawn.why || '', count: g.autoRespawns || 0 } : null,
        lastMsgAgo: g.lastMsgAt ? Math.round((now - g.lastMsgAt) / 1000) : null,
        alerts: [...g.alerts],
      };
    }),
  };
}

const visible = (w) => !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized();
let pushTimer = null;
let sleepMode = false; let sleepShown = [];
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    updateTray();
    logChanges();
    // nobody looking: don't build or send anything
    const targets = [dashboard, settingsWin].filter(visible);
    if (!targets.length) return;
    const st = publicState();
    for (const w of targets) w.webContents.send('dash:state', st);
  }, 250);
}

// ---------- notifications ----------
function notify(id, kind, text) {
  const s = store.data.settings;
  const group = kind.startsWith('item:') ? 'itemLow' : kind.startsWith('potion:') ? 'potion' : kind === 'weightFull' ? 'weight' : kind;
  if (s.notify[group] === false) return;
  // id null = about the game world (bosses), not one account
  const g = id == null ? null : rt(id);
  if (g && g.demo) return; // demo data never notifies
  // don't interrupt the account you're looking at right now
  if (g && g.win && !g.win.isDestroyed() && g.win.isVisible() && g.win.isFocused()) return;
  log.info(`notify ${id == null ? 'world' : 'acc ' + id} ${kind}`);
  const a = id == null ? null : account(id);
  const title = a ? (g.data.stats.name ? `${a.name} · ${g.data.stats.name}` : a.name) : 'BinderDash';
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: text, silent: !s.notify.sound, icon: nativeImage.createFromDataURL(icons.alert) });
    n.on('click', () => (id == null ? createDashboard() : showGame(id)));
    n.show();
  }
  telegram.send(s.telegram.token, s.telegram.chatId, `${title}: ${text}`).catch(() => {});
}

function setAlert(id, key, on, text) {
  const g = rt(id);
  if (on && !g.alerts.has(key)) {
    g.alerts.add(key);
    log.info(`acc ${id}: alert on ${key.replace(/:.*/, ':…')}`);
    g.alertSaid = g.alertSaid || new Map();
    const said = g.alertSaid.get(key);
    if (!(said && Date.now() - said < 15 * 60000 && /^(weight|weightFull|idle|potion|item)/.test(key))) { g.alertSaid.set(key, Date.now()); notify(id, key, text); }
  } else if (!on && g.alerts.has(key)) {
    g.alerts.delete(key);
    log.info(`acc ${id}: alert off ${key.replace(/:.*/, ':…')}`);
  }
  pushState();
}

// ---------- game windows ----------
function windowTitle(id) {
  const a = account(id);
  const n = rt(id).data.stats.name;
  return `${n ? `${a.name} · ${n}` : a.name} — Binder Town`;
}

// Put a game window over the middle of the Dashboard (unless the user has moved it themselves)
function placeOverDashboard(win) {
  if (!dashboard || dashboard.isDestroyed() || !dashboard.isVisible() || dashboard.isMinimized()) return;
  const d = dashboard.getBounds();
  const width = Math.min(1280, Math.round(d.width * 0.85));
  const height = Math.min(800, Math.round(d.height * 0.85));
  win.setBounds({ x: d.x + Math.round((d.width - width) / 2), y: d.y + Math.round((d.height - height) / 2), width, height });
}

function chromeUA(ua) {
  return ua.replace(/\sElectron\/\S+/, '').replace(/\s(bindertown-dash|BinderDash)\/\S+/i, '');
}

function isGameUrl(url) {
  try {
    const h = new URL(url).hostname;
    return GAME_HOSTS.some((g) => h === g || h.endsWith('.' + g));
  } catch { return false; }
}

function openGame(id, opts = {}) {
  const a = account(id);
  if (!a) return;
  const g = rt(id);
  if (g.win && !g.win.isDestroyed()) return showGame(id);
  g.demo = null;
  g.data.reset();
  g.adapter.reset();

  const win = new BrowserWindow({
    icon: APP_ICON,
    width: 1280,
    height: 800,
    show: false,
    title: windowTitle(id),
    autoHideMenuBar: true,
    backgroundColor: '#0b1220', // the game's own background: no white flash while loading
    webPreferences: {
      partition: `persist:acc-${id}`, // separate login/cookies per account
      preload: path.join(__dirname, 'preload-game.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck', // keep compiled game code: faster later opens
    },
  });
  g.win = win;
  g.userPlaced = false;
  placeOverDashboard(win);
  // "open hidden" (Settings): the game loads and plays without ever taking the screen
  const startHidden = !!(store.data.settings.openHidden || opts.hidden);
  if (!startHidden) {
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible() && !g.hiddenOnPurpose) win.show(); }, 3000);
  }
  g.hiddenOnPurpose = startHidden;
  win.on('moved', () => { g.userPlaced = true; });
  g.status = 'loading';
  g.alerts.clear();
  g.loadedAt = Date.now();
  updateSleepBlocker();

  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(windowTitle(id)); });
  win.on('close', (e) => {
    if (quitting) return;
    // X on a game window = leave the game (account stays in the list)
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['ปิดเกม', 'ซ่อนเกม', 'ยกเลิก'], defaultId: 1, cancelId: 2,
      message: `ปิดเกมของ ${a.name}?`, detail: 'ปิดเกม = ตัวละครออกจากเกม · ซ่อนเกม = เกมเล่นต่อ แค่ซ่อนหน้าต่าง',
    });
    if (choice === 1) { e.preventDefault(); win.hide(); pushState(); }
    else if (choice === 2) e.preventDefault();
  });
  win.on('closed', () => {
    games.set(id, blankRuntime());
    updateSleepBlocker();
    pushState();
  });
  // hidden/minimized: tell the page it's in the background (Page Visibility), so the game
  // drops to its own background frame rate — the same thing it does in a hidden browser
  // tab. AUTO keeps going; timers stay unthrottled by the app's switches.
  const background = (on) => {
    win.webContents.executeJavaScript(`(() => {
      if (!window.__bdVis) {
        window.__bdVis = { h: false };
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__bdVis.h });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__bdVis.h ? 'hidden' : 'visible') });
      }
      if (window.__bdVis.h !== ${on}) { window.__bdVis.h = ${on}; document.dispatchEvent(new Event('visibilitychange')); }
    })()`, true).catch(() => {});
    pushState();
  };
  win.webContents.on('did-finish-load', () => { if (!win.isVisible() || win.isMinimized()) background(true); });
  win.on('show', () => background(false));
  win.on('restore', () => background(false));
  win.on('hide', () => background(true));
  win.on('minimize', () => background(true));
  if (startHidden) background(true);

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (isGameUrl(url) || /accounts\.google\.com|facebook\.com|discord\.com\/oauth2/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }; // login popups share the account's session
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') { toggleDashboard(); e.preventDefault(); }
    else if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (((input.control || input.meta) && input.key.toLowerCase() === 'r') || input.key === 'F5') { wc.reload(); e.preventDefault(); }
  });
  wc.on('did-navigate', (_e, _url, code) => {
    if (code === 503) {
      g.status = 'maintenance';
      setAlert(id, 'maintenance', true, 'เกมปิดปรับปรุง (maintenance)');
    } else {
      setAlert(id, 'maintenance', false);
    }
    pushState();
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (isMain && code !== -3) { g.status = 'offline'; pushState(); }
  });
  wc.on('render-process-gone', (_e, details) => {
    log.error(`acc ${id}: game page gone: ${details.reason} (exit ${details.exitCode})`);
    g.status = 'crashed';
    setAlert(id, 'crash', true, `หน้าเกมหยุดทำงาน (${details.reason})`);
    if (details.reason !== 'clean-exit') scheduleReload(id, 'หน้าเกมหยุดทำงาน', 5000);
  });
  wc.on('unresponsive', () => {
    setAlert(id, 'crash', true, 'หน้าเกมค้าง ไม่ตอบสนอง');
    g.hangSince = Date.now();
  });
  wc.on('responsive', () => { g.hangSince = 0; setAlert(id, 'crash', false); });
  wc.on('did-start-loading', () => { g.sockets.clear(); g.loadedAt = Date.now(); });

  attachWatcher(id, wc);
  win.loadURL(gameUrl);
  pushState();
}

// Watch the game's WebSocket traffic through the DevTools protocol (read-only).
function attachWatcher(id, wc) {
  const g = rt(id);
  const dbg = wc.debugger;
  try { dbg.attach('1.3'); } catch (err) { log.error(`acc ${id}: debugger attach failed`, err); return; }
  // small buffers: we only need WebSocket frames, not response bodies kept in memory
  dbg.sendCommand('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 }).catch(() => {});
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.webSocketCreated') {
      g.sockets.add(params.requestId);
      g.closedSince = null;
    } else if (method === 'Network.webSocketClosed') {
      g.sockets.delete(params.requestId);
      if (g.sockets.size === 0) g.closedSince = Date.now();
    } else if (method === 'Network.webSocketFrameReceived') {
      onFrame(id, params.response);
    } else if (method === 'Network.webSocketFrameSent') {
      // only used to time the game's own pings (read-only)
      if (params.response.opcode === 2) rt(id).adapter.outgoing(Buffer.from(params.response.payloadData, 'base64'));
    }
  });
  dbg.on('detach', (_e, reason) => log.warn(`acc ${id}: debugger detached: ${reason}`));
}

function onFrame(id, frame) {
  const g = rt(id);
  g.lastMsgAt = Date.now();
  if (g.status !== 'online') { g.status = 'online'; }
  if (g.alerts.has('disconnect')) setAlert(id, 'disconnect', false);

  if (store.data.settings.debugCapture) capture(id, frame);
  // the game talks Colyseus over binary frames (opcode 2, base64 from the DevTools protocol)
  if (frame.opcode !== 2) return pushState();
  try {
    handleEvents(id, g.adapter.incoming(Buffer.from(frame.payloadData, 'base64')));
  } catch (err) {
    log.once(`decode:${id}`, 60000, 'error', `acc ${id}: frame decode failed`, err);
  }
  pushState();
}

// Read the game's own state (window.__game) once a second: character, mobs, minimap. Read-only.
let watchedId = null; // account the dashboard is showing (gets the minimap)
async function pollSnapshots() {
  if (process.env.BD_NO_SNAPSHOT) return; // diagnostics only: measure a game page with nothing read from it
  const looking = visible(dashboard);
  const now = Date.now();
  for (const [id, g] of openGames()) {
    if (g.snapshotBusy || g.status === 'maintenance' || g.status === 'crashed') continue;
    // dashboard closed: every 3 s is plenty for alerts
    // every second only for the account open in the Dashboard; the others (and all when nobody looks) every 3 s:
    // each read runs inside the game page, so fewer reads = smoother games
    if ((!looking || sleepMode || id !== watchedId) && g.lastSnapAt && now - g.lastSnapAt < 3000) continue;
    g.lastSnapAt = now;
    g.snapshotBusy = true;
    try {
      const wantMini = looking && id === watchedId;
      const snap = await g.win.webContents.executeJavaScript(`window.__bdWantMini=${wantMini};` + SNAPSHOT_JS, true);
      if (!g.win || g.win.isDestroyed()) continue;
      const prevName = g.data.stats.name;
      handleEvents(id, g.adapter.snapshot(snap));
      if (g.inGame && !g.demo) farmBalance(g);
      if (snap && snap.fps && g.win.isVisible() && !g.win.isMinimized()) {
        const P = g.perf || (g.perf = { n: 0, sum: 0, min: 999, worst: 0 });
        P.n++; P.sum += snap.fps.fps; P.min = Math.min(P.min, snap.fps.fps); P.worst = Math.max(P.worst, snap.fps.worstMs);
        if (snap.fps.worstMs >= 2000 && (!g.freezeLogAt || Date.now() - g.freezeLogAt > 60000)) { g.freezeLogAt = Date.now(); log.info(`acc ${id}: game window froze ${(snap.fps.worstMs / 1000).toFixed(1)} s (${snap.fps.fps} fps this second, ${g.memoryMB || '?'} MB)`); }
      }
      if (g.inGame && !g.demo && Number.isFinite(Number(g.data.stats.silver))) {
        const m = Math.floor(Date.now() / 60000); const B = g.balHist || (g.balHist = []);
        if (!B.length || B[B.length - 1][0] !== m) { B.push([m, Number(g.data.stats.silver)]); while (B.length > 61) B.shift(); }
      }
      if (snap && snap.ready) { if (!g.inGame) { g.inGameAt = Date.now(); setTimeout(() => uiCheck(id, g).catch(() => {}), 25000); } g.inGame = true; }
      else if (g.status === 'loading' && Date.now() - g.loadedAt > 5000) { g.status = 'lobby'; pushState(); }
      watchScreen(id, snap);
      if (g.data.stats.name !== prevName) g.win.setTitle(windowTitle(id));
    } catch { /* page reloading */ } finally {
      g.snapshotBusy = false;
    }
  }
  pushState();
}

const captureStreams = new Map();
function capture(id, frame) {
  let s = captureStreams.get(id);
  if (!s) {
    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    s = fs.createWriteStream(path.join(dir, `acc-${id}.jsonl`), { flags: 'a' });
    captureStreams.set(id, s);
  }
  const data = frame.payloadData || '';
  s.write(JSON.stringify({ t: Date.now(), op: frame.opcode, data: data.slice(0, 4000) }) + '\n');
}

function showGame(id) {
  const g = rt(id);
  if (!g.win || g.win.isDestroyed()) return openGame(id);
  if (g.win.isMinimized()) g.win.restore();
  if (!g.win.isVisible() && !g.userPlaced) placeOverDashboard(g.win);
  g.hiddenOnPurpose = false;
  g.win.show();
  g.win.focus();
}
function hideGame(id) {
  const g = rt(id);
  if (g.win && !g.win.isDestroyed()) g.win.hide();
}
function closeGame(id) {
  const g = rt(id);
  if (g.win && !g.win.isDestroyed()) g.win.destroy();
}
function openGames() {
  return [...games.entries()].filter(([, g]) => g.win && !g.win.isDestroyed());
}

// While a game is open, don't let Windows suspend the app when idle
function updateSleepBlocker() {
  const any = openGames().length > 0;
  if (any && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!any && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
}

// ---------- game events -> data + notifications ----------
function handleEvents(id, events) {
  const g = rt(id);
  const s = store.data.settings;
  for (const ev of events) {
    g.data.ingest(ev);
    farmEvent(id, g, ev);
    switch (ev.type) {
      case 'hit':
      case 'kill':
        g.lastHitAt = Date.now();
        // a real-DPS measurement is running: keep this character's own hits
        if (ev.type === 'hit') { fightHit(g, ev); selftest.combatHit(id, ev); abHit(g, ev); }
        if (ev.type === 'kill' && g.ab && g.ab.phase) abBucket(g).kills++;
        if (ev.type === 'kill' && g.fight && ev.target === pretty(g.fight.mob)) fightEnd(g, true);
        if (ev.type === 'hit' && g.measure && Date.now() < g.measure.until) { const m = g.measure; if (!m.first) m.first = Date.now(); m.last = Date.now(); m.hits.push({ dmg: ev.dmg, sid: ev.sid, mob: ev.mob, pet: ev.pet, crit: ev.crit }); }
        if (g.alerts.has('idle')) setAlert(id, 'idle', false);
        break;
      case 'humanCheck':
        g.humanCheck = true;
        setAlert(id, 'human', true, '🧩 เกมขอให้ยืนยันว่าเป็นคน · เปิดหน้าเกมแล้วทำให้เสร็จ (BinderDash ไม่ทำแทน)');
        break;
      case 'humanResult':
        if (ev.ok) { g.humanCheck = false; setAlert(id, 'human', false); }
        break;
      case 'self':
        if (typeof ev.weightPct === 'number') {
          // two steps: nearly full (default 90%) and full (default 95%: AUTO stops picking up loot)
          const w = ev.weightPct;
          if (w >= s.weightCriticalPct && !g.alerts.has('weightFull')) {
            setAlert(id, 'weightFull', true, `🎒 กระเป๋าเต็ม ${Math.round(w)}% · เก็บของไม่ได้แล้ว ขาย/ย่อย/ฝากของด่วน`);
          } else if (w >= s.weightFullPct && w < s.weightCriticalPct && !g.alerts.has('weight')) {
            setAlert(id, 'weight', true, `🎒 กระเป๋าหนัก ${Math.round(w)}% · ใกล้เต็ม`);
          }
          if (w < s.weightCriticalPct - 2 && g.alerts.has('weightFull')) setAlert(id, 'weightFull', false);
          if (w < s.weightFullPct - 5 && g.alerts.has('weight')) setAlert(id, 'weight', false);
        }
        if (ev.dead && !g.deadSince) g.deadSince = Date.now(); // a death the event stream missed
        if (ev.dead && !g.alerts.has('death') && Date.now() - g.deadSince > 10000) setAlert(id, 'death', true, 'ตัวละครตายค้าง (เกิน 10 วิ)');
        else if (ev.dead === false && g.alerts.has('death')) setAlert(id, 'death', false);
        if (ev.dead === false && g.deadSince && Date.now() - g.deadSince > 15000) g.deadSince = 0; // up (the revive message was missed)
        break;
      case 'death':
        g.autoAtDeath = !!g.data.stats.auto;
        { const n0 = Date.now(); g.deathLog = (g.deathLog || []).filter((t) => n0 - t < 3600000); if (!g.deathLog.length || n0 - g.deathLog[g.deathLog.length - 1] > 1500) g.deathLog.push(n0); }
        if (g.lastDeathAt && Date.now() - g.lastDeathAt < 1500) break; // the same death, second message
        g.lastDeathAt = Date.now(); g.deadSince = g.lastDeathAt;
        selftest.count(id, 'deaths');
        deathLoopCheck(id, g);
        // a death that gets up again in a few seconds is not news (it was 940 notifications in a few days):
        // the alert / notification only comes when it is still lying dead after 10 s
        clearTimeout(g.deathAlertTimer);
        { const by = ev.by; const at = g.deadSince;
          g.deathAlertTimer = setTimeout(() => { if (g.deadSince === at) setAlert(id, 'death', true, by ? `ตัวละครตายค้าง (เกิน 10 วิ) · โดย ${by}` : 'ตัวละครตายค้าง (เกิน 10 วิ)'); }, 10000); }
        g.respawnTries = 0; g.respawnClicked = false; g.respawnWhy = false; g.respawnSends = 0; // a new death: start over (send again)
        backupRespawn(id);
        break;
      case 'revive':
        if (g.respawnTries) selftest.count(id, 'respawnOk');
        g.respawnClicked = false; g.respawnWhy = false;
        setTimeout(() => backupRespawn(id, 0), 2500); // a death screen that shows up after the revive gets closed
        if (g.bossTrip && WORLD_ARENAS.has(mapOf(g)) && !g.bossWalking) { g.bossWalking = true; setTimeout(() => walkToBossThenAuto(id, g.bossTrip ? g.bossTrip.kind : '', true).catch(() => {}).finally(() => { g.bossWalking = false; }), 1200); }
        if (g.deadSince) { const ms = Date.now() - g.deadSince; selftest.count(id, 'revives'); selftest.count(id, 'deadMs', ms); log.info(`acc ${id}: up again after ${(ms / 1000).toFixed(1)} s${ev.here ? ' (the game\'s own)' : ''}`); g.deadSince = 0; } // how long it lay dead
        clearTimeout(g.deathAlertTimer);
        if (g.alerts.has('death')) setAlert(id, 'death', false);
        g.respawnTries = 0;
        if (ev.here) selftest.count(id, 'autoRespawned');
        if (ev.here) { g.autoRespawns = (g.autoRespawns || 0) + 1; log.info(`acc ${id}: respawned in place by the game's Auto Respawn (-${ev.fee} G)`); }
        break;
      case 'chat':
        if (ev.channel === 'whisper' && !ev.mine && !ev.backlog) notify(id, 'whisper', `กระซิบจาก ${ev.from}: ${ev.text}`);
        break;
      case 'party':
        notify(id, 'party', ev.text || `${ev.from} ชวน/ขอเข้าปาร์ตี้`);
        break;
      case 'card':
        notify(id, 'card', `🃏 ได้การ์ด ${ev.mob}${ev.level ? ` Lv ${ev.level}` : ''}`);
        break;
      case 'rareDrop':
        notify(id, 'rareDrop', `✨ ดรอปหายาก: ${ev.item}`);
        break;
      case 'loot':
        // something that isn't a plain monster drop: ask the market what it's worth, notify if it's worth it
        if (ev.worthChecking && ev.id) { g.valuableWait.set(ev.id, { qty: ev.qty, at: Date.now() }); requestPrice(id, ev.id); }
        break;
      case 'fieldBosses': onFieldBosses(ev.list); break;
      case 'myListings': onMyListings(id, ev.list); break;
      case 'marketResult': g.lastMarket = { ok: ev.ok, reason: ev.reason, at: Date.now() }; break;
      case 'worldEvent': onWorldEvent(ev); break;
      case 'newType':
        log.info(`acc ${id}: new server message type from the game: ${ev.name} (fields: ${ev.fields.join(', ') || '-'})`);
        break;
      case 'pass':
      case 'mail': {
        if (ev.type === 'mail') g.mailSeen = { giftIds: ev.giftIds || [], at: Date.now() };
        if (ev.type === 'pass') g.passSeen = { daily: ev.daily || [], weekly: ev.weekly || [], at: Date.now() };
        // once a day per account, when there is something new to collect. At midnight several pass / mail
        // messages come in a row (the count goes 1, 2, 3): wait 10 s and say it once with the total
        clearTimeout(g.rewardsTimer);
        g.rewardsTimer = setTimeout(() => {
          const w = g.data.rewardsWaiting();
          const day = new Date().toDateString();
          const [lastDay, lastCount] = (g.rewardsNotified || ':0').split(':');
          if (w.total > 0 && (lastDay !== day || w.total > Number(lastCount))) {
            g.rewardsNotified = `${day}:${w.total}`;
            notify(id, 'daily', `🎁 มีของรอรับ: ${[w.pass ? `ภารกิจ Pass ${w.pass}` : null, w.mail ? `จดหมาย ${w.mail} ฉบับ` : null].filter(Boolean).join(' · ')}`);
          }
        }, 10000);
        break;
      }
      case 'worldBoss': onWorldBoss(ev); break;
      case 'channels': g.channels = { counts: ev.counts, lockMs: ev.lockMs, at: Date.now() }; break;
      case 'hunt': g.hunt = { day: ev.day, prog: ev.progById || {}, claimed: ev.claimedIds || [], at: Date.now() }; break;
      case 'market': {
        let askedId = ev.id;
        if (ev.fromBoard && g.priceAsks && g.priceAsks.length) {
          // answers come back in the order asked: tie this answer to the bag piece that was asked
          const i = g.priceAsks.findIndex((a) => a.id === ev.id);
          const ask = i >= 0 ? g.priceAsks.splice(i, 1)[0] : g.priceAsks.shift();
          if (ask && ask.id !== ev.id && Date.now() - ask.at < 8000) {
            askedId = ask.id; selftest.count(id, 'priceRemapped');
            const copy = { ...ev, id: ask.id };
            for (const [, o] of games) o.data.ingest(copy);
          }
        }
        // prices are the same for every account on the server
        for (const [, other] of games) if (other !== g) other.data.ingest(ev);
        marketWatchSeen(ev);
        const wKey = g.valuableWait.has(ev.id) ? ev.id : askedId;
        const wait = g.valuableWait.get(wKey);
        if (wait) {
          g.valuableWait.delete(wKey);
          // the central market's price for this kind + grade (cheapest listing now, like the board),
          // never NPC prices; only from the threshold up (default 1,000,000 Gold)
          const G = (n) => Math.round(n).toLocaleString('en-US');
          log.info(`acc ${id}: market price ${ev.key || ev.id}: ${ev.price ?? '-'} G (${ev.basis || 'no data'})`);
          if (ev.price && ev.price * wait.qty >= s.valuableMinGold) {
            notify(id, 'valuable', `💰 ดรอป ${ev.item}${wait.qty > 1 ? ' x' + wait.qty : ''} · ตลาดกลาง${ev.basis === 'listed' ? 'ถูกสุด' : 'ขายล่าสุด'} ~${G(ev.price)} G${wait.qty > 1 ? '/ชิ้น' : ''}${ev.basis === 'listed' && ev.last ? ` · ขายจริงล่าสุด ${G(ev.last)} G` : ''}`);
          }
        }
        break;
      }
      case 'info':
        if (/^เลเวลอัป/.test(ev.text)) notify(id, 'levelUp', `🎉 ${ev.text}`);
        // only the server's notices answer a command (not our own level-up lines etc.)
        if (ev.notice) g.lastNotice = { text: ev.text, at: Date.now() };
        break;
      case 'bag':
        for (const it of ev.items || []) {
          const limit = s.itemWatch[it.name];
          const key = 'item:' + it.name;
          if (limit == null) { g.alerts.delete(key); continue; }
          if (it.qty < limit) setAlert(id, key, true, `${it.name} เหลือ ${it.qty} (ตั้งไว้ต่ำกว่า ${limit})`);
          else if (g.alerts.has(key)) setAlert(id, key, false);
        }
        break;
      default: break;
    }
  }
}

// ---------- commands from the Dashboard ----------
// Only what the player presses. Each goes out the way the game's own UI sends it:
// a click on the game's own button, the game's own window.__game helpers, or the
// same 'input' message the game client sends.
function sendInput(id, obj) {
  const g = rt(id);
  if (!g.win || g.win.isDestroyed()) return Promise.resolve(false);
  const b64 = encodeInput(obj).toString('base64');
  return g.win.webContents.executeJavaScript(`window.__bdSend ? window.__bdSend(${JSON.stringify(b64)}) : false`, true).catch(() => false);
}

const priceAsked = new Map(); // itemId -> time
function requestPrice(id, itemId, force = false) {
  const last = priceAsked.get(itemId) || 0;
  if (!force && Date.now() - last < 10 * 60 * 1000) return Promise.resolve(true);
  priceAsked.set(itemId, Date.now());
  // remember what was asked: the board may answer with its own id for the kind + grade (not the bag piece's id)
  const g = rt(id); g.priceAsks = (g.priceAsks || []).filter((a) => Date.now() - a.at < 8000); g.priceAsks.push({ id: itemId, at: Date.now() });
  // the market board's item view (kind + grade): what the game's market window asks for
  return sendInput(id, { ...MARKET_FILTER, type: 'marketItem', itemId, loff: 0 });
}

async function gameCommand(id, cmd, arg) {
  const r = await runCommand(id, cmd, arg);
  if (!r.ok || !['sell', 'sellEtc', 'chat', 'salvage'].includes(cmd)) return r;
  // the game answers refusals with a notice ("ซื้อ/ขายผ่าน HUD ได้เฉพาะ Premium ..."): pass it on
  const g = rt(id);
  const sentAt = Date.now();
  await new Promise((res) => setTimeout(res, 1500));
  if (g.lastNotice && g.lastNotice.at >= sentAt) return { ok: false, error: g.lastNotice.text };
  return r;
}

async function runCommand(id, cmd, arg) {
  const g = rt(id);
  if (!g.win || g.win.isDestroyed()) return { ok: false, error: 'เปิดเกมบัญชีนี้ก่อน' };
  if (!g.inGame) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
  const js = (code) => g.win.webContents.executeJavaScript(code, true).catch(() => false);
  const click = (sel) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent || x.id === 'autobig'); if (!b) return false; b.click(); return true; })()`);
  let ok = false;
  switch (cmd) {
    case 'auto':
    case 'sleep': {
      const before = await liveUi(id);
      ok = await click(cmd === 'auto' ? '#autobig' : '#autoeco');
      if (ok) {
        await new Promise((res) => setTimeout(res, 400));
        const after = await liveUi(id);
        Object.assign(g.data.stats, { auto: after.auto, sleeping: after.sleeping });
        if (cmd === 'auto' && after.auto === before.auto) return { ok: false, error: `เกมไม่${before.auto ? 'ปิด' : 'เปิด'} AUTO ให้ (เช่น อยู่ในเมือง ตัวละครตาย หรือกำลังวาร์ป)` };
      }
      break;
    }
    case 'respawn':
      // prefer the "here / in place" button, then any respawn button on the death screen
      // the game's death screen: #drespawnhere = up on the spot (Gold fee), the other button = back to town
      ok = await js(`(() => { const o = document.getElementById('deathoverlay'); if (!o || getComputedStyle(o).display === 'none') return false; const h = document.getElementById('drespawnhere'); if (h && !h.disabled) { h.click(); return true; } if (${arg.hereOnly ? 'true' : 'false'}) return false; const bs = [...o.querySelectorAll('button')].filter((b) => !b.disabled && b.id !== 'drespawnhere'); if (!bs[0]) return false; bs[0].click(); return true; })()`);
      break;
    case 'sell': {
      const qty = Math.max(1, Math.floor(Number(arg.qty) || 0));
      if (!/^[\w~#.:+^|$&!%@*-]+$/.test(arg.itemId || '')) return { ok: false, error: 'ไอเทมไม่ถูกต้อง' };
      ok = await js(`(window.__game && window.__game.sell) ? (window.__game.sell(${JSON.stringify(arg.itemId)}, ${qty}), true) : false`);
      break;
    }
    case 'sellNpc': {
      // chosen pieces (the dashboard's NPC sell window); never a locked one, whatever the list says
      const list = Array.isArray(arg.items) ? arg.items.slice(0, 300) : [];
      let n = 0;
      for (const it of list) {
        const itemId = String(it.itemId || ''); const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
        if (!/^[\w~#.:+^|$&!%@*-]+$/.test(itemId) || (g.adapter.locks && g.adapter.locks.has(itemId))) continue;
        // eslint-disable-next-line no-await-in-loop
        await js(`window.__game.sell(${JSON.stringify(itemId)}, ${qty}), true`); n++;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250));
      }
      log.info(`acc ${id}: sold ${n} item stack(s) to the NPC (chosen in the dashboard)`);
      ok = n > 0;
      break;
    }
    case 'sellEtc': {
      // every monster drop in the bag (ETC), one sell per stack, like the game's sell window
      const inv = g.adapter.inv ? [...g.adapter.inv] : [];
      const drops = inv.filter(([itemId, qty]) => /^drop_/.test(itemId) && qty > 0);
      if (!drops.length) return { ok: false, error: 'ไม่มีของดรอปในกระเป๋า' };
      for (const [itemId, qty] of drops) {
        // eslint-disable-next-line no-await-in-loop
        await js(`window.__game.sell(${JSON.stringify(itemId)}, ${qty}), true`);
      }
      ok = true;
      break;
    }
    case 'price': ok = await requestPrice(id, arg.itemId, true); break;
    case 'priceAll': {
      // ask the market about every tradable gear piece in the bag (one after another, like browsing)
      const ids = tradableGear(g);
      for (const itemId of ids) {
        // eslint-disable-next-line no-await-in-loop
        await requestPrice(id, itemId, true);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 350));
      }
      return { ok: true, count: ids.length };
    }
    case 'marketList': {
      // list one piece / stack on the central market at the price the player confirmed
      const itemId = String(arg.itemId || '');
      const unit = Math.floor(Number(arg.unitPrice) || 0);
      const have = g.adapter.inv ? g.adapter.inv.get(itemId) || 0 : 0;
      const qty = Math.max(1, Math.min(have, Math.floor(Number(arg.qty) || 1)));
      if (!have) return { ok: false, error: 'ไม่มีของชิ้นนี้ในกระเป๋าแล้ว' };
      if (g.adapter.locks.has(itemId)) return { ok: false, error: 'ของชิ้นนี้ล็อกไว้ในเกม' };
      if (g.adapter.bound.has(itemId)) return { ok: false, error: 'ของผูกตัว ลงขายไม่ได้' };
      if (unit < 1) return { ok: false, error: 'ใส่ราคาก่อน' };
      const sentAt = Date.now();
      if (!(await sendInput(id, { type: 'marketList', itemId, qty, price: qty * unit }))) return { ok: false, error: 'เกมยังไม่พร้อม' };
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 200));
        const m = g.lastMarket;
        if (m && m.at >= sentAt) {
          log.info(`acc ${id}: market list ${itemId.split(/[|#]/)[0]} x${qty} @ ${unit} -> ${m.ok ? 'listed' : 'refused: ' + m.reason}`);
          if (m.ok) addPending(g, itemId, qty, unit, true);
          return m.ok ? { ok: true, pending: true } : { ok: false, error: m.reason || 'ตลาดไม่รับรายการนี้' };
        }
        const n = g.lastNotice;
        if (n && n.at >= sentAt) return { ok: false, error: n.text };
      }
      // no answer yet: the market may still be working on it (listings show up ~5 min later).
      // If the piece left the bag it went to the market; either way it is rechecked later.
      const gone = !(g.adapter.inv && g.adapter.inv.get(itemId));
      addPending(g, itemId, qty, unit, gone);
      log.info(`acc ${id}: market list ${itemId.split(/[|#]/)[0]} x${qty} @ ${unit} -> no answer, ${gone ? 'left the bag' : 'still in bag'}; recheck later`);
      return { ok: true, pending: true, unsure: !gone };
    }
    case 'marketCancel': ok = await sendInput(id, { type: 'marketCancel', id: Number(arg.listingId) }); break;
    case 'buy': {
      // NPC shop potions only (the game's vendor list); the game charges Silver
      const p = POTIONS.find((x) => x.id === arg.itemId);
      const qty = Math.max(1, Math.min(999, Math.floor(Number(arg.qty) || 0)));
      if (!p) return { ok: false, error: 'ซื้อได้เฉพาะยาจากร้าน NPC' };
      // the shop takes at most 99 per purchase: buy in rounds and count what really arrived in the bag
      // every quality grade of this potion (potion, potion~1, potion~2): what the hotbar draws from
      const have = () => { let n = 0; if (g.adapter.inv) for (const [k, q] of g.adapter.inv) if (baseOf(k) === p.id) n += q || 0; return n; };
      const start = have();
      let left = qty; let reason = '';
      // keepSilver: never spend below this (auto-buy); the unit price is learned from the first round
      const keep = Math.max(0, Number(arg.keepSilver) || 0);
      const silverNow = async () => { try { return await g.win.webContents.executeJavaScript('(window.__game && window.__game.me() || {}).silver', true); } catch { return null; } };
      let unit = (p.price || 12) * 1.5;
      while (left > 0) {
        let n = Math.min(99, left);
        if (arg.keepSilver != null) {
          const sv = await silverNow(); // eslint-disable-line no-await-in-loop
          if (sv != null) n = Math.min(n, Math.floor((sv - keep) / unit));
          if (n <= 0) { reason = `เหลือ Silver ไม่เกินที่ตั้งเก็บไว้ (${keep.toLocaleString('en-US')})`; break; }
        }
        const svBefore = arg.keepSilver != null ? await silverNow() : null; // eslint-disable-line no-await-in-loop
        const before = have(); const sentAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        if (!(await sendInput(id, { type: 'vendorBuy', itemId: p.id, qty: n }))) { reason = 'เกมยังไม่พร้อม'; break; }
        let got = 0;
        for (let i = 0; i < 25 && !got; i++) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 120));
          got = have() - before;
          if (!got && g.lastNotice && g.lastNotice.at >= sentAt) { reason = g.lastNotice.text; break; }
        }
        if (got > 0 && svBefore != null) { const sv = await silverNow(); const u = sv != null ? (svBefore - sv) / got : 0; if (u >= (p.price || 1) * 0.3 && u <= (p.price || 1) * 10) unit = u; } // eslint-disable-line no-await-in-loop -- kills add Silver meanwhile: keep only a believable price
        if (got <= 0) { reason = reason || 'ร้านไม่ขายเพิ่ม (Silver ไม่พอ / กระเป๋าหนักเกิน / ต้องเป็น Premium หรืออยู่ใกล้ร้าน)'; break; }
        left -= got;
        if (got < n) { reason = 'ได้ไม่ครบรอบนี้ (Silver หรือน้ำหนักกระเป๋าไม่พอ)'; break; }
      }
      const bought = have() - start;
      log.info(`acc ${id}: buy ${p.id} x${qty} -> got ${bought}${reason ? ' (' + reason + ')' : ''}`);
      return bought > 0 ? { ok: true, bought, asked: qty, note: reason } : { ok: false, error: reason || 'ซื้อไม่สำเร็จ' };
    }
    case 'salvage': {
      // one or more gear pieces from the bag; locked ones are skipped like in the game
      const ids = (Array.isArray(arg.itemIds) ? arg.itemIds : [arg.itemId]).filter((x) => typeof x === 'string' && x.includes('#'));
      const usable = ids.filter((x) => !g.adapter.locks.has(x) && g.adapter.inv && g.adapter.inv.has(x));
      if (!usable.length) return { ok: false, error: 'ไม่มีของที่ย่อยได้ (ของที่ล็อกไว้จะไม่ถูกย่อย)' };
      for (const itemId of usable) {
        // eslint-disable-next-line no-await-in-loop
        ok = (await sendInput(id, { type: 'salvage', itemId })) || ok;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 250));
      }
      break;
    }
    case 'chat': {
      const text = String(arg.text || '').trim().slice(0, 200);
      const channel = ['world', 'map', 'party', 'guild', 'whisper', 'trade'].includes(arg.channel) ? arg.channel : 'map';
      if (!text) return { ok: false, error: 'ไม่มีข้อความ' };
      const msg = { type: 'chat', text, channel };
      if (channel === 'whisper') { if (!arg.to) return { ok: false, error: 'ใส่ชื่อคนที่จะกระซิบ' }; msg.to = String(arg.to).trim(); }
      ok = await sendInput(id, msg);
      break;
    }
    default: return { ok: false, error: 'ไม่รู้จักคำสั่ง' };
  }
  log.info(`acc ${id}: command ${cmd}${cmd === 'chat' ? ` (${arg.channel}, ${String(arg.text || '').length} chars)` : arg.itemId ? ` ${arg.itemId}` : ''} -> ${ok ? 'sent' : 'not sent'}`);
  return ok ? { ok: true } : { ok: false, error: 'เกมยังไม่พร้อม ลองใหม่อีกครั้ง' };
}

// ---------- auto reconnect ----------
// The game reconnects ordinary drops by itself. On top of that BinderDash reloads the game
// page (the same as the game's own "reconnect" buttons, which call __hardReload) when:
//   the game says the connection was cut (4008) · it stays disconnected or stuck too long ·
//   the page crashed. The game then signs back in by itself and resumes AUTO.
// It never reconnects when the character is playing elsewhere (4001), was disconnected by
// the game's staff (4005), the game asks for a human check, or the sign-in has expired:
// those are notified for the player to handle.
const RECONNECT_MAX_PER_HOUR = 5;

function classifyVeil(veil) {
  if (!veil) return null;
  if (veil.includes('กำลังเล่นอยู่ที่อื่น')) return 'elsewhere';
  if (veil.includes('ถูกตัดการเชื่อมต่อโดย')) return 'staff';
  if (veil.includes('การเชื่อมต่อถูกตัด')) return 'cut';
  if (veil.includes('การเชื่อมต่อหลุด') || veil.includes('กำลังอัปเดตแพตช์')) return 'dropping';
  return null;
}

function scheduleReload(id, reason, baseDelayMs) {
  const s = store.data.settings;
  const g = rt(id);
  if (!s.autoReconnect || !g.win || g.win.isDestroyed()) return;
  if (g.rc && g.rc.pending) return; // one at a time
  const now = Date.now();
  g.rcAttempts = (g.rcAttempts || []).filter((t) => now - t < 3600 * 1000);
  if (g.rcAttempts.length >= RECONNECT_MAX_PER_HOUR) {
    setAlert(id, 'reconnectLimit', true, `ต่อใหม่อัตโนมัติครบ ${RECONNECT_MAX_PER_HOUR} ครั้งในชั่วโมงนี้แล้ว (${reason}) · หยุดลองเพื่อไม่ให้วนไม่จบ กรุณาดูหน้าเกม`);
    return;
  }
  // back off: each extra try this hour waits twice as long (at most 15 minutes)
  const delay = Math.min(15 * 60000, baseDelayMs * 2 ** g.rcAttempts.length);
  g.rc = { pending: true, at: now + delay, reason };
  log.info(`acc ${id}: reconnect in ${Math.round(delay / 1000)} s (${reason}, try ${g.rcAttempts.length + 1}/${RECONNECT_MAX_PER_HOUR} this hour)`);
  pushState();
}

function reconnectTick() {
  const now = Date.now();
  const s = store.data.settings;
  for (const [id, g] of openGames()) {
    if (g.demo) continue;
    // stuck page (not answering) for 30 s
    if (g.hangSince && now - g.hangSince > 30000) { g.hangSince = 0; scheduleReload(id, 'หน้าเกมค้าง', 1000); }
    // disconnected (or the game's own reconnect still spinning) for too long
    const lost = g.status === 'disconnected' || g.status === 'offline' || g.veil === 'dropping';
    if (lost) g.lostSince = g.lostSince || now; else g.lostSince = 0;
    // tries 30 s, 1, 2, 4, 8 min apart: covers ~15 minutes of an outage before giving up
    if (g.lostSince && now - g.lostSince > s.reconnectMinutes * 60000) scheduleReload(id, 'หลุดนานเกินไป', 30000);
    if (g.rc && g.rc.pending && now >= g.rc.at) {
      const reason = g.rc.reason;
      g.rc = null;
      g.rcAttempts = [...(g.rcAttempts || []), now];
      g.lostSince = 0;
      g.status = 'reconnecting';
      g.loadedAt = now;
      log.info(`acc ${id}: reconnecting (reload page) — ${reason}`);
      try { g.win.webContents.reload(); } catch (err) { log.error(`acc ${id}: reload failed`, err); }
      pushState();
    }
  }
}

// What the game page shows: disconnect boxes, sign-in screen. Called with every snapshot.
function watchScreen(id, snap) {
  const g = rt(id);
  const scr = (snap && snap.screen) || {};
  const kind = classifyVeil(scr.veil);
  if (kind !== g.veil) { if (kind || g.veil) log.info(`acc ${id}: game screen ${g.veil || '-'} -> ${kind || '-'}`); g.veil = kind; }
  setAlert(id, 'elsewhere', kind === 'elsewhere', 'ตัวละครนี้ถูกเปิดที่อื่น (แท็บ/เครื่องอื่น) · ไม่ต่อใหม่เองเพื่อไม่ให้แย่งกัน');
  setAlert(id, 'staff', kind === 'staff', 'ถูกตัดการเชื่อมต่อโดยทีมงานเกม · ไม่ต่อใหม่เอง');
  if (kind === 'cut') scheduleReload(id, 'เกมตัดการเชื่อมต่อ', 45000);
  // sign-in screen on an account that was signed in before = the sign-in expired
  const acc = account(id);
  if (snap && snap.ready && acc && !acc.signedIn) { acc.signedIn = true; store.save(); }
  setAlert(id, 'login', !!(scr.login && acc && acc.signedIn), 'ต้องล็อกอินใหม่ (การล็อกอินหมดอายุ) · เปิดหน้าเกมแล้วล็อกอิน');
  if (snap && snap.ready) {
    if (g.status === 'reconnecting') log.info(`acc ${id}: back in the game after reconnect`);
    for (const k of ['crash', 'reconnectLimit']) if (g.alerts.has(k) && g.status !== 'crashed') setAlert(id, k, false);
  }
}

// ---------- logging of state changes (status, game build / read health) ----------
function logChanges() {
  for (const [id, g] of games) {
    if (g.loggedStatus !== g.status) {
      if (g.loggedStatus !== undefined || g.status !== 'closed') log.info(`acc ${id}: status ${g.loggedStatus || '-'} -> ${g.status}`);
      g.loggedStatus = g.status;
    }
    if (!g.inGame || g.demo || (g.inGameAt && Date.now() - g.inGameAt < 60000)) continue; // the HUD is still drawing just after loading
    const h = g.adapter.health();
    const key = JSON.stringify([h.build, h.ok, h.problems]);
    if (g.loggedHealth !== key && (h.build || !h.ok)) {
      g.loggedHealth = key;
      if (h.ok) log.info(`acc ${id}: game build ${h.build || '?'}${h.knownBuild ? '' : ' (not tested yet)'}, data reads fine`);
      else log.warn(`acc ${id}: game build ${h.build || '?'} data problems: ${h.problems.join(' | ')}`);
    }
  }
}

// ---------- world events (EXP/drop boosts; the same for every account) ----------
const worldEvents = new Map(); // key -> { active, next }
function onWorldEvent(ev) {
  const before = worldEvents.get(ev.key);
  worldEvents.set(ev.key, { active: ev.active, next: ev.next || null });
  const startedNow = ev.active && (!before || !before.active || before.active.id !== ev.active.id);
  // a start we see live (or the server says it just began), not one already running at login
  if (startedNow && (before || ev.fresh)) {
    const left = ev.active.endsAt ? Math.round((ev.active.endsAt - Date.now()) / 60000) : 0;
    notify(null, 'event', `🔥 อีเวนต์ ${ev.active.name} เริ่มแล้ว${ev.active.perks.length ? ` · ${ev.active.perks.join(' · ')}` : ''}${left > 0 ? ` · ${left >= 120 ? Math.round(left / 60) + ' ชม.' : left + ' นาที'}` : ''}`);
    log.info(`world event started: ${ev.key} ${ev.active.id}`);
  }
  pushState();
}
function eventsView() {
  const now = Date.now();
  return [...worldEvents.values()].flatMap((e) => [
    e.active && (!e.active.endsAt || e.active.endsAt > now) ? { name: e.active.name, perks: e.active.perks, endsInMs: e.active.endsAt ? e.active.endsAt - now : 0, live: true } : null,
    e.next && e.next.startsAt > now ? { name: e.next.name, perks: [], startsInMs: e.next.startsAt - now, live: false } : null,
  ]).filter(Boolean);
}

// gear that may go on the market: not locked, not bound
// ---------- central-market listings that take a while to appear ----------
const LISTING_DELAY_MS = 5 * 60 * 1000;
function addPending(g, itemId, qty, unit, confirmed) {
  g.pending = g.pending.filter((p) => p.itemId !== itemId);
  g.pending.push({ itemId, name: pretty(baseOf(itemId)), rarity: rarityOf(itemId), qty, unit, at: Date.now(), confirmed, state: 'waiting' });
}
function onMyListings(id, list) {
  const g = rt(id);
  g.myListings = { list, at: Date.now() };
  for (const p of g.pending) {
    if (list.some((m) => m.itemId === p.itemId)) p.state = 'listed';
    else if (Date.now() - p.at > LISTING_DELAY_MS + 60 * 1000 && p.state === 'waiting') p.state = p.confirmed || !(g.adapter.inv && g.adapter.inv.get(p.itemId)) ? 'notSeen' : 'failed';
  }
}
// once the market's delay is over, look at "my listings" for each account with listings waiting
let marketTickN = 0;
function marketTick() {
  marketTickN++;
  for (const [id, g] of games) {
    if (g.status !== 'online') continue;
    g.pending = g.pending.filter((p) => Date.now() - p.at < 60 * 60 * 1000 && !(p.state === 'listed' && Date.now() - p.at > 15 * 60 * 1000));
    const due = g.pending.some((p) => p.state === 'waiting' && Date.now() - p.at > LISTING_DELAY_MS);
    if (due && (!g.myListings || Date.now() - g.myListings.at > 50 * 1000)) sendInput(id, { ...MARKET_FILTER, type: 'marketQuery', sort: 'def', off: 0 });
    // price gear pieces the dashboard has no market price for yet (a few per minute, like browsing)
    if (marketTickN % 4 === 0) {
      const ip = g.data.itemPrices;
      const todo = tradableGear(g).filter((x) => !ip.has(x) || Date.now() - ip.get(x).at > 30 * 60 * 1000).slice(0, 3);
      todo.forEach((x, i) => setTimeout(() => requestPrice(id, x), i * 500));
    }
  }
}

function tradableGear(g) {
  return g.adapter.inv ? [...g.adapter.inv.keys()].filter((x) => x.includes('#') && !g.adapter.locks.has(x) && !g.adapter.bound.has(x)) : [];
}

// gear pieces that may be salvaged: unlocked, of the chosen grades (default Normal + Magic)
function salvageable(g, rarities, opt) {
  const want = new Set(Array.isArray(rarities) && rarities.length ? rarities : ['normal', 'magic']);
  const ids = g.adapter.inv ? [...g.adapter.inv.keys()].filter((x) => x.includes('#') && !g.adapter.locks.has(x) && want.has(rarityOf(x))) : [];
  return opt && opt.byPrice ? ids.filter((x) => salvageVerdict(g, x, opt).salvage) : ids;
}
// salvage only what the central market says is worth little: no price, or under the limit, and not a steady seller
function salvageOpts(o) {
  const s = store.data.settings;
  return { byPrice: o && o.byPrice != null ? !!o.byPrice : s.salvageByPrice !== false, maxPrice: Number((o && o.maxPrice) ?? s.salvageMaxPrice ?? 1000000), keepVol: Number((o && o.keepVol) ?? s.salvageKeepVol ?? 3), unknownOk: o && o.unknownOk != null ? !!o.unknownOk : !!s.salvageUnknownOk };
}
function salvageVerdict(g, id, opt) {
  if (g.adapter.bound.has(id)) return { salvage: true, why: 'ผูกตัว ขายในตลาดไม่ได้' };
  const p = g.data.itemPrices.get(id);
  if (!p) return opt.unknownOk ? { salvage: true, why: 'ตลาดไม่ตอบราคา (ตั้งให้ถือว่าไม่มีราคา)' } : { salvage: false, why: 'ตลาดไม่ตอบราคา (เก็บไว้ก่อน)' };
  if (p.vol7 >= opt.keepVol && opt.keepVol > 0) return { salvage: false, why: `ขายออกบ่อย ${p.vol7} ชิ้นใน 7 วัน`, price: p.price, vol7: p.vol7 };
  if (p.price && p.price >= opt.maxPrice) return { salvage: false, why: `ราคาตลาด ${Math.round(p.price).toLocaleString()} G`, price: p.price, vol7: p.vol7 };
  return { salvage: true, why: p.price ? `ราคาต่ำ ${Math.round(p.price).toLocaleString()} G` : 'ไม่มีราคาในตลาด', price: p.price || 0, vol7: p.vol7 || 0 };
}
// ask the market about gear in the bag that has no recent price, then wait for the answers
async function priceGear(id, ids) {
  const g = rt(id);
  const todo = ids.filter((x) => !g.adapter.bound.has(x) && (!g.data.itemPrices.has(x) || Date.now() - g.data.itemPrices.get(x).at > 30 * 60 * 1000));
  // ask, wait, and ask again for the pieces the market did not answer (it can skip quick repeated asks)
  const t0 = Date.now();
  let missing = todo;
  for (let round = 0; round < 3 && missing.length; round++) {
    for (const x of missing) { await requestPrice(id, x, true); await new Promise((r) => setTimeout(r, round ? 800 : 450)); } // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2500)); // eslint-disable-line no-await-in-loop
    missing = missing.filter((x) => !g.data.itemPrices.has(x) || g.data.itemPrices.get(x).at < t0 - 1000);
  }
  selftest.count(id, 'priceAsked', todo.length); selftest.count(id, 'priceMissed', missing.length);
  if (missing.length) log.info(`acc ${id}: market gave no price for ${missing.length} piece(s) after 3 tries`);
  return todo.length;
}

// AUTO / sleep straight from the game page: the once-a-second snapshot can be a beat behind
async function liveUi(id) {
  const g = rt(id);
  try {
    return await g.win.webContents.executeJavaScript(`({ auto: document.body.classList.contains('auto-on'), sleeping: document.body.classList.contains('sleeping') })`, true);
  } catch { return { auto: g.data.stats.auto, sleeping: g.data.stats.sleeping }; }
}

// ---------- every account at once (only what the player pressed) ----------
async function commandAll(cmd, arg) {
  const results = [];
  for (const [id, g] of openGames()) {
    if (!g.inGame || g.demo) continue;
    const name = g.data.stats.name || account(id).name;
    let r;
    if (cmd === 'autoOn' || cmd === 'autoOff') {
      const want = cmd === 'autoOn';
      r = (await liveUi(id)).auto === want ? { ok: true, skipped: true } : await gameCommand(id, 'auto', {});
    } else if (cmd === 'sleep') {
      r = (await liveUi(id)).sleeping ? { ok: true, skipped: true } : await gameCommand(id, 'sleep', {});
    } else if (cmd === 'sellEtc' && !(g.adapter.inv && [...g.adapter.inv].some(([k, q]) => /^drop_/.test(k) && q > 0))) {
      r = { ok: true, skipped: true, error: 'ไม่มีของดรอปให้ขาย' };
    } else if (['sellEtc', 'buy'].includes(cmd)) {
      r = await gameCommand(id, cmd, arg);
    } else if (cmd === 'salvageAll') {
      // unlocked gear of the chosen grades in this account's bag (the player confirmed the counts first)
      const opt = salvageOpts(arg);
      if (opt.byPrice) await priceGear(id, salvageable(g, arg.rarities));
      const ids = salvageable(g, arg.rarities, opt);
      r = ids.length ? await gameCommand(id, 'salvage', { itemIds: ids }) : { ok: true, skipped: true, error: 'ไม่มีอุปกรณ์ให้ย่อย' };
      if (r.ok && ids.length) r.count = ids.length;
    } else {
      r = { ok: false, error: 'ไม่รู้จักคำสั่ง' };
    }
    results.push({ id, name, ...r });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 300)); // one after another, like a person clicking
  }
  log.info(`all accounts: ${cmd} -> ${results.map((r) => `${r.id}:${r.ok ? (r.skipped ? 'skip' : 'ok') : 'fail'}`).join(' ') || 'no account in game'}`);
  return results;
}

// Start BinderDash when Windows starts (with "open all accounts on start" = fully hands-off)
function applyStartWithWindows() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try { app.setLoginItemSettings({ openAtLogin: !!store.data.settings.startWithWindows }); } catch (err) { log.warn('login item:', err.message); }
}

// ---------- remote control from Telegram (owner's chat only, off by default) ----------
const remote = new telegram.Remote({
  onCommand: (text) => remoteCommand(text),
  onIgnored: (m) => log.warn(`telegram: ignored a message from another chat (${m.chat && m.chat.id})`),
  onError: (err) => log.once('tg-remote', 60000, 'warn', 'telegram remote:', err.message || err),
});
function syncRemote() {
  const s = store.data.settings;
  if (s.telegramRemote && s.telegram.token && s.telegram.chatId) { remote.start(s.telegram.token, s.telegram.chatId); log.info('telegram remote: on'); }
  else if (remote.running) { remote.stop(); log.info('telegram remote: off'); }
}

const pctText = (cur, max) => (max ? `${Math.round((cur / max) * 100)}%` : '-');
const shortNum = (n) => (typeof n !== 'number' ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const mins = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// "all" or account numbers as shown in the Dashboard list (1 = top)
function pickAccounts(arg) {
  const list = store.data.accounts;
  if (!arg || arg === 'all' || arg === 'ทั้งหมด') return list.map((a) => a.id);
  return String(arg).split(/[ ,]+/).map(Number).filter((n) => n >= 1 && n <= list.length).map((n) => list[n - 1].id);
}

async function remoteCommand(text) {
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ');
  log.info(`telegram command: ${cmd}${arg ? ' ' + arg.slice(0, 20) : ''}`);
  const list = store.data.accounts;
  switch (cmd) {
    case '/start':
    case '/help':
      return [
        'BinderDash รีโมต 🎮',
        '/status — สถานะทุกบัญชี',
        '/auto on|off [all|1 2 …] — เปิด/ปิด AUTO',
        '/sleep [all|1 2 …] — พักจอ',
        '/daily — ของรอรับ (Pass / จดหมาย)',
        '/bosses — บอสที่เกิดแล้ว / ใกล้เกิด',
        '/events — อีเวนต์ที่กำลังมี',
        'เลขบัญชี = ลำดับในรายการบน Dashboard',
      ].join('\n');
    case '/status': {
      const now = Date.now();
      const lines = list.map((a, i) => {
        const g = rt(a.id);
        const s = g.data.stats;
        const r = g.data.rates(now);
        if (!g.win || g.win.isDestroyed()) return `${i + 1}. ${a.name} — ปิดอยู่`;
        if (!g.inGame) return `${i + 1}. ${a.name} — ${g.status === 'maintenance' ? 'ปิดปรับปรุง' : 'ยังไม่เข้าเกม'}`;
        return `${i + 1}. ${s.name || a.name} Lv${s.level ?? '?'} ${s.auto ? '▶AUTO' : '■หยุด'}${s.dead ? ' 💀ตาย' : ''}`
          + `\n   HP ${pctText(s.hp, s.maxHp)} · EXP ${typeof s.expPct === 'number' ? s.expPct.toFixed(1) + '%' : '-'} · ${shortNum(r.expPerHour)} EXP/ชม. · รายได้ ${shortNum(r.incomePerHour)}/ชม.`
          + (g.alerts.size ? `\n   ⚠ ${[...g.alerts].map((k) => k.replace(/:.*/, '')).join(', ')}` : '');
      });
      const online = Math.max(0, ...[...games.values()].map((g) => g.data.net.online || 0));
      return `📊 สถานะ${online ? ` · คนในเซิร์ฟ ${online}` : ''}\n${lines.join('\n') || 'ยังไม่มีบัญชี'}`;
    }
    case '/auto':
    case '/sleep': {
      let target = arg;
      let want = null;
      if (cmd === '/auto') {
        const m = /^(on|off|เปิด|ปิด)\b\s*(.*)$/i.exec(arg);
        if (!m) return 'ใช้แบบนี้: /auto on หรือ /auto off (เติมเลขบัญชีได้ เช่น /auto off 2 3)';
        want = /^(on|เปิด)$/i.test(m[1]);
        target = m[2];
      }
      const ids = pickAccounts(target);
      const out = [];
      for (const id of ids) {
        const g = rt(id);
        const name = (g.data.stats.name || account(id).name);
        if (!g.win || g.win.isDestroyed() || !g.inGame) { out.push(`– ${name}: ไม่ได้อยู่ในเกม`); continue; }
        // eslint-disable-next-line no-await-in-loop
        const ui = await liveUi(id);
        if (cmd === '/auto' && ui.auto === want) { out.push(`✔ ${name}: AUTO ${want ? 'เปิด' : 'ปิด'}อยู่แล้ว`); continue; }
        if (cmd === '/sleep' && ui.sleeping) { out.push(`✔ ${name}: พักจออยู่แล้ว`); continue; }
        // eslint-disable-next-line no-await-in-loop
        const r = await gameCommand(id, cmd === '/auto' ? 'auto' : 'sleep', {});
        out.push(`${r.ok ? '✔' : '✖'} ${name}${r.ok ? (cmd === '/auto' ? `: AUTO ${want ? 'เปิด' : 'ปิด'}แล้ว` : ': พักจอแล้ว') : `: ${r.error}`}`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 300));
      }
      return out.join('\n') || 'ไม่มีบัญชีที่เลือก';
    }
    case '/daily': {
      const lines = list.map((a, i) => {
        const g = rt(a.id);
        const w = g.data.rewardsWaiting();
        const c = g.data.checklist;
        if (!c.pass && !c.mail) return `${i + 1}. ${a.name} — ยังไม่มีข้อมูล`;
        const done = c.pass ? c.pass.daily.filter((x) => x.claimed).length : 0;
        return `${i + 1}. ${g.data.stats.name || a.name} — Pass ${done}/${c.pass ? c.pass.daily.length : 4}${w.pass ? ` · 🎁 รอกดรับ ${w.pass}` : ''}${w.mail ? ` · ✉ จดหมายมีของ ${w.mail}` : ''}`;
      });
      return `📋 รายวัน\n${lines.join('\n')}`;
    }
    case '/bosses': {
      const b = bossView();
      const up = b.field.filter((f) => f.up).map((f) => `♛ ${f.name} (${mapName(f.map)}) — เกิดแล้ว`);
      const soon = b.field.filter((f) => !f.up && f.inMs < 30 * 60000).map((f) => `♛ ${f.name} (${mapName(f.map)}) — อีก ${mins(f.inMs)}`);
      const world = b.world.map((w) => `🌋 ${w.name} — ${w.state === 'live' ? `กำลังสู้ ${w.fighters} คน` : `อีก ${mins(w.inMs)}`}`);
      const all = [...world, ...up, ...soon];
      return all.length ? `บอส\n${all.join('\n')}` : 'ยังไม่มีข้อมูลบอส (ต้องมีบัญชีที่อยู่ในเกม)';
    }
    case '/events': {
      const ev = eventsView();
      return ev.length ? ev.map((e) => (e.live ? `🔥 ${e.name}${e.perks.length ? ' · ' + e.perks.join(' · ') : ''}${e.endsInMs ? ` · เหลือ ${mins(e.endsInMs)}` : ''}` : `⏳ ${e.name} · เริ่มในอีก ${mins(e.startsInMs)}`)).join('\n') : 'ตอนนี้ไม่มีอีเวนต์';
    }
    default:
      return 'ไม่รู้จักคำสั่งนี้ พิมพ์ /help ดูคำสั่งทั้งหมด';
  }
}

// ---------- bosses (the same for every account on the server) ----------
const bosses = { field: new Map(), world: new Map(), sent: new Set(), queriedAt: 0 };

function onFieldBosses(list) {
  const now = Date.now();
  for (const b of list) {
    const key = `${b.mobType}@${b.map}`;
    const before = bosses.field.get(key);
    bosses.field.set(key, { ...b, seenAt: now });
    // up now, and it wasn't before (first sight doesn't count: no spam on start)
    if (before && before.until > now && !b.until && !b.closed) bossUp(b);
  }
  pushState();
}

// ---------- buy potions by themselves when they are about to run out ----------
// rounds x 99 (the shop sells 99 at a time), at most once every 10 minutes per potion; HUD buying is Premium
// the game's hotbar (belt): base ids per slot, kept by the game page in its local storage
function readBelt(id, g) {
  if (!g.win || g.win.isDestroyed() || (g.beltAt && Date.now() - g.beltAt < 60000)) return;
  g.beltAt = Date.now();
  g.win.webContents.executeJavaScript(`(() => { const out = []; for (const k of Object.keys(localStorage)) if (/\\.pref\\.belt$/.test(k)) { try { for (const x of JSON.parse(localStorage.getItem(k)) || []) if (x && !out.includes(x)) out.push(String(x)); } catch {} } return out; })()`, true)
    .then((b) => { const list = (b || []).map((x) => baseOf(x)); if (String(list) !== String(g.belt || [])) log.info(`acc ${id}: hotbar ${list.join(', ') || '(empty)'}`); g.belt = list; })
    .catch(() => {});
}
async function autoBuyPotion(id, g, p) {
  const ab = store.data.settings.autoBuy || {};
  if (!ab.on || g.demo || !g.inGame || !p) return;
  const pid = p.id;
  const row = { name: p.name };
  g.autoBuyAt = g.autoBuyAt || {};
  if (g.autoBuyAt[pid] && Date.now() - g.autoBuyAt[pid] < 10 * 60 * 1000) return;
  g.autoBuyAt[pid] = Date.now();
  const lv = Number(g.data.stats.level) || 0;
  if (p.lv && lv && lv < p.lv) {
    if (!g.autoBuyLvWarned) { g.autoBuyLvWarned = true; notify(id, 'potion', `🧪 ร้านยังไม่ขาย ${p.name} ที่ Lv ${lv} (ขายตั้งแต่ Lv ${p.lv}) · ยานี้ต้องคราฟต์หรือซื้อจากตลาด`); }
    return;
  }
  const qty = 99 * Math.max(1, Math.min(10, Number(ab.rounds) || 3));
  const r = await runCommand(id, 'buy', { itemId: pid, qty, keepSilver: Math.max(0, Number(ab.keepSilver ?? 5000)) });
  log.info(`acc ${id}: auto-buy ${pid} x${qty} -> ${r.ok ? 'got ' + r.bought : r.error}`);
  selftest.count(id, r.ok ? 'autoBuy' : 'autoBuyFail'); if (r.ok) selftest.count(id, 'autoBuyQty', r.bought);
  if (r.ok) { setAlert(id, 'potion:' + pid, false); notify(id, 'potion', `🧪 ซื้อ ${row.name} อัตโนมัติ ${r.bought} ขวด${r.note ? ' · ' + r.note : ''}`); }
  else if (!g.autoBuyFailAt || Date.now() - g.autoBuyFailAt > 60 * 60 * 1000) { g.autoBuyFailAt = Date.now(); notify(id, 'potion', `🧪 ซื้อ ${row.name} อัตโนมัติไม่สำเร็จ: ${r.error}`); } // at most once an hour
}

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
function deathLoopCheck(id, g) {
  return; // removed in 1.5.1 at the player's request: pausing respawn cost the farming spot; always get up at once
  // eslint-disable-next-line no-unreachable
  if (store.data.settings.autoRespawnHere === false || store.data.settings.deathLoopGuard === false) return;
  const now = Date.now();
  g.deathTimes = (g.deathTimes || []).filter((t) => now - t < 120000); g.deathTimes.push(now);
  if (g.deathTimes.length < 4 || (g.respawnPausedUntil && now < g.respawnPausedUntil)) return;
  // boss fights: dying often is part of it and getting up at once matters most (world boss = free).
  // A world boss arena while the event is on counts too (respawn is sent before the death screen, so
  // the "free" button is often never seen; seen in a real log: the guard paused respawn mid-fight)
  const arena = WORLD_ARENAS.has(mapOf(g)) && [...bosses.world.values()].some((w) => w.state === 'live' || (w.endsAt && now - w.endsAt < 5 * 60 * 1000));
  if (arena || g.bossTrip || (g.fight && now - g.fight.last < 30000) || (g.freeRespawnAt && now - g.freeRespawnAt < 5 * 60 * 1000)) return;
  g.respawnPausedUntil = now + 10 * 60 * 1000; g.deathTimes = [];
  // where it farmed: after the pause it is taken back there (a log: woke up in town and stood there 8 hours)
  { const st = (g.data.world && g.data.world.self) || {}; const again = g.loopBack && now - g.loopBack.at < 60 * 60000; g.loopBack = again ? { ...g.loopBack, giveUp: true } : { map: mapOf(g), x: st.x, y: st.y, at: now, done: false }; }
  selftest.count(id, 'deathLoops');
  if (g.win && !g.win.isDestroyed()) g.win.webContents.executeJavaScript(`(() => { const c = document.getElementById('au-respawn'); if (c && c.checked && !c.disabled) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); return true; } return false; })()`, true).catch(() => {});
  log.info(`acc ${id}: death loop (4 deaths in 2 min) -> respawn in place off for 10 min`);
  notify(id, 'death', '☠ ตายวนซ้ำ 4 ครั้งใน 2 นาที · ปิด "เกิดที่เดิม" ของบัญชีนี้ 10 นาที (ตายครั้งต่อไปกลับเมือง) · ลองเปลี่ยนจุดฟาร์มหรือเช็คยา/อุปกรณ์');
  g.autoRespawnAt = 0; pushState();
}
async function ensureAutoRespawn(id) {
  const g = games.get(id);
  if (!g || !g.inGame || g.demo || !g.win || g.win.isDestroyed()) return;
  if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return; // death loop pause
  if (g.autoRespawnAt && Date.now() - g.autoRespawnAt < 60000) return;
  g.autoRespawnAt = Date.now();
  const premium = g.data.stats.premium === true || (g.data.premiumUntil && g.data.premiumUntil > Date.now());
  let r; try { r = await g.win.webContents.executeJavaScript(AUTO_RESPAWN_JS(premium), true); } catch { return; }
  const before = g.autoRespawn && g.autoRespawn.on;
  g.autoRespawn = r;
  if (r.changed) { log.info(`acc ${id}: turned on the game's Auto Respawn (respawn in place)${r.unlocked ? ' · its box was greyed out by the game (drawn before Premium was known)' : ''}`); g.data.log('other', '↺ เปิด "เกิดที่เดิมอัตโนมัติ" ของเกมคืนให้แล้ว'); }
  if (!r.ok && r.why === 'premium' && !g.autoRespawnWarned) { g.autoRespawnWarned = true; log.info(`acc ${id}: Auto Respawn needs Premium`); }
  if (before !== r.on) pushState();
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
function backupRespawn(id, delay = 150) {
  if (store.data.settings.autoRespawnHere === false) return;
  const g = games.get(id); if (!g || g.demo || g.respawnPending) return;
  g.respawnPending = true;
  setTimeout(async () => {
    g.respawnPending = false;
    if (!g.win || g.win.isDestroyed()) return;
    if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return; // death loop pause: let it go to town
    let r; try { r = await g.win.webContents.executeJavaScript(RESPAWN_HERE_JS, true); } catch { r = null; }
    if (!r) { g.respawnTries = (g.respawnTries || 0) + 1; if (g.respawnTries < 40) backupRespawn(id, 300); return; } // page busy: look again, do not give up
    if (r.stale) { log.info(`acc ${id}: death screen left over while alive -> closed it`); selftest.count(id, 'staleDeathScreen'); if (g.autoAtDeath || g.bossTrip) setTimeout(async () => { if (!(await liveUi(id)).auto) gameCommand(id, 'auto', {}); }, 800); }
    if (!r.dead) { if (g.respawnTries) log.info(`acc ${id}: up again after ${((Date.now() - (g.deadSince || g.lastDeathAt || Date.now())) / 1000).toFixed(1)} s`); g.respawnTries = 0; return; } // up already
    const since = ((Date.now() - (g.deadSince || g.lastDeathAt || Date.now())) / 1000).toFixed(1);
    if (!g.respawnTries || (g.respawnTries % 5 === 0 && !r.clicked)) { // at once, then again every ~1.5 s while still down
      await sendInput(id, { type: 'respawn', here: true });
      g.respawnSends = (g.respawnSends || 0) + 1;
      if (!g.respawnTries) { selftest.count(id, 'respawnPress'); log.info(`acc ${id}: dead -> sent respawn here after ${since} s`); }
    }
    if (r.free) g.freeRespawnAt = Date.now();
    if (r.clicked && !g.respawnClicked) { g.respawnClicked = true; log.info(`acc ${id}: still dead -> pressed the respawn-here button${r.free ? ' (free)' : ''} after ${since} s`); }
    else if (r.disabled && !g.respawnWhy) { g.respawnWhy = true; log.info(`acc ${id}: respawn here not possible: ${r.why || 'button off'}`); }
    g.respawnTries = (g.respawnTries || 0) + 1;
    if (g.respawnTries < 40) backupRespawn(id, 300); // up to ~12 s, then the 15 s check takes over
    else g.respawnTries = 0;
  }, delay);
}
async function liveDead(id) {
  const g = games.get(id);
  // a death screen over a living character counts too: backupRespawn closes it
  try { return await g.win.webContents.executeJavaScript(`(() => { try { const o = document.getElementById('deathoverlay'); if (o && getComputedStyle(o).display !== 'none') return true; const m = window.__game && window.__game.me(); return !!(m && (m.state === 'dead' || m.hp <= 0)); } catch { return false; } })()`, true); } catch { return false; }
}
function autoRespawnTick() {
  if (store.data.settings.autoRespawnHere === false) return;
  for (const [id, g] of games) {
    if (!g.inGame || g.demo) continue;
    ensureAutoRespawn(id);
    // a death the event stream missed: look at the screen too
    liveDead(id).then((dead) => { if (dead) backupRespawn(id, 0); else if (!g.respawnPending) g.respawnTries = 0; });
  }
}

// ---------- real-time market watch: items followed on the central market, refreshed in the background ----------
// One online account asks the market about one watched item every few seconds (like browsing the board).
// A watched item is "base id + grade": gear grade comes from how many affixes the asked id carries
// (the server counts them: 1-2 = Magic, 3 = Rare, 4 = Epic), stackables and cards are asked as they are.
const GRADE_SUFFIX = { normal: '', magic: '|str:1:1', rare: '|str:1:1,agi:1:1,vit:1:1', epic: '|str:1:1,agi:1:1,vit:1:1,int:1:1' };
const marketLive = new Map(); // key -> latest view
let mwLastAsk = 0;
const mwList = () => store.data.marketWatch || (store.data.marketWatch = []);
const mwHist = () => store.data.marketHist || (store.data.marketHist = {});
function marketWatchSeen(ev) {
  const watch = mwList(); if (!watch.length) return;
  const hit = watch.filter((w) => w.key === ev.key || w.itemId === ev.id); if (!hit.length) return;
  const now = Date.now();
  for (const w of hit) {
    if (!w.key && ev.key) w.key = ev.key;
    const k = w.key || w.itemId;
    const prev = marketLive.get(k);
    const view = { low: ev.price != null && ev.basis === 'listed' ? ev.price : 0, last: ev.last || 0, stock: ev.stock || 0, vol7: ev.vol7 || 0, at: now, prevLow: prev ? prev.low : null, prevLast: prev ? prev.last : null };
    marketLive.set(k, view);
    w.at = now;
    const h = mwHist(); const list = h[k] || (h[k] = []);
    const lastPt = list[list.length - 1];
    if (!lastPt || now - lastPt[0] > 60000 || lastPt[1] !== view.low || lastPt[2] !== view.last) { list.push([now, view.low, view.last, view.stock, view.vol7]); if (list.length > 500) list.splice(0, list.length - 500); }
    // alerts: lowest listing at or under "below", or at or over "above" (once per crossing)
    const price = view.low || view.last;
    if (w.below && price && price <= w.below && !w.belowSent) { w.belowSent = true; notify(null, 'marketWatch', `📉 ${w.name}: ตลาดกลาง${view.low ? 'ถูกสุด' : 'ขายล่าสุด'} ${Math.round(price).toLocaleString('en-US')} G (≤ ${Math.round(w.below).toLocaleString('en-US')})`); }
    if (w.below && price > w.below) w.belowSent = false;
    if (w.above && price && price >= w.above && !w.aboveSent) { w.aboveSent = true; notify(null, 'marketWatch', `📈 ${w.name}: ตลาดกลาง ${Math.round(price).toLocaleString('en-US')} G (≥ ${Math.round(w.above).toLocaleString('en-US')})`); }
    if (w.above && price < w.above) w.aboveSent = false;
  }
  store.save();
  pushState();
}
function marketWatchTick() {
  const watch = mwList(); if (!watch.length) return;
  const every = Math.max(1, Number(store.data.settings.marketWatchMin) || 2) * 60000;
  if (Date.now() - mwLastAsk < 3000) return;
  const acc = openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
  if (!acc) return;
  const due = watch.filter((w) => !w.at || Date.now() - w.at >= every).sort((a, b) => (a.at || 0) - (b.at || 0))[0];
  if (!due) return;
  mwLastAsk = Date.now();
  if (!due.at) due.at = 0;
  due.askedAt = Date.now();
  requestPrice(acc[0], due.itemId, true);
}
function mwSearch(q) {
  const N = require('./game-names');
  const t = String(q || '').trim().toLowerCase(); if (t.length < 2) return [];
  const out = [];
  for (const [id, name] of Object.entries(N.items)) {
    if (id.startsWith('cash') || id.startsWith('drop_')) continue;
    if (id.toLowerCase().includes(t) || String(name).toLowerCase().includes(t)) out.push({ id, name });
    if (out.length >= 30) break;
  }
  return out;
}

// ---------- real boss fights: how long they take (Build Lab scores builds over that time) ----------
const { MOBS: MOB_ROLES } = require('./mob-table');
const WORLD_TYPES = { vale: 'wraithroot_colossus', nacreon: 'pearlheart_titan' };
const WORLD_ARENAS = new Set(['rootfall_barrow', 'nacre_lagoon']); // the world bosses' maps (client table)
const isBossType = (t) => !!t && (Object.values(WORLD_TYPES).includes(t) || /^true_/.test(t) || ['boss', 'mini-boss'].includes((MOB_ROLES[t] || [])[0]));
function fightHit(g, ev) {
  if (!isBossType(ev.mob) || ev.pet) return;
  const now = Date.now();
  if (!g.fight || g.fight.mob !== ev.mob) { fightEnd(g); g.fight = { mob: ev.mob, start: now, last: now, dmg: 0, hits: 0 }; }
  g.fight.last = now; g.fight.dmg += ev.dmg || 0; g.fight.hits++;
}
function fightEnd(g, killed = false) {
  const f = g.fight; g.fight = null;
  if (!f || f.hits < 5) return;
  const sec = Math.round((f.last - f.start) / 1000);
  if (sec < 5) return;
  const list = store.data.fights || (store.data.fights = []);
  list.push({ acc: g.accId, mob: f.mob, sec, dmg: f.dmg, dps: Math.round(f.dmg / sec), killed, at: Date.now() });
  if (list.length > 600) list.splice(0, list.length - 600);
  store.save();
  log.info(`boss fight: acc ${g.accId} ${f.mob} ${sec}s ${f.dmg} dmg (${Math.round(f.dmg / sec)}/s)${killed ? ' (killed)' : ''}`);
}
function fightTick() {
  for (const [, g] of games) if (g.fight && Date.now() - g.fight.last > 20000) fightEnd(g);
}
function fightTimes() {
  const by = {};
  for (const f of store.data.fights || []) (by[f.mob] || (by[f.mob] = [])).push(f.sec);
  const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
  const out = {};
  for (const [mob, a] of Object.entries(by)) out[mob] = { sec: med(a), n: a.length };
  return { fights: out, world: store.data.worldLen || {} };
}

// deaths this session and what respawning in place cost (Gold per death in fields, the game's fee),
// next to what the character earns: a spot where it dies a lot can earn less than it seems
function deathCost(id, g) {
  const c = selftest.counters.get(id) || {};
  const hours = Math.max(1 / 60, (Date.now() - (g.data.startedAt || Date.now())) / 3600000);
  const deaths = c.deaths || 0;
  if (!deaths) return null;
  const fee = (g.autoRespawns || 0) * 5000 + (c.respawnPress || 0) * 5000 * (WORLD_ARENAS.has(mapOf(g)) ? 0 : 1);
  const rate = g.data.rates(Date.now());
  return { perHour: +(deaths / hours).toFixed(1), feePerHour: Math.round(fee / hours), silverPerHour: Math.round(rate.silverPerHour || 0) };
}

// ---------- real A/B test: the build before a change (A) against after it (B), same map, measured per minute ----------
// The game is the judge: active DPS (time between own hits of 3 s or less) and kills, minute by minute, so the
// spread between minutes says how much a difference has to be before it is real.
function abBucket(g) {
  const P = g.ab[g.ab.phase]; const m = Math.floor((Date.now() - P.start) / 60000);
  while (P.mins.length <= m) P.mins.push({ dmg: 0, activeMs: 0, kills: 0, hits: 0 });
  return P.mins[m];
}
function abHit(g, ev) {
  const A = g.ab; if (!A || !A.phase || ev.pet || !(ev.dmg > 0)) return;
  const P = A[A.phase];
  if (Date.now() - P.start > P.minutes * 60000) { A.phase = null; log.info(`A/B: phase ${A.last} done`); return; }
  const b = abBucket(g); const now = Date.now();
  b.dmg += ev.dmg; b.hits++; if (P.lastHit && now - P.lastHit <= 3000) b.activeMs += now - P.lastHit; P.lastHit = now;
  if (ev.mob) P.mobs[ev.mob] = (P.mobs[ev.mob] || 0) + 1;
}
function abStats(P) {
  if (!P) return null;
  const full = P.mins.filter((x) => x.activeMs > 10000); // minutes with enough fighting in them
  const dps = full.map((x) => x.dmg / (x.activeMs / 1000));
  const n = dps.length; const mean = n ? dps.reduce((t, x) => t + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(dps.reduce((t, x) => t + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const kills = P.mins.reduce((t, x) => t + x.kills, 0); const mins = Math.max(1 / 60, Math.min(P.minutes, (Date.now() - P.start) / 60000));
  const mob = Object.entries(P.mobs).sort((a, b) => b[1] - a[1])[0];
  return { minutes: +mins.toFixed(1), of: P.minutes, n, dps: Math.round(mean), sd: Math.round(sd), se: n > 1 ? Math.round(sd / Math.sqrt(n)) : null, killsPerMin: +(kills / mins).toFixed(1), map: P.map, mob: mob ? mob[0] : '', label: P.label };
}
function abResult(g) {
  const A = g.ab; if (!A) return null;
  const a = abStats(A.A); const b = abStats(A.B);
  let verdict = null;
  if (a && b && a.n >= 3 && b.n >= 3) {
    const diff = b.dps - a.dps; const noise = 2 * Math.sqrt((a.se || 0) ** 2 + (b.se || 0) ** 2);
    const pct = a.dps ? Math.round(diff / a.dps * 1000) / 10 : 0;
    const same = a.map === b.map && a.mob === b.mob;
    verdict = { pct, noisePct: a.dps ? Math.round(noise / a.dps * 1000) / 10 : 0, same,
      says: !same ? 'วัดคนละแมพ/มอน เทียบกันไม่ได้' : Math.abs(diff) <= noise ? 'ยังบอกไม่ได้: ต่างน้อยกว่าความแกว่งของข้อมูล (วัดนานขึ้นอีกหน่อย)' : diff > 0 ? 'ดีขึ้นจริง ✅ เก็บแบบใหม่ไว้' : 'แย่ลงจริง ❌ กลับไปแบบเดิม' };
  }
  return { phase: A.phase, A: a, B: b, verdict };
}
async function abStart(id, phase, minutes, label) {
  const g = games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!['A', 'B'].includes(phase)) return { ok: false, error: 'phase' };
  g.ab = g.ab || {};
  const running = g.ab.phase && g.ab[g.ab.phase] && Date.now() - g.ab[g.ab.phase].start < g.ab[g.ab.phase].minutes * 60000;
  if (running) { const P = g.ab[g.ab.phase]; return { ok: false, error: `กำลังวัด ${g.ab.phase} อยู่ อีก ~${Math.ceil((P.start + P.minutes * 60000 - Date.now()) / 60000)} นาที · รอให้ครบก่อน (หรือกดหยุด)` }; }
  if (phase === 'B') { const a = abStats(g.ab.A); if (!a || a.n < 3) return { ok: false, error: 'ต้องวัดแบบเดิม (A) ให้ได้อย่างน้อย 3 นาทีที่ตีจริงก่อน แล้วค่อยเปลี่ยนและวัด B' }; }
  if (phase === 'A') g.ab.B = null;
  g.ab[phase] = { start: Date.now(), minutes: Math.max(2, Math.min(60, Number(minutes) || 10)), mins: [], mobs: {}, map: mapOf(g), label: String(label || '').slice(0, 80), lastHit: 0 };
  g.ab.phase = phase; g.ab.last = phase;
  log.info(`acc ${id}: A/B measuring ${phase} for ${g.ab[phase].minutes} min on ${mapOf(g)}${label ? ` (${label})` : ''}`);
  return { ok: true };
}


// ---------- farm ledger: what one minute of farming is really worth, per map ----------
// Counted: the Silver balance going up while AUTO farms = Silver from kills (the game's own number, so combo and
// Gold cards are already in it) + the game's auto-sell / Soulforge of Normal/Magic gear, minus potions bought and
// respawn fees, + ETC picked up at the NPC price. Never counted: market prices, mail, Pass, bounty rewards (a minute
// with one of those in it is left out), minutes on the road, at a world boss or without a kill.
const FARM_KEEP = 300; // rows (= farming minutes) kept per account + map
const FARM_DAYS = 10;
let farmDirtyStore = false;
function farmBucket(g) {
  const m = Math.floor(Date.now() / 60000);
  if (!g.ledger || g.ledger.m !== m) {
    if (g.ledger) farmClose(g.ledger);
    g.ledger = { m, id: g.accId, map: mapOf(g), lv: g.data.stats.level || 0, bal: 0, kill: 0, etc: 0, kills: 0, dirty: !!(g.bossTrip || g.travelling) };
  }
  return g.ledger;
}
function farmDirty(g) { if (g) farmBucket(g).dirty = true; }
function farmEvent(id, g, ev) {
  if (!g.inGame || g.demo) return;
  const L = farmBucket(g);
  if (ev.type === 'kill') { L.kills++; L.kill += Number(ev.silver) || 0; }
  else if (ev.type === 'loot' && ev.value > 0 && /^drop_/.test(ev.id || '')) { L.etc += ev.value; (g.etcPrice || (g.etcPrice = {}))[baseOf(ev.id)] = ev.value / (ev.qty || 1); }
  else if (ev.type === 'sold' && ev.auto) { const p = g.etcPrice && g.etcPrice[baseOf(ev.id || '')]; if (p) L.etc -= p * (ev.qty || 1); } // ETC sold by the game: the balance has it now
  else if (ev.type === 'sold' && !ev.auto) L.dirty = true; // a sale from the sell window (old loot) is not this minute's farming
}
function farmBalance(g) {
  const s = Number(g.data.stats.silver);
  if (!Number.isFinite(s)) return;
  const L = farmBucket(g);
  if (g.lastBal != null) L.bal += s - g.lastBal;
  if (L.map !== mapOf(g) || (g.claimUntil && Date.now() < g.claimUntil)) L.dirty = true; // changed map inside the minute / rewards coming in
  g.lastBal = s;
}
function farmClose(L) {
  if (L.dirty || !L.kills || !L.map || WORLD_ARENAS.has(L.map) || !L.id) return;
  if (L.bal - L.kill > 20000000) { log.info(`farm ledger acc ${L.id}: +${L.bal} Silver in one minute on ${L.map} (not from kills or sales?) -> left out`); return; } // a claim / trade the dashboard did not see
  const all = store.data.farm || (store.data.farm = {});
  const key = `${L.id}:${L.map}`;
  const rows = all[key] || (all[key] = []);
  rows.push([L.m, L.lv, Math.round(L.bal + L.etc), Math.round(L.kill), L.kills]);
  const old = Math.floor(Date.now() / 60000) - FARM_DAYS * 1440;
  while (rows.length && (rows.length > FARM_KEEP || rows[0][0] < old)) rows.shift();
  farmDirtyStore = true;
}
// per map for one account, near its level: Silver per hour (median of the minutes, one bad minute does not swing it)
let farmHistCache = null;
function farmHist() { if (!farmHistCache || Date.now() - farmHistCache.at > 30 * 60000) { let h = {}; try { h = selftest.farmHistory(14); } catch (e) { log.warn(`farm history: ${e.message}`); } farmHistCache = { at: Date.now(), h }; } return farmHistCache.h; }
function farmSummary(accId, level, sinceMin = 0) {
  const live = farmSummaryLedger(accId, level, sinceMin);
  if (sinceMin) return live; // a measurement window: only what was measured in it
  // + the stats log (every 10 min, 14 days): Silver from kills per map. It has no auto-sell, so maps known only from
  // there get an estimate: their kill Silver x this account's own (profit / kill Silver) from maps measured both ways
  const hist = farmHist(); const byMap = new Map(live.map((x) => [x.map, x]));
  const ratios = live.filter((x) => x.minutes >= 10 && x.killSilverHr > 0).map((x) => x.netHr / x.killSilverHr);
  const ratio = ratios.length ? Math.max(0.8, Math.min(3, ratios.reduce((t, x) => t + x, 0) / ratios.length)) : 1;
  for (const a of Object.values(hist)) {
    if (Number(a.acc) !== accId || WORLD_ARENAS.has(a.map)) continue;
    const st = a.steps.filter((s) => !level || !s.lv || Math.abs(s.lv - level) <= 5);
    const min = st.reduce((t, s) => t + s.min, 0); if (min < 20) continue;
    const killHr = Math.round(st.reduce((t, s) => t + s.silver, 0) / min * 60); const killsHr = Math.round(st.reduce((t, s) => t + s.kills, 0) / min * 60);
    if (killsHr < 100) continue; // a town / standing around, not a farm
    // deaths cost: respawning in place is 5,000 G each in fields (a log: a Scout dying 45 times an hour paid
    // 2/3 of its kill Silver back in fees); time lost dead is already in the kill numbers
    const deathsHr = +(st.reduce((t, s) => t + (s.deaths || 0), 0) / min * 60).toFixed(1);
    const fee = Math.round(deathsHr * 5000);
    const x = byMap.get(a.map);
    if (x) Object.assign(x, { histMinutes: min, histKillHr: killHr, deathsHr });
    else { const e = { map: a.map, name: mapName(a.map), minutes: 0, netHr: Math.round(killHr * ratio) - fee, est: true, killSilverHr: killHr, killsHr, deathsHr, histMinutes: min, histKillHr: killHr, last: Math.max(...st.map((s) => s.t)) }; live.push(e); byMap.set(a.map, e); }
  }
  return live.sort((p, q) => q.netHr - p.netHr);
}
function farmSummaryLedger(accId, level, sinceMin = 0) {
  const out = [];
  for (const [key, rows] of Object.entries(store.data.farm || {})) {
    const [a, map] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (Number(a) !== accId) continue;
    const r = rows.filter((x) => x[0] >= sinceMin && (!level || !x[1] || Math.abs(x[1] - level) <= 5));
    if (!r.length) continue;
    // the plain average: sales come in lumps, a median would leave them out
    const mean = r.reduce((t, x) => t + x[2], 0) / r.length;
    out.push({ map, name: mapName(map), minutes: r.length, netHr: Math.round(mean * 60), killSilverHr: Math.round(r.reduce((t, x) => t + x[3], 0) / r.length * 60), killsHr: Math.round(r.reduce((t, x) => t + x[4], 0) / r.length * 60), last: r[r.length - 1][0] * 60000 });
  }
  return out.sort((p, q) => q.netHr - p.netHr);
}
function farmSaveTick() { if (farmDirtyStore) { farmDirtyStore = false; store.save(); } }

// ---------- does this game build still have what each automation uses? ----------
const UI_CHECK_JS = `(async () => { const g = window.__game; const has = (id) => !!document.getElementById(id);
  const fn = (k) => !!(g && typeof g[k] === 'function');
  let world = false; try { if (window.__bdOpenWorld) world = true; else { const urls = [...new Set([...performance.getEntriesByType('resource').map((e) => e.name), ...[...document.scripts].map((x) => x.src)].filter((u) => /\\/assets\\/main-[\\w-]+\\.js(\\?|$)/.test(u || '')))]; for (const u of urls) { try { const m = await import(u); if (m && typeof m.openWorldMap === 'function') { window.__bdOpenWorld = m.openWorldMap; world = true; break; } } catch (e) {} } } } catch (e) {}
  return { api: fn('me') && fn('state') && fn('mapId'), sell: fn('sell'), autoPanel: has('autoopt') && has('autoopts'), farmRange: has('au-farm'), targets: has('au-targets'), respawnBox: has('au-respawn'),
    hunt: has('openhunt') && has('huntwin'), channel: has('chbtn'), worldMap: world, worldBtn: has('worldbtn') }; })()`;
const UI_USES = { api: 'อ่านข้อมูลตัวละคร (ทุกระบบ)', sell: 'ขายของให้ NPC', autoPanel: 'ตั้งค่า AUTO (ระยะฟาร์ม, เลือกมอน, เกิดที่เดิม)', farmRange: 'ระยะฟาร์ม (ค่าหัว / หาที่ฟาร์ม)', targets: 'ตีเฉพาะมอนค่าหัว', respawnBox: 'เปิดเกิดที่เดิมอัตโนมัติ', hunt: 'ทำค่าหัว', channel: 'ย้าย CH เมื่อคนเยอะ', worldMap: 'เดินทางไปแมพ (หาที่ฟาร์ม / ไปฟาร์ม / กลับจุดเดิม)', worldBtn: 'แผนที่โลก' };
async function uiCheck(id, g) {
  if (!g.win || g.win.isDestroyed() || !g.inGame || g.demo) return;
  let r; try { r = await g.win.webContents.executeJavaScript(UI_CHECK_JS, true); } catch { return; }
  if (!r) return;
  const missing = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  g.uiMissing = missing;
  if (missing.length) {
    log.warn(`acc ${id}: this game build lacks what some automations use: ${missing.join(', ')}`);
    setAlert(id, 'uiMissing', true, `⚠ เกมอัปเดต: ระบบเหล่านี้อาจใช้ไม่ได้ · ${missing.map((k) => UI_USES[k] || k).join(' · ')} · ส่ง log ให้ผู้พัฒนา`);
  } else { if (g.alerts.has('uiMissing')) setAlert(id, 'uiMissing', false); log.info(`acc ${id}: game buttons used by the automations: all there`); }
}

// ---------- who drives this character now ----------
// Every system that walks, travels or presses AUTO asks mayAct() first. Order: world boss (and the way back
// from it) > bounty > farm finder / a map chosen in the Dashboard / back after a death > crowded-channel move >
// AUTO-stuck fix / RAM reload. A higher one pauses the lower ones; equal or lower ones wait.
const DRIVE_PRIO = { boss: 5, bossReturn: 5, bounty: 4, finder: 3, travel: 3, deathReturn: 3, crowd: 1, stuck: 1, ram: 0 };
const DRIVE_TH = { boss: 'ตีบอสโลก', bossReturn: 'กลับจุดฟาร์มหลังบอส', bounty: 'ทำค่าหัว', finder: 'หาที่ฟาร์ม', travel: 'เดินทางไปแมพที่เลือก', deathReturn: 'กลับจุดฟาร์มหลังตาย', crowd: 'ย้าย CH', stuck: 'แก้ AUTO ค้าง', ram: 'คืนแรม' };
function driverOf(g) {
  const now = Date.now(); const list = [];
  if (g.bossTrip || WORLD_ARENAS.has(mapOf(g))) list.push('boss');
  if (g.loopBack && !g.loopBack.done) list.push(g.loopBack.why === 'boss' ? 'bossReturn' : 'deathReturn');
  if (g.bounty && g.bounty.on) list.push('bounty');
  if (g.finder && g.finder.on) list.push('finder');
  if (g.travelling && now - g.travelling.at < 8 * 60000) list.push('travel');
  if (g.crowdBusy) list.push('crowd');
  if (g.ramReloadAt && now - g.ramReloadAt < 90 * 1000) list.push('ram');
  list.sort((a, b) => DRIVE_PRIO[b] - DRIVE_PRIO[a]);
  return list[0] || null;
}
// who may go ahead: nobody else drives, or it is itself, or it outranks the one driving
function mayAct(g, who) {
  const d = driverOf(g);
  return !d || d === who || DRIVE_PRIO[who] > DRIVE_PRIO[d];
}
function waitNote(g) { const d = driverOf(g); return d ? `รอ: กำลัง${DRIVE_TH[d]}` : ''; }

// ---------- AUTO on but nothing hit for 3 minutes: switch AUTO off and on again (at most 4 times an hour) ----------
async function stuckCheck(id, g) {
  if (!store.data.settings.stuckFix || !g.inGame || g.demo || g.status !== 'online' || g.alerts.has('death') || g.humanCheck) return;
  const d0 = driverOf(g); if (d0 && d0 !== 'bounty' && d0 !== 'finder') return; // something is moving it (a bounty / finder standing on its map may be helped)
  if (g.bounty && g.bounty.on && g.bounty.phase === 'travel') return;
  const now = Date.now(); const last = Math.max(g.lastHitAt || 0, g.inGameAt || 0, g.autoSeenOffAt || 0);
  if (now - last < 3 * 60000) return;
  const ui = await liveUi(id);
  if (!ui.auto || ui.sleeping) { g.autoSeenOffAt = now; return; } // the player switched AUTO off: leave it
  g.kicks = (g.kicks || []).filter((t) => now - t < 3600000);
  if (g.kicks.length >= 4 || (g.kicks.length && now - g.kicks[g.kicks.length - 1] < 4 * 60000)) return;
  g.kicks.push(now);
  log.info(`acc ${id}: AUTO on but no hit for ${Math.round((now - last) / 60000)} min on ${mapOf(g)} -> AUTO off/on (${g.kicks.length} this hour)`);
  g.data.log('other', '🔧 AUTO เปิดอยู่แต่ไม่ได้ตี 3 นาที · ปิดแล้วเปิด AUTO ใหม่');
  selftest.count(id, 'stuckFix');
  await gameCommand(id, 'auto', {}); await new Promise((r) => setTimeout(r, 1500));
  if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
  g.autoSeenOffAt = now; // give it 3 more minutes
}

// ---------- after a death-loop pause: back to the farming spot, AUTO on (once an hour; a second loop = stay, say so) ----------
async function loopBackCheck(id, g) {
  const L = g.loopBack;
  if (!L || L.done || L.busy || !g.inGame || g.demo || g.status !== 'online' || !L.map) return;
  if (g.respawnPausedUntil && Date.now() < g.respawnPausedUntil) return;
  if (L.giveUp) { L.done = true; notify(id, 'death', `☠ ตายวนซ้ำอีกรอบใน 1 ชม. ที่ ${mapName(L.map)} · ไม่พากลับแล้ว รอคุณดู (ลองแมพที่มอนเบาลง หรือเช็คยา/อุปกรณ์)`); log.info(`acc ${id}: death loop again at ${L.map} -> not going back`); return; }
  if (WORLD_ARENAS.has(mapOf(g)) && !g.bossTrip && Date.now() - L.at < 3 * 60000) return; // still leaving the arena
  if (g.bossTrip || WORLD_ARENAS.has(mapOf(g))) return; // a new boss trip: wait for it
  // a bounty or the finder took the character meanwhile: they decide where it goes now
  if ((g.bounty && g.bounty.on) || (g.finder && g.finder.on)) { L.done = true; log.info(`acc ${id}: back to farm: not needed, ${g.bounty && g.bounty.on ? 'bounty' : 'farm finder'} runs it`); return; }
  L.busy = true;
  try {
    if (mapOf(g) !== L.map) {
      log.info(`acc ${id}: ${L.why === 'boss' ? 'world boss done' : 'death-loop pause over'}, in ${mapOf(g)} -> back to ${L.map}`);
      const r = await travelTo(id, g, L.map);
      if (!r.ok) { L.done = true; log.info(`acc ${id}: back to farm: ${r.error}`); return; }
      if (!r.here && !(await arrive(id, g, L.map, 6 * 60000, true))) { L.done = true; log.info(`acc ${id}: back to farm: did not arrive`); return; }
    }
    if (L.x != null) {
      if ((await liveUi(id)).auto) await gameCommand(id, 'auto', {});
      // up to ~3 minutes: the spot can be across a big map from where the warp lands
      let left = null;
      for (let i = 0; i < 70; i++) { // eslint-disable-line no-await-in-loop
        const st = (g.data.world && g.data.world.self) || {};
        if (st.x == null) { await new Promise((r) => setTimeout(r, 1500)); continue; } // eslint-disable-line no-await-in-loop
        left = Math.hypot(st.x - L.x, st.y - L.y);
        if (left <= 3 || mapOf(g) !== L.map) break;
        await sendInput(id, { type: 'moveTo', x: L.x, y: L.y }); // eslint-disable-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 2500)); // eslint-disable-line no-await-in-loop
      }
      log.info(`acc ${id}: walked back to ${Math.round(L.x)},${Math.round(L.y)} on ${L.map}${left != null ? ` (${Math.round(left)} tiles left)` : ' (position unknown)'}`);
    }
    if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
    g.autoSeenOffAt = Date.now();
    L.done = true;
    log.info(`acc ${id}: back at the farming spot on ${L.map}${L.why === 'boss' ? ' after the world boss' : ''}, AUTO on`);
    g.data.log('other', `↩ กลับจุดฟาร์ม${L.why === 'boss' ? 'หลังตีบอสโลก' : 'หลังพักเกิดที่เดิม 10 นาที'} · ${mapName(L.map)} · เปิด AUTO`);
  } finally { L.busy = false; }
}

// ---------- travel to any map with the game's own world-map "travel" button ----------
// The game opens its world map on a map from the hunt window's "ไปที่แมพ" buttons; the button reads the map when
// clicked, so any of them can open the world map on another map. Then the game's "เดินทางไป …" (warp when free).
// The game's own "open the world map on this map" (its module exports it as openWorldMap; the hunt window, the
// guide and the atlas all call it), then the game's "เดินทางไป …" button: warps when free, else walks.
// Fallback when the module cannot be reached: a hunt-window "ไปที่แมพ" button pointed at the map (needs a bounty left).
const TRAVEL_JS = (map) => `(async () => { const MAP = ${JSON.stringify(map)}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let how = '';
  try {
    if (!window.__bdOpenWorld) {
      const urls = [...new Set([...performance.getEntriesByType('resource').map((e) => e.name), ...[...document.scripts].map((x) => x.src)].filter((u) => /\\/assets\\/main-[\\w-]+\\.js(\\?|$)/.test(u || '')))];
      for (const u of urls) { try { const m = await import(u); if (m && typeof m.openWorldMap === 'function') { window.__bdOpenWorld = m.openWorldMap; break; } } catch (e) {} }
    }
    if (window.__bdOpenWorld) { window.__bdOpenWorld(MAP, true); how = 'worldmap'; }
  } catch (e) {}
  if (!how) {
    const win = document.getElementById('huntwin'); const open = document.getElementById('openhunt'); if (!win || !open) return { ok: false, why: 'no world map and no hunt window' };
    if (win.style.display !== 'block') open.click();
    await wait(600);
    let b = document.querySelector('#huntwin [data-goto]');
    if (!b) { for (const t of win.querySelectorAll('[data-htab]')) { t.click(); await wait(400); b = document.querySelector('#huntwin [data-goto]'); if (b) break; } }
    if (!b) { win.style.display = 'none'; return { ok: false, why: 'no map button' }; }
    b.dataset.goto = MAP; b.click(); how = 'hunt';
  }
  let go = null; for (let i = 0; i < 10 && !go; i++) { await wait(300); go = document.querySelector('.wdgo'); }
  if (!go) return { ok: false, why: 'no travel button (' + how + ')' };
  go.click(); return { ok: true, how }; })()`;
async function travelTo(id, g, map) {
  if (mapOf(g) === map) return { ok: true, here: true };
  if ((await liveUi(id)).auto) await gameCommand(id, 'auto', {}); // the game's travel walks; AUTO would fight on the way
  let r; try { r = await g.win.webContents.executeJavaScript(TRAVEL_JS(map), true); } catch (e) { r = { ok: false, why: e.message }; }
  if (!r || !r.ok) return { ok: false, error: `เดินทางไม่ได้ (${(r && r.why) || '?'})` };
  g.travelling = { map, at: Date.now() }; farmDirty(g);
  log.info(`acc ${id}: travel ${mapOf(g)} -> ${map} (${r.how})`);
  await answerWarpBox(id, g);
  return { ok: true };
}
// wait until the character is on the map (6 minutes at most), then AUTO on over the whole map
async function arrive(id, g, map, maxMs = 6 * 60000, keepRange = false) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!g.win || g.win.isDestroyed()) return false;
    if (mapOf(g) === map) {
      await new Promise((r) => setTimeout(r, 2500));
      g.travelling = null;
      if (keepRange) return true; // the caller walks to its spot and starts AUTO there
      await setFarmRange(g, 0);
      if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
      g.autoSeenOffAt = Date.now();
      return true;
    }
    if ((Date.now() - t0) % 20000 < 2100) await answerWarpBox(id, g);
    await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
  }
  g.travelling = null;
  return false;
}

// ---------- find the farm that pays most: try the best few maps for real, then stay on the winner ----------
// Candidates: Build Lab's map list for this character (its level, safe enough: 5+ hits to die) + maps it already
// farmed. Each new one is farmed N minutes and judged by the ledger above; maps with enough recent minutes are not
// tried again. Free travel only (walks when a warp would cost Gold). Stops for world bosses and bounties.
function finderStatus(g) { const f = g.finder; return f ? { on: !!f.on, note: f.note || '', i: f.i, n: (f.list || []).length, best: f.best || null } : null; }
async function finderStart(id, on) {
  const g = games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!on) { if (g.finder) { g.finder.on = false; g.finder.note = 'หยุดแล้ว'; } g.travelling = null; log.info(`acc ${id}: farm finder stopped`); pushState(); return { ok: true }; }
  if (g.bounty && g.bounty.on) return { ok: false, error: 'กำลังทำค่าหัวอยู่ · หยุดค่าหัวก่อน' };
  const me = labMeRef && await labMeRef(id);
  if (!me) return { ok: false, error: 'อ่านข้อมูลตัวละครไม่ได้' };
  let sim = null;
  try {
    sim = await labCall(`window.__bdLab.maps(${JSON.stringify({ job: me.job, level: me.level, jobLevel: me.jobLevel, stats: me.stats, basics: me.skills, guild: me.guildLevel || 0, c2Job: (me.c2info && me.c2info.jobLevel) || 50,
      loadout: { ...(me.loadout || {}), wRefine: me.wRefine, sRefine: me.sRefine }, build: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr }, pack: 3, top: 40 })})`);
  } catch (e) { log.warn(`acc ${id}: farm finder maps: ${e.message}`); }
  const lv = me.level;
  const minutes = Math.max(5, Math.min(30, Number(store.data.settings.farmTrialMinutes) || 10));
  const known = new Map([...farmSummary(id, lv).filter((x) => x.est && x.histMinutes >= 30), ...farmSummary(id, lv, Math.floor(Date.now() / 60000) - 3 * 1440).filter((x) => x.minutes >= minutes)].map((x) => [x.map, x]));
  // safe first (5+ hits to die); if that leaves fewer than 3 other maps, take 3+ hits, then any in the level band
  const inBand = ((sim && sim.rows) || []).filter((r) => r.band && r.band[0] <= lv + 3 && !WORLD_ARENAS.has(r.id));
  let rows = inBand.filter((r) => r.hitsToDie == null || r.hitsToDie >= 5);
  if (rows.filter((r) => r.id !== mapOf(g)).length < 3) rows = inBand.filter((r) => r.hitsToDie == null || r.hitsToDie >= 3);
  if (rows.filter((r) => r.id !== mapOf(g)).length < 3) rows = inBand;
  if (!sim) log.info(`acc ${id}: farm finder: Build Lab map list not available, only maps farmed before`);
  const list = [];
  const here = mapOf(g);
  if (!known.has(here) && !WORLD_ARENAS.has(here)) list.push({ map: here, sim: (rows.find((r) => r.id === here) || {}).silverHr || 0 });
  for (const r of rows) { if (list.length >= 4) break; if (!known.has(r.id) && !list.some((x) => x.map === r.id)) list.push({ map: r.id, sim: r.silverHr }); }
  if (!list.length && !known.size) return { ok: false, error: 'หาแมพที่จะลองไม่ได้ (Build Lab ไม่ตอบ และยังไม่เคยฟาร์มที่ไหน) · ลองใหม่อีกครั้ง' };
  if (list.length <= 1 && known.size === 0) log.info(`acc ${id}: farm finder: only ${list.length} map to try`);
  g.finder = { on: true, list, i: 0, phase: 'go', minutes, lv, note: 'เริ่ม', start: 0, deaths0: 0, tries: {} };
  log.info(`acc ${id}: farm finder start (Lv ${lv}, ${minutes} min each): try ${list.map((x) => x.map).join(', ') || '-'}; known ${[...known.keys()].join(', ') || '-'}`);
  finderStep(id).catch((e) => log.warn(`acc ${id}: farm finder: ${e.message}`));
  pushState();
  return { ok: true, trying: list.map((x) => mapName(x.map)), known: [...known.values()].map((x) => x.name) };
}
async function finderStep(id) {
  const g = games.get(id); const f = g && g.finder;
  if (!f || !f.on || f.busy || !g.inGame || g.demo || g.status !== 'online') return;
  if (g.bounty && g.bounty.on) { f.on = false; f.note = 'หยุด: เริ่มทำค่าหัว'; return; }
  if (!mayAct(g, 'finder')) { f.note = waitNote(g) || f.note; return; } // a world boss (or the way back from it) first
  f.busy = true;
  try {
    const deaths = (selftest.counters.get(id) || {}).deaths || 0;
    if (f.phase === 'go') {
      const c = f.list[f.i];
      if (!c) { f.phase = 'pick'; return; }
      f.note = `ไปลองฟาร์ม ${mapName(c.map)} (${f.i + 1}/${f.list.length})`;
      const r = await travelTo(id, g, c.map);
      if (!r.ok) { log.info(`acc ${id}: farm finder: ${r.error} -> skip ${c.map}`); f.i++; return; }
      if (!r.here && !(await arrive(id, g, c.map))) { log.info(`acc ${id}: farm finder: did not reach ${c.map} -> skip`); f.i++; return; }
      if (r.here) { await setFarmRange(g, 0); if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); }
      f.phase = 'measure';
      if (f.back) { f.back = false; f.at += Date.now() - f.leftAt; return; } // back after dying in town: keep counting
      f.start = Math.floor(Date.now() / 60000) + 1; f.deaths0 = deaths; f.at = Date.now();
      log.info(`acc ${id}: farm finder measuring ${c.map} for ${f.minutes} min`);
      return;
    }
    if (f.phase === 'measure') {
      const c = f.list[f.i];
      const got = (farmSummary(id, 0, f.start).find((x) => x.map === c.map) || {}).minutes || 0;
      f.note = `วัดผล ${mapName(c.map)} ${got}/${f.minutes} นาที (${f.i + 1}/${f.list.length})`;
      // dying already shows in the measured profit (time lost); with respawn in place it is no reason to skip a map,
      // only a death loop is (the respawn guard's own limit). Without it every death is a walk back from town.
      if (deaths - f.deaths0 >= (g.autoRespawn && g.autoRespawn.on ? 8 : 3)) { log.info(`acc ${id}: farm finder: ${deaths - f.deaths0} deaths on ${c.map} -> not safe, next`); c.unsafe = true; f.i++; f.phase = 'go'; return; }
      if (got >= f.minutes || Date.now() - f.at > f.minutes * 2 * 60000) { f.i++; f.phase = 'go'; return; }
      // died and woke up in town (no respawn in place): go back to the map being tried
      if (mapOf(g) !== c.map && !g.travelling && !g.alerts.has('death')) { log.info(`acc ${id}: farm finder: in ${mapOf(g)} instead of ${c.map} (died?) -> back`); f.back = true; f.leftAt = Date.now(); f.phase = 'go'; }
      return;
    }
    if (f.phase === 'pick') {
      const unsafe = new Set(f.list.filter((x) => x.unsafe).map((x) => x.map));
      // measured in the last 3 days, plus maps known from the stats log (estimated); the measured number wins per map
      const recent = farmSummary(id, f.lv, Math.floor(Date.now() / 60000) - 3 * 1440).filter((x) => x.minutes >= 3);
      const fromLog = farmSummary(id, f.lv).filter((x) => x.est && x.histMinutes >= 30 && !recent.some((y) => y.map === x.map));
      const all = [...recent, ...fromLog].filter((x) => !unsafe.has(x.map) && !WORLD_ARENAS.has(x.map)).sort((p, q) => q.netHr - p.netHr);
      const best = all[0];
      if (!best) { f.on = false; f.note = 'ยังไม่มีข้อมูลพอ (ไม่ได้ฟาร์มครบนาทีในแมพไหนเลย)'; return; }
      f.best = { map: best.map, name: best.name, netHr: best.netHr };
      f.note = `ไปฟาร์มที่ดีสุด ${best.name}`;
      const r = await travelTo(id, g, best.map);
      if (r.ok && !r.here) await arrive(id, g, best.map);
      else if (r.here) { if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); }
      f.on = false;
      f.note = `ดีสุด: ${best.name} ~${Math.round(best.netHr).toLocaleString('en-US')} Silver/ชม.`;
      const top = all.slice(0, 4).map((x, k) => `${k + 1}. ${x.name} ${Math.round(x.netHr / 1000)}k/ชม.`).join(' · ');
      log.info(`acc ${id}: farm finder done -> ${best.map} (${best.netHr}/h); ${all.map((x) => `${x.map} ${x.netHr} (${x.minutes} min)`).join(', ')}`);
      notify(id, 'farm', `🔎 หาที่ฟาร์มเสร็จ · ${top}${unsafe.size ? ` · ตายบ่อย ข้าม: ${[...unsafe].map(mapName).join(', ')}` : ''}`);
    }
  } finally { f.busy = false; pushState(); }
}
async function farmGo(id, map) {
  const g = games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!mayAct(g, 'travel')) return { ok: false, error: waitNote(g) || 'ตัวละครกำลังทำอย่างอื่นอยู่' };
  if (g.finder && g.finder.on) { g.finder.on = false; g.finder.note = 'หยุด: คุณเลือกแมพเอง'; } // the player's choice wins over the finder
  const r = await travelTo(id, g, map);
  if (!r.ok) return r;
  if (r.here) { if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); return { ok: true }; }
  arrive(id, g, map).then((ok) => log.info(`acc ${id}: go farm ${map}: ${ok ? 'arrived, AUTO on' : 'did not arrive'}`)).catch(() => {});
  return { ok: true };
}
// dying a lot on a farm map costs real money (5,000 G a respawn): say so once in a while, with a better map
function deathRateCheck(id, g) {
  const now = Date.now(); const map = mapOf(g);
  if (!map || WORLD_ARENAS.has(map) || g.bossTrip) return;
  const n = (g.deathLog || []).filter((t) => now - t < 3600000).length;
  if (n < 20 || (g.deathWarnAt && now - g.deathWarnAt < 6 * 3600000) || store.data.settings.notify.deathRate === false) return;
  if (g.inGameAt && now - g.inGameAt < 45 * 60000) return; // an hour's worth first
  g.deathWarnAt = now;
  const lv = g.data.stats.level || 0;
  const rows = farmSummary(id, lv).filter((x) => !WORLD_ARENAS.has(x.map));
  const here = rows.find((x) => x.map === map);
  const better = rows.filter((x) => x.map !== map && (x.deathsHr == null || x.deathsHr < n / 2) && (!here || x.netHr > here.netHr))[0];
  log.info(`acc ${id}: ${n} deaths in the last hour on ${map} (~${n * 5000} G in respawns)${better ? ` -> suggest ${better.map} (${better.netHr}/h)` : ''}`);
  notify(id, 'deathRate', `☠ ตาย ${n} ครั้งใน 1 ชม. ที่ ${mapName(map)} · ค่าเกิด ~${(n * 5000).toLocaleString('en-US')} G/ชม.${here ? ` (เงินจากมอน ~${Math.round(here.killSilverHr / 1000)}k/ชม.)` : ''}${better ? ` · แมพที่คุ้มกว่า: ${better.name} ~${Math.round(better.netHr / 1000)}k/ชม. (กด 📊 แมพที่เคยฟาร์ม → ไปฟาร์ม)` : ''}`);
}
function farmTick() {
  for (const [id, g] of games) {
    if (!g.inGame || g.demo) continue;
    farmBucket(g); // closes the minute that just ended
    stuckCheck(id, g).catch(() => {});
    deathRateCheck(id, g);
    loopBackCheck(id, g).catch((e) => log.warn(`acc ${id}: back to farm: ${e.message}`));
    finderStep(id).catch((e) => log.warn(`acc ${id}: farm finder: ${e.message}`));
  }
}
// ---------- collect rewards: mail gifts, Pass missions (daily / weekly) and Pass tiers ----------
// the same messages the game's own "รับ" buttons send (mail one by one, then "claim all" on the Pass page)
async function claimRewards(id) {
  const g = games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
  const waitFor = async (key, since) => { for (let i = 0; i < 20; i++) { if (g[key] && g[key].at >= since) return g[key]; await new Promise((r) => setTimeout(r, 250)); } return null; }; // eslint-disable-line no-await-in-loop
  const out = { mail: 0, daily: 0, weekly: 0, tiers: false };
  farmDirty(g); g.claimUntil = Date.now() + 90000;
  let t0 = Date.now(); await sendInput(id, { type: 'mailQuery' });
  const mail = await waitFor('mailSeen', t0);
  for (const mid of (mail && mail.giftIds) || []) { await sendInput(id, { type: 'mailClaim', id: mid }); out.mail++; await new Promise((r) => setTimeout(r, 350)); } // eslint-disable-line no-await-in-loop
  t0 = Date.now(); await sendInput(id, { type: 'passQuery' });
  const pass = await waitFor('passSeen', t0);
  for (const m of ((pass && pass.daily) || []).filter((x) => x.ready)) { await sendInput(id, { type: 'dailyClaim', id: m.id }); out.daily++; await new Promise((r) => setTimeout(r, 350)); } // eslint-disable-line no-await-in-loop
  for (const m of ((pass && pass.weekly) || []).filter((x) => x.ready)) { await sendInput(id, { type: 'weeklyClaim', id: m.id }); out.weekly++; await new Promise((r) => setTimeout(r, 350)); } // eslint-disable-line no-await-in-loop
  await sendInput(id, { type: 'passClaimAll' }); out.tiers = true; // Pass tiers that are unlocked (the game skips when none)
  await new Promise((r) => setTimeout(r, 800));
  await sendInput(id, { type: 'mailQuery' }); await sendInput(id, { type: 'passQuery' }); // fresh numbers for the dashboard
  log.info(`acc ${id}: rewards collected: ${out.mail} mail, ${out.daily} daily, ${out.weekly} weekly mission(s), pass tiers`);
  if (!mail && !pass) return { ok: false, error: 'เกมไม่ตอบ (ลองใหม่อีกครั้ง)' };
  return { ok: true, ...out };
}

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
  const s = store.data.settings;
  if (!s.crowdSwitch || !g.inGame || g.demo || g.status !== 'online' || !g.win || g.win.isDestroyed() || g.crowdBusy) return;
  if (driverOf(g)) { g.crowdSince = 0; g.crowdHist = []; return; } // only while the character just farms
  if (!(await liveUi(id)).auto) { g.crowdSince = 0; g.crowdHist = []; return; } // only while AUTO farms
  let c; try { c = await g.win.webContents.executeJavaScript(CROWD_JS, true); } catch { c = null; }
  if (!c || !c.ch || c.ch === PVP_CH) { g.crowdSince = 0; g.crowdHist = []; return; }
  const need = Math.max(1, Number(s.crowdPlayers) || 3);
  // most of the last N minutes, not every check: players walk in and out of the circle all the time, and one
  // quiet check used to start the count over (a log showed 4 players around for minutes and no move)
  const win = Math.max(1, Number(s.crowdMinutes) || 2) * 60000; const now0 = Date.now();
  const H = (g.crowdHist = (g.crowdHist || []).filter(([t]) => now0 - t <= win)); H.push([now0, c.near, c.ch]);
  if (H.some(([, , ch]) => ch !== c.ch)) { g.crowdHist = [[now0, c.near, c.ch]]; return; } // changed channel meanwhile
  const busy = H.filter(([, n]) => n >= need).length;
  if (c.near >= need && (!g.crowdLogAt || now0 - g.crowdLogAt > 60000)) { g.crowdLogAt = now0; log.info(`acc ${id}: ${c.near} other player(s) in the AUTO circle (CH ${c.ch}) · crowded ${busy}/${H.length} checks in the last ${Math.round((now0 - H[0][0]) / 60000)} min`); }
  if (now0 - H[0][0] < win * 0.85 || busy / H.length < 0.7 || c.near < need) return;
  g.crowdSince = H[0][0];
  if (g.crowdMovedAt && Date.now() - g.crowdMovedAt < 10 * 60000) return;
  g.crowdBusy = true;
  try {
    const asked = Date.now();
    await sendInput(id, { type: 'channelQuery' });
    for (let i = 0; i < 20 && !(g.channels && g.channels.at >= asked); i++) await new Promise((r) => setTimeout(r, 250)); // eslint-disable-line no-await-in-loop
    const counts = (g.channels && g.channels.at >= asked && g.channels.counts) || [];
    if (!counts.length) { log.info(`acc ${id}: crowded, but the channel list did not come`); return; }
    if (g.channels.lockMs > 30000) { log.info(`acc ${id}: crowded, channel change locked for ${Math.ceil(g.channels.lockMs / 1000)} s`); return; }
    if (g.channels.lockMs > 0) await new Promise((r) => setTimeout(r, g.channels.lockMs + 600)); // the game's short lock after arriving
    const here = counts[c.ch - 1] ?? 999;
    let best = 0;
    for (let ch = 1; ch <= counts.length; ch++) { if (ch === c.ch || ch === PVP_CH) continue; if (!best || (counts[ch - 1] ?? 999) < (counts[best - 1] ?? 999)) best = ch; }
    if (!best || (counts[best - 1] ?? 999) > here - 2) { log.info(`acc ${id}: crowded, but no quieter channel (here ${here}, quietest CH ${best} ${counts[best - 1]})`); g.crowdMovedAt = Date.now(); return; }
    g.crowdMovedAt = Date.now(); g.crowdSince = 0; g.crowdHist = [];
    log.info(`acc ${id}: crowded (${c.near} in the circle, CH ${c.ch} ${here} players) -> CH ${best} (${counts[best - 1]} players), back to ${c.x},${c.y}`);
    await sendInput(id, { type: 'switchChannel', channel: best });
    // wait for the new channel, then walk back to the same spot and fight there again
    let now = null;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { now = await g.win.webContents.executeJavaScript(CROWD_JS, true); } catch { now = null; } if (now && now.ch === best && now.map === c.map) break; } // eslint-disable-line no-await-in-loop
    if (!now || now.ch !== best) { log.info(`acc ${id}: channel did not change (still CH ${now && now.ch})`); return; }
    if ((await liveUi(id)).auto) await gameCommand(id, 'auto', {}); // off while walking back (it would fight on the way)
    for (let i = 0; i < 15; i++) { // eslint-disable-line no-await-in-loop
      let p; try { p = await g.win.webContents.executeJavaScript(CROWD_JS, true); } catch { p = null; } // eslint-disable-line no-await-in-loop
      if (!p || Math.hypot(p.x - c.x, p.y - c.y) <= 3) break;
      await sendInput(id, { type: 'moveTo', x: c.x, y: c.y }); // eslint-disable-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
    }
    if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
    selftest.count(id, 'crowdMoves');
    notify(id, 'crowd', `👥 คนเยอะ (${c.near} คนในวง) · ย้าย CH ${c.ch} → CH ${best} (${counts[best - 1]} คน) กลับจุดเดิมแล้วเปิด AUTO`);
  } catch (err) { log.warn(`acc ${id}: crowd move: ${err.message}`); } finally { g.crowdBusy = false; }
}
function crowdTick() { for (const [id, g] of games) crowdCheck(id, g).catch(() => {}); }

// ---------- daily bounties (ค่าหัว): claim what is done, then go and hunt the next one ----------
// Everything goes through the game's own hunt window: its list (map, monster, progress), its
// "go to map" button and the world map's "travel" button (the game walks there by itself),
// then the monster is looked up on the map, AUTO goes on next to it, and the reward is claimed at 40/40.
const MOB_BY_NAME = (() => { const m = require('./game-names').mobs || {}; const o = {}; for (const [id, nm] of Object.entries(m)) if (!o[nm]) o[nm] = id; return o; })();
const BOUNTY_LIST_JS = `(() => { const win = document.getElementById('huntwin'); if (!win) return null;
  const wasOpen = win.style.display === 'block'; if (!wasOpen) { const b = document.getElementById('openhunt'); if (!b) return null; b.click(); }
  const tab = win.querySelector('[data-htab="bounty"]'); if (tab && !tab.classList.contains('on')) tab.click();
  const out = [...document.querySelectorAll('#huntbody .hu1b')].map((x) => { const go = x.querySelector('[data-goto]'); const cl = x.querySelector('[data-claim]'); const sm = [...x.querySelectorAll('.hu1tx small')].map((e) => e.textContent);
    const band = /Lv\\s*(\\d+)\\D+(\\d+)/.exec(sm[0] || ''); const pr = /(\\d+)\\s*\\/\\s*(\\d+)/.exec(sm[1] || '');
    return { id: cl ? cl.dataset.claim : '', map: go ? go.dataset.goto : '', name: ((x.querySelector('.hu1tx b') || {}).textContent || '').replace(/\\s*×\\s*\\d+\\s*$/, '').trim(),
      lo: band ? +band[1] : 0, hi: band ? +band[2] : 0, prog: pr ? +pr[1] : 0, need: pr ? +pr[2] : 40, claimed: x.classList.contains('claimed'), done: x.classList.contains('done') }; });
  if (!wasOpen) win.style.display = 'none';
  return out; })()`;
const BOUNTY_GO_JS = (map) => `(async () => { const win = document.getElementById('huntwin'); if (win.style.display !== 'block') document.getElementById('openhunt').click();
  await new Promise((r) => setTimeout(r, 600));
  const b = document.querySelector('#huntbody [data-goto="' + ${JSON.stringify(map)} + '"]'); if (!b) return { ok: false, why: 'no button' }; b.click();
  await new Promise((r) => setTimeout(r, 900));
  const go = document.querySelector('.wdgo'); if (!go) return { ok: false, why: 'no travel button' }; go.click(); return { ok: true }; })()`;
// the game's "warp to X (then walk on)?" box: warp when it is free (Premium), else walk (never pays Gold)
const WARP_CONFIRM_JS = `(() => { const box = document.getElementById('buyconfirm'); if (!box || box.style.display === 'none' || !box.offsetParent && getComputedStyle(box).display === 'none') return { box: false };
  const text = box.innerText || ''; if (!/วาร์ป/.test(text)) return { box: true, warp: false };
  const free = /ฟรี/.test(text); const b = document.getElementById(free ? 'bcyes' : 'bcno'); if (!b || b.disabled) return { box: true, warp: true, free, pressed: false };
  b.click(); return { box: true, warp: true, free, pressed: true }; })()`;
async function answerWarpBox(id, g) {
  for (let i = 0; i < 8; i++) { // the box comes after the server answers (a moment)
    let r; try { r = await g.win.webContents.executeJavaScript(WARP_CONFIRM_JS, true); } catch { r = null; } // eslint-disable-line no-await-in-loop
    if (r && r.pressed) { log.info(`acc ${id}: travel -> ${r.free ? 'warp (free)' : 'walk (warp would cost Gold)'}`); return r; }
    await new Promise((res) => setTimeout(res, 500)); // eslint-disable-line no-await-in-loop
  }
  return null;
}
// the game's own AUTO settings "targets on this map" (one switch per monster kind, off = AUTO never hits it):
// keep only the bounty monster on, or put back the ones BinderDash switched off. Bosses are left alone.
const MOB_FILTER_JS = (mode, names) => `(async () => { const win = document.getElementById('autoopts'); const open = document.getElementById('autoopt'); if (!win || !open) return { ok: false, why: 'no auto settings' };
  const was = win.style.display === 'block'; if (!was) open.click();
  await new Promise((r) => setTimeout(r, 400));
  const mode = ${JSON.stringify(mode)}; const names = ${JSON.stringify(names)}; const changed = []; let found = false;
  for (let guard = 0; guard < 40; guard++) {
    const btns = [...document.querySelectorAll('#au-targets .autg')];
    const pick = btns.find((b) => { const nm = ((b.querySelector('.autgn b') || {}).textContent || '').trim(); if (b.querySelector('em.r-boss')) return false;
      const on = b.classList.contains('on');
      if (mode === 'only') { if (nm === names[0]) { found = true; return !on; } return on && !changed.includes(nm); }
      return names.includes(nm) && !on; });
    if (!pick) break;
    const nm = ((pick.querySelector('.autgn b') || {}).textContent || '').trim();
    pick.click(); if (!(mode === 'only' && nm === names[0])) changed.push(nm);
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!was) win.style.display = 'none';
  return { ok: true, changed, found: mode === 'only' ? found || [...document.querySelectorAll('#au-targets .autg .autgn b')].some((b) => b.textContent.trim() === names[0]) : true }; })()`;
async function bountyFilterOn(id, g, map, name) {
  let r; try { r = await g.win.webContents.executeJavaScript(MOB_FILTER_JS('only', [name]), true); } catch (e) { r = { ok: false, why: e.message }; }
  if (r && r.ok && r.changed.length) { g.mobFilter = { map, names: [...new Set([...((g.mobFilter && g.mobFilter.map === map && g.mobFilter.names) || []), ...r.changed])] }; store.data.mobFilter = { ...(store.data.mobFilter || {}), [id]: g.mobFilter }; store.save(); }
  log.info(`acc ${id}: bounty -> AUTO only on ${name}${r && r.ok ? ` (${r.changed.length} other kind(s) switched off)` : ` (could not set: ${(r && r.why) || '?'})`}`);
  return r;
}
async function bountyFilterOff(id, g) {
  const f = g.mobFilter || (store.data.mobFilter || {})[id];
  if (!f || !f.names || !f.names.length || mapOf(g) !== f.map || !g.win || g.win.isDestroyed()) return false;
  let r; try { r = await g.win.webContents.executeJavaScript(MOB_FILTER_JS('restore', f.names), true); } catch { r = null; }
  if (r && r.ok) { g.mobFilter = null; const all = store.data.mobFilter || {}; delete all[id]; store.save(); log.info(`acc ${id}: AUTO targets back as they were (${r.changed.length} kind(s) on again)`); return true; }
  return false;
}
const MOB_SPOT_JS = (type) => `(() => { try { const g = window.__game; const me = g.me(); const all = []; g.state().mobs.forEach((m) => all.push(m));
  const want = all.filter((m) => (m.mobType || m.type) === ${JSON.stringify(type)} && m.hp > 0).map((m) => ({ x: m.x, y: m.y, d: Math.hypot(m.x - me.x, m.y - me.y) })).sort((a, b) => a.d - b.d);
  return want.length ? { x: Math.round(want[0].x), y: Math.round(want[0].y), d: want[0].d, n: want.length } : { n: 0 }; } catch (e) { return null; } })()`;
// the game's AUTO range (AUTO settings: N tiles around the start point, or 0 = whole map); returns the old one
const FARM_R_JS = (v) => `(() => { const box = document.getElementById('au-farm'); if (!box) return null; const on = box.querySelector('[data-farm].on'); const prev = on ? Number(on.dataset.farm) : null;
  const b = box.querySelector('[data-farm="' + ${JSON.stringify(String(v))} + '"]'); if (b && prev !== ${Number(v)}) b.click(); return prev; })()`;
async function setFarmRange(g, v) { try { return await g.win.webContents.executeJavaScript(FARM_R_JS(v), true); } catch { return null; } }
async function bountyRestore(g, id) {
  if (id != null) await bountyFilterOff(id, g); const B = g.bounty; if (B && B.prevFarm != null && g.win && !g.win.isDestroyed()) { await setFarmRange(g, B.prevFarm); B.prevFarm = null; } }
async function bountyList(id) {
  const g = games.get(id); if (!g || !g.win || g.win.isDestroyed()) return null;
  try { return await g.win.webContents.executeJavaScript(BOUNTY_LIST_JS, true); } catch { return null; }
}
function bountyStatus(g) { const b = g.bounty; return b ? { on: !!b.on, phase: b.phase, target: b.cur ? `${b.cur.name} @ ${b.cur.map}` : '', done: b.claimedN || 0, note: b.note || '' } : null; }
async function bountyStart(id, on = true) {
  const g = games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เข้าเกม' };
  if (!on) { if (g.bounty) { g.bounty.on = false; g.bounty.phase = 'off'; await bountyRestore(g, id); } log.info(`acc ${id}: bounties off`); pushState(); return { ok: true }; }
  g.bounty = { on: true, phase: 'start', claimedN: 0, skip: [], at: Date.now(), note: '' };
  await sendInput(id, { type: 'huntQuery' });
  log.info(`acc ${id}: bounties on`);
  pushState();
  setTimeout(() => bountyStep(id), 1500);
  return { ok: true };
}
async function bountyClaimDone(id, list) {
  const g = games.get(id); let n = 0;
  for (const b of list || []) {
    if (!b.id || b.claimed || b.prog < b.need) continue;
    farmDirty(g); await sendInput(id, { type: 'bountyClaim', id: b.id }); // eslint-disable-line no-await-in-loop
    n++; log.info(`acc ${id}: bounty claimed ${b.id} (${b.name || b.map || ''})`);
    await new Promise((r) => setTimeout(r, 500)); // eslint-disable-line no-await-in-loop
  }
  if (n) { if (g.bounty) g.bounty.claimedN = (g.bounty.claimedN || 0) + n; selftest.count(id, 'bountyClaims', n); await sendInput(id, { type: 'huntQuery' }); }
  return n;
}
async function bountyStep(id) {
  const g = games.get(id); const B = g && g.bounty;
  if (!B || !B.on || !g.inGame || g.demo || !g.win || g.win.isDestroyed() || B.busy) return;
  if (!mayAct(g, 'bounty')) { B.note = waitNote(g) || 'พักไว้'; return; } // a world boss (or the way back from it) first
  B.busy = true;
  try {
    const list = await bountyList(id);
    if (!list || !list.length) { B.note = 'อ่านหน้าค่าหัวไม่ได้'; return; }
    // the hunt window shows the last progress it got: merge the server's numbers in
    if (g.hunt) for (const b of list) { if (g.hunt.prog[b.id] != null) b.prog = Math.min(b.need, g.hunt.prog[b.id]); if (g.hunt.claimed.includes(b.id)) b.claimed = true; }
    await bountyClaimDone(id, list);
    const lv = Number(g.data.stats.level) || 0; const here = mapOf(g);
    B.later = B.later || {};
    const doable = list.filter((b) => b.map && !b.claimed && b.prog < b.need && !B.skip.includes(b.id) && (!b.hi || b.hi <= lv + 2));
    // set aside for 30 min: no progress for 8 min (e.g. a monster that only comes out at night)
    const fresh = doable.filter((b) => !B.later[b.id] || Date.now() - B.later[b.id] > 30 * 60 * 1000);
    const open = fresh.length ? fresh : [];
    if (!fresh.length && doable.length) { await bountyFilterOff(id, g); B.phase = 'wait'; B.note = `รอมอนเกิด ${doable.length} ใบ (เช่นมอนกลางคืน) · ลองใหม่ทุก 30 นาที · AUTO ต่อ`; if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); return; }
    if (!open.length) {
      const hard = list.filter((b) => b.map && !b.claimed && b.prog < b.need && b.hi > lv + 2).length;
      B.on = false; B.phase = 'done';
      B.note = hard ? `ทำครบที่ทำได้แล้ว · เหลือ ${hard} ใบที่มอนเลเวลสูงเกิน` : 'ทำค่าหัวครบทุกใบแล้ว';
      log.info(`acc ${id}: bounties finished (${B.claimedN || 0} claimed${hard ? `, ${hard} too hard` : ''})`);
      await bountyRestore(g, id);
      notify(id, 'bounty', `📜 ${B.note} · อยู่ที่ ${mapName(here)} AUTO ต่อ`);
      if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
      return;
    }
    // stay on the current one while it is not finished; else the one on this map; else the easiest
    let cur = B.cur && open.find((b) => b.id === B.cur.id);
    if (!cur) cur = open.find((b) => b.map === here) || open.slice().sort((a, b) => a.hi - b.hi)[0];
    if (!B.cur || B.cur.id !== cur.id) { B.cur = cur; B.phase = 'pick'; B.travelAt = 0; B.progAt = Date.now(); log.info(`acc ${id}: bounty -> ${cur.name} x${cur.need} at ${cur.map} (${cur.prog}/${cur.need})`); }
    if (B.cur.prog !== cur.prog || !B.progAt) B.progAt = Date.now();
    B.cur.prog = cur.prog;
    if (B.phase === 'hunt' && here === cur.map && Date.now() - B.progAt > 8 * 60 * 1000) {
      B.later[cur.id] = Date.now(); B.cur = null; B.progAt = 0; B.phase = 'pick';
      await bountyFilterOff(id, g); // its monster is not around: AUTO may hit everything again meanwhile
      B.note = `${cur.name} ไม่ขึ้นเลย 8 นาที (อาจเกิดเฉพาะกลางคืน) · ไปใบอื่นก่อน`;
      log.info(`acc ${id}: bounty ${cur.id} no progress for 8 min -> later`);
      return;
    }
    if (here !== cur.map) {
      if (B.phase === 'travel' && Date.now() - B.travelAt < 6 * 60 * 1000) { B.note = `กำลังเดินทางไป ${mapName(cur.map)}`; await answerWarpBox(id, g); return; }
      if (B.phase === 'travel') { B.skip.push(cur.id); B.cur = null; B.note = `ไป ${mapName(cur.map)} ไม่ถึงใน 6 นาที · ข้ามใบนี้`; log.info(`acc ${id}: bounty travel timed out -> skip ${cur.id}`); return; }
      await bountyFilterOff(id, g); // the targets switched off on this map come back before leaving it
      if ((await liveUi(id)).auto) await gameCommand(id, 'auto', {}); // AUTO off: the game's travel walks
      let r; try { r = await g.win.webContents.executeJavaScript(BOUNTY_GO_JS(cur.map), true); } catch (e) { r = { ok: false, why: e.message }; }
      if (!r || !r.ok) { B.skip.push(cur.id); B.cur = null; B.note = `เดินทางไม่ได้ (${(r && r.why) || '?'}) · ข้ามใบนี้`; return; }
      B.phase = 'travel'; B.travelAt = Date.now(); B.note = `กำลังเดินทางไป ${mapName(cur.map)}`;
      log.info(`acc ${id}: bounty travel ${here} -> ${cur.map}`);
      await answerWarpBox(id, g);
      // the moment it is on the map: the next step at once (the 20-s tick left it standing there)
      const to = cur.map; const t0 = Date.now();
      let looking = false;
      const watch = setInterval(async () => {
        if (!g.bounty || !g.bounty.on || g.bounty.phase !== 'travel' || Date.now() - t0 > 6 * 60000 || !g.win || g.win.isDestroyed()) { clearInterval(watch); return; }
        if (looking) return; looking = true;
        let m = mapOf(g); try { m = await g.win.webContents.executeJavaScript('window.__game && window.__game.mapId()', true); } catch { /* page busy: use the last snapshot */ }
        looking = false;
        if (m === to) { clearInterval(watch);
          // AUTO on the moment it lands; the bounty step then keeps it to the bounty monster
          await new Promise((r) => setTimeout(r, 800)); { const prev = await setFarmRange(g, 0); if (prev != null && prev !== 0 && g.bounty && g.bounty.prevFarm == null) g.bounty.prevFarm = prev; } if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); g.bountyArrivedAt = Date.now(); log.info(`acc ${id}: bounty arrived at ${to} (${Math.round((Date.now() - t0) / 1000)} s)`); const kick = (n) => { if (g.bounty && g.bounty.busy && n < 40) { setTimeout(() => kick(n + 1), 500); return; } bountyStep(id).catch(() => {}); }; setTimeout(() => kick(0), 300); } // the step may be busy (another tick): try again shortly
      }, 1000);
      return;
    }
    // on the map: stand next to the bounty monster and fight there
    const type = MOB_BY_NAME[cur.name] || '';
    if (B.phase !== 'hunt' || !(await liveUi(id)).auto) {
      // AUTO on at once over the whole map (it walks to the monsters itself), then keep it to the bounty monster.
      // (it used to walk to the monster with AUTO off first: up to 20 s more of standing around)
      { const prev = await setFarmRange(g, 0); if (prev != null && prev !== 0 && B.prevFarm == null) B.prevFarm = prev; } // whole map while on a bounty
      if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
      if (store.data.settings.bountyOnlyTarget !== false) await bountyFilterOn(id, g, cur.map, cur.name); // AUTO hits only the bounty monster
      let spot = null; try { spot = await g.win.webContents.executeJavaScript(MOB_SPOT_JS(type), true); } catch { spot = null; }
      if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); // the settings window can pause it: make sure
      B.phase = 'hunt';
      log.info(`acc ${id}: bounty hunting ${cur.name} at ${cur.map}${spot && spot.n ? '' : ' (none in sight: AUTO here)'}${g.bountyArrivedAt ? ` · AUTO ${((Date.now() - g.bountyArrivedAt) / 1000).toFixed(1)} s after arriving` : ''}`); g.bountyArrivedAt = 0;
    }
    B.note = `ล่า ${cur.name} ${cur.prog}/${cur.need} ที่ ${mapName(cur.map)}`;
  } catch (err) { log.warn(`acc ${id}: bounty step: ${err.message}`); } finally { if (g.bounty) g.bounty.busy = false; pushState(); }
}
function bountyTick() {
  for (const [id, g] of games) {
    if (!g.inGame || g.demo) continue;
    if (g.bounty && g.bounty.on) { sendInput(id, { type: 'huntQuery' }); setTimeout(() => bountyStep(id), 1500); continue; }
    if (!g.mobFilter && (store.data.mobFilter || {})[id]) g.mobFilter = store.data.mobFilter[id];
    if (g.mobFilter && mapOf(g) === g.mobFilter.map) bountyFilterOff(id, g).catch(() => {});
    // claim finished bounties by themselves (free, setting on by default): ask for fresh numbers every 5 min
    if (store.data.settings.bountyAutoClaim !== false && (!g.huntAskAt || Date.now() - g.huntAskAt > 5 * 60 * 1000)) { g.huntAskAt = Date.now(); sendInput(id, { type: 'huntQuery' }); }
    if (store.data.settings.bountyAutoClaim !== false && g.hunt && g.hunt.at > (g.huntClaimAt || 0)) {
      g.huntClaimAt = Date.now();
      // straight from the server's numbers (no game window opened: it would close what the player has open)
      const NEED = { logging: 60, mining: 60, herbalism: 60, fishing: 30, spirit: 40 };
      const list = Object.entries(g.hunt.prog || {}).map(([bid, prog]) => { const line = /#g:(\w+)$/.exec(bid); return { id: bid, prog, need: line ? NEED[line[1]] || 999 : 40, claimed: g.hunt.claimed.includes(bid) }; });
      bountyClaimDone(id, list).catch(() => {});
    }
  }
}

// ---------- world boss mode: every online account into the arena (the game's own "join (free)") ----------
// joins with the game's worldBossWarp, turns AUTO on in the arena, and when the event ends takes the
// accounts that BinderDash sent back to where they were (the game's "leave") with AUTO on again
const mapOf = (g) => (g.data && g.data.stats && g.data.stats.map) || '';
async function worldBossGo(kind, reason = 'ปุ่ม') {
  const out = [];
  for (const [id, g] of openGames()) {
    if (!g.inGame || g.demo || g.status !== 'online') continue;
    const name = g.data.stats.name || account(id).name;
    const before = mapOf(g);
    const me = (g.data.world && g.data.world.self) || {};
    g.bossTrip = { kind, from: before, x: me.x, y: me.y, at: Date.now() };
    log.info(`acc ${id}: world boss -> ${WORLD_ARENAS.has(before) ? 'already in the arena (went in by hand)' : `asked the game to warp in, from ${before}${me.x != null ? ` at ${Math.round(me.x)},${Math.round(me.y)}` : ''}`}`);
    await sendInput(id, { type: 'worldBossWarp', enter: true, kind }); // eslint-disable-line no-await-in-loop
    out.push({ id, name, from: before });
    await new Promise((r) => setTimeout(r, 400)); // eslint-disable-line no-await-in-loop
  }
  log.info(`world boss ${kind}: sent ${out.length} account(s) in (${reason})`);
  // once there: walk up to the boss first (AUTO only fights inside 16 tiles of where it was switched on,
  // and the arena's warp-in point is farther than that), then AUTO on; say who did not get in
  // a log showed 2 of 3 accounts still loading the arena at 7 s: they were taken as "did not get in",
  // so nobody walked them to the boss or took them back after (one stood idle 16 minutes in the arena)
  // each account on its own: as soon as it is in the arena, walk it to the boss (3 minutes at most, asking again
  // every 30 s: a warp asked before the start may only go through when the boss starts)
  const missed = [];
  Promise.all(out.map(async (o) => {
    const g = games.get(o.id); if (!g) return;
    for (let i = 0; i < 90; i++) {
      if (!g.bossTrip) return; // stopped meanwhile
      if (WORLD_ARENAS.has(mapOf(g))) { await walkToBossThenAuto(o.id, kind); return; }
      if (i && i % 15 === 0) await sendInput(o.id, { type: 'worldBossWarp', enter: true, kind });
      await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
    }
    missed.push(o.name); g.bossTrip = null; log.info(`acc ${o.id}: world boss -> not in the arena after 3 min`);
  })).then(() => { if (missed.length) notify(null, 'worldBoss', `🌋 เข้า World Boss ไม่ได้: ${missed.join(', ')} (เลเวลไม่ถึง / วาร์ปไม่สำเร็จใน 3 นาที)`); }).catch((e) => log.warn(`world boss go: ${e.message}`));
  return { ok: true, sent: out.length, accounts: out };
}
// where to stand: next to the world boss; if it is not in sight, the middle of the monsters around
const BOSS_SPOT_JS = (type) => `(() => { try { const g = window.__game; const st = g.state(); const me = g.me(); if (!st || !me) return null;
  const all = []; st.mobs.forEach((m) => all.push(m));
  const kind = (m) => m.mobType || m.type || '';
  const biggest = all.slice().sort((a, b) => (b.maxHp || 0) - (a.maxHp || 0))[0];
  const boss = all.find((m) => kind(m) === ${JSON.stringify(type)}) || all.find((m) => /colossus|titan/i.test(kind(m))) || (biggest && biggest.maxHp > 1e6 ? biggest : null);
  let x, y, how;
  if (boss) { x = boss.x; y = boss.y; how = 'boss'; } else if (all.length) { x = all.reduce((t, m) => t + m.x, 0) / all.length; y = all.reduce((t, m) => t + m.y, 0) / all.length; how = 'mobs'; } else return { me: [me.x, me.y], none: true };
  return { x: Math.round(x), y: Math.round(y), how, d: Math.hypot(x - me.x, y - me.y), me: [Math.round(me.x), Math.round(me.y)] }; } catch (e) { return null; } })()`;
async function walkToBossThenAuto(id, kind, again = false) {
  const g = games.get(id); if (!g || !g.win || g.win.isDestroyed()) return;
  const type = WORLD_TYPES[kind] || '';
  let spot = null;
  if (again) { // got up again: only walk when it woke up out of AUTO's reach (16 tiles) of the boss
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; }
    if (!spot || spot.how !== 'boss' || spot.d <= 12) { if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {}); return; }
    log.info(`acc ${id}: world boss -> up again ${Math.round(spot.d)} tiles from the boss, walking back`);
  }
  if ((await liveUi(id)).auto) await gameCommand(id, 'auto', {}); // AUTO off while walking (it would stop to fight on the way)
  // in early (before it spawns): wait for the boss to show up, up to ~3 minutes
  for (let i = 0; i < (again ? 3 : 60); i++) {
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; } // eslint-disable-line no-await-in-loop
    if (spot && spot.how === 'boss') break;
    if (i === 0) log.info(`acc ${id}: world boss not in sight yet -> waiting for it`);
    await new Promise((r) => setTimeout(r, 3000)); // eslint-disable-line no-await-in-loop
  }
  for (let i = 0; i < 15; i++) { // up to ~30 s
    try { spot = await g.win.webContents.executeJavaScript(BOSS_SPOT_JS(type), true); } catch { spot = null; } // eslint-disable-line no-await-in-loop
    if (!spot || spot.none) { await new Promise((r) => setTimeout(r, 2000)); continue; } // eslint-disable-line no-await-in-loop
    if (spot.d <= 5) break;
    await sendInput(id, { type: 'moveTo', x: spot.x + (spot.how === 'boss' ? 2 : 0), y: spot.y }); // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 2000)); // eslint-disable-line no-await-in-loop
  }
  log.info(`acc ${id}: world boss -> walked to the ${spot && spot.how ? spot.how : 'arena'}${spot && spot.d != null ? ` (${Math.round(spot.d)} tiles left)` : ''}, AUTO on`);
  if (!(await liveUi(id)).auto) await gameCommand(id, 'auto', {});
}
async function worldBossLeave(kind) {
  for (const [id, g] of openGames()) {
    const inArena = g.inGame && !g.demo && WORLD_ARENAS.has(mapOf(g));
    if (!(g.bossTrip && g.bossTrip.kind === kind) && !inArena) continue;
    await sendInput(id, { type: 'worldBossWarp', enter: false, kind }); // eslint-disable-line no-await-in-loop
    log.info(`acc ${id}: world boss over -> left the arena (back toward ${g.bossTrip ? g.bossTrip.from : 'town'})`);
    if (g.bossTrip && g.bossTrip.from && !WORLD_ARENAS.has(g.bossTrip.from)) g.loopBack = { map: g.bossTrip.from, x: g.bossTrip.x, y: g.bossTrip.y, at: Date.now(), done: false, why: 'boss' };
    g.bossTrip = null;
    setTimeout(async () => { if (!(await liveUi(id)).auto) gameCommand(id, 'auto', {}); }, 8000);
    await new Promise((r) => setTimeout(r, 400)); // eslint-disable-line no-await-in-loop
  }
}

function onWorldBoss(v) {
  // the event's real length (start -> end) for the Build Lab
  if (v.state === 'live' && v.startAt && v.endsAt && v.endsAt > v.startAt && WORLD_TYPES[v.kind]) {
    const wl = store.data.worldLen || (store.data.worldLen = {});
    const sec = Math.round((v.endsAt - v.startAt) / 1000);
    if (wl[WORLD_TYPES[v.kind]] !== sec) { wl[WORLD_TYPES[v.kind]] = sec; store.save(); }
  }
  const before = bosses.world.get(v.kind);
  bosses.world.set(v.kind, { ...v, seenAt: Date.now(), goneFor: before && before.goneFor });
  if (before && before.state !== 'live' && v.state === 'live') {
    notify(null, 'worldBoss', `🌋 World Boss ${v.name} เริ่มแล้ว · เข้าร่วม ${v.fighters} คน${store.data.settings.worldBossAuto ? ' · ส่งทุกบัญชีไปตีแล้ว' : ''}`);
    if (store.data.settings.worldBossAuto && !(before.goneFor && Math.abs((v.startAt || 0) - before.goneFor) < 5 * 60 * 1000)) worldBossGo(v.kind, 'เริ่มเอง');
  }
  if (before && before.state === 'live' && v.state !== 'live' && store.data.settings.worldBossReturn !== false) worldBossLeave(v.kind);
  pushState();
}

function bossUp(b) {
  // one heads-up per boss and map per 20 minutes: the game re-estimates the spawn time every minute,
  // so a key with the time in it said the same boss again every minute (seen 6 times in a row in a log)
  const key = `${b.mobType}@${b.map}`;
  bosses.lastUp = bosses.lastUp || new Map();
  if (bosses.lastUp.has(key) && Date.now() - bosses.lastUp.get(key) < 20 * 60 * 1000) return;
  bosses.lastUp.set(key, Date.now());
  notify(null, 'fieldBoss', `♛ บอสสนาม ${b.name} เกิดแล้ว · ${mapName(b.map)}`);
}

// map id -> name, from the same map table the Dashboard uses (one JSON object per line)
const MAP_NAMES = (() => {
  try {
    return Object.fromEntries(fs.readFileSync(path.join(__dirname, 'dashboard', 'maps.js'), 'utf8').split('\n')
      .filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l.trim().replace(/,$/, ''))).map((m) => [m.id, m.name]));
  } catch { return {}; }
})();
function mapName(id) { return MAP_NAMES[id] || String(id || '?').split('_').map((w) => w && w[0].toUpperCase() + w.slice(1)).join(' '); }

// timers: "about to spawn" heads-up, and spawns we can tell from the clock alone
function bossTick() {
  const s = store.data.settings;
  const now = Date.now();
  const lead = s.bossLeadMinutes * 60000;
  for (const b of bosses.field.values()) {
    if (b.closed || !b.until) continue;
    const left = b.until - now;
    const soon = `${b.mobType}@${b.map}`; // not the time: the game re-estimates it every minute
    bosses.lastSoon = bosses.lastSoon || new Map();
    if (left > 0 && left <= lead && !(bosses.lastSoon.has(soon) && now - bosses.lastSoon.get(soon) < 20 * 60 * 1000)) {
      bosses.lastSoon.set(soon, now);
      notify(null, 'fieldBoss', `♛ บอสสนาม ${b.name} จะเกิดในอีก ~${Math.max(1, Math.round(left / 60000))} นาที · ${mapName(b.map)}`);
    }
    if (left <= 0 && left > -60000) bossUp(b);
  }
  for (const w of bosses.world.values()) {
    const start = w.state === 'live' ? 0 : w.nextAt || w.startAt;
    const left = start - now;
    const soon = `wsoon:${w.kind}:${start}`;
    if (start && left > 0 && left <= lead && !bosses.sent.has(soon)) {
      bosses.sent.add(soon);
      notify(null, 'worldBoss', `🌋 World Boss ${w.name} จะเริ่มในอีก ~${Math.max(1, Math.round(left / 60000))} นาที`);
    }
    // go in 1 minute early: the trip in (back to town first, then the warp) can take a while
    const early = `wgo:${w.kind}:${start}`;
    if (s.worldBossAuto && start && left > 0 && left <= 75000 && !bosses.sent.has(early)) {
      bosses.sent.add(early); w.goneFor = start;
      worldBossGo(w.kind, 'ก่อนเกิด 1 นาที');
    }
  }
  if (bosses.sent.size > 500) bosses.sent.clear();
  // ask the game for the field-boss board (what its atlas map asks), from one account, once a minute
  if (now - bosses.queriedAt > 60000 && (s.notify.fieldBoss || visible(dashboard))) {
    const first = openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
    if (first) { bosses.queriedAt = now; sendInput(first[0], { type: 'fieldBossQuery' }); }
  }
}

function bossView() {
  const now = Date.now();
  return {
    field: [...bosses.field.values()]
      .filter((b) => !b.closed)
      .map((b) => ({ name: b.name, map: b.map, up: !b.until || b.until <= now, inMs: b.until ? Math.max(0, b.until - now) : 0, killer: b.killer }))
      .sort((a, b) => (a.up === b.up ? a.inMs - b.inMs : a.up ? -1 : 1)),
    world: [...bosses.world.values()].map((w) => ({
      name: w.name, kind: w.kind, state: w.state, fighters: w.fighters, hpFrac: w.hpFrac,
      inMs: w.state === 'live' ? 0 : Math.max(0, (w.nextAt || w.startAt) - now), endsInMs: w.endsAt ? Math.max(0, w.endsAt - now) : 0,
    })),
  };
}

// ---------- problem report ----------
function makeReport() {
  const s = store.data.settings;
  const os = require('os');
  const lines = [
    `BinderDash ${app.getVersion()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows/OS: ${os.type()} ${os.release()} ${os.arch()} · RAM ${Math.round(os.totalmem() / 1073741824)} GB · CPU ${os.cpus().length} cores`,
    `เวลา: ${new Date().toString()}`,
    `ทดสอบกับเกม build: ${KNOWN_BUILDS.join(', ')}`,
    `ชนิดข้อความใหม่จากเกม: ${[...new Set([...games.values()].flatMap((g) => [...g.adapter.newTypes.keys()]))].join(', ') || '-'}`,
    '',
    '== บัญชี ==',
    ...store.data.accounts.map((a) => {
      const g = rt(a.id);
      const h = g.inGame ? g.adapter.health() : null;
      return `#${a.id} status=${g.status} alerts=[${[...g.alerts].map((k) => k.replace(/:.*/, ':…')).join(',')}] mem=${g.memoryMB || '-'}MB`
        + (h ? ` build=${h.build || '?'} ok=${h.ok} frames=${h.frames}${h.problems.length ? ` problems=${h.problems.join(' | ')}` : ''}` : '');
    }),
    '',
    '== ตั้งค่า (ไม่มี KEY) ==',
    JSON.stringify({ ...s, telegram: { connected: !!(s.telegram.token && s.telegram.chatId) }, itemWatch: Object.keys(s.itemWatch || {}).length }),
    '',
    '== log ล่าสุด ==',
    log.tail(400),
  ];
  const file = path.join(log.dir(), `report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(file, lines.join('\n'));
  log.info('problem report written');
  shell.showItemInFolder(file);
  return file;
}

// ---------- demo mode ----------
function demoTick() {
  const on = store.data.settings.demo;
  store.data.accounts.forEach((a, i) => {
    const g = rt(a.id);
    const open = g.win && !g.win.isDestroyed();
    if (on && !open) {
      if (!g.demo) { g.demo = new DemoFeed(i); g.data.reset(); }
      handleEvents(a.id, g.demo.tick());
    } else if (g.demo) {
      g.demo = null;
      g.data.reset();
    }
  });
  pushState();
}

// Memory used by each game window (shown on the account list)
function updateMemory() {
  const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  for (const [, g] of openGames()) {
    const m = byPid.get(g.win.webContents.getOSProcessId());
    g.memoryMB = m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : null;
  }
}

// ---------- periodic checks ----------
function tick() {
  updateMemory();
  const s = store.data.settings;
  const now = Date.now();
  for (const [id, g] of [...openGames(), ...[...games].filter(([, x]) => x.demo)]) {
    // supplies about to run out at the current rate (potions, arrows ...)
    const low = new Set();
    // potions: what is on the game's hotbar (belt), counted over every quality grade
    readBelt(id, g);
    const potionIds = new Set(POTIONS.map((p) => p.id));
    const belt = (g.belt || []).filter((b) => potionIds.has(b));
    const watch = belt.length ? belt : [...new Set([...(g.adapter.inv ? g.adapter.inv.keys() : [])].map(baseOf).filter((b) => potionIds.has(b)))];
    // a fixed count, not a forecast: steady whatever the pace (every quality grade counted, like the hotbar)
    const below = Math.max(1, Number((s.autoBuy || {}).below) || 50);
    for (const pid of watch) {
      let qty = 0; if (g.adapter.inv) for (const [k, q] of g.adapter.inv) if (baseOf(k) === pid) qty += q || 0;
      const p = POTIONS.find((x) => x.id === pid);
      const key = 'potion:' + pid;
      if (qty <= below) {
        low.add(key);
        if (!g.alerts.has(key)) setAlert(id, key, true, `${p.name}${belt.includes(pid) ? ' (ช่องลัด)' : ''} เหลือ ${qty} ขวด (ตั้งไว้ซื้อเมื่อเหลือ ${below})`);
        if (belt.includes(pid)) autoBuyPotion(id, g, p); // buy only what the hotbar really uses
      }
    }
    for (const row of g.data.detail(now).bag) {
      if ((row.ids || []).some((x) => potionIds.has(baseOf(x.id)))) continue; // potions: done above
      const key = 'potion:' + row.name;
      if (row.minutesLeft != null && row.minutesLeft < s.potionMinutes) {
        low.add(key);
        if (!g.alerts.has(key)) setAlert(id, key, true, `${row.name} จะหมดในอีก ~${Math.max(1, Math.round(row.minutesLeft))} นาที (เหลือ ${row.qty})`);
        autoBuyPotion(id, g, row);
      } else if (g.alerts.has(key)) setAlert(id, key, false);
    }
    // an alert for a supply that is no longer in the bag (or renamed) must not stay forever
    for (const key of [...g.alerts]) if (key.startsWith('potion:') && !low.has(key)) setAlert(id, key, false);
    // Premium running out
    const until = g.data.premiumUntil;
    const left = until ? until - now : 0;
    if (left > 0 && left < 30 * 60 * 1000) { if (!g.alerts.has('premium')) setAlert(id, 'premium', true, `Premium จะหมดในอีก ${Math.ceil(left / 60000)} นาที`); }
    else if (g.alerts.has('premium')) setAlert(id, 'premium', false);
  }
  for (const [id, g] of openGames()) {
    if (g.status === 'maintenance') {
      // retry every 2 minutes so the account comes back by itself after maintenance
      if (now - g.loadedAt > 2 * 60 * 1000) g.win.webContents.reload();
      continue;
    }
    if (g.status === 'crashed') continue;
    const graceOver = g.loadedAt && now - g.loadedAt > 30 * 1000;
    if (graceOver && g.closedSince && now - g.closedSince > s.disconnectSeconds * 1000) {
      g.status = 'disconnected';
      setAlert(id, 'disconnect', true, `หลุดจากเซิร์ฟเวอร์เกิน ${s.disconnectSeconds} วินาที`);
    }
    // Auto Play probably stopped: no hits for N minutes (only while connected and alive).
    // Until hits can be read from the game, fall back to "no data at all".
    const lastActivity = g.lastHitAt || g.lastMsgAt;
    if (g.status === 'online' && !g.alerts.has('death') && lastActivity && now - lastActivity > s.idleMinutes * 60 * 1000) {
      setAlert(id, 'idle', true, g.lastHitAt ? `ไม่ได้ตีเลย ${s.idleMinutes} นาที · Auto Play น่าจะหยุด` : `ไม่มีข้อมูลจากเกม ${s.idleMinutes} นาที · AUTO อาจหยุด`);
    }
    // Give back RAM: a game page grows ~600-700 MB an hour and stutters, then stops, near 5 GB (a 10-hour log).
    // Reload it past the limit (at most every 30 min, one account at a time), not while it travels, is at a boss
    // or lies dead; small warnings (potions, bag weight) do not hold it back. AUTO is switched back on after.
    const minorOnly = [...g.alerts].every((k) => /^(potion|item|weight|weightFull|idle)/.test(k));
    const dr = driverOf(g);
    const busy = (dr && dr !== 'bounty' && dr !== 'finder') || (g.bounty && g.bounty.on && g.bounty.phase === 'travel') || (g.finder && g.finder.on && g.finder.phase !== 'measure') || g.data.stats.dead;
    const otherReloading = [...games.values()].some((o) => o !== g && o.ramReloadAt && now - o.ramReloadAt < 90 * 1000);
    if (s.autoRam && g.memoryMB > s.ramLimitMB && g.status === 'online' && minorOnly && !busy && !otherReloading
        && (!g.ramReloadAt || now - g.ramReloadAt > 30 * 60 * 1000)) {
      g.ramReloadAt = now;
      const mb = g.memoryMB;
      log.info(`acc ${id}: game page uses ${mb} MB (limit ${s.ramLimitMB}) -> reload to give the memory back`);
      g.data.log('other', `หน้าเกมใช้ RAM ${mb} MB เกิน ${s.ramLimitMB} MB · โหลดใหม่เพื่อคืน RAM`);
      liveUi(id).then((ui) => {
        g.autoBeforeReload = !!ui.auto;
        g.win.webContents.reload();
        // back in the game: AUTO on again if it was on (the character is where it was: the server kept it there)
        setTimeout(async () => { try { if (g.autoBeforeReload && g.inGame && !(await liveUi(id)).auto) { await gameCommand(id, 'auto', {}); log.info(`acc ${id}: after the RAM reload: AUTO on again`); } } catch { /* page still loading */ } }, 60000);
      }).catch(() => g.win.webContents.reload());
    }
  }
  pushState();
}

// ---------- dashboard ----------
function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.focus(); return; }
  dashboard = new BrowserWindow({
    icon: APP_ICON,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BinderDash',
    autoHideMenuBar: true,
    backgroundColor: '#14121f',
    webPreferences: {
      preload: path.join(__dirname, 'preload-dashboard.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  dashboard.loadFile(path.join(__dirname, 'dashboard', 'index.html'));
  dashboard.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') {
      toggleDashboard(); e.preventDefault();
    }
  });
  dashboard.on('closed', () => { dashboard = null; });
}
function toggleDashboard() {
  if (dashboard && !dashboard.isDestroyed() && dashboard.isVisible() && dashboard.isFocused()) dashboard.close();
  else createDashboard();
}

// ---------- settings window ----------
function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show(); settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    icon: APP_ICON,
    width: 860,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    title: 'ตั้งค่า — BinderDash',
    autoHideMenuBar: true,
    backgroundColor: '#0d0c16',
    webPreferences: { preload: path.join(__dirname, 'preload-dashboard.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'dashboard', 'settings.html'), { hash: tab || '' });
  settingsWin.on('page-title-updated', (e) => e.preventDefault());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- tray ----------
function updateTray() {
  if (!tray) return;
  const anyAlert = [...games.values()].some((g) => g.alerts.size > 0);
  tray.setImage(trayImg(anyAlert ? icons.alert : icons.normal));
  const open = openGames().length;
  tray.setToolTip(`BinderDash · เปิดอยู่ ${open} บัญชี${anyAlert ? ' · มีเรื่องต้องดู' : ''}`);
}
function toggleAllGames() {
  const open = openGames();
  const anyVisible = open.some(([, g]) => g.win.isVisible());
  for (const [id] of open) anyVisible ? hideGame(id) : showGame(id);
}
// macOS menu bar wants a small icon (about 18 pt); Windows takes the 32 px one as it is
const trayImg = (url) => { const img = nativeImage.createFromDataURL(url); return process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img; };
function createTray() {
  tray = new Tray(trayImg(icons.normal));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Dashboard', click: createDashboard },
    { label: 'ตั้งค่า', click: () => openSettings() },
    { label: 'ซ่อน/แสดงเกมทั้งหมด', click: toggleAllGames },
    { type: 'separator' },
    { label: 'ออกจากโปรแกรม', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', toggleAllGames);
  updateTray();
}

// ---------- dashboard API ----------
// ---------- Build Lab: the game's own damage calculator, in a hidden window on the game's site ----------
const { LAB_JS } = require('./build-lab');
let labWin = null;
let labReady = null;
function labCall(expr) {
  if (!labWin || labWin.isDestroyed()) {
    labWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:lab', contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    labWin.on('closed', () => { labWin = null; labReady = null; });
    // any small page on the game's site will do: the lab imports the game's own module from there
    labReady = labWin.loadURL(new URL(gameUrl).origin + '/robots.txt').catch(() => {}).then(() => labWin.webContents.executeJavaScript(LAB_JS));
  }
  return labReady.then(() => labWin.webContents.executeJavaScript(expr, true))
    .catch((e) => { log.warn('build lab: ' + (e && e.message)); throw new Error('Build Lab: ' + String((e && e.message) || e).replace(/^.*Error: /, '')); });
}
const ME_JS = `(() => { const m = window.__game && window.__game.me(); if (!m) return null;
  const o = (v) => (v instanceof Map ? Object.fromEntries(v) : v && typeof v.toJSON === 'function' ? v.toJSON() : v);
  let traits = o(m.traits); try { if (typeof traits === 'string') traits = JSON.parse(traits); } catch { traits = {}; }
  let c2r = o(m.c2r); try { if (typeof c2r === 'string') c2r = JSON.parse(c2r); } catch { c2r = null; }
  let c2tr = o(m.c2tr); try { if (typeof c2tr === 'string') c2tr = JSON.parse(c2tr); } catch { c2tr = {}; }
  return { job: m.job, level: m.level, jobLevel: m.jobLevel, skillPoints: m.skillPoints, c2: m.c2 || '', c2r,
    stats: { str: m.str, agi: m.agi, vit: m.vit, int: m.int, dex: m.dex, luk: m.luk }, statPoints: m.statPoints,
    skills: o(m.skillLevels) || {}, evo: o(m.skillMods) || {}, traits: traits || {}, c2tr: c2tr || {},
    wRefine: m.wRefine || 0, sRefine: m.sRefine || 0, guildLevel: m.guildLevel || 0 }; })()`;

function handle(cmd, fn) { ipcMain.handle('dash:' + cmd, (_e, ...args) => fn(...args)); }

function registerIpc() {
  handle('state', () => publicState());
  handle('detail', (id) => {
    if (!account(id)) return null;
    watchedId = id;
    const g = rt(id);
    return { ...g.data.detail(), pending: g.pending.map((p) => ({ ...p, left: Math.max(0, p.at + LISTING_DELAY_MS - Date.now()) })) };
  });
  handle('open', (id) => {
    const nonPremiumWarning = openGames().length === 3;
    openGame(id);
    return { warnFreeLimit: nonPremiumWarning };
  });
  handle('show', (id) => showGame(id));
  handle('reload', (id) => { const g = rt(id); if (g.win && !g.win.isDestroyed()) g.win.webContents.reload(); });
  handle('toggle-all', () => toggleAllGames());
  // the Dashboard's sleep view: hide the game windows that are showing (they keep playing; a hidden window
  // draws nothing, so the PC runs cooler and the other games smoother), show them again on the way out
  handle('sleep-mode', (on) => {
    sleepMode = !!on;
    if (sleepMode) {
      sleepShown = [];
      for (const [id, g] of openGames()) if (g.win && !g.win.isDestroyed() && g.win.isVisible()) { sleepShown.push(id); g.win.hide(); }
      log.info(`sleep view on: ${sleepShown.length} game window(s) hidden`);
    } else {
      for (const id of sleepShown) { const g = games.get(id); if (g && g.win && !g.win.isDestroyed()) g.win.showInactive(); }
      log.info(`sleep view off: ${sleepShown.length} game window(s) shown again`);
      sleepShown = [];
    }
    pushState();
    return { ok: true };
  });
  handle('hide', (id) => hideGame(id));
  handle('close', (id) => closeGame(id));
  handle('add', () => {
    if (store.data.accounts.length >= MAX_ACCOUNTS) return false;
    const id = store.data.nextId++;
    store.data.accounts.push({ id, name: `บัญชี ${id}` });
    store.save();
    pushState();
    return id;
  });
  handle('rename', (id, name) => {
    const a = account(id);
    if (!a || typeof name !== 'string') return;
    a.name = name.trim().slice(0, 40) || a.name;
    store.save();
    const g = rt(id);
    if (g.win && !g.win.isDestroyed()) g.win.setTitle(windowTitle(id));
    pushState();
  });
  handle('remove', async (id) => {
    closeGame(id);
    store.data.accounts = store.data.accounts.filter((a) => a.id !== id);
    store.save();
    games.delete(id);
    // forget this account's login
    await session.fromPartition(`persist:acc-${id}`).clearStorageData().catch(() => {});
    pushState();
  });
  handle('settings', (patch) => {
    const s = store.data.settings;
    if (patch.reconnectMinutes !== undefined) s.reconnectMinutes = Math.min(60, Math.max(1, Number(patch.reconnectMinutes) || 3));
    if (patch.startWithWindows !== undefined) { s.startWithWindows = !!patch.startWithWindows; applyStartWithWindows(); }
    for (const k of ['openDashboardOnStart', 'openAllOnStart', 'autoRam', 'openHidden', 'telegramRemote', 'autoReconnect', 'statsLog', 'deathLoopGuard', 'worldBossAuto', 'worldBossReturn', 'bountyAutoClaim', 'bountyOnlyTarget', 'crowdSwitch', 'stuckFix']) if (patch[k] !== undefined) s[k] = !!patch[k];
    if (patch.crowdPlayers !== undefined) s.crowdPlayers = Math.max(1, Math.min(30, Number(patch.crowdPlayers) || 3));
    if (patch.crowdMinutes !== undefined) s.crowdMinutes = Math.max(1, Math.min(30, Number(patch.crowdMinutes) || 2));
    if (patch.autoBuy !== undefined) s.autoBuy = { on: !!patch.autoBuy.on, below: Math.max(1, Math.min(9999, Number(patch.autoBuy.below ?? (s.autoBuy || {}).below) || 50)), rounds: Math.max(1, Math.min(10, Number(patch.autoBuy.rounds) || 3)), keepSilver: Math.max(0, Number(patch.autoBuy.keepSilver ?? (s.autoBuy || {}).keepSilver ?? 5000) || 0) };
    if (patch.autoRespawnHere !== undefined) s.autoRespawnHere = !!patch.autoRespawnHere;
    if (patch.salvageByPrice !== undefined) s.salvageByPrice = !!patch.salvageByPrice;
    if (patch.salvageMaxPrice !== undefined) s.salvageMaxPrice = Math.max(0, Number(patch.salvageMaxPrice) || 0);
    if (patch.salvageUnknownOk !== undefined) s.salvageUnknownOk = !!patch.salvageUnknownOk;
    if (patch.salvageKeepVol !== undefined) s.salvageKeepVol = Math.max(0, Number(patch.salvageKeepVol) || 0);
    if (patch.highValueGold !== undefined) s.highValueGold = Math.max(0, Number(patch.highValueGold) || 0);
    if (patch.valuableMinGold !== undefined) s.valuableMinGold = Math.max(0, Number(patch.valuableMinGold) || 0);
    if (patch.bossLeadMinutes !== undefined) s.bossLeadMinutes = Math.min(60, Math.max(1, Number(patch.bossLeadMinutes) || 5));
    if (patch.potionMinutes !== undefined) s.potionMinutes = Math.min(240, Math.max(1, Number(patch.potionMinutes) || 30));
    if (patch.weightFullPct !== undefined) s.weightFullPct = Math.min(100, Math.max(50, Number(patch.weightFullPct) || 90));
    if (patch.weightCriticalPct !== undefined) s.weightCriticalPct = Math.min(100, Math.max(50, Number(patch.weightCriticalPct) || 95));
    if (patch.ramLimitMB !== undefined) s.ramLimitMB = Math.min(8000, Math.max(500, Number(patch.ramLimitMB) || 1500));
    if (patch.gameUrl !== undefined) {
      const u = String(patch.gameUrl).trim();
      s.gameUrl = /^https:\/\/[^\s]+$/.test(u) && u !== DEFAULT_GAME_URL ? u : '';
    }
    if (patch.farmTrialMinutes !== undefined) s.farmTrialMinutes = Math.min(30, Math.max(5, Number(patch.farmTrialMinutes) || 10));
    if (patch.idleMinutes !== undefined) s.idleMinutes = Math.min(120, Math.max(1, Number(patch.idleMinutes) || 5));
    if (patch.disconnectSeconds !== undefined) s.disconnectSeconds = Math.min(600, Math.max(15, Number(patch.disconnectSeconds) || 60));
    if (patch.notify) for (const k of Object.keys(s.notify)) if (k in patch.notify) s.notify[k] = !!patch.notify[k];
    if (patch.debugCapture !== undefined) s.debugCapture = !!patch.debugCapture;
    if (patch.demo !== undefined) s.demo = !!patch.demo;
    store.save();
    syncRemote();
    pushState();
  });
  handle('telegram-connect', async (token) => {
    token = String(token || '').trim();
    if (!/^\d+:[\w-]{30,}$/.test(token)) return { ok: false, error: 'KEY ไม่ถูกรูปแบบ' };
    try {
      const chatId = await telegram.findChatId(token);
      if (!chatId) return { ok: false, error: 'ยังไม่เจอแชท · เปิดแชทกับบอทใน Telegram แล้วกด START ก่อน แล้วกดเชื่อมต่ออีกครั้ง' };
      store.data.settings.telegram = { token, chatId };
      store.save();
      syncRemote();
      await telegram.send(token, chatId, 'BinderDash เชื่อมต่อแล้ว 👋');
      pushState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  handle('telegram-disconnect', () => {
    store.data.settings.telegram = { token: '', chatId: '' };
    syncRemote();
    store.save();
    pushState();
  });
  handle('test-notify', () => {
    const first = store.data.accounts[0];
    const s = store.data.settings;
    if (Notification.isSupported()) new Notification({ title: 'BinderDash', body: 'ทดสอบการแจ้งเตือน', silent: !s.notify.sound }).show();
    telegram.send(s.telegram.token, s.telegram.chatId, 'BinderDash: ทดสอบการแจ้งเตือน').catch(() => {});
    return !!first;
  });
  handle('game-cmd', (id, cmd, arg) => gameCommand(id, cmd, arg || {}));
  handle('game-cmd-all', (cmd, arg) => commandAll(cmd, arg || {}));
  handle('world-boss-go', (kind) => worldBossGo(String(kind || ''), 'ปุ่ม'));
  handle('bounty', (id, on) => bountyStart(id, on !== false));
  handle('claim-rewards', (id) => claimRewards(id));
  handle('farm-find', (id, on) => finderStart(id, !!on));
  handle('farm-go', (id, map) => farmGo(id, String(map || '')));
  handle('farm-maps', (id) => { const g = games.get(id); return { rows: farmSummary(id, (g && g.data.stats.level) || 0), level: (g && g.data.stats.level) || 0, here: g ? mapOf(g) : '', finder: g ? finderStatus(g) : null }; });
  handle('ab-start', (id, phase, minutes, label) => abStart(id, phase, minutes, label));
  handle('ab-get', (id) => { const g = games.get(id); return g ? abResult(g) : null; });
  handle('ab-stop', (id) => { const g = games.get(id); if (g && g.ab) g.ab.phase = null; return { ok: true }; });
  handle('claim-rewards-all', async () => { const r = []; for (const [id, g] of openGames()) if (g.inGame && !g.demo) r.push({ id, ...(await claimRewards(id)) }); return r; }); // eslint-disable-line no-await-in-loop
  handle('bounty-all', async (on) => { const r = []; for (const [id, g] of openGames()) if (g.inGame && !g.demo) r.push({ id, ...(await bountyStart(id, on !== false)) }); return r; }); // eslint-disable-line no-await-in-loop
  // how many unlocked gear pieces each account would salvage (shown before confirming)
  handle('lab-info', () => labCall('window.__bdLab.info()'));
  // real DPS: sum this character's own hits for N seconds (count from the first hit)
  handle('measure-start', (id, seconds) => {
    const g = games.get(id);
    if (!g || !g.inGame) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
    const sec = Math.max(10, Math.min(300, Number(seconds) || 60));
    g.measure = { sec, armed: Date.now(), until: Date.now() + (sec + 120) * 1000, first: 0, last: 0, hits: [] };
    return { ok: true };
  });
  handle('measure-get', (id) => {
    const g = games.get(id);
    const m = g && g.measure;
    if (!m) return null;
    if (m.first && Date.now() > m.first + m.sec * 1000) m.until = Math.min(m.until, m.first + m.sec * 1000);
    const now = Math.min(Date.now(), m.until);
    const done = now >= m.until;
    const secs = m.first ? Math.max(1, (now - m.first) / 1000) : 0;
    const mine = m.hits.filter((h) => !h.pet);
    const per = {}; for (const h of mine) per[h.sid || 'basic'] = (per[h.sid || 'basic'] || 0) + h.dmg;
    const mobs = {}; for (const h of m.hits) if (h.mob) mobs[h.mob] = (mobs[h.mob] || 0) + 1;
    const total = mine.reduce((t, h) => t + h.dmg, 0);
    const pet = m.hits.filter((h) => h.pet).reduce((t, h) => t + h.dmg, 0);
    if (done && m.first) g.lastMeasure = { dps: secs ? Math.round(total / secs) : 0, secs, at: Date.now() };
    return { done, started: !!m.first, secs: Math.round(secs * 10) / 10, sec: m.sec, total, pet, dps: secs ? Math.round(total / secs) : 0, hits: mine.length, crits: mine.filter((h) => h.crit).length, perSkill: per, mobs };
  });
  // a character's own learned factors (when the lab is about one account): per-skill for its rankings
  const calibFor = (p) => {
    if (!p || p.acc == null) return null;
    const all = store.data.calib || {};
    const role = (MOB_ROLES[p.target || ''] || [])[0];
    const kind = /^(wraithroot_colossus|pearlheart_titan)$/.test(p.target || '') || role === 'boss' || role === 'mini-boss' || p.mode === 'boss' ? 'world' : 'field';
    const c = all[`${p.acc}:mob:${p.target}`] || all[`${p.acc}:${kind}`];
    return c && c.job === p.job && c.v === 3 ? { ...c, kind } : null; // older ones were learned without class-2 traits
  };
  // the character's own numbers: per-skill factors, and (farming) how many monsters it really hits at once
  const withAdj = (p) => {
    const c = calibFor(p); if (!c) return p;
    const out = { ...p };
    if (c.rel && c.runs >= 1) out.skillAdj = c.rel;
    if (c.kind === 'field' && c.pack && !p.packSet) out.pack = Math.max(1, Math.round(c.pack * 10) / 10);
    // farming with no monster chosen: the one this character really farms (its last real-damage log), not a stand-in
    const farming = p.mode !== 'boss' && p.goal !== 'boss';
    if (c.kind === 'field' && farming && !p.target && c.mob) out.target = c.mob;
    return out;
  };
  handle('lab-run', (p) => labCall(`window.__bdLab.run(${JSON.stringify(withAdj(p))})`));
  handle('lab-predict', async (p) => {
    const r = await labCall(`window.__bdLab.predict(${JSON.stringify(withAdj(p))})`);
    const kind = /^(wraithroot_colossus|pearlheart_titan)$/.test((p && p.target) || '') ? 'world' : 'field';
    const c = calibFor(p);
    if (r && c && c.job === p.job) { const m = c.d || c.k; r.calib = { k: c.k, d: c.d || null, kind, n: c.n, runs: c.runs || 1, withCombos: Math.round((r.packDps || r.withCombos || r.dps) * m), dps: Math.round(r.dps * m) }; }
    return r;
  });
  handle('fight-times', () => fightTimes());
  handle('mw-list', () => ({ watch: mwList(), live: Object.fromEntries(marketLive), hist: mwHist(), every: store.data.settings.marketWatchMin || 2, online: !!openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo) }));
  handle('mw-search', (q) => mwSearch(q));
  // which accounts hold each watched item (same kind + grade), not locked or bound: those can be listed for sale
  handle('mw-holders', () => {
    const out = {};
    for (const w of mwList()) {
      const want = w.key || (w.base + (GRADE_SUFFIX[w.grade] != null && w.itemId.includes('|') ? '|' + w.grade : ''));
      const list = [];
      for (const [id, g] of openGames()) {
        if (!g.inGame || g.demo || !g.adapter.inv) continue;
        for (const [itemId, qty] of g.adapter.inv) {
          if (!qty || g.adapter.locks.has(itemId) || g.adapter.bound.has(itemId)) continue;
          const key = itemId.includes('#') ? `${baseOf(itemId)}|${rarityOf(itemId)}` : baseOf(itemId);
          if (key === want || (!itemId.includes('#') && baseOf(itemId) === w.base && !w.itemId.includes('|'))) list.push({ acc: id, name: g.data.stats.name || (account(id) || {}).name, itemId, qty });
        }
      }
      out[w.itemId] = list;
    }
    return out;
  });
  handle('mw-add', (o) => {
    const base = String(o.id || '').split(/[|#]/)[0]; if (!base) return { ok: false };
    const grade = GRADE_SUFFIX[o.grade] != null ? o.grade : 'normal';
    const itemId = base + (o.gear === false ? '' : GRADE_SUFFIX[grade]);
    const watch = mwList();
    if (watch.some((w) => w.itemId === itemId)) return { ok: false, error: 'ติดตามอยู่แล้ว' };
    if (watch.length >= 40) return { ok: false, error: 'ติดตามได้สูงสุด 40 รายการ' };
    watch.push({ itemId, base, grade, name: (o.name || base) + (grade !== 'normal' && o.gear !== false ? ` (${grade[0].toUpperCase() + grade.slice(1)})` : ''), key: '', at: 0, below: 0, above: 0 });
    store.save(); return { ok: true };
  });
  handle('mw-remove', (itemId) => { const w = mwList(); const i = w.findIndex((x) => x.itemId === itemId); if (i >= 0) { const k = w[i].key; w.splice(i, 1); if (k) { delete mwHist()[k]; marketLive.delete(k); } store.save(); } return true; });
  handle('mw-set', (itemId, patch) => { const w = mwList().find((x) => x.itemId === itemId); if (w) { if (patch.below !== undefined) { w.below = Math.max(0, Number(patch.below) || 0); w.belowSent = false; } if (patch.above !== undefined) { w.above = Math.max(0, Number(patch.above) || 0); w.aboveSent = false; } store.save(); } return true; });
  handle('mw-every', (min) => { store.data.settings.marketWatchMin = Math.max(1, Math.min(60, Number(min) || 2)); store.save(); return true; });
  handle('mw-now', (itemId) => { const w = mwList().find((x) => x.itemId === itemId); if (w) w.at = 0; mwLastAsk = 0; return true; });
  // check one item now (not watched): ask through an online account and wait for the answer
  handle('mw-check', async (o) => {
    const acc = openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
    if (!acc) return { ok: false, error: 'ต้องมีบัญชีที่ออนไลน์อยู่อย่างน้อย 1 บัญชี' };
    const base = String(o.id || '').split(/[|#]/)[0];
    const itemId = base + (o.gear === false ? '' : (GRADE_SUFFIX[o.grade] || ''));
    const g = acc[1]; const t0 = Date.now();
    await requestPrice(acc[0], itemId, true);
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 150)); const p = g.data.itemPrices.get(itemId); if (p && p.at >= t0 - 1000) return { ok: true, itemId, ...p }; } // eslint-disable-line no-await-in-loop
    return { ok: false, error: 'ตลาดไม่ตอบ' };
  });
  handle('lab-combos', () => labCall('window.__bdLab.combos()'));
  handle('lab-full', (p) => labCall(`window.__bdLab.full(${JSON.stringify(withAdj(p))})`));
  handle('lab-maps', (p) => labCall(`window.__bdLab.maps(${JSON.stringify(withAdj(p))})`));
  handle('lab-cards', (p) => labCall(`window.__bdLab.cards(${JSON.stringify(withAdj(p))})`));
  const labMe = async (id) => {
    const g = games.get(id);
    if (!g || !g.win || g.win.isDestroyed() || !g.inGame) return null;
    try {
      const me = await g.win.webContents.executeJavaScript(ME_JS, true);
      if (!me) return null;
      // class 2: the game keeps it as a path name or a small JSON object (path, jobLevel, points)
      let c2 = me.c2; let c2obj = null;
      if (typeof c2 === 'string' && c2.trim().startsWith('{')) { try { c2obj = JSON.parse(c2); } catch { /* keep string */ } }
      else if (typeof c2 === 'string' && c2.includes('|')) { const [path, jl] = c2.split('|'); c2obj = { path, jobLevel: Number(jl) || 0 }; } // "path|jobLevel|jobExp|…" e.g. "scribe|50|0|1"
      else if (c2 && typeof c2 === 'object') c2obj = c2;
      const r = me.c2r && typeof me.c2r === 'object' ? me.c2r : {};
      const c2info = { path: (c2obj && c2obj.path) || (typeof c2 === 'string' && !c2obj ? c2 : '') || r.path || '', jobLevel: (c2obj && c2obj.jobLevel) || r.jobLevel || 0, points: (c2obj && c2obj.points) ?? r.points ?? 0 };
      // cards this character owns: equipped (album) + card items in the bag ("spirit_card+N|monster")
      const owned = {};
      const addCard = (str, n) => { const v = String(str); const bar = v.indexOf('|'); if (bar < 0 || !/^spirit_card/.test(v)) return; const plus = /\+(\d+)/.exec(v.slice(0, bar)); const mob = v.slice(bar + 1).split('#')[0]; const st = (plus ? Number(plus[1]) : 0) + 1; const o = owned[mob] || (owned[mob] = { mob, stars: 0, n: 0 }); o.stars = Math.max(o.stars, st); o.n += n; };
      for (const v of Object.values(g.adapter.loadout.album || {})) addCard(v, 1);
      if (g.adapter.inv) for (const [k, q] of g.adapter.inv) addCard(k, q || 1);
      return { ...me, c2: c2info.path, c2info, loadout: g.adapter.loadout, ownedCards: Object.values(owned), name: (account(id) || {}).name };
    } catch { return null; }
  };
  handle('lab-me', labMe);
  labMeRef = labMe;
  handle('selftest', (id, opts) => selftest.runSelfTest(id, opts || {}));
  handle('stats-summary', (days) => selftest.statsSummary(days || 7));
  handle('log-bundle', async () => {
    for (const [id, g] of games) if (g.inGame && !g.demo) await selftest.combatFlush(id).catch(() => null); // eslint-disable-line no-await-in-loop
    let dir; try { dir = app.getPath('desktop'); fs.accessSync(dir, fs.constants.W_OK); } catch { dir = app.getPath('downloads'); try { fs.mkdirSync(dir, { recursive: true }); } catch { dir = log.dir(); } }
    try {
      const r = selftest.bundle(dir, { platform: process.platform, os: require('os').release(), electron: process.versions.electron });
      shell.showItemInFolder(r.file);
      return r;
    } catch (err) { log.warn('log bundle:', err.message); return { ok: false, error: err.message }; }
  });
  handle('open-selftest', () => { const d = path.join(log.dir(), 'selftest'); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
  handle('salvage-preview', async (rarities, o) => {
    const opt = salvageOpts(o);
    const list = openGames().filter(([, g]) => g.inGame && !g.demo);
    if (opt.byPrice) await Promise.all(list.map(([id, g]) => priceGear(id, salvageable(g, rarities))));
    return list.map(([id, g]) => { const all = salvageable(g, rarities); const ok = opt.byPrice ? salvageable(g, rarities, opt) : all; return { id, name: g.data.stats.name || account(id).name, count: ok.length, kept: all.length - ok.length }; });
  });
  // one account: every unlocked gear piece with its market numbers and the verdict
  handle('salvage-verdicts', async (id, o) => {
    const g = games.get(id); if (!g || !g.inGame) return null;
    const opt = salvageOpts(o);
    const all = salvageable(g, ['normal', 'magic', 'rare', 'epic']);
    await priceGear(id, all);
    return { opt, items: all.map((x) => ({ id: x, ...salvageVerdict(g, x, opt) })) };
  });
  handle('potions', () => POTIONS);
  handle('item-watch', (name, limit) => {
    const w = store.data.settings.itemWatch;
    const n = Number(limit);
    if (limit === null || limit === '' || !(n > 0)) delete w[name];
    else w[name] = Math.floor(n);
    store.save();
    pushState();
  });
  handle('open-settings', (tab) => openSettings(tab));
  handle('update-check', () => updater.check(true));
  handle('update-now', () => { const u = updater.state(); if (u.status === 'available') updater.download(); else updater.check(true); });
  handle('open-release', () => shell.openExternal('https://github.com/Bdev666/BB/releases/latest'));
  handle('open-hidden', (id) => openGame(id, { hidden: true }));
  handle('app-info', () => ({
    name: 'BinderDash',
    version: app.getVersion(),
    author: require('../package.json').author || '',
    userData: app.getPath('userData'),
    defaultGameUrl: DEFAULT_GAME_URL,
    activeGameUrl: gameUrl,
  }));
  handle('open-userdata', () => shell.openPath(app.getPath('userData')));
  handle('clear-cookies', async () => {
    for (const a of store.data.accounts) {
      await session.fromPartition(`persist:acc-${a.id}`).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] }).catch(() => {});
    }
    for (const [, g] of openGames()) g.win.webContents.reload();
  });
  handle('clear-cache', async () => {
    for (const a of store.data.accounts) await session.fromPartition(`persist:acc-${a.id}`).clearCache().catch(() => {});
    for (const [, g] of openGames()) g.win.webContents.reloadIgnoringCache();
  });
  handle('open-logs', () => shell.openPath(log.dir()));
  handle('make-report', () => makeReport());
  handle('open-captures', () => {
    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ---------- app lifecycle ----------
app.on('second-instance', () => createDashboard());
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; try { farmSaveTick(); } catch { /* closing */ } });

// Google refuses sign-in in browsers that announce Electron: every window (game pages and
// their sign-in popups) presents itself as plain Chrome
app.userAgentFallback = chromeUA(app.userAgentFallback);

// Log errors instead of showing Electron's crash dialog (which would freeze the app)
process.on('uncaughtException', (err) => log.error('uncaught', err));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));

app.whenReady().then(() => {
  log.init(app.getPath('userData'));
  log.info(`BinderDash ${app.getVersion()} start · Electron ${process.versions.electron} · ${process.platform} ${require('os').release()}`);
  store = new Store(app.getPath('userData'));
  if (store.data.calib && Object.keys(store.data.calib).some((k) => !k.includes(':'))) { store.data.calib = {}; store.save(); } // 0.37 compared without crits: start over
  if (store.loadError) log.warn(`settings: ${store.loadError}${store.loadedFrom ? ' -> loaded the backup ' + path.basename(store.loadedFrom) : ' -> started with defaults'}`);
  gameUrl = store.data.settings.gameUrl || DEFAULT_GAME_URL;
  registerIpc();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'BinderDash', submenu: [{ label: 'Dashboard', accelerator: 'Cmd+Shift+D', click: () => toggleDashboard() }, { label: 'ตั้งค่า…', accelerator: 'Cmd+,', click: () => openSettings() }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit', label: 'ออกจาก BinderDash' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
    app.on('activate', () => createDashboard()); // click on the Dock icon
  }
  createTray();
  if (store.data.settings.openDashboardOnStart) createDashboard();
  // accounts open before an update come back by themselves; otherwise "open all on start"
  const reopen = store.data.reopenAfterUpdate;
  const toOpen = Array.isArray(reopen) ? reopen.filter((id) => account(id))
    : store.data.settings.openAllOnStart ? store.data.accounts.map((a) => a.id) : [];
  if (reopen) { delete store.data.reopenAfterUpdate; store.save(); }
  toOpen.forEach((id, i) => setTimeout(() => openGame(id, { hidden: !!reopen }), i * 2000)); // staggered: smoother start
  updater.init({
    onChange: () => pushState(),
    onAvailable: () => { createDashboard(); pushState(); }, // the dashboard shows its update card
    beforeInstall: () => {
      store.data.reopenAfterUpdate = openGames().map(([id]) => id);
      store.save();
      quitting = true;
    },
  });
  setInterval(tick, 15 * 1000);
  setInterval(() => selftest.statsTick(), 10 * 60 * 1000);
  setInterval(demoTick, 500);
  setInterval(pollSnapshots, 1000);
  setInterval(bossTick, 15 * 1000);
  setInterval(reconnectTick, 5000);
  setInterval(marketTick, 15 * 1000);
  setInterval(fightTick, 5000);
  setInterval(marketWatchTick, 1000);
  setInterval(autoRespawnTick, 15000);
  setInterval(bountyTick, 20000);
  setInterval(crowdTick, 20000);
  setInterval(farmTick, 15000);
  setInterval(farmSaveTick, 5 * 60000);
  // Build Lab numbers from every real-damage record kept, at start and every hour
  const calibFromHistory = () => {
    try {
      const h = selftest.calibHistory(45); const all = store.data.calib || (store.data.calib = {});
      let n = 0;
      for (const [key, c] of Object.entries(h)) { const old = all[key]; if (!old || old.v !== 3 || old.job !== c.job || (old.runs || 0) <= c.runs) { all[key] = c; n++; } }
      if (n) { store.save(); log.info(`calibration from the combat history: ${n} entr${n === 1 ? 'y' : 'ies'} · ${Object.entries(h).filter(([k]) => !k.includes(':mob:')).map(([k, c]) => `${k} k=${c.k} pack=${c.pack} n=${c.n}`).join(', ')}`); }
    } catch (e) { log.warn(`calibration from history: ${e.message}`); }
  };
  // boss fights (field and world bosses): real damage per second against the lab's prediction for that boss,
  // per account + boss (needs the character in game for its build); 3 fights at least
  const calibFromBossFights = async () => {
    const all = store.data.calib || (store.data.calib = {}); const since = Date.now() - 30 * 864e5;
    const by = {};
    for (const f of store.data.fights || []) if (f.acc != null && f.at >= since && f.sec >= 20 && f.dps > 0) (by[`${f.acc}|${f.mob}`] || (by[`${f.acc}|${f.mob}`] = [])).push(f);
    for (const [key, fs] of Object.entries(by)) {
      if (fs.length < 3) continue;
      const [acc, mob] = [Number(key.split('|')[0]), key.split('|')[1]];
      const g = games.get(acc); if (!g || !g.inGame || g.demo || !labMeRef) continue;
      let me; try { me = await labMeRef(acc); } catch { me = null; } if (!me) continue;
      let pr; try { pr = await labCall(`window.__bdLab.predict(${JSON.stringify({ job: me.job, level: me.level, jobLevel: me.jobLevel, stats: me.stats, basics: me.skills, target: mob, guild: me.guildLevel || 0, c2Job: (me.c2info && me.c2info.jobLevel) || 50, loadout: { ...(me.loadout || {}), wRefine: me.wRefine, sRefine: me.sRefine }, current: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr } })})`); } catch { pr = null; }
      if (!pr || !(pr.withCombos > 0)) continue;
      const xs = fs.map((f) => f.dps).sort((a, b) => a - b); const real = xs[xs.length >> 1];
      const base = all[`${acc}:world`] || {};
      all[`${acc}:mob:${mob}`] = { ...base, v: 3, job: me.job, kind: 'world', d: +(real / pr.withCombos).toFixed(3), k: base.k || 1, mob, n: fs.length, runs: fs.length, fromBossFights: true, realDps: real, at: Date.now() };
      log.info(`boss calibration acc ${acc} ${mob}: real ${real}/s over ${fs.length} fights vs lab ${pr.withCombos}/s -> x${(real / pr.withCombos).toFixed(2)}`);
    }
    store.save();
  };
  setTimeout(() => calibFromBossFights().catch((e) => log.warn(`boss calibration: ${e.message}`)), 90000);
  setInterval(() => calibFromBossFights().catch(() => {}), 60 * 60000);
  setTimeout(calibFromHistory, 8000);
  setInterval(calibFromHistory, 60 * 60000);
  applyStartWithWindows();
  syncRemote();
});
