// Pure helpers shared by the UI (no DOM, no app state), so they can be unit tested.
// Loaded as a plain script before the UI scripts (core.js … app.js); also exported for Node when 'module' exists.
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const norm = (p) => p.toLowerCase().replace(/[\\/]+$/, '');

const samePath = (a, b) => !!a && !!b && norm(a) === norm(b);

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function timeAgo(unixSec) {
  const s = Math.max(0, Date.now() / 1000 - unixSec);
  const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [86400 * 30, 'day', 86400], [86400 * 365, 'month', 86400 * 30], [Infinity, 'year', 86400 * 365]];
  for (const [limit, unit, div] of steps) {
    if (s < limit) { const n = Math.floor(s / div); return n <= 0 || unit === 'second' ? 'just now' : `${plural(n, unit)} ago`; }
  }
  return '';
}

function parseConflicts(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const segs = [];
  let cur = { type: 'text', lines: [] };
  let mode = 'text';
  for (const line of text.split(/\r?\n/)) {
    if (mode === 'text' && line.startsWith('<<<<<<<')) {
      segs.push(cur);
      cur = { type: 'conflict', ours: [], base: [], theirs: [], markers: { start: line } };
      mode = 'ours';
    } else if (mode === 'ours' && line.startsWith('|||||||')) { mode = 'base'; cur.markers.base = line; }
    else if ((mode === 'ours' || mode === 'base') && line.startsWith('=======')) { mode = 'theirs'; cur.markers.sep = line; }
    else if (mode === 'theirs' && line.startsWith('>>>>>>>')) {
      cur.markers.end = line;
      segs.push(cur);
      cur = { type: 'text', lines: [] };
      mode = 'text';
    } else if (mode === 'text') cur.lines.push(line);
    else cur[mode].push(line);
  }
  if (mode !== 'text') return null; // unbalanced markers â€” let the user use their editor
  segs.push(cur);
  return { segs, eol, count: segs.filter((s) => s.type === 'conflict').length };
}

function pickLines(seg, choice, custom) {
  switch (choice) {
    case 'ours': return seg.ours;
    case 'theirs': return seg.theirs;
    case 'both': return [...seg.ours, ...seg.theirs];
    case 'both-rev': return [...seg.theirs, ...seg.ours];
    case 'edit': return (custom ?? [...seg.ours, ...seg.theirs].join('\n')).split(/\r?\n/);
    default: return null;
  }
}

// ---------- line diff (Myers) for the side-by-side comparer ----------
function myers(A, B) {
  const N = A.length;
  const M = B.length;
  const allChanged = () => [...A.map((_, i) => ['-', i, null]), ...B.map((_, j) => ['+', null, j])];
  if (!N || !M) return allChanged();
  const max = N + M;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  const limit = Math.max(50, Math.floor(2e7 / v.length)); // keep memory bounded on huge, very different files
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    if (d > limit) return allChanged();
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { done = true; break; }
    }
  }
  const res = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { res.push(['=', x - 1, y - 1]); x--; y--; }
    if (d > 0) res.push(x === prevX ? ['+', null, y - 1] : ['-', x - 1, null]);
    x = prevX;
    y = prevY;
  }
  return res.reverse();
}

function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length;
  let eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const out = [];
  for (let i = 0; i < pre; i++) out.push(['=', i, i]);
  for (const [op, i, j] of myers(a.slice(pre, ea), b.slice(pre, eb))) out.push([op, i == null ? null : i + pre, j == null ? null : j + pre]);
  for (let i = ea, j = eb; i < a.length; i++, j++) out.push(['=', i, j]);
  return out;
}

