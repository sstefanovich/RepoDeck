'use strict';

// The sidebar, the tab bar, the home page and the workspace overview.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- sidebar ----------
function badgesHtml(st, repo = null) {
  if (!st) return '';
  if (st.missing) return '<span class="badge bad" title="Folder not found">missing</span>';
  if (st.error) return '<span class="badge bad" title="Not a git repo">error</span>';
  const out = [];
  const w = repo && workWarning(repo);
  if (w) out.push(`<span class="badge wrong" title="${esc(w.kind === 'base' ? `Work on ${st.branch} itself. It usually goes on its own branch.` : `${st.branch} is already finished. These changes probably belong on a new branch.`)}">⚠</span>`);
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
    return `<div class="ws" data-ws="${w.id}">
      <div class="ws-head ${active ? 'active' : ''}" data-action="open-ws" data-ws="${w.id}">
        <span class="caret" data-action="toggle-ws" data-ws="${w.id}">${w.collapsed ? '▸' : '▾'}</span>
        <span class="ws-name">${esc(w.name)}</span>
        <button class="icon-btn" data-action="add-repo" data-ws="${w.id}" title="Add a repo folder to this workspace">＋</button>
      </div>
      ${w.collapsed ? '' : `<div class="ws-repos">${w.repos.map((p) => {
        const st = state.status[p];
        const activeRepo = samePath(currentRepo(), p) && state.view.ws === w.id;
        const branch = st?.detached ? 'detached' : st?.branch || '';
        return `<div class="repo-item ${activeRepo ? 'active' : ''}" draggable="${ws.length > 1}" data-action="open-repo" data-repo="${esc(p)}" data-ws="${w.id}" title="${esc(p)}${ws.length > 1 ? '\nDrag onto another workspace to move it there (hold Ctrl to copy)' : ''}">
          <div class="ri-top"><span class="ri-name">${esc(basename(p))}</span>${busyLabel(p) ? `<span class="spinner sm" role="status" aria-label="${esc(busyLabel(p))}"></span>` : ''}</div>
          <div class="ri-bottom"><button class="ri-branch" data-action="branch-switcher" data-repo="${esc(p)}" title="Switch branch" ${st && !st.error && !st.missing ? '' : 'disabled'}>⎇ ${esc(branch)}</button><span class="ri-badges">${badgesHtml(st, p)}</span></div>
        </div>`;
      }).join('') || '<div class="muted small pad">No repos yet — click ＋</div>'}</div>`}
    </div>`;
  }).join('');
}

// Drag a repo in the sidebar onto another workspace to move it there (hold Ctrl to copy it instead).
let dragRepo = null; // { path, ws } of the repo being dragged
const repoDropTarget = (e) => { const w = e.target.closest?.('#ws-list .ws'); return w && w.dataset.ws !== dragRepo?.ws ? w : null; };
const clearRepoDrag = () => document.querySelectorAll('.ws.drop-target, .repo-item.dragging').forEach((x) => x.classList.remove('drop-target', 'dragging'));
document.addEventListener('dragstart', (e) => {
  const r = e.target.closest?.('.repo-item[draggable=true]');
  if (!r) return;
  dragRepo = { path: r.dataset.repo, ws: r.dataset.ws };
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', r.dataset.repo);
  r.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  if (!dragRepo) return;
  const w = repoDropTarget(e);
  document.querySelectorAll('.ws.drop-target').forEach((x) => { if (x !== w) x.classList.remove('drop-target'); });
  if (!w) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
  w.classList.add('drop-target');
});
document.addEventListener('dragend', () => { dragRepo = null; clearRepoDrag(); });
document.addEventListener('drop', (e) => {
  if (!dragRepo) return;
  const w = repoDropTarget(e);
  const d = dragRepo;
  dragRepo = null;
  clearRepoDrag();
  if (!w) return;
  e.preventDefault();
  moveRepoTo(d.path, d.ws, w.dataset.ws, e.ctrlKey);
});

