'use strict';

// The Branches tab: switching, creating, finishing and deleting branches.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- branches ----------
async function loadBranches() {
  const repo = currentRepo();
  try { [state.branches, state.tags] = await Promise.all([git('branches', repo), gitRaw('tags', repo).catch(() => [])]); }
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
    <h3>Tags <span class="muted small">(${(state.tags || []).length})</span></h3>
    <p class="hint">A <b>tag</b> is a permanent label on one commit, usually a release like v1.2.0. Add one from a commit in History.</p>
    <div class="rows">${(state.tags || []).map((t) => `<div class="row" data-name="${esc(t.name)}">
      <div class="row-main"><div class="row-title">🏷 ${esc(t.name)}</div>
        <div class="row-sub"><span class="mono">${t.commit.slice(0, 7)}</span>${t.message ? ` · ${esc(t.message)}` : ''}${t.date ? ` · ${timeAgo(t.date)}` : ''}</div></div>
      <div class="row-actions">
        ${st.hasRemote ? `<button class="btn small ghost" data-action="push-tag" data-name="${esc(t.name)}" title="git push origin ${esc(t.name)}">↑ Send</button>` : ''}
        <button class="btn small ghost danger-text" data-action="delete-tag" data-name="${esc(t.name)}">Delete…</button>
      </div></div>`).join('') || '<div class="muted pad">No tags yet.</div>'}</div>
  </div>`;
  const filter = $('#branch-filter');
  const apply = () => {
    const q = filter.value.toLowerCase();
    state.branchFilter = filter.value;
    body.querySelectorAll('.row[data-name]').forEach((r) => { r.style.display = r.dataset.name.toLowerCase().includes(q) ? '' : 'none'; });
  };
  filter.value = state.branchFilter || '';
  filter.addEventListener('input', apply);
  if (filter.value) apply();
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
