// Build Lab: the strongest skill build, cards, live view (the game's own calculator).
// Loaded before dashboard.js: only declarations here; they run when dashboard.js calls them.

let labInfo = null;

let lastLab = null; // the settings of the last Build Lab run (card builds reuse them)

const labPretty = (id) => String(id || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// opt.id: which account to read (default: the selected one) · opt.auto: run at once (skills, then cards)
async function openLab(opt = {}) {
  const out = el('div', { class: 'lab-out' }, el('p', { class: 'hint' }, 'กำลังโหลดตัวคำนวณของเกม…'));
  openModal('🧪 Build Lab · หาชุดสกิลที่แรงที่สุด', [out]);
  $('#modal').classList.add('wide');
  try { labInfo = labInfo || await dash.invoke('lab-info'); } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
  const accId = opt.id || selected;
  const me = accId ? await dash.invoke('lab-me', accId) : null;
  const online = ((state && state.accounts) || []).filter((a) => a.status === 'online');
  const accSel = el('select', {}, el('option', { value: '' }, '— ไม่ใช้ตัวละคร (กรอกเอง) —'),
    ...online.map((a) => el('option', { value: a.id, selected: a.id === accId ? '' : null }, a.name || ('บัญชี ' + a.id))));
  accSel.addEventListener('change', () => openLab({ id: accSel.value ? Number(accSel.value) || accSel.value : -1 }));
  const jobs = labInfo.jobs;
  const myJob = me && jobs.some((j) => j.id === me.job) ? me.job : 'mage';
  const num_ = (v, min, max, step = 1) => el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(v) });
  const job = el('select', {}, ...jobs.map((j) => el('option', { value: j.id, selected: j.id === myJob ? '' : null }, labPretty(j.id))));
  const lv = num_(me && me.job === myJob ? me.level : 100, 1, 200);
  // class 1: Job Lv 50 (all skill points) by default, like class 2; untick to use the character's own Job Lv
  const jlvReal = me && me.job === myJob ? Math.min(50, me.jobLevel) : 50;
  const jlv = num_(50, 1, 50);
  const c1Full = el('input', { type: 'checkbox', checked: me && me.job === myJob ? null : '' }); // a real character: its own Job Lv
  const c1Sync = () => { jlv.disabled = c1Full.checked; jlv.value = String(c1Full.checked ? 50 : jlvReal); };
  c1Full.addEventListener('change', c1Sync); c1Sync();
  const c2i = (me && me.c2info) || {};
  const c2SkillPts = me && me.c2 ? Object.entries(me.skills).filter(([k]) => k.startsWith(me.c2 + '_')).reduce((t, [, v]) => t + v, 0) : 0;
  // class 2: Job Lv 50 and all 70 points by default, so every result is compared on a full class 2
  const c2lv = num_(50, 1, 50);
  const c2pts = num_(70, 0, 70);
  const c2Full = el('input', { type: 'checkbox', checked: me && me.c2 ? null : '' }); // a real character: its own class-2 Job Lv and points
  const c2Real = me && me.c2 ? { lv: c2i.jobLevel || 0, pts: c2SkillPts + (c2i.points || 0) } : null;
  const c2Sync = () => {
    c2lv.disabled = c2pts.disabled = c2Full.checked;
    if (c2Full.checked) { c2lv.value = '50'; c2pts.value = '70'; } else if (c2Real) { c2lv.value = String(c2Real.lv || 50); c2pts.value = String(c2Real.pts || 0); }
  };
  c2Full.addEventListener('change', c2Sync); c2Sync();
  const owned = (me && me.ownedCards) || [];
  const st = {}; for (const k of ['str', 'agi', 'vit', 'int', 'dex', 'luk']) st[k] = num_(me && me.stats ? me.stats[k] || 1 : 1, 0, 999);
  const mode = el('select', {}, el('option', { value: 'boss' }, '👑 ตีบอส (ดาเมจเป้าเดียว)'));
  const pack = num_(4, 1, 12); pack.addEventListener('change', () => { pack.dataset.touched = '1'; });
  const boss = el('select', {}, el('option', { value: '' }, 'บอสเลเวลใกล้ตัวที่สุด'),
    el('option', { value: 'wraithroot_colossus' }, '🌍 World Boss · Wraithroot Colossus (Lv 99)'),
    el('option', { value: 'pearlheart_titan' }, '🌍 World Boss · Pearlheart Titan (Lv 130)'),
    el('option', { value: 'training_dummy' }, '🎯 หุ่นฟางห้องฝึก (เทียบกับ DPS Meter)'),
    ...labInfo.bosses.map((b) => el('option', { value: b.id }, `${labPretty(b.id)} (Lv ${b.level})`)));
  const useCur = el('input', { type: 'checkbox', checked: me && me.job === myJob ? '' : null });
  const lo = me && me.loadout;
  const hasLo = !!lo && (Object.keys(lo.equip || {}).length > 0 || Object.keys(lo.album || {}).length > 0);
  const useGear = el('input', { type: 'checkbox', checked: hasLo ? '' : null, disabled: hasLo ? null : '' });
  const packRow = el('label', { hidden: '' }, 'มอนต่อกลุ่ม ', pack, el('small', { class: 'hint' }, ' ตัว (สกิลวง/ทะลุ/กวาด ตีได้หลายตัว)'));
  // how long the boss fight lasts: the build is scored on its average damage over that time
  let ft = { fights: {}, world: {} }; try { ft = await dash.invoke('fight-times'); } catch { /* none yet */ }
  const win = el('select', { title: 'บิลด์ถูกจัดให้ได้ดาเมจรวมมากที่สุดในเวลาที่ตีบอสจริง (ช่วงเปิดกับช่วงยาวถ่วงตามเวลานั้น)' },
    el('option', { value: 'auto' }, 'อัตโนมัติ (ตามบอส)'), el('option', { value: 'real' }, 'จากการตีจริง'),
    el('option', { value: '30' }, '30 วิ'), el('option', { value: '60' }, '1 นาที'), el('option', { value: '180' }, '3 นาที'), el('option', { value: 'sustain' }, 'ยาวมาก (นาทีที่ 2–3)'));
  const party = num_(1, 1, 30);
  const useCombos = el('input', { type: 'checkbox', checked: '' });
  const realOf = () => { const t = boss.value || ''; const f = ft.fights[t]; return f ? f : null; };
  const ftNote = el('small', { class: 'hint' });
  const updFt = () => { const f = realOf(); const wl = ft.world[boss.value]; ftNote.textContent = f ? ` · ตีจริง ${f.n} ครั้ง ค่ากลาง ${f.sec} วิ` : wl ? ` · กิจกรรมยาว ${Math.round(wl / 60)} นาที` : ''; };
  boss.addEventListener('change', updFt); updFt();
  const bossRow = el('label', {}, me && me.job === myJob ? '' : 'เป้า ', me && me.job === myJob ? '' : boss, ' · ระยะเวลาสู้ ', win, ' · ตีกี่คน ', party, me && me.job === myJob ? '' : ftNote);
  mode.addEventListener('change', () => { packRow.hidden = mode.value !== 'farm'; bossRow.hidden = mode.value !== 'boss'; });
  const go = el('button', { class: 'primary' }, me && me.job === myJob ? `🧪 วิเคราะห์ ${me.name || 'ตัวละคร'} (สกิล + การ์ด)` : 'คำนวณหาบิลด์ที่ดีที่สุด');
  const res = el('div', { class: 'lab-res' });
  go.onclick = async () => {
    go.disabled = true; res.replaceChildren(el('p', { class: 'hint' }, 'กำลังลองชุดสกิล + Evolution + Trait + ช่องลัด ทั้งคลาส 1 และคลาส 2 ทุกสาย…'));
    const p = labParams();
    lastLab = p;
    try {
      const rr = await dash.invoke('lab-run', p);
      if (rr.fight) p.fightSec = rr.fight.sec; // cards are scored over the same fight length
      renderLab(res, rr);
      // a real character: go straight on to the best cards for the winning build
      if (me && me.job === job.value) { const b = res.querySelector('.lab-card.best .lab-cardbtn[data-goal="' + (mode.value === 'boss' ? 'boss' : 'farm') + '"]'); if (b) b.click(); }
    } catch (e) { res.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    go.disabled = false;
  };
  const labParams = () => {
    const rf = realOf();
    const p = { combos: useCombos.checked, fightMode: win.value, window: win.value === 'sustain' ? 'sustain' : 'sustain', party: +party.value || 1, realSec: rf ? rf.sec : 0, realN: rf ? rf.n : 0, worldSec: ft.world[boss.value] || 0, job: job.value, level: +lv.value, jobLevel: +jlv.value, c2Job: +c2lv.value, c2Points: +c2pts.value, mode: mode.value, pack: +pack.value, packSet: pack.dataset.touched === '1', target: mode.value === 'boss' ? boss.value : '',
      stats: Object.fromEntries(Object.entries(st).map(([k, i]) => [k, +i.value || 0])) };
    if (useGear.checked && hasLo) p.loadout = { ...lo, wRefine: me.wRefine, sRefine: me.sRefine };
    p.realC2 = !c2Full.checked && !!c2Real; // the real class 2 points: the lab adds the levels already put past the top of class 1 skills
    if (useCur.checked && me && me.job === job.value) p.current = { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr || {} };
    if (me && me.job === job.value) p.acc = accId; // the character's own learned per-skill factors (from its real hits)
    if (owned.length) p.owned = owned;
    if (me && me.skills) p.basics = me.skills; // the character's real basic-skill levels (the calculator assumes maxed)
    return p;
  };
  // competition mode: skills -> cards -> skills -> cards for the 2 strongest paths, every hotbar order
  const fullStars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
  const full = el('button', { class: 'primary gold', title: 'หาชุดสกิลที่แรงที่สุดก่อน (ไม่นับการ์ด) แล้วหาการ์ดที่ดีที่สุดให้ชุดสกิลนั้น 2 คลาสที่แรงสุด ใช้เวลา 30–90 วิ' }, '🏆 โหมดแข่ง (ละเอียดสุด)');
  full.onclick = async () => {
    full.disabled = true; go.disabled = true;
    const t = Date.now();
    const tick = setInterval(() => { res.firstChild && (res.firstChild.textContent = `🏆 กำลังหาสกิลก่อน แล้วหาการ์ดให้… ${Math.round((Date.now() - t) / 1000)} วิ (ราว 30–90 วิ)`); }, 1000);
    res.replaceChildren(el('p', { class: 'hint' }, '🏆 กำลังหาสกิลก่อน แล้วหาการ์ดให้…'));
    const p = { ...labParams(), stars: +fullStars.value, goal: mode.value === 'boss' ? 'boss' : 'farm' };
    lastLab = p;
    try {
      const f = await dash.invoke('lab-full', p);
      renderLab(res, { mode: p.mode, target: f.out[0].target, results: f.out.map((o) => o.result), current: f.out[0].current, evals: 0, ms: f.ms, loadout: !!p.loadout, full: true });
      res.querySelectorAll('.lab-card').forEach((cardEl, i) => { const box = cardEl.querySelector('.lab-cards'); if (box && f.out[i]) box.replaceChildren(...cardsView(f.out[i].cards, p.goal)); });
      res.prepend(el('p', { class: 'hint' }, `🏆 โหมดแข่ง: เลือกสกิลที่แรงที่สุดก่อน (ไม่นับการ์ด) แล้วค่อยหาการ์ดให้ชุดสกิลนั้น (การ์ดไม่เปลี่ยนสกิลที่เลือก) · ${(f.ms / 1000).toFixed(0)} วิ · DPS ในการ์ดผลลัพธ์รวมการ์ดชุดนี้แล้ว`));
    } catch (e) { res.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    clearInterval(tick); full.disabled = false; go.disabled = false;
  };
  const comboBtn = el('button', { class: 'tiny', onclick: async () => {
    comboBtn.disabled = true;
    try {
      const list = await dash.invoke('lab-combos');
      const kindName = { region: '🗺 เซ็ตภูมิภาค (การ์ดต่างชนิด ภูมิภาคเดียวกัน)', kin: '🐾 คู่สายพันธุ์ (2 ใบต่างชนิด สายพันธุ์เดียวกัน)', color: '🎨 สีการ์ด (ต้อง ★3 ขึ้นไปทุกใบ)' };
      openModal('📖 คอมโบการ์ดทั้งหมด (จากข้อมูลเกม)', [
        el('p', { class: 'hint' }, 'การ์ดซ้ำชนิดเดียวกันได้ผล 100% / 50% / 25% / 0% · คอมโบนับการ์ดต่างชนิดกัน · ค่าในตารางคือโบนัสคอมโบ (ไม่ขึ้นกับดาว)'),
        ...['region', 'kin', 'color'].map((k) => el('div', {}, el('h4', {}, kindName[k]),
          el('table', { class: 'lab-maps' }, el('tr', {}, ...['คอมโบ', 'ใส่กี่ใบ', 'โบนัส', 'การ์ดที่นับ'].map((h) => el('th', {}, h))),
            ...list.filter((x) => x.kind === k).flatMap((x) => (x.tiers.length ? x.tiers : [{ n: '-', fx: [] }]).map((t, i) => el('tr', {},
              el('td', {}, i ? '' : x.name), el('td', {}, String(t.n)), el('td', {}, t.fx.join(' · ')),
              el('td', { class: 'hint' }, i ? '' : `${x.count} ชนิด: ` + x.members.slice(0, 10).map(labPretty).join(', ') + (x.count > 10 ? ' …' : '')))))))),
      ]);
    } catch (e) { alert(e.message); }
    comboBtn.disabled = false;
  } }, '📖 คอมโบการ์ดทั้งหมด');
  const skillPane = el('div', {}, ...[
    el('p', { class: 'hint' }, 'ใช้สูตรดาเมจของเกมเอง (ตัวเดียวกับหน้าบิลด์แนะนำในเกม) ลองลงแต้มสกิล · Evolution A/B · Trait ของสาย · ลำดับช่องลัด แล้วจัดอันดับ คลาส 1 อย่างเดียว เทียบกับคลาส 2 ทั้งสองสาย'),
    me && me.job === myJob ? el('div', { class: 'lab-real' }, el('b', {}, `📊 ใช้ข้อมูลจริงของ ${me.name || 'ตัวละคร'} (อ่านจากเกมตอนนี้)`),
      el('div', { class: 'hint' }, `${labPretty(me.job)} Lv ${me.level} · Job ${me.jobLevel}${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)} Job ${(me.c2info && me.c2info.jobLevel) || '-'} (${c2Real ? c2Real.pts : 0} แต้ม)` : ''} · ` +
        ['str', 'agi', 'vit', 'int', 'dex', 'luk'].map((k) => `${k.toUpperCase()} ${(me.stats || {})[k] || 0}`).join(' ') +
        ` · เกียร์ ${Object.keys((lo && lo.equip) || {}).length} ชิ้น · การ์ด ${Object.keys((lo && lo.album) || {}).length} ใบ · สกิล ${Object.values(me.skills || {}).filter((v) => v > 0).length} ตัว · Trait ${Object.keys(me.traits || {}).length + Object.keys(me.c2tr || {}).length} สาย`),
      el('div', { class: 'lab-form' }, el('label', {}, 'เป้า ', boss), ftNote)) : null,
    me && me.job === myJob ? el('details', { class: 'lab-adv' }, el('summary', {}, '⚙ สมมติค่าเอง (ไม่ใช่ค่าจริง: ลองเปลี่ยนอาชีพ เลเวล สเตตัส Job เต็ม ฯลฯ)'),
    el('div', { class: 'lab-form' },
      el('label', {}, 'อาชีพ ', job), el('label', {}, 'Lv ', lv), el('label', { title: 'ตามเกม: Job คลาส 1 สูงสุด 50 · แต้มสกิลเต็ม' }, c1Full, ' คลาส 1 Job เต็ม'), el('label', {}, 'Job Lv ', jlv),
      el('label', { title: 'ตามเกม: Job คลาส 2 สูงสุด 50 ได้แต้มรวม 70 (ใช้ร่วมกันทั้งสองสาย)' }, c2Full, ' คลาส 2 Job เต็ม (Lv 50 · 70 แต้ม)'),
      el('label', {}, 'Job คลาส 2 ', c2lv), el('label', { title: c2Real ? 'เอาติ๊ก "Job เต็ม" ออกเพื่อใช้ค่าของตัวละคร' : 'แต้มคลาส 2 ทั้งหมด (สูงสุด 70)' }, 'แต้มคลาส 2 ', c2pts),
      el('div', { class: 'lab-stats' }, ...Object.entries(st).map(([k, i]) => el('label', {}, k.toUpperCase() + ' ', i))),
      el('label', {}, 'โหมด ', mode), bossRow, packRow,
      el('label', { title: 'นับคอมโบตามกลไกเกม: เป้าติดสถานะ (สโลว์/ตรึง/หนาว กับเกียร์-การ์ด-สกิลที่แรงขึ้น), Hunter\'s Mark ของ Scout, Chill → Shatter ของ Mage' }, useCombos, ' นับคอมโบ (สถานะ · Mark · Shatter)'),
      me ? el('label', {}, useCur, ' เทียบกับบิลด์ปัจจุบันของตัวละคร') : null,
      el('label', { title: hasLo ? 'อาวุธ/ชุด/ตีบวก/affix และการ์ดที่ใส่อยู่ จากเกม' : 'เปิดเกมของบัญชีนี้ก่อน (ต้องเข้าเกมแล้ว) จึงจะอ่านเกียร์และการ์ดได้' }, useGear,
        hasLo ? ` ใส่เกียร์ ${Object.keys(lo.equip || {}).length} ชิ้น + การ์ด ${Object.keys(lo.album || {}).length} ใบของตัวละคร (แม่นขึ้น)` : ' ใส่เกียร์+การ์ดของตัวละคร (ต้องเปิดเกมบัญชีนี้)'),
      me ? el('small', { class: 'hint' }, ` · มีการ์ด ${owned.length} ชนิด${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)}` : ''}`) : null)) : null,
    me && me.job === myJob ? null : el('div', { class: 'lab-form' },
      el('label', {}, 'อาชีพ ', job), el('label', {}, 'Lv ', lv), el('label', { title: 'ตามเกม: Job คลาส 1 สูงสุด 50 · แต้มสกิลเต็ม' }, c1Full, ' คลาส 1 Job เต็ม'), el('label', {}, 'Job Lv ', jlv),
      el('label', { title: 'ตามเกม: Job คลาส 2 สูงสุด 50 ได้แต้มรวม 70 (ใช้ร่วมกันทั้งสองสาย)' }, c2Full, ' คลาส 2 Job เต็ม (Lv 50 · 70 แต้ม)'),
      el('label', {}, 'Job คลาส 2 ', c2lv), el('label', { title: c2Real ? 'เอาติ๊ก "Job เต็ม" ออกเพื่อใช้ค่าของตัวละคร' : 'แต้มคลาส 2 ทั้งหมด (สูงสุด 70)' }, 'แต้มคลาส 2 ', c2pts),
      el('div', { class: 'lab-stats' }, ...Object.entries(st).map(([k, i]) => el('label', {}, k.toUpperCase() + ' ', i))),
      el('label', {}, 'โหมด ', mode), bossRow, packRow,
      el('label', { title: 'นับคอมโบตามกลไกเกม: เป้าติดสถานะ (สโลว์/ตรึง/หนาว กับเกียร์-การ์ด-สกิลที่แรงขึ้น), Hunter\'s Mark ของ Scout, Chill → Shatter ของ Mage' }, useCombos, ' นับคอมโบ (สถานะ · Mark · Shatter)'),
      me ? el('label', {}, useCur, ' เทียบกับบิลด์ปัจจุบันของตัวละคร') : null,
      el('label', { title: hasLo ? 'อาวุธ/ชุด/ตีบวก/affix และการ์ดที่ใส่อยู่ จากเกม' : 'เปิดเกมของบัญชีนี้ก่อน (ต้องเข้าเกมแล้ว) จึงจะอ่านเกียร์และการ์ดได้' }, useGear,
        hasLo ? ` ใส่เกียร์ ${Object.keys(lo.equip || {}).length} ชิ้น + การ์ด ${Object.keys(lo.album || {}).length} ใบของตัวละคร (แม่นขึ้น)` : ' ใส่เกียร์+การ์ดของตัวละคร (ต้องเปิดเกมบัญชีนี้)'),
      me ? el('small', { class: 'hint' }, ` · มีการ์ด ${owned.length} ชนิด${me.c2 ? ` · คลาส 2 ${labPretty(me.c2)}` : ''}`) : null),
    me ? measureBox(accId, me, () => ({ ...labParams(), job: me.job, level: me.level, jobLevel: me.jobLevel, current: { skills: me.skills, evo: me.evo, traits: me.traits, c2: me.c2, c2tr: me.c2tr || {} } })) : null,
    el('div', { class: 'lab-row' }, go, full, el('small', { class: 'hint' }, ' ดาวการ์ด (โหมดแข่ง ถ้าไม่ใช้เฉพาะที่มี) '), fullStars, comboBtn), res,
    el('p', { class: 'hint' }, 'ติ๊ก "ใส่เกียร์+การ์ด" เพื่อให้ตัวเลขใกล้ของจริง · เทียบความแม่นได้ที่ห้องฝึก: เลือกเป้า "หุ่นฟางห้องฝึก" แล้วดู DPS ของ "บิลด์ปัจจุบัน" เทียบ DPS Meter (เปิด AUTO ตีหุ่น 1 นาที) · สเตตัสใช้ของตัวละครที่เลือก แก้ได้ · คลาส 2 คิดแบบ Job เต็ม (Lv 50 · 70 แต้ม ตามเกม) ถ้าอยากใช้ค่าจริงของตัวละครให้เอาติ๊กออก'),
  ].filter(Boolean));

  // ---- tab: cards from the character's own collection (equipped + bag), for its current skill build ----
  const cardPane = el('div', { hidden: '' });
  const livePane = el('div', { hidden: '' });
  if (me) {
    const cGoal = el('select', {}, el('option', { value: 'boss' }, '👑 DPS ตีบอส'), el('option', { value: 'gold' }, '💰 ฟาร์มเงิน (การ์ด Gold/ดรอป)'));
    const cBoss = el('select', {}, ...[...boss.options].map((o) => el('option', { value: o.value }, o.textContent)));
    const cMine = el('input', { type: 'checkbox', checked: owned.length ? '' : null, disabled: owned.length ? null : '' });
    const cNoCrit = el('input', { type: 'checkbox' });
    const cDup = el('input', { type: 'checkbox' });
    const cStars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
    const cOut = el('div', {});
    const cGo = el('button', { class: 'primary' }, owned.length ? `🃏 จัดการ์ดจาก ${owned.length} ชนิดที่มี` : '🃏 จัดการ์ด');
    cGo.onclick = async () => {
      cGo.disabled = true; cOut.replaceChildren(el('p', { class: 'hint' }, 'กำลังอ่านตัวละครล่าสุดและลองการ์ดทุกคอมโบ…'));
      const meNow = (await dash.invoke('lab-me', accId)) || me;
      const q = { job: meNow.job, level: meNow.level, jobLevel: meNow.jobLevel, stats: meNow.stats, c2Job: (meNow.c2info && meNow.c2info.jobLevel) || 50, c2Points: meNow.c2 ? Object.entries(meNow.skills || {}).filter(([k]) => k.startsWith(meNow.c2 + '_')).reduce((t, [, v]) => t + v, 0) + ((meNow.c2info && meNow.c2info.points) || 0) : 0, guild: meNow.guildLevel || 0, basics: meNow.skills, mode: cGoal.value === 'boss' ? 'boss' : 'farm', pack: +pack.value || 4, packSet: pack.dataset.touched === '1',
        target: cGoal.value === 'boss' ? cBoss.value : '', goal: cGoal.value, stars: +cStars.value, combos: true, acc: accId,
        loadout: { ...(meNow.loadout || {}), wRefine: meNow.wRefine, sRefine: meNow.sRefine },
        build: { skills: meNow.skills, evo: meNow.evo, traits: meNow.traits, c2tr: meNow.c2tr || {}, hotbar: [], c2: meNow.c2 || '' } };
      if (cMine.checked && meNow.ownedCards && meNow.ownedCards.length) q.owned = meNow.ownedCards;
      if (cNoCrit.checked) q.noCrit = true;
      if (cDup.checked) q.allowDup = true;
      try { cOut.replaceChildren(...cardsView(await dash.invoke('lab-cards', q), q.goal)); } catch (e) { cOut.replaceChildren(el('p', {}, '✖ ' + e.message)); }
      cGo.disabled = false;
    };
    cardPane.append(
      el('p', { class: 'hint' }, 'จัดการ์ดให้บิลด์สกิลที่ตัวละครใช้อยู่ตอนนี้ (อ่านจากเกมทุกครั้งที่กด) · ใช้เฉพาะการ์ดที่มีจริง (ที่ใส่อยู่ + ในกระเป๋า) จำนวนและดาวตามจริง · รวมเกียร์และ affix ที่ใส่อยู่'),
      el('div', { class: 'lab-form' }, el('label', {}, 'เป้าหมาย ', cGoal), el('label', {}, 'เป้า ', cBoss),
        el('label', {}, cMine, ` เฉพาะการ์ดที่มี (${owned.length} ชนิด)`), el('label', {}, cNoCrit, ' ไม่เอาการ์ดคริ'), el('label', { title: 'เกมนับการ์ดใบเดียวกัน ใบที่ 2 ได้ 50% ใบที่ 3 ได้ 25% ใบที่ 4 ไม่ได้อะไร และไม่นับเข้าเซ็ต' }, cDup, ' ใส่การ์ดซ้ำได้'), el('label', {}, 'ดาว (ถ้าใช้ทุกใบในเกม) ', cStars)),
      cGo, cOut);

    // ---- tab: the character as it is right now, re-read every 10 s ----
    const lBoss = el('select', {}, ...[...boss.options].map((o) => el('option', { value: o.value }, o.textContent)));
    const lOut = el('div', {}); let lPrev = null; let lTimer = null;
    const lTick = async () => {
      if (livePane.hidden || $('#modal').hidden) return;
      const m2 = await dash.invoke('lab-me', accId); if (!m2) { lOut.replaceChildren(el('p', {}, 'ตัวละครไม่ได้ออนไลน์')); return; }
      let pr; try { pr = await dash.invoke('lab-predict', { weights: true, job: m2.job, level: m2.level, jobLevel: m2.jobLevel, stats: m2.stats, basics: m2.skills, target: lBoss.value, guild: m2.guildLevel || 0, c2Job: (m2.c2info && m2.c2info.jobLevel) || 50, acc: accId, loadout: { ...(m2.loadout || {}), wRefine: m2.wRefine, sRefine: m2.sRefine }, current: { skills: m2.skills, evo: m2.evo, traits: m2.traits, c2: m2.c2, c2tr: m2.c2tr || {} } }); } catch (e) { lOut.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
      const d = lPrev ? pr.withCombos - lPrev : 0; lPrev = pr.withCombos;
      // the real damage per second the character is doing right now (its own hits over the last minute)
      let det = null; try { det = await dash.invoke('detail', accId); } catch { det = null; }
      const realNow = det && det.rates ? Math.round(det.rates.dpsNow || 0) : 0;
      const calcNow = (pr.calib && pr.calib.withCombos) || pr.packDps || pr.withCombos;
      const tgt = det && det.stats ? (det.stats.target || '') : '';
      const sh = pr.sheet || {};
      lOut.replaceChildren(...[
        pr.useless && pr.useless.length ? el('div', { class: 'hint warnline' }, `⚠ แต้มที่ไม่เพิ่มดาเมจตอนตีบอส: ${pr.useless.map((x) => `${x.name} ${x.points} แต้ม (${x.why || 'ไม่เพิ่มดาเมจ'})`).join(' · ')} · ย้ายไปลงสกิลที่ใช้ตีได้ (ดูผล "หาบิลด์" ด้านล่าง) · ถ้าเป็นสกิลเอาตัวรอด (HP/ป้องกัน) อาจตั้งใจเก็บไว้`) : null,
        el('div', { class: 'lab-row' }, el('b', { class: 'lab-score' }, `DPS ตอนนี้ ${num(pr.withCombos)}`), el('small', { class: 'hint' }, ` · ไม่รวมคอมโบ ${num(pr.dps)} · เป้า ${labPretty(pr.target.id)}${pr.packDps ? ` · ตีทั้งฝูง ${pr.pack} ตัว ≈ ${num(pr.packDps)}` : ''}`),
          d ? el('span', { class: 'chip ' + (d > 0 ? 'ok' : 'warnc') }, `${d > 0 ? '▲' : '▼'} ${num(Math.abs(d))} จากรอบก่อน`) : null, el('small', { class: 'hint' }, ` · อ่านเมื่อ ${new Date().toLocaleTimeString('th-TH')}`)),
        el('div', { class: 'lab-row lab-realnow' }, el('b', {}, realNow ? `⚔ ตีจริงตอนนี้ ${num(realNow)}/วิ` : '⚔ ตีจริงตอนนี้: ยังไม่ได้ตีใน 1 นาทีล่าสุด'),
          el('small', { class: 'hint' }, realNow ? ` · ดาเมจของตัวเองใน 1 นาทีล่าสุด (รวมทุกตัวที่โดน และช่วงเดิน/ไม่ได้ตี)${tgt ? ' · กำลังตี ' + tgt : ''} · เทียบที่คำนวณ ${num(calcNow)} = ${Math.round(realNow / Math.max(1, calcNow) * 100)}%` : ' · เปิด AUTO ให้ตีสักพัก ตัวเลขจริงจะขึ้นที่นี่')),
        pr.calib ? el('div', { class: 'lab-row' }, el('span', { class: 'chip ok' }, `ปรับตามดาเมจจริงของตัวละครนี้ ≈ ${num(pr.calib.withCombos)} DPS`), el('small', { class: 'hint' }, ` · ${pr.calib.kind === 'world' ? 'บอสโลก' : 'มอนทั่วไป'}: ดาเมจต่อฮิตจริง ×${pr.calib.k} ของสูตรเกม (รวมคริ)${pr.calib.d ? ` · DPS รวมจริง ×${pr.calib.d}` : ''} · จาก ${pr.calib.runs} รอบบันทึก · การจัดอันดับบิลด์ใช้สูตรเกม`)) : null,
        el('div', { class: 'lab-row' }, ...[['ATK', sh.atk], ['MATK', sh.matk], ['Spell Amp', sh.spellAmp, '%'], ['ลดคูลดาวน์', sh.cdr, '%'], ['ร่ายเร็ว', sh.castSpd, '%'], ['คริ', sh.crit, '%'], ['ดาเมจคริ', sh.critDmg, '%'], ['เจาะเกราะ', sh.armorPen, '%']].filter((x) => x[1] != null).map(([l, v, u]) => el('span', { class: 'chip' }, `${l} ${Number.isInteger(v) ? num(v) : v}${u || ''}`))),
        pr.weights && pr.weights.length ? el('div', { class: 'lab-row' }, el('small', {}, '📈 ควรเพิ่มอะไรต่อ (ตัวละครตอนนี้ หักเพดานเกมแล้ว): '), ...pr.weights.map((w) => el('span', { class: 'chip' + (w.gain > 0.05 ? ' ok' : ''), title: w.note || '' }, `${w.label} → ${w.gain > 0 ? '+' : ''}${w.gain}%`))) : null,
        comboBox(pr.combos) || el('span'),
        el('table', { class: 'lab-maps' }, el('tr', {}, el('th', {}, 'สกิล'), el('th', {}, 'DPS'), el('th', {}, '%')),
          ...pr.perSkill.map((x) => el('tr', {}, el('td', {}, x.name), el('td', {}, num(x.dps)), el('td', {}, pr.dps ? Math.round(x.dps / pr.dps * 100) + '%' : '-')))),
        el('div', { class: 'lab-row' }, el('small', {}, 'เกียร์: '), ...pr.gear.map((g) => el('span', { class: 'chip', title: g.affixes.join(', ') }, `${g.slot}: ${labPretty(g.id)}${g.refine ? ' +' + g.refine : ''}${g.affixes.length ? ` · ${g.affixes.length} affix` : ''}`))),
        el('div', { class: 'lab-row' }, el('small', {}, 'การ์ดที่ใส่: '), ...(pr.cards.length ? pr.cards.map((c) => el('span', { class: 'chip' }, `${labPretty(c.id)} ${'★'.repeat(c.star)}`)) : [el('small', { class: 'hint' }, 'ไม่มี')])),
        el('p', { class: 'hint' }, 'อ่านเกียร์ affix ตีบวก การ์ด สเตตัส สกิล Evolution ของตัวละครจากเกมทุก 10 วิ แล้วคำนวณใหม่ · เปลี่ยนของในเกมแล้วดูตัวเลขขยับได้ทันที')].filter(Boolean));
    };
    lBoss.addEventListener('change', () => { lPrev = null; lTick(); });
    livePane.append(el('div', { class: 'lab-form' }, el('label', {}, 'เป้า ', lBoss)), lOut, abBox(accId));
    livePane.start = () => { lTick(); clearInterval(lTimer); lTimer = setInterval(() => { if ($('#modal').hidden) { clearInterval(lTimer); return; } lTick(); }, 10000); };
  } else {
    cardPane.append(el('p', { class: 'hint' }, 'เลือกตัวละครที่ออนไลน์อยู่ เพื่อจัดการ์ดจากการ์ดที่มี'));
    livePane.append(el('p', { class: 'hint' }, 'เลือกตัวละครที่ออนไลน์อยู่เพื่อดูบิลด์ปัจจุบันแบบสด'));
  }
  const tabs = me ? [['live', '📡 บิลด์ตอนนี้ (สด)', livePane], ['skills', '🧪 หาบิลด์สกิล', skillPane], ['cards', '🃏 จัดการ์ด', cardPane]] : [['skills', '🧪 สกิล', skillPane], ['cards', '🃏 การ์ด', cardPane], ['live', '📡 บิลด์ปัจจุบัน (สด)', livePane]];
  const tabBar = el('div', { class: 'lab-tabs' }, ...tabs.map(([k, label, pane]) => el('button', { class: 'tab' + (k === tabs[0][0] ? ' on' : ''), 'data-k': k, onclick: (e) => {
    for (const [, , p2] of tabs) p2.hidden = p2 !== pane;
    for (const t of tabBar.children) t.classList.toggle('on', t === e.currentTarget);
    if (pane === livePane && livePane.start) livePane.start();
  } }, label)));
  out.replaceChildren(
    el('div', { class: 'lab-form' }, el('label', { title: 'ตัวละครที่ออนไลน์อยู่ · อ่านเลเวล สเตตัส สกิล คลาส 2 เกียร์ และการ์ดจากเกม' }, '👤 ตัวละคร ', accSel),
      me && !jobs.some((j) => j.id === me.job) ? el('small', { class: 'hint' }, `(${labPretty(me.job)} ยังไม่มีอาชีพคลาส 1 · เลือกอาชีพเพื่อจำลอง)`) : null),
    tabBar, skillPane, cardPane, livePane);
  // a real character: the live view first (what it does right now, re-read every 10 s); the others on their tab
  if (me) { skillPane.hidden = true; cardPane.hidden = true; livePane.hidden = false; if (livePane.start) livePane.start(); }
}

