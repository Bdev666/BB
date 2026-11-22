const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dash', {
  invoke: (cmd, ...args) => ipcRenderer.invoke('dash:' + cmd, ...args),
  platform: process.platform,
  onState: (cb) => ipcRenderer.on('dash:state', (_e, s) => cb(s)),
  onSelftest: (cb) => ipcRenderer.on('dash:selftest-step', (_e, s) => cb(s)),
  onTab: (cb) => ipcRenderer.on('settings:tab', (_e, t) => cb(t)),
});
