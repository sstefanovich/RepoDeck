'use strict';

// `api` is the bridge exposed by preload.js (window.api).

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const norm = (p) => p.toLowerCase().replace(/[\\/]+$/, '');
const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const uid = () => Math.random().toString(36).slice(2, 10);

function timeAgo(unixSec) {
  const s = Math.max(0, Date.now() / 1000 - unixSec);
  const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [86400 * 30, 'day', 86400], [86400 * 365, 'month', 86400 * 30], [Infinity, 'year', 86400 * 365]];
  for (const [limit, unit, div] of steps) {
    if (s < limit) { const n = Math.floor(s / div); return n <= 0 || unit === 'second' ? 'just now' : `${plural(n, unit)} ago`; }
  }
  return '';
}

async function git(op, ...args) {
  const r = await api.git(op, ...args);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
}

// ---------- state ----------
const state = {
  config: { workspaces: [], settings: {} },
  status: {},        // repo path -> status from git
  view: { type: 'home' },
  tab: 'changes',
  checked: {},       // repo -> { file: true/false } for the commit checkboxes
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
  const raw = err?.message || String(err);
  const nice = explain(raw);
  const identity = /tell me who you are|empty ident|auto-detect email/i.test(raw);
  const r = await modal({
    title,
    body: `${nice ? `<p>${esc(nice)}</p>` : '<p>Git reported a problem:</p>'}
      <details ${nice ? '' : 'open'}><summary>What git actually said</summary><pre class="raw">${esc(raw)}</pre></details>`,
    buttons: identity ? [{ id: 'ok', label: 'Close' }, { id: 'id', label: 'Set my name & email', kind: 'primary' }] : [{ id: 'ok', label: 'OK', kind: 'primary' }],
  });
  if (r.id === 'id') openSettings();
}

// ---------- modals & toasts ----------
function modal({ title, body = '', buttons = [{ id: 'ok', label: 'OK', kind: 'primary' }], wide = false, init }) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
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

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 3800);
  setTimeout(() => el.remove(), 4300);
}

async function resultsModal(title, results) {
  await modal({
    title,
    body: `<ul class="results">${results.map((r) => `<li class="${r.ok ? 'ok' : r.warn ? 'warn' : 'bad'}">
      <span class="ri">${r.ok ? '✓' : r.warn ? '!' : '✕'}</span>
      <div><b>${esc(basename(r.repo))}</b> — ${esc(r.msg)}${r.raw ? `<details><summary>details</summary><pre class="raw">${esc(r.raw)}</pre></details>` : ''}</div></li>`).join('')}</ul>`,
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
          <div class="ri-top"><span class="ri-name">${esc(basename(p))}</span>${state.busy[p] ? '<span class="spinner sm"></span>' : ''}</div>
          <div class="ri-bottom"><span class="ri-branch">⎇ ${esc(branch)}</span><span class="ri-badges">${badgesHtml(st)}</span></div>
        </div>`;
      }).join('') || '<div class="muted small pad">No repos yet — click ＋</div>'}</div>`}
    </div>`;
  }).join('');
}

// ---------- home ----------
function renderHome() {
  $('#view').innerHTML = `<div class="home">
    <h1>Welcome to RepoDeck 👋</h1>
    <p class="lead">A calmer way to work with git — with plain-English buttons, and several repos side by side.</p>
    <div class="home-cards">
      <div class="hcard"><h3>1. Make a workspace</h3><p>A <b>workspace</b> is a group of repos you work on together — e.g. the three repos for one project. You'll see all of them at a glance and can pull, push or switch branches in all of them at once.</p><button class="btn primary" data-action="new-ws">＋ New workspace</button></div>
      <div class="hcard"><h3>2. Add your repos</h3><p>Point it at folders you already have on disk, or clone one from GitHub/Azure DevOps/etc.</p><button class="btn" data-action="clone">⤓ Clone a repo</button></div>
      <div class="hcard"><h3>3. Keep editing where you like</h3><p>Keep coding in VS Code or Cursor. This window watches your folders and updates automatically.</p><button class="btn" data-action="help">? Git explained</button></div>
    </div>
  </div>`;
}

// ---------- workspace overview ----------
function openWorkspace(id) {
  state.view = { type: 'workspace', ws: id };
  renderSidebar();
  const w = currentWs();
  $('#view').innerHTML = `<div class="page">
    <div class="page-head">
      <div><h1>${esc(w.name)}</h1><div class="muted">${plural(w.repos.length, 'repo')} · actions here run on every repo in the workspace</div></div>
      <div class="spacer"></div>
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
      <span class="sep"></span>
      <button class="btn" data-action="ws-open-editor">Open all in ${esc(editorName())}</button>
      <button class="btn ghost" data-action="add-repo" data-ws="${w.id}">＋ Add repo</button>
    </div>
    <div id="ws-cards" class="cards"></div>
  </div>`;
  renderWorkspaceCards();
}

function syncText(st) {
  if (!st || st.error || st.missing) return '';
  if (st.detached) return 'Not on a branch';
  if (st.initial) return 'No commits yet';
  if (!st.upstream) return 'Only on your computer — not on the server yet';
  const bits = [];
  if (st.ahead) bits.push(`<b>${st.ahead}</b> to send`);
  if (st.behind) bits.push(`<b>${st.behind}</b> new on the server`);
  return bits.length ? bits.join(' · ') : 'In sync with the server';
}

function renderWorkspaceCards() {
  const w = currentWs();
  const el = $('#ws-cards');
  if (!w || !el) return;
  if (!w.repos.length) { el.innerHTML = '<div class="empty"><b>No repos in this workspace yet.</b><p>Click “＋ Add repo” to add a folder.</p></div>'; return; }
  el.innerHTML = w.repos.map((p) => {
    const st = state.status[p] || {};
    const b = state.busy[p];
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
        ${b ? `<span class="busy"><span class="spinner"></span>${esc(b)}</span>` : ''}
      </div>
      <div class="card-branch">⎇ <b>${esc(st.detached ? 'detached HEAD' : st.branch || '')}</b></div>
      <div class="facts">${facts}</div>
      <div class="card-actions">
        <button class="btn small primary" data-action="open-repo" data-repo="${esc(p)}" data-ws="${w.id}">Open</button>
        <button class="btn small" data-action="pull" data-repo="${esc(p)}" ${b ? 'disabled' : ''}>↓ Get latest</button>
        <button class="btn small" data-action="push" data-repo="${esc(p)}" ${b ? 'disabled' : ''}>↑ Send</button>
        <button class="btn small ghost" data-action="open-editor" data-repo="${esc(p)}">${esc(editorName())}</button>
        <div class="spacer"></div>
        <button class="icon-btn" data-action="remove-repo" data-repo="${esc(p)}" title="Remove from this workspace (doesn't delete any files)">✕</button>
      </div>
    </div>`;
  }).join('');
}