// real test: measure this character's own damage for 60 s (training dummy) and compare with the prediction
// real A/B test: measure the build as it is (A), change one thing in the game, measure again (B);
// the minute-by-minute spread decides whether the difference is real
function abBox(accId) {
  const mins = el('select', {}, ...[5, 10, 15, 20, 30].map((m) => el('option', { value: String(m), selected: m === 10 ? '' : null }, `${m} นาที`)));
  const label = el('input', { type: 'text', placeholder: 'เปลี่ยนอะไร เช่น ย้ายแต้ม Smite → Martyrdom', style: 'width:280px;max-width:60vw' });
  const out = el('div', { class: 'hint' }, 'ยังไม่ได้เริ่ม');
  let timer = null;
  const fmtP = (x, name) => (x ? `${name}: ${x.minutes}/${x.of} นาที · DPS ${num(x.dps)}${x.se ? ` ±${num(x.se)}` : ''} · ฆ่า ${x.killsPerMin}/นาที · ${labPretty(x.mob || '-')} @ ${x.map}${x.label ? ` · ${x.label}` : ''}` : `${name}: -`);
  const show = async () => {
    const r = await dash.invoke('ab-get', accId);
    if (!r) return;
    out.replaceChildren(el('div', {}, fmtP(r.A, 'A (แบบเดิม)')), el('div', {}, fmtP(r.B, 'B (แบบใหม่)')),
      r.verdict ? el('div', { class: r.verdict.same && r.verdict.says.startsWith('ดีขึ้น') ? 'pos' : r.verdict.says.startsWith('แย่ลง') ? 'neg' : '' }, el('b', {}, `ผล: ${r.verdict.pct > 0 ? '+' : ''}${r.verdict.pct}% (ความแกว่ง ±${r.verdict.noisePct}%) · ${r.verdict.says}`))
        : el('div', {}, r.phase ? `⏱ กำลังวัด ${r.phase} · ตีตามปกติ (เปิด AUTO ที่แมพเดิม มอนเดิม)` : 'ต้องมีข้อมูลอย่างน้อย 3 นาทีที่ได้ตีทั้ง A และ B'));
    if (!r.phase && timer && r.A && (r.B || r.A.minutes >= r.A.of)) { /* keep showing */ }
  };
  const start = async (phase) => {
    const r = await dash.invoke('ab-start', accId, phase, +mins.value, label.value);
    if (!r || !r.ok) { out.textContent = (r && r.error) || 'เริ่มไม่ได้'; return; }
    clearInterval(timer); timer = setInterval(() => { if ($('#modal').hidden) { clearInterval(timer); return; } show(); }, 5000); show();
  };
  return el('div', { class: 'lab-card' },
    el('div', { class: 'lab-top' }, el('b', {}, '🔬 ทดลองจริง (A/B): ให้เกมตัดสินว่าเปลี่ยนแล้วดีขึ้นจริงไหม')),
    el('p', { class: 'hint' }, '① กด "วัดแบบเดิม" แล้วฟาร์มตามปกติจนครบเวลา ② เปลี่ยนในเกม 1 อย่าง (แต้มสกิล ช่องลัด การ์ด) ③ กด "วัดแบบใหม่" ที่แมพเดิม มอนเดิม · โปรแกรมเทียบ DPS ช่วงที่ตีอยู่ทีละนาที แล้วบอกว่าต่างจริงหรือแค่แกว่ง'),
    el('div', { class: 'lab-row' }, el('label', {}, 'วัดนาน ', mins), label),
    el('div', { class: 'lab-row' }, el('button', { class: 'primary', onclick: () => start('A') }, '① วัดแบบเดิม (A)'), el('button', { class: 'primary', onclick: () => start('B') }, '② เปลี่ยนแล้ว วัดแบบใหม่ (B)'), el('button', { onclick: async () => { await dash.invoke('ab-stop', accId); show(); } }, '■ หยุดวัด')),
    out);
}

