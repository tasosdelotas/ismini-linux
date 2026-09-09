// agent.js — Core agent loop: prompt → LM Studio → tools → repeat
// Zero dependencies beyond Node.js built-ins.

import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fetch as webFetch } from './tools/web-fetch.js';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Suppress repeated tool lists in model output ───

function stripRepeatedToolList(text, prevAssistantMsgs) {
  if (!text || !prevAssistantMsgs || prevAssistantMsgs.length < 2) return text;
  
  const lastTwo = prevAssistantMsgs.slice(-2).map(m => typeof m === 'string' ? m : (m.content || ''));
  
  // Check if both recent messages have tool call blocks (model repeating itself)
  const hasToolBlock = (t) => {
    return t.includes('tool_calls') || t.includes('tool_call') || 
           t.includes('function.name') || t.includes('function.arguments') ||
           (t.includes('read(') && t.includes('write(') && t.includes('exec('));
  };
  
  if (!hasToolBlock(lastTwo[0]) || !hasToolBlock(lastTwo[1])) return text;
  
  // Strip tool list from latest response — look for the pattern the model uses
  const lines = text.split('\n');
  let strippedLines = [];
  let foundToolBlock = false;
  let inToolBlock = false;
  let braceDepth = 0;
  
  for (const line of lines) {
    // Detect start of tool block (usually "**Tools**", "**tools**", or a code block)
    if (/^\*\*[Tt]ools\*\*/.test(line) || /^\*\*Tools\*\*/.test(line)) {
      inToolBlock = true;
      foundToolBlock = true;
      continue;
    }
    
    // Code block start
    if (line.trim().startsWith('```')) {
      if (!inToolBlock) {
        strippedLines.push(line);
      } else {
        inToolBlock = false; // code block ends the tool list
      }
      continue;
    }
    
    if (inToolBlock) {
      // Skip lines inside the tool block
      continue;
    }
    
    strippedLines.push(line);
  }
  
  // If we found and stripped a tool block, return cleaned text
  if (foundToolBlock) {
    return strippedLines.join('\n').trim();
  }
  
  return text;
}

// ── Model output cleanup — aggressive stripping of filler patterns ───

