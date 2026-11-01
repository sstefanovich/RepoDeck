const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  git: (op, ...args) => ipcRenderer.invoke('git', op, ...args),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (c) => ipcRenderer.invoke('config:save', c),
  pickFolder: (title) => ipcRenderer.invoke('dialog:folder', title),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  openInEditor: (cmd, targets) => ipcRenderer.invoke('open:editor', cmd, targets),
  openMergeEditor: (cmd, repo, file, oursLabel, theirsLabel) => ipcRenderer.invoke('open:merge', cmd, repo, file, oursLabel, theirsLabel),
  openFolder: (p) => ipcRenderer.invoke('open:folder', p),
  openTerminal: (p) => ipcRenderer.invoke('open:terminal', p),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  watchRepos: (repos) => ipcRenderer.invoke('watch:set', repos),
  onRepoChanged: on('repo:changed'),
  onLog: on('git:log'),
  onProgress: on('git:progress'),
  loadChats: () => ipcRenderer.invoke('chats:load'),
  saveChats: (data) => ipcRenderer.invoke('chats:save', data),
  onUpdate: on('app:update'),
  restartToUpdate: () => ipcRenderer.invoke('app:restartToUpdate'),
  version: () => ipcRenderer.invoke('app:version'),
  ado: {
    hasToken: () => ipcRenderer.invoke('ado:hasToken'),
    setToken: (token) => ipcRenderer.invoke('ado:setToken', token),
    prStatus: (repo, branch) => ipcRenderer.invoke('ado:prStatus', repo, branch),
  },
  claude: {
    find: () => ipcRenderer.invoke('claude:find'),
    send: (text, opts) => ipcRenderer.invoke('claude:send', text, opts),
    permission: (requestId, allow, input) => ipcRenderer.invoke('claude:permission', requestId, allow, input),
    interrupt: () => ipcRenderer.invoke('claude:interrupt'),
    reset: () => ipcRenderer.invoke('claude:reset'),
    oneShot: (cwd, prompt) => ipcRenderer.invoke('claude:oneShot', cwd, prompt),
    onEvent: on('claude:event'),
  },
});