// Pairs up removed/added lines so changed lines sit next to each other.
function sideBySide(a, b) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const li = dels[k] ?? null;
      const ri = adds[k] ?? null;
      rows.push({ kind: li != null && ri != null ? 'chg' : li != null ? 'del' : 'add', li, ri, l: li != null ? a[li] : null, r: ri != null ? b[ri] : null });
    }
    dels = [];
    adds = [];
  };
  for (const [op, i, j] of diffLines(a, b)) {
    if (op === '=') { flush(); rows.push({ kind: 'same', li: i, ri: j, l: a[i], r: b[j] }); }
    else if (op === '-') dels.push(i);
    else adds.push(j);
  }
  flush();
  return rows;
}

function inlineDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mark = (x) => `${esc(x.slice(0, p))}<mark>${esc(x.slice(p, x.length - s))}</mark>${esc(x.slice(x.length - s))}`;
  return [mark(a), mark(b)];
}

const toLines = (text) => { const l = text.split(/\r?\n/); if (l[l.length - 1] === '') l.pop(); return l; };

// Small, safe markdown: code blocks, inline code, bold, headings, lists, links shown as text.
function md(text) {
  const out = [];
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) { out.push(`<pre class="cp-code">${esc(part.replace(/\n$/, ''))}</pre>`); return; }
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    let list = null;
    const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${x}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of part.split('\n')) {
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
        list.items.push(inline((ul || ol)[1]));
      } else {
        flush();
        if (h) out.push(`<div class="cp-h">${inline(h[1])}</div>`);
        else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
      }
    }
    flush();
  });
  return out.join('');
}

// ---------- syntax highlighting (small, regex-based) ----------
const LANG_BY_EXT = {
  js: 'c', jsx: 'c', ts: 'c', tsx: 'c', mjs: 'c', cjs: 'c', cs: 'c', java: 'c', kt: 'c', go: 'c', rs: 'c', c: 'c', h: 'c', cpp: 'c', hpp: 'c',
  swift: 'c', php: 'c', scala: 'c', dart: 'c', css: 'css', scss: 'css', less: 'css', json: 'json', py: 'hash', rb: 'hash', sh: 'hash',
  bash: 'hash', ps1: 'hash', psm1: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', dockerfile: 'hash', r: 'hash',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', xaml: 'markup', csproj: 'markup', config: 'markup', razor: 'markup', cshtml: 'markup',
  sql: 'sql', md: null,
};
const KEYWORDS = new Set(('abstract async await break case catch class const continue default def defer delete do elif else enum export extends false final finally fn for foreach from func function get go if impl import in instanceof interface internal is let lambda match module mut namespace new nil none null override package pass private protected pub public raise readonly return select self set static struct super switch then this throw throws trait true try type typeof undefined unless until use using var void when where while with yield '
  + 'and as begin by create delete desc distinct drop end exists from group having insert into join left limit not on or order right table union update values view').split(' '));
const LANG_RE = {
  c: /(\/\/.*$|\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.xXa-fA-F]*\b)|(\b[A-Za-z_$][\w$]*\b)/g,
  hash: /(#.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_.]*\b)|(\b[A-Za-z_][\w-]*\b)/g,
  css: /(\/\*.*?(?:\*\/|$))|("[^"]*"?|'[^']*'?)|(#[0-9a-fA-F]{3,8}\b|\b\d[\d.]*(?:px|em|rem|%|s|ms|vh|vw|deg)?\b)|([\w-]+(?=\s*:))/g,
  json: /()("(?:[^"\\]|\\.)*"?)|(-?\b\d[\d.eE+-]*\b)|(\b(?:true|false|null)\b)/g,
  sql: /(--.*$)|('(?:[^']|'')*'?)|(\b\d[\d.]*\b)|(\b[A-Za-z_]\w*\b)/gi,
  markup: /(<!--.*?(?:-->|$))|("[^"]*"?|'[^']*'?)|()(<\/?[\w:.-]+|\/?>)/g,
};

function langOf(file) {
  const name = String(file || '').split(/[\\/]/).pop().toLowerCase();
  if (name === 'dockerfile') return 'hash';
  return LANG_BY_EXT[name.includes('.') ? name.split('.').pop() : ''] || null;
}

