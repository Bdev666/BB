let currentAgent = null;
let agents = [];
const SESSION_ID = 'sess_' + Math.random().toString(36).slice(2);

// Client-side message display only (history stored server-side)
const displayHistory = {};

const $ = id => document.getElementById(id);
const agentList = $('agentList');
const welcomeScreen = $('welcomeScreen');
const welcomeAgents = $('welcomeAgents');
const messages = $('messages');
const chatArea = $('chatArea');
const messageInput = $('messageInput');
const sendBtn = $('sendBtn');
const clearBtn = $('clearBtn');
const headerEmoji = $('headerEmoji');
const headerName = $('headerName');
const headerTitle = $('headerTitle');
const inputHint = $('inputHint');

// ── Init ──
async function init() {
  try {
    const res = await fetch('/api/agents');
    agents = await res.json();
    renderSidebar();
    renderWelcome();
  } catch (e) {
    agentList.innerHTML = '<div class="loading-agents" style="color:#ef4444">โหลดไม่สำเร็จ — ตรวจสอบ server</div>';
  }
}

function renderSidebar() {
  agentList.innerHTML = agents.map(a => `
    <div class="agent-item" data-id="${a.id}" style="--agent-color:${a.color}" onclick="selectAgent('${a.id}')">
      <div class="agent-avatar">${a.emoji}</div>
      <div class="agent-item-info">
        <div class="agent-item-name">${a.name}</div>
        <div class="agent-item-desc">${a.description}</div>
      </div>
      ${a.id === 'pm' ? '<span class="pm-badge">QC</span>' : ''}
    </div>`).join('');
}

function renderWelcome() {
  welcomeAgents.innerHTML = agents.map(a => `
    <div class="wac" style="--c:${a.color}" onclick="selectAgent('${a.id}')">
      <div class="wac-emoji">${a.emoji}</div>
      <div class="wac-name">${a.name}</div>
      <div class="wac-desc">${a.description}</div>
    </div>`).join('');
}

// ── Select Agent ──
function selectAgent(id) {
  currentAgent = agents.find(a => a.id === id);
  if (!currentAgent) return;

  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
    el.querySelector('.active-dot')?.remove();
  });
  document.querySelector(`.agent-item[data-id="${id}"]`)
    ?.insertAdjacentHTML('beforeend', '<div class="active-dot"></div>');

  headerEmoji.textContent = currentAgent.emoji;
  headerName.textContent = currentAgent.name;
  headerTitle.textContent = currentAgent.title;

  welcomeScreen.style.display = 'none';
  messages.style.display = 'flex';
  messages.innerHTML = '';

  // Restore display messages for this agent
  if (displayHistory[id]?.length) {
    displayHistory[id].forEach(m => {
      if (m.type === 'user') appendBubble('user', m.text);
      else appendBubble('ai', m.text);
    });
  } else {
    appendBubble('ai', `สวัสดีครับ/ค่ะ! ผม/หนูคือ **${currentAgent.name}** (${currentAgent.title}) 👋\n\nพร้อมช่วยเรื่อง${currentAgent.description} และสามารถ**ค้นหาข้อมูลจากอินเทอร์เน็ต**ได้แบบ real-time ด้วยนะครับ/ค่ะ\n\nมีอะไรให้ช่วยไหมครับ/ค่ะ?`);
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;
  inputHint.textContent = `คุยกับ ${currentAgent.name} — Enter ส่ง | Shift+Enter ขึ้นบรรทัดใหม่`;
  messageInput.focus();
}

