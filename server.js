import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Agent Definitions ──
const AGENTS = {
  manager: {
    id: 'manager', name: 'ผู้จัดการ', title: 'CEO & ผู้จัดการทั่วไป',
    emoji: '👔', color: '#4F46E5',
    description: 'วางแผนกลยุทธ์ ตัดสินใจ และบริหารจัดการองค์กร',
    system: `คุณคือ CEO และผู้จัดการทั่วไป เชี่ยวชาญด้านกลยุทธ์ การตัดสินใจ OKR SWOT และการบริหารองค์กร
ตอบเป็นภาษาไทยเสมอ เป็นผู้นำ คิดเชิงกลยุทธ์ มองภาพรวม ให้คำแนะนำชัดเจนและมีคุณค่า
หากต้องการข้อมูลปัจจุบัน ให้ค้นหาก่อนตอบเสมอ`
  },
  secretary: {
    id: 'secretary', name: 'เลขานุการ', title: 'เลขานุการและผู้ประสานงาน',
    emoji: '📋', color: '#0891B2',
    description: 'จัดการเอกสาร นัดหมาย และประสานงานทีม',
    system: `คุณคือเลขานุการและผู้ประสานงาน เชี่ยวชาญการจัดการเอกสาร นัดหมาย และประสานงาน
ตอบเป็นภาษาไทย ละเอียดรอบคอบ เป็นระเบียบ ช่วยร่างอีเมล บันทึกประชุม รายงาน และตารางเวลา
หากต้องการข้อมูลอ้างอิง ให้ค้นหาก่อนเสมอ`
  },
  developer: {
    id: 'developer', name: 'นักพัฒนา', title: 'Senior Software Developer',
    emoji: '💻', color: '#059669',
    description: 'เขียนโค้ด แก้บัค และออกแบบระบบซอฟต์แวร์',
    system: `คุณคือ Senior Software Developer เชี่ยวชาญการเขียนโปรแกรม ออกแบบสถาปัตยกรรม และแก้ปัญหาเทคนิค
ตอบเป็นภาษาไทย ใช้ภาษาอังกฤษสำหรับชื่อเทคนิคและโค้ด เชี่ยวชาญ JS, TS, Python, React, Node.js
ให้ตัวอย่างโค้ดจริง best practices และค้นหา docs ล่าสุดก่อนตอบเสมอ`
  },
  analyst: {
    id: 'analyst', name: 'นักวิเคราะห์', title: 'Data & Business Analyst',
    emoji: '📊', color: '#D97706',
    description: 'วิเคราะห์ข้อมูล วิจัย และสร้างรายงาน',
    system: `คุณคือ Data & Business Analyst เชี่ยวชาญวิเคราะห์ข้อมูล วิจัยตลาด และสร้างรายงานเชิงลึก
ตอบเป็นภาษาไทย คิดวิเคราะห์เป็นระบบ ใช้ข้อมูลสนับสนุนการตัดสินใจ
สำหรับตัวเลข สถิติ หรือเทรนด์ ให้ค้นหาข้อมูลจริงก่อนวิเคราะห์เสมอ`
  },
  writer: {
    id: 'writer', name: 'นักเขียน', title: 'Content Creator & Copywriter',
    emoji: '✍️', color: '#DC2626',
    description: 'เขียนเนื้อหา บทความ และสื่อการตลาด',
    system: `คุณคือ Content Creator และ Copywriter เชี่ยวชาญการเขียนเนื้อหาที่น่าสนใจและโน้มน้าวใจ
ตอบเป็นภาษาไทย ใช้ภาษาสวยงาม กระชับ เหมาะกับกลุ่มเป้าหมาย
ช่วยเขียนบทความ โพสต์โซเชียล สคริปต์ คำโฆษณา และเนื้อหาทุกประเภท
หากเกี่ยวกับข่าวหรือเทรนด์ปัจจุบัน ให้ค้นหาก่อนเสมอ`
  },
  hr: {
    id: 'hr', name: 'HR', title: 'Human Resources Manager',
    emoji: '👥', color: '#7C3AED',
    description: 'บริหารบุคคล สรรหา และพัฒนาทีมงาน',
    system: `คุณคือ HR Manager เชี่ยวชาญบริหารบุคคล สรรหาพนักงาน และพัฒนาองค์กร
ตอบเป็นภาษาไทย เห็นอกเห็นใจ เป็นธรรม ให้คำปรึกษาที่ดี
ช่วยด้านสรรหา ประเมินผล แก้ปัญหาในทีม และพัฒนาทักษะพนักงาน
หากต้องการข้อมูลตลาดงานหรือกฎหมายแรงงาน ให้ค้นหาก่อนเสมอ`
  },
  pm: {
    id: 'pm', name: 'Project Manager', title: 'PM — KPI & Quality Control',
    emoji: '🎯', color: '#0D9488',
    description: 'ติดตาม KPI ตรวจสอบงาน และให้ Feedback ทีม',
    system: `คุณคือ Project Manager ระดับสูง เชี่ยวชาญบริหารโครงการ ติดตาม KPI ตรวจสอบคุณภาพงาน และให้ Feedback
ตอบเป็นภาษาไทย ละเอียด เป็นระบบ วิจารณ์อย่างตรงไปตรงมาแต่สร้างสรรค์
recheck งาน ใช้โครงสร้าง: ✅ ผ่าน / ⚠️ ต้องปรับ / ❌ บกพร่อง / 💡 แนะนำ / 📊 คะแนน
หากต้องการ benchmark หรือ best practices ล่าสุด ให้ค้นหาก่อนเสมอ`
  }
};

