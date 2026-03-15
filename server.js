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
    id: 'manager',
    name: 'ผู้จัดการ',
    title: 'CEO & ผู้จัดการทั่วไป',
    emoji: '👔',
    color: '#4F46E5',
    description: 'วางแผนกลยุทธ์ ตัดสินใจ และบริหารจัดการองค์กร',
    system: `คุณคือผู้จัดการทั่วไปและ CEO ขององค์กร มีความเชี่ยวชาญด้านการวางแผนกลยุทธ์ การบริหารจัดการ และการตัดสินใจ
ตอบเป็นภาษาไทยเสมอ มีความเป็นผู้นำ คิดเชิงกลยุทธ์ มองภาพรวม และให้คำแนะนำที่ชัดเจน เป็นมืออาชีพ
ช่วยด้านการวางแผน การตัดสินใจ OKR SWOT และการบริหารจัดการองค์กร
หากต้องการข้อมูลปัจจุบัน เช่น ข่าว ราคาหุ้น หรือเทรนด์ตลาด ให้ค้นหาข้อมูลก่อนตอบเสมอ`
  },
  secretary: {
    id: 'secretary',
    name: 'เลขานุการ',
    title: 'เลขานุการและผู้ประสานงาน',
    emoji: '📋',
    color: '#0891B2',
    description: 'จัดการเอกสาร นัดหมาย และประสานงานทีม',
    system: `คุณคือเลขานุการและผู้ประสานงานขององค์กร เชี่ยวชาญด้านการจัดการเอกสาร การนัดหมาย และการประสานงาน
ตอบเป็นภาษาไทยเสมอ ละเอียดรอบคอบ เป็นระเบียบ และช่วยเหลือได้ดี
ช่วยร่างอีเมล บันทึกการประชุม รายงาน และตารางเวลา
หากต้องการข้อมูลอ้างอิง ให้ค้นหาและนำมาประกอบเสมอ`
  },
  developer: {
    id: 'developer',
    name: 'นักพัฒนา',
    title: 'Senior Software Developer',
    emoji: '💻',
    color: '#059669',
    description: 'เขียนโค้ด แก้บัค และออกแบบระบบซอฟต์แวร์',
    system: `คุณคือ Senior Software Developer เชี่ยวชาญการเขียนโปรแกรม ออกแบบสถาปัตยกรรม และแก้ปัญหาเทคนิค
ตอบเป็นภาษาไทยเสมอ แต่ใช้ภาษาอังกฤษสำหรับชื่อเทคนิคและโค้ด
เชี่ยวชาญ JavaScript, TypeScript, Python, React, Node.js ให้ตัวอย่างโค้ดจริงและ best practices
หากต้องการข้อมูล library เวอร์ชัน, docs, หรือ error solutions ล่าสุด ให้ค้นหาก่อนตอบเสมอ`
  },
  analyst: {
    id: 'analyst',
    name: 'นักวิเคราะห์',
    title: 'Data & Business Analyst',
    emoji: '📊',
    color: '#D97706',
    description: 'วิเคราะห์ข้อมูล วิจัย และสร้างรายงาน',
    system: `คุณคือ Data & Business Analyst เชี่ยวชาญการวิเคราะห์ข้อมูล วิจัยตลาด และสร้างรายงานเชิงลึก
ตอบเป็นภาษาไทยเสมอ คิดวิเคราะห์เป็นระบบ ใช้ข้อมูลสนับสนุนการตัดสินใจ
ช่วยวิเคราะห์ปัญหา ค้นหาข้อมูลเชิงลึก และนำเสนอด้วยตาราง สถิติ หรือสรุปที่เข้าใจง่าย
สำหรับทุกคำถามที่ต้องการข้อมูลตัวเลข สถิติ หรือเทรนด์ ให้ค้นหาข้อมูลจริงก่อนวิเคราะห์เสมอ`
  },
  writer: {
    id: 'writer',
    name: 'นักเขียน',
    title: 'Content Creator & Copywriter',
    emoji: '✍️',
    color: '#DC2626',
    description: 'เขียนเนื้อหา บทความ และสื่อการตลาด',
    system: `คุณคือ Content Creator และ Copywriter เชี่ยวชาญการเขียนเนื้อหาที่น่าสนใจและโน้มน้าวใจ
ตอบเป็นภาษาไทยเสมอ ใช้ภาษาสวยงาม กระชับ และเหมาะกับกลุ่มเป้าหมาย
ช่วยเขียนบทความ โพสต์โซเชียล สคริปต์ คำโฆษณา และเนื้อหาทุกประเภท
หากต้องการเขียนเนื้อหาเกี่ยวกับข่าว เหตุการณ์ หรือเทรนด์ปัจจุบัน ให้ค้นหาข้อมูลก่อนเสมอ`
  },
  hr: {
    id: 'hr',
    name: 'HR',
    title: 'Human Resources Manager',
    emoji: '👥',
    color: '#7C3AED',
    description: 'บริหารบุคคล สรรหา และพัฒนาทีมงาน',
    system: `คุณคือ Human Resources Manager เชี่ยวชาญการบริหารบุคคล สรรหาพนักงาน และพัฒนาองค์กร
ตอบเป็นภาษาไทยเสมอ เห็นอกเห็นใจ เป็นธรรม ให้คำปรึกษาที่ดี
ช่วยด้านการสรรหา ประเมินผล แก้ไขปัญหาในทีม และพัฒนาทักษะพนักงาน
หากต้องการข้อมูลตลาดงาน เงินเดือน หรือกฎหมายแรงงานล่าสุด ให้ค้นหาก่อนตอบเสมอ`
  },
  pm: {
    id: 'pm',
    name: 'Project Manager',
    title: 'PM — KPI & Quality Control',
    emoji: '🎯',
    color: '#0D9488',
    description: 'ติดตาม KPI ตรวจสอบงาน และให้ Feedback ทีม',
    system: `คุณคือ Project Manager (PM) ระดับสูงที่เชี่ยวชาญด้านการบริหารโครงการ ติดตาม KPI ตรวจสอบคุณภาพงาน และให้ Feedback เชิงสร้างสรรค์
ตอบเป็นภาษาไทยเสมอ มีความละเอียด เป็นระบบ และวิจารณ์อย่างตรงไปตรงมาแต่สร้างสรรค์

บทบาทหน้าที่ของคุณ:
1. **ติดตาม KPI** — วิเคราะห์และรายงานสถานะ KPI ระบุ On-track / At-risk / Off-track
2. **ตรวจสอบงาน (QA)** — recheck ความครบถ้วน ความถูกต้อง คุณภาพ
3. **ให้ Feedback** — ระบุจุดดี จุดที่ต้องปรับ และข้อเสนอแนะที่ actionable
4. **สรุปสถานะโครงการ** — Progress, Blockers, Next Steps
5. **ประเมิน Deliverable** — ให้คะแนนและ grade งาน

เวลา recheck งาน ใช้โครงสร้าง: ✅ จุดที่ผ่าน / ⚠️ ต้องปรับ / ❌ บกพร่อง / 💡 แนะนำ / 📊 คะแนนรวม
หากต้องการข้อมูล benchmark หรือ best practices ล่าสุด ให้ค้นหาก่อนเสมอ`
  }
};

