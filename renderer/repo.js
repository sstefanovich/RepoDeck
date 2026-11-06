'use strict';

// The repo view: header and banners, the Changes tab, committing some lines, the commit check, and fetch / pull / push.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

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
    state.branches = state.tags = state.history = state.stashes = null;
    state.selCommit = state.selStash = state.conflict = null;
    state.histRef = null;
    state.cmp = null;
    state.branchFilter = state.branchFilter && tab === 'branches' ? state.branchFilter : '';
    state.blame = false;
    state.picks.clear();
    state.headKey = `${st.branch}|${st.oid}`;
  }
  state.tab = tab || (switching ? (st.conflicted?.length ? 'conflicts' : 'changes') : state.tab);
  renderSidebar();
  $('#view').innerHTML = '<div class="repo-view"><div id="repo-header" class="repo-header"></div><div id="op-banner"></div><div id="tabs" class="tabs"></div><div id="tab-body" class="tab-body"></div></div>';
  updateRepoChrome();
  renderTab();
  loadPrStatus(repo);
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
  if (headChanged) loadPrStatus(currentRepo());
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
  const prable = st.upstream && !st.upstreamGone && !st.ahead && !['main', 'master', 'develop'].includes(st.branch);
  const pushBtn = noServer
    ? `<button class="btn ${st.initial ? '' : 'primary'}" data-action="add-remote" data-repo="${esc(repo)}" ${d} title="git remote add — connect this repo to a server such as GitHub">⇪ Add server…</button>`
    : `<button class="btn ${st.ahead || (!st.upstream && !st.initial && !st.detached) ? 'primary' : ''}" data-action="push" data-repo="${esc(repo)}" ${d} title="git push — uploads your commits to the server">↑ ${st.upstream || st.detached ? 'Send' : 'Publish branch'}${st.ahead ? ` (${st.ahead})` : ''}</button>`;
  return `${top}
    <div class="rh-bar">
      <button class="branch-pill" data-action="branch-switcher" data-repo="${esc(repo)}" title="Switch to another branch, or create one" aria-haspopup="dialog">⎇ <b>${esc(branchLabel)}</b> <span class="pill-action">Switch branch ▾</span></button>
      <div class="sync-text" title="${esc(sync.replace(/<[^>]+>/g, ''))}">${sync}${checked ? ` <span class="muted small">(${checked})</span>` : ''}</div>
      ${prChipHtml(repo)}
      <div class="spacer"></div>
      ${busyHtml(repo)}
      ${prable && state.prStatus[norm(repo)]?.status !== 'active' ?`<button class="btn ghost" data-action="open-pr" data-repo="${esc(repo)}" title="Open the page for a pull request from ${esc(st.branch)}">⇄ Pull request</button>` : ''}
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

// Before a commit: looks for big files, likely secrets and build folders among the files about to go in,
// and lets the user leave them out (adding a .gitignore line where that makes sense).
// Returns { paths, all } to commit (unchanged if nothing was flagged or they chose to go ahead), or null to stop.
const ISSUE_ICONS = { large: '⚖', secret: '🔑', build: '📦' };
async function checkBeforeCommit(repo, { paths, all }, { inRepoName = false } = {}) {
  const issues = await gitRaw('commitCheck', repo, { paths, all }).catch(() => []);
  if (!issues.length) return { paths, all };
  const r = await modal({
    title: inRepoName ? `Check these before committing in ${basename(repo)}` : 'Check these before committing',
    wide: true,
    body: `<p class="intro">Some of these files are usually kept out of a repo. Once a file has been sent to a server it stays in the history, so it's worth a look now.</p>
      <div class="commit-issues">${issues.map((i, n) => `<label class="issue ${i.severe ? 'severe' : ''}">
        <input type="checkbox" name="i${n}" checked>
        <span class="issue-icon" aria-hidden="true">${ISSUE_ICONS[i.kind] || '•'}</span>
        <span class="issue-text"><b>${esc(i.path)}</b> <span class="muted">— ${esc(i.detail)}</span>
          <span class="hint">${i.ignore ? `Leave out, and add <code>${esc(i.ignore)}</code> to .gitignore so it stays out` : 'Leave this file out of the commit'}</span></span>
      </label>`).join('')}</div>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'anyway', label: 'Commit them anyway' }, { id: 'ok', label: 'Leave the ticked ones out', kind: 'primary' }],
  });
  if (r.id === 'anyway') return { paths, all };
  if (r.id !== 'ok') return null;
  const chosen = issues.filter((_, n) => r.values[`i${n}`]);
  if (!chosen.length) return { paths, all };
  const out = new Set(chosen.flatMap((i) => i.files));
  const patterns = chosen.map((i) => i.ignore).filter(Boolean);
  if (patterns.length) await gitRaw('ignorePatterns', repo, patterns);
  for (const f of out) if (state.checked[repo]) state.checked[repo][f] = false;
  let files = paths || [];
  if (all || !paths) {
    await refreshRepo(repo);
    files = changedFiles(state.status[repo]).flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
  }
  const keep = files.filter((p) => !out.has(p));
  if (patterns.length && !keep.includes('.gitignore')) keep.push('.gitignore');
  if (state.checked[repo] && patterns.length) state.checked[repo]['.gitignore'] = true;
  if (!keep.length) { toast('Nothing is left to commit.', 'info'); return null; }
  toast(`Left out ${plural(out.size, 'file')}${patterns.length ? ' and added them to .gitignore' : ''}.`, 'info');
  return { paths: keep, all: false };
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
  let some = partial && Object.keys(partial).length ? partial : null;
  let all = !some && files.length > 0 && ticked.length === files.length;
  let commitPaths = paths;
  if (ticked.length) {
    const checked = await checkBeforeCommit(repo, { paths, all });
    if (!checked) { updateRepoView(); return; }
    if (checked.paths !== paths) {
      ({ paths: commitPaths, all } = checked);
      if (some) { for (const k of Object.keys(some)) if (!commitPaths.includes(k)) delete some[k]; if (!Object.keys(some).length) some = null; }
    }
  }
  try {
    const before = await gitRaw('headOid', repo).catch(() => null);
    await busy(repo, amend ? 'Amending…' : 'Committing…', () => git('commit', repo, { message, paths: commitPaths, all, amend, partial: some }));
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
    loadPrStatus(repo, true);
  } catch (e) { if (!silent) showError("Couldn't check for updates", e, { repo, retry: () => doFetch(repo) }); else throw e; }
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
  } catch (e) { showError("Couldn't get the latest", e, { repo, retry: () => doPull(repo) }); return false; }
}

