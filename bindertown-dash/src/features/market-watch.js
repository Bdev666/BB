const HUB = require('../core/hub');

// ---------- real-time market watch: items followed on the central market, refreshed in the background ----------
// One online account asks the market about one watched item every few seconds (like browsing the board).
// A watched item is "base id + grade": gear grade comes from how many affixes the asked id carries
// (the server counts them: 1-2 = Magic, 3 = Rare, 4 = Epic), stackables and cards are asked as they are.
HUB.GRADE_SUFFIX = { normal: '', magic: '|str:1:1', rare: '|str:1:1,agi:1:1,vit:1:1', epic: '|str:1:1,agi:1:1,vit:1:1,int:1:1' };
HUB.marketLive = new Map(); // key -> latest view
HUB.mwLastAsk = 0;
HUB.mwList = () => HUB.store.data.marketWatch || (HUB.store.data.marketWatch = []);
HUB.mwHist = () => HUB.store.data.marketHist || (HUB.store.data.marketHist = {});
HUB.marketWatchSeen = HUB.marketWatchSeen = function marketWatchSeen(ev) {
  const watch = HUB.mwList(); if (!watch.length) return;
  const hit = watch.filter((w) => w.key === ev.key || w.itemId === ev.id); if (!hit.length) return;
  const now = Date.now();
  for (const w of hit) {
    if (!w.key && ev.key) w.key = ev.key;
    const k = w.key || w.itemId;
    const prev = HUB.marketLive.get(k);
    const view = { low: ev.price != null && ev.basis === 'listed' ? ev.price : 0, last: ev.last || 0, stock: ev.stock || 0, vol7: ev.vol7 || 0, at: now, prevLow: prev ? prev.low : null, prevLast: prev ? prev.last : null };
    HUB.marketLive.set(k, view);
    w.at = now;
    const h = HUB.mwHist(); const list = h[k] || (h[k] = []);
    const lastPt = list[list.length - 1];
    if (!lastPt || now - lastPt[0] > 60000 || lastPt[1] !== view.low || lastPt[2] !== view.last) { list.push([now, view.low, view.last, view.stock, view.vol7]); if (list.length > 500) list.splice(0, list.length - 500); }
    // alerts: lowest listing at or under "below", or at or over "above" (once per crossing)
    const price = view.low || view.last;
    if (w.below && price && price <= w.below && !w.belowSent) { w.belowSent = true; HUB.notify(null, 'marketWatch', `📉 ${w.name}: ตลาดกลาง${view.low ? 'ถูกสุด' : 'ขายล่าสุด'} ${Math.round(price).toLocaleString('en-US')} G (≤ ${Math.round(w.below).toLocaleString('en-US')})`); }
    if (w.below && price > w.below) w.belowSent = false;
    if (w.above && price && price >= w.above && !w.aboveSent) { w.aboveSent = true; HUB.notify(null, 'marketWatch', `📈 ${w.name}: ตลาดกลาง ${Math.round(price).toLocaleString('en-US')} G (≥ ${Math.round(w.above).toLocaleString('en-US')})`); }
    if (w.above && price < w.above) w.aboveSent = false;
  }
  HUB.store.save();
  HUB.pushState();
};;
HUB.marketWatchTick = HUB.marketWatchTick = function marketWatchTick() {
  const watch = HUB.mwList(); if (!watch.length) return;
  const every = Math.max(1, Number(HUB.store.data.settings.marketWatchMin) || 2) * 60000;
  if (Date.now() - HUB.mwLastAsk < 3000) return;
  const acc = HUB.openGames().find(([, g]) => g.inGame && g.status === 'online' && !g.demo);
  if (!acc) return;
  const due = watch.filter((w) => !w.at || Date.now() - w.at >= every).sort((a, b) => (a.at || 0) - (b.at || 0))[0];
  if (!due) return;
  HUB.mwLastAsk = Date.now();
  if (!due.at) due.at = 0;
  due.askedAt = Date.now();
  HUB.requestPrice(acc[0], due.itemId, true);
};;
HUB.mwSearch = HUB.mwSearch = function mwSearch(q) {
  const N = require('../game-names');
  const t = String(q || '').trim().toLowerCase(); if (t.length < 2) return [];
  const out = [];
  for (const [id, name] of Object.entries(N.items)) {
    if (id.startsWith('cash') || id.startsWith('drop_')) continue;
    if (id.toLowerCase().includes(t) || String(name).toLowerCase().includes(t)) out.push({ id, name });
    if (out.length >= 30) break;
  }
  return out;
};;
