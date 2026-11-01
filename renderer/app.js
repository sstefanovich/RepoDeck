'use strict';

// `api` is the bridge exposed by preload.js (window.api).

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);


// Operations that change something. These can be previewed before they run.
const MUTATING = new Set([
  'commit', 'discard', 'ignore', 'fetch', 'pull', 'push', 'addRemote', 'createBranch', 'switchBranch', 'checkoutRemote',
  'renameBranch', 'deleteBranch', 'merge', 'undoLastCommit', 'stashSave', 'stashApply', 'stashPop', 'stashDrop',
  'resolveSide', 'saveResolution', 'markResolved', 'abortOp', 'continueOp', 'skipOp', 'cherryPick', 'cherryPickOnto',
  'clone', 'init', 'setIdentity', 'resetTo', 'restoreBranch', 'stashStore', 'updateFrom', 'revertCommit', 'finishBranch', 'discardLines', 'applyPatch', 'tidyCommits',
]);
let previewSuppressed = 0;
const CANCELLED = 'CANCELLED';
const previewWanted = () => !previewSuppressed && (state.config.settings.previewCommands || state.previewOnce);

async function git(op, ...args) {
  if (MUTATING.has(op) && previewWanted() && !(await previewPlans([{ op, args }]))) {
    throw Object.assign(new Error('Cancelled'), { code: CANCELLED });
  }
  return gitRaw(op, ...args);
}

// Runs without a preview (used for read-only calls and for quietly undoing a step the user cancelled).
async function gitRaw(op, ...args) {
  const r = await api.git(op, ...args);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
}

function planLabel(op, args) {
  if (op === 'clone') return 'New clone';
  if (op === 'setIdentity') return 'Your global git settings';
  return basename(args[0]);
}

// Shows the exact git commands an action is about to run. Resolves true to go ahead.
async function previewPlans(items) {
  const plans = await Promise.all(items.map(async (i) => ({ ...i, steps: await gitRaw('plan', i.op, ...i.args).catch((e) => [{ cmd: null, note: e.message }]) })));
  const copyText = plans.map((p) => {
    const cwd = p.op === 'clone' ? p.args[1] : p.op === 'setIdentity' ? null : p.args[0];
    return [cwd ? `cd "${cwd}"` : null, ...p.steps.filter((s) => s.cmd).map((s) => s.cmd)].filter(Boolean).join('\n');
  }).join('\n\n');
  // Nothing has started yet, so hide the "working…" spinners while this is open.
  state.previewOpen = true;
  onStatusChanged(allRepos());
  const r = await modal({
    title: 'Here’s what will run',
    wide: plans.length > 1,
    body: `${plans.map((p) => `<div class="plan">
        <div class="plan-repo">${esc(planLabel(p.op, p.args))}</div>
        ${p.steps.map((s, i) => `<div class="plan-step"><span class="plan-n">${i + 1}</span><div>${s.cmd ? `<code class="plan-cmd">${esc(s.cmd)}</code>` : ''}<div class="plan-note">${esc(s.note)}</div></div></div>`).join('')}
      </div>`).join('')}
      <div class="plan-foot">
        <label class="check"><input type="checkbox" name="always" ${state.config.settings.previewCommands ? 'checked' : ''}> Always show this before running an action</label>
        <div class="spacer"></div>
        <button class="btn small ghost" id="copy-plan" type="button">Copy commands</button>
      </div>
      <p class="hint">Tip: hold <b>Shift</b> while clicking any button to see this preview just once.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'run', label: 'Run', kind: 'primary' }],
    init: (el) => el.querySelector('#copy-plan').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(copyText).catch(() => {});
      e.target.textContent = 'Copied ✓';
    }),
  });
  state.previewOpen = false;
  onStatusChanged(allRepos());
  if (r.values.always !== state.config.settings.previewCommands) {
    state.config.settings.previewCommands = r.values.always;
    saveConfig();
  }
  return r.id === 'run';
}

// ---------- state ----------
const state = {
  config: { workspaces: [], settings: {} },
  status: {},        // repo path -> status from git
  view: { type: 'home' },
  tab: 'changes',
  checked: {},       // repo -> { file: true/false } for the commit checkboxes
  excluded: {},      // repo -> { file: Set of line keys } left out of the next commit
  diffKeys: null,    // { repo, path, keys } of the changed lines in the diff on screen
  selected: {},      // repo -> selected file in Changes
  commitMsg: {},     // repo -> { summary, body }
  busy: {},          // repo -> "Getting latest…"
  lastFetch: {},     // repo -> ms timestamp
  headKey: null,
  branches: null,
  history: null,
  stashes: null,
  selCommit: null,
  selStash: null,
  conflict: null,
  logs: [],
  logOpen: false,
  unseenLogs: 0,
  previewOnce: false, // Shift+click: preview the commands of this one action
  histRef: null,      // History: which branch is shown (null = current)
  histNotIn: true,    // History: only commits not already in the current branch
  picks: new Set(),   // History: commits ticked for cherry-picking
  tabs: [],           // open tabs: { type: 'repo', path, ws } | { type: 'workspace', ws }
  activeTab: null,    // key of the active tab
  repoTabs: {},       // repo -> last inner tab (Changes/Branches/...) used there
  previewOpen: false, // a command preview is showing (so nothing is running yet)
  progress: {},       // repo (or 'clone') -> { text, percent } for long operations
  undos: [],          // recent actions that can be undone, newest first (see recordUndo)
  prStatus: {},       // norm(repo) -> pull request info from Azure DevOps, for the current branch
  workItem: {},       // "repo|branch" -> work item number typed in the commit box
  histFile: null,     // History: only commits touching this file
  histQuery: '',      // History: search text
};

// What a repo is busy with right now (hidden while a preview is open, since nothing has started).
const busyLabel = (repo) => {
  if (!state.busy[repo] || state.previewOpen) return '';
  const p = state.progress[repo];
  return p?.text ? `${state.busy[repo].replace(/…$/, '')}: ${p.text}${p.percent != null ? ` ${p.percent}%` : ''}…` : state.busy[repo];
};
const LONG_OPS = /Getting latest|Sending|Checking|Combining/;
const busyHtml = (repo, cls = '') => {
  const label = busyLabel(repo);
  if (!label) return '';
  const cancel = LONG_OPS.test(state.busy[repo]) ? `<button class="icon-btn" data-action="cancel-op" data-repo="${esc(repo)}" title="Cancel" aria-label="Cancel">✕</button>` : '';
  return `<span class="busy ${cls}" role="status"><span class="spinner"></span>${esc(label)}${cancel}</span>`;
};

const allRepos = () => {
  const seen = new Map();
  for (const w of state.config.workspaces) for (const p of w.repos) if (!seen.has(norm(p))) seen.set(norm(p), p);
  return [...seen.values()];
};
const currentRepo = () => (state.view.type === 'repo' ? state.view.path : null);
const currentWs = () => state.config.workspaces.find((w) => w.id === state.view.ws) || null;
const saveConfig = () => api.saveConfig(state.config);
const EDITORS = { code: 'VS Code', cursor: 'Cursor', 'code-insiders': 'VS Code Insiders', windsurf: 'Windsurf' };
const editorName = () => EDITORS[state.config.settings.editor] || state.config.settings.editor;

// ---------- friendly error messages ----------
const FRIENDLY = [
  [/Please tell me who you are|empty ident|unable to auto-detect email/i, 'Git needs your name and email before it can save commits. They are stamped on every commit so others know who made it.'],
  [/would be overwritten by (checkout|merge|switch)|Your local changes to the following files would be overwritten/i, 'You have uncommitted changes in files that this would also change, so git stopped to protect your work. Commit them or put them on the Shelf, then try again.'],
  [/\[rejected\]|fetch first|non-fast-forward/i, "The server has commits you don't have yet. Get latest first, then send again."],
  [/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|403/i, "Git couldn't log in to the server. Try a push once from VS Code or a terminal so your login gets saved (Git Credential Manager), then try again here."],
  [/not fully merged/i, "This branch has commits that aren't in any other branch yet. Deleting it would lose them."],
  [/already exists/i, 'Something with that name already exists.'],
  [/not a valid branch name|is not a valid branch name/i, 'That is not a valid branch name. Use letters, numbers, dashes and slashes (e.g. feature/login-page).'],
  [/unmerged|needs merge|resolve your current index first|unresolved conflict/i, 'There are unresolved conflicts. Finish them in the Conflicts tab first (or abort).'],
  [/Could not resolve host|unable to access|Connection (timed out|refused)|Could not read from remote/i, "Couldn't reach the server. Check your internet or VPN connection."],
  [/no upstream|has no upstream/i, "This branch isn't on the server yet. Use Publish branch first."],
  [/nothing to commit/i, 'There is nothing to commit — no changes are ticked.'],
  [/index\.lock/i, 'Another program (often your editor) is busy with this repo, or crashed and left a lock file. Wait a moment and try again. If it keeps happening, delete the file .git/index.lock.'],
  [/No local changes to save/i, 'There were no changes to put on the Shelf.'],
  [/You have not concluded your merge|MERGE_HEAD exists/i, 'A merge is still in progress. Finish it or abort it first (see the yellow banner).'],
];
const explain = (msg) => (FRIENDLY.find(([re]) => re.test(msg)) || [])[1] || null;

async function showError(title, err) {
  if (err?.code === CANCELLED) return;
  const raw = err?.message || String(err);
  const nice = explain(raw);
  const identity = /tell me who you are|empty ident|auto-detect email/i.test(raw);
  const r = await modal({
    title,
    body: `${nice ? `<p>${esc(nice)}</p>` : '<p>Git reported a problem:</p>'}
      <details ${nice ? '' : 'open'}><summary>What git actually said</summary><pre class="raw">${esc(raw)}</pre></details>`,
    buttons: [
      ...(claudeScope() ? [{ id: 'claude', label: '✦ Ask Claude why' }] : []),
      ...(identity ? [{ id: 'ok', label: 'Close' }, { id: 'id', label: 'Set my name & email', kind: 'primary' }] : [{ id: 'ok', label: 'OK', kind: 'primary' }]),
    ],
  });
  if (r.id === 'id') openSettings();
  if (r.id === 'claude') askClaude(`I tried "${title.replace(/^Couldn't /i, 'to ')}" in RepoDeck and git said:\n\n${raw.slice(0, 3000)}\n\nWhat went wrong, in plain English, and how do I fix it? Look at the repo if that helps, but don't change anything yet.`);
}

// ---------- modals & toasts ----------
function modal({ title, body = '', buttons = [{ id: 'ok', label: 'OK', kind: 'primary' }], wide = false, init }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    const titleId = `m-${uid()}`;
    el.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <h2 id="${titleId}">${esc(title)}</h2>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">${buttons.map((b) => `<button class="btn ${b.kind || ''}" data-close="${b.id}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
    $('#modal-root').appendChild(el);
    const close = (id) => {
      const values = {};
      el.querySelectorAll('[name]').forEach((i) => {
        if (i.type === 'checkbox') { if (i.dataset.multi) (values[i.name] ||= []).push(...(i.checked ? [i.value] : [])); else values[i.name] = i.checked; }
        else if (i.type === 'radio') { if (i.checked) values[i.name] = i.value; }
        else values[i.name] = i.value;
      });
      el.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve({ id, values });
    };
    function onKey(e) {
      if (el !== $('#modal-root').lastElementChild) return;
      if (e.key === 'Escape') { e.stopPropagation(); close('cancel'); }
      // Keep keyboard focus inside the dialog.
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll('button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
        else if (!e.shiftKey && (i === items.length - 1 || i < 0)) { e.preventDefault(); items[0].focus(); }
      }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        const primary = el.querySelector('.modal-actions .primary');
        if (primary && !primary.disabled) { e.preventDefault(); close(primary.dataset.close); }
      }
    }
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-close]');
      if (b && !b.disabled) close(b.dataset.close);
      else if (e.target === el) close('cancel');
    });
    document.addEventListener('keydown', onKey, true);
    const first = el.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
    (first || el.querySelector('.modal-actions .primary'))?.focus();
    init?.(el);
  });
}

async function choose(title, intro, options) {
  const body = `${intro ? `<div class="intro">${intro}</div>` : ''}
    <div class="choices">${options.map((o) => `<button class="choice ${o.kind || ''}" data-close="${o.id}"><b>${esc(o.label)}</b>${o.desc ? `<span>${o.desc}</span>` : ''}</button>`).join('')}</div>`;
  return (await modal({ title, body, buttons: [{ id: 'cancel', label: 'Cancel' }] })).id;
}

async function confirmBox(title, html, okLabel = 'OK', danger = false) {
  const r = await modal({ title, body: html, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: okLabel, kind: danger ? 'danger' : 'primary' }] });
  return r.id === 'ok';
}

async function ask(title, { label = '', value = '', placeholder = '', help = '', okLabel = 'OK', transform } = {}) {
  const r = await modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input name="v" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false"></label>${help ? `<p class="hint">${help}</p>` : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: okLabel, kind: 'primary' }],
    init: (el) => {
      const i = el.querySelector('input');
      if (transform) i.addEventListener('input', () => { const p = i.selectionStart; const v = transform(i.value); if (v !== i.value) { i.value = v; i.setSelectionRange(p, p); } });
      i.select();
    },
  });
  return r.id === 'ok' ? r.values.v.trim() : null;
}

// action: { label, fn } adds a button (e.g. Undo); the toast then stays longer.
function toast(msg, kind = 'info', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  const life = action ? 12000 : 3800;
  const dismiss = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 400); };
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.fn(); });
    el.appendChild(b);
  }
  $('#toast-root').appendChild(el);
  setTimeout(dismiss, life);
}

// ---------- undo ----------
// Every action that can be undone goes in state.undos (newest first) for the rest of the session,
// as well as getting an Undo button in its message. Each entry:
// { id, label, repos, time, run(), check() } — check returns why it can no longer be undone, if it can't.
const MAX_UNDOS = 15;

function recordUndo({ label, repos, run, check }) {
  const entry = { id: uid(), label, repos, time: Date.now(), run, check };
  state.undos = [entry, ...state.undos].slice(0, MAX_UNDOS);
  undosChanged();
  return entry;
}

async function runUndo(id) {
  const entry = state.undos.find((u) => u.id === id);
  if (!entry) { toast('That was already undone.', 'info'); return; }
  closePopover();
  const why = await entry.check?.().catch(() => null);
  if (why) {
    state.undos = state.undos.filter((u) => u !== entry);
    undosChanged();
    await modal({ title: "Can't undo that any more", body: `<p>${esc(why)}</p><p class="hint">To back out a commit that's already in the history, use <b>Reverse this commit</b> in History.</p>` });
    return;
  }
  try {
    // Undos that span several repos show their own progress per repo.
    if (entry.repos.length > 1) await entry.run();
    else await busy(entry.repos[0], 'Undoing…', entry.run);
    state.undos = state.undos.filter((u) => u !== entry);
    undosChanged();
    toast(`Undone: ${entry.label}.`, 'ok');
  } catch (e) { showError("Couldn't undo", e); }
  if (state.view.type === 'repo' && ['branches', 'history'].includes(state.tab)) renderTab();
}

// Shows or hides the Undo buttons to match the list.
function undosChanged() {
  if (state.view.type === 'repo' && $('#repo-header')) updateRepoChrome();
  const ws = $('#ws-undo');
  if (ws) ws.innerHTML = undoButtonHtml();
}

const undoButtonHtml = () => (state.undos.length
  ? `<button class="btn ghost" data-action="undo-list" title="Undo something you did recently (Ctrl+Z)" aria-haspopup="menu">↶ Undo…</button>` : '');

function openUndoList(anchor) {
  if (!state.undos.length) { toast('Nothing to undo yet.', 'info'); return; }
  popover(anchor, `<div class="undo-list" role="menu">
      ${state.undos.map((u) => `<div class="undo-item">
        <div class="undo-text"><div>${esc(u.label[0].toUpperCase() + u.label.slice(1))}</div><div class="muted small">${esc(u.repos.map(basename).join(', '))} · ${timeAgo(u.time / 1000)}</div></div>
        <button class="btn small" role="menuitem" data-action="undo-run" data-id="${u.id}">Undo</button></div>`).join('')}
    </div>
    <p class="hint pad-x">Actions from this session, newest first. Anything already sent to the server can't be undone here.</p>`, {
    width: 340,
    onOpen: (el) => el.querySelector('button')?.focus(),
  });
}

// After an action, offer to put things back. `undo` performs the reversal; `check` (optional)
// says why it no longer can be.
function undoToast(msg, repo, label, undo, check) {
  const entry = recordUndo({ label, repos: [repo], run: undo, check });
  toast(msg, 'ok', { label: 'Undo', fn: () => runUndo(entry.id) });
}

// Undo for something that moved the branch (commit, merge, pull, cherry-pick): go back to `before`,
// as long as the branch is still where the action left it.
async function offerUndoMove(repo, before, msg, label, { soft = false } = {}) {
  const after = await gitRaw('headOid', repo).catch(() => null);
  if (!before || !after || before === after) { toast(msg, 'ok'); return; }
  const branch = state.status[repo]?.branch;
  undoToast(msg, repo, label, () => undoMove(repo, before, after, soft), () => moveUndoBlocked(repo, branch, after));
}

async function moveUndoBlocked(repo, branch, after) {
  const st = state.status[repo] || {};
  if (st.branch !== branch) return `${basename(repo)} has switched from ${branch} to ${st.branch || 'another commit'} since, so undoing now would change the wrong branch.`;
  if ((await gitRaw('headOid', repo).catch(() => null)) !== after) return `${branch} in ${basename(repo)} has changed since (new commits, or another undo), so undoing now could lose newer work.`;
  if (await gitRaw('isPushed', repo, after)) return 'This has already been sent to the server, so undoing it here would make your branch disagree with the server.';
  return null;
}

const undoMove = (repo, before, after, soft) => git('resetTo', repo, before, soft ? 'soft' : 'keep');

// note: optional HTML shown under the list.
async function resultsModal(title, results, note = '') {
  await modal({
    title,
    body: `<ul class="results">${results.map((r) => `<li class="${r.ok ? 'ok' : r.warn ? 'warn' : 'bad'}">
      <span class="ri">${r.ok ? '✓' : r.warn ? '!' : '✕'}</span>
      <div><b>${esc(basename(r.repo))}</b> — ${esc(r.msg)}${r.raw ? `<details><summary>details</summary><pre class="raw">${esc(r.raw)}</pre></details>` : ''}</div></li>`).join('')}</ul>
      ${note ? `<p class="hint">${note}</p>` : ''}`,
  });
}

// ---------- status refresh ----------
let refreshing = false;
async function refreshRepo(repo) {
  const r = await api.git('status', repo);
  const st = r.ok ? r.data : { error: r.error };
  const changed = JSON.stringify(st) !== JSON.stringify(state.status[repo]);
  state.status[repo] = st;
  return changed;
}

async function refreshAll(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const repos = allRepos();
    const changed = await Promise.all(repos.map(refreshRepo));
    const changedRepos = repos.filter((_, i) => changed[i]);
    if (force || changedRepos.length) onStatusChanged(force ? repos : changedRepos);
  } finally { refreshing = false; }
}

function onStatusChanged(changedRepos) {
  renderSidebar();
  renderTabbar();
  const v = state.view;
  if (v.type === 'workspace') renderWorkspaceCards();
  else if (v.type === 'repo' && changedRepos.some((r) => samePath(r, v.path))) updateRepoView();
}

async function busy(repo, label, fn) {
  state.busy[repo] = label;
  onStatusChanged([repo]);
  try { return await fn(); }
  finally {
    delete state.busy[repo];
    delete state.progress[repo];
    await refreshRepo(repo);
    onStatusChanged([repo]);
  }
}

// ---------- sidebar ----------
function badgesHtml(st) {
  if (!st) return '';
  if (st.missing) return '<span class="badge bad" title="Folder not found">missing</span>';
  if (st.error) return '<span class="badge bad" title="Not a git repo">error</span>';
  const out = [];
  if (st.conflicted?.length || st.op) out.push(`<span class="badge bad" title="Conflicts need your attention">⚠ ${st.conflicted.length || '!'}</span>`);
  const n = changedFiles(st).length;
  if (n) out.push(`<span class="badge changes" title="${plural(n, 'uncommitted change')}">● ${n}</span>`);
  if (st.ahead) out.push(`<span class="badge ahead" title="${plural(st.ahead, 'commit')} to send">↑${st.ahead}</span>`);
  if (st.behind) out.push(`<span class="badge behind" title="${plural(st.behind, 'commit')} on the server to get">↓${st.behind}</span>`);
  return out.join('');
}

function renderSidebar() {
  const list = $('#ws-list');
  const ws = state.config.workspaces;
  if (!ws.length) { list.innerHTML = '<div class="muted small pad">No workspaces yet.</div>'; return; }
  list.innerHTML = ws.map((w) => {
    const active = state.view.type === 'workspace' && state.view.ws === w.id;
    return `<div class="ws">
      <div class="ws-head ${active ? 'active' : ''}" data-action="open-ws" data-ws="${w.id}">
        <span class="caret" data-action="toggle-ws" data-ws="${w.id}">${w.collapsed ? '▸' : '▾'}</span>
        <span class="ws-name">${esc(w.name)}</span>
        <button class="icon-btn" data-action="add-repo" data-ws="${w.id}" title="Add a repo folder to this workspace">＋</button>
      </div>
      ${w.collapsed ? '' : `<div class="ws-repos">${w.repos.map((p) => {
        const st = state.status[p];
        const activeRepo = samePath(currentRepo(), p) && state.view.ws === w.id;
        const branch = st?.detached ? 'detached' : st?.branch || '';
        return `<div class="repo-item ${activeRepo ? 'active' : ''}" data-action="open-repo" data-repo="${esc(p)}" data-ws="${w.id}" title="${esc(p)}">
          <div class="ri-top"><span class="ri-name">${esc(basename(p))}</span>${busyLabel(p) ? `<span class="spinner sm" role="status" aria-label="${esc(busyLabel(p))}"></span>` : ''}</div>
          <div class="ri-bottom"><button class="ri-branch" data-action="branch-switcher" data-repo="${esc(p)}" title="Switch branch" ${st && !st.error && !st.missing ? '' : 'disabled'}>⎇ ${esc(branch)}</button><span class="ri-badges">${badgesHtml(st)}</span></div>
        </div>`;
      }).join('') || '<div class="muted small pad">No repos yet — click ＋</div>'}</div>`}
    </div>`;
  }).join('');
}

// ---------- tabs (one per open repo / workspace overview) ----------
const tabKey = (t) => (t.type === 'repo' ? `repo:${norm(t.path)}` : `ws:${t.ws}`);
const tabValid = (t) => (t.type === 'repo' ? allRepos().some((p) => samePath(p, t.path)) : state.config.workspaces.some((w) => w.id === t.ws));

function persistTabs() {
  state.config.tabs = state.tabs.map(({ type, path, ws }) => ({ type, path, ws }));
  state.config.activeTab = state.activeTab;
  saveConfig();
}

// Makes the tab for this view exist (opening it next to the current one) and active.
function ensureTab(t) {
  const key = tabKey(t);
  const existing = state.tabs.find((x) => tabKey(x) === key);
  if (existing) { if (t.ws) existing.ws = t.ws; }
  else {
    const i = state.tabs.findIndex((x) => tabKey(x) === state.activeTab);
    state.tabs.splice(i >= 0 ? i + 1 : state.tabs.length, 0, { ...t });
  }
  if (state.activeTab !== key || !existing) { state.activeTab = key; persistTabs(); }
  renderTabbar();
  renderClaudeSoon();
}

function activateTab(key) {
  const t = state.tabs.find((x) => tabKey(x) === key);
  if (!t) return;
  if (t.type === 'repo') openRepo(t.path, t.ws);
  else openWorkspace(t.ws);
}

function showNoTab() {
  state.activeTab = null;
  state.view = { type: 'home' };
  renderSidebar();
  renderHome();
  renderTabbar();
}

function closeTab(key, activateNext = true) {
  const i = state.tabs.findIndex((x) => tabKey(x) === key);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.activeTab === key) {
    const next = state.tabs[i] || state.tabs[i - 1];
    if (!activateNext) state.activeTab = null;
    else if (next) activateTab(tabKey(next));
    else showNoTab();
  }
  persistTabs();
  renderTabbar();
}

// Drops tabs whose repo/workspace was removed.
function pruneTabs() {
  state.tabs = state.tabs.filter(tabValid);
  if (state.activeTab && !state.tabs.some((t) => tabKey(t) === state.activeTab)) {
    if (state.tabs[0]) activateTab(tabKey(state.tabs[0])); else showNoTab();
  }
  persistTabs();
  renderTabbar();
}

function cycleTab(dir) {
  if (!state.tabs.length) return;
  const i = state.tabs.findIndex((x) => tabKey(x) === state.activeTab);
  activateTab(tabKey(state.tabs[(i + dir + state.tabs.length) % state.tabs.length]));
}

