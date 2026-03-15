const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AGENTS = {
  assistant: {
    id: 'assistant',
    name: 'ผู้ช่วย (Assistant)',
    emoji: '🤖',
    color: '#4F46E5',
    systemPrompt: `คุณคือ AI ผู้ช่วยอเนกประสงค์ที่ชื่อ "ผู้ช่วย" ใน Multi-Agent AI Office
คุณมีความสามารถในการตอบคำถาม ให้คำแนะนำ และช่วยแก้ปัญหาทั่วไปได้อย่างครอบคลุม
ตอบเป็นภาษาไทยเสมอ เป็นกันเอง ชัดเจน และเป็นประโยชน์`
  },
  writer: {
    id: 'writer',
    name: 'นักเขียน (Writer)',
    emoji: '✍️',
    color: '#059669',
    systemPrompt: `คุณคือ AI นักเขียนมืออาชีพที่ชื่อ "นักเขียน" ใน Multi-Agent AI Office
ความเชี่ยวชาญ: เขียนบทความ บล็อก เนื้อหาการตลาด สโลแกน คำอธิบายสินค้า นิยาย และเนื้อหาต่างๆ
ตอบเป็นภาษาไทยเสมอ มีความคิดสร้างสรรค์ และเขียนได้ไพเราะน่าอ่าน`
  },
  analyst: {
    id: 'analyst',
    name: 'นักวิเคราะห์ (Analyst)',
    emoji: '📊',
    color: '#D97706',
    systemPrompt: `คุณคือ AI นักวิเคราะห์ข้อมูลที่ชื่อ "นักวิเคราะห์" ใน Multi-Agent AI Office
ความเชี่ยวชาญ: วิเคราะห์ข้อมูล ตีความสถิติ ประเมินความเสี่ยง วิเคราะห์ตลาด และให้ข้อมูลเชิงลึก
ตอบเป็นภาษาไทยเสมอ ใช้ข้อมูลเชิงตัวเลข และให้เหตุผลอย่างมีระบบ`
  },
  coder: {
    id: 'coder',
    name: 'โปรแกรมเมอร์ (Coder)',
    emoji: '💻',
    color: '#7C3AED',
    systemPrompt: `คุณคือ AI โปรแกรมเมอร์ผู้เชี่ยวชาญที่ชื่อ "โปรแกรมเมอร์" ใน Multi-Agent AI Office
ความเชี่ยวชาญ: เขียนโค้ด debug แนะนำ architecture อธิบายการทำงานของโค้ด และแก้ปัญหาทางเทคนิค
ตอบเป็นภาษาไทยเสมอ แต่ชื่อตัวแปร/โค้ดให้ใช้ภาษาอังกฤษตามมาตรฐาน`
  },
  secretary: {
    id: 'secretary',
    name: 'เลขานุการ (Secretary)',
    emoji: '📋',
    color: '#DC2626',
    systemPrompt: `คุณคือ AI เลขานุการมืออาชีพที่ชื่อ "เลขานุการ" ใน Multi-Agent AI Office
ความเชี่ยวชาญ: จัดการนัดหมาย เขียนอีเมล สรุปการประชุม จัดทำเอกสาร และประสานงาน
ตอบเป็นภาษาไทยเสมอ เป็นทางการ สุภาพ และมีระเบียบแบบแผน`
  }
};

// Track agent states and conversation histories
const agentStates = {};
const conversationHistories = {};

Object.keys(AGENTS).forEach(id => {
  agentStates[id] = { status: 'idle', currentTask: null };
  conversationHistories[id] = [];
});

async function runAgent(agentId, userMessage, io) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`ไม่พบ agent: ${agentId}`);

  agentStates[agentId].status = 'working';
  agentStates[agentId].currentTask = userMessage;

  // Emit status update
  io.emit('agentStatus', { agentId, status: 'working', task: userMessage });

  // Add to history
  conversationHistories[agentId].push({ role: 'user', content: userMessage });

  // Keep last 20 messages for context
  if (conversationHistories[agentId].length > 20) {
    conversationHistories[agentId] = conversationHistories[agentId].slice(-20);
  }

  try {
    let fullResponse = '';

    const stream = await client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: agent.systemPrompt,
      messages: conversationHistories[agentId]
    });

    // Stream tokens in real-time
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        io.emit('agentToken', { agentId, token: event.delta.text });
      }
    }

    // Save assistant response to history
    conversationHistories[agentId].push({ role: 'assistant', content: fullResponse });

    agentStates[agentId].status = 'idle';
    agentStates[agentId].currentTask = null;
    io.emit('agentStatus', { agentId, status: 'idle', task: null });
    io.emit('agentDone', { agentId, response: fullResponse });

    return fullResponse;
  } catch (error) {
    agentStates[agentId].status = 'error';
    agentStates[agentId].currentTask = null;
    io.emit('agentStatus', { agentId, status: 'error', task: null });
    io.emit('agentError', { agentId, error: error.message });
    throw error;
  }
}

function clearHistory(agentId) {
  if (conversationHistories[agentId]) {
    conversationHistories[agentId] = [];
  }
}

function getAgentState(agentId) {
  return agentStates[agentId] || null;
}

module.exports = { AGENTS, runAgent, clearHistory, getAgentState, agentStates };
