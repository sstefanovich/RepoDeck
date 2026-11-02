// Starts the real app against throwaway repos and drives its window over the Chrome
// DevTools protocol. Everything (settings, git identity) is isolated in a temp folder.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'output');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchApp(repos, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodeck-ui-'));
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(userData);
  const ws = { id: 'ui', name: 'UI tests', repos };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    workspaces: [ws],
    settings: { autoFetchMinutes: 0, theme: 'dark', ...settings },
    tabs: [{ type: 'repo', path: repos[0], ws: 'ui' }],
    activeTab: `repo:${repos[0].toLowerCase()}`,
  }));
  // The app asks for a name and email on first run if git has none, so give it its own.
  const gitConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = UI Test\n\temail = ui@example.com\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig };
  delete env.ELECTRON_RUN_AS_NODE;
  // Port 0: Chromium picks a free port and writes it to DevToolsActivePort.
  const child = spawn(electron, [ROOT, `--user-data-dir=${userData}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' });

  const portFile = path.join(userData, 'DevToolsActivePort');
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    await sleep(200);
    try {
      const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
    } catch { /* not up yet */ }
  }
  if (!page) { kill(child); throw new Error('The app did not start'); }

  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener('open', r); sock.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
  const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); sock.send(JSON.stringify({ id: i, method, params })); });

  const app = {
    // Runs `body` (the inside of an async function) in the page and returns its result.
    async run(body) {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page error');
      return r.result?.result?.value;
    },
    async waitFor(body, what, timeout = 10000) {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await app.run(body).catch(() => null);
        if (v) return v;
        if (Date.now() > end) {
          const shot = await app.screenshot(`timeout ${what}`);
          const modal = await app.run("return document.querySelector('.modal')?.innerText || ''").catch(() => '');
          throw new Error(`Timed out waiting for ${what}${modal ? `\n  open dialog: ${modal.replace(/\s+/g, ' ').slice(0, 300)}` : ''}${shot ? `\n  screenshot: ${shot}` : ''}`);
        }
        await sleep(150);
      }
    },
    click: (selector) => app.run(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element: ' + ${JSON.stringify(selector)}); el.click();`),
    async size(width, height = 800) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
    },
    // Saves a picture for a failed check. Skipped quietly if the window isn't painting (e.g. minimised).
    async screenshot(name) {
      const shot = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(5000).then(() => null)]);
      if (!shot?.result?.data) return null;
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `${name.replace(/[^\w-]+/g, '_')}.png`);
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      return file;
    },
    async close() {
      try { sock.close(); } catch {}
      kill(child);
      await sleep(500);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await app.waitFor("return document.querySelector('#tab-body') && !document.querySelector('#tab-body .spinner')", 'the repo to open', 20000);
  return app;
}

function kill(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill();
}

// Runs in the page: buttons, tags and titles whose text spills out of their own box, or
// that are cut off by a container. Text that is shortened on purpose ("…") is fine.
const LAYOUT_PROBLEMS = `
  const sel = '.btn, .tag, .badge, .chip, .branch-pill, .seg-btn, .row-title, .commit-subject, .menu-item, .tab, .modal h2';
  const problems = [];
  const label = (el) => (el.className + ' "' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 50) + '"');
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[hidden], .dtab, .diff-scroll')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (cs.overflow === 'visible') {
      // Measure the visible text only: text inside a child that cuts itself short ("…") doesn't count.
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        let clipped = false;
        for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (getComputedStyle(p).overflow !== 'visible') clipped = true;
        if (clipped || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const t = range.getBoundingClientRect();
        if (t.right > r.right + 1 || t.left < r.left - 1) { problems.push('text spills out of ' + label(el)); break; }
      }
    }
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (r.right > ar.right + 1 || r.left < ar.left - 1) problems.push('cut off: ' + label(el) + ' (inside ' + a.className + ')');
      break;
    }
  }
  return problems;
`;

module.exports = { launchApp, LAYOUT_PROBLEMS };
