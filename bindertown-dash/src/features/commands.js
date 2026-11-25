const HUB = require('../core/hub');

// ---------- commands from the Dashboard ----------
// Only what the player presses. Each goes out the way the game's own UI sends it:
// a click on the game's own button, the game's own window.__game helpers, or the
// same 'input' message the game client sends.
HUB.sendInput = function sendInput(id, obj) {
  const g = HUB.rt(id);
  if (!g.win || g.win.isDestroyed()) return Promise.resolve(false);
  const b64 = HUB.encodeInput(obj).toString('base64');
  return g.win.webContents.executeJavaScript(`window.__bdSend ? window.__bdSend(${JSON.stringify(b64)}) : false`, true).catch(() => false);
};

const priceAsked = new Map(); // itemId -> time
HUB.requestPrice = function requestPrice(id, itemId, force = false) {
  const last = priceAsked.get(itemId) || 0;
  if (!force && Date.now() - last < 10 * 60 * 1000) return Promise.resolve(true);
  priceAsked.set(itemId, Date.now());
  // remember what was asked: the board may answer with its own id for the kind + grade (not the bag piece's id)
  const g = HUB.rt(id); g.priceAsks = (g.priceAsks || []).filter((a) => Date.now() - a.at < 8000); g.priceAsks.push({ id: itemId, at: Date.now() });
  // the market board's item view (kind + grade): what the game's market window asks for
  return HUB.sendInput(id, { ...HUB.MARKET_FILTER, type: 'marketItem', itemId, loff: 0 });
};

HUB.gameCommand = async function gameCommand(id, cmd, arg) {
  const r = await HUB.runCommand(id, cmd, arg);
  if (!r.ok || !['sell', 'sellEtc', 'chat', 'salvage'].includes(cmd)) return r;
  // the game answers refusals with a notice ("ซื้อ/ขายผ่าน HUD ได้เฉพาะ Premium ..."): pass it on
  const g = HUB.rt(id);
  const sentAt = Date.now();
  await HUB.sleep(1500);
  if (g.lastNotice && g.lastNotice.at >= sentAt) return { ok: false, error: g.lastNotice.text };
  return r;
};

