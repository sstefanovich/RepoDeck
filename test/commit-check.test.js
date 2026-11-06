// The look at a commit before it's made: big files, likely secrets and build folders.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ops } = require('../src/git');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

const byPath = (issues) => Object.fromEntries(issues.map((i) => [i.path, i]));

test('flags secret files, tokens in new files, build folders and big files', async () => {
  const a = sb.repo('check');
  sb.write(a, 'src/app.js', 'console.log(1);\n');
  sb.write(a, '.env', 'DB=x\n');
  sb.write(a, '.env.example', 'DB=\n');
  sb.write(a, 'deploy/site.pfx', 'x');
  sb.write(a, 'config.js', `const token = "ghp_${'a'.repeat(36)}";\n`);
  sb.write(a, 'web/node_modules/left-pad/index.js', '');
  sb.write(a, 'web/node_modules/left-pad/package.json', '{}');
  sb.write(a, 'tool/__pycache__/x.cpython-312.pyc', '');
  fs.writeFileSync(path.join(a, 'video.mp4'), Buffer.alloc(51 * 1024 * 1024));

  const issues = byPath(await ops.commitCheck(a, { all: true }));
  assert.deepEqual(Object.keys(issues).sort(), ['.env', 'config.js', 'deploy/site.pfx', 'tool/__pycache__/', 'video.mp4', 'web/node_modules/'].sort());
  assert.equal(issues['.env'].kind, 'secret');
  assert.equal(issues['.env'].ignore, '/.env');
  assert.match(issues['config.js'].detail, /GitHub token/);
  assert.equal(issues['config.js'].ignore, null, 'a source file is left out, not ignored');
  assert.equal(issues['web/node_modules/'].kind, 'build');
  assert.equal(issues['web/node_modules/'].files.length, 2);
  assert.equal(issues['web/node_modules/'].ignore, 'node_modules/');
  assert.equal(issues['video.mp4'].kind, 'large');
  assert.equal(issues['video.mp4'].severe, false, 'under 100 MB is only a warning');

  // Only the ticked files are looked at.
  const some = await ops.commitCheck(a, { paths: ['src/app.js', '.env'], all: false });
  assert.deepEqual(some.map((i) => i.path), ['.env']);
});

test('in files already in the repo, only the added lines count', async () => {
  const a = sb.repo('check-diff');
  sb.write(a, 'settings.ini', `key = AKIA${'B'.repeat(16)}\n`);
  sb.sh(a, 'add', '-A');
  sb.sh(a, 'commit', '-qm', 'old secret');
  sb.write(a, 'settings.ini', `key = AKIA${'B'.repeat(16)}\nname = shop\n`);
  assert.deepEqual(await ops.commitCheck(a, { all: true }), [], 'the old line was already committed');

  sb.write(a, 'settings.ini', `key = AKIA${'B'.repeat(16)}\nname = shop\nconn = Server=db;Password=hunter22;\n`);
  const [issue] = await ops.commitCheck(a, { all: true });
  assert.equal(issue.path, 'settings.ini');
  assert.match(issue.detail, /password in a connection string/);

  sb.write(a, 'settings.ini', `key = AKIA${'B'.repeat(16)}\nconn = Server=db;Password=<your password>;\n`);
  assert.deepEqual(await ops.commitCheck(a, { all: true }), [], 'placeholders are fine');
});

test('ignorePatterns adds each line once, and commit can make an empty first commit', async () => {
  const a = sb.repo('check-ignore');
  sb.write(a, '.gitignore', 'dist/');
  assert.equal(await ops.ignorePatterns(a, ['node_modules/', '/.env', 'dist/', 'node_modules/']), true);
  assert.equal(fs.readFileSync(path.join(a, '.gitignore'), 'utf8'), 'dist/\nnode_modules/\n/.env\n');
  assert.equal(await ops.ignorePatterns(a, ['/.env']), false);

  const b = sb.repo('check-empty');
  await ops.commit(b, { message: 'Initial commit', paths: [], all: true, allowEmpty: true });
  assert.equal((await ops.status(b)).initial, false);
});
