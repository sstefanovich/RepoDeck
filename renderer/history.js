'use strict';

// The History tab and commit graph, cherry-pick, and Recover lost work.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

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
  // Each group of lines gets a header saying which commit last changed them (fits any width).
  const head = (g) => {
    if (/^0+$/.test(g.hash)) return '<div class="bl-head"><span class="muted">Not committed yet</span></div>';
    const c = b.commits[g.hash];
    const from = g.lines[0].n;
    const to = g.lines[g.lines.length - 1].n;
    return `<div class="bl-head"><button class="bl-hash mono" data-action="blame-commit" data-hash="${g.hash}" title="Show this commit">${g.hash.slice(0, 7)}</button>
      <span class="bl-sum" title="${esc(c.summary)}">${esc(c.summary)}</span>
      <span class="bl-who">${esc(c.author)} · ${timeAgo(c.time)}</span>
      <button class="icon-btn bl-explain" data-action="blame-explain" data-hash="${g.hash}" data-from="${from}" data-to="${to}" title="Ask Claude why these lines were changed">✦</button></div>`;
  };
  const html = groups.map((g) => `<div class="bl-group">${head(g)}${g.lines.map((l) => `<div class="bl"><span class="ln">${l.n}</span><span class="code">${highlight(l.text, lang) || ' '}</span></div>`).join('')}</div>`).join('');
  const shaped = Object.keys(b.commits).filter((h) => !/^0+$/.test(h)).length;
  pane.innerHTML = `<div class="diff-head"><b>${esc(file)}</b><span class="muted small">${plural(shaped, 'commit')} shaped this file as it is now${b.truncated ? ' (showing the first 20,000 lines)' : ''}</span></div>
    <div class="diff-scroll blame-scroll"><div class="blame">${html}</div></div>`;
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