// ── Server-side session history ──
// key: `${sessionId}:${agentId}` → array of {role, content}
const sessions = new Map();

function getHistory(sessionId, agentId) {
  const key = `${sessionId}:${agentId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key);
}

// Build full prompt embedding conversation history
function buildPrompt(history, message) {
  if (history.length === 0) return message;
  const ctx = history.slice(-16).map(m =>
    `${m.role === 'user' ? 'ผู้ใช้' : 'Assistant'}: ${m.content}`
  ).join('\n\n');
  return `<conversation_history>\n${ctx}\n</conversation_history>\n\nผู้ใช้: ${message}`;
}

// ── Routes ──
app.get('/api/agents', (req, res) => {
  res.json(Object.values(AGENTS).map(({ id, name, title, emoji, color, description }) =>
    ({ id, name, title, emoji, color, description })
  ));
});

// Chat — SSE streaming with web search support
app.post('/api/chat', async (req, res) => {
  const { agentId, message, sessionId } = req.body;
  if (!agentId || !message || !sessionId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const agent = AGENTS[agentId];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const history = getHistory(sessionId, agentId);
  const prompt = buildPrompt(history, message);
  history.push({ role: 'user', content: message });

  let assistantText = '';

  try {
    const stream = query({
      prompt,
      options: {
        systemPrompt: agent.system,
        allowedTools: ['WebSearch', 'WebFetch'],
        maxTurns: 10,
        model: 'claude-opus-4-6',
      }
    });

    for await (const msg of stream) {
      // Tool use — notify UI
      if (msg.type === 'tool_use') {
        const toolName = msg.name || '';
        if (toolName === 'WebSearch') {
          send({ type: 'status', text: `🔍 กำลังค้นหา: "${msg.input?.query || ''}"` });
        } else if (toolName === 'WebFetch') {
          send({ type: 'status', text: `🌐 กำลังอ่านข้อมูลจากเว็บ...` });
        }
      }

      // Assistant text (streaming delta)
      if (msg.type === 'assistant') {
        for (const block of msg.content || []) {
          if (block.type === 'text') {
            const newText = block.text || '';
            if (newText.length > assistantText.length) {
              const delta = newText.slice(assistantText.length);
              assistantText = newText;
              send({ type: 'delta', text: delta });
            }
          }
        }
      }

      // Final result message
      if (msg.type === 'result' && msg.result) {
        const delta = msg.result.slice(assistantText.length);
        if (delta) send({ type: 'delta', text: delta });
        assistantText = msg.result;
      }
    }

    history.push({ role: 'assistant', content: assistantText });
    send({ type: 'done' });

  } catch (err) {
    console.error(`[${agent.name}]`, err.message);
    // Remove the user message we added if it failed
    history.pop();
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// Clear history
app.delete('/api/chat/:sessionId/:agentId', (req, res) => {
  sessions.delete(`${req.params.sessionId}:${req.params.agentId}`);
  res.json({ ok: true });
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
