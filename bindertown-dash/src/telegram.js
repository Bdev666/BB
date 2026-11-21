// Telegram (bot made with @BotFather): notifications out, and — when switched on in
// Settings — commands in from the owner's chat only (remote control from a phone).
// BINDERDASH_TG_API can point at a stand-in server for testing; normally it's Telegram.
const API = (process.env.BINDERDASH_TG_API || 'https://api.telegram.org').replace(/\/+$/, '') + '/bot';

async function call(token, method, body, signal) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal,
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
  await call(token, 'sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000) });
}

// Long-polls the bot for messages. Only messages from `chatId` reach `onCommand`;
// anything else is ignored (and reported through `onIgnored`, for the log).
class Remote {
  constructor({ onCommand, onIgnored, onError }) {
    this.onCommand = onCommand;
    this.onIgnored = onIgnored || (() => {});
    this.onError = onError || (() => {});
    this.running = false;
    this.offset = 0;
    this.abort = null;
  }

  start(token, chatId) {
    if (this.running && this.token === token && this.chatId === chatId) return;
    this.stop();
    this.token = token;
    this.chatId = String(chatId);
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    this.abort = null;
  }

  async loop() {
    // skip whatever was sent while BinderDash was closed: old commands shouldn't run now
    try {
      const old = await call(this.token, 'getUpdates', { offset: -1, timeout: 0 });
      if (old.length) this.offset = old[old.length - 1].update_id + 1;
    } catch (err) { this.onError(err); }
    while (this.running) {
      this.abort = new AbortController();
      try {
        // eslint-disable-next-line no-await-in-loop
        const updates = await call(this.token, 'getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] }, this.abort.signal);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || typeof m.text !== 'string') continue;
          if (String(m.chat && m.chat.id) !== this.chatId) { this.onIgnored(m); continue; }
          let reply;
          // eslint-disable-next-line no-await-in-loop
          try { reply = await this.onCommand(m.text.trim()); } catch (err) { reply = `ทำไม่สำเร็จ: ${err.message || err}`; }
          // eslint-disable-next-line no-await-in-loop
          if (reply) await send(this.token, this.chatId, reply).catch((err) => this.onError(err));
        }
      } catch (err) {
        if (!this.running) break;
        this.onError(err);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

module.exports = { findChatId, send, Remote };
