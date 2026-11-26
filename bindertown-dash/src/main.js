const HUB = require('./core/hub');
// BinderDash: fan-made multi-account launcher + dashboard for Binder Town.
// Unofficial. Read-only: it watches the game, it never plays for you.
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage,
  powerSaveBlocker, shell, dialog, session,
} = require('electron');
HUB.fs = require('fs');
HUB.path = require('path');
const { Store } = require('./store');
HUB.telegram = require('./telegram');
const icons = require('./icons');
const __m1 = require('./game-adapter'); const BinderTownAdapter = __m1.BinderTownAdapter; const SNAPSHOT_JS = __m1.SNAPSHOT_JS; HUB.encodeInput = __m1.encodeInput; HUB.itemLabel = __m1.pretty; HUB.POTIONS = __m1.POTIONS; const KNOWN_BUILDS = __m1.KNOWN_BUILDS; HUB.MARKET_FILTER = __m1.MARKET_FILTER; HUB.rarityOf = __m1.rarityOf; HUB.baseOf = __m1.baseOf; HUB.pretty = __m1.pretty;
const { AccountData } = require('./session-data');
const { DemoFeed } = require('./demo');
const APP_ICON = HUB.path.join(__dirname, 'assets', 'icon.png');
const updater = require('./updater');
HUB.log = require('./logger');

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
// GPU: use the graphics card fully (Settings: "เร่งกราฟิก", on by default; takes effect at the next start). The game draws with
// WebGL: a driver on Chromium's block list falls back to slow software drawing, rasterizing on the GPU keeps the CPU for the
// game, and a laptop with two GPUs is asked for the fast one.
const EARLY = (() => { try { return JSON.parse(HUB_FS().readFileSync(require('path').join(app.getPath('userData'), 'config.json'), 'utf8')).settings || {}; } catch { return {}; } })();
function HUB_FS() { return require('fs'); }
if (EARLY.gpuBoost !== false) {
  for (const sw of ['ignore-gpu-blocklist', 'enable-gpu-rasterization', 'enable-zero-copy', 'force_high_performance_gpu']) app.commandLine.appendSwitch(sw);
}

HUB.store = undefined;
HUB.dashboard = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let sleepBlocker = null;
HUB.games = new Map(); // accountId -> runtime state
HUB.labMeRef = null;
HUB.selftest = require('./selftest').create({
  games: HUB.games, log: HUB.log, store: () => HUB.store, version: () => app.getVersion(),
  salvageable: (...a) => HUB.salvageable(...a), tradableGear: (...a) => HUB.tradableGear(...a), priceGear: (...a) => HUB.priceGear(...a),
  salvageOpts: (...a) => HUB.salvageOpts(...a), salvageVerdict: (...a) => HUB.salvageVerdict(...a), sendInput: (...a) => HUB.sendInput(...a),
  runCommand: (...a) => HUB.runCommand(...a), MARKET_FILTER: HUB.MARKET_FILTER, labMe: (id) => (HUB.labMeRef ? HUB.labMeRef(id) : null),
  labPredict: (p) => HUB.labCall(`window.__bdLab.predict(${JSON.stringify(p)})`),
  // per character: real hit / formula hit (median over skills), eased in over time
  // kept apart for world bosses and everything else (the world boss takes damage differently from what the formula says)
  saveCalib: (id, c) => {
    const all = HUB.store.data.calib || (HUB.store.data.calib = {}); const key = `${id}:${c.kind || 'field'}`; const old = all[key];
    if (c.k < 0.2 || c.k > 8) { HUB.log.info(`calib acc ${id} ${c.kind}: x${c.k} ignored (out of range)`); return; }
    const ease = (a, b) => (a && b ? +(a * 0.6 + b * 0.4).toFixed(3) : b || a || null);
    if (c.d != null && (c.d < 0.2 || c.d > 20)) c.d = null; // whole-DPS ratio: real / formula (hits per second, focus, splash included)
    const relOf = (a, b) => { const out = { ...(a || {}) }; for (const [sid, x] of Object.entries(b || {})) out[sid] = out[sid] ? +(out[sid] * 0.6 + x * 0.4).toFixed(3) : x; return out; };
    if (c.pack != null && !(c.pack >= 1 && c.pack <= 8)) c.pack = null; // monsters really hit at once (from real DPS over the pack curve)
    // v3: class-2 traits are in the lab now; numbers learned without them start over
    all[key] = old && old.job === c.job && old.v === c.v ? { ...c, k: ease(old.k, c.k), d: ease(old.d, c.d), pack: ease(old.pack, c.pack), rel: relOf(old.rel, c.rel), runs: (old.runs || 1) + 1 } : { ...c, runs: 1 };
    // field monsters differ a lot (weak ones die in one hit, and overkill is not reported): also per monster
    if (c.kind !== 'world' && c.mob) { const mk = `${id}:mob:${c.mob}`; const om = all[mk]; all[mk] = om && om.job === c.job && om.v === c.v ? { ...c, k: ease(om.k, c.k), d: ease(om.d, c.d), pack: ease(om.pack, c.pack), rel: relOf(om.rel, c.rel), runs: (om.runs || 1) + 1 } : { ...c, runs: 1 }; }
    HUB.store.save();
  },
  onProgress: (st) => { for (const w of [HUB.dashboard, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('dash:selftest-step', st); },
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
HUB.rt = HUB.rt = function rt(id) {
  if (!HUB.games.has(id)) HUB.games.set(id, { ...blankRuntime(), accId: id });
  return HUB.games.get(id);
};;
HUB.account = function account(id) { return HUB.store.data.accounts.find((a) => a.id === id); };
require('./features/premium');

function publicState() {
  const now = Date.now();
  return {
    settings: { ...HUB.store.data.settings, telegram: { connected: !!(HUB.store.data.settings.telegram.token && HUB.store.data.settings.telegram.chatId) } },
    maxAccounts: MAX_ACCOUNTS,
    update: { ...updater.state(), current: app.getVersion() },
    bosses: HUB.bossView(),
    events: HUB.eventsView(),
    accounts: HUB.store.data.accounts.map((a) => {
      const g = HUB.rt(a.id);
      return {
        id: a.id,
        name: a.name,
        status: g.demo ? 'demo' : g.status,
        hidden: !!(g.win && !g.win.isVisible()),
        summary: g.data.summary(now),
        memoryMB: g.memoryMB || null,
        compat: g.inGame && !g.demo ? g.adapter.health() : null,
        bounty: HUB.bountyStatus(g),
        spam: { ...HUB.spamCfg(a.id), state: g.spamState || '' },
        turbo: HUB.refineView(g),
        premium: HUB.isPremium(a.id, g), premiumMode: a.premium || 'auto', premiumGame: g.data && g.data.stats ? g.data.stats.premium : undefined,
        finder: HUB.finderStatus(g),
        driver: (() => { const d = HUB.driverOf(g); return d ? HUB.DRIVE_TH[d] : ''; })(),
        deaths: HUB.deathCost(a.id, g),
        autoRespawn: g.autoRespawn ? { on: !!g.autoRespawn.on, why: g.autoRespawn.why || '', count: g.autoRespawns || 0 } : null,
        alerts: [...g.alerts],
        alertTexts: Object.fromEntries(g.alertTexts || []), // what each alert says, in Thai with the item's real name
      };
    }),
  };
}

HUB.visible = (w) => !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized();
let pushTimer = null;
let sleepMode = false; let sleepShown = [];
// The dashboard gets the whole state; it is built and sent only when someone can see it, at most 4 times a second while the window
// has focus, once a second when it is just visible behind something, and never when what would be sent is what it already has.
let lastSent = '';
HUB.pushState = function pushState() {
  if (pushTimer) return;
  const focused = !!(HUB.dashboard && !HUB.dashboard.isDestroyed() && HUB.dashboard.isFocused());
  pushTimer = setTimeout(() => {
    pushTimer = null;
    updateTray();
    logChanges();
    const targets = [HUB.dashboard, settingsWin].filter(HUB.visible);
    if (!targets.length) { lastSent = ''; return; }
    const st = publicState(); const json = JSON.stringify(st);
    if (json === lastSent) return;
    lastSent = json;
    for (const w of targets) w.webContents.send('dash:state', st);
  }, focused ? 250 : 1000);
};

// ---------- notifications ----------
HUB.notify = function notify(id, kind, text) {
  const s = HUB.store.data.settings;
  const group = kind.startsWith('item:') ? 'itemLow' : kind.startsWith('potion:') ? 'potion' : kind === 'weightFull' ? 'weight' : kind;
  if (s.notify[group] === false) return;
  // id null = about the game world (bosses), not one account
  const g = id == null ? null : HUB.rt(id);
  if (g && g.demo) return; // demo data never notifies
  // don't interrupt the account you're looking at right now
  if (g && g.win && !g.win.isDestroyed() && g.win.isVisible() && g.win.isFocused()) return;
  HUB.log.info(`notify ${id == null ? 'world' : 'acc ' + id} ${kind}`);
  const a = id == null ? null : HUB.account(id);
  const title = a ? (g.data.stats.name ? `${a.name} · ${g.data.stats.name}` : a.name) : 'BinderDash';
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: text, silent: !s.notify.sound, icon: nativeImage.createFromDataURL(icons.alert) });
    n.on('click', () => (id == null ? createDashboard() : showGame(id)));
    n.show();
  }
  HUB.telegram.send(s.telegram.token, s.telegram.chatId, `${title}: ${text}`).catch(() => {});
};

HUB.setAlert = function setAlert(id, key, on, text) {
  const g = HUB.rt(id);
  g.alertTexts = g.alertTexts || new Map();
  if (on && text) g.alertTexts.set(key, text); else if (!on) g.alertTexts.delete(key);
  if (on && !g.alerts.has(key)) {
    g.alerts.add(key);
    if (key !== 'death') HUB.log.info(`acc ${id}: alert on ${key.replace(/:.*/, ':…')}`); // deaths: the respawn lines say them
    g.alertSaid = g.alertSaid || new Map();
    const said = g.alertSaid.get(key);
    if (!(said && Date.now() - said < 15 * 60000 && /^(weight|weightFull|idle|potion|item)/.test(key))) { g.alertSaid.set(key, Date.now()); HUB.notify(id, key, text); }
  } else if (!on && g.alerts.has(key)) {
    g.alerts.delete(key);
    if (key !== 'death') HUB.log.info(`acc ${id}: alert off ${key.replace(/:.*/, ':…')}`);
  }
  HUB.pushState();
};

// ---------- game windows ----------
const VIS_JS = (hidden) => `(() => { try { const h = ${hidden ? 'true' : 'false'};
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange')); return true; } catch (e) { return false; } })()`;
HUB.syncVisibility = function syncVisibility(g) {
  if (!g || !g.win || g.win.isDestroyed()) return;
  const hidden = HUB.store.data.settings.lowFpsHidden !== false && (!g.win.isVisible() || g.win.isMinimized());
  if (g.pageHidden === hidden) return;
  g.pageHidden = hidden;
  g.win.webContents.executeJavaScript(VIS_JS(hidden), true).catch(() => { g.pageHidden = undefined; });
};
function windowTitle(id) {
  const a = HUB.account(id);
  const n = HUB.rt(id).data.stats.name;
  return `${n ? `${a.name} · ${n}` : a.name} — Binder Town`;
}

// Put a game window over the middle of the Dashboard (unless the user has moved it themselves)
function placeOverDashboard(win) {
  if (!HUB.dashboard || HUB.dashboard.isDestroyed() || !HUB.dashboard.isVisible() || HUB.dashboard.isMinimized()) return;
  const d = HUB.dashboard.getBounds();
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
  const a = HUB.account(id);
  if (!a) return;
  const g = HUB.rt(id);
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
      preload: HUB.path.join(__dirname, 'preload-game.js'),
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
  const startHidden = !!(HUB.store.data.settings.openHidden || opts.hidden);
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
  // A hidden game still drew at full speed (its timers must keep running, and that also kept the page "visible"): with 3 games
  // open, two drew for nobody and took the GPU from the one on screen. The page is told it is hidden while its window is
  // hidden or minimized: the game itself drops to 4 frames a second then (its own rule for a background tab), AUTO goes on.
  const sync = () => HUB.syncVisibility(g);
  for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, sync);
  win.webContents.on('did-finish-load', () => { g.pageHidden = undefined; setTimeout(sync, 1500); setTimeout(sync, 8000); });
  win.on('close', (e) => {
    if (quitting) return;
    // X on a game window = leave the game (account stays in the list)
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['ปิดเกม', 'ซ่อนเกม', 'ยกเลิก'], defaultId: 1, cancelId: 2,
      message: `ปิดเกมของ ${a.name}?`, detail: 'ปิดเกม = ตัวละครออกจากเกม · ซ่อนเกม = เกมเล่นต่อ แค่ซ่อนหน้าต่าง',
    });
    if (choice === 1) { e.preventDefault(); win.hide(); HUB.pushState(); }
    else if (choice === 2) e.preventDefault();
  });
  // A frozen game page never answers a page script: every caller used to wait for ever (and the one-by-one page read stopped
  // for all accounts behind it). Every script now gives up after 10 s (the page keeps whatever it was doing); callers already
  // treat a failed script as "no answer".
  { const wc = win.webContents; const run = wc.executeJavaScript.bind(wc);
    wc.executeJavaScript = (code, gesture) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const n = (win.__jsTimeouts = (win.__jsTimeouts || 0) + 1);
        if (n <= 3 || n % 50 === 0) HUB.log.warn(`acc ${id}: a page script got no answer in 10 s (${n}x) - the game page is busy or frozen`);
        reject(new Error('page script timed out'));
      }, 10000);
      run(code, gesture).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    }); }
  win.on('closed', () => {
    HUB.games.set(id, { ...blankRuntime(), accId: id }); // accId too: without it a boss fight was logged for "acc undefined"
    updateSleepBlocker();
    HUB.pushState();
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
    HUB.pushState();
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
      HUB.setAlert(id, 'maintenance', true, 'เกมปิดปรับปรุง (maintenance)');
    } else {
      HUB.setAlert(id, 'maintenance', false);
    }
    HUB.pushState();
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (isMain && code !== -3) { g.status = 'offline'; HUB.pushState(); }
  });
  wc.on('render-process-gone', (_e, details) => {
    if (g.ramKill && Date.now() - g.ramKill < 15000) { g.ramKill = 0; HUB.log.info(`acc ${id}: game page restarted on purpose (a new renderer gives the memory back)`); return; }
    HUB.log.error(`acc ${id}: game page gone: ${details.reason} (exit ${details.exitCode})`);
    g.status = 'crashed';
    HUB.setAlert(id, 'crash', true, `หน้าเกมหยุดทำงาน (${details.reason})`);
    if (details.reason !== 'clean-exit') scheduleReload(id, 'หน้าเกมหยุดทำงาน', 5000);
  });
  wc.on('unresponsive', () => {
    HUB.setAlert(id, 'crash', true, 'หน้าเกมค้าง ไม่ตอบสนอง');
    g.hangSince = Date.now();
  });
  wc.on('responsive', () => { g.hangSince = 0; HUB.setAlert(id, 'crash', false); });
  wc.on('did-start-loading', () => { g.sockets.clear(); g.loadedAt = Date.now(); });

  attachWatcher(id, wc);
  win.loadURL(gameUrl);
  HUB.pushState();
}

