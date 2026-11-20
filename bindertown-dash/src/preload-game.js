// Runs inside each game window. Only reports the browser's online/offline state.
// Game traffic is observed from the main process (DevTools protocol), read-only:
// nothing is injected into the game and nothing is sent to the game server.
const { ipcRenderer } = require('electron');

window.addEventListener('online', () => ipcRenderer.send('game:net', true));
window.addEventListener('offline', () => ipcRenderer.send('game:net', false));
