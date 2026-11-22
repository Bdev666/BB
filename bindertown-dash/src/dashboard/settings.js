/* global dash */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
let info = null;

// ---------- tabs ----------
function showTab(tab) {
  if (!document.querySelector(`[data-page="${tab}"]`)) tab = 'general';
  for (const p of $$('[data-page]')) p.hidden = p.dataset.page !== tab;
  for (const a of $$('[data-tab]')) a.classList.toggle('on', a.dataset.tab === tab);
}
for (const a of $$('[data-tab]')) {
  a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.tab); });
}
dash.onTab(showTab);
showTab(location.hash.slice(1));

// ---------- state -> controls ----------
function render(state) {
  const s = state.settings;
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'checkbox';
  for (const box of $$('[data-set]')) box.checked = !!s[box.dataset.set];
  for (const box of $$('[data-notify]')) box.checked = !!s.notify[box.dataset.notify];
  if (!typing) {
    $('#idleMinutes').value = s.idleMinutes;
    $('#disconnectSeconds').value = s.disconnectSeconds;
    $('#ramLimitMB').value = s.ramLimitMB;
    $('#valuableMinGold').value = s.valuableMinGold;
    $('#highValueGold').value = s.highValueGold;
    $('#potionMinutes').value = s.potionMinutes;
    $('#bossLeadMinutes').value = s.bossLeadMinutes;
    $('#reconnectMinutes').value = s.reconnectMinutes;
    $('#weightFullPct').value = s.weightFullPct;
    $('#weightCriticalPct').value = s.weightCriticalPct;
    if (info) $('#gameUrl').value = s.gameUrl || info.defaultGameUrl;
  }
  $('#tg-on').hidden = !s.telegram.connected;
  if (state.update) $('#upd-status').textContent = updateText(state.update);
  $('#tg-off').hidden = s.telegram.connected;
}

// ---------- controls -> settings ----------
for (const box of $$('[data-set]')) {
  box.addEventListener('change', () => dash.invoke('settings', { [box.dataset.set]: box.checked }));
}
for (const box of $$('[data-notify]')) {
  box.addEventListener('change', () => dash.invoke('settings', { notify: { [box.dataset.notify]: box.checked } }));
}
for (const id of ['idleMinutes', 'disconnectSeconds', 'ramLimitMB', 'valuableMinGold', 'highValueGold', 'potionMinutes', 'weightFullPct', 'weightCriticalPct', 'bossLeadMinutes', 'reconnectMinutes']) {
  $('#' + id).addEventListener('change', (e) => dash.invoke('settings', { [id]: e.target.value }));
}
function urlNote(saved) {
  const pending = info && saved !== info.activeGameUrl;
  $('#url-active').textContent = pending ? 'บันทึกแล้ว เปิดโปรแกรมใหม่เพื่อใช้' : `ตอนนี้ใช้ ${info ? info.activeGameUrl : ''}`;
}
$('#url-save').addEventListener('click', async () => {
  await dash.invoke('settings', { gameUrl: $('#gameUrl').value });
  const st = await dash.invoke('state');
  const saved = st.settings.gameUrl || info.defaultGameUrl;
  $('#gameUrl').value = saved;
  urlNote(saved);
});
$('#url-default').addEventListener('click', async () => {
  await dash.invoke('settings', { gameUrl: '' });
  $('#gameUrl').value = info.defaultGameUrl;
  urlNote(info.defaultGameUrl);
});
$('#clear-cookies').addEventListener('click', async () => {
  if (!confirm('ล้างคุกกี้? ทุกบัญชีจะออกจากระบบเกม ต้องเข้าสู่ระบบใหม่')) return;
  await dash.invoke('clear-cookies');
  alert('ล้างคุกกี้แล้ว');
});
$('#clear-cache').addEventListener('click', async () => {
  await dash.invoke('clear-cache');
  alert('ล้างแคชแล้ว หน้าเกมที่เปิดอยู่กำลังโหลดใหม่');
});
$('#test-notify').addEventListener('click', () => dash.invoke('test-notify'));
$('#tg-connect').addEventListener('click', async () => {
  $('#tg-msg').textContent = 'กำลังเชื่อมต่อ...';
  const r = await dash.invoke('telegram-connect', $('#tg-token').value);
  $('#tg-msg').textContent = r.ok ? 'เชื่อมต่อแล้ว บอทส่งข้อความทักทายไปแล้ว' : r.error;
  if (r.ok) $('#tg-token').value = '';
});
$('#tg-disconnect').addEventListener('click', () => { dash.invoke('telegram-disconnect'); $('#tg-msg').textContent = ''; });
$('#open-userdata').addEventListener('click', () => dash.invoke('open-userdata'));
$('#open-logs').addEventListener('click', () => dash.invoke('open-logs'));
$('#make-report').addEventListener('click', async () => { await dash.invoke('make-report'); alert('สร้างรายงานแล้ว · ไฟล์อยู่ในโฟลเดอร์ที่เปิดขึ้นมา ส่งให้ผู้พัฒนาได้เลย'); });
$('#open-captures').addEventListener('click', () => dash.invoke('open-captures'));