function measureBox(accId, me, params) {
  const out = el('div', { class: 'lab-cards' });
  const secs = el('select', {}, ...[30, 60, 120].map((n) => el('option', { value: String(n), selected: n === 60 ? '' : null }, n + ' วิ')));
  let timer = null;
  const go = el('button', { class: 'tiny', onclick: async () => {
    const st = await dash.invoke('measure-start', accId, +secs.value);
    if (!st.ok) { out.replaceChildren(el('p', {}, '✖ ' + st.error)); return; }
    go.disabled = true;
    out.replaceChildren(el('p', { class: 'hint' }, 'พร้อมวัด · เริ่มตีหุ่นฟางได้เลย (เปิด AUTO ก็ได้) · นับจากดาเมจแรก'));
    clearInterval(timer);
    timer = setInterval(async () => {
      const m = await dash.invoke('measure-get', accId);
      if (!m) return;
      if (!m.done) { out.firstChild.textContent = m.started ? `⏱ กำลังวัด ${m.secs}/${m.sec} วิ · DPS ตอนนี้ ${num(m.dps)} · ${m.hits} ฮิต` : 'พร้อมวัด · เริ่มตีหุ่นฟางได้เลย (เปิด AUTO ก็ได้) · นับจากดาเมจแรก'; return; }
      clearInterval(timer); go.disabled = false;
      const mob = Object.entries(m.mobs).sort((a, b) => b[1] - a[1])[0];
      const p = { ...params(), target: mob ? mob[0] : 'training_dummy' };
      let pr = null; try { pr = await dash.invoke('lab-predict', p); } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); return; }
      const diff = pr.dps ? Math.round((m.dps / pr.dps - 1) * 1000) / 10 : 0;
      const rows = new Set([...Object.keys(m.perSkill), ...pr.perSkill.map((x) => x.sid)]);
      out.replaceChildren(
        el('div', { class: 'lab-row' }, el('b', {}, `🎯 ของจริง ${num(m.dps)} DPS`), el('span', { class: 'chip' }, `Build Lab คาด ${num(pr.dps)}`),
          el('span', { class: 'chip ' + (Math.abs(diff) <= 5 ? 'ok' : 'warnc') }, `ต่าง ${diff > 0 ? '+' : ''}${diff}%`),
          el('small', { class: 'hint' }, ` · เป้า ${labPretty(pr.target.id)} · ${m.secs} วิ · ${m.hits} ฮิต (คริ ${m.crits})${m.pet ? ` · สัตว์เลี้ยง/อัญเชิญ ${num(Math.round(m.pet / m.secs))}/วิ (ไม่นับ)` : ''}`)),
        el('table', { class: 'lab-maps' }, el('tr', {}, ...['สกิล', 'ของจริง /วิ', 'คาด /วิ'].map((h) => el('th', {}, h))),
          ...[...rows].map((sid) => { const real = Math.round((m.perSkill[sid] || 0) / m.secs); const exp = (pr.perSkill.find((x) => x.sid === sid) || {}).dps || 0;
            return el('tr', {}, el('td', {}, sid === 'basic' ? 'โจมตีปกติ' : pr.names[sid] || labPretty(sid)), el('td', {}, num(real)), el('td', {}, num(exp))); })),
        el('p', { class: 'hint' }, `ลำดับกดที่ Build Lab คิด: ${pr.hotbar.join(' > ')} · ถ้าในเกมจัดช่องลัดต่างไป ดาเมจต่อสกิลจะต่างตาม · ต่างไม่เกิน ±5% ถือว่าตรง`));
    }, 1000);
  } }, '🎯 เริ่มวัด DPS จริง');
  return el('div', { class: 'lab-measure' },
    el('div', { class: 'lab-row' }, el('b', {}, '🎯 ทดสอบกับตัวละครจริง: '), go, secs,
      el('small', { class: 'hint' }, ' ไปห้องฝึก (Portal ข้างรูปปั้นวาร์ปในเมือง) แล้วตีหุ่นฟาง · หุ่นมุมล่างมีค่าป้องกันเท่า Pearlheart Titan')),
    out);
}

