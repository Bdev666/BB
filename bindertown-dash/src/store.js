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
    openHidden: false,
    autoReconnect: true,     // reload the game page when it's cut off / stuck / crashed (see main.js)
    reconnectMinutes: 3,     // ... after being disconnected this long
    startWithWindows: false,       // open games without showing their window (lighter on the PC)
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
      fieldBoss: true, worldBoss: true, event: true, daily: true, marketWatch: true,
    },
    statsLog: true, // numbers every 10 minutes into logs/stats (stays on this PC)
    autoBuy: { on: false, below: 50, rounds: 3, keepSilver: 5000 }, // buy potions by themselves when about to run out (rounds x 99)
    autoRespawnHere: true,
    deathLoopGuard: true, // 4 deaths in 2 minutes = respawn in place off for 10 minutes    // tick the game's Auto Respawn (respawn in place, Premium) + press respawn for hidden dead characters
    marketWatchMin: 2,        // refresh each watched market item every N minutes
    salvageByPrice: true,     // salvage only gear the central market says is worth little
    salvageMaxPrice: 1000000, // ... under this many Gold (or no price at all)
    salvageKeepVol: 3,        // ... and never what sold this many times or more in the last 7 days
    highValueGold: 10000000, // the dashboard's "high-value gear" panel shows pieces worth at least this
    valuableMinGold: 1000000, // notify drops whose central-market value is at least this (Gold)
    potionMinutes: 30,
    bossLeadMinutes: 5,      // heads-up this many minutes before a boss spawns / starts       // warn when supplies run out within this many minutes
    weightFullPct: 90,       // warn when the bag is this full
    weightCriticalPct: 95,   // ... and again when it's (almost) full
    itemWatch: {},           // item name -> warn when count drops below this
    telegram: { token: '', chatId: '' },
    telegramRemote: false,   // accept commands from the owner's Telegram chat
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
      // 0.11: 'valuable drop' alerts start at 1,000,000 Gold (the old 100 / 300 were far too chatty)
      if (!this.data.settings.valuable1m) {
        if (this.data.settings.valuableMinGold < 1000000) this.data.settings.valuableMinGold = 1000000;
        this.data.settings.valuable1m = true;
      }
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