function renderTabbar() {
  const bar = $('#tabbar');
  bar.style.display = state.tabs.length ? '' : 'none';
  bar.innerHTML = state.tabs.map((t) => {
    const key = tabKey(t);
    const active = key === state.activeTab;
    const close = `<button class="dtab-x" data-action="close-tab" data-key="${esc(key)}" title="Close tab (Ctrl+W)">×</button>`;
    if (t.type === 'workspace') {
      const w = state.config.workspaces.find((x) => x.id === t.ws);
      return `<div class="dtab ws ${active ? 'active' : ''}" draggable="true" role="tab" data-action="activate-tab" data-key="${esc(key)}" title="Workspace overview: ${esc(w?.name || '')}">
        <span class="dtab-icon">▦</span><span class="dtab-name">${esc(w?.name || 'Workspace')}</span>${close}</div>`;
    }
    const st = state.status[t.path] || {};
    const n = changedFiles(st).length;
    const mark = busyLabel(t.path) ? `<span class="spinner sm" role="img" aria-label="${esc(busyLabel(t.path))}"></span>`
      : st.conflicted?.length || st.op ? '<span class="dtab-dot bad" role="img" title="Conflicts" aria-label="has conflicts"></span>'
      : n ? `<span class="dtab-dot changes" role="img" title="${plural(n, 'uncommitted change')}" aria-label="${plural(n, 'uncommitted change')}"></span>` : '';
    return `<div class="dtab ${active ? 'active' : ''}" draggable="true" role="tab" data-action="activate-tab" data-key="${esc(key)}" title="${esc(t.path)}">
      <span class="dtab-name">${esc(basename(t.path))}</span>
      ${st.branch || st.detached ? `<span class="dtab-branch">${esc(st.detached ? 'detached' : st.branch)}</span>` : ''}
      ${mark}${close}</div>`;
  }).join('');
  bar.querySelector('.dtab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Drag tabs to reorder them.
let dragKey = null;
document.addEventListener('dragstart', (e) => { const t = e.target.closest?.('.dtab'); if (t) { dragKey = t.dataset.key; e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragover', (e) => { if (dragKey && e.target.closest?.('.dtab')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  const over = e.target.closest?.('.dtab');
  if (!dragKey || !over || over.dataset.key === dragKey) { dragKey = null; return; }
  e.preventDefault();
  const from = state.tabs.findIndex((x) => tabKey(x) === dragKey);
  const [moved] = state.tabs.splice(from, 1);
  const r = over.getBoundingClientRect();
  const to = state.tabs.findIndex((x) => tabKey(x) === over.dataset.key) + (e.clientX > r.left + r.width / 2 ? 1 : 0);
  state.tabs.splice(to, 0, moved);
  dragKey = null;
  persistTabs();
  renderTabbar();
});
document.addEventListener('auxclick', (e) => {
  const t = e.target.closest('.dtab');
  if (t && e.button === 1) { e.preventDefault(); closeTab(t.dataset.key); }
});

// ---------- home ----------
function renderHome() {
  $('#view').innerHTML = `<div class="home">
    <h1>Welcome to RepoDeck 👋</h1>
    <p class="lead">A calmer way to work with git — with plain-English buttons, and several repos side by side.</p>
    <div class="home-cards">
      <div class="hcard"><h3>Already have a repo on your computer?</h3><p>Pick its folder — the one you cloned into. You can also just <b>drag the folder onto this window</b>.</p><button class="btn primary" data-action="open-repo-folder">📂 Open repo folder…</button></div>
      <div class="hcard"><h3>Need to download one?</h3><p>Clone a repo from GitHub, Azure DevOps, GitLab… using its URL.</p><button class="btn" data-action="clone">⤓ Clone a repo</button></div>
      <div class="hcard"><h3>Work on several repos together?</h3><p>A <b>workspace</b> groups repos you use together — e.g. the three repos of one project — so you can see them side by side and pull, push or branch all of them at once.</p><button class="btn" data-action="new-ws">＋ New workspace</button></div>
    </div>
    <p class="hint">Keep coding in VS Code or Cursor as usual — RepoDeck watches your folders and updates by itself. New to git? <a href="#" data-action="help">Git explained</a>.</p>
  </div>`;
}

// ---------- workspace overview ----------
function openWorkspace(id) {
  if (state.view.type === 'repo') state.repoTabs[state.view.path] = state.tab;
  state.view = { type: 'workspace', ws: id };
  ensureTab({ type: 'workspace', ws: id });
  renderSidebar();
  const w = currentWs();
  $('#view').innerHTML = `<div class="page">
    <div class="page-head">
      <div><h1>${esc(w.name)}</h1><div class="muted">${plural(w.repos.length, 'repo')} · actions here run on every repo in the workspace</div></div>
      <div class="spacer"></div>
      <span id="ws-undo">${undoButtonHtml()}</span>
      <button class="btn ghost" data-action="ws-rename">Rename</button>
      <button class="btn ghost" data-action="ws-delete">Remove workspace</button>
    </div>
    <div class="toolbar wrap">
      <button class="btn" data-action="ws-fetch" title="git fetch — asks every server what's new, without changing your files">⟳ Check all for updates</button>
      <button class="btn" data-action="ws-pull" title="git pull — downloads new commits into every repo">↓ Get latest for all</button>
      <button class="btn" data-action="ws-push" title="git push — uploads your commits from every repo">↑ Send all</button>
      <span class="sep"></span>
      <button class="btn" data-action="ws-new-branch" title="git switch -c — the same new branch in several repos">⎇ New branch in all…</button>
      <button class="btn" data-action="ws-switch" title="git switch — move every repo to the same branch">⇄ Switch all to branch…</button>
      <button class="btn" data-action="ws-update-from" title="Bring the new commits from dev, main or any branch into every repo">⤓ Update all from…</button>
      <span class="sep"></span>
      <button class="btn" data-action="ws-tidy" title="Delete branches that were merged or deleted on the server">🧹 Tidy up branches…</button>
      <button class="btn" data-action="ws-open-editor">Open all in ${esc(editorName())}</button>
      <button class="btn ghost" data-action="add-repo" data-ws="${w.id}">＋ Add repo</button>
    </div>
    <div id="ws-align"></div>
    <div id="ws-cards" class="cards"></div>
  </div>`;
  renderWorkspaceCards();
}

// The classic multi-repo mistake: building api on feature/x against web on main. Point it out.
function renderAlignment() {
  const el = $('#ws-align');
  const w = currentWs();
  if (!el || !w) return;
  const gone = w.repos.filter((p) => state.status[p]?.upstreamGone && state.status[p]?.branch);
  const finish = gone.length ? `<div class="banner info ws-banner"><div><div class="banner-title">${plural(gone.length, 'branch was', 'branches were')} deleted on the server</div>
    <div>${gone.map((p) => `<b>${esc(basename(p))}</b> → ${esc(state.status[p].branch)}`).join(' · ')}</div>
    <div class="hint">That usually means their pull requests were completed.</div></div>
    <div class="banner-actions"><button class="btn primary" data-action="ws-finish">✓ Finish them…</button></div></div>` : '';
  const on = w.repos.map((p) => ({ p, b: state.status[p]?.branch })).filter((x) => x.b);
  const names = [...new Set(on.map((x) => x.b))];
  if (on.length < 2 || names.length < 2) { el.innerHTML = finish; return; }
  const counts = names.map((n) => [n, on.filter((x) => x.b === n).length]).sort((a, b) => b[1] - a[1]);
  el.innerHTML = finish + `<div class="banner info ws-banner"><div><div class="banner-title">These repos are on different branches</div>
    <div>${on.map((x) => `<b>${esc(basename(x.p))}</b> → ${esc(x.b)}`).join(' · ')}</div>
    <div class="hint">That's fine if it's on purpose — but if you're working on one feature across repos, they usually belong on the same branch.</div></div>
    <div class="banner-actions"><button class="btn primary" data-action="ws-switch" data-preset="${esc(counts[0][0])}">Line them up…</button></div></div>`;
}

function syncText(st) {
  if (!st || st.error || st.missing) return '';
  if (st.detached) return 'Not on a branch';
  if (st.initial) return 'No commits yet';
  if (!st.hasRemote) return 'No server set up — this repo only exists on your computer';
  if (!st.upstream) return 'This branch isn\'t on the server yet — click <b>Publish branch</b> to share it';
  const bits = [];
  if (st.ahead) bits.push(`<b>${st.ahead}</b> to send`);
  if (st.behind) bits.push(`<b>${st.behind}</b> new on the server`);
  return bits.length ? bits.join(' · ') : 'In sync with the server';
}

function renderWorkspaceCards() {
  const w = currentWs();
  const el = $('#ws-cards');
  if (!w || !el) return;
  renderAlignment();
  if (!w.repos.length) { el.innerHTML = '<div class="empty"><b>No repos in this workspace yet.</b><p>Click “＋ Add repo” to add a folder.</p></div>'; return; }
  el.innerHTML = w.repos.map((p) => {
    const st = state.status[p] || {};
    const b = busyLabel(p);
    const n = st.error || st.missing ? 0 : changedFiles(st).length;
    const facts = st.missing ? '<div class="fact bad">Folder not found on disk</div>'
      : st.error ? `<div class="fact bad">${esc(st.error)}</div>`
      : `${st.op || st.conflicted?.length ? `<div class="fact bad">⚠ ${st.op ? esc(st.op.kind) + ' in progress — ' : ''}${plural(st.conflicted.length, 'conflict')}</div>` : ''}
         <div class="fact">${n ? `<span class="dot changes"></span>${plural(n, 'uncommitted change')}` : '<span class="dot ok"></span>No uncommitted changes'}</div>
         <div class="fact">${syncText(st)}</div>
         ${st.stashCount ? `<div class="fact muted">${plural(st.stashCount, 'item')} on the Shelf</div>` : ''}`;
    return `<div class="card ${st.conflicted?.length ? 'warn' : ''}">
      <div class="card-head" data-action="open-repo" data-repo="${esc(p)}" data-ws="${w.id}">
        <div><div class="card-title">${esc(basename(p))}</div><div class="path">${esc(p)}</div></div>
        ${busyHtml(p)}
      </div>
      <div class="card-branch">⎇ <b>${esc(st.detached ? 'detached HEAD' : st.branch || '')}</b>
        ${st.error || st.missing ? '' : `<button class="btn small ghost" data-action="branch-switcher" data-repo="${esc(p)}" title="Switch this repo to another branch">Switch…</button>`}</div>
      <div class="facts">${facts}</div>
      <div class="card-actions">
        <button class="btn small primary" data-action="open-repo" data-repo="${esc(p)}" data-ws="${w.id}">Open</button>
        ${st.hasRemote || st.error || st.missing
          ? `<button class="btn small" data-action="pull" data-repo="${esc(p)}" ${b ? 'disabled' : ''}>↓ Get latest</button>
        <button class="btn small" data-action="push" data-repo="${esc(p)}" ${b ? 'disabled' : ''}>↑ ${st.upstream || st.detached ? 'Send' : 'Publish'}</button>`
          : `<button class="btn small" data-action="add-remote" data-repo="${esc(p)}" ${b ? 'disabled' : ''}>⇪ Add server…</button>`}
        <button class="btn small ghost" data-action="open-editor" data-repo="${esc(p)}">${esc(editorName())}</button>
        <div class="spacer"></div>
        <button class="icon-btn" data-action="remove-repo" data-repo="${esc(p)}" title="Remove from this workspace (doesn't delete any files)" aria-label="Remove ${esc(basename(p))} from this workspace">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ---------- repo view ----------
function openRepo(repo, wsId, tab) {
  const st = state.status[repo] || {};
  const switching = !samePath(currentRepo(), repo);
  if (switching && state.view.type === 'repo') state.repoTabs[state.view.path] = state.tab;
  if (switching && !tab) tab = st.conflicted?.length ? 'conflicts' : state.repoTabs[repo];
  if (tab === 'conflicts' && !st.conflicted?.length && !st.op) tab = 'changes';
  state.view = { type: 'repo', path: repo, ws: wsId };
  ensureTab({ type: 'repo', path: repo, ws: wsId });
  if (switching) {
    state.branches = state.history = state.stashes = null;
    state.selCommit = state.selStash = state.conflict = null;
    state.histRef = null;
    state.cmp = null;
    state.blame = false;
    state.picks.clear();
    state.headKey = `${st.branch}|${st.oid}`;
  }
  state.tab = tab || (switching ? (st.conflicted?.length ? 'conflicts' : 'changes') : state.tab);
  renderSidebar();
  $('#view').innerHTML = '<div class="repo-view"><div id="repo-header" class="repo-header"></div><div id="op-banner"></div><div id="tabs" class="tabs"></div><div id="tab-body" class="tab-body"></div></div>';
  updateRepoChrome();
  renderTab();
}

function updateRepoChrome() {
  const repo = currentRepo();
  $('#repo-header').innerHTML = repoHeaderHtml(repo);
  $('#op-banner').innerHTML = bannerHtml(repo);
  $('#tabs').innerHTML = tabsHtml(repo);
}

function updateRepoView() {
  if (!$('#repo-header')) return;
  updateRepoChrome();
  const st = state.status[currentRepo()] || {};
  const key = `${st.branch}|${st.oid}`;
  const headChanged = key !== state.headKey;
  state.headKey = key;
  if (state.tab === 'changes') { renderFileList(); refreshDiff(); }
  else if (state.tab === 'conflicts') renderConflictList();
  else if (state.tab === 'branches' && headChanged) loadBranches();
  else if (state.tab === 'history' && headChanged) loadHistory();
  else if (state.tab === 'compare' && headChanged) loadCompare();
  else if (state.tab === 'shelf') loadShelf();
}

function repoHeaderHtml(repo) {
  const st = state.status[repo] || {};
  const b = state.busy[repo];
  const d = b ? 'disabled' : '';
  const tools = `${undoButtonHtml()}<button class="btn ghost" data-action="open-menu" data-repo="${esc(repo)}" aria-haspopup="menu">Open ▾</button>
    <button class="btn ghost" data-action="claude-open" title="Ask Claude about this repo (Ctrl+J)">✦ Ask Claude</button>`;
  const top = `<div class="rh-top"><div class="rh-title"><h1>${esc(basename(repo))}</h1><div class="path">${esc(repo)}</div></div><div class="spacer"></div>${tools}</div>`;
  if (st.missing || st.error) {
    return `${top}<div class="banner bad"><div>${st.missing ? 'This folder no longer exists on disk.' : esc(st.error)}</div><div class="banner-actions"><button class="btn" data-action="remove-repo" data-repo="${esc(repo)}">Remove from workspace</button></div></div>`;
  }
  const branchLabel = st.detached ? `detached at ${(st.oid || '').slice(0, 7)}` : st.branch;
  const checked = state.lastFetch[repo] ? `checked ${timeAgo(state.lastFetch[repo] / 1000)}` : '';
  const sync = syncText(st);
  const noServer = !st.hasRemote && !st.detached;
  const prable = st.upstream && !st.ahead && !['main', 'master', 'develop'].includes(st.branch);
  const pushBtn = noServer
    ? `<button class="btn ${st.initial ? '' : 'primary'}" data-action="add-remote" data-repo="${esc(repo)}" ${d} title="git remote add — connect this repo to a server such as GitHub">⇪ Add server…</button>`
    : `<button class="btn ${st.ahead || (!st.upstream && !st.initial && !st.detached) ? 'primary' : ''}" data-action="push" data-repo="${esc(repo)}" ${d} title="git push — uploads your commits to the server">↑ ${st.upstream || st.detached ? 'Send' : 'Publish branch'}${st.ahead ? ` (${st.ahead})` : ''}</button>`;
  return `${top}
    <div class="rh-bar">
      <button class="branch-pill" data-action="branch-switcher" data-repo="${esc(repo)}" title="Switch to another branch, or create one" aria-haspopup="dialog">⎇ <b>${esc(branchLabel)}</b> <span class="pill-action">Switch branch ▾</span></button>
      <div class="sync-text" title="${esc(sync.replace(/<[^>]+>/g, ''))}">${sync}${checked ? ` <span class="muted small">(${checked})</span>` : ''}</div>
      <div class="spacer"></div>
      ${busyHtml(repo)}
      ${prable ? `<button class="btn ghost" data-action="open-pr" data-repo="${esc(repo)}" title="Open the page for a pull request from ${esc(st.branch)}">⇄ Pull request</button>` : ''}
      ${noServer ? '' : `<button class="btn" data-action="fetch" data-repo="${esc(repo)}" ${d} title="git fetch — asks the server what's new. Doesn't change any of your files.">⟳ Check for updates</button>
      <button class="btn ${st.behind ? 'primary' : ''}" data-action="pull" data-repo="${esc(repo)}" ${d} title="git pull — downloads new commits from the server into this branch">↓ Get latest${st.behind ? ` (${st.behind})` : ''}</button>`}
      ${pushBtn}
    </div>`;
}

const OP_NAMES = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };

function bannerHtml(repo) {
  const st = state.status[repo] || {};
  const c = st.conflicted?.length || 0;
  const r = esc(repo);
  if (st.op) {
    const name = OP_NAMES[st.op.kind];
    const more = st.op.remaining ? ` <span class="muted">(${plural(st.op.remaining, 'more commit')} queued after this one)</span>` : '';
    const what = st.op.kind === 'merge' ? `Combining <b>${esc(st.op.incoming)}</b> into <b>${esc(st.branch)}</b>`
      : st.op.kind === 'cherry-pick' ? `Cherry-picking “${esc(st.op.incoming)}” into <b>${esc(st.branch)}</b>${more}`
      : `A ${name} is in progress`;
    const finish = st.op.remaining ? 'Continue' : `Finish ${name}`;
    return `<div class="banner warn">
      <div><div class="banner-title">${what}</div>
      <div>${c ? `${plural(c, 'file')} need${c === 1 ? 's' : ''} you to decide what to keep. <a href="#" data-action="tab" data-tab="conflicts">Go to Conflicts →</a>` : `All conflicts are resolved. Click <b>${finish}</b> to complete it.`}</div></div>
      <div class="banner-actions">
        <button class="btn" data-action="abort-op" data-repo="${r}" title="git ${st.op.kind} --abort">Abort — put everything back</button>
        ${st.op.kind !== 'merge' ? `<button class="btn" data-action="skip-op" data-repo="${r}" title="git ${st.op.kind} --skip">Skip this commit</button>` : ''}
        <button class="btn primary" data-action="continue-op" data-repo="${r}" ${c ? 'disabled' : ''}>${finish}</button>
      </div></div>`;
  }
  if (c) {
    return `<div class="banner warn"><div><div class="banner-title">Some files clash with changes you restored from the Shelf</div>
      <div>${plural(c, 'file')} need${c === 1 ? 's' : ''} your decision. <a href="#" data-action="tab" data-tab="conflicts">Go to Conflicts →</a> The Shelf item was kept as a backup — delete it once you're happy.</div></div></div>`;
  }
  if (st.detached) {
    return `<div class="banner info"><div><div class="banner-title">You're not on a branch ("detached HEAD")</div>
      <div>You're looking at an old snapshot. Any commits you make here won't belong to a branch and are easy to lose.</div></div>
      <div class="banner-actions"><button class="btn" data-action="tab" data-tab="branches">Go back to a branch</button><button class="btn primary" data-action="new-branch" data-repo="${r}">Create a branch here</button></div></div>`;
  }
  const pr = state.prStatus[norm(repo)];
  const prDone = pr?.branch === st.branch && pr.status === 'completed';
  if (st.branch && (st.upstreamGone || prDone)) {
    return `<div class="banner info"><div><div class="banner-title">${prDone ? `Pull request #${pr.id} for ${esc(st.branch)} is completed` : `${esc(st.branch)} was deleted on the server`}</div>
      <div>${prDone ? 'Its work is in the main branch now.' : 'That usually means its pull request was completed.'} Finish up: switch to the main branch, get its latest, and delete ${esc(st.branch)} here.</div></div>
      <div class="banner-actions"><button class="btn primary" data-action="finish-branch" data-repo="${r}" title="git switch, git pull, git branch -D">✓ Finish branch…</button></div></div>`;
  }
  return '';
}

function tabsHtml(repo) {
  const st = state.status[repo] || {};
  const n = st.error || st.missing ? 0 : changedFiles(st).length;
  const tabs = [
    ['changes', `Changes${n ? ` <span class="count">${n}</span>` : ''}`, 'Files you have edited since your last commit'],
    ['branches', 'Branches', 'Parallel versions of the code'],
    ['history', 'History', 'Commits made so far'],
    ['compare', 'Compare', 'What is different between two branches'],
    ['shelf', `Shelf${st.stashCount ? ` <span class="count">${st.stashCount}</span>` : ''}`, "Changes you've set aside for later (git calls this “stash”)"],
  ];
  if (st.conflicted?.length || st.op) tabs.unshift(['conflicts', `⚠ Conflicts${st.conflicted?.length ? ` <span class="count bad">${st.conflicted.length}</span>` : ''}`, 'Files where two sets of changes clash']);
  return tabs.map(([id, label, tip]) => `<button class="tab ${state.tab === id ? 'active' : ''} ${id === 'conflicts' ? 'warn' : ''}" data-action="tab" data-tab="${id}" title="${esc(tip)}">${label}</button>`).join('');
}

function setTab(tab) {
  state.tab = tab;
  $('#tabs').innerHTML = tabsHtml(currentRepo());
  renderTab();
}

function renderTab() {
  const t = state.tab;
  if (t === 'changes') renderChangesTab();
  else if (t === 'branches') { renderBranchesTab(); loadBranches(); }
  else if (t === 'history') { renderHistoryTab(); loadHistory(); }
  else if (t === 'compare') { renderCompareTab(); loadCompare(); }
  else if (t === 'shelf') { renderShelfTab(); loadShelf(); }
  else if (t === 'conflicts') renderConflictsTab();
}

// ---------- changes tab ----------
const CODE_LABEL = { '?': 'New', A: 'New', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

function changedFiles(st) {
  if (!st || st.error || st.missing) return [];
  const map = new Map();
  for (const f of st.staged || []) map.set(f.path, { path: f.path, orig: f.orig, code: f.code });
  for (const f of st.unstaged || []) {
    const e = map.get(f.path);
    if (!e) map.set(f.path, { path: f.path, orig: f.orig, code: f.code });
    else if (f.code === 'D') e.code = 'D';
  }
  for (const f of st.untracked || []) map.set(f.path, { path: f.path, code: '?', untracked: true });
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function renderChangesTab() {
  const repo = currentRepo();
  const msg = state.commitMsg[repo] || { summary: state.config.settings.commitTemplate || '', body: '' };
  const prefixes = (state.config.settings.commitPrefixes ?? 'feat fix docs refactor test chore').split(/\s+/).filter(Boolean);
  $('#tab-body').innerHTML = `<div class="split">
    <div class="pane-left">
      <div class="list-head" id="changes-head"></div>
      <div class="file-list" id="file-list"></div>
      <div class="commit-box" id="commit-box">
        ${prefixes.length ? `<div class="prefix-row" aria-label="Commit type">${prefixes.map((p) => `<button class="chip" data-action="commit-prefix" data-prefix="${esc(p)}" title="Start the summary with “${esc(p)}:”">${esc(p)}</button>`).join('')}
          <div class="spacer"></div><button class="btn small ghost" data-action="write-message" title="Let Claude write a message from the ticked changes">✦ Write message</button></div>` : ''}
        <input id="commit-summary" placeholder="Summary (required) — e.g. Fix login button" maxlength="200" value="${esc(msg.summary)}" spellcheck="true" aria-label="Commit summary">
        <textarea id="commit-body" rows="2" placeholder="Description (optional)" aria-label="Commit description">${esc(msg.body)}</textarea>
        ${state.config.settings.workItems !== false ? `<label class="wi-row" title="Adds AB#&lt;number&gt; to the commit message, which links the commit to that work item in Azure Boards"><span>Work item</span><span class="muted">AB#</span><input id="work-item" inputmode="numeric" placeholder="none" spellcheck="false" aria-label="Azure Boards work item number"></label>` : ''}
        <label class="check amend-row" id="amend-row" hidden title="git commit --amend"><input type="checkbox" id="amend" data-action="amend-toggle"> <span>Add to my last commit instead (amend) — <span class="muted" id="amend-what"></span></span></label>
        <div class="commit-actions">
          <button class="btn primary grow" id="commit-btn" data-action="commit" title="git commit — Ctrl+Enter">Commit</button>
          <button class="btn" id="commit-push-btn" data-action="commit-push" title="git commit, then git push">Commit &amp; Send</button>
        </div>
        <p class="hint">A <b>commit</b> saves a snapshot of the ticked files on your computer. <b>Send</b> uploads your commits to the server so others get them.</p>
      </div>
    </div>
    <div class="pane-right" id="diff-pane"></div>
  </div>`;
  renderFileList();
  refreshDiff();
  loadLastCommit();
}

// Amend is only offered while the last commit hasn't been sent.
async function loadLastCommit() {
  const repo = currentRepo();
  const last = await gitRaw('lastCommit', repo).catch(() => null);
  if (!samePath(repo, currentRepo()) || !$('#amend-row')) return;
  state.lastCommit = last;
  const ok = last && !last.pushed && !state.status[repo]?.op;
  $('#amend-row').hidden = !ok;
  if (ok) $('#amend-what').textContent = `“${last.message.split('\n')[0].slice(0, 60)}”`;
  if (!ok) $('#amend').checked = false;
  updateCommitButtons();
}

function renderFileList() {
  const repo = currentRepo();
  const list = $('#file-list');
  if (!list) return;
  const st = state.status[repo] || {};
  const files = changedFiles(st);
  const checked = (state.checked[repo] ||= {});
  const present = new Set(files.map((f) => f.path));
  for (const k of Object.keys(checked)) if (!present.has(k)) delete checked[k];
  for (const f of files) if (!(f.path in checked)) checked[f.path] = true;
  for (const k of Object.keys(state.excluded[repo] || {})) {
    const f = files.find((x) => x.path === k);
    if (!f || !canPickLines(st, f)) clearPicks(repo, k);
  }
  const n = files.filter((f) => checked[f.path]).length;

  $('#commit-box').style.display = files.length || st.op ? '' : 'none';
  $('#changes-head').innerHTML = files.length ? `
    <label class="check" title="Tick or untick everything"><input type="checkbox" data-action="check-all" ${n === files.length ? 'checked' : ''}> <span>${plural(files.length, 'changed file')}</span></label>
    <div class="spacer"></div>
    ${n && n < files.length
      ? `<button class="btn small ghost" data-action="shelve-ticked" title="git stash push -- <files> — set the ticked files' changes aside">Put ticked on Shelf</button>`
      : `<button class="btn small ghost" data-action="shelve" data-repo="${esc(repo)}" title="git stash — set all your changes aside so your folder is clean">Put all on Shelf</button>`}
    <button class="btn small ghost danger-text" data-action="discard-checked" ${n ? '' : 'disabled'}>Discard ticked…</button>` : '';
  const all = $('[data-action=check-all]');
  if (all) all.indeterminate = n > 0 && n < files.length;

  if (!files.length) {
    list.innerHTML = `<div class="empty"><div class="big">✓</div><b>No uncommitted changes</b>
      <p>Everything you've edited is saved in a commit.${st.ahead ? `<br>You have ${plural(st.ahead, 'commit')} that ${st.ahead === 1 ? "hasn't" : "haven't"} been sent to the server yet.` : ''}</p></div>`;
  } else {
    const sel = state.selected[repo];
    list.innerHTML = files.map((f) => {
      const slash = f.path.lastIndexOf('/');
      const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
      const name = f.path.slice(slash + 1);
      const part = partlyPicked(repo, f.path);
      return `<div class="file ${f.path === sel ? 'selected' : ''}" data-action="select-file" data-path="${esc(f.path)}">
        <input type="checkbox" data-action="check-file" data-path="${esc(f.path)}" ${checked[f.path] ? 'checked' : ''} ${part ? 'data-part="1"' : ''} title="${part ? 'Only some lines are ticked. Click to include the whole file.' : 'Include in the next commit'}">
        <span class="code c-${f.code === '?' ? 'N' : f.code}" title="${CODE_LABEL[f.code] || f.code}">${f.code === '?' ? 'N' : f.code}</span>
        <span class="fname" title="${esc(f.orig ? `${f.orig} → ${f.path}` : f.path)}"><b>${esc(name)}</b> <span class="muted">${esc(dir)}</span></span>
        <span class="file-actions">
          <button class="icon-btn" data-action="open-file" data-path="${esc(f.path)}" title="Open in ${esc(editorName())}">✎</button>
          ${f.untracked ? `<button class="icon-btn" data-action="ignore-file" data-path="${esc(f.path)}" title="Ignore this file (add to .gitignore)">⊘</button>` : ''}
          <button class="icon-btn" data-action="discard-file" data-path="${esc(f.path)}" title="Discard my changes to this file">↺</button>
        </span>
      </div>`;
    }).join('');
    if (!sel || !present.has(sel)) state.selected[repo] = files[0].path;
    list.querySelectorAll('[data-part]').forEach((b) => { b.indeterminate = true; });
  }
  updateCommitButtons();
}

// The work item box follows the branch: what you typed for it, else the number in its name.
const workItemKey = (repo, branch) => `${norm(repo)}|${branch}`;
function syncWorkItem(repo, st) {
  const input = $('#work-item');
  const key = workItemKey(repo, st.branch);
  if (!input || input.dataset.key === key) return;
  input.dataset.key = key;
  input.value = state.workItem[key] ?? workItemFromBranch(st.branch) ?? '';
}

function updateCommitButtons() {
  const repo = currentRepo();
  const btn = $('#commit-btn');
  if (!btn) return;
  const st = state.status[repo] || {};
  syncWorkItem(repo, st);
  const files = changedFiles(st);
  const n = files.filter((f) => state.checked[repo]?.[f.path]).length;
  const summary = $('#commit-summary').value.trim();
  if (st.op) {
    btn.textContent = `Finish ${OP_NAMES[st.op.kind]}`;
    btn.dataset.action = 'continue-op';
    btn.dataset.repo = repo;
    btn.disabled = !!st.conflicted?.length;
    $('#commit-push-btn').style.display = 'none';
    return;
  }
  btn.dataset.action = 'commit';
  $('#commit-push-btn').style.display = '';
  const amend = $('#amend')?.checked;
  const part = files.filter((f) => partlyPicked(repo, f.path)).length;
  const what = `${plural(n, 'file')}${part ? ` (${part} in part)` : ''}`;
  btn.textContent = amend ? `Amend last commit${n ? ` (+${what})` : ''}` : n ? `Commit ${what} to ${st.branch || 'branch'}` : 'Tick some files to commit';
  btn.disabled = (!n && !amend) || !summary;
  $('#commit-push-btn').disabled = btn.disabled;
  btn.title = !summary && (n || amend) ? 'Type a summary first' : amend ? 'git commit --amend — Ctrl+Enter' : 'git commit — Ctrl+Enter';
}

async function refreshDiff() {
  const repo = currentRepo();
  const pane = $('#diff-pane');
  if (!pane) return;
  const sel = state.selected[repo];
  const f = changedFiles(state.status[repo]).find((x) => x.path === sel);
  if (!f) { pane.innerHTML = '<div class="empty muted">Select a file to see what changed.</div>'; return; }
  const token = {};
  state.diffToken = token;
  let d;
  try { d = await git('fileDiff', repo, f.orig ? [f.path, f.orig] : [f.path], { untracked: !!f.untracked }); }
  catch (e) { d = { kind: 'error', text: e.message }; }
  if (state.diffToken !== token || !$('#diff-pane')) return;
  const prev = pane.querySelector('.diff-scroll');
  const keepScroll = prev && pane.dataset.file === f.path ? prev.scrollTop : 0;
  pane.dataset.file = f.path;
  const pickable = d.kind === 'text' && canPickLines(state.status[repo], f);
  state.diffKeys = pickable ? { repo, path: f.path, keys: changedLines(d.text).map((x) => x.key) } : null;
  if (pickable) prunePicks(repo, f.path);
  const split = state.config.settings.diffMode === 'split';
  pane.innerHTML = `<div class="diff-head">
      <b>${esc(f.path)}</b>${f.orig ? ` <span class="muted">(was ${esc(f.orig)})</span>` : ''}
      <span class="tag c-${f.code === '?' ? 'N' : f.code}">${CODE_LABEL[f.code] || f.code}</span>
      ${pickable ? `<span class="muted small" id="pick-count">${split ? 'Switch to Inline to commit only some lines.' : ''}</span>` : ''}
      <div class="spacer"></div>
      ${diffModeToggle()}
      ${f.untracked ? '' : `<button class="btn small ghost" data-action="file-history" data-path="${esc(f.path)}" title="Every commit that changed this file">History</button><button class="btn small ghost" data-action="file-blame" data-path="${esc(f.path)}" title="git blame — who last changed each line">Blame</button>`}
      <button class="btn small ghost" data-action="open-file" data-path="${esc(f.path)}">Open in ${esc(editorName())}</button>
    </div>
    <div class="diff-scroll">${d.kind === 'text' ? renderDiff(d.text, { file: f.path, picked: pickable ? (k) => isPicked(repo, f.path, k) : null }) : diffBody(d, f.path)}</div>`;
  pane.querySelector('.diff-scroll').scrollTop = keepScroll;
  syncPickBoxes();
}

// ---------- committing only some lines ----------
// state.excluded[repo][file] holds the keys of lines left out of the next commit. A file
// is "partly ticked" while it has some; ticked files without an entry are committed whole.
const canPickLines = (st, f) => !!st && !st.op && !st.initial && !f.untracked && !f.orig && f.code === 'M';
const isPicked = (repo, file, key) => !!state.checked[repo]?.[file] && !state.excluded[repo]?.[file]?.has(key);
const partlyPicked = (repo, file) => !!state.checked[repo]?.[file] && !!state.excluded[repo]?.[file]?.size;

// Tick (on) or untick lines of the file shown in the diff.
function pickLines(repo, file, keys, on) {
  const all = state.diffKeys?.path === file ? state.diffKeys.keys : [];
  const ex = (state.excluded[repo] ||= {});
  const checked = (state.checked[repo] ||= {});
  let set = checked[file] ? new Set(ex[file] || []) : new Set(all);
  checked[file] = true;
  for (const k of keys) { if (on) set.delete(k); else set.add(k); }
  set = new Set([...set].filter((k) => all.includes(k)));
  if (set.size >= all.length) { checked[file] = false; delete ex[file]; }
  else if (!set.size) delete ex[file];
  else ex[file] = set;
}

// Forget left-out lines that are gone from the file (e.g. edited away in the editor).
function prunePicks(repo, file) {
  const set = state.excluded[repo]?.[file];
  if (!set) return;
  const now = new Set(state.diffKeys.keys);
  for (const k of [...set]) if (!now.has(k)) set.delete(k);
  if (!set.size) delete state.excluded[repo][file];
  else if (set.size >= now.size) { delete state.excluded[repo][file]; state.checked[repo][file] = false; }
}

function clearPicks(repo, file) {
  if (file) delete state.excluded[repo]?.[file];
  else delete state.excluded[repo];
}

// Brings the line and block tick boxes in the diff up to date, without redrawing it.
function syncPickBoxes() {
  const pane = $('#diff-pane');
  const k = state.diffKeys;
  if (!pane || !k || pane.dataset.file !== k.path) return;
  pane.querySelectorAll('[data-action=pick-line]').forEach((b) => {
    b.checked = isPicked(k.repo, k.path, b.dataset.key);
    b.closest('.dl').classList.toggle('off', !b.checked);
  });
  pane.querySelectorAll('[data-action=pick-hunk]').forEach((b) => {
    const lines = [...pane.querySelectorAll(`.dl[data-h="${b.dataset.h}"] [data-action=pick-line]`)];
    const on = lines.filter((x) => x.checked).length;
    b.checked = on > 0 && on === lines.length;
    b.indeterminate = on > 0 && on < lines.length;
  });
  const count = $('#pick-count');
  if (count && state.config.settings.diffMode !== 'split') {
    const total = k.keys.length;
    const on = k.keys.filter((key) => isPicked(k.repo, k.path, key)).length;
    count.textContent = on && on < total ? `${on} of ${plural(total, 'changed line')} ticked` : '';
  }
}

// Throws away one block of changes in the file shown in the diff.
async function discardBlock(h) {
  const k = state.diffKeys;
  if (!k) return;
  const keys = [...document.querySelectorAll(`#diff-pane .dl[data-h="${h}"] [data-action=pick-line]`)].map((b) => b.dataset.key);
  if (!keys.length) return;
  const ok = await confirmBox('Discard this block?', `<p>Throw away ${plural(keys.length, 'changed line')} in <code>${esc(k.path)}</code>, putting ${keys.length === 1 ? 'it' : 'them'} back to your last commit? The rest of the file is left alone.</p>
    <p class="hint">Changed your mind? <b>Undo</b> puts them back.</p>`, 'Discard block', true);
  if (!ok) return;
  try {
    const { patch } = await busy(k.repo, 'Discarding…', () => git('discardLines', k.repo, k.path, keys));
    undoToast('Block discarded.', k.repo, `discard of a block in ${basename(k.path)}`, () => git('applyPatch', k.repo, patch));
  } catch (e) { showError("Couldn't discard", e); }
}

// After ticking lines: update the file list and commit button to match.
function afterPick() {
  syncPickBoxes();
  renderFileList();
}

function diffBody(d, file) {
  if (d.kind === 'binary') return '<div class="empty muted">Binary file (image, dll, etc.) — no preview.</div>';
  if (d.kind === 'large') return `<div class="empty muted">This file is large (${Math.round(d.size / 1024)} KB), so it isn't previewed.</div>`;
  if (d.kind === 'missing') return '<div class="empty muted">File not found.</div>';
  if (d.kind === 'error') return `<pre class="raw">${esc(d.text)}</pre>`;
  return renderDiff(d.text, { file });
}

const diffModeToggle = () => {
  const sbs = state.config.settings.diffMode === 'split';
  return `<div class="seg small" role="group" aria-label="Diff layout"><button class="seg-btn ${sbs ? '' : 'active'}" data-action="diff-mode" data-mode="unified" title="Changes in one column">Inline</button><button class="seg-btn ${sbs ? 'active' : ''}" data-action="diff-mode" data-mode="split" title="Before and after side by side">Side by side</button></div>`;
};

// Renders a unified diff with syntax colours and word-level highlights, inline or side by side.
// `file` names the file when the diff text has no "diff --git" header (e.g. a new file).
// `picked(key)`: show a tick box on each changed line (inline layout only), ticked when it returns true.
function renderDiff(text, { maxLines = 6000, file = '', picked = null } = {}) {
  if (!text || !text.trim()) return '<div class="empty muted">No line changes to show (maybe only file permissions or line endings changed).</div>';
  const split = state.config.settings.diffMode === 'split';
  const picking = !!picked && !split;
  const files = parseUnified(text);
  const out = [];
  let count = 0;
  let hunkNo = 0;
  const ln = (x) => `<span class="ln">${x ?? ''}</span>`;
  const box = (r) => {
    if (!picking) return '';
    if (!r.key) return '<span class="lp"></span>';
    return `<span class="lp"><input type="checkbox" data-action="pick-line" data-key="${esc(r.key)}" ${picked(r.key) ? 'checked' : ''} aria-label="Include this line in the commit"></span>`;
  };
  const line = (kind, r, html) => (split ? '' : `<div class="dl ${kind} ${picking && r.key && !picked(r.key) ? 'off' : ''}" ${r.key ? `data-h="${hunkNo}"` : ''}>${box(r)}${ln(r.o)}${ln(r.n)}<span class="code">${html || ' '}</span></div>`);
  const sbsRow = (kind, l, r, lh, rh) => `<div class="sr ${kind}">${ln(l?.o)}<span class="sc l">${lh || ' '}</span>${ln(r?.n)}<span class="sc r">${rh || ' '}</span></div>`;
  for (const f of files) {
    const lang = langOf(f.name || file);
    const key = lineKeyer();
    if (f.name && (files.length > 1 || file !== f.name)) {
      out.push(`<div class="dfile"><span>${esc(f.name)}</span><button class="btn small ghost" data-action="file-history" data-path="${esc(f.name)}" title="Every commit that changed this file">History</button></div>`);
    }
    for (const n of f.notes) out.push(`<div class="dnote">${esc(n)}</div>`);
    for (const h of f.hunks) {
      if (count > maxLines) break;
      hunkNo++;
      if (picking) for (const r of h.rows) if (r.kind !== 'ctx') r.key = key(r.kind, r.text);
      const hunkBox = picking ? `<span class="lp"><input type="checkbox" data-action="pick-hunk" data-h="${hunkNo}" title="Tick or untick this whole block" aria-label="Include this block in the commit"></span>` : '';
      const discard = picking ? `<button class="btn small ghost hunk-discard" data-action="discard-hunk" data-h="${hunkNo}" title="Throw away the changes in this block (Undo puts them back)">↺ Discard block</button>` : '';
      out.push(split ? `<div class="sr gap hunk-gap">${esc(h.ctx) || '⋯'}</div>` : `<div class="dl hunk">${hunkBox}${ln('⋯')}${ln('⋯')}<span class="code">${esc(h.ctx)}</span>${discard}</div>`);
      for (const g of pairHunk(h.rows)) {
        if (++count > maxLines) { out.push('<div class="dnote">… the rest is too long to show here. Open the file in your editor.</div>'); break; }
        if (g.kind === 'ctx') {
          const html = highlight(g.row.text, lang);
          out.push(split ? sbsRow('same', g.row, g.row, html, html) : line('ctx', g.row, html));
          continue;
        }
        const pairs = Math.max(g.dels.length, g.adds.length);
        for (let i = 0; i < pairs; i++) {
          const d = g.dels[i];
          const a = g.adds[i];
          const range = d && a ? changeRange(d.text, a.text) : null;
          // Only mark words when the lines are mostly alike; otherwise the whole line is the change.
          const useMarks = range && (range.a[1] - range.a[0]) < d.text.length * 0.7;
          const dh = d ? highlight(d.text, lang, useMarks ? range.a : null) : '';
          const ah = a ? highlight(a.text, lang, useMarks ? range.b : null) : '';
          if (split) out.push(sbsRow(d && a ? 'chg' : d ? 'del' : 'add', d, a, dh, ah));
        }
        if (!split) {
          g.dels.forEach((d, i) => {
            const a = g.adds[i];
            const range = a ? changeRange(d.text, a.text) : null;
            out.push(line('del', d, highlight(d.text, lang, range && (range.a[1] - range.a[0]) < d.text.length * 0.7 ? range.a : null)));
          });
          g.adds.forEach((a, i) => {
            const d = g.dels[i];
            const range = d ? changeRange(d.text, a.text) : null;
            out.push(line('add', a, highlight(a.text, lang, range && (range.a[1] - range.a[0]) < d.text.length * 0.7 ? range.b : null)));
          });
        }
      }
    }
  }
  return split ? `<div class="sbs diff-sbs">${out.join('')}</div>` : `<div class="diff">${out.join('')}</div>`;
}

async function doCommit(repo, thenPush) {
  const st = state.status[repo];
  const summary = $('#commit-summary').value.trim();
  const body = $('#commit-body').value.trim();
  if (!summary) { toast('Type a short summary of what you changed first.', 'warn'); $('#commit-summary').focus(); return; }
  const files = changedFiles(st);
  const ticked = files.filter((f) => state.checked[repo]?.[f.path]);
  const amend = !!$('#amend')?.checked;
  if (!ticked.length && !amend) return;
  const paths = ticked.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
  const message = withWorkItem(body ? `${summary}\n\n${body}` : summary, $('#work-item')?.value);
  // Files with some lines left out: { file: [keys of the left-out lines] }.
  const partial = st.op ? null : Object.fromEntries(ticked.filter((f) => partlyPicked(repo, f.path)).map((f) => [f.path, [...state.excluded[repo][f.path]]]));
  const some = partial && Object.keys(partial).length ? partial : null;
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    await busy(repo, amend ? 'Amending…' : 'Committing…', () => git('commit', repo, { message, paths, all: !some && files.length > 0 && ticked.length === files.length, amend, partial: some }));
    clearPicks(repo);
    state.commitMsg[repo] = { summary: state.config.settings.commitTemplate || '', body: '' };
    $('#commit-summary').value = state.commitMsg[repo].summary;
    $('#commit-body').value = '';
    if ($('#amend')) $('#amend').checked = false;
    loadLastCommit();
    if (thenPush) await doPush(repo);
    // Undo keeps the changes (soft reset), so they go back to the Changes tab.
    else if (before) offerUndoMove(repo, before, amend ? 'Last commit amended.' : `Committed to ${st.branch}.`, amend ? `amend of “${summary}”` : `commit “${summary}”`, { soft: true });
    else toast(`Committed to ${st.branch}.`, 'ok');
  } catch (e) { showError("Couldn't commit", e); }
}

// ---------- sync: fetch / pull / push ----------
async function doFetch(repo, { silent = false } = {}) {
  try {
    await busy(repo, 'Checking for updates…', () => git('fetch', repo));
    state.lastFetch[repo] = Date.now();
    const st = state.status[repo];
    if (!silent) toast(st.behind ? `${plural(st.behind, 'new commit')} on the server for ${st.branch}.` : `${basename(repo)}: nothing new on the server.`, st.behind ? 'info' : 'ok');
    if (state.tab === 'branches' && samePath(repo, currentRepo())) loadBranches();
  } catch (e) { if (!silent) showError("Couldn't check for updates", e); else throw e; }
}

async function doPull(repo) {
  const st = state.status[repo] || {};
  if (st.detached) { toast("You're not on a branch, so there's nothing to get. Switch to a branch first.", 'warn'); return false; }
  if (!st.upstream) {
    await modal({ title: 'Nothing to get yet', body: `<p>The branch <b>${esc(st.branch)}</b> only exists on your computer — it isn't on the server yet, so there's nothing to download.</p><p>Use <b>Publish branch</b> to put it on the server.</p>` });
    return false;
  }
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    let r = await busy(repo, 'Getting latest…', () => git('pull', repo, 'ff'));
    if (r.diverged) {
      const c = await choose('Both sides have new commits', `<p>You have commits on <b>${esc(st.branch)}</b> that aren't on the server, <i>and</i> the server has commits you don't have. They need to be combined.</p>`, [
        { id: 'merge', label: 'Combine them (merge)', desc: 'Downloads the server commits and joins them with yours in a “merge commit”. If you both changed the same lines, I\'ll help you resolve it. This is the safe, normal choice.' },
      ]);
      if (c !== 'merge') return false;
      r = await busy(repo, 'Combining…', () => git('pull', repo, 'merge'));
    }
    if (!(await afterMaybeConflict(repo, r, null))) return false;
    if (/Already up to date/i.test(r.output || '')) toast('Already up to date.', 'ok');
    else offerUndoMove(repo, before, 'Got the latest changes.', `get latest on ${st.branch}`);
    return true;
  } catch (e) { showError("Couldn't get the latest", e); return false; }
}

async function doPush(repo) {
  try {
    const r = await busy(repo, 'Sending…', () => git('push', repo));
    if (r.rejected) {
      const c = await choose('The server has newer commits', "<p>Someone else (or you, from another computer) sent commits to this branch. You need to get those first, then your commits can be sent on top.</p>", [
        { id: 'pull', label: 'Get latest, then send', desc: 'Recommended. Downloads their commits, combines with yours, then sends.', kind: 'primary' },
      ]);
      if (c === 'pull' && (await doPull(repo))) {
        const st = state.status[repo];
        if (!st.conflicted?.length && !st.op) return doPush(repo);
      }
      return false;
    }
    const msg = r.published ? 'Branch published to the server.' : 'Sent to the server.';
    // The natural next step after sending a feature branch is a pull request.
    if (r.branch && !['main', 'master', 'develop'].includes(r.branch)) {
      const url = await gitRaw('prUrl', repo, r.branch).catch(() => null);
      if (url) { toast(msg, 'ok', { label: 'Open pull request', fn: () => api.openUrl(url) }); return true; }
    }
    toast(msg, 'ok');
    return true;
  } catch (e) {
    if (e.code === 'NO_REMOTE') return addRemoteFlow(repo);
    showError("Couldn't send", e);
    return false;
  }
}

async function addRemoteFlow(repo) {
  const st = state.status[repo] || {};
  const url = await ask('Connect this repo to a server', {
    label: 'Server URL (from GitHub, Azure DevOps, GitLab…)',
    placeholder: 'https://github.com/you/project.git',
    help: 'This repo only exists on your computer. Create an <b>empty</b> repo on GitHub/Azure DevOps first, copy its URL, and paste it here. (This runs <code>git remote add origin &lt;url&gt;</code>.)',
    okLabel: st.initial ? 'Add server' : 'Add server & send',
  });
  if (!url) return false;
  try {
    await git('addRemote', repo, url);
    await refreshRepo(repo);
    onStatusChanged([repo]);
    if (st.initial) { toast('Server added. Make your first commit, then Publish.', 'ok'); return true; }
    return doPush(repo);
  } catch (e) { showError("Couldn't add the server", e); return false; }
}

async function afterMaybeConflict(repo, r, successMsg) {
  if (r && r.conflicts) {
    if (samePath(repo, currentRepo())) setTab('conflicts');
    else openRepo(repo, state.view.ws, 'conflicts');
    await modal({
      title: 'Some changes clash — your decision needed',
      body: `<p>Git combined everything it could automatically, but in some files <b>both sides changed the same lines</b>, so it needs you to pick what to keep. This is called a <b>merge conflict</b> — it's normal, nothing is broken or lost.</p>
        <p>In the <b>Conflicts</b> tab you'll see each clash side by side and can choose with one click. Changed your mind? <b>Abort</b> puts everything back the way it was.</p>`,
      buttons: [{ id: 'ok', label: "Let's resolve them", kind: 'primary' }],
    });
    return false;
  }
  if (successMsg) toast(successMsg, 'ok');
  return true;
}

// ---------- branches ----------
async function loadBranches() {
  const repo = currentRepo();
  try { state.branches = await git('branches', repo); }
  catch (e) { state.branches = { error: e.message }; }
  if (state.tab === 'branches' && samePath(currentRepo(), repo)) renderBranchesTab();
}

function trackText(b) {
  if (!b.upstream) return '<span class="tag">only on your computer</span>';
  if (b.track === 'gone') return '<span class="tag bad" title="It was probably merged and deleted on the server">deleted on server</span>';
  if (!b.track) return '<span class="tag ok">in sync with server</span>';
  return b.track.split(', ').map((t) => {
    const [kind, num] = t.split(' ');
    return kind === 'ahead' ? `<span class="tag ahead">↑${num} to send</span>` : `<span class="tag behind">↓${num} to get</span>`;
  }).join(' ');
}

function renderBranchesTab() {
  const body = $('#tab-body');
  const b = state.branches;
  const st = state.status[currentRepo()] || {};
  const cur = st.branch;
  const head = `<div class="toolbar wrap">
      <button class="btn primary" data-action="new-branch" data-repo="${esc(currentRepo())}">⎇ New branch…</button>
      ${cur ? `<button class="btn" data-action="update-from" data-repo="${esc(currentRepo())}" title="Bring in the new commits from main, dev or any other branch">⤓ Update ${esc(cur)} from…</button>` : ''}
      <input class="filter" id="branch-filter" placeholder="Filter branches…" spellcheck="false" aria-label="Filter branches">
      <button class="btn ghost" data-action="tidy" data-repo="${esc(currentRepo())}" title="Delete branches that were merged or deleted on the server">🧹 Tidy up…</button>
      <div class="spacer"></div>
      <span class="hint">A <b>branch</b> is a separate line of work. Switching branches changes the files in your folder to that branch's version.</span>
    </div>`;
  if (!b) { body.innerHTML = head + '<div class="empty muted"><span class="spinner"></span> Loading…</div>'; return; }
  if (b.error) { body.innerHTML = head + `<pre class="raw">${esc(b.error)}</pre>`; return; }
  const local = b.local.map((x) => `<div class="row ${x.current ? 'current' : ''}" data-name="${esc(x.name)}">
      <div class="row-main"><div class="row-title">${x.current ? '<span class="tag current">you are here</span> ' : ''}${esc(x.name)}</div>
      <div class="row-sub">${esc(x.subject)} · ${timeAgo(x.date)}</div></div>
      <div class="row-status">${trackText(x)}</div>
      <div class="row-actions">
        ${x.current ? '' : `<button class="btn small" data-action="switch-branch" data-name="${esc(x.name)}">Switch to</button>
        <button class="btn small ghost" data-action="merge-branch" data-name="${esc(x.name)}" title="git merge ${esc(x.name)} — copy all its commits into ${esc(cur)}">Merge into ${esc(cur || 'current')}</button>
        <button class="btn small ghost" data-action="pick-from" data-ref="${esc(x.name)}" title="See its commits and copy just the ones you want">🍒 Cherry-pick from…</button>`}
        <button class="icon-btn" data-action="branch-menu" data-name="${esc(x.name)}" title="More…">⋯</button>
      </div></div>`).join('');
  const remote = b.remoteOnly.map((x) => `<div class="row" data-name="${esc(x.name)}">
      <div class="row-main"><div class="row-title">${esc(x.branch)} <span class="muted small">(${esc(x.remote)})</span></div>
      <div class="row-sub">${esc(x.subject)} · ${timeAgo(x.date)}</div></div>
      <div class="row-status"><span class="tag">server only</span></div>
      <div class="row-actions">
        <button class="btn small" data-action="switch-remote" data-name="${esc(x.name)}" data-branch="${esc(x.branch)}" title="Downloads it as a branch on your computer and switches to it">Switch to</button>
        <button class="btn small ghost" data-action="merge-branch" data-name="${esc(x.name)}" title="git merge ${esc(x.name)}">Merge into ${esc(cur || 'current')}</button>
        <button class="btn small ghost" data-action="pick-from" data-ref="${esc(x.name)}" title="See its commits and copy just the ones you want">🍒 Cherry-pick from…</button>
      </div></div>`).join('');
  body.innerHTML = `${head}<div class="scroll">
    <h3>Branches on your computer <span class="muted small">(${b.local.length})</span></h3>
    <div class="rows" id="local-branches">${local || '<div class="muted pad">No branches yet — make your first commit.</div>'}</div>
    <h3>On the server only <span class="muted small">(${b.remoteOnly.length})</span></h3>
    <p class="hint">These exist on the server but you haven't got them as a branch here. “Switch to” downloads one. Click <b>Check for updates</b> to refresh this list.</p>
    <div class="rows">${remote || '<div class="muted pad">None.</div>'}</div>
  </div>`;
  $('#branch-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    body.querySelectorAll('.row[data-name]').forEach((r) => { r.style.display = r.dataset.name.toLowerCase().includes(q) ? '' : 'none'; });
  });
}

const branchTransform = (v) => v.replace(/\s+/g, '-');

async function newBranch(repo) {
  const st = state.status[repo] || {};
  let b = state.branches;
  if (!b || b.error || !samePath(repo, currentRepo())) { try { b = await git('branches', repo); } catch { b = { local: [], remote: [] }; } }
  const starts = [];
  if (!st.initial) starts.push({ v: '', label: st.detached ? 'This exact snapshot (where you are now)' : `${st.branch} — your current branch` });
  for (const x of b.local) if (!x.current) starts.push({ v: x.name, label: x.name });
  for (const x of b.remote) starts.push({ v: x.name, label: `${x.name} (latest from the server)` });
  const changes = changedFiles(st).length;
  const r = await modal({
    title: 'Create a new branch',
    body: `<label class="field"><span>Branch name</span><input name="name" placeholder="e.g. feature/login-page or fix/crash-on-save" spellcheck="false"></label>
      ${starts.length > 1 ? `<label class="field"><span>Start from</span><select name="start">${starts.map((s) => `<option value="${esc(s.v)}">${esc(s.label)}</option>`).join('')}</select></label>` : ''}
      <p class="hint">The new branch starts as a copy of what you pick above, and you'll be switched onto it.${changes ? ` Your ${plural(changes, 'uncommitted change')} will come with you.` : ''}</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Create & switch', kind: 'primary' }],
    init: (el) => { const i = el.querySelector('[name=name]'); i.addEventListener('input', () => { i.value = branchTransform(i.value); }); },
  });
  if (r.id !== 'ok' || !r.values.name) return;
  const name = r.values.name.trim();
  if (!(await git('checkBranchName', name))) { showError('Invalid branch name', new Error(`fatal: '${name}' is not a valid branch name`)); return; }
  try {
    await busy(repo, 'Creating branch…', () => git('createBranch', repo, name, r.values.start || null));
    toast(`Created ${name} and switched to it.`, 'ok');
    if (samePath(repo, currentRepo()) && state.tab === 'branches') loadBranches();
  } catch (e) { showError("Couldn't create the branch", e); }
}

// Switch branch, dealing with uncommitted changes in a friendly way.
async function switchBranch(repo, target, remoteRef) {
  const st = state.status[repo] || {};
  const changes = changedFiles(st).length;
  let shelved = false;
  if (changes) {
    const c = await choose(`You have ${plural(changes, 'uncommitted change')}`, `<p>What should happen to them when you switch from <b>${esc(st.branch || 'here')}</b> to <b>${esc(target)}</b>?</p>`, [
      { id: 'bring', label: 'Bring them with me', desc: `Your edits stay in your folder and carry over to <b>${esc(target)}</b>.` },
      { id: 'leave', label: `Leave them on ${st.branch || 'this branch'}`, desc: "Puts them on the Shelf. When you come back to this branch, I'll offer to restore them." },
    ]);
    if (c === 'cancel') return;
    if (c === 'leave') {
      try { await git('stashSave', repo, `[auto] ${st.branch}: left behind when switching to ${target}`); shelved = true; }
      catch (e) { showError("Couldn't put your changes on the Shelf", e); return; }
    }
  }
  try {
    await busy(repo, `Switching to ${target}…`, () => (remoteRef ? git('checkoutRemote', repo, remoteRef, target) : git('switchBranch', repo, target)));
    if (st.branch && !shelved) undoToast(`Now on ${target}.`, repo, `switch back to ${st.branch}`, () => git('switchBranch', repo, st.branch));
    else toast(`Now on ${target}.`, 'ok');
  } catch (e) {
    if (shelved) await gitRaw('stashPop', repo, 'stash@{0}').catch(() => {});
    if (e.code === CANCELLED) return;
    if (/would be overwritten|local changes/i.test(e.message) && !shelved) {
      const c = await choose("Your changes can't come along", `<p>Some files you've edited are also different on <b>${esc(target)}</b>, so git can't carry your edits over safely.</p>`, [
        { id: 'leave', label: `Leave them on ${st.branch} (Shelf) and switch`, desc: "Puts them on the Shelf. I'll offer to bring them back when you return." },
      ]);
      if (c === 'leave') {
        try {
          await git('stashSave', repo, `[auto] ${st.branch}: left behind when switching to ${target}`);
          await busy(repo, `Switching to ${target}…`, () => (remoteRef ? git('checkoutRemote', repo, remoteRef, target) : git('switchBranch', repo, target)));
          toast(`Now on ${target}. Your changes are on the Shelf.`, 'ok');
        } catch (e2) { showError("Couldn't switch", e2); return; }
      } else return;
    } else { showError("Couldn't switch branch", e); return; }
  }
  if (samePath(repo, currentRepo()) && state.tab === 'branches') loadBranches();
  await offerAutoRestore(repo, target);
}

async function offerAutoRestore(repo, branch) {
  const list = await git('stashList', repo).catch(() => []);
  const item = list.find((s) => s.message.startsWith(`[auto] ${branch}:`));
  if (!item) return;
  const st = state.status[repo] || {};
  const ok = await confirmBox('Welcome back!', `<p>You left some uncommitted changes on <b>${esc(branch)}</b> ${timeAgo(item.time)}. Put them back in your folder now?</p>${changedFiles(st).length ? '<p class="hint">You also have changes in your folder right now — they\'ll be combined.</p>' : ''}`, 'Restore them');
  if (!ok) return;
  try { const r = await busy(repo, 'Restoring…', () => git('stashPop', repo, item.ref)); afterMaybeConflict(repo, r, 'Your changes are back.'); }
  catch (e) { showError("Couldn't restore", e); }
}

async function mergeBranch(repo, name) {
  const st = state.status[repo] || {};
  const ok = await confirmBox(`Merge ${name} into ${st.branch}?`, `<p>This copies all the commits from <b>${esc(name)}</b> into <b>${esc(st.branch)}</b> (your current branch). <b>${esc(name)}</b> itself is not changed.</p>
    <p class="hint">If both branches changed the same lines you'll get a <b>conflict</b>, and I'll walk you through picking what to keep. You can always abort.</p>`, 'Merge');
  if (!ok) return;
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    const r = await busy(repo, 'Merging…', () => git('merge', repo, name));
    if (await afterMaybeConflict(repo, r, null)) {
      if (/Already up to date/i.test(r.output || '')) toast(`${st.branch} already has everything from ${name}.`, 'ok');
      else offerUndoMove(repo, before, `Merged ${name} into ${st.branch}.`, `merge of ${name} into ${st.branch}`);
    }
    if (state.tab === 'branches') loadBranches();
  } catch (e) { showError("Couldn't merge", e); }
}

// Bring the latest from another branch (main, dev, a teammate's branch…) into the current one.
async function updateFrom(repo) {
  const st = state.status[repo] || {};
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  if (!st.branch) { toast("You're not on a branch. Switch to one first.", 'warn'); return; }
  const b = await gitRaw('branches', repo).catch(() => null);
  if (!b) return;
  const local = b.local.filter((x) => !x.current).map((x) => x.name);
  const remote = b.remote.map((x) => x.name).filter((n) => n !== st.upstream);
  if (!local.length && !remote.length) { toast('There is no other branch to update from.', 'info'); return; }
  const memoKey = `${norm(repo)}|${st.branch}`;
  const remembered = state.config.updateFrom?.[memoKey];
  const def = await gitRaw('defaultBranch', repo).catch(() => null);
  const all = [...local, ...remote];
  const pick = [remembered, def && `origin/${def}`, def].find((x) => x && x !== st.branch && all.includes(x)) || all[0];
  const opt = (n) => `<option value="${esc(n)}" ${n === pick ? 'selected' : ''}>${esc(n)}</option>`;
  const r = await modal({
    title: `Update ${st.branch} from another branch`,
    body: `<label class="field"><span>Bring in the new commits from</span><select name="ref">
        ${local.length ? `<optgroup label="Branches on your computer">${local.map(opt).join('')}</optgroup>` : ''}
        ${remote.length ? `<optgroup label="On the server (latest you've checked)">${remote.map(opt).join('')}</optgroup>` : ''}
      </select></label>
      <p class="uf-info" id="uf-info"><span class="spinner sm"></span></p>
      <div class="field"><span>How</span>
        <label class="check"><input type="radio" name="mode" value="merge" checked> <span><b>Merge</b> (recommended) — adds a merge commit. Nothing you've already made is rewritten.</span></label>
        <label class="check" id="uf-rebase"><input type="radio" name="mode" value="rebase"> <span><b>Rebase</b> — replays your commits on top, for a straight history. Your commits get new IDs.</span></label>
      </div>
      <p class="hint">Uncommitted changes are set aside and put back automatically. If both branches changed the same lines, I'll walk you through it, and you can abort.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Update', kind: 'primary' }],
    init: (el) => {
      const sel = el.querySelector('[name=ref]');
      const info = el.querySelector('#uf-info');
      const rebase = el.querySelector('[value=rebase]');
      const ok = el.querySelector('[data-close=ok]');
      const show = async () => {
        const ref = sel.value;
        info.innerHTML = '<span class="spinner sm"></span>';
        const c = await gitRaw('compareCounts', repo, ref).catch(() => null);
        if (sel.value !== ref || !el.isConnected) return;
        if (!c) { info.textContent = ''; return; }
        info.innerHTML = c.behind
          ? `<b>${esc(ref)}</b> has <b>${plural(c.behind, 'commit')}</b> that ${esc(st.branch)} doesn't have yet.`
          : `${esc(st.branch)} already has everything from <b>${esc(ref)}</b>.`;
        ok.disabled = !c.behind;
        rebase.disabled = !c.canRebase;
        if (!c.canRebase && rebase.checked) el.querySelector('[value=merge]').checked = true;
        el.querySelector('#uf-rebase').title = c.canRebase ? 'git rebase' : `Not available: ${plural(c.sent, 'commit')} on ${st.branch} ${c.sent === 1 ? 'is' : 'are'} already on the server, and rebasing would rewrite ${c.sent === 1 ? 'it' : 'them'}.`;
      };
      sel.addEventListener('change', show);
      show();
    },
  });
  if (r.id !== 'ok') return;
  const ref = r.values.ref;
  state.config.updateFrom = { ...state.config.updateFrom, [memoKey]: ref };
  saveConfig();
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    const res = await busy(repo, `Updating from ${ref}…`, () => git('updateFrom', repo, ref, r.values.mode));
    if (await afterMaybeConflict(repo, res, null)) {
      if (/up to date/i.test(res.output || '')) toast(`${st.branch} already has everything from ${ref}.`, 'ok');
      else offerUndoMove(repo, before, `Updated ${st.branch} from ${ref}.`, `update from ${ref}`);
    }
    if (samePath(repo, currentRepo()) && ['branches', 'history'].includes(state.tab)) renderTab();
  } catch (e) { showError(`Couldn't update from ${ref}`, e); }
}