// Watch the game's WebSocket traffic through the DevTools protocol (read-only).
function attachWatcher(id, wc) {
  const g = HUB.rt(id);
  const dbg = wc.debugger;
  // attach (if not attached) and switch Network on. Done again after every page load: a page that came back from a crash or
  // a new renderer process has lost it, and the account then read nothing from the game (no data for hours, a log showed it)
  const enable = () => {
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (err) { HUB.log.error(`acc ${id}: debugger attach failed`, err); return false; }
    // small buffers: we only need WebSocket frames, not response bodies kept in memory
    dbg.sendCommand('Network.enable', { maxTotalBufferSize: 1024 * 1024, maxResourceBufferSize: 64 * 1024 }).catch(() => {});
    return true;
  };
  if (!enable()) return;
  wc.on('did-finish-load', () => { if (enable()) HUB.log.info(`acc ${id}: page loaded: game data watcher on`); });
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
      if (params.response.opcode === 2) { const o = HUB.rt(id).adapter.outgoing(Buffer.from(params.response.payloadData, 'base64')); if (o && o.cast) HUB.selftest.combatCast(id, o.cast); }
    }
  });
  dbg.on('detach', (_e, reason) => {
    HUB.log.warn(`acc ${id}: debugger detached: ${reason}`);
    setTimeout(() => { try { if (!wc.isDestroyed() && enable()) HUB.log.info(`acc ${id}: debugger attached again`); } catch { /* window closing */ } }, 1500);
  });
}

function onFrame(id, frame) {
  const g = HUB.rt(id);
  g.lastMsgAt = Date.now();
  if (g.status !== 'online') { g.status = 'online'; }
  if (g.alerts.has('disconnect')) HUB.setAlert(id, 'disconnect', false);

  if (HUB.store.data.settings.debugCapture) capture(id, frame);
  // the game talks Colyseus over binary frames (opcode 2, base64 from the DevTools protocol)
  if (frame.opcode !== 2) return HUB.pushState();
  try {
    handleEvents(id, g.adapter.incoming(Buffer.from(frame.payloadData, 'base64')));
  } catch (err) {
    HUB.log.once(`decode:${id}`, 60000, 'error', `acc ${id}: frame decode failed`, err);
  }
  HUB.pushState();
}

// Read the game's own state (window.__game) once a second: character, mobs, minimap. Read-only.
let watchedId = null; // account the dashboard is showing (gets the minimap)
async function pollSnapshots() {
  if (process.env.BD_NO_SNAPSHOT) return; // diagnostics only: measure a game page with nothing read from it
  const looking = HUB.visible(HUB.dashboard);
  const now = Date.now();
  // all accounts at once: one slow page no longer holds up the others (each read has its own 10 s limit)
  await Promise.all(HUB.openGames().map(async ([id, g]) => {
    if (g.snapshotBusy || g.status === 'maintenance' || g.status === 'crashed') return;
    // dashboard closed: every 3 s is plenty for alerts
    // every second only for the account open in the Dashboard; the others (and all when nobody looks) every 3 s:
    // each read runs inside the game page, so fewer reads = smoother games
    if ((!looking || sleepMode || id !== watchedId) && g.lastSnapAt && now - g.lastSnapAt < 3000) return;
    g.lastSnapAt = now;
    g.snapshotBusy = true;
    try {
      const wantMini = looking && id === watchedId;
      const snap = await g.win.webContents.executeJavaScript(`window.__bdWantMini=${wantMini};` + SNAPSHOT_JS, true);
      if (!g.win || g.win.isDestroyed()) return;
      const prevName = g.data.stats.name;
      handleEvents(id, g.adapter.snapshot(snap));
      if (g.inGame && !g.demo) HUB.farmBalance(g);
      if (snap && snap.fps && g.win.isVisible() && !g.win.isMinimized()) {
        const P = g.perf || (g.perf = { n: 0, sum: 0, min: 999, worst: 0 });
        P.n++; P.sum += snap.fps.fps; P.min = Math.min(P.min, snap.fps.fps); P.worst = Math.max(P.worst, snap.fps.worstMs);
        if (snap.fps.worstMs >= 2000 && (!g.freezeLogAt || Date.now() - g.freezeLogAt > 60000)) { g.freezeLogAt = Date.now(); HUB.log.info(`acc ${id}: game window froze ${(snap.fps.worstMs / 1000).toFixed(1)} s (${snap.fps.fps} fps this second, ${g.memoryMB || '?'} MB)`); }
      }
      if (g.inGame && !g.demo && Number.isFinite(Number(g.data.stats.silver))) {
        const m = Math.floor(Date.now() / 60000); const B = g.balHist || (g.balHist = []);
        if (!B.length || B[B.length - 1][0] !== m) { B.push([m, Number(g.data.stats.silver)]); while (B.length > 61) B.shift(); }
      }
      if (snap && snap.ready) { if (!g.inGame) { g.inGameAt = Date.now(); setTimeout(() => HUB.uiCheck(id, g).catch(() => {}), 25000); } g.inGame = true; }
      else if (g.status === 'loading' && Date.now() - g.loadedAt > 5000) { g.status = 'lobby'; HUB.pushState(); }
      watchScreen(id, snap);
      if (g.data.stats.name !== prevName) g.win.setTitle(windowTitle(id));
    } catch { /* page reloading */ } finally {
      g.snapshotBusy = false;
    }
  }));
  HUB.pushState();
}

