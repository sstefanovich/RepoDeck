// Screen test: the tab bar's right-click menu, and tabs wrapping onto more rows.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp } = require('./app');

const sb = sandbox();
const repos = [];
let app;

before(async () => {
  for (let i = 1; i <= 6; i++) {
    const r = sb.repo(`tabs-repo-with-a-longer-name-${i}`);
    sb.write(r, 'a.txt', 'a\n');
    sb.sh(r, 'add', '-A');
    sb.sh(r, 'commit', '-qm', 'Base');
    repos.push(r);
  }
  app = await launchApp(repos.slice(0, 4), {}, { workspaces: [{ id: 'other', name: 'Other', repos: repos.slice(4) }] });
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const tabNames = () => app.run("return [...document.querySelectorAll('#tabbar .dtab .dtab-name')].map((n) => n.textContent)");
const activeName = () => app.run("return document.querySelector('#tabbar .dtab.active .dtab-name')?.textContent || null");
const openAll = async () => {
  for (const r of repos) {
    await app.run(`[...document.querySelectorAll('#ws-list .repo-item')].find((x) => x.dataset.repo === ${JSON.stringify(r)}).click()`);
    await app.waitFor(`return document.querySelector('#tabbar .dtab.active')?.title === ${JSON.stringify(r)}`, `the tab of ${r}`);
  }
};
// Right-clicks the tab at `index` and clicks the menu item with that label.
const menu = async (index, label) => {
  await app.run(`const t = document.querySelectorAll('#tabbar .dtab')[${index}]; const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.bottom - 5 }));`);
  await app.waitFor("return document.querySelector('.popover [data-action=tab-close-set]')", 'the tab menu');
  return app.run(`const b = [...document.querySelectorAll('.popover .menu-item')].find((x) => x.querySelector('span').textContent === ${JSON.stringify(label)});
    if (!b) throw new Error('No menu item ' + ${JSON.stringify(label)});
    if (b.disabled) return 'disabled';
    b.click(); return 'clicked';`);
};
const name = (i) => `tabs-repo-with-a-longer-name-${i}`;

test('right-click a tab to close others, to the right, to the left, or all', async () => {
  await app.size(1600);
  await openAll();
  assert.deepEqual(await tabNames(), [1, 2, 3, 4, 5, 6].map(name));

  assert.equal(await menu(3, 'Close tabs to the right'), 'clicked');
  assert.deepEqual(await tabNames(), [1, 2, 3, 4].map(name));
  assert.equal(await activeName(), name(4), 'the tab right-clicked takes over from the closed active one');

  assert.equal(await menu(3, 'Close tabs to the right'), 'disabled', 'nothing to the right of the last tab');
  await app.run('closePopover()');

  assert.equal(await menu(2, 'Close tabs to the left'), 'clicked');
  assert.deepEqual(await tabNames(), [3, 4].map(name));
  assert.equal(await activeName(), name(4), 'the active tab stays when it is not closed');

  assert.equal(await menu(0, 'Close others'), 'clicked');
  assert.deepEqual(await tabNames(), [name(3)]);
  assert.equal(await activeName(), name(3));

  // Tabs from another workspace.
  await openAll();
  assert.equal(await menu(0, 'Close tabs not in UI tests'), 'clicked');
  assert.deepEqual((await tabNames()).sort(), [1, 2, 3, 4].map(name), 'new tabs open next to the active one, so the order differs');

  assert.equal(await menu(1, 'Close all'), 'clicked');
  assert.deepEqual(await tabNames(), []);
  assert.ok(await app.run("return !!document.querySelector('.home')"), 'back to the start page');
});

test('tabs that do not fit wrap onto more rows instead of scrolling sideways', async () => {
  await app.size(900);
  await openAll();
  const r = await app.run(`const bar = document.querySelector('#tabbar');
    const tabs = [...bar.querySelectorAll('.dtab')];
    return { rows: new Set(tabs.map((t) => t.offsetTop)).size, sideways: bar.scrollWidth > bar.clientWidth + 1,
      upper: tabs.filter((t) => t.classList.contains('upper-row')).length, inside: tabs.every((t) => t.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1) };`);
  assert.ok(r.rows > 1, `rows: ${r.rows}`);
  assert.equal(r.sideways, false, 'no sideways scrolling');
  assert.ok(r.inside, 'every tab is inside the bar');
  assert.ok(r.upper > 0, 'tabs above the bottom row are marked');
  if (process.env.SHOTS) {
    await app.screenshot('tabs multi-row');
    await app.run(`const t = document.querySelectorAll('#tabbar .dtab')[1]; const b = t.getBoundingClientRect();
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 10, clientY: b.bottom - 5 }));`);
    await app.screenshot('tabs menu');
    await app.run('closePopover()');
  }
  // Widening the window puts them back on one row.
  await app.size(2600);
  await app.waitFor("return document.querySelectorAll('#tabbar .dtab.upper-row').length === 0", 'one row of tabs');
});
