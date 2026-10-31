// End-to-end tests of src/git.js against real (throwaway) repos.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ops } = require('../src/git');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

test('status, commits and pushing a new branch', async () => {
  const a = sb.repo('basics');
  let st = await ops.status(a);
  assert.ok(st.initial);
  assert.equal(st.branch, 'main');
  assert.equal(st.hasRemote, false);

  sb.write(a, 'readme.md', 'hello\n');
  sb.write(a, 'src/app [1].txt', 'one\n'); // glob characters in the name
  st = await ops.status(a);
  assert.equal(st.untracked.length, 2);

  await ops.commit(a, { message: 'first', paths: ['readme.md'], all: false });
  st = await ops.status(a);
  assert.deepEqual(st.untracked.map((f) => f.path), ['src/app [1].txt'], 'unticked file stays uncommitted');

  await ops.commit(a, { message: 'second', paths: [], all: true });
  await ops.addRemote(a, sb.server('basics'));
  const p = await ops.push(a);
  assert.ok(p.published);
  st = await ops.status(a);
  assert.equal(st.upstream, 'origin/main');
  assert.equal(st.hasRemote, true);
});

test('pull: fast-forward, divergence, conflicts, resolution', async () => {
  const srv = sb.server('sync');
  const a = sb.repo('sync-a');
  sb.write(a, 'f.txt', 'line1\nline2\nline3\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.addRemote(a, srv);
  await ops.push(a);
  const b = sb.clone(srv, 'sync-b');

  sb.write(b, 'g.txt', 'from b\n');
  await ops.commit(b, { message: 'b1', paths: [], all: true });
  await ops.push(b);
  sb.write(a, 'local.txt', 'uncommitted\n');
  await ops.fetch(a);
  assert.equal((await ops.status(a)).behind, 1);
  assert.ok((await ops.pull(a, 'ff')).ok, 'fast-forward with uncommitted work (autostash)');
  assert.ok(fs.existsSync(path.join(a, 'local.txt')));
  fs.unlinkSync(path.join(a, 'local.txt'));

  sb.write(b, 'f.txt', 'line1\nB\nline3\n');
  await ops.commit(b, { message: 'b2', paths: [], all: true });
  await ops.push(b);
  sb.write(a, 'f.txt', 'line1\nA\nline3\n');
  await ops.commit(a, { message: 'a2', paths: [], all: true });
  assert.ok((await ops.push(a)).rejected);
  await ops.fetch(a);
  assert.ok((await ops.pull(a, 'ff')).diverged);
  assert.ok((await ops.pull(a, 'merge')).conflicts);

  let st = await ops.status(a);
  assert.equal(st.op.kind, 'merge');
  assert.equal(st.conflicted[0].path, 'f.txt');
  const v = await ops.conflictVersions(a, 'f.txt');
  assert.match(v.base, /line2/);
  assert.match(v.ours, /A/);
  assert.match(v.theirs, /B/);

  await ops.saveResolution(a, 'f.txt', 'line1\nA\nB\nline3\n');
  assert.ok((await ops.continueOp(a, 'merge')).ok);
  st = await ops.status(a);
  assert.equal(st.op, null);
  assert.ok((await ops.push(a)).ok);
});

test('branches: create, switch, delete and restore (undo)', async () => {
  const a = sb.repo('branches');
  sb.write(a, 'x.txt', 'x\n');
  await ops.commit(a, { message: 'x', paths: [], all: true });
  await ops.createBranch(a, 'feature/one', null);
  sb.write(a, 'y.txt', 'y\n');
  await ops.commit(a, { message: 'y', paths: [], all: true });
  await ops.switchBranch(a, 'main');
  assert.ok(await ops.checkBranchName('feature/ok'));
  assert.ok(!(await ops.checkBranchName('bad..name')));

  await assert.rejects(ops.deleteBranch(a, 'feature/one'), /not fully merged/);
  const { oid } = await ops.deleteBranch(a, 'feature/one', { force: true });
  assert.ok(!(await ops.branches(a)).local.some((b) => b.name === 'feature/one'));
  await ops.restoreBranch(a, 'feature/one', oid);
  assert.ok((await ops.branches(a)).local.some((b) => b.name === 'feature/one'), 'undo brings the branch back');
});

test('undo: soft reset keeps a commit\'s changes; amend replaces the last commit', async () => {
  const a = sb.repo('undo');
  sb.write(a, 'a.txt', 'a\n');
  await ops.commit(a, { message: 'one', paths: [], all: true });
  const before = await ops.headOid(a);
  sb.write(a, 'b.txt', 'b\n');
  await ops.commit(a, { message: 'two', paths: [], all: true });
  await ops.resetTo(a, before, 'soft');
  assert.equal(await ops.headOid(a), before);
  assert.equal((await ops.status(a)).staged.length, 1, 'the undone commit\'s change is back');

  await ops.commit(a, { message: 'two again', paths: [], all: true });
  const last = await ops.lastCommit(a);
  assert.equal(last.message, 'two again');
  assert.equal(last.pushed, false);
  sb.write(a, 'c.txt', 'c\n');
  await ops.commit(a, { message: 'two, amended', paths: ['c.txt'], all: false, amend: true });
  const h = await ops.history(a);
  assert.equal(h.commits.length, 2, 'amend did not add a commit');
  assert.equal(h.commits[0].subject, 'two, amended');
  await ops.commit(a, { message: 'message only', paths: [], all: false, amend: true });
  assert.equal((await ops.lastCommit(a)).message, 'message only');
});

test('shelf: save, drop and put back (undo)', async () => {
  const a = sb.repo('shelf');
  sb.write(a, 'a.txt', 'a\n');
  await ops.commit(a, { message: 'a', paths: [], all: true });
  sb.write(a, 'a.txt', 'changed\n');
  sb.write(a, 'new.txt', 'new\n');
  await ops.discard(a, ['a.txt']);
  let list = await ops.stashList(a);
  assert.match(list[0].message, /^\[discarded\]/);
  await ops.stashSave(a, 'my work');
  assert.equal((await ops.status(a)).untracked.length, 0, 'new files are shelved too');
  list = await ops.stashList(a);
  const dropped = await ops.stashDrop(a, list[0].ref);
  assert.equal((await ops.stashList(a)).length, 1);
  await ops.stashStore(a, dropped.oid, dropped.message);
  assert.equal((await ops.stashList(a))[0].message, 'my work', 'undo puts it back');
  assert.ok((await ops.stashPop(a, 'stash@{0}')).ok);
  assert.ok(fs.existsSync(path.join(a, 'new.txt')));
});

test('cherry-pick: candidates, picking, skipping, copying to another branch', async () => {
  const a = sb.repo('cherry');
  sb.write(a, 'readme.md', 'one\ntwo\nthree\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.createBranch(a, 'hotfix', null);
  sb.write(a, 'fix1.txt', '1\n');
  await ops.commit(a, { message: 'fix one', paths: [], all: true });
  sb.write(a, 'fix2.txt', '2\n');
  await ops.commit(a, { message: 'fix two', paths: [], all: true });
  await ops.switchBranch(a, 'main');

  let h = await ops.history(a, { ref: 'hotfix', notIn: true });
  assert.deepEqual(h.commits.map((c) => c.subject), ['fix two', 'fix one']);
  const one = h.commits[1].hash;
  assert.equal((await ops.cherryPick(a, [one])).picked, 1);
  h = await ops.history(a, { ref: 'hotfix', notIn: true });
  assert.deepEqual(h.commits.map((c) => c.subject), ['fix two'], 'already-picked commit is hidden');
  assert.equal((await ops.cherryPick(a, [one])).picked, 0, 'picking again is a no-op');

  // a clashing commit followed by a clean one: skip the clash, keep the rest
  await ops.switchBranch(a, 'hotfix');
  sb.write(a, 'readme.md', 'one\nHOTFIX\nthree\n');
  await ops.commit(a, { message: 'hotfix readme', paths: [], all: true });
  sb.write(a, 'fix3.txt', '3\n');
  await ops.commit(a, { message: 'fix three', paths: [], all: true });
  await ops.switchBranch(a, 'main');
  sb.write(a, 'readme.md', 'one\nMAIN\nthree\n');
  await ops.commit(a, { message: 'main readme', paths: [], all: true });
  h = await ops.history(a, { ref: 'hotfix', notIn: true });
  const seq = h.commits.filter((c) => ['hotfix readme', 'fix three'].includes(c.subject)).reverse().map((c) => c.hash);
  assert.ok((await ops.cherryPick(a, seq, { x: true })).conflicts);
  const st = await ops.status(a);
  assert.equal(st.op.kind, 'cherry-pick');
  assert.equal(st.op.remaining, 1, 'one more commit queued after the one that stopped');
  assert.ok((await ops.skipOp(a, 'cherry-pick')).ok);
  assert.equal((await ops.history(a)).commits[0].subject, 'fix three');

  // copy to another branch with uncommitted work, and come back
  await ops.createBranch(a, 'release', 'hotfix~3');
  await ops.switchBranch(a, 'main');
  sb.write(a, 'wip.txt', 'not committed\n');
  const pick = (await ops.history(a)).commits[1].hash;
  const r = await ops.cherryPickOnto(a, { hashes: [pick], target: 'release', returnAfter: true });
  assert.ok(r.returned);
  assert.equal((await ops.status(a)).branch, 'main');
  assert.ok(fs.existsSync(path.join(a, 'wip.txt')), 'uncommitted work restored');
  assert.equal((await ops.history(a, { ref: 'release' })).commits[0].subject, 'main readme');
});

test('history of one file, tidy-up candidates and pull request links', async () => {
  const srv = sb.server('tidy');
  const a = sb.repo('tidy');
  sb.write(a, 'a.txt', 'a\n');
  await ops.commit(a, { message: 'add a', paths: [], all: true });
  sb.write(a, 'b.txt', 'b\n');
  await ops.commit(a, { message: 'add b', paths: [], all: true });
  sb.write(a, 'a.txt', 'a2\n');
  await ops.commit(a, { message: 'edit a', paths: [], all: true });
  const fh = await ops.history(a, { file: 'a.txt' });
  assert.deepEqual(fh.commits.map((c) => c.subject), ['edit a', 'add a']);

  await ops.addRemote(a, srv);
  await ops.push(a);
  await ops.createBranch(a, 'merged-one', null);
  await ops.switchBranch(a, 'main');
  await ops.createBranch(a, 'gone-one', null);
  sb.write(a, 'g.txt', 'g\n');
  await ops.commit(a, { message: 'g', paths: [], all: true });
  await ops.push(a);
  sb.sh(a, 'push', '-q', 'origin', '--delete', 'gone-one');
  await ops.fetch(a);
  await ops.switchBranch(a, 'main');
  const t = await ops.tidyCandidates(a);
  assert.equal(t.defaultBranch, 'main');
  const byName = Object.fromEntries(t.branches.map((b) => [b.name, b]));
  assert.ok(byName['merged-one'].merged);
  assert.ok(byName['gone-one'].gone && !byName['gone-one'].merged);
  assert.ok(!byName.main, 'main is never offered');

  const link = async (url) => { sb.sh(a, 'remote', 'set-url', 'origin', url); return ops.prUrl(a, 'feature/x'); };
  assert.equal(await link('git@github.com:acme/api.git'), 'https://github.com/acme/api/compare/feature%2Fx?expand=1');
  assert.equal(await link('https://dev.azure.com/acme/Shop/_git/api'), 'https://dev.azure.com/acme/Shop/_git/api/pullrequestcreate?sourceRef=feature%2Fx');
  assert.equal(await link('git@ssh.dev.azure.com:v3/acme/Shop/api'), 'https://dev.azure.com/acme/Shop/_git/api/pullrequestcreate?sourceRef=feature%2Fx');
  assert.match(await link('https://gitlab.com/acme/api.git'), /gitlab\.com\/acme\/api\/-\/merge_requests\/new/);
});

test('previews describe what will run', async () => {
  const a = sb.repo('plans');
  const commit = await ops.plan('commit', a, { message: 'msg\n\nbody', paths: ['x.txt'], all: false });
  assert.equal(commit.length, 2);
  assert.match(commit[1].cmd, /-- x\.txt/);
  assert.match((await ops.plan('commit', a, { message: 'm', paths: [], all: true, amend: true }))[1].cmd, /--amend/);
  assert.equal((await ops.plan('push', a))[0].cmd, null, 'no server: explains instead of a command');
  assert.match((await ops.plan('resetTo', a, 'a'.repeat(40), 'soft'))[0].cmd, /reset --soft/);
  assert.equal((await ops.plan('nonsense')).length, 1);
});
