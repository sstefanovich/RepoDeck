// Screen test: with the AI assistant turned off in Settings, nothing Claude-related shows.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp } = require('./app');

const sb = sandbox();
let app;

// Every way into the assistant that is on screen right now.
const VISIBLE_AI = `return [...document.querySelectorAll('[data-action^="claude-"], [data-action=write-message], [data-action=explain-commit], [data-action=explain-conflict], [data-action=blame-explain], #claude-panel')]
  .filter((el) => el.getClientRects().length && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')).map((el) => el.dataset.action || el.id);`;

before(async () => {
  const repo = sb.repo('ai-off');
  sb.write(repo, 'a.txt', 'a\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'First');
  sb.write(repo, 'a.txt', 'a changed\n');
  app = await launchApp([repo], { assistant: 'off', claudeOpen: true });
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

test('turned off: no ✦ buttons or panel on any tab, and Ctrl+J does nothing', async () => {
  for (const tab of ['changes', 'history', 'branches']) {
    await app.click(`[data-action=tab][data-tab=${tab}]`);
    await app.waitFor("return !document.querySelector('#tab-body .spinner') && (document.querySelector('.commit-detail') || location.href)", `the ${tab} tab`);
    if (tab === 'history') await app.waitFor("return document.querySelector('.commit-detail')", 'commit details');
    assert.deepEqual(await app.run(VISIBLE_AI), [], `nothing on the ${tab} tab`);
  }
  await app.run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));");
  assert.ok(await app.run("return document.querySelector('#claude-panel').hidden"), 'Ctrl+J does not open the panel');
});

test('turning it back on in Settings brings everything back', async () => {
  await app.click('[data-action=settings]');
  await app.waitFor("return document.querySelector('.modal [name=assistant]')", 'Settings');
  await app.run("document.querySelector('.modal [name=assistant]').value = 'claude';");
  await app.click('.modal [data-close=ok]');
  await app.click('[data-action=tab][data-tab=changes]');
  await app.waitFor("return document.querySelector('[data-action=write-message]')?.getClientRects().length", 'the ✦ Write message button');
  const visible = await app.run(VISIBLE_AI);
  assert.ok(visible.includes('claude-toggle') && visible.includes('write-message'), visible.join(', '));
});
