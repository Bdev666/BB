const HUB = require('../core/hub');

// Premium decides how several systems work (respawn here, free warps, HUD shop / NPC sell, town warp before a world boss).
// Per account: 'auto' (what the game says; not known yet = Premium), 'yes', 'no' (the player's tick on the Dashboard).
HUB.isPremium = function isPremium(id, g) {
  const a = HUB.account(id) || {};
  if (a.premium === 'yes') return true;
  if (a.premium === 'no') return false;
  const st = (g && g.data && g.data.stats) || {};
  if (st.premium === true || (g && g.data && g.data.premiumUntil > Date.now())) return true;
  if (st.premium === false || (g && g.data && g.data.premiumUntil === 0)) return false;
  return true;
};