// When a branch's work is merged: go to the main branch, get its latest, delete the branch.
async function finishBranch(repo) {
  const st = state.status[repo] || {};
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  if (!st.branch) { toast("You're not on a branch.", 'warn'); return; }
  const target = await gitRaw('defaultBranch', repo).catch(() => null);
  if (!target || target === st.branch) { toast(`${st.branch} is the main branch, so there's nothing to finish.`, 'info'); return; }
  const dirty = changedFiles(st).length;
  const onServer = st.upstream && !st.upstreamGone;
  const r = await modal({
    title: `Finish ${st.branch}?`,
    body: `<ol class="steps">
        <li>Switch to <b>${esc(target)}</b> and get its latest${st.hasRemote ? ' from the server' : ''}.</li>
        <li>Delete <b>${esc(st.branch)}</b> on your computer. (Undo can bring it back.)</li>
      </ol>
      ${onServer ? `<label class="check"><input type="checkbox" name="remote"> Also delete it on the server (${esc(st.upstream)})</label>` : ''}
      ${dirty ? `<p class="hint">You have ${plural(dirty, 'uncommitted change')} on this branch. They'll be put on the Shelf first, so nothing is lost.</p>` : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: '✓ Finish branch', kind: 'primary' }],
  });
  if (r.id !== 'ok') return;
  const opts = { deleteRemote: !!r.values.remote };
  try {
    if (dirty) await git('stashSave', repo, `[auto] ${st.branch}: set aside when finishing the branch`);
    let res = await busy(repo, `Finishing ${st.branch}…`, () => git('finishBranch', repo, opts));
    if (res.needsForce) {
      const go = await confirmBox(`${st.branch} isn't in ${res.target} as-is`, `<p>Its commits aren't in <b>${esc(res.target)}</b> exactly as they are here. That's normal when a pull request is <b>squashed</b> on merge${st.upstreamGone ? ', and the server has already deleted the branch, so it was most likely merged' : ''}.</p>
        <p>Delete it anyway? Undo can bring it back afterwards.</p>`, 'Delete it anyway', true);
      if (!go) return;
      res = await busy(repo, `Finishing ${st.branch}…`, () => git('finishBranch', repo, { ...opts, force: true }));
    }
    undoToast(`Finished ${res.branch}. You're on ${res.target}${res.pulled === false ? " (couldn't get its latest — try Get latest)" : ''}.`, repo, `finish of ${res.branch}`, async () => {
      await git('restoreBranch', repo, res.branch, res.oid);
      await git('switchBranch', repo, res.branch);
    });
    if (samePath(repo, currentRepo()) && state.tab === 'branches') loadBranches();
  } catch (e) { showError(`Couldn't finish ${st.branch}`, e); }
}