// Splits a line into [{ t: text, c: class|null }] covering the whole line.
function tokenize(line, lang) {
  const re = LANG_RE[lang];
  if (!re) return [{ t: line, c: null }];
  re.lastIndex = 0;
  const out = [];
  let pos = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (m.index > pos) out.push({ t: line.slice(pos, m.index), c: null });
    let c = m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'num' : null;
    if (!c && m[4]) {
      if (lang === 'json') c = 'kw';
      else if (lang === 'css') c = 'prop';
      else if (lang === 'markup') c = 'tag';
      else if (KEYWORDS.has(lang === 'sql' ? m[4].toLowerCase() : m[4])) c = 'kw';
    }
    out.push({ t: m[0], c });
    pos = m.index + m[0].length;
  }
  if (pos < line.length) out.push({ t: line.slice(pos), c: null });
  return out;
}

// HTML for one line: syntax colours, plus <mark> around the [start, end) range that changed.
function highlight(text, lang, mark) {
  let html = '';
  let pos = 0;
  for (const s of tokenize(text, lang)) {
    const start = pos;
    const end = pos + s.t.length;
    pos = end;
    const pieces = mark && mark[1] > mark[0] && mark[0] < end && mark[1] > start
      ? [[s.t.slice(0, Math.max(start, mark[0]) - start), false], [s.t.slice(Math.max(start, mark[0]) - start, Math.min(end, mark[1]) - start), true], [s.t.slice(Math.min(end, mark[1]) - start), false]]
      : [[s.t, false]];
    for (const [t, m] of pieces) {
      if (!t) continue;
      let h = esc(t);
      if (s.c) h = `<span class="hl-${s.c}">${h}</span>`;
      if (m) h = `<mark>${h}</mark>`;
      html += h;
    }
  }
  return html;
}

// The part of a changed line that differs: common prefix/suffix are left unmarked.
function changeRange(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

// ---------- unified diff parsing ----------
// -> [{ name, notes: [], hunks: [{ ctx, rows: [{ kind: 'ctx'|'add'|'del', o, n, text }] }] }]
function parseUnified(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let inHeader = false;
  let o = 0;
  let n = 0;
  const ensureFile = () => { if (!file) { file = { name: '', notes: [], hunks: [] }; files.push(file); } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.*)$/);
      file = { name: m ? m[1] : line, notes: [], hunks: [] };
      files.push(file);
      hunk = null;
      inHeader = true;
      continue;
    }
    if (inHeader && !line.startsWith('@@')) {
      if (line.startsWith('Binary files')) file.notes.push('Binary file changed');
      else if (line.startsWith('rename from ')) file.notes.push(`Renamed from ${line.slice(12)}`);
      else if (line.startsWith('new file mode')) file.notes.push('New file');
      else if (line.startsWith('deleted file mode')) file.notes.push('File deleted');
      continue;
    }
    if (line.startsWith('@@')) {
      ensureFile();
      inHeader = false;
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (m) { o = +m[1]; n = +m[2]; }
      hunk = { ctx: line.replace(/^@@[^@]*@@ ?/, ''), rows: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) hunk.rows.push({ kind: 'add', o: null, n: n++, text: line.slice(1) });
    else if (line.startsWith('-')) hunk.rows.push({ kind: 'del', o: o++, n: null, text: line.slice(1) });
    else if (line !== '') hunk.rows.push({ kind: 'ctx', o: o++, n: n++, text: line.slice(1) });
  }
  return files;
}

// Groups a hunk's rows so each run of removed lines is paired with the added lines that replace it.
// -> [{ kind: 'ctx', row } | { kind: 'change', dels: [], adds: [] }]
function pairHunk(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.kind === 'ctx') { cur = null; out.push({ kind: 'ctx', row: r }); continue; }
    if (!cur || (r.kind === 'del' && cur.adds.length)) { cur = { kind: 'change', dels: [], adds: [] }; out.push(cur); }
    (r.kind === 'del' ? cur.dels : cur.adds).push(r);
  }
  return out;
}

