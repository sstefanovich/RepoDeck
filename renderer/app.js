'use strict';

// Rendering entry, event handling (data-action buttons, keyboard) and start-up. Loaded last.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

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
  'new-repo': () => newRepo(state.view.ws),
  settings: () => openSettings(),
  help: () => openHelp(),
  'console-toggle': () => toggleConsole(),
  'console-clear': () => { consoleClear(); $('#console-input')?.focus(); },
  'console-stop': () => { consoleStop(); $('#console-input')?.focus(); },
  'console-help': () => { if (currentRepo()) consoleLine(currentRepo(), CONSOLE_HELP); $('#console-input')?.focus(); },
  'console-terminal': () => { const r = currentRepo(); if (r) api.openTerminal(r); },
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
  'open-pr-web': (t) => api.openUrl(t.dataset.url),
  'ws-search-clear': () => { state.wsQuery = ''; $('#ws-search').value = ''; $('#ws-results').innerHTML = ''; },
  'ws-hit-commit': (t) => openCommitIn(t.dataset.repo, t.dataset.hash, t.dataset.on),
  'ws-hit-branch': (t) => { state.branchFilter = t.dataset.name; openRepo(t.dataset.repo, state.view.ws, 'branches'); },
  'add-tag': (t) => addTag(currentRepo(), t.dataset.hash),
  'delete-tag': (t) => deleteTag(currentRepo(), t.dataset.name),
  'push-tag': async (t) => { const repo = currentRepo(); try { await busy(repo, 'Sending tag…', () => git('pushTag', repo, t.dataset.name)); toast(`Sent ${t.dataset.name} to the server.`, 'ok'); } catch (e) { showError("Couldn't send the tag", e); } },
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
  'open-pr': (t) => openPullRequest(t.dataset.repo || currentRepo()),
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
  'close-tab': (t) => { closePopover(); closeTab(t.dataset.key); },
  'tab-close-set': (t) => { closePopover(); closeTabs(tabCloseSets(t.dataset.key)[t.dataset.which], t.dataset.key); },
  'copy-path': async (t) => { closePopover(); await navigator.clipboard.writeText(t.dataset.repo).catch(() => {}); toast('Folder path copied.', 'ok'); },
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
  'ws-commit': () => wsCommit(),
  'ws-prs': () => wsPullRequests(),
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
  'pick-line': (t) => { const k = state.diffKeys; if (k) { setLinesPicked(k.repo, k.path, [t.dataset.key], t.checked); afterPick(); } },
  'pick-hunk': (t) => {
    const k = state.diffKeys;
    if (!k) return;
    const keys = [...document.querySelectorAll(`#diff-pane .dl[data-h="${t.dataset.h}"] [data-action=pick-line]`)].map((b) => b.dataset.key);
    setLinesPicked(k.repo, k.path, keys, t.checked);
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
  recover: (t) => recoverLostWork(t.dataset.repo || currentRepo()),
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
  // A choice in a menu or the branch switcher closes it first, so whatever opens next
  // (a dialog, another menu) isn't left underneath it.
  if (t.closest('.popover')) closePopover();
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
  if (e.ctrlKey && !e.shiftKey && e.code === 'Backquote') { e.preventDefault(); toggleConsole(); return; }
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
  state.tokens = await api.host.tokens().catch(() => ({ ado: false, github: false }));
  api.onLog(addLog);
  initConsole();
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
  applyAssistant();
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
  window.addEventListener('focus', () => { lastPoll = Date.now(); refreshAll(); loadPrStatus(currentRepo()); });
  // Pull request status changes on the server (reviews, builds); loadPrStatus limits itself to every 5 minutes.
  setInterval(() => { if (document.hasFocus()) loadPrStatus(currentRepo()); }, 60000);
  setTimeout(backgroundFetch, 5000);
  setInterval(backgroundFetch, 60000);
  const id = await git('getIdentity').catch(() => null);
  if (id && (!id.name || !id.email)) {
    const go = await confirmBox('One-time setup', '<p>Git needs your <b>name and email</b> to stamp on your commits. It isn\'t set on this computer yet.</p>', 'Set them now');
    if (go) openSettings();
  }
}

init();
