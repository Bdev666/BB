const HUB = require('../core/hub');

// ---------- turbo refine: strike the chosen piece again the moment the last result is in ----------
// The game's own auto refine waits a fixed pause after every result (and a +15 piece takes many strikes). Here the next
// strike goes out as soon as the server's result arrives (the game's own refine message, the same one its button sends),
// until the target level, a refusal (no Gold / material / max), a level lost when "stop on drop" is on, or the player stops it.
// Gold and materials are spent exactly as the game's button would spend them: the player starts it, picks the piece and the target.
const levelOf = (ref) => { const m = /\+(\d+)/.exec(String(ref || '').split('|')[0]); return m ? Number(m[1]) : 0; };
HUB.refineLevelOf = levelOf;
HUB.refineView = (g) => { const t = g && g.turbo; return t ? { running: !!t.running, itemId: t.itemId, level: t.level, target: t.target, n: t.n, ok: t.ok, fail: t.fail, drop: t.drop, why: t.why || '', sec: Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000), protect: t.protect } : null; };
HUB.refineResult = function refineResult(g, ev) { if (g.turboWait) { const w = g.turboWait; g.turboWait = null; w(ev); } };
HUB.refineStop = function refineStop(id) { const g = HUB.games.get(id); if (g && g.turbo && g.turbo.running) { g.turbo.running = false; g.turbo.why = g.turbo.why || 'หยุดเอง'; g.turbo.endedAt = Date.now(); HUB.pushState(); } return true; };
HUB.refineStart = async function refineStart(id, o) {
  const g = HUB.games.get(id);
  if (!g || !g.inGame || g.demo || g.status !== 'online') return { ok: false, error: 'เกมยังไม่พร้อม' };
  if (g.turbo && g.turbo.running) return { ok: false, error: 'กำลังตีบวกอยู่' };
  const target = Math.max(1, Math.min(30, Number(o.target) || 15));
  const t = g.turbo = { itemId: String(o.itemId || ''), level: levelOf(o.itemId), target, protect: !!o.protect, stopOnDrop: o.stopOnDrop !== false, keepSilver: Math.max(0, Number(o.keepSilver) || 0), n: 0, ok: 0, fail: 0, drop: 0, running: true, startedAt: Date.now(), why: '' };
  if (!t.itemId) { g.turbo = null; return { ok: false, error: 'ยังไม่ได้เลือกชิ้น' }; }
  if (t.level >= target) { t.running = false; t.why = `ชิ้นนี้ +${t.level} แล้ว`; t.endedAt = Date.now(); return { ok: true }; }
  // the game refines only at the town's blacksmith: get there first (warp to a town with Premium, walk to the smith, talk to him)
  const SMITH_JS = `(() => { try { const g = window.__game; const n = (g.npcs() || []).find((x) => x.kind === 'smith' || x.act === 'repair'); const me = g.me(); return n ? { id: n.id, x: n.x, y: n.y, me: [me.x, me.y], map: g.mapId() } : null; } catch (e) { return null; } })()`;
  const smith = async () => HUB.pageRun(g, SMITH_JS, 'SMITH_JS');
  t.why = 'กำลังไปช่างตีเหล็ก…';
  let sm = await smith();
  if (!sm) { // not in a town (no blacksmith here)
    const town = HUB.townFor ? HUB.townFor(HUB.mapOf(g)) : null;
    if (town && HUB.isPremium(id, g)) {
      if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {});
      await HUB.warpGap(g); await HUB.sendInput(id, { type: 'warpTo', mapId: town });
      for (let i = 0; i < 25 && !(sm = await smith()); i++) await HUB.sleep(1000);
    }
    if (!sm) { t.running = false; t.why = 'ตีบวกได้ที่ช่างตีเหล็กในเมืองเท่านั้น · ตัวละครไม่ได้อยู่ในเมือง'; t.endedAt = Date.now(); return { ok: false, error: t.why }; }
  }
  if ((await HUB.liveUi(id)).auto) await HUB.gameCommand(id, 'auto', {}); // AUTO would wander off from the smith
  for (let i = 0; i < 30; i++) { // walk next to him (up to ~45 s)
    const now = await smith(); if (!now) break;
    if (Math.hypot(now.me[0] - now.x, now.me[1] - now.y) <= 2.5) break;
    await HUB.sendInput(id, { type: 'moveTo', x: now.x + 1, y: now.y });
    await HUB.sleep(1500);
  }
  await HUB.pageRun(g, `(() => { try { window.__game.talk(${JSON.stringify(sm.id)}); return true; } catch (e) { return false; } })()`, 'talk smith');
  await HUB.sleep(700);
  t.why = '';
  HUB.log.info(`acc ${id}: turbo refine start ${t.itemId.split('|')[0]} -> +${target}${t.protect ? ' (protect)' : ''}`);
  (async () => {
    let silent = 0;
    while (t.running) {
      if (!g.win || g.win.isDestroyed() || g.status !== 'online') { t.why = 'เกมหลุด'; break; }
      if (t.level >= target) { t.why = `ถึง +${target} แล้ว`; break; }
      const sv = Number(g.data.stats.silver); if (t.keepSilver && Number.isFinite(sv) && sv <= t.keepSilver) { t.why = 'Silver เหลือน้อยกว่าที่ตั้งเก็บไว้'; break; }
      const sentAt = Date.now();
      const reply = new Promise((res) => { g.turboWait = res; setTimeout(() => { if (g.turboWait === res) { g.turboWait = null; res(null); } }, 6000); });
      await HUB.sendInput(id, { type: 'refine', itemId: t.itemId, protect: t.protect }); // eslint-disable-line no-await-in-loop
      const r = await reply; // eslint-disable-line no-await-in-loop
      if (!t.running) break;
      if (!r) { // no refine result: the game may have said why in a notice (e.g. refine works only at the town's blacksmith)
        const nt = g.lastNotice && g.lastNotice.at >= sentAt ? g.lastNotice.text : '';
        if (nt) { t.why = nt; break; }
        if (++silent >= 3) { t.why = 'เกมไม่ตอบ 3 ครั้ง · น่าจะวัตถุดิบหรือ Gold ไม่พอ (เกมไม่ส่งคำตอบเมื่อปุ่มตีบวกกดไม่ได้) หรือชิ้นนี้ตีไม่ได้'; break; }
        continue;
      }
      silent = 0; t.n++;
      const before = t.level;
      if (r.itemId) t.itemId = r.itemId;
      const lv = r.level != null ? r.level : levelOf(r.itemId);
      if (r.reason && !r.ok) { t.why = r.reason; break; } // a refusal (no Gold / material / max), not a failed strike
      t.level = lv;
      if (r.ok) t.ok++; else { t.fail++; if (lv < before) { t.drop++; if (t.stopOnDrop) { t.why = `ตกเหลือ +${lv} (หยุดเมื่อตก)`; break; } } }
      HUB.pushState();
      await HUB.sleep(60); // eslint-disable-line no-await-in-loop
    }
    t.running = false; t.endedAt = Date.now(); if (!t.why) t.why = 'หยุด';
    HUB.log.info(`acc ${id}: turbo refine end: +${t.level} after ${t.n} strikes (${t.ok} ok, ${t.fail} fail, ${t.drop} drops) in ${Math.round((t.endedAt - t.startedAt) / 1000)} s · ${t.why}`);
    HUB.notify(id, 'event', `🔨 ตีบวกรัวจบ: +${t.level} (${t.n} ครั้ง ${Math.round((t.endedAt - t.startedAt) / 1000)} วิ) · ${t.why}`);
    HUB.pushState();
  })().catch((e) => { t.running = false; t.why = e.message; HUB.log.warn(`acc ${id}: turbo refine: ${e.message}`); });
  return { ok: true };
};