// ---------- repo view ----------
function openRepo(repo, wsId, tab) {
  const st = state.status[repo] || {};
  const switching = !samePath(currentRepo(), repo);
  state.view = { type: 'repo', path: repo, ws: wsId };
  if (switching) {
    state.branches = state.history = state.stashes = null;
    state.selCommit = state.selStash = state.conflict = null;
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
  else if (state.tab === 'shelf') loadShelf();
}

function repoHeaderHtml(repo) {
  const st = state.status[repo] || {};
  const b = state.busy[repo];
  const d = b ? 'disabled' : '';
  const tools = `<button class="btn ghost" data-action="open-editor" data-repo="${esc(repo)}">Open in ${esc(editorName())}</button>
    <button class="btn ghost" data-action="open-folder" data-repo="${esc(repo)}">Folder</button>
    <button class="btn ghost" data-action="open-terminal" data-repo="${esc(repo)}">Terminal</button>
    <button class="btn ghost" data-action="open-web" data-repo="${esc(repo)}" title="Open the repo's page on GitHub / Azure DevOps / etc.">Website</button>`;
  const top = `<div class="rh-top"><div class="rh-title"><h1>${esc(basename(repo))}</h1><div class="path">${esc(repo)}</div></div><div class="spacer"></div>${tools}</div>`;
  if (st.missing || st.error) {
    return `${top}<div class="banner bad"><div>${st.missing ? 'This folder no longer exists on disk.' : esc(st.error)}</div><div class="banner-actions"><button class="btn" data-action="remove-repo" data-repo="${esc(repo)}">Remove from workspace</button></div></div>`;
  }
  const branchLabel = st.detached ? `detached at ${(st.oid || '').slice(0, 7)}` : st.branch;
  const checked = state.lastFetch[repo] ? `checked ${timeAgo(state.lastFetch[repo] / 1000)}` : '';
  return `${top}
    <div class="rh-bar">
      <button class="branch-pill" data-action="tab" data-tab="branches" title="Switch or create branches">⎇ <b>${esc(branchLabel)}</b> <span class="muted">▾</span></button>
      <div class="sync-text">${syncText(st)}${checked ? ` <span class="muted small">(${checked})</span>` : ''}</div>
      <div class="spacer"></div>
      ${b ? `<span class="busy"><span class="spinner"></span>${esc(b)}</span>` : ''}
      <button class="btn" data-action="fetch" data-repo="${esc(repo)}" ${d} title="git fetch — asks the server what's new. Doesn't change any of your files.">⟳ Check for updates</button>
      <button class="btn ${st.behind ? 'primary' : ''}" data-action="pull" data-repo="${esc(repo)}" ${d} title="git pull — downloads new commits from the server into this branch">↓ Get latest${st.behind ? ` (${st.behind})` : ''}</button>
      <button class="btn ${st.ahead || (!st.upstream && !st.initial && !st.detached) ? 'primary' : ''}" data-action="push" data-repo="${esc(repo)}" ${d} title="git push — uploads your commits to the server">↑ ${st.upstream || st.detached ? 'Send' : 'Publish branch'}${st.ahead ? ` (${st.ahead})` : ''}</button>
    </div>`;
}

const OP_NAMES = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };

function bannerHtml(repo) {
  const st = state.status[repo] || {};
  const c = st.conflicted?.length || 0;
  const r = esc(repo);
  if (st.op) {
    const name = OP_NAMES[st.op.kind];
    const what = st.op.kind === 'merge' ? `Combining <b>${esc(st.op.incoming)}</b> into <b>${esc(st.branch)}</b>` : `A ${name} is in progress`;
    return `<div class="banner warn">
      <div><div class="banner-title">${what}</div>
      <div>${c ? `${plural(c, 'file')} need${c === 1 ? 's' : ''} you to decide what to keep. <a href="#" data-action="tab" data-tab="conflicts">Go to Conflicts →</a>` : `All conflicts are resolved. Click <b>Finish ${name}</b> to complete it.`}</div></div>
      <div class="banner-actions">
        <button class="btn" data-action="abort-op" data-repo="${r}" title="git ${st.op.kind} --abort">Abort — put everything back</button>
        <button class="btn primary" data-action="continue-op" data-repo="${r}" ${c ? 'disabled' : ''}>Finish ${name}</button>
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
  return '';
}

function tabsHtml(repo) {
  const st = state.status[repo] || {};
  const n = st.error || st.missing ? 0 : changedFiles(st).length;
  const tabs = [
    ['changes', `Changes${n ? ` <span class="count">${n}</span>` : ''}`, 'Files you have edited since your last commit'],
    ['branches', 'Branches', 'Parallel versions of the code'],
    ['history', 'History', 'Commits made so far'],
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
  const msg = state.commitMsg[repo] || { summary: '', body: '' };
  $('#tab-body').innerHTML = `<div class="split">
    <div class="pane-left">
      <div class="list-head" id="changes-head"></div>
      <div class="file-list" id="file-list"></div>
      <div class="commit-box" id="commit-box">
        <input id="commit-summary" placeholder="Summary (required) — e.g. Fix login button" maxlength="200" value="${esc(msg.summary)}" spellcheck="true">
        <textarea id="commit-body" rows="2" placeholder="Description (optional)">${esc(msg.body)}</textarea>
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
  const n = files.filter((f) => checked[f.path]).length;

  $('#commit-box').style.display = files.length || st.op ? '' : 'none';
  $('#changes-head').innerHTML = files.length ? `
    <label class="check" title="Tick or untick everything"><input type="checkbox" data-action="check-all" ${n === files.length ? 'checked' : ''}> <span>${plural(files.length, 'changed file')}</span></label>
    <div class="spacer"></div>
    <button class="btn small ghost" data-action="shelve" data-repo="${esc(repo)}" title="git stash — set all your changes aside so your folder is clean">Put all on Shelf</button>
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
      return `<div class="file ${f.path === sel ? 'selected' : ''}" data-action="select-file" data-path="${esc(f.path)}">
        <input type="checkbox" data-action="check-file" data-path="${esc(f.path)}" ${checked[f.path] ? 'checked' : ''} title="Include in the next commit">
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
  }
  updateCommitButtons();
}

function updateCommitButtons() {
  const repo = currentRepo();
  const btn = $('#commit-btn');
  if (!btn) return;
  const st = state.status[repo] || {};
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
  btn.textContent = n ? `Commit ${plural(n, 'file')} to ${st.branch || 'branch'}` : 'Tick some files to commit';
  btn.disabled = !n || !summary;
  $('#commit-push-btn').disabled = !n || !summary;
  btn.title = !summary && n ? 'Type a summary first' : 'git commit — Ctrl+Enter';
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
  pane.innerHTML = `<div class="diff-head">
      <b>${esc(f.path)}</b>${f.orig ? ` <span class="muted">(was ${esc(f.orig)})</span>` : ''}
      <span class="tag c-${f.code === '?' ? 'N' : f.code}">${CODE_LABEL[f.code] || f.code}</span>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="open-file" data-path="${esc(f.path)}">Open in ${esc(editorName())}</button>
    </div>
    <div class="diff-scroll">${diffBody(d)}</div>`;
  pane.querySelector('.diff-scroll').scrollTop = keepScroll;
}

function diffBody(d) {
  if (d.kind === 'binary') return '<div class="empty muted">Binary file (image, dll, etc.) — no preview.</div>';
  if (d.kind === 'large') return `<div class="empty muted">This file is large (${Math.round(d.size / 1024)} KB), so it isn't previewed.</div>`;
  if (d.kind === 'missing') return '<div class="empty muted">File not found.</div>';
  if (d.kind === 'error') return `<pre class="raw">${esc(d.text)}</pre>`;
  return renderDiff(d.text);
}

function renderDiff(text, { maxLines = 6000 } = {}) {
  if (!text || !text.trim()) return '<div class="empty muted">No line changes to show (maybe only file permissions or line endings changed).</div>';
  const out = [];
  let o = 0;
  let n = 0;
  let inHeader = false;
  let count = 0;
  const row = (cls, a, b, code) => `<div class="dl ${cls}"><span class="ln">${a}</span><span class="ln">${b}</span><span class="code">${esc(code) || ' '}</span></div>`;
  for (const raw of text.split('\n')) {
    if (++count > maxLines) { out.push('<div class="dnote">… the rest is too long to show here. Open the file in your editor.</div>'); break; }
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.*)$/);
      out.push(`<div class="dfile">${esc(m ? m[1] : line)}</div>`);
      inHeader = true;
      continue;
    }
    if (inHeader && !line.startsWith('@@')) {
      if (line.startsWith('Binary files')) out.push('<div class="dnote">Binary file changed</div>');
      else if (line.startsWith('rename from ')) out.push(`<div class="dnote">Renamed from ${esc(line.slice(12))}</div>`);
      else if (line.startsWith('new file mode')) out.push('<div class="dnote">New file</div>');
      else if (line.startsWith('deleted file mode')) out.push('<div class="dnote">File deleted</div>');
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { o = +m[1]; n = +m[2]; }
      const ctx = line.replace(/^@@[^@]*@@ ?/, '');
      out.push(`<div class="dl hunk"><span class="ln">⋯</span><span class="ln">⋯</span><span class="code">${esc(ctx)}</span></div>`);
      continue;
    }
    if (line.startsWith('+')) out.push(row('add', '', n++, line.slice(1)));
    else if (line.startsWith('-')) out.push(row('del', o++, '', line.slice(1)));
    else if (line.startsWith('\\') || line === '') continue;
    else out.push(row('ctx', o++, n++, line.slice(1)));
  }
  return `<div class="diff">${out.join('')}</div>`;
}