// Workspace: finish every repo whose branch was deleted on the server.
async function wsFinish() {
  const repos = currentWs().repos.filter((p) => state.status[p]?.upstreamGone && state.status[p]?.branch);
  if (!repos.length) return;
  const r = await modal({
    title: 'Finish merged branches',
    body: `<p>These branches were deleted on the server, which usually means their pull requests were completed. For each one: switch to the main branch, get its latest, and delete the branch here.</p>
      <div class="field">${repos.map((p) => `<label class="check"><input type="checkbox" name="repos" data-multi="1" value="${esc(p)}" checked> <b>${esc(basename(p))}</b> <span class="muted small">${esc(state.status[p].branch)}</span></label>`).join('')}</div>
      <p class="hint">Repos with uncommitted changes, or whose commits aren't in the main branch as-is (e.g. squashed), are skipped — open them to finish.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: '✓ Finish', kind: 'primary' }],
  });
  if (r.id !== 'ok' || !r.values.repos?.length) return;
  const done = [];
  const results = await forEachRepo('Finishing…', r.values.repos, async (repo) => {
    if (changedFiles(state.status[repo]).length) return { ok: false, warn: true, msg: 'skipped — has uncommitted changes; open this repo to finish it' };
    const res = await git('finishBranch', repo, {});
    if (res.needsForce) return { ok: false, warn: true, msg: `${res.branch}'s commits aren't in ${res.target} as-is (squashed?) — open this repo to finish it` };
    done.push({ repo, ...res });
    return { ok: true, msg: `finished ${res.branch}, now on ${res.target}` };
  }, (repo) => ['finishBranch', repo, {}]);
  if (!results) return;
  if (done.length) {
    recordUndo({
      label: `finish of ${plural(done.length, 'branch', 'branches')}`,
      repos: done.map((d) => d.repo),
      run: async () => {
        for (const d of done) { await git('restoreBranch', d.repo, d.branch, d.oid); await git('switchBranch', d.repo, d.branch); }
        await refreshAll();
      },
    });
  }
  resultsModal('Finish branches — results', results, done.length ? 'Changed your mind? <b>↶ Undo…</b> brings the branches back.' : '');
}

async function branchMenu(repo, name) {
  const b = state.branches?.local.find((x) => x.name === name);
  if (!b) return;
  const cur = state.status[repo]?.branch;
  const c = await choose(name, '', [
    ...(b.current || !cur ? [] : [{ id: 'compare', label: `Compare with ${cur}`, desc: `See what ${esc(name)} has that ${esc(cur)} doesn't.` }]),
    ...(b.current ? [{ id: 'finish', label: 'Finish this branch…', desc: 'After its pull request: switch to the main branch, get its latest, and delete this branch.' }] : []),
    { id: 'rename', label: 'Rename…' },
    ...(b.current ? [] : [{ id: 'delete', label: 'Delete…', desc: 'Removes the branch from your computer (and optionally the server).', kind: 'danger' }]),
  ]);
  if (c === 'compare') showCompare(cur, name);
  else if (c === 'finish') finishBranch(repo);
  else if (c === 'rename') {
    const nn = await ask(`Rename ${name}`, { label: 'New name', value: name, transform: branchTransform, okLabel: 'Rename', help: b.upstream ? "Note: this only renames it on your computer. The server still has the old name." : '' });
    if (!nn || nn === name) return;
    try { await git('renameBranch', repo, name, nn); toast('Renamed.', 'ok'); loadBranches(); refreshAll(); }
    catch (e) { showError("Couldn't rename", e); }
  } else if (c === 'delete') {
    const slash = b.upstream ? b.upstream.indexOf('/') : -1;
    const remote = slash > 0 && b.track !== 'gone' ? { remote: b.upstream.slice(0, slash), branch: b.upstream.slice(slash + 1) } : null;
    const r = await modal({
      title: `Delete ${name}?`,
      body: `<p>This removes the branch <b>${esc(name)}</b> from your computer.</p>
        ${remote ? `<label class="check"><input type="checkbox" name="remote"> Also delete it on the server (${esc(b.upstream)})</label>` : ''}`,
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete', kind: 'danger' }],
    });
    if (r.id !== 'ok') return;
    const opts = { remote: r.values.remote ? remote : null };
    // Undo brings the branch back on this computer (a server deletion isn't reversed).
    const deleted = (res) => undoToast(`Deleted ${name}.`, repo, `delete ${name}`, async () => { await git('restoreBranch', repo, name, res.oid); loadBranches(); });
    try { deleted(await git('deleteBranch', repo, name, opts)); }
    catch (e) {
      if (/not fully merged/i.test(e.message)) {
        const force = await confirmBox('This branch has unmerged work', `<p><b>${esc(name)}</b> has commits that aren't in any other branch. If you delete it, those commits will be lost.</p>`, 'Delete anyway', true);
        if (!force) return;
        try { deleted(await git('deleteBranch', repo, name, { ...opts, force: true })); }
        catch (e2) { showError("Couldn't delete", e2); }
      } else showError("Couldn't delete", e);
    }
    loadBranches();
  }
}

// ---------- history ----------
async function loadHistory() {
  const repo = currentRepo();
  if (state.histRef && state.histRef === state.status[repo]?.branch) state.histRef = null;
  const ref = state.histRef;
  try {
    const [h, b] = await Promise.all([
      gitRaw('history', repo, { ref, notIn: !!ref && state.histNotIn, file: state.histFile }),
      gitRaw('branches', repo).catch(() => null),
    ]);
    state.history = h;
    if (b) state.branches = b;
  } catch (e) { state.history = { error: e.message }; }
  if (state.tab === 'history' && samePath(currentRepo(), repo) && state.histRef === ref) renderHistoryTab();
}

// Opens History showing only commits that changed `file`.
function showFileHistory(file) {
  state.histFile = file;
  state.histRef = null;
  state.selCommit = null;
  state.history = null;
  state.picks.clear();
  if (state.tab === 'history') { renderHistoryTab(); loadHistory(); } else setTab('history');
}

function showHistoryOf(ref) {
  state.histRef = ref || null;
  state.histNotIn = true;
  state.picks.clear();
  state.selCommit = null;
  state.history = null;
  if (state.tab === 'history') { renderHistoryTab(); loadHistory(); } else setTab('history');
}

function refTags(refs) {
  return refs.map((r) => {
    if (r === 'HEAD') return '';
    // title shows the full name when a long one is cut short.
    if (r.startsWith('HEAD -> ')) return `<span class="tag current" title="${esc(r.slice(8))}">${esc(r.slice(8))}</span>`;
    if (r.startsWith('tag: ')) return `<span class="tag" title="${esc(r.slice(5))}">🏷 ${esc(r.slice(5))}</span>`;
    return `<span class="tag ${r.includes('/') ? 'remote' : ''}" title="${esc(r)}">${esc(r)}</span>`;
  }).join(' ');
}

// ---------- commit graph ----------
const LANE_W = 12;
const LANE_COLORS = ['#5b8cff', '#3fbf74', '#e0a341', '#d06bd6', '#f06a6a', '#3fc1c9', '#9a8cff', '#c9a227'];
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

// One row of the graph: lines from the row above into this commit's dot, and on to its parents below.
function graphSvg(g, lanes) {
  const x = (i) => i * LANE_W + 8;
  const ln = (x1, y1, x2, y2, c) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${laneColor(c)}" stroke-width="2" />`;
  const parts = [];
  g.before.forEach((h, i) => {
    if (h == null) return;
    if (i === g.col) { if (g.hasChild) parts.push(ln(x(i), '0%', x(g.col), '50%', i)); }
    else if (g.merging.includes(i)) parts.push(ln(x(i), '0%', x(g.col), '50%', i));
    else { const j = g.after.indexOf(h); parts.push(ln(x(i), '0%', x(j >= 0 ? j : i), '100%', i)); }
  });
  g.parentCols.forEach((pc) => parts.push(ln(x(g.col), '50%', x(pc), '100%', pc)));
  parts.push(`<circle cx="${x(g.col)}" cy="50%" r="4.5" fill="${laneColor(g.col)}" stroke="var(--panel)" stroke-width="2" />`);
  return `<span class="commit-graph" style="width:${Math.max(1, lanes) * LANE_W + 6}px" aria-hidden="true"><svg>${parts.join('')}</svg></span>`;
}

function commitRow(c, unpushed, pickable = true, graph = '') {
  return `<div class="commit commit-row ${state.selCommit === c.hash ? 'selected' : ''}" data-action="select-commit" data-hash="${c.hash}" data-search="${esc(`${c.subject} ${c.author} ${c.hash}`.toLowerCase())}">
    ${pickable ? `<input type="checkbox" data-action="pick-commit" data-hash="${c.hash}" ${state.picks.has(c.hash) ? 'checked' : ''} title="Tick to cherry-pick this commit" aria-label="Select ${esc(c.subject)}">` : ''}
    ${graph}
    <div class="commit-text">
      <div class="commit-subject">${esc(c.subject)} ${unpushed ? '<span class="tag ahead" title="Committed on your computer but not sent to the server yet">not sent</span>' : ''} ${refTags(c.refs)}</div>
      <div class="commit-meta">${esc(c.author)} · ${timeAgo(c.date)} · <span class="mono">${c.short}</span>${c.parents.length > 1 ? ' · merge' : ''}</div>
    </div>
  </div>`;
}

