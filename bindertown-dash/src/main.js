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
    notify(id, key, text);
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
    switch (ev.type) {
      case 'hit':
      case 'kill':
        g.lastHitAt = Date.now();
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
        // once a day per account, when there is something new to collect
        const w = g.data.rewardsWaiting();
        const day = new Date().toDateString();
        const [lastDay, lastCount] = (g.rewardsNotified || ':0').split(':');
        if (w.total > 0 && (lastDay !== day || w.total > Number(lastCount))) {
          g.rewardsNotified = `${day}:${w.total}`;
          notify(id, 'daily', `🎁 มีของรอรับ: ${[w.pass ? `ภารกิจ Pass ${w.pass}` : null, w.mail ? `จดหมาย ${w.mail} ฉบับ` : null].filter(Boolean).join(' · ')}`);
        }
        break;
      }
      case 'worldBoss': onWorldBoss(ev); break;
      case 'market': {
        // prices are the same for every account on the server
        for (const [, other] of games) if (other !== g) other.data.ingest(ev);
        const wait = g.valuableWait.get(ev.id);
        if (wait) {
          g.valuableWait.delete(ev.id);
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
  // the market board's item view (kind + grade): what the game's market window asks for
  return sendInput(id, { ...MARKET_FILTER, type: 'marketItem', itemId, loff: 0 });
}

async function gameCommand(id, cmd, arg) {
  const r = await runCommand(id, cmd, arg);
  if (!r.ok || !['sell', 'sellEtc', 'chat', 'buy', 'salvage'].includes(cmd)) return r;
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
      ok = await sendInput(id, { type: 'vendorBuy', itemId: p.id, qty });
      break;
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
    if (!g.inGame || g.demo) continue;
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
function salvageable(g, rarities) {
  const want = new Set(Array.isArray(rarities) && rarities.length ? rarities : ['normal', 'magic']);
  return g.adapter.inv ? [...g.adapter.inv.keys()].filter((x) => x.includes('#') && !g.adapter.locks.has(x) && want.has(rarityOf(x))) : [];
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
      const ids = salvageable(g, arg.rarities);
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

function onWorldBoss(v) {
  const before = bosses.world.get(v.kind);
  bosses.world.set(v.kind, { ...v, seenAt: Date.now() });
  if (before && before.state !== 'live' && v.state === 'live') {
    notify(null, 'worldBoss', `🌋 World Boss ${v.name} เริ่มแล้ว · เข้าร่วม ${v.fighters} คน`);
  }
  pushState();
}

function bossUp(b) {
  const key = `up:${b.mobType}@${b.map}:${b.until}`;
  if (bosses.sent.has(key)) return;
  bosses.sent.add(key);
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
    const soon = `soon:${b.mobType}@${b.map}:${b.until}`;
    if (left > 0 && left <= lead && !bosses.sent.has(soon)) {
      bosses.sent.add(soon);
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
  return { job: m.job, level: m.level, jobLevel: m.jobLevel, skillPoints: m.skillPoints, c2: m.c2 || '', c2r,
    stats: { str: m.str, agi: m.agi, vit: m.vit, int: m.int, dex: m.dex, luk: m.luk }, statPoints: m.statPoints,
    skills: o(m.skillLevels) || {}, evo: o(m.skillMods) || {}, traits: traits || {},
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
    for (const k of ['openDashboardOnStart', 'openAllOnStart', 'autoRam', 'openHidden', 'telegramRemote', 'autoReconnect']) if (patch[k] !== undefined) s[k] = !!patch[k];
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
  // how many unlocked gear pieces each account would salvage (shown before confirming)
  handle('lab-info', () => labCall('window.__bdLab.info()'));
  handle('lab-run', (p) => labCall(`window.__bdLab.run(${JSON.stringify(p)})`));
  handle('lab-combos', () => labCall('window.__bdLab.combos()'));
  handle('lab-full', (p) => labCall(`window.__bdLab.full(${JSON.stringify(p)})`));
  handle('lab-maps', (p) => labCall(`window.__bdLab.maps(${JSON.stringify(p)})`));
  handle('lab-cards', (p) => labCall(`window.__bdLab.cards(${JSON.stringify(p)})`));
  handle('lab-me', async (id) => {
    const g = games.get(id);
    if (!g || !g.win || g.win.isDestroyed() || !g.inGame) return null;
    try {
      const me = await g.win.webContents.executeJavaScript(ME_JS, true);
      if (!me) return null;
      // class 2: the game keeps it as a path name or a small JSON object (path, jobLevel, points)
      let c2 = me.c2; let c2obj = null;
      if (typeof c2 === 'string' && c2.trim().startsWith('{')) { try { c2obj = JSON.parse(c2); } catch { /* keep string */ } }
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
  });
  handle('salvage-preview', (rarities) => openGames().filter(([, g]) => g.inGame && !g.demo).map(([id, g]) => ({
    id, name: g.data.stats.name || account(id).name, count: salvageable(g, rarities).length,
  })));
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
app.on('before-quit', () => { quitting = true; });

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
  setInterval(bossTick, 15 * 1000);
  setInterval(reconnectTick, 5000);
  setInterval(marketTick, 15 * 1000);
  applyStartWithWindows();
  syncRemote();
});
