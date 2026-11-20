// BinderDash: fan-made multi-account launcher + dashboard for Binder Town.
// Unofficial. Read-only: it watches the game, it never plays for you.
const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage,
  powerSaveBlocker, shell, dialog,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const telegram = require('./telegram');
const icons = require('./icons');
const { parseMessage } = require('./game-adapter');
const { AccountData } = require('./session-data');
const { DemoFeed } = require('./demo');

const GAME_URL = 'https://play.bindertowngame.com/';
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

let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('dash:state', publicState());
    updateTray();
  }, 250);
}

// ---------- notifications ----------
function notify(id, kind, text) {
  const s = store.data.settings;
  if (s.notify[kind] === false) return;
  const a = account(id);
  const title = a ? `${a.name}` : 'BinderDash';
  if (Notification.isSupported()) {
    const n = new Notification({ title, body: text, icon: nativeImage.createFromDataURL(icons.alert) });
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
  return n ? `${a.name} · ${n}` : a.name;
}

function isGameUrl(url) {
  try {
    const h = new URL(url).hostname;
    return GAME_HOSTS.some((g) => h === g || h.endsWith('.' + g));
  } catch { return false; }
}

function openGame(id) {
  const a = account(id);
  if (!a) return;
  const g = rt(id);
  if (g.win && !g.win.isDestroyed()) return showGame(id);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: a.name,
    icon: nativeImage.createFromDataURL(icons.normal),
    autoHideMenuBar: true,
    webPreferences: {
      partition: `persist:acc-${id}`, // separate login/cookies per account
      preload: path.join(__dirname, 'preload-game.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  g.win = win;
  g.status = 'loading';
  g.alerts.clear();
  g.loadedAt = Date.now();
  g.demo = null;
  g.data.reset();
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
  win.on('show', pushState);
  win.on('hide', pushState);

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
  win.loadURL(GAME_URL);
  pushState();
}

// Watch the game's WebSocket traffic through the DevTools protocol (read-only).
function attachWatcher(id, wc) {
  const g = rt(id);
  const dbg = wc.debugger;
  try { dbg.attach('1.3'); } catch (err) { console.warn('debugger attach failed', err); return; }
  dbg.sendCommand('Network.enable').catch(() => {});
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.webSocketCreated') {
      g.sockets.add(params.requestId);
      g.closedSince = null;
    } else if (method === 'Network.webSocketClosed') {
      g.sockets.delete(params.requestId);
      if (g.sockets.size === 0) g.closedSince = Date.now();
    } else if (method === 'Network.webSocketFrameReceived') {
      onFrame(id, params.response);
    }
  });
  dbg.on('detach', (_e, reason) => console.warn(`debugger detached for ${id}: ${reason}`));
}

function onFrame(id, frame) {
  const g = rt(id);
  g.lastMsgAt = Date.now();
  if (g.status !== 'online') { g.status = 'online'; }
  if (g.alerts.has('disconnect')) setAlert(id, 'disconnect', false);
  if (g.alerts.has('idle')) setAlert(id, 'idle', false);

  // opcode 1 = text frame; binary frames come base64-encoded
  const text = frame.opcode === 1 ? frame.payloadData : null;
  if (store.data.settings.debugCapture) capture(id, frame);
  if (!text) return pushState();

  const prevName = g.data.stats.name;
  for (const ev of parseMessage(text)) g.data.ingest(ev);
  if (g.data.stats.name !== prevName && g.win && !g.win.isDestroyed()) g.win.setTitle(windowTitle(id));
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

// ---------- demo mode ----------
function demoTick() {
  const on = store.data.settings.demo;
  store.data.accounts.forEach((a, i) => {
    const g = rt(a.id);
    const open = g.win && !g.win.isDestroyed();
    if (on && !open) {
      if (!g.demo) { g.demo = new DemoFeed(i); g.data.reset(); }
      for (const ev of g.demo.tick()) g.data.ingest(ev);
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
    if (g.status === 'online' && g.lastMsgAt && now - g.lastMsgAt > s.idleMinutes * 60 * 1000) {
      setAlert(id, 'idle', true, `ไม่มีข้อมูลจากเกม ${s.idleMinutes} นาที · AUTO อาจหยุด`);
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
    const { session } = require('electron');
    await session.fromPartition(`persist:acc-${id}`).clearStorageData().catch(() => {});
    pushState();
  });
  handle('settings', (patch) => {
    const s = store.data.settings;
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
    if (Notification.isSupported()) new Notification({ title: 'BinderDash', body: 'ทดสอบการแจ้งเตือน' }).show();
    telegram.send(s.telegram.token, s.telegram.chatId, 'BinderDash: ทดสอบการแจ้งเตือน').catch(() => {});
    return !!first;
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

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  registerIpc();
  createTray();
  createDashboard();
  setInterval(tick, 15 * 1000);
  setInterval(demoTick, 500);
});