function updateText(u) {
  const when = u.checkedAt ? ` · ตรวจล่าสุด ${new Date(u.checkedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}` : '';
  switch (u.status) {
    case 'checking': return 'กำลังตรวจ...';
    case 'latest': return `เป็นเวอร์ชันล่าสุดแล้ว (v${u.current})${when}`;
    case 'available': return `มีเวอร์ชันใหม่ v${u.version}${when}`;
    case 'downloading': return `กำลังดาวน์โหลด v${u.version} ${u.percent}%`;
    case 'ready': return 'กำลังติดตั้งและเปิดใหม่...';
    case 'dev': return 'โหมดพัฒนา (ยังไม่ได้ติดตั้ง) ไม่ตรวจอัปเดต';
    case 'error': return `ตรวจไม่สำเร็จ: ${u.error}${when}`;
    default: return `v${u.current}`;
  }
}
$('#upd-check').addEventListener('click', () => dash.invoke('update-now'));

// ---------- start ----------
dash.onState(render);
(async () => {
  info = await dash.invoke('app-info');
  $('#userData').value = info.userData;
  $('#version').textContent = 'v' + info.version;
  $('#author').textContent = info.author ? `ผู้พัฒนาโปรแกรม: ${info.author}` : '';
  urlNote(info.activeGameUrl);
  render(await dash.invoke('state'));
})();

const gh = document.getElementById('open-gh'); if (gh) gh.addEventListener('click', () => dash.invoke('open-release'));

{ const ar = document.getElementById('autoRespawnHere');
  if (ar) { dash.invoke('state').then((st) => { ar.checked = st.settings.autoRespawnHere !== false; }).catch(() => {}); ar.addEventListener('change', () => dash.invoke('settings', { autoRespawnHere: ar.checked })); } }

{ const on = document.getElementById('autoBuyOn'); const rd = document.getElementById('autoBuyRounds'); const kp = document.getElementById('autoBuyKeep'); const bl = document.getElementById('autoBuyBelow');
  if (on && rd) {
    dash.invoke('state').then((st) => { const ab = st.settings.autoBuy || {}; on.checked = !!ab.on; rd.value = ab.rounds || 3; if (kp) kp.value = ab.keepSilver ?? 5000; if (bl) bl.value = ab.below || 50; }).catch(() => {});
    const save = () => dash.invoke('settings', { autoBuy: { on: on.checked, rounds: Number(rd.value) || 3, keepSilver: kp ? Number(kp.value) || 0 : 5000, below: bl ? Number(bl.value) || 50 : 50 } });
    on.addEventListener('change', save); rd.addEventListener('change', save); if (kp) kp.addEventListener('change', save); if (bl) bl.addEventListener('change', save);
  } }

