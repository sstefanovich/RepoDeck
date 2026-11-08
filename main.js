const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const git = require('./src/git');
const { ClaudeSession, findClaude, oneShot } = require('./src/claude');
const ado = require('./src/ado');
const github = require('./src/github');
const con = require('./src/console');

let win;

// ---------- config (workspaces, settings) stored in the user's app-data folder ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_SETTINGS = { editor: 'code', autoFetchMinutes: 5, previewCommands: false, cherryPickX: false, theme: 'system' };

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch {}
  return {
    workspaces: c.workspaces || [],
    settings: { ...DEFAULT_SETTINGS, ...(c.settings || {}) },
    tabs: c.tabs || [],
    activeTab: c.activeTab || null,
  };
}

function saveConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
  applyTheme(c.settings?.theme);
}

// 'system' follows Windows; 'light'/'dark' force it. This also switches the page's
// prefers-color-scheme, so the CSS and native controls follow automatically.
function applyTheme(theme) {
  nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system';
}

// ---------- launching other programs ----------
function launch(command, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true, stdio: 'ignore', cwd });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: `"${command}" failed (exit code ${code}).` }));
  });
}

async function openInEditor(cmd, targets) {
  const quoted = targets.map((t) => `"${t}"`).join(' ');
  const r = await launch(`${cmd} ${quoted}`);
  if (!r.ok) r.error = `Couldn't start "${cmd}". Make sure it's installed and its command-line launcher is on your PATH (in VS Code/Cursor: Command Palette → "Shell Command: Install ... command in PATH").`;
  return r;
}

// Opens VS Code/Cursor's 3-way merge editor: the two sides and the original are
// written to temp files, and the result is the real file in the repo.
async function openMergeEditor(cmd, repo, file, oursLabel, theirsLabel) {
  const v = await git.ops.conflictVersions(repo, file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodeck-merge-'));
  const ext = path.extname(file);
  const name = path.basename(file, ext);
  const safe = (s) => s.replace(/[<>:"/\\|?*]+/g, '-').slice(0, 60);
  const write = (label, content) => {
    const p = path.join(dir, `${name} (${safe(label)})${ext}`);
    fs.writeFileSync(p, typeof content === 'string' ? content : '');
    return p;
  };
  const ours = write(oursLabel, v.ours);
  const theirs = write(theirsLabel, v.theirs);
  const base = write('original', v.base);
  const r = await launch(`${cmd} --merge "${ours}" "${theirs}" "${base}" "${path.join(repo, file)}"`);
  if (!r.ok) r.error = `Couldn't start "${cmd}" with its merge editor. Make sure it's installed and on your PATH.`;
  return r;
}

async function openTerminal(dir) {
  const wt = await launch(`wt -d "${dir}"`);
  if (wt.ok) return wt;
  return launch(`start "" cmd /k cd /d "${dir}"`);
}

// ---------- window ----------
function createWindow() {
  applyTheme(loadConfig().settings.theme);
  Menu.setApplicationMenu(null); // no menu bar: frees Ctrl+W / Alt for the app's own shortcuts
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'RepoDeck',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181c' : '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const toWin = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
git.setLogger((entry) => toWin('git:log', entry));
git.setProgress((p) => toWin('git:progress', p));

// ---------- watch repo folders, so edits made in other apps show up right away ----------
const watchers = new Map(); // repo path (lowercase) -> { watcher, timer }
function watchRepos(repos) {
  const wanted = new Set(repos.map((r) => r.toLowerCase()));
  for (const [key, w] of watchers) if (!wanted.has(key)) { w.watcher.close(); clearTimeout(w.timer); watchers.delete(key); }
  for (const repo of repos) {
    const key = repo.toLowerCase();
    if (watchers.has(key)) continue;
    try {
      const entry = { timer: null };
      entry.watcher = fs.watch(repo, { recursive: true }, (_type, file) => {
        const f = String(file || '').replace(/\//g, '\\');
        // Object writes and dependency folders are noise; HEAD, index and refs changes still count.
        if (/^\.git\\(objects|logs)\\|(^|\\)node_modules\\/i.test(f)) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => toWin('repo:changed', repo), 350);
      });
      entry.watcher.on('error', () => { entry.watcher.close(); watchers.delete(key); });
      watchers.set(key, entry);
    } catch { /* folder missing — the regular refresh shows that */ }
  }
}
ipcMain.handle('watch:set', (_e, repos) => { watchRepos(repos); return true; });

// ---------- saved Claude chats ----------
const chatsFile = () => path.join(app.getPath('userData'), 'chats.json');
ipcMain.handle('chats:load', () => { try { return JSON.parse(fs.readFileSync(chatsFile(), 'utf8')); } catch { return {}; } });
ipcMain.handle('chats:save', (_e, data) => { fs.writeFileSync(chatsFile(), JSON.stringify(data)); return true; });

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, c) => { saveConfig(c); return true; });
ipcMain.handle('dialog:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:editor', (_e, cmd, targets) => openInEditor(cmd, targets));
ipcMain.handle('open:merge', (_e, cmd, repo, file, oursLabel, theirsLabel) => openMergeEditor(cmd, repo, file, oursLabel, theirsLabel));
ipcMain.handle('open:folder', async (_e, p) => { const err = await shell.openPath(p); return err ? { ok: false, error: err } : { ok: true }; });
ipcMain.handle('open:terminal', (_e, p) => openTerminal(p));
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('git', async (_e, op, ...args) => {
  const fn = git.ops[op];
  if (!fn) return { ok: false, error: `Unknown operation: ${op}` };
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message, code: err.code }; }
});