function renderHistoryTab() {
  const body = $('#tab-body');
  const st = state.status[currentRepo()] || {};
  const cur = st.branch || 'here';
  const h = state.history;
  const ref = state.histRef;
  const b = state.branches && !state.branches.error ? state.branches : { local: [], remote: [] };
  const others = b.local.filter((x) => !x.current);
  const toolbar = `<div class="toolbar wrap">
      <span class="muted">Showing commits on</span>
      <select id="hist-ref" class="ref-select">
        <option value="" ${!ref ? 'selected' : ''}>${esc(cur)} (current branch)</option>
        ${others.length ? `<optgroup label="Other branches on your computer">${others.map((x) => `<option value="${esc(x.name)}" ${ref === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}
        ${b.remote.length ? `<optgroup label="On the server">${b.remote.map((x) => `<option value="${esc(x.name)}" ${ref === x.name ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}
      </select>
      ${ref ? `<label class="check"><input type="checkbox" data-action="hist-notin" ${state.histNotIn ? 'checked' : ''}> Hide commits already in ${esc(cur)}</label>` : ''}
      <input class="filter" id="hist-search" placeholder="Search message, author or hash…" value="${esc(state.histQuery)}" spellcheck="false" aria-label="Search commits">
      ${state.histFile ? `<span class="chip on" title="${esc(state.histFile)}">Only changes to ${esc(basename(state.histFile))} <button class="chip-x" data-action="clear-file-history" aria-label="Show all commits">✕</button></span>
        <div class="seg small" role="group" aria-label="Right-hand side shows"><button class="seg-btn ${state.blame ? '' : 'active'}" data-action="blame-mode" data-on="">Commit details</button><button class="seg-btn ${state.blame ? 'active' : ''}" data-action="blame-mode" data-on="1" title="git blame">Who changed each line</button></div>` : ''}
      ${!ref && !state.histFile && st.branch ? `<button class="btn ghost" data-action="tidy-commits" title="Combine, reword or drop commits you haven't sent yet (git rebase -i)">✎ Tidy unsent commits…</button>` : ''}
      <div class="spacer"></div>
      <div id="pick-bar" class="pick-bar"></div>
    </div>
    ${ref ? `<div class="explain">🍒 <b>Cherry-pick</b> copies individual commits from <b>${esc(ref)}</b> into <b>${esc(cur)}</b> — without merging the whole branch. Tick the ones you want, then click <b>Cherry-pick into ${esc(cur)}</b>.</div>` : ''}`;
  const bind = () => {
    $('#hist-ref').addEventListener('change', (e) => showHistoryOf(e.target.value));
    $('#hist-search').addEventListener('input', (e) => { state.histQuery = e.target.value; filterHistory(); });
    renderPickBar();
    filterHistory();
  };
  if (!h) { body.innerHTML = toolbar + '<div class="empty muted"><span class="spinner"></span> Loading…</div>'; bind(); return; }
  if (h.error) { body.innerHTML = toolbar + `<pre class="raw">${esc(h.error)}</pre>`; bind(); return; }
  for (const p of [...state.picks]) if (!h.commits.some((c) => c.hash === p)) state.picks.delete(p);
  const unpushed = new Set(h.unpushed);
  if (!state.selCommit && h.commits[0]) state.selCommit = h.commits[0].hash;
  const empty = ref && state.histNotIn ? `<div class="empty"><div class="big">✓</div><b>Nothing to cherry-pick</b><p>${esc(cur)} already has every change from ${esc(ref)}.</p></div>` : '<div class="empty muted">No commits yet.</div>';
  // The graph only makes sense for a full branch history (not a filtered or cherry-pick list).
  const showGraph = !state.histFile && !(ref && state.histNotIn);
  const graph = showGraph ? graphRows(h.commits) : [];
  const lanes = graph.reduce((m, g) => Math.max(m, g.before.length, g.after.length, g.col + 1), 1);
  body.innerHTML = `${toolbar}<div class="split">
    <div class="pane-left scroll" id="history-list">
      ${h.incoming.length && !state.histFile ? `<div class="incoming"><div class="incoming-head"><b>On the server, not on your computer yet (${h.incoming.length})</b><button class="btn small primary" data-action="pull" data-repo="${esc(currentRepo())}">↓ Get latest</button></div>
        ${h.incoming.map((c) => commitRow(c, false, false)).join('')}</div>` : ''}
      ${h.commits.length ? h.commits.map((c, i) => commitRow(c, unpushed.has(c.hash), true, showGraph ? graphSvg(graph[i], lanes) : '')).join('') : empty}
      <div class="empty muted" id="hist-nomatch" hidden>No commits match your search.</div>
    </div>
    <div class="pane-right" id="commit-pane"></div>
  </div>`;
  bind();
  if (state.histFile && state.blame) loadBlame();
  else loadCommitDetails();
}

// "Who changed each line" for the file History is showing: lines grouped by the commit that last changed them.
async function loadBlame() {
  const repo = currentRepo();
  const file = state.histFile;
  const pane = $('#commit-pane');
  if (!pane || !file) return;
  pane.innerHTML = '<div class="empty muted"><span class="spinner"></span></div>';
  let b;
  try { b = await gitRaw('blame', repo, file); }
  catch (e) { pane.innerHTML = `<pre class="raw">${esc(e.message)}</pre>`; return; }
  if (!$('#commit-pane') || state.histFile !== file || !state.blame) return;
  const groups = [];
  for (const l of b.lines) {
    const g = groups[groups.length - 1];
    if (g && g.hash === l.hash) g.lines.push(l);
    else groups.push({ hash: l.hash, lines: [l] });
  }
  const lang = langOf(file);
  const meta = (g) => {
    if (/^0+$/.test(g.hash)) return '<span class="bl-meta"><span class="muted">Not committed yet</span></span>';
    const c = b.commits[g.hash];
    const from = g.lines[0].n;
    const to = g.lines[g.lines.length - 1].n;
    return `<span class="bl-meta"><button class="bl-hash mono" data-action="blame-commit" data-hash="${g.hash}" title="Show this commit">${g.hash.slice(0, 7)}</button>
      <span class="bl-who">${esc(c.author)} · ${timeAgo(c.time)}</span>
      <span class="bl-sum" title="${esc(c.summary)}">${esc(c.summary)}</span>
      <button class="icon-btn bl-explain" data-action="blame-explain" data-hash="${g.hash}" data-from="${from}" data-to="${to}" title="Ask Claude why these lines were changed">✦</button></span>`;
  };
  const html = groups.map((g, gi) => g.lines.map((l, i) => `<div class="bl g${gi % 2} ${i ? '' : 'first'}">${i ? '<span class="bl-meta"></span>' : meta(g)}<span class="ln">${l.n}</span><span class="code">${highlight(l.text, lang) || ' '}</span></div>`).join('')).join('');
  const shaped = Object.keys(b.commits).filter((h) => !/^0+$/.test(h)).length;
  pane.innerHTML = `<div class="diff-head"><b>${esc(file)}</b><span class="muted small">${plural(shaped, 'commit')} shaped this file as it is now${b.truncated ? ' (showing the first 20,000 lines)' : ''}</span></div>
    <div class="diff-scroll"><div class="blame">${html}</div></div>`;
}

// Search hides non-matching rows (and the graph, whose lines would no longer join up).
function filterHistory() {
  const list = $('#history-list');
  if (!list) return;
  const q = state.histQuery.trim().toLowerCase();
  list.classList.toggle('searching', !!q);
  let shown = 0;
  list.querySelectorAll('.commit-row[data-search]').forEach((r) => {
    const hit = !q || q.split(/\s+/).every((w) => r.dataset.search.includes(w));
    r.hidden = !hit;
    if (hit) shown++;
  });
  $('#hist-nomatch').hidden = !q || shown > 0;
}

function renderPickBar() {
  const bar = $('#pick-bar');
  if (!bar) return;
  const n = state.picks.size;
  const cur = state.status[currentRepo()]?.branch || 'here';
  if (!n) { bar.innerHTML = `<span class="hint">Tick commits to cherry-pick them ${state.histRef ? `into ${esc(cur)}` : 'to another branch'}.</span>`; return; }
  bar.innerHTML = `<span><b>${n}</b> ticked</span>
    ${state.histRef ? `<button class="btn small primary" data-action="cherry-pick" title="git cherry-pick">🍒 Cherry-pick into ${esc(cur)}</button>` : ''}
    <button class="btn small ${state.histRef ? '' : 'primary'}" data-action="cherry-pick-to">Copy to another branch…</button>
    <button class="btn small ghost" data-action="clear-picks">Clear</button>`;
}

// Ticked commits in the order git should apply them: oldest first.
const orderedCommits = (hashes) => (state.history?.commits || []).filter((c) => hashes.includes(c.hash)).reverse();
const commitListHtml = (commits) => `<ul class="pick-list">${commits.map((c) => `<li><span class="mono">${c.short}</span> ${esc(c.subject)}</li>`).join('')}</ul>`;
const xCheckbox = () => `<label class="check"><input type="checkbox" name="x" ${state.config.settings.cherryPickX ? 'checked' : ''}> Add “(cherry picked from commit …)” to each commit message</label>`;
function rememberX(x) {
  if (x !== state.config.settings.cherryPickX) { state.config.settings.cherryPickX = x; saveConfig(); }
}

async function cherryPickHere(repo, hashes) {
  const st = state.status[repo] || {};
  const cur = st.branch || 'the current commit';
  const commits = orderedCommits(hashes);
  if (!commits.length) return;
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  const r = await modal({
    title: `Cherry-pick ${plural(commits.length, 'commit')} into ${cur}?`,
    body: `<p>${commits.length === 1 ? 'This commit is' : 'These commits are'} copied onto <b>${esc(cur)}</b> as new commits, oldest first. The branch they came from isn't changed.</p>
      ${commitListHtml(commits)}${xCheckbox()}
      <p class="hint">If a commit clashes with what's already on ${esc(cur)}, you'll get the conflict helper — and you can skip that commit or abort the whole thing.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: '🍒 Cherry-pick', kind: 'primary' }],
  });
  if (r.id !== 'ok') return;
  rememberX(r.values.x);
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    const res = await busy(repo, 'Cherry-picking…', () => git('cherryPick', repo, commits.map((c) => c.hash), { x: r.values.x }));
    state.picks.clear();
    if (await afterMaybeConflict(repo, res, null)) {
      if (res.picked) offerUndoMove(repo, before, `Copied ${plural(res.picked, 'commit')} into ${cur}.`, `cherry-pick into ${cur}`);
      else toast(`Nothing new to copy — ${cur} already has those changes.`, 'ok');
    }
    if (state.tab === 'history') loadHistory();
  } catch (e) { showError("Couldn't cherry-pick", e); }
}

async function cherryPickTo(repo, hashes) {
  const st = state.status[repo] || {};
  const commits = orderedCommits(hashes);
  if (!commits.length) return;
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  if (!st.branch) { toast("You're not on a branch. Switch to one first.", 'warn'); return; }
  const targets = (state.branches?.local || []).filter((x) => !x.current);
  if (!targets.length) { toast('There is no other branch to copy to. Create one first (Branches tab).', 'warn'); return; }
  const dirty = changedFiles(st).length;
  const r = await modal({
    title: `Copy ${plural(commits.length, 'commit')} to another branch`,
    body: `<label class="field"><span>Copy to</span><select name="target">${targets.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</select></label>
      ${commitListHtml(commits)}
      <label class="check"><input type="checkbox" name="back" checked> Come back to <b>${esc(st.branch)}</b> afterwards</label>
      ${xCheckbox()}
      ${dirty ? `<p class="hint">Your ${plural(dirty, 'uncommitted change')} will be put on the Shelf while this happens, and put back when you're back on ${esc(st.branch)}.</p>` : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: '🍒 Copy commits', kind: 'primary' }],
  });
  if (r.id !== 'ok') return;
  rememberX(r.values.x);
  const target = r.values.target;
  try {
    const res = await busy(repo, `Copying to ${target}…`, () => git('cherryPickOnto', repo, { hashes: commits.map((c) => c.hash), target, returnAfter: r.values.back, x: r.values.x }));
    state.picks.clear();
    if (res.conflicts) {
      await afterMaybeConflict(repo, res);
      toast(`You're on ${target} now, to resolve the conflicts.${res.shelved ? ` Your uncommitted changes are on the Shelf; you'll be offered them back when you return to ${res.original}.` : ''}`, 'info');
    } else {
      let msg = res.picked ? `Copied ${plural(res.picked, 'commit')} to ${target}.` : `${target} already had those changes.`;
      if (!res.returned) msg += ` You're now on ${target}.${res.shelved ? ` Your uncommitted changes wait on the Shelf for when you go back to ${res.original}.` : ''}`;
      toast(msg, 'ok');
      if (res.restoreConflicts) await afterMaybeConflict(repo, { conflicts: true });
    }
    if (state.tab === 'history') loadHistory();
  } catch (e) { showError("Couldn't copy the commits", e); }
}

async function loadCommitDetails() {
  const repo = currentRepo();
  const pane = $('#commit-pane');
  const hash = state.selCommit;
  if (!pane || !hash) return;
  pane.innerHTML = '<div class="empty muted"><span class="spinner"></span></div>';
  let d;
  try { d = await git('commitDetails', repo, hash); } catch (e) { pane.innerHTML = `<pre class="raw">${esc(e.message)}</pre>`; return; }
  if (state.selCommit !== hash || !$('#commit-pane')) return;
  const h = state.history;
  const isHead = !state.histRef && h.commits[0]?.hash === hash;
  const canUndo = isHead && d.parents.length === 1 && (!h.upstream || h.unpushed.includes(hash));
  const inList = h.commits.some((c) => c.hash === hash);
  const cur = state.status[repo]?.branch || 'here';
  const [subject, ...rest] = d.message.split('\n');
  pane.innerHTML = `<div class="commit-detail">
      <div class="cd-subject">${esc(subject)}</div>
      ${rest.join('\n').trim() ? `<pre class="cd-body">${esc(rest.join('\n').trim())}</pre>` : ''}
      <div class="cd-meta">${esc(d.author)} &lt;${esc(d.email)}&gt; · ${new Date(d.date * 1000).toLocaleString()} · <span class="mono">${d.hash.slice(0, 10)}</span></div>
      ${inList ? `<div class="cd-actions">
        <button class="btn small ghost" data-action="explain-commit" data-hash="${d.hash}" data-subject="${esc(subject)}" title="Ask Claude to explain this commit">✦ Explain</button>
        ${state.histRef ? `<button class="btn small primary" data-action="cherry-pick-one" data-hash="${d.hash}" title="git cherry-pick">🍒 Cherry-pick into ${esc(cur)}</button>` : ''}
        <button class="btn small" data-action="cherry-pick-to-one" data-hash="${d.hash}">Copy to another branch…</button>
        ${!state.histRef && !canUndo ? `<button class="btn small" data-action="revert-commit" data-hash="${d.hash}" data-subject="${esc(subject)}" title="git revert — a new commit that does the opposite">↺ Reverse this commit…</button>` : ''}
        ${canUndo ?`<button class="btn small" data-action="undo-commit" title="git reset --soft HEAD~1">↶ Undo this commit</button><span class="hint">Undo keeps your changes (they go back to the Changes tab). Possible because it hasn't been sent yet.</span>` : ''}
      </div>` : ''}
    </div>
    <div class="diff-scroll">${renderDiff(d.diff)}</div>`;
}

// Combine, reword or drop commits that haven't been sent yet.
async function tidyCommits(repo) {
  const st = state.status[repo] || {};
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  const u = await gitRaw('unsentCommits', repo).catch((e) => ({ error: e.message }));
  if (u.error) { showError("Couldn't read your commits", new Error(u.error)); return; }
  if (!u.commits.length) { toast('Nothing to tidy — every commit on this branch has been sent.', 'info'); return; }
  if (u.hasMerge) { toast("Your unsent commits include a merge, which can't be tidied here.", 'warn'); return; }
  const n = u.commits.length;
  const r = await modal({
    title: `Tidy ${plural(n, 'unsent commit')} on ${st.branch}`,
    wide: true,
    body: `<p class="hint">Oldest first. Only commits that haven't been sent are listed, so nobody else has them yet.${u.more ? ' (Showing the newest 50.)' : ''}</p>
      <div class="tidy-list">${u.commits.map((c, i) => `<div class="tidy-commit" data-i="${i}">
        <div class="tidy-head"><span class="mono">${c.short}</span>
          <select name="act${i}" aria-label="What to do with ${esc(c.short)}">
            <option value="pick">Keep</option>
            ${i ? '<option value="squash">Combine into the one above</option>' : ''}
            <option value="drop">Drop (throw away)</option>
          </select></div>
        <textarea name="msg${i}" rows="${Math.min(4, c.message.split('\n').length)}" aria-label="Message for ${esc(c.short)}" spellcheck="true">${esc(c.message)}</textarea>
        <div class="tidy-note hint" hidden></div>
      </div>`).join('')}</div>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Tidy commits', kind: 'primary' }],
    init: (el) => {
      // A combined commit's message goes into the commit it joins; dropped ones have none.
      const sync = () => {
        el.querySelectorAll('.tidy-commit').forEach((row) => {
          const act = row.querySelector('select').value;
          const note = row.querySelector('.tidy-note');
          row.querySelector('textarea').hidden = act !== 'pick';
          row.classList.toggle('dropped', act === 'drop');
          note.hidden = act === 'pick';
          note.textContent = act === 'drop' ? 'This commit and its changes will be removed.' : 'Its changes join the commit above; edit the message there.';
        });
      };
      el.addEventListener('change', sync);
      sync();
    },
  });
  if (r.id !== 'ok') return;
  const steps = u.commits.map((c, i) => {
    const action = r.values[`act${i}`];
    const msg = r.values[`msg${i}`].trim();
    return { hash: c.hash, action, ...(action === 'pick' && msg !== c.message ? { message: msg } : {}) };
  });
  if (steps.every((s) => s.action === 'pick' && s.message == null)) { toast('Nothing changed.', 'info'); return; }
  if (steps.some((s) => s.action === 'pick' && s.message === '')) { toast('A kept commit needs a message.', 'warn'); return; }
  if (steps.every((s) => s.action === 'drop') && !(await confirmBox('Drop every unsent commit?', '<p>All your unsent commits and their changes will be removed from this branch. Undo can bring them back.</p>', 'Drop them all', true))) return;
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    const res = await busy(repo, 'Tidying commits…', () => git('tidyCommits', repo, steps));
    if (await afterMaybeConflict(repo, res, null)) offerUndoMove(repo, before, 'Commits tidied.', `tidy of ${plural(n, 'commit')}`);
    if (state.tab === 'history') loadHistory();
  } catch (e) { showError("Couldn't tidy the commits", e); }
}

// Back out an older (or already sent) commit by adding one that does the opposite.
async function revertCommit(repo, hash, subject) {
  const st = state.status[repo] || {};
  if (st.op) { toast('Finish or abort what is in progress first (see the yellow banner).', 'warn'); return; }
  const isMerge = state.history?.commits.find((c) => c.hash === hash)?.parents.length > 1;
  const dirty = changedFiles(st).length;
  const ok = await confirmBox('Reverse this commit?', `<p>This adds a new commit to <b>${esc(st.branch || 'here')}</b> that does the exact opposite of “${esc(subject)}”. The original commit stays in the history, so this is safe even after it was sent to the server.</p>
    ${isMerge ? `<p>This is a merge, so everything it brought in from the other branch is taken back out.</p>` : ''}
    ${dirty ? `<p class="hint">Your ${plural(dirty, 'uncommitted change')} ${dirty === 1 ? 'is' : 'are'} set aside while this happens and put back afterwards.</p>` : ''}
    <p class="hint">If later commits changed the same lines, I'll walk you through it, and you can abort.</p>`, '↺ Reverse it');
  if (!ok) return;
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    const r = await busy(repo, 'Reversing…', () => git('revertCommit', repo, hash));
    if (r.conflicts) {
      await afterMaybeConflict(repo, r, null);
      if (r.shelved) toast('Your uncommitted changes are waiting on the Shelf. Restore them from there once the reverse is finished.', 'info');
    } else {
      offerUndoMove(repo, before, `Reversed “${subject}”. Send it to share the fix.`, `reverse of “${subject}”`);
      if (r.restoreConflicts) await afterMaybeConflict(repo, { conflicts: true });
    }
    if (state.tab === 'history') loadHistory();
  } catch (e) { showError("Couldn't reverse the commit", e); }
}

// ---------- compare two branches ----------
// state.cmp: { base, head, mode: 'split'|'exact', data, sel } — what `head` has compared with `base`.
async function loadCompare() {
  const repo = currentRepo();
  const c = (state.cmp ||= { base: null, head: null, mode: 'split', data: null, sel: null });
  const token = {};
  c.token = token;
  if (!state.branches || state.branches.error) state.branches = await gitRaw('branches', repo).catch(() => null);
  if (!c.head) c.head = state.status[repo]?.branch || state.branches?.local[0]?.name || null;
  if (!c.base) {
    const def = await gitRaw('defaultBranch', repo).catch(() => null);
    c.base = def && def !== c.head ? def : state.branches?.local.find((x) => x.name !== c.head)?.name || null;
  }
  let data;
  if (!c.base || !c.head || c.base === c.head) data = { same: true };
  else {
    try { data = await gitRaw('compare', repo, c.base, c.head, { mode: c.mode }); }
    catch (e) { data = { error: e.message }; }
  }
  if (c.token !== token || !samePath(currentRepo(), repo)) return;
  c.data = data;
  if (data.files && !data.files.some((f) => f.path === c.sel)) c.sel = data.files[0]?.path || null;
  if (state.tab === 'compare') renderCompareTab();
}

function showCompare(base, head) {
  state.cmp = { base, head, mode: state.cmp?.mode || 'split', data: null, sel: null };
  if (state.tab === 'compare') { renderCompareTab(); loadCompare(); } else setTab('compare');
}

function renderCompareTab() {
  const body = $('#tab-body');
  const c = state.cmp || {};
  const b = state.branches && !state.branches.error ? state.branches : { local: [], remote: [] };
  const opts = (sel) => {
    const known = [...b.local.map((x) => x.name), ...b.remote.map((x) => x.name)];
    return `${sel && !known.includes(sel) ? `<option selected>${esc(sel)}</option>` : ''}
      ${b.local.length ? `<optgroup label="On your computer">${b.local.map((x) => `<option value="${esc(x.name)}" ${x.name === sel ? 'selected' : ''}>${esc(x.name)}${x.current ? ' (current)' : ''}</option>`).join('')}</optgroup>` : ''}
      ${b.remote.length ? `<optgroup label="On the server">${b.remote.map((x) => `<option value="${esc(x.name)}" ${x.name === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : ''}`;
  };
  const exact = c.mode === 'exact';
  const head = esc(c.head || '…');
  const base = esc(c.base || '…');
  const toolbar = `<div class="toolbar wrap">
      <span class="muted">What</span><select id="cmp-head" class="ref-select" aria-label="Branch to look at">${opts(c.head)}</select>
      <span class="muted">has, compared with</span><select id="cmp-base" class="ref-select" aria-label="Branch to compare with">${opts(c.base)}</select>
      <button class="btn small ghost" data-action="cmp-swap" title="Swap the two branches">⇄ Swap</button>
      <div class="seg small" role="group" aria-label="What to compare">
        <button class="seg-btn ${exact ? '' : 'active'}" data-action="cmp-range" data-mode="split" title="Only what changed on ${head} since it split from ${base}: what a pull request would show">Since they split</button>
        <button class="seg-btn ${exact ? 'active' : ''}" data-action="cmp-range" data-mode="exact" title="Every difference between the two branches as they are now">Exact difference</button>
      </div>
    </div>
    <div class="explain">${exact
      ? `Every difference between <b>${base}</b> and <b>${head}</b> right now: what would change in your folder if you switched from ${base} to ${head}.`
      : `The changes made on <b>${head}</b> since it split from <b>${base}</b>: what a pull request from ${head} into ${base} would contain.`}</div>`;
  const bind = () => {
    $('#cmp-head').addEventListener('change', (e) => showCompare(c.base, e.target.value));
    $('#cmp-base').addEventListener('change', (e) => showCompare(e.target.value, c.head));
  };
  const d = c.data;
  if (!d) { body.innerHTML = toolbar + '<div class="empty muted"><span class="spinner"></span> Loading…</div>'; bind(); return; }
  if (d.same) { body.innerHTML = toolbar + '<div class="empty muted">Pick two different branches to compare.</div>'; bind(); return; }
  if (d.error) { body.innerHTML = toolbar + `<pre class="raw">${esc(d.error)}</pre>`; bind(); return; }
  const commits = d.commits.map((x) => `<div class="commit cmp-commit"><div class="commit-subject">${esc(x.subject)}</div>
      <div class="commit-meta">${esc(x.author)} · ${timeAgo(x.date)} · <span class="mono">${x.short}</span></div></div>`).join('');
  const files = d.files.map((f) => {
    const slash = f.path.lastIndexOf('/');
    const stat = f.add == null ? '<span class="muted">binary</span>' : `<span class="st-add">+${f.add}</span> <span class="st-del">−${f.del}</span>`;
    return `<div class="file ${f.path === c.sel ? 'selected' : ''}" data-action="cmp-file" data-path="${esc(f.path)}">
      <span class="code c-${f.code}" title="${CODE_LABEL[f.code] || f.code}">${f.code}</span>
      <span class="fname" title="${esc(f.orig ? `${f.orig} → ${f.path}` : f.path)}"><b>${esc(f.path.slice(slash + 1))}</b> <span class="muted">${esc(slash >= 0 ? f.path.slice(0, slash + 1) : '')}</span></span>
      <span class="cmp-stat">${stat}</span></div>`;
  }).join('');
  body.innerHTML = `${toolbar}<div class="split">
    <div class="pane-left scroll">
      <div class="cmp-sum"><b>${plural(d.onlyHead, 'commit')}</b> on ${head} that ${base} doesn't have · <b>${plural(d.onlyBase, 'commit')}</b> the other way</div>
      ${d.commits.length ? `<details class="cmp-commits"><summary>Commits on ${head} only (${d.onlyHead})</summary>${commits}${d.onlyHead > d.commits.length ? `<div class="muted pad small">…and ${d.onlyHead - d.commits.length} older ones.</div>` : ''}</details>` : ''}
      <div class="list-head"><span>${d.files.length ? plural(d.files.length, 'changed file') : 'No file differences'}</span></div>
      ${files || `<div class="empty muted">${exact ? 'The two branches have exactly the same files.' : `Nothing has changed on ${head} since it split from ${base}.`}</div>`}
    </div>
    <div class="pane-right" id="cmp-diff"></div>
  </div>`;
  bind();
  loadCompareDiff();
}

async function loadCompareDiff() {
  const repo = currentRepo();
  const c = state.cmp;
  const pane = $('#cmp-diff');
  if (!pane || !c?.data?.files) return;
  const f = c.data.files.find((x) => x.path === c.sel);
  if (!f) { pane.innerHTML = '<div class="empty muted">Select a file to see what changed.</div>'; return; }
  const token = {};
  c.diffToken = token;
  let d;
  try { d = await gitRaw('compareDiff', repo, c.base, c.head, f.orig ? [f.orig, f.path] : [f.path], { mode: c.mode }); }
  catch (e) { d = { kind: 'error', text: e.message }; }
  if (c.diffToken !== token || !$('#cmp-diff')) return;
  pane.innerHTML = `<div class="diff-head">
      <b>${esc(f.path)}</b>${f.orig ? ` <span class="muted">(was ${esc(f.orig)})</span>` : ''}
      <span class="tag c-${f.code}">${CODE_LABEL[f.code] || f.code}</span>
      <div class="spacer"></div>
      ${diffModeToggle()}
    </div>
    <div class="diff-scroll">${diffBody(d, f.path)}</div>`;
}

// ---------- shelf (stash) ----------
async function loadShelf() {
  const repo = currentRepo();
  state.stashes = await git('stashList', repo).catch(() => []);
  if (state.tab === 'shelf' && samePath(currentRepo(), repo)) renderShelfTab();
}

function renderShelfTab() {
  const body = $('#tab-body');
  const repo = currentRepo();
  const list = state.stashes;
  const changes = changedFiles(state.status[repo]).length;
  const intro = `<div class="explain">
    <b>What is the Shelf?</b> It's a safe place to set aside uncommitted changes without committing them, so your folder goes back to clean.
    Handy when you need to switch branches or get the latest but aren't ready to commit. Restore them whenever you like.
    <span class="muted">(Git calls this <code>stash</code>.)</span>
  </div>`;
  if (!list) { body.innerHTML = intro + '<div class="empty muted"><span class="spinner"></span></div>'; return; }
  if (state.selStash && !list.some((s) => s.ref === state.selStash)) state.selStash = null;
  if (!state.selStash && list[0]) state.selStash = list[0].ref;
  // Things you shelved on purpose come first; the safety copies made by Discard go in their own group.
  const isDiscarded = (s) => /^\[discarded\]/.test(s.message);
  const mine = list.filter((s) => !isDiscarded(s));
  const discarded = list.filter(isDiscarded);
  const old = discarded.filter((s) => Date.now() / 1000 - s.time > 14 * 86400);
  const row = (s) => `<div class="commit ${s.ref === state.selStash ? 'selected' : ''}" data-action="select-stash" data-ref="${esc(s.ref)}">
        <div class="commit-subject">${esc(s.message.replace(/^\[(auto|discarded)\] /, ''))} ${/^\[auto\]/.test(s.message) ? '<span class="tag">auto</span>' : ''}</div>
        <div class="commit-meta">from ${esc(s.branch)} · ${timeAgo(s.time)}</div>
      </div>`;
  const discardOpen = state.discardOpen || mine.length === 0;
  body.innerHTML = `${intro}
    <div class="toolbar"><button class="btn primary" data-action="shelve" data-repo="${esc(repo)}" ${changes ? '' : 'disabled'}>Put my ${changes ? plural(changes, 'change') : 'changes'} on the Shelf…</button></div>
    <div class="split">
      <div class="pane-left scroll">
        ${mine.length ? mine.map(row).join('') : discarded.length ? '' : '<div class="empty muted">The Shelf is empty.</div>'}
        ${discarded.length ? `<div class="shelf-group">
          <button class="shelf-group-head" data-action="toggle-discarded" aria-expanded="${discardOpen}">${discardOpen ? '▾' : '▸'} Discarded changes <span class="count">${discarded.length}</span></button>
          <div class="hint pad">Safety copies of changes you discarded, in case you want them back.${old.length ? ` <button class="btn small ghost" data-action="clean-discarded" data-refs="${esc(old.map((s) => s.ref).join(','))}">Delete ${plural(old.length, 'copy', 'copies')} older than 2 weeks</button>` : ''}</div>
          ${discardOpen ? discarded.map(row).join('') : ''}
        </div>` : ''}
      </div>
      <div class="pane-right" id="stash-pane"></div>
    </div>`;
  loadStashPreview();
}

async function loadStashPreview() {
  const pane = $('#stash-pane');
  const ref = state.selStash;
  if (!pane) return;
  if (!ref) { pane.innerHTML = ''; return; }
  const repo = currentRepo();
  const diff = await git('stashShow', repo, ref).catch((e) => e.message);
  if (state.selStash !== ref || !$('#stash-pane')) return;
  pane.innerHTML = `<div class="diff-head">
      <button class="btn small primary" data-action="stash-pop" data-ref="${esc(ref)}" title="git stash pop">Restore</button>
      <button class="btn small" data-action="stash-apply" data-ref="${esc(ref)}" title="git stash apply">Restore a copy (keep on Shelf)</button>
      <div class="spacer"></div>
      <button class="btn small ghost danger-text" data-action="stash-drop" data-ref="${esc(ref)}" title="git stash drop">Delete</button>
    </div>
    <div class="diff-scroll">${renderDiff(diff)}</div>`;
}

// paths: only these files (whole files); all changes when omitted.
async function shelve(repo, paths = null) {
  const name = await ask(paths ? `Put ${plural(paths.length, 'file')} on the Shelf` : 'Put changes on the Shelf', {
    label: 'Name (optional) — so you remember what this was',
    placeholder: 'e.g. half-done refactor of login',
    help: paths ? 'The changes to the ticked files are set aside and those files go back to your last commit. Your other changes stay where they are.'
      : 'All your uncommitted changes (including new files) will be set aside and your folder will match your last commit.',
    okLabel: 'Put on Shelf',
  });
  if (name === null) return;
  try { await busy(repo, 'Shelving…', () => git('stashSave', repo, name, paths)); toast('Changes are on the Shelf.', 'ok'); if (state.tab === 'shelf') loadShelf(); }
  catch (e) { showError("Couldn't shelve", e); }
}

// ---------- conflicts ----------
function conflictLabels(st) {
  return st.op ? { ours: st.op.ours, theirs: st.op.theirs } : { ours: 'Your current files', theirs: 'From the Shelf' };
}



function renderConflictsTab() {
  $('#tab-body').innerHTML = `<div class="split">
    <div class="pane-left"><div class="list-head"><b>Files with conflicts</b></div><div class="file-list" id="conflict-list"></div>
      <p class="hint pad">A <b>conflict</b> happens when both sides changed the same lines. Pick what to keep for each one. Nothing is lost until you decide.</p></div>
    <div class="pane-right" id="conflict-pane"></div>
  </div>`;
  renderConflictList();
}

function renderConflictList() {
  const repo = currentRepo();
  const list = $('#conflict-list');
  if (!list) return;
  const st = state.status[repo] || {};
  const files = st.conflicted || [];
  if (state.conflict && !files.some((f) => f.path === state.conflict.file)) state.conflict = null;
  list.innerHTML = files.length ? files.map((f) => `<div class="file ${state.conflict?.file === f.path ? 'selected' : ''}" data-action="open-conflict" data-path="${esc(f.path)}">
      <span class="code c-U">!</span><span class="fname"><b>${esc(basename(f.path))}</b> <span class="muted">${esc(f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '')}</span></span></div>`).join('')
    : '<div class="empty"><div class="big">✓</div><b>All conflicts resolved</b><p>' + (st.op ? `Click <b>Finish ${OP_NAMES[st.op.kind]}</b> in the yellow banner to complete it.` : 'You\'re done here.') + '</p></div>';
  if (!state.conflict && files.length) openConflict(files[0].path);
  else if (!files.length) $('#conflict-pane').innerHTML = '';
}

async function openConflict(file) {
  const repo = currentRepo();
  const view = state.conflictView || 'steps';
  state.conflict = { file, loading: true, choices: {}, custom: {}, view };
  renderConflictList();
  let data;
  try { data = await gitRaw('readConflict', repo, file); }
  catch (e) { showError("Couldn't read the file", e); return; }
  if (state.conflict?.file !== file) return;
  state.conflict = {
    file, data,
    parsed: data.content != null ? parseConflicts(data.content) : null,
    choices: {}, custom: {},
    view: data.exists && !data.binary ? view : 'steps',
    cmp: 'ours-theirs', full: false, versions: null,
    resultText: null, resultDirty: false,
  };
  renderConflictPane();
}

// The file as it would be saved: decided conflicts use your choice, undecided ones keep their markers.
function buildResult(c) {
  return c.parsed.segs.map((s, i) => {
    if (s.type === 'text') return s.lines;
    const picked = pickLines(s, c.choices[i], c.custom[i]);
    if (picked) return picked;
    const m = s.markers;
    return [m.start, ...s.ours, ...(m.base ? [m.base, ...s.base] : []), m.sep, ...s.theirs, m.end];
  }).flat().join('\n');
}

const fileEol = (c) => c.parsed?.eol || ((c.data.content || '').includes('\r\n') ? '\r\n' : '\n');






const XY_TEXT = {
  UU: () => 'Both sides changed this file.',
  AA: () => 'Both sides added a file with this name.',
  UD: (L) => `<b>${esc(L.ours)}</b> changed this file, but <b>${esc(L.theirs)}</b> deleted it.`,
  DU: (L) => `<b>${esc(L.ours)}</b> deleted this file, but <b>${esc(L.theirs)}</b> changed it.`,
  AU: (L) => `Added by <b>${esc(L.ours)}</b>.`,
  UA: (L) => `Added by <b>${esc(L.theirs)}</b>.`,
  DD: () => 'Both sides deleted this file.',
};

const VS_CODE_LIKE = ['code', 'cursor', 'code-insiders', 'windsurf'];

function renderConflictPane() {
  const pane = $('#conflict-pane');
  const c = state.conflict;
  if (!pane || !c || c.loading) return;
  const repo = currentRepo();
  const st = state.status[repo] || {};
  const L = conflictLabels(st);
  const entry = (st.conflicted || []).find((f) => f.path === c.file) || { xy: 'UU' };
  const textFile = c.data.exists && !c.data.binary;
  const sameView = pane.dataset.view === c.view && pane.dataset.file === c.file;
  const scroll = sameView ? pane.querySelector('.conflict-scroll, .sbs-scroll')?.scrollTop || 0 : 0;
  const head = `<div class="diff-head wrap">
      <div><b>${esc(c.file)}</b><div class="small">${(XY_TEXT[entry.xy] || XY_TEXT.UU)(L)}</div></div>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="reload-conflict" title="Re-read the file, e.g. after fixing it in your editor">↻ Reload</button>
      <button class="btn small ghost" data-action="open-file" data-path="${esc(c.file)}">Open in ${esc(editorName())}</button>
      <button class="btn small ghost" data-action="explain-conflict" title="Ask Claude what each side changed and what to keep">✦ Explain</button>
      ${textFile && VS_CODE_LIKE.includes(state.config.settings.editor) ? `<button class="btn small" data-action="merge-editor" title="${esc(editorName())}'s 3-way merge editor: both sides plus the result, side by side">Open in ${esc(editorName())} merge editor</button>` : ''}
      <button class="btn small" data-action="resolve-side" data-side="ours" title="git checkout --ours">Keep whole file: ${esc(L.ours)}</button>
      <button class="btn small" data-action="resolve-side" data-side="theirs" title="git checkout --theirs">Keep whole file: ${esc(L.theirs)}</button>
    </div>`;
  const views = textFile ? `<div class="seg-wrap"><div class="seg">${[['steps', 'Step by step'], ['compare', 'Compare side by side'], ['result', 'Edit the result']]
    .map(([id, label]) => `<button class="seg-btn ${c.view === id ? 'active' : ''}" data-action="conflict-view" data-view="${id}">${label}</button>`).join('')}</div></div>` : '';
  const body = c.view === 'compare' && textFile ? compareHtml(c, L) : c.view === 'result' && textFile ? resultHtml(c) : stepsHtml(c, L);
  pane.dataset.view = c.view;
  pane.dataset.file = c.file;
  pane.innerHTML = head + views + body;
  const sc = pane.querySelector('.conflict-scroll, .sbs-scroll');
  if (sc) sc.scrollTop = scroll;
  if (c.view === 'compare' && textFile && !c.versions) loadConflictVersions();
}

async function loadConflictVersions() {
  const c = state.conflict;
  const repo = currentRepo();
  try { c.versions = await gitRaw('conflictVersions', repo, c.file); }
  catch (e) { c.versions = { error: e.message }; }
  if (state.conflict === c) renderConflictPane();
}

function compareHtml(c, L) {
  const modes = [['ours-theirs', `${L.ours} ↔ ${L.theirs}`], ['base-ours', `What ${L.ours} changed`], ['base-theirs', `What ${L.theirs} changed`]];
  const bar = `<div class="cmp-bar">
      <div class="seg small">${modes.map(([id, label]) => `<button class="seg-btn ${c.cmp === id ? 'active' : ''}" data-action="cmp-mode" data-mode="${id}">${esc(label)}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-action="cmp-full" ${c.full ? 'checked' : ''}> Show the whole file</label>
    </div>
    <p class="hint cmp-hint">${c.cmp === 'ours-theirs' ? 'The two complete versions of the file, lined up. Highlighted lines differ.' : 'Compares the <b>original</b> (the file before either side touched it) with one side — so you see exactly what that side changed.'}</p>`;
  const v = c.versions;
  if (!v) return bar + '<div class="empty muted"><span class="spinner"></span></div>';
  if (v.error) return bar + `<pre class="raw">${esc(v.error)}</pre>`;
  const pick = { 'ours-theirs': [v.ours, v.theirs, L.ours, L.theirs], 'base-ours': [v.base, v.ours, 'Original', L.ours], 'base-theirs': [v.base, v.theirs, 'Original', L.theirs] }[c.cmp];
  const [left, right, ll, rl] = pick;
  if (left == null || right == null) return bar + `<div class="empty muted">${left == null ? esc(ll) : esc(rl)} doesn't have this file (it was added or deleted on one side), so there's nothing to line up.</div>`;
  if (typeof left !== 'string' || typeof right !== 'string') return bar + '<div class="empty muted">Binary file — it can\'t be compared line by line.</div>';
  const rows = sideBySide(toLines(left), toLines(right));
  let blocks = 0;
  rows.forEach((r, i) => { if (r.kind !== 'same' && (i === 0 || rows[i - 1].kind === 'same')) blocks++; });
  const show = rows.map((r) => c.full || r.kind !== 'same');
  if (!c.full) rows.forEach((r, i) => { if (r.kind !== 'same') for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) show[k] = true; });
  let html = '';
  let hidden = 0;
  const gap = (n) => `<div class="sr gap" data-action="cmp-show-all">⋯ ${plural(n, 'matching line')} hidden — click to show the whole file</div>`;
  rows.forEach((r, i) => {
    if (!show[i]) { hidden++; return; }
    if (hidden) { html += gap(hidden); hidden = 0; }
    let [l, rr] = [r.l == null ? '' : esc(r.l), r.r == null ? '' : esc(r.r)];
    if (r.kind === 'chg') [l, rr] = inlineDiff(r.l, r.r);
    html += `<div class="sr ${r.kind}"><span class="ln">${r.li != null ? r.li + 1 : ''}</span><span class="sc l">${l || ' '}</span><span class="ln">${r.ri != null ? r.ri + 1 : ''}</span><span class="sc r">${rr || ' '}</span></div>`;
  });
  if (hidden) html += gap(hidden);
  return `${bar}<div class="cmp-summary">${blocks ? `${plural(blocks, 'place')} where these differ` : 'These two versions are identical.'}</div>
    <div class="sbs-scroll"><div class="sbs ${c.cmp === 'ours-theirs' ? 'two-sided' : ''}">
      <div class="sbs-head"><div class="side-label ${c.cmp === 'ours-theirs' ? 'ours' : ''}">${esc(ll)}</div><div class="side-label theirs">${esc(rl)}</div></div>
      ${html}
    </div></div>`;
}

function resultHtml(c) {
  if (c.resultText == null) c.resultText = c.parsed ? buildResult(c) : (c.data.content || '').replace(/\r\n/g, '\n');
  const markers = /^(<<<<<<<|>>>>>>>)/m.test(c.resultText);
  return `<div class="result-bar"><span class="hint">This is exactly what will be saved — edit anything you like.${c.parsed?.count ? ' Your step-by-step choices are already applied; undecided conflicts still show their <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers.' : ''}</span>
      <div class="spacer"></div>${c.parsed?.count ? '<button class="btn small ghost" data-action="result-reset">Reset to my step-by-step choices</button>' : ''}</div>
    <textarea id="result-editor" class="result-editor" spellcheck="false">${esc(c.resultText)}</textarea>
    <div class="conflict-foot"><span id="result-status">${markers ? '⚠ Conflict markers are still in the file' : '✓ No conflict markers left'}</span><div class="spacer"></div>
      <button class="btn primary" data-action="save-result">Save &amp; mark resolved</button></div>`;
}

function stepsHtml(c, L) {
  const p = c.parsed;
  if (!c.data.exists || c.data.binary || !p || !p.count) {
    const why = !c.data.exists ? "The file was deleted on one side, so there's nothing to compare line by line."
      : c.data.binary ? "It's a binary file (image, dll…), so it can't be compared line by line."
      : !p ? 'The conflict markers in this file look damaged — use <b>Edit the result</b> or your editor to fix it.'
      : 'No conflict markers are left in this file — maybe you fixed it in your editor.';
    return `<div class="empty"><p>${why}</p><p>Use the <b>Keep whole file</b> buttons above, or fix it in your editor and then:</p>
      <button class="btn primary" data-action="mark-resolved">Mark as resolved</button></div>`;
  }
  let idx = 0;
  const blocks = p.segs.map((s, i) => {
    if (s.type === 'text') {
      const ctx = i === 0 ? s.lines.slice(-3) : s.lines.length > 6 ? [...s.lines.slice(0, 3), '⋯', ...s.lines.slice(-3)] : s.lines;
      return ctx.length ? `<pre class="ctx">${esc(ctx.join('\n'))}</pre>` : '';
    }
    idx++;
    const ch = c.choices[i];
    const btn = (id, label) => `<button class="btn small ${ch === id ? 'primary' : ''}" data-action="pick" data-i="${i}" data-choice="${id}">${label}</button>`;
    const result = pickLines(s, ch, c.custom[i]);
    return `<div class="conflict ${ch ? 'decided' : ''}">
      <div class="conflict-title">Conflict ${idx} of ${p.count} ${ch ? '<span class="tag ok">decided</span>' : '<span class="tag bad">needs a decision</span>'}</div>
      <div class="sides">
        <div class="side ours"><div class="side-label">${esc(L.ours)}</div><pre>${esc(s.ours.join('\n')) || '<i class="muted">(nothing — these lines were removed)</i>'}</pre></div>
        <div class="side theirs"><div class="side-label">${esc(L.theirs)}</div><pre>${esc(s.theirs.join('\n')) || '<i class="muted">(nothing — these lines were removed)</i>'}</pre></div>
      </div>
      <div class="pick-row">${btn('ours', `Use ${esc(L.ours)}`)}${btn('theirs', `Use ${esc(L.theirs)}`)}${btn('both', 'Use both (left first)')}${btn('both-rev', 'Use both (right first)')}${btn('edit', 'Edit by hand…')}</div>
      ${ch === 'edit' ? `<textarea class="custom" data-i="${i}" rows="${Math.min(20, Math.max(4, result.length + 1))}" spellcheck="false">${esc(result.join('\n'))}</textarea>`
        : ch ? `<div class="result-label">Result:</div><pre class="result">${esc(result.join('\n')) || '<i class="muted">(empty)</i>'}</pre>` : ''}
    </div>`;
  }).join('');
  const decided = p.segs.filter((s, i) => s.type === 'conflict' && c.choices[i]).length;
  return `<div class="conflict-scroll">${blocks}</div>
    <div class="conflict-foot"><span>${decided} of ${p.count} decided</span><div class="spacer"></div>
      <button class="btn primary" data-action="save-resolution" ${decided === p.count ? '' : 'disabled'}>Save &amp; mark resolved</button></div>`;
}

async function saveConflictText(text) {
  const repo = currentRepo();
  const c = state.conflict;
  const eol = fileEol(c);
  const content = eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  try {
    await git('saveResolution', repo, c.file, content);
    toast(`${basename(c.file)} resolved.`, 'ok');
    state.conflict = null;
    await refreshAll();
    renderConflictList();
  } catch (e) { showError("Couldn't save", e); }
}

const saveResolution = () => saveConflictText(buildResult(state.conflict));

// ---------- workspace-wide actions ----------
// Runs fn on each repo in parallel. planFor(repo) returns [op, ...args] describing the
// git operation for that repo, so one combined preview can be shown up front.
async function forEachRepo(label, repos, fn, planFor) {
  if (planFor && previewWanted()) {
    const items = repos.map((r) => planFor(r)).filter(Boolean).map(([op, ...args]) => ({ op, args }));
    if (items.length && !(await previewPlans(items))) return null;
  }
  previewSuppressed++;
  try {
    return await Promise.all(repos.map(async (repo) => {
      try { return { repo, ...(await busy(repo, label, () => fn(repo))) }; }
      catch (e) { return { repo, ok: false, msg: explain(e.message) || 'Failed', raw: e.message }; }
    }));
  } finally { previewSuppressed--; }
}

async function wsFetch() {
  const w = currentWs();
  const results = await forEachRepo('Checking…', w.repos, async (repo) => { await git('fetch', repo); state.lastFetch[repo] = Date.now(); return { ok: true }; }, (r) => ['fetch', r]);
  if (!results) return;
  const bad = results.filter((r) => !r.ok);
  if (bad.length) resultsModal('Some repos could not be checked', results.map((r) => (r.ok ? { ...r, msg: 'checked' } : r)));
  else {
    const behind = w.repos.filter((p) => state.status[p]?.behind);
    toast(behind.length ? `New commits available in: ${behind.map(basename).join(', ')}` : 'Everything is up to date.', behind.length ? 'info' : 'ok');
  }
}

async function wsPull() {
  const w = currentWs();
  const results = await forEachRepo('Getting latest…', w.repos, async (repo) => {
    const st = state.status[repo] || {};
    if (st.detached || !st.upstream) return { ok: true, warn: true, msg: st.detached ? 'skipped — not on a branch' : 'skipped — branch not on the server yet' };
    const r = await git('pull', repo, 'ff');
    if (r.diverged) return { ok: false, warn: true, msg: 'both you and the server have new commits — open this repo and click “Get latest” to combine them' };
    if (r.conflicts) return { ok: false, msg: 'conflicts — open this repo to resolve them' };
    return { ok: true, msg: /Already up to date/i.test(r.output) ? 'already up to date' : 'updated' };
  }, (repo) => { const st = state.status[repo] || {}; return st.detached || !st.upstream ? null : ['pull', repo, 'ff']; });
  if (results) resultsModal('Get latest — results', results);
}

async function wsPush() {
  const w = currentWs();
  const targets = w.repos.filter((p) => { const st = state.status[p] || {}; return !st.error && !st.missing && !st.detached && !st.initial && (st.ahead || !st.upstream); });
  if (!targets.length) { toast('Nothing to send — no repo has unsent commits.', 'ok'); return; }
  const results = await forEachRepo('Sending…', targets, async (repo) => {
    const r = await git('push', repo);
    if (r.rejected) return { ok: false, warn: true, msg: 'the server has newer commits — get latest first' };
    return { ok: true, msg: r.published ? 'branch published' : 'sent' };
  }, (repo) => ['push', repo]);
  if (results) resultsModal('Send — results', results);
}

// Bring the same branch (dev, main…) into every repo's current branch.
async function wsUpdateFrom() {
  const w = currentWs();
  const repos = w.repos.filter((p) => { const st = state.status[p] || {}; return !st.error && !st.missing; });
  if (!repos.length) return;
  // "dev" usually means the server's copy, so make sure those are fresh.
  const stale = repos.filter((p) => state.status[p]?.hasRemote && Date.now() - (state.lastFetch[p] || 0) > 2 * 60000);
  if (stale.length) {
    await forEachRepo('Checking…', stale, async (p) => { await gitRaw('fetch', p, { background: true }); state.lastFetch[p] = Date.now(); return { ok: true }; });
  }
  const info = await Promise.all(repos.map(async (p) => ({ repo: p, b: await gitRaw('branches', p).catch(() => null) })));
  // dev and origin/dev count as one name; each repo uses the server's copy when it has one.
  const names = new Map();
  for (const { b } of info) {
    if (!b) continue;
    for (const n of new Set([...b.local.map((x) => x.name), ...b.remote.map((x) => x.branch)])) names.set(n, (names.get(n) || 0) + 1);
  }
  const refFor = (repo, name) => {
    const b = info.find((x) => x.repo === repo)?.b;
    const remote = b?.remote.find((x) => x.branch === name && x.remote === 'origin') || b?.remote.find((x) => x.branch === name);
    if (remote) return remote.name;
    return b?.local.some((x) => x.name === name) ? name : null;
  };
  const sorted = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!sorted.length) return;
  const pick = [state.config.updateFromWs?.[w.id], 'develop', 'dev', 'main', 'master'].find((n) => n && names.has(n)) || sorted[0][0];
  const plan = new Map(); // repo -> { ref, canRebase }
  const r = await modal({
    title: 'Update every repo from a branch',
    wide: true,
    body: `<label class="field"><span>Bring in the new commits from</span><select name="name">${sorted.map(([n, c]) => `<option value="${esc(n)}" ${n === pick ? 'selected' : ''}>${esc(n)} — in ${c} of ${repos.length} repos</option>`).join('')}</select></label>
      <div class="field"><span>Into each repo's current branch</span><div class="wu-rows" id="wu-rows"></div></div>
      <div class="field"><span>How</span>
        <label class="check"><input type="radio" name="mode" value="merge" checked> <span><b>Merge</b> (recommended) — adds a merge commit. Nothing you've already made is rewritten.</span></label>
        <label class="check" id="wu-rebase"><input type="radio" name="mode" value="rebase"> <span><b>Rebase</b> — replays your commits on top, for a straight history.</span></label>
      </div>
      <p class="hint">Each repo uses the server's copy of the branch (e.g. origin/dev) when there is one. Uncommitted changes are set aside and put back. Repos that hit a conflict stop there for you to resolve or abort; the others carry on.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Update', kind: 'primary' }],
    init: (el) => {
      const sel = el.querySelector('[name=name]');
      const rows = el.querySelector('#wu-rows');
      const ok = el.querySelector('[data-close=ok]');
      const rebase = el.querySelector('[value=rebase]');
      const refresh = () => {
        const ticked = [...rows.querySelectorAll('input:checked')].map((i) => i.value);
        ok.disabled = !ticked.length;
        const blocked = ticked.filter((p) => plan.get(p) && !plan.get(p).canRebase);
        rebase.disabled = blocked.length > 0;
        if (rebase.disabled && rebase.checked) el.querySelector('[value=merge]').checked = true;
        el.querySelector('#wu-rebase').title = blocked.length ? `Not available: ${blocked.map(basename).join(', ')} already sent commits to the server, and rebasing would rewrite them.` : 'git rebase';
      };
      const show = async () => {
        const name = sel.value;
        plan.clear();
        rows.innerHTML = repos.map((p) => `<label class="check wu-row"><input type="checkbox" name="repos" data-multi="1" value="${esc(p)}" disabled>
          <b>${esc(basename(p))}</b> <span class="muted small">on ${esc(state.status[p]?.branch || '?')}</span><span class="wu-info" data-repo="${esc(p)}"><span class="spinner sm"></span></span></label>`).join('');
        refresh();
        await Promise.all(repos.map(async (p) => {
          const st = state.status[p] || {};
          const ref = refFor(p, name);
          let text;
          let tick = false;
          if (st.op) text = `a ${st.op.kind} is in progress — finish it first`;
          else if (!st.branch) text = 'not on a branch';
          else if (st.branch === name) text = `is on ${name} itself — use Get latest`;
          else if (!ref) text = `doesn't have ${name}`;
          else {
            const c = await gitRaw('compareCounts', p, ref).catch(() => null);
            if (c) plan.set(p, { ref, canRebase: c.canRebase });
            text = !c ? "couldn't compare" : c.behind ? `${plural(c.behind, 'commit')} coming from ${ref}` : 'already has everything';
            tick = !!c?.behind;
          }
          if (sel.value !== name || !el.isConnected) return;
          const box = rows.querySelector(`input[value="${CSS.escape(p)}"]`);
          box.disabled = !tick;
          box.checked = tick;
          rows.querySelector(`.wu-info[data-repo="${CSS.escape(p)}"]`).textContent = text;
        }));
        if (sel.value === name) refresh();
      };
      sel.addEventListener('change', show);
      rows.addEventListener('change', refresh);
      show();
    },
  });
  const picked = (r.values.repos || []).filter((p) => plan.has(p));
  if (r.id !== 'ok' || !picked.length) return;
  const name = r.values.name;
  const mode = r.values.mode;
  state.config.updateFromWs = { ...state.config.updateFromWs, [w.id]: name };
  saveConfig();
  const before = Object.fromEntries(await Promise.all(picked.map(async (p) => [p, await gitRaw('headOid', p).catch(() => null)])));
  const results = await forEachRepo(`Updating from ${name}…`, picked, async (repo) => {
    const res = await git('updateFrom', repo, plan.get(repo).ref, mode);
    if (res.conflicts) return { ok: false, msg: 'stopped at a conflict — open this repo to resolve it, or abort' };
    return { ok: true, msg: /up to date/i.test(res.output || '') ? 'already up to date' : `updated from ${plan.get(repo).ref}` };
  }, (repo) => ['updateFrom', repo, plan.get(repo).ref, mode]);
  if (!results) return;
  // One undo puts every repo that moved back where it was.
  const moved = [];
  for (const res of results.filter((x) => x.ok)) {
    const after = await gitRaw('headOid', res.repo).catch(() => null);
    if (after && before[res.repo] && after !== before[res.repo]) moved.push({ repo: res.repo, before: before[res.repo], after, branch: state.status[res.repo]?.branch });
  }
  if (moved.length) {
    recordUndo({
      label: `update of ${plural(moved.length, 'repo')} from ${name}`,
      repos: moved.map((m) => m.repo),
      check: async () => {
        for (const m of moved) { const why = await moveUndoBlocked(m.repo, m.branch, m.after); if (why) return why; }
        return null;
      },
      run: async () => {
        const res = await forEachRepo('Undoing…', moved.map((m) => m.repo), async (repo) => {
          const m = moved.find((x) => x.repo === repo);
          await undoMove(repo, m.before, m.after, false);
          return { ok: true };
        });
        const bad = (res || []).filter((x) => !x.ok);
        if (bad.length) throw new Error(bad.map((x) => `${basename(x.repo)}: ${x.raw || x.msg}`).join('\n'));
      },
    });
  }
  resultsModal(`Update from ${name} — results`, results, moved.length ? 'Changed your mind? <b>↶ Undo…</b> at the top puts every updated repo back.' : '');
}

async function wsNewBranch() {
  const w = currentWs();
  const r = await modal({
    title: 'New branch in several repos',
    body: `<label class="field"><span>Branch name</span><input name="name" placeholder="e.g. feature/new-checkout" spellcheck="false"></label>
      <div class="field"><span>Create it in</span>${w.repos.map((p) => `<label class="check"><input type="checkbox" name="repos" data-multi="1" value="${esc(p)}" checked> ${esc(basename(p))} <span class="muted small">(from ${esc(state.status[p]?.branch || '?')})</span></label>`).join('')}</div>
      <p class="hint">Each repo gets the branch starting from whatever branch it's on now, and switches to it. Uncommitted changes come along.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Create', kind: 'primary' }],
    init: (el) => { const i = el.querySelector('[name=name]'); i.addEventListener('input', () => { i.value = branchTransform(i.value); }); },
  });
  if (r.id !== 'ok' || !r.values.name) return;
  const name = r.values.name;
  if (!(await git('checkBranchName', name))) { showError('Invalid branch name', new Error(`fatal: '${name}' is not a valid branch name`)); return; }
  const results = await forEachRepo('Creating branch…', r.values.repos || [], async (repo) => { await git('createBranch', repo, name, null); return { ok: true, msg: `created ${name}` }; }, (repo) => ['createBranch', repo, name, null]);
  if (results) resultsModal('New branch — results', results);
}

// Delete branches that are merged into the main branch or were deleted on the server.
async function tidyBranches(repos) {
  const found = await Promise.all(repos.map(async (repo) => ({ repo, ...(await gitRaw('tidyCandidates', repo).catch(() => ({ branches: [] }))) })));
  const total = found.reduce((n, f) => n + f.branches.length, 0);
  if (!total) { toast('Nothing to tidy — no merged or deleted-on-server branches.', 'ok'); return; }
  const r = await modal({
    title: 'Tidy up branches',
    wide: repos.length > 1,
    body: `<p>These branches look finished: they're <b>merged</b> into the main branch, or were <b>deleted on the server</b> (usually after a pull request was merged). Untick any you want to keep.</p>
      ${found.filter((f) => f.branches.length).map((f) => `<div class="tidy-repo">${repos.length > 1 ? `<h3>${esc(basename(f.repo))}</h3>` : ''}
        ${f.branches.map((b) => `<label class="check tidy-row"><input type="checkbox" name="pick" data-multi="1" value="${esc(`${f.repo}|${b.name}`)}" checked>
          <b>${esc(b.name)}</b> <span class="tag ${b.merged ? 'ok' : 'bad'}">${b.merged ? `merged into ${esc(f.defaultBranch)}` : 'deleted on server, not merged here'}</span>
          <span class="muted small">${esc(b.subject)} · ${timeAgo(b.date)}</span></label>`).join('')}</div>`).join('')}
      <p class="hint">Only the copies on your computer are deleted, and each one can be brought back with Undo right after.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete ticked branches', kind: 'danger' }],
  });
  if (r.id !== 'ok' || !r.values.pick?.length) return;
  const deleted = [];
  const failed = [];
  for (const v of r.values.pick) {
    const [repo, name] = v.split('|');
    const info = found.find((f) => f.repo === repo).branches.find((b) => b.name === name);
    try { const res = await git('deleteBranch', repo, name, { force: !info.merged }); deleted.push({ repo, name, oid: res.oid }); }
    catch (e) { if (e.code === CANCELLED) break; failed.push(`${basename(repo)}/${name}: ${e.message}`); }
  }
  await refreshAll();
  if (state.tab === 'branches') loadBranches();
  if (failed.length) showError(`Couldn't delete ${plural(failed.length, 'branch', 'branches')}`, new Error(failed.join('\n')));
  if (deleted.length) {
    const entry = recordUndo({
      label: `tidy-up of ${plural(deleted.length, 'branch', 'branches')}`,
      repos: [...new Set(deleted.map((d) => d.repo))],
      run: async () => {
        for (const d of deleted) await git('restoreBranch', d.repo, d.name, d.oid).catch(() => {});
        await refreshAll();
      },
    });
    toast(`Deleted ${plural(deleted.length, 'branch', 'branches')}.`, 'ok', { label: 'Undo', fn: () => runUndo(entry.id) });
  }
}

async function wsSwitch(preset) {
  const w = currentWs();
  const info = await Promise.all(w.repos.map(async (p) => ({ repo: p, b: await git('branches', p).catch(() => null) })));
  const names = new Map();
  for (const { repo, b } of info) {
    if (!b) continue;
    const here = new Set([...b.local.map((x) => x.name), ...b.remote.map((x) => x.branch)]);
    for (const n of here) names.set(n, (names.get(n) || 0) + 1);
  }
  const sorted = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const r = await modal({
    title: preset ? 'Put every repo on the same branch' : 'Switch all repos to a branch',
    body: `<label class="field"><span>Branch</span><select name="name">${sorted.map(([n, c]) => `<option value="${esc(n)}" ${n === preset ? 'selected' : ''}>${esc(n)} — in ${c} of ${w.repos.length} repos</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="create"> Create the branch in repos that don't have it</label>
      <p class="hint">Uncommitted changes come along. If a repo can't switch safely it's left alone and you'll be told.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Switch', kind: 'primary' }],
  });
  if (r.id !== 'ok' || !r.values.name) return;
  const name = r.values.name;
  // Work out what each repo needs, so the preview and the real run agree.
  const decide = (repo) => {
    const b = info.find((x) => x.repo === repo)?.b;
    const st = state.status[repo] || {};
    if (st.branch === name) return { result: { ok: true, msg: 'already on it' } };
    if (b?.local.some((x) => x.name === name)) return { call: ['switchBranch', repo, name], msg: 'switched' };
    const remote = b?.remote.find((x) => x.branch === name);
    if (remote) return { call: ['checkoutRemote', repo, remote.name, name], msg: 'downloaded from server and switched' };
    if (r.values.create) return { call: ['createBranch', repo, name, null], msg: `created from ${st.branch}` };
    return { result: { ok: false, warn: true, msg: "doesn't have this branch — left as is" } };
  };
  const results = await forEachRepo(`Switching to ${name}…`, w.repos, async (repo) => {
    const d = decide(repo);
    if (d.result) return d.result;
    await git(...d.call);
    return { ok: true, msg: d.msg };
  }, (repo) => decide(repo).call);
  if (results) resultsModal(`Switch to ${name} — results`, results);
}

// ---------- add / clone / workspaces ----------
async function newWorkspace() {
  const name = await ask('New workspace', { label: 'Name', placeholder: 'e.g. Acme project', help: 'A workspace groups repos you work on together, so you can see them side by side and act on all of them at once.', okLabel: 'Create' });
  if (!name) return;
  const w = { id: uid(), name, repos: [] };
  state.config.workspaces.push(w);
  await saveConfig();
  openWorkspace(w.id);
  addRepo(w.id);
}

function ensureWorkspace(wsId) {
  let w = state.config.workspaces.find((x) => x.id === wsId);
  if (!w) w = state.config.workspaces[0];
  if (!w) { w = { id: uid(), name: 'My repos', repos: [] }; state.config.workspaces.push(w); }
  return w;
}

async function addRepoPath(wsId, folder) {
  let info = await git('resolveRepo', folder);
  if (!info.isRepo) {
    const c = await choose("This folder isn't a git repo", `<p><code>${esc(folder)}</code> isn't tracked by git yet.</p>`, [
      { id: 'init', label: 'Start tracking it with git', desc: 'Runs <code>git init</code>, which creates an empty history for this folder. Your files are not changed.' },
    ]);
    if (c !== 'init') return null;
    try { await git('init', folder); } catch (e) { showError("Couldn't set up git", e); return null; }
    info = { path: folder };
  } else if (!samePath(info.path, folder)) toast(`Using the repo's top folder: ${info.path}`, 'info');
  const w = ensureWorkspace(wsId);
  if (!w.repos.some((p) => samePath(p, info.path))) w.repos.push(info.path);
  await saveConfig();
  await refreshRepo(info.path);
  return { w, path: info.path };
}

// Adds folder(s) to a workspace (creating "My repos" if there is none) and opens the last one in a tab.
async function addRepos(wsId, folders) {
  let last = null;
  for (const folder of folders) last = (await addRepoPath(wsId, folder)) || last;
  if (!last) return;
  renderSidebar();
  openRepo(last.path, last.w.id);
}

async function addRepo(wsId) {
  const folder = await api.pickFolder('Choose the folder of a repo you already have');
  if (folder) await addRepos(wsId, [folder]);
}

// Drop folders onto the window to open them as repos.
let dropOverlay = null;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.textContent = 'Drop a repo folder to open it';
    document.body.appendChild(dropOverlay);
  }
});
document.addEventListener('dragleave', (e) => { if (dropOverlay && !e.relatedTarget) { dropOverlay.remove(); dropOverlay = null; } });
document.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dropOverlay?.remove();
  dropOverlay = null;
  const folders = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (folders.length) addRepos(state.view.ws, folders);
});