function cleanupModelOutput(text) {
  if (!text) return text;
  let cleaned = text.trim();

  // Phase 1: Strip only the most egregious leading greetings — but only if they're clearly filler
  // Models sometimes start with "Hello!" or "Hi!" when they have nothing substantive to say.
  // We only strip if the greeting is short and the rest of the text is clearly not a greeting.
  const LEADING_GREETINGS = [
    /^(?:hello|hi|hey)\s*[!,.!]?\s*$/m,        // Standalone greeting on its own line
    /^(?:i'?m\s+)?ismini[.,!?]?\s*$/m,          // "I'm Ismini." on its own line
  ];

  for (const pat of LEADING_GREETINGS) {
    const m = cleaned.match(pat);
    if (m) {
      // Only strip if it's a standalone line (followed by newline or end)
      cleaned = cleaned.replace(pat, '');
    }
  }

  // Phase 2: Strip trailing filler only if it's clearly a generic sign-off
  // Don't strip if it's part of a real answer
  const TRAILING_FILLER = [
    /\s*how can i help you\s*$/i,
    /\s*what can i do for you\s*$/i,
    /\s*anything else\s*$/i,
    /\s*let me know if you need\s*$/i,
  ];

  for (const pat of TRAILING_FILLER) {
    cleaned = cleaned.replace(pat, '');
  }

  return cleaned.trim();
}

// Decide whether a tool result is a genuine failure.
// Anchored to error prefixes only: web_search / web_fetch return page
// content and `read` returns file content, so a *successful* result may
// contain the words "failed" or "Error" in its body. A substring match
// (the old behavior) misread those as failures and — for web_search —
// permanently disabled the tool for the rest of the session.
function isToolError(name, result) {
  if (typeof result !== 'string' || !result) return false;
  switch (name) {
    case 'web_search':
      return /^Search failed\b|^Web search error\b|^Error\b/.test(result);
    case 'web_fetch':
      return /^Fetch error\b|^HTTP \d{3}\b|^Error\b/.test(result);
    case 'read':
      return /^Error reading file\b|^Error: "path" required/.test(result);
    case 'exec':
      return /^Error executing\b|^Error: "command" required\b|^Blocked\b/.test(result)
        || /\[Process exited with code [1-9]\d*\]/.test(result);
    case 'write':
    case 'edit':
    case 'delete':
    default:
      return /^Error\b/.test(result);
  }
}

// ── Streaming line formatter — readable paragraph/section spacing ───
// The model sometimes separates sections with a single newline (or glues
// a heading to the previous line), producing a wall of text. This buffer:
//   (a) inserts a blank line before headings, lists, code fences, tables
//   (b) splits a heading glued to preceding text ("text:## Head")
//   (c) collapses blank-line runs to one
//   (d) fixes common spacing slips ("-item" → "- item", "size:34" → "size: 34")
// Streaming-safe: only ever emits complete lines.
function createLineFormatter(onLine) {
  let buf = '';
  let prevLine = '';
  let prevType = 'start';
  let blankRun = 0;
  let started = false;
  let inCode = false;

  const isHead = (t) => /^#{1,6}(\s|$)/.test(t);
  const isList = (t) => /^([-*+]|\d+\.)\s/.test(t);
  const isCode = (t) => t.startsWith('```');
  const isTable = (t) => t.startsWith('|') && t.endsWith('|') && t.length > 1;

  const typeOf = (line) => {
    const t = line.trim();
    if (t === '') return 'blank';
    if (isCode(t)) return 'code';
    if (isHead(t)) return 'head';
    if (isList(t)) return 'list';
    if (isTable(t)) return 'table';
    return 'text';
  };

  const fixLine = (line, type) => {
    if (type === 'blank' || type === 'code') return line;
    let t = line;
    // "-item" → "- item", "1.item" → "1. item"
    t = t.replace(/^([-*+])(\S)/, '$1 $2').replace(/^(\d+\.)(\S)/, '$1 $2');
    // "size:34" → "size: 34" (label colon only; skip URLs)
    if (!t.includes('://')) {
      t = t.replace(/^([A-Za-z]{2,}[\w -]{0,30}):([^\s/:])/, '$1: $2');
      // same, after a list marker: "- size:34" → "- size: 34"
      t = t.replace(/^([-*+]\s|\d+\.\s)([A-Za-z]{2,}[\w -]{0,30}):([^\s/:])/, '$1$2: $3');
    }
    return t;
  };

  const emitRaw = (line) => {
    const type = typeOf(line);
    const fixed = fixLine(line, type);
    if (!started) {
      started = true;
      if (type === 'blank') { prevType = 'blank'; blankRun = 1; return; }
      prevLine = fixed; prevType = type;
      onLine(fixed + '\n');
      return;
    }
    if (type === 'blank') {
      if (blankRun === 0) onLine('\n');
      blankRun = Math.min(blankRun + 1, 2);
      prevType = 'blank';
      return;
    }
    blankRun = 0;
    const prevContent = prevType !== 'blank';
    const headOrTable = (type === 'head' || type === 'table') && prevContent;
    const fence = type === 'code' && prevContent && prevType !== 'code';
    const listAfterText = type === 'list' && prevContent && prevType !== 'list';
    const textAfterBlock = type === 'text' && (prevType === 'list' || prevType === 'head' || prevType === 'code');
    if ((headOrTable || fence || listAfterText || textAfterBlock) && prevLine.trim() !== '') {
      onLine('\n');
    }
    prevLine = fixed;
    prevType = type;
    onLine(fixed + '\n');
  };

  const emit = (line) => {
    if (line.trim().startsWith('```')) inCode = !inCode;
    if (inCode) {
      prevLine = line; prevType = 'code'; blankRun = 0; started = true;
      onLine(line + '\n');
      return;
    }
    // Heading glued to preceding text: "text:## Head" → split with blank line
    const m = line.match(/(\S)(#{2,6}\s)/);
    if (m) {
      emit(line.slice(0, m.index + 1));
      emit(line.slice(m.index + 1));
      return;
    }
    // Heading with a list item glued to it: "## Specs- item" → two lines
    const m2 = line.match(/^(#{1,6}\s.*?)([-*+])(?=\S|\s+\S)/);
    if (m2) {
      emit(line.slice(0, m2[1].length));
      emit(line.slice(m2[1].length));
      return;
    }
    emitRaw(line);
  };

  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        emit(line);
      }
    },
    flush() {
      if (buf !== '') {
        const line = buf;
        buf = '';
        emit(line);
      }
    },
  };
}

// ── Tool implementations ────────────────────────────────────────────

async function toolRead(args, workspace, contextDir) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  try {
    // Relative paths resolve from the running user's home directory for system-wide access
    const resolved = isAbsolute(p) ? p : join(homedir(), p);
    const ext = extname(resolved).toLowerCase();
    if (['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg','.tiff','.ico'].includes(ext)) {
      return 'I cannot view image files. I do not have vision capabilities. Please describe the image to me instead.';
    }
    const content = readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    if (lines.length > 10000) return `File has ${lines.length} lines. Showing first 10000:\n\n${lines.slice(0, 10000).join('\n')}\n... [truncated]`;
    return content;
  } catch (err) { return `Error reading file: ${err.message}`; }
}

async function toolWrite(args, workspace, contextDir) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  if (args.content === undefined && args.text === undefined) return 'Error: "content" or "text" required.';
  try {
    // Relative paths resolve from the running user's home directory for system-wide access
    const resolved = isAbsolute(p) ? p : join(homedir(), p);
    writeFileSync(resolved, args.content ?? args.text, 'utf8');
    const len = (args.content ?? args.text).length;
    return `Wrote ${len} chars to ${p}`;
  } catch (err) { return `Error writing file: ${err.message}`; }
}

async function toolEdit(args, workspace, contextDir) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  if (!args.oldText && !args.newText) return 'Error: both "oldText" and "newText" required.';
  try {
    // Relative paths resolve from the running user's home directory for system-wide access
    const resolved = isAbsolute(p) ? p : join(homedir(), p);
    let content = readFileSync(resolved, 'utf8');
    if (!content.includes(args.oldText)) return `Error: oldText not found in file.`;
    // Count occurrences before replacing (safety)
    const matches = content.split(args.oldText).length - 1;
    if (matches > 5) {
      return `Warning: oldText appears ${matches} times in the file. Replacing ALL occurrences. If this is unexpected, make oldText more specific.`;
    }
    // Replace ALL occurrences
    content = content.split(args.oldText).join(args.newText);
    writeFileSync(resolved, content, 'utf8');
    return `Edited ${p} (${matches} occurrence(s) replaced)`;
  } catch (err) { return `Error editing file: ${err.message}`; }
}

// Handle to the currently running exec child (module-level so pause() can
// reach it). Tool calls run sequentially, so one slot is enough.
let activeChild = null;