async function doCommit(repo, thenPush) {
  const st = state.status[repo];
  const summary = $('#commit-summary').value.trim();
  const body = $('#commit-body').value.trim();
  if (!summary) { toast('Type a short summary of what you changed first.', 'warn'); $('#commit-summary').focus(); return; }
  const files = changedFiles(st);
  const ticked = files.filter((f) => state.checked[repo]?.[f.path]);
  if (!ticked.length) return;
  const paths = ticked.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
  const message = body ? `${summary}\n\n${body}` : summary;
  try {
    await busy(repo, 'Committing…', () => git('commit', repo, { message, paths, all: ticked.length === files.length }));
    state.commitMsg[repo] = { summary: '', body: '' };
    $('#commit-summary').value = '';
    $('#commit-body').value = '';
    toast(`Committed to ${st.branch}.`, 'ok');
    if (thenPush) await doPush(repo);
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
    let r = await busy(repo, 'Getting latest…', () => git('pull', repo, 'ff'));
    if (r.diverged) {
      const c = await choose('Both sides have new commits', `<p>You have commits on <b>${esc(st.branch)}</b> that aren't on the server, <i>and</i> the server has commits you don't have. They need to be combined.</p>`, [
        { id: 'merge', label: 'Combine them (merge)', desc: 'Downloads the server commits and joins them with yours in a “merge commit”. If you both changed the same lines, I\'ll help you resolve it. This is the safe, normal choice.' },
      ]);
      if (c !== 'merge') return false;
      r = await busy(repo, 'Combining…', () => git('pull', repo, 'merge'));
    }
    return afterMaybeConflict(repo, r, /Already up to date/i.test(r.output || '') ? 'Already up to date.' : 'Got the latest changes.');
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
    toast(r.published ? 'Branch published to the server.' : 'Sent to the server.', 'ok');
    return true;
  } catch (e) {
    if (e.code === 'NO_REMOTE') return addRemoteFlow(repo);
    showError("Couldn't send", e);
    return false;
  }
}

async function addRemoteFlow(repo) {
  const url = await ask('No server set up for this repo', {
    label: 'Server URL (from GitHub, Azure DevOps, GitLab…)',
    placeholder: 'https://github.com/you/project.git',
    help: 'This repo only exists on your computer. Create an <b>empty</b> repo on GitHub/Azure DevOps first, copy its URL, and paste it here. (This runs <code>git remote add origin &lt;url&gt;</code>.)',
    okLabel: 'Add server & send',
  });
  if (!url) return false;
  try { await git('addRemote', repo, url); return doPush(repo); }
  catch (e) { showError("Couldn't add the server", e); return false; }
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
  const head = `<div class="toolbar">
      <button class="btn primary" data-action="new-branch" data-repo="${esc(currentRepo())}">⎇ New branch…</button>
      <input class="filter" id="branch-filter" placeholder="Filter branches…" spellcheck="false">
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
        <button class="btn small ghost" data-action="merge-branch" data-name="${esc(x.name)}" title="git merge ${esc(x.name)} — copy its commits into ${esc(cur)}">Merge into ${esc(cur || 'current')}</button>`}
        <button class="icon-btn" data-action="branch-menu" data-name="${esc(x.name)}" title="More…">⋯</button>
      </div></div>`).join('');
  const remote = b.remoteOnly.map((x) => `<div class="row" data-name="${esc(x.name)}">
      <div class="row-main"><div class="row-title">${esc(x.branch)} <span class="muted small">(${esc(x.remote)})</span></div>
      <div class="row-sub">${esc(x.subject)} · ${timeAgo(x.date)}</div></div>
      <div class="row-status"><span class="tag">server only</span></div>
      <div class="row-actions">
        <button class="btn small" data-action="switch-remote" data-name="${esc(x.name)}" data-branch="${esc(x.branch)}" title="Downloads it as a branch on your computer and switches to it">Switch to</button>
        <button class="btn small ghost" data-action="merge-branch" data-name="${esc(x.name)}" title="git merge ${esc(x.name)}">Merge into ${esc(cur || 'current')}</button>
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
    toast(`Now on ${target}.`, 'ok');
  } catch (e) {
    if (shelved) await git('stashPop', repo, 'stash@{0}').catch(() => {});
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
    const r = await busy(repo, 'Merging…', () => git('merge', repo, name));
    await afterMaybeConflict(repo, r, /Already up to date/i.test(r.output || '') ? `${st.branch} already has everything from ${name}.` : `Merged ${name} into ${st.branch}.`);
    if (state.tab === 'branches') loadBranches();
  } catch (e) { showError("Couldn't merge", e); }
}

async function branchMenu(repo, name) {
  const b = state.branches?.local.find((x) => x.name === name);
  if (!b) return;
  const c = await choose(name, '', [
    { id: 'rename', label: 'Rename…' },
    ...(b.current ? [] : [{ id: 'delete', label: 'Delete…', desc: 'Removes the branch from your computer (and optionally the server).', kind: 'danger' }]),
  ]);
  if (c === 'rename') {
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
    try { await git('deleteBranch', repo, name, opts); toast(`Deleted ${name}.`, 'ok'); }
    catch (e) {
      if (/not fully merged/i.test(e.message)) {
        const force = await confirmBox('This branch has unmerged work', `<p><b>${esc(name)}</b> has commits that aren't in any other branch. If you delete it, those commits will be lost.</p>`, 'Delete anyway', true);
        if (!force) return;
        try { await git('deleteBranch', repo, name, { ...opts, force: true }); toast(`Deleted ${name}.`, 'ok'); }
        catch (e2) { showError("Couldn't delete", e2); }
      } else showError("Couldn't delete", e);
    }
    loadBranches();
  }
}

