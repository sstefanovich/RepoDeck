// Screen tests for finishing branches, discarding a block, work items, tidying commits,
// blame, tags, pull request status and workspace search. Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
const BRANCH = 'feature/1234-a-fairly-long-login-page-branch';
let repo; // on BRANCH, with unsent commits and uncommitted edits in two places
let done; // on feature/done, whose pull request was completed (merged and deleted on the server)
let app;

const toastSays = (re) => app.waitFor(`return [...document.querySelectorAll('.toast')].some((t) => ${re}.test(t.textContent))`, `a message matching ${re}`);
const text = (file) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');
const openTab = async (tab) => {
  await app.click(`[data-action=tab][data-tab=${tab}]`);
  await app.waitFor("return !document.querySelector('#tab-body .spinner')", `the ${tab} tab to load`);
};
async function assertLayout(name) {
  const problems = await app.run(LAYOUT_PROBLEMS);
  if (problems.length) {
    const shot = await app.screenshot(name);
    assert.fail(`${name}:\n  ${problems.join('\n  ')}${shot ? `\n  screenshot: ${shot}` : ''}`);
  }
}
// SHOTS=1 npm run test:ui saves pictures of the new screens to test/ui/output for a look.
const shot = (name) => process.env.SHOTS && app.screenshot(`feature ${name}`);
const undoNewest = async (label) => {
  await app.click('[data-action=undo-list]');
  await app.waitFor("return document.querySelector('.undo-item')", 'the Undo list');
  assert.match(await app.run("return document.querySelector('.undo-item').innerText"), label);
  await app.run("document.querySelectorAll('.toast').forEach((t) => t.remove());"); // so an older "Undone" doesn't count
  await app.click('.undo-item [data-action=undo-run]');
  await toastSays('/Undone/');
};