// ---------- GitHub and Azure DevOps (pull requests, new repos) ----------
// Personal access tokens are encrypted with Windows' own data protection (safeStorage) and kept in
// their own file; they are only ever used here, never sent to the page.
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const TOKEN_KEYS = { ado: 'adoToken', github: 'githubToken' };
function readSecrets() { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } }
function readToken(kind) {
  const enc = readSecrets()[TOKEN_KEYS[kind]];
  try { return enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch { return ''; }
}
const HOSTS = { ado, github };
// Which service a repo is on (from its origin URL), with that service's token.
async function hostOf(repo) {
  const remoteUrl = await git.ops.remoteUrl(repo);
  const kind = !remoteUrl ? null : ado.parseRemote(remoteUrl) ? 'ado' : github.parseRemote(remoteUrl) ? 'github' : null;
  return { kind, remoteUrl, token: kind ? readToken(kind) : '' };
}
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message, code: err.code }; }
});

ipcMain.handle('tokens:has', () => ({ ado: !!readToken('ado'), github: !!readToken('github') }));
ipcMain.handle('tokens:set', (_e, kind, token) => {
  if (!TOKEN_KEYS[kind]) return { ok: false, error: 'Unknown service.' };
  const t = String(token || '').trim();
  if (t && !safeStorage.isEncryptionAvailable()) return { ok: false, error: "Windows can't encrypt the token on this computer, so it wasn't saved." };
  const s = readSecrets();
  if (t) s[TOKEN_KEYS[kind]] = safeStorage.encryptString(t).toString('base64'); else delete s[TOKEN_KEYS[kind]];
  fs.writeFileSync(secretsFile(), JSON.stringify(s));
  return { ok: true };
});
handle('host:prStatus', async (repo, branch) => {
  const h = await hostOf(repo);
  if (!h.kind) return { supported: false };
  return { ...(await HOSTS[h.kind].prStatus({ remoteUrl: h.remoteUrl, branch, token: h.token })), host: h.kind };
});
// What the UI needs to offer creating a pull request in the app: { kind, hasToken, defaultBranch }.
handle('host:info', async (repo) => {
  const h = await hostOf(repo);
  if (!h.kind || !h.token) return { kind: h.kind, hasToken: !!h.token };
  const info = await HOSTS[h.kind].repoInfo({ remoteUrl: h.remoteUrl, token: h.token }).catch(() => null);
  return { kind: h.kind, hasToken: true, defaultBranch: info?.defaultBranch || null };
});
// opts: { source, target, title, description, draft, workItems }
handle('host:createPr', async (repo, opts) => {
  const h = await hostOf(repo);
  if (!h.kind || !h.token) throw new Error('No token is saved for this server.');
  if (h.kind === 'github') return github.createPr({ remoteUrl: h.remoteUrl, token: h.token, head: opts.source, base: opts.target, title: opts.title, body: opts.description, draft: opts.draft });
  return ado.createPr({ remoteUrl: h.remoteUrl, token: h.token, ...opts });
});
handle('host:githubOwners', () => github.owners({ token: readToken('github') }));
handle('host:adoProjects', (org) => ado.projects({ org, token: readToken('ado') }));
// opts: github { owner, name, isPrivate, description } | ado { org, project, name }
handle('host:createRepo', (kind, opts) => {
  const token = readToken(kind);
  if (!token) throw new Error('No token is saved for this service.');
  return HOSTS[kind].createRepo({ ...opts, token });
});