// card result: the cards, what each adds, combos on and one card away
function cardsView(r, goal) {
  const pct = (a, b) => (b ? `${a >= b ? '+' : ''}${Math.round((a / b - 1) * 100)}%` : '');
  return [
        el('div', { class: 'lab-row' }, el('b', {}, `${{ boss: '👑 การ์ด DPS ตีบอส', farm: '🌾 การ์ด DPS ฟาร์ม', gold: '💰 การ์ดฟาร์มเงิน' }[goal]} · ${r.magic ? 'สายเวท' : 'สายกายภาพ'}`),
          el('small', { class: 'hint' }, ` · ${r.cards.length}/${r.slots} ช่อง · Spirit Load ${r.load}/${r.cap} · ${r.owned ? `จากการ์ดที่มี ${r.poolSize} ชนิด` : 'จากการ์ดทุกใบในเกม ' + '★'.repeat(r.star)} · เป้า ${labPretty(r.target.id)} Lv ${r.target.level}`)),
        r.now ? el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, `การ์ดที่ใส่อยู่ตอนนี้: DPS ${num(r.now.dps)}${r.now.gold ? ` · Gold +${r.now.gold}%` : ''} → ชุดใหม่ ${num(r.after.dps)} (${pct(r.after.dps, r.now.dps)})`)) : null,
        el('div', { class: 'lab-row' }, el('span', { class: 'chip' }, `DPS ${num(r.before.dps)} → ${num(r.after.dps)} (${pct(r.after.dps, r.before.dps)})`),
          r.after.gold ? el('span', { class: 'chip' }, `Gold +${r.after.gold}%`) : null, r.after.drop ? el('span', { class: 'chip' }, `Drop +${r.after.drop}%`) : null,
          r.seeds ? el('small', { class: 'hint' }, ` · ลอง ${r.seeds} จุดเริ่ม (ทุกคอมโบ) ${num(r.evals)} แบบ`) : null),
    r.caps ? (() => { const c = r.caps; const t = [];
      if (c.crit != null && c.crit >= 99.5) t.push('คริเต็ม 100% แล้ว: การ์ดโอกาสคริไม่มีผล');
      else if (c.crit != null && c.crit >= 90) t.push(`คริ ${c.crit}% ใกล้เต็ม 100%: การ์ดคริได้ผลแค่ถึง 100%`);
      if (c.cdr != null && c.cdr >= 42) t.push(`ลด CD ${c.cdr}% เลยจุดลดผล 42% แล้ว: ใส่เพิ่มได้ผลแค่ 40% (เต็มที่ 75%)`);
      if (c.armorPen != null && c.armorPen >= 50) t.push(`เจาะเกราะ ${c.armorPen}% เลยจุดลดผล 50% แล้ว`);
      return t.length ? el('div', { class: 'hint warnline' }, '📏 เพดานของเกม (ตัวคำนวณหักให้แล้ว): ' + t.join(' · ')) : null; })() : null,
    r.compare && r.compare.base ? el('div', { class: 'hint' }, `⚖ เทียบทั้งชุด (ดาเมจเพิ่มจากไม่ใส่การ์ด): เน้นเซ็ต +${Math.round((r.compare.sets / r.compare.base - 1) * 100)}% · การ์ดดาเมจตรงสายล้วน +${Math.round((r.compare.direct / r.compare.base - 1) * 100)}% (สลับปรับแล้ว +${Math.round((r.compare.directTuned / r.compare.base - 1) * 100)}%) → เลือก${r.compare.pick === 'direct' ? 'การ์ดตรงสาย' : 'ชุดที่มีเซ็ต'} เพราะดาเมจรวมสูงกว่า`) : null,
    r.sets && r.sets.length ? el('div', { class: 'lab-row' }, el('small', {}, '🔗 คอมโบที่ติด: '), ...r.sets.map((t) => el('span', { class: 'chip combo ' + t.kind, title: t.fx.join(' · ') }, `${t.name} ${t.count} ใบ: ${t.fx.join(', ')}`))) : null,
    r.near && r.near.length ? el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, 'ขาดอีก 1 ใบ: '), ...r.near.map((t) => el('span', { class: 'chip dim' }, `${t.name} ${t.count}/${t.need}`))) : null,
        el('div', { class: 'lab-cardlist' }, ...r.cards.map((c, i) => el('div', { class: 'lab-card1' },
          el('b', {}, `${i + 1}. ${labPretty(c.id)}`), el('small', { class: 'hint' }, ` ${'★'.repeat(c.star || 1)} · ${c.role || ''} Lv ${c.level} · Load ${c.load}`),
          el('div', { class: 'hint' }, ...c.fx.flatMap((t, j) => { const gn = (c.lineGain || [])[j]; const dead = gn != null && gn <= 0.05; return [j ? ' · ' : '', el('span', { class: dead ? 'fx-dead' : '', title: gn == null ? '' : dead ? 'ค่านี้ไม่เพิ่มดาเมจของบิลด์นี้ (ลองเอาออกในตัวคำนวณของเกมแล้วดาเมจเท่าเดิม)' : 'ถ้าเอาค่านี้ออก ดาเมจลดลงเท่านี้' }, gn == null ? t : dead ? `${t} (ไม่มีผล)` : `${t} (+${gn}%)`)]; })),
          c.why && c.why.set && (c.lineGain || []).length && (c.lineGain || []).every((g) => g <= 0.05)
            ? el('div', { class: 'why' }, `🔗 ใส่เพื่อเติมเซ็ต ${c.why.set} เท่านั้น${(() => { const t = (r.sets || []).find((z) => c.why.set.startsWith(z.name)); return t ? ` (เซ็ตให้ ${t.fx.join(', ')})` : ''; })()} · ตัวการ์ดเองไม่เพิ่มดาเมจ แต่ถอดแล้วเสียเซ็ต DPS −${c.why.pct}% · เปลี่ยนเป็นการ์ดใบอื่นทีละใบแล้วไม่มีใบไหนได้ดีกว่า`)
            : null,
          c.why && !(c.why.set && (c.lineGain || []).length && (c.lineGain || []).every((g) => g <= 0.05)) ? el('div', { class: 'why' }, `${goal === 'gold' ? 'คะแนน' : 'DPS'} +${c.why.pct}%${c.why.pctGame != null && goal !== 'gold' ? ` (เครื่องคิดเลขเกม +${c.why.pctGame}% · ส่วนที่โปรแกรมประมาณเพิ่ม ${c.why.pct - c.why.pctGame >= 0 ? '+' : ''}${Math.round((c.why.pct - c.why.pctGame) * 10) / 10}%)` : ''}${c.why.skill ? ` · ช่วย ${c.why.skill} มากสุด${c.why.skillPct ? ` (+${c.why.skillPct}%)` : ''}` : ''}${c.why.set ? ` · ทำให้ครบเซ็ต ${c.why.set}` : ''}`) : null,
          c.proc ? el('div', { class: 'hint' }, '⚠ มีเอฟเฟกต์พิเศษ (proc) ที่เครื่องคิดเลขของเกมคิดแบบเฉลี่ย') : null))),
        el('p', { class: 'hint' }, goal === 'gold' ? 'คะแนนฟาร์มเงิน = ความเร็วฆ่ามอน × (1 + Gold%) × (1 + Drop%/2) · การ์ด slayer(ชนิด) แรงเฉพาะมอนชนิดนั้น (จัดตามเป้าด้านบน) ถ้าฟาร์มแมพอื่นให้เปลี่ยนเป็นการ์ดเพิ่ม ATK/MATK/INT/STR แทน' : 'จัดจากเครื่องคิดเลขของเกม (ตัวเดียวกับหน้าคำนวณดาเมจใน wiki) รวมโบนัสเซ็ตภูมิภาค · "ช่วยสกิลไหน" = สกิลที่ดาเมจหายมากสุดถ้าถอดใบนั้น · ค่าการ์ดตามดาวที่เลือก (wiki แสดง ★1) · ไม่รวมการ์ดบอสโลก')
  ].filter(Boolean);
}