// ---------- history ----------
async function loadHistory() {
  const repo = currentRepo();
  try { state.history = await git('history', repo); }
  catch (e) { state.history = { error: e.message }; }
  if (state.tab === 'history' && samePath(currentRepo(), repo)) renderHistoryTab();
}

function refTags(refs) {
  return refs.map((r) => {
    if (r === 'HEAD') return '';
    if (r.startsWith('HEAD -> ')) return `<span class="tag current">${esc(r.slice(8))}</span>`;
    if (r.startsWith('tag: ')) return `<span class="tag">🏷 ${esc(r.slice(5))}</span>`;
    return `<span class="tag ${r.includes('/') ? 'remote' : ''}">${esc(r)}</span>`;
  }).join(' ');
}

function commitRow(c, unpushed) {
  return `<div class="commit ${state.selCommit === c.hash ? 'selected' : ''}" data-action="select-commit" data-hash="${c.hash}">
    <div class="commit-subject">${esc(c.subject)} ${unpushed ? '<span class="tag ahead" title="Committed on your computer but not sent to the server yet">not sent</span>' : ''} ${refTags(c.refs)}</div>
    <div class="commit-meta">${esc(c.author)} · ${timeAgo(c.date)} · <span class="mono">${c.short}</span>${c.parents.length > 1 ? ' · merge' : ''}</div>
  </div>`;
}

