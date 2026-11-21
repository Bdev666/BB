// Log file for troubleshooting: %APPDATA%/BinderDash/logs/binderdash.log
// Rotates at 2 MB (keeps one old file). Never logs chat text, tokens or passwords.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
let dir = null;
let file = null;
const recentOnce = new Map(); // key -> last time, for rate-limited lines

function init(userData) {
  dir = path.join(userData, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'binderdash.log');
}

function rotate() {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, file + '.1');
  } catch { /* no file yet */ }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function clean(v) {
  if (v instanceof Error) return `${v.message}\n${(v.stack || '').split('\n').slice(1, 6).join('\n')}`;
  if (typeof v === 'object') {
    try { return JSON.stringify(v, (k, x) => (/token|password|secret|chatId/i.test(k) ? '***' : x)); } catch { return String(v); }
  }
  return String(v);
}

function write(level, args) {
  const line = `${stamp()} [${level}] ${args.map(clean).join(' ')}\n`;
  if (level !== 'debug') (level === 'error' ? console.error : console.log)(line.trimEnd());
  if (!file) return;
  try { rotate(); fs.appendFileSync(file, line); } catch { /* disk full / read-only: keep going */ }
}

// Same message at most once per `everyMs` (frame decode errors and the like)
function once(key, everyMs, level, ...args) {
  const now = Date.now();
  if (now - (recentOnce.get(key) || 0) < everyMs) return;
  recentOnce.set(key, now);
  write(level, args);
}

function tail(lines = 300) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  if (!file) return '';
  const all = (read(file + '.1') + read(file)).split('\n');
  return all.slice(-lines - 1).join('\n');
}

module.exports = {
  init,
  dir: () => dir,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  once,
  tail,
};
