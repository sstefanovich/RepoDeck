// Signing in again after a login failure, against a fake credential helper (no real sign-in window).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ops } = require('../src/git');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

// A credential helper that logs what git asks of it, and answers "get" with a fixed login.
function fakeHelper(repo) {
  const log = path.join(sb.root, `${path.basename(repo)}-helper.log`).replace(/\\/g, '/');
  sb.sh(repo, 'config', 'credential.helper', ''); // "" resets the list, so a real helper (GCM) isn't asked
  sb.sh(repo, 'config', '--add', 'credential.helper',
    `!f() { echo "$1" >> "${log}"; cat >> "${log}"; if [ "$1" = get ]; then echo username=me; echo password=s3cret; fi; }; f`);
  return () => fs.readFileSync(log, 'utf8');
}

test('signIn forgets the old login, gets a new one, and saves it', async () => {
  const a = sb.repo('signin');
  sb.sh(a, 'remote', 'add', 'origin', 'https://example.com/team/app.git');
  const log = fakeHelper(a);
  const r = await ops.signIn(a);
  assert.equal(r.host, 'example.com');
  const text = log();
  assert.ok(text.indexOf('erase') < text.indexOf('get') && text.indexOf('get') < text.indexOf('store'), 'erase, then get, then store');
  assert.match(text, /store[\s\S]*password=s3cret/, 'the new login is handed to the helper to keep');
});

test('signIn explains SSH remotes and a missing helper', async () => {
  const a = sb.repo('signin-ssh');
  sb.sh(a, 'remote', 'add', 'origin', 'git@github.com:team/app.git');
  await assert.rejects(ops.signIn(a), (e) => e.code === 'SSH');

  const b = sb.repo('signin-nohelper');
  sb.sh(b, 'remote', 'add', 'origin', 'https://example.com/team/app.git');
  sb.sh(b, 'config', 'credential.helper', '');
  await assert.rejects(ops.signIn(b), (e) => e.code === 'NO_HELPER');
});

test('useHttps switches an SSH remote to the same repo over HTTPS', async () => {
  const cases = [
    ['git@github.com:team/app.git', 'https://github.com/team/app.git'],
    ['ssh://git@gitlab.com/group/sub/app.git', 'https://gitlab.com/group/sub/app.git'],
    ['git@ssh.dev.azure.com:v3/acme/Shop/api', 'https://dev.azure.com/acme/Shop/_git/api'],
  ];
  for (const [i, [from, to]] of cases.entries()) {
    const a = sb.repo(`https-${i}`);
    sb.sh(a, 'remote', 'add', 'origin', from);
    assert.equal(await ops.useHttps(a), to);
    assert.equal((await ops.remoteUrl(a)), to);
  }
});