const captureStreams = new Map();
function capture(id, frame) {
  let s = captureStreams.get(id);
  if (!s) {
    const dir = HUB.path.join(app.getPath('userData'), 'captures');
    HUB.fs.mkdirSync(dir, { recursive: true });
    s = HUB.fs.createWriteStream(HUB.path.join(dir, `acc-${id}.jsonl`), { flags: 'a' });
    captureStreams.set(id, s);
  }
  const data = frame.payloadData || '';
  s.write(JSON.stringify({ t: Date.now(), op: frame.opcode, data: data.slice(0, 4000) }) + '\n');
}

function showGame(id) {
  const g = HUB.rt(id);
  if (!g.win || g.win.isDestroyed()) return openGame(id);
  if (g.win.isMinimized()) g.win.restore();
  if (!g.win.isVisible() && !g.userPlaced) placeOverDashboard(g.win);
  g.hiddenOnPurpose = false;
  g.win.show();
  g.win.focus();
}
function hideGame(id) {
  const g = HUB.rt(id);
  if (g.win && !g.win.isDestroyed()) g.win.hide();
}
function closeGame(id) {
  const g = HUB.rt(id);
  if (g.win && !g.win.isDestroyed()) g.win.destroy();
}
HUB.openGames = function openGames() {
  return [...HUB.games.entries()].filter(([, g]) => g.win && !g.win.isDestroyed());
};

// While a game is open, don't let Windows suspend the app when idle
function updateSleepBlocker() {
  const any = HUB.openGames().length > 0;
  if (any && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!any && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
}

// ---------- game events -> data + notifications ----------
function handleEvents(id, events) {
  const g = HUB.rt(id);
  const s = HUB.store.data.settings;
  for (const ev of events) {
    g.data.ingest(ev);
    HUB.farmEvent(id, g, ev);
    switch (ev.type) {
      case 'hit':
      case 'kill':
        g.lastHitAt = Date.now();
        // a real-DPS measurement is running: keep this character's own hits
        if (ev.type === 'refineResult') HUB.refineResult(g, ev);
        if (ev.type === 'hit') { HUB.fightHit(g, ev); HUB.selftest.combatHit(id, ev); HUB.abHit(g, ev); }
        if (ev.type === 'kill' && g.ab && g.ab.phase) HUB.abBucket(g).kills++;
        if (ev.type === 'kill' && g.fight && ev.target === HUB.pretty(g.fight.mob)) HUB.fightEnd(g, true);
        if (ev.type === 'hit' && g.measure && Date.now() < g.measure.until) { const m = g.measure; if (!m.first) m.first = Date.now(); m.last = Date.now(); m.hits.push({ dmg: ev.dmg, sid: ev.sid, mob: ev.mob, pet: ev.pet, crit: ev.crit }); }
        if (g.alerts.has('idle')) HUB.setAlert(id, 'idle', false);
        break;
      case 'humanCheck':
        g.humanCheck = true;
        HUB.setAlert(id, 'human', true, '🧩 เกมขอให้ยืนยันว่าเป็นคน · เปิดหน้าเกมแล้วทำให้เสร็จ (BinderDash ไม่ทำแทน)');
        break;
      case 'humanResult':
        if (ev.ok) { g.humanCheck = false; HUB.setAlert(id, 'human', false); }
        break;
      case 'self':
        if (typeof ev.weightPct === 'number') {
          // two steps: nearly full (default 90%) and full (default 95%: AUTO stops picking up loot)
          const w = ev.weightPct;
          if (w >= s.weightCriticalPct && !g.alerts.has('weightFull')) {
            HUB.setAlert(id, 'weightFull', true, `🎒 กระเป๋าเต็ม ${Math.round(w)}% · เก็บของไม่ได้แล้ว ขาย/ย่อย/ฝากของด่วน`);
          } else if (w >= s.weightFullPct && w < s.weightCriticalPct && !g.alerts.has('weight')) {
            HUB.setAlert(id, 'weight', true, `🎒 กระเป๋าหนัก ${Math.round(w)}% · ใกล้เต็ม`);
          }
          if (w < s.weightCriticalPct - 2 && g.alerts.has('weightFull')) HUB.setAlert(id, 'weightFull', false);
          if (w < s.weightFullPct - 5 && g.alerts.has('weight')) HUB.setAlert(id, 'weight', false);
        }
        if (ev.dead && !g.deadSince) g.deadSince = Date.now(); // a death the event stream missed
        if (ev.dead && !g.alerts.has('death') && Date.now() - g.deadSince > 10000) HUB.setAlert(id, 'death', true, 'ตัวละครตายค้าง (เกิน 10 วิ)');
        else if (ev.dead === false && g.alerts.has('death')) HUB.setAlert(id, 'death', false);
        if (ev.dead === false && g.deadSince && Date.now() - g.deadSince > 15000) g.deadSince = 0; // up (the revive message was missed)
        break;
      case 'death':
        g.autoAtDeath = !!g.data.stats.auto;
        { const n0 = Date.now(); g.deathLog = (g.deathLog || []).filter((t) => n0 - t < 3600000); if (!g.deathLog.length || n0 - g.deathLog[g.deathLog.length - 1] > 1500) g.deathLog.push(n0); }
        if (g.lastDeathAt && Date.now() - g.lastDeathAt < 1500) break; // the same death, second message
        g.lastDeathAt = Date.now(); g.deadSince = g.lastDeathAt;
        HUB.selftest.count(id, 'deaths');
        HUB.deathLoopCheck(id, g);
        // a death that gets up again in a few seconds is not news (it was 940 notifications in a few days):
        // the alert / notification only comes when it is still lying dead after 10 s
        clearTimeout(g.deathAlertTimer);
        { const by = ev.by; const at = g.deadSince;
          g.deathAlertTimer = setTimeout(() => { if (g.deadSince === at) HUB.setAlert(id, 'death', true, by ? `ตัวละครตายค้าง (เกิน 10 วิ) · โดย ${by}` : 'ตัวละครตายค้าง (เกิน 10 วิ)'); }, 10000); }
        g.respawnTries = 0; g.respawnClicked = false; g.respawnWhy = false; g.respawnSends = 0; // a new death: start over (send again)
        HUB.backupRespawn(id);
        break;
      case 'revive':
        if (g.respawnTries) HUB.selftest.count(id, 'respawnOk');
        g.respawnClicked = false; g.respawnWhy = false;
        setTimeout(() => HUB.backupRespawn(id, 0), 2500); // a death screen that shows up after the revive gets closed
        if (g.bossTrip && HUB.WORLD_ARENAS.has(HUB.mapOf(g)) && !g.bossWalking) { g.bossWalking = true; setTimeout(() => HUB.walkToBossThenAuto(id, g.bossTrip ? g.bossTrip.kind : '', true).catch(() => {}).finally(() => { g.bossWalking = false; }), 1200); }
        if (g.deadSince) { const ms = Date.now() - g.deadSince; HUB.selftest.count(id, 'revives'); HUB.selftest.count(id, 'deadMs', ms); HUB.log.info(`acc ${id}: up again after ${(ms / 1000).toFixed(1)} s${ev.here ? ' (the game\'s own)' : ''}`); g.deadSince = 0; } // how long it lay dead
        clearTimeout(g.deathAlertTimer);
        if (g.alerts.has('death')) HUB.setAlert(id, 'death', false);
        g.respawnTries = 0;
        if (ev.here) HUB.selftest.count(id, 'autoRespawned');
        if (ev.here) { g.autoRespawns = (g.autoRespawns || 0) + 1; HUB.log.info(`acc ${id}: respawned in place by the game's Auto Respawn (-${ev.fee} G)`); }
        break;
      case 'chat':
        if (ev.channel === 'whisper' && !ev.mine && !ev.backlog) HUB.notify(id, 'whisper', `กระซิบจาก ${ev.from}: ${ev.text}`);
        break;
      case 'party':
        HUB.notify(id, 'party', ev.text || `${ev.from} ชวน/ขอเข้าปาร์ตี้`);
        break;
      case 'card':
        HUB.notify(id, 'card', `🃏 ได้การ์ด ${ev.mob}${ev.level ? ` Lv ${ev.level}` : ''}`);
        break;
      case 'rareDrop':
        HUB.notify(id, 'rareDrop', `✨ ดรอปหายาก: ${ev.item}`);
        break;
      case 'loot':
        // something that isn't a plain monster drop: ask the market what it's worth, notify if it's worth it
        if (ev.worthChecking && ev.id) { g.valuableWait.set(ev.id, { qty: ev.qty, at: Date.now() }); HUB.requestPrice(id, ev.id); }
        break;
      case 'fieldBosses': onFieldBosses(ev.list); break;
      case 'myListings': HUB.onMyListings(id, ev.list); break;
      case 'marketResult': g.lastMarket = { ok: ev.ok, reason: ev.reason, at: Date.now() }; break;
      case 'worldEvent': onWorldEvent(ev); break;
      case 'newType':
        HUB.log.info(`acc ${id}: new server message type from the game: ${ev.name} (fields: ${ev.fields.join(', ') || '-'})`);
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
            HUB.notify(id, 'daily', `🎁 มีของรอรับ: ${[w.pass ? `ภารกิจ Pass ${w.pass}` : null, w.mail ? `จดหมาย ${w.mail} ฉบับ` : null].filter(Boolean).join(' · ')}`);
          }
        }, 10000);
        break;
      }
      case 'worldBoss': HUB.onWorldBoss(ev); break;
      case 'channels': g.channels = { counts: ev.counts, lockMs: ev.lockMs, at: Date.now() }; break;
      case 'hunt': g.hunt = { day: ev.day, prog: ev.progById || {}, claimed: ev.claimedIds || [], at: Date.now() }; break;
      case 'market': {
        let askedId = ev.id;
        if (ev.fromBoard && g.priceAsks && g.priceAsks.length) {
          // answers come back in the order asked: tie this answer to the bag piece that was asked
          const i = g.priceAsks.findIndex((a) => a.id === ev.id);
          const ask = i >= 0 ? g.priceAsks.splice(i, 1)[0] : g.priceAsks.shift();
          if (ask && ask.id !== ev.id && Date.now() - ask.at < 8000) {
            askedId = ask.id; HUB.selftest.count(id, 'priceRemapped');
            const copy = { ...ev, id: ask.id };
            for (const [, o] of HUB.games) o.data.ingest(copy);
          }
        }
        // prices are the same for every account on the server
        for (const [, other] of HUB.games) if (other !== g) other.data.ingest(ev);
        HUB.marketWatchSeen(ev);
        const wKey = g.valuableWait.has(ev.id) ? ev.id : askedId;
        const wait = g.valuableWait.get(wKey);
        if (wait) {
          g.valuableWait.delete(wKey);
          // the central market's price for this kind + grade (cheapest listing now, like the board),
          // never NPC prices; only from the threshold up (default 1,000,000 Gold)
          const G = (n) => Math.round(n).toLocaleString('en-US');
          // the same price again is not news (a 4-day log had ~5,000 of these lines): say it when it changes or every 30 min
          HUB.priceSaid = HUB.priceSaid || new Map(); const pk = ev.key || ev.id; const ps = HUB.priceSaid.get(pk);
          if (!ps || ps.price !== ev.price || Date.now() - ps.at > 30 * 60000) { HUB.priceSaid.set(pk, { price: ev.price, at: Date.now() }); HUB.log.info(`acc ${id}: market price ${pk}: ${ev.price ?? '-'} G (${ev.basis || 'no data'})`); }
          if (ev.price && ev.price * wait.qty >= s.valuableMinGold) {
            HUB.notify(id, 'valuable', `💰 ดรอป ${ev.item}${wait.qty > 1 ? ' x' + wait.qty : ''} · ตลาดกลาง${ev.basis === 'listed' ? 'ถูกสุด' : 'ขายล่าสุด'} ~${G(ev.price)} G${wait.qty > 1 ? '/ชิ้น' : ''}${ev.basis === 'listed' && ev.last ? ` · ขายจริงล่าสุด ${G(ev.last)} G` : ''}`);
          }
        }
        break;
      }
      case 'info':
        if (/^เลเวลอัป/.test(ev.text)) HUB.notify(id, 'levelUp', `🎉 ${ev.text}`);
        // only the server's notices answer a command (not our own level-up lines etc.)
        if (ev.notice) { g.lastNotice = { text: ev.text, at: Date.now() }; const wm = /(?:วาร์ป|warp)[^0-9]{0,40}(\d+)\s*(?:วินาที|วิ|s\b)/i.exec(ev.text || ''); if (wm) g.warpWaitMs = Math.min(60000, (Number(wm[1]) + 1) * 1000); } // a warp cooldown the game named
        break;
      case 'bag':
        for (const it of ev.items || []) {
          const limit = s.itemWatch[it.name];
          const key = 'item:' + it.name;
          if (limit == null) { g.alerts.delete(key); continue; }
          if (it.qty < limit) HUB.setAlert(id, key, true, `${it.name} เหลือ ${it.qty} (ตั้งไว้ต่ำกว่า ${limit})`);
          else if (g.alerts.has(key)) HUB.setAlert(id, key, false);
        }
        break;
      default: break;
    }
  }
}

