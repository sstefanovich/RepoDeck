// All git work happens here, in the main process. Every operation shells out to
// the real git CLI (no shell, args passed as an array) so behaviour matches
// what you'd get in a terminal.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Treat file names literally (so names like "app [1].txt" aren't read as glob patterns).
const lit = (p) => `:(literal)${p}`;

const quoteArg = (a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(cwd, args, { quiet = false, input, background = false } = {}) {
  return new Promise((resolve) => {
    const env = background ? { ...ENV, GCM_INTERACTIVE: 'never' } : ENV;
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=never', ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        const res = { ok: !err, stdout: stdout || '', stderr: stderr || (err && !stdout ? err.message : '') };
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
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

class GitError extends Error {
  constructor(message, code = 'GIT') { super(message.trim() || 'git failed'); this.code = code; }
}

async function must(cwd, args, opts) {
  const r = await run(cwd, args, opts);
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
  if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', ours: `Yours (${branch || 'current'})`, theirs: 'The commit being copied', incoming: 'a commit' };
  if (has('REVERT_HEAD')) return { kind: 'revert', ours: `Yours (${branch || 'current'})`, theirs: 'The undo', incoming: 'a revert' };
  return null;
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
    const s = { branch: null, detached: false, oid: null, initial: false, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] };
    const parts = r.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (!line) continue;
      if (line.startsWith('# branch.oid ')) { s.oid = line.slice(13); s.initial = s.oid === '(initial)'; }
      else if (line.startsWith('# branch.head ')) { const h = line.slice(14); if (h === '(detached)') s.detached = true; else s.branch = h; }
      else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { s.ahead = +m[1]; s.behind = +m[2]; } }
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

  async commit(repo, { message, paths, all }) {
    const st = await ops.status(repo);
    if (st.conflicted.length) throw new GitError('You have unresolved conflicts. Resolve them first.', 'CONFLICTS');
    if (all || st.op) {
      await must(repo, ['add', '-A']);
      await must(repo, ['commit', '-m', message]);
    } else {
      const spec = paths.map(lit).join('\0');
      await must(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec });
      await must(repo, ['commit', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec });
    }
    return true;
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

  async deleteBranch(repo, name, { force = false, remote = null } = {}) {
    await must(repo, ['branch', force ? '-D' : '-d', name]);
    if (remote) await must(repo, ['push', remote.remote, '--delete', remote.branch]);
    return true;
  },

  async merge(repo, branch) {
    return withConflicts(repo, await run(repo, ['merge', '--no-edit', '--autostash', branch]));
  },

  async fetch(repo, { background = false } = {}) {
    await must(repo, ['fetch', '--all', '--prune'], { quiet: background, background });
    return true;
  },

  // mode 'ff': only fast-forward (safe, never creates a merge).
  // mode 'merge': combine diverged histories with a merge commit.
  async pull(repo, mode = 'ff') {
    const args = mode === 'merge' ? ['pull', '--no-rebase', '--no-edit', '--autostash'] : ['pull', '--ff-only', '--autostash'];
    const r = await run(repo, args);
    if (!r.ok && /fast-forward|diverg/i.test(r.stderr)) return { ok: false, diverged: true, output: r.stderr.trim() };
    return withConflicts(repo, r);
  },

  async push(repo) {
    const st = await ops.status(repo);
    if (st.detached) throw new GitError('You are not on a branch, so there is nothing to push. Create a branch first.', 'DETACHED');
    if (st.upstream) {
      const r = await run(repo, ['push']);
      if (!r.ok && /rejected|fetch first|non-fast-forward/i.test(r.stderr)) return { ok: false, rejected: true, output: r.stderr.trim() };
      if (!r.ok) throw new GitError(r.stderr);
      return { ok: true, output: (r.stdout + r.stderr).trim() };
    }
    const remotes = (await run(repo, ['remote'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
    if (!remotes.length) throw new GitError('This repo has no server (remote) configured.', 'NO_REMOTE');
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const r = await run(repo, ['push', '-u', remote, 'HEAD']);
    if (!r.ok && /rejected|fetch first|non-fast-forward/i.test(r.stderr)) return { ok: false, rejected: true, output: r.stderr.trim() };
    if (!r.ok) throw new GitError(r.stderr);
    return { ok: true, published: true, output: (r.stdout + r.stderr).trim() };
  },

  async addRemote(repo, url) {
    await must(repo, ['remote', 'add', 'origin', url]);
    return true;
  },

  async remoteWebUrl(repo) {
    const r = await run(repo, ['remote', 'get-url', 'origin'], { quiet: true });
    return r.ok ? webUrl(r.stdout) : null;
  },

  async history(repo, { limit = 300 } = {}) {
    const fmt = '%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1f%P%x1e';
    const parse = (out) => out.split('\x1e').map((s) => s.replace(/^\s+/, '')).filter(Boolean).map((rec) => {
      const [hash, short, author, date, subject, refs, parents] = rec.split('\x1f');
      return { hash, short, author, date: +date, subject, refs: refs ? refs.split(', ') : [], parents: parents ? parents.split(' ') : [] };
    });
    const r = await run(repo, ['log', `-n${limit}`, `--format=${fmt}`, 'HEAD'], { quiet: true });
    if (!r.ok) return { commits: [], unpushed: [], incoming: [], upstream: null };
    const commits = parse(r.stdout);
    const up = await run(repo, ['rev-parse', '--abbrev-ref', '@{u}'], { quiet: true });
    let unpushed = [];
    let incoming = [];
    if (up.ok) {
      unpushed = (await run(repo, ['rev-list', '@{u}..HEAD'], { quiet: true })).stdout.split(/\r?\n/).filter(Boolean);
      incoming = parse((await run(repo, ['log', `--format=${fmt}`, 'HEAD..@{u}'], { quiet: true })).stdout);
    }
    return { commits, unpushed, incoming, upstream: up.ok ? up.stdout.trim() : null };
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
    const r = await run(repo, ['stash', 'list', '--format=%gd%x1f%ct%x1f%gs'], { quiet: true });
    if (!r.ok) return [];
    return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
      const [ref, ct, gs] = l.split('\x1f');
      const m = gs.match(/^(?:WIP on|On) ([^:]+): (.*)$/);
      return { ref, time: +ct, branch: m ? m[1] : '', message: m ? m[2] : gs };
    });
  },

  async stashSave(repo, message) {
    const args = ['stash', 'push', '--include-untracked'];
    if (message) args.push('-m', message);
    await must(repo, args);
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

  async stashDrop(repo, ref) {
    await must(repo, ['stash', 'drop', ref]);
    return true;
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

  async clone(url, parent) {
    const name = url.trim().replace(/[\/\\]+$/, '').split(/[\/\\:]/).pop().replace(/\.git$/i, '');
    if (!name) throw new GitError('Could not work out a folder name from that URL.');
    const dest = path.join(parent, name);
    if (fs.existsSync(dest)) throw new GitError(`A folder named "${name}" already exists in ${parent}.`, 'EXISTS');
    await must(parent, ['clone', '--progress', url.trim(), dest]);
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

module.exports = { ops, setLogger };
