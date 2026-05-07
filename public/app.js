let currentAgent = null;
let agents = [];
let currentMode = 'home'; // 'home' | 'chat'
const SESSION_ID = 'sess_' + Math.random().toString(36).slice(2);

const displayHistory = {};

// ── Forward state ──
const forwardTexts = new Map();
let forwardIdCounter = 0;
let pendingForward = null;

const $ = id => document.getElementById(id);
const agentList      = $('agentList');
const messages       = $('messages');
const chatArea       = $('chatArea');
const dispatchArea   = $('dispatchArea');
const dispatchBody   = $('dispatchBody');
const dispatchInput  = $('dispatchInput');
const dispatchBtn    = $('dispatchBtn');
const chatInputArea  = $('chatInputArea');
const dispatchInputArea = $('dispatchInputArea');
const messageInput   = $('messageInput');
const sendBtn        = $('sendBtn');
const clearBtn       = $('clearBtn');
const headerEmoji    = $('headerEmoji');
const headerName     = $('headerName');
const headerTitle    = $('headerTitle');
const inputHint      = $('inputHint');
const backBtn        = $('backBtn');

// ── Init ──
async function init() {
  try {
    const res = await fetch('/api/agents');
    agents = await res.json();
    renderSidebar();
    goHome();
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

// ── Home (auto-dispatch) ──
function goHome() {
  currentMode = 'home';
  currentAgent = null;
  clearForward();

  // Show dispatch area, hide chat
  dispatchArea.style.display = 'flex';
  chatArea.style.display = 'none';
  dispatchInputArea.style.display = '';
  chatInputArea.style.display = 'none';
  clearBtn.style.display = 'none';
  backBtn.style.display = 'none';

  // Header: command center
  headerEmoji.textContent = '🏢';
  headerName.textContent  = 'AI Command Center';
  headerTitle.textContent = 'พิมพ์งานที่ต้องการ — ระบบจัดทีม AI ทำงานให้อัตโนมัติ';

  // Deselect all agents in sidebar
  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.remove('active');
    el.querySelector('.active-dot')?.remove();
  });

  $('sidebarLabel').textContent = 'คุยโดยตรง 1:1';
  dispatchInput.focus();
}

// ── Direct chat: select agent ──
function selectAgent(id) {
  currentMode = 'chat';
  currentAgent = agents.find(a => a.id === id);
  if (!currentAgent) return;

  // Show chat, hide dispatch
  chatArea.style.display = '';
  dispatchArea.style.display = 'none';
  chatInputArea.style.display = '';
  dispatchInputArea.style.display = 'none';
  clearBtn.style.display = '';
  backBtn.style.display = '';

  // Header: current agent
  headerEmoji.textContent = currentAgent.emoji;
  headerName.textContent  = currentAgent.name;
  headerTitle.textContent = currentAgent.title;

  // Sidebar: mark active
  document.querySelectorAll('.agent-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
    el.querySelector('.active-dot')?.remove();
  });
  document.querySelector(`.agent-item[data-id="${id}"]`)
    ?.insertAdjacentHTML('beforeend', '<div class="active-dot"></div>');

  $('sidebarLabel').textContent = '— กำลังคุยกับ ' + currentAgent.name;

  // Show messages
  const ws = $('welcomeScreen');
  ws.style.display = 'none';
  messages.style.display = 'flex';
  messages.innerHTML = '';

  if (displayHistory[id]?.length) {
    displayHistory[id].forEach(m => {
      const div = (m.type === 'user') ? appendBubble('user', m.text) : appendBubble('ai', m.text);
      if (m.type === 'ai' && m.text) addForwardButton(div, m.text);
    });
  } else {
    // Show welcome
    ws.style.display = '';
    messages.style.display = 'none';
    $('welcomeAgentEmoji').textContent = currentAgent.emoji;
    $('welcomeAgentName').textContent  = currentAgent.name;
    $('welcomeAgentDesc').textContent  = currentAgent.description;
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;
  inputHint.textContent = `คุยกับ ${currentAgent.name} — Enter ส่ง | Shift+Enter ขึ้นบรรทัดใหม่`;

  // If there's a pending forward, show its banner
  if (pendingForward) showForwardBanner();
  else messageInput.focus();
}

// ── Example chips ──
function useExample(el) {
  // Strip emoji prefix
  const text = el.textContent.replace(/^[\p{Emoji}\s]+/u, '').trim();
  dispatchInput.value = el.textContent.trim();
  autoResizeTextarea(dispatchInput);
  dispatchInput.focus();
}

