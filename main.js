const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const git = require('./src/git');

let win;

// ---------- config (workspaces, settings) stored in the user's app-data folder ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_SETTINGS = { editor: 'code', autoFetchMinutes: 5 };

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch {}
  return { workspaces: c.workspaces || [], settings: { ...DEFAULT_SETTINGS, ...(c.settings || {}) } };
}

function saveConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
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

async function openTerminal(dir) {
  const wt = await launch(`wt -d "${dir}"`);
  if (wt.ok) return wt;
  return launch(`start "" cmd /k cd /d "${dir}"`);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'RepoDeck',
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

git.setLogger((entry) => { if (win && !win.isDestroyed()) win.webContents.send('git:log', entry); });

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, c) => { saveConfig(c); return true; });
ipcMain.handle('dialog:folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:editor', (_e, cmd, targets) => openInEditor(cmd, targets));
ipcMain.handle('open:folder', async (_e, p) => { const err = await shell.openPath(p); return err ? { ok: false, error: err } : { ok: true }; });
ipcMain.handle('open:terminal', (_e, p) => openTerminal(p));
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return true; });
ipcMain.handle('git', async (_e, op, ...args) => {
  const fn = git.ops[op];
  if (!fn) return { ok: false, error: `Unknown operation: ${op}` };
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message, code: err.code }; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
