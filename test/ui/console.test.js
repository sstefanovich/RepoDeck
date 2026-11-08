// Screen test: the console runs git commands in the open repo, blocks interactive ones, asks before
// risky ones, offers Undo, and keeps a history.
// Run with `npm run test:ui`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sandbox } = require('../helpers');
const { launchApp, LAYOUT_PROBLEMS } = require('./app');

const sb = sandbox();
let app;
let repo;

before(async () => {
  repo = sb.repo('console');
  sb.write(repo, 'a.txt', 'a\n');
  sb.sh(repo, 'add', '-A');
  sb.sh(repo, 'commit', '-qm', 'Base');
  app = await launchApp([repo]);
});

after(async () => {
  await app?.close();
  sb.cleanup();
});

const output = () => app.run("return document.querySelector('#console-out').innerText");
// Types a line, presses Enter, and waits for it to finish (and the app to catch up).
async function type(line) {
  await app.run(`const i = document.querySelector('#console-input'); i.value = ${JSON.stringify(line)};
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await term.pending;
    renderConsoleOutput();`);
}

test('the console opens in the repo and runs git commands', async () => {
  await app.run("document.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', ctrlKey: true, bubbles: true }));");
  await app.waitFor("return !document.querySelector('#console').hidden", 'the console to open');
  assert.equal(await app.run("return document.activeElement.id"), 'console-input');
  assert.equal(await app.run("return document.querySelector('#console-prompt').textContent"), 'console (main) >');
  for (const w of [960, 1400]) {
    await app.size(w);
    assert.deepEqual(await app.run(LAYOUT_PROBLEMS), [], `layout at ${w}px`);
  }

  sb.write(repo, 'b.txt', 'b\n');
  await type('git add -A');
  await type('git commit -m "Typed by hand"');
  assert.match(await output(), /Typed by hand/);
  assert.equal(sb.sh(repo, 'log', '-1', '--format=%s').trim(), 'Typed by hand');
  // The app noticed, and offers Undo like any other commit.
  assert.match(await app.run('return state.undos[0]?.label'), /Typed by hand/, 'an undo entry');
  assert.ok(await app.run("return state.logs.some((l) => l.command === 'git commit -m \"Typed by hand\"')"), 'listed in Behind the scenes');

  await type('git log --oneline -1');
  assert.match(await app.run("return document.querySelector('#console-out').innerHTML"), /class="ansi-fg3"/, 'git colours show');
});

test('interactive commands are explained; risky ones ask first', async () => {
  await type('git rebase -i HEAD~1');
  assert.match(await output(), /needs a full terminal[\s\S]*Tidy unsent commits/);

  await app.run(`const i = document.querySelector('#console-input'); i.value = 'git reset --hard HEAD~1';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  await app.waitFor("return /Run this command/.test(document.querySelector('.modal h2')?.textContent)", 'the confirmation');
  await app.click('.modal [data-close=cancel]');
  await app.waitFor("return /\\(not run\\)/.test(document.querySelector('#console-out').innerText)", '"not run"');
  assert.equal(sb.sh(repo, 'log', '-1', '--format=%s').trim(), 'Typed by hand', 'nothing was reset');
});

test('history with ↑, Tab completion, clear, and shell commands', async () => {
  const key = (k) => app.run(`document.querySelector('#console-input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));`);
  const value = () => app.run("return document.querySelector('#console-input').value");
  await key('ArrowUp');
  assert.equal(await value(), 'git reset --hard HEAD~1');
  await key('ArrowUp');
  assert.equal(await value(), 'git rebase -i HEAD~1');
  await key('ArrowDown');
  await key('ArrowDown');
  assert.equal(await value(), '', 'back to the empty line');

  await app.run("const i = document.querySelector('#console-input'); i.value = 'git swi'; i.setSelectionRange(7, 7);");
  await key('Tab');
  await app.waitFor("return document.querySelector('#console-input').value === 'git switch '", 'the command to complete');
  await app.run("const i = document.querySelector('#console-input'); i.value = 'git switch ma'; i.setSelectionRange(13, 13);");
  await key('Tab');
  await app.waitFor("return document.querySelector('#console-input').value === 'git switch main '", 'the branch to complete');

  await type('Write-Output "from PowerShell"');
  assert.match(await output(), /from PowerShell/);
  await type('clear');
  assert.doesNotMatch(await output(), /from PowerShell/);
});
