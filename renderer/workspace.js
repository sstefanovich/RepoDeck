'use strict';

// Actions on every repo of a workspace at once.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

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

// One undo for a commit made in several repos: each goes back to where it was, keeping the changes.
function recordMultiCommitUndo(label, moved) {
  if (!moved.length) return;
  recordUndo({
    label,
    repos: moved.map((m) => m.repo),
    check: async () => {
      for (const m of moved) { const why = await moveUndoBlocked(m.repo, m.branch, m.after); if (why) return why; }
      return null;
    },
    run: async () => {
      const res = await forEachRepo('Undoing…', moved.map((m) => m.repo), async (repo) => {
        const m = moved.find((x) => x.repo === repo);
        await undoMove(repo, m.before, m.after, true);
        return { ok: true };
      });
      const bad = (res || []).filter((x) => !x.ok);
      if (bad.length) throw new Error(bad.map((x) => `${basename(x.repo)}: ${x.raw || x.msg}`).join('\n'));
    },
  });
}

// The same commit (message, work item) in several repos: everything changed in each ticked repo.
async function wsCommit() {
  const w = currentWs();
  const ready = (p) => { const st = state.status[p] || {}; return !st.error && !st.missing && !st.detached && !st.conflicted?.length && changedFiles(st).length > 0; };
  const repos = w.repos.filter(ready);
  if (!repos.length) { toast('No repo has changes to commit.', 'ok'); return; }
  const showWi = state.config.settings.workItems !== false;
  const wi = showWi ? repos.map((p) => workItemFromBranch(state.status[p].branch)).find(Boolean) || '' : '';
  const r = await modal({
    title: 'Commit in several repos',
    wide: true,
    body: `<div class="field"><span>Commit in</span>${repos.map((p) => {
        const st = state.status[p];
        const files = changedFiles(st);
        return `<label class="check ws-commit-row" title="${esc(files.map((f) => f.path).join('\n'))}"><input type="checkbox" name="repos" data-multi="1" value="${esc(p)}" checked>
          <b>${esc(basename(p))}</b> <span class="muted small">on ${esc(st.branch)} · ${plural(files.length, 'changed file')}</span></label>`;
      }).join('')}</div>
      <label class="field"><span>Summary</span><input name="summary" value="${esc(state.config.settings.commitTemplate || '')}" placeholder="What did you change? e.g. Add the login page"></label>
      <label class="field"><span>Description (optional)</span><textarea name="body" rows="3"></textarea></label>
      ${showWi ? `<label class="field"><span>Work item (Azure Boards)</span><input name="workItem" value="${esc(wi)}" inputmode="numeric" placeholder="none"></label>` : ''}
      <label class="check"><input type="checkbox" name="send"> Send each repo to the server afterwards</label>
      <p class="hint">Every changed file in each ticked repo is included. To pick single files or lines, commit from that repo's Changes tab.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Commit', kind: 'primary' }],
    init: (el) => {
      const sum = el.querySelector('[name=summary]');
      const ok = el.querySelector('[data-close=ok]');
      const upd = () => { ok.disabled = !sum.value.trim() || !el.querySelector('[name=repos]:checked'); };
      el.addEventListener('input', upd);
      el.addEventListener('change', upd);
      upd();
    },
  });
  const picked = r.values.repos || [];
  if (r.id !== 'ok' || !picked.length || !r.values.summary?.trim()) return;
  const v = r.values;
  const message = withWorkItem(v.body.trim() ? `${v.summary.trim()}\n\n${v.body.trim()}` : v.summary.trim(), v.workItem);
  // The file check asks per repo, so it runs one repo at a time before anything is committed.
  const plan = new Map();
  for (const repo of picked) {
    const c = await checkBeforeCommit(repo, { paths: null, all: true }, { inRepoName: picked.length > 1 });
    if (c) plan.set(repo, c);
  }
  const skipped = picked.filter((p) => !plan.has(p));
  const before = Object.fromEntries(await Promise.all([...plan.keys()].map(async (p) => [p, await gitRaw('headOid', p).catch(() => null)])));
  const results = await forEachRepo('Committing…', [...plan.keys()], async (repo) => {
    const c = plan.get(repo);
    await git('commit', repo, { message, paths: c.paths || [], all: c.all });
    if (!v.send) return { ok: true, msg: `committed to ${state.status[repo]?.branch}` };
    const p = await git('push', repo).catch((e) => ({ error: e }));
    if (p.error) return { ok: false, warn: true, msg: `committed, but couldn't send: ${explain(p.error.message) || 'failed'}`, raw: p.error.message };
    if (p.rejected) return { ok: false, warn: true, msg: 'committed, but the server has newer commits — get latest, then send' };
    return { ok: true, msg: p.published ? 'committed and branch published' : 'committed and sent' };
  }, (repo) => ['commit', repo, { message, paths: plan.get(repo).paths || [], all: plan.get(repo).all }]);
  if (!results) return;
  for (const repo of plan.keys()) clearPicks(repo);
  const moved = [];
  for (const res of results.filter((x) => x.ok || x.warn)) {
    const after = await gitRaw('headOid', res.repo).catch(() => null);
    if (after && before[res.repo] && after !== before[res.repo] && !v.send) moved.push({ repo: res.repo, before: before[res.repo], after, branch: state.status[res.repo]?.branch });
  }
  recordMultiCommitUndo(`commit “${v.summary.trim()}” in ${plural(moved.length, 'repo')}`, moved);
  const all = [...results, ...skipped.map((repo) => ({ repo, ok: false, warn: true, msg: 'skipped — cancelled at the file check' }))];
  resultsModal('Commit in several repos — results', all, moved.length ? 'Changed your mind? <b>↶ Undo…</b> takes the commits back out of every repo, keeping the changes.' : '');
}

