// Screen test: warnings about work on dev (or another shared branch), and moving it to a new branch.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let repo;

before(async () => {
  repo = sb.repo('warn');
  sb.write(repo, 'a.txt', 'a\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  sb.sh(repo, 'remote', 'add', 'origin', sb.server('warn'));
  sb.sh(repo, 'push', '-q', '-u', 'origin', 'main');
  sb.sh(repo, 'switch', '-qc', 'dev');
  sb.sh(repo, 'push', '-q', '-u', 'origin', 'dev');
  sb.write(repo, 'a.txt', 'a\nedited on dev\n');
  app = await launchApp([repo]);
  await app.run(`openRepo(${JSON.stringify(repo)}, 'ui', 'changes');`);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const bannerText = () => app.run("return document.querySelector('#op-banner')?.textContent || ''");
const modalTitle = () => app.run("return document.querySelector('.modal h2')?.textContent || ''");

test('an edit on dev shows a warning in the repo and the sidebar', async () => {
  await app.waitFor("return /working directly on dev/.test(document.querySelector('#op-banner')?.textContent)", 'the warning banner');
  assert.match(await bannerText(), /1 uncommitted change/);
  if (process.env.SHOTS) await app.screenshot('warning on dev');
  assert.ok(await app.run("return !!document.querySelector('.repo-item .badge.wrong')"), 'sidebar badge');
  for (const w of [960, 1300]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }
});

test('committing on dev offers to move the work, then commits on the new branch', async () => {
  await app.run("const s = document.querySelector('#commit-summary'); s.value = 'Fix the thing'; s.dispatchEvent(new Event('input', { bubbles: true }));");
  await app.click('#commit-btn');
  await app.waitFor("return /Commit straight to dev/.test(document.querySelector('.modal h2')?.textContent)", 'the commit check');
  await app.click('.modal [data-close=move]');
  await app.waitFor("return /Move your work/.test(document.querySelector('.modal h2')?.textContent)", 'the move dialog');
  assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the move dialog fits');
  if (process.env.SHOTS) await app.screenshot('move to a new branch');
  await app.run("document.querySelector('.modal [name=name]').value = 'fix/the-thing';");
  await app.click('.modal [data-close=ok]');
  await app.waitFor(`return ${JSON.stringify(sb.sh(repo, 'rev-parse', 'HEAD').trim())} !== (state.status[${JSON.stringify(repo)}]?.oid) && state.status[${JSON.stringify(repo)}]?.branch === 'fix/the-thing' && !state.busy[${JSON.stringify(repo)}]`, 'the commit on the new branch');
  assert.equal(sb.sh(repo, 'branch', '--show-current').trim(), 'fix/the-thing');
  assert.equal(sb.sh(repo, 'log', '-1', '--format=%s').trim(), 'Fix the thing');
  assert.equal(sb.sh(repo, 'rev-parse', 'dev').trim(), sb.sh(repo, 'rev-parse', 'origin/dev').trim(), 'dev is untouched');
  assert.equal(await modalTitle(), '');
  await app.waitFor("return !/working directly/.test(document.querySelector('#op-banner')?.textContent)", 'the banner to go');
});

test('"Keep working on dev" hides the warning for this session', async () => {
  sb.sh(repo, 'switch', '-q', 'dev');
  sb.write(repo, 'b.txt', 'b\n');
  await app.run('await refreshAll(true);');
  await app.waitFor("return /working directly on dev/.test(document.querySelector('#op-banner')?.textContent)", 'the warning banner');
  await app.click('#op-banner [data-action=warn-ok]');
  await app.waitFor("return !document.querySelector('#op-banner .banner')", 'the banner to go');
  assert.ok(!(await app.run("return !!document.querySelector('.repo-item .badge.wrong')")), 'the badge goes too');
});

test('a branch far behind dev says so, and offers Update from dev', async () => {
  const r = sb.repo('behind-ui');
  sb.write(r, 'a.txt', 'a\n');
  sb.sh(r, 'add', '-A');
  sb.sh(r, 'commit', '-qm', 'Base');
  sb.sh(r, 'remote', 'add', 'origin', sb.server('behind-ui'));
  sb.sh(r, 'push', '-q', '-u', 'origin', 'main');
  sb.sh(r, 'switch', '-qc', 'dev');
  sb.sh(r, 'push', '-q', '-u', 'origin', 'dev');
  sb.sh(r, 'switch', '-qc', 'feature/far');
  sb.sh(r, 'switch', '-q', 'dev');
  for (let i = 0; i < 3; i++) { sb.write(r, 'd.txt', `${i}\n`); sb.sh(r, 'add', '-A'); sb.sh(r, 'commit', '-qm', `dev ${i}`); }
  sb.sh(r, 'push', '-q');
  // A Shelf item left on a branch that was then deleted.
  sb.sh(r, 'switch', '-qc', 'feature/old');
  sb.write(r, 'old.txt', 'unfinished\n');
  sb.sh(r, 'stash', 'push', '-u', '-m', '[auto] feature/old: left behind when switching to feature/far');
  sb.sh(r, 'switch', '-q', 'feature/far');
  sb.sh(r, 'branch', '-D', 'feature/old');

  await app.run(`state.config.settings.behindWarn = 2; state.config.workspaces[0].repos.push(${JSON.stringify(r)}); await refreshAll(true); openRepo(${JSON.stringify(r)}, 'ui', 'changes');`);
  await app.waitFor("return /feature.far is 3 commits behind dev/.test(document.querySelector('#op-banner')?.textContent)", 'the behind banner');
  assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the behind banner fits');
  if (process.env.SHOTS) await app.screenshot('behind dev');
  await app.click('#op-banner [data-action=update-from]');
  await app.waitFor("return /Update feature.far/.test(document.querySelector('.modal h2')?.textContent)", 'the Update from dialog');
  assert.equal(await app.run("return document.querySelector('.modal [name=ref]').value"), 'origin/dev', 'dev is picked');
  await app.run("document.querySelector('.modal [data-close=cancel]').click();");

  // Not now: the next thing to mention is the Shelf item.
  await app.click('#op-banner [data-action=behind-ok]');
  await app.waitFor("return /left on feature.old, which no longer exists/.test(document.querySelector('#op-banner')?.textContent)", 'the Shelf banner');
  assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the Shelf banner fits');
  if (process.env.SHOTS) await app.screenshot('shelf left behind');
  await app.click('#op-banner [data-tab=shelf]');
  await app.waitFor("return document.querySelector('.commit .tag.bad')?.textContent === 'branch deleted'", 'the tag in the Shelf');
  await app.click('#op-banner [data-action=shelf-ok]');
  await app.waitFor("return !document.querySelector('#op-banner .banner')", 'the banner to go');
});

test('new branch names: advice as you type, and the suggested name in one click', async () => {
  await app.run('setTab("changes"); newBranch(currentRepo());');
  await app.waitFor("return document.querySelector('.modal #name-advice')", 'the new branch dialog');
  const type = (v) => app.run(`const i = document.querySelector('.modal [name=name]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input'));`);
  await type('feature/far');
  assert.match(await app.run("return document.querySelector('#name-advice').textContent"), /already a branch called feature\/far/);
  await type('dev');
  assert.match(await app.run("return document.querySelector('#name-advice').textContent"), /one of your shared branches/);
  await type('login page');
  assert.equal(await app.run("return document.querySelector('.modal [name=name]').value"), 'login-page', 'spaces become dashes');
  assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the advice fits');
  if (process.env.SHOTS) await app.screenshot('branch name advice');
  await app.click('#name-advice [data-suggest]');
  assert.equal(await app.run("return document.querySelector('.modal [name=name]').value"), 'feature/login-page');
  assert.equal(await app.run("return document.querySelector('#name-advice').textContent"), '', 'no more advice');
  await app.click('.modal [data-close=ok]');
  await app.waitFor("return state.status[currentRepo()]?.branch === 'feature/login-page'", 'the new branch');
});
