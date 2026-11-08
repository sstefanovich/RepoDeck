'use strict';

// The console: type git commands (or PowerShell ones) and run them in the open repo, with the output
// streamed in. Commands that need a full terminal are explained instead, risky ones are confirmed,
// and anything that moved the branch can be undone like any other action.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

const term = {
  sessions: {},     // norm(repo) -> { buf, running }
  runs: new Map(),  // run id -> { repo, line, kind, before, branch, out }
  histPos: -1,      // where ↑/↓ is in the history (-1 = the line being typed)
  draft: '',        // what was typed before ↑ was pressed
  completions: null, // { repo, names } cached for Tab
  frame: 0,
  shownFor: null,   // the repo whose output is on screen
};

const GIT_COMMANDS = ['add', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch', 'grep',
  'init', 'log', 'ls-files', 'merge', 'mv', 'notes', 'pull', 'push', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert', 'rm', 'shortlog', 'show',
  'stash', 'status', 'submodule', 'switch', 'tag', 'worktree'];

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function consoleSession(repo) {
  const k = norm(repo);
  return (term.sessions[k] ||= { buf: { lines: [''], cr: false, dropped: 0 }, running: null });
}

const consoleHistory = () => (state.config.consoleHistory ||= []);
const consolePrompt = (repo) => `${basename(repo)}${state.status[repo]?.branch ? ` (${state.status[repo].branch})` : ''} >`;

// Writes text (which may hold colour codes) to a repo's console.
function consoleWrite(repo, text) {
  const s = consoleSession(repo);
  feedOutput(s.buf, text, 3000);
  scheduleConsoleRender(repo);
}
const consoleLine = (repo, text) => {
  const s = consoleSession(repo);
  consoleWrite(repo, `${s.buf.lines.at(-1) ? '\n' : ''}${text}\n`);
};

function scheduleConsoleRender(repo) {
  if (!samePath(repo, currentRepo()) || !state.config.settings.consoleOpen || term.frame) return;
  // A timer, not requestAnimationFrame: that doesn't run while the window is hidden or minimised.
  term.frame = setTimeout(() => { term.frame = 0; renderConsoleOutput(); }, 30);
}

function renderConsoleOutput() {
  const out = $('#console-out');
  const repo = currentRepo();
  if (!out) return;
  if (!repo) { out.innerHTML = '<div class="muted console-empty">Open a repo to use the console. Commands run in the repo you are looking at.</div>'; return; }
  const s = consoleSession(repo);
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const lines = s.buf.lines.at(-1) === '' ? s.buf.lines.slice(0, -1) : s.buf.lines;
  out.innerHTML = (s.buf.dropped ? `<div class="muted">… ${plural(s.buf.dropped, 'earlier line')} not shown</div>` : '')
    + (lines.length ? lines.map((l) => `<div class="cl">${ansiToHtml(l) || ' '}</div>`).join('')
      : '<div class="muted console-empty">Type a git command, like <code>git status</code> or <code>git log --oneline -10</code>, and press Enter. Other commands run in PowerShell. Type <code>help</code> for tips.</div>');
  if (atBottom || s.running) out.scrollTop = out.scrollHeight;
}

// The parts around the output: where it runs, the prompt, Stop, and whether you can type.
function updateConsole() {
  const el = $('#console');
  if (!el) return;
  const open = !!state.config.settings.consoleOpen;
  el.hidden = !open;
  $('#console-toggle-btn')?.classList.toggle('active', open);
  $('#console-toggle-btn')?.setAttribute('aria-expanded', String(open));
  if (!open) return;
  el.style.height = `${state.config.settings.consoleHeight || 240}px`;
  const repo = currentRepo();
  const s = repo ? consoleSession(repo) : null;
  const input = $('#console-input');
  $('#console-where').textContent = repo ? `in ${repo}` : '';
  $('#console-prompt').textContent = repo ? consolePrompt(repo) : '';
  input.disabled = !repo;
  input.placeholder = !repo ? 'Open a repo first' : s.running ? 'Running… (Ctrl+C stops it)' : 'git status   (Tab completes, ↑ for earlier commands)';
  $('#console-stop').hidden = !s?.running;
  if (term.shownFor !== norm(repo || '')) { term.shownFor = norm(repo || ''); renderConsoleOutput(); }
}

