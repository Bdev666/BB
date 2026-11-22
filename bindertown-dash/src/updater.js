// In-app updates from GitHub Releases (Bdev666/BB). Checks on start and every
// 30 minutes, asks before downloading, then installs and restarts by itself with
// the accounts that were open opened again.
const { app } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev without the module */ }

const state = { status: 'idle', version: null, notes: '', percent: 0, error: '', checkedAt: null };
let onChange = () => {};
let beforeInstall = () => {};

const log = require('./logger');
function set(patch) {
  if (patch.status && patch.status !== state.status && patch.status !== 'downloading') {
    log.info(`update: ${patch.status}${patch.version ? ' ' + patch.version : ''}${patch.error ? ' ' + patch.error : ''}`);
  }
  Object.assign(state, patch);
  onChange({ ...state });
}

function notesText(info) {
  const n = info && info.releaseNotes;
  if (!n) return '';
  const text = Array.isArray(n) ? n.map((x) => x.note || '').join('\n') : String(n);
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 1200);
}

// a new version: the dashboard shows its own update card (version, what's new, progress)
let onAvailable = () => {};
function askToDownload() { onAvailable({ ...state }); }

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
  onAvailable = opts.onAvailable || onAvailable;
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
