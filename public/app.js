let currentAgent = null;
let agents = [];
let currentMode = 'chat';
const SESSION_ID = 'sess_' + Math.random().toString(36).slice(2);

const displayHistory = {};

// ── Forward state ──
const forwardTexts = new Map();
let forwardIdCounter = 0;
let pendingForward = null; // { text, fromAgentName, fromAgentEmoji }

const $ = id => document.getElementById(id);
const agentList   = $('agentList');
const welcomeScreen = $('welcomeScreen');
const welcomeAgents = $('welcomeAgents');
const messages    = $('messages');
const chatArea    = $('chatArea');
const messageInput = $('messageInput');
const sendBtn     = $('sendBtn');
const clearBtn    = $('clearBtn');
const headerEmoji = $('headerEmoji');
const headerName  = $('headerName');
const headerTitle = $('headerTitle');
const inputHint   = $('inputHint');

const dispatchArea      = $('dispatchArea');
const dispatchBody      = $('dispatchBody');
const dispatchInput     = $('dispatchInput');
const dispatchBtn       = $('dispatchBtn');
const chatInputArea     = $('chatInputArea');
const dispatchInputArea = $('dispatchInputArea');

// ── Init ──
async function init() {
  try {
    const res = await fetch('/api/agents');
    agents = await res.json();
    renderSidebar();
    renderWelcome();
  } catch {
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

// ── Mode Switch ──
function switchMode(mode) {
  currentMode = mode;
  $('tabChat').classList.toggle('active', mode === 'chat');
  $('tabDispatch').classList.toggle('active', mode === 'dispatch');
  if (mode === 'chat') {
    chatArea.style.display = '';
    dispatchArea.style.display = 'none';
    chatInputArea.style.display = '';
    dispatchInputArea.style.display = 'none';
    clearBtn.style.display = '';
  } else {
    chatArea.style.display = 'none';
    dispatchArea.style.display = 'flex';
    chatInputArea.style.display = 'none';
    dispatchInputArea.style.display = '';
    clearBtn.style.display = 'none';
    dispatchInput.focus();
  }
}

// ── Select Agent ──
function selectAgent(id) {
  if (currentMode !== 'chat') switchMode('chat');
  currentAgent = agents.find(a => a.id === id);
  if (!currentAgent) return;

  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
    el.querySelector('.active-dot')?.remove();
  });
  document.querySelector(`.agent-item[data-id="${id}"]`)
    ?.insertAdjacentHTML('beforeend', '<div class="active-dot"></div>');

  headerEmoji.textContent = currentAgent.emoji;
  headerName.textContent  = currentAgent.name;
  headerTitle.textContent = currentAgent.title;

  welcomeScreen.style.display = 'none';
  messages.style.display = 'flex';
  messages.innerHTML = '';

  if (displayHistory[id]?.length) {
    displayHistory[id].forEach(m => {
      const div = (m.type === 'user') ? appendBubble('user', m.text) : appendBubble('ai', m.text);
      if (m.type === 'ai' && m.text) addForwardButton(div, m.text);
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

function showStatus(text) {
  const pill = document.createElement('div');
  pill.className = 'status-pill';
  pill.innerHTML = `<span class="status-spin">⟳</span> ${esc(text)}`;
  messages.appendChild(pill);
  scrollDown();
  return pill;
}

// ── Forward system ──
function addForwardButton(msgDiv, text) {
  if (!text?.trim()) return;
  const fid = ++forwardIdCounter;
  forwardTexts.set(fid, text);

  const bar = document.createElement('div');
  bar.className = 'msg-forward-bar';
  bar.innerHTML = `
    <button class="forward-btn" onclick="toggleForwardMenu(${fid}, this)">🔀 ส่งต่อ ▾</button>
    <div class="forward-menu" id="fmenu-${fid}">
      <div class="fmenu-header">ส่งต่อให้...</div>
      <div class="fmenu-item fmenu-dispatch" onclick="forwardToDispatch(${fid})">
        <span>🚀</span><span>แจกจ่ายให้ทีมอัตโนมัติ</span>
      </div>
      <div class="fmenu-divider"></div>
      ${agents.map(a => `<div class="fmenu-item" onclick="forwardToAgent('${a.id}',${fid})">
        <span>${a.emoji}</span><span>${a.name}</span>
        <span class="fmenu-role">${a.title}</span>
      </div>`).join('')}
    </div>`;
  msgDiv.querySelector('.msg-body').appendChild(bar);
}

function toggleForwardMenu(fid, btn) {
  const menu = $(`fmenu-${fid}`);
  const isOpen = menu.classList.contains('open');
  closeAllForwardMenus();
  if (!isOpen) {
    menu.classList.add('open');
    // Flip up if near bottom
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    menu.style.bottom = spaceBelow < 260 ? 'calc(100% + 4px)' : '';
    menu.style.top    = spaceBelow < 260 ? '' : 'calc(100% + 4px)';
  }
}

function closeAllForwardMenus() {
  document.querySelectorAll('.forward-menu.open').forEach(m => m.classList.remove('open'));
}

function forwardToAgent(agentId, fid) {
  closeAllForwardMenus();
  const text = forwardTexts.get(fid);
  const fromAgent = currentAgent;
  pendingForward = {
    text,
    fromAgentName:  fromAgent?.name  || 'AI',
    fromAgentEmoji: fromAgent?.emoji || '🤖'
  };
  selectAgent(agentId);
  showForwardBanner();
}

function forwardToDispatch(fid) {
  closeAllForwardMenus();
  const text = forwardTexts.get(fid);
  switchMode('dispatch');
  dispatchInput.value = text.length > 600 ? text.slice(0, 600) + '...' : text;
  autoResizeTextarea(dispatchInput);
  dispatchInput.focus();
  // Scroll to end of input
  dispatchInput.setSelectionRange(dispatchInput.value.length, dispatchInput.value.length);
}

// ── Forward Banner ──
function showForwardBanner() {
  if (!pendingForward) return;
  let banner = $('forwardBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'forwardBanner';
    banner.className = 'forward-banner';
    chatInputArea.insertBefore(banner, chatInputArea.firstChild);
  }
  const preview = pendingForward.text.replace(/\s+/g, ' ').slice(0, 90);
  banner.innerHTML = `
    <div class="fwd-banner-content">
      <span class="fwd-banner-icon">📎</span>
      <div class="fwd-banner-info">
        <span class="fwd-banner-label">ส่งต่อจาก ${pendingForward.fromAgentEmoji} ${pendingForward.fromAgentName}</span>
        <span class="fwd-banner-preview">"${esc(preview)}${pendingForward.text.length > 90 ? '…' : ''}"</span>
      </div>
      <button class="fwd-banner-close" onclick="clearForward()">✕</button>
    </div>`;
  banner.style.display = '';
  // Update placeholder hint
  inputHint.textContent = `พิมพ์คำสั่งเพิ่มเติม (หรือ Enter เพื่อส่งต่อทันที)`;
}

function clearForward() {
  pendingForward = null;
  const banner = $('forwardBanner');
  if (banner) banner.style.display = 'none';
  if (currentAgent) {
    inputHint.textContent = `คุยกับ ${currentAgent.name} — Enter ส่ง | Shift+Enter ขึ้นบรรทัดใหม่`;
  }
}

// Close menus on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.msg-forward-bar')) closeAllForwardMenus();
});

// ── Markdown + escape ──
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function md(text) {
  let h = esc(text);
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,l,c) =>
    `<pre><code class="${l||'plaintext'}">${c.trim()}</code></pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/^---+$/gm, '<hr>');
  h = h.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  h = h.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  h = h.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, m =>
    `<ol>${m.replace(/<\/?oli>/g, t => t.replace('oli','li'))}</ol>`);
  h = h.replace(/\|(.+)\|\n\|[-|:\s]+\|\n((?:\|.+\|\n?)+)/g, (_, hdr, rows) => {
    const th = hdr.split('|').filter(s=>s.trim()).map(s=>`<th>${s.trim()}</th>`).join('');
    const trs = rows.trim().split('\n').map(r => {
      const tds = r.split('|').filter(s=>s.trim()).map(s=>`<td>${s.trim()}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  h = h.replace(/\n\n+/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  if (!h.match(/^<(h[1-3]|ul|ol|pre|blockquote|table|hr)/)) h = `<p>${h}</p>`;
  return h;
}

function scrollDown() {
  requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; });
}
function scrollDispatchDown() {
  requestAnimationFrame(() => { dispatchBody.scrollTop = dispatchBody.scrollHeight; });
}
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

