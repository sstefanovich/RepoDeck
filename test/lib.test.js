// Tests of the pure UI helpers in renderer/lib.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../renderer/lib');

test('line diff pairs changed lines and keeps unchanged ones', () => {
  const rows = lib.sideBySide(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd', 'e']);
  assert.deepEqual(rows.map((r) => r.kind), ['same', 'chg', 'same', 'same', 'add']);
  assert.equal(rows[1].l, 'b');
  assert.equal(rows[1].r, 'B');
  const ops = lib.diffLines(['x', 'y'], ['y']);
  assert.deepEqual(ops, [['-', 0, null], ['=', 1, 0]]);
});

test('a patch of only some lines keeps the rest as context and fixes line numbers', () => {
  const head = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n';
  const diff = `${head}@@ -1,2 +1,3 @@\n a\n+new1\n b\n@@ -9,2 +10,2 @@ ctx\n-old\n+NEW\n z\n`;
  const lines = lib.changedLines(diff);
  const key = (text) => lines.find((r) => r.text === text).key;
  // Leave out the first block: the second hunk moves up by one line.
  assert.equal(lib.partialPatch(diff, [key('new1')]), `${head}@@ -9,2 +9,2 @@ ctx\n-old\n+NEW\n z\n`);
  // Keep the removal but not its replacement.
  assert.equal(lib.partialPatch(diff, [key('new1'), key('NEW')]), `${head}@@ -9,2 +9,1 @@ ctx\n-old\n z\n`);
  // Leave out the removal: the line stays, as context.
  assert.equal(lib.partialPatch(diff, [key('old')]), `${head}@@ -1,2 +1,3 @@\n a\n+new1\n b\n@@ -9,2 +10,3 @@ ctx\n old\n+NEW\n z\n`);
  assert.equal(lib.partialPatch(diff, [key('new1'), key('old'), key('NEW')]), null, 'nothing left to commit');
  // "No newline at end of file" follows its line in or out.
  const nl = `${head}@@ -1,1 +1,2 @@\n a\n+b\n\\ No newline at end of file\n`;
  assert.equal(lib.partialPatch(nl, []), nl);
  // Keys don't depend on line numbers, so an edit higher up doesn't change which line is left out.
  const shifted = `${head}@@ -1,2 +1,4 @@\n a\n+x\n+new1\n b\n@@ -9,2 +12,2 @@ ctx\n-old\n+NEW\n z\n`;
  assert.equal(lib.changedLines(shifted).find((r) => r.text === 'new1').key, key('new1'));
  // Repeated identical lines get their own keys.
  assert.deepEqual(lib.changedLines(`${head}@@ -1,0 +1,2 @@\n+}\n+}\n`).map((r) => r.key), ['+}#0', '+}#1']);
});

test('work items: read from branch names and added to messages once', () => {
  assert.equal(lib.workItemFromBranch('feature/1234-login'), '1234');
  assert.equal(lib.workItemFromBranch('bug/98765'), '98765');
  assert.equal(lib.workItemFromBranch('users/steve/4321_fix-crash'), '4321');
  assert.equal(lib.workItemFromBranch('feature/login-v2'), null, 'v2 is not a work item');
  assert.equal(lib.workItemFromBranch('release/2024'), null);
  assert.equal(lib.workItemFromBranch('main'), null);
  assert.equal(lib.withWorkItem('Fix login', '1234'), 'Fix login\n\nAB#1234');
  assert.equal(lib.withWorkItem('Fix login\n\nDetails here.', 'AB#1234'), 'Fix login\n\nDetails here.\nAB#1234');
  assert.equal(lib.withWorkItem('Fix login AB#1234', '1234'), 'Fix login AB#1234', 'not added twice');
  assert.equal(lib.withWorkItem('Fix login', ''), 'Fix login');
  assert.equal(lib.withWorkItem('Fix login', 'abc'), 'Fix login', 'only numbers');
});

test('conflict parsing round-trips and applies choices', () => {
  const text = 'top\n<<<<<<< HEAD\nmine\n||||||| base\norig\n=======\ntheirs\n>>>>>>> feature\nbottom\n';
  const p = lib.parseConflicts(text);
  assert.equal(p.count, 1);
  const c = p.segs[1];
  assert.deepEqual([c.ours, c.base, c.theirs], [['mine'], ['orig'], ['theirs']]);
  assert.deepEqual(lib.pickLines(c, 'both'), ['mine', 'theirs']);
  assert.deepEqual(lib.pickLines(c, 'theirs'), ['theirs']);
  assert.equal(lib.pickLines(c, undefined), null);
  assert.equal(lib.parseConflicts('a\n<<<<<<< HEAD\nunfinished\n'), null, 'damaged markers are reported, not guessed');
});

test('unified diff parsing tracks line numbers and pairs edits', () => {
  const diff = 'diff --git a/x.js b/x.js\nindex 1..2\n--- a/x.js\n+++ b/x.js\n@@ -1,3 +1,3 @@ fn\n a\n-b\n+B\n c\n';
  const [f] = lib.parseUnified(diff);
  assert.equal(f.name, 'x.js');
  const rows = f.hunks[0].rows;
  assert.deepEqual(rows.map((r) => [r.kind, r.o, r.n]), [['ctx', 1, 1], ['del', 2, null], ['add', null, 2], ['ctx', 3, 3]]);
  const groups = lib.pairHunk(rows);
  assert.equal(groups[1].kind, 'change');
  assert.equal(groups[1].dels.length, 1);
  assert.equal(groups[1].adds.length, 1);
  // a deleted line that itself starts with "--" is not mistaken for a header
  const [g] = lib.parseUnified('@@ -1 +0,0 @@\n--- comment\n');
  assert.equal(g.hunks[0].rows[0].kind, 'del');
});

test('highlighting escapes HTML and marks only the changed part', () => {
  const html = lib.highlight('const s = "<b>"; // hi', 'c');
  assert.ok(!html.includes('<b>'), 'user text is escaped');
  assert.match(html, /hl-kw">const/);
  assert.match(html, /hl-com/);
  const r = lib.changeRange('color: red;', 'color: blue;');
  assert.deepEqual(r.a, [7, 10]);
  assert.match(lib.highlight('color: red;', null, r.a), /<mark>red<\/mark>/);
  assert.equal(lib.langOf('src/App.TSX'), 'c');
  assert.equal(lib.langOf('Dockerfile'), 'hash');
});

test('commit graph lanes for a merge', () => {
  // newest first: M merges B into A; both come from R
  const commits = [
    { hash: 'M', parents: ['A', 'B'] },
    { hash: 'B', parents: ['R'] },
    { hash: 'A', parents: ['R'] },
    { hash: 'R', parents: [] },
  ];
  const g = lib.graphRows(commits);
  assert.equal(g[0].col, 0);
  assert.deepEqual(g[0].parentCols, [0, 1]);
  assert.equal(g[1].col, 1, 'the merged branch gets its own lane');
  assert.equal(g[2].col, 0);
  assert.deepEqual(g[3].merging, [1], 'both lanes join at the common parent');
});

test('fuzzy search ranks whole words first', () => {
  assert.ok(lib.fuzzyScore('lat', 'Get latest') > lib.fuzzyScore('lat', 'Line them all up'));
  assert.equal(lib.fuzzyScore('zz', 'Get latest'), -1);
  assert.ok(lib.fuzzyScore('gl', 'Get latest') > 0);
});

test('markdown is escaped and supports code and lists', () => {
  const html = lib.md('**bold** and `x<y`\n\n- one\n- two\n\n```\n<script>\n```');
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.ok(!html.includes('<script>'));
});

test('repos move or copy between workspaces', () => {
  const [web, api, docs] = ['C:\\src\\web', 'C:\\src\\api', 'C:\\src\\docs'];
  const ws = () => [{ id: 'a', repos: [web, api] }, { id: 'b', repos: [docs] }];
  let w = ws();
  assert.equal(lib.moveRepo(w, web, 'a', 'b'), true);
  assert.deepEqual(w.map((x) => x.repos), [[api], [docs, web]]);
  w = ws();
  assert.equal(lib.moveRepo(w, web, 'a', 'b', true), true, 'copy');
  assert.deepEqual(w.map((x) => x.repos), [[web, api], [docs, web]]);
  assert.equal(lib.moveRepo(w, 'c:\\src\\web\\', 'a', 'b', true), false, 'already there (case and trailing slash ignored)');
  assert.equal(lib.moveRepo(w, web, 'a', 'b'), true, 'moving drops the copy left behind');
  assert.deepEqual(w[0].repos, [api]);
  assert.equal(lib.moveRepo(w, api, 'a', 'a'), false, 'same workspace');
  assert.equal(lib.moveRepo(w, api, 'a', 'nope'), false, 'unknown workspace');
});