before(async () => {
  const srv = sb.server('feat');
  repo = sb.repo('feat-web');
  sb.write(repo, 'app.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  sb.sh(repo, 'remote', 'add', 'origin', srv);
  sb.sh(repo, 'push', '-qu', 'origin', 'main');
  sb.sh(repo, 'remote', 'set-head', 'origin', 'main');
  sb.sh(repo, 'switch', '-qc', BRANCH);
  for (const [file, msg] of [['a.txt', 'wip login form'], ['b.txt', 'wip login styles']]) {
    sb.write(repo, file, `${file}\n`);
    sb.sh(repo, 'add', '-A');
    sb.sh(repo, 'commit', '-qm', msg);
  }
  const lines = text('app.txt').split('\n');
  lines[1] = 'line 2 EDITED';
  lines[24] = 'console.log("debug")';
  sb.write(repo, 'app.txt', lines.join('\n'));

  // A second repo whose feature branch was merged and deleted on the server.
  const srv2 = sb.server('feat-done');
  done = sb.repo('feat-api');
  sb.write(done, 'x.txt', 'x\n');
  sb.sh(done, 'add', '-A');
  sb.sh(done, 'commit', '-qm', 'Base');
  sb.sh(done, 'remote', 'add', 'origin', srv2);
  sb.sh(done, 'push', '-qu', 'origin', 'main');
  sb.sh(done, 'remote', 'set-head', 'origin', 'main');
  sb.sh(done, 'switch', '-qc', 'feature/done');
  sb.write(done, 'done.txt', 'done\n');
  sb.sh(done, 'add', '-A');
  sb.sh(done, 'commit', '-qm', 'Finished work');
  sb.sh(done, 'push', '-qu', 'origin', 'feature/done');
  const reviewer = sb.clone(srv2, 'feat-reviewer');
  sb.sh(reviewer, 'merge', '-q', '--no-ff', '-m', 'Merge PR', 'origin/feature/done');
  sb.sh(reviewer, 'push', '-q', 'origin', 'main');
  sb.sh(reviewer, 'push', '-q', 'origin', '--delete', 'feature/done');
  sb.sh(done, 'fetch', '-q', '--prune');

  app = await launchApp([repo, done]);
  await app.size(960);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

test('discard one block, then undo it', async () => {
  await openTab('changes');
  await app.waitFor("return document.querySelectorAll('[data-action=discard-hunk]').length === 2", 'a Discard button per block');
  await assertLayout('changes with block buttons at 960px');
  await shot('changes');
  await app.click('[data-action=discard-hunk][data-h="2"]');
  await app.click('.modal [data-close=ok]');
  await toastSays('/Block discarded/');
  assert.doesNotMatch(text('app.txt'), /debug/);
  assert.match(text('app.txt'), /line 2 EDITED/, 'the other block stays');
  await undoNewest(/Discard of a block in app\.txt/);
  assert.match(text('app.txt'), /console\.log\("debug"\)/, 'undo puts it back');
});

test('the work item number comes from the branch and lands in the commit', async () => {
  await openTab('changes');
  assert.equal(await app.run("return document.querySelector('#work-item').value"), '1234');
  await app.waitFor("return document.querySelectorAll('[data-action=pick-hunk]').length === 2", 'the line tick boxes');
  await app.click('[data-action=pick-hunk][data-h="2"]'); // leave the debug line out
  await app.run(`const s = document.querySelector('#commit-summary'); s.value = 'Edit line 2'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await app.click('#commit-btn');
  await toastSays('/Committed/');
  assert.equal(sb.sh(repo, 'log', '-1', '--format=%B').trim(), 'Edit line 2\n\nAB#1234');
});

test('tidy unsent commits: combine the two wip commits and reword them', async () => {
  await openTab('history');
  await app.click('[data-action=tidy-commits]');
  await app.waitFor("return document.querySelectorAll('.tidy-commit').length === 3", 'the unsent commits');
  await assertLayout('tidy dialog at 960px');
  await app.run(`
    const m = document.querySelector('.modal');
    m.querySelector('[name=msg0]').value = 'Add the login page';
    const act = m.querySelector('[name=act1]');
    act.value = 'squash';
    act.dispatchEvent(new Event('change', { bubbles: true }));`);
  assert.ok(await app.run("return document.querySelector('[name=msg1]').hidden"), 'a combined commit has no message of its own');
  await shot('tidy');
  await app.click('.modal [data-close=ok]');
  await toastSays('/Commits tidied/');
  assert.equal(sb.sh(repo, 'log', '--format=%s', 'main..HEAD'), 'Edit line 2\nAdd the login page\n');
  assert.ok(fs.existsSync(path.join(repo, 'b.txt')), 'the combined commit kept both changes');
});

test('blame shows who changed each line', async () => {
  await openTab('changes');
  await app.waitFor("return document.querySelector('[data-action=file-blame]')", 'the Blame button');
  await app.click('[data-action=file-blame]');
  await app.waitFor("return document.querySelectorAll('.bl').length >= 30", 'the blame view');
  const firstLines = await app.run("return [...document.querySelectorAll('.bl-head .bl-sum, .bl-head > .muted')].map((x) => x.textContent)");
  assert.ok(firstLines.includes('Base') && firstLines.includes('Edit line 2'), firstLines.join(', '));
  assert.ok(firstLines.includes('Not committed yet'), 'the uncommitted debug line');
  await assertLayout('blame at 960px');
  await shot('blame');
  await app.click('[data-action=blame-mode][data-on=""]');
  await app.waitFor("return document.querySelector('.commit-detail')", 'back to commit details');
});

test('tags: add one to a commit, see it in Branches, delete and undo', async () => {
  await app.click('[data-action=clear-file-history]');
  await app.waitFor("return document.querySelector('[data-action=add-tag]')", 'the commit details');
  await app.click('[data-action=add-tag]');
  await app.run(`const m = document.querySelector('.modal'); m.querySelector('[name=name]').value = 'v1.0.0'; m.querySelector('[name=message]').value = 'First release'; m.querySelector('[name=send]').checked = false;`);
  await app.click('.modal [data-close=ok]');
  await toastSays('/Tagged/');
  assert.match(sb.sh(repo, 'tag', '-n'), /v1\.0\.0\s+First release/);
  await openTab('branches');
  await app.waitFor("return document.querySelector('.row[data-name=\"v1.0.0\"]')", 'the tag in Branches');
  await assertLayout('branches with tags at 960px');
  await shot('tags');
  await app.click('.row[data-name="v1.0.0"] [data-action=delete-tag]');
  await app.click('.modal [data-close=ok]');
  await toastSays('/Deleted the tag/');
  assert.equal(sb.sh(repo, 'tag'), '');
  await undoNewest(/Delete of the tag v1\.0\.0/);
  assert.match(sb.sh(repo, 'tag', '-n'), /v1\.0\.0\s+First release/, 'undo keeps the message');
});

test('pull request status chip (with sample data, no real Azure DevOps)', async () => {
  const chip = await app.run(`
    state.prStatus[norm(${JSON.stringify(repo)})] = { branch: ${JSON.stringify(BRANCH)}, id: 42, title: 'Add login', status: 'active', target: 'main', url: 'https://dev.azure.com/acme/Shop/_git/web/pullrequest/42',
      reviewers: [{ name: 'Ana', vote: 10 }, { name: 'Bo', vote: 0 }], approved: 1, waiting: 0, rejected: 0, checks: { builds: { total: 1, passed: 0, failed: 0, running: 1 }, blocking: 1 } };
    updateRepoChrome();
    return document.querySelector('.pr-chip')?.textContent;`);
  assert.equal(chip, 'PR #42 · ✓ 1 approved · ⏳ build running');
  await assertLayout('header with PR chip at 960px');
  await shot('pr-chip');
  const completed = await app.run(`
    Object.assign(state.prStatus[norm(${JSON.stringify(repo)})], { status: 'completed' });
    updateRepoChrome();
    return document.querySelector('#op-banner').innerText;`);
  assert.match(completed, /Pull request #42 .* is completed/);
  assert.ok(await app.run("return !!document.querySelector('#op-banner [data-action=finish-branch]') && !!document.querySelector('#op-banner [data-action=move-to-branch]')"),
    'with changes on it, the completed branch offers both Finish and Move');
  await assertLayout('finished-branch warning at 960px');
  await shot('finished-branch-warning');
  await app.run(`delete state.prStatus[norm(${JSON.stringify(repo)})]; updateRepoChrome();`);
});

test('workspace: a merged branch shows up, search finds commits in every repo', async () => {
  await app.click('[data-action=open-ws][data-ws=ui]');
  await app.waitFor("return document.querySelector('[data-action=ws-finish]')", 'the "deleted on the server" banner');
  await app.run(`const s = document.querySelector('#ws-search'); s.value = 'finished'; s.dispatchEvent(new Event('input', { bubbles: true }));`);
  await app.waitFor("return document.querySelector('.ws-hit')", 'search results');
  await assertLayout('workspace search at 960px');
  await shot('workspace-search');
  const hits = await app.run("return [...document.querySelectorAll('.ws-hit')].map((h) => h.innerText.replace(/\\s+/g, ' '))");
  assert.equal(hits.length, 1);
  assert.match(hits[0], /Finished work .* on feature\/done/);
  await app.click('.ws-hit');
  await app.waitFor("return document.querySelector('.commit-detail .cd-subject')?.textContent === 'Finished work'", 'the commit to open in History');
});

test('finish the merged branch', async () => {
  await app.waitFor("return document.querySelector('#op-banner [data-action=finish-branch]')", 'the Finish banner in feat-api');
  const header = await app.run(`return {
    sync: document.querySelector('.sync-text').textContent,
    prButton: !!document.querySelector('#repo-header [data-action=open-pr]'),
    undoCommit: !!document.querySelector('[data-action=undo-commit]'),
  };`);
  assert.equal(header.sync, 'Deleted on the server');
  assert.ok(!header.prButton, 'no "Pull request" button for a branch the server deleted');
  assert.ok(!header.undoCommit, 'its commits were sent, so no "Undo this commit"');
  await assertLayout('finish banner at 960px');
  await shot('finish-banner');
  await app.click('#op-banner [data-action=finish-branch]');
  await app.waitFor("return document.querySelector('.modal .steps')", 'the Finish dialog');
  await app.click('.modal [data-close=ok]');
  await toastSays('/Finished feature\\/done/');
  assert.equal(sb.sh(done, 'branch', '--show-current').trim(), 'main');
  assert.ok(fs.existsSync(path.join(done, 'done.txt')), 'main has the merged work');
  assert.doesNotMatch(sb.sh(done, 'branch'), /feature\/done/);
  await undoNewest(/Finish of feature\/done/);
  assert.equal(sb.sh(done, 'branch', '--show-current').trim(), 'feature/done', 'undo brings the branch back and switches to it');
});