// A pull request from each repo's branch, with the same title and description (one feature across repos).
async function wsPullRequests() {
  const w = currentWs();
  const MAIN = ['main', 'master', 'develop'];
  const repos = w.repos.filter((p) => { const st = state.status[p] || {}; return st.hasRemote && st.branch && !MAIN.includes(st.branch) && !st.error && !st.missing; });
  if (!repos.length) { toast('No repo is on a feature branch that is on a server.', 'info'); return; }
  const rows = await Promise.all(repos.map(async (repo) => {
    const st = state.status[repo];
    const info = await api.host.info(repo).then((x) => (x.ok ? x.data : {})).catch(() => ({}));
    const b = await gitRaw('branches', repo).catch(() => null);
    const remote = st.upstream?.split('/')[0] || 'origin';
    const targets = (b?.remote || []).filter((x) => x.remote === remote && x.branch !== st.branch).map((x) => x.branch);
    const target = [info.defaultBranch, ...MAIN].find((x) => x && targets.includes(x)) || targets[0] || '';
    const pr = state.prStatus[norm(repo)];
    const open = pr?.branch === st.branch && pr.status === 'active' ? pr : null;
    return { repo, st, info, targets, target, open, inApp: !!(info.kind && info.hasToken) };
  }));
  const first = rows[0].st.branch;
  const ado = rows.some((x) => x.info.kind === 'ado');
  const wi = ado && state.config.settings.workItems !== false ? rows.map((x) => workItemFromBranch(x.st.branch)).find(Boolean) || '' : null;
  const r = await modal({
    title: 'Pull requests for several repos',
    wide: true,
    body: `<div class="field"><span>Create one in</span>${rows.map((x, i) => `<div class="ws-pr-row">
        <label class="check"><input type="checkbox" name="repos" data-multi="1" value="${i}" ${x.open || !x.target ? '' : 'checked'} ${x.target ? '' : 'disabled'}>
          <b>${esc(basename(x.repo))}</b> <span class="muted small">${esc(x.st.branch)}${x.st.ahead || !x.st.upstream ? ` · ${x.st.upstream ? `${plural(x.st.ahead, 'unsent commit')} (sent first)` : 'not on the server yet (published first)'}` : ''}</span></label>
        <span class="muted small">into</span> <select name="t${i}" aria-label="Target branch for ${esc(basename(x.repo))}">${x.targets.map((t) => `<option ${t === x.target ? 'selected' : ''}>${esc(t)}</option>`).join('') || '<option value="">no other branch</option>'}</select>
        <span class="tag ${x.open ? 'warn' : x.inApp ? 'ok' : ''}">${x.open ? `has PR #${x.open.id}` : x.inApp ? 'created here' : 'opens in browser'}</span>
      </div>`).join('')}</div>
      <label class="field"><span>Title</span><input name="title" value="${esc(prTitleFromBranch(first))}"></label>
      <label class="field"><span>Description</span><textarea name="description" rows="5" placeholder="What changed and why. Markdown works."></textarea></label>
      <label class="check"><input type="checkbox" name="mention" checked> Mention the other repos in each description</label>
      ${wi != null ? `<label class="field"><span>Work item (Azure Boards)</span><input name="workItem" value="${esc(wi)}" inputmode="numeric" placeholder="none"></label>` : ''}
      <label class="check"><input type="checkbox" name="draft"> Draft (not ready for review yet)</label>
      ${rows.some((x) => !x.inApp) ? '<p class="hint">Repos marked <i>opens in browser</i> have no token for their server (Settings), so their pull request page opens for you to finish there.</p>' : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Create pull requests', kind: 'primary' }],
  });
  const picked = (r.values.repos || []).map(Number).map((i) => ({ ...rows[i], target: r.values[`t${i}`] })).filter((x) => x.target);
  if (r.id !== 'ok' || !picked.length || !r.values.title?.trim()) return;
  const v = r.values;
  const others = (repo) => picked.filter((x) => x.repo !== repo).map((x) => basename(x.repo));
  const describe = (repo) => {
    const o = others(repo);
    return [v.description.trim(), v.mention && o.length ? `Part of a change across ${o.length + 1} repos; also see the pull requests in ${o.join(', ')}.` : ''].filter(Boolean).join('\n\n');
  };
  const workItems = /^\d+$/.test(String(v.workItem || '').replace(/^AB#/i, '').trim()) ? [String(v.workItem).replace(/^AB#/i, '').trim()] : [];
  const browser = [];
  const results = await forEachRepo('Creating pull request…', picked.map((x) => x.repo), async (repo) => {
    const x = picked.find((y) => y.repo === repo);
    if (x.st.ahead || !x.st.upstream) {
      const p = await git('push', repo);
      if (p.rejected) return { ok: false, warn: true, msg: 'the server has newer commits on this branch — get latest, then try again' };
    }
    if (!x.inApp) {
      const url = await gitRaw('prUrl', repo, x.st.branch).catch(() => null);
      if (!url) return { ok: false, warn: true, msg: "couldn't work out the pull request page for this server" };
      browser.push(url);
      return { ok: true, warn: true, msg: 'opened in your browser to finish there', url };
    }
    const res = await api.host.createPr(repo, { source: x.st.branch, target: x.target, title: v.title.trim(), description: describe(repo), draft: v.draft, workItems: x.info.kind === 'ado' ? workItems : [] });
    if (!res.ok) return { ok: false, msg: res.error };
    return { ok: true, msg: `pull request #${res.data.id} into ${x.target}`, url: res.data.url };
  });
  if (!results) return;
  for (const url of browser) api.openUrl(url);
  for (const x of picked) loadPrStatus(x.repo, true);
  resultsModal('Pull requests — results', results);
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