require('./features/commands');

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
  const s = HUB.store.data.settings;
  const g = HUB.rt(id);
  if (!s.autoReconnect || !g.win || g.win.isDestroyed()) return;
  if (g.rc && g.rc.pending) return; // one at a time
  const now = Date.now();
  g.rcAttempts = (g.rcAttempts || []).filter((t) => now - t < 3600 * 1000);
  if (g.rcAttempts.length >= RECONNECT_MAX_PER_HOUR) {
    HUB.setAlert(id, 'reconnectLimit', true, `ต่อใหม่อัตโนมัติครบ ${RECONNECT_MAX_PER_HOUR} ครั้งในชั่วโมงนี้แล้ว (${reason}) · หยุดลองเพื่อไม่ให้วนไม่จบ กรุณาดูหน้าเกม`);
    return;
  }
  // back off: each extra try this hour waits twice as long (at most 15 minutes)
  const delay = Math.min(15 * 60000, baseDelayMs * 2 ** g.rcAttempts.length);
  g.rc = { pending: true, at: now + delay, reason };
  HUB.log.info(`acc ${id}: reconnect in ${Math.round(delay / 1000)} s (${reason}, try ${g.rcAttempts.length + 1}/${RECONNECT_MAX_PER_HOUR} this hour)`);
  HUB.pushState();
}

function reconnectTick() {
  const now = Date.now();
  const s = HUB.store.data.settings;
  for (const [id, g] of HUB.openGames()) {
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
      HUB.log.info(`acc ${id}: reconnecting (reload page) — ${reason}`);
      try { g.win.webContents.reload(); } catch (err) { HUB.log.error(`acc ${id}: reload failed`, err); }
      HUB.pushState();
    }
  }
}

// What the game page shows: disconnect boxes, sign-in screen. Called with every snapshot.
function watchScreen(id, snap) {
  const g = HUB.rt(id);
  const scr = (snap && snap.screen) || {};
  const kind = classifyVeil(scr.veil);
  if (kind !== g.veil) { if (kind || g.veil) HUB.log.info(`acc ${id}: game screen ${g.veil || '-'} -> ${kind || '-'}`); g.veil = kind; }
  HUB.setAlert(id, 'elsewhere', kind === 'elsewhere', 'ตัวละครนี้ถูกเปิดที่อื่น (แท็บ/เครื่องอื่น) · ไม่ต่อใหม่เองเพื่อไม่ให้แย่งกัน');
  HUB.setAlert(id, 'staff', kind === 'staff', 'ถูกตัดการเชื่อมต่อโดยทีมงานเกม · ไม่ต่อใหม่เอง');
  if (kind === 'cut') scheduleReload(id, 'เกมตัดการเชื่อมต่อ', 45000);
  // sign-in screen on an account that was signed in before = the sign-in expired
  const acc = HUB.account(id);
  if (snap && snap.ready && acc && !acc.signedIn) { acc.signedIn = true; HUB.store.save(); }
  HUB.setAlert(id, 'login', !!(scr.login && acc && acc.signedIn), 'ต้องล็อกอินใหม่ (การล็อกอินหมดอายุ) · เปิดหน้าเกมแล้วล็อกอิน');
  if (snap && snap.ready) {
    if (g.status === 'reconnecting') HUB.log.info(`acc ${id}: back in the game after reconnect`);
    for (const k of ['crash', 'reconnectLimit']) if (g.alerts.has(k) && g.status !== 'crashed') HUB.setAlert(id, k, false);
  }
}

