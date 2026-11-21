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
const { BinderTownAdapter, SNAPSHOT_JS, encodeInput } = require('./game-adapter');
const { AccountData } = require('./session-data');
const { DemoFeed } = require('./demo');
const updater = require('./updater');

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
    demo: null,
    alerts: new Set(), // active problems, e.g. 'disconnect', 'idle'
    loadedAt: null,
  };
}
function rt(id) {
  if (!games.has(id)) games.set(id, blankRuntime());
  return games.get(id);
}
function account(id) { return store.data.accounts.find((a) => a.id === id); }

function publicState() {
  const now = Date.now();
  return {
    settings: { ...store.data.settings, telegram: { connected: !!(store.data.settings.telegram.token && store.data.settings.telegram.chatId) } },
    maxAccounts: MAX_ACCOUNTS,
    update: { ...updater.state(), current: app.getVersion() },
    accounts: store.data.accounts.map((a) => {
      const g = rt(a.id);
      return {
        id: a.id,
        name: a.name,
        status: g.demo ? 'demo' : g.status,
        hidden: !!(g.win && !g.win.isVisible()),
        summary: g.data.summary(now),
        memoryMB: g.memoryMB || null,
        lastMsgAgo: g.lastMsgAt ? Math.round((now - g.lastMsgAt) / 1000) : null,
        alerts: [...g.alerts],
      };
    }),
  };
}

const visible = (w) => !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized();
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    updateTray();
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
  const group = kind.startsWith('item:') ? 'itemLow' : kind.startsWith('potion:') ? 'potion' : kind;
  if (s.notify[group] === false) return;
  const g = rt(id);
  if (g.demo) return; // demo data never notifies
  // don't interrupt the account you're looking at right now
  if (g.win && !g.win.isDestroyed() && g.win.isVisible() && g.win.isFocused()) return;
  const a = account(id);
  const title = a ? (g.data.stats.name ? `${a.name} · ${g.data.stats.name}` : a.name) : 'BinderDash';
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: text, silent: !s.notify.sound, icon: nativeImage.createFromDataURL(icons.alert) });
    n.on('click', () => showGame(id));
    n.show();
  }
  telegram.send(s.telegram.token, s.telegram.chatId, `${title}: ${text}`).catch(() => {});
}

function setAlert(id, key, on, text) {
  const g = rt(id);
  if (on && !g.alerts.has(key)) {
    g.alerts.add(key);
    notify(id, key, text);
  } else if (!on) {
    g.alerts.delete(key);
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
    width: 1280,
    height: 800,
    show: false,
    title: windowTitle(id),
    icon: nativeImage.createFromDataURL(icons.normal),
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
    if (input.control && input.shift && input.key.toLowerCase() === 'd') { toggleDashboard(); e.preventDefault(); }
    else if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') { wc.reload(); e.preventDefault(); }
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
    g.status = 'crashed';
    setAlert(id, 'crash', true, `หน้าเกมหยุดทำงาน (${details.reason}) · กด Ctrl+R ในหน้าต่างเกมเพื่อโหลดใหม่`);
  });
  wc.on('unresponsive', () => setAlert(id, 'crash', true, 'หน้าเกมค้าง ไม่ตอบสนอง'));
  wc.on('responsive', () => setAlert(id, 'crash', false));
  wc.on('did-start-loading', () => { g.sockets.clear(); g.loadedAt = Date.now(); });

  attachWatcher(id, wc);
  win.loadURL(gameUrl);
  pushState();
}

// Watch the game's WebSocket traffic through the DevTools protocol (read-only).
function attachWatcher(id, wc) {
  const g = rt(id);
  const dbg = wc.debugger;
  try { dbg.attach('1.3'); } catch (err) { console.warn('debugger attach failed', err); return; }
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
  dbg.on('detach', (_e, reason) => console.warn(`debugger detached for ${id}: ${reason}`));
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
    console.warn('frame decode failed', err);
  }
  pushState();
}