HUB.runCommand = async function runCommand(id, cmd, arg) {
  const g = HUB.rt(id);
  if (!g.win || g.win.isDestroyed()) return { ok: false, error: 'เปิดเกมบัญชีนี้ก่อน' };
  if (!g.inGame) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
  const js = (code) => g.win.webContents.executeJavaScript(code, true).catch(() => false);
  const click = (sel) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.offsetParent || x.id === 'autobig'); if (!b) return false; b.click(); return true; })()`);
  let ok = false;
  switch (cmd) {
    case 'auto':
    case 'sleep': {
      const before = await HUB.liveUi(id);
      ok = await click(cmd === 'auto' ? '#autobig' : '#autoeco');
      if (ok) {
        await HUB.sleep(400);
        const after = await HUB.liveUi(id);
        Object.assign(g.data.stats, { auto: after.auto, sleeping: after.sleeping });
        if (cmd === 'auto' && after.auto === before.auto) return { ok: false, error: `เกมไม่${before.auto ? 'ปิด' : 'เปิด'} AUTO ให้ (เช่น อยู่ในเมือง ตัวละครตาย หรือกำลังวาร์ป)` };
      }
      break;
    }
    case 'respawn':
      // prefer the "here / in place" button, then any respawn button on the death screen
      // the game's death screen: #drespawnhere = up on the spot (Gold fee), the other button = back to town
      ok = await js(`(() => { const o = document.getElementById('deathoverlay'); if (!o || getComputedStyle(o).display === 'none') return false; const h = document.getElementById('drespawnhere'); if (h && !h.disabled) { h.click(); return true; } if (${arg.hereOnly ? 'true' : 'false'}) return false; const bs = [...o.querySelectorAll('button')].filter((b) => !b.disabled && b.id !== 'drespawnhere'); if (!bs[0]) return false; bs[0].click(); return true; })()`);
      break;
    case 'sell': {
      const qty = Math.max(1, Math.floor(Number(arg.qty) || 0));
      if (!/^[\w~#.:+^|$&!%@*-]+$/.test(arg.itemId || '')) return { ok: false, error: 'ไอเทมไม่ถูกต้อง' };
      ok = await js(`(window.__game && window.__game.sell) ? (window.__game.sell(${JSON.stringify(arg.itemId)}, ${qty}), true) : false`);
      break;
    }
    case 'sellNpc': {
      // chosen pieces (the dashboard's NPC sell window); never a locked one, whatever the list says
      const list = Array.isArray(arg.items) ? arg.items.slice(0, 300) : [];
      let n = 0;
      for (const it of list) {
        const itemId = String(it.itemId || ''); const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
        if (!/^[\w~#.:+^|$&!%@*-]+$/.test(itemId) || (g.adapter.locks && g.adapter.locks.has(itemId))) continue;
        // eslint-disable-next-line no-await-in-loop
        await js(`window.__game.sell(${JSON.stringify(itemId)}, ${qty}), true`); n++;
        // eslint-disable-next-line no-await-in-loop
        await HUB.sleep(250);
      }
      HUB.log.info(`acc ${id}: sold ${n} item stack(s) to the NPC (chosen in the dashboard)`);
      ok = n > 0;
      break;
    }
    case 'sellEtc': {
      // every monster drop in the bag (ETC), one sell per stack, like the game's sell window
      const inv = g.adapter.inv ? [...g.adapter.inv] : [];
      const drops = inv.filter(([itemId, qty]) => /^drop_/.test(itemId) && qty > 0);
      if (!drops.length) return { ok: false, error: 'ไม่มีของดรอปในกระเป๋า' };
      for (const [itemId, qty] of drops) {
        // eslint-disable-next-line no-await-in-loop
        await js(`window.__game.sell(${JSON.stringify(itemId)}, ${qty}), true`);
      }
      ok = true;
      break;
    }
    case 'price': ok = await HUB.requestPrice(id, arg.itemId, true); break;
    case 'priceAll': {
      // ask the market about every tradable gear piece in the bag (one after another, like browsing)
      const ids = HUB.tradableGear(g);
      for (const itemId of ids) {
        // eslint-disable-next-line no-await-in-loop
        await HUB.requestPrice(id, itemId, true);
        // eslint-disable-next-line no-await-in-loop
        await HUB.sleep(350);
      }
      return { ok: true, count: ids.length };
    }
    case 'marketList': {
      // list one piece / stack on the central market at the price the player confirmed
      const itemId = String(arg.itemId || '');
      const unit = Math.floor(Number(arg.unitPrice) || 0);
      const have = g.adapter.inv ? g.adapter.inv.get(itemId) || 0 : 0;
      const qty = Math.max(1, Math.min(have, Math.floor(Number(arg.qty) || 1)));
      if (!have) return { ok: false, error: 'ไม่มีของชิ้นนี้ในกระเป๋าแล้ว' };
      if (g.adapter.locks.has(itemId)) return { ok: false, error: 'ของชิ้นนี้ล็อกไว้ในเกม' };
      if (g.adapter.bound.has(itemId)) return { ok: false, error: 'ของผูกตัว ลงขายไม่ได้' };
      if (unit < 1) return { ok: false, error: 'ใส่ราคาก่อน' };
      const sentAt = Date.now();
      if (!(await HUB.sendInput(id, { type: 'marketList', itemId, qty, price: qty * unit }))) return { ok: false, error: 'เกมยังไม่พร้อม' };
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop
        await HUB.sleep(200);
        const m = g.lastMarket;
        if (m && m.at >= sentAt) {
          HUB.log.info(`acc ${id}: market list ${itemId.split(/[|#]/)[0]} x${qty} @ ${unit} -> ${m.ok ? 'listed' : 'refused: ' + m.reason}`);
          if (m.ok) HUB.addPending(g, itemId, qty, unit, true);
          return m.ok ? { ok: true, pending: true } : { ok: false, error: m.reason || 'ตลาดไม่รับรายการนี้' };
        }
        const n = g.lastNotice;
        if (n && n.at >= sentAt) return { ok: false, error: n.text };
      }
      // no answer yet: the market may still be working on it (listings show up ~5 min later).
      // If the piece left the bag it went to the market; either way it is rechecked later.
      const gone = !(g.adapter.inv && g.adapter.inv.get(itemId));
      HUB.addPending(g, itemId, qty, unit, gone);
      HUB.log.info(`acc ${id}: market list ${itemId.split(/[|#]/)[0]} x${qty} @ ${unit} -> no answer, ${gone ? 'left the bag' : 'still in bag'}; recheck later`);
      return { ok: true, pending: true, unsure: !gone };
    }
    case 'marketCancel': ok = await HUB.sendInput(id, { type: 'marketCancel', id: Number(arg.listingId) }); break;
    case 'buy': {
      // NPC shop potions only (the game's vendor list); the game charges Silver
      const p = HUB.POTIONS.find((x) => x.id === arg.itemId);
      const qty = Math.max(1, Math.min(999, Math.floor(Number(arg.qty) || 0)));
      if (!p) return { ok: false, error: 'ซื้อได้เฉพาะยาจากร้าน NPC' };
      // the shop takes at most 99 per purchase: buy in rounds and count what really arrived in the bag
      // every quality grade of this potion (potion, potion~1, potion~2): what the hotbar draws from
      const have = () => { let n = 0; if (g.adapter.inv) for (const [k, q] of g.adapter.inv) if (HUB.baseOf(k) === p.id) n += q || 0; return n; };
      const start = have();
      let left = qty; let reason = '';
      // keepSilver: never spend below this (auto-buy); the unit price is learned from the first round
      const keep = Math.max(0, Number(arg.keepSilver) || 0);
      const silverNow = async () => { try { return await g.win.webContents.executeJavaScript('(window.__game && window.__game.me() || {}).silver', true); } catch { return null; } };
      let unit = (p.price || 12) * 1.5;
      while (left > 0) {
        let n = Math.min(99, left);
        if (arg.keepSilver != null) {
          const sv = await silverNow(); // eslint-disable-line no-await-in-loop
          if (sv != null) n = Math.min(n, Math.floor((sv - keep) / unit));
          if (n <= 0) { reason = `เหลือ Silver ไม่เกินที่ตั้งเก็บไว้ (${keep.toLocaleString('en-US')})`; break; }
        }
        const svBefore = arg.keepSilver != null ? await silverNow() : null; // eslint-disable-line no-await-in-loop
        const before = have(); const sentAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        if (!(await HUB.sendInput(id, { type: 'vendorBuy', itemId: p.id, qty: n }))) { reason = 'เกมยังไม่พร้อม'; break; }
        let got = 0;
        for (let i = 0; i < 25 && !got; i++) {
          // eslint-disable-next-line no-await-in-loop
          await HUB.sleep(120);
          got = have() - before;
          if (!got && g.lastNotice && g.lastNotice.at >= sentAt) { reason = g.lastNotice.text; break; }
        }
        if (got > 0 && svBefore != null) { const sv = await silverNow(); const u = sv != null ? (svBefore - sv) / got : 0; if (u >= (p.price || 1) * 0.3 && u <= (p.price || 1) * 10) unit = u; } // eslint-disable-line no-await-in-loop -- kills add Silver meanwhile: keep only a believable price
        // say which: the numbers are here (silver, bag weight), the guess list is only the fallback
        const why = async () => { const sv = await silverNow(); const sum = g.data.summary ? g.data.summary() : {}; const wp = sum.weightPct;
          if (sv != null && sv < unit * Math.min(n, 10)) return `Silver ไม่พอ (มี ${Math.round(sv).toLocaleString('en-US')})`;
          if (wp != null && wp >= 90) return `กระเป๋าหนัก ${Math.round(wp)}%`;
          return 'ร้านไม่ขายเพิ่ม (ต้องเป็น Premium หรืออยู่ใกล้ร้าน)'; };
        if (got <= 0) { reason = reason || await why(); break; } // eslint-disable-line no-await-in-loop
        left -= got;
        if (got < n) { reason = `ได้ไม่ครบรอบนี้ (${await why()})`; break; } // eslint-disable-line no-await-in-loop
      }
      const bought = have() - start;
      HUB.log.info(`acc ${id}: buy ${p.id} x${qty} -> got ${bought}${reason ? ' (' + reason + ')' : ''}`);
      return bought > 0 ? { ok: true, bought, asked: qty, note: reason } : { ok: false, error: reason || 'ซื้อไม่สำเร็จ' };
    }
    case 'salvage': {
      // one or more gear pieces from the bag; locked ones are skipped like in the game
      const ids = (Array.isArray(arg.itemIds) ? arg.itemIds : [arg.itemId]).filter((x) => typeof x === 'string' && x.includes('#'));
      const usable = ids.filter((x) => !g.adapter.locks.has(x) && g.adapter.inv && g.adapter.inv.has(x));
      if (!usable.length) return { ok: false, error: 'ไม่มีของที่ย่อยได้ (ของที่ล็อกไว้จะไม่ถูกย่อย)' };
      for (const itemId of usable) {
        // eslint-disable-next-line no-await-in-loop
        ok = (await HUB.sendInput(id, { type: 'salvage', itemId })) || ok;
        // eslint-disable-next-line no-await-in-loop
        await HUB.sleep(250);
      }
      break;
    }
    case 'chat': {
      const text = String(arg.text || '').trim().slice(0, 200);
      const channel = ['world', 'map', 'party', 'guild', 'whisper', 'trade'].includes(arg.channel) ? arg.channel : 'map';
      if (!text) return { ok: false, error: 'ไม่มีข้อความ' };
      const msg = { type: 'chat', text, channel };
      if (channel === 'whisper') { if (!arg.to) return { ok: false, error: 'ใส่ชื่อคนที่จะกระซิบ' }; msg.to = String(arg.to).trim(); }
      ok = await HUB.sendInput(id, msg);
      break;
    }
    default: return { ok: false, error: 'ไม่รู้จักคำสั่ง' };
  }
  HUB.log.info(`acc ${id}: command ${cmd}${cmd === 'chat' ? ` (${arg.channel}, ${String(arg.text || '').length} chars)` : arg.itemId ? ` ${arg.itemId}` : ''} -> ${ok ? 'sent' : 'not sent'}`);
  return ok ? { ok: true } : { ok: false, error: 'เกมยังไม่พร้อม ลองใหม่อีกครั้ง' };
};