// card build for one Build Lab result: best cards for boss DPS, farm DPS or gold farming
function cardBox(x) {
  const out = el('div', { class: 'lab-cards' });
  const stars = el('select', {}, ...[1, 2, 3, 4, 5].map((n) => el('option', { value: String(n) }, '★'.repeat(n))));
  const hasOwned = !!(lastLab && lastLab.owned && lastLab.owned.length);
  const onlyMine = el('input', { type: 'checkbox', checked: hasOwned ? '' : null, disabled: hasOwned ? null : '' });
  const noCrit = el('input', { type: 'checkbox' });
  const allowDup = el('input', { type: 'checkbox' });
  const run = async (goal, btn) => {
    for (const b of out.parentNode.querySelectorAll('.lab-cardbtn')) b.disabled = true;
    out.replaceChildren(el('p', { class: 'hint' }, 'กำลังลองการ์ดทุกใบในเกม ตามช่องที่เปิดและ Spirit Load…'));
    try {
      const q = { ...lastLab, build: x.build, goal, stars: +stars.value };
      if (!onlyMine.checked) delete q.owned;
      if (noCrit.checked) q.noCrit = true;
      if (allowDup.checked) q.allowDup = true;
      const r = await dash.invoke('lab-cards', q);
      out.replaceChildren(...cardsView(r, goal));
      // magic build that got crit cards: say why, and work out the same search without them to compare
      if (r.magic && r.critCards.length && !q.noCrit) {
        const why = r.sureCrit.length
          ? `สกิลเวทปกติไม่คริ (ใช้ Spell Amp แทน) · การ์ดคริช่วยเฉพาะ ${r.sureCrit.join(', ')} ที่เกมบอกว่า "คริแน่นอน" (ดาเมจ × 1 + (ดาเมจคริ − 1) × 0.6)`
          : 'สกิลเวทปกติไม่คริ (ใช้ Spell Amp แทน) · การ์ดคริในชุดนี้ช่วยโจมตีปกติและค่าอื่นของการ์ด (เช่น ดาเมจใส่บอส)';
        const cmp = el('div', { class: 'lab-crit' }, el('div', {}, '💡 ' + why), el('div', { class: 'hint' }, 'กำลังลองชุดที่ไม่มีการ์ดคริเทียบ…'));
        out.insertBefore(cmp, out.children[2] || null);
        try {
          const r2 = await dash.invoke('lab-cards', { ...q, noCrit: true });
          const d = r.after.dps ? Math.round((r2.after.dps / r.after.dps - 1) * 1000) / 10 : 0;
          cmp.lastChild.replaceWith(el('div', {}, `ถ้าไม่ใส่การ์ดคริ: DPS ${num(r2.after.dps)} (${d > 0 ? '+' : ''}${d}%) · ใช้ ${r2.cards.map((c) => labPretty(c.id)).join(', ')}`,
            el('button', { class: 'tiny', onclick: () => out.replaceChildren(...cardsView(r2, goal)) }, 'ดูชุดนี้')));
        } catch { cmp.lastChild.textContent = ''; }
      }
    } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    for (const b of out.parentNode.querySelectorAll('.lab-cardbtn')) b.disabled = false;
  };
  return el('div', {},
    el('div', { class: 'lab-row' }, el('small', {}, '🃏 จัดการ์ดให้บิลด์นี้: '),
      el('button', { class: 'tiny lab-cardbtn', 'data-goal': 'boss', onclick: (e) => run('boss', e.target) }, '👑 DPS ตีบอส'),
      el('button', { class: 'tiny lab-cardbtn', 'data-goal': 'gold', onclick: (e) => run('gold', e.target) }, '💰 ฟาร์มเงิน'),
      el('label', { class: 'hint', title: 'ไม่ใช้การ์ดที่ค่าหลักเป็นโอกาสคริ / ดาเมจคริ (สายเวทปกติไม่คริ)' }, noCrit, ' ไม่เอาการ์ดคริ'),
      el('label', { class: 'hint', title: 'เกมนับการ์ดใบเดียวกัน ใบที่ 2 ได้ 50% ใบที่ 3 ได้ 25% ใบที่ 4 ไม่ได้อะไร และไม่นับเข้าเซ็ต · ปกติไม่ใส่ซ้ำ' }, allowDup, ' ใส่การ์ดซ้ำได้'),
      el('label', { class: 'hint', title: hasOwned ? 'จัดจากการ์ดที่ตัวละครมี (ใส่อยู่ + ในกระเป๋า) จำนวนและดาวตามจริง' : 'ต้องวิเคราะห์จากตัวละครที่ออนไลน์อยู่' }, onlyMine, ' เฉพาะการ์ดที่มี'),
      el('small', { class: 'hint' }, ' · ดาว (ถ้าใช้ทุกใบ) '), stars),
    out);
}

// every stat the game computes for this build, and which stat adds the most damage
function statBox(sh, w) {
  if (!sh) return null;
  const chip = (label, v, unit = '') => (v == null ? null : el('span', { class: 'chip' }, `${label} ${typeof v === 'number' ? (Number.isInteger(v) ? num(v) : v) : v}${unit}`));
  return el('details', { class: 'lab-order' },
    el('summary', {}, `📈 ค่าสเตตัส และค่าที่คุ้มที่สุด${w && w.length && w[0].gain != null ? ` · ${w[0].label} = DPS +${w[0].gain}%` : ''}`),
    el('div', { class: 'lab-row' }, ...[chip('ATK', sh.atk), chip('MATK', sh.matk), chip('Spell Amp', sh.spellAmp, '%'), chip('ลดคูลดาวน์', sh.cdr, '%'), chip('ร่ายเร็ว', sh.castSpd, '%'),
      chip('คริ', sh.crit, '%'), chip('ดาเมจคริ', sh.critDmg, '%'), chip('ความเร็วโจมตี', sh.aspd), chip('เจาะเกราะ', sh.armorPen, '%'), chip('HIT', sh.hit), chip('HP', sh.maxHp)].filter(Boolean)),
    w && w.length ? el('table', { class: 'lab-maps' }, el('tr', {}, el('th', {}, 'ถ้าเพิ่ม'), el('th', {}, 'DPS'), el('th', {}, '')),
      ...w.map((x) => el('tr', {}, el('td', {}, x.label), el('td', { class: 'gold' }, x.gain == null ? '-' : (x.gain > 0 ? '+' : '') + x.gain + '%'), el('td', { class: 'hint' }, x.note || '')))) : null,
    el('p', { class: 'hint' }, 'ค่าจากเครื่องคิดเลขของเกม (รวมเกียร์ การ์ด ตีบวก และสกิลพาสซีฟ) · ตาราง = ใส่ค่านั้นเพิ่มเข้าไปจริงแล้วคำนวณใหม่ทั้งบิลด์ (รวมคอมโบ) · สเตตัสหลัก +10 แต้ม · ค่า % ตามที่เขียน'));
}

// combo conditions counted in the score: target under status, Hunter's Mark, Chill -> Shatter
function comboBox(parts) {
  if (!parts || !parts.length) return null;
  const line = (c) => {
    if (c.k === 'status') return c.full > 0
      ? `🧊 เป้าติดสถานะ ${c.up}% ของเวลา (จาก ${c.skills.join(', ')}) · ถ้าติดตลอด +${c.full}% → ได้จริง +${c.gain}%`
      : `🧊 เป้าติดสถานะ ${c.up}% ของเวลา (จาก ${c.skills.join(', ')}) · ยังไม่มีเกียร์/การ์ด/สกิลที่แรงขึ้นใส่เป้าติดสถานะ (เช่น affix "ดาเมจใส่เป้าติดดีบัฟ", การ์ด Bramble Pact)`;
    if (c.k === 'mark') return `🎯 Hunter's Mark ค้างได้ ${c.stacks}/${c.cap} สแตก${c.apex ? ' · Apex ทั้งปาร์ตี้ +30%' : ''} → ดาเมจ +${c.gain}%`;
    if (c.k === 'shatter') return c.boss ? `❄️ Chill → Shatter: บอส/มินิบอสไม่แข็ง จึงไม่มี Shatter (ได้แค่สโลว์จาก ${c.skills.join(', ')})` : `❄️ Chill → Shatter ~${c.perMin} ครั้ง/นาที ต่อมอน 1 ตัว (จาก ${c.skills.join(', ')}) → ดาเมจ +${c.gain}% (ไม่นับระเบิดรอบตัว 30%)`;
    if (c.k === 'proc') return `🎲 Proc จากเกียร์ → ดาเมจ +${c.gain}% (${c.list.join(' · ')})`;
    if (c.k === 'res') {
      const bits = [c.stacks != null ? `ค้าง ${c.stacks}/${c.cap}` : '', c.perMin != null ? `${c.perMin} ครั้ง/นาที` : '', c.up != null ? `ติด ${c.up}% ของเวลา` : '', c.spend ? 'มีสกิลใช้สแตก' : ''].filter(Boolean).join(' · ');
      return `⚡ ${c.name}${bits ? ' ' + bits : ''} → ดาเมจ +${c.gain}%`;
    }
    return c.name;
  };
  return el('div', { class: 'lab-crit' }, el('b', {}, '🔗 คอมโบที่นับในคะแนน'), ...parts.map((c) => el('div', {}, line(c))));
}