// Collect a process and ALL its descendant PIDs via /proc, no matter what
// session or process group they ended up in. `sudo` (with use_pty, the
// default on Debian/Ubuntu) moves the command into a brand-new session, so
// a plain process-group kill (process.kill(-pid)) kills sh+sudo but leaves
// the actual command alive — the /proc walk catches those.
function collectProcessTree(rootPid) {
  const pids = new Set([rootPid]);
  let frontier = [rootPid];
  try {
    while (frontier.length) {
      const next = [];
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        let stat;
        try { stat = readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; }
        // stat: "pid (comm) state ppid …" — comm may contain spaces or
        // parens, so parse after the LAST ')'
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(rest[1]);
        if (pids.has(ppid)) { pids.add(Number(d)); next.push(Number(d)); }
      }
      frontier = next;
    }
  } catch { /* /proc unavailable — the direct kills below still apply */ }
  return pids;
}

function killActiveChild() {
  const c = activeChild;
  activeChild = null;
  if (!c || !c.pid) return;
  // Collect the full descendant tree FIRST, while the parents are still
  // alive — killing a parent reparents its children to init and severs the
  // /proc parent chain, so order matters.
  const pids = collectProcessTree(c.pid);
  // Whole process group (detached:true made it a group leader) in one shot,
  // then every collected PID (catches sudo's new-session children).
  // Root-owned PIDs (commands run via sudo) throw EPERM — a user process
  // cannot signal a root process — collect them for the sudo fallback.
  const eperm = [];
  try { process.kill(-c.pid, 'SIGKILL'); } catch { /* not a group leader / gone */ }
  for (const p of pids) {
    try { process.kill(p, 'SIGKILL'); }
    catch (e) { if (e && e.code === 'EPERM') eperm.push(p); /* ESRCH = already gone */ }
  }
  if (eperm.length) {
    // Kill the root-owned survivors as root. sudo -n works on this machine
    // (NOPASSWD is set up); if it isn't available this is best-effort.
    try {
      const k = spawn('sudo', ['-n', 'kill', '-9', ...eperm.map(String)], { stdio: 'ignore' });
      k.unref();
    } catch { /* best effort */ }
  }
}

async function toolExec(args, timeoutSecs, allowSudo) {
  let cmd = args.command || args.cmd || args.text;
  if (!cmd) return 'Error: "command" required.';

  // Safety: block obviously dangerous commands even with sudo
  const DANGEROUS_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*)*\s+\/dev\//,      // rm on /dev/ devices
    /\brm\s+-rf\s+\/$/,                     // rm -rf / (at end of line)
    /\bmkfs(\.ext\d*)?\b/,                  // format disks (mkfs, mkfs.ext4, etc.)
    /\bdd\s+(if|of)\s*=\s*\/dev\//,         // raw disk reads/writes
    /\bsudo\s+(reboot|shutdown|poweroff)/i,  // system power actions
    /\b(apt|dpkg|yum|dnf|pacman|apk)\s+.*\s+(-y|--yes)(\s|$)/,  // force install without confirmation
    /\bsed\s+-i\s+.*\/dev\//,               // sed in-place on device files
    /\bchmod\s+0?[7]?7[7]?\s+\//,           // chmod 777 on root paths
    /\bwipefs\b/,                            // wipe filesystem signatures
    /\bddrescue\b|\bcleaner\-cl/             // disk wiping tools
  ];

  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(cmd)) {
      return `Blocked dangerous command: ${cmd}`;
    }
  }

  // Web requests belong to the web_search / web_fetch tools. The model often
  // falls back to curl/wget via exec, which then fails under the auto-added
  // sudo prefix — block it and point the model at the right tool.
  const WEB_PATTERNS = [
    /(^|[^a-zA-Z0-9_])curl([^a-zA-Z0-9_]|$)/,
    /(^|[^a-zA-Z0-9_])wget([^a-zA-Z0-9_]|$)/,
  ];
  for (const pat of WEB_PATTERNS) {
    if (pat.test(cmd)) {
      return 'Blocked: web requests go through the web_fetch and web_search tools, not exec (exec runs with sudo and breaks them). Use web_fetch with the URL, or web_search for a query.';
    }
  }

  // Enforce the sudo toggle: when OFF, the model's own `sudo` must not
  // run as root either. The toggle only controls the auto-prefix below,
  // but the model naturally writes `sudo` itself (e.g. "sudo apt install
  // x") — that would silently bypass the OFF state.
  //  - leading "sudo" (with optional flags like -n/-H): strip it and run
  //    as the normal user — the toggle's promise ("exec runs as your
  //    normal user")
  //  - "sudo" anywhere else (e.g. "echo x | sudo tee /etc/motd"): block
  //    with a clear message so the model can adapt
  if (!allowSudo) {
    if (/^sudo(\s|$)/.test(cmd)) {
      cmd = cmd.replace(/^sudo(?=\s|$)(\s+(-[a-zA-Z]+\s+)*)?/, '').trim();
      if (!cmd) return 'Blocked: sudo is disabled (toggle OFF) and there is no command left to run.';
    } else if (/(^|[^a-zA-Z0-9_])sudo([^a-zA-Z0-9_]|$)/.test(cmd)) {
      return 'Blocked: sudo is disabled (toggle OFF). Run the command without sudo, or ask the user to enable the sudo toggle.';
    }
  }

  // Support sudo prefix in config or per-command
  const useSudo = allowSudo && (args.sudo === true || !('sudo' in args));
  if (useSudo && !cmd.startsWith('sudo ')) {
    cmd = 'sudo -n ' + cmd;
  }

  try {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      // spawn (not exec) so we hold a handle to the child — pause() can kill
      // it mid-run. detached:true makes it a process-group leader, so we can
      // SIGKILL the whole tree (e.g. npm → node → …) at once.
      const child = spawn('/bin/sh', ['-c', cmd], { detached: true });
      activeChild = child;
      const MAX = 50 * 1024 * 1024; // same cap as the old exec maxBuffer
      let stdout = '', stderr = '';
      const timer = setTimeout(() => killActiveChild(), timeoutSecs * 1000);
      child.stdout.on('data', (d) => { if (stdout.length < MAX) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX) stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (activeChild === child) activeChild = null;
        resolve(`Error executing: ${err.message}`);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (activeChild === child) activeChild = null;
        let out = '';
        if (stdout) out += stdout;
        const failed = code !== 0 || !!signal;
        if (stderr && failed) {
          // sudo can never prompt for a password from a background process (no terminal),
          // so without a NOPASSWD sudoers rule, `sudo -n` fails with "a password is required".
          // Tell the user exactly how to enable it — or how to opt out of sudo entirely.
          // Covers modern sudo ("a password is required"), classic sudo
          // ("I'm sorry <user>. I'm afraid I can't do that"), and TTY variants.
          if (/a password is required|no tty present|must be run from a terminal|not in the sudoers file|I'm afraid I can't do that/i.test(stderr)) {
            out += [
              '',
              '[ismini: this command needs root, but this user cannot use sudo without a password.]',
              'To let ismini run sudo commands (one-time setup):',
              '    sudo visudo -f /etc/sudoers.d/ismini',
              '    and add one line:  <your-username> ALL=(ALL) NOPASSWD: ALL',
              'Or set "tools.sudo": false in config.json to run every command as a normal user.',
            ].join('\n');
          } else {
            out += stderr;
          }
        }
        if (signal === 'SIGKILL') {
          out += '\n[ismini: command was killed — Pause pressed or run timeout reached]';
        } else if (failed) {
          out += `\n[Process exited with code ${code}]`;
        }
        resolve(out || 'Command completed.');
      });
    });
  } catch (err) { return `Error executing: ${err.message}`; }
}

