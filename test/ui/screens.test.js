// Screen tests: the real app, driven like a user, against a throwaway repo.
// Run with `npm run test:ui` (opens a window for about a minute).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
const LONG = 'feature/a-really-long-branch-name-for-checking-layout';
let repo;
let app;

before(async () => {
  // main, dev (2 commits ahead), and a long-named feature branch that is on the server.
  const srv = sb.server('ui');
  repo = sb.repo('ui-demo');
  sb.write(repo, 'app.txt', Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  sb.write(repo, 'README.md', 'readme\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  sb.sh(repo, 'remote', 'add', 'origin', srv);
  sb.sh(repo, 'push', '-qu', 'origin', 'main');
  sb.sh(repo, 'switch', '-qc', 'dev');
  sb.write(repo, 'dev.txt', 'dev\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Add a dev feature with a fairly long commit message to wrap');
  sb.sh(repo, 'commit', '-q', '--allow-empty', '-m', 'Second dev commit');
  sb.sh(repo, 'switch', '-q', 'main');
  sb.sh(repo, 'switch', '-qc', LONG);
  sb.write(repo, 'login.txt', 'login\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Add login page');
  sb.sh(repo, 'push', '-qu', 'origin', LONG);
  // Uncommitted edits in two separate places of app.txt.
  const lines = fs.readFileSync(path.join(repo, 'app.txt'), 'utf8').split('\n');
  lines[1] = 'line 2 EDITED';
  lines[24] = 'line 25 EDITED';
  sb.write(repo, 'app.txt', lines.join('\n'));
  app = await launchApp([repo]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

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

test('every tab lays out cleanly at the narrowest and a wide window', async () => {
  for (const width of [960, 1400]) {
    await app.size(width);
    for (const tab of ['changes', 'branches', 'history', 'compare', 'shelf']) {
      await openTab(tab);
      await assertLayout(`${tab} at ${width}px`);
    }
  }
});

test('commit only some lines', async () => {
  await app.size(1300);
  await openTab('changes');
  await app.waitFor("return document.querySelectorAll('[data-action=pick-hunk]').length === 2", 'a tick box per block');
  await app.click('[data-action=pick-hunk][data-h="2"]');
  const state = await app.run(`
    const s = document.querySelector('#commit-summary');
    s.value = 'Edit line 2';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return { button: document.querySelector('#commit-btn').textContent, part: document.querySelector('[data-action=check-file]').indeterminate };`);
  assert.match(state.button, /1 in part/);
  assert.ok(state.part, 'the file shows a half-ticked box');
  await app.click('#commit-btn');
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Committed/.test(t.textContent))", 'the commit');
  assert.match(sb.sh(repo, 'show', 'HEAD:app.txt'), /line 2 EDITED\n[\s\S]*\nline 25\n/);
  assert.match(sb.sh(repo, 'diff'), /^\+line 25 EDITED$/m, 'the unticked block is still uncommitted');
});

test('a branch made outside the app shows up by itself', async () => {
  await openTab('branches');
  sb.sh(repo, 'branch', 'made-in-a-terminal');
  await app.waitFor("return document.querySelector('.row[data-name=\"made-in-a-terminal\"]')", 'the new branch in the list');
});

test('update from another branch: shows what is coming, and blocks a rebase of sent commits', async () => {
  await app.size(960);
  await openTab('branches');
  await app.click('#tab-body [data-action=update-from]');
  await app.waitFor("return document.querySelector('.modal [name=ref]')", 'the dialog');
  const info = await app.run(`
    const sel = document.querySelector('.modal [name=ref]');
    sel.value = 'dev';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1500));
    return { text: document.querySelector('#uf-info').textContent, rebase: document.querySelector('.modal [value=rebase]').disabled };`);
  assert.match(info.text, /dev has 2 commits/);
  assert.ok(info.rebase, 'Add login page is on the server, so rebase is off');
  await assertLayout('update dialog at 960px');
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Updated/.test(t.textContent))", 'the merge');
  assert.ok(fs.existsSync(path.join(repo, 'dev.txt')));
  assert.match(sb.sh(repo, 'diff'), /line 25 EDITED/, 'uncommitted work survived');
});

test('reverse an older commit, then undo it', async () => {
  await openTab('history');
  await app.run("[...document.querySelectorAll('.commit-row')].find((r) => r.textContent.includes('Add login page')).click();");
  await app.waitFor("return document.querySelector('[data-action=revert-commit]')", 'the Reverse button');
  sb.sh(repo, 'stash', '-q'); // the uncommitted edit is in a file the revert doesn't touch, but keep it simple
  await app.click('[data-action=revert-commit]');
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Reversed/.test(t.textContent))", 'the reverse');
  assert.ok(!fs.existsSync(path.join(repo, 'login.txt')));
  await app.run("[...document.querySelectorAll('.toast')].find((t) => /Reversed/.test(t.textContent)).querySelector('button').click();");
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Undone/.test(t.textContent))", 'the undo');
  assert.ok(fs.existsSync(path.join(repo, 'login.txt')), 'undo brings the file back');
  sb.sh(repo, 'stash', 'pop', '-q');
});

test('compare two branches', async () => {
  await app.size(1300);
  await openTab('compare');
  const r = await app.run(`
    const base = document.querySelector('#cmp-base');
    base.value = 'main';
    base.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1500));
    return { files: [...document.querySelectorAll('#tab-body .file')].map((f) => f.dataset.path), head: document.querySelector('#cmp-head').value };`);
  assert.equal(r.head, LONG);
  assert.ok(r.files.includes('login.txt') && r.files.includes('dev.txt'), `files: ${r.files}`);
  await app.click('[data-action=cmp-range][data-mode=exact]');
  await app.waitFor("return document.querySelector('.seg-btn.active[data-mode=exact]') && document.querySelector('#cmp-diff .diff-head')", 'the exact comparison');
  await assertLayout('compare at 1300px');
});
