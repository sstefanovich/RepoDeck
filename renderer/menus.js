'use strict';

// Settings, help, popover menus, the command palette (Ctrl+K) and the log drawer.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- settings & help ----------
async function openSettings() {
  const s = state.config.settings;
  const id = await git('getIdentity').catch(() => ({ name: '', email: '' }));
  const claudeExe = await api.claude.find().catch(() => null);
  const known = Object.keys(EDITORS);
  const r = await modal({
    title: 'Settings',
    body: `<h3>Who you are</h3>
      <p class="hint">Stamped on every commit you make (stored in git's global config, so VS Code/Cursor/Visual Studio use it too).</p>
      <label class="field"><span>Your name</span><input name="name" value="${esc(id.name)}"></label>
      <label class="field"><span>Your email</span><input name="email" value="${esc(id.email)}" placeholder="Use the same email as your GitHub/Azure account"></label>
      <h3>Appearance</h3>
      <label class="field"><span>Theme</span><select name="theme">${[['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<option value="${v}" ${(s.theme || 'system') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <h3>Editor</h3>
      <label class="field"><span>“Open in editor” uses</span><select name="editor">${known.map((k) => `<option value="${k}" ${s.editor === k ? 'selected' : ''}>${EDITORS[k]}</option>`).join('')}<option value="__custom" ${known.includes(s.editor) ? '' : 'selected'}>Other command…</option></select></label>
      <label class="field"><span>Other command (if chosen above)</span><input name="custom" value="${known.includes(s.editor) ? '' : esc(s.editor)}" placeholder="e.g. rider64"></label>
      <h3>Commits</h3>
      <label class="field"><span>Start every commit summary with (optional)</span><input name="commitTemplate" value="${esc(s.commitTemplate || '')}" placeholder="e.g. ABC-123: "></label>
      <label class="field"><span>Quick type buttons above the summary (space-separated; empty to hide)</span><input name="commitPrefixes" value="${esc(s.commitPrefixes ?? 'feat fix docs refactor test chore')}"></label>
      <label class="check"><input type="checkbox" name="workItems" ${s.workItems !== false ? 'checked' : ''}> Show a work item box (AB#) for Azure Boards, filled in from the branch name (e.g. feature/1234-login)</label>
      <h3>GitHub</h3>
      <p class="hint">With a personal access token, repos on GitHub show their pull request's reviews and checks next to the branch, and you can create pull requests and new repos from RepoDeck.
        Create a <a href="#" data-url="https://github.com/settings/tokens/new?scopes=repo,read:org&amp;description=RepoDeck">classic token</a> with the <b>repo</b> and <b>read:org</b> scopes
        (or a fine-grained one with <b>Administration</b>, <b>Contents</b> and <b>Pull requests</b> read &amp; write, and <b>Commit statuses</b> read). It's stored encrypted on this computer and only sent to GitHub.</p>
      <label class="field"><span>GitHub token</span><input name="githubToken" type="password" autocomplete="off" placeholder="${state.tokens.github ? 'Saved — type a new one to replace it' : 'Paste your token'}"></label>
      ${state.tokens.github ? '<label class="check"><input type="checkbox" name="githubForget"> Forget the saved GitHub token</label>' : ''}
      <h3>Azure DevOps</h3>
      <p class="hint">With a personal access token, repos on Azure DevOps show their pull request's reviews and build next to the branch. Create one in Azure DevOps under <b>User settings → Personal access tokens</b>.
        <b>Code (Read)</b> is enough to see pull requests; to create pull requests and new repos from RepoDeck, give it <b>Code (Read &amp; write)</b> and <b>Project and Team (Read)</b>. It's stored encrypted on this computer and only sent to Azure DevOps.</p>
      <label class="field"><span>Azure DevOps token</span><input name="adoToken" type="password" autocomplete="off" placeholder="${state.tokens.ado ? 'Saved — type a new one to replace it' : 'Paste your token'}"></label>
      ${state.tokens.ado ? '<label class="check"><input type="checkbox" name="adoForget"> Forget the saved Azure DevOps token</label>' : ''}
      <h3>Seeing what happens</h3>
      <label class="check"><input type="checkbox" name="preview" ${s.previewCommands ? 'checked' : ''}> Show me the git commands before running any action</label>
      <p class="hint">You can always hold <b>Shift</b> while clicking a button to preview just that one action.</p>
      <h3>Cherry-pick</h3>
      <label class="check"><input type="checkbox" name="cpx" ${s.cherryPickX ? 'checked' : ''}> Add “(cherry picked from commit …)” to cherry-picked commit messages</label>
      <h3>AI assistant</h3>
      <label class="field"><span>Assistant</span><select name="assistant">
        <option value="claude" ${s.assistant !== 'off' ? 'selected' : ''}>Claude (Claude Code)</option>
        <option value="off" ${s.assistant === 'off' ? 'selected' : ''}>Off — hide all the ✦ assistant features</option>
      </select></label>
      <p class="hint">Turn it off if you don't have Claude: the Ask Claude panel, Ctrl+J and every ✦ button (Write message, Explain, Ask why) are hidden. Everything else works the same.</p>
      <p class="hint">The Claude panel runs the Claude Code app (<code>claude</code>) you already have, signed in as you.${claudeExe ? ` Found: <code>${esc(claudeExe)}</code>` : ' <b>Not found yet</b> — install it or enter its path below.'}</p>
      <label class="field"><span>claude.exe location (leave empty to find it automatically)</span><input name="claudePath" value="${esc(s.claudePath || '')}" placeholder="C:\\Users\\you\\.local\\bin\\claude.exe"></label>
      <label class="field"><span>Model (leave empty for your Claude Code default)</span><input name="claudeModel" value="${esc(s.claudeModel || '')}" placeholder="e.g. opus, sonnet, haiku"></label>
      <h3>Automatic checking</h3>
      <label class="field"><span>Check servers for updates every … minutes (0 = never)</span><input name="fetch" type="number" min="0" max="120" value="${s.autoFetchMinutes}"></label>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Save', kind: 'primary' }],
  });
  if (r.id !== 'ok') return;
  const v = r.values;
  s.editor = v.editor === '__custom' ? v.custom.trim() || 'code' : v.editor;
  s.autoFetchMinutes = Math.max(0, Number(v.fetch) || 0);
  s.theme = v.theme;
  s.commitTemplate = v.commitTemplate;
  s.commitPrefixes = v.commitPrefixes.trim();
  s.workItems = v.workItems;
  let tokensChanged = false;
  for (const [kind, name] of [['github', 'GitHub'], ['ado', 'Azure DevOps']]) {
    if (!v[`${kind}Token`].trim() && !v[`${kind}Forget`]) continue;
    const t = await api.host.setToken(kind, v[`${kind}Forget`] ? '' : v[`${kind}Token`].trim());
    if (!t.ok) showError(`Couldn't save the ${name} token`, new Error(t.error));
    tokensChanged = true;
  }
  if (tokensChanged) {
    state.tokens = await api.host.tokens();
    state.prStatus = {};
    for (const k of Object.keys(prLoaded)) delete prLoaded[k];
    loadPrStatus(currentRepo(), true);
  }
  s.assistant = v.assistant;
  s.claudePath = v.claudePath.trim();
  s.claudeModel = v.claudeModel.trim();
  s.previewCommands = v.preview;
  s.cherryPickX = v.cpx;
  await saveConfig();
  if (v.name.trim() && v.email.trim() && (v.name.trim() !== id.name || v.email.trim() !== id.email)) {
    try { await git('setIdentity', v.name.trim(), v.email.trim()); } catch (e) { showError("Couldn't save your name/email", e); }
  }
  applyAssistant();
  toast('Settings saved.', 'ok');
  rerender();
}

function openHelp() {
  const terms = [
    ['Repo (repository)', 'A project folder that git tracks. It holds your files plus the full history of every saved version.'],
    ['Commit', 'A saved snapshot of your files, with a message saying what changed. Commits live on <i>your computer</i> until you send them.'],
    ['Branch', 'A separate line of work. <code>main</code> is usually the “real” version; you make a branch (e.g. <code>feature/login</code>) to work on something without disturbing main. Switching branches swaps the files in your folder.'],
    ['Server / remote / origin', 'The online copy of the repo (GitHub, Azure DevOps…). <code>origin</code> is just git\'s default nickname for it.'],
    ['Check for updates (fetch)', 'Asks the server what\'s new. Changes <b>none</b> of your files — completely safe. That\'s how this app knows you\'re “behind”.'],
    ['Get latest (pull)', 'Downloads new commits from the server and adds them to your current branch. (Under the hood: fetch + merge.)'],
    ['Send (push)', 'Uploads your commits to the server so teammates get them. <b>Publish branch</b> is the first push of a brand-new branch.'],
    ['Shelf (stash)', 'A safe drawer for uncommitted edits. “Put on Shelf” sets your changes aside and leaves your folder clean; “Restore” puts them back. Use it when you need to switch branches or pull but aren\'t ready to commit.'],
    ['Merge', 'Copies the commits from another branch into your current one — e.g. merge <code>main</code> into your feature branch to get your teammates\' work.'],
    ['Cherry-pick', 'Copies <i>individual</i> commits from one branch onto another, instead of merging the whole branch. E.g. take just a bug fix from <code>develop</code> into <code>release</code>. In History, pick a branch, tick commits, click 🍒.'],
    ['Merge conflict','When two branches changed <b>the same lines</b>, git can\'t guess which is right, so it asks you. You pick “yours”, “theirs”, or both, per clash. Nothing is lost, and you can abort to go back.'],
    ['Ahead / behind (↑ / ↓)', '↑3 = you have 3 commits the server doesn\'t. ↓2 = the server has 2 commits you don\'t.'],
    ['Detached HEAD', 'You\'re looking at an old snapshot instead of a branch. Fine for looking around; create a branch if you want to keep work made here.'],
    ['Staging', 'Git\'s “ready to commit” area. This app hides it: just tick the files you want in the commit.'],
    ['.gitignore', 'A list of files git should never track (build output, secrets, node_modules…).'],
  ];
  modal({
    title: 'Git, explained in plain English',
    wide: true,
    body: `<div class="glossary">${terms.map(([t, d]) => `<div class="term"><b>${t}</b><p>${d}</p></div>`).join('')}</div>
      <h3>A typical day</h3>
      <ol class="flow">
        <li><b>Get latest</b> on <code>main</code> so you start from the newest code.</li>
        <li><b>New branch</b> for what you're about to do (e.g. <code>fix/login-crash</code>). With several repos, use <b>New branch in all</b> from the workspace.</li>
        <li>Edit in VS Code / Cursor as usual. Your edits show up here under <b>Changes</b>.</li>
        <li><b>Commit</b> whenever you reach a good point. Small commits are easier to understand later.</li>
        <li><b>Send</b> to put your branch on the server, then open a pull request on GitHub/Azure DevOps.</li>
        <li>If main moves on while you work: on your branch, <b>Merge main into</b> it (Branches tab) to stay current.</li>
      </ol>
      <h3>Safety nets</h3>
      <ul class="flow">
        <li>After a commit, merge, get latest, cherry-pick, branch switch or delete, the message at the bottom right has an <b>Undo</b> button.</li>
        <li><b>Discard</b> keeps a copy on the Shelf. <b>Abort</b> undoes a half-finished merge or cherry-pick.</li>
      </ul>
      <h3>Shortcuts</h3>
      <p><kbd>Ctrl</kbd>+<kbd>K</kbd> command palette (jump anywhere, run anything) · <kbd>Ctrl</kbd>+<kbd>J</kbd> Claude · <kbd>Ctrl</kbd>+<kbd>Tab</kbd> next tab · <kbd>Ctrl</kbd>+<kbd>W</kbd> close tab · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> commit · <kbd>F5</kbd> refresh</p>
      <p class="hint">Curious what's really happening? Hold <b>Shift</b> while clicking any button to see the exact git commands <i>before</i> they run (or turn that on for everything in Settings). “Behind the scenes” at the bottom lists every command that already ran, with its output.</p>`,
  });
}

// ---------- popovers (menus anchored to a button) ----------
let popoverEl = null;
function closePopover() { popoverEl?.remove(); popoverEl = null; }
function popover(anchor, html, { width = 280, onOpen } = {}) {
  closePopover();
  const r = anchor.getBoundingClientRect();
  popoverEl = document.createElement('div');
  popoverEl.className = 'popover';
  popoverEl.style.width = `${width}px`;
  popoverEl.style.top = `${r.bottom + 6}px`;
  popoverEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  popoverEl.innerHTML = html;
  document.body.appendChild(popoverEl);
  onOpen?.(popoverEl);
}
document.addEventListener('mousedown', (e) => { if (popoverEl && !popoverEl.contains(e.target) && !e.target.closest('[data-action=branch-switcher],[data-action=open-menu]')) closePopover(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popoverEl) { closePopover(); e.stopPropagation(); } }, true);

function openMenu(anchor, repo) {
  const st = state.status[repo] || {};
  const item = (action, label, extra = '') => `<button class="menu-item" role="menuitem" data-action="${action}" data-repo="${esc(repo)}" ${extra}>${label}</button>`;
  popover(anchor, `<div role="menu">
    ${item('open-editor', `Open in ${esc(editorName())}`)}
    ${item('open-folder', 'Show in File Explorer')}
    ${item('open-terminal', 'Open a terminal here')}
    ${st.hasRemote ? item('open-web', 'Open the repo website') : ''}
    ${st.upstream && st.branch ? item('open-pr', `Open a pull request for ${esc(st.branch)}`) : ''}
    ${st.branch ? item('update-from', `Update ${esc(st.branch)} from another branch…`) : ''}
    ${st.branch ? item('finish-branch', `Finish ${esc(st.branch)} (after its pull request)…`) : ''}
    ${item('compare', 'Compare branches')}
    ${item('recover', 'Recover lost work…')}
    ${item('console-toggle', 'Git console (Ctrl+`)')}
  </div>`, { width: 260, onOpen: (el) => el.querySelector('button')?.focus() });
}

// Quick branch switcher: type to filter, Enter to switch.
async function openBranchSwitcher(anchor, repo) {
  const st = state.status[repo] || {};
  const b = await gitRaw('branches', repo).catch(() => ({ local: [], remoteOnly: [] }));
  const items = [
    ...b.local.map((x) => ({ name: x.name, label: x.name, current: x.current, local: true, sub: timeAgo(x.date) })),
    ...b.remoteOnly.map((x) => ({ name: x.branch, remote: x.name, label: x.branch, sub: `on ${x.remote} only` })),
  ];
  const render = (q) => {
    const list = items.map((it) => ({ it, s: fuzzyScore(q, it.label) })).filter((x) => !q || x.s >= 0).sort((a, c) => (q ? c.s - a.s : 0)).slice(0, 60);
    return list.map(({ it }, i) => `<button class="menu-item ${i === 0 && q ? 'hot' : ''} ${it.current ? 'current' : ''}" data-action="switcher-pick" data-repo="${esc(repo)}" data-name="${esc(it.name)}" ${it.remote ? `data-remote="${esc(it.remote)}"` : ''}>
      <span>${it.current ? '✓ ' : ''}${esc(it.label)}</span><span class="muted small">${esc(it.sub)}</span></button>`).join('') || '<div class="muted pad small">No matching branch.</div>';
  };
  popover(anchor, `<input class="switcher-input" placeholder="Find a branch…" spellcheck="false" aria-label="Find a branch">
    <div class="switcher-list" role="listbox">${render('')}</div>
    <div class="switcher-foot"><button class="btn small" data-action="new-branch" data-repo="${esc(repo)}">＋ New branch…</button>${st.branch ? `<button class="btn small ghost" data-action="update-from" data-repo="${esc(repo)}" title="Bring in the new commits from another branch">⤓ Update from…</button>` : ''}<button class="btn small ghost" data-action="tab" data-tab="branches">All branches…</button></div>`, {
    width: 320,
    onOpen: (el) => {
      const input = el.querySelector('input');
      input.focus();
      input.addEventListener('input', () => { el.querySelector('.switcher-list').innerHTML = render(input.value); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.querySelector('.menu-item:not(.current)')?.click(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); el.querySelector('.menu-item')?.focus(); }
      });
      el.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp'].includes(e.key) || e.target.tagName !== 'BUTTON') return;
        e.preventDefault();
        const all = [...el.querySelectorAll('.menu-item')];
        const i = all.indexOf(e.target) + (e.key === 'ArrowDown' ? 1 : -1);
        if (i < 0) input.focus(); else all[Math.min(i, all.length - 1)].focus();
      });
    },
  });
  if (st.detached) toast("You're not on a branch right now — pick one to get back on track.", 'info');
}

// ---------- command palette (Ctrl+K) ----------
function paletteCommands() {
  const cmds = [];
  const repo = currentRepo();
  for (const w of state.config.workspaces) {
    cmds.push({ label: `Workspace: ${w.name}`, hint: plural(w.repos.length, 'repo'), run: () => openWorkspace(w.id) });
    for (const p of w.repos) cmds.push({ label: `Open ${basename(p)}`, hint: `${w.name} · ${state.status[p]?.branch || ''}`, run: () => openRepo(p, w.id) });
  }
  if (repo) {
    const st = state.status[repo] || {};
    const here = basename(repo);
    const a = (label, action, hint = here) => cmds.push({ label, hint, run: () => actions[action]?.({ dataset: { repo }, checked: true }, { preventDefault() {}, stopPropagation() {} }) });
    a('Get latest', 'pull');
    a('Send / publish', 'push');
    a('Check for updates', 'fetch');
    a('New branch…', 'new-branch');
    if (st.branch) a(`Update ${st.branch} from another branch…`, 'update-from');
    if (st.branch) a(`Finish ${st.branch} (after its pull request)…`, 'finish-branch');
    a('Compare branches', 'compare');
    a('Put changes on the Shelf…', 'shelve');
    a('Tidy up branches…', 'tidy');
    a('Open in editor', 'open-editor');
    a('Open terminal', 'open-terminal');
    if (st.upstream) a('Open pull request', 'open-pr');
    a('Recover lost work…', 'recover');
    a('Git console: type git commands', 'console-toggle');
    for (const t of ['changes', 'branches', 'history', 'compare', 'shelf']) cmds.push({ label: `Go to ${t[0].toUpperCase() + t.slice(1)}`, hint: here, run: () => setTab(t) });
    for (const b of state.branches?.local || []) if (!b.current) cmds.push({ label: `Switch to ${b.name}`, hint: `${here} · branch`, run: () => switchBranch(repo, b.name) });
  }
  if (state.view.type === 'workspace') {
    for (const [label, action] of [['Get latest for all', 'ws-pull'], ['Send all', 'ws-push'], ['Commit in all…', 'ws-commit'], ['Pull requests for all…', 'ws-prs'], ['New branch in all…', 'ws-new-branch'], ['Switch all to branch…', 'ws-switch'], ['Update all from a branch…', 'ws-update-from'], ['Tidy up branches in all…', 'ws-tidy']]) {
      cmds.push({ label, hint: currentWs()?.name, run: () => actions[action]({ dataset: {} }) });
    }
  }
  for (const u of state.undos) cmds.push({ label: `Undo ${u.label}`, hint: `${u.repos.map(basename).join(', ')} · ${timeAgo(u.time / 1000)}`, run: () => runUndo(u.id) });
  cmds.push(
    { label: 'Open repo folder…', hint: 'add', run: () => addRepo(state.view.ws) },
    { label: 'Clone a repo…', hint: 'add', run: () => cloneRepo() },
    { label: 'New repo from a folder…', hint: 'add', run: () => newRepo(state.view.ws) },
    { label: 'New workspace…', hint: 'add', run: () => newWorkspace() },
    ...(aiOn() ? [{ label: 'Ask Claude', hint: 'Ctrl+J', run: () => toggleClaude(true) }] : []),
    { label: 'Settings', hint: '', run: () => openSettings() },
    { label: 'Git explained', hint: 'help', run: () => openHelp() },
    { label: `Theme: ${state.config.settings.theme === 'dark' ? 'light' : 'dark'}`, hint: 'appearance', run: () => { state.config.settings.theme = state.config.settings.theme === 'dark' ? 'light' : 'dark'; saveConfig(); } },
  );
  return cmds;
}

function openPalette() {
  if ($('.palette')) return;
  const cmds = paletteCommands();
  const back = document.createElement('div');
  back.className = 'modal-backdrop palette-back';
  back.innerHTML = `<div class="palette" role="dialog" aria-label="Command palette"><input placeholder="Type a command, repo or branch…" spellcheck="false" aria-label="Search commands"><div class="palette-list" role="listbox"></div></div>`;
  $('#modal-root').appendChild(back);
  const input = back.querySelector('input');
  const list = back.querySelector('.palette-list');
  let shown = [];
  let sel = 0;
  const close = () => back.remove();
  const draw = () => {
    const q = input.value;
    shown = cmds.map((c) => ({ c, s: fuzzyScore(q, `${c.label} ${c.hint || ''}`) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.c);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown.map((c, i) => `<div class="palette-item ${i === sel ? 'sel' : ''}" role="option" aria-selected="${i === sel}" data-i="${i}"><span>${esc(c.label)}</span><span class="muted small">${esc(c.hint || '')}</span></div>`).join('') || '<div class="muted pad">Nothing matches.</div>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const runSel = () => { const c = shown[sel]; close(); c?.run(); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('click', (e) => { const it = e.target.closest('.palette-item'); if (it) { sel = +it.dataset.i; runSel(); } });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  draw();
  input.focus();
}

// ---------- log drawer ----------
function addLog(entry) {
  state.logs.unshift(entry);
  state.logs.length = Math.min(state.logs.length, 300);
  if (!state.logOpen) state.unseenLogs++;
  renderLog();
}

function renderLog() {
  $('#log').classList.toggle('open', state.logOpen);
  $('.log-caret').textContent = state.logOpen ? '▾' : '▸';
  $('#log-count').textContent = state.unseenLogs ? `${state.unseenLogs} new` : '';
  $('#log-count').style.display = state.unseenLogs ? '' : 'none';
  if (!state.logOpen) return;
  $('#log-body').innerHTML = state.logs.length ? state.logs.map((l) => `<details class="log-entry ${l.ok ? '' : 'bad'}">
      <summary><span class="muted">${new Date(l.time).toLocaleTimeString()}</span> <b>${esc(basename(l.repo))}</b> <code>${esc(l.command)}</code> ${l.ok ? '' : '<span class="tag bad">failed</span>'}</summary>
      <pre class="raw">${esc(l.output || '(no output)')}</pre></details>`).join('')
    : '<div class="muted pad">Nothing yet. When you click buttons, the matching git commands appear here — a nice way to learn git.</div>';
}
