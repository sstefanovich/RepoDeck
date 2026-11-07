// The console: splitting command lines, what is blocked or risky, running commands, and the output helpers.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const con = require('../src/console');
const { feedOutput, ansiToHtml } = require('../renderer/lib');
const { sandbox } = require('./helpers');

const sb = sandbox();
after(() => sb.cleanup());

test('command lines are split like a shell would', () => {
  assert.deepEqual(con.splitArgs('git commit -m "Fix the login page" --no-verify'), ['git', 'commit', '-m', 'Fix the login page', '--no-verify']);
  assert.deepEqual(con.splitArgs("git log --format='%h %s'  -3"), ['git', 'log', '--format=%h %s', '-3']);
  assert.deepEqual(con.splitArgs('git commit -m "say \\"hi\\""'), ['git', 'commit', '-m', 'say "hi"']);
  assert.deepEqual(con.splitArgs('git commit -m ""'), ['git', 'commit', '-m', '']);
  assert.deepEqual(con.splitArgs('   '), []);
});

test('git commands that need a full terminal are blocked, with a way forward', () => {
  const blocked = (line) => con.check(line).blocked;
  for (const line of ['git rebase -i HEAD~3', 'git rebase --interactive main', 'git add -p', 'git add --patch src', 'git checkout -p',
    'git commit', 'git commit --amend', 'git tag -a v1', 'git mergetool', 'git -C sub commit -a']) {
    assert.ok(blocked(line), `${line} is blocked`);
  }
  for (const line of ['git commit -m "x"', 'git commit -am "x"', 'git commit --amend --no-edit', 'git commit -F msg.txt', 'git tag -a v1 -m "One"',
    'git rebase main', 'git add -A', 'git status', 'git log --oneline', 'git stash push -m "wip"', 'git checkout -b feature/p']) {
    assert.equal(blocked(line), null, `${line} runs`);
  }
  assert.match(con.check('git rebase -i HEAD~2').hint, /Tidy unsent commits/);
  assert.match(con.check('git commit').hint, /git commit -m/);
});

test('risky commands are recognised; everyday ones are not', () => {
  const risky = (line) => con.check(line).risky;
  for (const line of ['git push --force', 'git push -f origin main', 'git push origin +main', 'git push --force-with-lease', 'git push origin --delete old',
    'git push origin :old', 'git reset --hard', 'git reset --hard origin/main', 'git clean -fd', 'git checkout .', 'git checkout -- app.js',
    'git restore app.js', 'git branch -D old', 'git stash drop', 'git stash clear', 'git gc --prune=now', 'Remove-Item -Recurse build', 'rm -r dist']) {
    assert.ok(risky(line), `${line} asks first`);
  }
  for (const line of ['git push', 'git push -u origin feature/x', 'git reset --soft HEAD~1', 'git restore --staged app.js', 'git branch -d old',
    'git stash pop', 'git clean -n', 'git checkout main', 'git checkout -b fix', 'dir', 'npm test']) {
    assert.equal(risky(line), null, `${line} just runs`);
  }
});

test('lines go to git or the shell', () => {
  assert.equal(con.check('git status').kind, 'git');
  assert.equal(con.check('GIT status').kind, 'git');
  assert.equal(con.check('git log | Select-Object -First 3').kind, 'shell', 'pipes need the shell');
  assert.equal(con.check('npm test').kind, 'shell');
  assert.equal(con.check('').kind, 'empty');
  assert.ok(con.check('vim').blocked);
});

const runLine = (cwd, line) => new Promise((resolve) => {
  let out = '';
  con.start({ cwd, line, onData: (_s, t) => { out += t; }, onExit: (code, error) => resolve({ code, error, out }) });
});

test('runs git with colours, a pager-free log, and no editor', async () => {
  const a = sb.repo('console-run');
  sb.write(a, 'readme.md', 'hi\n');
  let r = await runLine(a, 'git add -A');
  assert.equal(r.code, 0);
  r = await runLine(a, 'git commit -m "From the console"');
  assert.equal(r.code, 0);
  assert.match(r.out, /From the console/);
  r = await runLine(a, 'git log --oneline');
  assert.match(r.out, /\x1b\[33m[0-9a-f]{7}/, 'hashes come in colour');
  r = await runLine(a, 'git switch nope');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /invalid reference|did not match/i);
});

test('runs shell commands, and Stop ends a long one', { skip: process.platform !== 'win32' }, async () => {
  const a = sb.repo('console-shell');
  const r = await runLine(a, 'Write-Output "héllo wörld"; Get-Location | Select-Object -ExpandProperty Path');
  assert.equal(r.code, 0);
  assert.match(r.out, /héllo wörld/, 'UTF-8 comes through');
  assert.match(r.out.toLowerCase(), new RegExp(a.toLowerCase().replace(/[\\.]/g, (c) => `\\${c}`)), 'runs in the repo folder');

  const started = Date.now();
  const done = new Promise((resolve) => {
    const child = con.start({ cwd: a, line: 'Start-Sleep -Seconds 30', onData: () => {}, onExit: (code) => resolve(code) });
    setTimeout(() => con.stop(child), 1500);
  });
  await done;
  assert.ok(Date.now() - started < 15000, 'stopped well before the 30 seconds');
});

test('output buffer: lines, progress counters that redraw, and a limit', () => {
  const buf = { lines: [''], cr: false, dropped: 0 };
  feedOutput(buf, 'one\ntw');
  feedOutput(buf, 'o\r');
  feedOutput(buf, '\nReceiving 10%\rReceiving 55%\rReceiving 100%\n');
  assert.deepEqual(buf.lines, ['one', 'two', 'Receiving 100%', '']);
  feedOutput(buf, 'a\nb\nc\n', 3);
  assert.deepEqual(buf.lines, ['b', 'c', '']);
  assert.equal(buf.dropped, 4, 'one, two, Receiving 100% and a');
});

test('terminal colours become spans; text is escaped', () => {
  assert.equal(ansiToHtml('\x1b[33mabc1234\x1b[m fix <b>'), '<span class="ansi-fg3">abc1234</span> fix &lt;b&gt;');
  assert.equal(ansiToHtml('\x1b[1;31mbad\x1b[0m ok'), '<span class="ansi-fg1 ansi-b">bad</span> ok');
  assert.equal(ansiToHtml('\x1b[92mnew\x1b[39m\x1b[K plain'), '<span class="ansi-fg10">new</span> plain');
  assert.equal(ansiToHtml('\x1b[38;5;208mx\x1b[m'), 'x', '256-colour codes are skipped without breaking');
});
