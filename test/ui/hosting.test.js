// Screen test: putting a repo on a server, and the pull request dialog (without touching a real server).
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let local;
let feature;

before(async () => {
  local = sb.repo('local-only');
  sb.write(local, 'a.txt', 'a\n');
  sb.sh(local, 'add', '-A');
  sb.sh(local, 'commit', '-qm', 'Base');

  // A repo on a server, on a feature branch that has been sent.
  const srv = sb.server('shop');
  feature = sb.repo('shop');
  sb.write(feature, 'a.txt', 'a\n');
  sb.sh(feature, 'add', '-A');
  sb.sh(feature, 'commit', '-qm', 'Base');
  sb.sh(feature, 'remote', 'add', 'origin', srv);
  sb.sh(feature, 'push', '-q', '-u', 'origin', 'main');
  sb.sh(feature, 'switch', '-q', '-c', 'feature/42-login-page');
  sb.write(feature, 'login.js', 'login()\n');
  sb.sh(feature, 'add', '-A');
  sb.sh(feature, 'commit', '-qm', 'Add the login form');
  sb.write(feature, 'login.test.js', 'test()\n');
  sb.sh(feature, 'add', '-A');
  sb.sh(feature, 'commit', '-qm', 'Test the login form');
  sb.sh(feature, 'push', '-q', '-u', 'origin', 'feature/42-login-page');

  app = await launchApp([local, feature]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const modalTitle = () => app.run("return document.querySelector('.modal h2')?.textContent || ''");

test('Add server: paste a URL, or see how to create the repo from here', async () => {
  app.run(`addRemoteFlow(${JSON.stringify(local)});`);
  await app.waitFor("return /Put this repo on a server/.test(document.querySelector('.modal h2')?.textContent)", 'the add-server dialog');
  const visiblePanel = () => app.run("return [...document.querySelectorAll('.srv-panel')].filter((p) => !p.hidden).map((p) => p.dataset.mode)");
  assert.deepEqual(await visiblePanel(), ['url']);
  await app.run("const r = document.querySelector('[name=srvMode][value=github]'); r.checked = true; r.dispatchEvent(new Event('change'));");
  assert.deepEqual(await visiblePanel(), ['github']);
  assert.match(await app.run("return document.querySelector('.srv-panel[data-mode=github]').textContent"), /add a GitHub token in Settings/, 'without a token it says how to get one');
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }

  const srv = sb.server('local-only');
  await app.run("const r = document.querySelector('[name=srvMode][value=url]'); r.checked = true; r.dispatchEvent(new Event('change'));");
  await app.run(`document.querySelector('.modal [name=remote]').value = ${JSON.stringify(srv)};`);
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /on the server/.test(t.textContent))", 'the repo to be sent', 20000);
  assert.equal(sb.sh(srv, 'log', '-1', '--format=%s', 'main').trim(), 'Base');
});

test('the pull request dialog drafts a title and description from the commits', async () => {
  await app.run(`openRepo(${JSON.stringify(feature)}, 'ui');`);
  await app.run(`await refreshRepo(${JSON.stringify(feature)});`);
  app.run(`createPrDialog(${JSON.stringify(feature)}, { kind: 'ado', hasToken: true, defaultBranch: 'main' });`);
  await app.waitFor("return /Create a pull request/.test(document.querySelector('.modal h2')?.textContent)", 'the pull request dialog');
  assert.match(await modalTitle(), /Azure DevOps/);
  const v = await app.run(`const m = document.querySelector('.modal'); return {
    target: m.querySelector('[name=target]').value, title: m.querySelector('[name=title]').value,
    description: m.querySelector('[name=description]').value, workItem: m.querySelector('[name=workItem]').value,
    summary: m.querySelector('#pr-summary').textContent };`);
  assert.deepEqual(v, {
    target: 'main', title: 'Login page', description: '- Add the login form\n- Test the login form', workItem: '42', summary: '2 commits, 2 files changed',
  });
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }
  await app.click('.modal [data-close=cancel]');
});
