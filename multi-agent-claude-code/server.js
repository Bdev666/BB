import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { AGENTS, runAgentTask, clearSession, getAgentStates, initWorkspaces } from './agentManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ─── REST API ─────────────────────────────────────────────────────────────────

// List all agents with current state
app.get('/api/agents', (req, res) => {
  const states = getAgentStates();
  const agents = Object.values(AGENTS).map(a => ({
    ...a,
    state: states[a.id]
  }));
  res.json(agents);
});

// Send task to one agent
app.post('/api/agents/:agentId/task', async (req, res) => {
  const { agentId } = req.params;
  const { message } = req.body;

  if (!AGENTS[agentId]) return res.status(404).json({ error: 'ไม่พบ agent' });
  if (!message?.trim()) return res.status(400).json({ error: 'ต้องระบุข้อความ' });

  const states = getAgentStates();
  if (states[agentId].status === 'working') {
    return res.status(409).json({ error: `${AGENTS[agentId].name} กำลังทำงานอยู่` });
  }

  runAgentTask(agentId, message.trim(), io).catch(err =>
    console.error(`[${agentId}] error:`, err.message)
  );

  res.json({ success: true, message: `ส่งงานให้ ${AGENTS[agentId].name} แล้ว` });
});

// Broadcast to ALL agents simultaneously
app.post('/api/broadcast', (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'ต้องระบุข้อความ' });

  const states = getAgentStates();
  const busy = Object.entries(states)
    .filter(([, s]) => s.status === 'working')
    .map(([id]) => AGENTS[id].name);

  if (busy.length > 0) {
    return res.status(409).json({ error: `กำลังทำงานอยู่: ${busy.join(', ')}` });
  }

  const agentIds = Object.keys(AGENTS);
  agentIds.forEach(id => {
    runAgentTask(id, message.trim(), io).catch(err =>
      console.error(`[${id}] error:`, err.message)
    );
  });

  res.json({ success: true, message: `ส่งงานให้ ${agentIds.length} agents พร้อมกัน` });
});

// Clear session / reset agent
app.post('/api/agents/:agentId/reset', (req, res) => {
  const { agentId } = req.params;
  if (!AGENTS[agentId]) return res.status(404).json({ error: 'ไม่พบ agent' });
  clearSession(agentId);
  res.json({ success: true, message: `รีเซ็ต session ${AGENTS[agentId].name} แล้ว` });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[WS] client connected: ${socket.id}`);

  const states = getAgentStates();
  const agents = Object.values(AGENTS).map(a => ({ ...a, state: states[a.id] }));
  socket.emit('init', { agents });

  socket.on('disconnect', () => console.log(`[WS] client disconnected: ${socket.id}`));
});

// ─── Start ────────────────────────────────────────────────────────────────────

await initWorkspaces();

httpServer.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       🏢  Multi-Agent Claude Code Office      ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  🌐  http://localhost:${PORT}                     ║`);
  console.log('╠══════════════════════════════════════════════╣');
  Object.values(AGENTS).forEach(a => {
    const tools = a.allowedTools.join(', ');
    console.log(`║  ${a.emoji}  ${a.name.padEnd(14)} [${tools.slice(0, 26).padEnd(26)}]  ║`);
  });
  console.log('╚══════════════════════════════════════════════╝\n');
});
