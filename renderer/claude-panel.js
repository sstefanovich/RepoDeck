'use strict';

// The Claude panel, which runs the Claude Code CLI.
// One of several plain scripts sharing the page's global scope; index.html loads them in order.

// ---------- Claude panel (runs the Claude Code CLI) ----------
// Each workspace keeps its own chats (saved between launches); `cl` is the chat on screen.
// chat.items: { kind: 'user' | 'text' | 'tool' | 'notice' | 'done', ... }
const chatStore = { data: {}, timer: 0 };
const newChat = () => ({ id: uid(), created: Date.now(), title: '', items: [], session: null, sessionId: null, running: false, model: null, rules: [] });
let cl = newChat();

const scopeKey = () => {
  const v = state.view;
  if (v.ws) return `ws:${v.ws}`;
  return v.type === 'repo' ? `repo:${norm(v.path)}` : null;
};
const chatsFor = (key) => (chatStore.data[key] ||= { current: null, list: [] });

function selectChatForView() {
  const key = scopeKey();
  if (!key) return;
  const box = chatsFor(key);
  let chat = box.list.find((c) => c.id === box.current);
  if (!chat) { chat = newChat(); box.list.unshift(chat); box.current = chat.id; }
  cl = chat;
}

function findChat(id) {
  for (const box of Object.values(chatStore.data)) { const c = box.list.find((x) => x.id === id); if (c) return c; }
  return null;
}

function saveChats() {
  clearTimeout(chatStore.timer);
  chatStore.timer = setTimeout(() => {
    const slim = {};
    for (const [k, box] of Object.entries(chatStore.data)) {
      slim[k] = {
        current: box.current,
        list: box.list.filter((c) => c.items.length).slice(0, 20).map((c) => ({
          ...c, running: false, items: c.items.slice(-200).map((it) => (it.preview ? { ...it, preview: it.preview.slice(0, 600) } : it)),
        })),
      };
    }
    api.saveChats(slim);
  }, 800);
}

async function loadChats() {
  const data = await api.loadChats().catch(() => ({}));
  for (const box of Object.values(data)) {
    for (const c of box.list) {
      c.running = false;
      c.rules ||= [];
      // The claude process behind any pending approval is gone after a restart.
      for (const it of c.items) if (it.perm && !it.perm.decided) it.perm.decided = 'cancelled';
    }
  }
  chatStore.data = data;
}

// Opens the panel and sends a prepared question (used by the ✦ buttons around the app).
function askClaude(text) {
  if (!aiOn()) return;
  toggleClaude(true);
  selectChatForView();
  if (cl.running) { $('#cp-input').value = text; toast('Claude is still busy — your question is ready in the box.', 'info'); return; }
  claudeSend(text);
}

