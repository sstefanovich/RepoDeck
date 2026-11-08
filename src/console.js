// The console: git (and shell) commands typed by the user, run in a repo folder with the output
// streamed back. Runs in the main process. There is no real terminal behind it, so commands that
// need one (an editor, interactive prompts) are recognised up front and explained instead of hanging.
const { spawn, execFile } = require('child_process');

// Splits a command line like a shell would: spaces separate, "double" and 'single' quotes group,
// and \" inside double quotes is a quote.
function splitArgs(line) {
  const args = [];
  let cur = '';
  let has = false;
  let quote = null;
  const s = String(line || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\s/.test(c)) { if (has || cur) args.push(cur); cur = ''; has = false; }
    else cur += c;
  }
  if (has || cur) args.push(cur);
  return args;
}

// git's global options that come before the command (git -C dir -c x=y status).
function gitCommand(args) {
  let i = 1;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  return { cmd: args[i] || '', rest: args.slice(i + 1) };
}

const has = (rest, ...flags) => rest.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)));
// Short flags can be bundled: -pm, -fd.
const hasShort = (rest, letter) => rest.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
const stdinOrMessage = (rest) => has(rest, '-m', '--message', '-F', '--file', '-C', '--reuse-message', '--no-edit', '--fixup', '--squash') || rest.some((a) => /^-[a-zA-Z]*m/.test(a));

// Commands that need a real terminal: [test(cmd, rest), why, what to do instead].
const INTERACTIVE = [
  [(c, r) => ['add', 'checkout', 'reset', 'restore', 'stash', 'commit'].includes(c) && (has(r, '-p', '--patch') || hasShort(r, 'p') && c !== 'stash' && c !== 'commit'),
    'picks changes piece by piece, asking a question for each one', 'In RepoDeck, untick single lines or blocks in the Changes tab instead.'],
  [(c, r) => (c === 'add' || c === 'commit') && has(r, '-i', '--interactive'), 'asks questions as it goes', 'Tick the files you want in the Changes tab instead.'],
  [(c, r) => c === 'rebase' && (has(r, '-i', '--interactive') || hasShort(r, 'i')), 'opens an editor with the list of commits',
    'Use History → Tidy unsent commits to combine, reword or drop commits.'],
  [(c, r) => c === 'commit' && !stdinOrMessage(r), 'opens an editor for the message', 'Add a message: git commit -m "What changed"'],
  [(c, r) => c === 'tag' && has(r, '-a', '--annotate', '-s', '--sign') && !has(r, '-m', '--message', '-F', '--file'), 'opens an editor for the message', 'Add a message: git tag -a v1.0 -m "Release 1.0"'],
  [(c) => c === 'mergetool' || c === 'difftool', 'starts a separate tool and waits for it', 'Use the Conflicts tab, or Open in VS Code there.'],
  [(c, r) => c === 'config' && has(r, '-e', '--edit'), 'opens an editor', 'Set a value instead: git config user.name "Your Name"'],
  [(c, r) => c === 'notes' && ['add', 'edit', 'append'].includes(r[0]) && !has(r, '-m', '-F'), 'opens an editor', 'Add a message with -m "…"'],
];

// Commands that can throw work away or rewrite what others have: confirmed before they run.
const RISKY_GIT = [
  [(c, r) => c === 'push' && (has(r, '--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror') || hasShort(r, 'f') || r.some((a) => /^\+/.test(a))), 'Force-pushing replaces the branch on the server, which can throw away commits other people sent.'],
  [(c, r) => c === 'push' && (has(r, '--delete', '-d') || r.some((a) => /^:./.test(a))), 'This deletes something on the server.'],
  [(c, r) => c === 'reset' && has(r, '--hard'), 'reset --hard throws away all uncommitted changes. They are not put on the Shelf.'],
  [(c, r) => c === 'clean' && (has(r, '-f', '--force') || hasShort(r, 'f')), 'clean -f deletes files git doesn\'t track. They don\'t go to the Recycle Bin.'],
  [(c, r) => c === 'checkout' && (r.includes('--') || r.includes('.')) && !has(r, '-b', '-B'), 'This puts files back to their last commit, throwing away your uncommitted changes to them.'],
  [(c, r) => c === 'restore' && !has(r, '--staged', '-S') && r.some((a) => !a.startsWith('-')), 'restore throws away uncommitted changes to these files.'],
  [(c, r) => c === 'branch' && (has(r, '-D') || (has(r, '--delete', '-d') && has(r, '--force', '-f'))), 'branch -D deletes the branch even if its commits are nowhere else.'],
  [(c, r) => c === 'stash' && ['drop', 'clear'].includes(r[0]), 'This deletes Shelf items for good.'],
  [(c) => ['filter-branch', 'filter-repo'].includes(c), 'This rewrites the whole history of the repo.'],
  [(c, r) => c === 'reflog' && ['expire', 'delete'].includes(r[0]), 'This deletes the record git uses to recover lost work.'],
  [(c, r) => c === 'gc' && r.some((a) => /^--prune(=now)?$/.test(a)), 'This deletes lost commits that could otherwise still be recovered.'],
  [(c, r) => c === 'update-ref' && has(r, '-d'), 'This deletes a branch or other reference directly.'],
];
const RISKY_SHELL = [
  [/\b(rm|rmdir|rd|del|erase|Remove-Item|ri)\b/i, 'This deletes files or folders.'],
  [/\b(format|Format-Volume)\b/i, 'This can wipe a drive.'],
];