// ── Bubble helpers ──
function appendBubble(role, text, streaming = false) {
  const isUser = role === 'user';
  // Make sure messages area is visible
  const ws = $('welcomeScreen');
  if (ws && ws.style.display !== 'none') {
    ws.style.display = 'none';
    messages.style.display = 'flex';
  }
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'ai'}`;
  div.innerHTML = `
    <div class="msg-avatar">${isUser ? '👤' : (currentAgent?.emoji || '🤖')}</div>
    <div class="msg-body">
      <div class="msg-sender">${isUser ? 'คุณ' : (currentAgent?.name || 'AI')}</div>
      <div class="msg-bubble">${isUser ? esc(text) : md(text)}${streaming ? '<span class="cursor"></span>' : ''}</div>
    </div>`;
  messages.appendChild(div);
  scrollChat();
  return div;
}

function showStatus(text) {
  const pill = document.createElement('div');
  pill.className = 'status-pill';
  pill.innerHTML = `<span class="status-spin">⟳</span> ${esc(text)}`;
  messages.appendChild(pill);
  scrollChat();
  return pill;
}

// ── Forward system ──
function addForwardButton(msgDiv, text) {
  if (!text?.trim()) return;
  const fid = ++forwardIdCounter;
  forwardTexts.set(fid, text);
  const bar = document.createElement('div');
  bar.className = 'msg-forward-bar';
  bar.innerHTML = buildForwardMenuHTML(fid);
  msgDiv.querySelector('.msg-body').appendChild(bar);
}

function buildForwardMenuHTML(fid) {
  return `
    <button class="forward-btn" onclick="toggleForwardMenu(${fid}, this)">🔀 ส่งต่อ ▾</button>
    <div class="forward-menu" id="fmenu-${fid}">
      <div class="fmenu-header">ส่งต่อให้...</div>
      <div class="fmenu-item fmenu-dispatch" onclick="forwardToHome(${fid})">
        <span>🚀</span><span>แจกจ่ายให้ทีมอัตโนมัติ</span>
      </div>
      <div class="fmenu-divider"></div>
      ${agents.map(a => `<div class="fmenu-item" onclick="forwardToAgent('${a.id}',${fid})">
        <span>${a.emoji}</span><span>${a.name}</span>
        <span class="fmenu-role">${a.title}</span>
      </div>`).join('')}
    </div>`;
}

function toggleForwardMenu(fid, btn) {
  const menu = $(`fmenu-${fid}`);
  const isOpen = menu.classList.contains('open');
  closeAllForwardMenus();
  if (!isOpen) {
    menu.classList.add('open');
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    menu.style.bottom = spaceBelow < 280 ? 'calc(100% + 4px)' : 'auto';
    menu.style.top    = spaceBelow < 280 ? 'auto' : 'calc(100% + 4px)';
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
}

function forwardToHome(fid) {
  closeAllForwardMenus();
  const text = forwardTexts.get(fid);
  goHome();
  dispatchInput.value = text.length > 600 ? text.slice(0, 600) + '...' : text;
  autoResizeTextarea(dispatchInput);
  dispatchInput.focus();
}

// ── Forward Banner ──
function showForwardBanner() {
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
  inputHint.textContent = `พิมพ์คำสั่งเพิ่ม (หรือ Enter เพื่อส่งต่อทันที)`;
  messageInput.focus();
}

function clearForward() {
  pendingForward = null;
  const banner = $('forwardBanner');
  if (banner) banner.style.display = 'none';
  if (currentAgent) inputHint.textContent = `คุยกับ ${currentAgent.name} — Enter ส่ง | Shift+Enter ขึ้นบรรทัดใหม่`;
}

document.addEventListener('click', e => {
  if (!e.target.closest('.msg-forward-bar')) closeAllForwardMenus();
});

// ── Markdown + escape ──
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function md(text) {
  let h = esc(text);
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_,l,c) => `<pre><code class="${l||'plaintext'}">${c.trim()}</code></pre>`);
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
  h = h.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, m => `<ol>${m.replace(/<\/?oli>/g, t => t.replace('oli','li'))}</ol>`);
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

function scrollChat()     { requestAnimationFrame(() => { chatArea.scrollTop     = chatArea.scrollHeight; }); }
function scrollDispatch() { requestAnimationFrame(() => { dispatchBody.scrollTop = dispatchBody.scrollHeight; }); }
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
    scrollChat();
    await new Promise(r => setTimeout(r, 8));
  }
  bubble.innerHTML = md(text);
}

// ── Send: direct agent chat ──
async function send() {
  if (!currentAgent) return;
  const text = messageInput.value.trim();
  if (!text && !pendingForward) return;

  let displayText = text || `[ส่งต่อจาก ${pendingForward.fromAgentEmoji} ${pendingForward.fromAgentName}]`;
  let actualMessage = text;
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

  const aiDiv   = appendBubble('ai', '', true);
  const bubble  = aiDiv.querySelector('.msg-bubble');
  let full = '';
  let statusPill = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message: actualMessage, sessionId: SESSION_ID })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === 'status') {
            if (!statusPill) { statusPill = showStatus(d.text); messages.insertBefore(statusPill, aiDiv); }
            else statusPill.innerHTML = `<span class="status-spin">⟳</span> ${esc(d.text)}`;
          }
          if (d.type === 'delta') {
            full += d.text;
            if (statusPill) { statusPill.remove(); statusPill = null; }
            bubble.innerHTML = md(full) + '<span class="cursor"></span>';
            scrollChat();
          }
          if (d.type === 'done') {
            if (statusPill) { statusPill.remove(); statusPill = null; }
            const finalText = full || d.text || '';
            if (!full && finalText) { await typeOut(bubble, finalText); full = finalText; }
            else bubble.innerHTML = md(full);
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
    if (!full) bubble.innerHTML = '<span style="color:#f59e0b">⚠️ ไม่ได้รับคำตอบ</span>';
  } catch (err) {
    if (statusPill) statusPill.remove();
    bubble.innerHTML = `<span style="color:#ef4444">⚠️ ${esc(err.message)}</span>`;
    displayHistory[agentId].pop();
  } finally {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.focus();
    scrollChat();
  }
}

// ── Dispatch: auto-route task ──
async function dispatch() {
  const task = dispatchInput.value.trim();
  if (!task) return;

  dispatchInput.value = '';
  dispatchInput.style.height = 'auto';
  dispatchInput.disabled = true;
  dispatchBtn.disabled = true;

  // Hide placeholder
  const placeholder = $('dispatchPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  // Task card header
  const taskCard = document.createElement('div');
  taskCard.className = 'task-request-card';
  taskCard.innerHTML = `<span class="task-request-label">📝 งานที่ได้รับ</span><p>${esc(task)}</p>`;
  dispatchBody.appendChild(taskCard);
  scrollDispatch();

  // Planning indicator
  const planningEl = document.createElement('div');
  planningEl.className = 'plan-card';
  planningEl.innerHTML = `
    <div class="plan-card-header">
      <span class="plan-badge">🎯 Orchestrator</span>
    </div>
    <div class="step-inline-status"><span class="step-spin">⟳</span> กำลังวิเคราะห์งานและจัดทีม...</div>`;
  dispatchBody.appendChild(planningEl);
  scrollDispatch();

  const stepCards = {};

  try {
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, sessionId: SESSION_ID })
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));

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
                    <span>${a?.emoji || '🤖'} ${a?.name || s.agentId}</span>
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
            scrollDispatch();
            stepCards[index] = {
              card,
              bodyEl:   card.querySelector(`#step-body-${index}`),
              statusEl: card.querySelector(`#step-status-${index}`),
              badgeEl:  card.querySelector(`#step-badge-${index}`),
              full: '', hasContent: false
            };
          }

          if (d.type === 'step_status') {
            const sc = stepCards[d.index];
            if (sc) {
              sc.statusEl.textContent = d.text;
              if (!sc.hasContent) sc.bodyEl.innerHTML = `<div class="step-inline-status"><span class="step-spin">⟳</span> ${esc(d.text)}</div>`;
            }
            scrollDispatch();
          }

          if (d.type === 'step_delta') {
            const sc = stepCards[d.index];
            if (sc) {
              sc.full += d.text; sc.hasContent = true;
              sc.bodyEl.innerHTML = md(sc.full) + '<span class="cursor"></span>';
              scrollDispatch();
            }
          }

          if (d.type === 'step_delta_replace') {
            const sc = stepCards[d.index];
            if (sc) {
              sc.full = d.text;
              sc.bodyEl.innerHTML = md(sc.full) + '<span class="cursor"></span>';
              scrollDispatch();
            }
          }

          if (d.type === 'step_kpi') {
            const sc = stepCards[d.index];
            if (sc) {
              const k = d.kpi || {};
              const score = k.overall || 0;
              const color = score >= 85 ? '#10b981' : score >= 70 ? '#f59e0b' : '#ef4444';
              const label = d.phase === 'revised' ? '📊 KPI (หลังแก้ไข)' : '📊 KPI';
              const kpiBox = document.createElement('div');
              kpiBox.style.cssText = `margin:8px 16px;padding:10px 12px;background:rgba(0,0,0,.2);border-left:3px solid ${color};border-radius:6px;font-size:12px;`;
              const sc_obj = k.scores || {};
              kpiBox.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <strong>${label}</strong>
                  <span style="font-size:18px;font-weight:700;color:${color}">${score}/100</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px;opacity:.85;">
                  ${Object.entries(sc_obj).map(([n,v]) => `<span style="padding:2px 6px;background:rgba(255,255,255,.05);border-radius:4px;">${n}: ${v}</span>`).join('')}
                </div>
                ${(k.issues && k.issues.length) ? `<div style="margin-top:6px;color:#fca5a5;">⚠️ ${esc(k.issues.join('; '))}</div>` : ''}
                ${k.feedback ? `<div style="margin-top:6px;color:#fde68a;">💬 ${esc(k.feedback)}</div>` : ''}`;
              sc.card.appendChild(kpiBox);
              scrollDispatch();
            }
          }

          if (d.type === 'step_revising') {
            const sc = stepCards[d.index];
            if (sc) {
              const note = document.createElement('div');
              note.style.cssText = 'margin:6px 16px;padding:8px 12px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:6px;font-size:12px;color:#fde68a;';
              note.innerHTML = `🔁 <strong>กำลังแก้ไขตาม Feedback:</strong> ${esc(d.feedback || '')}`;
              sc.card.appendChild(note);
              scrollDispatch();
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
              const score = d.kpi?.overall || 0;
              sc.badgeEl.textContent = score ? `✓ เสร็จ • KPI ${score}` : '✓ เสร็จแล้ว';
              sc.statusEl.textContent = d.revised ? 'แก้ไขและเสร็จสิ้น' : 'ดำเนินการเสร็จสิ้น';
              // Forward button on each step
              if (finalText) {
                const fid = ++forwardIdCounter;
                forwardTexts.set(fid, finalText);
                const fwdDiv = document.createElement('div');
                fwdDiv.style.cssText = 'padding:6px 16px 10px';
                fwdDiv.innerHTML = `<div class="msg-forward-bar" style="margin-top:0">${buildForwardMenuHTML(fid)}</div>`;
                sc.card.appendChild(fwdDiv);
              }
              scrollDispatch();
            }
          }

          if (d.type === 'summary_start') {
            const sumCard = document.createElement('div');
            sumCard.id = 'finalSummaryCard';
            sumCard.className = 'step-card working';
            sumCard.innerHTML = `
              <div class="step-card-header">
                <div class="step-agent-avatar" style="background:#0d948820;border:1px solid #0d948840">📋</div>
                <div class="step-agent-info">
                  <div class="step-agent-name">สรุปสำหรับผู้ใช้</div>
                  <div class="step-agent-status">PM กำลังสรุปผลและรายงาน...</div>
                </div>
                <span class="step-badge working">⟳ สรุป</span>
              </div>
              <div class="step-card-body" id="finalSummaryBody">
                <div class="step-inline-status"><span class="step-spin">⟳</span> รอผลลัพธ์...</div>
              </div>`;
            dispatchBody.appendChild(sumCard);
            scrollDispatch();
          }

          if (d.type === 'summary_delta') {
            const body = $('finalSummaryBody');
            if (body) {
              if (!body.dataset.full) body.dataset.full = '';
              body.dataset.full += d.text;
              body.innerHTML = md(body.dataset.full) + '<span class="cursor"></span>';
              scrollDispatch();
            }
          }

          if (d.type === 'summary_done') {
            const card = $('finalSummaryCard');
            const body = $('finalSummaryBody');
            if (body) body.innerHTML = md(d.text || body.dataset.full || '');
            if (card) {
              card.className = 'step-card done';
              const badge = card.querySelector('.step-badge');
              if (badge) { badge.className = 'step-badge done'; badge.textContent = '✓ สรุปเสร็จ'; }
              const stats = d.stats || {};
              const statsBar = document.createElement('div');
              const c = stats.avgKPI >= 85 ? '#10b981' : stats.avgKPI >= 70 ? '#f59e0b' : '#ef4444';
              statsBar.style.cssText = `margin:8px 16px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:6px;font-size:12px;display:flex;gap:14px;flex-wrap:wrap;`;
              statsBar.innerHTML = `
                <span>📊 <strong style="color:${c}">KPI เฉลี่ย: ${stats.avgKPI || 0}/100</strong></span>
                <span>👥 ${stats.totalSteps || 0} agents</span>
                <span>🔁 แก้ไข: ${stats.revisions || 0} ครั้ง</span>
                <span>⚠️ ปัญหาที่พบ: ${(stats.issues || []).length}</span>`;
              card.appendChild(statsBar);
            }
            scrollDispatch();
          }

          if (d.type === 'dispatch_done') {
            const doneCard = document.createElement('div');
            doneCard.className = 'dispatch-done-card';
            doneCard.innerHTML = `<span style="font-size:20px">✅</span><span>งานเสร็จสิ้น • บันทึกลง memory แล้ว — พิมพ์งานใหม่ได้เลย</span>`;
            dispatchBody.appendChild(doneCard);
            scrollDispatch();
          }

          if (d.type === 'error') {
            const errCard = document.createElement('div');
            errCard.style.cssText = 'background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:14px 16px;color:#fca5a5;font-size:13px;';
            errCard.textContent = `⚠️ ${d.message}`;
            dispatchBody.appendChild(errCard);
            scrollDispatch();
          }
        } catch {}
      }
    }
  } catch (err) {
    const errCard = document.createElement('div');
    errCard.style.cssText = 'background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:14px 16px;color:#fca5a5;font-size:13px;';
    errCard.textContent = `⚠️ ${err.message}`;
    dispatchBody.appendChild(errCard);
    scrollDispatch();
  } finally {
    dispatchInput.disabled = false;
    dispatchBtn.disabled = false;
    dispatchInput.focus();
  }
}

// ── Session Monitor ──
const sessionBanner = $('sessionBanner');
const bannerText    = $('bannerText');
const bannerExtend  = $('bannerExtend');
const bannerClose   = $('bannerClose');
let bannerDismissed = false;

function fmtTime(sec) {
  if (sec >= 60) { const m = Math.floor(sec/60), s = sec%60; return s > 0 ? `${m} นาที ${s} วินาที` : `${m} นาที`; }
  return `${sec} วินาที`;
}
async function checkSession() {
  try {
    const r = await fetch(`/api/session-status/${SESSION_ID}`);
    const d = await r.json();
    if (d.expired) {
      Object.keys(displayHistory).forEach(k => { displayHistory[k] = []; });
      sessionBanner.style.display = 'flex'; sessionBanner.classList.add('critical');
      bannerText.textContent = '⚠️ Session หมดอายุแล้ว — ประวัติถูกล้างอัตโนมัติ';
      bannerExtend.style.display = 'none';
      if (currentMode === 'chat' && currentAgent) {
        messages.innerHTML = '';
        appendBubble('ai', '🔄 Session หมดอายุแล้วครับ/ค่ะ — พิมพ์ข้อความใหม่ได้เลยครับ/ค่ะ');
      }
      return;
    }
    if (d.warningSoon && !bannerDismissed) {
      sessionBanner.style.display = 'flex';
      sessionBanner.classList.toggle('critical', d.ttlSec <= 60);
      bannerExtend.style.display = '';
      const at = new Date(d.expiresAt).toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' });
      bannerText.textContent = `Session จะหมดอายุใน ${fmtTime(d.ttlSec)} (เวลา ${at})`;
    } else if (!d.warningSoon) {
      sessionBanner.style.display = 'none'; bannerDismissed = false;
    }
  } catch {}
}
bannerExtend.addEventListener('click', async () => {
  await fetch(`/api/session-touch/${SESSION_ID}`, { method:'POST' }).catch(()=>{});
  bannerDismissed = false; sessionBanner.style.display = 'none';
  setTimeout(checkSession, 500);
});
bannerClose.addEventListener('click', () => { bannerDismissed = true; sessionBanner.style.display = 'none'; });
setInterval(checkSession, 30_000);
setTimeout(checkSession, 5_000);

// ── Clear ──
clearBtn.addEventListener('click', async () => {
  if (!currentAgent) return;
  if (!confirm(`ล้างประวัติการสนทนากับ ${currentAgent.name}?`)) return;
  await fetch(`/api/chat/${SESSION_ID}/${currentAgent.id}`, { method:'DELETE' }).catch(()=>{});
  displayHistory[currentAgent.id] = [];
  messages.innerHTML = '';
  $('welcomeScreen').style.display = '';
  messages.style.display = 'none';
});

// ── Inputs ──
messageInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
messageInput.addEventListener('input', () => autoResizeTextarea(messageInput));
sendBtn.addEventListener('click', send);

dispatchInput.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); dispatch(); } });
dispatchInput.addEventListener('input', () => autoResizeTextarea(dispatchInput));
dispatchBtn.addEventListener('click', dispatch);

init();