async function cloneRepo() {
  const ws = state.config.workspaces;
  let parent = '';
  const r = await modal({
    title: 'Clone a repo',
    body: `<label class="field"><span>Repo URL</span><input name="url" placeholder="https://github.com/owner/project.git" spellcheck="false"></label>
      <div class="field"><span>Put it inside this folder</span><div class="row-inline"><input name="parent" readonly placeholder="Choose a folder…"><button class="btn" id="pick-parent" type="button">Browse…</button></div></div>
      ${ws.length ? `<label class="field"><span>Add to workspace</span><select name="ws">${ws.map((w) => `<option value="${w.id}" ${state.view.ws === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}
      <p class="hint"><b>Cloning</b> downloads a full copy of a repo (and all its history) from a server to your computer.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Clone', kind: 'primary' }],
    init: (el) => {
      el.querySelector('#pick-parent').addEventListener('click', async () => {
        const f = await api.pickFolder('Clone into which folder?');
        if (f) { parent = f; el.querySelector('[name=parent]').value = f; }
      });
    },
  });
  if (r.id !== 'ok' || !r.values.url) return;
  parent = r.values.parent || parent;
  if (!parent) { toast('Pick a folder to clone into.', 'warn'); return; }
  const box = document.createElement('div');
  box.className = 'toast info progress-toast';
  box.setAttribute('role', 'status');
  box.innerHTML = `<span class="spinner"></span><div><b>Cloning…</b><div class="small muted" id="clone-progress">Connecting to the server</div></div><button class="btn small" data-action="cancel-clone">Cancel</button>`;
  $('#toast-root').appendChild(box);
  try {
    const dest = await git('clone', r.values.url, parent);
    box.remove();
    const added = await addRepoPath(r.values.ws, dest);
    toast(`Cloned into ${dest}.`, 'ok');
    renderSidebar();
    if (added) openRepo(added.path, added.w.id);
  } catch (e) {
    box.remove();
    if (e.code === 'CANCELLED') toast('Clone cancelled.', 'info');
    else showError("Couldn't clone", e);
  }
}

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
      <h3>Seeing what happens</h3>
      <label class="check"><input type="checkbox" name="preview" ${s.previewCommands ? 'checked' : ''}> Show me the git commands before running any action</label>
      <p class="hint">You can always hold <b>Shift</b> while clicking a button to preview just that one action.</p>
      <h3>Cherry-pick</h3>
      <label class="check"><input type="checkbox" name="cpx" ${s.cherryPickX ? 'checked' : ''}> Add “(cherry picked from commit …)” to cherry-picked commit messages</label>
      <h3>Claude</h3>
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
  s.claudePath = v.claudePath.trim();
  s.claudeModel = v.claudeModel.trim();
  s.previewCommands = v.preview;
  s.cherryPickX = v.cpx;
  await saveConfig();
  if (v.name.trim() && v.email.trim() && (v.name.trim() !== id.name || v.email.trim() !== id.email)) {
    try { await git('setIdentity', v.name.trim(), v.email.trim()); } catch (e) { showError("Couldn't save your name/email", e); }
  }
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
    for (const t of ['changes', 'branches', 'history', 'compare', 'shelf']) cmds.push({ label: `Go to ${t[0].toUpperCase() + t.slice(1)}`, hint: here, run: () => setTab(t) });
    for (const b of state.branches?.local || []) if (!b.current) cmds.push({ label: `Switch to ${b.name}`, hint: `${here} · branch`, run: () => switchBranch(repo, b.name) });
  }
  if (state.view.type === 'workspace') {
    for (const [label, action] of [['Get latest for all', 'ws-pull'], ['Send all', 'ws-push'], ['New branch in all…', 'ws-new-branch'], ['Switch all to branch…', 'ws-switch'], ['Update all from a branch…', 'ws-update-from'], ['Tidy up branches in all…', 'ws-tidy']]) {
      cmds.push({ label, hint: currentWs()?.name, run: () => actions[action]({ dataset: {} }) });
    }
  }
  for (const u of state.undos) cmds.push({ label: `Undo ${u.label}`, hint: `${u.repos.map(basename).join(', ')} · ${timeAgo(u.time / 1000)}`, run: () => runUndo(u.id) });
  cmds.push(
    { label: 'Open repo folder…', hint: 'add', run: () => addRepo(state.view.ws) },
    { label: 'Clone a repo…', hint: 'add', run: () => cloneRepo() },
    { label: 'New workspace…', hint: 'add', run: () => newWorkspace() },
    { label: 'Ask Claude', hint: 'Ctrl+J', run: () => toggleClaude(true) },
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

// ---------- Claude panel (runs the Claude Code CLI) ----------
// Each workspace keeps its own chats (saved between launches); `cl` is the chat on screen.
// chat.items: { kind: 'user' | 'text' | 'tool' | 'notice' | 'done', ... }
const chatStore = { data: {}, timer: 0 };
const newChat = () => ({ id: uid(), created: Date.now(), title: '', items: [], session: null, sessionId: null, running: false, model: null, rules: [] });
let cl = newChat();

const scopeKey = () => {
  const v = state.view;
  if (v.ws) return `ws:${v.ws}`;
  return v.type === 'repo' ? `repo:${norm(v.path)}` : null;
};
const chatsFor = (key) => (chatStore.data[key] ||= { current: null, list: [] });

function selectChatForView() {
  const key = scopeKey();
  if (!key) return;
  const box = chatsFor(key);
  let chat = box.list.find((c) => c.id === box.current);
  if (!chat) { chat = newChat(); box.list.unshift(chat); box.current = chat.id; }
  cl = chat;
}

function findChat(id) {
  for (const box of Object.values(chatStore.data)) { const c = box.list.find((x) => x.id === id); if (c) return c; }
  return null;
}

function saveChats() {
  clearTimeout(chatStore.timer);
  chatStore.timer = setTimeout(() => {
    const slim = {};
    for (const [k, box] of Object.entries(chatStore.data)) {
      slim[k] = {
        current: box.current,
        list: box.list.filter((c) => c.items.length).slice(0, 20).map((c) => ({
          ...c, running: false, items: c.items.slice(-200).map((it) => (it.preview ? { ...it, preview: it.preview.slice(0, 600) } : it)),
        })),
      };
    }
    api.saveChats(slim);
  }, 800);
}

async function loadChats() {
  const data = await api.loadChats().catch(() => ({}));
  for (const box of Object.values(data)) {
    for (const c of box.list) {
      c.running = false;
      c.rules ||= [];
      // The claude process behind any pending approval is gone after a restart.
      for (const it of c.items) if (it.perm && !it.perm.decided) it.perm.decided = 'cancelled';
    }
  }
  chatStore.data = data;
}

// Opens the panel and sends a prepared question (used by the ✦ buttons around the app).
function askClaude(text) {
  toggleClaude(true);
  selectChatForView();
  if (cl.running) { $('#cp-input').value = text; toast('Claude is still busy — your question is ready in the box.', 'info'); return; }
  claudeSend(text);
}

// "Always allow" rules for this chat: a git subcommand (e.g. "git switch") or all file edits.
const normGit = (cmd) => (cmd || '').trim().replace(/^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+/, 'git ');
function ruleFor(it) {
  if (it.name === 'Bash' || it.name === 'PowerShell') {
    const cmd = normGit(it.input?.command);
    if (RISKY.test(cmd) || /[;&|<>`]|\$\(/.test(cmd)) return null;
    const m = cmd.match(/^git\s+([a-z-]+)/);
    return m ? { tool: 'shell', prefix: `git ${m[1]}`, label: `all “git ${m[1]}” commands` } : null;
  }
  if (['Edit', 'MultiEdit', 'Write'].includes(it.name)) return { tool: 'edit', prefix: '', label: 'all file edits' };
  return null;
}
function matchesRule(chat, it) {
  const r = ruleFor(it);
  return !!r && chat.rules.some((x) => x.tool === r.tool && x.prefix === r.prefix);
}

const uniqPaths = (list) => list.filter((p, i) => list.findIndex((q) => samePath(p, q)) === i);

// The repo being viewed plus the other repos of its workspace.
function claudeScope() {
  const v = state.view;
  const ws = state.config.workspaces.find((w) => w.id === v.ws);
  if (v.type === 'repo') return { cwd: v.path, repos: uniqPaths([v.path, ...(ws?.repos || [])]), label: ws?.name || basename(v.path) };
  if (v.type === 'workspace' && ws?.repos.length) return { cwd: ws.repos[0], repos: ws.repos, label: ws.name };
  return null;
}

// Prepended to every message so Claude knows what the user is looking at right now.
function claudeContext() {
  const v = state.view;
  const describe = (p) => {
    const st = state.status[p] || {};
    if (st.error || st.missing) return `${basename(p)} (${p}): unavailable`;
    const bits = [`branch ${st.detached ? '(detached HEAD)' : st.branch}`, `${changedFiles(st).length} uncommitted changes`];
    if (st.upstream) bits.push(`${st.ahead} ahead / ${st.behind} behind ${st.upstream}`); else if (!st.detached) bits.push('not on the server yet');
    if (st.op) bits.push(`${st.op.kind} in progress`);
    if (st.conflicted?.length) bits.push(`conflicts in: ${st.conflicted.map((f) => f.path).join(', ')}`);
    return `${basename(p)} (${p}): ${bits.join(', ')}`;
  };
  const lines = [];
  if (v.type === 'repo') {
    lines.push(`The user is looking at the repo ${describe(v.path)}${state.tab ? ` — ${state.tab} tab` : ''}.`);
    if (state.tab === 'history' && state.histRef) lines.push(`History is showing commits on ${state.histRef}.`);
  } else if (v.type === 'workspace') lines.push(`The user is looking at the overview of the workspace "${currentWs()?.name}".`);
  for (const p of cl.session?.repos || []) if (!(v.type === 'repo' && samePath(p, v.path))) lines.push(`Also in this chat: ${describe(p)}`);
  return `<repodeck-context>\n${lines.join('\n')}\n</repodeck-context>\n\n`;
}

function toggleClaude(open = $('#claude-panel').hidden) {
  $('#claude-panel').hidden = !open;
  if (state.config.settings.claudeOpen !== open) { state.config.settings.claudeOpen = open; saveConfig(); }
  if (open) { renderClaude(); $('#cp-input').focus(); }
}

const relPath = (p) => {
  const base = cl.session?.cwd;
  if (!p || !base) return p || '';
  return p.toLowerCase().startsWith(base.toLowerCase() + '\\') ? p.slice(base.length + 1) : p;
};

// Long repo paths in commands are shown as just the repo name.
function shortCmd(cmd) {
  let out = cmd || '';
  for (const p of cl.session?.repos || []) {
    for (const v of [p, p.replace(/\\/g, '/')]) {
      out = out.split(`"${v}"`).join(basename(p)).split(`'${v}'`).join(basename(p)).split(v).join(basename(p));
    }
  }
  return out;
}

function toolLabel(t) {
  const i = t.input || {};
  switch (t.name) {
    case 'Bash': case 'PowerShell': return `Run <code title="${esc(i.command || '')}">${esc(shortCmd(i.command))}</code>`;
    case 'Read': return `Read ${esc(relPath(i.file_path))}`;
    case 'Edit': case 'MultiEdit': return `Edit ${esc(relPath(i.file_path))}`;
    case 'Write': return `Write ${esc(relPath(i.file_path))}`;
    case 'Glob': return `Find files <code>${esc(i.pattern || '')}</code>`;
    case 'Grep': return `Search for <code>${esc(i.pattern || '')}</code>`;
    case 'Task': case 'Agent': return `Sub-task: ${esc(i.description || '')}`;
    case 'TodoWrite': return 'Update its to-do list';
    default: return esc(t.name);
  }
}

const RISKY = /\b(push\b.*(--force|-f\b|--force-with-lease)|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s|restore\s|rm\s+-r|Remove-Item|stash\s+(drop|clear)|filter-branch|rebase)\b/i;

function permissionDetail(t) {
  const i = t.input || {};
  if (t.name === 'Bash' || t.name === 'PowerShell') {
    const short = shortCmd(i.command);
    return `<pre class="cp-cmd">${esc(short)}</pre>${short !== i.command ? `<details class="cp-out"><summary>full command</summary><pre>${esc(i.command)}</pre></details>` : ''}${i.description ? `<div class="cp-desc">${esc(i.description)}</div>` : ''}
      ${RISKY.test(i.command || '') ? '<div class="cp-risk">⚠ This command can throw away work or rewrite history. Make sure that is what you want.</div>' : ''}`;
  }
  const diffLines = (oldS, newS) => [...(oldS || '').split('\n').map((l) => `<div class="dl del"><span class="code">-${esc(l)}</span></div>`), ...(newS || '').split('\n').map((l) => `<div class="dl add"><span class="code">+${esc(l)}</span></div>`)].slice(0, 80).join('');
  if (t.name === 'Edit') return `<div class="cp-file">${esc(relPath(i.file_path))}</div><div class="diff cp-diff">${diffLines(i.old_string, i.new_string)}</div>`;
  if (t.name === 'MultiEdit') return `<div class="cp-file">${esc(relPath(i.file_path))}</div><div class="diff cp-diff">${(i.edits || []).map((e) => diffLines(e.old_string, e.new_string)).join('<div class="dl hunk"><span class="code">⋯</span></div>')}</div>`;
  if (t.name === 'Write') {
    const lines = (i.content || '').split('\n');
    return `<div class="cp-file">${esc(relPath(i.file_path))} <span class="muted">(${plural(lines.length, 'line')})</span></div><pre class="cp-cmd">${esc(lines.slice(0, 30).join('\n'))}${lines.length > 30 ? '\n…' : ''}</pre>`;
  }
  return `<pre class="cp-cmd">${esc(JSON.stringify(i, null, 2))}</pre>`;
}


let claudeFrame = 0;
const renderClaudeSoon = () => { if (!claudeFrame) claudeFrame = requestAnimationFrame(() => { claudeFrame = 0; renderClaude(); }); };

function renderClaude() {
  if ($('#claude-panel').hidden) return;
  selectChatForView();
  const scope = claudeScope();
  $('#cp-scope').textContent = cl.session ? `Working in: ${cl.session.label}` : scope ? `Will work in: ${scope.label}` : 'Open a repo to start';
  $('#cp-scope').title = (cl.session || scope)?.repos.join('\n') || '';
  // Something running in another workspace's chat keeps going; say so.
  const elsewhere = Object.values(chatStore.data).flatMap((b) => b.list).find((c) => c.running && c !== cl);
  $('#cp-banner').innerHTML = elsewhere ? `<div class="cp-banner">Claude is still working on a chat in <b>${esc(elsewhere.session?.label || 'another workspace')}</b>. Sending here will stop it.</div>` : '';
  const send = $('#cp-send');
  send.textContent = cl.running ? 'Stop' : 'Send';
  send.dataset.action = cl.running ? 'claude-stop' : 'claude-send';
  send.classList.toggle('danger', cl.running);
  send.classList.toggle('primary', !cl.running);
  const waiting = cl.items.some((i) => i.kind === 'tool' && i.perm && !i.perm.decided);
  $('#cp-status').innerHTML = waiting ? '<b>Waiting for your approval ↑</b>' : cl.running ? '<span class="spinner sm"></span> Claude is working…' : cl.model ? esc(cl.model) : '';

  const box = $('#cp-msgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (!cl.items.length) {
    const ideas = ['What state are my branches in?', 'Which commits on main are not in my branch yet?', 'Explain what changed in the last 5 commits', 'Make a branch called feature/new-login in every repo', 'Copy the latest fix from main into my branch', 'Why can\'t I push?'];
    box.innerHTML = `<div class="cp-empty"><p>Ask Claude to look at or change things in your repos. It runs the <b>Claude Code</b> app you already have, signed in as you.</p>
      <p class="hint">It can read freely, but every command that changes something waits for you to click <b>Allow</b>.</p>
      <div class="cp-ideas">${ideas.map((t) => `<button class="cp-idea" data-action="claude-idea">${esc(t)}</button>`).join('')}</div></div>`;
    return;
  }
  box.innerHTML = cl.items.map((it, idx) => {
    if (it.kind === 'user') return `<div class="cp-user">${esc(it.text)}</div>`;
    if (it.kind === 'text') return it.text.trim() ? `<div class="cp-text">${md(it.text)}</div>` : '';
    if (it.kind === 'notice') return `<div class="cp-notice ${it.level || ''}">${it.html || esc(it.text)}</div>`;
    if (it.kind === 'done') return `<div class="cp-done">✓ Done${it.durationMs ? ` · ${Math.round(it.durationMs / 1000)}s` : ''}</div>`;
    const done = !cl.running && it.status === 'running' && !it.perm;
    const icon = it.status === 'error' ? '✕' : it.status === 'ok' || done ? '✓' : it.perm && !it.perm.decided ? '?' : '<span class="spinner sm"></span>';
    const pending = it.perm && !it.perm.decided;
    const rule = pending ? ruleFor(it) : null;
    const ok = ['allowed', 'auto-allowed'].includes(it.perm?.decided);
    return `<div class="cp-tool ${it.status || ''} ${pending ? 'pending' : ''} ${it.sub ? 'sub' : ''}">
      <div class="cp-tool-head"><span class="cp-ti" aria-hidden="true">${icon}</span><span class="cp-tl">${toolLabel(it)}</span>
        ${it.perm?.decided ? `<span class="tag ${ok ? 'ok' : 'bad'}">${it.perm.decided}</span>` : ''}</div>
      ${pending ? `<div class="cp-perm" role="group" aria-label="Approval needed"><div class="cp-perm-q">Claude wants to ${it.name === 'Bash' || it.name === 'PowerShell' ? 'run this command' : it.name === 'Write' ? 'write this file' : it.name.includes('Edit') ? 'make this edit' : `use ${esc(it.name)}`}:</div>
        ${permissionDetail(it)}
        <div class="cp-perm-actions">
          ${rule ? `<button class="btn small ghost" data-action="claude-allow-similar" data-idx="${idx}" title="Don't ask again in this chat for ${esc(rule.label)}">Always allow ${esc(rule.label)}</button>` : ''}
          <div class="spacer"></div>
          <button class="btn small" data-action="claude-deny" data-idx="${idx}">Deny</button><button class="btn small primary" data-action="claude-allow" data-idx="${idx}">Allow</button></div></div>` : ''}
      ${it.preview && !pending ? `<details class="cp-out"><summary>output</summary><pre>${esc(it.preview)}</pre></details>` : ''}
    </div>`;
  }).join('');
  if (atBottom || cl.items.at(-1)?.kind === 'user') box.scrollTop = box.scrollHeight;
}

let claudeRefreshTimer = 0;
const refreshSoon = () => { clearTimeout(claudeRefreshTimer); claudeRefreshTimer = setTimeout(() => refreshAll(), 400); };

function onClaudeEvent(ev) {
  // Events carry the chat they belong to, which may not be the one on screen.
  const chat = findChat(ev.key);
  if (!chat) return;
  const findTool = (id) => chat.items.find((i) => i.kind === 'tool' && i.id === id);
  switch (ev.type) {
    case 'init': chat.model = ev.model; chat.sessionId = ev.sessionId; break;
    case 'text_start': chat.items.push({ kind: 'text', text: '' }); break;
    case 'text': {
      let last = chat.items.at(-1);
      if (!last || last.kind !== 'text') chat.items.push((last = { kind: 'text', text: '' }));
      last.text += ev.delta;
      break;
    }
    case 'tool': if (!findTool(ev.id)) chat.items.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, sub: ev.sub, status: 'running' }); break;
    case 'tool_result': {
      const t = findTool(ev.id);
      if (t) { t.status = ev.isError ? 'error' : 'ok'; t.preview = ev.preview; }
      refreshSoon();
      break;
    }
    case 'permission': {
      let t = findTool(ev.toolUseId);
      if (!t) chat.items.push((t = { kind: 'tool', id: ev.toolUseId, name: ev.tool, status: 'running' }));
      t.input = ev.input;
      t.perm = { requestId: ev.requestId, decided: null };
      if (matchesRule(chat, t) && !RISKY.test(t.input?.command || '')) {
        t.perm.decided = 'auto-allowed';
        api.claude.permission(ev.requestId, true, t.input);
      } else if ($('#claude-panel').hidden) toggleClaude(true);
      break;
    }
    case 'result':
      chat.running = false;
      if (ev.isError && ev.subtype !== 'error_during_execution') chat.items.push({ kind: 'notice', level: 'bad', text: ev.text || `Claude stopped (${ev.subtype}).` });
      else chat.items.push({ kind: 'done', durationMs: ev.durationMs });
      // Approvals still open belonged to the finished turn.
      for (const i of chat.items) if (i.perm && !i.perm.decided) i.perm.decided = 'cancelled';
      refreshSoon();
      saveChats();
      break;
    case 'notice': chat.items.push({ kind: 'notice', text: ev.text }); break;
    case 'exit':
      if (chat.running && ev.code) chat.items.push({ kind: 'notice', level: 'bad', text: `Claude stopped unexpectedly${ev.message ? `: ${ev.message}` : '.'}` });
      chat.running = false;
      saveChats();
      break;
    default: break;
  }
  if (chat === cl) renderClaudeSoon();
}