// What a typed line is, before running it. -> { kind: 'git'|'shell'|'empty', cmd, blocked, hint, risky }
function check(line) {
  const text = String(line || '').trim();
  if (!text) return { kind: 'empty' };
  const args = splitArgs(text);
  if (args[0]?.toLowerCase() === 'git' && !/[|&;<>`$]/.test(text.replace(/"[^"]*"|'[^']*'/g, ''))) {
    const { cmd, rest } = gitCommand(args);
    const block = INTERACTIVE.find(([t]) => t(cmd, rest));
    const risky = RISKY_GIT.find(([t]) => t(cmd, rest));
    return { kind: 'git', cmd, blocked: block ? `git ${cmd} ${block[1]}, which needs a full terminal.` : null, hint: block?.[2] || null, risky: risky?.[1] || null };
  }
  // Anything else (or a git line with pipes or redirects) goes to PowerShell.
  const risky = RISKY_SHELL.find(([re]) => re.test(text));
  const interactive = /^\s*(vim?|nano|notepad|code\s+--wait|ssh|less|more|python|node|pwsh|powershell|cmd)\s*$/i.test(text);
  return { kind: 'shell', cmd: args[0], blocked: interactive ? `${args[0]} waits for you to type into it, which needs a full terminal.` : null, hint: interactive ? 'Use Open in Windows Terminal for that.' : null, risky: risky?.[1] || null };
}

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',   // no username/password prompts (Git Credential Manager's window still works)
  GIT_EDITOR: 'true',         // never open an editor
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',           // print everything instead of paging
  PAGER: 'cat',
  LANGUAGE: 'en',
};

// Runs a line in `cwd`. onData(stream, text) gets the output as it comes; onExit(code, error) once at the end.
function start({ cwd, line, onData, onExit }) {
  const kind = check(line).kind;
  let child;
  try {
    if (kind === 'git') {
      const args = splitArgs(line).slice(1);
      child = spawn('git', ['-c', 'color.ui=always', '-c', 'core.quotepath=false', ...args], { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true });
    } else if (process.platform === 'win32') {
      // UTF-8 out, no progress bars, and git's settings for any git call inside a pipe.
      const prelude = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ";
      child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + line], { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true });
    } else {
      child = spawn(process.env.SHELL || '/bin/sh', ['-c', line], { cwd, env: { ...process.env, ...GIT_ENV } });
    }
  } catch (e) { onExit(-1, e.message); return null; }
  let done = false;
  const finish = (code, err) => { if (!done) { done = true; onExit(code, err); } };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (t) => onData('out', t));
  child.stderr.on('data', (t) => onData('err', t));
  child.on('error', (e) => finish(-1, e.code === 'ENOENT' ? `${kind === 'git' ? 'git' : 'PowerShell'} wasn't found on this computer.` : e.message));
  child.on('close', (code, signal) => finish(code ?? (signal ? -1 : 0)));
  child.stdin.end(); // anything that waits for typed input gets "end of input" instead of hanging
  return child;
}

// Stops a running command and everything it started.
function stop(child) {
  if (!child || child.exitCode !== null) return false;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGINT');
  return true;
}

module.exports = { splitArgs, check, start, stop };
