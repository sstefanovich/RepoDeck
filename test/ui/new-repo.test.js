// Screen test: opening a folder that isn't a repo sets it up, commits it and sends it to a server.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let existing;

before(async () => {
  existing = sb.repo('existing');
  sb.write(existing, 'a.txt', 'a\n');
  sb.sh(existing, 'add', '-A');
  sb.sh(existing, 'commit', '-qm', 'Base');
  app = await launchApp([existing]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

test('a plain folder is set up with a .gitignore, a first commit and a server, then sent', async () => {
  const folder = path.join(sb.root, 'brand-new');
  sb.write(folder, 'package.json', '{}');
  sb.write(folder, 'node_modules/dep/index.js', 'not wanted');
  const srv = sb.server('brand-new');

  // The same path as opening or dropping a folder.
  app.run(`addRepos('ui', [${JSON.stringify(folder)}]);`);
  await app.waitFor("return /Set up a new repo/.test(document.querySelector('.modal h2')?.textContent)", 'the set-up dialog');
  assert.equal(await app.run("return document.querySelector('.modal [name=gitignore]').value"), 'node', 'suggests a Node .gitignore');
  assert.equal(await app.run("return document.querySelector('.modal [name=branch]').value"), 'main');
  for (const w of [700, 1200]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }

  await app.run(`const i = document.querySelector('.modal [name=remote]'); i.value = ${JSON.stringify(srv)};`);
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return [...document.querySelectorAll('.toast')].some((t) => /on the server/.test(t.textContent))", 'the repo to be sent', 20000);

  assert.ok(await app.run(`return state.config.workspaces.find((w) => w.id === 'ui').repos.some((p) => samePath(p, ${JSON.stringify(folder)}))`), 'added to the workspace');
  assert.ok(await app.run(`return samePath(state.view.path, ${JSON.stringify(folder)})`), 'opened in a tab');
  assert.equal(sb.sh(srv, 'log', '-1', '--format=%s', 'main').trim(), 'Initial commit');
  assert.deepEqual(sb.sh(srv, 'ls-tree', '--name-only', 'main').trim().split('\n').sort(), ['.gitignore', 'package.json']);
  assert.ok(fs.existsSync(path.join(folder, '.git')));
});