function toggleConsole(force) {
  const s = state.config.settings;
  s.consoleOpen = force ?? !s.consoleOpen;
  saveConfig();
  term.shownFor = null;
  updateConsole();
  if (s.consoleOpen) { renderConsoleOutput(); $('#console-input')?.focus(); }
}

const CONSOLE_HELP = `${BOLD}The console${RESET}
  Commands run in the open repo. Lines starting with ${BOLD}git${RESET} run git; anything else runs in PowerShell.
  ${BOLD}Enter${RESET} run   ${BOLD}↑ ↓${RESET} earlier commands   ${BOLD}Tab${RESET} complete commands and branch names
  ${BOLD}Ctrl+C${RESET} stop the running command   ${BOLD}Ctrl+L${RESET} or ${BOLD}clear${RESET} clear the screen   ${BOLD}Ctrl+\`${RESET} show or hide
  Risky commands (reset --hard, push --force, clean -f…) ask first. If a command moves your branch,
  ${BOLD}↶ Undo${RESET} can put it back, like any button in RepoDeck.
  Commands that need a full terminal (an editor, rebase -i, add -p) can't run here: use
  ${BOLD}Open in Windows Terminal${RESET} for those.`;

// Resolves when the command has finished and the screens are up to date.
async function consoleRun(text) {
  const repo = currentRepo();
  const line = text.trim();
  if (!repo || !line) return;
  const s = consoleSession(repo);
  if (s.running) return;
  const h = consoleHistory();
  if (h.at(-1) !== line) { h.push(line); if (h.length > 200) h.splice(0, h.length - 200); saveConfig(); }
  term.histPos = -1;
  consoleLine(repo, `${DIM}${consolePrompt(repo)}${RESET} ${BOLD}${line}${RESET}`);
  if (/^(clear|cls)$/i.test(line)) { consoleClear(repo); return; }
  if (/^(help|\?)$/i.test(line)) { consoleLine(repo, CONSOLE_HELP); return; }
  if (/^(exit|quit)$/i.test(line)) { toggleConsole(false); return; }
  const c = await api.console.check(line);
  if (c.blocked) {
    consoleLine(repo, `${YELLOW}${c.blocked}${RESET}${c.hint ? `\n${c.hint}` : ''}\n${DIM}Or click Open in Windows Terminal to run it there.${RESET}`);
    return;
  }
  if (c.risky) {
    const ok = await confirmBox('Run this command?', `<p><code>${esc(line)}</code></p><p>${esc(c.risky)}</p>`, 'Run it', true);
    $('#console-input')?.focus();
    if (!ok) { consoleLine(repo, `${DIM}(not run)${RESET}`); return; }
  }
  const id = uid();
  const before = c.kind === 'git' ? await gitRaw('headOid', repo).catch(() => null) : null;
  s.running = { id };
  term.runs.set(id, { repo, line, kind: c.kind, before, branch: state.status[repo]?.branch, out: '', started: Date.now() });
  updateConsole();
  const finished = new Promise((resolve) => { term.runs.get(id).done = resolve; });
  await api.console.run(id, repo, line);
  return finished;
}

api.console.onData(({ id, text }) => {
  const r = term.runs.get(id);
  if (!r) return;
  if (r.out.length < 20000) r.out += text;
  consoleWrite(r.repo, text);
});