// ---------- committing some lines of a file ----------
// Names the changed lines of a diff, in order: the line's text plus how many identical changed
// lines came before it. Unlike a line number, the key survives edits elsewhere in the file.
function lineKeyer() {
  const seen = new Map();
  return (kind, text) => {
    const k = (kind === 'add' ? '+' : '-') + text;
    const i = seen.get(k) || 0;
    seen.set(k, i + 1);
    return `${k}#${i}`;
  };
}

// Every changed line of a diff: [{ kind: 'add'|'del', text, key }].
function changedLines(diffText) {
  const key = lineKeyer();
  return parseUnified(diffText).flatMap((f) => f.hunks.flatMap((h) => h.rows))
    .filter((r) => r.kind !== 'ctx').map((r) => ({ kind: r.kind, text: r.text, key: key(r.kind, r.text) }));
}

// A patch holding only some of a file's changed lines, for `git apply --cached`.
// `excluded` lists line keys (see lineKeyer) to leave out: a left-out removal stays as
// context and a left-out addition is dropped. Returns null when no change is left.
function partialPatch(diffText, excluded) {
  const skip = new Set(excluded);
  const key = lineKeyer();
  const lines = String(diffText || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let hunk = null;
  let delta = 0; // how far new-side line numbers have moved from the hunks written so far
  let any = false;
  let kept = true;
  const flush = () => {
    if (!hunk || !hunk.changed) { hunk = null; return; }
    const oldFirst = hunk.oldCount ? hunk.oldStart : hunk.oldStart + 1;
    const newStart = oldFirst + delta - (hunk.newCount ? 0 : 1);
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${newStart},${hunk.newCount} @@${hunk.ctx}`, ...hunk.body);
    delta += hunk.newCount - hunk.oldCount;
    any = true;
    hunk = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      flush();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (!m) return null;
      hunk ={ oldStart: +m[1], ctx: m[4], oldCount: 0, newCount: 0, body: [], changed: false };
      continue;
    }
    if (!hunk) { out.push(raw); continue; } // file header (diff --git, index, ---, +++)
    if (line.startsWith('\\')) { if (kept) hunk.body.push(raw); continue; }
    const text = line.slice(1);
    if (line.startsWith('+')) {
      kept = !skip.has(key('add', text));
      if (kept) { hunk.body.push(raw); hunk.newCount++; hunk.changed = true; }
    } else if (line.startsWith('-')) {
      const leave = skip.has(key('del', text));
      kept = true;
      hunk.body.push(leave ? ' ' + raw.slice(1) : raw);
      hunk.oldCount++;
      if (leave) hunk.newCount++; else hunk.changed = true;
    } else {
      kept = true;
      hunk.body.push(raw);
      hunk.oldCount++;
      hunk.newCount++;
    }
  }
  flush();
  return any ? out.join('\n') + '\n' : null;
}

// ---------- Azure Boards work items ----------
// The work item number in a branch name, as in feature/1234-login, bug/1234 or users/me/1234_fix.
// Version-like branches (release/2.4, release/2024) are not work items.
function workItemFromBranch(branch) {
  if (!branch || /^(release|hotfix|support)\//i.test(branch)) return null;
  const m = branch.match(/(?:^|[/_-])(\d{2,7})(?=[/_-]|$)/);
  return m ? m[1] : null;
}

// ---------- console output ----------
// Adds a chunk of program output to buf = { lines: [''], cr: false, dropped: 0 } (the last line may be
// unfinished). A \r on its own starts the line over, the way progress counters ("Receiving 45%")
// expect. Keeps at most `max` lines, counting the ones dropped from the top.
function feedOutput(buf, chunk, max = 5000) {
  for (const part of String(chunk).split(/(\r\n|\n|\r)/)) {
    if (part === '\n' || part === '\r\n') { buf.lines.push(''); buf.cr = false; }
    else if (part === '\r') buf.cr = true;
    else if (part) {
      const i = buf.lines.length - 1;
      buf.lines[i] = buf.cr ? part : buf.lines[i] + part;
      buf.cr = false;
    }
  }
  if (buf.lines.length > max) {
    const n = buf.lines.length - max;
    buf.lines.splice(0, n);
    buf.dropped = (buf.dropped || 0) + n;
  }
  return buf;
}

// Terminal colours (ANSI "SGR" codes, which git uses with color.ui=always) to HTML spans with
// classes ansi-fg0…15 and ansi-b (bold) / ansi-d (dim). Other escape codes are dropped.
function ansiToHtml(text) {
  let out = '';
  let fg = null;
  let bold = false;
  let dim = false;
  const re = /\x1b\[([\d;]*)([A-Za-z])|\x1b[()][A-Z0-9]|\x1b./g;
  let last = 0;
  const flush = (s) => {
    if (!s) return;
    const cls = [fg != null ? `ansi-fg${fg}` : '', bold ? 'ansi-b' : '', dim ? 'ansi-d' : ''].filter(Boolean).join(' ');
    out += cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map((n) => Number(n || 0));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = null; bold = false; dim = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c >= 30 && c <= 37) fg = c - 30;
      else if (c >= 90 && c <= 97) fg = c - 90 + 8;
      else if (c === 39) fg = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // 256-colour / RGB: skip
    }
  }
  flush(text.slice(last));
  return out;
}

// git's reflog lines ("checkout: moving from a to b") in plain English.
function reflogText(action) {
  const a = String(action || '');
  const rules = [
    [/^commit \(initial\): (.*)/, (m) => `First commit “${m[1]}”`],
    [/^commit \(amend\): (.*)/, (m) => `Changed the last commit “${m[1]}”`],
    [/^commit \(merge\): (.*)/, (m) => `Finished a merge “${m[1]}”`],
    [/^commit: (.*)/, (m) => `Committed “${m[1]}”`],
    [/^checkout: moving from (\S+) to (\S+)/, (m) => (m[1] === m[2] ? `Switched to ${m[2]}` : `Switched from ${m[1]} to ${m[2]}`)],
    [/^reset: moving to (.*)/, (m) => `Moved the branch to ${m[1]} (reset / undo)`],
    [/^merge (\S+): Fast-forward/, (m) => `Brought in ${m[1]} (fast-forward)`],
    [/^merge (\S+): (.*)/, (m) => `Merged ${m[1]}`],
    [/^pull\b[^:]*: Fast-forward/, () => 'Got latest from the server'],
    [/^pull\b[^:]*: (.*)/, (m) => `Got latest from the server (${m[1]})`],
    [/^rebase(?: -i)? \(finish\): returning to refs\/heads\/(.*)/, (m) => `Finished replaying ${m[1]} (rebase)`],
    [/^rebase(?: -i)? \(finish\)/, () => 'Finished a rebase'],
    [/^rebase(?: -i)? \(start\)/, () => 'Started a rebase'],
    [/^rebase(?: -i)? \(abort\)/, () => 'Cancelled a rebase'],
    [/^rebase(?: -i)? \((?:pick|reword|edit|squash|fixup)\): (.*)/, (m) => `Replayed “${m[1]}” (rebase)`],
    [/^cherry-pick: (.*)/, (m) => `Copied “${m[1]}” (cherry-pick)`],
    [/^revert: (.*)/, (m) => `Reversed a commit: “${m[1]}”`],
    [/^clone: /, () => 'Downloaded the repo (clone)'],
    [/^branch: (.*)/, (m) => `Branch: ${m[1]}`],
  ];
  for (const [re, fn] of rules) { const m = a.match(re); if (m) return fn(m); }
  return a;
}

// A pull request title from a branch name: "feature/1234-login-page" -> "Login page".
function prTitleFromBranch(branch) {
  const words = String(branch || '').split('/').pop().replace(/^\d+(?=[-_])/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(branch || '');
}

// A pull request's starting title and description from its commits (newest first, as git log gives them).
function prDraft(branch, commits) {
  const subjects = (commits || []).map((c) => c.subject).filter((s) => !/^Merge (branch|remote-tracking branch|pull request) /.test(s)).reverse();
  if (subjects.length === 1) return { title: subjects[0], description: '' };
  return { title: prTitleFromBranch(branch), description: subjects.map((s) => `- ${s}`).join('\n') };
}

// Adds "AB#1234" (which Azure DevOps turns into a link to the work item) to a commit message,
// unless it already mentions it.
function withWorkItem(message, id) {
  const n = String(id || '').replace(/^AB#/i, '').trim();
  if (!/^\d+$/.test(n) || new RegExp(`AB#${n}\\b`, 'i').test(message)) return message;
  return `${message}${message.includes('\n') ? '\n' : '\n\n'}AB#${n}`;
}

// ---------- commit graph ----------
// For each commit (newest first), which lane it sits in and how lanes connect to the rows around it.
function graphRows(commits) {
  let lanes = [];
  const rows = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const hasChild = col >= 0;
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; }
    const before = lanes.slice();
    const merging = [];
    before.forEach((h, i) => { if (h === c.hash && i !== col) merging.push(i); });
    const after = lanes.slice();
    merging.forEach((i) => { after[i] = null; });
    after[col] = c.parents[0] || null;
    const parentCols = c.parents[0] ? [col] : [];
    for (const p of c.parents.slice(1)) {
      let pc = after.indexOf(p);
      if (pc < 0) { pc = after.indexOf(null); if (pc < 0) pc = after.length; after[pc] = p; }
      parentCols.push(pc);
    }
    while (after.length && after[after.length - 1] == null) after.pop();
    rows.push({ col, hasChild, before, after, merging, parentCols });
    lanes = after;
  }
  return rows;
}