// skill order: ranking, the opening sequence as the game casts it
function orderBox(o) {
  if (!o || !o.rank) return null;
  const sec = (ms) => (ms ? (ms / 1000).toFixed(ms % 1000 ? 1 : 0) + ' วิ' : '-');
  return el('details', { class: 'lab-order' },
    el('summary', {}, `⚔️ อันดับสกิลและลำดับการปล่อย · ${o.rank.filter((r) => r.sid !== 'basic').map((r) => r.name).slice(0, 3).join(' > ')}`),
    el('div', { class: 'lab-row' }, el('small', {}, [
      o.naive ? `ลำดับช่องลัดนี้แรงกว่าเรียงตามดาเมจต่อครั้ง (${o.naive.order.join(' > ')}) ${o.naive.gain >= 0 ? '+' : ''}${o.naive.gain}%` : 'ลำดับนี้ตรงกับการเรียงตามดาเมจต่อครั้ง',
      o.filler ? ` · ${o.filler} เป็นสกิลตีถี่ เติมช่องว่างระหว่างคูลดาวน์ของสกิลแรง` : '',
    ].join(''))),
    el('div', { class: 'lab-row' }, el('small', {}, 'ลำดับช่วงเปิด 15 วิแรก (เกมกดตามช่องลัด สกิลไหนพร้อมก่อนในลำดับ กดก่อน): ')),
    el('div', { class: 'lab-timeline' }, ...o.opener.map((c) => el('span', { class: 'tl' }, el('small', {}, c.t + 's'), ' ', c.name))),
    el('table', { class: 'lab-maps' },
      el('tr', {}, ...['#', 'สกิล', 'ช่อง', '% ดาเมจ', 'ดาเมจ/ครั้ง', 'ครั้ง/นาที', 'คูลดาวน์', 'ร่าย', 'ชาร์จ'].map((h) => el('th', {}, h))),
      ...o.rank.map((r, i) => el('tr', {}, el('td', {}, String(i + 1)), el('td', {}, r.name), el('td', {}, r.slot > 0 ? String(r.slot) : '-'),
        el('td', { class: 'gold' }, r.share + '%'), el('td', {}, num(r.perCast), r.dot ? el('small', { class: 'hint' }, ` (DoT ${r.dot}%)`) : ''), el('td', {}, String(r.casts)), el('td', {}, sec(r.cdMs)), el('td', {}, sec(r.castMs)), el('td', {}, String(r.charges))))),
    el('p', { class: 'hint' }, 'อันดับและครั้ง/นาทีคิดจากนาทีที่ 2–3 (ตีบอสยาว) · ลำดับช่วงเปิดคือ 15 วิแรก · จำลองแบบเดียวกับเครื่องคิดเลขของเกม: ทุก 50 ms ถ้าไม่ได้ร่ายอยู่ กดสกิลแรกในช่องลัดที่พร้อม ไม่งั้นตีปกติ · ชาร์จที่ 2 ขึ้นไปแรง 50% · ดาเมจ/ครั้งรวม DoT (เลือดไหล/พิษ/เผา ทุกติ๊กจนหมดเวลา) แล้ว วงเล็บคือส่วนที่มาจาก DoT · ลำดับช่องลัดที่แสดงคือแบบที่ดีที่สุดจากการลองทุกลำดับ'));
}

// which map earns the most silver per hour with this build (+ the cards picked for gold farming, if any)
function mapBox(x) {
  const out = el('div', { class: 'lab-cards' });
  const pack = el('input', { type: 'number', min: '1', max: '8', value: '3', style: 'width:52px' }); pack.addEventListener('change', () => { pack.dataset.touched = '1'; });
  const go = el('button', { class: 'tiny', onclick: async () => {
    go.disabled = true; out.replaceChildren(el('p', { class: 'hint' }, 'กำลังคำนวณทุกแมพ…'));
    try {
      const r = await dash.invoke('lab-maps', { ...lastLab, build: x.build, pack: +pack.value, packSet: pack.dataset.touched === '1' });
      const lvl = lastLab.level;
      out.replaceChildren(
        el('p', { class: 'hint' }, `คิดจากดาเมจของบิลด์นี้กับมอนแต่ละชนิดในแมพ (เครื่องคิดเลขของเกม) · Silver/ตัว × Gold% · ฆ่า/ชม. จำกัดด้วยเวลาเกิดใหม่ · ${r.total} แมพ ใน ${(r.ms / 1000).toFixed(1)} วิ`),
        el('table', { class: 'lab-maps' },
          el('tr', {}, ...['#', 'แมพ', 'เลเวล', 'Silver/ชม.', 'ฆ่า/ชม.', 'Silver/ตัว', 'โดนตีกี่ทีตาย', 'มอน'].map((h) => el('th', {}, h))),
          ...r.rows.map((m, i) => el('tr', { class: (m.hitsToDie != null && m.hitsToDie < 6 ? 'risky' : '') + (lvl > m.band[1] + 10 ? ' low' : '') },
            el('td', {}, String(i + 1)), el('td', {}, m.name), el('td', {}, `${m.band[0]}–${m.band[1]}`), el('td', { class: 'gold' }, num(m.silverHr)),
            el('td', {}, num(m.killsHr)), el('td', {}, num(m.perKill)), el('td', {}, m.hitsToDie == null ? '-' : String(m.hitsToDie) + (m.hitsToDie < 6 ? ' ⚠' : '')),
            el('td', { class: 'hint' }, m.mobs.map((o) => `${labPretty(o.type)} ×${o.count} (${o.ttk}s)`).join(', '))))),
        el('p', { class: 'hint' }, 'ตัวเลขเป็นค่าประมาณเพื่อเทียบแมพ (ไม่รวมของดรอป/การ์ดดรอป, เวลาเดินคิด 1.5 วิ/ตัว) · ⚠ = โดนตีไม่กี่ทีก็ตาย'));
    } catch (e) { out.replaceChildren(el('p', {}, '✖ ' + e.message)); }
    go.disabled = false;
  } }, '🗺 หาแมพทำเงิน');
  return el('div', {}, el('div', { class: 'lab-row' }, go, el('small', { class: 'hint' }, ' มอนต่อกลุ่มที่ลากตีพร้อมกัน '), pack), out);
}

function renderLab(box, r) {
  const best = r.results[0];
  const cur = r.current;
  const head = el('p', {}, `${r.mode === 'boss' ? '👑 ตีบอส' : '🌾 ฟาร์ม'} · เป้า ${labPretty(r.target.id)} Lv ${r.target.level}${r.fight ? ` · คิดจากการสู้ ${r.fight.sec >= 120 ? (r.fight.sec / 60).toFixed(1) + ' นาที' : r.fight.sec + ' วิ'} (${r.fight.why})` : ''} · ${r.full ? 'รวมการ์ดชุดที่จัดให้' + (r.loadout ? ' + เกียร์ของตัวละคร' : '') : r.loadout ? 'รวมเกียร์+การ์ดของตัวละคร' : 'ไม่รวมเกียร์/การ์ด'}${r.evals ? ` · ลอง ${num(r.evals)} แบบ` : ''} ใน ${(r.ms / 1000).toFixed(1)} วิ`);
  const card = (x, i) => el('div', { class: 'lab-card' + (i === 0 ? ' best' : '') },
    x.extended && x.extended.length ? el('div', { class: 'hint okline' }, `⬆ อัปคลาส 1 ให้เต็มเพื่อต่อยอดคลาส 2 (คุ้มกว่า): ${x.extended.join(' · ')}`) : null,
    x.freed && x.freed.length ? el('div', { class: 'hint okline' }, `♻ ไม่ลงแต้มสกิลที่ไม่เพิ่มดาเมจ · เก็บแต้มไว้: ${x.freed.join(' · ')}`) : null,
    x.measured ? el('div', { class: 'hint ' + (x.unmeasured && x.unmeasured.length ? 'warnline' : 'okline') }, x.unmeasured && x.unmeasured.length ? `⚠ สกิลที่ยังไม่เคยวัดดาเมจจริง: ${x.unmeasured.join(', ')} · ตัวเลขของสกิลพวกนี้มาจากสูตรอย่างเดียว ลองใช้จริงแล้ววัดด้วย A/B ก่อนเชื่อ` : '✓ ทุกสกิลในช่องลัดปรับตามดาเมจจริงของตัวละครนี้แล้ว') : null,
    el('div', { class: 'lab-top' }, el('b', {}, `${i === 0 ? '🏆 ' : ''}${x.c2 ? 'คลาส 2 · ' + x.c2 : 'คลาส 1 อย่างเดียว'}`),
      el('span', { class: 'lab-score' }, `${r.mode === 'boss' ? (x.fightSec ? `DPS เฉลี่ย ${x.fightSec >= 120 ? (x.fightSec / 60).toFixed(1) + ' นาที' : x.fightSec + ' วิ'}` : x.window === 'burst' ? 'DPS 60 วิแรก' : 'DPS ยาว') : 'ดาเมจรวม/วิ'} ${num(x.score)}`),
      x.fightSec && x.bossHp && r.mode === 'boss' && !/^training/.test(r.target.id) ? el('small', { class: 'hint' }, ` · ล้มบอสคนเดียวใน ~${Math.round(x.bossHp / Math.max(1, x.score))} วิ`) : null,
      r.mode === 'boss' ? el('small', { class: 'hint', title: 'ดาเมจยาว = นาทีที่ 2–3 ของการตีต่อเนื่อง (ไม่มีช่วงเปิดที่ทุกสกิลพร้อมพร้อมกัน) · 60 วิแรก = รวมช่วงเปิด' },
        x.window === 'burst' ? ` · ดาเมจยาว ${num(x.sustained)}` : ` · 60 วิแรก ${num(x.dps)} (ช่วงเปิด +${x.sustained ? Math.round((x.dps / x.sustained - 1) * 100) : 0}%)`) : null,
      i ? el('small', { class: 'hint' }, ` (${Math.round((x.score / best.score - 1) * 100)}%)`) : null,
      cur ? el('small', { class: x.score >= cur.score ? 'pos' : 'neg' }, ` · ${x.score >= cur.score ? '+' : ''}${Math.round((x.score / Math.max(1, cur.score) - 1) * 100)}% จากบิลด์ปัจจุบัน`) : null),
    el('div', { class: 'lab-row' }, el('small', { class: 'hint' }, `แต้มคลาส 1 ${x.points.c1}/${x.points.c1Max}${x.c2 ? ` · แต้มคลาส 2 ${x.points.c2}/${x.points.c2Max}` : ''}`)),
    x.extras && x.extras.length ? el('details', { class: 'lab-ext', open: x.extras.some((e) => e.used > 0) ? '' : null },
      el('summary', {}, `⬆ ต่อยอดคลาส 2 · ใช้ ${x.extras.reduce((t, e) => t + e.used, 0)} แต้มคลาส 2 กับ ${x.extras.filter((e) => e.used > 0).length} สกิล`),
      el('p', { class: 'hint' }, 'ต้องอัปสกิลคลาส 1 ให้เต็มก่อน (เช่น 10/10) แล้วเลเวลที่เกินเต็มใช้แต้มคลาส 2 ทีละ 1 · ตัวเลข "เป้า" คือเลเวลที่ควรอัปในหน้าสกิลของเกม (รวมส่วนคลาส 1)'),
      el('table', { class: 'lab-maps' },
        el('tr', {}, ...['สกิล', 'ควรอัปถึง', 'คลาส 1', 'ต่อยอด', 'หมายเหตุ'].map((h) => el('th', {}, h))),
        ...x.extras.map((e) => el('tr', {},
          el('td', {}, e.name + (e.game ? ' → ' + e.game : '')),
          el('td', { class: e.used ? 'gold' : '' }, `${e.lv}/${e.base + e.plus}`),
          el('td', {}, `${Math.min(e.lv, e.base)}/${e.base}`),
          el('td', {}, e.used ? `+${e.used}/${e.plus}` : `0/${e.plus}`),
          el('td', {}, e.used ? (e.used >= e.plus ? 'เต็ม' : '') : e.why || ''))))) : null,
    el('div', { class: 'lab-row' }, el('small', {}, 'ช่องลัด (ลำดับกด): '), x.hotbar.map((h, k) => el('span', { class: 'chip' }, `${k + 1}. ${h}`))),
    el('div', { class: 'lab-skills' }, ...x.skills.sort((a, b) => (a.c2 - b.c2) || a.line.localeCompare(b.line)).map((s) => el('div', { class: 'lab-sk' + (s.c2 ? ' c2' : '') + (s.passive ? ' pas' : '') },
      el('span', {}, s.name), el('b', {}, `${s.lv}/${s.max}`), s.ext ? el('small', { class: 'evo', title: 'เลเวลเกินเต็มของสกิลคลาส 1 ใช้แต้มคลาส 2 (ต้องเต็มก่อน และ Job คลาส 2 ถึงเกณฑ์)' }, '⬆ ต่อยอดคลาส 2 ' + (s.ext.trim() || '+' + (s.lv - s.base))) : null, s.evo ? el('small', { class: 'evo' }, 'Evo ' + s.evo) : null, el('small', { class: 'hint' }, s.line)))),
    x.traits.length ? el('div', { class: 'lab-row' }, el('small', {}, 'Trait: '), ...x.traits.map((t) => el('span', { class: 'chip' }, t))) : null,
    el('div', { class: 'lab-row' }, el('small', {}, 'สัดส่วนดาเมจ: '), ...x.share.map((s) => el('span', { class: 'chip' }, `${s.name} ${s.pct}%`))),
    comboBox(x.combos),
    statBox(x.sheet, x.weights),
    orderBox(x.order),
    cardBox(x),
    mapBox(x),
    x.notes.length ? el('details', {}, el('summary', {}, `ข้อสังเกต ${x.notes.length} ข้อ (ส่วนที่เครื่องคิดเลขของเกมไม่ได้นับ)`), ...x.notes.map((n) => el('div', { class: 'hint' }, '· ' + n))) : null);
  box.replaceChildren(...[head,
    cur ? el('p', { class: 'hint' }, `บิลด์ปัจจุบัน: ${r.mode === 'boss' ? 'DPS' : 'ดาเมจรวม/วิ'} ${num(cur.score)}`) : null,
    cur && cur.tuned ? tunedBox(cur.tuned) : null,
    ...r.results.map(card)].filter(Boolean));
}