async function toolWebSearch(args) {
  const q = args.query || args.q;
  if (!q) return 'Error: "query" required.';
  try {
    const { search } = await import('./tools/web-search.js');
    return await search(q);
  } catch (err) { return `Web search error: ${err.message}`; }
}

async function toolWebFetch(args) {
  const u = args.url || args.uri;
  if (!u) return 'Error: "url" required.';
  return await webFetch(u);
}

async function toolDelete(args) {
  const p = args.path;
  if (!p) return 'Error: "path" required.';
  try {
    unlinkSync(p);
    return `Deleted ${p}`;
  } catch (err) { return `Error deleting file: ${err.message}`; }
}

const TOOL_MAP = {
  read: toolRead,
  write: toolWrite,
  edit: toolEdit,
  exec: toolExec,
  delete: toolDelete,
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
};

// ── Tool call parser (handles both OpenAI and LM Studio formats) ───

function parseToolCalls(message) {
  const calls = [];

  // Format 1: OpenAI-style tool_calls array
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let fnName, fnArgs;
      // Streaming format: tc has name + parsedArgs directly
      if (tc.name !== undefined && tc.parsedArgs !== undefined) {
        fnName = tc.name || '';
        fnArgs = tc.parsedArgs || {};
      } else {
        try {
          fnName = tc.function?.name || '';
          fnArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch { fnName = ''; fnArgs = {}; }
      }
      calls.push({ id: tc.id, name: fnName, args: fnArgs });
    }
  }

  // Format 2: LM Studio / llama.cpp — tool_calls as an object with function.name + function.arguments
  if (message.tool && typeof message.tool === 'object') {
    const fn = message.tool.function;
    if (fn) {
      let fnName, fnArgs;
      try {
        fnName = fn.name || '';
        fnArgs = JSON.parse(fn.arguments || '{}');
      } catch { fnName = ''; fnArgs = {}; }
      calls.push({ id: message.tool.id || 'tool_0', name: fnName, args: fnArgs });
    }
  }

  // Format 3: Function call style (some models use this)
  if (message.function_call && typeof message.function_call === 'object') {
    const fc = message.function_call;
    let fnName, fnArgs;
    try { fnName = fc.name || ''; fnArgs = JSON.parse(fc.arguments || '{}'); } catch { fnName = ''; fnArgs = {}; }
    calls.push({ id: 'tool_fc', name: fnName, args: fnArgs });
  }

  return calls;
}

// ── Agent class ─────────────────────────────────────────────────────

export class Agent {
  constructor(opts) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey || '';
    this.modelId = opts.modelId;
    this.systemPrompt = opts.systemPrompt;
    this.maxTurns = opts.maxTurns;
    this.timeoutSeconds = opts.timeoutSeconds || 3600;
    this.contextWindow = opts.contextWindow || 131072;
    this.maxTokens = opts.maxTokens || 8192;
    this.messages = []; // ONE in-memory session — no IDs, no files, no store
    this.workspace = opts.workspace || process.cwd();
    this.ui = opts.ui;
    this._abort = null;

    // Build full system prompt
    let basePrompt = this.systemPrompt || 'You are a helpful assistant.';