// ---------- fuzzy search (command palette) ----------
// Higher is better; -1 = no match. Prefers whole-substring and word-start matches.
function fuzzyScore(query, text) {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  const i = t.indexOf(q);
  if (i >= 0) return 1000 - i + (i === 0 || /[\s/\\._-]/.test(t[i - 1]) ? 200 : 0);
  let score = 0;
  let pos = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const j = t.indexOf(ch, pos);
    if (j < 0) return -1;
    score += j === pos ? 5 : 1;
    pos = j + 1;
  }
  return score;
}

// Moves a repo from one workspace to another (with `copy`, adds it and leaves it where it was too).
// Changes the workspaces in place. Returns false if nothing changed.
function moveRepo(workspaces, repo, fromId, toId, copy = false) {
  const from = workspaces.find((w) => w.id === fromId);
  const to = workspaces.find((w) => w.id === toId);
  if (!to || fromId === toId) return false;
  const added = !to.repos.some((p) => samePath(p, repo));
  if (added) to.repos.push(repo);
  const removed = !copy && !!from?.repos.some((p) => samePath(p, repo));
  if (removed) from.repos = from.repos.filter((p) => !samePath(p, repo));
  return added || removed;
}

if (typeof module !== 'undefined') {
  module.exports = { esc, basename, norm, samePath, plural, timeAgo, parseConflicts, pickLines, myers, diffLines, sideBySide, inlineDiff, toLines, md,
    langOf, tokenize, highlight, changeRange, parseUnified, pairHunk, lineKeyer, changedLines, partialPatch, workItemFromBranch, withWorkItem, feedOutput, ansiToHtml, reflogText, prTitleFromBranch, prDraft, graphRows, fuzzyScore, moveRepo };
}
