const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  git: (op, ...args) => ipcRenderer.invoke('git', op, ...args),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  openInEditor: (cmd, targets) => ipcRenderer.invoke('open:editor', cmd, targets),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openTerminal: (p) => ipcRenderer.invoke('open:terminal', p),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  onLog: (cb) => ipcRenderer.on('git:log', (_e, entry) => cb(entry)),
});