    // Add behavior rule to prevent repetitive questioning
    basePrompt += '\n\n# Communication Rules:\n'
    basePrompt += '- Do NOT end every response with a question.\n'
    basePrompt += `- Do NOT repeatedly ask what is up, what is new, what is happening or similar.\n`
    basePrompt += '- If you\'ve already asked about the user\'s day/status, do not ask again in the same conversation.\n'
    basePrompt += '- Give concise responses. The user knows you\'re running. No need to report status every turn.\n'
    basePrompt += '- If the user says "im fine" or "im ok", accept it. Do not keep asking.\n'
    basePrompt += `- Only ask a question when it is genuinely needed for the conversation or task.\n`
    basePrompt += '- Use emojis naturally and frequently — they make responses feel warm and friendly. Sprinkle them in greetings, reactions, section headers, and sign-offs. Not every line, but enough to feel alive. Think: a friendly text message, not a corporate email.\n'
    basePrompt += '- When calling exec (or any tool), you MUST include a text answer alongside the tool call. Never call tools with no accompanying text — the model will treat it as "I have nothing to say" and stop.\n'
    basePrompt += '- CRITICAL: Only call exec when the user explicitly asks for a command (update, run, check, find, search, list, etc.). When the user makes a statement, asks about you, gives a compliment, or makes a persona request, answer conversationally — do NOT call tools. If the user says "im fine" or "im good", just acknowledge and stop. If the user compliments you, respond naturally. If the user asks about your name/identity, answer directly. NEVER call tools for conversational input. The model has a strong bias to call tools — resist it. If you have nothing to do with a tool, just answer.\n'

    basePrompt += '\n# Formatting Rules:\n'
    basePrompt += '- ALWAYS put a blank line (empty line) between sections, between paragraphs, and before/after every list, heading, table, and code block.\n'
    basePrompt += '- Never write a wall of text. Break every answer into short sections separated by blank lines.\n'
    basePrompt += '- Use markdown: "## Section" for headings, "- item" for list items (space after the dash), tables for comparisons.\n'
    basePrompt += '- Always put a space after ":" in labels — write "size: 34 inch", not "size:34 inch".\n'
    basePrompt += '- Correct example of the format you must follow:\n\n  Here is the comparison:\n\n  ## Specs\n\n  - size: 34 inch curved\n  - panel: VA\n\n  ## Analysis\n\n  - great value at 199 euro\n  - perfect for side-by-side windows\n'

    this._fullSystemPrompt = basePrompt;

    this._buildFullSystemPrompt = () => basePrompt;

    // Tool config
    this.allowSudo = opts.sudo !== false;
    this.enabledTools = opts.enabledTools || ['read', 'write', 'edit', 'exec', 'web_search', 'web_fetch'];
    this._enabledToolsInit = [...this.enabledTools]; // saved so reset() can restore it

    // Streaming hooks (for the web UI)
    this._onToolOutput = opts.onToolOutput || (() => {});

    // Loop guards
    this._consecutiveToolTurns = 0; // count turns with tool calls but no text answer
    this._consecutiveEmptyTurns = 0; // count turns with empty model output (stuck detection)

