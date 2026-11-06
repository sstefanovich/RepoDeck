// Screen test: one commit in several repos (with one Undo), and the pull-requests-for-all dialog.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let web;
let api;
let clean;

before(async () => {
  [web, api, clean] = ['wc-web', 'wc-api', 'wc-clean'].map((n) => {
    const r = sb.repo(n);
    sb.write(r, 'a.txt', 'a\n');
    sb.sh(r, 'add', '-A');
    sb.sh(r, 'commit', '-qm', 'Base');
    return r;
  });
  for (const r of [web, api]) {
    const srv = sb.server(require('path').basename(r));
    sb.sh(r, 'remote', 'add', 'origin', srv);
    sb.sh(r, 'push', '-q', '-u', 'origin', 'main');
    sb.sh(r, 'switch', '-q', '-c', 'feature/77-checkout');
    sb.write(r, 'checkout.txt', 'new\n');
  }
  app = await launchApp([web, api, clean]);
  await app.run("openWorkspace('ui');");
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const last = (repo) => sb.sh(repo, 'log', '-1', '--format=%B').trim();

test('commit in all: one message in every repo with changes, and one Undo for all', async () => {
  app.run('wsCommit();');
  await app.waitFor("return /Commit in several repos/.test(document.querySelector('.modal h2')?.textContent)", 'the commit dialog');
  const offered = await app.run("return [...document.querySelectorAll('.modal [name=repos]')].map((i) => i.value)");
  assert.deepEqual(offered, [web, api], 'only repos with changes');
  assert.equal(await app.run("return document.querySelector('.modal [name=workItem]').value"), '77', 'work item from the branch name');
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }
  await app.run("const s = document.querySelector('.modal [name=summary]'); s.value = 'Add checkout'; s.dispatchEvent(new Event('input', { bubbles: true }));");
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return /results/.test(document.querySelector('.modal h2')?.textContent)", 'the results');
  assert.equal(last(web), 'Add checkout\n\nAB#77');
  assert.equal(last(api), 'Add checkout\n\nAB#77');
  await app.click('.modal [data-close=ok]');

  assert.match(await app.run('return state.undos[0].label'), /commit “Add checkout” in 2 repos/);
  await app.run('await runUndo(state.undos[0].id);');
  assert.equal(await app.run("return document.querySelector('.modal h2')?.textContent || ''"), '', 'no "can\'t undo" message');
  assert.equal(last(web), 'Base', 'undone in web');
  assert.equal(last(api), 'Base', 'undone in api');
  assert.match(sb.sh(web, 'status', '--porcelain'), /checkout\.txt/, 'the changes are kept');
});

test('pull requests for all: one row per feature-branch repo, opening in the browser without tokens', async () => {
  for (const r of [web, api]) { sb.sh(r, 'add', '-A'); sb.sh(r, 'commit', '-qm', 'Add checkout'); }
  await app.run('await refreshAll(true);');
  app.run('wsPullRequests();');
  await app.waitFor("return /Pull requests for several repos/.test(document.querySelector('.modal h2')?.textContent)", 'the pull requests dialog');
  const rows = await app.run(`return [...document.querySelectorAll('.ws-pr-row')].map((r) => ({
    name: r.querySelector('b').textContent, target: r.querySelector('select').value, how: r.querySelector('.tag').textContent,
    note: r.querySelector('.muted').textContent }))`);
  assert.deepEqual(rows.map((r) => [r.name, r.target, r.how]), [['wc-web', 'main', 'opens in browser'], ['wc-api', 'main', 'opens in browser']]);
  assert.match(rows[0].note, /not on the server yet \(published first\)/, 'the branch was never sent');
  assert.equal(await app.run("return document.querySelector('.modal [name=title]').value"), 'Checkout');
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }
  await app.click('.modal [data-close=cancel]');
});