function renderHistoryTab() {
  const body = $('#tab-body');
  const h = state.history;
  if (!h) { body.innerHTML = '<div class="empty muted"><span class="spinner"></span> Loading…</div>'; return; }
  if (h.error) { body.innerHTML = `<pre class="raw">${esc(h.error)}</pre>`; return; }
  const unpushed = new Set(h.unpushed);
  if (!state.selCommit && h.commits[0]) state.selCommit = h.commits[0].hash;
  body.innerHTML = `<div class="split">
    <div class="pane-left scroll">
      ${h.incoming.length ? `<div class="incoming"><div class="incoming-head"><b>On the server, not on your computer yet (${h.incoming.length})</b><button class="btn small primary" data-action="pull" data-repo="${esc(currentRepo())}">↓ Get latest</button></div>
        ${h.incoming.map((c) => commitRow(c, false)).join('')}</div>` : ''}
      ${h.commits.length ? h.commits.map((c) => commitRow(c, unpushed.has(c.hash))).join('') : '<div class="empty muted">No commits yet.</div>'}
    </div>
    <div class="pane-right" id="commit-pane"></div>
  </div>`;
  loadCommitDetails();
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
  const isHead = h.commits[0]?.hash === hash;
  const canUndo = isHead && d.parents.length === 1 && (!h.upstream || h.unpushed.includes(hash));
  const [subject, ...rest] = d.message.split('\n');
  pane.innerHTML = `<div class="commit-detail">
      <div class="cd-subject">${esc(subject)}</div>
      ${rest.join('\n').trim() ? `<pre class="cd-body">${esc(rest.join('\n').trim())}</pre>` : ''}
      <div class="cd-meta">${esc(d.author)} &lt;${esc(d.email)}&gt; · ${new Date(d.date * 1000).toLocaleString()} · <span class="mono">${d.hash.slice(0, 10)}</span></div>
      ${canUndo ? `<div class="cd-actions"><button class="btn small" data-action="undo-commit" title="git reset --soft HEAD~1">↶ Undo this commit</button><span class="hint">Your changes go back to the Changes tab, nothing is lost. Only possible because it hasn't been sent yet.</span></div>` : ''}
    </div>
    <div class="diff-scroll">${renderDiff(d.diff)}</div>`;
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
  body.innerHTML = `${intro}
    <div class="toolbar"><button class="btn primary" data-action="shelve" data-repo="${esc(repo)}" ${changes ? '' : 'disabled'}>Put my ${changes ? plural(changes, 'change') : 'changes'} on the Shelf…</button></div>
    <div class="split">
      <div class="pane-left scroll">${list.length ? list.map((s) => `<div class="commit ${s.ref === state.selStash ? 'selected' : ''}" data-action="select-stash" data-ref="${esc(s.ref)}">
        <div class="commit-subject">${esc(s.message.replace(/^\[(auto|discarded)\] /, ''))} ${/^\[discarded\]/.test(s.message) ? '<span class="tag">discarded</span>' : ''}${/^\[auto\]/.test(s.message) ? '<span class="tag">auto</span>' : ''}</div>
        <div class="commit-meta">from ${esc(s.branch)} · ${timeAgo(s.time)}</div>
      </div>`).join('') : '<div class="empty muted">The Shelf is empty.</div>'}</div>
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

async function shelve(repo) {
  const name = await ask('Put changes on the Shelf', {
    label: 'Name (optional) — so you remember what this was',
    placeholder: 'e.g. half-done refactor of login',
    help: 'All your uncommitted changes (including new files) will be set aside and your folder will match your last commit.',
    okLabel: 'Put on Shelf',
  });
  if (name === null) return;
  try { await busy(repo, 'Shelving…', () => git('stashSave', repo, name)); toast('Changes are on the Shelf.', 'ok'); if (state.tab === 'shelf') loadShelf(); }
  catch (e) { showError("Couldn't shelve", e); }
}

// ---------- conflicts ----------
function conflictLabels(st) {
  return st.op ? { ours: st.op.ours, theirs: st.op.theirs } : { ours: 'Your current files', theirs: 'From the Shelf' };
}

function parseConflicts(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const segs = [];
  let cur = { type: 'text', lines: [] };
  let mode = 'text';
  for (const line of text.split(/\r?\n/)) {
    if (mode === 'text' && line.startsWith('<<<<<<<')) {
      segs.push(cur);
      cur = { type: 'conflict', ours: [], base: [], theirs: [] };
      mode = 'ours';
    } else if (mode !== 'text' && line.startsWith('|||||||') && mode === 'ours') mode = 'base';
    else if (mode !== 'text' && line.startsWith('=======') && (mode === 'ours' || mode === 'base')) mode = 'theirs';
    else if (mode === 'theirs' && line.startsWith('>>>>>>>')) {
      segs.push(cur);
      cur = { type: 'text', lines: [] };
      mode = 'text';
    } else if (mode === 'text') cur.lines.push(line);
    else cur[mode].push(line);
  }
  if (mode !== 'text') return null; // unbalanced markers — let the user use their editor
  segs.push(cur);
  return { segs, eol, count: segs.filter((s) => s.type === 'conflict').length };
}

function pickLines(seg, choice, custom) {
  switch (choice) {
    case 'ours': return seg.ours;
    case 'theirs': return seg.theirs;
    case 'both': return [...seg.ours, ...seg.theirs];
    case 'both-rev': return [...seg.theirs, ...seg.ours];
    case 'edit': return (custom ?? [...seg.ours, ...seg.theirs].join('\n')).split(/\r?\n/);
    default: return null;
  }
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
  state.conflict = { file, loading: true, choices: {}, custom: {} };
  renderConflictList();
  let data;
  try { data = await git('readConflict', repo, file); }
  catch (e) { showError("Couldn't read the file", e); return; }
  if (state.conflict?.file !== file) return;
  state.conflict = { file, data, parsed: data.content != null ? parseConflicts(data.content) : null, choices: {}, custom: {} };
  renderConflictPane();
}

const XY_TEXT = {
  UU: () => 'Both sides changed this file.',
  AA: () => 'Both sides added a file with this name.',
  UD: (L) => `<b>${esc(L.ours)}</b> changed this file, but <b>${esc(L.theirs)}</b> deleted it.`,
  DU: (L) => `<b>${esc(L.ours)}</b> deleted this file, but <b>${esc(L.theirs)}</b> changed it.`,
  AU: (L) => `Added by <b>${esc(L.ours)}</b>.`,
  UA: (L) => `Added by <b>${esc(L.theirs)}</b>.`,
  DD: () => 'Both sides deleted this file.',
};

function renderConflictPane() {
  const pane = $('#conflict-pane');
  const c = state.conflict;
  if (!pane || !c || c.loading) return;
  const repo = currentRepo();
  const st = state.status[repo] || {};
  const L = conflictLabels(st);
  const entry = (st.conflicted || []).find((f) => f.path === c.file) || { xy: 'UU' };
  const scroll = pane.querySelector('.conflict-scroll')?.scrollTop || 0;
  const head = `<div class="diff-head wrap">
      <div><b>${esc(c.file)}</b><div class="small">${(XY_TEXT[entry.xy] || XY_TEXT.UU)(L)}</div></div>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="open-file" data-path="${esc(c.file)}">Open in ${esc(editorName())}</button>
      <button class="btn small" data-action="resolve-side" data-side="ours" title="git checkout --ours">Keep whole file: ${esc(L.ours)}</button>
      <button class="btn small" data-action="resolve-side" data-side="theirs" title="git checkout --theirs">Keep whole file: ${esc(L.theirs)}</button>
    </div>`;
  const p = c.parsed;
  if (!c.data.exists || c.data.binary || !p || !p.count) {
    const why = !c.data.exists ? "The file was deleted on one side, so there's nothing to compare line by line."
      : c.data.binary ? "It's a binary file (image, dll…), so it can't be compared line by line."
      : !p ? 'The conflict markers in this file look damaged, so it\'s safest to fix it in your editor.'
      : 'No conflict markers are left in this file — maybe you fixed it in your editor.';
    pane.innerHTML = `${head}<div class="empty"><p>${why}</p><p>Use the <b>Keep whole file</b> buttons above, or fix it in your editor and then:</p>
      <button class="btn primary" data-action="mark-resolved">Mark as resolved</button></div>`;
    return;
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
  pane.innerHTML = `${head}<div class="conflict-scroll">${blocks}</div>
    <div class="conflict-foot"><span>${decided} of ${p.count} decided</span><div class="spacer"></div>
      <button class="btn primary" data-action="save-resolution" ${decided === p.count ? '' : 'disabled'}>Save &amp; mark resolved</button></div>`;
  pane.querySelector('.conflict-scroll').scrollTop = scroll;
}

async function saveResolution() {
  const repo = currentRepo();
  const c = state.conflict;
  const content = c.parsed.segs.map((s, i) => (s.type === 'text' ? s.lines : pickLines(s, c.choices[i], c.custom[i]))).flat().join(c.parsed.eol);
  try { await git('saveResolution', repo, c.file, content); toast(`${basename(c.file)} resolved.`, 'ok'); state.conflict = null; await refreshAll(); }
  catch (e) { showError("Couldn't save", e); }
}

// ---------- workspace-wide actions ----------
async function forEachRepo(label, repos, fn) {
  return Promise.all(repos.map(async (repo) => {
    try { return { repo, ...(await busy(repo, label, () => fn(repo))) }; }
    catch (e) { return { repo, ok: false, msg: explain(e.message) || 'Failed', raw: e.message }; }
  }));
}

async function wsFetch() {
  const w = currentWs();
  const results = await forEachRepo('Checking…', w.repos, async (repo) => { await git('fetch', repo); state.lastFetch[repo] = Date.now(); return { ok: true }; });
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
  });
  resultsModal('Get latest — results', results);
}

