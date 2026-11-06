'use strict';

// Pull requests: creating one (GitHub, Azure DevOps or in the browser) and showing their status.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- creating a pull request ----------
// With a token for the repo's server, the pull request is created here; otherwise its page opens in the browser.
async function openPullRequest(repo) {
  closePopover();
  let st = state.status[repo] || {};
  const inBrowser = async () => {
    const url = await gitRaw('prUrl', repo, st.branch).catch(() => null);
    if (url) api.openUrl(url); else toast("Couldn't work out the pull request page for this server.", 'warn');
  };
  if (!st.branch) { toast("You're not on a branch.", 'warn'); return; }
  const info = await api.host.info(repo);
  if (!info.ok || !info.data.kind || !info.data.hasToken) return inBrowser();
  if (!st.upstream || st.ahead) {
    const c = await choose(st.upstream ? 'Send your commits first?' : 'Publish the branch first?',
      `<p>${st.upstream ? `${plural(st.ahead, 'commit')} on <b>${esc(st.branch)}</b> ${st.ahead === 1 ? "isn't" : "aren't"} on the server yet, so the pull request wouldn't include ${st.ahead === 1 ? 'it' : 'them'}.` : `<b>${esc(st.branch)}</b> isn't on the server yet. A pull request needs the branch there.`}</p>`,
      [{ id: 'send', label: st.upstream ? 'Send, then create the pull request' : 'Publish, then create the pull request', kind: 'primary' }]);
    if (c !== 'send') return;
    if (!(await doPush(repo, { quiet: true }))) return;
    st = state.status[repo];
  }
  return createPrDialog(repo, info.data);
}

