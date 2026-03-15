require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { AGENTS, runAgent, clearHistory, agentStates } = require('./agents');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API: Get all agents info
app.get('/api/agents', (req, res) => {
  const agents = Object.values(AGENTS).map(agent => ({
    ...agent,
    state: agentStates[agent.id]
  }));
  res.json(agents);
});

// API: Send task to specific agent
app.post('/api/agents/:agentId/task', async (req, res) => {
  const { agentId } = req.params;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'ต้องระบุข้อความ' });
  if (!AGENTS[agentId]) return res.status(404).json({ error: 'ไม่พบ agent' });

  if (agentStates[agentId].status === 'working') {
    return res.status(409).json({ error: `${AGENTS[agentId].name} กำลังทำงานอยู่` });
  }

  // Run async, don't wait
  runAgent(agentId, message, io).catch(err => {
    console.error(`Agent ${agentId} error:`, err.message);
  });

  res.json({ success: true, message: `ส่งงานให้ ${AGENTS[agentId].name} แล้ว` });
});

// API: Broadcast task to ALL agents simultaneously
app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'ต้องระบุข้อความ' });

  const busyAgents = Object.entries(agentStates)
    .filter(([, state]) => state.status === 'working')
    .map(([id]) => AGENTS[id].name);

  if (busyAgents.length > 0) {
    return res.status(409).json({
      error: `Agent ต่อไปนี้กำลังทำงานอยู่: ${busyAgents.join(', ')}`
    });
  }

  // Run all agents in parallel
  const agentIds = Object.keys(AGENTS);
  agentIds.forEach(agentId => {
    runAgent(agentId, message, io).catch(err => {
      console.error(`Agent ${agentId} error:`, err.message);
    });
  });

  res.json({ success: true, message: `ส่งงานให้ทุก agent แล้ว (${agentIds.length} ตัว)` });
});

// API: Clear agent conversation history
app.post('/api/agents/:agentId/clear', (req, res) => {
  const { agentId } = req.params;
  if (!AGENTS[agentId]) return res.status(404).json({ error: 'ไม่พบ agent' });
  clearHistory(agentId);
  res.json({ success: true, message: `ล้างประวัติ ${AGENTS[agentId].name} แล้ว` });
});

// Socket.io connections
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Send current agent states on connect
  const agents = Object.values(AGENTS).map(agent => ({
    ...agent,
    state: agentStates[agent.id]
  }));
  socket.emit('init', { agents });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Multi-Agent AI Office กำลังทำงานที่ http://localhost:${PORT}`);
  console.log(`📋 Agents ที่พร้อมใช้งาน:`);
  Object.values(AGENTS).forEach(a => {
    console.log(`   ${a.emoji} ${a.name}`);
  });
  console.log('\n');
});