// the gentle way: the character's own build with a few single points moved, backed by its real hits
function tunedBox(t) {
  const head = el('b', {}, '🔧 ปรับจากบิลด์ที่ใช้อยู่ (ทีละแต้ม)');
  if (!t.moves.length) {
    return el('div', { class: 'lab-card best' }, el('div', { class: 'lab-top' }, head),
      el('p', {}, t.realBacked ? '✅ บิลด์ปัจจุบันดีแล้ว: ย้ายแต้มจุดไหนก็ไม่แรงขึ้นเกิน 1% ตามดาเมจจริงที่บันทึกไว้' : 'บิลด์ปัจจุบันดีแล้วตามสูตรเกม (ยังไม่มีดาเมจจริงของตัวละครนี้ · ฟาร์ม/ตีบอสสัก 10 นาทีแล้วคำนวณใหม่จะแม่นขึ้น)'));
  }
  return el('div', { class: 'lab-card best' }, el('div', { class: 'lab-top' }, head, el('span', { class: 'lab-score pos' }, ` +${t.gainPct}%`)),
    el('p', { class: 'hint' }, t.realBacked ? 'คิดจากดาเมจจริงต่อสกิลของตัวละครนี้ · ทำตามทีละขั้นแล้ววัดใหม่ได้' : 'คิดจากสูตรเกม (ยังไม่มีดาเมจจริงของตัวละครนี้)'),
    el('ol', {}, ...t.moves.map((m) => el('li', {}, `ย้าย 1 แต้ม: ${m.fromName} → ${m.toName} (+${m.gainPct}%)`, m.guess ? el('small', { class: 'warnc', title: 'สกิลนี้ยังไม่เคยใช้ จึงไม่มีดาเมจจริง ตัวเลขมาจากสูตรเกมซึ่งมักคลาด · ลองแล้วตีจริงสัก 10 นาทีเพื่อยืนยัน' }, ' ⚠ ยังไม่มีข้อมูลจริง') : null))),
    el('div', { class: 'lab-row' }, el('small', {}, 'ช่องลัดหลังปรับ: '), ...(t.hotbar || []).map((h, k) => el('span', { class: 'chip' }, `${k + 1}. ${h}`))));
}

async function openMarketSell(opt = {}) {
  const gear = tradableGear().filter((g) => !opt.only || opt.only.includes(g.id));
  const minBox = el('input', { type: 'number', min: '0', step: '100000', value: String(opt.only ? 0 : (state && state.settings.valuableMinGold) || 1000000) });
  const list = el('div', { class: 'gearlist mklist' });
  const out = el('div', { class: 'results' });
  const rows = gear.map((g) => {
    const box = el('input', { type: 'checkbox' });
    const price = el('input', { type: 'number', min: '1', step: '1000', class: 'mkprice', placeholder: 'ราคา' });
    const info = el('small', { class: 'hint' }, 'กำลังถามราคาตลาด…');
    const res = el('small', {});
    const row = el('div', { class: 'mkrow' }, box, el('span', { class: 'rar r-' + (g.rarity || 'normal') }, (RARITIES.find((r) => r[0] === g.rarity) || RARITIES[0])[1]),
      el('div', { class: 'bn' }, g.name, info, res), price, el('span', { class: 'hint' }, 'G'));
    return { g, box, price, info, res, row, filled: false };
  });
  list.replaceChildren(...(rows.length ? rows.map((r) => r.row) : [el('p', {}, 'ไม่มีอุปกรณ์ที่ลงขายได้ (ของที่ล็อกหรือผูกตัวไม่แสดง)')]));
  const G = (n) => num(n) + ' G';
  const fill = () => {
    const ip = (detail && detail.itemPrices) || {};
    const min = Number(minBox.value) || 0;
    for (const r of rows) {
      const p = ip[r.g.id];
      if (!p || r.filled) continue;
      r.filled = true;
      r.info.textContent = p.price ? `ตลาด: ถูกสุด ${G(p.price)}${p.last ? ` · ขายล่าสุด ${G(p.last)}` : ''} · วางขาย ${p.stock} · ขาย 7 วัน ${p.vol7}` : 'ยังไม่มีคนขายชนิด+เกรดนี้ในตลาด ตั้งราคาเอง';
      if (p.price) r.price.value = String(Math.max(1, (p.basis === 'listed' ? p.price - 1 : p.price))); // just under the cheapest
      r.box.checked = !!p.price && p.price >= min;
    }
  };
  minBox.addEventListener('change', () => { for (const r of rows) r.filled = false; fill(); });
  const go = el('button', { class: 'primary', onclick: async () => {
    const pick = rows.filter((r) => r.box.checked);
    if (!pick.length) { out.replaceChildren(el('p', {}, 'เลือกของที่จะลงขายก่อน')); return; }
    const bad = pick.find((r) => !(Number(r.price.value) >= 1));
    if (bad) { out.replaceChildren(el('p', {}, `ใส่ราคาให้ ${bad.g.name} ก่อน`)); return; }
    const total = pick.reduce((t, r) => t + Number(r.price.value), 0);
    if (!confirm(`ลงขายในตลาดกลาง ${pick.length} ชิ้น รวม ${G(total)}?\n${pick.map((r) => `${r.g.name}: ${G(Number(r.price.value))}`).join('\n')}\n(ภาษีตลาดตามกฎเกม · ยกเลิกประกาศได้ในหน้าตลาดของเกม)`)) return;
    for (const r of pick) {
      r.res.textContent = ' · กำลังลงขาย…';
      // eslint-disable-next-line no-await-in-loop
      const x = await dash.invoke('game-cmd', selected, 'marketList', { itemId: r.g.id, qty: 1, unitPrice: Number(r.price.value) });
      r.res.textContent = x && x.ok ? (x.unsure ? ' · ⏳ ส่งแล้ว รอตลาดยืนยัน (~5 นาที)' : ' · ✔ ส่งลงขายแล้ว ขึ้นตลาดใน ~5 นาที') : ` · ✖ ${(x && x.error) || 'ไม่สำเร็จ'}`;
      r.res.className = x && x.ok ? 'res ok' : 'res bad';
      r.box.checked = false;
    }
    out.replaceChildren(el('p', { class: 'hint' }, 'เสร็จแล้ว · ตลาดใช้เวลาราว 5 นาทีกว่าประกาศจะขึ้น โปรแกรมจะเช็ค "ประกาศของฉัน" ให้เองหลังครบเวลา ดูสถานะได้ในช่อง 💎 ของมีค่า'));
  } }, 'ลงขายที่เลือก');
  openModal('🏪 ลงขายตลาดกลาง', [
    el('p', { class: 'hint' }, 'ราคาตลาดตามชนิด+เกรด (ถูกสุดตอนนี้ / ขายจริงล่าสุด) · ราคาตั้งต้น = ต่ำกว่าถูกสุด 1 G แก้ได้ · ติ๊กให้อัตโนมัติเมื่อมูลค่าตั้งแต่'),
    el('label', {}, 'ติ๊กอัตโนมัติเมื่อราคาตลาด ≥ ', minBox, ' G'),
    list, rows.length ? go : null, out,
  ]);
  if (rows.length) {
    await dash.invoke('game-cmd', selected, 'priceAll', {});
    for (let i = 0; i < 20 && rows.some((r) => !r.filled); i++) { await refreshDetail(); fill(); await new Promise((r) => setTimeout(r, 700)); } // eslint-disable-line no-await-in-loop
    for (const r of rows) if (!r.filled) r.info.textContent = 'ตลาดไม่ตอบ ตั้งราคาเอง';
  }
}

// skill spam: which hotbar keys to press over and over, and how often
function openSpam(a) {
  const cur = a.spam || { on: false, slots: [], everyMs: 300 };
  const picks = new Set(cur.slots || []);
  const chips = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
    const b = el('button', { class: 'ctl spam-key' + (picks.has(n) ? ' on' : ''), title: n === 9 ? 'ช่อง 9 = Ultimate ของคลาส 2' : `ปุ่ม ${n} บนแถบสกิล` }, n === 9 ? '9 (Ult)' : String(n));
    b.onclick = () => { if (picks.has(n)) picks.delete(n); else picks.add(n); b.classList.toggle('on', picks.has(n)); };
    return b;
  });
  // the skill on each slot (read from the game's AUTO settings): "2 · Ice Lance"
  dash.invoke('spam-slots', a.id).then((list) => {
    for (const x of list || []) { const b = chips[x.slot - 1]; if (!b || !x.name) continue; b.textContent = `${x.slot} · ${x.name}${x.auto ? '' : ' (AUTO ไม่ใช้)'}`; b.title = x.auto ? 'AUTO ของเกมใช้สกิลนี้อยู่' : 'ปิดไว้ในตั้งค่า AUTO ของเกม: สแปมจะกดให้เอง'; }
  }).catch(() => {});
  const speed = el('select', {}, ...[[200, 'ถี่มาก (0.2 วิ)'], [300, 'ปกติ (0.3 วิ)'], [500, 'ช้า (0.5 วิ)'], [1000, 'ช้ามาก (1 วิ)']].map(([v, t]) => el('option', { value: String(v), selected: Number(cur.everyMs) === v ? '' : null }, t)));
  const save = async (on) => { await dash.invoke('spam-set', a.id, { on, slots: [...picks], everyMs: +speed.value }); closeModal(); }; // the button on the account shows the new state
  openModal(`⚡ สแปมสกิล · ${a.name}`, [
    el('p', { class: 'hint' }, 'เลือกปุ่มบนแถบสกิลของเกมที่จะกดซ้ำๆ ให้ร่ายทันทีที่คูลดาวน์หมด (AUTO ของเกมยังเลือกเป้าและเดินเอง) · ปุ่มที่ไม่เลือก AUTO ใช้ตามปกติ'),
    el('div', { class: 'ctl-row' }, ...chips),
    el('label', {}, 'ความถี่ ', speed),
    el('p', { class: 'hint' }, 'กดเฉพาะตอน AUTO เปิดและกำลังฟาร์ม/ตีบอส/ทำค่าหัว · หยุดเองตอนตาย พักจอ เดินทาง กลับจุดฟาร์ม หรือมีช่องพิมพ์แชทเปิดอยู่ · ตั้งต่อบัญชี จำไว้หลังปิดโปรแกรม'),
    el('div', { class: 'ctl-row' },
      el('button', { class: 'primary', onclick: () => save(true) }, picks.size || cur.on ? '✓ เปิด / บันทึก' : '✓ เปิด'),
      el('button', { class: 'ctl', onclick: () => save(false) }, '■ ปิด')),
  ]);
}

