import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Persistent Memory ──
const MEM_DIR  = join(__dirname, '.memory');
const MEM_FILE = join(MEM_DIR, 'memory.json');
if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });
let memoryStore = {};
try { if (existsSync(MEM_FILE)) memoryStore = JSON.parse(readFileSync(MEM_FILE, 'utf8')) || {}; } catch { memoryStore = {}; }
function saveMemory() {
  try { writeFileSync(MEM_FILE, JSON.stringify(memoryStore, null, 2)); } catch (e) { console.error('[memory] save failed:', e.message); }
}
function getMemory(sessionId) {
  if (!memoryStore[sessionId]) memoryStore[sessionId] = { tasks: [], notes: [] };
  return memoryStore[sessionId];
}
function rememberTask(sessionId, entry) {
  const mem = getMemory(sessionId);
  mem.tasks.push({ ...entry, at: new Date().toISOString() });
  if (mem.tasks.length > 50) mem.tasks = mem.tasks.slice(-50);
  saveMemory();
}
function memoryContext(sessionId) {
  const mem = getMemory(sessionId);
  if (!mem.tasks.length && !mem.notes.length) return '';
  const recent = mem.tasks.slice(-5).map(t =>
    `- [${t.at?.slice(0,10) || ''}] ${t.task} → ${(t.summary || '').slice(0, 120)}`
  ).join('\n');
  const notes = mem.notes.slice(-5).map(n => `- ${n}`).join('\n');
  return `<long_term_memory>
งานที่เคยทำของผู้ใช้ (recent):
${recent || '(ไม่มี)'}
${notes ? `\nบันทึกพิเศษ:\n${notes}` : ''}
</long_term_memory>\n\n`;
}

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
  },
  designer: {
    id: 'designer', name: 'นักออกแบบ', title: 'UX/UI & Graphic Designer',
    emoji: '🎨', color: '#EC4899',
    description: 'ออกแบบ UI/UX, Graphic, Product และ Brand Identity',
    system: `คุณคือ Senior Designer เชี่ยวชาญทั้ง UX/UI Design, Graphic Design, Product Design และ Brand Identity
ตอบเป็นภาษาไทย คิดเชิงสร้างสรรค์ มีรสนิยม ให้คำปรึกษาด้านการออกแบบอย่างมืออาชีพ

ความเชี่ยวชาญ:
- UX/UI: Wireframe, Prototype, User Flow, Design System, Figma, Accessibility
- Graphic Design: Typography, Color Theory, Layout, Composition, Brand Guidelines
- Product Design: Industrial Design, Packaging, Material Selection, Ergonomics
- Brand Identity: Logo, Visual Identity, Brand Voice, Style Guide
- Tools: Figma, Adobe XD, Photoshop, Illustrator, After Effects, Canva

เวลาให้คำปรึกษา ให้อธิบาย: แนวคิด (Concept) → องค์ประกอบ (Elements) → เครื่องมือที่แนะนำ → ตัวอย่าง Reference
หากต้องการดูเทรนด์ดีไซน์ล่าสุด ให้ค้นหาก่อนตอบเสมอ`
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

// ── KPI Evaluation ──
async function evaluateKPI({ task, instruction, output, agent }) {
  const evalPrompt = `คุณคือผู้ประเมิน KPI คุณภาพงาน วิเคราะห์ผลงานต่อไปนี้และให้คะแนน

โจทย์ของผู้ใช้: "${task}"
ภารกิจที่มอบหมายให้ ${agent.name}: "${instruction}"

ผลงานที่ส่งมอบ:
"""${(output || '').slice(0, 4000)}"""

ประเมิน 5 มิติ (0-100):
- accuracy: ความถูกต้องของข้อมูล/ตรรกะ
- relevance: ตรงกับโจทย์หรือไม่
- completeness: ครบถ้วน/ละเอียดเพียงพอ
- clarity: ชัดเจน อ่านเข้าใจง่าย
- usefulness: ใช้งานได้จริง

ตอบเป็น JSON เท่านั้น (ไม่มี markdown):
{
  "scores": { "accuracy": 0, "relevance": 0, "completeness": 0, "clarity": 0, "usefulness": 0 },
  "overall": 0,
  "issues": ["ข้อบกพร่องที่พบ", "..."],
  "feedback": "ข้อเสนอแนะที่ตรงไปตรงมา 1-3 ประโยค สำหรับให้ agent แก้ไข",
  "verdict": "pass" | "revise"
}
หากคะแนน overall < 70 ให้ verdict = "revise"`;
  let raw = '';
  try {
    raw = await runAgent('pm', evalPrompt, () => {});
  } catch (e) {
    return { scores: {}, overall: 0, issues: [`ประเมินไม่ได้: ${e.message}`], feedback: '', verdict: 'pass' };
  }
  try {
    const s = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    const obj = JSON.parse(s.slice(start, end + 1));
    obj.overall = Number(obj.overall) || 0;
    obj.verdict = obj.overall < 70 ? 'revise' : (obj.verdict || 'pass');
    return obj;
  } catch {
    return { scores: {}, overall: 75, issues: [], feedback: '', verdict: 'pass' };
  }
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
app.get('/api/memory/:sessionId', (req, res) => {
  res.json(getMemory(req.params.sessionId));
});
app.delete('/api/memory/:sessionId', (req, res) => {
  delete memoryStore[req.params.sessionId];
  saveMemory();
  res.json({ ok: true });
});
app.post('/api/memory/:sessionId/note', (req, res) => {
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Missing note' });
  const mem = getMemory(req.params.sessionId);
  mem.notes.push(String(note).slice(0, 500));
  if (mem.notes.length > 30) mem.notes = mem.notes.slice(-30);
  saveMemory();
  res.json({ ok: true });
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
  const memCtx  = memoryContext(sessionId);
  const prompt  = memCtx + buildPrompt(history, message);
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

    const memCtx = memoryContext(sessionId);
    const planPrompt = `${memCtx}คุณคือ Orchestrator ของ AI Office ทำหน้าที่วางแผนและแจกจ่ายงานให้ทีม

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

    // Step 2: Execute each agent in sequence with KPI eval + revision loop
    let previousOutput = '';
    const stepResults = [];

    async function runStep(index, agent, instruction, contextText, revisionFeedback) {
      let prompt = `งานของคุณ: ${instruction}`;
      if (contextText) prompt += `\n\nผลงานจากทีมก่อนหน้า:\n${contextText}`;
      if (revisionFeedback) {
        prompt += `\n\n⚠️ Feedback จาก PM (ต้องแก้ไข):\n${revisionFeedback}\n\nกรุณาปรับปรุงผลงานตาม feedback นี้`;
      }
      prompt += `\n\nกรุณาดำเนินงานอย่างละเอียดและใช้เครื่องมือค้นหาเมื่อจำเป็น`;

      let stepText = '';
      const stepStream = query({
        prompt,
        options: { systemPrompt: agent.system, allowedTools: ['WebSearch', 'WebFetch'], maxTurns: 10 }
      });
      for await (const msg of stepStream) {
        if (msg.type === 'tool_use') {
          const n = msg.name || '';
          if (n === 'WebSearch') send({ type: 'step_status', index, text: `🔍 ค้นหา: "${msg.input?.query || ''}"` });
          else if (n === 'WebFetch') send({ type: 'step_status', index, text: '🌐 อ่านข้อมูลจากเว็บ...' });
        }
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b.type === 'text' && b.text?.length > stepText.length) {
              send({ type: 'step_delta', index, text: b.text.slice(stepText.length) });
              stepText = b.text;
            }
          }
        }
        if (msg.type === 'result') {
          const final = msg.result || stepText;
          if (final.length > stepText.length) send({ type: 'step_delta', index, text: final.slice(stepText.length) });
          stepText = final;
        }
      }
      return stepText;
    }

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const agent = AGENTS[step.agentId];
      send({ type: 'step_start', index: i, agentId: step.agentId, agentName: agent.name, agentEmoji: agent.emoji });

      let stepText = '';
      let kpi = null;
      let revised = false;
      try {
        stepText = await runStep(i, agent, step.instruction, previousOutput, null);

        // KPI evaluation
        send({ type: 'step_status', index: i, text: '📊 PM กำลังประเมิน KPI และคุณภาพงาน...' });
        kpi = await evaluateKPI({ task, instruction: step.instruction, output: stepText, agent });
        send({ type: 'step_kpi', index: i, kpi, phase: 'initial' });

        // Revision loop (1 retry max)
        if (kpi.verdict === 'revise' && kpi.feedback) {
          send({ type: 'step_status', index: i, text: '🔁 ส่ง Feedback ให้ agent แก้ไข...' });
          send({ type: 'step_revising', index: i, feedback: kpi.feedback });
          const revisedText = await runStep(i, agent, step.instruction, previousOutput, kpi.feedback);
          if (revisedText && revisedText.trim()) {
            stepText = revisedText;
            revised = true;
            send({ type: 'step_delta_replace', index: i, text: stepText });
            // Re-evaluate after revision
            send({ type: 'step_status', index: i, text: '📊 ประเมินงานที่แก้ไขแล้ว...' });
            kpi = await evaluateKPI({ task, instruction: step.instruction, output: stepText, agent });
            send({ type: 'step_kpi', index: i, kpi, phase: 'revised' });
          }
        }
      } catch (err) {
        stepText = `⚠️ เกิดข้อผิดพลาด: ${err.message}`;
      }

      stepResults.push({
        agentId: step.agentId, agentName: agent.name, agentEmoji: agent.emoji,
        instruction: step.instruction, output: stepText, kpi, revised
      });
      previousOutput = stepText;
      send({ type: 'step_done', index: i, text: stepText, kpi, revised });
    }

    // Step 3: Final user-facing summary
    send({ type: 'summary_start' });
    const overallScores = stepResults.map(r => r.kpi?.overall || 0).filter(x => x > 0);
    const avgScore = overallScores.length ? Math.round(overallScores.reduce((a, b) => a + b, 0) / overallScores.length) : 0;
    const revisionsCount = stepResults.filter(r => r.revised).length;
    const allIssues = stepResults.flatMap(r => (r.kpi?.issues || []).map(it => `[${r.agentName}] ${it}`));

    const summaryPrompt = `คุณคือ PM กำลังสรุปผลงานทั้งหมดให้ผู้ใช้ฟัง อย่างกระชับและเข้าใจง่าย

โจทย์เดิมของผู้ใช้: "${task}"

ผลการดำเนินงาน:
${stepResults.map((r, i) => `
ขั้นที่ ${i+1}: ${r.agentEmoji} ${r.agentName}
- ภารกิจ: ${r.instruction}
- KPI overall: ${r.kpi?.overall || 'N/A'}/100${r.revised ? ' (หลังแก้ไข)' : ''}
- ปัญหาที่พบ: ${(r.kpi?.issues || []).join('; ') || 'ไม่มี'}
- ผลงานสรุป: ${(r.output || '').slice(0, 500)}
`).join('\n')}

โปรดสรุปให้ผู้ใช้เป็นภาษาไทย ด้วยรูปแบบ:
## สรุปงานที่ทำให้คุณ
(2-3 ประโยคสรุปผลลัพธ์โดยรวม)

## คะแนน KPI เฉลี่ย: ${avgScore}/100

## สิ่งที่ทำเสร็จ
- (รายการ bullet ของผลงานสำคัญ)

## ข้อบกพร่องที่พบและแก้ไข
- (อธิบายปัญหาและการแก้ไขด้วย feedback loop ระหว่าง agent — ถ้าไม่มีให้ระบุ "ไม่พบปัญหา")

## ข้อเสนอแนะถัดไป
- (1-3 ข้อ)

ตอบกระชับ ตรงประเด็น ไม่ต้องใช้ web search`;

    let summaryText = '';
    try {
      const sumStream = query({
        prompt: summaryPrompt,
        options: { systemPrompt: AGENTS.pm.system, allowedTools: [], maxTurns: 2 }
      });
      for await (const msg of sumStream) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const b of msg.message.content) {
            if (b.type === 'text' && b.text?.length > summaryText.length) {
              send({ type: 'summary_delta', text: b.text.slice(summaryText.length) });
              summaryText = b.text;
            }
          }
        }
        if (msg.type === 'result') {
          const f = msg.result || summaryText;
          if (f.length > summaryText.length) send({ type: 'summary_delta', text: f.slice(summaryText.length) });
          summaryText = f;
        }
      }
    } catch (e) {
      summaryText = `สรุปไม่สำเร็จ: ${e.message}`;
    }

    // Save to long-term memory
    rememberTask(sessionId, {
      task,
      summary: summaryText.slice(0, 400),
      avgKPI: avgScore,
      revisions: revisionsCount,
      agents: stepResults.map(r => r.agentId)
    });

    send({
      type: 'summary_done',
      text: summaryText,
      stats: { avgKPI: avgScore, revisions: revisionsCount, totalSteps: stepResults.length, issues: allIssues }
    });
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
