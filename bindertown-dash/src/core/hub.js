// One shared object for what the main process and its feature modules use across files.
module.exports = {};

// one way to wait, for every feature
module.exports.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a script in a game page. A failure is normal while the page loads, so it returns null instead of throwing, but the
// reason is logged (once per script per 10 minutes): a page script that always fails used to fail in silence
// (the bounty's "AUTO only on" said nothing but "could not set" for a day because of a mistake in the script itself).
const said = new Map();
module.exports.pageRun = async (g, js, what = 'page script') => {
  try {
    if (!g || !g.win || g.win.isDestroyed()) return null;
    return await g.win.webContents.executeJavaScript(js, true);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/destroyed|navigat|reload|frame was disposed|context/i.test(msg)) {
      const key = what + '|' + msg.slice(0, 80);
      if (!said.has(key) || Date.now() - said.get(key) > 10 * 60000) { said.set(key, Date.now()); if (module.exports.log) module.exports.log.warn(`acc ${g.accId}: ${what} failed: ${msg.slice(0, 200)}`); }
    }
    return null;
  }
};
