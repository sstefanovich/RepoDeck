// Which shell commands Claude may run without asking (read-only git only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isReadOnlyCommand } = require('../src/claude');

test('read-only git commands are allowed', () => {
  for (const cmd of [
    'git status',
    'git -C "C:\\x y\\api" branch --list test/a -v; git -C "C:\\x y\\api" rev-parse --abbrev-ref HEAD',
    'git log --oneline -5 | head -3',
    'git fetch --all --prune',
    'git stash list',
  ]) assert.ok(isReadOnlyCommand(cmd), cmd);
});

test('anything that changes something still asks', () => {
  for (const cmd of [
    'git branch -D foo',
    'git branch test/x main',
    'git status && git push',
    'git diff --output=x.txt',
    'git log > out.txt',
    'git -c core.pager=evil log',
    'git cherry-pick abc',
    'git show HEAD; rm -rf x',
    'git stash drop',
    'git log $(rm -rf x)',
    '',
  ]) assert.ok(!isReadOnlyCommand(cmd), cmd);
});