// one line per online account every 30 minutes: where it is, what drives it, what it earns, how the page is (a log is read
// afterwards by someone who was not there: this is the picture of each account at that time)
function healthTick() {
  const now = Date.now();
  for (const [id, g] of HUB.games) {
    if (!g.inGame || g.demo || g.status !== 'online') continue;
    try {
      const st = g.data.stats; const r = g.data.rates(now);
      const f = HUB.farmSummary(id, st.level || 0, Math.floor(now / 60000) - 60).find((x) => x.map === HUB.mapOf(g));
      HUB.log.info(`acc ${id}: health ${st.job || '?'} Lv${st.level || '?'} on ${HUB.mapOf(g) || '?'} · driver ${HUB.driverOf(g) || 'farm'} · kills ${Math.round(r.killsPerHour || 0)}/h · net ${f ? f.netHr : '-'} G/h · deaths ${f && f.deathsHr != null ? f.deathsHr : '-'}/h · dps ${Math.round(r.dpsNow || 0)} · page ${g.memoryMB || '-'} MB · ping ${(g.data.net && g.data.net.ping) || '-'} ms · alerts [${[...g.alerts].join(',')}]`);
    } catch { /* a number missing: skip this account this time */ }
  }
}
// ---------- logging of state changes (status, game build / read health) ----------
function logChanges() {
  for (const [id, g] of HUB.games) {
    if (g.loggedStatus !== g.status) {
      if (g.loggedStatus !== undefined || g.status !== 'closed') HUB.log.info(`acc ${id}: status ${g.loggedStatus || '-'} -> ${g.status}`);
      g.loggedStatus = g.status;
    }
    if (!g.inGame || g.demo || (g.inGameAt && Date.now() - g.inGameAt < 60000)) continue; // the HUD is still drawing just after loading
    const h = g.adapter.health();
    const key = JSON.stringify([h.build, h.ok, h.problems]);
    if (g.loggedHealth !== key && (h.build || !h.ok)) {
      g.loggedHealth = key;
      if (h.ok) HUB.log.info(`acc ${id}: game build ${h.build || '?'}${h.knownBuild ? '' : ' (not tested yet)'}, data reads fine`);
      else if (!g.healthWarnAt || Date.now() - g.healthWarnAt > 30 * 60000) { g.healthWarnAt = Date.now(); HUB.log.warn(`acc ${id}: game build ${h.build || '?'} data problems: ${h.problems.join(' | ')}`); }
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
    HUB.notify(null, 'event', `🔥 อีเวนต์ ${ev.active.name} เริ่มแล้ว${ev.active.perks.length ? ` · ${ev.active.perks.join(' · ')}` : ''}${left > 0 ? ` · ${left >= 120 ? Math.round(left / 60) + ' ชม.' : left + ' นาที'}` : ''}`);
    HUB.log.info(`world event started: ${ev.key} ${ev.active.id}`);
  }
  HUB.pushState();
}
HUB.eventsView = function eventsView() {
  const now = Date.now(); const r5 = (ms) => Math.round(ms / 5000) * 5000; // 5 s steps: the state only changes when the display would
  return [...worldEvents.values()].flatMap((e) => [
    e.active && (!e.active.endsAt || e.active.endsAt > now) ? { name: e.active.name, perks: e.active.perks, endsInMs: e.active.endsAt ? r5(e.active.endsAt - now) : 0, live: true } : null,
    e.next && e.next.startsAt > now ? { name: e.next.name, perks: [], startsInMs: r5(e.next.startsAt - now), live: false } : null,
  ]).filter(Boolean);
};

// gear that may go on the market: not locked, not bound
require('./features/market-listings');

// ---------- every account at once (only what the player pressed) ----------
async function commandAll(cmd, arg) {
  const results = [];
  for (const [id, g] of HUB.openGames()) {
    if (!g.inGame || g.demo) continue;
    const name = g.data.stats.name || HUB.account(id).name;
    let r;
    if (cmd === 'autoOn' || cmd === 'autoOff') {
      const want = cmd === 'autoOn';
      r = (await HUB.liveUi(id)).auto === want ? { ok: true, skipped: true } : await HUB.gameCommand(id, 'auto', {});
    } else if (cmd === 'sleep') {
      r = (await HUB.liveUi(id)).sleeping ? { ok: true, skipped: true } : await HUB.gameCommand(id, 'sleep', {});
    } else if (cmd === 'sellEtc' && !(g.adapter.inv && [...g.adapter.inv].some(([k, q]) => /^drop_/.test(k) && q > 0))) {
      r = { ok: true, skipped: true, error: 'ไม่มีของดรอปให้ขาย' };
    } else if (['sellEtc', 'buy'].includes(cmd)) {
      r = await HUB.gameCommand(id, cmd, arg);
    } else if (cmd === 'salvageAll') {
      // unlocked gear of the chosen grades in this account's bag (the player confirmed the counts first)
      const opt = HUB.salvageOpts(arg);
      if (opt.byPrice) await HUB.priceGear(id, HUB.salvageable(g, arg.rarities));
      const ids = HUB.salvageable(g, arg.rarities, opt);
      r = ids.length ? await HUB.gameCommand(id, 'salvage', { itemIds: ids }) : { ok: true, skipped: true, error: 'ไม่มีอุปกรณ์ให้ย่อย' };
      if (r.ok && ids.length) r.count = ids.length;
    } else {
      r = { ok: false, error: 'ไม่รู้จักคำสั่ง' };
    }
    results.push({ id, name, ...r });
    // eslint-disable-next-line no-await-in-loop
    await HUB.sleep(300); // one after another, like a person clicking
  }
  HUB.log.info(`all accounts: ${cmd} -> ${results.map((r) => `${r.id}:${r.ok ? (r.skipped ? 'skip' : 'ok') : 'fail'}`).join(' ') || 'no account in game'}`);
  return results;
}

// Start BinderDash when Windows starts (with "open all accounts on start" = fully hands-off)
function applyStartWithWindows() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try { app.setLoginItemSettings({ openAtLogin: !!HUB.store.data.settings.startWithWindows }); } catch (err) { HUB.log.warn('login item:', err.message); }
}

require('./features/telegram-remote');

// ---------- bosses (the same for every account on the server) ----------
HUB.bosses = { field: new Map(), world: new Map(), sent: new Set(), queriedAt: 0 };

function onFieldBosses(list) {
  const now = Date.now();
  for (const b of list) {
    const key = `${b.mobType}@${b.map}`;
    const before = HUB.bosses.field.get(key);
    HUB.bosses.field.set(key, { ...b, seenAt: now });
    // up now, and it wasn't before (first sight doesn't count: no spam on start)
    if (before && before.until > now && !b.until && !b.closed) HUB.bossUp(b);
  }
  HUB.pushState();
}

require('./features/potions');

require('./features/respawn');

require('./features/market-watch');

require('./features/combat');

require('./features/farm');

require('./features/rewards');

require('./features/crowd');

require('./features/bounty');

require('./features/worldboss');
require('./features/calibration');
require('./features/spam');
require('./features/refine');

