// Setting up a new repo from a plain folder (git init, .gitignore, first commit, server, first send).
// A fixed identity, set before src/git.js reads the environment, so commits work on any machine.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
});
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ops } = require('../src/git');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

const folder = (name) => { const d = path.join(sb.root, name); fs.mkdirSync(d); return d; };

test('newRepoInfo suggests a .gitignore and refuses risky folders', async () => {
  const f = folder('info');
  sb.write(f, 'package.json', '{}');
  sb.write(f, 'index.js', '');
  const info = await ops.newRepoInfo(f);
  assert.equal(info.name, 'info');
  assert.equal(info.items, 2);
  assert.equal(info.suggested, 'node');
  assert.equal(info.hasGitignore, false);
  assert.equal(info.risky, false);
  assert.ok(info.templates.some((t) => t.id === 'dotnet'));

  sb.write(f, 'App.csproj', '');
  fs.rmSync(path.join(f, 'package.json'));
  assert.equal((await ops.newRepoInfo(f)).suggested, 'dotnet');
  assert.equal((await ops.newRepoInfo(os.homedir())).risky, true);
  assert.equal((await ops.newRepoInfo(path.parse(sb.root).root)).risky, true);
});

test('setupRepo: init, .gitignore, first commit, server, and send', async () => {
  const f = folder('fresh');
  sb.write(f, 'package.json', '{}');
  sb.write(f, 'node_modules/x/index.js', 'ignored');
  const srv = sb.server('fresh');
  await ops.setupRepo(f, { branch: 'main', gitignore: 'node', message: 'Start', remote: srv });

  const st = await ops.status(f);
  assert.equal(st.branch, 'main');
  assert.equal(st.initial, false);
  assert.equal(st.hasRemote, true);
  assert.equal(st.untracked.length + st.unstaged.length + st.staged.length, 0, 'everything committed or ignored');
  assert.match(fs.readFileSync(path.join(f, '.gitignore'), 'utf8'), /^node_modules\/$/m);
  const files = sb.sh(f, 'ls-files').trim().split('\n');
  assert.deepEqual(files.sort(), ['.gitignore', 'package.json']);
  assert.equal(sb.sh(f, 'log', '-1', '--format=%s').trim(), 'Start');

  const p = await ops.push(f);
  assert.ok(p.published);
  assert.equal((await ops.status(f)).upstream, 'origin/main');
});

test('setupRepo keeps an existing .gitignore, works on an empty folder, and checks the branch name', async () => {
  const keep = folder('keep');
  sb.write(keep, '.gitignore', 'secret.txt\n');
  sb.write(keep, 'secret.txt', 'x');
  await ops.setupRepo(keep, { branch: 'trunk', gitignore: 'node' });
  assert.equal(fs.readFileSync(path.join(keep, '.gitignore'), 'utf8'), 'secret.txt\n');
  assert.equal((await ops.status(keep)).branch, 'trunk');
  assert.equal((await ops.status(keep)).hasRemote, false);

  const empty = folder('empty');
  await ops.setupRepo(empty, {});
  const st = await ops.status(empty);
  assert.equal(st.initial, false, 'an empty folder still gets a first commit');
  assert.equal(sb.sh(empty, 'log', '-1', '--format=%s').trim(), 'Initial commit');

  const bad = folder('bad');
  await assert.rejects(ops.setupRepo(bad, { branch: 'no spaces' }), (e) => e.code === 'BAD_NAME');
  assert.equal(fs.existsSync(path.join(bad, '.git')), false, 'nothing is done for a bad branch name');
});

test('joinServerHistory combines a server repo created with a README', async () => {
  const srv = sb.server('readme');
  const other = sb.clone(srv, 'readme-web');
  sb.write(other, 'README.md', '# hi\n');
  sb.sh(other, 'add', '-A');
  sb.sh(other, 'commit', '-q', '-m', 'Initial commit');
  sb.sh(other, 'push', '-q', 'origin', 'HEAD:main');

  const f = folder('readme-local');
  sb.write(f, 'app.txt', 'mine\n');
  await ops.setupRepo(f, { remote: srv });
  assert.equal((await ops.push(f)).rejected, true);
  const m = await ops.joinServerHistory(f);
  assert.equal(m.ok, true);
  assert.ok(fs.existsSync(path.join(f, 'README.md')));
  assert.ok((await ops.push(f)).ok);
});
