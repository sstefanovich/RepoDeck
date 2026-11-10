// Screen test: menus close when you pick something, and the Conflicts tab keeps showing its file.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let repo;
let conflicted;

before(async () => {
  repo = sb.repo('polish');
  sb.write(repo, 'a.txt', 'a\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  sb.sh(repo, 'branch', 'dev');

  conflicted = sb.repo('polish-conflict');
  sb.write(conflicted, 'guide.md', 'Title\nIntro\nEnd\n');
  sb.sh(conflicted, 'add', '-A');
  sb.sh(conflicted, 'commit', '-qm', 'Guide');
  sb.sh(conflicted, 'switch', '-qc', 'rewrite');
  sb.write(conflicted, 'guide.md', 'Title\nA brand new intro\nEnd\n');
  sb.sh(conflicted, 'commit', '-qam', 'Rewrite');
  sb.sh(conflicted, 'switch', '-q', 'main');
  sb.write(conflicted, 'guide.md', 'Title\nA shorter intro\nEnd\n');
  sb.sh(conflicted, 'commit', '-qam', 'Shorten');
  try { sb.sh(conflicted, 'merge', 'rewrite'); } catch { /* the conflict is the point */ }

  app = await launchApp([repo, conflicted]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const popoverOpen = () => app.run("return !!document.querySelector('.popover')");
const modalTitle = () => app.run("return document.querySelector('.modal h2')?.textContent || ''");
const closeModal = () => app.run("document.querySelector('.modal [data-close=cancel], .modal [data-close=ok]')?.click();");

test('picking New branch… in the branch switcher closes it before the dialog opens', async () => {
  await app.run(`openRepo(${JSON.stringify(repo)}, 'ui', 'changes');`);
  await app.click('.branch-pill');
  await app.waitFor("return document.querySelector('.popover .switcher-input')", 'the branch switcher');
  await app.click('.popover [data-action=new-branch]');
  await app.waitFor("return document.querySelector('.modal')", 'the new branch dialog');
  assert.equal(await popoverOpen(), false, 'the switcher is gone, not left on top of the dialog');
  await closeModal();
});

test('every choice in the Open menu closes the menu', async () => {
  // Some open a dialog, some a tab or a message; none may leave the menu behind.
  for (const action of ['update-from', 'finish-branch', 'compare', 'recover']) {
    await app.click('[data-action=open-menu]');
    await app.waitFor("return document.querySelector('.popover [role=menu]')", 'the Open menu');
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], 'the menu fits');
    await app.click(`.popover [data-action=${action}]`);
    assert.equal(await popoverOpen(), false, `${action} closed the menu`);
    await new Promise((r) => setTimeout(r, 400));
    await closeModal();
    await app.waitFor("return !document.querySelector('.modal')", 'any dialog to close');
    await app.run(`openRepo(${JSON.stringify(repo)}, 'ui', 'changes');`);
  }
});

test('the branch switcher footer fits', async () => {
  await app.click('.branch-pill');
  await app.waitFor("return document.querySelector('.popover .switcher-foot')", 'the branch switcher');
  const fits = await app.run(`const p = document.querySelector('.popover').getBoundingClientRect();
    return [...document.querySelectorAll('.switcher-foot .btn')].every((b) => b.getBoundingClientRect().right <= p.right - 4);`);
  assert.ok(fits, 'no footer button runs past the edge');
  await app.run('closePopover();');
});

test('the Conflicts tab keeps showing its file when the tab is redrawn', async () => {
  await app.run(`openRepo(${JSON.stringify(conflicted)}, 'ui', 'conflicts');`);
  await app.waitFor("return document.querySelector('#conflict-pane .diff-head')", 'the first conflict to open by itself');
  // A status refresh redraws the tab; the file must not vanish.
  assert.match(await app.run("return document.querySelector('#conflict-pane').textContent"), /A shorter intro[\s\S]*A brand new intro/, 'the step-by-step view shows both sides');
  // A status refresh redraws the tab; the file must not vanish.
  await app.run('renderConflictsTab();');
  assert.ok(await app.run("return !!document.querySelector('#conflict-pane .diff-head')"), 'still showing guide.md');
});
