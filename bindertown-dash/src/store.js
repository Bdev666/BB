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
    autoRam: false,          // restart a game page whose memory passes ramLimitMB: off (it costs farming time); pages are restarted only when frozen or cut off
    ramLimitMB: 2500,
    // notifications
    idleMinutes: 5,          // no hits (or no data) for this long -> warn
    disconnectSeconds: 60,   // socket closed this long -> warn
    notify: {
      disconnect: true, death: true, idle: true, whisper: true, party: true, itemLow: true,
      crash: true, maintenance: true, sound: true,
      card: true, valuable: true, rareDrop: true, potion: true, weight: true, premium: true, levelUp: false,
      fieldBoss: true, worldBoss: true, event: true, daily: true, marketWatch: true, deathRate: true,
    },
    statsLog: true, // numbers every 10 minutes into logs/stats (stays on this PC)
    autoBuy: { on: false, below: 50, rounds: 3, keepSilver: 5000 }, // buy potions by themselves when about to run out (rounds x 99)
    autoRespawnHere: false, // spends Gold in fields (5,000 G a death): new users switch it on themselves
    stuckFix: true, // AUTO on but no hit for 3 minutes: AUTO off and on again (free)
    farmTrialMinutes: 10, // "find the best farm": minutes on each map tried
    crowdSwitch: false, crowdPlayers: 3, crowdMinutes: 2, // crowded spot: quietest channel of the same map
    bountyOnlyTarget: true, // while on a bounty, AUTO hits only that monster (the game's own target switches)
    bountyAutoClaim: true, // claim finished daily bounties by themselves (free)
    worldBossAuto: false, // send every online account to the world boss when it starts
    worldBossReturn: true, // and take them back when it ends
    deathLoopGuard: false, // 4 deaths in 2 minutes = respawn in place off for 10 minutes    // tick the game's Auto Respawn (respawn in place, Premium) + press respawn for hidden dead characters
    marketWatchMin: 2,        // refresh each watched market item every N minutes
    salvageByPrice: true,     // salvage only gear the central market says is worth little
    salvageMaxPrice: 1000000, // ... under this many Gold (or no price at all)
    salvageKeepVol: 3,        // ... and never what sold this many times or more in the last 7 days
    highValueGold: 5000000, // the dashboard's "high-value gear" panel shows pieces worth at least this
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
    // the saved settings, or the backup kept by the last good save (a power cut mid-save must not lose the accounts)
    let saved = null;
    for (const f of [this.file, this.file + '.bak']) {
      let text = null; try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      try { saved = JSON.parse(text); this.loadedFrom = f; break; } catch {
        try { fs.copyFileSync(f, f + '.broken-' + Date.now()); } catch { /* keep going */ }
        this.loadError = (this.loadError ? this.loadError + '; ' : '') + path.basename(f) + ' อ่านไม่ได้';
      }
    }
    if (saved && typeof saved === 'object') try {
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
      this.data.settings.deathLoopGuard = false; // removed: always respawn at once
      // the player's choice (25 Nov): no restart for memory, only for a frozen or cut-off page (once, for everyone)
      if (!this.data.settings.ramOff) { this.data.settings.autoRam = false; this.data.settings.ramOff = true; }
      this.data.settings.ram25 = true; // (was: memory restart on for everyone; replaced by ramOff above)
      if (!this.data.settings.hv5m) { // the high-value panel starts at 5M now (the old default was 10M)
        if (this.data.settings.highValueGold === 10000000) this.data.settings.highValueGold = 5000000;
        this.data.settings.hv5m = true;
      }
      if (!this.data.settings.valuable1m) {
        if (this.data.settings.valuableMinGold < 1000000) this.data.settings.valuableMinGold = 1000000;
        this.data.settings.valuable1m = true;
      }
    } catch { /* keep defaults */ }
    if (!Array.isArray(this.data.accounts)) this.data.accounts = structuredClone(DEFAULTS.accounts);
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* first save */ }
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error('settings save failed:', err.message); } // disk full / no rights: keep running
  }
}

module.exports = { Store };
