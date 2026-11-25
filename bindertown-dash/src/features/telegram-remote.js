const HUB = require('../core/hub');

// ---------- remote control from Telegram (owner's chat only, off by default) ----------
const remote = new HUB.telegram.Remote({
  onCommand: (text) => remoteCommand(text),
  onIgnored: (m) => HUB.log.warn(`telegram: ignored a message from another chat (${m.chat && m.chat.id})`),
  onError: (err) => HUB.log.once('tg-remote', 60000, 'warn', 'telegram remote:', err.message || err),
});
HUB.syncRemote = HUB.syncRemote = function syncRemote() {
  const s = HUB.store.data.settings;
  if (s.telegramRemote && s.telegram.token && s.telegram.chatId) { remote.start(s.telegram.token, s.telegram.chatId); HUB.log.info('telegram remote: on'); }
  else if (remote.running) { remote.stop(); HUB.log.info('telegram remote: off'); }
};;

const pctText = (cur, max) => (max ? `${Math.round((cur / max) * 100)}%` : '-');
const shortNum = (n) => (typeof n !== 'number' ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)));
const mins = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// "all" or account numbers as shown in the Dashboard list (1 = top)
function pickAccounts(arg) {
  const list = HUB.store.data.accounts;
  if (!arg || arg === 'all' || arg === 'ทั้งหมด') return list.map((a) => a.id);
  return String(arg).split(/[ ,]+/).map(Number).filter((n) => n >= 1 && n <= list.length).map((n) => list[n - 1].id);
}

