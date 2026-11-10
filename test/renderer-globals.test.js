// The UI scripts share one global scope, so two top-level functions or constants with the same name
// don't fail: the later one silently replaces the earlier one. (That broke the step-by-step conflict
// view once, when a line-picking pickLines replaced the conflict one in lib.js.) This keeps names unique.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'renderer');

test('every top-level name in the UI scripts is declared once', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 5, 'found the scripts in index.html');
  const seen = new Map();
  const clashes = [];
  for (const file of scripts) {
    fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/^(?:async\s+)?function\s*\*?\s*([\w$]+)|^(?:const|let|var|class)\s+([\w$]+)/);
      if (!m) return;
      const name = m[1] || m[2];
      if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${file}:${i + 1}`);
      else seen.set(name, `${file}:${i + 1}`);
    });
  }
  assert.deepEqual(clashes, []);
});