// ── Session Management ──
const SESSION_TTL_MS = 30 * 60 * 1000;
const WARN_BEFORE_MS =  5 * 60 * 1000;
const sessionMeta = new Map();
const sessions = new Map();

function touchSession(sessionId) {
  clearTimeout(sessionMeta.get(sessionId)?.timer);
  const timer = setTimeout(() => expireSession(sessionId), SESSION_TTL_MS);
  sessionMeta.set(sessionId, { lastActive: Date.now(), timer });
}
function expireSession(sessionId) {
  for (const k of sessions.keys()) if (k.startsWith(sessionId + ':')) sessions.delete(k);
  sessionMeta.delete(sessionId);
  console.log(`[session] expired: ${sessionId}`);
}
function getHistory(sessionId, agentId) {
  touchSession(sessionId);
  const key = `${sessionId}:${agentId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}
function msUntilExpiry(sessionId) {
  const m = sessionMeta.get(sessionId);
  return m ? Math.max(0, m.lastActive + SESSION_TTL_MS - Date.now()) : SESSION_TTL_MS;
}
function buildPrompt(history, message) {
  if (!history.length) return message;
  const ctx = history.slice(-16).map(m =>
    `${m.role === 'user' ? 'ผู้ใช้' : 'Assistant'}: ${m.content}`
  ).join('\n\n');
  return `<conversation_history>\n${ctx}\n</conversation_history>\n\nผู้ใช้: ${message}`;
}

// ── Shared: run one agent query, return full text ──
async function runAgent(agentId, prompt, onStatus) {
  const agent = AGENTS[agentId];
  let text = '';
  const stream = query({
    prompt,
    options: { systemPrompt: agent.system, allowedTools: ['WebSearch', 'WebFetch'], maxTurns: 10 }
  });
  for await (const msg of stream) {
    if (msg.type === 'tool_use') {
      const name = msg.name || '';
      if (name === 'WebSearch') onStatus?.(`🔍 ${agent.name} กำลังค้นหา: "${msg.input?.query || ''}"`);
      else if (name === 'WebFetch') onStatus?.(`🌐 ${agent.name} กำลังอ่านข้อมูลจากเว็บ...`);
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'text' && b.text?.length > text.length) text = b.text;
      }
    }
    if (msg.type === 'result') {
      if (msg.is_error) throw new Error(msg.result || 'Agent error');
      if (msg.result) text = msg.result;
    }
  }
  return text;
}

// ── Routes: Agents & Session ──
app.get('/api/agents', (req, res) => {
  res.json(Object.values(AGENTS).map(({ id, name, title, emoji, color, description }) =>
    ({ id, name, title, emoji, color, description })
  ));
});
app.get('/api/session-status/:id', (req, res) => {
  const ms = msUntilExpiry(req.params.id);
  res.json({ ttlMs: ms, ttlSec: Math.floor(ms / 1000),
    expiresAt: Date.now() + ms, warningSoon: ms > 0 && ms <= WARN_BEFORE_MS, expired: ms === 0 });
});
app.post('/api/session-touch/:id', (req, res) => {
  touchSession(req.params.id);
  res.json({ ok: true, ttlMs: SESSION_TTL_MS });
});
app.delete('/api/chat/:sessionId/:agentId', (req, res) => {
  sessions.delete(`${req.params.sessionId}:${req.params.agentId}`);
  touchSession(req.params.sessionId);
  res.json({ ok: true });
});

// ── Chat: single agent ──
app.post('/api/chat', async (req, res) => {
  const { agentId, message, sessionId } = req.body;
  if (!agentId || !message || !sessionId) return res.status(400).json({ error: 'Missing fields' });
  const agent = AGENTS[agentId];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);

  const history = getHistory(sessionId, agentId);
  const prompt = buildPrompt(history, message);
  history.push({ role: 'user', content: message });

  let assistantText = '';
  send({ type: 'status', text: '💭 กำลังคิด...' });

  try {
    const stream = query({
      prompt,
      options: { systemPrompt: agent.system, allowedTools: ['WebSearch', 'WebFetch'], maxTurns: 10 }
    });
    for await (const msg of stream) {
      if (msg.type === 'tool_use') {
        const n = msg.name || '';
        if (n === 'WebSearch') send({ type: 'status', text: `🔍 กำลังค้นหา: "${msg.input?.query || ''}"` });
        else if (n === 'WebFetch') send({ type: 'status', text: '🌐 กำลังอ่านข้อมูลจากเว็บ...' });
      }
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const b of msg.message.content) {
          if (b.type === 'text' && b.text?.length > assistantText.length) {
            send({ type: 'delta', text: b.text.slice(assistantText.length) });
            assistantText = b.text;
          }
        }
      }
      if (msg.type === 'result') {
        if (msg.is_error) { send({ type: 'error', message: msg.result || 'Error' }); return; }
        const final = msg.result || assistantText;
        if (final.length > assistantText.length) send({ type: 'delta', text: final.slice(assistantText.length) });
        assistantText = final;
      }
    }
    history.push({ role: 'assistant', content: assistantText });
    send({ type: 'done', text: assistantText });
  } catch (err) {
    history.pop();
    console.error(`[${agent.name}]`, err.message);
    send({ type: 'error', message: err.message });
  } finally { res.end(); }
});

// ── Dispatch: multi-agent workflow ──
app.post('/api/dispatch', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task || !sessionId) return res.status(400).json({ error: 'Missing fields' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  touchSession(sessionId);

  const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const agentList = Object.values(AGENTS).map(a => `${a.id}: ${a.name} — ${a.description}`).join('\n');

  try {
    // Step 1: Orchestrator plans the workflow
    send({ type: 'plan_start' });

    const planPrompt = `คุณคือ Orchestrator ของ AI Office ทำหน้าที่วางแผนและแจกจ่ายงานให้ทีม

รายชื่อ agents ที่มีในทีม:
${agentList}

งานที่ได้รับมอบหมาย:
"${task}"

วิเคราะห์งานและตัดสินใจ:
1. เลือก agents ที่เหมาะสม (1-4 คน) พร้อม order และ instruction เฉพาะสำหรับแต่ละคน
2. แต่ละ agent จะได้รับผลลัพธ์จาก agent ก่อนหน้าเป็น context ด้วย

ตอบในรูปแบบ JSON เท่านั้น ไม่มี markdown:
{
  "summary": "สรุปแผนงานสั้นๆ",
  "steps": [
    { "agentId": "id", "instruction": "สิ่งที่ agent นี้ต้องทำ" }
  ]
}`;

    let planText = '';
    try {
      planText = await runAgent('pm', planPrompt, msg => send({ type: 'status', text: msg }));
    } catch (e) {
      // fallback: simple routing
      planText = JSON.stringify({ summary: 'ส่งงานให้ผู้จัดการ', steps: [{ agentId: 'manager', instruction: task }] });
    }

    // Parse JSON (strip possible markdown fences)
    let plan;
    try {
      const jsonStr = planText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      // Find first { to last }
      const start = jsonStr.indexOf('{');
      const end = jsonStr.lastIndexOf('}');
      plan = JSON.parse(jsonStr.slice(start, end + 1));
    } catch {
      plan = { summary: 'ดำเนินงานโดยตรง', steps: [{ agentId: 'manager', instruction: task }] };
    }

    // Validate steps
    plan.steps = (plan.steps || []).filter(s => AGENTS[s.agentId]);
    if (!plan.steps.length) plan.steps = [{ agentId: 'manager', instruction: task }];

    send({ type: 'plan', plan });

    // Step 2: Execute each agent in sequence
    let previousOutput = '';

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const agent = AGENTS[step.agentId];

      send({ type: 'step_start', index: i, agentId: step.agentId, agentName: agent.name, agentEmoji: agent.emoji });

      const agentPrompt = previousOutput
        ? `งานของคุณ: ${step.instruction}\n\nผลงานจากทีมก่อนหน้า:\n${previousOutput}\n\nกรุณาดำเนินงานของคุณโดยใช้ผลงานข้างต้นเป็น context`
        : `งานของคุณ: ${step.instruction}`;

      let stepText = '';
      try {
        const stepStream = query({
          prompt: agentPrompt,
          options: { systemPrompt: agent.system, allowedTools: ['WebSearch', 'WebFetch'], maxTurns: 10 }
        });

        for await (const msg of stepStream) {
          if (msg.type === 'tool_use') {
            const n = msg.name || '';
            if (n === 'WebSearch') send({ type: 'step_status', index: i, text: `🔍 ค้นหา: "${msg.input?.query || ''}"` });
            else if (n === 'WebFetch') send({ type: 'step_status', index: i, text: '🌐 อ่านข้อมูลจากเว็บ...' });
          }
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const b of msg.message.content) {
              if (b.type === 'text' && b.text?.length > stepText.length) {
                send({ type: 'step_delta', index: i, text: b.text.slice(stepText.length) });
                stepText = b.text;
              }
            }
          }
          if (msg.type === 'result') {
            const final = msg.result || stepText;
            if (final.length > stepText.length) send({ type: 'step_delta', index: i, text: final.slice(stepText.length) });
            stepText = final;
          }
        }
      } catch (err) {
        stepText = `⚠️ เกิดข้อผิดพลาด: ${err.message}`;
      }

      previousOutput = stepText;
      send({ type: 'step_done', index: i, text: stepText });
    }

    send({ type: 'dispatch_done' });

  } catch (err) {
    console.error('[dispatch]', err.message);
    send({ type: 'error', message: err.message });
  } finally { res.end(); }
});

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║      🏢  Multi-Agent AI Office         ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  http://localhost:${PORT}                   ║`);
  console.log('╚════════════════════════════════════════╝\n');
  Object.values(AGENTS).forEach(a => console.log(`  ${a.emoji} ${a.name}`));
  console.log('');
});