// ---------- problem report ----------
function makeReport() {
  const s = HUB.store.data.settings;
  const os = require('os');
  const lines = [
    `BinderDash ${app.getVersion()} · Electron ${process.versions.electron} · Chrome ${process.versions.chrome}`,
    `Windows/OS: ${os.type()} ${os.release()} ${os.arch()} · RAM ${Math.round(os.totalmem() / 1073741824)} GB · CPU ${os.cpus().length} cores`,
    `เวลา: ${new Date().toString()}`,
    `ทดสอบกับเกม build: ${KNOWN_BUILDS.join(', ')}`,
    `ชนิดข้อความใหม่จากเกม: ${[...new Set([...HUB.games.values()].flatMap((g) => [...g.adapter.newTypes.keys()]))].join(', ') || '-'}`,
    '',
    '== บัญชี ==',
    ...HUB.store.data.accounts.map((a) => {
      const g = HUB.rt(a.id);
      const h = g.inGame ? g.adapter.health() : null;
      return `#${a.id} status=${g.status} alerts=[${[...g.alerts].map((k) => k.replace(/:.*/, ':…')).join(',')}] mem=${g.memoryMB || '-'}MB`
        + (h ? ` build=${h.build || '?'} ok=${h.ok} frames=${h.frames}${h.problems.length ? ` problems=${h.problems.join(' | ')}` : ''}` : '');
    }),
    '',
    '== ตั้งค่า (ไม่มี KEY) ==',
    JSON.stringify({ ...s, telegram: { connected: !!(s.telegram.token && s.telegram.chatId) }, itemWatch: Object.keys(s.itemWatch || {}).length }),
    '',
    '== log ล่าสุด ==',
    HUB.log.tail(400),
  ];
  const file = HUB.path.join(HUB.log.dir(), `report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  HUB.fs.writeFileSync(file, lines.join('\n'));
  HUB.log.info('problem report written');
  shell.showItemInFolder(file);
  return file;
}

// ---------- demo mode ----------
function demoTick() {
  const on = HUB.store.data.settings.demo;
  HUB.store.data.accounts.forEach((a, i) => {
    const g = HUB.rt(a.id);
    const open = g.win && !g.win.isDestroyed();
    if (on && !open) {
      if (!g.demo) { g.demo = new DemoFeed(i); g.data.reset(); }
      handleEvents(a.id, g.demo.tick());
    } else if (g.demo) {
      g.demo = null;
      g.data.reset();
    }
  });
  HUB.pushState();
}

// Memory used by each game window (shown on the account list)
function updateMemory() {
  const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  for (const [, g] of HUB.openGames()) {
    const m = byPid.get(g.win.webContents.getOSProcessId());
    g.memoryMB = m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : null;
  }
}

// ---------- periodic checks ----------
function tick() {
  updateMemory();
  const s = HUB.store.data.settings;
  const now = Date.now();
  for (const [id, g] of [...HUB.openGames(), ...[...HUB.games].filter(([, x]) => x.demo)]) {
    // supplies about to run out at the current rate (potions, arrows ...)
    const low = new Set();
    // potions: what is on the game's hotbar (belt), counted over every quality grade
    HUB.readBelt(id, g);
    const potionIds = new Set(HUB.POTIONS.map((p) => p.id));
    const belt = (g.belt || []).filter((b) => potionIds.has(b));
    const watch = belt.length ? belt : [...new Set([...(g.adapter.inv ? g.adapter.inv.keys() : [])].map(HUB.baseOf).filter((b) => potionIds.has(b)))];
    // a fixed count, not a forecast: steady whatever the pace (every quality grade counted, like the hotbar)
    const below = Math.max(1, Number((s.autoBuy || {}).below) || 50);
    for (const pid of watch) {
      let qty = 0; if (g.adapter.inv) for (const [k, q] of g.adapter.inv) if (HUB.baseOf(k) === pid) qty += q || 0;
      const p = HUB.POTIONS.find((x) => x.id === pid);
      const key = 'potion:' + pid;
      if (qty <= below) {
        low.add(key);
        if (!g.alerts.has(key)) HUB.setAlert(id, key, true, `${p.name}${belt.includes(pid) ? ' (ช่องลัด)' : ''} เหลือ ${qty} ขวด (ตั้งไว้ซื้อเมื่อเหลือ ${below})`);
        if (belt.includes(pid)) HUB.autoBuyPotion(id, g, p); // buy only what the hotbar really uses
      }
    }
    for (const row of g.data.detail(now).bag) {
      if ((row.ids || []).some((x) => potionIds.has(HUB.baseOf(x.id)))) continue; // potions: done above
      const key = 'potion:' + row.name;
      if (row.minutesLeft != null && row.minutesLeft < s.potionMinutes) {
        low.add(key);
        if (!g.alerts.has(key)) HUB.setAlert(id, key, true, `${row.name} จะหมดในอีก ~${Math.max(1, Math.round(row.minutesLeft))} นาที (เหลือ ${row.qty})`);
        HUB.autoBuyPotion(id, g, row);
      } else if (g.alerts.has(key)) HUB.setAlert(id, key, false);
    }
    // an alert for a supply that is no longer in the bag (or renamed) must not stay forever
    for (const key of [...g.alerts]) if (key.startsWith('potion:') && !low.has(key)) HUB.setAlert(id, key, false);
    // Premium running out
    const until = g.data.premiumUntil;
    const left = until ? until - now : 0;
    if (left > 0 && left < 30 * 60 * 1000) { if (!g.alerts.has('premium')) HUB.setAlert(id, 'premium', true, `Premium จะหมดในอีก ${Math.ceil(left / 60000)} นาที`); }
    else if (g.alerts.has('premium')) HUB.setAlert(id, 'premium', false);
  }
  for (const [id, g] of HUB.openGames()) {
    if (g.status === 'maintenance') {
      // retry every 2 minutes so the account comes back by itself after maintenance
      if (now - g.loadedAt > 2 * 60 * 1000) g.win.webContents.reload();
      continue;
    }
    if (g.status === 'crashed') continue;
    const graceOver = g.loadedAt && now - g.loadedAt > 30 * 1000;
    if (graceOver && g.closedSince && now - g.closedSince > s.disconnectSeconds * 1000) {
      g.status = 'disconnected';
      HUB.setAlert(id, 'disconnect', true, `หลุดจากเซิร์ฟเวอร์เกิน ${s.disconnectSeconds} วินาที`);
    }
    // Auto Play probably stopped: no hits for N minutes (only while connected and alive).
    // Until hits can be read from the game, fall back to "no data at all".
    const lastActivity = g.lastHitAt || g.lastMsgAt;
    if (g.status === 'online' && !g.alerts.has('death') && lastActivity && now - lastActivity > s.idleMinutes * 60 * 1000) {
      HUB.setAlert(id, 'idle', true, g.lastHitAt ? `ไม่ได้ตีเลย ${s.idleMinutes} นาที · Auto Play น่าจะหยุด` : `ไม่มีข้อมูลจากเกม ${s.idleMinutes} นาที · AUTO อาจหยุด`);
    }
    // Give back RAM: a game page grows ~600-700 MB an hour and stutters, then stops, near 5 GB (a 10-hour log).
    // Reload it past the limit (at most every 30 min, one account at a time), not while it travels, is at a boss
    // or lies dead; small warnings (potions, bag weight) do not hold it back. AUTO is switched back on after.
    const minorOnly = [...g.alerts].every((k) => /^(potion|item|weight|weightFull|idle)/.test(k));
    const dr = HUB.driverOf(g);
    const busy = (dr && dr !== 'bounty' && dr !== 'finder') || (g.bounty && g.bounty.on && g.bounty.phase === 'travel') || (g.finder && g.finder.on && g.finder.phase !== 'measure') || g.data.stats.dead;
    const otherReloading = [...HUB.games.values()].some((o) => o !== g && o.ramReloadAt && now - o.ramReloadAt < 90 * 1000);
    if (s.autoRam && g.memoryMB > s.ramLimitMB && g.status === 'online' && minorOnly && !busy && !otherReloading
        // as seldom as it can be: a fresh renderer takes ~30-40 s out of the farming. Once past the limit it waits 2 hours since the
        // last one; far past the limit (+1500 MB: the page then freezes for seconds) it does not wait
        && (!g.ramReloadAt || now - g.ramReloadAt > 2 * 3600 * 1000 || g.memoryMB > s.ramLimitMB + 1500)) {
      g.ramReloadAt = now;
      const mb = g.memoryMB;
      HUB.log.info(`acc ${id}: game page uses ${mb} MB (limit ${s.ramLimitMB}) -> reload to give the memory back`);
      g.data.log('other', `หน้าเกมใช้ RAM ${mb} MB เกิน ${s.ramLimitMB} MB · โหลดใหม่เพื่อคืน RAM`);
      HUB.liveUi(id).then((ui) => {
        g.autoBeforeReload = !!ui.auto;
        // a reload keeps the same renderer process and its memory (measured: 470 MB stayed 470 MB, and the log of a day showed
        // 2500 MB after every "reload"); a new renderer process is what gives it back (470 MB -> 88 MB)
        g.ramKill = Date.now();
        try { g.win.webContents.forcefullyCrashRenderer(); } catch { /* old Electron: reload below */ }
        setTimeout(() => { try { g.win.webContents.reload(); } catch { /* closed */ } }, 800);
        // safety: the page must talk to the game again within 90 s, else the normal reconnect takes over (status stays
        // "online" through a restart on purpose, so nothing else would notice a page that stayed blank)
        setTimeout(() => { if (!g.lastMsgAt || Date.now() - g.lastMsgAt > 60000) scheduleReload(id, 'หน้าเกมไม่กลับมาหลังคืน RAM', 1000); }, 90000);
        // back in the game: AUTO on again if it was on (the character is where it was: the server kept it there)
        // AUTO back on as soon as the game is up again: look every 4 s from 8 s on, 2 minutes at most
        setTimeout(() => { try { updateMemory(); HUB.log.info(`acc ${id}: page memory after the restart: ${mb} -> ${g.memoryMB || '?'} MB`); } catch { /* closed */ } }, 20000);
        for (let t = 8000; t <= 120000; t += 4000) {
          setTimeout(async () => { try { if (g.autoBeforeReload && g.inGame && !(await HUB.liveUi(id)).auto) { g.autoBeforeReload = false; await HUB.gameCommand(id, 'auto', {}); HUB.log.info(`acc ${id}: after the RAM reload: AUTO on again`); } } catch { /* page still loading: the next look */ } }, t);
        }
      }).catch(() => g.win.webContents.reload());
    }
  }
  HUB.pushState();
}

// ---------- dashboard ----------
function createDashboard() {
  if (HUB.dashboard && !HUB.dashboard.isDestroyed()) { HUB.dashboard.show(); HUB.dashboard.focus(); return; }
  HUB.dashboard = new BrowserWindow({
    icon: APP_ICON,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BinderDash',
    autoHideMenuBar: true,
    backgroundColor: '#14121f',
    webPreferences: {
      preload: HUB.path.join(__dirname, 'preload-dashboard.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  HUB.dashboard.loadFile(HUB.path.join(__dirname, 'dashboard', 'index.html'));
  HUB.dashboard.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') {
      toggleDashboard(); e.preventDefault();
    }
  });
  HUB.dashboard.on('closed', () => { HUB.dashboard = null; });
}
function toggleDashboard() {
  if (HUB.dashboard && !HUB.dashboard.isDestroyed() && HUB.dashboard.isVisible() && HUB.dashboard.isFocused()) HUB.dashboard.close();
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
    webPreferences: { preload: HUB.path.join(__dirname, 'preload-dashboard.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(HUB.path.join(__dirname, 'dashboard', 'settings.html'), { hash: tab || '' });
  settingsWin.on('page-title-updated', (e) => e.preventDefault());
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------- tray ----------
function updateTray() {
  if (!tray) return;
  const anyAlert = [...HUB.games.values()].some((g) => g.alerts.size > 0);
  tray.setImage(trayImg(anyAlert ? icons.alert : icons.normal));
  const open = HUB.openGames().length;
  tray.setToolTip(`BinderDash · เปิดอยู่ ${open} บัญชี${anyAlert ? ' · มีเรื่องต้องดู' : ''}`);
}
function toggleAllGames() {
  const open = HUB.openGames();
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
HUB.labCall = function labCall(expr) {
  if (!labWin || labWin.isDestroyed()) {
    labWin = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:lab', contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    labWin.on('closed', () => { labWin = null; labReady = null; });
    // any small page on the game's site will do: the lab imports the game's own module from there
    labReady = labWin.loadURL(new URL(gameUrl).origin + '/robots.txt').catch(() => {}).then(() => labWin.webContents.executeJavaScript(LAB_JS));
  }
  return labReady.then(() => labWin.webContents.executeJavaScript(expr, true))
    .catch((e) => { HUB.log.warn('build lab: ' + (e && e.message)); throw new Error('Build Lab: ' + String((e && e.message) || e).replace(/^.*Error: /, '')); });
};
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
    if (!HUB.account(id)) return null;
    watchedId = id;
    const g = HUB.rt(id);
    return { ...g.data.detail(), pending: g.pending.map((p) => ({ ...p, left: Math.max(0, p.at + HUB.LISTING_DELAY_MS - Date.now()) })) };
  });
  handle('open', (id) => {
    const nonPremiumWarning = HUB.openGames().length === 3;
    openGame(id);
    return { warnFreeLimit: nonPremiumWarning };
  });
  handle('show', (id) => showGame(id));
  handle('reload', (id) => { const g = HUB.rt(id); if (g.win && !g.win.isDestroyed()) g.win.webContents.reload(); });
  handle('toggle-all', () => toggleAllGames());
  // the Dashboard's sleep view: hide the game windows that are showing (they keep playing; a hidden window
  // draws nothing, so the PC runs cooler and the other games smoother), show them again on the way out
  handle('sleep-mode', (on) => {
    sleepMode = !!on;
    if (sleepMode) {
      sleepShown = [];
      for (const [id, g] of HUB.openGames()) if (g.win && !g.win.isDestroyed() && g.win.isVisible()) { sleepShown.push(id); g.win.hide(); }
      HUB.log.info(`sleep view on: ${sleepShown.length} game window(s) hidden`);
    } else {
      for (const id of sleepShown) { const g = HUB.games.get(id); if (g && g.win && !g.win.isDestroyed()) g.win.showInactive(); }
      HUB.log.info(`sleep view off: ${sleepShown.length} game window(s) shown again`);
      sleepShown = [];
    }
    HUB.pushState();
    return { ok: true };
  });
  handle('hide', (id) => hideGame(id));
  handle('close', (id) => closeGame(id));
  handle('add', () => {
    if (HUB.store.data.accounts.length >= MAX_ACCOUNTS) return false;
    const id = HUB.store.data.nextId++;
    HUB.store.data.accounts.push({ id, name: `บัญชี ${id}` });
    HUB.store.save();
    HUB.pushState();
    return id;
  });
  handle('account-premium', (id, mode) => {
    const a = HUB.account(id); if (!a) return null;
    a.premium = mode === 'yes' || mode === 'no' ? mode : 'auto'; HUB.store.save();
    HUB.log.info(`acc ${id}: Premium set to ${a.premium} (now ${HUB.isPremium(id, HUB.games.get(id)) ? 'Premium' : 'no Premium'})`);
    HUB.pushState(); return a.premium;
  });
  handle('rename', (id, name) => {
    const a = HUB.account(id);
    if (!a || typeof name !== 'string') return;
    a.name = name.trim().slice(0, 40) || a.name;
    HUB.store.save();
    const g = HUB.rt(id);
    if (g.win && !g.win.isDestroyed()) g.win.setTitle(windowTitle(id));
    HUB.pushState();
  });
  handle('remove', async (id) => {
    closeGame(id);
    HUB.store.data.accounts = HUB.store.data.accounts.filter((a) => a.id !== id);
    HUB.store.save();
    HUB.games.delete(id);
    // forget this account's login
    await session.fromPartition(`persist:acc-${id}`).clearStorageData().catch(() => {});
    HUB.pushState();
  });
  handle('settings', (patch) => {
    const s = HUB.store.data.settings;
    if (patch.reconnectMinutes !== undefined) s.reconnectMinutes = Math.min(60, Math.max(1, Number(patch.reconnectMinutes) || 3));
    if (patch.startWithWindows !== undefined) { s.startWithWindows = !!patch.startWithWindows; applyStartWithWindows(); }
    for (const k of ['gpuBoost', 'lowFpsHidden', 'openDashboardOnStart', 'openAllOnStart', 'autoRam', 'openHidden', 'telegramRemote', 'autoReconnect', 'statsLog', 'deathLoopGuard', 'worldBossAuto', 'worldBossReturn', 'bountyAutoClaim', 'bountyOnlyTarget', 'crowdSwitch', 'stuckFix']) if (patch[k] !== undefined) s[k] = !!patch[k];
    if (patch.lowFpsHidden !== undefined) for (const [, gg] of HUB.games) { gg.pageHidden = undefined; HUB.syncVisibility(gg); } // applies at once
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
    HUB.store.save();
    HUB.syncRemote();
    HUB.pushState();
  });
  handle('telegram-connect', async (token) => {
    token = String(token || '').trim();
    if (!/^\d+:[\w-]{30,}$/.test(token)) return { ok: false, error: 'KEY ไม่ถูกรูปแบบ' };
    try {
      const chatId = await HUB.telegram.findChatId(token);
      if (!chatId) return { ok: false, error: 'ยังไม่เจอแชท · เปิดแชทกับบอทใน Telegram แล้วกด START ก่อน แล้วกดเชื่อมต่ออีกครั้ง' };
      HUB.store.data.settings.telegram = { token, chatId };
      HUB.store.save();
      HUB.syncRemote();
      await HUB.telegram.send(token, chatId, 'BinderDash เชื่อมต่อแล้ว 👋');
      HUB.pushState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  handle('telegram-disconnect', () => {
    HUB.store.data.settings.telegram = { token: '', chatId: '' };
    HUB.syncRemote();
    HUB.store.save();
    HUB.pushState();
  });
  handle('test-notify', () => {
    const first = HUB.store.data.accounts[0];
    const s = HUB.store.data.settings;
    if (Notification.isSupported()) new Notification({ title: 'BinderDash', body: 'ทดสอบการแจ้งเตือน', silent: !s.notify.sound }).show();
    HUB.telegram.send(s.telegram.token, s.telegram.chatId, 'BinderDash: ทดสอบการแจ้งเตือน').catch(() => {});
    return !!first;
  });
  handle('game-cmd', (id, cmd, arg) => HUB.gameCommand(id, cmd, arg || {}));
  handle('game-cmd-all', (cmd, arg) => commandAll(cmd, arg || {}));
  handle('world-boss-go', (kind) => HUB.worldBossGo(String(kind || ''), 'ปุ่ม'));
  handle('bounty', (id, on) => HUB.bountyStart(id, on !== false));
  handle('spam-set', (id, cfg) => HUB.spamSet(id, cfg || {}));
  handle('refine-start', (id, o) => HUB.refineStart(id, o || {}));
  handle('refine-stop', (id) => HUB.refineStop(id));
  handle('refine-worn', (id) => { const g = HUB.games.get(id); return g && g.adapter ? Object.entries((g.adapter.loadout && g.adapter.loadout.equip) || {}).map(([slot, ref]) => ({ slot, id: ref, name: HUB.itemLabel ? HUB.itemLabel(ref) : HUB.baseOf(ref) })) : []; });
  handle('spam-slots', (id) => HUB.spamSlots(id));
  handle('claim-rewards', (id) => HUB.claimRewards(id));
  handle('farm-find', (id, on) => HUB.finderStart(id, !!on));
  handle('farm-go', (id, map) => HUB.farmGo(id, String(map || '')));
  handle('farm-maps', (id) => { const g = HUB.games.get(id); return { rows: HUB.farmSummary(id, (g && g.data.stats.level) || 0), level: (g && g.data.stats.level) || 0, here: g ? HUB.mapOf(g) : '', finder: g ? HUB.finderStatus(g) : null }; });
  handle('ab-start', (id, phase, minutes, label) => HUB.abStart(id, phase, minutes, label));
  handle('ab-get', (id) => { const g = HUB.games.get(id); return g ? HUB.abResult(g) : null; });
  handle('ab-stop', (id) => { const g = HUB.games.get(id); if (g && g.ab) g.ab.phase = null; return { ok: true }; });
  handle('claim-rewards-all', async () => { const r = []; for (const [id, g] of HUB.openGames()) if (g.inGame && !g.demo) r.push({ id, ...(await HUB.claimRewards(id)) }); return r; }); // eslint-disable-line no-await-in-loop
  handle('bounty-all', async (on) => { const r = []; for (const [id, g] of HUB.openGames()) if (g.inGame && !g.demo) r.push({ id, ...(await HUB.bountyStart(id, on !== false)) }); return r; }); // eslint-disable-line no-await-in-loop
  // how many unlocked gear pieces each account would salvage (shown before confirming)
  handle('lab-info', () => HUB.labCall('window.__bdLab.info()'));
  // real DPS: sum this character's own hits for N seconds (count from the first hit)
  handle('measure-start', (id, seconds) => {
    const g = HUB.games.get(id);
    if (!g || !g.inGame) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
    const sec = Math.max(10, Math.min(300, Number(seconds) || 60));
    g.measure = { sec, armed: Date.now(), until: Date.now() + (sec + 120) * 1000, first: 0, last: 0, hits: [] };
    return { ok: true };
  });
  handle('measure-get', (id) => {
    const g = HUB.games.get(id);
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
    const all = HUB.store.data.calib || {};
    const role = (HUB.MOB_ROLES[p.target || ''] || [])[0];
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
  handle('lab-run', (p) => HUB.labCall(`window.__bdLab.run(${JSON.stringify(withAdj(p))})`));
  handle('lab-predict', async (p) => {
    const r = await HUB.labCall(`window.__bdLab.predict(${JSON.stringify(withAdj(p))})`);
    const kind = /^(wraithroot_colossus|pearlheart_titan)$/.test((p && p.target) || '') ? 'world' : 'field';
    const c = calibFor(p);
    if (r && c && c.job === p.job) { const m = c.d || c.k; r.calib = { k: c.k, d: c.d || null, kind, n: c.n, runs: c.runs || 1, withCombos: Math.round((r.packDps || r.withCombos || r.dps) * m), dps: Math.round(r.dps * m) }; }
    return r;
  });
  handle('fight-times', () => HUB.fightTimes());
  handle('mw-list', () => ({ watch: HUB.mwList(), live: Object.fromEntries(HUB.marketLive), hist: HUB.mwHist(), every: HUB.store.data.settings.marketWatchMin || 2, online: !!HUB.openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo) }));
  handle('mw-search', (q) => HUB.mwSearch(q));
  // which accounts hold each watched item (same kind + grade), not locked or bound: those can be listed for sale
  handle('mw-holders', () => {
    const out = {};
    for (const w of HUB.mwList()) {
      const want = w.key || (w.base + (HUB.GRADE_SUFFIX[w.grade] != null && w.itemId.includes('|') ? '|' + w.grade : ''));
      const list = [];
      for (const [id, g] of HUB.openGames()) {
        if (!g.inGame || g.demo || !g.adapter.inv) continue;
        for (const [itemId, qty] of g.adapter.inv) {
          if (!qty || g.adapter.locks.has(itemId) || g.adapter.bound.has(itemId)) continue;
          const key = itemId.includes('#') ? `${HUB.baseOf(itemId)}|${HUB.rarityOf(itemId)}` : HUB.baseOf(itemId);
          if (key === want || (!itemId.includes('#') && HUB.baseOf(itemId) === w.base && !w.itemId.includes('|'))) list.push({ acc: id, name: g.data.stats.name || (HUB.account(id) || {}).name, itemId, qty });
        }
      }
      out[w.itemId] = list;
    }
    return out;
  });
  handle('mw-add', (o) => {
    const base = String(o.id || '').split(/[|#]/)[0]; if (!base) return { ok: false };
    const grade = HUB.GRADE_SUFFIX[o.grade] != null ? o.grade : 'normal';
    const itemId = base + (o.gear === false ? '' : HUB.GRADE_SUFFIX[grade]);
    const watch = HUB.mwList();
    if (watch.some((w) => w.itemId === itemId)) return { ok: false, error: 'ติดตามอยู่แล้ว' };
    if (watch.length >= 40) return { ok: false, error: 'ติดตามได้สูงสุด 40 รายการ' };
    watch.push({ itemId, base, grade, name: (o.name || base) + (grade !== 'normal' && o.gear !== false ? ` (${grade[0].toUpperCase() + grade.slice(1)})` : ''), key: '', at: 0, below: 0, above: 0 });
    HUB.store.save(); return { ok: true };
  });
  handle('mw-remove', (itemId) => { const w = HUB.mwList(); const i = w.findIndex((x) => x.itemId === itemId); if (i >= 0) { const k = w[i].key; w.splice(i, 1); if (k) { delete HUB.mwHist()[k]; HUB.marketLive.delete(k); } HUB.store.save(); } return true; });
  handle('mw-set', (itemId, patch) => { const w = HUB.mwList().find((x) => x.itemId === itemId); if (w) { if (patch.below !== undefined) { w.below = Math.max(0, Number(patch.below) || 0); w.belowSent = false; } if (patch.above !== undefined) { w.above = Math.max(0, Number(patch.above) || 0); w.aboveSent = false; } HUB.store.save(); } return true; });
  handle('mw-every', (min) => { HUB.store.data.settings.marketWatchMin = Math.max(1, Math.min(60, Number(min) || 2)); HUB.store.save(); return true; });
  handle('mw-now', (itemId) => { const w = HUB.mwList().find((x) => x.itemId === itemId); if (w) w.at = 0; HUB.mwLastAsk = 0; return true; });
  // check one item now (not watched): ask through an online account and wait for the answer
  handle('mw-check', async (o) => {
    const acc = HUB.openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
    if (!acc) return { ok: false, error: 'ต้องมีบัญชีที่ออนไลน์อยู่อย่างน้อย 1 บัญชี' };
    const base = String(o.id || '').split(/[|#]/)[0];
    const itemId = base + (o.gear === false ? '' : (HUB.GRADE_SUFFIX[o.grade] || ''));
    const g = acc[1]; const t0 = Date.now();
    await HUB.requestPrice(acc[0], itemId, true);
    for (let i = 0; i < 30; i++) { await HUB.sleep(150); const p = g.data.itemPrices.get(itemId); if (p && p.at >= t0 - 1000) return { ok: true, itemId, ...p }; } // eslint-disable-line no-await-in-loop
    return { ok: false, error: 'ตลาดไม่ตอบ' };
  });
  handle('lab-combos', () => HUB.labCall('window.__bdLab.combos()'));
  handle('lab-full', (p) => HUB.labCall(`window.__bdLab.full(${JSON.stringify(withAdj(p))})`));
  handle('lab-maps', (p) => HUB.labCall(`window.__bdLab.maps(${JSON.stringify(withAdj(p))})`));
  handle('lab-cards', (p) => HUB.labCall(`window.__bdLab.cards(${JSON.stringify(withAdj(p))})`));
  const labMe = async (id) => {
    const g = HUB.games.get(id);
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
      return { ...me, c2: c2info.path, c2info, loadout: g.adapter.loadout, ownedCards: Object.values(owned), name: (HUB.account(id) || {}).name };
    } catch { return null; }
  };
  handle('lab-me', labMe);
  HUB.labMeRef = labMe;
  handle('selftest', (id, opts) => HUB.selftest.runSelfTest(id, opts || {}));
  handle('stats-summary', (days) => HUB.selftest.statsSummary(days || 7));
  handle('log-bundle', async () => {
    for (const [id, g] of HUB.games) if (g.inGame && !g.demo) await HUB.selftest.combatFlush(id).catch(() => null); // eslint-disable-line no-await-in-loop
    let dir; try { dir = app.getPath('desktop'); HUB.fs.accessSync(dir, HUB.fs.constants.W_OK); } catch { dir = app.getPath('downloads'); try { HUB.fs.mkdirSync(dir, { recursive: true }); } catch { dir = HUB.log.dir(); } }
    try {
      const r = HUB.selftest.bundle(dir, { platform: process.platform, os: require('os').release(), electron: process.versions.electron });
      shell.showItemInFolder(r.file);
      return r;
    } catch (err) { HUB.log.warn('log bundle:', err.message); return { ok: false, error: err.message }; }
  });
  handle('open-selftest', () => { const d = HUB.path.join(HUB.log.dir(), 'selftest'); HUB.fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
  handle('salvage-preview', async (rarities, o) => {
    const opt = HUB.salvageOpts(o);
    const list = HUB.openGames().filter(([, g]) => g.inGame && !g.demo);
    if (opt.byPrice) await Promise.all(list.map(([id, g]) => HUB.priceGear(id, HUB.salvageable(g, rarities))));
    return list.map(([id, g]) => { const all = HUB.salvageable(g, rarities); const ok = opt.byPrice ? HUB.salvageable(g, rarities, opt) : all; return { id, name: g.data.stats.name || HUB.account(id).name, count: ok.length, kept: all.length - ok.length }; });
  });
  // one account: every unlocked gear piece with its market numbers and the verdict
  handle('salvage-verdicts', async (id, o) => {
    const g = HUB.games.get(id); if (!g || !g.inGame) return null;
    const opt = HUB.salvageOpts(o);
    const all = HUB.salvageable(g, ['normal', 'magic', 'rare', 'epic']);
    await HUB.priceGear(id, all);
    return { opt, items: all.map((x) => ({ id: x, ...HUB.salvageVerdict(g, x, opt) })) };
  });
  handle('potions', () => HUB.POTIONS);
  handle('item-watch', (name, limit) => {
    const w = HUB.store.data.settings.itemWatch;
    const n = Number(limit);
    if (limit === null || limit === '' || !(n > 0)) delete w[name];
    else w[name] = Math.floor(n);
    HUB.store.save();
    HUB.pushState();
  });
  handle('open-settings', (tab) => openSettings(tab));
  handle('update-check', () => updater.check(true));
  handle('update-now', () => { const u = updater.state(); if (u.status === 'ready') updater.install(); else if (u.status === 'available') updater.download(); else updater.check(true); });
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
    for (const a of HUB.store.data.accounts) {
      await session.fromPartition(`persist:acc-${a.id}`).clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb'] }).catch(() => {});
    }
    for (const [, g] of HUB.openGames()) g.win.webContents.reload();
  });
  handle('clear-cache', async () => {
    for (const a of HUB.store.data.accounts) await session.fromPartition(`persist:acc-${a.id}`).clearCache().catch(() => {});
    for (const [, g] of HUB.openGames()) g.win.webContents.reloadIgnoringCache();
  });
  handle('open-logs', () => shell.openPath(HUB.log.dir()));
  handle('make-report', () => makeReport());
  handle('open-captures', () => {
    const dir = HUB.path.join(app.getPath('userData'), 'captures');
    HUB.fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ---------- app lifecycle ----------
app.on('second-instance', () => createDashboard());
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; try { HUB.farmSaveTick(); } catch { /* closing */ } });

// Google refuses sign-in in browsers that announce Electron: every window (game pages and
// their sign-in popups) presents itself as plain Chrome
app.userAgentFallback = chromeUA(app.userAgentFallback);

// Log errors instead of showing Electron's crash dialog (which would freeze the app)
process.on('uncaughtException', (err) => HUB.log.error('uncaught', err));
process.on('unhandledRejection', (err) => HUB.log.error('unhandled rejection', err));

app.whenReady().then(() => {
  HUB.log.init(app.getPath('userData'));
  HUB.log.info(`BinderDash ${app.getVersion()} start · Electron ${process.versions.electron} · ${process.platform} ${require('os').release()}`);
  HUB.store = new Store(app.getPath('userData'));
  if (HUB.store.data.calib && Object.keys(HUB.store.data.calib).some((k) => !k.includes(':'))) { HUB.store.data.calib = {}; HUB.store.save(); } // 0.37 compared without crits: start over
  if (HUB.store.loadError) HUB.log.warn(`settings: ${HUB.store.loadError}${HUB.store.loadedFrom ? ' -> loaded the backup ' + HUB.path.basename(HUB.store.loadedFrom) : ' -> started with defaults'}`);
  gameUrl = HUB.store.data.settings.gameUrl || DEFAULT_GAME_URL;
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
  if (HUB.store.data.settings.openDashboardOnStart) createDashboard();
  // accounts open before an update come back by themselves; otherwise "open all on start"
  const reopen = HUB.store.data.reopenAfterUpdate;
  const toOpen = Array.isArray(reopen) ? reopen.filter((id) => HUB.account(id))
    : HUB.store.data.settings.openAllOnStart ? HUB.store.data.accounts.map((a) => a.id) : [];
  if (reopen) { delete HUB.store.data.reopenAfterUpdate; HUB.store.save(); }
  toOpen.forEach((id, i) => setTimeout(() => openGame(id, { hidden: !!reopen }), i * 2000)); // staggered: smoother start
  updater.init({
    onChange: () => HUB.pushState(),
    onAvailable: () => { createDashboard(); HUB.pushState(); }, // the dashboard shows its update card
    beforeInstall: () => {
      HUB.store.data.reopenAfterUpdate = HUB.openGames().map(([id]) => id);
      HUB.store.save();
      quitting = true;
    },
  });
  // ---------- everything that runs on a timer, in one place, most frequent first ----------
  // [what, function, every ms, first run after ms]. Each run is guarded: one failing never stops the others.
  const SCHEDULE = [
    ['read the game pages', pollSnapshots, 1000],
    ['market watch', HUB.marketWatchTick, 1000],
    ['skill spam', HUB.spamTick, 100],
    ['demo data', demoTick, 500],
    ['reconnect lost games', reconnectTick, 5000],
    ['boss fight timer', HUB.fightTick, 5000],
    ['alerts, idle, RAM', tick, 15000],
    ['boss clocks', HUB.bossTick, 15000],
    ['world boss watchdog', HUB.bossWatchdog, 15000],
    ['market listings', HUB.marketTick, 15000],
    ['respawn in place', HUB.autoRespawnTick, 15000],
    ['farm: ledger, stuck AUTO, way back, finder', HUB.farmTick, 15000],
    ['bounties', HUB.bountyTick, 20000],
    ['crowded channel', HUB.crowdTick, 20000],
    ['save the farm ledger', HUB.farmSaveTick, 5 * 60000],
    ['stats line', () => HUB.selftest.statsTick(), 10 * 60000],
    ['health line per account', healthTick, 30 * 60000, 5 * 60000],
    ['Build Lab calibration from history', HUB.calibFromHistory, 60 * 60000, 8000],
    ['Build Lab calibration from boss fights', HUB.calibFromBossFights, 60 * 60000, 90000],
  ];
  const failed = new Map();
  for (const [name, fn, every, first] of SCHEDULE) {
    let running = 0; // when 0: free; else when the last run started (an async run that is still going is not started again)
    const run = () => {
      if (running && Date.now() - running < 120000) return; // still busy: stacking runs on a slow page was what made things lag
      running = Date.now();
      try { const r = fn(); if (r && typeof r.then === 'function') r.then(() => { running = 0; }, (e) => { running = 0; report(e); }); else running = 0; } catch (e) { running = 0; report(e); }
      function report(e) { const n = (failed.get(name) || 0) + 1; failed.set(name, n); if (n <= 3 || n % 100 === 0) HUB.log.warn(`timer "${name}" failed (${n}x): ${e && e.message}`); }
    };
    if (first) setTimeout(run, first);
    setInterval(run, every);
  }
  applyStartWithWindows();
  HUB.syncRemote();
});
