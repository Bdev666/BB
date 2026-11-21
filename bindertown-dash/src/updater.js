// In-app updates from GitHub Releases (Bdev666/BB). Checks on start and every
// 30 minutes, asks before downloading, then installs and restarts by itself with
// the accounts that were open opened again.
const { app, dialog, BrowserWindow } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev without the module */ }

const state = { status: 'idle', version: null, notes: '', percent: 0, error: '', checkedAt: null };
let onChange = () => {};
let beforeInstall = () => {};
let busyAsking = false;

function set(patch) { Object.assign(state, patch); onChange({ ...state }); }

function notesText(info) {
  const n = info && info.releaseNotes;
  if (!n) return '';
  const text = Array.isArray(n) ? n.map((x) => x.note || '').join('\n') : String(n);
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

async function askToDownload() {
  if (busyAsking) return;
  busyAsking = true;
  const parent = BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.getTitle() === 'BinderDash');
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: ['อัปเดต', 'ภายหลัง'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'มีเวอร์ชันใหม่',
    message: `BinderDash ${state.version} พร้อมแล้ว (ตอนนี้ ${app.getVersion()})`,
    detail: `${state.notes ? state.notes + '\n\n' : ''}กด "อัปเดต" โปรแกรมจะดาวน์โหลด ปิด ติดตั้ง แล้วเปิดใหม่เอง (ราว 1 นาที) บัญชีที่เปิดอยู่จะเปิดให้ใหม่ ตัวละครออกจากเกมแป๊บหนึ่ง\nกด "ภายหลัง" แล้วกดปุ่มทองมุมขวาบนของ Dashboard ได้ตลอด`,
  });
  busyAsking = false;
  if (response === 0) download();
}

function download() {
  if (!autoUpdater || state.status === 'downloading' || state.status === 'ready') return;
  set({ status: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch((err) => set({ status: 'error', error: String(err.message || err) }));
}

function check(manual = false) {
  if (!autoUpdater) { set({ status: 'error', error: 'ตัวอัปเดตใช้ได้เฉพาะโปรแกรมที่ติดตั้งแล้ว' }); return; }
  if (!app.isPackaged) { set({ status: 'dev', checkedAt: Date.now() }); return; }
  if (state.status === 'downloading' || state.status === 'ready') return;
  set({ status: 'checking', error: '' });
  autoUpdater.checkForUpdates()
    .then((r) => { if (!r || !r.updateInfo) set({ status: 'latest', checkedAt: Date.now() }); })
    .catch((err) => set({ status: 'error', error: String(err.message || err), checkedAt: Date.now() }));
  state.manual = manual;
}

function init(opts) {
  onChange = opts.onChange || onChange;
  beforeInstall = opts.beforeInstall || beforeInstall;
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    set({ status: 'available', version: info.version, notes: notesText(info), checkedAt: Date.now() });
    askToDownload();
  });
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => {
    set({ status: 'ready', percent: 100 });
    beforeInstall();
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 800); // silent install, run after
  });
  autoUpdater.on('error', (err) => set({ status: 'error', error: String((err && err.message) || err), checkedAt: Date.now() }));
  setTimeout(() => check(false), 10 * 1000);
  setInterval(() => check(false), 30 * 60 * 1000);
}

module.exports = { init, check, download, ask: askToDownload, state: () => ({ ...state }) };
