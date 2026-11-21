// Stand-in for api.telegram.org: same JSON API shape (getUpdates long-poll, sendMessage).
const http = require('http');
function startMock(port) {
  const updates = []; const sent = []; let nextId = 1000; const waiters = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const method = req.url.split('/').pop();
      const reply = (result) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'sendMessage') { sent.push({ chat: String(json.chat_id), text: json.text, at: Date.now() }); return reply({ message_id: sent.length }); }
      if (method === 'getUpdates') {
        const take = () => {
          if (json.offset === -1) return updates.slice(-1);
          return updates.filter((u) => u.update_id >= (json.offset || 0));
        };
        const now = take();
        if (now.length || !json.timeout) return reply(now);
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reply(take()); }, Math.min(json.timeout, 2) * 1000);
        const w = () => { clearTimeout(t); reply(take()); };
        waiters.push(w);
        return;
      }
      reply(true);
    });
  });
  server.listen(port);
  return {
    push(chatId, text) { updates.push({ update_id: nextId++, message: { message_id: nextId, chat: { id: chatId }, text } }); waiters.splice(0).forEach((w) => w()); },
    sent, close: () => server.close(),
  };
}
module.exports = { startMock };
