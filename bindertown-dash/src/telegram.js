// Optional Telegram notifications (bot made with @BotFather)
const API = 'https://api.telegram.org/bot';

async function call(token, method, body) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
  return json.result;
}

// Find the chat of whoever last sent the bot a message (/start)
async function findChatId(token) {
  const updates = await call(token, 'getUpdates', { timeout: 0 });
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].message || updates[i].my_chat_member;
    if (msg && msg.chat) return String(msg.chat.id);
  }
  return null;
}

async function send(token, chatId, text) {
  if (!token || !chatId) return;
  await call(token, 'sendMessage', { chat_id: chatId, text });
}

module.exports = { findChatId, send };