async function remoteCommand(text) {
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  const arg = rest.join(' ');
  HUB.log.info(`telegram command: ${cmd}${arg ? ' ' + arg.slice(0, 20) : ''}`);
  const list = HUB.store.data.accounts;
  switch (cmd) {
    case '/start':
    case '/help':
      return [
        'BinderDash รีโมต 🎮',
        '/status — สถานะทุกบัญชี',
        '/auto on|off [all|1 2 …] — เปิด/ปิด AUTO',
        '/sleep [all|1 2 …] — พักจอ',
        '/daily — ของรอรับ (Pass / จดหมาย)',
        '/bosses — บอสที่เกิดแล้ว / ใกล้เกิด',
        '/events — อีเวนต์ที่กำลังมี',
        'เลขบัญชี = ลำดับในรายการบน Dashboard',
      ].join('\n');
    case '/status': {
      const now = Date.now();
      const lines = list.map((a, i) => {
        const g = HUB.rt(a.id);
        const s = g.data.stats;
        const r = g.data.rates(now);
        if (!g.win || g.win.isDestroyed()) return `${i + 1}. ${a.name} — ปิดอยู่`;
        if (!g.inGame) return `${i + 1}. ${a.name} — ${g.status === 'maintenance' ? 'ปิดปรับปรุง' : 'ยังไม่เข้าเกม'}`;
        return `${i + 1}. ${s.name || a.name} Lv${s.level ?? '?'} ${s.auto ? '▶AUTO' : '■หยุด'}${s.dead ? ' 💀ตาย' : ''}`
          + `\n   HP ${pctText(s.hp, s.maxHp)} · EXP ${typeof s.expPct === 'number' ? s.expPct.toFixed(1) + '%' : '-'} · ${shortNum(r.expPerHour)} EXP/ชม. · รายได้ ${shortNum(r.incomePerHour)}/ชม.`
          + (g.alerts.size ? `\n   ⚠ ${[...g.alerts].map((k) => k.replace(/:.*/, '')).join(', ')}` : '');
      });
      const online = Math.max(0, ...[...HUB.games.values()].map((g) => g.data.net.online || 0));
      return `📊 สถานะ${online ? ` · คนในเซิร์ฟ ${online}` : ''}\n${lines.join('\n') || 'ยังไม่มีบัญชี'}`;
    }
    case '/auto':
    case '/sleep': {
      let target = arg;
      let want = null;
      if (cmd === '/auto') {
        const m = /^(on|off|เปิด|ปิด)\b\s*(.*)$/i.exec(arg);
        if (!m) return 'ใช้แบบนี้: /auto on หรือ /auto off (เติมเลขบัญชีได้ เช่น /auto off 2 3)';
        want = /^(on|เปิด)$/i.test(m[1]);
        target = m[2];
      }
      const ids = pickAccounts(target);
      const out = [];
      for (const id of ids) {
        const g = HUB.rt(id);
        const name = (g.data.stats.name || HUB.account(id).name);
        if (!g.win || g.win.isDestroyed() || !g.inGame) { out.push(`– ${name}: ไม่ได้อยู่ในเกม`); continue; }
        // eslint-disable-next-line no-await-in-loop
        const ui = await HUB.liveUi(id);
        if (cmd === '/auto' && ui.auto === want) { out.push(`✔ ${name}: AUTO ${want ? 'เปิด' : 'ปิด'}อยู่แล้ว`); continue; }
        if (cmd === '/sleep' && ui.sleeping) { out.push(`✔ ${name}: พักจออยู่แล้ว`); continue; }
        // eslint-disable-next-line no-await-in-loop
        const r = await HUB.gameCommand(id, cmd === '/auto' ? 'auto' : 'sleep', {});
        out.push(`${r.ok ? '✔' : '✖'} ${name}${r.ok ? (cmd === '/auto' ? `: AUTO ${want ? 'เปิด' : 'ปิด'}แล้ว` : ': พักจอแล้ว') : `: ${r.error}`}`);
        // eslint-disable-next-line no-await-in-loop
        await HUB.sleep(300);
      }
      return out.join('\n') || 'ไม่มีบัญชีที่เลือก';
    }
    case '/daily': {
      const lines = list.map((a, i) => {
        const g = HUB.rt(a.id);
        const w = g.data.rewardsWaiting();
        const c = g.data.checklist;
        if (!c.pass && !c.mail) return `${i + 1}. ${a.name} — ยังไม่มีข้อมูล`;
        const done = c.pass ? c.pass.daily.filter((x) => x.claimed).length : 0;
        return `${i + 1}. ${g.data.stats.name || a.name} — Pass ${done}/${c.pass ? c.pass.daily.length : 4}${w.pass ? ` · 🎁 รอกดรับ ${w.pass}` : ''}${w.mail ? ` · ✉ จดหมายมีของ ${w.mail}` : ''}`;
      });
      return `📋 รายวัน\n${lines.join('\n')}`;
    }
    case '/bosses': {
      const b = HUB.bossView();
      const up = b.field.filter((f) => f.up).map((f) => `♛ ${f.name} (${HUB.mapName(f.map)}) — เกิดแล้ว`);
      const soon = b.field.filter((f) => !f.up && f.inMs < 30 * 60000).map((f) => `♛ ${f.name} (${HUB.mapName(f.map)}) — อีก ${mins(f.inMs)}`);
      const world = b.world.map((w) => `🌋 ${w.name} — ${w.state === 'live' ? `กำลังสู้ ${w.fighters} คน` : `อีก ${mins(w.inMs)}`}`);
      const all = [...world, ...up, ...soon];
      return all.length ? `บอส\n${all.join('\n')}` : 'ยังไม่มีข้อมูลบอส (ต้องมีบัญชีที่อยู่ในเกม)';
    }
    case '/events': {
      const ev = HUB.eventsView();
      return ev.length ? ev.map((e) => (e.live ? `🔥 ${e.name}${e.perks.length ? ' · ' + e.perks.join(' · ') : ''}${e.endsInMs ? ` · เหลือ ${mins(e.endsInMs)}` : ''}` : `⏳ ${e.name} · เริ่มในอีก ${mins(e.startsInMs)}`)).join('\n') : 'ตอนนี้ไม่มีอีเวนต์';
    }
    default:
      return 'ไม่รู้จักคำสั่งนี้ พิมพ์ /help ดูคำสั่งทั้งหมด';
  }
}