// ---------- console (commands typed by the user) ----------
// Each run has an id from the page; its output streams back as console:data, then console:exit.
const consoleRuns = new Map(); // id -> child process
ipcMain.handle('console:check', (_e, line) => con.check(line));
ipcMain.handle('console:run', (_e, id, cwd, line) => {
  const child = con.start({
    cwd,
    line,
    onData: (stream, text) => toWin('console:data', { id, stream, text }),
    onExit: (code, error) => { consoleRuns.delete(id); toWin('console:exit', { id, code, error }); },
  });
  if (child) consoleRuns.set(id, child);
  return true;
});
ipcMain.handle('console:stop', (_e, id) => con.stop(consoleRuns.get(id)));

// ---------- Claude chat panel (Claude Code CLI) ----------
// One claude process at a time, for the chat the user is in. Each chat has a key; switching
// chats (or restarting the app) starts a process that resumes that chat's Claude session.
let claude = null;
let claudeKey = null;

ipcMain.handle('claude:find', async () => findClaude(loadConfig().settings.claudePath));
// opts: { key, cwd, repos, resumeId }
ipcMain.handle('claude:send', async (_e, text, opts) => {
  if (!claude || !claude.alive || claudeKey !== opts.key) {
    claude?.stop();
    const exe = await findClaude(loadConfig().settings.claudePath);
    if (!exe) return { ok: false, error: 'NOT_FOUND' };
    const key = opts.key;
    claudeKey = key;
    claude = new ClaudeSession({ exe, cwd: opts.cwd, repos: opts.repos, resumeId: opts.resumeId, model: loadConfig().settings.claudeModel,
      send: (ev) => toWin('claude:event', { ...ev, key }) });
    claude.start();
  }
  claude.sendUser(text);
  return { ok: true };
});
ipcMain.handle('claude:permission', (_e, requestId, allow, input) => { claude?.answerPermission(requestId, allow, input); return true; });
ipcMain.handle('claude:interrupt', () => { claude?.interrupt(); return true; });
ipcMain.handle('claude:reset', () => { claude?.stop(); claude = null; claudeKey = null; return true; });
ipcMain.handle('claude:oneShot', async (_e, cwd, prompt) => {
  const exe = await findClaude(loadConfig().settings.claudePath);
  if (!exe) return { ok: false, error: 'NOT_FOUND' };
  try { return { ok: true, text: await oneShot({ exe, cwd, prompt, model: loadConfig().settings.claudeModel }) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------- updates (installed builds only) ----------
function checkForUpdates() {
  // Needs a "publish" target in package.json's build config (which writes app-update.yml).
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-downloaded', (info) => toWin('app:update', { version: info.version }));
    autoUpdater.checkForUpdates().catch(() => {});
  } catch { /* updater not bundled */ }
}
ipcMain.handle('app:restartToUpdate', () => { try { require('electron-updater').autoUpdater.quitAndInstall(); } catch {} });
ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => { createWindow(); setTimeout(checkForUpdates, 5000); });
app.on('window-all-closed', () => { claude?.stop(); for (const c of consoleRuns.values()) con.stop(c); for (const w of watchers.values()) w.watcher.close(); app.quit(); });
