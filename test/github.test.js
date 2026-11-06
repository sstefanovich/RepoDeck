// Tests of src/github.js and the newer src/ado.js calls against fake servers (no network, no real token).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const github = require('../src/github');
const ado = require('../src/ado');
const { prTitleFromBranch, prDraft } = require('../renderer/lib');

// A fake fetch that answers from a table of [method, URL pattern, body, status], and records what was asked.
function fakeServer(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, auth: opts.headers?.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes.find(([m, re]) => m === method && re.test(url));
    const [, , body = { message: 'Not Found' }, status = hit ? 200 : 404, extraHeaders = {}] = hit || [];
    const headers = { 'content-type': 'application/json; charset=utf-8', ...extraHeaders };
    return { ok: status < 300, status, statusText: 'x', headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body };
  };
  return { fetch, calls };
}

test('GitHub remotes are recognised; others are not', () => {
  assert.deepEqual(github.parseRemote('https://github.com/acme/shop.git'), { owner: 'acme', repo: 'shop' });
  assert.deepEqual(github.parseRemote('https://me@github.com/acme/shop'), { owner: 'acme', repo: 'shop' });
  assert.deepEqual(github.parseRemote('git@github.com:acme/shop.git'), { owner: 'acme', repo: 'shop' });
  assert.deepEqual(github.parseRemote('ssh://git@github.com/acme/shop.git'), { owner: 'acme', repo: 'shop' });
  assert.equal(github.parseRemote('https://dev.azure.com/acme/Shop/_git/api'), null);
  assert.equal(github.parseRemote('https://gitlab.com/acme/shop.git'), null);
});

const remoteUrl = 'https://github.com/acme/shop.git';

test('GitHub pull request status: reviews and checks, in the Azure DevOps shape', async () => {
  const { fetch, calls } = fakeServer([
    ['GET', /\/pulls\?/, [
      { number: 9, state: 'open', title: 'Add login', draft: false, base: { ref: 'main' }, head: { sha: 'abc' }, html_url: 'https://github.com/acme/shop/pull/9', requested_reviewers: [{ login: 'cy' }] },
      { number: 3, state: 'closed', merged_at: '2026-01-01', title: 'Old' },
    ]],
    ['GET', /\/pulls\/9\/reviews/, [
      { user: { login: 'ana' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'ana' }, state: 'APPROVED' }, // her latest review wins
      { user: { login: 'bo' }, state: 'COMMENTED' },
      { user: { login: 'bo' }, state: 'CHANGES_REQUESTED' },
    ]],
    ['GET', /\/commits\/abc\/check-runs/, { check_runs: [
      { status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'skipped' },
    ] }],
    ['GET', /\/commits\/abc\/statuses/, [{ context: 'ci/legacy', state: 'failure' }, { context: 'ci/legacy', state: 'pending' }]],
  ]);
  const s = await github.prStatus({ remoteUrl, branch: 'feature/login', token: 'tok', fetch });
  assert.equal(s.id, 9, 'the open PR wins');
  assert.equal(s.status, 'active');
  assert.equal(s.target, 'main');
  assert.deepEqual(s.reviewers.map((r) => [r.name, r.vote]), [['ana', 10], ['bo', -5], ['cy', 0]]);
  assert.deepEqual([s.approved, s.waiting, s.rejected], [1, 1, 0]);
  assert.deepEqual(s.checks.builds, { total: 3, passed: 1, failed: 1, running: 1 }, 'only the newest status per context counts');
  assert.match(calls[0].url, /head=acme%3Afeature%2Flogin/);
  assert.equal(calls[0].auth, 'Bearer tok');
});

test('GitHub pull request status: merged, closed, none, no token, bad token, rate limit', async () => {
  const merged = fakeServer([['GET', /\/pulls\?/, [{ number: 3, state: 'closed', merged_at: 'x', title: 'Done', base: { ref: 'main' } }]]]);
  const m = await github.prStatus({ remoteUrl, branch: 'x', token: 't', fetch: merged.fetch });
  assert.equal(m.status, 'completed');
  assert.equal(merged.calls.length, 1, 'no review or check lookups for a finished PR');
  const closed = fakeServer([['GET', /\/pulls\?/, [{ number: 4, state: 'closed', merged_at: null, title: 'Nope', base: { ref: 'main' } }]]]);
  assert.equal((await github.prStatus({ remoteUrl, branch: 'x', token: 't', fetch: closed.fetch })).status, 'abandoned');
  const none = fakeServer([['GET', /\/pulls\?/, []]]);
  assert.ok((await github.prStatus({ remoteUrl, branch: 'x', token: 't', fetch: none.fetch })).none);
  assert.ok((await github.prStatus({ remoteUrl, branch: 'x', token: '' })).noToken);
  const bad = fakeServer([['GET', /\/pulls\?/, { message: 'Bad credentials' }, 401]]);
  await assert.rejects(github.prStatus({ remoteUrl, branch: 'x', token: 'nope', fetch: bad.fetch }), (e) => e.code === 'AUTH');
  const limited = fakeServer([['GET', /\/pulls\?/, { message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }]]);
  await assert.rejects(github.prStatus({ remoteUrl, branch: 'x', token: 't', fetch: limited.fetch }), (e) => e.code === 'RATE');
});

