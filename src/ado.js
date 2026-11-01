// Pull request status from Azure DevOps for the branch you're on. Runs in the main process, so
// the personal access token never reaches the page. Needs a token with "Code (Read)".

class AdoError extends Error {
  constructor(message, code = 'ADO') { super(message); this.code = code; }
}

// Where a repo lives on Azure DevOps, from its remote URL; null for other servers.
// -> { base, project, repo } with base like https://dev.azure.com/org
function parseRemote(url) {
  const u = String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  let m = u.match(/^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { base: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] };
  m = u.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com(?::v3|:22\/v3)?\/([^/]+)\/([^/]+)\/([^/]+)$/i)
    || u.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (m) return { base: `https://dev.azure.com/${m[1]}`, project: m[2], repo: m[3] };
  m = u.match(/^https:\/\/(?:[^@/]+@)?([^.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { base: `https://${m[1]}.visualstudio.com`, project: m[2], repo: m[3] };
  m = u.match(/^[^@]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (m) return { base: `https://${m[1]}.visualstudio.com`, project: m[2], repo: m[3] };
  return null;
}

// Reviewer votes: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected.
function summarizeReviews(reviewers) {
  const list = (reviewers || []).filter((r) => !r.isContainer || r.vote !== 0).map((r) => ({ name: r.displayName, vote: r.vote || 0, required: !!r.isRequired }));
  return {
    reviewers: list,
    approved: list.filter((r) => r.vote >= 5).length,
    waiting: list.filter((r) => r.vote === -5).length,
    rejected: list.filter((r) => r.vote === -10).length,
  };
}

// Branch policy results (builds and other checks) for a pull request.
function summarizePolicies(evaluations) {
  const all = (evaluations || []).filter((e) => e.status !== 'notApplicable');
  const builds = all.filter((e) => /build/i.test(e.configuration?.type?.displayName || ''));
  const count = (list, ...states) => list.filter((e) => states.includes(e.status)).length;
  return {
    builds: { total: builds.length, passed: count(builds, 'approved'), failed: count(builds, 'rejected', 'broken'), running: count(builds, 'running', 'queued') },
    blocking: all.filter((e) => e.configuration?.isBlocking && e.status !== 'approved').length,
  };
}

async function prStatus({ remoteUrl, branch, token, fetch = globalThis.fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) return { supported: false };
  if (!token) return { supported: true, noToken: true };
  const auth = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  const get = async (url) => {
    let res;
    try { res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } }); }
    catch { throw new AdoError("Couldn't reach Azure DevOps. Check your internet or VPN connection.", 'OFFLINE'); }
    // A bad or expired token gets 401, or 203 with a sign-in page instead of JSON.
    if (res.status === 401 || res.status === 203 || !/json/i.test(res.headers.get('content-type') || '')) {
      throw new AdoError('Azure DevOps didn\'t accept your token. Check it in Settings — it needs the "Code (Read)" permission and may have expired.', 'AUTH');
    }
    if (!res.ok) throw new AdoError(`Azure DevOps said: ${res.status} ${res.statusText}`);
    return res.json();
  };
  const api = `${where.base}/${where.project}/_apis`;
  const ref = encodeURIComponent(`refs/heads/${branch}`);
  const list = await get(`${api}/git/repositories/${where.repo}/pullrequests?searchCriteria.sourceRefName=${ref}&searchCriteria.status=all&$top=10&api-version=7.1`);
  // The open one if there is one, else the most recent.
  const prs = (list.value || []).sort((a, b) => b.pullRequestId - a.pullRequestId);
  const pr = prs.find((p) => p.status === 'active') || prs[0];
  if (!pr) return { supported: true, none: true, branch };
  let checks = null;
  const projectId = pr.repository?.project?.id;
  if (projectId && pr.status === 'active') {
    const artifact = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${pr.pullRequestId}`);
    checks = await get(`${api}/policy/evaluations?artifactId=${artifact}&api-version=7.1-preview.1`).then((e) => summarizePolicies(e.value)).catch(() => null);
  }
  return {
    supported: true,
    branch,
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.status, // active | completed | abandoned
    draft: !!pr.isDraft,
    target: String(pr.targetRefName || '').replace(/^refs\/heads\//, ''),
    url: `${where.base}/${where.project}/_git/${where.repo}/pullrequest/${pr.pullRequestId}`,
    ...summarizeReviews(pr.reviewers),
    checks,
  };
}

module.exports = { parseRemote, prStatus, summarizeReviews, summarizePolicies, AdoError };
