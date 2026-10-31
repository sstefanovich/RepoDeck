// Runs the Claude Code CLI (`claude`) headless for the chat panel. One long-lived
// process per conversation: user messages go in on stdin and events stream out on
// stdout (stream-json). Permission prompts come to us as `can_use_tool` control
// requests, so every change-making command is approved in RepoDeck's UI.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Allowed without asking: reading files and read-only git commands.
const READ_ONLY_GIT = ['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'for-each-ref', 'branch --list', 'branch -a',
  'branch -v', 'branch -vv', 'branch -r', 'remote -v', 'stash list', 'stash show', 'merge-base', 'blame', 'shortlog', 'describe', 'fetch'];
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', ...READ_ONLY_GIT.flatMap((c) => [`Bash(git ${c}:*)`, `PowerShell(git ${c}:*)`])];

// True when a shell command is only read-only git commands (optionally chained with
// ; && || or piped), e.g. `git -C "C:\repo" branch --list x && git rev-parse HEAD`.
// Anything that could write (redirection, --output, -c config, subshells) is not.
const READ_ONLY_RE = new RegExp(`^git(\\s+-C\\s+("[^"]*"|'[^']*'|\\S+))?\\s+(${READ_ONLY_GIT.map((c) => c.replace(/ /g, '\\s+')).join('|')})(\\s|$)`);
function isReadOnlyCommand(cmd) {
  if (!cmd || /[<>`]|\$\(|--output|--exec|(^|\s)-c\s/.test(cmd)) return false;
  return cmd.split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/).filter(Boolean).every((part) => READ_ONLY_RE.test(part.trim()) || /^(echo|cat|head|tail|wc|sort|Select-Object|Measure-Object|Out-String)(\s|$)/.test(part.trim()));
}

const systemPrompt = (repos) => `You are the assistant built into RepoDeck, a desktop git app, and you help the user with their git repos and branches.
The user may be new to git: explain in plain English, keep replies short, and mention the git commands you run.
The repos you can work in: ${repos.map((r) => `${path.basename(r)} (${r})`).join(', ')}.
Each user message starts with a <repodeck-context> block saying which repo the user is looking at. Work in that repo unless they say otherwise (use git -C <path> for the others).
Every command that changes something is shown to the user in RepoDeck as an approval card before it runs, so don't ask "shall I go ahead?" in chat — make the tool call and they will approve or deny it. If they deny it, don't retry it; ask what they would like instead.
Before anything that can lose work (force push, reset --hard, clean, deleting unmerged branches, rewriting pushed history), say plainly what would be lost.
Never use interactive git commands or anything that opens an editor (rebase -i, add -i/-p, commit without -m); use --no-edit where needed.
If a merge, pull or cherry-pick stops with conflicts, tell the user which files clash: RepoDeck's Conflicts tab can resolve them, or you can if they ask.`;

// Finds claude.exe: a configured path, then PATH, then the usual install places.
function findClaude(configured) {
  return new Promise((resolve) => {
    if (configured && fs.existsSync(configured)) return resolve(configured);
    execFile('where.exe', ['claude'], { windowsHide: true }, (err, stdout) => {
      const fromPath = !err && stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => /\.(exe|cmd)$/i.test(s));
      if (fromPath) return resolve(fromPath);
      const home = os.homedir();
      const candidates = [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
      ];
      for (const dir of ['.vscode', '.cursor'].map((d) => path.join(home, d, 'extensions'))) {
        try {
          for (const ext of fs.readdirSync(dir).filter((n) => n.startsWith('anthropic.claude-code')).sort().reverse()) {
            candidates.push(path.join(dir, ext, 'resources', 'native-binary', 'claude.exe'));
          }
        } catch {}
      }
      resolve(candidates.find((c) => fs.existsSync(c)) || null);
    });
  });
}

class ClaudeSession {
  constructor({ exe, cwd, repos, model, resumeId, send }) {
    this.exe = exe;
    this.resumeId = resumeId;
    this.cwd = cwd;
    this.repos = repos;
    this.model = model;
    this.send = send;
    this.child = null;
    this.buf = '';
    this.stderr = '';
    this.reqId = 0;
  }

  start() {
    const env = cleanEnv();
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'manual', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--strict-mcp-config',
      '--append-system-prompt', systemPrompt(this.repos),
      ...this.repos.filter((r) => r.toLowerCase() !== this.cwd.toLowerCase()).flatMap((r) => ['--add-dir', r]),
      ...(this.model ? ['--model', this.model] : []),
      ...(this.resumeId ? ['--resume', this.resumeId] : []),
      '--allowedTools', ...ALLOWED_TOOLS,
    ];
    // .cmd launchers (npm installs) need a shell; the native .exe doesn't.
    const viaShell = /\.cmd$/i.test(this.exe);
    this.child = spawn(viaShell ? `"${this.exe}"` : this.exe, viaShell ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args,
      { cwd: this.cwd, env, windowsHide: true, shell: viaShell });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.child.on('error', (e) => this.send({ type: 'exit', code: -1, message: e.message }));
    this.child.on('exit', (code) => {
      this.child = null;
      this.send({ type: 'exit', code, message: code ? this.stderr.trim() : '' });
    });
    this.write({ type: 'control_request', request_id: `init-${++this.reqId}`, request: { subtype: 'initialize' } });
  }

  get alive() { return !!this.child; }

  write(obj) { if (this.child) this.child.stdin.write(JSON.stringify(obj) + '\n'); }

  sendUser(text) { this.write({ type: 'user', message: { role: 'user', content: text } }); }

  answerPermission(requestId, allow, input) {
    const response = allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user declined this in RepoDeck.' };
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  // Ask Claude to stop the current turn; kill the process if it doesn't.
  interrupt() {
    if (!this.child) return;
    this.write({ type: 'control_request', request_id: `int-${++this.reqId}`, request: { subtype: 'interrupt' } });
    const child = this.child;
    this.interruptTimer = setTimeout(() => { if (this.child === child) child.kill(); }, 6000);
  }

  stop() { if (this.child) { this.child.stdin.end(); this.child.kill(); this.child = null; } }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      this.handle(m);
    }
  }

  handle(m) {
    const sub = !!m.parent_tool_use_id; // from a subagent
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.send({ type: 'init', sessionId: m.session_id, model: m.model });
        break;
      case 'stream_event': {
        const ev = m.event;
        if (sub || !ev) break;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') this.send({ type: 'text_start' });
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.send({ type: 'text', delta: ev.delta.text });
        break;
      }
      case 'assistant':
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') this.send({ type: 'tool', id: b.id, name: b.name, input: b.input, sub });
        }
        break;
      case 'user':
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (b.type !== 'tool_result') continue;
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
          this.send({ type: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, preview: text.slice(0, 1500) });
        }
        break;
      case 'control_request':
        if (m.request?.subtype === 'can_use_tool') {
          const r = m.request;
          if ((r.tool_name === 'Bash' || r.tool_name === 'PowerShell') && isReadOnlyCommand(r.input?.command)) {
            this.answerPermission(m.request_id, true, r.input);
            break;
          }
          this.send({ type: 'permission', requestId: m.request_id, toolUseId: r.tool_use_id, tool: r.tool_name, input: r.input, description: r.description || '' });
        }
        break;
      case 'result':
        clearTimeout(this.interruptTimer);
        this.send({ type: 'result', isError: !!m.is_error, subtype: m.subtype, cost: m.total_cost_usd, durationMs: m.duration_ms, text: m.is_error ? m.result : '' });
        break;
      case 'rate_limit_event':
        if (m.rate_limit_info?.status && m.rate_limit_info.status !== 'allowed') this.send({ type: 'notice', text: `Claude usage limit reached (${m.rate_limit_info.rateLimitType || 'limit'}).` });
        break;
      default:
        break;
    }
  }
}

const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return env;
};

// A single question with no tools (e.g. "write a commit message for this diff"). Resolves to Claude's text.
function oneShot({ exe, cwd, prompt, model }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--permission-mode', 'manual', '--permission-prompts', 'none',
      ...(model ? ['--model', model] : []),
      '--disallowedTools', 'Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Read', 'Glob', 'Grep'];
    const viaShell = /\.cmd$/i.test(exe);
    const child = spawn(viaShell ? `"${exe}"` : exe, viaShell ? args.map((a) => `"${a}"`) : args, { cwd, env: cleanEnv(), windowsHide: true, shell: viaShell });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude took too long to answer.')); }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out.trim().split(/\r?\n/).pop());
        if (r.is_error) reject(new Error(r.result || 'Claude could not answer.'));
        else resolve(String(r.result || '').trim());
      } catch { reject(new Error((err || out || 'No answer from Claude.').trim().slice(0, 500))); }
    });
    child.stdin.end(prompt);
  });
}

module.exports = { ClaudeSession, findClaude, isReadOnlyCommand, oneShot };
