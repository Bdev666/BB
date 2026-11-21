// Runs inside each game window before the game's own scripts.
// 1. Reports the browser's online/offline state.
// 2. Remembers the game's WebSocket so commands the player presses on the Dashboard
//    (sell, chat, market price ...) can go out exactly as the game's own client
//    sends them. Nothing is sent unless the player asks for it.
const { ipcRenderer, webFrame } = require('electron');

window.addEventListener('online', () => ipcRenderer.send('game:net', true));
window.addEventListener('offline', () => ipcRenderer.send('game:net', false));

webFrame.executeJavaScript(`(() => {
  const Native = window.WebSocket;
  if (!Native || window.__bdSend) return;
  const sockets = [];
  window.WebSocket = new Proxy(Native, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      sockets.push(ws);
      if (sockets.length > 8) sockets.shift();
      return ws;
    },
  });
  // send one binary frame (base64) on the open game-room socket; true if sent
  Object.defineProperty(window, '__bdSend', {
    value: (b64) => {
      const ws = sockets.slice().reverse().find((s) => s.readyState === 1 && /sessionId=/.test(s.url));
      if (!ws) return false;
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      ws.send(bytes);
      return true;
    },
  });
})();`).catch(() => {});