// ── Bubble helpers ──
function appendBubble(role, text, streaming = false) {
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'ai'}`;
  div.innerHTML = `
    <div class="msg-avatar">${isUser ? '👤' : (currentAgent?.emoji || '🤖')}</div>
    <div class="msg-body">
      <div class="msg-sender">${isUser ? 'คุณ' : (currentAgent?.name || 'AI')}</div>
      <div class="msg-bubble">${isUser ? esc(text) : md(text)}${streaming ? '<span class="cursor"></span>' : ''}</div>
    </div>`;
  messages.appendChild(div);
  scrollDown();
  return div;
}

// Status pill (searching indicator) — replaces itself with nothing when done
function showStatus(text) {
  const pill = document.createElement('div');
  pill.className = 'status-pill';
  pill.innerHTML = `<span class="status-spin">⟳</span> ${esc(text)}`;
  messages.appendChild(pill);
  scrollDown();
  return pill;
}

// ── Markdown + escape ──
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  let h = esc(text);
  // Code blocks
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,l,c) =>
    `<pre><code class="${l||'plaintext'}">${c.trim()}</code></pre>`);
  // Inline code
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Headers
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Blockquote
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // HR
  h = h.replace(/^---+$/gm, '<hr>');
  // Unordered list
  h = h.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  // Ordered list
  h = h.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  h = h.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, m =>
    `<ol>${m.replace(/<\/?oli>/g, t => t.replace('oli','li'))}</ol>`);
  // Basic table
  h = h.replace(/\|(.+)\|\n\|[-|:\s]+\|\n((?:\|.+\|\n?)+)/g, (_, hdr, rows) => {
    const th = hdr.split('|').filter(s=>s.trim()).map(s=>`<th>${s.trim()}</th>`).join('');
    const trs = rows.trim().split('\n').map(r => {
      const tds = r.split('|').filter(s=>s.trim()).map(s=>`<td>${s.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  // Paragraphs
  h = h.replace(/\n\n+/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  if (!h.match(/^<(h[1-3]|ul|ol|pre|blockquote|table|hr)/)) h = `<p>${h}</p>`;
  return h;
}

function scrollDown() {
  requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}

// ── Send ──
async function send() {
  const text = messageInput.value.trim();
  if (!text || !currentAgent) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';
  messageInput.disabled = true;
  sendBtn.disabled = true;

  const agentId = currentAgent.id;
  if (!displayHistory[agentId]) displayHistory[agentId] = [];
  displayHistory[agentId].push({ type: 'user', text });

  appendBubble('user', text);

  // AI bubble (streaming)
  const aiDiv = appendBubble('ai', '', true);
  const bubble = aiDiv.querySelector('.msg-bubble');
  let full = '';
  let statusPill = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message: text, sessionId: SESSION_ID })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));

          if (d.type === 'status') {
            // Show / update searching pill above the AI bubble
            if (!statusPill) {
              statusPill = showStatus(d.text);
              // Insert pill before the AI message div
              messages.insertBefore(statusPill, aiDiv);
            } else {
              statusPill.innerHTML = `<span class="status-spin">⟳</span> ${esc(d.text)}`;
            }
          }

          if (d.type === 'delta') {
            // Remove searching indicator once answer starts
            if (statusPill) { statusPill.remove(); statusPill = null; }
            full += d.text;
            bubble.innerHTML = md(full) + '<span class="cursor"></span>';
            scrollDown();
          }

          if (d.type === 'done') {
            if (statusPill) { statusPill.remove(); statusPill = null; }
            bubble.innerHTML = md(full);
            displayHistory[agentId].push({ type: 'ai', text: full });
          }

          if (d.type === 'error') {
            if (statusPill) { statusPill.remove(); statusPill = null; }
            bubble.innerHTML = `<span style="color:#ef4444">⚠️ ${esc(d.message)}</span>`;
          }
        } catch {}
      }
    }

    if (!full) bubble.innerHTML = '<span style="color:#f59e0b">⚠️ ไม่ได้รับคำตอบ — ลองใหม่อีกครั้ง</span>';

  } catch (err) {
    if (statusPill) { statusPill.remove(); }
    bubble.innerHTML = `<span style="color:#ef4444">⚠️ เกิดข้อผิดพลาด: ${esc(err.message)}</span>`;
    displayHistory[agentId].pop(); // remove failed user msg
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
    scrollDown();
  }
}

// ── Session Expiry Monitor ──
const sessionBanner = $('sessionBanner');
const bannerText    = $('bannerText');
const bannerExtend  = $('bannerExtend');
const bannerClose   = $('bannerClose');
let bannerDismissed = false;

function fmtTime(sec) {
  if (sec >= 60) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return s > 0 ? `${m} นาที ${s} วินาที` : `${m} นาที`;
  }
  return `${sec} วินาที`;
}

async function checkSession() {
  try {
    const r = await fetch(`/api/session-status/${SESSION_ID}`);
    const d = await r.json();

    if (d.expired) {
      // Session gone — clear display and notify
      Object.keys(displayHistory).forEach(k => { displayHistory[k] = []; });
      sessionBanner.style.display = 'flex';
      sessionBanner.classList.add('critical');
      bannerText.textContent = '⚠️ Session หมดอายุแล้ว — ประวัติการสนทนาถูกล้างอัตโนมัติ กรุณาเริ่มสนทนาใหม่';
      bannerExtend.style.display = 'none';
      if (currentAgent) {
        messages.innerHTML = '';
        appendBubble('ai', '🔄 Session หมดอายุแล้วครับ/ค่ะ ประวัติถูกล้างอัตโนมัติ — พิมพ์ข้อความใหม่ได้เลยครับ/ค่ะ');
      }
      return;
    }

    if (d.warningSoon && !bannerDismissed) {
      const sec = d.ttlSec;
      const isCritical = sec <= 60;
      sessionBanner.style.display = 'flex';
      sessionBanner.classList.toggle('critical', isCritical);
      bannerExtend.style.display = '';
      const resetAt = new Date(d.expiresAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      bannerText.textContent = `Session จะหมดอายุใน ${fmtTime(sec)} (เวลา ${resetAt}) — ประวัติสนทนาจะถูกล้างอัตโนมัติ`;
    } else if (!d.warningSoon) {
      sessionBanner.style.display = 'none';
      bannerDismissed = false;
    }
  } catch {}
}

// Extend session by sending a no-op touch (just re-fetch session status touches it server-side via getHistory on next message)
bannerExtend.addEventListener('click', async () => {
  await fetch(`/api/session-touch/${SESSION_ID}`, { method: 'POST' }).catch(() => {});
  bannerDismissed = false;
  sessionBanner.style.display = 'none';
  bannerText.textContent = '';
  setTimeout(checkSession, 500);
});

bannerClose.addEventListener('click', () => {
  bannerDismissed = true;
  sessionBanner.style.display = 'none';
});

// Poll every 30 seconds
setInterval(checkSession, 30_000);
setTimeout(checkSession, 5_000); // first check after 5s

// ── Clear ──
clearBtn.addEventListener('click', async () => {
  if (!currentAgent) return;
  if (!confirm(`ล้างประวัติการสนทนากับ ${currentAgent.name}?`)) return;
  await fetch(`/api/chat/${SESSION_ID}/${currentAgent.id}`, { method: 'DELETE' }).catch(() => {});
  displayHistory[currentAgent.id] = [];
  messages.innerHTML = '';
  appendBubble('ai', `ล้างประวัติแล้วครับ/ค่ะ 🗑️ มีอะไรให้ช่วยไหม?`);
});

// ── Input ──
messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
});
sendBtn.addEventListener('click', send);

init();