// Moves (or copies) a repo between workspaces, keeping its tab, with Undo.
async function moveRepoTo(repo, fromId, toId, copy = false) {
  const all = state.config.workspaces;
  const from = all.find((w) => w.id === fromId);
  const to = all.find((w) => w.id === toId);
  if (!to) return;
  const name = basename(repo);
  const saved = [[from, from && [...from.repos]], [to, [...to.repos]]];
  if (!moveRepo(all, repo, fromId, toId, copy)) { toast(`${name} is already in ${to.name}.`, 'info'); return; }
  // An open tab of a moved repo now belongs to the workspace it went to.
  const retarget = (a, b) => {
    for (const t of state.tabs) if (t.type === 'repo' && t.ws === a && samePath(t.path, repo)) t.ws = b;
    if (state.view.type === 'repo' && state.view.ws === a && samePath(state.view.path, repo)) state.view.ws = b;
  };
  if (!copy) retarget(fromId, toId);
  const redraw = async () => {
    await saveConfig();
    persistTabs();
    renderSidebar();
    renderTabbar();
    if (state.view.type === 'workspace' && currentWs()) openWorkspace(state.view.ws);
  };
  await redraw();
  toast(copy ? `Added ${name} to ${to.name} too.` : `Moved ${name} to ${to.name}.`, 'ok', {
    label: 'Undo',
    fn: async () => {
      for (const [w, repos] of saved) if (w && all.includes(w)) w.repos = repos;
      if (!copy) retarget(toId, fromId);
      await redraw();
    },
  });
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

// Closes several tabs at once. If the active tab goes, `prefer` (when still open) takes its place,
// otherwise the nearest open tab to its right, then to its left.
function closeTabs(keys, prefer = null) {
  const drop = new Set(keys);
  if (!drop.size) return;
  const old = state.tabs;
  state.tabs = old.filter((x) => !drop.has(tabKey(x)));
  if (drop.has(state.activeTab)) {
    const i = old.findIndex((x) => tabKey(x) === state.activeTab);
    const open = (x) => !drop.has(tabKey(x));
    const next = state.tabs.find((x) => tabKey(x) === prefer) || old.slice(i + 1).find(open) || old.slice(0, i).reverse().find(open);
    if (next) activateTab(tabKey(next));
    else showNoTab();
  }
  persistTabs();
  renderTabbar();
}

// Which tabs each "Close …" item of a tab's right-click menu would close.
function tabCloseSets(key) {
  const keys = state.tabs.map(tabKey);
  const i = keys.indexOf(key);
  const t = state.tabs[i];
  return {
    others: keys.filter((k) => k !== key),
    right: keys.slice(i + 1),
    left: keys.slice(0, i),
    all: keys,
    // Tabs that belong to a different workspace than this one.
    otherWs: t?.ws ? state.tabs.filter((x) => x.ws && x.ws !== t.ws).map(tabKey) : [],
  };
}

function openTabMenu(e, key) {
  const t = state.tabs.find((x) => tabKey(x) === key);
  if (!t) return;
  const sets = tabCloseSets(key);
  const w = state.config.workspaces.find((x) => x.id === t.ws);
  const item = (action, label, { which, hint = '', disabled = false } = {}) => `<button class="menu-item" role="menuitem" data-action="${action}" data-key="${esc(key)}" ${which ? `data-which="${which}"` : ''} ${t.path ? `data-repo="${esc(t.path)}"` : ''} ${disabled ? 'disabled' : ''}><span>${label}</span>${hint ? `<span class="muted small">${hint}</span>` : ''}</button>`;
  const closeItem = (which, label) => item('tab-close-set', label, { which, hint: sets[which].length ? String(sets[which].length) : '', disabled: !sets[which].length });
  popover({ getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY - 4 }) }, `<div role="menu">
    ${item('close-tab', 'Close', { hint: 'Ctrl+W' })}
    ${closeItem('others', 'Close others')}
    ${closeItem('right', 'Close tabs to the right')}
    ${closeItem('left', 'Close tabs to the left')}
    ${w && sets.otherWs.length ? closeItem('otherWs', `Close tabs not in ${esc(w.name)}`) : ''}
    ${closeItem('all', 'Close all')}
    ${t.type === 'repo' ? `<div class="menu-sep"></div>
      ${item('open-editor', `Open in ${esc(editorName())}`)}
      ${item('open-folder', 'Show in File Explorer')}
      ${item('copy-path', 'Copy folder path')}` : ''}
  </div>`, { width: 250, onOpen: (el) => el.querySelector('button:not(:disabled)')?.focus() });
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
  updateConsole(); // the console follows the repo on screen
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
  markTabRows();
  bar.querySelector('.dtab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Tabs wrap onto more rows when they don't fit. Only the bottom row joins the page below,
// so tabs in the rows above are drawn as whole boxes.
function markTabRows() {
  const tabs = [...$('#tabbar').querySelectorAll('.dtab')];
  const bottom = Math.max(...tabs.map((t) => t.offsetTop));
  for (const t of tabs) t.classList.toggle('upper-row', t.offsetTop < bottom - 2);
}
new ResizeObserver(() => markTabRows()).observe(document.querySelector('#tabbar'));

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
document.addEventListener('contextmenu', (e) => {
  const t = e.target.closest?.('.dtab');
  if (!t) return;
  e.preventDefault();
  openTabMenu(e, t.dataset.key);
});

// ---------- home ----------
function renderHome() {
  $('#view').innerHTML = `<div class="home">
    <h1>Welcome to RepoDeck 👋</h1>
    <p class="lead">A calmer way to work with git — with plain-English buttons, and several repos side by side.</p>
    <div class="home-cards">
      <div class="hcard"><h3>Already have a repo on your computer?</h3><p>Pick its folder — the one you cloned into. You can also just <b>drag the folder onto this window</b>.</p><button class="btn primary" data-action="open-repo-folder">📂 Open repo folder…</button></div>
      <div class="hcard"><h3>Need to download one?</h3><p>Clone a repo from GitHub, Azure DevOps, GitLab… using its URL.</p><button class="btn" data-action="clone">⤓ Clone a repo</button></div>
      <div class="hcard"><h3>Starting something new?</h3><p>Turn any folder into a repo, save your files as the first commit, and put it on GitHub or Azure DevOps in one go.</p><button class="btn" data-action="new-repo">＋ New repo from a folder</button></div>
      <div class="hcard"><h3>Work on several repos together?</h3><p>A <b>workspace</b> groups repos you use together — e.g. the three repos of one project — so you can see them side by side and pull, push or branch all of them at once.</p><button class="btn" data-action="new-ws">▦ New workspace</button></div>
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
      <button class="btn" data-action="ws-commit" title="git commit — the same commit message in several repos">✓ Commit in all…</button>
      <button class="btn" data-action="ws-prs" title="A pull request from each repo's branch, with the same title and description">⇄ Pull requests for all…</button>
      <span class="sep"></span>
      <button class="btn" data-action="ws-new-branch" title="git switch -c — the same new branch in several repos">⎇ New branch in all…</button>
      <button class="btn" data-action="ws-switch" title="git switch — move every repo to the same branch">⇄ Switch all to branch…</button>
      <button class="btn" data-action="ws-update-from" title="Bring the new commits from dev, main or any branch into every repo">⤓ Update all from…</button>
      <span class="sep"></span>
      <button class="btn" data-action="ws-tidy" title="Delete branches that were merged or deleted on the server">🧹 Tidy up branches…</button>
      <button class="btn" data-action="ws-open-editor">Open all in ${esc(editorName())}</button>
      <button class="btn ghost" data-action="add-repo" data-ws="${w.id}">＋ Add repo</button>
    </div>
    <div class="ws-search-row">
      <input class="filter ws-search" id="ws-search" placeholder="Find a commit or branch in every repo — message, author, hash or branch name" spellcheck="false" aria-label="Search every repo" value="${esc(state.wsQuery || '')}">
    </div>
    <div id="ws-results"></div>
    <div id="ws-align"></div>
    <div id="ws-cards" class="cards"></div>
  </div>`;
  renderWorkspaceCards();
  let timer = 0;
  $('#ws-search').addEventListener('input', (e) => {
    state.wsQuery = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => searchWorkspace(id), 300);
  });
  if (state.wsQuery) searchWorkspace(id);
}

