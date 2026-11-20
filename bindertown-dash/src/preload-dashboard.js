const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  invoke: (cmd, ...args) => ipcRenderer.invoke('dash:' + cmd, ...args),
  onState: (cb) => ipcRenderer.on('dash:state', (_e, s) => cb(s)),
});