async function typeOut(bubble, text, chunkSize = 6) {
  let i = 0;
  bubble.innerHTML = '<span class="cursor"></span>';
  while (i < text.length) {
    i = Math.min(i + chunkSize, text.length);
    bubble.innerHTML = md(text.slice(0, i)) + (i < text.length ? '<span class="cursor"></span>' : '');
    scrollDown();
    await new Promise(r => setTimeout(r, 8));
  }
  bubble.innerHTML = md(text);
}

// ── Send (single agent chat) ──
async function send() {
  const text = messageInput.value.trim();
  // Allow empty input if there's a pending forward (send the forward alone)
  if (!currentAgent) return;
  if (!text && !pendingForward) return;

  // Build the actual message to send — include forwarded context if present
  let actualMessage = text;
  let displayText = text || `[ส่งต่อผลงานจาก ${pendingForward.fromAgentEmoji} ${pendingForward.fromAgentName}]`;

  if (pendingForward) {
    const fwd = pendingForward;
    actualMessage = text
      ? `${text}\n\n--- ข้อมูลส่งต่อจาก ${fwd.fromAgentName} ---\n${fwd.text}`
      : `กรุณาอ่านและให้ความเห็น/พัฒนาต่อจากผลงานต่อไปนี้:\n\n--- ผลงานจาก ${fwd.fromAgentName} ---\n${fwd.text}`;
    clearForward();
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';
  messageInput.disabled = true;
  sendBtn.disabled = true;

  const agentId = currentAgent.id;
  if (!displayHistory[agentId]) displayHistory[agentId] = [];
  displayHistory[agentId].push({ type: 'user', text: displayText });

  appendBubble('user', displayText);

  const aiDiv = appendBubble('ai', '', true);
  const bubble = aiDiv.querySelector('.msg-bubble');
  let full = '';
  let statusPill = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message: actualMessage, sessionId: SESSION_ID })
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
            if (!statusPill) {
              statusPill = showStatus(d.text);
              messages.insertBefore(statusPill, aiDiv);
            } else {
              statusPill.innerHTML = `<span class="status-spin">⟳</span> ${esc(d.text)}`;
            }
          }
          if (d.type === 'delta') {
            full += d.text;
            if (statusPill) { statusPill.remove(); statusPill = null; }
            bubble.innerHTML = md(full) + '<span class="cursor"></span>';
            scrollDown();
          }
          if (d.type === 'done') {
            if (statusPill) { statusPill.remove(); statusPill = null; }
            const finalText = full || d.text || '';
            if (!full && finalText) {
              await typeOut(bubble, finalText);
              full = finalText;
            } else {
              bubble.innerHTML = md(full);
            }
            displayHistory[agentId].push({ type: 'ai', text: full });
            addForwardButton(aiDiv, full);
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
    displayHistory[agentId].pop();
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
    scrollDown();
  }
}