api.console.onExit(async ({ id, code, error }) => {
  const r = term.runs.get(id);
  if (!r) return;
  term.runs.delete(id);
  const s = consoleSession(r.repo);
  s.running = null;
  term.completions = null;
  if (error) consoleLine(r.repo, `${RED}${error}${RESET}`);
  else if (code !== 0) consoleLine(r.repo, `${DIM}(exit code ${code})${RESET}`);
  else if (s.buf.lines.at(-1)) consoleWrite(r.repo, '\n');
  if (r.kind === 'git') addLog({ time: Date.now(), repo: r.repo, command: r.line, ok: code === 0, output: r.out.replace(/\x1b\[[\d;]*[A-Za-z]/g, '').trim().slice(0, 20000) });
  updateConsole();
  // The command may have changed anything, so bring the screens up to date.
  await refreshRepo(r.repo);
  onStatusChanged([r.repo]);
  if (samePath(r.repo, currentRepo()) && ['branches', 'history', 'shelf', 'compare'].includes(state.tab)) renderTab();
  // Offer Undo when it moved the branch it started on (commit, reset, merge, pull, rebase…).
  if (r.before && state.status[r.repo]?.branch && state.status[r.repo].branch === r.branch) {
    const after = await gitRaw('headOid', r.repo).catch(() => null);
    if (after && after !== r.before) await offerUndoMove(r.repo, r.before, `Ran “${r.line}”.`, `“${r.line}”`);
  }
  r.done?.();
});

function consoleStop() {
  const repo = currentRepo();
  const s = repo && consoleSession(repo);
  if (!s?.running) return false;
  api.console.stop(s.running.id);
  consoleWrite(repo, `${DIM}^C${RESET}`);
  return true;
}

function consoleClear(repo = currentRepo()) {
  if (!repo) return;
  const s = consoleSession(repo);
  s.buf = { lines: [''], cr: false, dropped: 0 };
  renderConsoleOutput();
}

// Tab: completes git commands after "git ", and branch, tag and remote names after that.
async function consoleComplete(input) {
  const repo = currentRepo();
  const upto = input.value.slice(0, input.selectionStart);
  const word = upto.match(/(\S*)$/)[1];
  let pool;
  if (/^\s*git\s+\S*$/.test(upto)) pool = GIT_COMMANDS;
  else if (/^\s*git\s/.test(upto)) {
    if (term.completions?.repo !== repo) {
      const [b, t] = await Promise.all([gitRaw('branches', repo).catch(() => null), gitRaw('tags', repo).catch(() => [])]);
      term.completions = { repo, names: [...new Set([...(b?.local || []).map((x) => x.name), ...(b?.remote || []).map((x) => x.name), ...(b?.remotes || []), ...t.map((x) => x.name), 'HEAD'])] };
    }
    pool = term.completions.names;
  } else return;
  const hits = pool.filter((p) => p.startsWith(word));
  if (!hits.length) return;
  let fill = hits[0];
  for (const h of hits) while (!h.startsWith(fill)) fill = fill.slice(0, -1);
  if (hits.length === 1) fill += ' ';
  if (fill.length > word.length) {
    const pos = input.selectionStart;
    input.value = input.value.slice(0, pos - word.length) + fill + input.value.slice(pos);
    input.setSelectionRange(pos - word.length + fill.length, pos - word.length + fill.length);
  } else consoleLine(repo, `${DIM}${hits.slice(0, 60).join('   ')}${hits.length > 60 ? '   …' : ''}${RESET}`);
}

function consoleKeys(e) {
  const input = e.target;
  if (e.key === 'Enter') { e.preventDefault(); const v = input.value; input.value = ''; term.pending = consoleRun(v); return; }
  if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); consoleComplete(input); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); consoleClear(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) {
    e.preventDefault();
    if (!consoleStop() && input.value) { consoleLine(currentRepo(), `${DIM}${consolePrompt(currentRepo())}${RESET} ${input.value}^C`); input.value = ''; }
    return;
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const h = consoleHistory();
    if (!h.length) return;
    e.preventDefault();
    if (term.histPos === -1) term.draft = input.value;
    term.histPos = e.key === 'ArrowUp' ? (term.histPos === -1 ? h.length - 1 : Math.max(0, term.histPos - 1)) : (term.histPos === -1 ? -1 : term.histPos + 1);
    if (term.histPos >= h.length) term.histPos = -1;
    input.value = term.histPos === -1 ? term.draft : h[term.histPos];
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// Drag the top edge to make the console taller or shorter.
function initConsole() {
  $('#console-input').addEventListener('keydown', consoleKeys);
  $('#console-out').addEventListener('mouseup', () => { if (!window.getSelection().toString()) $('#console-input').focus(); });
  $('#console-resize').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const el = $('#console');
    const startY = e.clientY;
    const startH = el.offsetHeight;
    const move = (ev) => { el.style.height = `${Math.max(120, Math.min(window.innerHeight * 0.75, startH + startY - ev.clientY))}px`; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      state.config.settings.consoleHeight = el.offsetHeight;
      saveConfig();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  updateConsole();
}