test('GitHub: create a pull request, and explain one that already exists', async () => {
  const ok = fakeServer([['POST', /\/repos\/acme\/shop\/pulls$/, { number: 12, html_url: 'https://github.com/acme/shop/pull/12' }, 201]]);
  const pr = await github.createPr({ remoteUrl, token: 't', head: 'feature/x', base: 'main', title: 'X', body: 'Why', draft: true, fetch: ok.fetch });
  assert.deepEqual(pr, { id: 12, url: 'https://github.com/acme/shop/pull/12' });
  assert.deepEqual(ok.calls[0].body, { head: 'feature/x', base: 'main', title: 'X', body: 'Why', draft: true });

  const dup = fakeServer([['POST', /\/pulls$/, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature/x.' }] }, 422]]);
  await assert.rejects(github.createPr({ remoteUrl, token: 't', head: 'feature/x', base: 'main', title: 'X', fetch: dup.fetch }), /already exists for acme:feature\/x/);
});

test('GitHub: owners, and creating a repo for you or an organisation', async () => {
  const routes = [
    ['GET', /\/user$/, { login: 'me' }],
    ['GET', /\/user\/orgs/, [{ login: 'acme' }]],
    ['POST', /\/user\/repos$/, { clone_url: 'https://github.com/me/app.git', html_url: 'https://github.com/me/app', full_name: 'me/app' }, 201],
    ['POST', /\/orgs\/acme\/repos$/, { clone_url: 'https://github.com/acme/app.git', html_url: 'https://github.com/acme/app', full_name: 'acme/app' }, 201],
  ];
  const s = fakeServer(routes);
  assert.deepEqual(await github.owners({ token: 't', fetch: s.fetch }), [{ login: 'me', type: 'user' }, { login: 'acme', type: 'org' }]);
  const mine = await github.createRepo({ token: 't', owner: 'me', name: 'app', isPrivate: true, fetch: s.fetch });
  assert.equal(mine.cloneUrl, 'https://github.com/me/app.git');
  assert.deepEqual(s.calls.find((c) => c.method === 'POST').body, { name: 'app', private: true, description: '', auto_init: false }, 'created empty, so the first send just works');
  const org = await github.createRepo({ token: 't', owner: 'acme', name: 'app', isPrivate: false, fetch: s.fetch });
  assert.equal(org.cloneUrl, 'https://github.com/acme/app.git');

  const taken = fakeServer([['GET', /\/user$/, { login: 'me' }], ['POST', /\/user\/repos$/, { message: 'Repository creation failed.', errors: [{ code: 'custom', field: 'name', message: 'name already exists on this account' }] }, 422]]);
  await assert.rejects(github.createRepo({ token: 't', owner: 'me', name: 'app', fetch: taken.fetch }), /already exists/);
});

test('Azure DevOps: create a pull request with a work item, projects, and a new repo', async () => {
  const s = fakeServer([
    ['POST', /\/Shop\/_apis\/git\/repositories\/api\/pullrequests/, { pullRequestId: 77 }],
    ['GET', /dev\.azure\.com\/acme\/_apis\/projects\?/, { value: [{ id: '2', name: 'Web' }, { id: '1', name: 'Shop' }] }],
    ['GET', /dev\.azure\.com\/acme\/_apis\/projects\/Shop\?/, { id: 'p-1', name: 'Shop' }],
    ['POST', /dev\.azure\.com\/acme\/Shop\/_apis\/git\/repositories\?/, { name: 'new-api', remoteUrl: 'https://acme@dev.azure.com/acme/Shop/_git/new-api', webUrl: 'https://dev.azure.com/acme/Shop/_git/new-api' }],
  ]);
  const pr = await ado.createPr({ remoteUrl: 'https://dev.azure.com/acme/Shop/_git/api', token: 't', source: 'feature/1234-x', target: 'main', title: 'X', description: 'Why', workItems: ['1234'], fetch: s.fetch });
  assert.deepEqual(pr, { id: 77, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/77' });
  assert.deepEqual(s.calls[0].body, { sourceRefName: 'refs/heads/feature/1234-x', targetRefName: 'refs/heads/main', title: 'X', description: 'Why', isDraft: false, workItemRefs: [{ id: '1234' }] });

  assert.deepEqual((await ado.projects({ org: 'acme', token: 't', fetch: s.fetch })).map((p) => p.name), ['Shop', 'Web']);
  const repo = await ado.createRepo({ org: 'https://dev.azure.com/acme/', project: 'Shop', name: 'new-api', token: 't', fetch: s.fetch });
  assert.equal(repo.cloneUrl, 'https://acme@dev.azure.com/acme/Shop/_git/new-api');
  assert.deepEqual(s.calls.at(-1).body, { name: 'new-api', project: { id: 'p-1' } });

  const dup = fakeServer([['POST', /pullrequests/, { message: 'TF401179: An active pull request for the source and target branch already exists.' }, 409]]);
  await assert.rejects(ado.createPr({ remoteUrl: 'https://dev.azure.com/acme/Shop/_git/api', token: 't', source: 'a', target: 'main', title: 'X', fetch: dup.fetch }),
    (e) => e.code === 'EXISTS' && e.message.startsWith('An active pull request'));
  assert.equal(ado.orgBase('acme'), 'https://dev.azure.com/acme');
  assert.equal(ado.orgBase('acme.visualstudio.com'), 'https://acme.visualstudio.com');
  assert.throws(() => ado.orgBase('not an org!'));
});

test('pull request title and description drafts', () => {
  assert.equal(prTitleFromBranch('feature/1234-login-page'), 'Login page');
  assert.equal(prTitleFromBranch('fix_users_auth'), 'Fix users auth');
  const newestFirst = [{ subject: 'Add tests' }, { subject: "Merge branch 'main' into feature/x" }, { subject: 'Add login form' }];
  assert.deepEqual(prDraft('feature/12-login', newestFirst), { title: 'Login', description: '- Add login form\n- Add tests' });
  assert.deepEqual(prDraft('feature/12-login', [{ subject: 'Add login form' }]), { title: 'Add login form', description: '' });
});
