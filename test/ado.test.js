// Tests of src/ado.js against a fake Azure DevOps (no network, no real token).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRemote, prStatus } = require('../src/ado');

test('Azure DevOps remotes are recognised in every URL form', () => {
  const want = { base: 'https://dev.azure.com/acme', project: 'Shop', repo: 'api' };
  assert.deepEqual(parseRemote('https://dev.azure.com/acme/Shop/_git/api'), want);
  assert.deepEqual(parseRemote('https://acme@dev.azure.com/acme/Shop/_git/api'), want);
  assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/acme/Shop/api'), want);
  assert.deepEqual(parseRemote('https://acme.visualstudio.com/Shop/_git/api'), { base: 'https://acme.visualstudio.com', project: 'Shop', repo: 'api' });
  assert.deepEqual(parseRemote('https://acme.visualstudio.com/DefaultCollection/Shop/_git/api'), { base: 'https://acme.visualstudio.com', project: 'Shop', repo: 'api' });
  assert.deepEqual(parseRemote('acme@vs-ssh.visualstudio.com:v3/acme/Shop/api'), { base: 'https://acme.visualstudio.com', project: 'Shop', repo: 'api' });
  assert.equal(parseRemote('https://dev.azure.com/acme/My%20Project/_git/web').project, 'My%20Project', 'names stay URL-encoded');
  assert.equal(parseRemote('https://github.com/acme/api.git'), null);
});

// A fake fetch that answers from a table of URL patterns, and records what was asked.
function fakeAdo(routes) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => 'application/json' }, json: async () => ({}) };
    const [, body, status = 200, type = 'application/json'] = hit;
    return { ok: status < 300, status, statusText: 'x', headers: { get: () => type }, json: async () => body };
  };
  return { fetch, calls };
}

const remoteUrl = 'https://dev.azure.com/acme/Shop/_git/api';

test('pull request status: reviews and builds', async () => {
  const { fetch, calls } = fakeAdo([
    [/pullrequests\?/, { value: [
      { pullRequestId: 41, status: 'completed', title: 'Old one' },
      { pullRequestId: 42, status: 'active', title: 'Add login', targetRefName: 'refs/heads/main', isDraft: false,
        repository: { project: { id: 'p-1' } },
        reviewers: [{ displayName: 'Ana', vote: 10 }, { displayName: 'Bo', vote: 5 }, { displayName: 'Cy', vote: -5, isRequired: true }, { displayName: 'Team', vote: 0, isContainer: true }] },
    ] }],
    [/policy\/evaluations/, { value: [
      { status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' } } },
      { status: 'running', configuration: { isBlocking: true, type: { displayName: 'Build' } } },
      { status: 'rejected', configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } },
      { status: 'notApplicable', configuration: { isBlocking: true, type: { displayName: 'Build' } } },
    ] }],
  ]);
  const s = await prStatus({ remoteUrl, branch: 'feature/1234-login', token: 'secret', fetch });
  assert.equal(s.id, 42, 'the active PR wins over an older completed one');
  assert.equal(s.status, 'active');
  assert.equal(s.target, 'main');
  assert.equal(s.url, 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/42');
  assert.deepEqual([s.approved, s.waiting, s.rejected], [2, 1, 0]);
  assert.deepEqual(s.checks.builds, { total: 2, passed: 1, failed: 0, running: 1 });
  assert.equal(s.checks.blocking, 2, 'the running build and the reviewer policy still block');
  assert.match(calls[0].url, /sourceRefName=refs%2Fheads%2Ffeature%2F1234-login/);
  assert.equal(calls[0].auth, `Basic ${Buffer.from(':secret').toString('base64')}`);
});

test('pull request status: none, completed, no token, bad token, other servers', async () => {
  const none = fakeAdo([[/pullrequests\?/, { value: [] }]]);
  assert.ok((await prStatus({ remoteUrl, branch: 'x', token: 't', fetch: none.fetch })).none);

  const done = fakeAdo([[/pullrequests\?/, { value: [{ pullRequestId: 7, status: 'completed', title: 'Done', repository: { project: { id: 'p' } } }] }]]);
  const d = await prStatus({ remoteUrl, branch: 'x', token: 't', fetch: done.fetch });
  assert.equal(d.status, 'completed');
  assert.equal(d.checks, null, 'no policy lookup for a finished PR');
  assert.equal(done.calls.length, 1);

  assert.ok((await prStatus({ remoteUrl, branch: 'x', token: '' })).noToken);
  // Azure DevOps answers a bad token with 203 and an HTML sign-in page.
  const bad = fakeAdo([[/pullrequests\?/, '<html>', 203, 'text/html']]);
  await assert.rejects(prStatus({ remoteUrl, branch: 'x', token: 'nope', fetch: bad.fetch }), (e) => e.code === 'AUTH');
  assert.equal((await prStatus({ remoteUrl: 'https://github.com/a/b.git', branch: 'x', token: 't' })).supported, false);
});
