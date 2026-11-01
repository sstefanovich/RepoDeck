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

test('commit only some lines of a file', async () => {
  const { changedLines } = require('../renderer/lib');
  const a = sb.repo('partial');
  sb.write(a, 'f.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  sb.write(a, 'g.txt', 'g\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  // Two separate blocks of changes in f.txt, plus a change in g.txt.
  sb.write(a, 'f.txt', 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n');
  sb.write(a, 'g.txt', 'g2\n');
  const d = await ops.fileDiff(a, ['f.txt']);
  const rows = changedLines(d.text);
  // Leave out the second block (TEN + eleven), commit the first block and all of g.txt.
  const excluded = rows.filter((r) => /TEN|ten|eleven/.test(r.text)).map((r) => r.key);
  await ops.commit(a, { message: 'some lines', paths: ['f.txt', 'g.txt'], all: false, partial: { 'f.txt': excluded } });
  assert.equal(sb.sh(a, 'show', 'HEAD:f.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  assert.equal(sb.sh(a, 'show', 'HEAD:g.txt'), 'g2\n');
  assert.equal(fs.readFileSync(path.join(a, 'f.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n', 'the file on disk is untouched');
  const st = await ops.status(a);
  assert.deepEqual(st.unstaged.map((f) => f.path), ['f.txt'], 'the left-out lines are still uncommitted');
  assert.equal(st.staged.length, 0);

  // Only an added line out of a replaced pair: keep "eleven" out, take TEN.
  const d2 = await ops.fileDiff(a, ['f.txt']);
  const rows2 = changedLines(d2.text);
  await ops.commit(a, { message: 'TEN', paths: ['f.txt'], all: false, partial: { 'f.txt': rows2.filter((r) => r.text === 'eleven').map((r) => r.key) } });
  assert.match(sb.sh(a, 'show', 'HEAD:f.txt'), /nine\nTEN\n$/);
  const plan = await ops.plan('commit', a, { message: 'm', paths: ['f.txt'], all: false, partial: { 'f.txt': [] } });
  assert.ok(plan.some((s) => /apply --cached/.test(s.cmd)));
});

test('update from another branch: merge, rebase, and the rebase safety check', async () => {
  const srv = sb.server('update');
  const a = sb.repo('update');
  sb.write(a, 'base.txt', 'base\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.createBranch(a, 'dev', null);
  sb.write(a, 'dev.txt', 'dev\n');
  await ops.commit(a, { message: 'on dev', paths: [], all: true });
  await ops.switchBranch(a, 'main');
  await ops.createBranch(a, 'feature', null);
  sb.write(a, 'feature.txt', 'feature\n');
  await ops.commit(a, { message: 'on feature', paths: [], all: true });

  let c = await ops.compareCounts(a, 'dev');
  assert.deepEqual([c.ahead, c.behind, c.canRebase], [1, 1, true]);
  assert.ok((await ops.updateFrom(a, 'dev', 'rebase')).ok);
  let h = await ops.history(a);
  assert.deepEqual(h.commits.map((x) => x.subject), ['on feature', 'on dev', 'base'], 'rebase gives a straight line');

  // Once feature is on the server, rebasing would rewrite sent commits.
  await ops.addRemote(a, srv);
  await ops.push(a);
  await ops.switchBranch(a, 'dev');
  sb.write(a, 'dev2.txt', 'dev2\n');
  await ops.commit(a, { message: 'more dev', paths: [], all: true });
  await ops.switchBranch(a, 'feature');
  c = await ops.compareCounts(a, 'dev');
  assert.equal(c.behind, 1);
  assert.equal(c.canRebase, false);
  sb.write(a, 'wip.txt', 'uncommitted\n');
  assert.ok((await ops.updateFrom(a, 'dev', 'merge')).ok);
  h = await ops.history(a);
  assert.equal(h.commits[0].parents.length, 2, 'a merge commit');
  assert.ok(fs.existsSync(path.join(a, 'wip.txt')), 'uncommitted work kept');
});

test('revert an older commit, including a clash', async () => {
  const a = sb.repo('revert');
  sb.write(a, 'f.txt', 'a\n');
  await ops.commit(a, { message: 'one', paths: [], all: true });
  sb.write(a, 'g.txt', 'g\n');
  await ops.commit(a, { message: 'add g', paths: [], all: true });
  const addG = await ops.headOid(a);
  sb.write(a, 'f.txt', 'b\n');
  await ops.commit(a, { message: 'f to b', paths: [], all: true });
  const fToB = await ops.headOid(a);
  sb.write(a, 'f.txt', 'c\n');
  await ops.commit(a, { message: 'f to c', paths: [], all: true });

  assert.ok((await ops.revertCommit(a, addG)).ok);
  assert.ok(!fs.existsSync(path.join(a, 'g.txt')), 'the old commit is reversed');
  assert.match((await ops.history(a)).commits[0].subject, /^Revert "add g"/);
  assert.ok((await ops.revertCommit(a, fToB)).conflicts, 'a later commit changed the same line');
  assert.equal((await ops.status(a)).op.kind, 'revert');
  await ops.abortOp(a, 'revert');
  assert.equal((await ops.status(a)).op, null);
});

test('revert with uncommitted edits in the same file sets them aside and puts them back', async () => {
  const a = sb.repo('revert-dirty');
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
  sb.write(a, 'f.txt', ten.join('\n') + '\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  sb.write(a, 'f.txt', ['l1', 'CHANGED', ...ten.slice(2)].join('\n') + '\n');
  await ops.commit(a, { message: 'change l2', paths: [], all: true });
  const change = await ops.headOid(a);
  sb.write(a, 'other.txt', 'o\n');
  await ops.commit(a, { message: 'other', paths: [], all: true });
  // An uncommitted edit far from the reverted line.
  sb.write(a, 'f.txt', ['l1', 'CHANGED', ...ten.slice(2, 8), 'MY EDIT', 'l10'].join('\n') + '\n');
  const before = await ops.headOid(a);
  const r = await ops.revertCommit(a, change);
  assert.ok(r.ok && !r.shelved && !r.restoreConflicts);
  const text = () => fs.readFileSync(path.join(a, 'f.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text(), ['l1', 'l2', ...ten.slice(2, 8), 'MY EDIT', 'l10'].join('\n') + '\n', 'reverted, with the edit kept');
  assert.equal((await ops.stashList(a)).length, 0, 'nothing left on the Shelf');
  // Undo (reset --keep) works too, although the edit is in a file it changes.
  assert.ok((await ops.resetTo(a, before, 'keep')).ok);
  assert.equal(await ops.headOid(a), before);
  assert.equal(text(), ['l1', 'CHANGED', ...ten.slice(2, 8), 'MY EDIT', 'l10'].join('\n') + '\n', 'undone, with the edit kept');
  assert.equal((await ops.stashList(a)).length, 0);

  // A revert that conflicts leaves the edits on the Shelf until it's finished.
  sb.sh(a, 'checkout', '-q', '--', 'f.txt');
  await ops.commit(a, { message: 'keep', paths: [], all: true }).catch(() => {});
  sb.write(a, 'f.txt', ['l1', 'AGAIN', ...ten.slice(2)].join('\n') + '\n');
  await ops.commit(a, { message: 'l2 again', paths: [], all: true });
  sb.write(a, 'other.txt', 'uncommitted\n');
  const c = await ops.revertCommit(a, change);
  assert.ok(c.conflicts && c.shelved);
  assert.match((await ops.stashList(a))[0].message, /set aside while reversing/);
  await ops.abortOp(a, 'revert');
});

test('finish a branch after its pull request: merged, and squashed', async () => {
  const srv = sb.server('finish');
  const a = sb.repo('finish');
  sb.write(a, 'a.txt', 'a\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.addRemote(a, srv);
  await ops.push(a);
  sb.sh(a, 'remote', 'set-head', 'origin', 'main');
  // The "server side" of a pull request, done from a second clone.
  const reviewer = sb.clone(srv, 'finish-reviewer');
  const complete = (branch, squash) => {
    sb.sh(reviewer, 'fetch', '-q');
    sb.sh(reviewer, 'switch', '-q', 'main');
    sb.sh(reviewer, 'pull', '-q');
    if (squash) { sb.sh(reviewer, 'merge', '-q', '--squash', `origin/${branch}`); sb.sh(reviewer, 'commit', '-qm', `Squashed ${branch}`); }
    else sb.sh(reviewer, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
    sb.sh(reviewer, 'push', '-q', 'origin', 'main');
    sb.sh(reviewer, 'push', '-q', 'origin', '--delete', branch);
  };

  await ops.createBranch(a, 'feature/one', null);
  sb.write(a, 'one.txt', '1\n');
  await ops.commit(a, { message: 'one', paths: [], all: true });
  await ops.push(a);
  complete('feature/one', false);
  await ops.fetch(a);
  assert.ok((await ops.status(a)).upstreamGone, 'the branch is gone on the server');
  const r = await ops.finishBranch(a);
  assert.ok(r.ok && r.pulled);
  const st = await ops.status(a);
  assert.equal(st.branch, 'main');
  assert.ok(fs.existsSync(path.join(a, 'one.txt')), 'main has the merged work');
  assert.ok(!(await ops.branches(a)).local.some((b) => b.name === 'feature/one'), 'the branch is deleted');
  await ops.restoreBranch(a, 'feature/one', r.oid);
  assert.ok((await ops.branches(a)).local.some((b) => b.name === 'feature/one'), 'undo brings it back');

  await ops.createBranch(a, 'feature/two', null);
  sb.write(a, 'two.txt', '2\n');
  await ops.commit(a, { message: 'two', paths: [], all: true });
  await ops.push(a);
  complete('feature/two', true);
  const s = await ops.finishBranch(a);
  assert.ok(s.needsForce, 'a squashed branch is not deleted without asking');
  assert.equal((await ops.status(a)).branch, 'feature/two', 'nothing changed');
  assert.ok((await ops.finishBranch(a, { force: true })).ok);
  assert.equal((await ops.status(a)).branch, 'main');
  assert.ok(fs.existsSync(path.join(a, 'two.txt')));

  sb.write(a, 'dirty.txt', 'x\n');
  await ops.switchBranch(a, 'feature/one');
  await assert.rejects(ops.finishBranch(a), /uncommitted changes/);
});

test('discard one block of a file (and put it back), and shelve only some files', async () => {
  const { changedLines } = require('../renderer/lib');
  const a = sb.repo('discard-block');
  const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
  sb.write(a, 'f.txt', lines.join('\n') + '\n');
  sb.write(a, 'g.txt', 'g\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  const edited = [...lines];
  edited[1] = 'DEBUG';
  edited[17] = 'KEEP ME';
  sb.write(a, 'f.txt', edited.join('\n') + '\n');
  const text = () => fs.readFileSync(path.join(a, 'f.txt'), 'utf8').replace(/\r\n/g, '\n');
  const debug = changedLines((await ops.fileDiff(a, ['f.txt'])).text).filter((x) => /l2$|DEBUG/.test(x.text)).map((x) => x.key);
  const { patch } = await ops.discardLines(a, 'f.txt', debug);
  assert.match(text(), /^l2$/m, 'the debug block is gone');
  assert.match(text(), /^KEEP ME$/m, 'the other block is untouched');
  await ops.applyPatch(a, patch);
  assert.match(text(), /^DEBUG$/m, 'undo puts it back');

  sb.write(a, 'g.txt', 'g changed\n');
  sb.write(a, 'new.txt', 'new\n');
  await ops.stashSave(a, 'just g and new', ['g.txt', 'new.txt']);
  const st = await ops.status(a);
  assert.deepEqual([...st.unstaged.map((f) => f.path), ...st.untracked.map((f) => f.path)], ['f.txt'], 'f.txt stays; g.txt and new.txt are shelved');
  assert.equal((await ops.stashList(a))[0].message, 'just g and new');
});

test('tidy unsent commits: combine, reword, drop', async () => {
  const srv = sb.server('tidy-commits');
  const a = sb.repo('tidy-commits');
  sb.write(a, 'a.txt', 'a\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.addRemote(a, srv);
  await ops.push(a);
  await ops.createBranch(a, 'feature', null);
  for (const [file, msg] of [['1.txt', 'wip'], ['2.txt', 'wip 2'], ['3.txt', 'oops, debug file'], ['4.txt', 'Add four']]) {
    sb.write(a, file, `${file}\n`);
    await ops.commit(a, { message: msg, paths: [], all: true });
  }
  const u = await ops.unsentCommits(a);
  assert.deepEqual(u.commits.map((c) => c.message), ['wip', 'wip 2', 'oops, debug file', 'Add four'], 'oldest first, nothing from main');
  const [c1, c2, c3, c4] = u.commits.map((c) => c.hash);
  sb.write(a, 'wip.txt', 'uncommitted\n');
  const r = await ops.tidyCommits(a, [
    { hash: c1, action: 'pick', message: 'Add one and two\n\nCombined from two wip commits.' },
    { hash: c2, action: 'squash' },
    { hash: c3, action: 'drop' },
    { hash: c4, action: 'pick', message: 'Add four (reworded)' },
  ]);
  assert.ok(r.ok, r.output);
  const h = await ops.history(a);
  assert.deepEqual(h.commits.map((c) => c.subject), ['Add four (reworded)', 'Add one and two', 'base']);
  assert.ok(fs.existsSync(path.join(a, '2.txt')), 'the combined commit kept both files');
  assert.ok(!fs.existsSync(path.join(a, '3.txt')), 'the dropped commit is gone');
  assert.ok(fs.existsSync(path.join(a, 'wip.txt')), 'uncommitted work kept');
  assert.match(sb.sh(a, 'log', '-1', '--format=%B', 'HEAD~1'), /Combined from two wip commits/);
  await assert.rejects(ops.tidyCommits(a, [{ hash: c1, action: 'squash' }]), /combined into a kept commit/);
  // After sending, nothing is left to tidy.
  await ops.push(a);
  assert.equal((await ops.unsentCommits(a)).commits.length, 0);
});

test('blame: who changed each line', async () => {
  const a = sb.repo('blame');
  sb.write(a, 'f.txt', 'one\ntwo\nthree\n');
  await ops.commit(a, { message: 'first version', paths: [], all: true });
  sb.write(a, 'f.txt', 'one\nTWO\nthree\n');
  sb.sh(a, '-c', 'user.name=Someone Else', 'commit', '-qam', 'shout two');
  sb.write(a, 'f.txt', 'one\nTWO\nthree\nfour (not committed)\n');
  const b = await ops.blame(a, 'f.txt');
  assert.deepEqual(b.lines.map((l) => l.text), ['one', 'TWO', 'three', 'four (not committed)']);
  const who = (n) => b.commits[b.lines[n].hash];
  assert.equal(who(0).summary, 'first version');
  assert.equal(who(1).summary, 'shout two');
  assert.equal(who(1).author, 'Someone Else');
  assert.ok(/^0+$/.test(b.lines[3].hash), 'uncommitted lines have no commit');
  assert.deepEqual(b.lines.map((l) => l.n), [1, 2, 3, 4]);
});

test('compare two branches', async () => {
  const a = sb.repo('compare');
  sb.write(a, 'keep.txt', 'k\n');
  sb.write(a, 'old name.txt', 'some text that is long enough\nto be seen as a rename\nby git\n');
  await ops.commit(a, { message: 'base', paths: [], all: true });
  await ops.createBranch(a, 'feature', null);
  sb.write(a, 'keep.txt', 'k\nk2\n');
  fs.renameSync(path.join(a, 'old name.txt'), path.join(a, 'new name.txt'));
  sb.write(a, 'added.txt', 'new\n');
  await ops.commit(a, { message: 'feature work', paths: [], all: true });
  await ops.switchBranch(a, 'main');
  sb.write(a, 'main-only.txt', 'm\n');
  await ops.commit(a, { message: 'main work', paths: [], all: true });

  const split = await ops.compare(a, 'main', 'feature');
  assert.deepEqual([split.onlyBase, split.onlyHead], [1, 1]);
  assert.deepEqual(split.commits.map((c) => c.subject), ['feature work']);
  const byPath = Object.fromEntries(split.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['added.txt', 'keep.txt', 'new name.txt'], 'main-only.txt is not part of feature\'s changes');
  assert.equal(byPath['new name.txt'].code, 'R');
  assert.equal(byPath['new name.txt'].orig, 'old name.txt');
  assert.deepEqual([byPath['keep.txt'].add, byPath['keep.txt'].del], [1, 0]);
  const exact = await ops.compare(a, 'main', 'feature', { mode: 'exact' });
  assert.ok(exact.files.some((f) => f.path === 'main-only.txt' && f.code === 'D'), 'exact shows main-only.txt as missing on feature');
  const d = await ops.compareDiff(a, 'main', 'feature', ['keep.txt']);
  assert.match(d.text, /^\+k2$/m);
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