// quiet: no message on success (the caller carries on, e.g. to create a pull request).
async function doPush(repo, { quiet = false } = {}) {
  try {
    const r = await busy(repo, 'Sending…', () => git('push', repo));
    if (r.rejected) {
      const c = await choose('The server has newer commits', "<p>Someone else (or you, from another computer) sent commits to this branch. You need to get those first, then your commits can be sent on top.</p>", [
        { id: 'pull', label: 'Get latest, then send', desc: 'Recommended. Downloads their commits, combines with yours, then sends.', kind: 'primary' },
      ]);
      if (c === 'pull' && (await doPull(repo))) {
        const st = state.status[repo];
        if (!st.conflicted?.length && !st.op) return doPush(repo, { quiet });
      }
      return false;
    }
    loadPrStatus(repo, true);
    if (quiet) return true;
    const msg = r.published ? 'Branch published to the server.' : 'Sent to the server.';
    // The natural next step after sending a feature branch is a pull request.
    if (r.branch && !['main', 'master', 'develop'].includes(r.branch)) {
      const url = await gitRaw('prUrl', repo, r.branch).catch(() => null);
      if (url) { toast(msg, 'ok', { label: 'Pull request…', fn: () => openPullRequest(repo) }); return true; }
    }
    toast(msg, 'ok');
    return true;
  } catch (e) {
    if (e.code === 'NO_REMOTE') return addRemoteFlow(repo);
    showError("Couldn't send", e, { repo, retry: () => doPush(repo) });
    return false;
  }
}

async function addRemoteFlow(repo) {
  const st = state.status[repo] || {};
  const r = await modal({
    title: 'Put this repo on a server',
    wide: true,
    body: `<p class="intro">This repo only exists on your computer. Connect it to a repo on GitHub, Azure DevOps, GitLab… so you can send your work there. (This runs <code>git remote add origin &lt;url&gt;</code>.)</p>
      ${serverFieldsHtml(basename(repo))}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: st.initial ? 'Add server' : 'Add server & send', kind: 'primary' }],
    init: initServerFields,
  });
  if (r.id === 'settings') { await openSettings(); return addRemoteFlow(repo); }
  if (r.id !== 'ok') return false;
  let url;
  try { url = await resolveServer(r.values); } catch (e) { showError("Couldn't create the repo on the server", e); return false; }
  if (!url) { toast('Paste the server URL first.', 'warn'); return false; }
  try {
    await git('addRemote', repo, url);
    await refreshRepo(repo);
    onStatusChanged([repo]);
  } catch (e) { showError("Couldn't add the server", e); return false; }
  if (st.initial) { toast('Server added. Make your first commit, then Publish.', 'ok'); return true; }
  return publishNewRepo(repo);
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
