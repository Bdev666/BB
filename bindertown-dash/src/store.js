// Simple JSON config stored in %APPDATA%/BinderDash/config.json
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  accounts: [{ id: 1, name: 'บัญชี 1' }],
  nextId: 2,
  settings: {
    // general
    openDashboardOnStart: true,
    openAllOnStart: false,
    openHidden: false,       // open games without showing their window (lighter on the PC)
    gameUrl: '',             // empty = default server; takes effect after restart
    autoRam: false,          // reload a game page whose memory passes ramLimitMB
    ramLimitMB: 1500,
    // notifications
    idleMinutes: 5,          // no hits (or no data) for this long -> warn
    disconnectSeconds: 60,   // socket closed this long -> warn
    notify: {
      disconnect: true, death: true, idle: true, whisper: true, party: true, itemLow: true,
      crash: true, maintenance: true, sound: true,
      card: true, valuable: true, rareDrop: true, potion: true, weight: true, premium: true, levelUp: false,
      fieldBoss: true, worldBoss: true, event: true, daily: true,
    },
    valuableMinGold: 300,    // notify drops whose player-market value is at least this (Gold)
    potionMinutes: 30,
    bossLeadMinutes: 5,      // heads-up this many minutes before a boss spawns / starts       // warn when supplies run out within this many minutes
    weightFullPct: 90,       // warn when the bag is this full
    itemWatch: {},           // item name -> warn when count drops below this
    telegram: { token: '', chatId: '' },
    debugCapture: false,     // save raw game messages to a local file (to map the game's data)
    demo: false,             // fake data to preview the dashboard
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
          itemWatch: { ...(saved.settings || {}).itemWatch },
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