// Read the game's own state (window.__game) once a second: character, mobs, minimap. Read-only.
let watchedId = null; // account the dashboard is showing (gets the minimap)
async function pollSnapshots() {
  const looking = visible(dashboard);
  const now = Date.now();
  for (const [id, g] of openGames()) {
    if (g.snapshotBusy || g.status === 'maintenance' || g.status === 'crashed') continue;
    // dashboard closed: every 3 s is plenty for alerts
    if (!looking && g.lastSnapAt && now - g.lastSnapAt < 3000) continue;
    g.lastSnapAt = now;
    g.snapshotBusy = true;
    try {
      const wantMini = looking && id === watchedId;
      const snap = await g.win.webContents.executeJavaScript(`window.__bdWantMini=${wantMini};` + SNAPSHOT_JS, true);
      if (!g.win || g.win.isDestroyed()) continue;
      const prevName = g.data.stats.name;
      handleEvents(id, g.adapter.snapshot(snap));
      if (snap && snap.ready) g.inGame = true;
      else if (g.status === 'loading' && Date.now() - g.loadedAt > 5000) { g.status = 'lobby'; pushState(); }
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
    switch (ev.type) {
      case 'hit':
      case 'kill':
        g.lastHitAt = Date.now();
        if (g.alerts.has('idle')) setAlert(id, 'idle', false);
        break;
      case 'self':
        if (typeof ev.weightPct === 'number') {
          if (ev.weightPct >= s.weightFullPct && !g.alerts.has('weight')) setAlert(id, 'weight', true, `กระเป๋าหนัก ${Math.round(ev.weightPct)}% · ใกล้เต็ม เก็บของไม่ได้`);
          else if (ev.weightPct < s.weightFullPct - 5 && g.alerts.has('weight')) setAlert(id, 'weight', false);
        }
        if (ev.dead && !g.alerts.has('death')) setAlert(id, 'death', true, 'ตัวละครตาย');
        else if (ev.dead === false && g.alerts.has('death')) setAlert(id, 'death', false);
        break;
      case 'death': setAlert(id, 'death', true, ev.by ? `ตัวละครตาย · โดย ${ev.by}` : 'ตัวละครตาย'); break;
      case 'revive': setAlert(id, 'death', false); break;
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
        if (ev.worthChecking && ev.id) { g.valuableWait.set(ev.item, { qty: ev.qty, at: Date.now() }); requestPrice(id, ev.id); }
        break;
      case 'market': {
        // prices are the same for every account on the server
        for (const [, other] of games) if (other !== g) other.data.ingest(ev);
        const wait = g.valuableWait.get(ev.item);
        if (wait) {
          g.valuableWait.delete(ev.item);
          if (ev.price && ev.price * wait.qty >= s.valuableMinGold) {
            notify(id, 'valuable', `💰 ดรอป ${ev.item}${wait.qty > 1 ? ' x' + wait.qty : ''} · ราคาตลาด ~${Math.round(ev.price).toLocaleString('en-US')} G${wait.qty > 1 ? '/ชิ้น' : ''}`);
          }
        }
        break;
      }
      case 'info':
        if (/^เลเวลอัป/.test(ev.text)) notify(id, 'levelUp', `🎉 ${ev.text}`);
        g.lastNotice = { text: ev.text, at: Date.now() };
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
  return sendInput(id, { type: 'marketGuide', itemId });
}

async function gameCommand(id, cmd, arg) {
  const r = await runCommand(id, cmd, arg);
  if (!r.ok || !['sell', 'sellEtc', 'chat'].includes(cmd)) return r;
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
    case 'auto': ok = await click('#autobig'); break;
    case 'sleep': ok = await click('#autoeco'); break;
    case 'respawn': ok = await click('#deathoverlay button'); break;
    case 'sell': {
      const qty = Math.max(1, Math.floor(Number(arg.qty) || 0));
      if (!/^[\w~#.:+^|-]+$/.test(arg.itemId || '')) return { ok: false, error: 'ไอเทมไม่ถูกต้อง' };
      ok = await js(`(window.__game && window.__game.sell) ? (window.__game.sell(${JSON.stringify(arg.itemId)}, ${qty}), true) : false`);
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
  return ok ? { ok: true } : { ok: false, error: 'เกมยังไม่พร้อม ลองใหม่อีกครั้ง' };
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
    for (const row of g.data.detail(now).bag) {
      const key = 'potion:' + row.name;
      if (row.minutesLeft != null && row.minutesLeft < s.potionMinutes) {
        if (!g.alerts.has(key)) setAlert(id, key, true, `${row.name} จะหมดในอีก ~${Math.max(1, Math.round(row.minutesLeft))} นาที (เหลือ ${row.qty})`);
      } else if (g.alerts.has(key)) setAlert(id, key, false);
    }
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
    // Give back RAM: reload a page that grew past the limit (at most every 30 min, not while something's wrong)
    if (s.autoRam && g.memoryMB > s.ramLimitMB && g.status === 'online' && g.alerts.size === 0
        && (!g.ramReloadAt || now - g.ramReloadAt > 30 * 60 * 1000)) {
      g.ramReloadAt = now;
      g.data.log('other', `หน้าเกมใช้ RAM ${g.memoryMB} MB เกิน ${s.ramLimitMB} MB · โหลดใหม่เพื่อคืน RAM`);
      g.win.webContents.reload();
    }
  }
  pushState();
}

// ---------- dashboard ----------
function createDashboard() {
  if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.focus(); return; }
  dashboard = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'BinderDash',
    icon: nativeImage.createFromDataURL(icons.normal),
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
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'd') {
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
    width: 860,
    height: 680,
    minWidth: 640,
    minHeight: 480,
    title: 'ตั้งค่า — BinderDash',
    icon: nativeImage.createFromDataURL(icons.normal),
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
  tray.setImage(nativeImage.createFromDataURL(anyAlert ? icons.alert : icons.normal));
  const open = openGames().length;
  tray.setToolTip(`BinderDash · เปิดอยู่ ${open} บัญชี${anyAlert ? ' · มีเรื่องต้องดู' : ''}`);
}
function toggleAllGames() {
  const open = openGames();
  const anyVisible = open.some(([, g]) => g.win.isVisible());
  for (const [id] of open) anyVisible ? hideGame(id) : showGame(id);
}
function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(icons.normal));
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
function handle(cmd, fn) { ipcMain.handle('dash:' + cmd, (_e, ...args) => fn(...args)); }

function registerIpc() {
  handle('state', () => publicState());
  handle('detail', (id) => {
    if (!account(id)) return null;
    watchedId = id;
    const g = rt(id);
    return g.data.detail();
  });
  handle('open', (id) => {
    const nonPremiumWarning = openGames().length === 3;
    openGame(id);
    return { warnFreeLimit: nonPremiumWarning };
  });
  handle('show', (id) => showGame(id));
  handle('reload', (id) => { const g = rt(id); if (g.win && !g.win.isDestroyed()) g.win.webContents.reload(); });
  handle('toggle-all', () => toggleAllGames());
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
    for (const k of ['openDashboardOnStart', 'openAllOnStart', 'autoRam', 'openHidden']) if (patch[k] !== undefined) s[k] = !!patch[k];
    if (patch.valuableMinGold !== undefined) s.valuableMinGold = Math.max(0, Number(patch.valuableMinGold) || 0);
    if (patch.potionMinutes !== undefined) s.potionMinutes = Math.min(240, Math.max(1, Number(patch.potionMinutes) || 30));
    if (patch.weightFullPct !== undefined) s.weightFullPct = Math.min(100, Math.max(50, Number(patch.weightFullPct) || 90));
    if (patch.ramLimitMB !== undefined) s.ramLimitMB = Math.min(8000, Math.max(500, Number(patch.ramLimitMB) || 1500));
    if (patch.gameUrl !== undefined) {
      const u = String(patch.gameUrl).trim();
      s.gameUrl = /^https:\/\/[^\s]+$/.test(u) && u !== DEFAULT_GAME_URL ? u : '';
    }
    if (patch.idleMinutes !== undefined) s.idleMinutes = Math.min(120, Math.max(1, Number(patch.idleMinutes) || 5));
    if (patch.disconnectSeconds !== undefined) s.disconnectSeconds = Math.min(600, Math.max(15, Number(patch.disconnectSeconds) || 60));
    if (patch.notify) for (const k of Object.keys(s.notify)) if (k in patch.notify) s.notify[k] = !!patch.notify[k];
    if (patch.debugCapture !== undefined) s.debugCapture = !!patch.debugCapture;
    if (patch.demo !== undefined) s.demo = !!patch.demo;
    store.save();
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
      await telegram.send(token, chatId, 'BinderDash เชื่อมต่อแล้ว 👋');
      pushState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });
  handle('telegram-disconnect', () => {
    store.data.settings.telegram = { token: '', chatId: '' };
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
  handle('open-captures', () => {
    const dir = path.join(app.getPath('userData'), 'captures');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });
}

// ---------- app lifecycle ----------
app.on('second-instance', () => createDashboard());
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; });

// Google refuses sign-in in browsers that announce Electron: every window (game pages and
// their sign-in popups) presents itself as plain Chrome
app.userAgentFallback = chromeUA(app.userAgentFallback);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  gameUrl = store.data.settings.gameUrl || DEFAULT_GAME_URL;
  registerIpc();
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
    beforeInstall: () => {
      store.data.reopenAfterUpdate = openGames().map(([id]) => id);
      store.save();
      quitting = true;
    },
  });
  setInterval(tick, 15 * 1000);
  setInterval(demoTick, 500);
  setInterval(pollSnapshots, 1000);
});