// "Always allow" rules for this chat: a git subcommand (e.g. "git switch") or all file edits.
const normGit = (cmd) => (cmd || '').trim().replace(/^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+/, 'git ');
function ruleFor(it) {
  if (it.name === 'Bash' || it.name === 'PowerShell') {
    const cmd = normGit(it.input?.command);
    if (RISKY.test(cmd) || /[;&|<>`]|\$\(/.test(cmd)) return null;
    const m = cmd.match(/^git\s+([a-z-]+)/);
    return m ? { tool: 'shell', prefix: `git ${m[1]}`, label: `all “git ${m[1]}” commands` } : null;
  }
  if (['Edit', 'MultiEdit', 'Write'].includes(it.name)) return { tool: 'edit', prefix: '', label: 'all file edits' };
  return null;
}
function matchesRule(chat, it) {
  const r = ruleFor(it);
  return !!r && chat.rules.some((x) => x.tool === r.tool && x.prefix === r.prefix);
}

const uniqPaths = (list) => list.filter((p, i) => list.findIndex((q) => samePath(p, q)) === i);

// The repo being viewed plus the other repos of its workspace.
function claudeScope() {
  const v = state.view;
  const ws = state.config.workspaces.find((w) => w.id === v.ws);
  if (v.type === 'repo') return { cwd: v.path, repos: uniqPaths([v.path, ...(ws?.repos || [])]), label: ws?.name || basename(v.path) };
  if (v.type === 'workspace' && ws?.repos.length) return { cwd: ws.repos[0], repos: ws.repos, label: ws.name };
  return null;
}

// Prepended to every message so Claude knows what the user is looking at right now.
function claudeContext() {
  const v = state.view;
  const describe = (p) => {
    const st = state.status[p] || {};
    if (st.error || st.missing) return `${basename(p)} (${p}): unavailable`;
    const bits = [`branch ${st.detached ? '(detached HEAD)' : st.branch}`, `${changedFiles(st).length} uncommitted changes`];
    if (st.upstream) bits.push(`${st.ahead} ahead / ${st.behind} behind ${st.upstream}`); else if (!st.detached) bits.push('not on the server yet');
    if (st.op) bits.push(`${st.op.kind} in progress`);
    if (st.conflicted?.length) bits.push(`conflicts in: ${st.conflicted.map((f) => f.path).join(', ')}`);
    return `${basename(p)} (${p}): ${bits.join(', ')}`;
  };
  const lines = [];
  if (v.type === 'repo') {
    lines.push(`The user is looking at the repo ${describe(v.path)}${state.tab ? ` — ${state.tab} tab` : ''}.`);
    if (state.tab === 'history' && state.histRef) lines.push(`History is showing commits on ${state.histRef}.`);
  } else if (v.type === 'workspace') lines.push(`The user is looking at the overview of the workspace "${currentWs()?.name}".`);
  for (const p of cl.session?.repos || []) if (!(v.type === 'repo' && samePath(p, v.path))) lines.push(`Also in this chat: ${describe(p)}`);
  return `<repodeck-context>\n${lines.join('\n')}\n</repodeck-context>\n\n`;
}

// The AI assistant can be turned off in Settings (e.g. for people without Claude). Then the panel
// can't open and every ✦ button is hidden (see body.no-ai in styles.css).
const aiOn = () => state.config.settings.assistant !== 'off';
function applyAssistant() {
  document.body.classList.toggle('no-ai', !aiOn());
  if (!aiOn()) $('#claude-panel').hidden = true;
}

function toggleClaude(open = $('#claude-panel').hidden) {
  if (open && !aiOn()) return;
  $('#claude-panel').hidden = !open;
  if (state.config.settings.claudeOpen !== open) { state.config.settings.claudeOpen = open; saveConfig(); }
  if (open) { renderClaude(); $('#cp-input').focus(); }
}

const relPath = (p) => {
  const base = cl.session?.cwd;
  if (!p || !base) return p || '';
  return p.toLowerCase().startsWith(base.toLowerCase() + '\\') ? p.slice(base.length + 1) : p;
};

// Long repo paths in commands are shown as just the repo name.
function shortCmd(cmd) {
  let out = cmd || '';
  for (const p of cl.session?.repos || []) {
    for (const v of [p, p.replace(/\\/g, '/')]) {
      out = out.split(`"${v}"`).join(basename(p)).split(`'${v}'`).join(basename(p)).split(v).join(basename(p));
    }
  }
  return out;
}

function toolLabel(t) {
  const i = t.input || {};
  switch (t.name) {
    case 'Bash': case 'PowerShell': return `Run <code title="${esc(i.command || '')}">${esc(shortCmd(i.command))}</code>`;
    case 'Read': return `Read ${esc(relPath(i.file_path))}`;
    case 'Edit': case 'MultiEdit': return `Edit ${esc(relPath(i.file_path))}`;
    case 'Write': return `Write ${esc(relPath(i.file_path))}`;
    case 'Glob': return `Find files <code>${esc(i.pattern || '')}</code>`;
    case 'Grep': return `Search for <code>${esc(i.pattern || '')}</code>`;
    case 'Task': case 'Agent': return `Sub-task: ${esc(i.description || '')}`;
    case 'TodoWrite': return 'Update its to-do list';
    default: return esc(t.name);
  }
}

const RISKY = /\b(push\b.*(--force|-f\b|--force-with-lease)|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|checkout\s+--\s|restore\s|rm\s+-r|Remove-Item|stash\s+(drop|clear)|filter-branch|rebase)\b/i;

function permissionDetail(t) {
  const i = t.input || {};
  if (t.name === 'Bash' || t.name === 'PowerShell') {
    const short = shortCmd(i.command);
    return `<pre class="cp-cmd">${esc(short)}</pre>${short !== i.command ? `<details class="cp-out"><summary>full command</summary><pre>${esc(i.command)}</pre></details>` : ''}${i.description ? `<div class="cp-desc">${esc(i.description)}</div>` : ''}
      ${RISKY.test(i.command || '') ? '<div class="cp-risk">⚠ This command can throw away work or rewrite history. Make sure that is what you want.</div>' : ''}`;
  }
  const diffLines = (oldS, newS) => [...(oldS || '').split('\n').map((l) => `<div class="dl del"><span class="code">-${esc(l)}</span></div>`), ...(newS || '').split('\n').map((l) => `<div class="dl add"><span class="code">+${esc(l)}</span></div>`)].slice(0, 80).join('');
  if (t.name === 'Edit') return `<div class="cp-file">${esc(relPath(i.file_path))}</div><div class="diff cp-diff">${diffLines(i.old_string, i.new_string)}</div>`;
  if (t.name === 'MultiEdit') return `<div class="cp-file">${esc(relPath(i.file_path))}</div><div class="diff cp-diff">${(i.edits || []).map((e) => diffLines(e.old_string, e.new_string)).join('<div class="dl hunk"><span class="code">⋯</span></div>')}</div>`;
  if (t.name === 'Write') {
    const lines = (i.content || '').split('\n');
    return `<div class="cp-file">${esc(relPath(i.file_path))} <span class="muted">(${plural(lines.length, 'line')})</span></div><pre class="cp-cmd">${esc(lines.slice(0, 30).join('\n'))}${lines.length > 30 ? '\n…' : ''}</pre>`;
  }
  return `<pre class="cp-cmd">${esc(JSON.stringify(i, null, 2))}</pre>`;
}


let claudeFrame = 0;
const renderClaudeSoon = () => { if (!claudeFrame) claudeFrame = requestAnimationFrame(() => { claudeFrame = 0; renderClaude(); }); };

function renderClaude() {
  if ($('#claude-panel').hidden) return;
  selectChatForView();
  const scope = claudeScope();
  $('#cp-scope').textContent = cl.session ? `Working in: ${cl.session.label}` : scope ? `Will work in: ${scope.label}` : 'Open a repo to start';
  $('#cp-scope').title = (cl.session || scope)?.repos.join('\n') || '';
  // Something running in another workspace's chat keeps going; say so.
  const elsewhere = Object.values(chatStore.data).flatMap((b) => b.list).find((c) => c.running && c !== cl);
  $('#cp-banner').innerHTML = elsewhere ? `<div class="cp-banner">Claude is still working on a chat in <b>${esc(elsewhere.session?.label || 'another workspace')}</b>. Sending here will stop it.</div>` : '';
  const send = $('#cp-send');
  send.textContent = cl.running ? 'Stop' : 'Send';
  send.dataset.action = cl.running ? 'claude-stop' : 'claude-send';
  send.classList.toggle('danger', cl.running);
  send.classList.toggle('primary', !cl.running);
  const waiting = cl.items.some((i) => i.kind === 'tool' && i.perm && !i.perm.decided);
  $('#cp-status').innerHTML = waiting ? '<b>Waiting for your approval ↑</b>' : cl.running ? '<span class="spinner sm"></span> Claude is working…' : cl.model ? esc(cl.model) : '';

  const box = $('#cp-msgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  if (!cl.items.length) {
    const ideas = ['What state are my branches in?', 'Which commits on main are not in my branch yet?', 'Explain what changed in the last 5 commits', 'Make a branch called feature/new-login in every repo', 'Copy the latest fix from main into my branch', 'Why can\'t I push?'];
    box.innerHTML = `<div class="cp-empty"><p>Ask Claude to look at or change things in your repos. It runs the <b>Claude Code</b> app you already have, signed in as you.</p>
      <p class="hint">It can read freely, but every command that changes something waits for you to click <b>Allow</b>.</p>
      <div class="cp-ideas">${ideas.map((t) => `<button class="cp-idea" data-action="claude-idea">${esc(t)}</button>`).join('')}</div></div>`;
    return;
  }
  box.innerHTML = cl.items.map((it, idx) => {
    if (it.kind === 'user') return `<div class="cp-user">${esc(it.text)}</div>`;
    if (it.kind === 'text') return it.text.trim() ? `<div class="cp-text">${md(it.text)}</div>` : '';
    if (it.kind === 'notice') return `<div class="cp-notice ${it.level || ''}">${it.html || esc(it.text)}</div>`;
    if (it.kind === 'done') return `<div class="cp-done">✓ Done${it.durationMs ? ` · ${Math.round(it.durationMs / 1000)}s` : ''}</div>`;
    const done = !cl.running && it.status === 'running' && !it.perm;
    const icon = it.status === 'error' ? '✕' : it.status === 'ok' || done ? '✓' : it.perm && !it.perm.decided ? '?' : '<span class="spinner sm"></span>';
    const pending = it.perm && !it.perm.decided;
    const rule = pending ? ruleFor(it) : null;
    const ok = ['allowed', 'auto-allowed'].includes(it.perm?.decided);
    return `<div class="cp-tool ${it.status || ''} ${pending ? 'pending' : ''} ${it.sub ? 'sub' : ''}">
      <div class="cp-tool-head"><span class="cp-ti" aria-hidden="true">${icon}</span><span class="cp-tl">${toolLabel(it)}</span>
        ${it.perm?.decided ? `<span class="tag ${ok ? 'ok' : 'bad'}">${it.perm.decided}</span>` : ''}</div>
      ${pending ? `<div class="cp-perm" role="group" aria-label="Approval needed"><div class="cp-perm-q">Claude wants to ${it.name === 'Bash' || it.name === 'PowerShell' ? 'run this command' : it.name === 'Write' ? 'write this file' : it.name.includes('Edit') ? 'make this edit' : `use ${esc(it.name)}`}:</div>
        ${permissionDetail(it)}
        <div class="cp-perm-actions">
          ${rule ? `<button class="btn small ghost" data-action="claude-allow-similar" data-idx="${idx}" title="Don't ask again in this chat for ${esc(rule.label)}">Always allow ${esc(rule.label)}</button>` : ''}
          <div class="spacer"></div>
          <button class="btn small" data-action="claude-deny" data-idx="${idx}">Deny</button><button class="btn small primary" data-action="claude-allow" data-idx="${idx}">Allow</button></div></div>` : ''}
      ${it.preview && !pending ? `<details class="cp-out"><summary>output</summary><pre>${esc(it.preview)}</pre></details>` : ''}
    </div>`;
  }).join('');
  if (atBottom || cl.items.at(-1)?.kind === 'user') box.scrollTop = box.scrollHeight;
}

let claudeRefreshTimer = 0;
const refreshSoon = () => { clearTimeout(claudeRefreshTimer); claudeRefreshTimer = setTimeout(() => refreshAll(), 400); };

function onClaudeEvent(ev) {
  // Events carry the chat they belong to, which may not be the one on screen.
  const chat = findChat(ev.key);
  if (!chat) return;
  const findTool = (id) => chat.items.find((i) => i.kind === 'tool' && i.id === id);
  switch (ev.type) {
    case 'init': chat.model = ev.model; chat.sessionId = ev.sessionId; break;
    case 'text_start': chat.items.push({ kind: 'text', text: '' }); break;
    case 'text': {
      let last = chat.items.at(-1);
      if (!last || last.kind !== 'text') chat.items.push((last = { kind: 'text', text: '' }));
      last.text += ev.delta;
      break;
    }
    case 'tool': if (!findTool(ev.id)) chat.items.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, sub: ev.sub, status: 'running' }); break;
    case 'tool_result': {
      const t = findTool(ev.id);
      if (t) { t.status = ev.isError ? 'error' : 'ok'; t.preview = ev.preview; }
      refreshSoon();
      break;
    }
    case 'permission': {
      let t = findTool(ev.toolUseId);
      if (!t) chat.items.push((t = { kind: 'tool', id: ev.toolUseId, name: ev.tool, status: 'running' }));
      t.input = ev.input;
      t.perm = { requestId: ev.requestId, decided: null };
      if (matchesRule(chat, t) && !RISKY.test(t.input?.command || '')) {
        t.perm.decided = 'auto-allowed';
        api.claude.permission(ev.requestId, true, t.input);
      } else if ($('#claude-panel').hidden) toggleClaude(true);
      break;
    }
    case 'result':
      chat.running = false;
      if (ev.isError && ev.subtype !== 'error_during_execution') chat.items.push({ kind: 'notice', level: 'bad', text: ev.text || `Claude stopped (${ev.subtype}).` });
      else chat.items.push({ kind: 'done', durationMs: ev.durationMs });
      // Approvals still open belonged to the finished turn.
      for (const i of chat.items) if (i.perm && !i.perm.decided) i.perm.decided = 'cancelled';
      refreshSoon();
      saveChats();
      break;
    case 'notice': chat.items.push({ kind: 'notice', text: ev.text }); break;
    case 'exit':
      if (chat.running && ev.code) chat.items.push({ kind: 'notice', level: 'bad', text: `Claude stopped unexpectedly${ev.message ? `: ${ev.message}` : '.'}` });
      chat.running = false;
      saveChats();
      break;
    default: break;
  }
  if (chat === cl) renderClaudeSoon();
}

async function claudeSend(text) {
  const ta = $('#cp-input');
  text = (text ?? ta.value).trim();
  if (!text || cl.running) return;
  const scope = claudeScope();
  if (!cl.session) {
    if (!scope) { toast('Open a repo or workspace first, so Claude knows where to work.', 'warn'); return; }
    cl.session = scope;
  }
  // Only one claude runs at a time: starting here stops any other chat's turn.
  for (const c of Object.values(chatStore.data).flatMap((b) => b.list)) if (c !== cl) c.running = false;
  const context = claudeContext();
  if (!cl.title) cl.title = text.slice(0, 80);
  cl.items.push({ kind: 'user', text });
  ta.value = '';
  cl.running = true;
  renderClaude();
  saveChats();
  const r = await api.claude.send(context + text, { key: cl.id, cwd: cl.session.cwd, repos: cl.session.repos, resumeId: cl.sessionId });
  if (!r.ok) {
    cl.running = false;
    cl.items.push({ kind: 'notice', level: 'bad', html: r.error === 'NOT_FOUND'
      ? 'Couldn\'t find the <b>Claude Code</b> app (claude.exe). Install it from <code>claude.com/claude-code</code>, or set its path in <b>Settings → Claude</b>.'
      : esc(r.error) });
    renderClaude();
  }
}

function claudeNewChat() {
  const key = scopeKey();
  if (!key) return;
  if (cl.running) api.claude.interrupt();
  const box = chatsFor(key);
  const chat = newChat();
  box.list.unshift(chat);
  box.current = chat.id;
  cl = chat;
  renderClaude();
  saveChats();
  $('#cp-input').focus();
}

// Earlier chats in this workspace.
function claudeHistory(anchor) {
  const key = scopeKey();
  if (!key) return;
  const list = chatsFor(key).list.filter((c) => c.items.length);
  popover(anchor, list.length
    ? `<div role="menu">${list.map((c) => `<button class="menu-item ${c === cl ? 'current' : ''}" data-action="claude-open-chat" data-id="${c.id}"><span>${esc(c.title || 'Untitled chat')}</span><span class="muted small">${timeAgo(c.created / 1000)}</span></button>`).join('')}</div>`
    : '<div class="muted pad small">No earlier chats in this workspace yet.</div>', { width: 340 });
}