async function wsPush() {
  const w = currentWs();
  const targets = w.repos.filter((p) => { const st = state.status[p] || {}; return !st.error && !st.missing && !st.detached && !st.initial && (st.ahead || !st.upstream); });
  if (!targets.length) { toast('Nothing to send — no repo has unsent commits.', 'ok'); return; }
  const results = await forEachRepo('Sending…', targets, async (repo) => {
    const r = await git('push', repo);
    if (r.rejected) return { ok: false, warn: true, msg: 'the server has newer commits — get latest first' };
    return { ok: true, msg: r.published ? 'branch published' : 'sent' };
  });
  resultsModal('Send — results', results);
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
  const results = await forEachRepo('Creating branch…', r.values.repos || [], async (repo) => { await git('createBranch', repo, name, null); return { ok: true, msg: `created ${name}` }; });
  resultsModal('New branch — results', results);
}

async function wsSwitch() {
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
    title: 'Switch all repos to a branch',
    body: `<label class="field"><span>Branch</span><select name="name">${sorted.map(([n, c]) => `<option value="${esc(n)}">${esc(n)} — in ${c} of ${w.repos.length} repos</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="create"> Create the branch in repos that don't have it</label>
      <p class="hint">Uncommitted changes come along. If a repo can't switch safely it's left alone and you'll be told.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Switch', kind: 'primary' }],
  });
  if (r.id !== 'ok' || !r.values.name) return;
  const name = r.values.name;
  const results = await forEachRepo(`Switching to ${name}…`, w.repos, async (repo) => {
    const b = info.find((x) => x.repo === repo)?.b;
    const st = state.status[repo] || {};
    if (st.branch === name) return { ok: true, msg: 'already on it' };
    if (b?.local.some((x) => x.name === name)) { await git('switchBranch', repo, name); return { ok: true, msg: 'switched' }; }
    const remote = b?.remote.find((x) => x.branch === name);
    if (remote) { await git('checkoutRemote', repo, remote.name, name); return { ok: true, msg: 'downloaded from server and switched' }; }
    if (r.values.create) { await git('createBranch', repo, name, null); return { ok: true, msg: `created from ${st.branch}` }; }
    return { ok: false, warn: true, msg: "doesn't have this branch — left as is" };
  });
  resultsModal(`Switch to ${name} — results`, results);
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

async function addRepo(wsId) {
  const folder = await api.pickFolder('Choose a repo folder');
  if (!folder) return;
  const r = await addRepoPath(wsId, folder);
  if (!r) return;
  renderSidebar();
  if (state.view.type === 'workspace' && state.view.ws === r.w.id) renderWorkspaceCards();
  else openWorkspace(r.w.id);
}

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
  toast('Cloning… this can take a minute for big repos.', 'info');
  try {
    const dest = await git('clone', r.values.url, parent);
    const added = await addRepoPath(r.values.ws, dest);
    toast(`Cloned into ${dest}.`, 'ok');
    renderSidebar();
    if (added) openRepo(added.path, added.w.id);
  } catch (e) { showError("Couldn't clone", e); }
}