async function claudeSend(text) {
  const ta = $('#cp-input');
  text = (text ?? ta.value).trim();
  if (!text || cl.running) return;
  const scope = claudeScope();
  if (!cl.session) {
    if (!scope) { toast('Open a repo or workspace first, so Claude knows where to work.', 'warn'); return; }
    cl.session = scope;
  }
  // Only one claude runs at a time: starting here stops any other chat's turn.
  for (const c of Object.values(chatStore.data).flatMap((b) => b.list)) if (c !== cl) c.running = false;
  const context = claudeContext();
  if (!cl.title) cl.title = text.slice(0, 80);
  cl.items.push({ kind: 'user', text });
  ta.value = '';
  cl.running = true;
  renderClaude();
  saveChats();
  const r = await api.claude.send(context + text, { key: cl.id, cwd: cl.session.cwd, repos: cl.session.repos, resumeId: cl.sessionId });
  if (!r.ok) {
    cl.running = false;
    cl.items.push({ kind: 'notice', level: 'bad', html: r.error === 'NOT_FOUND'
      ? 'Couldn\'t find the <b>Claude Code</b> app (claude.exe). Install it from <code>claude.com/claude-code</code>, or set its path in <b>Settings → Claude</b>.'
      : esc(r.error) });
    renderClaude();
  }
}

function claudeNewChat() {
  const key = scopeKey();
  if (!key) return;
  if (cl.running) api.claude.interrupt();
  const box = chatsFor(key);
  const chat = newChat();
  box.list.unshift(chat);
  box.current = chat.id;
  cl = chat;
  renderClaude();
  saveChats();
  $('#cp-input').focus();
}

// Earlier chats in this workspace.
function claudeHistory(anchor) {
  const key = scopeKey();
  if (!key) return;
  const list = chatsFor(key).list.filter((c) => c.items.length);
  popover(anchor, list.length
    ? `<div role="menu">${list.map((c) => `<button class="menu-item ${c === cl ? 'current' : ''}" data-action="claude-open-chat" data-id="${c.id}"><span>${esc(c.title || 'Untitled chat')}</span><span class="muted small">${timeAgo(c.created / 1000)}</span></button>`).join('')}</div>`
    : '<div class="muted pad small">No earlier chats in this workspace yet.</div>', { width: 340 });
}

// ---------- rendering entry ----------
function rerender() {
  renderSidebar();
  const v = state.view;
  if (v.type === 'workspace' && currentWs()) openWorkspace(v.ws);
  else if (v.type === 'repo') openRepo(v.path, v.ws, state.tab);
  else renderHome();
}

