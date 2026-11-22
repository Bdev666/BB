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

{ const on = document.getElementById('autoBuyOn'); const rd = document.getElementById('autoBuyRounds');
  if (on && rd) {
    dash.invoke('state').then((st) => { const ab = st.settings.autoBuy || {}; on.checked = !!ab.on; rd.value = ab.rounds || 3; }).catch(() => {});
    const save = () => dash.invoke('settings', { autoBuy: { on: on.checked, rounds: Number(rd.value) || 3 } });
    on.addEventListener('change', save); rd.addEventListener('change', save);
  } }
