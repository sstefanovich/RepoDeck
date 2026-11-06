'use strict';

// Shared helpers, app state, git calls with command previews, friendly errors, dialogs and toasts, undo, status refresh.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.


// `api` is the bridge exposed by preload.js (window.api).

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);


// Operations that change something. These can be previewed before they run.
const MUTATING = new Set([
  'commit', 'discard', 'ignore', 'fetch', 'pull', 'push', 'addRemote', 'createBranch', 'switchBranch', 'checkoutRemote',
  'renameBranch', 'deleteBranch', 'merge', 'undoLastCommit', 'stashSave', 'stashApply', 'stashPop', 'stashDrop',
  'resolveSide', 'saveResolution', 'markResolved', 'abortOp', 'continueOp', 'skipOp', 'cherryPick', 'cherryPickOnto',
  'clone', 'init', 'setIdentity', 'resetTo', 'restoreBranch', 'stashStore', 'updateFrom', 'revertCommit', 'finishBranch', 'discardLines', 'applyPatch', 'tidyCommits', 'createTag', 'pushTag', 'deleteTag', 'restoreTag',
  'setupRepo', 'joinServerHistory', 'useHttps',
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
  tags: null,        // tags of the open repo (Branches tab)
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
  prStatus: {},       // norm(repo) -> pull request info from GitHub or Azure DevOps, for the current branch
  tokens: { ado: false, github: false }, // which tokens are saved (the tokens themselves stay in the main process)
  workItem: {},       // "repo|branch" -> work item number typed in the commit box
  wsQuery: '',        // workspace page: search text
  branchFilter: '',   // Branches tab: filter text
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
  [/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|403/i, "Git couldn't log in to the server. Your saved login may have expired. Send, Get latest or Check for updates on this repo offers to sign in again."],
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

const AUTH_FAILED = /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey\)|terminal prompts disabled|returned error: 40[13]|Invalid username or (password|token)|Host key verification failed/i;

// A login problem: explain it and offer to sign in again (HTTPS) or switch to HTTPS (SSH), then retry.
// where: { repo } for an existing repo's origin, or { url } (e.g. a clone).
async function showSignInError(title, raw, { repo = null, url = null, retry = null } = {}) {
  const remote = url || (repo ? await gitRaw('remoteUrl', repo).catch(() => null) : null);
  const ssh = /publickey|Host key verification/i.test(raw) || (remote && !/^https?:\/\//i.test(remote));
  const host = (() => { try { return new URL(remote).host; } catch { return remote?.match(/@([^:/]+)/)?.[1] || 'the server'; } })();
  const body = ssh
    ? `<p><b>${esc(host)}</b> didn't accept your SSH key. Either no key is set up on this computer, or the server doesn't know it.</p>
       <p>${repo ? 'The easiest fix is to use HTTPS for this repo instead. You sign in once in a browser window and the login is saved for next time.' : 'Try the HTTPS address of the repo instead. You sign in once in a browser window and the login is saved.'}</p>`
    : `<p>Git couldn't log in to <b>${esc(host)}</b>. Your saved login may have expired, been changed, or never been saved.</p>
       <p><b>Sign in again</b> forgets the old login and opens the sign-in window (Git Credential Manager). ${retry ? 'RepoDeck then tries again.' : ''}</p>`;
  const r = await modal({
    title,
    body: `${body}<details><summary>What git actually said</summary><pre class="raw">${esc(raw)}</pre></details>`,
    buttons: [
      { id: 'cancel', label: 'Close' },
      ...(ssh ? (repo ? [{ id: 'https', label: 'Use HTTPS and sign in', kind: 'primary' }] : []) : [{ id: 'signin', label: 'Sign in again', kind: 'primary' }]),
    ],
  });
  if (r.id !== 'signin' && r.id !== 'https') return;
  try {
    if (r.id === 'https') {
      const https = await git('useHttps', repo);
      toast(`This repo now uses ${https}.`, 'info');
      await refreshRepo(repo);
    }
    const box = toast('Finish signing in in the window that opened…', 'info');
    try { await gitRaw('signIn', repo || remote); } finally { box?.remove?.(); }
    toast(`Signed in to ${host}.`, 'ok');
    if (retry) await retry();
  } catch (e) {
    if (e.code === CANCELLED) return;
    const why = e.code === 'NO_HELPER' || e.code === 'SIGNIN_FAILED' ? e.message : null;
    await modal({ title: "Couldn't sign in", body: `<p>${esc(why || "The sign-in didn't work.")}</p>${why ? '' : `<details><summary>Details</summary><pre class="raw">${esc(e.message)}</pre></details>`}` });
  }
}

async function showError(title, err, where = null) {
  if (err?.code === CANCELLED) return;
  const raw = err?.message || String(err);
  if (where && AUTH_FAILED.test(raw)) return showSignInError(title, raw, where);
  const nice = explain(raw);
  const identity = /tell me who you are|empty ident|auto-detect email/i.test(raw);
  const r = await modal({
    title,
    body: `${nice ? `<p>${esc(nice)}</p>` : '<p>Git reported a problem:</p>'}
      <details ${nice ? '' : 'open'}><summary>What git actually said</summary><pre class="raw">${esc(raw)}</pre></details>`,
    buttons: [
      ...(aiOn() && claudeScope() ? [{ id: 'claude', label: '✦ Ask Claude why' }] : []),
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
      // Links in dialogs open in the browser: <a href="#" data-url="https://…">.
      const link = e.target.closest('a[data-url]');
      if (link) { e.preventDefault(); api.openUrl(link.dataset.url); return; }
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
  return el;
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
      <div><b>${esc(basename(r.repo))}</b> — ${esc(r.msg)}${r.url ? ` <a href="#" data-url="${esc(r.url)}">Open ↗</a>` : ''}${r.raw ? `<details><summary>details</summary><pre class="raw">${esc(r.raw)}</pre></details>` : ''}</div></li>`).join('')}</ul>
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
