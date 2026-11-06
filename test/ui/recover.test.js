// Screen test: Recover lost work brings back a commit lost to a reset, and a deleted Shelf item.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let repo;

before(async () => {
  repo = sb.repo('recover');
  sb.write(repo, 'f.txt', '1\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  sb.write(repo, 'f.txt', '2\n');
  sb.sh(repo, 'commit', '-qam', 'Important work');
  sb.sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
  sb.write(repo, 'f.txt', 'shelved\n');
  sb.sh(repo, 'stash', 'push', '-q', '-m', 'Unfinished idea');
  sb.sh(repo, 'stash', 'drop', '-q');
  app = await launchApp([repo]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

test('lost commits and deleted Shelf items can be brought back', async () => {
  app.run(`recoverLostWork(${JSON.stringify(repo)});`);
  await app.waitFor("return /Recover lost work/.test(document.querySelector('.modal h2')?.textContent)", 'the recover dialog');
  await app.waitFor("return document.querySelector('#rec-shelf [data-rec=shelf]')", 'the deleted Shelf item');
  const shown = await app.run("return [...document.querySelectorAll('#rec-list .rec-row')].filter((r) => !r.hidden).map((r) => r.querySelector('.rec-what').textContent)");
  assert.deepEqual(shown, ['Committed “Important work”'], 'only lost work is shown at first');
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }

  await app.run("document.querySelector('#rec-list .rec-row.lost [data-rec=show]').click();");
  await app.waitFor("return document.querySelector('.rec-detail .diff, .rec-detail .sbs')", 'the commit diff');

  app.run("document.querySelector('#rec-list .rec-row.lost [data-rec=branch]').click();");
  await app.waitFor("return /Make a branch here/.test([...document.querySelectorAll('.modal h2')].pop()?.textContent)", 'the branch name dialog');
  await app.run("[...document.querySelectorAll('.modal')].pop().querySelector('[data-close=ok]').click();");
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Made the branch recovered\\//.test(t.textContent))", 'the branch');
  assert.match(sb.sh(repo, 'branch', '--list', 'recovered/*'), /recovered\//);

  await app.run("document.querySelector('#rec-shelf [data-rec=shelf]').click();");
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /Put back on the Shelf/.test(t.textContent))", 'the Shelf item');
  assert.match(sb.sh(repo, 'stash', 'list'), /Unfinished idea/);
  await app.click('.modal [data-close=ok]');
});
