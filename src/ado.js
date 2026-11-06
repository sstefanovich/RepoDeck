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

// One API call with the token. Turns Azure DevOps' errors into messages people can act on.
// need: the permission to mention if the token is refused.
function client(token, fetch = globalThis.fetch, need = 'Code (Read)') {
  const auth = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  return async (url, { method = 'GET', body } = {}) => {
    let res;
    try {
      res = await fetch(url, { method, headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AdoError("Couldn't reach Azure DevOps. Check your internet or VPN connection.", 'OFFLINE'); }
    // A bad or expired token gets 401, or 203 with a sign-in page instead of JSON.
    if (res.status === 401 || res.status === 203 || !/json/i.test(res.headers.get('content-type') || '')) {
      throw new AdoError(`Azure DevOps didn't accept your token. Check it in Settings: it needs the "${need}" permission and may have expired.`, 'AUTH');
    }
    if (res.status === 403) throw new AdoError(`Your Azure DevOps token isn't allowed to do that. It needs the "${need}" permission.`, 'FORBIDDEN');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // Messages look like "TF401179: An active pull request ... already exists." — drop the code.
      throw new AdoError(data.message ? String(data.message).replace(/^TF\d+:\s*/, '') : `Azure DevOps said: ${res.status} ${res.statusText}`, res.status === 409 ? 'EXISTS' : 'ADO');
    }
    return res.json();
  };
}

async function prStatus({ remoteUrl, branch, token, fetch = globalThis.fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) return { supported: false };
  if (!token) return { supported: true, noToken: true };
  const get = client(token, fetch);
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

// The repo's main branch, for the target of a new pull request.
async function repoInfo({ remoteUrl, token, fetch = globalThis.fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) return null;
  const r = await client(token, fetch)(`${where.base}/${where.project}/_apis/git/repositories/${where.repo}?api-version=7.1`);
  return { defaultBranch: String(r.defaultBranch || '').replace(/^refs\/heads\//, '') || null, webUrl: r.webUrl };
}

// workItems: work item numbers to link (Azure Boards).
async function createPr({ remoteUrl, token, source, target, title, description = '', draft = false, workItems = [], fetch = globalThis.fetch }) {
  const where = parseRemote(remoteUrl);
  if (!where) throw new AdoError('This repo is not on Azure DevOps.');
  const pr = await client(token, fetch, 'Code (Read & write)')(`${where.base}/${where.project}/_apis/git/repositories/${where.repo}/pullrequests?api-version=7.1`, {
    method: 'POST',
    body: {
      sourceRefName: `refs/heads/${source}`, targetRefName: `refs/heads/${target}`, title, description: description.slice(0, 4000), isDraft: !!draft,
      ...(workItems.length ? { workItemRefs: workItems.map((id) => ({ id: String(id) })) } : {}),
    },
  });
  return { id: pr.pullRequestId, url: `${where.base}/${where.project}/_git/${where.repo}/pullrequest/${pr.pullRequestId}` };
}

// The organisation's address from what people type: "acme", "dev.azure.com/acme" or a full URL.
function orgBase(org) {
  const o = String(org || '').trim().replace(/\/+$/, '');
  const m = o.match(/^(?:https?:\/\/)?(?:[^@/]+@)?dev\.azure\.com\/([^/]+)/i);
  if (m) return `https://dev.azure.com/${m[1]}`;
  const v = o.match(/^(?:https?:\/\/)?([^./]+)\.visualstudio\.com/i);
  if (v) return `https://${v[1]}.visualstudio.com`;
  if (/^[\w.-]+$/.test(o)) return `https://dev.azure.com/${o}`;
  throw new AdoError('Type the organisation name, e.g. "acme" from dev.azure.com/acme.');
}

async function projects({ org, token, fetch = globalThis.fetch }) {
  const r = await client(token, fetch, 'Project and Team (Read)')(`${orgBase(org)}/_apis/projects?$top=500&api-version=7.1`);
  return (r.value || []).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
}

// An empty repo in a project.
async function createRepo({ org, project, name, token, fetch = globalThis.fetch }) {
  const base = orgBase(org);
  const call = client(token, fetch, 'Code (Read & write)');
  const p = await call(`${base}/_apis/projects/${encodeURIComponent(project)}?api-version=7.1`);
  const r = await call(`${base}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`, { method: 'POST', body: { name, project: { id: p.id } } });
  return { cloneUrl: r.remoteUrl, webUrl: r.webUrl, name: `${project}/${r.name}` };
}

module.exports = { parseRemote, prStatus, repoInfo, createPr, projects, createRepo, orgBase, summarizeReviews, summarizePolicies, AdoError };
