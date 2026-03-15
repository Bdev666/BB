import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Agent Definitions ───────────────────────────────────────────────────────

export const AGENTS = {
  assistant: {
    id: 'assistant',
    name: 'ผู้ช่วย',
    emoji: '🤖',
    color: '#4F46E5',
    role: 'General Assistant',
    description: 'ตอบคำถาม ค้นหาข้อมูล อธิบายเนื้อหา',
    allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion'],
    systemPrompt: `คุณคือ AI ผู้ช่วยอเนกประสงค์ใน Multi-Agent AI Office
ตอบเป็นภาษาไทยเสมอ เป็นกันเอง ชัดเจน และเป็นประโยชน์
ช่วยตอบคำถาม อธิบายแนวคิด และค้นหาข้อมูลได้`
  },
  coder: {
    id: 'coder',
    name: 'โปรแกรมเมอร์',
    emoji: '💻',
    color: '#7C3AED',
    role: 'Software Developer',
    description: 'เขียนโค้ด debug แก้ไขไฟล์ รันคำสั่ง',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    systemPrompt: `คุณคือ AI โปรแกรมเมอร์ผู้เชี่ยวชาญใน Multi-Agent AI Office
ตอบเป็นภาษาไทยเสมอ แต่ชื่อตัวแปร/โค้ดใช้ภาษาอังกฤษตามมาตรฐาน
เขียนโค้ดได้ทุกภาษา debug หาข้อผิดพลาด และแก้ไขไฟล์ได้จริง`
  },
  analyst: {
    id: 'analyst',
    name: 'นักวิเคราะห์',
    emoji: '📊',
    color: '#D97706',
    role: 'Data Analyst',
    description: 'วิเคราะห์ข้อมูล อ่านไฟล์ สรุปรายงาน',
    allowedTools: ['Read', 'Bash', 'Glob', 'Grep', 'Write'],
    systemPrompt: `คุณคือ AI นักวิเคราะห์ข้อมูลใน Multi-Agent AI Office
ตอบเป็นภาษาไทยเสมอ ใช้ข้อมูลเชิงตัวเลข ให้เหตุผลอย่างมีระบบ
วิเคราะห์ไฟล์ข้อมูล ประมวลผลด้วย bash/python และสรุปผลได้`
  },
  writer: {
    id: 'writer',
    name: 'นักเขียน',
    emoji: '✍️',
    color: '#059669',
    role: 'Content Writer',
    description: 'เขียนบทความ เนื้อหา บันทึกไฟล์',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob'],
    systemPrompt: `คุณคือ AI นักเขียนมืออาชีพใน Multi-Agent AI Office
ตอบเป็นภาษาไทยเสมอ มีความคิดสร้างสรรค์ เขียนได้ไพเราะน่าอ่าน
เขียนบทความ บล็อก เนื้อหาการตลาด รายงาน และบันทึกเป็นไฟล์ได้`
  },
  secretary: {
    id: 'secretary',
    name: 'เลขานุการ',
    emoji: '📋',
    color: '#DC2626',
    role: 'Office Secretary',
    description: 'จัดการเอกสาร บันทึก ค้นหาไฟล์',
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    systemPrompt: `คุณคือ AI เลขานุการมืออาชีพใน Multi-Agent AI Office
ตอบเป็นภาษาไทยเสมอ เป็นทางการ สุภาพ มีระเบียบแบบแผน
จัดการเอกสาร สรุปข้อมูล ค้นหาไฟล์ และบันทึกรายงานได้`
  }
};

// ─── Agent State ──────────────────────────────────────────────────────────────

const agentStates = {};
const agentSessions = {};  // store session IDs for multi-turn

Object.keys(AGENTS).forEach(id => {
  agentStates[id] = {
    status: 'idle',       // idle | working | error
    currentTask: null,
    lastResult: null,
    turnCount: 0,
    sessionId: null,
    workDir: path.join(__dirname, 'workspaces', id)
  };
});

// Ensure workspace directories exist
export async function initWorkspaces() {
  await Promise.all(
    Object.keys(AGENTS).map(id =>
      mkdir(path.join(__dirname, 'workspaces', id), { recursive: true })
    )
  );
}

// ─── Run Agent ────────────────────────────────────────────────────────────────

export async function runAgentTask(agentId, prompt, io) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`ไม่พบ agent: ${agentId}`);

  const state = agentStates[agentId];
  if (state.status === 'working') {
    throw new Error(`${agent.name} กำลังทำงานอยู่`);
  }

  state.status = 'working';
  state.currentTask = prompt;
  state.turnCount++;
  io.emit('agentStatus', { agentId, status: 'working', task: prompt });

  // Emit user message to dashboard
  io.emit('agentMessage', {
    agentId,
    role: 'user',
    text: prompt,
    timestamp: Date.now()
  });

  try {
    const queryOptions = {
      prompt,
      options: {
        cwd: state.workDir,
        allowedTools: agent.allowedTools,
        permissionMode: 'acceptEdits',
        systemPrompt: agent.systemPrompt,
        maxTurns: 10,
        // Resume previous session for multi-turn conversation
        ...(state.sessionId ? { resume: state.sessionId } : {})
      }
    };

    let fullText = '';
    let currentToolUse = null;

    for await (const msg of query(queryOptions)) {

      // Capture session ID on first turn
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (!state.sessionId) {
          state.sessionId = msg.session_id;
          agentStates[agentId].sessionId = msg.session_id;
        }
        continue;
      }

      // Assistant text and tool use blocks
      if (msg.type === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            fullText += block.text;
            io.emit('agentToken', { agentId, token: block.text });
          }
          if (block.type === 'tool_use') {
            currentToolUse = {
              tool: block.name,
              input: summarizeInput(block.name, block.input)
            };
            io.emit('agentToolUse', { agentId, ...currentToolUse });
          }
        }
      }

      // Final result
      if ('result' in msg) {
        state.lastResult = msg.result;
        if (msg.result && !fullText) {
          fullText = msg.result;
        }
      }
    }

    state.status = 'idle';
    state.currentTask = null;
    io.emit('agentStatus', { agentId, status: 'idle', task: null });
    io.emit('agentDone', {
      agentId,
      text: fullText,
      sessionId: state.sessionId,
      turnCount: state.turnCount
    });

    return fullText;

  } catch (err) {
    state.status = 'error';
    state.currentTask = null;
    io.emit('agentStatus', { agentId, status: 'error', task: null });
    io.emit('agentError', { agentId, error: err.message });
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function summarizeInput(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Bash': return (input.command || '').slice(0, 80);
    case 'Glob': return input.pattern || '';
    case 'Grep': return `"${input.pattern || ''}"`;
    case 'WebSearch': return input.query || '';
    case 'WebFetch': return input.url || '';
    default: return JSON.stringify(input).slice(0, 80);
  }
}

export function clearSession(agentId) {
  if (agentStates[agentId]) {
    agentStates[agentId].sessionId = null;
    agentStates[agentId].turnCount = 0;
    agentStates[agentId].lastResult = null;
  }
}

export function getAgentStates() {
  return Object.fromEntries(
    Object.keys(AGENTS).map(id => [id, { ...agentStates[id] }])
  );
}
