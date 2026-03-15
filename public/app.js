let currentAgent = null;
let agents = [];
// Client-side history per agent
const histories = {};

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

  if (!histories[id]) histories[id] = [];

  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
    el.querySelector('.active-dot')?.remove();
  });
  const activeEl = document.querySelector(`.agent-item[data-id="${id}"]`);
  if (activeEl) activeEl.insertAdjacentHTML('beforeend', '<div class="active-dot"></div>');

  headerEmoji.textContent = currentAgent.emoji;
  headerName.textContent = currentAgent.name;
  headerTitle.textContent = currentAgent.title;

  welcomeScreen.style.display = 'none';
  messages.style.display = 'flex';
  messages.innerHTML = '';

  // Restore previous messages
  if (histories[id].length > 0) {
    histories[id].forEach(m => appendMessage(m.role, m.content, false, true));
  } else {
    appendMessage('ai', `สวัสดีครับ/ค่ะ! ผม/หนูคือ **${currentAgent.name}** (${currentAgent.title}) 👋\n\nพร้อมช่วยเรื่อง${currentAgent.description}แล้ว มีอะไรให้ช่วยไหมครับ/ค่ะ?`, false, true);
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;
  inputHint.textContent = `คุยกับ ${currentAgent.name} — Enter ส่ง | Shift+Enter ขึ้นบรรทัดใหม่`;
  messageInput.focus();
}

// ── Messages ──
function appendMessage(role, text, streaming = false, skipHistory = false) {
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

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  let h = esc(text);
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,l,c) => `<pre><code>${c.trim()}</code></pre>`);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/^---$/gm, '<hr>');
  h = h.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  h = h.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
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
  const history = histories[agentId] || [];

  // Add to local history
  history.push({ role: 'user', content: text });
  histories[agentId] = history;

  appendMessage('user', text);

  const aiDiv = appendMessage('ai', '', true);
  const bubble = aiDiv.querySelector('.msg-bubble');
  let full = '';

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        message: text,
        history: history.slice(-20) // send last 20 turns for context
      })
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
          if (d.type === 'delta') {
            full += d.text;
            bubble.innerHTML = md(full) + '<span class="cursor"></span>';
            scrollDown();
          } else if (d.type === 'done') {
            if (d.fullText) full = d.fullText;
            bubble.innerHTML = md(full);
            // Save to history
            histories[agentId].push({ role: 'assistant', content: full });
          } else if (d.type === 'error') {
            bubble.innerHTML = `<span style="color:#ef4444">⚠️ ${esc(d.message)}</span>`;
          }
        } catch {}
      }
    }

    if (!full) bubble.innerHTML = '<span style="color:#f59e0b">⚠️ ไม่ได้รับคำตอบ — ลองใหม่อีกครั้ง</span>';

  } catch (err) {
    bubble.innerHTML = `<span style="color:#ef4444">⚠️ เกิดข้อผิดพลาด: ${esc(err.message)}</span>`;
    // Remove failed user message from history
    histories[agentId].pop();
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
    scrollDown();
  }
}

// ── Clear ──
clearBtn.addEventListener('click', () => {
  if (!currentAgent) return;
  if (!confirm(`ล้างประวัติการสนทนากับ ${currentAgent.name}?`)) return;
  histories[currentAgent.id] = [];
  messages.innerHTML = '';
  appendMessage('ai', `ล้างประวัติแล้วครับ/ค่ะ 🗑️ มีอะไรให้ช่วยไหม?`);
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
