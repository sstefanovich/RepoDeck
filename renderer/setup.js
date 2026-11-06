'use strict';

// Adding repos: open, clone, workspaces, server repos, and setting up a new repo from a folder.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

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
  const info = await gitRaw('resolveRepo', folder);
  if (!info.isRepo) return setupNewRepo(wsId, folder, { notRepo: true });
  if (!samePath(info.path, folder)) toast(`Using the repo's top folder: ${info.path}`, 'info');
  return attachRepo(wsId, info.path);
}

// Puts a repo in a workspace (creating "My repos" if there is none) and loads its status.
async function attachRepo(wsId, repo) {
  const w = ensureWorkspace(wsId);
  if (!w.repos.some((p) => samePath(p, repo))) w.repos.push(repo);
  await saveConfig();
  await refreshRepo(repo);
  return { w, path: repo };
}

// Adds folder(s) to a workspace and opens the last one in a tab.
async function addRepos(wsId, folders) {
  let last = null;
  for (const folder of folders) last = (await addRepoPath(wsId, folder)) || last;
  if (!last || last.opened) return;
  renderSidebar();
  openRepo(last.path, last.w.id);
}

// ---------- choosing (or creating) the server repo ----------
// One block of fields for "where does this repo live": paste a URL, or create an empty repo on GitHub or
// Azure DevOps with the saved token. serverFieldsHtml + initServerFields go in a modal; resolveServer
// turns its values into a URL (creating the repo if asked) after the modal closes.
const safeRepoName = (s) => String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-repo';

// Azure DevOps organisations of the repos you already have, to suggest when creating a repo there.
async function knownAdoOrgs() {
  const orgs = new Set([state.config.settings.lastServer?.adoOrg].filter(Boolean));
  const urls = await Promise.all(allRepos().map((p) => gitRaw('remoteUrl', p).catch(() => null)));
  for (const u of urls) { const m = String(u || '').match(/dev\.azure\.com[:/](?:v3\/)?([^/]+)/i); if (m) orgs.add(m[1]); }
  return [...orgs];
}

function serverFieldsHtml(name, { optional = false } = {}) {
  const last = state.config.settings.lastServer || {};
  const mode = ['github', 'ado'].includes(last.mode) && state.tokens[last.mode] ? last.mode : 'url';
  const tokenHint = (svc) => `<p class="hint">To create repos from here, add ${svc} token in <a href="#" data-close="settings">Settings</a>. Or create the repo on the website and paste its URL.</p>`;
  return `<div class="seg server-mode" role="radiogroup" aria-label="Where the repo goes">
      ${[['url', 'Paste a URL'], ['github', 'Create on GitHub'], ['ado', 'Create in Azure DevOps']].map(([v, l]) => `<label class="seg-btn"><input type="radio" name="srvMode" value="${v}" ${v === mode ? 'checked' : ''}> ${l}</label>`).join('')}
    </div>
    <div class="srv-panel" data-mode="url">
      <p class="hint">${optional ? 'Leave it empty to keep the repo on your computer for now. ' : ''}Create an <b>empty</b> repo (no README, .gitignore or licence) and paste its URL:
        <a href="#" data-url="https://github.com/new">GitHub ↗</a> · <a href="#" data-url="https://dev.azure.com/">Azure DevOps ↗</a></p>
      <label class="field"><span>Server URL</span><input name="remote" placeholder="https://github.com/you/project.git" spellcheck="false"></label>
    </div>
    <div class="srv-panel" data-mode="github">
      ${state.tokens.github ? `<div class="setup-grid">
          <label class="field"><span>Owner</span><select name="ghOwner"><option value="">Loading…</option></select></label>
          <label class="field"><span>Repo name</span><input name="ghName" value="${esc(safeRepoName(name))}" spellcheck="false"></label>
        </div>
        <label class="check"><input type="checkbox" name="ghPrivate" ${last.ghPrivate === false ? '' : 'checked'}> Private (only people you invite can see it)</label>` : tokenHint('a GitHub')}
    </div>
    <div class="srv-panel" data-mode="ado">
      ${state.tokens.ado ? `<div class="setup-grid">
          <label class="field"><span>Organisation</span><input name="adoOrg" value="${esc(last.adoOrg || '')}" placeholder="e.g. acme (from dev.azure.com/acme)" list="ado-orgs" spellcheck="false"><datalist id="ado-orgs"></datalist></label>
          <label class="field"><span>Project</span><select name="adoProject"><option value="">Type the organisation first</option></select></label>
        </div>
        <label class="field"><span>Repo name</span><input name="adoName" value="${esc(safeRepoName(name))}" spellcheck="false"></label>` : tokenHint('an Azure DevOps')}
    </div>`;
}

