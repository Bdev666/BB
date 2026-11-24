const HUB = require('../core/hub');

// ---------- collect rewards: mail gifts, Pass missions (daily / weekly) and Pass tiers ----------
// the same messages the game's own "รับ" buttons send (mail one by one, then "claim all" on the Pass page)
HUB.claimRewards = HUB.claimRewards = async function claimRewards(id) {
  const g = HUB.games.get(id); if (!g || !g.inGame || g.demo) return { ok: false, error: 'ยังไม่ได้เข้าเกม' };
  const waitFor = async (key, since) => { for (let i = 0; i < 20; i++) { if (g[key] && g[key].at >= since) return g[key]; await HUB.sleep(250); } return null; }; // eslint-disable-line no-await-in-loop
  const out = { mail: 0, daily: 0, weekly: 0, tiers: false };
  HUB.farmDirty(g); g.claimUntil = Date.now() + 90000;
  let t0 = Date.now(); await HUB.sendInput(id, { type: 'mailQuery' });
  const mail = await waitFor('mailSeen', t0);
  for (const mid of (mail && mail.giftIds) || []) { await HUB.sendInput(id, { type: 'mailClaim', id: mid }); out.mail++; await HUB.sleep(350); } // eslint-disable-line no-await-in-loop
  t0 = Date.now(); await HUB.sendInput(id, { type: 'passQuery' });
  const pass = await waitFor('passSeen', t0);
  for (const m of ((pass && pass.daily) || []).filter((x) => x.ready)) { await HUB.sendInput(id, { type: 'dailyClaim', id: m.id }); out.daily++; await HUB.sleep(350); } // eslint-disable-line no-await-in-loop
  for (const m of ((pass && pass.weekly) || []).filter((x) => x.ready)) { await HUB.sendInput(id, { type: 'weeklyClaim', id: m.id }); out.weekly++; await HUB.sleep(350); } // eslint-disable-line no-await-in-loop
  await HUB.sendInput(id, { type: 'passClaimAll' }); out.tiers = true; // Pass tiers that are unlocked (the game skips when none)
  await HUB.sleep(800);
  await HUB.sendInput(id, { type: 'mailQuery' }); await HUB.sendInput(id, { type: 'passQuery' }); // fresh numbers for the dashboard
  HUB.log.info(`acc ${id}: rewards collected: ${out.mail} mail, ${out.daily} daily, ${out.weekly} weekly mission(s), pass tiers`);
  if (!mail && !pass) return { ok: false, error: 'เกมไม่ตอบ (ลองใหม่อีกครั้ง)' };
  return { ok: true, ...out };
};;
