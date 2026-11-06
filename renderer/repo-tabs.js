'use strict';

// Tags, the Compare tab, the Shelf and the Conflicts tab.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- tags ----------
async function addTag(repo, hash) {
  const st = state.status[repo] || {};
  const r = await modal({
    title: 'Add a tag',
    body: `<label class="field"><span>Tag name</span><input name="name" placeholder="e.g. v1.2.0" spellcheck="false"></label>
      <label class="field"><span>Message (optional — makes a release-style tag with your name and the date)</span><textarea name="message" rows="2" placeholder="e.g. First public release"></textarea></label>
      ${st.hasRemote ? '<label class="check"><input type="checkbox" name="send" checked> Send it to the server straight away</label>' : ''}
      <p class="hint">On commit <span class="mono">${hash.slice(0, 7)}</span>.</p>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: '🏷 Add tag', kind: 'primary' }],
    init: (el) => { const i = el.querySelector('[name=name]'); i.addEventListener('input', () => { i.value = i.value.replace(/\s+/g, '-'); }); },
  });
  const name = r.values.name?.trim();
  if (r.id !== 'ok' || !name) return;
  if (!(await gitRaw('checkTagName', name))) { showError('Invalid tag name', new Error(`'${name}' is not a valid tag name. Use letters, numbers, dots and dashes, e.g. v1.2.0.`)); return; }
  try {
    await busy(repo, 'Tagging…', () => git('createTag', repo, name, hash, r.values.message.trim()));
    if (r.values.send) await busy(repo, 'Sending tag…', () => git('pushTag', repo, name));
    toast(`Tagged ${hash.slice(0, 7)} as ${name}${r.values.send ? ' and sent it to the server' : ''}.`, 'ok');
    if (state.tab === 'history') loadHistory();
  } catch (e) { showError("Couldn't add the tag", e); }
}

async function deleteTag(repo, name) {
  const st = state.status[repo] || {};
  const r = await modal({
    title: `Delete the tag ${name}?`,
    body: `<p>The commit itself isn't touched — only the label is removed.</p>
      ${st.hasRemote ? '<label class="check"><input type="checkbox" name="remote"> Also delete it on the server</label>' : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete', kind: 'danger' }],
  });
  if (r.id !== 'ok') return;
  try {
    const { oid } = await git('deleteTag', repo, name, { remote: !!r.values.remote });
    undoToast(`Deleted the tag ${name}${r.values.remote ? ' (here and on the server)' : ''}.`, repo, `delete of the tag ${name}`, async () => {
      await git('restoreTag', repo, name, oid);
      if (r.values.remote) await git('pushTag', repo, name);
      loadBranches();
    });
    loadBranches();
  } catch (e) { showError("Couldn't delete the tag", e); }
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
