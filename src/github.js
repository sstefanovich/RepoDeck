// GitHub: pull request status, creating pull requests and creating repos. Runs in the main process,
// so the personal access token never reaches the page. Pull request status uses the same shape as
// src/ado.js, so the UI shows both the same way.

const API = 'https://api.github.com';

class GithubError extends Error {
  constructor(message, code = 'GITHUB') { super(message); this.code = code; }
}

// Where a repo lives on GitHub, from its remote URL; null for other servers. -> { owner, repo }
function parseRemote(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = u.match(/^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i)
    || u.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+)$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// One API call. Turns GitHub's errors into messages people can act on.
function client(token, fetch = globalThis.fetch) {
  return async (method, url, body) => {
    let res;
    try {
      res = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'RepoDeck', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new GithubError("Couldn't reach GitHub. Check your internet connection.", 'OFFLINE'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new GithubError("GitHub didn't accept your token. Check it in Settings: it may have expired or been revoked.", 'AUTH');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') throw new GithubError('GitHub has had too many requests from this token for now. Try again in a few minutes.', 'RATE');
    if (res.status === 403 || (res.status === 404 && method !== 'GET')) {
      throw new GithubError(`GitHub said your token isn't allowed to do that${data.message ? ` (${data.message})` : ''}. Check its permissions in Settings.`, 'FORBIDDEN');
    }
    if (res.status === 404) throw new GithubError("GitHub couldn't find that repo. If it's private, check that your token can see it.", 'NOT_FOUND');
    if (res.status === 422) {
      const detail = (data.errors || []).map((e) => e.message || (e.code === 'already_exists' ? `${e.field || 'it'} already exists` : e.code)).filter(Boolean).join('; ');
      throw new GithubError(detail || data.message || 'GitHub rejected the request.', 'INVALID');
    }
    if (!res.ok) throw new GithubError(`GitHub said: ${res.status} ${data.message || res.statusText || ''}`.trim());
    return data;
  };
}

// The latest review from each reviewer, plus requested reviewers who haven't reviewed yet,
// as Azure DevOps-style votes: 10 approved, -5 changes requested, 0 no vote.
function summarizeReviews(reviews, requested = []) {
  const latest = new Map();
  for (const r of reviews || []) {
    if (!r.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue; // COMMENTED doesn't change a vote
    latest.set(r.user.login, r.state);
  }
  const list = [...latest].filter(([, s]) => s !== 'DISMISSED').map(([name, s]) => ({ name, vote: s === 'APPROVED' ? 10 : -5, required: false }));
  for (const u of requested) if (!latest.has(u.login)) list.push({ name: u.login, vote: 0, required: false });
  return {
    reviewers: list,
    approved: list.filter((r) => r.vote >= 5).length,
    waiting: list.filter((r) => r.vote === -5).length,
    rejected: 0,
  };
}

// Check runs (GitHub Actions and apps) and commit statuses (older CI) for the PR's latest commit.
function summarizeChecks(runs = [], statuses = []) {
  const builds = { total: 0, passed: 0, failed: 0, running: 0 };
  for (const r of runs) {
    if (r.conclusion === 'skipped' || r.conclusion === 'neutral') continue;
    builds.total++;
    if (r.status !== 'completed') builds.running++;
    else if (r.conclusion === 'success') builds.passed++;
    else builds.failed++;
  }
  // Statuses: only the newest per context counts.
  const latest = new Map();
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, s.state);
  for (const state of latest.values()) {
    builds.total++;
    if (state === 'pending') builds.running++;
    else if (state === 'success') builds.passed++;
    else builds.failed++;
  }
  return { builds, blocking: builds.failed + builds.running };
}

async function prStatus({ remoteUrl, branch, token, fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) return { supported: false };
  if (!token) return { supported: true, noToken: true };
  const call = client(token, fetch);
  const repo = `/repos/${where.owner}/${where.repo}`;
  const prs = await call('GET', `${repo}/pulls?state=all&head=${encodeURIComponent(`${where.owner}:${branch}`)}&per_page=10&sort=created&direction=desc`);
  const pr = prs.find((p) => p.state === 'open') || prs[0];
  if (!pr) return { supported: true, none: true, branch };
  const status = pr.state === 'open' ? 'active' : pr.merged_at ? 'completed' : 'abandoned';
  let reviews = { reviewers: [], approved: 0, waiting: 0, rejected: 0 };
  let checks = null;
  if (status === 'active') {
    const [rv, runs, sts] = await Promise.all([
      call('GET', `${repo}/pulls/${pr.number}/reviews?per_page=100`).catch(() => []),
      call('GET', `${repo}/commits/${pr.head.sha}/check-runs?per_page=100`).catch(() => null),
      call('GET', `${repo}/commits/${pr.head.sha}/statuses?per_page=100`).catch(() => null),
    ]);
    reviews = summarizeReviews(rv, pr.requested_reviewers);
    if (runs || sts) checks = summarizeChecks(runs?.check_runs, sts || []);
  }
  return {
    supported: true,
    branch,
    id: pr.number,
    title: pr.title,
    status,
    draft: !!pr.draft,
    target: pr.base?.ref,
    url: pr.html_url,
    ...reviews,
    checks,
  };
}

// The repo's main branch, for the target of a new pull request.
async function repoInfo({ remoteUrl, token, fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) return null;
  const r = await client(token, fetch)('GET', `/repos/${where.owner}/${where.repo}`);
  return { defaultBranch: r.default_branch, webUrl: r.html_url };
}

async function createPr({ remoteUrl, token, head, base, title, body = '', draft = false, fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) throw new GithubError('This repo is not on GitHub.');
  const pr = await client(token, fetch)('POST', `/repos/${where.owner}/${where.repo}/pulls`, { head, base, title, body, draft });
  return { id: pr.number, url: pr.html_url };
}

// You, then the organisations you belong to (each a place a new repo can go).
async function owners({ token, fetch }) {
  const call = client(token, fetch);
  const me = await call('GET', '/user');
  const orgs = await call('GET', '/user/orgs?per_page=100').catch(() => []);
  return [{ login: me.login, type: 'user' }, ...orgs.map((o) => ({ login: o.login, type: 'org' }))];
}

// An empty repo (no README, licence or .gitignore, so the first send just works).
async function createRepo({ token, owner, name, isPrivate = true, description = '', fetch }) {
  const call = client(token, fetch);
  const me = await call('GET', '/user');
  const body = { name, private: !!isPrivate, description, auto_init: false };
  const r = owner && owner.toLowerCase() !== me.login.toLowerCase()
    ? await call('POST', `/orgs/${encodeURIComponent(owner)}/repos`, body)
    : await call('POST', '/user/repos', body);
  return { cloneUrl: r.clone_url, webUrl: r.html_url, name: r.full_name };
}

module.exports = { parseRemote, prStatus, repoInfo, createPr, owners, createRepo, summarizeReviews, summarizeChecks, GithubError };