// Searches every repo of the workspace at once; results are grouped by repo.
async function searchWorkspace(wsId) {
  const el = $('#ws-results');
  const w = currentWs();
  const q = (state.wsQuery || '').trim();
  if (!el || !w) return;
  if (q.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="ws-results"><span class="spinner sm"></span> Searching…</div>';
  const repos = w.repos.filter((p) => !state.status[p]?.error && !state.status[p]?.missing);
  const found = await Promise.all(repos.map(async (repo) => ({ repo, ...(await gitRaw('search', repo, q).catch(() => ({ branches: [], commits: [] }))) })));
  if ((state.wsQuery || '').trim() !== q || state.view.ws !== wsId || !$('#ws-results')) return;
  const hits = found.filter((f) => f.branches.length || f.commits.length);
  const n = hits.reduce((s, f) => s + f.branches.length + f.commits.length, 0);
  el.innerHTML = `<div class="ws-results">
    <div class="ws-results-head"><b>${n ? `${plural(n, 'match', 'matches')} in ${plural(hits.length, 'repo')}` : `Nothing matches “${esc(q)}” in any repo.`}</b>
      <button class="btn small ghost" data-action="ws-search-clear">Clear</button></div>
    ${hits.map((f) => `<div class="ws-hit-repo"><h3>${esc(basename(f.repo))}</h3>
      ${f.branches.map((b) => `<button class="ws-hit" data-action="ws-hit-branch" data-repo="${esc(f.repo)}" data-name="${esc(b.name)}">
        <span>⎇ <b>${esc(b.name)}</b></span><span class="muted small">${b.remote ? 'branch on the server' : 'branch'}</span></button>`).join('')}
      ${f.commits.map((c) => `<button class="ws-hit" data-action="ws-hit-commit" data-repo="${esc(f.repo)}" data-hash="${c.hash}" data-on="${esc(c.on || '')}">
        <span><span class="mono">${c.short}</span> ${esc(c.subject)}</span>
        <span class="muted small">${esc(c.author)} · ${timeAgo(c.date)}${c.on ? ` · on ${esc(c.on)}` : ''}</span></button>`).join('')}
    </div>`).join('')}
  </div>`;
}

// Opens a search result: the commit in the History of the branch it's on.
function openCommitIn(repo, hash, on) {
  openRepo(repo, state.view.ws);
  const cur = state.status[repo]?.branch;
  state.histRef = on && on !== cur ? on : null;
  state.histNotIn = false;
  state.histFile = null;
  state.histQuery = '';
  state.selCommit = hash;
  state.history = null;
  setTab('history');
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
  if (st.upstreamGone) return 'Deleted on the server';
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
