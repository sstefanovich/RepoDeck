// Recover lost work: the reflog in plain English, commits on no branch, and deleted Shelf items.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { ops } = require('../src/git');
const { reflogText } = require('../renderer/lib');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

test('reflog lists where HEAD has been and flags commits no branch has', async () => {
  const a = sb.repo('reflog');
  sb.write(a, 'f.txt', '1\n');
  sb.sh(a, 'add', '-A');
  sb.sh(a, 'commit', '-qm', 'one');
  sb.write(a, 'f.txt', '2\n');
  sb.sh(a, 'commit', '-qam', 'two (will be lost)');
  const two = sb.sh(a, 'rev-parse', 'HEAD').trim();
  sb.sh(a, 'reset', '-q', '--hard', 'HEAD~1');
  sb.sh(a, 'switch', '-q', '-c', 'side');
  sb.write(a, 'f.txt', '3\n');
  sb.sh(a, 'stash', '-q'); // does a "reset: moving to HEAD", which is left out

  const log = await ops.reflog(a);
  assert.deepEqual(log.map((e) => reflogText(e.action)), [
    'Switched from main to side',
    'Moved the branch to HEAD~1 (reset / undo)',
    'Committed “two (will be lost)”',
    'First commit “one”',
  ]);
  assert.deepEqual(log.filter((e) => e.lost).map((e) => e.hash), [two], 'only the reset-away commit is lost');
  assert.ok(log.every((e) => e.time > 1e9), 'reflog times are read');

  // Making a branch there brings it back.
  await ops.restoreBranch(a, 'recovered', two);
  assert.equal((await ops.reflog(a)).filter((e) => e.lost).length, 0);
});

test('droppedShelf finds deleted Shelf items, not ones still on the Shelf', async () => {
  const a = sb.repo('dropped');
  sb.write(a, 'f.txt', '1\n');
  sb.sh(a, 'add', '-A');
  sb.sh(a, 'commit', '-qm', 'base');
  sb.write(a, 'f.txt', 'gone\n');
  sb.sh(a, 'stash', 'push', '-q', '-m', 'half-done search box');
  sb.sh(a, 'stash', 'drop', '-q');
  sb.write(a, 'f.txt', 'kept\n');
  sb.sh(a, 'stash', 'push', '-q', '-m', 'still on the shelf');

  const dropped = await ops.droppedShelf(a);
  assert.deepEqual(dropped.map((d) => d.message), ['On main: half-done search box']);
  await ops.stashStore(a, dropped[0].hash, dropped[0].message);
  assert.equal((await ops.stashList(a)).length, 2, 'put back on the Shelf');
  assert.deepEqual(await ops.droppedShelf(a), []);
});

test('reflog lines in plain English', () => {
  assert.equal(reflogText('commit (amend): Fix typo'), 'Changed the last commit “Fix typo”');
  assert.equal(reflogText('pull --ff-only --autostash: Fast-forward'), 'Got latest from the server');
  assert.equal(reflogText('merge origin/main: Merge made by the \'ort\' strategy.'), 'Merged origin/main');
  assert.equal(reflogText('rebase (finish): returning to refs/heads/feature/x'), 'Finished replaying feature/x (rebase)');
  assert.equal(reflogText('rebase -i (pick): Add login'), 'Replayed “Add login” (rebase)');
  assert.equal(reflogText('cherry-pick: Add login'), 'Copied “Add login” (cherry-pick)');
  assert.equal(reflogText('something new: in git'), 'something new: in git', 'unknown lines are shown as they are');
});