// ── Dispatch: multi-agent workflow ──
async function dispatch() {
  const task = dispatchInput.value.trim();
  if (!task) return;

  dispatchInput.value = '';
  dispatchInput.style.height = 'auto';
  dispatchInput.disabled = true;
  dispatchBtn.disabled = true;

  dispatchBody.innerHTML = '';

  const planningEl = document.createElement('div');
  planningEl.className = 'plan-card';
  planningEl.innerHTML = `
    <div class="plan-card-header">
      <span class="plan-badge">🎯 Orchestrator</span>
      <span style="font-size:12px;color:var(--text2)">กำลังวางแผนงาน...</span>
    </div>
    <div class="step-inline-status"><span class="step-spin">⟳</span> กำลังวิเคราะห์งานและจัดทีม...</div>`;
  dispatchBody.appendChild(planningEl);
  scrollDispatchDown();

  const stepCards = {};

  try {
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, sessionId: SESSION_ID })
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

          if (d.type === 'plan_start') {
            planningEl.querySelector('.step-inline-status').innerHTML =
              `<span class="step-spin">⟳</span> PM กำลังวางแผนการทำงาน...`;
          }
          if (d.type === 'status') {
            planningEl.querySelector('.step-inline-status').innerHTML =
              `<span class="step-spin">⟳</span> ${esc(d.text)}`;
          }
          if (d.type === 'plan') {
            const plan = d.plan;
            planningEl.innerHTML = `
              <div class="plan-card-header">
                <span class="plan-badge">🎯 แผนงาน</span>
              </div>
              <div class="plan-summary">${esc(plan.summary || '')}</div>
              <div class="plan-steps-preview">
                ${(plan.steps || []).map((s, i) => {
                  const a = agents.find(x => x.id === s.agentId);
                  return `<div class="plan-step-chip">
                    <span class="step-num">${i+1}</span>
                    <span>${a ? a.emoji : '🤖'} ${a ? a.name : s.agentId}</span>
                  </div>`;
                }).join('')}
              </div>`;
          }
          if (d.type === 'step_start') {
            const { index, agentId, agentName, agentEmoji } = d;
            const a = agents.find(x => x.id === agentId);
            const color = a?.color || '#4F46E5';
            const card = document.createElement('div');
            card.className = 'step-card working';
            card.innerHTML = `
              <div class="step-card-header">
                <div class="step-agent-avatar" style="background:${color}20;border:1px solid ${color}40">${agentEmoji}</div>
                <div class="step-agent-info">
                  <div class="step-agent-name">${agentName}</div>
                  <div class="step-agent-status" id="step-status-${index}">กำลังทำงาน...</div>
                </div>
                <span class="step-badge working" id="step-badge-${index}">⟳ กำลังทำงาน</span>
              </div>
              <div class="step-card-body" id="step-body-${index}">
                <div class="step-inline-status"><span class="step-spin">⟳</span> รอผลลัพธ์...</div>
              </div>`;
            dispatchBody.appendChild(card);
            scrollDispatchDown();
            stepCards[index] = {
              card,
              bodyEl:   card.querySelector(`#step-body-${index}`),
              statusEl: card.querySelector(`#step-status-${index}`),
              badgeEl:  card.querySelector(`#step-badge-${index}`),
              full: ''
            };
          }
          if (d.type === 'step_status') {
            const sc = stepCards[d.index];
            if (sc) {
              sc.statusEl.textContent = d.text;
              if (!sc.hasContent)
                sc.bodyEl.innerHTML = `<div class="step-inline-status"><span class="step-spin">⟳</span> ${esc(d.text)}</div>`;
            }
            scrollDispatchDown();
          }
          if (d.type === 'step_delta') {
            const sc = stepCards[d.index];
            if (sc) {
              sc.full += d.text;
              sc.hasContent = true;
              sc.bodyEl.innerHTML = md(sc.full) + '<span class="cursor"></span>';
              scrollDispatchDown();
            }
          }
          if (d.type === 'step_done') {
            const sc = stepCards[d.index];
            if (sc) {
              const finalText = sc.full || d.text || '';
              sc.full = finalText;
              sc.bodyEl.innerHTML = md(finalText);
              sc.card.className = 'step-card done';
              sc.badgeEl.className = 'step-badge done';
              sc.badgeEl.textContent = '✓ เสร็จแล้ว';
              sc.statusEl.textContent = 'ดำเนินการเสร็จสิ้น';

              // Add "forward" button on each completed step
              if (finalText) {
                const fwd = document.createElement('div');
                fwd.style.cssText = 'padding:6px 16px 10px;';
                const fid = ++forwardIdCounter;
                forwardTexts.set(fid, finalText);
                // Find agent name for this step
                const agentStep = agents.find(x => x.id === d.agentId) || {};
                fwd.innerHTML = `
                  <div class="msg-forward-bar" style="margin-top:0">
                    <button class="forward-btn" onclick="toggleForwardMenu(${fid}, this)">🔀 ส่งต่อ ▾</button>
                    <div class="forward-menu" id="fmenu-${fid}">
                      <div class="fmenu-header">ส่งต่อให้...</div>
                      <div class="fmenu-item fmenu-dispatch" onclick="forwardToDispatch(${fid})">
                        <span>🚀</span><span>แจกจ่ายให้ทีมอัตโนมัติ</span>
                      </div>
                      <div class="fmenu-divider"></div>
                      ${agents.map(a => `<div class="fmenu-item" onclick="forwardToAgent('${a.id}',${fid})">
                        <span>${a.emoji}</span><span>${a.name}</span>
                        <span class="fmenu-role">${a.title}</span>
                      </div>`).join('')}
                    </div>
                  </div>`;
                sc.card.appendChild(fwd);
              }
              scrollDispatchDown();
            }
          }
          if (d.type === 'dispatch_done') {
            const doneCard = document.createElement('div');
            doneCard.className = 'dispatch-done-card';
            doneCard.innerHTML = `<span style="font-size:20px">✅</span> <span>งานทั้งหมดเสร็จสิ้นแล้ว — ทีม AI ดำเนินการครบทุกขั้นตอน</span>`;
            dispatchBody.appendChild(doneCard);
            scrollDispatchDown();
          }
          if (d.type === 'error') {
            const errCard = document.createElement('div');
            errCard.style.cssText = 'background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:14px 16px;color:#fca5a5;font-size:13px;';
            errCard.textContent = `⚠️ เกิดข้อผิดพลาด: ${d.message}`;
            dispatchBody.appendChild(errCard);
            scrollDispatchDown();
          }
        } catch {}
      }
    }
  } catch (err) {
    const errCard = document.createElement('div');
    errCard.style.cssText = 'background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:14px 16px;color:#fca5a5;font-size:13px;';
    errCard.textContent = `⚠️ เกิดข้อผิดพลาด: ${err.message}`;
    dispatchBody.appendChild(errCard);
    scrollDispatchDown();
  } finally {
    dispatchInput.disabled = false;
    dispatchBtn.disabled = false;
    dispatchInput.focus();
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
      sessionBanner.style.display = 'flex';
      sessionBanner.classList.toggle('critical', sec <= 60);
      bannerExtend.style.display = '';
      const resetAt = new Date(d.expiresAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      bannerText.textContent = `Session จะหมดอายุใน ${fmtTime(sec)} (เวลา ${resetAt}) — ประวัติสนทนาจะถูกล้างอัตโนมัติ`;
    } else if (!d.warningSoon) {
      sessionBanner.style.display = 'none';
      bannerDismissed = false;
    }
  } catch {}
}

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
setInterval(checkSession, 30_000);
setTimeout(checkSession, 5_000);

// ── Clear ──
clearBtn.addEventListener('click', async () => {
  if (!currentAgent) return;
  if (!confirm(`ล้างประวัติการสนทนากับ ${currentAgent.name}?`)) return;
  await fetch(`/api/chat/${SESSION_ID}/${currentAgent.id}`, { method: 'DELETE' }).catch(() => {});
  displayHistory[currentAgent.id] = [];
  messages.innerHTML = '';
  appendBubble('ai', `ล้างประวัติแล้วครับ/ค่ะ 🗑️ มีอะไรให้ช่วยไหม?`);
});

// ── Input: chat ──
messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
messageInput.addEventListener('input', () => autoResizeTextarea(messageInput));
sendBtn.addEventListener('click', send);

// ── Input: dispatch ──
dispatchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatch(); }
});
dispatchInput.addEventListener('input', () => autoResizeTextarea(dispatchInput));
dispatchBtn.addEventListener('click', dispatch);

init();