function initServerFields(el) {
  const last = state.config.settings.lastServer || {};
  const show = () => {
    const mode = el.querySelector('[name=srvMode]:checked')?.value || 'url';
    el.querySelectorAll('.srv-panel').forEach((p) => { p.hidden = p.dataset.mode !== mode; });
    el.querySelectorAll('.server-mode .seg-btn').forEach((b) => b.classList.toggle('active', b.querySelector('input').checked));
    if (mode === 'github') loadOwners();
    if (mode === 'ado') loadProjects();
  };
  let ownersLoaded = false;
  const loadOwners = async () => {
    const sel = el.querySelector('[name=ghOwner]');
    if (!sel || ownersLoaded) return;
    ownersLoaded = true;
    const r = await api.host.githubOwners();
    sel.innerHTML = r.ok ? r.data.map((o) => `<option value="${esc(o.login)}" ${o.login === last.ghOwner ? 'selected' : ''}>${esc(o.login)}${o.type === 'org' ? ' (organisation)' : ''}</option>`).join('')
      : `<option value="">Couldn't load: ${esc(r.error)}</option>`;
  };
  let projectsFor = null;
  const loadProjects = async () => {
    const org = el.querySelector('[name=adoOrg]');
    const sel = el.querySelector('[name=adoProject]');
    if (!org || !sel || !org.value.trim() || projectsFor === org.value.trim()) return;
    projectsFor = org.value.trim();
    sel.innerHTML = '<option value="">Loading…</option>';
    const r = await api.host.adoProjects(projectsFor);
    if (projectsFor !== org.value.trim()) return; // typed on meanwhile
    sel.innerHTML = r.ok && r.data.length ? r.data.map((p) => `<option ${p.name === last.adoProject ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
      : `<option value="">${r.ok ? 'No projects found' : `Couldn't load: ${esc(r.error)}`}</option>`;
  };
  el.querySelectorAll('[name=srvMode]').forEach((i) => i.addEventListener('change', show));
  const orgInput = el.querySelector('[name=adoOrg]');
  orgInput?.addEventListener('change', loadProjects);
  if (orgInput) knownAdoOrgs().then((orgs) => {
    el.querySelector('#ado-orgs').innerHTML = orgs.map((o) => `<option value="${esc(o)}">`).join('');
    if (!orgInput.value && orgs[0]) { orgInput.value = orgs[0]; if (el.querySelector('[name=srvMode]:checked')?.value === 'ado') loadProjects(); }
  });
  show();
}

// -> the server URL ('' for none), creating the repo first when asked. Throws if creating fails.
async function resolveServer(v) {
  const mode = v.srvMode || 'url';
  const s = state.config.settings;
  if (mode === 'url') return (v.remote || '').trim();
  let r;
  if (mode === 'github') {
    if (!v.ghOwner) throw new Error('Pick who the repo belongs to.');
    r = await api.host.createRepo('github', { owner: v.ghOwner, name: safeRepoName(v.ghName), isPrivate: v.ghPrivate });
    s.lastServer = { ...s.lastServer, mode, ghOwner: v.ghOwner, ghPrivate: v.ghPrivate };
  } else {
    if (!v.adoOrg?.trim() || !v.adoProject) throw new Error('Pick the organisation and project.');
    r = await api.host.createRepo('ado', { org: v.adoOrg.trim(), project: v.adoProject, name: (v.adoName || '').trim() || 'my-repo' });
    s.lastServer = { ...s.lastServer, mode, adoOrg: v.adoOrg.trim(), adoProject: v.adoProject };
  }
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
  saveConfig();
  toast(`Created ${r.data.name} on ${mode === 'github' ? 'GitHub' : 'Azure DevOps'}.`, 'ok');
  return r.data.cloneUrl;
}

// ---------- set up a new repo from a plain folder ----------
async function newRepo(wsId) {
  const folder = await api.pickFolder('Choose (or make) the folder for your new repo');
  if (!folder) return;
  const info = await gitRaw('resolveRepo', folder);
  if (!info.isRepo) { await setupNewRepo(wsId, folder); return; }
  if (samePath(info.path, folder)) toast('That folder is already a repo, so it was opened as it is.', 'info');
  else toast(`That folder is inside the repo ${info.path}, so that repo was opened.`, 'info');
  await addRepos(wsId, [info.path]);
}

// One dialog for git init, a starter .gitignore, the first commit, the server URL and the first send.
// Returns { w, path, opened: true } once the repo exists (even if sending failed), or null.
async function setupNewRepo(wsId, folder, { notRepo = false } = {}) {
  let info;
  try { info = await gitRaw('newRepoInfo', folder); } catch (e) { showError("Couldn't open the folder", e); return null; }
  if (info.risky) {
    await modal({ title: "Let's pick a smaller folder", body: `<p><code>${esc(folder)}</code> is a whole drive or your user folder. Making it a repo would track everything in it. Choose (or make) a folder just for this project instead.</p>` });
    return null;
  }
  const ws = state.config.workspaces;
  const r = await modal({
    title: 'Set up a new repo',
    wide: true,
    body: `${notRepo ? `<p class="intro"><code>${esc(folder)}</code> isn't a git repo yet. RepoDeck can set it up, save your files as the first commit, and put it on GitHub or Azure DevOps.</p>`
        : `<p class="intro">Folder: <code>${esc(folder)}</code> <span class="muted small">(${info.items ? `${info.items} item${info.items === 1 ? '' : 's'} in it` : 'empty'})</span></p>`}
      <div class="setup-grid">
        <label class="field"><span>Main branch name</span><input name="branch" value="main" spellcheck="false"></label>
        ${info.hasGitignore
          ? '<div class="field"><span>Files to leave out</span><p class="hint">This folder already has a <code>.gitignore</code>, so it is used as it is.</p></div>'
          : `<label class="field"><span>Files to leave out (.gitignore)</span><select name="gitignore">
              <option value="">None — include every file</option>
              ${info.templates.map((t) => `<option value="${t.id}" ${t.id === info.suggested ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
            </select></label>`}
      </div>
      <label class="field"><span>First commit message</span><input name="message" value="Initial commit"></label>
      <h3>Put it on a server <span class="muted small">(optional — you can do this later with Send)</span></h3>
      ${serverFieldsHtml(info.name, { optional: true })}
      <label class="check"><input type="checkbox" name="send" checked> Send it to the server straight away</label>
      ${ws.length > 1 ? `<label class="field"><span>Add to workspace</span><select name="ws">${ws.map((w) => `<option value="${w.id}" ${(wsId || state.view.ws) === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label>` : ''}`,
    buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Set up repo', kind: 'primary' }],
    init: (el) => {
      initServerFields(el);
      const branch = el.querySelector('[name=branch]');
      const ok = el.querySelector('[data-close=ok]');
      branch.addEventListener('input', () => { ok.disabled = !branch.value.trim(); });
    },
  });
  if (r.id === 'settings') { await openSettings(); return setupNewRepo(wsId, folder, { notRepo }); }
  if (r.id !== 'ok') return null;
  const v = r.values;
  const target = v.ws || wsId;
  // Create the server repo first: if that fails, nothing has changed in the folder yet.
  let remote;
  try { remote = await resolveServer(v); } catch (e) { showError("Couldn't create the repo on the server", e); return null; }
  try {
    // The first commit is made below, after the files are checked.
    await git('setupRepo', folder, { branch: v.branch, gitignore: v.gitignore || null, message: v.message, remote, commit: false });
  } catch (e) {
    if (e.code === CANCELLED) return null;
    // A later step (say, the commit) can fail after git init worked: still show the repo so it can be fixed there.
    const now = await gitRaw('resolveRepo', folder).catch(() => ({}));
    let added = null;
    if (now.isRepo && samePath(now.path, folder)) { added = await attachRepo(target, folder); renderSidebar(); openRepo(folder, added.w.id); }
    showError("Couldn't finish setting up the repo", e);
    return added && { ...added, opened: true };
  }
  const added = await attachRepo(target, folder);
  renderSidebar();
  openRepo(folder, added.w.id);
  const checked = await checkBeforeCommit(folder, { paths: null, all: true });
  if (!checked) {
    toast('The repo is set up, but nothing is committed yet. Tick the files you want in Changes, then commit.', 'info');
    return { ...added, opened: true };
  }
  try {
    await busy(folder, 'Committing…', () => git('commit', folder, { message: v.message.trim() || 'Initial commit', paths: checked.paths || [], all: checked.all, allowEmpty: true }));
  } catch (e) {
    showError("The repo is set up, but the first commit didn't work", e);
    return { ...added, opened: true };
  }
  if (!remote) toast('Repo set up, with your files as the first commit. Click Send when you want to put it on a server.', 'ok');
  else if (!v.send) toast('Repo set up and linked to the server. Click Send when you\'re ready to publish it.', 'ok');
  else await publishNewRepo(folder);
  return { ...added, opened: true };
}

// The first send of a new repo. If the server repo was created with a README or licence, offers to combine.
async function publishNewRepo(repo) {
  try {
    let r = await busy(repo, 'Sending…', () => git('push', repo));
    if (r.rejected) {
      const c = await choose('The repo on the server isn\'t empty', '<p>It already has commits, usually a README, .gitignore or licence added when it was created. Those need to be combined with your files before yours can be sent.</p>', [
        { id: 'join', label: 'Combine them, then send', desc: "Brings the server's files in next to yours, then sends. If the same file is on both sides, you'll choose what to keep.", kind: 'primary' },
      ]);
      if (c !== 'join') { toast('Your repo is set up here. Send it once the server side is sorted out.', 'info'); return false; }
      const m = await busy(repo, 'Combining…', () => git('joinServerHistory', repo));
      if (m.conflicts) return afterMaybeConflict(repo, m);
      r = await busy(repo, 'Sending…', () => git('push', repo));
      if (r.rejected) throw new Error(r.output);
    }
    const web = await gitRaw('remoteWebUrl', repo).catch(() => null);
    toast('Your new repo is on the server.', 'ok', web ? { label: 'Open it', fn: () => api.openUrl(web) } : null);
    return true;
  } catch (e) {
    if (e.code === CANCELLED) return false;
    showError("Your repo is set up here, but couldn't be sent", e, { repo, retry: () => publishNewRepo(repo) });
    return false;
  }
}

async function addRepo(wsId) {
  const folder = await api.pickFolder('Choose the folder of a repo you already have');
  if (folder) await addRepos(wsId, [folder]);
}

// Drop folders onto the window to open them as repos.
let dropOverlay = null;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.className = 'drop-overlay';
    dropOverlay.textContent = 'Drop a repo folder to open it';
    document.body.appendChild(dropOverlay);
  }
});
document.addEventListener('dragleave', (e) => { if (dropOverlay && !e.relatedTarget) { dropOverlay.remove(); dropOverlay = null; } });
document.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dropOverlay?.remove();
  dropOverlay = null;
  const folders = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (folders.length) addRepos(state.view.ws, folders);
});

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
  const box = document.createElement('div');
  box.className = 'toast info progress-toast';
  box.setAttribute('role', 'status');
  box.innerHTML = `<span class="spinner"></span><div><b>Cloning…</b><div class="small muted" id="clone-progress">Connecting to the server</div></div><button class="btn small" data-action="cancel-clone">Cancel</button>`;
  $('#toast-root').appendChild(box);
  try {
    const dest = await git('clone', r.values.url, parent);
    box.remove();
    const added = await addRepoPath(r.values.ws, dest);
    toast(`Cloned into ${dest}.`, 'ok');
    renderSidebar();
    if (added) openRepo(added.path, added.w.id);
  } catch (e) {
    box.remove();
    if (e.code === 'CANCELLED') toast('Clone cancelled.', 'info');
    else showError("Couldn't clone", e, { url: r.values.url.trim() });
  }
}