// ---------- system test ----------
{ const sel = document.getElementById('st-acc'); const out = document.getElementById('st-out'); const run = document.getElementById('st-run');
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = (s) => (s.skipped ? '⏭' : !s.ok ? '❌' : s.warn ? '⚠️' : '✅');
  const line = (s) => `<div class="st-row"><span>${icon(s)}</span><b>${esc(s.step)}</b><em>${esc(s.detail)}</em><small>${(s.ms / 1000).toFixed(1)} วิ</small></div>`;
  const fill = () => dash.invoke('state').then((st) => {
    const on = (st.accounts || []).filter((a) => a.status === 'online' && !a.demo);
    const keep = sel.value;
    sel.innerHTML = on.length ? on.map((a) => `<option value="${a.id}">${esc((a.stats && a.stats.name) || a.name)}</option>`).join('') : '<option value="">(ไม่มีบัญชีที่เข้าเกมอยู่)</option>';
    if (keep && on.some((a) => String(a.id) === keep)) sel.value = keep;
    run.disabled = !on.length;
  }).catch(() => {});
  if (sel && run) {
    fill(); setInterval(fill, 10000);
    if (dash.onSelftest) dash.onSelftest((s) => { if (run.dataset.busy) out.insertAdjacentHTML('beforeend', line(s)); });
    run.addEventListener('click', async () => {
      const spend = document.getElementById('st-spend').checked;
      if (spend && !confirm('ทดสอบจะซื้อยา 1 ขวดจากร้าน (เสีย Silver เล็กน้อย) ตกลงไหม?')) return;
      run.disabled = true; run.dataset.busy = '1'; out.innerHTML = '<p>กำลังทดสอบ… (ประมาณ 20–40 วิ)</p>';
      try {
        const r = await dash.invoke('selftest', Number(sel.value), { allowSpend: spend });
        if (!r || !r.ok) { out.innerHTML = `<p>❌ ${esc(r && r.error || 'ทดสอบไม่ได้')}</p>`; return; }
        const n = (f) => r.steps.filter(f).length;
        out.innerHTML = `<p><b>ผ่าน ${n((s) => s.ok && !s.warn && !s.skipped)}</b> · เตือน ${n((s) => s.warn)} · ไม่ผ่าน ${n((s) => !s.ok)} · ข้าม ${n((s) => s.skipped)} · ${(r.ms / 1000).toFixed(0)} วิ</p>`
          + r.steps.map(line).join('')
          + (r.improve.length ? `<h3>ควรปรับปรุง</h3><ul>${r.improve.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>ไม่พบเรื่องที่ต้องปรับปรุง</p>')
          + `<p class="mono small">บันทึกที่ ${esc(r.file)}</p>`;
      } catch (err) { out.innerHTML = `<p>❌ ${esc(err.message)}</p>`; }
      finally { delete run.dataset.busy; run.disabled = false; stats(); }
    });
    document.getElementById('st-open').addEventListener('click', () => dash.invoke('open-selftest'));
  }
  const box = document.getElementById('st-stats');
  const stats = () => box && dash.invoke('stats-summary', 7).then((s) => {
    if (!s || !s.rows) { box.innerHTML = '<p>ยังไม่มีสถิติ (บันทึกทุก 10 นาทีที่มีตัวละครออนไลน์)</p>'; return; }
    box.innerHTML = `<p>7 วันล่าสุด ${s.rows} บันทึก</p><table class="st-tab"><tr><th>บัญชี</th><th>อาชีพ</th><th>ฆ่า/ชม.</th><th>Silver/ชม.</th><th>รายได้/ชม.</th><th>ราคาไม่ตอบ</th><th>ซื้อยาเอง</th><th>ตาย</th></tr>`
      + s.accounts.map((a) => `<tr><td>${a.acc}</td><td>${esc(a.job)} ${a.level || ''}</td><td>${a.killsH}</td><td>${a.silverH.toLocaleString('en-US')}</td><td>${a.incomeH.toLocaleString('en-US')}</td><td>${a.last.priceMissed || 0}/${a.last.priceAsked || 0}</td><td>${a.last.autoBuy || 0}${a.last.autoBuyFail ? ` (พลาด ${a.last.autoBuyFail})` : ''}</td><td>${a.last.deaths || 0}</td></tr>`).join('') + '</table>';
  }).catch(() => {});
  stats();
}

// macOS: shortcuts use Cmd, and "start with Windows" means start at login
if (dash.platform === 'darwin') {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/Ctrl|พร้อม Windows|มุมขวาล่าง/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/Ctrl\+/g, 'Cmd+').replace(/พร้อม Windows/g, 'ตอนเปิด Mac').replace(/มุมขวาล่าง/g, 'บนแถบเมนูด้านบน');
}

{ const b = document.getElementById('st-bundle'); const o = document.getElementById('st-bundle-out');
  if (b) b.addEventListener('click', async () => {
    b.disabled = true; o.textContent = 'กำลังรวม log…';
    try { const r = await dash.invoke('log-bundle'); o.textContent = r && r.ok ? `✓ บันทึกแล้ว (${r.kb} KB): ${r.file}` : `❌ ${(r && r.error) || 'รวม log ไม่ได้'}`; }
    catch (err) { o.textContent = '❌ ' + err.message; } finally { b.disabled = false; }
  }); }

{ const cp = document.getElementById('crowdPlayers'); const cm = document.getElementById('crowdMinutes');
  if (cp && cm) {
    dash.invoke('state').then((st) => { cp.value = st.settings.crowdPlayers || 3; cm.value = st.settings.crowdMinutes || 2; }).catch(() => {});
    cp.addEventListener('change', () => dash.invoke('settings', { crowdPlayers: Number(cp.value) || 3 }));
    cm.addEventListener('change', () => dash.invoke('settings', { crowdMinutes: Number(cm.value) || 2 }));
  } }

{ const ft = document.getElementById('farmTrialMinutes');
  if (ft) {
    dash.invoke('state').then((st) => { ft.value = st.settings.farmTrialMinutes || 10; }).catch(() => {});
    ft.addEventListener('change', () => dash.invoke('settings', { farmTrialMinutes: Number(ft.value) || 10 }));
  }
}