function renderControls(a) {
  const s = (detail && detail.stats) || {};
  const live = a.status === 'online';
  const etc = ((detail && detail.bag) || []).filter((it) => it.ids && it.ids.some((x) => /^drop_/.test(x.id)));
  const etcQty = etc.reduce((t, it) => t + it.qty, 0);
  const key = JSON.stringify([a.id, live, s.auto, s.sleeping, s.dead, etcQty, !!s.premium, gearCount(), tradableGear().length, a.autoRespawn, a.bounty, a.deaths && a.deaths.perHour, a.finder, a.driver, a.spam, a.premium, a.premiumMode, a.premiumGame]);
  rebuild($('#d-controls'), key, () => (live ? [
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '▶ การเล่น'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl' + (s.auto ? ' on' : ''), title: 'เปิด/ปิด AUTO ของเกม (เหมือนกดปุ่ม AUTO ในเกม)', onclick: () => cmd('auto') }, s.auto ? '■ AUTO เปิดอยู่' : '▶ AUTO ปิดอยู่'),
      el('button', { class: 'ctl', title: 'โหมดพักจอของเกม: จอมืด ประหยัดเครื่อง AUTO ทำงานต่อ (กลับมาได้ที่หน้าเกม กดค้าง 3 วิ)', onclick: () => cmd('sleep') }, s.sleeping ? '☾ พักจออยู่' : '☾ พักจอ'),
      s.dead ? el('button', { class: 'ctl danger', title: 'กดปุ่มฟื้นในหน้าเกม', onclick: () => cmd('respawn') }, '✚ ฟื้นคืนชีพ') : null,
      el('button', { class: 'ctl' + (a.premium ? ' on' : ''), title: 'Premium ของบัญชีนี้: ใช้ตัดสินใจหลายระบบ (เกิดที่เดิม วาร์ปฟรี ซื้อ/ขายผ่าน HUD วาร์ปเข้าเมืองก่อนบอสโลก) · กดเพื่อสลับ: อัตโนมัติ (ตามที่เกมบอก) → มี → ไม่มี',
        onclick: () => dash.invoke('account-premium', a.id, a.premiumMode === 'auto' || !a.premiumMode ? 'yes' : a.premiumMode === 'yes' ? 'no' : 'auto') },
        `👑 Premium: ${a.premiumMode === 'yes' ? 'มี (ตั้งเอง)' : a.premiumMode === 'no' ? 'ไม่มี (ตั้งเอง)' : `อัตโนมัติ · ${a.premiumGame === true ? 'มี' : a.premiumGame === false ? 'ไม่มี' : 'ยังไม่รู้ = ถือว่ามี'}`}`),
      el('button', { class: 'ctl' + (a.spam && a.spam.on ? ' on' : ''), title: 'กดปุ่มสกิลที่เลือก (1–9) ซ้ำๆ ให้ร่ายทันทีที่พร้อม ระหว่างที่ AUTO ตีอยู่' + (a.spam && a.spam.on && a.spam.state ? ` · ตอนนี้: ${a.spam.state}` : ''), onclick: () => openSpam(a) },
        a.spam && a.spam.on ? `⚡ สแปมสกิล ${a.spam.slots.join(' ')}${a.spam.state && a.spam.state !== 'กดอยู่' ? ' · ' + a.spam.state : ''}` : '⚡ สแปมสกิล'),
      a.autoRespawn ? el('span', { class: 'ctl-chip' + (a.autoRespawn.on ? ' on' : ''), title: a.autoRespawn.on ? 'ตัวเลือก "เกิดที่เดิมอัตโนมัติ" ของเกมเปิดอยู่ · ตายตอน AUTO ในแมพฟิลด์ = ลุกที่เดิม' : 'เปิดตัวเลือกของเกมไม่ได้' }, a.autoRespawn.on ? `↺ เกิดที่เดิม: เปิด${a.autoRespawn.count ? ` (${a.autoRespawn.count} ครั้ง)` : ''}` : (a.autoRespawn.why === 'premium' ? '↺ เกิดที่เดิม: ต้อง Premium' : '↺ เกิดที่เดิม: -')) : null,
      el('button', { class: 'ctl' + (a.bounty && a.bounty.on ? ' on' : ''), title: 'ทำค่าหัวรายวันเอง: เดินทางไปแมพของแต่ละใบ (ปุ่มเดินทางของเกม) ยืนข้างมอนแล้วเปิด AUTO ครบ 40 ตัวรับรางวัลแล้วไปใบต่อไป · ข้ามใบที่มอนเลเวลสูงกว่าตัวละคร', onclick: () => dash.invoke('bounty', a.id, !(a.bounty && a.bounty.on)) }, a.bounty && a.bounty.on ? '■ หยุดทำค่าหัว' : '📜 ทำค่าหัวอัตโนมัติ'),
      el('button', { class: 'ctl' + (a.finder && a.finder.on ? ' on' : ''), title: 'ลองฟาร์มจริงแมพที่น่าจะคุ้มสุด 3–4 แมพ (เลือกจาก Build Lab ตามเลเวลและความปลอดภัย) แมพละ 10 นาที แล้วพาไปฟาร์มแมพที่ได้ Silver สุทธิมากสุด · นับ Silver จากมอน + ขาย/หลอม Normal/Magic + ETC ราคา NPC − ยา · ไม่นับราคาตลาด · เดินทางฟรีเท่านั้น · แมพที่เคยวัดแล้วใน 3 วันไม่ต้องลองซ้ำ', onclick: async () => { const on = !(a.finder && a.finder.on); const r = await dash.invoke('farm-find', a.id, on); if (r && !r.ok) showBanner(r.error); else if (on && r) showBanner(`🔎 จะลอง: ${r.trying.join(', ') || '-'}${r.known.length ? ` · ใช้ผลเดิม: ${r.known.join(', ')}` : ''}`); } }, a.finder && a.finder.on ? '■ หยุดหาที่ฟาร์ม' : '🔎 หาที่ฟาร์มคุ้มสุด'),
      el('button', { class: 'ctl', title: 'กำไรต่อชั่วโมงของทุกแมพที่ตัวละครนี้เคยฟาร์ม (ใกล้เลเวลตอนนี้) · กดไปฟาร์มแมพไหนก็ได้', onclick: () => openFarmMaps(a.id) }, '📊 แมพที่เคยฟาร์ม'),
      el('button', { class: 'ctl', title: 'รับของในจดหมาย ภารกิจรายวัน/รายสัปดาห์ของ Pass และรางวัล Tier ของ Pass ที่พร้อมรับ (เหมือนกดปุ่มรับในเกม)', onclick: async (e) => { e.target.disabled = true; const r = await dash.invoke('claim-rewards', a.id); showBanner(r && r.ok ? `🎁 รับแล้ว: จดหมาย ${r.mail} · ภารกิจ ${r.daily + r.weekly} · Tier ของ Pass` : (r && r.error) || 'รับของไม่สำเร็จ'); setTimeout(() => { $('#banner').hidden = true; }, 3000); e.target.disabled = false; } }, '🎁 รับของทั้งหมด'))),
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '💰 ของและเงิน'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl', disabled: canSell() ? null : '', title: canSell() ? 'ซื้อยา HP/MP จากร้าน NPC โดยไม่ต้องเปิดหน้าเกม' : SELL_RULE, onclick: () => openBuy() }, '🧪 ซื้อยา'),
      el('button', { class: 'ctl', disabled: tradableGear().length ? null : '', title: 'ลงขายอุปกรณ์ในตลาดกลาง ดูราคาตลาดตามชนิด+เกรดก่อน', onclick: () => openMarketSell() }, `🏪 ลงขายตลาดกลาง (${tradableGear().length})`),
      el('button', { class: 'ctl', disabled: gearCount() ? null : '', title: 'แยกชิ้นอุปกรณ์ในกระเป๋า (ของที่ล็อกไว้ในเกมจะไม่ถูกย่อย)', onclick: () => openSalvage() }, `🔨 ย่อยของ (${gearCount()})`),
      el('button', { class: 'ctl', disabled: etcQty && canSell() ? null : '', title: canSell() ? 'ขายของดรอปจากมอน (ETC) ทั้งหมดให้ NPC' : SELL_RULE, onclick: () => {
      if (confirm(`ขายของดรอปทั้งหมด ${num(etcQty)} ชิ้นให้ NPC?`)) cmd('sellEtc', {}, 'กำลังขายของดรอป…');
    } }, `🪙 ขาย ETC ทั้งหมด (${num(etcQty)})`),
      el('button', { class: 'ctl', disabled: gearCount() && canSell() ? null : '', title: canSell() ? 'เลือกอุปกรณ์ที่ล้นกระเป๋าขายให้ NPC (ชื่อไทย มี +ตีบวก และออฟชั่นบอกว่าชิ้นไหน · ของล็อกไม่แสดง · ของแพงไม่ติ๊กให้)' : SELL_RULE, onclick: () => openNpcSell() }, `🪙 ขายอุปกรณ์ให้ NPC (${gearCount()})`))),
    el('div', { class: 'ctl-group' }, el('div', { class: 'ctl-gh' }, '🧪 บิลด์'), el('div', { class: 'ctl-row' },
      el('button', { class: 'ctl', title: 'วิเคราะห์บิลด์ของตัวละครนี้: ดาเมจตอนนี้จากเกียร์+การ์ดที่ใส่ แล้วหาชุดสกิลและการ์ดที่แรงที่สุด', onclick: () => openLab({ id: a.id, auto: true }) }, '🧪 วิเคราะห์บิลด์'))),
    a.driver || (a.deaths && a.deaths.perHour >= 5) || (a.bounty && (a.bounty.on || a.bounty.note)) || (a.finder && a.finder.note) ? el('div', { class: 'ctl-status' }, a.driver ? el('span', { class: 'ctl-chip on', title: 'ระบบที่กำลังคุมตัวละครนี้อยู่ ระบบอื่นที่สำคัญน้อยกว่าจะรอ: บอสโลก > ค่าหัว > หาที่ฟาร์ม/เดินทาง > ย้าย CH > แก้ AUTO ค้าง/คืนแรม' }, `🎮 กำลัง${a.driver}`) : null, a.finder && a.finder.note ? el('span', { class: 'ctl-chip' + (a.finder.on ? ' on' : ''), title: 'หาที่ฟาร์มคุ้มสุด' }, `🔎 ${a.finder.note}`) : null, a.deaths && a.deaths.perHour >= 5 ? el('span', { class: 'ctl-chip' + (a.deaths.feePerHour > a.deaths.silverPerHour * 0.1 ? ' warn' : ''), title: 'ตายบ่อยในแมพนี้: ทุกครั้งที่ตายเสียเวลาตี และเกิดที่เดิมในแมพฟิลด์เสีย 5,000 G ต่อครั้ง · ถ้าค่าเกิดเกิน 10% ของรายได้ ลองเพิ่ม HP/VIT หรือย้ายไปแมพที่มอนเบาลง' }, `☠ ตาย ${a.deaths.perHour}/ชม. · ค่าเกิด ~${num(a.deaths.feePerHour)} G/ชม.${a.deaths.silverPerHour ? ` (${Math.round(a.deaths.feePerHour / a.deaths.silverPerHour * 100)}% ของรายได้)` : ''}`) : null, a.bounty && (a.bounty.on || a.bounty.note) ? el('span', { class: 'ctl-chip' + (a.bounty.on ? ' on' : ''), title: 'ค่าหัวรายวัน' }, `📜 ${a.bounty.note || a.bounty.phase}${a.bounty.done ? ` · รับแล้ว ${a.bounty.done}` : ''}`) : null) : null,
  ] : [el('span', { class: 'hint' }, a.status === 'closed' ? 'เปิดเกมเพื่อใช้ปุ่มควบคุม' : 'ปุ่มควบคุมใช้ได้เมื่อเข้าเกมแล้ว')]));
}
