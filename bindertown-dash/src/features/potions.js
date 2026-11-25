const HUB = require('../core/hub');

// ---------- buy potions by themselves when they are about to run out ----------
// rounds x 99 (the shop sells 99 at a time), at most once every 10 minutes per potion; HUD buying is Premium
// the game's hotbar (belt): base ids per slot, kept by the game page in its local storage
HUB.readBelt = function readBelt(id, g) {
  if (!g.win || g.win.isDestroyed() || (g.beltAt && Date.now() - g.beltAt < 60000)) return;
  g.beltAt = Date.now();
  g.win.webContents.executeJavaScript(`(() => { const out = []; for (const k of Object.keys(localStorage)) if (/\\.pref\\.belt$/.test(k)) { try { for (const x of JSON.parse(localStorage.getItem(k)) || []) if (x && !out.includes(x)) out.push(String(x)); } catch {} } return out; })()`, true)
    .then((b) => { const list = (b || []).map((x) => HUB.baseOf(x)); if (String([...list].sort()) !== String([...(g.belt || [])].sort())) HUB.log.info(`acc ${id}: hotbar ${list.join(', ') || '(empty)'}`); g.belt = list; })
    .catch(() => {});
};
HUB.autoBuyPotion = async function autoBuyPotion(id, g, p) {
  const ab = HUB.store.data.settings.autoBuy || {};
  if (!ab.on || g.demo || !g.inGame || !p) return;
  const pid = p.id;
  if (!HUB.isPremium(id, g)) { // the HUD shop is Premium only: without it the game refuses every try
    if (!g.autoBuyNoPrem) { g.autoBuyNoPrem = true; HUB.notify(id, 'potion', `🧪 ไม่มี Premium: ซื้อ${p.name}ผ่าน HUD ไม่ได้ (กฎของเกม) · ไปซื้อที่ร้าน NPC ในเมือง`); }
    return;
  }
  if (!pid) return; // a bag row with no shop id (cash scrolls, food, …): only NPC potions can be bought (a log: "auto-buy undefined")
  const row = { name: p.name };
  g.autoBuyAt = g.autoBuyAt || {};
  if (g.autoBuyAt[pid] && Date.now() - g.autoBuyAt[pid] < 10 * 60 * 1000) return;
  g.autoBuyAt[pid] = Date.now();
  const lv = Number(g.data.stats.level) || 0;
  if (p.lv && lv && lv < p.lv) {
    if (!g.autoBuyLvWarned) { g.autoBuyLvWarned = true; HUB.notify(id, 'potion', `🧪 ร้านยังไม่ขาย ${p.name} ที่ Lv ${lv} (ขายตั้งแต่ Lv ${p.lv}) · ยานี้ต้องคราฟต์หรือซื้อจากตลาด`); }
    return;
  }
  const qty = 99 * Math.max(1, Math.min(10, Number(ab.rounds) || 3));
  const r = await HUB.runCommand(id, 'buy', { itemId: pid, qty, keepSilver: Math.max(0, Number(ab.keepSilver ?? 5000)) });
  HUB.log.info(`acc ${id}: auto-buy ${pid} x${qty} -> ${r.ok ? 'got ' + r.bought : r.error}`);
  HUB.selftest.count(id, r.ok ? 'autoBuy' : 'autoBuyFail'); if (r.ok) HUB.selftest.count(id, 'autoBuyQty', r.bought);
  if (r.ok) { HUB.setAlert(id, 'potion:' + pid, false); HUB.notify(id, 'potion', `🧪 ซื้อ ${row.name} อัตโนมัติ ${r.bought} ขวด${r.note ? ' · ' + r.note : ''}`); }
  else if (!g.autoBuyFailAt || Date.now() - g.autoBuyFailAt > 60 * 60 * 1000) { g.autoBuyFailAt = Date.now(); HUB.notify(id, 'potion', `🧪 ซื้อ ${row.name} อัตโนมัติไม่สำเร็จ: ${r.error}`); } // at most once an hour
};
