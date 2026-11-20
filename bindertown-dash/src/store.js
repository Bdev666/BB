// Simple JSON config stored in %APPDATA%/BinderDash/config.json
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  accounts: [{ id: 1, name: 'บัญชี 1' }],
  nextId: 2,
  settings: {
    idleMinutes: 5,          // no server data for this long -> warn
    disconnectSeconds: 60,   // socket closed this long -> warn
    notify: { disconnect: true, idle: true, crash: true, maintenance: true },
    telegram: { token: '', chatId: '' },
    debugCapture: false,     // save raw game messages to a local file (to map the game's data)
  },
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        ...this.data,
        ...saved,
        settings: {
          ...DEFAULTS.settings,
          ...saved.settings,
          notify: { ...DEFAULTS.settings.notify, ...(saved.settings || {}).notify },
          telegram: { ...DEFAULTS.settings.telegram, ...(saved.settings || {}).telegram },
        },
      };
    } catch { /* first run */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