// ---------- settings & help ----------
async function openSettings() {
  const s = state.config.settings;
  const id = await git('getIdentity').catch(() => ({ name: '', email: '' }));
  const known = Object.keys(EDITORS);
  const r = await modal({
    title: 'Settings',
    body: `<h3>Who you are</h3>
      <p class="hint">Stamped on every commit you make (stored in git's global config, so VS Code/Cursor/Visual Studio use it too).</p>
      <label class="field"><span>Your name</span><input name="name" value="${esc(id.name)}"></label>
      <label class="field"><span>Your email</span><input name="email" value="${esc(id.email)}" placeholder="Use the same email as your GitHub/Azure account"></label>
      <h3>Editor</h3>
      <label class="field"><span>“Open in editor” uses</span><select name="editor">${known.map((k) => `<option value="${k}" ${s.editor === k ? 'selected' : ''}>${EDITORS[k]}</option>`).join('')}<option value="__custom" ${known.includes(s.editor) ? '' : 'selected'}>Other command…</option></select></label>
      <label class="field"><span>Other command (if chosen above)</span><input name="custom" value="${known.includes(s.editor) ? '' : esc(s.editor)}" placeholder="e.g. rider64"></label>
      <h3>Automatic checking</h3>
      <label class="field"><span>Check servers for updates every … minutes (0 = never)</span><input name="fetch" type="number" min="0" max="120" value="${s.autoFetchMinutes}"></label>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Save', kind: 'primary' }],
  });
  if (r.id !== 'ok') return;
  const v = r.values;
  s.editor = v.editor === '__custom' ? v.custom.trim() || 'code' : v.editor;
  s.autoFetchMinutes = Math.max(0, Number(v.fetch) || 0);
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
    ['Merge conflict', 'When two branches changed <b>the same lines</b>, git can\'t guess which is right, so it asks you. You pick “yours”, “theirs”, or both, per clash. Nothing is lost, and you can abort to go back.'],
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
      <p class="hint">Curious what's really happening? Open “Behind the scenes” at the bottom — every git command this app runs is listed there with its output.</p>`,
  });
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
  'toggle-ws': (t, e) => { e.stopPropagation(); const w = state.config.workspaces.find((x) => x.id === t.dataset.ws); w.collapsed = !w.collapsed; saveConfig(); renderSidebar(); },
  'add-repo': (t, e) => { e.stopPropagation(); addRepo(t.dataset.ws || state.view.ws); },
  'open-repo': (t) => openRepo(t.dataset.repo, t.dataset.ws),
  'remove-repo': async (t) => {
    const repo = t.dataset.repo;
    const w = ensureWorkspace(state.view.ws);
    if (!(await confirmBox('Remove from workspace?', `<p>Remove <b>${esc(basename(repo))}</b> from <b>${esc(w.name)}</b>? The folder and its files are <b>not</b> deleted.</p>`, 'Remove'))) return;
    w.repos = w.repos.filter((p) => !samePath(p, repo));
    await saveConfig();
    openWorkspace(w.id);
  },
  'ws-rename': async () => { const w = currentWs(); const n = await ask('Rename workspace', { label: 'Name', value: w.name, okLabel: 'Rename' }); if (n) { w.name = n; await saveConfig(); openWorkspace(w.id); } },
  'ws-delete': async () => {
    const w = currentWs();
    if (!(await confirmBox(`Remove workspace “${w.name}”?`, '<p>This only removes the grouping from this app. Your repo folders are <b>not</b> touched.</p>', 'Remove', true))) return;
    state.config.workspaces = state.config.workspaces.filter((x) => x !== w);
    await saveConfig();
    state.view = { type: 'home' };
    rerender();
  },
  'ws-fetch': () => wsFetch(),
  'ws-pull': () => wsPull(),
  'ws-push': () => wsPush(),
  'ws-new-branch': () => wsNewBranch(),
  'ws-switch': () => wsSwitch(),
  'ws-open-editor': async () => { const r = await api.openInEditor(state.config.settings.editor, currentWs().repos); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-editor': async (t) => { const r = await api.openInEditor(state.config.settings.editor, [t.dataset.repo]); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-file': async (t, e) => { e.stopPropagation(); const r = await api.openInEditor(state.config.settings.editor, [`${currentRepo()}\\${t.dataset.path.replace(/\//g, '\\')}`]); if (!r.ok) showError("Couldn't open the editor", new Error(r.error)); },
  'open-folder': (t) => api.openFolder(t.dataset.repo),
  'open-terminal': (t) => api.openTerminal(t.dataset.repo),
  'open-web': async (t) => { const url = await git('remoteWebUrl', t.dataset.repo).catch(() => null); if (url) api.openUrl(url); else toast('This repo has no web address (no server configured).', 'warn'); },
  tab: (t, e) => { e.preventDefault(); setTab(t.dataset.tab); },
  fetch: (t) => doFetch(t.dataset.repo),
  pull: (t) => doPull(t.dataset.repo),
  push: (t) => doPush(t.dataset.repo),
  'select-file': (t) => { state.selected[currentRepo()] = t.dataset.path; document.querySelectorAll('#file-list .file').forEach((f) => f.classList.toggle('selected', f === t)); refreshDiff(); },
  'check-file': (t, e) => { e.stopPropagation(); state.checked[currentRepo()][t.dataset.path] = t.checked; renderFileList(); },
  'check-all': (t) => { const c = state.checked[currentRepo()]; for (const k of Object.keys(c)) c[k] = t.checked; renderFileList(); },
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
  'select-stash': (t) => { state.selStash = t.dataset.ref; document.querySelectorAll('.commit').forEach((c) => c.classList.toggle('selected', c === t)); loadStashPreview(); },
  'stash-pop': async (t) => { const repo = currentRepo(); try { const r = await busy(repo, 'Restoring…', () => git('stashPop', repo, t.dataset.ref)); await afterMaybeConflict(repo, r, 'Restored to your folder.'); loadShelf(); } catch (e) { showError("Couldn't restore", e); } },
  'stash-apply': async (t) => { const repo = currentRepo(); try { const r = await busy(repo, 'Restoring…', () => git('stashApply', repo, t.dataset.ref)); await afterMaybeConflict(repo, r, 'Copied into your folder (still on the Shelf too).'); } catch (e) { showError("Couldn't restore", e); } },
  'stash-drop': async (t) => {
    const repo = currentRepo();
    if (!(await confirmBox('Delete from the Shelf?', '<p>These changes will be gone for good.</p>', 'Delete', true))) return;
    try { await git('stashDrop', repo, t.dataset.ref); state.selStash = null; await refreshAll(); loadShelf(); } catch (e) { showError("Couldn't delete", e); }
  },
  'open-conflict': (t) => openConflict(t.dataset.path),
  pick: (t) => { const c = state.conflict; c.choices[t.dataset.i] = t.dataset.choice; renderConflictPane(); },
  'save-resolution': () => saveResolution(),
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
  if (fn) fn(t, e);
});

document.addEventListener('input', (e) => {
  const repo = currentRepo();
  if (e.target.id === 'commit-summary' || e.target.id === 'commit-body') {
    state.commitMsg[repo] = { summary: $('#commit-summary').value, body: $('#commit-body').value };
    updateCommitButtons();
  } else if (e.target.classList.contains('custom') && state.conflict) {
    state.conflict.custom[e.target.dataset.i] = e.target.value;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey && (e.target.id === 'commit-summary' || e.target.id === 'commit-body')) {
    e.preventDefault();
    if (!$('#commit-btn').disabled) $('#commit-btn').click();
  }
  if (e.key === 'F5') { e.preventDefault(); refreshAll(true); }
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

async function init() {
  state.config = await api.getConfig();
  api.onLog(addLog);
  renderLog();
  const first = state.config.workspaces[0];
  if (first) { await refreshAll(); openWorkspace(first.id); } else renderHome();
  refreshAll(true);
  // Poll often while the window is focused, rarely in the background; refresh as soon as you come back.
  let lastPoll = 0;
  setInterval(() => {
    const gap = document.hasFocus() ? 3000 : 15000;
    if (Date.now() - lastPoll >= gap) { lastPoll = Date.now(); refreshAll(); }
  }, 1000);
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
