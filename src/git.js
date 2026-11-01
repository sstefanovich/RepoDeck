// All git work happens here, in the main process. Every operation shells out to
// the real git CLI (no shell, args passed as an array) so behaviour matches
// what you'd get in a terminal.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { partialPatch, changedLines } = require('../renderer/lib');

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',     // never hang waiting for a username/password prompt
  GIT_EDITOR: 'true',           // never open an editor (merge messages etc.)
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_OPTIONAL_LOCKS: '0',      // don't fight with VS Code / Cursor over index.lock
  LANGUAGE: 'en',               // English messages so error matching works
};

let logger = () => {};
function setLogger(fn) { logger = fn; }

// Long operations (clone/fetch/pull/push) report progress and can be cancelled, keyed by repo.
let progress = () => {};
function setProgress(fn) { progress = fn; }
const running = new Map(); // key -> child process
const cancelled = new Set();

// Treat file names literally (so names like "app [1].txt" aren't read as glob patterns).
const lit = (p) => `:(literal)${p}`;

const quoteArg = (a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// extraEnv: added to git's environment for this one command.
function run(cwd, args, { quiet = false, input, background = false, progressKey = null, extraEnv = null } = {}) {
  return new Promise((resolve) => {
    const env = { ...ENV, ...(background ? { GCM_INTERACTIVE: 'never' } : {}), ...extraEnv };
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (progressKey) { running.delete(progressKey); progress({ key: progressKey, done: true }); }
        const wasCancelled = progressKey && cancelled.delete(progressKey);
        const res = { ok: !err, stdout: stdout || '', stderr: wasCancelled ? 'Cancelled.' : stderr || (err && !stdout ? err.message : ''), cancelled: !!wasCancelled };
        if (!quiet) {
          logger({
            time: Date.now(),
            repo: cwd,
            command: 'git ' + args.map(quoteArg).join(' '),
            ok: res.ok,
            output: (res.stdout + res.stderr).trim().slice(0, 20000),
          });
        }
        resolve(res);
      }
    );
    if (progressKey) {
      running.set(progressKey, child);
      // git writes progress like "Receiving objects:  45% (123/456)" to stderr, separated by \r.
      child.stderr.on('data', (d) => {
        const line = String(d).split(/[\r\n]+/).filter((l) => l.trim()).pop();
        if (!line) return;
        const m = line.match(/^(?:remote:\s*)?([A-Za-z][A-Za-z ]+?):\s+(\d+)%/);
        progress({ key: progressKey, text: m ? m[1] : line.slice(0, 80), percent: m ? Number(m[2]) : null });
      });
    }
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Stops a running clone/fetch/pull/push (and the helpers git started for it).
function cancel(key) {
  const child = running.get(key);
  if (!child) return false;
  cancelled.add(key);
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill();
  return true;
}

class GitError extends Error {
  constructor(message, code = 'GIT') { super(message.trim() || 'git failed'); this.code = code; }
}

async function must(cwd, args, opts) {
  const r = await run(cwd, args, opts);
  if (r.cancelled) throw new GitError('Cancelled.', 'CANCELLED');
  if (!r.ok) throw new GitError(r.stderr || r.stdout);
  return r;
}

// For commands that can stop half-way with conflicts (merge, pull, stash pop...):
// conflicts are an expected outcome, not an error, so report them as data.
async function withConflicts(repo, r) {
  const output = (r.stdout + r.stderr).trim();
  if (r.ok) return { ok: true, output };
  const st = await ops.status(repo);
  if (st.conflicted && st.conflicted.length) return { ok: false, conflicts: true, output };
  throw new GitError(output);
}

// ---------- repo metadata ----------
const dirCache = new Map();
async function gitDirs(repo) {
  if (dirCache.has(repo)) return dirCache.get(repo);
  const r = await run(repo, ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'], { quiet: true });
  if (!r.ok) return null;
  const [gitDir, commonDir] = r.stdout.trim().split(/\r?\n/);
  const dirs = { gitDir, commonDir: commonDir || gitDir };
  dirCache.set(repo, dirs);
  return dirs;
}

const readFirstLine = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; } };
const shortRef = (r) => r.replace(/^refs\/heads\//, '');

// Works out whether a merge/rebase/etc. is half-finished, and gives friendly
// names for git's confusing "ours" and "theirs" (which swap meaning in a rebase).
async function opState(repo, branch) {
  const dirs = await gitDirs(repo);
  if (!dirs) return null;
  const has = (f) => fs.existsSync(path.join(dirs.gitDir, f));
  if (has('rebase-merge') || has('rebase-apply')) {
    const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
    const headName = shortRef(readFirstLine(path.join(dirs.gitDir, dir, 'head-name'))) || 'your branch';
    return { kind: 'rebase', ours: 'Target branch', theirs: `Your commit (${headName})`, incoming: headName };
  }
  if (has('MERGE_HEAD')) {
    const msg = readFirstLine(path.join(dirs.gitDir, 'MERGE_MSG'));
    const m = msg.match(/^Merge (?:remote-tracking )?branch '([^']+)'(?: of (\S+))?/);
    let incoming = m ? m[1] : 'the other branch';
    if (m && m[2]) incoming = `${incoming} from the server`;
    return { kind: 'merge', ours: `Yours (${branch || 'current'})`, theirs: `Incoming (${incoming})`, incoming };
  }
  if (has('CHERRY_PICK_HEAD')) {
    const hash = readFirstLine(path.join(dirs.gitDir, 'CHERRY_PICK_HEAD'));
    const subject = (await run(repo, ['log', '-1', '--format=%s', hash], { quiet: true })).stdout.trim() || hash.slice(0, 7);
    const short = subject.length > 50 ? subject.slice(0, 47) + '…' : subject;
    // The sequencer's todo list still includes the commit that stopped, so subtract it.
    let remaining = 0;
    try {
      remaining = Math.max(0, fs.readFileSync(path.join(dirs.gitDir, 'sequencer', 'todo'), 'utf8').split(/\r?\n/).filter((l) => /^\s*(pick|p)\s/.test(l)).length - 1);
    } catch {}
    return { kind: 'cherry-pick', ours: `Yours (${branch || 'current'})`, theirs: `Copied commit (${short})`, incoming: subject, remaining };
  }
  if (has('REVERT_HEAD')) return { kind: 'revert', ours: `Yours (${branch || 'current'})`, theirs: 'The undo', incoming: 'a revert' };
  return null;
}

// Whether any server (remote) is configured — read from .git/config to avoid another process per refresh.
function hasRemote(dirs) {
  try { return /^\s*\[remote\s+"/m.test(fs.readFileSync(path.join(dirs.commonDir, 'config'), 'utf8')); } catch { return false; }
}

function stashCount(dirs) {
  try {
    const text = fs.readFileSync(path.join(dirs.commonDir, 'logs', 'refs', 'stash'), 'utf8');
    return text.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function webUrl(remote) {
  let u = remote.trim();
  let m = u.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = u.match(/^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}`;
  return null;
}

// ---------- operations (callable from the UI) ----------
const ops = {
  async resolveRepo(folder) {
    const r = await run(folder, ['rev-parse', '--show-toplevel'], { quiet: true });
    if (!r.ok) return { isRepo: false, path: folder };
    return { isRepo: true, path: path.normalize(r.stdout.trim()) };
  },

  async init(folder) {
    await must(folder, ['init']);
    return true;
  },

  async status(repo) {
    if (!fs.existsSync(repo)) return { missing: true };
    const r = await run(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { quiet: true });
    if (!r.ok) return { error: (r.stderr || 'Not a git repository').trim() };
    const s = { branch: null, detached: false, oid: null, initial: false, upstream: null, upstreamGone: false, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] };
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.oid ')) { s.oid = line.slice(13); s.initial = s.oid === '(initial)'; }
      else if (line.startsWith('# branch.head ')) { const h = line.slice(14); if (h === '(detached)') s.detached = true; else s.branch = h; }
      // git prints no ahead/behind line when the upstream branch is gone from the server.
      else if (line.startsWith('# branch.upstream ')) { s.upstream = line.slice(18); s.upstreamGone = true; }
      else if (line.startsWith('# branch.ab ')) { s.upstreamGone = false; const m = line.match(/\+(\d+) -(\d+)/); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
      else if (line[0] === '1' || line[0] === '2') {
        const f = line.split(' ');
        const xy = f[1];
        const isRename = line[0] === '2';
        const file = f.slice(isRename ? 9 : 8).join(' ');
        const orig = isRename ? parts[++i] : undefined;
        if (xy[0] !== '.') s.staged.push({ path: file, code: xy[0], orig });
        if (xy[1] !== '.') s.unstaged.push({ path: file, code: xy[1], orig });
      }
      else if (line[0] === 'u') { const f = line.split(' '); s.conflicted.push({ path: f.slice(10).join(' '), xy: f[1] }); }
      else if (line[0] === '?') s.untracked.push({ path: line.slice(2) });
    }
    const dirs = await gitDirs(repo);
    s.op = await opState(repo, s.branch);
    s.stashCount = dirs ? stashCount(dirs) : 0;
    s.hasRemote = dirs ? hasRemote(dirs) : false;
    return s;
  },

  async fileDiff(repo, files, { untracked = false } = {}) {
    if (untracked) {
      const full = path.join(repo, files[0]);
      let st;
      try { st = fs.statSync(full); } catch { return { kind: 'missing' }; }
      if (st.isDirectory()) return { kind: 'text', text: '' };
      if (st.size > 3_000_000) return { kind: 'large', size: st.size };
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) return { kind: 'binary' };
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop();
      return { kind: 'text', text: `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') };
    }
    const hasHead = (await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { quiet: true })).ok;
    const args = hasHead ? ['diff', 'HEAD', '-M', '--', ...files.map(lit)] : ['diff', '--cached', '--', ...files.map(lit)];
    const r = await run(repo, args, { quiet: true });
    if (!r.ok) throw new GitError(r.stderr);
    if (/^Binary files /m.test(r.stdout) && !/^@@/m.test(r.stdout)) return { kind: 'binary' };
    return { kind: 'text', text: r.stdout };
  },

  // amend: fold the changes into the last commit (and replace its message) instead of making a new one.
  // partial: { file: [lineKey…] } — for these files, commit everything except the listed lines.
  async commit(repo, { message, paths, all, amend = false, partial = null }) {
    const st = await ops.status(repo);
    if (st.conflicted.length) throw new GitError('You have unresolved conflicts. Resolve them first.', 'CONFLICTS');
    const amendArg = amend ? ['--amend'] : [];
    if (partial && Object.keys(partial).length) {
      if (st.op || st.initial) throw new GitError('Picking single lines only works on a normal commit (not during a merge, or before the first commit).');
      const patches = await partialPatches(repo, partial);
      const whole = paths.filter((p) => !(p in partial));
      // Build the commit in git's index: start from the last commit, add the whole files, then the picked lines.
      await must(repo, ['reset', '-q']);
      if (whole.length) await must(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: whole.map(lit).join('\0') });
      for (const p of patches) await must(repo, ['apply', '--cached', '--whitespace=nowarn', '-'], { input: p });
      await must(repo, ['commit', ...amendArg, '-m', message]);
      return true;
    }
    if (all || st.op) {
      await must(repo, ['add', '-A']);
      await must(repo, ['commit', ...amendArg, '-m', message]);
    } else if (!paths.length && amend) {
      await must(repo, ['commit', '--amend', '--only', '-m', message]);
    } else {
      const spec = paths.map(lit).join('\0');
      await must(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec });
      await must(repo, ['commit', ...amendArg, '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec });
    }
    return true;
  },

  // The last commit's message, and whether it is already on the server (then it must not be amended/undone).
  async lastCommit(repo) {
    const r = await run(repo, ['log', '-1', '--format=%H%x1f%B'], { quiet: true });
    if (!r.ok) return null;
    const [hash, message] = r.stdout.split('\x1f');
    return { hash, message: (message || '').trim(), pushed: await ops.isPushed(repo, hash) };
  },

  async isPushed(repo, oid) {
    const r = await run(repo, ['branch', '-r', '--contains', oid], { quiet: true });
    return r.ok && !!r.stdout.trim();
  },

  async headOid(repo) {
    const r = await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { quiet: true });
    return r.ok ? r.stdout.trim() : null;
  },

  // Undo helpers. mode 'soft' keeps the undone commit's changes; 'keep' moves the branch back
  // but refuses if that would overwrite uncommitted changes.
  // 'keep' refuses when uncommitted edits are in files the move would change; those are then
  // set aside, the branch moved, and the edits put back.
  async resetTo(repo, oid, mode = 'keep') {
    const r = await run(repo, ['reset', `--${mode}`, oid]);
    if (r.ok) return { ok: true };
    if (mode !== 'keep' || !/not uptodate|would be overwritten|local changes/i.test(r.stderr)) throw new GitError(r.stderr);
    await must(repo, ['stash', 'push', '--include-untracked', '-m', 'set aside while undoing']);
    const moved = await run(repo, ['reset', '--keep', oid]);
    if (!moved.ok) { await run(repo, ['stash', 'pop']); throw new GitError(moved.stderr); }
    return withConflicts(repo, await run(repo, ['stash', 'pop']));
  },

  async restoreBranch(repo, name, oid) {
    await must(repo, ['branch', name, oid]);
    return true;
  },

  async stashStore(repo, oid, message) {
    await must(repo, ['stash', 'store', '-m', message, oid]);
    return true;
  },

  // The branch most work is based on: the server's default (origin/HEAD), else main/master.
  async defaultBranch(repo) {
    const r = await run(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { quiet: true });
    if (r.ok && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
    for (const b of ['main', 'master', 'develop']) {
      if ((await run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`], { quiet: true })).ok) return b;
    }
    return null;
  },

  // Local branches that are probably safe to delete: gone from the server, or fully merged into the default branch.
  async tidyCandidates(repo) {
    const def = await ops.defaultBranch(repo);
    const { local } = await ops.branches(repo);
    const keep = new Set(['main', 'master', 'develop', def].filter(Boolean));
    const merged = new Set();
    if (def) {
      const r = await run(repo, ['for-each-ref', '--format=%(refname:short)', `--merged=refs/heads/${def}`, 'refs/heads'], { quiet: true });
      r.stdout.split(/\r?\n/).filter(Boolean).forEach((b) => merged.add(b));
    }
    return {
      defaultBranch: def,
      branches: local.filter((b) => !b.current && !keep.has(b.name) && (b.track === 'gone' || merged.has(b.name)))
        .map((b) => ({ name: b.name, gone: b.track === 'gone', merged: merged.has(b.name), date: b.date, subject: b.subject })),
    };
  },

  // The web page for opening a pull request from `branch` on GitHub, Azure DevOps, GitLab or Bitbucket.
  async prUrl(repo, branch) {
    const r = await run(repo, ['remote', 'get-url', 'origin'], { quiet: true });
    if (!r.ok) return null;
    const remote = r.stdout.trim();
    const b = encodeURIComponent(branch);
    const az = remote.match(/(?:dev\.azure\.com[:/](?:v3\/)?|@ssh\.dev\.azure\.com:v3\/)([^/]+)\/([^/]+)\/(?:_git\/)?([^/]+?)(?:\.git)?\/?$/i)
      || remote.match(/https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/i);
    if (az) return `https://dev.azure.com/${az[1]}/${az[2]}/_git/${az[3]}/pullrequestcreate?sourceRef=${b}`;
    const web = webUrl(remote);
    if (!web) return null;
    if (/github\./i.test(web)) return `${web}/compare/${b}?expand=1`;
    if (/gitlab\./i.test(web)) return `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}`;
    if (/bitbucket\./i.test(web)) return `${web}/pull-requests/new?source=${b}`;
    return web;
  },

  // "Discard" puts the changes on the shelf (stash) instead of destroying them,
  // so a mis-click can always be undone from the Shelf tab.
  async discard(repo, paths) {
    const hasHead = (await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { quiet: true })).ok;
    if (!hasHead) {
      const { shell } = require('electron');
      for (const p of paths) {
        await run(repo, ['rm', '--cached', '-q', '--ignore-unmatch', '--', lit(p)]);
        await shell.trashItem(path.join(repo, p)).catch(() => {});
      }
      return { trashed: true };
    }
    const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
    await must(repo, ['stash', 'push', '--include-untracked', '-m', `[discarded] ${label}`, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.map(lit).join('\0') });
    return { trashed: false };
  },

  async ignore(repo, file) {
    const gi = path.join(repo, '.gitignore');
    let existing = '';
    try { existing = fs.readFileSync(gi, 'utf8'); } catch {}
    const entry = '/' + file.replace(/\\/g, '/');
    if (existing.split(/\r?\n/).includes(entry)) return true;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gi, `${sep}${entry}\n`);
    return true;
  },

  async branches(repo) {
    const fmt = ['%(refname)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(committerdate:unix)', '%(subject)'].join('%1f');
    const r = await must(repo, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], { quiet: true });
    const local = [];
    const remote = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      const [ref, upstream, track, head, date, subject] = line.split('\x1f');
      if (ref.startsWith('refs/heads/')) {
        local.push({ name: ref.slice(11), upstream, track, current: head === '*', date: +date, subject });
      } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        const name = ref.slice(13);
        const slash = name.indexOf('/');
        if (slash < 0) continue;
        remote.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), date: +date, subject });
      }
    }
    const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
    const localNames = new Set(local.map((b) => b.name));
    const remoteOnly = remote.filter((b) => !tracked.has(b.name) && !localNames.has(b.branch));
    const remotes = (await run(repo, ['remote'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
    return { local, remote, remoteOnly, remotes };
  },

  async checkBranchName(name) {
    const r = await run(os.homedir(), ['check-ref-format', '--branch', name], { quiet: true });
    return r.ok;
  },

  async createBranch(repo, name, start) {
    const args = ['switch', '-c', name, '--no-track'];
    if (start) args.push(start);
    await must(repo, args);
    return true;
  },

  async switchBranch(repo, name) {
    await must(repo, ['switch', name]);
    return true;
  },

  async checkoutRemote(repo, remoteBranch, localName) {
    await must(repo, ['switch', '-c', localName, '--track', remoteBranch]);
    return true;
  },

  async renameBranch(repo, oldName, newName) {
    await must(repo, ['branch', '-m', oldName, newName]);
    return true;
  },

  // Returns the deleted branch's last commit so it can be restored (Undo).
  async deleteBranch(repo, name, { force = false, remote = null } = {}) {
    const oid = (await run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { quiet: true })).stdout.trim();
    await must(repo, ['branch', force ? '-D' : '-d', name]);
    if (remote) await must(repo, ['push', remote.remote, '--delete', remote.branch]);
    return { oid };
  },

  async merge(repo, branch) {
    return withConflicts(repo, await run(repo, ['merge', '--no-edit', '--autostash', branch]));
  },

  // How the current branch and `ref` differ: commits only on `ref` (behind) and only here (ahead).
  // A rebase rewrites the "ahead" commits, so it's unsafe once any of them is on the server.
  async compareCounts(repo, ref) {
    const r = await must(repo, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], { quiet: true });
    const [ahead, behind] = r.stdout.trim().split(/\s+/).map(Number);
    const notSent = await run(repo, ['rev-list', '--count', 'HEAD', `^${ref}`, '^@{u}'], { quiet: true });
    const sent = notSent.ok ? ahead - Number(notSent.stdout.trim()) : 0;
    return { ahead, behind, sent, canRebase: sent === 0 };
  },

  // After a branch's pull request is merged: switch to the default branch, get its latest, and
  // delete the branch (here, and on the server if it's still there and `deleteRemote`).
  // If the branch's commits aren't in the default branch as-is (normal after a squash merge),
  // nothing is changed and { needsForce: true } comes back, unless `force` is set.
  async finishBranch(repo, { force = false, deleteRemote = false } = {}) {
    const st = await ops.status(repo);
    if (st.op || st.conflicted.length) throw new GitError('Finish or abort what is in progress first (see the yellow banner).');
    if (!st.branch) throw new GitError("You're not on a branch.");
    if (st.staged.length + st.unstaged.length + st.untracked.length) throw new GitError('You have uncommitted changes on this branch. Commit them or put them on the Shelf first, so nothing is lost.', 'DIRTY');
    const branch = st.branch;
    const target = await ops.defaultBranch(repo);
    if (!target || target === branch) throw new GitError(`${branch} is the main branch, so there's nothing to finish.`);
    if (st.hasRemote) await run(repo, ['fetch', '--prune', '--quiet'], { background: true });
    const oid = st.oid;
    const isIn = async (ref) => (await run(repo, ['merge-base', '--is-ancestor', oid, ref], { quiet: true })).ok;
    const merged = (await isIn(`refs/remotes/origin/${target}`)) || (await isIn(`refs/heads/${target}`));
    if (!merged && !force) return { needsForce: true, branch, target };
    const hasLocal = (await run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${target}`], { quiet: true })).ok;
    await must(repo, hasLocal ? ['switch', target] : ['switch', '-c', target, '--track', `origin/${target}`]);
    let pulled = null;
    const after = await ops.status(repo);
    if (after.upstream && !after.upstreamGone) pulled = await ops.pull(repo, 'ff').catch((e) => ({ ok: false, output: e.message }));
    await must(repo, ['branch', '-D', branch]);
    const slash = st.upstream ? st.upstream.indexOf('/') : -1;
    if (deleteRemote && slash > 0 && !st.upstreamGone) await must(repo, ['push', st.upstream.slice(0, slash), '--delete', st.upstream.slice(slash + 1)]);
    return { ok: true, branch, target, oid, pulled: pulled ? !!pulled.ok : null };
  },

  // Commits on this branch that haven't been sent, oldest first — the ones that are safe to rewrite.
  async unsentCommits(repo) {
    const st = await ops.status(repo);
    if (!st.branch || st.initial) return { commits: [] };
    let range;
    if (st.upstream && !st.upstreamGone) range = ['@{u}..HEAD'];
    else if (st.hasRemote) range = ['HEAD', '--not', '--remotes'];
    else {
      const def = await ops.defaultBranch(repo);
      range = def && def !== st.branch ? ['HEAD', '--not', `refs/heads/${def}`] : ['HEAD'];
    }
    const r = await must(repo, ['log', '-n51', '--reverse', '--format=%H%x1f%h%x1f%P%x1f%B%x1e', ...range], { quiet: true });
    let commits = r.stdout.split('\x1e').map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((rec) => {
      const [hash, short, parents, message] = rec.split('\x1f');
      return { hash, short, parents: parents ? parents.split(' ') : [], message: (message || '').trim() };
    });
    // `log -n51 --reverse` takes the newest 51 first, so dropping the oldest keeps the newest 50.
    const more = commits.length > 50;
    if (more) commits = commits.slice(1);
    return { commits, more, hasMerge: commits.some((c) => c.parents.length > 1) };
  },

  // Rewrites unsent commits. steps (oldest first): [{ hash, action: 'pick'|'squash'|'drop', message? }].
  // 'squash' folds a commit into the one before it; a message on a pick (or on the first commit of a
  // squashed group) replaces that commit's message.
  async tidyCommits(repo, steps) {
    const { todo, files } = tidyTodo(steps);
    const first = steps[0].hash;
    const root = !(await run(repo, ['rev-parse', '--verify', '-q', `${first}^`], { quiet: true })).ok;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repodeck-tidy-'));
    const todoFile = path.join(dir, 'todo');
    fs.writeFileSync(todoFile, todo.map((l) => l.replace('{dir}', dir.replace(/\\/g, '/'))).join('\n') + '\n');
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    // git runs the "sequence editor" with its own to-do file as the argument: replace it with ours.
    const editor = `cp "${todoFile.replace(/\\/g, '/')}"`;
    const r = await run(repo, ['rebase', '-i', '--autostash', ...(root ? ['--root'] : [`${first}^`])], { extraEnv: { GIT_SEQUENCE_EDITOR: editor } });
    return withConflicts(repo, r);
  },

  // Bring another branch's new commits into the current one, by merge or by rebase.
  async updateFrom(repo, ref, mode = 'merge') {
    const args = mode === 'rebase' ? ['rebase', '--autostash', ref] : ['merge', '--no-edit', '--autostash', ref];
    return withConflicts(repo, await run(repo, args));
  },

  // A new commit that does the opposite of `hash`. Merge commits are reversed against their first parent.
  // git won't revert over uncommitted edits to the same files, so they're shelved meanwhile and put back.
  // If the revert stops at a conflict they stay on the Shelf (shelved: true) until it's finished.
  async revertCommit(repo, hash) {
    const st = await ops.status(repo);
    const dirty = st.staged.length + st.unstaged.length + st.untracked.length > 0;
    const merge = (await run(repo, ['rev-list', '--no-walk', '--min-parents=2', hash], { quiet: true })).stdout.trim();
    if (dirty) await must(repo, ['stash', 'push', '--include-untracked', '-m', revertShelfMessage(st.branch)]);
    let r;
    try { r = await withConflicts(repo, await run(repo, ['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), hash])); }
    catch (e) { if (dirty) await run(repo, ['stash', 'pop']); throw e; }
    if (r.conflicts || !dirty) return { ...r, shelved: dirty && !!r.conflicts };
    const p = await withConflicts(repo, await run(repo, ['stash', 'pop']));
    return { ...r, restoreConflicts: !!p.conflicts };
  },

  // What `head` changes compared with `base`. mode 'split': only what happened on head since the
  // two branches split (what a pull request shows); 'exact': every difference between them.
  async compare(repo, base, head, { mode = 'split' } = {}) {
    const range = mode === 'exact' ? [base, head] : [`${base}...${head}`];
    const ns = await must(repo, ['diff', '--name-status', '-z', '-M', ...range], { quiet: true });
    const files = [];
    const parts = ns.stdout.split('\0');
    for (let i = 0; i < parts.length - 1;) {
      const code = parts[i++][0];
      if (code === 'R' || code === 'C') files.push({ code, orig: parts[i++], path: parts[i++] });
      else files.push({ code, path: parts[i++] });
    }
    const stats = new Map();
    const num = (await run(repo, ['diff', '--numstat', '-z', '-M', ...range], { quiet: true })).stdout.split('\0');
    for (let i = 0; i < num.length - 1;) {
      const m = num[i++].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      const file = m[3] || (i++, num[i++]); // renames list the old and new names after the counts
      stats.set(file, { add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2] });
    }
    for (const f of files) Object.assign(f, stats.get(f.path) || {});
    const fmt = '%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e';
    const log = (await run(repo, ['log', '-n300', `--format=${fmt}`, `${base}..${head}`], { quiet: true })).stdout;
    const commits = log.split('\x1e').map((s) => s.trim()).filter(Boolean).map((rec) => {
      const [hash, short, author, date, subject] = rec.split('\x1f');
      return { hash, short, author, date: +date, subject };
    });
    const counts = (await must(repo, ['rev-list', '--left-right', '--count', `${base}...${head}`], { quiet: true })).stdout.trim().split(/\s+/).map(Number);
    return { files, commits, onlyBase: counts[0], onlyHead: counts[1] };
  },

  async compareDiff(repo, base, head, files, { mode = 'split' } = {}) {
    const range = mode === 'exact' ? [base, head] : [`${base}...${head}`];
    const r = await must(repo, ['diff', '-M', ...range, '--', ...files.map(lit)], { quiet: true });
    if (/^Binary files /m.test(r.stdout) && !/^@@/m.test(r.stdout)) return { kind: 'binary' };
    return { kind: 'text', text: r.stdout };
  },

  async fetch(repo, { background = false } = {}) {
    await must(repo, ['fetch', '--all', '--prune', ...(background ? [] : ['--progress'])], { quiet: background, background, progressKey: background ? null : repo });
    return true;
  },

  // mode 'ff': only fast-forward (safe, never creates a merge).
  // mode 'merge': combine diverged histories with a merge commit.
  async pull(repo, mode = 'ff') {
    const args = mode === 'merge' ? ['pull', '--progress', '--no-rebase', '--no-edit', '--autostash'] : ['pull', '--progress', '--ff-only', '--autostash'];
    const r = await run(repo, args, { progressKey: repo });
    if (r.cancelled) throw new GitError('Cancelled.', 'CANCELLED');
    if (!r.ok && /fast-forward|diverg/i.test(r.stderr)) return { ok: false, diverged: true, output: r.stderr.trim() };
    return withConflicts(repo, r);
  },

  async push(repo) {
    const st = await ops.status(repo);
    if (st.detached) throw new GitError('You are not on a branch, so there is nothing to push. Create a branch first.', 'DETACHED');
    let args = ['push', '--progress'];
    if (!st.upstream) {
      const remotes = (await run(repo, ['remote'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
      if (!remotes.length) throw new GitError('This repo has no server (remote) configured.', 'NO_REMOTE');
      args = ['push', '--progress', '-u', remotes.includes('origin') ? 'origin' : remotes[0], 'HEAD'];
    }
    const r = await run(repo, args, { progressKey: repo });
    if (r.cancelled) throw new GitError('Cancelled.', 'CANCELLED');
    if (!r.ok && /rejected|fetch first|non-fast-forward/i.test(r.stderr)) return { ok: false, rejected: true, output: r.stderr.trim() };
    if (!r.ok) throw new GitError(r.stderr);
    return { ok: true, published: !st.upstream, branch: st.branch, output: (r.stdout + r.stderr).trim() };
  },

  async addRemote(repo, url) {
    await must(repo, ['remote', 'add', 'origin', url]);
    return true;
  },

  async remoteWebUrl(repo) {
    const r = await run(repo, ['remote', 'get-url', 'origin'], { quiet: true });
    return r.ok ? webUrl(r.stdout) : null;
  },

  // ref: show another branch instead of the current one.
  // notIn: only commits on `ref` whose changes aren't already in the current branch
  // (--cherry-pick hides commits that were already copied over) — i.e. cherry-pick candidates.
  // file: only commits that touched this file (following renames).
  async history(repo, { limit = 300, ref = null, notIn = false, file = null } = {}) {
    const fmt = '%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1f%P%x1e';
    const parse = (out) => out.split('\x1e').map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((rec) => {
      const [hash, short, author, date, subject, refs, parents] = rec.split('\x1f');
      return { hash, short, author, date: +date, subject, refs: refs ? refs.split(', ') : [], parents: parents ? parents.split(' ') : [] };
    });
    const range = !ref ? ['HEAD'] : notIn ? ['--cherry-pick', '--right-only', `HEAD...${ref}`] : [ref];
    const fileArgs = file ? ['--follow', '--', lit(file)] : [];
    const r = await run(repo, ['log', `-n${limit}`, `--format=${fmt}`, ...range, ...fileArgs], { quiet: true });
    if (!r.ok) return { commits: [], unpushed: [], incoming: [], upstream: null, ref };
    const commits = parse(r.stdout);
    if (ref) return { commits, unpushed: [], incoming: [], upstream: null, ref };
    const up = await run(repo, ['rev-parse', '--abbrev-ref', '@{u}'], { quiet: true });
    let unpushed = [];
    let incoming = [];
    if (up.ok) {
      unpushed = (await run(repo, ['rev-list', '@{u}..HEAD'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
      incoming = parse((await run(repo, ['log', `--format=${fmt}`, 'HEAD..@{u}'], { quiet: true })).stdout);
    }
    return { commits, unpushed, incoming, upstream: up.ok ? up.stdout.trim() : null };
  },

  // Who last changed each line of `file` (as it is on disk now; uncommitted lines have an all-zero hash).
  // -> { lines: [{ hash, n, text }], commits: { hash: { author, time, summary } }, truncated }
  async blame(repo, file) {
    // blame takes a plain path (no pathspec magic); `--` keeps names like "-x" safe.
    const r = await must(repo, ['blame', '--porcelain', '--', file], { quiet: true });
    const lines = [];
    const commits = {};
    let cur = null;
    for (const raw of r.stdout.split('\n')) {
      if (raw.startsWith('\t')) {
        if (lines.length < 20000) lines.push({ hash: cur.hash, n: cur.n, text: raw.slice(1).replace(/\r$/, '') });
        continue;
      }
      const head = raw.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (head) { cur = { hash: head[1], n: +head[2] }; commits[cur.hash] ||= { author: '', time: 0, summary: '' }; continue; }
      if (!cur) continue;
      const c = commits[cur.hash];
      if (raw.startsWith('author ')) c.author = raw.slice(7);
      else if (raw.startsWith('author-time ')) c.time = +raw.slice(12);
      else if (raw.startsWith('summary ')) c.summary = raw.slice(8);
    }
    return { lines, commits, truncated: lines.length >= 20000 };
  },

  async commitDetails(repo, hash) {
    const meta = await must(repo, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%B', hash], { quiet: true });
    const [full, author, email, date, parents, body] = meta.stdout.split('\x1f');
    const diff = await run(repo, ['show', '--format=', '-M', '--diff-merges=first-parent', '--patch', hash], { quiet: true });
    return { hash: full, author, email, date: +date, parents: parents ? parents.split(' ') : [], message: (body || '').trim(), diff: diff.stdout };
  },

  async undoLastCommit(repo) {
    await must(repo, ['reset', '--soft', 'HEAD~1']);
    return true;
  },

  async stashList(repo) {
    const r = await run(repo, ['stash', 'list', '--format=%gd%x1f%ct%x1f%H%x1f%gs'], { quiet: true });
    if (!r.ok) return [];
    return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
      const [ref, ct, oid, gs] = l.split('\x1f');
      const m = gs.match(/^(?:WIP on|On) ([^:]+): (.*)$/);
      return { ref, oid, time: +ct, branch: m ? m[1] : '', message: m ? m[2] : gs, raw: gs };
    });
  },

  // paths: only shelve these files (all changes when omitted).
  async stashSave(repo, message, paths = null) {
    const args = ['stash', 'push', '--include-untracked'];
    if (message) args.push('-m', message);
    if (paths?.length) {
      await must(repo, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.map(lit).join('\0') });
      return true;
    }
    await must(repo, args);
    return true;
  },

  // Throws away some changed lines of a file (keys from lineKeyer) and returns the patch that
  // puts them back, for Undo.
  async discardLines(repo, file, keys) {
    const d = await must(repo, ['diff', 'HEAD', '--', lit(file)], { quiet: true });
    const keep = new Set(keys);
    const others = changedLines(d.stdout).map((x) => x.key).filter((k) => !keep.has(k));
    const patch = partialPatch(d.stdout, others);
    if (!patch) throw new GitError('Those lines have already changed. Look at the file again and retry.');
    await must(repo, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch });
    return { patch };
  },

  async applyPatch(repo, patch) {
    await must(repo, ['apply', '--whitespace=nowarn', '-'], { input: patch });
    return true;
  },

  async stashShow(repo, ref) {
    const r = await run(repo, ['stash', 'show', '-p', '-M', '--include-untracked', ref], { quiet: true });
    return r.stdout;
  },

  async stashApply(repo, ref) {
    return withConflicts(repo, await run(repo, ['stash', 'apply', ref]));
  },

  async stashPop(repo, ref) {
    return withConflicts(repo, await run(repo, ['stash', 'pop', ref]));
  },

  // Returns what was dropped so it can be put back (Undo).
  async stashDrop(repo, ref) {
    const item = (await ops.stashList(repo)).find((s) => s.ref === ref);
    await must(repo, ['stash', 'drop', ref]);
    return item ? { oid: item.oid, message: item.raw } : {};
  },

  async readConflict(repo, file) {
    const full = path.join(repo, file);
    if (!fs.existsSync(full)) return { exists: false };
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return { exists: true, binary: true };
    return { exists: true, content: buf.toString('utf8') };
  },

  // Take one side's whole file. If that side deleted the file, delete it.
  async resolveSide(repo, file, side) {
    const r = await run(repo, ['checkout', `--${side}`, '--', lit(file)]);
    if (r.ok) { await must(repo, ['add', '--', lit(file)]); return true; }
    if (/does not have (our|their) version/i.test(r.stderr)) { await must(repo, ['rm', '--quiet', '--', lit(file)]); return true; }
    throw new GitError(r.stderr);
  },

  async saveResolution(repo, file, content) {
    fs.writeFileSync(path.join(repo, file), content, 'utf8');
    await must(repo, ['add', '--', lit(file)]);
    return true;
  },

  async markResolved(repo, file) {
    if (fs.existsSync(path.join(repo, file))) await must(repo, ['add', '--', lit(file)]);
    else await must(repo, ['rm', '--quiet', '--cached', '--', lit(file)]);
    return true;
  },

  async abortOp(repo, kind) {
    const map = { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'] };
    await must(repo, map[kind]);
    return true;
  },

  async continueOp(repo, kind) {
    const map = { merge: ['commit', '--no-edit'], rebase: ['rebase', '--continue'], 'cherry-pick': ['cherry-pick', '--continue'], revert: ['revert', '--continue'] };
    return withConflicts(repo, await run(repo, map[kind]));
  },

  async skipOp(repo, kind) {
    return withConflicts(repo, await run(repo, [kind, '--skip']));
  },

  // The three versions git keeps during a conflict: 1 = original (common ancestor),
  // 2 = ours, 3 = theirs. null when that side has no such file.
  async conflictVersions(repo, file) {
    const get = async (n) => {
      const r = await run(repo, ['show', `:${n}:${file.replace(/\\/g, '/')}`], { quiet: true });
      if (!r.ok) return null;
      return r.stdout.includes('\0') ? { binary: true } : r.stdout;
    };
    const [base, ours, theirs] = await Promise.all([get(1), get(2), get(3)]);
    return { base, ours, theirs };
  },

  // Copy commits (oldest first) onto the current branch.
  async cherryPick(repo, hashes, { x = false } = {}) {
    const before = (await run(repo, ['rev-parse', 'HEAD'], { quiet: true })).stdout.trim();
    const r = await withConflicts(repo, await run(repo, await cherryPickArgs(repo, hashes, x)));
    if (r.ok) {
      const count = (await run(repo, ['rev-list', '--count', `${before}..HEAD`], { quiet: true })).stdout.trim();
      r.picked = Number(count) || 0;
    }
    return r;
  },

  // Copy commits onto another branch: shelve uncommitted changes, switch there,
  // cherry-pick, and (optionally) come back and restore the changes.
  async cherryPickOnto(repo, { hashes, target, returnAfter = true, x = false }) {
    const st = await ops.status(repo);
    if (st.op || st.conflicted.length) throw new GitError('Finish or abort what is in progress first (see the yellow banner).');
    if (!st.branch) throw new GitError("You're not on a branch, so there's nowhere to come back to. Switch to a branch first.");
    const original = st.branch;
    const dirty = st.staged.length + st.unstaged.length + st.untracked.length > 0;
    if (dirty) await must(repo, ['stash', 'push', '--include-untracked', '-m', autoShelfMessage(original, target)]);
    const restore = async () => {
      await run(repo, ['switch', original]);
      if (dirty) await run(repo, ['stash', 'pop']);
    };
    const sw = await run(repo, ['switch', target]);
    if (!sw.ok) { if (dirty) await run(repo, ['stash', 'pop']); throw new GitError(sw.stderr); }
    let r;
    try { r = await ops.cherryPick(repo, hashes, { x }); }
    catch (e) { await run(repo, ['cherry-pick', '--abort'], { quiet: true }); await restore(); throw e; }
    if (r.conflicts) return { ...r, stayed: true, shelved: dirty, original };
    if (!returnAfter) return { ...r, shelved: dirty, original };
    await must(repo, ['switch', original]);
    if (dirty) {
      const p = await withConflicts(repo, await run(repo, ['stash', 'pop']));
      return { ...r, returned: true, restoreConflicts: !!p.conflicts };
    }
    return { ...r, returned: true };
  },

  cancel: (key) => cancel(key),

  async plan(op, ...args) {
    const fn = plans[op];
    return fn ? fn(...args) : [info('No preview is available for this action.')];
  },

  async clone(url, parent) {
    const name = url.trim().replace(/[\/\\]+$/, '').split(/[\/\\:]/).pop().replace(/\.git$/i, '');
    if (!name) throw new GitError('Could not work out a folder name from that URL.');
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) throw new GitError(`A folder named "${name}" already exists in ${parent}.`, 'EXISTS');
    try { await must(parent, ['clone', '--progress', url.trim(), dest], { progressKey: 'clone' }); }
    catch (e) { if (e.code === 'CANCELLED') fs.rmSync(dest, { recursive: true, force: true }); throw e; }
    return dest;
  },

  async getIdentity() {
    const get = async (key) => (await run(os.homedir(), ['config', '--global', key], { quiet: true })).stdout.trim();
    return { name: await get('user.name'), email: await get('user.email') };
  },

  async setIdentity(name, email) {
    await must(os.homedir(), ['config', '--global', 'user.name', name]);
    await must(os.homedir(), ['config', '--global', 'user.email', email]);
    return true;
  },
};

// Message used when changes are shelved automatically; the UI looks for it to
// offer restoring them when you come back to the branch.
const autoShelfMessage = (from, to) => `[auto] ${from}: left behind when switching to ${to}`;
const revertShelfMessage = (branch) => `[auto] ${branch}: set aside while reversing a commit`;

// The rebase to-do list for tidyCommits, and the message files its "exec" lines read ({dir} is
// replaced with their folder). A message is applied after the last commit squashed into it.
function tidyTodo(steps) {
  const todo = [];
  const files = {};
  let group = null; // the kept commit that following "squash" steps fold into
  const close = () => {
    if (group?.message != null) {
      const name = `msg${group.index}.txt`;
      files[name] = group.message.trim() + '\n';
      todo.push(`exec git commit --amend --only -q -F "{dir}/${name}"`);
    }
    group = null;
  };
  steps.forEach((s, i) => {
    if (s.action === 'drop') { todo.push(`drop ${s.hash}`); return; }
    if (s.action === 'squash') {
      if (!group) throw new GitError('A commit can only be combined into a kept commit before it.');
      todo.push(`fixup ${s.hash}`);
      return;
    }
    close();
    group = { index: i, message: s.message };
    todo.push(`pick ${s.hash}`);
  });
  close();
  return { todo, files };
}

// One patch per partly-ticked file, made from a fresh diff so it matches the files on disk.
async function partialPatches(repo, partial) {
  const patches = [];
  for (const [file, excluded] of Object.entries(partial)) {
    const d = await must(repo, ['diff', 'HEAD', '--', lit(file)], { quiet: true });
    const p = partialPatch(d.stdout, excluded);
    if (p) patches.push(p);
  }
  return patches;
}

async function cherryPickArgs(repo, hashes, x) {
  // Merge commits need "-m 1" (copy the changes relative to their first parent).
  const merges = (await run(repo, ['rev-list', '--no-walk', '--min-parents=2', ...hashes], { quiet: true })).stdout.trim();
  // --empty=drop: quietly skip commits whose changes are already on this branch.
  return ['cherry-pick', '--empty=drop', ...(x ? ['-x'] : []), ...(merges ? ['-m', '1'] : []), ...hashes];
}

// ---------- previews: what each action will run, in plain English ----------
// Paths are shown as plain `-- path` (the app passes the same paths literally).
const step = (args, note) => ({ cmd: 'git ' + args.map(quoteArg).join(' '), note });
const info = (note) => ({ cmd: null, note });
const firstLine = (m) => (m.includes('\n') ? m.split('\n')[0] + ' …' : m);
const OP_CMD = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' };

const plans = {
  async commit(repo, { message, paths, all, amend = false, partial = null }) {
    const st = await ops.status(repo);
    const a = amend ? ['--amend'] : [];
    const what = amend ? 'Add to your last commit and replace its message (instead of making a new commit).' : 'Save a snapshot with your message. It stays on your computer until you Send.';
    const some = Object.keys(partial || {});
    if (some.length) {
      const whole = paths.filter((p) => !some.includes(p));
      return [
        step(['reset', '-q'], 'Start the commit from your last commit. Your files on disk are not touched.'),
        ...(whole.length ? [step(['add', '-A', '--', ...whole], 'Include the files you ticked completely.')] : []),
        ...some.map((f) => step(['apply', '--cached', '-'], `Include only the lines you ticked in ${f}. The unticked lines stay as uncommitted changes.`)),
        step(['commit', ...a, '-m', firstLine(message)], what),
      ];
    }
    if (all || st.op) {
      return [
        step(['add', '-A'], 'Include every changed, new and deleted file in the commit.'),
        step(['commit', ...a, '-m', firstLine(message)], what),
      ];
    }
    if (!paths.length && amend) return [step(['commit', '--amend', '--only', '-m', firstLine(message)], 'Just change the last commit\'s message.')];
    return [
      step(['add', '-A', '--', ...paths], 'Mark the ticked files as ready to commit (“staging”).'),
      step(['commit', ...a, '-m', firstLine(message), '--', ...paths], amend ? what : 'Save a snapshot of just those files. Unticked files are left alone.'),
    ];
  },
  resetTo: (repo, oid, mode = 'keep') => [step(['reset', `--${mode}`, oid.slice(0, 10)], mode === 'soft'
    ? 'Move the branch back to before that commit, keeping its changes in your folder.'
    : 'Move the branch back to where it was before. Uncommitted edits in the files it changes are set aside and put back.')],
  restoreBranch: (repo, name, oid) => [step(['branch', name, oid.slice(0, 10)], `Bring the branch ${name} back, exactly as it was.`)],
  stashStore: (repo, oid, message) => [step(['stash', 'store', '-m', message, oid.slice(0, 10)], 'Put the deleted item back on the Shelf.')],
  async discard(repo, paths) {
    const hasHead = (await run(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { quiet: true })).ok;
    if (!hasHead) return [info('Move these new files to the Recycle Bin (the repo has no commits yet, so the Shelf is unavailable).')];
    return [step(['stash', 'push', '--include-untracked', '-m', `[discarded] ${paths.length === 1 ? paths[0] : `${paths.length} files`}`, '--', ...paths],
      'Move your changes to these files onto the Shelf and put the files back to your last commit. You can restore them from the Shelf.')];
  },
  ignore: (repo, file) => [info(`Add /${file.replace(/\\/g, '/')} to the .gitignore file so git stops showing it.`)],
  fetch: () => [step(['fetch', '--all', '--prune'], "Ask the server(s) what's new, and forget branches that were deleted there. None of your files change.")],
  pull: (repo, mode) => (mode === 'merge'
    ? [step(['pull', '--no-rebase', '--no-edit', '--autostash'], 'Download the server commits and join them with yours in a merge commit. Uncommitted edits are shelved and put back automatically.')]
    : [step(['pull', '--ff-only', '--autostash'], 'Download new commits and move your branch forward — only if no merge is needed. Uncommitted edits are shelved and put back automatically.')]),
  async push(repo) {
    const st = await ops.status(repo);
    if (st.detached) return [info("You're not on a branch, so there's nothing to send.")];
    if (st.upstream) return [step(['push'], `Upload your commits on ${st.branch} to ${st.upstream}.`)];
    const remotes = (await run(repo, ['remote'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
    if (!remotes.length) return [info("No server is set up yet — you'll be asked for its URL (git remote add origin <url>), then the branch is published.")];
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    return [step(['push', '-u', remote, 'HEAD'], `Publish ${st.branch} to ${remote} for the first time, and remember the link (-u) so later Sends just work.`)];
  },
  addRemote: (repo, url) => [step(['remote', 'add', 'origin', url], 'Remember this URL as the server, under the nickname “origin”.')],
  createBranch: (repo, name, start) => [step(['switch', '-c', name, '--no-track', ...(start ? [start] : [])], `Create the branch ${name} starting from ${start || 'where you are now'}, and switch to it. Uncommitted edits come along.`)],
  switchBranch: (repo, name) => [step(['switch', name], `Change the files in your folder to ${name}'s version. Uncommitted edits come along if they don't clash.`)],
  checkoutRemote: (repo, remoteBranch, localName) => [step(['switch', '-c', localName, '--track', remoteBranch], `Make a local branch ${localName} from the server's ${remoteBranch}, linked to it, and switch to it.`)],
  renameBranch: (repo, oldName, newName) => [step(['branch', '-m', oldName, newName], 'Rename the branch on your computer only.')],
  deleteBranch: (repo, name, { force = false, remote = null } = {}) => [
    step(['branch', force ? '-D' : '-d', name], force ? 'Delete the branch even though it has commits nowhere else (they will be lost).' : 'Delete the branch from your computer (refuses if that would lose commits).'),
    ...(remote ? [step(['push', remote.remote, '--delete', remote.branch], 'Also delete it on the server.')] : []),
  ],
  merge: (repo, branch) => [step(['merge', '--no-edit', '--autostash', branch], `Copy the commits from ${branch} into your current branch. If the same lines changed on both, you'll be asked to resolve conflicts.`)],
  async finishBranch(repo, { deleteRemote = false } = {}) {
    const st = await ops.status(repo);
    const target = (await ops.defaultBranch(repo)) || 'main';
    const slash = st.upstream ? st.upstream.indexOf('/') : -1;
    return [
      ...(st.hasRemote ? [step(['fetch', '--prune'], 'Ask the server what changed, so the merged work is known.')] : []),
      step(['switch', target], `Go to ${target}.`),
      ...(st.upstream ? [step(['pull', '--ff-only', '--autostash'], `Get the latest ${target}, which now includes your merged work.`)] : []),
      step(['branch', '-D', st.branch], `Delete ${st.branch} on your computer. Undo can bring it back.`),
      ...(deleteRemote && slash > 0 && !st.upstreamGone ? [step(['push', st.upstream.slice(0, slash), '--delete', st.upstream.slice(slash + 1)], 'Also delete it on the server.')] : []),
    ];
  },
  tidyCommits: (repo, steps) => {
    const { todo } = tidyTodo(steps);
    const words = { pick: 'keep', fixup: 'combine into the one above', drop: 'drop' };
    return [
      step(['rebase', '-i', '--autostash', `${steps[0].hash.slice(0, 10)}^`], 'Replay your unsent commits with these changes (oldest first). They get new IDs; nothing on the server is touched.'),
      ...todo.map((l) => (l.startsWith('exec')
        ? info('…then change that commit\'s message to the one you wrote.')
        : info(`${words[l.split(' ')[0]]}: ${l.split(' ')[1].slice(0, 7)}`))),
    ];
  },
  updateFrom: (repo, ref, mode = 'merge') => [mode === 'rebase'
    ? step(['rebase', '--autostash', ref], `Replay your commits on top of the latest ${ref}, as if you had started from there. Gives a straight history; your commits get new IDs.`)
    : step(['merge', '--no-edit', '--autostash', ref], `Bring ${ref}'s new commits into your branch with a merge commit. Nothing that's already there is rewritten.`)],
  async revertCommit(repo, hash) {
    const st = await ops.status(repo);
    const dirty = st.staged.length + st.unstaged.length + st.untracked.length > 0;
    const merge = (await run(repo, ['rev-list', '--no-walk', '--min-parents=2', hash], { quiet: true })).stdout.trim();
    return [
      ...(dirty ? [step(['stash', 'push', '--include-untracked', '-m', revertShelfMessage(st.branch)], 'Put your uncommitted changes on the Shelf for a moment.')] : []),
      step(['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), hash.slice(0, 10)], 'Make a new commit that does the exact opposite of that one. The original commit stays in the history.'),
      ...(dirty ? [step(['stash', 'pop'], 'Put your uncommitted changes back.')] : []),
    ];
  },
  undoLastCommit: () => [step(['reset', '--soft', 'HEAD~1'], 'Remove the last commit but keep all its changes in your folder, ready to commit again.')],
  stashSave: (repo, message, paths = null) => [paths?.length
    ? step(['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : []), '--', ...paths], 'Put the changes to these files on the Shelf and put the files back to your last commit. Other changes stay where they are.')
    : step(['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])], 'Put all uncommitted changes (including new files) on the Shelf and make your folder match your last commit.')],
  discardLines: (repo, file, keys) => [step(['apply', '-R', '-'], `Throw away ${keys.length === 1 ? 'this changed line' : `these ${keys.length} changed lines`} in ${file}, putting them back to your last commit. Undo puts them back.`)],
  applyPatch: () => [step(['apply', '-'], 'Put the thrown-away lines back.')],
  stashApply: (repo, ref) => [step(['stash', 'apply', ref], 'Copy the changes from this Shelf item into your folder, keeping the item on the Shelf.')],
  stashPop: (repo, ref) => [step(['stash', 'pop', ref], 'Put the changes from this Shelf item back into your folder and remove it from the Shelf (kept if there are conflicts).')],
  stashDrop: (repo, ref) => [step(['stash', 'drop', ref], 'Delete this item from the Shelf for good.')],
  resolveSide: (repo, file, side) => [
    step(['checkout', `--${side}`, '--', file], `Take the ${side === 'ours' ? '“ours”' : '“theirs”'} version of the whole file.`),
    step(['add', '--', file], 'Mark the file as resolved. (If that side deleted the file, git rm is used instead.)'),
  ],
  saveResolution: (repo, file) => [info(`Write your resolved version of ${file} to disk.`), step(['add', '--', file], 'Mark the file as resolved.')],
  markResolved: (repo, file) => (fs.existsSync(path.join(repo, file))
    ? [step(['add', '--', file], 'Mark the file as resolved, exactly as it is on disk now.')]
    : [step(['rm', '--cached', '--', file], 'Mark the file as resolved by keeping it deleted.')]),
  abortOp: (repo, kind) => [step([OP_CMD[kind], '--abort'], `Cancel the ${kind} and put everything back how it was before it started.`)],
  continueOp: (repo, kind) => [kind === 'merge'
    ? step(['commit', '--no-edit'], 'Create the merge commit with your resolved files, finishing the merge.')
    : step([OP_CMD[kind], '--continue'], `Save the resolved files and carry on with the ${kind}.`)],
  skipOp: (repo, kind) => [step([kind, '--skip'], 'Leave this commit out and carry on with the rest.')],
  async cherryPick(repo, hashes, { x = false } = {}) {
    return [step(await cherryPickArgs(repo, hashes, x), `Copy ${hashes.length === 1 ? 'this commit' : `these ${hashes.length} commits (oldest first)`} onto your current branch as new commits. Ones whose changes are already there are skipped${x ? '; each message gets a “cherry picked from” note' : ''}.`)];
  },
  async cherryPickOnto(repo, { hashes, target, returnAfter = true, x = false }) {
    const st = await ops.status(repo);
    const dirty = st.staged.length + st.unstaged.length + st.untracked.length > 0;
    return [
      ...(dirty ? [step(['stash', 'push', '--include-untracked', '-m', autoShelfMessage(st.branch, target)], 'Put your uncommitted changes on the Shelf for a moment.')] : []),
      step(['switch', target], `Go to ${target}.`),
      ...(await plans.cherryPick(repo, hashes, { x })),
      ...(returnAfter ? [step(['switch', st.branch], `Come back to ${st.branch}.`)] : []),
      ...(returnAfter && dirty ? [step(['stash', 'pop'], 'Put your uncommitted changes back.')] : []),
    ];
  },
  clone: (url, parent) => [step(['clone', url.trim()], `Download a full copy of the repo into a new folder inside ${parent}.`)],
  init: () => [step(['init'], 'Start tracking this folder with git (creates the hidden .git folder). Your files are not changed.')],
  setIdentity: (name, email) => [
    step(['config', '--global', 'user.name', name], 'Set the name stamped on your commits (for every repo on this computer).'),
    step(['config', '--global', 'user.email', email], 'Set the email stamped on your commits.'),
  ],
};

module.exports = { ops, setLogger, setProgress };