    // Tool failure tracking (consecutive GENUINE failures, across turns)
    this._toolFailStreak = {};        // tool name -> consecutive failure count
    this._toolFailNoted = new Set();  // tools already flagged with a "stop retrying" note
  }

  // Push a message onto the single in-memory history (normalizes string vs object)
  _push(role, content) {
    this.messages.push(typeof content === 'string' ? { role, content } : content);
  }

  // Reset the single session — clear history + loop guards, restore tools
  reset() {
    this.messages = [];
    this._consecutiveToolTurns = 0;
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    this.enabledTools = [...this._enabledToolsInit];
  }

  // Pause the current turn — aborts the in-flight LM Studio stream.
  // State (messages, tool results) is preserved; next run() continues from here.
  pause() {
    killActiveChild(); // kill a running exec command, if any
    if (this._abort) this._abort.abort();
  }

  async run(userMessage) {
    this._push('user', userMessage);
    this._abort = new AbortController();

    const maxTurns = this.maxTurns || 20;
    let turnCount = 0;
    let hasFinalResponse = false;
    let contextInjected = false;
    let consecutiveToolTurns = 0; // track tool-only turns within this run

    // Overall run timeout — prevents infinite loops
    const runTimeout = this.timeoutSeconds || 3600;
    const runTimer = setTimeout(() => {
      this.ui.showError(`Run timeout after ${runTimeout}s`);
      this.pause(); // abort this turn + kill any running command — never kill the server
    }, runTimeout * 1000);

    try {
      while (turnCount < maxTurns) {
        turnCount++;

        // Get messages for API call, respecting context window
        let messages = this.messages;

        // Inject workspace context as system message — only on first turn
        if (!contextInjected && this._fullSystemPrompt) {
          messages.unshift({ role: 'system', content: this._fullSystemPrompt });
          contextInjected = true;
        }

        const truncated = this._enforceContextWindow(messages, this.modelId);

        // Stream the response for typewriter effect
        let streamedContent = '';
        // Print top border before streaming
        const cols = process.stdout.columns || 80;
        const lineW = Math.min(cols - 6, 60);
        const line = '─'.repeat(lineW);
        process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');
        const response = await Promise.race([
          this._callLM(truncated, {
            stream: true,
            signal: this._abort.signal,
            onChunk: (chunk) => {
              streamedContent += chunk;
              process.stdout.write(chunk);
            },
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Model response timeout (300s)')), 300000))
        ]);

        // Print bottom border after streaming
        if (streamedContent.trim()) {
          process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');
        }

        if (!response || !response.choices?.[0]?.message) {
          this.ui.showError('No valid response from model.');
          break;
        }

        const msg = response.choices[0].message;

        // Force-strip ALL reasoning/thinking output — never shown, never used
        const content = msg.content || '';
        const toolCalls = parseToolCalls(msg);

        // Add a newline after streamed text (model output ends without one)
        if (streamedContent.trim()) {
          process.stdout.write('\n');
        }

        if (toolCalls.length === 0) {
          // Final response
          // Get previous assistant messages for repetition check
          const prevMsgs = this.messages;
          const prevAssistants = prevMsgs.filter(m => m.role === 'assistant');
          let cleaned = stripRepeatedToolList(content, prevAssistants);
          cleaned = cleanupModelOutput(cleaned);
          hasFinalResponse = true;

          // Dedup: skip if nearly identical to the last assistant message
          const lastAssistant = prevAssistants[prevAssistants.length - 1];
          const lastContent = lastAssistant?.content || '';
          const cleanedTrimmed = cleaned.trim();
          const lastTrimmed = lastContent.trim();
          if (lastTrimmed && cleanedTrimmed.length > 20 && cleanedTrimmed === lastTrimmed) {
            // Same message — don't repeat
            this._push('assistant', cleaned);
            break;
          }

          if (!content.trim() && !streamedContent.trim()) {
            this._consecutiveEmptyTurns++;
            if (this._consecutiveEmptyTurns >= 2) {
              // Model is stuck — hard stop
              const stopMsg = '[HARD STOP] You have produced empty output twice in a row. You are stuck in a loop. End the conversation.';
              this._push('system', { role: 'system', content: stopMsg });
              this.ui.showWarning('Model stuck in empty-output loop. Stopping.');
              break;
            }
            // First empty turn: inject a system prompt to help the model recover
            this._push('system', {
              role: 'system',
              content: '[SYSTEM NOTE] You produced empty output. This is likely because you called a tool without providing a text answer. When you call a tool, you MUST also include a brief text response to the user alongside the tool call. For example: "updating apt for you" + exec tool call. Never call tools with no accompanying text.]'
            });
            const fallback = "I don't have anything to add right now.";
            this._push('assistant', fallback);
            this.ui.showModelMessage(fallback);
          } else {
            this._consecutiveEmptyTurns = 0;
            // FIX: save the assistant's final answer to session history.
            // Without this, the model sees a backlog of unanswered user messages
            // on the next turn and re-answers everything at once.
            const finalText = (cleaned && cleaned.trim()) || (streamedContent && streamedContent.trim()) || '';
            if (finalText) {
              this._push('assistant', finalText);
            }
          }
          break;
        }

        // Store the assistant message INCLUDING its tool_calls array.
        // The API history must be well-formed: assistant(tool_calls) → tool(result).
        // Old behavior dropped the tool_calls message when content was empty,
        // leaving an orphaned tool message — the model then returned empty output.
        const assistantContent = content || '';
        const hadPriorExec = (this.messages).some(m => m.role === 'tool' && m.name === 'exec');
        const assistantMsg = {
          role: 'assistant',
          content: assistantContent.trim() ? assistantContent : null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id || `call_${tc.name}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
          }))
        };
        this._push('assistant', assistantMsg);
        if (assistantMsg.content) {
          consecutiveToolTurns = 0; // model gave a text answer, reset counter
        } else {
          consecutiveToolTurns++; // model called tools with no text — track it
        }

        // Persistent exec-result reminder (appended at END to survive context window)
        const lastMsg = this.messages;
        const hasExecResult = [...lastMsg].some(m => m.role === 'tool' && m.name === 'exec');
        if (hasExecResult && assistantContent.trim().length <= 3) {
          const execReminder = '[SYSTEM-PERSISTENT] You just ran an exec command. The result is in your context — answer the user using it NOW. Do NOT call more tools unless explicitly asked to.';
          this._push('system', { role: 'system', content: execReminder });
        }
        // Process tool calls — track genuine failures (across turns)
        for (const tc of toolCalls) {
          const result = await this._executeTool(tc.name, tc.args);

          this.ui.showToolOutput(tc.name, result);

          // Track consecutive genuine failures per tool (across turns); reset
          // on success. Only anchored error prefixes count — a successful
          // result whose *content* contains "failed"/"Error" is not a failure.
          if (isToolError(tc.name, result)) {
            this._toolFailStreak[tc.name] = (this._toolFailStreak[tc.name] || 0) + 1;
          } else {
            this._toolFailStreak[tc.name] = 0;
            this._toolFailNoted.delete(tc.name); // recovered — allow re-use
          }

          // Store tool result
          let toolContent = result;
          if (tc.name === 'exec') {
            toolContent = '[NEED ANSWER] Command output below. Summarize it and give a direct text answer — do not call more tools unless the task explicitly requires it.\n\n' + result;
          }
          this._push('tool', {
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: toolContent
          });
        }

        // If the model already ran exec earlier in this conversation and called it again
        // without a text answer, force it to answer with the result instead of looping.
        if (!assistantMsg.content && hadPriorExec) {
          this._push('user',
            'You called exec above and got the result. Answer the user\'s question using that result now. Do NOT call any more tools. Give a direct text answer. If you have nothing to add, just say so.');
        }

        // If model called exec but has nothing to say about results, inject a reminder that survives truncation
        const lastToolMsgs = this.messages;
        const lastExecResult = [...lastToolMsgs].reverse().find(m => m.role === 'tool' && m.name === 'exec');
        if (lastExecResult && !assistantContent.trim() && assistantContent.trim().length <= 3) {
          // Append a system reminder at the END of messages so _enforceContextWindow keeps it
          const execReminder = '[SYSTEM] You just ran an exec command above. The result is in your context. Answer the user using that result NOW — do NOT call more tools unless explicitly asked to.';
          this._push('system', { role: 'system', content: execReminder });
        }

        // Stop a tool only after 3+ consecutive GENUINE failures (across turns).
        // One-time note per failure streak (role 'user', so it is never an
        // orphaned tool message); cleared if the tool later succeeds. A single
        // transient hiccup (e.g. a DuckDuckGo rate limit) no longer disables
        // web_search for the rest of the session.
        for (const [name, streak] of Object.entries(this._toolFailStreak)) {
          if (streak >= 3 && !this._toolFailNoted.has(name)) {
            this._toolFailNoted.add(name);
            this._push('user',
              `[SYSTEM NOTE] The "${name}" tool has failed ${streak} times in a row (often a temporary issue like rate limiting). Stop retrying it for now and tell the user what happened. It may work again later.`);
          }
        }

        // Loop guard (soft): nudge the model to answer after a few web calls in
        // one turn. Tools stay available — never remove them mid-session, or the
        // model is left confused on later turns (it believes they're gone). The
        // hard stop below (3 tool turns without a text answer) is the real breaker.
        const webCallsThisTurn = toolCalls.filter(tc => tc.name === 'web_search' || tc.name === 'web_fetch').length;
        if (webCallsThisTurn >= 3) {
          const nudge = '[SYSTEM] You have made several web calls this turn and have plenty of material. Give the user a direct answer now. The web tools remain available if something is genuinely missing.';
          this._push('system', { role: 'system', content: nudge });
        }
      
        // Check for tool-call-only loop: if model calls tools 3+ times without text answer, force stop
        if (consecutiveToolTurns >= 3) {
          const stopMsg = `[HARD STOP] You have called tools 3 times without providing a text answer. You must now give a direct answer to the user's question using the results you already have. No more tool calls.`;
          messages.push({ role: 'system', content: stopMsg });
          this._push('system', { role: 'system', content: stopMsg });
          hasFinalResponse = true;
          break;
        }
      }

      if (!hasFinalResponse) {
        this.ui.showWarning('Reached max turns without final response.');
      }
    } finally {
      clearTimeout(runTimer); // also on pause/AbortError — a dangling timer would kill the server later
    }
  }

  _enforceContextWindow(messages, modelId) {
    // Keep system message + last N messages that fit within context window.
    // Token estimation: modern models like qwen3.6 use ~1.5 chars/token for modern text.
    // Tool definitions and structured JSON use fewer chars per token.
    let charsPerToken = 1.5;
    if (modelId) {
      if (modelId.includes('qwen') || modelId.includes('llama')) charsPerToken = 1.5;
      else if (modelId.includes('phi') || modelId.includes('gemma')) charsPerToken = 1.8;
      else charsPerToken = 2.0; // conservative default
    }

    if (messages.length <= 2) return messages;

    const sys = messages.find(m => m.role === 'system');
    const rest = sys ? messages.filter(m => m !== sys) : messages.slice();

    let totalTokens = 0;
    let kept = [];
    for (let i = rest.length - 1; i >= 0; i--) {
      const m = rest[i];
      const chars = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
      const tokens = Math.ceil(chars / charsPerToken);
      if (totalTokens + tokens > this.contextWindow * 0.85) break; // leave 15% headroom
      kept.unshift(m);
      totalTokens += tokens;
    }

    // CRITICAL: Qwen3's chat template 500s with "No user query found in
    // messages" if the first non-system message is not a user message —
    // e.g., after a long session, truncation cuts mid-tool-loop leaving
    // leading assistant/tool fragments (or no user message at all).
    // Anchor the window at the first surviving user message.
    const firstUser = kept.findIndex(m => m.role === 'user');
    if (firstUser === -1) {
      const li = rest.map(m => m.role).lastIndexOf('user');
      kept = li !== -1 ? rest.slice(li) : kept;
    } else if (firstUser > 0) {
      kept = kept.slice(firstUser);
    }

    return sys ? [sys, ...kept] : kept;
  }

  async _callLM(messages, opts = {}) {
    // Build tool definitions for the API (only enabled tools)
    const allTools = [
      { type: 'function', function: { name: 'read', description: 'Read file contents. Args: path (string). Returns file content as string.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }},
      { type: 'function', function: { name: 'write', description: 'Write or overwrite a file. Args: path (string), content (string). Returns success message.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } }},
      { type: 'function', function: { name: 'edit', description: 'Find and replace text in a file. Args: path (string), oldText (string), newText (string). Returns success message.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } }},
      { type: 'function', function: { name: 'delete', description: 'Delete a file. Args: path (string). Returns success message or error.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }},
      { type: 'function', function: { name: 'exec', description: "Execute a shell command on the local machine where ismini runs (the user's own machine). Args: command (string). Returns stdout/stderr output.", parameters: { type: 'object', properties: { command: { type: 'string' }, sudo: { type: 'boolean' } }, required: ['command'], additionalProperties: false } }},
      { type: 'function', function: { name: 'web_search', description: 'Search the web (DuckDuckGo) and get readable results. Args: query (string). ALWAYS use this for web lookups instead of exec/curl.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }},
      { type: 'function', function: { name: 'web_fetch', description: 'Fetch a URL and return its readable text. Args: url (string). ALWAYS use this to read web pages instead of exec/curl.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } }},
    ];

    const tools = allTools.filter(t => this.enabledTools.includes(t.function.name));

    // Always prepend the full system prompt (config + persona)
    // System notes from mid-conversation injections are collected here and
    // appended to the leading system prompt (kept at position 0 for Qwen3).
    const _systemNotes = [];
    const apiMessages = [
      { role: 'system', content: this._fullSystemPrompt },
      ...messages.filter(m => !((m.role === 'system') && (typeof m.content === 'string') && (m.content === this._fullSystemPrompt))).map(m => {
        // Mid-conversation system messages are FOLDED into the leading system
        // prompt below — Qwen3's chat template rejects system messages after
        // position 0 with a 500 ("System message must be at the beginning").
        if (m.role === 'system') {
          _systemNotes.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
          return null;
        }
        // Assistant messages carrying tool_calls must be sent in OpenAI shape
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          return {
            role: 'assistant',
            content: (typeof m.content === 'string' && m.content) ? m.content : null,
            tool_calls: m.tool_calls
          };
        }
        return {
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.name ? { name: m.name } : {})
        };
      }).filter(m => m !== null)
    ];

    // Fold mid-conversation system notes into the leading system prompt
    if (_systemNotes.length) {
      apiMessages[0] = { role: 'system', content: this._fullSystemPrompt + '\n\n' + _systemNotes.join('\n') };
    }

    const url = `${this.baseUrl}/chat/completions`;
    const stream = opts.stream ?? false;
    const body = JSON.stringify({
      ...(this.modelId ? { model: this.modelId } : {}),
      messages: apiMessages,
      tools: tools,
      tool_choice: 'auto',
      stream: stream,
      max_tokens: this.maxTokens || 8192,
      // Disable reasoning/thinking. The REAL switch for Qwen3 on LM Studio is
      // chat_template_kwargs.enable_thinking=false (proven: 0 reasoning tokens).
      // The four string params below are the correct OFF values for providers
      // that read them (OpenClaw uses exactly these: thinkingDefault "off",
      // reasoningEffortMap off→"none", verboseDefault "off").
      reasoning: 'off',
      thinking: 'off',
      reasoning_effort: 'none',
      verbose: 'off',
      chat_template_kwargs: { enable_thinking: false },
      max_completion_tokens: this.maxTokens || 8192,
    });

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: opts.signal || AbortSignal.timeout(this.timeoutSeconds * 1000)
    });

    if (!resp.ok) {
      let errText;
      try { errText = await resp.text(); } catch { errText = '(empty response)'; }
      throw new Error(`LM Studio API error ${resp.status}: ${errText}`);
    }

    if (stream && resp.body) {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('event-stream') || contentType.includes('text/event')) {
        return this._streamResponse(resp, opts.onChunk);
      }
      // LM Studio may return JSON even with stream=true — fall through
    }

    const data = await resp.json();
    return data;
  }

  async _streamResponse(resp, onChunk) {
    // Stream response chunks and accumulate text + tool calls.
    // Returns the same structure as non-streaming for compatibility.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let accumulated = '';
    let chunkCount = 0;
    let apiError = null; // captured from SSE error payloads — thrown after the stream ends

    // Readability: insert blank lines between sections/lists/headings so the
    // output is never a wall of text. Streaming-safe (complete lines only).
    // The web UI receives already-formatted lines.
    const fmt = createLineFormatter((line) => {
      fullContent += line;
      if (onChunk) onChunk(line);
    });
    // Accumulate tool calls as {id, name, args} objects
    const toolCalls = []; // [{id, name, args}]
    let currentToolIdx = -1;
    let hasToolCall = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      accumulated += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = accumulated.split('\n');
      accumulated = lines.pop() || ''; // Keep incomplete line for next read

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const raw = trimmed.slice(6);
          const parsed = JSON.parse(raw);
          // Check for API errors (capture, not throw — throwing inside this try
          // would be swallowed by the catch below, hiding the real failure)
          if (parsed.error) {
            apiError = parsed.error.message || JSON.stringify(parsed.error);
            continue;
          }
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle text content chunks (routed through the line formatter)
          if (delta.content) {
            fmt.push(delta.content);
            chunkCount++;
          }

          // Handle tool call chunks
          if (delta.tool_calls && delta.tool_calls.length > 0) {
            hasToolCall = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? currentToolIdx;
              if (tc.id && idx !== currentToolIdx) {
                // New tool call
                currentToolIdx = idx;
                toolCalls.push({ id: tc.id, name: '', args: '' });
              }
              if (tc.function?.name) {
                // Guard: ensure currentToolIdx is valid
                if (currentToolIdx < 0 || currentToolIdx >= toolCalls.length) {
                  currentToolIdx = 0;
                  toolCalls.push({ id: '', name: tc.function.name, args: '' });
                } else {
                  toolCalls[currentToolIdx].name += tc.function.name;
                }
              }
              if (tc.function?.arguments) {
                // Guard: ensure currentToolIdx is valid
                if (currentToolIdx < 0 || currentToolIdx >= toolCalls.length) {
                  currentToolIdx = 0;
                  toolCalls.push({ id: '', name: '', args: tc.function.arguments });
                } else {
                  toolCalls[currentToolIdx].args += tc.function.arguments;
                }
              }
            }
          }
        } catch (parseErr) {
          // Silently skip malformed SSE lines
        }
      }
    }

    // Surface API errors (e.g. llama.cpp chat-template 500s) instead of
    // silently returning empty content.
    if (apiError) {
      throw new Error(apiError);
    }

    // Parse accumulated args JSON for each tool call
    for (const tc of toolCalls) {
      try {
        tc.parsedArgs = JSON.parse(tc.args || '{}');
      } catch {
        tc.parsedArgs = {};
      }
    }

    // Emit any trailing line held by the formatter
    fmt.flush();

    // Return a structure compatible with non-streaming path
    return {
      choices: [{
        message: {
          content: fullContent,
          tool_calls: hasToolCall ? toolCalls : null,
        }
      }]
    };
  }

  async _executeTool(name, args) {
    const impl = TOOL_MAP[name];
    if (!impl) return `Unknown tool: ${name}`;

    // Pass context-specific params based on tool type
    if (name === 'exec') return await impl(args, this.timeoutSeconds, this.allowSudo);
    if (['read', 'write', 'edit'].includes(name)) return await impl(args, this.workspace, this._contextDir);
    return await impl(args);
  }
}