async function createPrDialog(repo, info) {
  const st = state.status[repo];
  const remote = st.upstream.split('/')[0];
  const br = await gitRaw('branches', repo).catch(() => null);
  const targets = (br?.remote || []).filter((b) => b.remote === remote && b.branch !== st.branch).map((b) => b.branch);
  const target0 = [info.defaultBranch, 'main', 'master', 'develop'].find((b) => b && targets.includes(b)) || targets[0];
  if (!target0) { toast('There is no other branch on the server to merge into.', 'warn'); return; }
  const compareTo = (target) => gitRaw('compare', repo, `${remote}/${target}`, 'HEAD').catch(() => null);
  let cmp = await compareTo(target0);
  const draft = prDraft(st.branch, cmp?.commits);
  const summary = (c) => (c ? `${plural(c.commits.length, 'commit')}, ${plural(c.files.length, 'file')} changed` : "Couldn't compare the branches.");
  const ado = info.kind === 'ado';
  const wi = ado && state.config.settings.workItems !== false ? workItemFromBranch(st.branch) : null;
  let descTouched = false;
  const r = await modal({
    title: `Create a pull request on ${ado ? 'Azure DevOps' : 'GitHub'}`,
    wide: true,
    body: `<div class="setup-grid">
        <div class="field"><span>From</span><div><b>${esc(st.branch)}</b></div></div>
        <label class="field"><span>Into</span><select name="target">${targets.map((b) => `<option ${b === target0 ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
      </div>
      <p class="hint" id="pr-summary">${summary(cmp)}</p>
      <label class="field"><span>Title</span><input name="title" value="${esc(draft.title)}"></label>
      <label class="field"><span class="row-inline">Description${aiOn() ? ' <button class="btn small ghost" type="button" id="pr-write">✦ Write description</button>' : ''}</span>
        <textarea name="description" rows="8" placeholder="What changed and why. Markdown works.">${esc(draft.description)}</textarea></label>
      ${ado ? `<label class="field"><span>Work item (Azure Boards)</span><input name="workItem" value="${esc(wi || '')}" inputmode="numeric" placeholder="none"></label>` : ''}
      <label class="check"><input type="checkbox" name="draft"> Draft (not ready for review yet)</label>`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'web', label: 'Open in browser instead' }, { id: 'ok', label: 'Create pull request', kind: 'primary' }],
    init: (el) => {
      const desc = el.querySelector('[name=description]');
      const title = el.querySelector('[name=title]');
      const ok = el.querySelector('[data-close=ok]');
      desc.addEventListener('input', () => { descTouched = true; });
      title.addEventListener('input', () => { ok.disabled = !title.value.trim(); });
      el.querySelector('[name=target]').addEventListener('change', async (e) => {
        el.querySelector('#pr-summary').textContent = 'Comparing…';
        cmp = await compareTo(e.target.value);
        el.querySelector('#pr-summary').textContent = summary(cmp);
        if (!descTouched) desc.value = prDraft(st.branch, cmp?.commits).description;
      });
      el.querySelector('#pr-write')?.addEventListener('click', async (e) => {
        const b = e.currentTarget;
        const target = el.querySelector('[name=target]').value;
        b.disabled = true;
        b.innerHTML = '<span class="spinner sm"></span> Writing…';
        try {
          const commits = (cmp?.commits || []).map((c) => `- ${c.subject}`).join('\n');
          const files = (cmp?.files || []).slice(0, 80).map((f) => `${f.code} ${f.path}${f.add != null ? ` (+${f.add} -${f.del})` : ''}`).join('\n');
          const prompt = `Write a pull request title and description for merging the branch ${st.branch} into ${target}.\nLook at the changes with: git diff ${remote}/${target}...HEAD\n\nCommits:\n${commits}\n\nFiles:\n${files}\n\nReply with ONLY: the title (under 72 characters) on the first line, a blank line, then the description in Markdown: one or two sentences on what and why, then a short bullet list of the main changes. No preamble, no code fences around the whole reply.`;
          const res = await api.claude.oneShot(repo, prompt);
          if (!res.ok) throw new Error(res.error === 'NOT_FOUND' ? "Couldn't find the Claude Code app (claude.exe). Set its location in Settings → Claude." : res.error);
          const [t, ...rest] = res.text.trim().split('\n');
          title.value = t.replace(/^#+\s*|^Title:\s*/i, '').trim();
          desc.value = rest.join('\n').trim();
          descTouched = true;
          ok.disabled = !title.value.trim();
        } catch (err) { toast(err.message, 'bad'); }
        finally { b.disabled = false; b.textContent = '✦ Write description'; }
      });
    },
  });
  if (r.id === 'web') { const url = await gitRaw('prUrl', repo, st.branch).catch(() => null); if (url) api.openUrl(url); return; }
  if (r.id !== 'ok' || !r.values.title.trim()) return;
  const v = r.values;
  const workItems = ado && /^\d+$/.test((v.workItem || '').replace(/^AB#/i, '').trim()) ? [v.workItem.replace(/^AB#/i, '').trim()] : [];
  const res = await busy(repo, 'Creating pull request…', () => api.host.createPr(repo, { source: st.branch, target: v.target, title: v.title.trim(), description: v.description.trim(), draft: v.draft, workItems }));
  if (!res.ok) { showError("Couldn't create the pull request", Object.assign(new Error(res.error), { code: res.code })); return; }
  toast(`Pull request #${res.data.id} created.`, 'ok', { label: 'Open it', fn: () => api.openUrl(res.data.url) });
  loadPrStatus(repo, true);
}

// ---------- pull request status (GitHub, Azure DevOps) ----------
// Fetched by the main process (which holds the token); refreshed at most every 5 minutes per branch
// unless `force` (after Check for updates or Send).
const prLoaded = {}; // norm(repo) -> { branch, time }
async function loadPrStatus(repo, force = false) {
  const st = state.status[repo] || {};
  if (!(state.tokens.ado || state.tokens.github) || !repo || !st.branch || !st.hasRemote) return;
  const k = norm(repo);
  const last = prLoaded[k];
  if (!force && last && last.branch === st.branch && Date.now() - last.time < 5 * 60000) return;
  prLoaded[k] = { branch: st.branch, time: Date.now() };
  const r = await api.host.prStatus(repo, st.branch);
  const data = r.ok ? r.data : { error: r.error, code: r.code };
  if (data.supported === false || data.noToken) delete state.prStatus[k];
  else state.prStatus[k] = { ...data, branch: st.branch };
  if (samePath(repo, currentRepo()) && $('#repo-header')) updateRepoChrome();
}

function prChipHtml(repo) {
  const st = state.status[repo] || {};
  const pr = state.prStatus[norm(repo)];
  if (!pr || pr.branch !== st.branch || pr.none) return '';
  if (pr.error) return `<span class="pr-chip muted" title="${esc(pr.error)}">PR status unavailable</span>`;
  const open = (label, cls, tip) => `<button class="pr-chip ${cls}" data-action="open-pr-web" data-url="${esc(pr.url)}" title="${esc(tip)}">${label}</button>`;
  if (pr.status === 'completed') return open(`PR #${pr.id} completed ✓`, 'ok', `${pr.title} — merged into ${pr.target}`);
  if (pr.status === 'abandoned') return open(`PR #${pr.id} abandoned`, 'muted', pr.title);
  const bits = [];
  if (pr.rejected) bits.push('✕ rejected');
  else if (pr.waiting) bits.push('↺ changes asked');
  else if (pr.approved) bits.push(`✓ ${pr.approved} approved`);
  else bits.push('waiting for review');
  const b = pr.checks?.builds;
  if (b?.failed) bits.push('✕ build failed');
  else if (b?.running) bits.push('⏳ build running');
  else if (b?.total && b.passed === b.total) bits.push('✓ build passed');
  const bad = pr.rejected || b?.failed;
  const good = !bad && pr.approved && pr.checks && !pr.checks.blocking;
  const reviewers = pr.reviewers.map((r) => `${r.name}: ${r.vote >= 10 ? 'approved' : r.vote >= 5 ? 'approved with suggestions' : r.vote === -5 ? 'waiting for author' : r.vote === -10 ? 'rejected' : 'no vote yet'}`).join('\n');
  return open(`PR #${pr.id}${pr.draft ? ' (draft)' : ''} · ${bits.join(' · ')}`, bad ? 'bad' : good ? 'ok' : '', `${pr.title} → ${pr.target}${reviewers ? `\n\n${reviewers}` : ''}${good ? '\n\nReady to complete.' : ''}`);
}
