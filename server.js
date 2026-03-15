import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);
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
ช่วยด้านการวางแผน การตัดสินใจ OKR SWOT และการบริหารจัดการองค์กร`
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
ช่วยร่างอีเมล บันทึกการประชุม รายงาน และตารางเวลา`
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
เชี่ยวชาญ JavaScript, TypeScript, Python, React, Node.js ให้ตัวอย่างโค้ดจริงและ best practices`
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
ช่วยวิเคราะห์ปัญหา ค้นหาข้อมูลเชิงลึก และนำเสนอด้วยตาราง สถิติ หรือสรุปที่เข้าใจง่าย`
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
ช่วยเขียนบทความ โพสต์โซเชียล สคริปต์ คำโฆษณา และเนื้อหาทุกประเภท`
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
ช่วยด้านการสรรหา ประเมินผล แก้ไขปัญหาในทีม และพัฒนาทักษะพนักงาน`
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
1. **ติดตาม KPI** — วิเคราะห์และรายงานสถานะ KPI ของแต่ละทีม/โครงการ ระบุ On-track / At-risk / Off-track
2. **ตรวจสอบงาน (QA)** — รับงานหรือผลลัพธ์จากทีม แล้ว recheck ความครบถ้วน ความถูกต้อง คุณภาพ
3. **ให้ Feedback** — ให้ feedback ที่ชัดเจน ระบุจุดดี จุดที่ต้องปรับ และข้อเสนอแนะที่ actionable
4. **สรุปสถานะโครงการ** — สร้าง Project Status Report ระบุ Progress, Blockers, Next Steps
5. **ประเมิน Deliverable** — ให้คะแนนและ grade งาน พร้อม justification

เวลา recheck งาน ให้ใช้โครงสร้างนี้:
- ✅ จุดที่ผ่าน
- ⚠️ จุดที่ต้องปรับปรุง
- ❌ จุดที่บกพร่อง / ขาดหาย
- 💡 ข้อเสนอแนะเพิ่มเติม
- 📊 คะแนนรวม (เช่น 8/10)

เวลาติดตาม KPI ให้แสดงในรูปแบบตาราง พร้อม status indicator และ action items`
  }
};

// ── Routes ──
app.get('/api/agents', (req, res) => {
  res.json(Object.values(AGENTS).map(({ id, name, title, emoji, color, description }) =>
    ({ id, name, title, emoji, color, description })
  ));
});

// Chat endpoint — streams SSE using Claude Agent SDK
app.post('/api/chat', async (req, res) => {
  const { agentId, message, history: clientHistory = [] } = req.body;

  if (!agentId || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const agent = AGENTS[agentId];
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Build prompt: include conversation history for context
    let fullPrompt = '';
    if (clientHistory.length > 0) {
      const ctx = clientHistory.slice(-10).map(m =>
        `${m.role === 'user' ? 'ผู้ใช้' : agent.name}: ${m.content}`
      ).join('\n');
      fullPrompt = `บริบทการสนทนาก่อนหน้า:\n${ctx}\n\nผู้ใช้: ${message}`;
    } else {
      fullPrompt = message;
    }

    const stream = query({
      prompt: fullPrompt,
      options: {
        systemPrompt: agent.system,
        allowedTools: [],  // text only — no file/web tools needed
        maxTurns: 1,
      }
    });

    let assistantText = '';

    for await (const msg of stream) {
      // AssistantMessage with streaming content
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
      // Result message
      if ('result' in msg && msg.result) {
        if (msg.result !== assistantText) {
          const delta = msg.result.slice(assistantText.length);
          if (delta) send({ type: 'delta', text: delta });
          assistantText = msg.result;
        }
      }
    }

    send({ type: 'done', fullText: assistantText });

  } catch (err) {
    console.error(`[${agent.name}] Error:`, err.message);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
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