// ---------- event handling ----------
const actions = {
  'new-ws': () => newWorkspace(),
  clone: () => cloneRepo(),
  settings: () => openSettings(),
  help: () => openHelp(),
  'toggle-log': () => { state.logOpen = !state.logOpen; state.unseenLogs = 0; renderLog(); },
  'open-ws': (t) => openWorkspace(t.dataset.ws),
  'claude-toggle': () => toggleClaude(),
  'claude-open': () => toggleClaude(true),
  'claude-send': () => claudeSend(),
  'claude-stop': () => api.claude.interrupt(),
  'claude-new': () => claudeNewChat(),
  'claude-idea': (t) => claudeSend(t.textContent),
  'claude-allow': (t) => { const it = cl.items[t.dataset.idx]; it.perm.decided = 'allowed'; api.claude.permission(it.perm.requestId, true, it.input); renderClaude(); },
  'claude-deny': (t) => { const it = cl.items[t.dataset.idx]; it.perm.decided = 'denied'; api.claude.permission(it.perm.requestId, false); renderClaude(); },
  'claude-allow-similar': (t) => {
    const it = cl.items[t.dataset.idx];
    const rule = ruleFor(it);
    if (rule) cl.rules.push({ tool: rule.tool, prefix: rule.prefix });
    it.perm.decided = 'allowed';
    api.claude.permission(it.perm.requestId, true, it.input);
    toast(`Claude can now run ${rule.label} in this chat without asking.`, 'ok');
    renderClaude();
    saveChats();
  },
  'claude-history': (t) => claudeHistory(t),
  'claude-open-chat': (t) => {
    const box = chatsFor(scopeKey());
    box.current = t.dataset.id;
    closePopover();
    renderClaude();
    saveChats();
  },
  'explain-commit': (t) => askClaude(`Explain commit ${t.dataset.hash.slice(0, 10)} ("${t.dataset.subject}") in plain English: what changed, and why it might have been done. Look at it with git show.`),
  'explain-conflict': () => {
    const repo = currentRepo();
    const L = conflictLabels(state.status[repo]);
    askClaude(`I have a merge conflict in ${state.conflict.file}. "${L.ours}" vs "${L.theirs}". Explain in plain English what each side changed and suggest what the merged result should be. Don't edit the file — I'll choose in RepoDeck unless I ask you to.`);
  },
  'write-message': async (t) => {
    const repo = currentRepo();
    const st = state.status[repo];
    const files = changedFiles(st).filter((f) => state.checked[repo]?.[f.path]);
    if (!files.length) { toast('Tick the files you want to commit first.', 'warn'); return; }
    t.disabled = true;
    const label = t.textContent;
    t.innerHTML = '<span class="spinner sm"></span> Writing…';
    try {
      const diffs = [];
      for (const f of files.slice(0, 40)) {
        const d = await gitRaw('fileDiff', repo, f.orig ? [f.path, f.orig] : [f.path], { untracked: !!f.untracked }).catch(() => null);
        diffs.push(`### ${f.path} (${CODE_LABEL[f.code] || f.code})\n${d?.kind === 'text' ? d.text : `(${d?.kind || 'unavailable'})`}`);
      }
      const prefix = $('#commit-summary').value.match(/^[\w-]+(\(.+?\))?!?:\s*/)?.[0] || '';
      const prompt = `Write a git commit message for the changes below.\nReply with ONLY the message: a summary line under 72 characters${prefix ? ` starting with "${prefix.trim()}"` : ''}, then (only if useful) a blank line and a short description.\nNo quotes, no code fences, no preamble.\n\n${diffs.join('\n\n').slice(0, 60000)}`;
      const r = await api.claude.oneShot(repo, prompt);
      if (!r.ok) throw new Error(r.error === 'NOT_FOUND' ? "Couldn't find the Claude Code app (claude.exe). Set its location in Settings → Claude." : r.error);
      const [summary, ...rest] = r.text.replace(/^```\w*\n?|```$/g, '').trim().split('\n');
      $('#commit-summary').value = summary.trim();
      $('#commit-body').value = rest.join('\n').trim();
      state.commitMsg[repo] = { summary: $('#commit-summary').value, body: $('#commit-body').value };
      updateCommitButtons();
    } catch (e) { showError("Claude couldn't write a message", e); }
    finally { t.disabled = false; t.textContent = label; }
  },
  'commit-prefix': (t) => {
    const s = $('#commit-summary');
    s.value = `${t.dataset.prefix}: ${s.value.replace(/^[\w-]+(\(.+?\))?!?:\s*/, '')}`;
    s.focus();
    s.dispatchEvent(new Event('input', { bubbles: true }));
  },
  'amend-toggle': (t) => {
    const s = $('#commit-summary');
    if (t.checked && state.lastCommit && !s.value.trim().replace(state.config.settings.commitTemplate || '', '')) {
      const [summary, ...rest] = state.lastCommit.message.split('\n');
      s.value = summary;
      $('#commit-body').value = rest.join('\n').trim();
      state.commitMsg[currentRepo()] = { summary: s.value, body: $('#commit-body').value };
    }
    updateCommitButtons();
  },
  'diff-mode': (t) => {
    state.config.settings.diffMode = t.dataset.mode;
    saveConfig();
    if (state.tab === 'changes') refreshDiff();
    else if (state.tab === 'history') loadCommitDetails();
    else if (state.tab === 'compare') loadCompareDiff();
    else if (state.tab === 'shelf') loadStashPreview();
  },
  'file-history': (t, e) => { e?.stopPropagation(); state.blame = false; showFileHistory(t.dataset.path); },
  'file-blame': (t, e) => { e?.stopPropagation(); state.blame = true; showFileHistory(t.dataset.path); },
  'blame-mode': (t) => { state.blame = !!t.dataset.on; renderHistoryTab(); },
  'blame-commit': (t) => { state.blame = false; state.selCommit = t.dataset.hash; renderHistoryTab(); },
  'blame-explain': (t) => askClaude(`In ${state.histFile}, lines ${t.dataset.from}–${t.dataset.to} were last changed by commit ${t.dataset.hash.slice(0, 10)}. Explain in plain English what that commit did to those lines and why it was probably done. Look at it with git show.`),
  'update-from': (t) => { closePopover(); updateFrom(t.dataset.repo || currentRepo()); },
  'ws-update-from': () => wsUpdateFrom(),
  'finish-branch': (t) => { closePopover(); finishBranch(t.dataset.repo || currentRepo()); },
  'ws-finish': () => wsFinish(),
  'discard-hunk': (t) => discardBlock(t.dataset.h),
  'tidy-commits': () => tidyCommits(currentRepo()),
  'shelve-ticked': () => {
    const repo = currentRepo();
    const ticked = changedFiles(state.status[repo]).filter((f) => state.checked[repo]?.[f.path]);
    shelve(repo, ticked.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path])));
  },
  'undo-list': (t) => (popoverEl ? closePopover() : openUndoList(t)),
  'undo-run': (t) => runUndo(t.dataset.id),
  compare: (t) => { closePopover(); const repo = t.dataset.repo || currentRepo(); if (!samePath(repo, currentRepo())) openRepo(repo, state.view.ws, 'compare'); else setTab('compare'); },
  'revert-commit': (t) => revertCommit(currentRepo(), t.dataset.hash, t.dataset.subject),
  'cmp-swap': () => { const c = state.cmp; if (c) showCompare(c.head, c.base); },
  'cmp-range': (t) => { const c = state.cmp; if (!c || c.mode === t.dataset.mode) return; c.mode = t.dataset.mode; c.data = null; renderCompareTab(); loadCompare(); },
  'cmp-file': (t) => { state.cmp.sel = t.dataset.path; document.querySelectorAll('#tab-body .file').forEach((f) => f.classList.toggle('selected', f === t)); loadCompareDiff(); },
  'clear-file-history': () => { state.histFile = null; state.blame = false; state.history = null; renderHistoryTab(); loadHistory(); },
  'open-menu': (t) => (popoverEl ? closePopover() : openMenu(t, t.dataset.repo)),
  'branch-switcher': (t) => (popoverEl ? closePopover() : openBranchSwitcher(t, t.dataset.repo)),
  'switcher-pick': (t) => {
    closePopover();
    const st = state.status[t.dataset.repo] || {};
    if (t.dataset.name === st.branch) return;
    switchBranch(t.dataset.repo, t.dataset.name, t.dataset.remote || undefined);
  },
  'open-pr': async (t) => {
    closePopover();
    const repo = t.dataset.repo || currentRepo();
    const url = await gitRaw('prUrl', repo, state.status[repo]?.branch).catch(() => null);
    if (url) api.openUrl(url); else toast("Couldn't work out the pull request page for this server.", 'warn');
  },
  'add-remote': (t) => addRemoteFlow(t.dataset.repo || currentRepo()),
  'cancel-op': async (t) => { await gitRaw('cancel', t.dataset.repo); toast('Cancelling…', 'info'); },
  'cancel-clone': () => gitRaw('cancel', 'clone'),
  tidy: (t) => tidyBranches([t.dataset.repo || currentRepo()]),
  'ws-tidy': () => tidyBranches(currentWs().repos.filter((p) => !state.status[p]?.error && !state.status[p]?.missing)),
  'toggle-discarded': () => { state.discardOpen = !state.discardOpen; renderShelfTab(); },
  'clean-discarded': async (t) => {
    const repo = currentRepo();
    const refs = t.dataset.refs.split(',');
    if (!(await confirmBox('Delete old discarded copies?', `<p>Delete ${plural(refs.length, 'safety copy', 'safety copies')} of changes you discarded more than 2 weeks ago? They can't be brought back afterwards.</p>`, 'Delete', true))) return;
    // Highest stash index first, so the lower refs stay valid.
    const sorted = refs.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    try { for (const ref of sorted) await gitRaw('stashDrop', repo, ref); toast('Cleaned up.', 'ok'); }
    catch (e) { showError("Couldn't clean up", e); }
    await refreshAll();
    loadShelf();
  },
  'open-repo-folder': () => addRepo(state.view.ws),
  'activate-tab': (t) => { if (t.dataset.key !== state.activeTab) activateTab(t.dataset.key); },
  'close-tab': (t) => closeTab(t.dataset.key),
  'toggle-ws': (t, e) => { e.stopPropagation(); const w = state.config.workspaces.find((x) => x.id === t.dataset.ws); w.collapsed = !w.collapsed; saveConfig(); renderSidebar(); },
  'add-repo': (t, e) => { e.stopPropagation(); addRepo(t.dataset.ws || state.view.ws); },
  'open-repo': (t) => openRepo(t.dataset.repo, t.dataset.ws),
  'remove-repo': async (t) => {
    const repo = t.dataset.repo;
    const w = ensureWorkspace(state.view.ws);
    if (!(await confirmBox('Remove from workspace?', `<p>Remove <b>${esc(basename(repo))}</b> from <b>${esc(w.name)}</b>? The folder and its files are <b>not</b> deleted.</p>`, 'Remove'))) return;
    w.repos = w.repos.filter((p) => !samePath(p, repo));
    await saveConfig();
    if (!tabValid({ type: 'repo', path: repo })) closeTab(tabKey({ type: 'repo', path: repo }), false);
    openWorkspace(w.id);
  },
  'ws-rename': async () => { const w = currentWs(); const n = await ask('Rename workspace', { label: 'Name', value: w.name, okLabel: 'Rename' }); if (n) { w.name = n; await saveConfig(); openWorkspace(w.id); } },
  'ws-delete': async () => {
    const w = currentWs();
    if (!(await confirmBox(`Remove workspace “${w.name}”?`, '<p>This only removes the grouping from this app. Your repo folders are <b>not</b> touched.</p>', 'Remove', true))) return;
    state.config.workspaces = state.config.workspaces.filter((x) => x !== w);
    await saveConfig();
    pruneTabs();
    renderSidebar();
  },
  'ws-fetch': () => wsFetch(),
  'ws-pull': () => wsPull(),
  'ws-push': () => wsPush(),
  'ws-new-branch': () => wsNewBranch(),
  'ws-switch': (t) => wsSwitch(t?.dataset?.preset),
  'ws-open-editor': async () => { const r = await api.openInEditor(state.config.settings.editor, currentWs().repos); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-editor': async (t) => { closePopover(); const r = await api.openInEditor(state.config.settings.editor, [t.dataset.repo || currentRepo()]); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-file': async (t, e) => { e.stopPropagation(); const r = await api.openInEditor(state.config.settings.editor, [`${currentRepo()}\\${t.dataset.path.replace(/\//g, '\\')}`]); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-folder': (t) => { closePopover(); api.openFolder(t.dataset.repo || currentRepo()); },
  'open-terminal': (t) => { closePopover(); api.openTerminal(t.dataset.repo || currentRepo()); },
  'open-web': async (t) => { closePopover(); const url = await git('remoteWebUrl', t.dataset.repo).catch(() => null); if (url) api.openUrl(url); else toast('This repo has no web address (no server configured).', 'warn'); },
  tab: (t, e) => { e.preventDefault(); setTab(t.dataset.tab); },
  fetch: (t) => doFetch(t.dataset.repo),
  pull: (t) => doPull(t.dataset.repo),
  push: (t) => doPush(t.dataset.repo),
  'select-file': (t) => { state.selected[currentRepo()] = t.dataset.path; document.querySelectorAll('#file-list .file').forEach((f) => f.classList.toggle('selected', f === t)); refreshDiff(); },
  // A file's own tick box always means the whole file, so it clears any line choices.
  'check-file': (t, e) => {
    e.stopPropagation();
    const repo = currentRepo();
    const whole = partlyPicked(repo, t.dataset.path) || t.checked;
    clearPicks(repo, t.dataset.path);
    state.checked[repo][t.dataset.path] = whole;
    afterPick();
  },
  'check-all': (t) => { const repo = currentRepo(); const c = state.checked[repo]; for (const k of Object.keys(c)) c[k] = t.checked; clearPicks(repo); afterPick(); },
  'pick-line': (t) => { const k = state.diffKeys; if (k) { pickLines(k.repo, k.path, [t.dataset.key], t.checked); afterPick(); } },
  'pick-hunk': (t) => {
    const k = state.diffKeys;
    if (!k) return;
    const keys = [...document.querySelectorAll(`#diff-pane .dl[data-h="${t.dataset.h}"] [data-action=pick-line]`)].map((b) => b.dataset.key);
    pickLines(k.repo, k.path, keys, t.checked);
    afterPick();
  },
  commit: () => doCommit(currentRepo(), false),
  'commit-push': () => doCommit(currentRepo(), true),
  'discard-file': (t, e) => { e.stopPropagation(); discard(currentRepo(), [t.dataset.path]); },
  'discard-checked': () => { const repo = currentRepo(); discard(repo, changedFiles(state.status[repo]).filter((f) => state.checked[repo][f.path]).map((f) => f.path)); },
  'ignore-file': async (t, e) => {
    e.stopPropagation();
    const p = t.dataset.path;
    if (!(await confirmBox('Ignore this file?', `<p>Add <code>${esc(p)}</code> to <code>.gitignore</code>? Git will stop showing it as a change. Good for build output, logs, local settings and secrets.</p>`, 'Ignore'))) return;
    try { await git('ignore', currentRepo(), p); await refreshAll(); } catch (er) { showError("Couldn't update .gitignore", er); }
  },
  shelve: (t) => shelve(t.dataset.repo || currentRepo()),
  'new-branch': (t) => newBranch(t.dataset.repo || currentRepo()),
  'switch-branch': (t) => switchBranch(currentRepo(), t.dataset.name),
  'switch-remote': (t) => switchBranch(currentRepo(), t.dataset.branch, t.dataset.name),
  'merge-branch': (t) => mergeBranch(currentRepo(), t.dataset.name),
  'branch-menu': (t) => branchMenu(currentRepo(), t.dataset.name),
  'select-commit': (t) => { state.selCommit = t.dataset.hash; document.querySelectorAll('.commit').forEach((c) => c.classList.toggle('selected', c === t)); loadCommitDetails(); },
  'undo-commit': async () => {
    const repo = currentRepo();
    if (!(await confirmBox('Undo the last commit?', '<p>The commit is removed, but <b>your changes are kept</b> — they go back to the Changes tab so you can fix them and commit again.</p>', 'Undo commit'))) return;
    try { await busy(repo, 'Undoing…', () => git('undoLastCommit', repo)); state.selCommit = null; loadHistory(); toast('Commit undone — your changes are in the Changes tab.', 'ok'); }
    catch (e) { showError("Couldn't undo", e); }
  },
  'pick-from': (t) => showHistoryOf(t.dataset.ref),
  'hist-notin': (t) => { state.histNotIn = t.checked; state.picks.clear(); loadHistory(); },
  'pick-commit': (t) => { if (t.checked) state.picks.add(t.dataset.hash); else state.picks.delete(t.dataset.hash); renderPickBar(); },
  'clear-picks': () => { state.picks.clear(); document.querySelectorAll('[data-action=pick-commit]').forEach((c) => { c.checked = false; }); renderPickBar(); },
  'cherry-pick': () => cherryPickHere(currentRepo(), [...state.picks]),
  'cherry-pick-to': () => cherryPickTo(currentRepo(), [...state.picks]),
  'cherry-pick-one': (t) => cherryPickHere(currentRepo(), [t.dataset.hash]),
  'cherry-pick-to-one': (t) => cherryPickTo(currentRepo(), [t.dataset.hash]),
  'skip-op': async (t) => {
    const repo = t.dataset.repo;
    const kind = state.status[repo].op.kind;
    if (!(await confirmBox('Skip this commit?', '<p>This commit will be left out (its changes are not copied), and the rest carry on.</p>', 'Skip it'))) return;
    try { const r = await busy(repo, 'Skipping…', () => git('skipOp', repo, kind)); state.conflict = null; if (await afterMaybeConflict(repo, r, 'Skipped.')) setTab('changes'); }
    catch (e) { showError("Couldn't skip", e); }
  },
  'select-stash': (t) => { state.selStash = t.dataset.ref; document.querySelectorAll('.commit').forEach((c) => c.classList.toggle('selected', c === t)); loadStashPreview(); },
  'stash-pop': async (t) => { const repo = currentRepo(); try { const r = await busy(repo, 'Restoring…', () => git('stashPop', repo, t.dataset.ref)); await afterMaybeConflict(repo, r, 'Restored to your folder.'); loadShelf(); } catch (e) { showError("Couldn't restore", e); } },
  'stash-apply': async (t) => { const repo = currentRepo(); try { const r = await busy(repo, 'Restoring…', () => git('stashApply', repo, t.dataset.ref)); await afterMaybeConflict(repo, r, 'Copied into your folder (still on the Shelf too).'); } catch (e) { showError("Couldn't restore", e); } },
  'stash-drop': async (t) => {
    const repo = currentRepo();
    if (!(await confirmBox('Delete from the Shelf?', '<p>These changes will be removed from the Shelf. (You can Undo right after.)</p>', 'Delete', true))) return;
    try {
      const dropped = await git('stashDrop', repo, t.dataset.ref);
      state.selStash = null;
      await refreshAll();
      loadShelf();
      if (dropped?.oid) undoToast('Deleted from the Shelf.', repo, 'delete from the Shelf', async () => { await git('stashStore', repo, dropped.oid, dropped.message || 'Restored'); loadShelf(); });
    } catch (e) { showError("Couldn't delete", e); }
  },
  'open-conflict': (t) => openConflict(t.dataset.path),
  pick: (t) => {
    const c = state.conflict;
    c.choices[t.dataset.i] = t.dataset.choice;
    if (!c.resultDirty) c.resultText = null;
    renderConflictPane();
  },
  'save-resolution': () => saveResolution(),
  'conflict-view': (t) => { state.conflictView = state.conflict.view = t.dataset.view; renderConflictPane(); },
  'cmp-mode': (t) => { state.conflict.cmp = t.dataset.mode; renderConflictPane(); },
  'cmp-full': (t) => { state.conflict.full = t.checked; renderConflictPane(); },
  'cmp-show-all': () => { state.conflict.full = true; renderConflictPane(); },
  'reload-conflict': () => openConflict(state.conflict.file),
  'result-reset': () => { const c = state.conflict; c.resultText = null; c.resultDirty = false; renderConflictPane(); },
  'save-result': async () => {
    const text = state.conflict.resultText;
    if (/^(<<<<<<<|>>>>>>>)/m.test(text) && !(await confirmBox('Markers still in the file', '<p>The result still contains <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> conflict markers. Save and mark it resolved anyway?</p>', 'Save anyway', true))) return;
    saveConflictText(text);
  },
  'merge-editor': async () => {
    const repo = currentRepo();
    const c = state.conflict;
    const L = conflictLabels(state.status[repo]);
    const r = await api.openMergeEditor(state.config.settings.editor, repo, c.file, L.ours, L.theirs);
    if (!r.ok) { showError("Couldn't open the merge editor", new Error(r.error)); return; }
    await modal({
      title: `Opened in ${editorName()}`,
      body: `<p>In ${esc(editorName())}'s merge editor, <b>${esc(L.ours)}</b> and <b>${esc(L.theirs)}</b> are shown at the top and the result at the bottom. Accept changes from either side, then click <b>Complete Merge</b> (or just save).</p>
        <p>Then come back here and click <b>↻ Reload</b> → <b>Mark as resolved</b>.</p>`,
    });
  },
  'resolve-side': async (t) => {
    const repo = currentRepo();
    const c = state.conflict;
    const L = conflictLabels(state.status[repo]);
    const side = t.dataset.side;
    if (!(await confirmBox('Keep the whole file?', `<p>Use <b>${esc(side === 'ours' ? L.ours : L.theirs)}</b>'s version of <code>${esc(c.file)}</code> for the whole file, throwing away the other side's changes to it?</p>`, 'Keep it'))) return;
    try { await git('resolveSide', repo, c.file, side); state.conflict = null; toast('Resolved.', 'ok'); await refreshAll(); }
    catch (e) { showError("Couldn't resolve", e); }
  },
  'mark-resolved': async () => {
    const repo = currentRepo();
    const c = state.conflict;
    const data = await git('readConflict', repo, c.file);
    if (data.content && /^(<<<<<<<|>>>>>>>)/m.test(data.content) && !(await confirmBox('Markers still in the file', '<p>This file still contains <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> / <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> conflict markers. Mark it resolved anyway?</p>', 'Mark resolved', true))) return;
    try { await git('markResolved', repo, c.file); state.conflict = null; await refreshAll(); } catch (e) { showError("Couldn't mark resolved", e); }
  },
  'abort-op': async (t) => {
    const repo = t.dataset.repo;
    const st = state.status[repo];
    if (!(await confirmBox(`Abort the ${OP_NAMES[st.op.kind]}?`, '<p>This cancels it and puts your files back exactly how they were before it started. Your earlier commits are safe.</p>', 'Abort', true))) return;
    try { await busy(repo, 'Aborting…', () => git('abortOp', repo, st.op.kind)); state.conflict = null; toast('Aborted — everything is back how it was.', 'ok'); setTab('changes'); }
    catch (e) { showError("Couldn't abort", e); }
  },
  'continue-op': async (t) => {
    const repo = t.dataset.repo;
    const kind = state.status[repo].op.kind;
    try { const r = await busy(repo, 'Finishing…', () => git('continueOp', repo, kind)); if (await afterMaybeConflict(repo, r, `${OP_NAMES[kind][0].toUpperCase() + OP_NAMES[kind].slice(1)} finished.`)) setTab('changes'); }
    catch (e) { showError("Couldn't finish", e); }
  },
};

async function discard(repo, paths) {
  if (!paths.length) return;
  const st = state.status[repo];
  const what = paths.length === 1 ? `<code>${esc(paths[0])}</code>` : plural(paths.length, 'file');
  const ok = await confirmBox('Discard changes?', `<p>Throw away your changes to ${what}? The file${paths.length === 1 ? '' : 's'} will go back to how ${paths.length === 1 ? 'it was' : 'they were'} at your last commit (new files are removed).</p>
    <p class="hint">${st.initial ? 'New files will be moved to the Recycle Bin.' : 'Safety net: the discarded changes are kept on the <b>Shelf</b>, so you can get them back if you change your mind.'}</p>`, 'Discard', true);
  if (!ok) return;
  try { await busy(repo, 'Discarding…', () => git('discard', repo, paths)); toast('Discarded.', 'ok'); }
  catch (e) { showError("Couldn't discard", e); }
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t || t.disabled || t.closest('.modal-backdrop')) return;
  const fn = actions[t.dataset.action];
  if (!fn) return;
  if (e.shiftKey && t.tagName === 'BUTTON') {
    e.preventDefault();
    state.previewOnce = true;
    Promise.resolve(fn(t, e)).finally(() => { state.previewOnce = false; });
  } else fn(t, e);
});

document.addEventListener('input', (e) => {
  const repo = currentRepo();
  if (e.target.id === 'commit-summary' || e.target.id === 'commit-body') {
    state.commitMsg[repo] = { summary: $('#commit-summary').value, body: $('#commit-body').value };
    updateCommitButtons();
  } else if (e.target.id === 'work-item') {
    e.target.value = e.target.value.replace(/[^\d]/g, '');
    state.workItem[e.target.dataset.key] = e.target.value;
  } else if (e.target.classList.contains('custom') && state.conflict) {
    state.conflict.custom[e.target.dataset.i] = e.target.value;
    if (!state.conflict.resultDirty) state.conflict.resultText = null;
  } else if (e.target.id === 'result-editor' && state.conflict) {
    const c = state.conflict;
    c.resultText = e.target.value;
    c.resultDirty = true;
    $('#result-status').textContent = /^(<<<<<<<|>>>>>>>)/m.test(c.resultText) ? '⚠ Conflict markers are still in the file' : '✓ No conflict markers left';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey && (e.target.id === 'commit-summary' || e.target.id === 'commit-body')) {
    e.preventDefault();
    if (!$('#commit-btn').disabled) $('#commit-btn').click();
  }
  if (e.key === 'F5') { e.preventDefault(); refreshAll(true); }
  if ($('#modal-root').childElementCount) return;
  if (e.target.id === 'cp-input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!cl.running) claudeSend(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleClaude(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); closePopover(); openPalette(); return; }
  // Ctrl+Z outside a text box opens the Undo list (it never undoes without a click).
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea, select, [contenteditable]') && !$('#modal-root').lastElementChild) {
    const anchor = $('[data-action=undo-list]');
    if (anchor) { e.preventDefault(); closePopover(); openUndoList(anchor); }
    return;
  }
  // Tab shortcuts, like a browser: Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab cycle, Ctrl+1..9 jump.
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'w') { e.preventDefault(); if (state.activeTab) closeTab(state.activeTab); }
  else if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
  else if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); cycleTab(e.key === 'PageDown' ? 1 : -1); }
  else if (e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key) && state.tabs.length) {
    e.preventDefault();
    const t = e.key === '9' ? state.tabs[state.tabs.length - 1] : state.tabs[Number(e.key) - 1];
    if (t) activateTab(tabKey(t));
  }
});

// ---------- start ----------
async function backgroundFetch() {
  const mins = state.config.settings.autoFetchMinutes;
  if (!mins) return;
  const changed = [];
  for (const repo of allRepos()) {
    const st = state.status[repo];
    if (!st || st.error || st.missing || state.busy[repo]) continue;
    if (Date.now() - (state.lastFetch[repo] || 0) < mins * 60000) continue;
    state.lastFetch[repo] = Date.now();
    const r = await api.git('fetch', repo, { background: true });
    if (r.ok && (await refreshRepo(repo))) changed.push(repo);
  }
  if (changed.length) onStatusChanged(changed);
}

// Watch every repo folder; a change there refreshes just that repo.
let watched = '';
function updateWatchers() {
  const repos = allRepos();
  const key = repos.join('|');
  if (key !== watched) { watched = key; api.watchRepos(repos); }
}

async function init() {
  state.config = await api.getConfig();
  api.onLog(addLog);
  api.claude.onEvent(onClaudeEvent);
  api.onProgress((p) => {
    if (p.done) { delete state.progress[p.key]; return; }
    state.progress[p.key] = p;
    if (p.key === 'clone') { const el = $('#clone-progress'); if (el) el.textContent = `${p.text}${p.percent != null ? ` ${p.percent}%` : ''}`; return; }
    // Update just the busy labels, not the whole view.
    document.querySelectorAll('.busy').forEach((b) => b.remove());
    onStatusChanged([p.key]);
  });
  api.onRepoChanged(async (repo) => {
    if (await refreshRepo(repo)) onStatusChanged([repo]);
    // Status doesn't cover branches or stashes made elsewhere (e.g. `git branch foo`), so reload the open list.
    else if (state.view.type === 'repo' && samePath(repo, state.view.path)) {
      if (state.tab === 'branches') loadBranches();
      else if (state.tab === 'shelf') loadShelf();
    }
  });
  api.onUpdate((u) => toast(`RepoDeck ${u.version} is ready to install.`, 'info', { label: 'Restart now', fn: () => api.restartToUpdate() }));
  await loadChats();
  if (state.config.settings.claudeOpen) toggleClaude(true);
  renderLog();
  const first = state.config.workspaces[0];
  // Reopen the tabs from last time.
  state.tabs = (state.config.tabs || []).filter(tabValid);
  const last = state.tabs.find((t) => tabKey(t) === state.config.activeTab) || state.tabs[0];
  if (first) await refreshAll();
  if (last) activateTab(tabKey(last));
  else if (first) openWorkspace(first.id);
  else renderHome();
  refreshAll(true);
  updateWatchers();
  // Folder watching does the real work; this slow check is a safety net (e.g. for network drives).
  let lastPoll = 0;
  setInterval(() => {
    updateWatchers();
    const gap = document.hasFocus() ? 20000 : 60000;
    if (Date.now() - lastPoll >= gap) { lastPoll = Date.now(); refreshAll(); }
  }, 2000);
  window.addEventListener('focus', () => { lastPoll = Date.now(); refreshAll(); });
  setTimeout(backgroundFetch, 5000);
  setInterval(backgroundFetch, 60000);
  const id = await git('getIdentity').catch(() => null);
  if (id && (!id.name || !id.email)) {
    const go = await confirmBox('One-time setup', '<p>Git needs your <b>name and email</b> to stamp on your commits. It isn\'t set on this computer yet.</p>', 'Set them now');
    if (go) openSettings();
  }
}

init();