// ---------- recover lost work (reflog) ----------
// Everywhere this repo's HEAD has been, in plain English, with a way to bring back commits that
// are no longer on any branch (after a reset, a deleted branch, a rebase) and deleted Shelf items.
async function recoverLostWork(repo) {
  closePopover();
  const entries = await gitRaw('reflog', repo).catch(() => []);
  const lostCount = entries.filter((e) => e.lost).length;
  const row = (e) => `<div class="rec-row ${e.lost ? 'lost' : ''}" data-hash="${e.hash}" ${e.lost ? '' : 'data-kept="1"'}>
      <div class="rec-main">
        <span class="rec-what">${esc(reflogText(e.action))}</span>
        <span class="muted small">${timeAgo(e.time)} · <span class="mono">${e.short}</span>${e.subject && !e.action.includes(e.subject) ? ` · ${esc(e.subject)}` : ''}</span>
        ${e.lost ? '<span class="tag bad" title="No branch, tag or server copy has this commit">not on any branch</span>' : ''}
      </div>
      <div class="rec-actions">
        <button class="btn small ghost" type="button" data-rec="show">Show</button>
        <button class="btn small" type="button" data-rec="branch">Make a branch here…</button>
      </div>
      <div class="rec-detail" hidden></div>
    </div>`;
  const r = await modal({
    title: `Recover lost work in ${basename(repo)}`,
    wide: true,
    body: `<p class="intro">Git keeps a diary of everywhere this repo has been for about 90 days, even after a reset, a deleted branch or a rebase. Find the moment before things went wrong and make a branch there to get that work back.</p>
      <label class="check"><input type="checkbox" id="rec-only-lost" ${lostCount ? 'checked' : ''}> Only show work that isn't on any branch <span class="muted small">(${lostCount})</span></label>
      <div class="rec-list" id="rec-list">${entries.length ? entries.map(row).join('') : '<p class="muted">Nothing recorded yet.</p>'}</div>
      <h3>Deleted Shelf items</h3>
      <div class="rec-list" id="rec-shelf"><p class="muted"><span class="spinner sm"></span> Looking…</p></div>`,
    buttons: [{ id: 'ok', label: 'Close', kind: 'primary' }],
    init: (el) => {
      const filter = () => { const only = el.querySelector('#rec-only-lost').checked; el.querySelectorAll('#rec-list [data-kept]').forEach((x) => { x.hidden = only; }); };
      el.querySelector('#rec-only-lost').addEventListener('change', filter);
      filter();
      gitRaw('droppedShelf', repo).then((items) => {
        el.querySelector('#rec-shelf').innerHTML = items.length ? items.map((s) => `<div class="rec-row" data-hash="${s.hash}">
            <div class="rec-main"><span class="rec-what">${esc(s.message.replace(/^(WIP on|On) [^:]+: /, '').replace(/^\[\w+\] /, ''))}</span>
              <span class="muted small">deleted from the Shelf · made ${timeAgo(s.time)} · <span class="mono">${s.short}</span></span></div>
            <div class="rec-actions"><button class="btn small" type="button" data-rec="shelf" data-msg="${esc(s.message)}">Put back on the Shelf</button></div>
          </div>`).join('') : '<p class="muted">None found.</p>';
      }).catch(() => { el.querySelector('#rec-shelf').innerHTML = '<p class="muted">Couldn\'t look for them.</p>'; });
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-rec]');
        if (!b) return;
        const rowEl = b.closest('.rec-row');
        const hash = rowEl.dataset.hash;
        if (b.dataset.rec === 'show') {
          const d = rowEl.querySelector('.rec-detail');
          if (!d.hidden) { d.hidden = true; return; }
          d.hidden = false;
          d.innerHTML = '<span class="spinner sm"></span>';
          const c = await gitRaw('commitDetails', repo, hash).catch((err) => ({ error: err.message }));
          d.innerHTML = c.error ? `<pre class="raw">${esc(c.error)}</pre>` : `<div class="cd-meta">${esc(c.author)} · ${new Date(c.date * 1000).toLocaleString()}</div><pre class="cd-body">${esc(c.message)}</pre><div class="diff-scroll rec-diff">${renderDiff(c.diff)}</div>`;
        } else if (b.dataset.rec === 'branch') {
          const name = await ask('Make a branch here', { label: 'Branch name', value: `recovered/${hash.slice(0, 7)}`, transform: branchTransform, okLabel: 'Create branch',
            help: "The branch starts at this point, so everything up to here is safe again. You stay on your current branch." });
          if (!name) return;
          try {
            await git('restoreBranch', repo, name, hash);
            toast(`Made the branch ${name}. Switch to it from the branch menu to see the work.`, 'ok');
            rowEl.classList.remove('lost');
            rowEl.querySelector('.tag.bad')?.remove();
            refreshRepo(repo).then(() => onStatusChanged([repo]));
          } catch (err) { showError("Couldn't make the branch", err); }
        } else if (b.dataset.rec === 'shelf') {
          try {
            await git('stashStore', repo, hash, b.dataset.msg);
            toast('Put back on the Shelf.', 'ok');
            rowEl.remove();
            refreshRepo(repo).then(() => onStatusChanged([repo]));
          } catch (err) { showError("Couldn't put it back on the Shelf", err); }
        }
      });
    },
  });
  if (r.id && state.tab === 'shelf' && samePath(repo, currentRepo())) loadShelf();
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
  // A branch whose server copy was deleted has no upstream to compare with, but its commits were sent.
  const canUndo = isHead && d.parents.length === 1 && !state.status[repo]?.upstreamGone && (!h.upstream || h.unpushed.includes(hash));
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
        <button class="btn small ghost" data-action="add-tag" data-hash="${d.hash}" title="git tag — put a permanent label (like v1.2.0) on this commit">🏷 Add tag…</button>
        ${!state.histRef && !canUndo ? `<button class="btn small" data-action="revert-commit" data-hash="${d.hash}" data-subject="${esc(subject)}" title="git revert — a new commit that does the opposite">↺ Reverse this commit…</button>` : ''}
        ${canUndo ?`<button class="btn small" data-action="undo-commit" title="git reset --soft HEAD~1">↶ Undo this commit</button><span class="hint">Undo keeps your changes (they go back to the Changes tab). Possible because it hasn't been sent yet.</span>` : ''}
      </div>` : ''}
    </div>
    <div class="diff-scroll">${renderDiff(d.diff)}</div>`;
}
