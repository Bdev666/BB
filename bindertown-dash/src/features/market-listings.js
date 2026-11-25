const HUB = require('../core/hub');

// ---------- central-market listings that take a while to appear ----------
HUB.LISTING_DELAY_MS = 5 * 60 * 1000;
HUB.addPending = HUB.addPending = function addPending(g, itemId, qty, unit, confirmed) {
  g.pending = g.pending.filter((p) => p.itemId !== itemId);
  g.pending.push({ itemId, name: HUB.pretty(HUB.baseOf(itemId)), rarity: HUB.rarityOf(itemId), qty, unit, at: Date.now(), confirmed, state: 'waiting' });
};;
HUB.onMyListings = HUB.onMyListings = function onMyListings(id, list) {
  const g = HUB.rt(id);
  g.myListings = { list, at: Date.now() };
  for (const p of g.pending) {
    if (list.some((m) => m.itemId === p.itemId)) p.state = 'listed';
    else if (Date.now() - p.at > HUB.LISTING_DELAY_MS + 60 * 1000 && p.state === 'waiting') p.state = p.confirmed || !(g.adapter.inv && g.adapter.inv.get(p.itemId)) ? 'notSeen' : 'failed';
  }
};;
// once the market's delay is over, look at "my listings" for each account with listings waiting
let marketTickN = 0;
HUB.marketTick = HUB.marketTick = function marketTick() {
  marketTickN++;
  for (const [id, g] of HUB.games) {
    if (g.status !== 'online') continue;
    g.pending = g.pending.filter((p) => Date.now() - p.at < 60 * 60 * 1000 && !(p.state === 'listed' && Date.now() - p.at > 15 * 60 * 1000));
    const due = g.pending.some((p) => p.state === 'waiting' && Date.now() - p.at > HUB.LISTING_DELAY_MS);
    if (due && (!g.myListings || Date.now() - g.myListings.at > 50 * 1000)) HUB.sendInput(id, { ...HUB.MARKET_FILTER, type: 'marketQuery', sort: 'def', off: 0 });
    // price gear pieces the dashboard has no market price for yet (a few per minute, like browsing)
    if (marketTickN % 4 === 0) {
      const ip = g.data.itemPrices;
      const todo = HUB.tradableGear(g).filter((x) => !ip.has(x) || Date.now() - ip.get(x).at > 30 * 60 * 1000).slice(0, 3);
      todo.forEach((x, i) => setTimeout(() => HUB.requestPrice(id, x), i * 500));
    }
  }
};;

HUB.tradableGear = HUB.tradableGear = function tradableGear(g) {
  return g.adapter.inv ? [...g.adapter.inv.keys()].filter((x) => x.includes('#') && !g.adapter.locks.has(x) && !g.adapter.bound.has(x)) : [];
};;

// gear pieces that may be salvaged: unlocked, of the chosen grades (default Normal + Magic)
HUB.salvageable = HUB.salvageable = function salvageable(g, rarities, opt) {
  const want = new Set(Array.isArray(rarities) && rarities.length ? rarities : ['normal', 'magic']);
  const ids = g.adapter.inv ? [...g.adapter.inv.keys()].filter((x) => x.includes('#') && !g.adapter.locks.has(x) && want.has(HUB.rarityOf(x))) : [];
  return opt && opt.byPrice ? ids.filter((x) => HUB.salvageVerdict(g, x, opt).salvage) : ids;
};;
// salvage only what the central market says is worth little: no price, or under the limit, and not a steady seller
HUB.salvageOpts = HUB.salvageOpts = function salvageOpts(o) {
  const s = HUB.store.data.settings;
  return { byPrice: o && o.byPrice != null ? !!o.byPrice : s.salvageByPrice !== false, maxPrice: Number((o && o.maxPrice) ?? s.salvageMaxPrice ?? 1000000), keepVol: Number((o && o.keepVol) ?? s.salvageKeepVol ?? 3), unknownOk: o && o.unknownOk != null ? !!o.unknownOk : !!s.salvageUnknownOk };
};;
HUB.salvageVerdict = HUB.salvageVerdict = function salvageVerdict(g, id, opt) {
  if (g.adapter.bound.has(id)) return { salvage: true, why: 'ผูกตัว ขายในตลาดไม่ได้' };
  const p = g.data.itemPrices.get(id);
  if (!p) return opt.unknownOk ? { salvage: true, why: 'ตลาดไม่ตอบราคา (ตั้งให้ถือว่าไม่มีราคา)' } : { salvage: false, why: 'ตลาดไม่ตอบราคา (เก็บไว้ก่อน)' };
  if (p.vol7 >= opt.keepVol && opt.keepVol > 0) return { salvage: false, why: `ขายออกบ่อย ${p.vol7} ชิ้นใน 7 วัน`, price: p.price, vol7: p.vol7 };
  if (p.price && p.price >= opt.maxPrice) return { salvage: false, why: `ราคาตลาด ${Math.round(p.price).toLocaleString()} G`, price: p.price, vol7: p.vol7 };
  return { salvage: true, why: p.price ? `ราคาต่ำ ${Math.round(p.price).toLocaleString()} G` : 'ไม่มีราคาในตลาด', price: p.price || 0, vol7: p.vol7 || 0 };
};;
// ask the market about gear in the bag that has no recent price, then wait for the answers
HUB.priceGear = HUB.priceGear = async function priceGear(id, ids) {
  const g = HUB.rt(id);
  const todo = ids.filter((x) => !g.adapter.bound.has(x) && (!g.data.itemPrices.has(x) || Date.now() - g.data.itemPrices.get(x).at > 30 * 60 * 1000));
  // ask, wait, and ask again for the pieces the market did not answer (it can skip quick repeated asks)
  const t0 = Date.now();
  let missing = todo;
  for (let round = 0; round < 3 && missing.length; round++) {
    for (const x of missing) { await HUB.requestPrice(id, x, true); await HUB.sleep(round ? 800 : 450); } // eslint-disable-line no-await-in-loop
    await HUB.sleep(2500); // eslint-disable-line no-await-in-loop
    missing = missing.filter((x) => !g.data.itemPrices.has(x) || g.data.itemPrices.get(x).at < t0 - 1000);
  }
  HUB.selftest.count(id, 'priceAsked', todo.length); HUB.selftest.count(id, 'priceMissed', missing.length);
  if (missing.length) HUB.log.info(`acc ${id}: market gave no price for ${missing.length} piece(s) after 3 tries`);
  return todo.length;
};;

// AUTO / sleep straight from the game page: the once-a-second snapshot can be a beat behind
HUB.liveUi = async function liveUi(id) {
  const g = HUB.rt(id);
  try {
    return await g.win.webContents.executeJavaScript(`({ auto: document.body.classList.contains('auto-on'), sleeping: document.body.classList.contains('sleeping') })`, true);
  } catch { return { auto: g.data.stats.auto, sleeping: g.data.stats.sleeping }; }
};
