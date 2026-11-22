// agent.js — Core agent loop: prompt → llama.cpp → tools → repeat
// Zero dependencies beyond Node.js built-ins.
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, realpathSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, extname, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fetch as webFetch } from './tools/web-fetch.js';
import { weather as weatherTool } from './tools/weather.js';
import { MAX_MEMORIES, MAX_TEXT_LENGTH } from './memory.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Diagnostic logger (NEVER stdout) ────────────────────────────────────────
// web.js intercepts process.stdout.write during a turn and broadcasts ANY line that
// isn't on its small blocklist straight to the chat UI. So a console.log() from here
// leaks onto the user's screen (this is exactly how an earlier '[tool-call] …' debug
// line showed up in the conversation). Diagnostics must go to a log file instead.
const DIAG_LOG_FILE = join(__dirname, 'ismini-diag.log');
function diagLog(...parts) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DIAG_LOG_FILE, `[${ts}] ` + parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');
  } catch { /* never let logging break the agent */ }
}

// ── Inactivity timeout for streaming model calls ────────────────────────
// Two-phase inactivity watchdog. The FIRST phase covers prompt processing — when
// llama.cpp is chewing through a large prompt (a heavy multi-file audit can push the
// prompt to 50k+ tokens), it emits NO output chunks for minutes, and the old single
// 2-minute timer would abort that as "inactivity" even though the model was working
// hard. So the pre-first-token wait gets a long allowance (default 10 min); once the
// first token streams in, we switch to the short between-tokens timeout (2 min), which
// is what actually catches a genuinely hung generation.
const MODEL_FIRST_TOKEN_TIMEOUT_MS = 600000; // 10 min to get the FIRST token (big-prompt processing)
const MODEL_INACTIVITY_TIMEOUT_MS = 120000;  // 2 min of silence AFTER tokens start → give up

// ── Exact token counting via llama-server's built-in /tokenize endpoint ────────
// The old budget math estimated tokens as chars/rate (a heuristic that over-counts
// normal code ~50% and under-counts base64/CJK). llama-server exposes POST /tokenize
// by default, so we can get EXACT counts with zero extra dependencies. We prime a
// cache asynchronously before each budget pass; tok() reads it and falls back to the
// heuristic (which now ALSO counts tool_calls — see _enforceContextWindow).
const tokKey = (s) => createHash('sha1').update(s).digest('base64');
// A message's countable text: its content PLUS any tool_calls args. Round-1 made
// history store REAL (large) tool-call arguments, so a 30 KB write payload must be
// budgeted — the old code counted it as ~4 tokens (a new overflow vector).
const msgText = (m) =>
  (typeof m.content === 'string' ? m.content : '') +
  (Array.isArray(m.tool_calls) ? '\n' + JSON.stringify(m.tool_calls) : '');

function raceWithInactivity(promise, { abort, onWatchdogAbort } = {}) {
  let timer;
  let settled = false;
  let started = false; // has the first output token arrived?
  let resolve, reject;
  const clear = () => clearTimeout(timer);
  const settle = (fn, val) => { if (!settled) { settled = true; clear(); fn(val); } };
  const currentTimeout = () => started ? MODEL_INACTIVITY_TIMEOUT_MS : MODEL_FIRST_TOKEN_TIMEOUT_MS;
  const reset = () => {
    clear();
    timer = setTimeout(() => {
      if (settled) return; // local guard: makes the no-double-settle invariant explicit
      settle(reject, new Error(`Model inactivity timeout (${currentTimeout() / 1000}s with no output)`));
      if (abort) { try { abort(); } catch {} }
      // Tell the caller THIS abort came from the watchdog (not a user Pause or the
      // run timer), so run() can summarize what we have instead of going silent.
      if (onWatchdogAbort) { try { onWatchdogAbort(); } catch {} }
    }, currentTimeout());
    if (timer.unref) timer.unref();
  };
    const promise2 = new Promise((res, rej) => {
      resolve = res; reject = rej;
      reset();
      promise.then(
        (v) => settle(resolve, v),
                   (e) => settle(reject, e)
      );
    });
    // `activity` is called on every streamed chunk. The FIRST call flips us into the
    // short between-tokens timeout; subsequent calls just keep it alive.
    return { promise: promise2, activity: () => { if (!settled) { started = true; reset(); } } };
}

// ── Suppress repeated tool lists in model output ───
function stripRepeatedToolList(text, prevAssistantMsgs) {
  if (!text || !prevAssistantMsgs || prevAssistantMsgs.length < 2) return text;
  const lastTwo = prevAssistantMsgs.slice(-2).map(m => typeof m === 'string' ? m : (m.content || ''));
  const hasToolBlock = (t) => {
    return t.includes('tool_calls') || t.includes('tool_call') ||
    t.includes('function.name') || t.includes('function.arguments') ||
    (t.includes('read(') && t.includes('write(') && t.includes('exec('));
  };
  if (!hasToolBlock(lastTwo[0]) || !hasToolBlock(lastTwo[1])) return text;
  const lines = text.split('\n');
  const strippedLines = [];
  let foundToolBlock = false;
  let inToolBlock = false;
  for (const line of lines) {
    if (/^\*\*[Tt]ools\*\*/.test(line)) {
      inToolBlock = true;
      foundToolBlock = true;
      continue;
    }
    if (line.trim().startsWith('`')) {
      if (!inToolBlock) strippedLines.push(line);
      else inToolBlock = false;
      continue;
    }
    if (inToolBlock) continue;
    strippedLines.push(line);
  }
  if (foundToolBlock) return strippedLines.join('\n').trim();
  return text;
}

// ── Model output cleanup — strip filler patterns ───
function cleanupModelOutput(text) {
  if (!text) return text;
  let cleaned = text.trim();
  const originalLen = cleaned.length;
  const LEADING_GREETINGS = [
    /^(?:hello|hi|hey)\s*[!,.]?\s+/i,
    /^(?:i'?m\s+)?ismini[.,!?]?\s+/i,
  ];
  for (const pat of LEADING_GREETINGS) {
    const m = cleaned.match(pat);
    if (m && m[0].length < cleaned.length) cleaned = cleaned.replace(pat, '');
  }
  const TRAILING_FILLER = [
    /\s*[,-]?\s*how can i help( you)?[?.!?]?$/i,
    /\s[,-]?\s*what can i do for you[?.!?]?$/i,
    /\s[,-]?\s*(?:anything else|else)[?.!?]?$/i,
    /\s*[,-]?\s*let me know if you need (?:anything|more)[?.!?]?$/i,
  ];
  for (const pat of TRAILING_FILLER) {
    const before = cleaned.replace(pat, '').trim();
    const isSubstantive = before.length >= 10 && /\s/.test(before);
    if (isSubstantive && before.length < originalLen) cleaned = before;
  }
  return cleaned.trim();
}

// ── Strip ismini's OWN internal system-note markers from final text ───
// Under a very large prompt a local model can occasionally ECHO an internal note it saw
// in context back into its reply (e.g. the "[SYSTEM NOTE] …" or "[HARD STOP] …" strings,
// or even a line of agent.js source it was reading). These are never meant to reach the
// user. We strip any line that is (or starts with) one of our internal markers, and drop
// bare marker fragments, so a forced summary / normal answer never leaks scaffolding text.
function stripInternalNotes(text) {
  if (!text || typeof text !== 'string') return text;
  const MARKERS = ['[HARD STOP]', '[SYSTEM NOTE]', '[SYSTEM]', '[ismini]', '[NEED ANSWER]'];
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    // Drop a line that IS an internal note, or one that merely comments on such a leak
    // ("that looks like it leaked from ismini's internal message template").
    if (MARKERS.some(mk => t.startsWith(mk))) continue;
    if (/leaked? from ismini'?s internal/i.test(t)) continue;
    out.push(line);
  }
  // Collapse any 3+ blank lines the removal may have created.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Streaming tool-call markup stripper ─────────────────────────────
// Some models (e.g. Gemma) emit tool calls as TEXT — `antml:invoke`,
// `antml:function`, `antml:parameter`, `antml:content` — instead of native
// tool_calls. If that text is streamed to the UI it shows on screen AND gets
// read aloud by TTS, then the turn stalls (the markup isn't a real tool call).
// This strips any tool-call markup from the *streamed* text so the user only
// ever sees ismini's natural speech. It is streaming-safe: it buffers across
// chunk boundaries and never emits a line that contains a tool tag.
function createToolMarkupStripper(onText) {
  let buf = '';
  // Catch ALL tool-call markup formats:
  //   antml:invoke, antml:function, antml:parameter, antml:content, …
  //   <function=read>, <function=exec>, <parameter name=…>, </function>
  //   <tool_call>, <tool_result>, <invoke name=…>
  const TAG = /(?:antml:(?:invoke|function|parameter|content|return|result|output|input|tool|call)|<(?:\/?)(?:function|parameter|tool_call|tool_result|invoke|return|result|output|input)[\s>=\/])/gi; // /g: a line can hold >1 tag; without it replace() leaks the 2nd
  const emitLine = (line) => {
    if (!line.trim()) { onText('\n'); return; }
    // If the line is entirely a short tool-tag, drop it.
    if (TAG.test(line) && line.trim().length <= 40) return;
    // Otherwise strip any embedded tool-tag fragments from the line.
    let cleaned = line.replace(TAG, '').replace(/\s{2,}/g, ' ').trim();
    if (!cleaned) return; // line was only markup
    onText(cleaned + '\n');
  };
  const push = (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    // Hold the last line: it may be a partial tag split across chunks.
    buf = lines.pop();
    for (const line of lines) emitLine(line);
  };
  const flush = () => {
    if (buf) { emitLine(buf); buf = ''; }
  };
  return { push, flush };
}

function isToolError(name, result) {
  if (typeof result !== 'string' || !result) return false;
  // "Missing required arg" errors are the MODEL's fault (bad tool-call args),
  // not a tool failure. Do NOT count them toward the tool-fail streak —
  // otherwise the model gets a "tool has failed 3 times" note for its own
  // mistake, which confuses it and wastes a turn.
  const isMissingArg = /^Error: "[\w]+" required\b/.test(result);
  if (isMissingArg) return false;
  switch (name) {
    case 'web_search':
      return /^Search failed\b|^Web search error\b|^Error\b/.test(result);
    case 'web_fetch':
      return /^Fetch error\b|^HTTP \d{3}\b|^Error\b/.test(result);
    case 'weather':
      return /^Weather (geocoding|fetch) failed\b|^Weather data unavailable\b|^Could not find location\b|^Error\b/.test(result);
    case 'read':
      return /^Error reading file\b/.test(result);
    case 'exec':
      return /^Error executing\b|^Blocked\b/.test(result)
      || /\[Process exited with code [1-9]\d*\]/.test(result);
    case 'write':
    case 'edit':
    case 'delete':
    default:
      return /^Error\b/.test(result);
  }
}

// ── Streaming line formatter — readable paragraph/section spacing ───
function createLineFormatter(onLine) {
  let buf = '';
  let prevLine = '';
  let prevType = 'start';
  let blankRun = 0;
  let started = false;
  let inCode = false;

  const isHead = (t) => /^#{1,6}(\s|$)/.test(t);
  const isList = (t) => /^([-*+]|\d+\.)\s/.test(t);
  const isCode = (t) => t.startsWith('`');
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
    t = t.replace(/^([-*+])(\S)/, '$1 $2').replace(/^(\d+\.)(\S)/, '$1 $2');
    if (!t.includes('://')) {
      t = t.replace(/^([A-Za-z]{2,}[\w-]{0,30}):([^\s/:])/, '$1: $2');
      t = t.replace(/^([-*+]\s|\d+\.\s)([A-Za-z]{2,}[\w-]{0,30}):([^\s/:])/, '$1$2: $3');
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
    if (line.trim().startsWith('`')) inCode = !inCode;
    if (inCode) {
      prevLine = line; prevType = 'code'; blankRun = 0; started = true;
      onLine(line + '\n');
      return;
    }
    const m = line.match(/(\S)(#{2,6}\s)/);
    if (m) {
      emit(line.slice(0, m.index + 1));
      emit(line.slice(m.index + 1));
      return;
    }
    const m2 = line.match(/^(#{1,6}\s\S[^\n]*?)([-*+])(?=\s+\S)/);
    if (m2) {
      const marker = m2[2];
      const before = m2[1].slice(-1);
      const after = line[m2.index + m2[0].length];
      const isMarkup = (before === marker) || (after === marker);
      if (!isMarkup) {
        emit(line.slice(0, m2[1].length));
        emit(line.slice(m2[1].length));
        return;
      }
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
const SENSITIVE_PATTERNS = [
  '/.ssh/', '/.gnupg/', '/.gnome/',
'/.config/google-chrome/', '/.config/firefox/', '/.mozilla/',
'/authorized_keys', '/id_rsa', '/id_ed25519', '/known_hosts',
// Anchored to /etc/ so a user's OWN file named e.g. 'shadow' or 'notes/passwd'
// is NOT blocked (the bare names would false-positive via endsWith). These guard
// only the real system credential files.
'/etc/shadow', '/etc/passwd', '/etc/group', '/etc/sudoers'
];

function resolveUserPath(p, workspace) {
  if (typeof p !== 'string' || !p) return null;
  let path = p.trim();
  let basePath;
  if (workspace && isAbsolute(workspace)) basePath = workspace;
  else basePath = homedir();
  if (path === '~') return homedir();
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else path = isAbsolute(path) ? path : join(basePath, path);
  const resolved = path;
  let canonical;
  try {
    if (existsSync(resolved)) canonical = realpathSync(resolved);
    else {
      const parentDir = dirname(resolved);
      const baseName = basename(resolved);
      if (existsSync(parentDir)) canonical = join(realpathSync(parentDir), baseName);
      else canonical = resolved;
    }
  } catch { return null; }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (canonical.includes(pattern)) return null;
    } else {
      if (canonical === pattern || canonical.endsWith(pattern) || canonical.includes(pattern + '/')) return null;
    }
  }
  if (/^\/(etc|boot|sys|proc|dev)\//.test(canonical)) return null;
    const home = homedir();
  const workspacePath = workspace && isAbsolute(workspace) ? workspace : home;
  if (!canonical.startsWith(home) && !canonical.startsWith(workspacePath)) return null;
  return canonical;
}

// Hard cap on a single tool result. Kept small on purpose: ismini targets small
// local models (often 16k context), and one 200 KB exec dump used to be ~50k
// tokens on its own — enough to overflow the whole context in one message.
// 48 KB still holds far more than any realistic answer; the rolling window then
// keeps many such results within the model's budget instead of one blowing it up.
const MAX_TOOL_OUTPUT = 48 * 1024;

function capToolOutput(text) {
  if (typeof text !== 'string' || text.length <= MAX_TOOL_OUTPUT) return text;
  const head = Math.floor(MAX_TOOL_OUTPUT * 0.7);
  const tail = MAX_TOOL_OUTPUT - head;
  return text.slice(0, head)
  + `\n... [truncated ${text.length - MAX_TOOL_OUTPUT} chars — output exceeded the ${MAX_TOOL_OUTPUT / 1024} KB cap] ...\n`
  + text.slice(text.length - tail);
}

// Tiny one-line header stored with every tool result so the model can SEE what it
// already did, even when the rolling window evicts the (large) body. Without this,
// a big read/exec disappears from context and the model re-runs the same action in
// an infinite loop ("let me read them… let me read them…"). Kept to ~60 chars so it
// always fits.
function toolResultHeader(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const target = a.path || a.file || a.url || a.query || a.location || a.command || a.cmd || a.name || '';
  const t = String(target || '').replace(/\s+/g, ' ').trim();
  return `[${name}${t ? ' ' + t.slice(0, 60) : ''}]`;
}

async function toolRead(args, workspace) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  try {
    const resolved = resolveUserPath(p, workspace);
    if (resolved === null) return 'Error: Access denied to this path.';
    const ext = extname(resolved).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.ico', '.avif'].includes(ext)) {
      return 'Images cannot be analyzed by reading their file path. Attach the image in chat so the loaded model can inspect it.';
    }
    if (['.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.bin', '.so', '.dylib', '.dll', '.o', '.a', '.class', '.jar', '.war', '.ear', '.pyc', '.wasm', '.mp3', '.mp4', '.avi', '.mkv', '.flac', '.ogg', '.wav', '.mid', '.m4a', '.webm', '.mov', '.psd', '.ai', '.skp', '.blend', '.fig', '.xd'].includes(ext)) {
      return `This is a binary file (${ext}) and cannot be read as text. Use exec with appropriate tools (e.g. 'pdftotext', 'unzip -l', 'file') to inspect it.`;
    }
    const content = readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    if (lines.length > 10000) {
      return capToolOutput(`File has ${lines.length} lines. Showing first 10000:\n\n${lines.slice(0, 10000).join('\n')}\n... [truncated]`);
    }
    return capToolOutput(content);
  } catch (err) { return `Error reading file: ${err.message}`; }
}

async function toolWrite(args, workspace) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  if (args.content === undefined && args.text === undefined) return 'Error: "content" or "text" required.';
  try {
    const resolved = resolveUserPath(p, workspace);
    if (resolved === null) return 'Error: Access denied to this path.';
    const body = String(args.content ?? args.text);
    // append:true ADDS to the file instead of truncating it — the working "notes"
    // path for batch tasks. Without it every write overwrote the previous findings.
    if (args.append === true) {
      appendFileSync(resolved, body, 'utf8');
      return `Appended ${body.length} chars to ${p}`;
    }
    writeFileSync(resolved, body, 'utf8');
    return `Wrote ${body.length} chars to ${p}`;
  } catch (err) { return `Error writing file: ${err.message}`; }
}

async function toolEdit(args, workspace) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  if (!args.oldText) return 'Error: "oldText" is required and must be a non-empty string.';
  if (args.newText === undefined) return 'Error: "newText" is required.';
  // NO-OP GUARD: oldText === newText changes nothing, yet the replace below would
  // still report success — and a small model that emits identical text (a generation
  // slip on repetitive files like memory.md) then believes it saved and tells the user
  // "Done" when nothing happened. Reject it explicitly so the failure is visible in
  // context and the model must re-issue with actually-different text.
  if (typeof args.newText === 'string' && args.newText === args.oldText) {
    return 'Error: no-op edit — oldText and newText are IDENTICAL, so nothing was changed. Write DIFFERENT text in newText (the new content you actually want), then call edit again.';
  }
  try {
    const resolved = resolveUserPath(p, workspace);
    if (resolved === null) return 'Error: Access denied to this path.';
    let content = readFileSync(resolved, 'utf8');
    if (!content.includes(args.oldText)) return 'Error: oldText not found in file.';
    const matches = content.split(args.oldText).length - 1;
    if (args.replaceAll === true) {
      content = content.split(args.oldText).join(args.newText);
    } else {
      const idx = content.indexOf(args.oldText);
      content = content.slice(0, idx) + args.newText + content.slice(idx + args.oldText.length);
    }
    writeFileSync(resolved, content, 'utf8');
    if (args.replaceAll === true) return `Edited ${p} (${matches} occurrence(s) replaced — replaceAll)`;
    const remaining = matches - 1;
    return remaining > 0
    ? `Edited ${p} (replaced first of ${matches} occurrences; ${remaining} still present — use replaceAll:true to change all, or a more specific oldText)`
    : `Edited ${p} (1 occurrence replaced)`;
  } catch (err) { return `Error editing file: ${err.message}`; }
}

let activeChild = null;

function collectProcessTree(rootPid) {
  // FIX: single /proc pass. The old code re-scanned ALL of /proc on every BFS level
  // (O(levels × nproc)); on a 1000+ process box that's wasteful on the kill path.
  // Build a ppid→children map once, then traverse in memory (O(nproc) total).
  const kids = new Map();
  try {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      let stat;
      try { stat = readFileSync(`/proc/${d}/stat`, 'utf8'); } catch { continue; }
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const pid = Number(d);
      const a = kids.get(ppid) || [];
      a.push(pid); kids.set(ppid, a);
    }
  } catch {}
  const out = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    for (const c of (kids.get(stack.pop()) || [])) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

export function killActiveChild() {
  const c = activeChild;
  activeChild = null;
  if (!c || !c.pid) return;
  const pids = collectProcessTree(c.pid);
  const eperm = [];
  try { process.kill(-c.pid, 'SIGTERM'); } catch {}
  for (const p of pids) {
    try { process.kill(p, 'SIGTERM'); }
    catch (e) { if (e && e.code === 'EPERM') eperm.push(p); }
  }
  setTimeout(() => {
    try { process.kill(-c.pid, 'SIGKILL'); } catch {}
    for (const p of pids) {
      try { process.kill(p, 'SIGKILL'); } catch {}
    }
  }, 2000).unref();
  if (eperm.length) {
    try {
      const k = spawn('sudo', ['-n', 'kill', '-15', ...eperm.map(String)], { stdio: 'ignore' });
      k.unref();
    } catch {}
    setTimeout(() => {
      try {
        const k = spawn('sudo', ['-n', 'kill', '-9', ...eperm.map(String)], { stdio: 'ignore' });
        k.unref();
      } catch {}
    }, 2000).unref();
  }
}

// Dangerous commands are always blocked. Forced package installs (apt -y etc.)
// are allowed ONLY when the sudo toggle is on — checked separately so they can
// never bypass the other patterns.
const APT_FORCE_INSTALL = /\b(?:apt-get|apt|dpkg|yum|dnf|pacman|apk)\b[\s\S]*\s(?:-y|--yes)(?=\s|$)/;

const DANGEROUS_PATTERNS = [
  /\brm\b[^>]*\s\/dev\//,
/\brm\b[\s\S]*--no-preserve-root/,
/\brm\s+(-[a-z]+\s+)*(~|\/\*|\/(?:home|root|etc|boot|usr|bin|sbin|lib|var|dev|proc|sys|tmp)?)(?:$|\s)/,
/\brm\s+(-[a-z]+\s+)*\$\{?HOME\}?/,
/\bfind\s+\/\s+[\s\S]*-delete\b/,
/(?:^|[;&|]\s*)(?:sudo\s+)?mkfs(?:\.\w+)?\b/,
/\bdd\b[\s\S]*\bof=\/dev\//,
/\bshred\b[\s\S]*\/dev\//,
/[>&]+\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme|mmcblk|xvd)/,
/(?:^|[;&|(]\s*)(?:sudo\b[\s\S]*?\s+)?(?:\/sbin\/|\/usr\/sbin\/)?(?:reboot|shutdown|poweroff|halt)\b/i,
  /(?:^|[;&|(]\s*)telinit\s+[06]\b/,
    /(?:^|[;&|(]\s*)init\s+[06]\b/,
      /systemctl\s+(?:reboot|poweroff|halt)\b/,
      /\bsed\s+-i[\s\S]*\/dev\//,
      /\bchmod\b[\s\S]*0?777\s+\/(?:$|\s)/,
      /(?:^|[;&|]\s*)(?:sudo\s+)?wipefs\b/,
      /(?:^|[;&|]\s*)(?:sudo\s+)?(?:ddrescue|cl-cleaner)\b/,
      /:\(\)\s*\{[^}]*[|&][^}]*\}/, // fork bomb
];

async function toolExec(args, timeoutSecs, allowSudo) {
  let cmd = args.command || args.cmd || args.text;
  if (!cmd && args && typeof args === 'object') {
    for (const key of Object.keys(args)) {
      if (typeof args[key] === 'string' && args[key].trim() && !['command', 'cmd', 'text', 'sudo', 'timeout', 'args'].includes(key.toLowerCase())) {
        cmd = args[key];
        break;
      }
    }
  }
  if (!cmd) return `Error: "command" required. Received args: ${JSON.stringify(args)}`;
  if (APT_FORCE_INSTALL.test(cmd) && !allowSudo) return `Blocked dangerous command: ${cmd}`;
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(cmd)) return `Blocked dangerous command: ${cmd}`;
  }
  const WEB_CMD = /(?:^|[;&|(]\s*)(?:sudo\b[\s\S]*?\s+)?(?:curl|wget)\b/;
  if (WEB_CMD.test(cmd)) {
    return 'Blocked: web requests go through the web_fetch and web_search tools, not exec (exec runs with sudo and breaks them). Use web_fetch with the URL, or web_search for a query.';
  }
  if (!allowSudo) {
    if (/^sudo(\s|$)/.test(cmd)) {
      cmd = cmd.replace(/^sudo(?:\s+-[a-zA-Z]\s+\S+|\s+-[a-zA-Z]+)\s*/, '').trim();
      if (!cmd) return 'Blocked: sudo is disabled (toggle OFF) and there is no command left to run.';
    }
  }
  // FIX: sudo is OPT-IN per command. The old default-on (`|| !('sudo' in args)`) ran
  // EVERY command as root whenever the toggle was on — `ls`, `cat`, a typo'd `rm` all
  // executed with full privileges. Now the model must explicitly pass sudo:true (the
  // schema says so), and the sudo-password hint already teaches it to retry elevated.
  const useSudo = allowSudo && args.sudo === true;
  if (useSudo) {
    const cleanCmd = cmd.replace(/^sudo\s+(-[a-zA-Z]+\s+)*/, '').trim();
    // FIX: JSON.stringify does NOT escape $ or backticks, which the OUTER sh -c would
    // expand before sudo sees them. Use POSIX single-quote escaping (only ' needs care).
    const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    cmd = `sudo -n sh -c ${shq(cleanCmd)}`;
  }
  try {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activeChild = child;
      const MAX = 1024 * 1024;
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
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
          if (/a password is required|no tty present|must be run from a terminal|not in the sudoers file|I'm afraid I can't do that/i.test(stderr)) {
            out += [
              '',
              '[ismini: this command needs root, but this user cannot use sudo without a password.]',
              'ismini runs commands as your normal user by default. To run a specific command with elevated privileges,',
              'run it yourself in a terminal (where you can type the password), or enable the sudo toggle and',
               'make sure this account is allowed to use sudo for that command.',
               'Note: do NOT grant blanket passwordless root (e.g. "NOPASSWD: ALL") — that would let any',
               'command ismini runs become root without a prompt, which is unsafe.',
            ].join('\n');
          } else {
            out += stderr;
          }
        }
        if (signal) {
          out += `\n[ismini: command was killed (${signal}) — Pause pressed or run timeout reached]`;
        } else if (failed) {
          out += `\n[Process exited with code ${code}]`;
        }
        resolve(capToolOutput(out) || 'Command completed.');
      });
    });
  } catch (err) { return `Error executing: ${err.message}`; }
}

async function toolWebSearch(args) {
  let q = '';
  if (typeof args === 'string') {
    q = args;
  } else if (args && typeof args === 'object') {
    q = args.query || args.q || args.search || args.text || args.input || args.prompt || '';
    if (!q) {
      // Fall back to the first non-empty string value, whatever the key is called
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.trim()) { q = v; break; }
      }
    }
  }
  q = (q || '').trim();
  if (!q) {
    // The model issued web_search but its argument JSON arrived empty/malformed
    // (a known weakness of smaller/quantized models on some phrasings). The old
    // message — 'Error: "query" required.' — gave the model NO clue that its own
    // JSON was empty, so it re-issued the identical call forever (the loop tasos
    // saw). Tell it exactly what to do and give it a concrete fallback so the turn
    // always makes forward progress instead of stalling.
    diagLog('[web_search] empty/malformed args — model must re-issue. raw=', JSON.stringify(args));
    return 'Error: web_search was called with an EMPTY query — your tool-call arguments were not valid JSON (or the "query" field was missing/empty). Re-issue web_search with proper JSON, e.g. {"query": "your search terms here"}. If you cannot form a valid query, do NOT call web_search again — answer the user directly from what you already know.';
  }
  try {
    const { search } = await import('./tools/web-search.js');
    return await search(q);
  } catch (err) { return `Web search error: ${err.message}`; }
}

async function toolWebFetch(args) {
  const a = args && typeof args === 'object' ? args : {};
  const u = a.url || a.uri;
  if (!u) return 'Error: "url" required.';
  try { return await webFetch(String(u)); }
  catch (err) { return `Fetch error for ${u}: ${err?.message || String(err)}`; }
}

async function toolWeather(args) {
  const a = args && typeof args === 'object' ? args : {};
  const loc = a.location || a.place;
  if (!loc) return 'Error: "location" required.';
  try { return await weatherTool(loc); }
  catch (err) { return `Weather fetch failed: ${err.message}`; }
}

async function toolDelete(args, workspace) {
  const p = args.path;
  if (!p) return 'Error: "path" required.';
  try {
    const resolved = resolveUserPath(p, workspace);
    if (resolved === null) return 'Error: Access denied to this path.';
    const st = statSync(resolved);
    if (st.isDirectory()) return `Error: "${p}" is a directory. Use exec with 'rm -rf' to delete directories.`;
    unlinkSync(resolved);
    return `Deleted ${p}`;
  } catch (err) { return `Error deleting file: ${err.message}`; }
}

async function toolMemoryAdd(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const text = args.text || args.content;
  if (!text) return 'Error: "text" required.';
  try {
    const res = memory.add(text, args.category);
    // add() returns null for whitespace-only input ('   ' passes the truthy check
    // above but trims to empty) — guard so we don't throw on destructuring.
    if (!res || !res.memory) return 'Error: "text" required (empty after trimming).';
    const { memory: m, evicted, persisted, truncated } = res;
    let msg = `Saved memory ${m.id}: ${m.text}`;
    // A failed disk write used to be reported as "Saved" — surface it so the model
    // tells the user the note will be lost on restart instead of lying about it.
    if (persisted === false) msg += ' — WARNING: could not write memory.json to disk; this will be lost on restart. Tell the user.';
    if (truncated) msg += ` — NOTE: text exceeded ${MAX_TEXT_LENGTH} chars and was cut. Save the full detail to a file if it matters.`;
    if (evicted) msg += `— NOTE: memory was full (${MAX_MEMORIES} max), so the least-recently-used entry was dropped: "${evicted.text}" (${evicted.id}). Mention this to the user.`;
    return msg;
  } catch (err) { return `Memory error: ${err.message}`; }
}

async function toolMemorySearch(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const q = args.query || '';
  try {
    // Clamp the limit so a model asking for limit:200 can't dump the whole store
    // (~60 KB / ~20k tokens) into one tool result. memory.search clamps to [1,20].
    const lim = Math.min(Math.max(1, Number(args.limit) || 5), 20);
    const results = await memory.search(q, lim);
    if (!results.length) return 'No matching memories found.';
    return results.map((m, i) => `${i + 1}. [${m.id}] ${m.text}${m.category ? ` (${m.category})` : ''}`).join('\n');
  } catch (err) { return `Memory error: ${err.message}`; }
}

// Recall: keyword-search across ALL past sessions and surface matching messages.
async function toolRecall(args, sessions) {
  if (!sessions || typeof sessions.search !== 'function') return 'Recall is unavailable (no session archive).';
  const q = args.query || args.q || '';
  if (!q || !q.trim()) return 'Error: "query" required for recall.';
  try {
    const results = sessions.search(q, Number(args.limit) || 8);
    if (!results.length) return `No past-session messages matched "${q}". Try broader keywords.`;
    const fmt = (t) => (t.length > 400 ? t.slice(0, 400) + ' …' : t);
    return results.map((r, i) => {
      const d = new Date(r.sessionDate).toISOString().slice(0, 10);
      return `${i + 1}. [${r.role} · ${d} · session ${r.sessionId.slice(0, 8)}]\n${fmt(r.text)}`;
    }).join('\n\n');
  } catch (err) { return `Recall error: ${err.message}`; }
}

async function toolMemoryDelete(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const id = args.id;
  if (!id) return 'Error: "id" required.';
  try {
    const res = memory.delete(id);
    if (!res || !res.deleted) return `Memory not found: ${id}`;
    let msg = `Deleted memory ${id}`;
    if (res.persisted === false) msg += ' — WARNING: could not write memory.json to disk; the deletion will be lost on restart. Tell the user.';
    return msg;
  } catch (err) { return `Memory error: ${err.message}`; }
}

// ── Skill shelf: reusable "how I fixed X" recipes, one file per skill ────
// Actions: list (titles + summaries), read (full text of one), save (write a
// new skill file), delete (remove one). Saving is confirm-gated by the caller.
function skillsDirReady(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function skillFileFor(dir, name) {
  // Sanitize the name to a safe file stem (no path traversal, no weird chars).
  const safe = String(name || '').trim().replace(/[^a-zA-Z0-9-_ ]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!safe) return null;
  return join(dir, safe.toLowerCase() + '.md');
}
function firstHeading(content) {
  const m = String(content || '').match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}
function firstSummary(content) {
  // First non-heading, non-empty line = the one-line summary shown in `list`.
  for (const line of String(content || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }
  return '';
}

async function toolSkills(args, skillsDir) {
  const dir = skillsDirReady(skillsDir);
  const action = (args.action || args.cmd || '').toLowerCase();

  if (action === 'list' || action === '') {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { files = []; }
    if (!files.length) return 'The skill shelf is empty. After you solve a non-trivial problem, offer to save it as a reusable skill.';
    const lines = files.map((f) => {
      let title = f.replace(/\.md$/, '');
      let summary = '';
      try {
        const content = readFileSync(join(dir, f), 'utf8');
        const h = firstHeading(content); if (h) title = h;
        summary = firstSummary(content);
      } catch {}
      return `- ${title}${summary ? ' — ' + summary : ''}`;
    });
    return `Skill shelf (${files.length} skill${files.length > 1 ? 's' : ''}):
${lines.join('\n')}

Use action "read" with a skill name to see its full steps.`;
  }

  if (action === 'read') {
    const name = args.name || args.skill;
    if (!name) return 'Error: "name" required to read a skill.';
    const file = skillFileFor(dir, name);
    if (!file || !existsSync(file)) {
      let files = [];
      try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch {}
      return `No skill named "${name}". Available: ${files.map((f) => f.replace(/\.md$/, '')).join(', ') || '(none yet)'}.`;
    }
    return readFileSync(file, 'utf8');
  }

  if (action === 'save') {
    const name = args.name || args.skill;
    const content = args.content || args.text;
    if (!name) return 'Error: "name" required to save a skill.';
    if (!content || !String(content).trim()) return 'Error: "content" required to save a skill.';
    const file = skillFileFor(dir, name);
    if (!file) return 'Error: invalid skill name (use letters, numbers, hyphens).';
    // Ensure the file has a title heading so `list` shows something useful.
    let body = String(content).trim();
    if (!/^\s*#\s+/.test(body)) body = `# ${String(name).trim()}\n\n` + body;
    writeFileSync(file, body + '\n', 'utf8');
    return `Saved skill "${String(name).trim()}" to skills/${file.split('/').pop()}. It will be available in future sessions.`;
  }

  if (action === 'delete') {
    const name = args.name || args.skill;
    if (!name) return 'Error: "name" required to delete a skill.';
    const file = skillFileFor(dir, name);
    if (!file || !existsSync(file)) return `No skill named "${name}" to delete.`;
    unlinkSync(file);
    return `Deleted skill "${String(name).trim()}".`;
  }

  return `Unknown skill action "${action}". Use: list, read, save, delete.`;
}

const TOOL_MAP = {
  read: toolRead,
  write: toolWrite,
  edit: toolEdit,
  exec: toolExec,
  delete: toolDelete,
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
  weather: toolWeather,
  memory_add: toolMemoryAdd,
  memory_search: toolMemorySearch,
  memory_delete: toolMemoryDelete,
  recall: toolRecall,
  skills: toolSkills,
};

// ── Tool call parser (handles both OpenAI and llama.cpp formats) ───
function parseToolCalls(message) {
  const calls = [];
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let fnName, fnArgs;
      if (tc.name !== undefined && tc.parsedArgs !== undefined) {
        fnName = tc.name || '';
        fnArgs = tc.parsedArgs || {};
      } else {
        try {
          fnName = tc.function?.name || '';
          fnArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch { fnName = ''; fnArgs = {}; }
      }
      calls.push({ id: tc.id, name: fnName, args: fnArgs, argsError: tc.argsError });
    }
  }
  // (Legacy `message.tool` / `message.function_call` formats were removed — llama.cpp
  // only ever emits `tool_calls`, so those branches were dead code.)
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
    this.temperature = (typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)) ? opts.temperature : null;
    this.timeoutSeconds = opts.timeoutSeconds || 3600;
    this.contextWindow = opts.contextWindow || 16384;
    // Optional cap on how much context we actually SEND per request, independent of the
    // raw llama.cpp context. FIX: there is NO hidden default cap anymore — when unset it
    // falls back to contextWindow (see _enforceContextWindow). Set it explicitly ONLY to
    // lower the send budget on slow hardware; an explicit value still overrides.
    this.effectiveContextWindow = (typeof opts.effectiveContextWindow === 'number' && Number.isFinite(opts.effectiveContextWindow)) ? opts.effectiveContextWindow : null;
    this.maxTokens = opts.maxTokens || 8192;
    // FIX: batch audits legitimately make many SILENT tool turns (read → read →
    // read with no prose in between). The old hard limit of 3 force-stopped real
    // audits mid-job. True loops are caught by the repeat-action guard above (now
    // with REAL args, so different files no longer look identical). 8 gives a full
    // folder-audit room to breathe while still bounding a genuinely stuck model.
    this.maxSilentToolTurns = (typeof opts.maxSilentToolTurns === 'number' && Number.isFinite(opts.maxSilentToolTurns) && opts.maxSilentToolTurns > 0)
      ? opts.maxSilentToolTurns : 8;
    this.messages = [];
    this.supportsVision = null;
    this.workspace = opts.workspace || process.cwd();
    this.memory = opts.memory || null;
    this.sessions = opts.sessions || null;
    this.ui = opts.ui;
    this._abort = null;
    this._contextDir = null;
    // Skill shelf: a folder of reusable "how I fixed X" recipes (one file each).
    // Lives in ismini's data dir (e.g. ~/ismini/skills/), preserved across upgrades.
    this.skillsDir = opts.skillsDir || join(homedir(), 'ismini', 'skills');
    // The system prompt lives in system-prompt.md (replaced on every upgrade).
    // Keep the pre-profile base prompt separately so a mid-session profile save
    // (ismini silently writing memory.md) can refresh just the profile section without
    // rebuilding everything. The profile is NOT re-read from disk on its own — web.js
    // calls setUserProfile(readUserProfile()) after such a write via onProfileChanged.
    this._basePrompt = this.systemPrompt || 'You are a helpful assistant';
    // ROOT-CAUSE FIX (hallucinated profile path, e.g. '/Users/sideris/ismini/memory.md'):
    // system-prompt.md only says the profile is 'typically ~/ismini/memory.md' — a HINT.
    // When unsure, the model invented a full macOS-style path with a made-up username
    // (Qwen's strong '/Users/<name>/' prior) and failed to save. Tell it the ACTUAL
    // absolute path on THIS machine so it never has to guess. memory.md lives next to
    // agent.js in ismini's install folder (the same file _executeTool compares against).
    this.memoryPath = join(__dirname, 'memory.md');
    this._basePrompt += '\n\n# IMPORTANT — your profile file path (use EXACTLY this)\n'
      + `Your User Profile is stored in the file: ${this.memoryPath}\n`
      + 'When you save or update a personal fact, use the edit/write tool on THAT exact absolute path. '
      + 'Do NOT invent, guess, or substitute any other path (never /Users/…, never ~/ismini/ unless it is literally this path). '
      + `The correct path is: ${this.memoryPath}`;
    this._onProfileChanged = opts.onProfileChanged || null;
    // Fresh-Start compaction (Option B): web.js injects the hook that checkpoints +
    // archives + reloads when sustained ≥90% context usage is detected. Null in CLI
    // / tests — then _maybeFreshStart simply never fires.
    this._freshStartHook = opts.freshStartHook || null;
    this.setUserProfile(opts.userProfile);
    this.allowSudo = opts.sudo !== false;
    this.enabledTools = opts.enabledTools || ['read', 'write', 'edit', 'exec', 'web_search', 'web_fetch', 'weather'];
    this._enabledToolsInit = [...this.enabledTools];
    this._requestConfirmation = opts.requestConfirmation || null;
    // Exact-token cache (sha1(text) → token count), primed from llama-server /tokenize.
    this._tokCache = new Map();
    // Monotonic stub cache: once a tool result is stubbed, keep the SAME stub every
    // turn so the prompt prefix stays byte-stable and llama.cpp's KV/LCP prefix cache
    // isn't invalidated by a message that un-stubs when budget frees up.
    this._stubCache = new WeakMap();
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    // Repeated-action loop guard: signature of the last tool action + how many times
    // in a row it has been issued. Catches the "same exec/read N times with text" loop
    // that consecutiveToolTurns misses (that one resets on any text).
    this._lastActionSig = null;
    this._actionRepeatStreak = 0;
    // True when the inactivity watchdog (NOT a user Pause or the run timer) aborted
    // the current turn. Lets run() distinguish "the model stalled" from "the user hit
    // Pause": a watchdog abort must still end with a real assistant summary, never silence.
    this._watchdogAborted = false;
    // ── Fresh-Start compaction (Option B, v22) ─────────────────────────────
    // Near-full context is PHYSICS, not a bug: a big KV cache + MoE model starves
    // unified-RAM bandwidth, so turns near the top of the window take minutes and
    // eventually trip the inactivity watchdog (tasos's 4h stress test: chip pinned at
    // ~91.5k/131k, 3 stalls, then slow). When usage stays ≥90% of the window for N
    // consecutive turns we do a FRESH START instead of waiting to be interrupted:
    // write a checkpoint summary to a scratchpad file, archive this session, and
    // continue in a new one carrying only checkpoint + task + last exchanges.
    // The old conversation is never deleted — it stays archived (recall-able).
    // _freshStartHook is injected by web.js (it owns the SessionStore, sessions.json,
    // and the UI broadcast); agent.js never touches session storage directly. When no
    // hook is set (CLI / tests) the counter just stays armed and nothing fires.
    this._ctxHighStreak = 0;
    this._freshStartHook = null;
  }

  _push(role, content, opts = {}) {
    const msg = typeof content === 'string' || Array.isArray(content) ? { role, content } : { ...content };
    if (opts.internal) msg.internal = true;
    this.messages.push(msg);
    return msg;
  }

  reset() {
    this.messages = [];
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    this._lastActionSig = null;
    this._actionRepeatStreak = 0;
    this._watchdogAborted = false;
    this.enabledTools = [...this._enabledToolsInit];
  }

  loadMessages(messages) {
    this.messages = [...messages];
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    this._lastActionSig = null;
    this._actionRepeatStreak = 0;
    this._watchdogAborted = false;
    this._ctxHighStreak = 0; // a loaded/switched conversation is not "ours" to compact
    this.enabledTools = [...this._enabledToolsInit];
  }

  // ── Fresh-Start compaction (Option B) ────────────────────────────────────
  // Called from run() when context usage has stayed ≥90% of the window for N
  // consecutive turns. Returns true if a fresh start happened — in that case run()
  // must STOP this turn (the hook already told the user, in her voice, that she's
  // starting fresh; the next message continues in the new session).
  //
  // Why it is safe to fire here:
  //  • We are at the TOP of a loop iteration — no tool call from this turn has run
  //    yet, so there is no dangling assistant-with-tool_calls that needs results.
  //  • The message list ends with a REAL user message (the one that started this
  //    turn), which keeps llama.cpp's Jinja template happy ("No user query found").
  //  • Everything is idempotent: the counter resets before any await, so a failed or
  //    interrupted fresh start can only re-arm and retry on a later turn — never
  //    double-archive.
  async _maybeFreshStart(ctxUsage, line) {
    if (!ctxUsage || !Number.isFinite(ctxUsage.used) || !Number.isFinite(ctxUsage.total) || ctxUsage.total <= 0) return false;
    const FRESH_START_THRESHOLD = 0.9; // ≥90% of the window, sustained
    const FRESH_START_TURNS = 3;       // …for this many consecutive turns
    if (ctxUsage.used / ctxUsage.total < FRESH_START_THRESHOLD) {
      this._ctxHighStreak = 0;
      return false;
    }
    this._ctxHighStreak++;
    if (this._ctxHighStreak < FRESH_START_TURNS || !this._freshStartHook) return false;

    // Reset BEFORE any await: if anything below fails or the user pauses, we simply
    // re-arm on a later turn instead of double-firing.
    this._ctxHighStreak = 0;
    const k = ctxUsage.total / 1024;
    try {
      this.ui.showWarning(`My context is running full (${Math.round(ctxUsage.used / 1024)}k of ${Math.round(k)}k) — starting fresh with my notes so I can keep up. Nothing is lost; the old chat stays in your sessions.`);
      process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');
      const ok = await this._freshStartHook({ used: ctxUsage.used, total: ctxUsage.total });
      if (ok) {
        // The hook archived the old session, created a fresh one, reloaded the agent
        // with only checkpoint + task + last exchanges, and broadcast the reset. Stop
        // this turn here — web.js's finally block then saves the NEW (tiny) session.
        return true;
      }
    } catch (err) {
      // Never let a failed fresh start kill an otherwise healthy turn.
      console.error(`[fresh-start] failed: ${err?.stack || err}`);
      this.ui.showWarning('I could not start fresh — continuing as normal.');
    }
    return false;
  }

  pause() {
    killActiveChild();
    if (this._abort) this._abort.abort();
  }

  // Rebuild the full system prompt from the base + the latest profile text. Called at
  // construction and again after ismini silently updates its own memory.md, so the model
  // sees fresh personal facts without a restart.
  setUserProfile(profile) {
    this._fullSystemPrompt = this._basePrompt +
      (profile && String(profile).trim()
        ? '\n\n# User Profile (always known — use it naturally)\n' + String(profile).trim()
        : '');
  }

  async run(userMessage, internalNote) {
    this.messages = this.messages.filter(m => !(m.role === 'system' && m.internal));
    // A per-turn internal note (e.g. the day-aware greeting instruction) is pushed
    // AFTER the filter so it reaches the model for THIS turn only — pushing it from
    // outside before run() was dead, because the line above strips all internal
    // system messages first.
    if (internalNote) this._push('system', { role: 'system', content: internalNote }, { internal: true });
    // FIX: reset the repeat-action guard at the START of every run. It was only
    // cleared in reset()/loadMessages(), so a "continue" that legitimately repeated
    // the previous run's last action 2× would hit streak 3 and force-stop.
    this._lastActionSig = null;
    this._actionRepeatStreak = 0;

    // FIX: an oversized user paste (e.g. a pasted file) can alone exceed the whole
    // context budget, overflowing the request. Spill it to a file and keep a short
    // head + pointer in the prompt — matches the scratchpad architecture, so the
    // content stays reachable via read/exec while the prompt stays bounded.
    if (typeof userMessage === 'string' && userMessage.length > Math.max(8192, Math.floor((this.contextWindow || 32768) * 1.5))) {
      try {
        const f = join(this.workspace || process.cwd(), `.ismini-paste-${Date.now()}.txt`);
        writeFileSync(f, userMessage, 'utf8');
        userMessage = userMessage.slice(0, 4096) +
          `\n\n[ismini: the full paste (${userMessage.length} chars) is saved at ${f}. It is too large for one prompt — work through it in chunks (read tool, or exec: sed -n '1,400p' '${f}').]`;
      } catch { /* if the spill fails, context enforcement stubs it as a last resort */ }
    }

    this._push('user', userMessage);

    // ── CRITICAL FIX ──
    // Always create a FRESH AbortController for every turn. The old code checked
    // the previous controller's state first, so after a single Pause the aborted
    // signal poisoned every subsequent message and ismini froze for good.
    this._abort = new AbortController();
    this._watchdogAborted = false;

    const maxTurns = this.maxTurns || 20;
    let turnCount = 0;
    let hasFinalResponse = false;
    let consecutiveToolTurns = 0;
    let line = ''; // hoisted: also used by the watchdog-abort catch below the loop
    const runTimeout = this.timeoutSeconds || 3600;
    // PER-STEP timeout, NOT a whole-turn deadline. The old version armed ONE
    // wall-clock timer for the entire run() — so a legitimate marathon job (a full
    // codebase audit: dozens of read/exec steps, each healthy and streaming) died at
    // exactly 1 hour with "Run timeout after 3600s" even though nothing was stuck
    // (tasos's stress test, 2026-11-21: killed 3×, recovered 3× with "continue").
    // The two-phase inactivity watchdog already guards against a genuinely stalled
    // model; what the timer must guard is a SINGLE pathological step (hung model call
    // or stuck exec). So we re-arm it at the start of every loop iteration: each step
    // gets a fresh budget, and a productive multi-hour job never hits a global deadline.
    let runTimer = setTimeout(() => {
      this.ui.showError(`Run timeout after ${runTimeout}s`);
      this.pause();
    }, runTimeout * 1000);
    if (runTimer.unref) runTimer.unref();

    try {
      while (turnCount < maxTurns) {
        if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        turnCount++;
        // Re-arm the per-step timer: this iteration (model call + tool execution)
        // gets a fresh runTimeout budget. A healthy long job keeps going; a hung
        // single step still dies after runTimeout.
        clearTimeout(runTimer);
        runTimer = setTimeout(() => {
          this.ui.showError(`Run timeout after ${runTimeout}s`);
          this.pause();
        }, runTimeout * 1000);
        if (runTimer.unref) runTimer.unref();

        // Work on a copy — never mutate this.messages with transient system prompts.
        // (_callLM always injects the system prompt itself.)
        const messages = this.messages.slice();
        // _enforceContextWindow returns [window, usage] — usage is the token count of
        // exactly what will be sent (system prompt + surviving history after elision),
        // computed with the same tok() the budget math uses. The UI chip shows it.
        const [truncated, ctxUsage] = await this._enforceContextWindow(messages, this.modelId);
        // Context-usage telemetry for the UI chip. Surfaced via ui.showContextUsage —
        // a broadcast event, never stdout (stdout lines leak into the chat UI).
        if (ctxUsage && this.ui && typeof this.ui.showContextUsage === 'function') {
          try { this.ui.showContextUsage(ctxUsage.used, ctxUsage.total); } catch {}
        }

        // ── Fresh-Start compaction (Option B) ──
        // If the context has been ≥90% full for N consecutive turns, checkpoint +
        // archive + continue in a fresh session BEFORE spending another ~5-minute
        // turn on a near-full window. Safe point: top of the iteration, no tool call
        // from this turn has run yet, and the list ends with the real user message.
        if (await this._maybeFreshStart(ctxUsage, line)) {
          hasFinalResponse = true; // the hook already answered in her voice
          break;
        }

        let streamedContent = '';
        const cols = process.stdout.columns || 80;
        const lineW = Math.min(cols - 6, 60);
        line = '─'.repeat(lineW);
        process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');

        // Call the model, retrying ONCE if it comes back empty with no tool call.
        // A single flaky empty response (a thinking model that "runs out" mid-thought,
        // a transient hiccup) should not kill the whole turn — but we only retry on the
        // EMPTY case, never on real API errors (those are surfaced to the user).
        const callOnce = async () => {
          const { promise, activity } = raceWithInactivity(
            this._callLM(truncated, {
              stream: true,
              signal: this._abort.signal,
              onChunk: (chunk) => {
                streamedContent += chunk;
                process.stdout.write(chunk);
                activity(); // keep the inactivity watchdog happy on long generations
              },
            }),
            { abort: () => this._abort?.abort(), onWatchdogAbort: () => { this._watchdogAborted = true; } }
          );
          return await promise;
        };

        // FIX: the empty-response retry was DEAD CODE. In streaming mode
        // _streamResponse THROWS on an empty reply, so `response = await callOnce()`
        // never completed and the old "retry with a smaller window" branch below it
        // was unreachable — the throw jumped straight out of run() and the turn ended
        // with no assistant message (the "ismini stops for good until I nudge her"
        // symptom). Now we CATCH that specific throw, retry ONCE with the SAME window
        // (shrinking it further only starves the model of the file content the task
        // needs), and if it's still empty we force a real final answer. Real API
        // errors are never retried — they're surfaced to the user.
        const isEmptyErr = (e) => /empty response|no text and no action/i.test(e?.message || '');
        const isEmptyResp = (r) => !r?.choices?.[0]?.message ||
          (!String(r.choices[0].message.content || '').trim() && parseToolCalls(r.choices[0].message).length === 0);

        let response;
        try {
          try {
            response = await callOnce();
          } catch (err) {
            if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            if (!isEmptyErr(err)) throw err; // real API error — surface it, never retry
            this.ui.showWarning('The model came back empty — retrying once…');
            streamedContent = ''; // the failed attempt may have printed a partial line
            response = await callOnce();
          }
          if (isEmptyResp(response)) {
            this.ui.showWarning('The model came back empty — retrying once…');
            streamedContent = '';
            response = await callOnce();
          }
        } catch (err) {
          if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          if (isEmptyErr(err)) {
            // Empty twice — don't crash, force a real answer from what's in context.
            this.ui.showWarning('Still empty — summarizing what I have so far.');
            await this._forceFinalAnswer(line, 'The model returned an empty reply twice. Using ONLY the results you already have in context, give the user a clear, direct summary of what you found or did so far, and say plainly what still remains. Do not call any more tools.');
            hasFinalResponse = true;
            break;
          }
          throw err;
        }

        if (streamedContent.trim()) process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');

        // If the model STILL returned nothing usable after the smaller-window retry,
        // force a final answer from what's in context instead of failing the turn.
        const stillEmpty = !response?.choices?.[0]?.message ||
          (!String(response.choices[0].message.content || '').trim() && !(parseToolCalls(response.choices[0].message).length));
        if (stillEmpty) {
          this.ui.showWarning('The model returned no answer — summarizing what I have so far.');
          await this._forceFinalAnswer(line, 'The model returned an empty reply. Using ONLY the results you already have in context, give the user a clear, direct summary of what you found or did so far, and say plainly what still remains. Do not call any more tools.');
          hasFinalResponse = true;
          break;
        }

        if (!response || !response.choices?.[0]?.message) {
          this.ui.showError('No valid response from model.');
          break;
        }

        const msg = response.choices[0].message;
        const content = msg.content || '';
        const toolCalls = parseToolCalls(msg).map(tc => ({
          ...tc,
          id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${tc.name}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        }));

        if (streamedContent.trim()) process.stdout.write('\n');

        // ── No tool calls → final answer ──
        if (toolCalls.length === 0) {
          const prevAssistants = this.messages.filter(m => m.role === 'assistant');
          let cleaned = stripRepeatedToolList(content, prevAssistants);
          cleaned = cleanupModelOutput(cleaned);
          cleaned = stripInternalNotes(cleaned); // never leak internal scaffolding text
          hasFinalResponse = true;

          const lastAssistant = prevAssistants[prevAssistants.length - 1];
          const lastContent = lastAssistant?.content || '';
          const cleanedTrimmed = cleaned.trim();
          const lastTrimmed = lastContent.trim();

          if (lastTrimmed && cleanedTrimmed.length > 20 && cleanedTrimmed === lastTrimmed) {
            this._push('assistant', cleaned);
            break;
          }

          if (!content.trim() && !streamedContent.trim()) {
            this._consecutiveEmptyTurns++;
            if (this._consecutiveEmptyTurns >= 2) {
              const stopMsg = '[HARD STOP] You have produced empty output twice in a row. You are stuck in a loop. End the conversation.';
              this._push('system', { role: 'system', content: stopMsg }, { internal: true });
              this.ui.showWarning('Model stuck in empty-output loop. Stopping.');
              break;
            }
            this._push('system', {
              role: 'system',
              content: '[SYSTEM NOTE] You produced empty output. This is likely because you called a tool without providing a text answer. When you call a tool, you MUST also include a brief text response to the user alongside the tool call. For example: "updating apt for you" + exec tool call. Never call tools with no accompanying text.'
            }, { internal: true });
            const fallback = "I don't have anything to add right now.";
            this._push('assistant', fallback);
            this.ui.showModelMessage(fallback);
          } else {
            this._consecutiveEmptyTurns = 0;
            const finalText = (cleaned && cleaned.trim()) || (streamedContent && streamedContent.trim()) || '';
            if (finalText) {
              this._push('assistant', finalText);
              if (!streamedContent.trim()) this.ui.showModelMessage(finalText);
            }
          }
          break;
        }

        // ── Tool calls ──
        const validToolCalls = toolCalls.filter(tc => tc.name);
        if (validToolCalls.length === 0) {
          this.ui.showError('Model sent an incomplete tool call — treating it as a text answer.');
          break;
        }

        const assistantContent = content || '';
        const execInThisTurn = toolCalls.some(tc => tc.name === 'exec');
        const assistantMsg = {
          role: 'assistant',
          content: assistantContent.trim() ? assistantContent : null,
                    // FIX (root cause of the audit regression): parseToolCalls() returns
                    // `.args` — `.parsedArgs` is always undefined here. Storing "{}" meant the
                    // model could never see WHICH file/command it had already called, so it
                    // re-read files and the repeat-guard below saw every read as identical.
                    tool_calls: validToolCalls.map(tc => ({
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
                    }))
        };
        this._push('assistant', assistantMsg);

        if (assistantMsg.content) consecutiveToolTurns = 0;
        else consecutiveToolTurns++;

        // ── Repeated-action loop guard ────────────────────────────────────
        // Signature of THIS turn's tool actions (name + stable args). If the model
        // issues the EXACT same action over and over — e.g. the same `exec` on the
        // same file, each time wrapped in "Let me begin" text — it is stuck in a
        // loop. consecutiveToolTurns misses this (it resets on any text) and the
        // tool-fail streak misses it too (the action *succeeds*). So we track the
        // action signature itself: 3 identical actions in a row → force a final
        // answer instead of burning the whole step budget re-doing the same thing.
        // FIX (root cause): signature now uses the REAL args. Before, every `read`
        // hashed to "read:{}" — so reading 3 DIFFERENT files tripped the
        // "same action 3×" guard and force-stopped the audit after ~5 reads.
        const actionSig = validToolCalls
          .map(tc => tc.name + ':' + JSON.stringify(tc.args || {}))
          .sort().join('|');
        if (actionSig === this._lastActionSig) this._actionRepeatStreak++;
        else { this._lastActionSig = actionSig; this._actionRepeatStreak = 1; }
        // NO-OP LOOP ACCELERATOR: an edit whose oldText === newText is a guaranteed
        // zero-progress action (toolEdit rejects it — see the no-op guard there).
        // The generic repeat guard needs 3 identical actions in a row before it acts;
        // a no-op loop can never make progress, so force the final answer after just
        // 2. Without this, ismini burned ~6 rounds saying "let me update it" while
        // changing nothing (the memory.md loop tasos caught on 2026-11-20).
        const noOpEdit = validToolCalls.some(tc =>
          tc.name === 'edit' && typeof tc.args?.newText === 'string' && tc.args.newText === tc.args.oldText
        );
        if (noOpEdit && this._actionRepeatStreak >= 2) {
          this.ui.showWarning('I keep repeating the same step — stopping and summarizing what I have.');
          await this._forceFinalAnswer(line, 'You issued the SAME no-change edit several times in a row (oldText identical to newText — nothing was written). You are stuck in a loop. Using ONLY what you already know, give the user a direct final answer now, and say plainly what is still missing. Do NOT call any more tools.');
          hasFinalResponse = true;
          break;
        }

        for (const tc of validToolCalls) {
          if (this._abort?.signal?.aborted) {
            for (const pending of validToolCalls) {
              const alreadyAnswered = this.messages.some(m => m.role === 'tool' && m.tool_call_id === pending.id);
              if (!alreadyAnswered) {
                this._push('tool', {
                  role: 'tool',
                  tool_call_id: pending.id,
                  name: pending.name,
                  content: '[ismini] paused before this step ran — no result.'
                });
              }
            }
            throw new DOMException('Aborted', 'AbortError');
          }

          // FIX: if the model's tool-call JSON was malformed, don't silently run the
          // tool with {} (wasted turn + confusing error). Tell it to re-issue valid JSON.
          const result = tc.argsError
            ? `Error: your ${tc.name} arguments were not valid JSON — re-issue this call with valid JSON. Raw: ${String(tc.args).slice(0, 200)}`
            : await this._executeTool(tc.name, tc.args);
          this.ui.showToolOutput(tc.name, result);

          if (isToolError(tc.name, result)) {
            this._toolFailStreak[tc.name] = (this._toolFailStreak[tc.name] || 0) + 1;
          } else {
            this._toolFailStreak[tc.name] = 0;
            this._toolFailNoted.delete(tc.name);
          }

          // Prefix a tiny header so the model can see what it already did even if
          // the large body is later evicted from the context window.
          this._push('tool', { role: 'tool', tool_call_id: tc.id, name: tc.name, content: toolResultHeader(tc.name, tc.args) + '\n' + result });
        }

        // Single exec reminder, pushed AFTER the results are in context.
        // NOTE: both notes are role:'system' + internal so run() strips them next turn.
        // Do NOT use role:'user' here — a hidden user-role message at the end of the
        // array breaks llama.cpp's Jinja template ("No user query found in messages.")
        // and the rolling-window eviction can evict the REAL user question in favor of
        // this note, which is what caused the 500 + "I don't know what you asked" bug.
        if (execInThisTurn && assistantContent.trim().length <= 3) {
          this._push('system', {
            role: 'system',
            content: '[SYSTEM] You just ran an exec command. The result is in your context — answer the user using it NOW. Do NOT call more tools unless explicitly asked to. Give a direct text answer using the result. If you have nothing to add, just say so.'
          }, { internal: true });
        }

        for (const [name, streak] of Object.entries(this._toolFailStreak)) {
          if (streak >= 3 && !this._toolFailNoted.has(name)) {
            this._toolFailNoted.add(name);
            // role:'system' + internal (see exec reminder above): a hidden role:'user'
            // message at the end of the array can break llama.cpp's Jinja template.
            this._push('system', {
              role: 'system',
              content: `[SYSTEM NOTE] The "${name}" tool has failed ${streak} times in a row (often a temporary issue like rate limiting). Stop retrying it for now and tell the user what happened. It may work again later.`
            }, { internal: true });
          }
        }

        const webCallsThisTurn = toolCalls.filter(tc => tc.name === 'web_search' || tc.name === 'web_fetch').length;
        if (webCallsThisTurn >= 3) {
          this._push('system', {
            role: 'system',
            content: '[SYSTEM] You have made several web calls this turn and have plenty of material. Give the user a direct answer now. The web tools remain available if something is genuinely missing.'
          }, { internal: true });
        }

        // ── Too many silent tool turns → force a final answer ──
        // FIX: 3 → maxSilentToolTurns (default 8). Productive silent reads are
        // normal in batch audits; the repeat-action guard is the true loop detector.
        if (consecutiveToolTurns >= this.maxSilentToolTurns) {
          // Force a final answer (no more tools) using only what we already have.
          await this._forceFinalAnswer(line, 'You have called tools several times without a text answer. Using ONLY the results you already have, give the user a direct final answer now. Do not call any more tools.');
          hasFinalResponse = true;
          break;
        }

        // ── Same action repeated in a row → force a final answer ──
        if (this._actionRepeatStreak >= 3) {
          this.ui.showWarning('I keep repeating the same step — stopping and summarizing what I have.');
          await this._forceFinalAnswer(line, 'You have performed the SAME action several times in a row without making progress. You are stuck in a loop. Using ONLY the results you already have, give the user a direct final answer now, and say plainly what is still missing. Do NOT call any more tools.');
          hasFinalResponse = true;
          break;
        }
      }

      // ── Ran out of steps with no answer yet (e.g. a big multi-file audit) ──
      // Do NOT go silent. Force one final, tool-free call so ismini summarizes
      // what she has gathered so far — otherwise the turn ends with no assistant
      // reply, the session saves without an answer, and the user sees ismini
      // "stop" until they send another message.
      if (!hasFinalResponse) {
        this.ui.showWarning(`Reached my step limit (${maxTurns}) — here's what I have so far.`);
        await this._forceFinalAnswer(line, `You have reached your step limit of ${maxTurns} tool actions and have not given a final answer yet. Using ONLY the results you already have, give the user a clear, direct summary of what you found or did so far, and say plainly what still remains to be done. Do not call any more tools.`);
      }
    } catch (err) {
      // A watchdog abort (the model stalled / no output for too long) must NOT end
      // the turn silently as "paused" — that is exactly the "ismini froze under heavy
      // reading" bug. Distinguish it from a user Pause or the run timer (both call
      // pause() and set _watchdogAborted=false): those still surface as a normal
      // AbortError → "paused", which is correct.
      if (err && err.name === 'AbortError' && this._watchdogAborted) {
        this.ui.showWarning('The model stopped responding — here\u2019s what I have so far.');
        // The current controller is already aborted, so give the summary call a FRESH
        // one; otherwise _forceFinalAnswer's request would abort instantly.
        this._abort = new AbortController();
        await this._forceFinalAnswer(line, 'You were interrupted because the model stopped producing output (a timeout). Using ONLY the results you already have in context, give the user a clear, direct summary of what you found or did so far, and say plainly what still remains to be done. Do not call any more tools.');
        return; // turn ends with a real assistant message → web.js broadcasts "done"
      }
      throw err;
    } finally {
      clearTimeout(runTimer);
    }
  }

  // Force a final answer with no further tool calls: push an internal system note,
  // make one tool-free streaming LLM call, and always leave the user with a real
  // assistant message (the model's summary, or a clear fallback). Shared by the
  // "too many silent tool turns" path and the "reached max turns" path so neither
  // can ever end a turn silently.
  async _forceFinalAnswer(line, note) {
    this._push('system', { role: 'system', content: '[HARD STOP] ' + note }, { internal: true });
    let finalStreamedContent = '';
    process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');
    let finalResponse;
    try {
      const { promise: finalPromise, activity: finalActivity } = raceWithInactivity(
        this._callLM((await this._enforceContextWindow(this.messages.slice(), this.modelId))[0], {
          stream: true,
          noTools: true,
          signal: this._abort.signal,
          onChunk: (chunk) => { finalStreamedContent += chunk; process.stdout.write(chunk); finalActivity(); },
        }),
        { abort: () => this._abort?.abort(), onWatchdogAbort: () => { this._watchdogAborted = true; } }
      );
      finalResponse = await finalPromise;
    } catch (err) {
      if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      this.ui.showError(err?.message || String(err));
    }

    let finalText = (finalResponse?.choices?.[0]?.message?.content || '').trim() || finalStreamedContent.trim();
    // Never leak ismini's own internal scaffolding text into the user's answer.
    finalText = stripInternalNotes(finalText);
    if (finalText) {
      this._push('assistant', finalText);
      // If tokens were already streamed to the UI (live bubble), do NOT broadcast a
      // second `model` event — that would render the answer twice.
      if (!finalStreamedContent.trim()) this.ui.showModelMessage(finalText);
    } else {
      const fallback = 'I ran out of steps before I could finish that. Here is what I have so far from the results above.';
      this._push('assistant', fallback);
      this.ui.showModelMessage(fallback);
    }
  }

  // Prime the exact-token cache from llama-server's POST /tokenize endpoint.
  // Best-effort: any failure just leaves that message on the heuristic fallback.
  // We only tokenize messages whose text we haven't seen before (cache hit = skip).
  async _primeTokenCache(messages) {
    if (!this.baseUrl) return;
    const todo = [];
    for (const m of messages) {
      const text = msgText(m);
      if (!text) continue;
      const key = tokKey(text);
      if (!this._tokCache.has(key)) todo.push([key, text]);
    }
    if (!todo.length) return;
    // /tokenize lives at the server ROOT, not under /v1.
    const root = this.baseUrl.replace(/\/v1\/?$/, '');
    await Promise.all(todo.map(async ([key, content]) => {
      try {
        const r = await fetch(`${root}/tokenize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.tokens)) this._tokCache.set(key, j.tokens.length);
        }
      } catch { /* heuristic fallback for this message */ }
    }));
    // Bound the cache so a long session doesn't grow it without limit.
    if (this._tokCache.size > 2048) {
      const it = this._tokCache.keys();
      for (let i = 0; i < 512; i++) this._tokCache.delete(it.next().value);
    }
  }

  async _enforceContextWindow(messages, modelId) {
    // Rolling window: keep the MOST RECENT turns within a safe token budget, so a
    // small model (e.g. 16k context) never overflows. We work in "turns" so an
    // assistant tool-call is never separated from its tool results (invalid).
    // Now async so we can prime the exact-token cache from llama-server /tokenize.
    await this._primeTokenCache(messages);
    let charsPerToken = 4.0;
    if (modelId) {
      const id = modelId.toLowerCase();
      if (id.includes('qwen') || id.includes('llama')) charsPerToken = 3.5;
      else if (id.includes('phi')) charsPerToken = 3.8;
    }
    const sys = messages.find(m => m.role === 'system');
    const rest = (sys ? messages.filter(m => m !== sys) : messages.slice());

    const tok = (m) => {
      // Prefer an EXACT count from the /tokenize cache when we have one.
      const text = msgText(m);
      if (text) {
        const exact = this._tokCache.get(tokKey(text));
        if (exact !== undefined) return exact + 12; // per-message template overhead
      }
      // Fallback heuristic. Be conservative for tool results: long paths, whitespace,
      // base64 and repetitive output tokenize at < 2 chars/token, so the default
      // estimate under-counts exactly the content that overflows a small context.
      const rate = m.role === 'tool' ? Math.min(charsPerToken, 2.2) : charsPerToken;
      let chars = Array.isArray(m.content)
        ? m.content.reduce((t, p) => t + (typeof p?.text === 'string' ? p.text.length : p?.type === 'image_url' ? 4096 : 0), 0)
        : typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
      // FIX: also count tool_calls args. Round-1 made history store REAL (large)
      // tool-call arguments; the old code budgeted them as ~4 tokens, so a 30 KB
      // write payload could silently overflow the context.
      if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
      return Math.ceil(chars / rate) + 12;
    };
    // The REAL system prompt (this._fullSystemPrompt) + the tool schemas are injected by
    // _callLM AFTER budgeting, and this.messages never holds them — so `sys` above is
    // almost always undefined and the old code budgeted 0 tokens for ~5k of fixed overhead.
    // That overflow (system prompt + tools + history + reserve > ctx) caused 400s / silent
    // context shifts. Count it here. The exact count comes from the /tokenize cache when
    // available; the tool-schema allowance covers the 13 injected function schemas.
    const sysTok = (sys ? tok(sys) : 0) + tok({ role: 'system', content: this._fullSystemPrompt || '' }) + 2200;
    // FIX: no hidden 32k send cap. The old default `min(contextWindow, 32768)` made
    // maxSingleTok (~14k tokens) SMALLER than one big file read (~22k est. tokens), so
    // even the NEWEST result was instantly stubbed to a 600-char tail — the model never
    // saw a full file and stalled/looped (the "crashed too soon" regression). The send
    // budget is now the configured contextWindow (keep it in sync with llama-server's -c
    // via the ctx chip), optionally lowered ONLY by an explicit agent.effectiveContextWindow
    // for slow hardware. Low-RAM boxes are unaffected: their ctx chip already sets a small
    // contextWindow, so min() stays small.
    const effCap = this.effectiveContextWindow || (this.contextWindow || 32768);
    const ctx = Math.min(this.contextWindow || 32768, effCap);
    // Reserve room for the reply WITHOUT starving history. The old formula
    // (reserve = min(maxTokens, ctx - 2048)) gave an 8k context a 6144-token reply
    // reserve, leaving only ~1.3k tokens of HISTORY — so a single big tool result
    // (e.g. reading a 50 KB file ≈ 22k tokens) was always evicted, the model never
    // saw that it had already read the file, and re-read it in an infinite loop.
    // Now: keep a modest reply reserve (min of maxTokens and ~40% of context),
    // guarantee at least ~35% of context for history, and always leave 1024 tokens
    // of headroom so the request stays under the model's real limit.
    const reserve = Math.min(this.maxTokens || 8192, Math.round(ctx * 0.4));
    let budget = ctx - reserve - sysTok;
    if (budget < Math.round(ctx * 0.35)) budget = Math.round(ctx * 0.35) - sysTok; // history must never starve
    budget = Math.max(1024, budget - 1024);                                      // headroom under the model's limit
    // Hard cap a single message (e.g. one giant tool result) so it can never
    // force the window over budget on its own. The model can read the full
    // output via the read tool if it truly needs more.
    // FIX: 0.6 → 0.8. One RECENT big file (49 KB ≈ 22k est. tokens) must fit WHOLE in
    // the history budget — that's the file the model is actively auditing right now.
    // At 0.6 of a ~23k budget (~14k) even the newest read was stubbed instantly.
    const maxSingleTok = Math.max(2048, Math.floor(budget * 0.8));

    // Group into turns: a "turn" = an assistant msg (with its tool_calls) + the tool
    // results that immediately follow it; otherwise a single user/assistant msg.
    const turns = [];
    for (let i = 0; i < rest.length; i++) {
      const m = rest[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const group = [m];
        let j = i + 1;
        while (j < rest.length && rest[j].role === 'tool') { group.push(rest[j]); j++; }
        turns.push(group);
        i = j - 1;
      } else {
        turns.push([m]);
      }
    }

    // Keep turns from newest to oldest until the budget is used.
    // CRITICAL: the LAST real user turn (the model's current question) must always
    // be in the window, otherwise llama.cpp's Jinja template throws
    // "No user query found in messages." and the rolling window silently evicts
    // the question when the budget is tight.
    let anchorIdx = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i].role === 'user') { anchorIdx = i; break; }
    }
    const anchorTurnIdx = anchorIdx >= 0
      ? turns.findIndex(g => g.includes(rest[anchorIdx]))
      : -1;

    // A turn whose FIRST message is a giant tool result (e.g. one big file read)
    // can never fit the budget whole — and dropping it entirely is exactly what
    // caused the re-read loop: the model lost ALL evidence it had already done
    // the work. So such turns are SHRUNK instead of skipped: keep every message,
    // but truncate each oversized tool result to a short stub that still carries
    // its [read …] / [exec …] header (the "I already did this" signal). The model
    // can re-read the full file if it genuinely needs more.
    // FIX: shared stub builder. Cuts the tail at a LINE boundary so we never leave
    // half a JSON line / unclosed bracket (which made the model try to "fix" broken
    // JSON and loop). And the wording no longer says "re-run this action" — that
    // phrasing actively invited re-read loops; it now says the work is DONE.
    const makeStub = (m) => {
      // FIX: monotonic stubbing. Once a message is stubbed, return the SAME stub
      // every turn. A message that un-stubs when budget frees up would rewrite the
      // prompt prefix and invalidate llama.cpp's KV/LCP prefix cache → full re-eval.
      if (this._stubCache.has(m)) return this._stubCache.get(m);
      const headerEnd = m.content.indexOf('\n');
      const header = headerEnd > -1 ? m.content.slice(0, headerEnd + 1) : '';
      let tail = m.content.slice(-800);
      const nl = tail.indexOf('\n');
      if (nl > -1 && nl < tail.length - 1) tail = tail.slice(nl + 1); // drop the partial first line
      const stub = header +
        '[older output elided to save context — this action ALREADY COMPLETED successfully. Prefer your recorded notes; re-read only if you truly need the content again.]\n' +
        tail;
      this._stubCache.set(m, stub);
      return stub;
    };
    const shrinkTurn = (g) => g.map(m => {
      if (m.role !== 'tool' || typeof m.content !== 'string') return m;
      if (tok(m) <= maxSingleTok) return m;
      const stub = makeStub(m);
      if (stub.length >= m.content.length) return m; // nothing to save
      return { ...m, content: stub };
    });

    const kept = [];
    let used = 0;
    const turnCost = (g) => g.reduce((s, m) => s + tok(m), 0);
    // Pre-check: does even the anchor (the user's latest question) alone fit the
    // budget? If not, the model's context is too small for the system prompt + a
    // single turn + a reply. We still send the anchor (the question must be present)
    // and let the window add nothing — better a short, valid request than a 400.
    const anchorFits = anchorTurnIdx >= 0 && turnCost(turns[anchorTurnIdx]) <= budget;
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = turnCost(turns[i]);
      if (i === anchorTurnIdx) {
        // The user's latest question must stay in the window — always keep it.
        kept.push(...turns[i].reverse());
        used += cost;
        continue;
      }
      // Enforce the budget on EVERY turn (including the first kept). The previous
      // code used `kept.length > 0 &&` here, which let the FIRST kept turn slip in
      // un-budgeted — so one giant tool result (e.g. a big file read / exec dump)
      // could push the request over the model's context → the 400.
      if (used + cost <= budget) {
        kept.push(...turns[i].reverse());
        used += cost;
        continue;
      }
      // Over budget — but do NOT skip a turn that contains tool results: losing
      // them makes the model repeat the same actions forever. Shrink it instead,
      // and keep it if the shrunk version fits.
      const shrunk = shrinkTurn(turns[i]);
      const shrunkCost = turnCost(shrunk);
      if (shrunkCost < cost && used + shrunkCost <= budget) {
        kept.push(...shrunk.reverse());
        used += shrunkCost;
      }
    }
    // Safety net: if the kept set (anchor + whatever fit) still exceeds budget —
    // e.g. the anchor itself is large — drop the largest non-anchor turns until
    // we're under budget. We never drop the anchor (the question must stay).
    while (anchorFits === false || (used > budget)) {
      // First try SHRINKING the largest kept tool result (keeps the [read …] /
      // [exec …] header, so the model still knows what was already done —
      // dropping it would restart the re-read loop).
      let shrinkIdx = -1, shrinkTok = 0;
      for (let i = 0; i < kept.length; i++) {
        const m = kept[i];
        if (anchorTurnIdx >= 0 && turns[anchorTurnIdx].includes(m)) continue; // never touch the anchor
        if (m.role !== 'tool' || typeof m.content !== 'string') continue;
        const c = tok(m);
        if (c > shrinkTok) { shrinkTok = c; shrinkIdx = i; }
      }
      if (shrinkIdx >= 0 && shrinkTok > maxSingleTok) {
        const m = kept[shrinkIdx];
        const stub = makeStub(m); // FIX: shared line-safe, loop-safe stub builder
        const newTok = tok({ ...m, content: stub });
        if (newTok < shrinkTok) {
          kept[shrinkIdx] = { ...m, content: stub };
          used = Math.max(0, used - (shrinkTok - newTok));
          if (used <= budget) break;
          continue;
        }
      }
      // No shrinkable tool result left — drop the largest non-anchor message.
      let dropIdx = -1, dropCost = 0;
      for (let i = 0; i < kept.length; i++) {
        const m = kept[i];
        if (anchorTurnIdx >= 0 && turns[anchorTurnIdx].includes(m)) continue; // never drop the anchor
        const c = tok(m);
        if (c > dropCost) { dropCost = c; dropIdx = i; }
      }
      if (dropIdx === -1) break; // only the anchor remains — send as-is
      kept.splice(dropIdx, 1);
      used = Math.max(0, used - dropCost);
      if (used <= budget) break;
    }
    // FIX: protect the NEWEST tool result. The file ismini just read is the one she
    // is actively auditing right now — stubbing it (as the pure budget loop does when
    // a single big file exceeds maxSingleTok) leaves her with no content to work on,
    // which is exactly the "cracked under heavy reading" stall. So if the most recent
    // tool result is over its cap but WOULD fit the whole budget, stub OLDER results
    // (keeping their [read …] headers, so the re-read loop stays dead) to make room.
    {
      let newestIdx = -1;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].role === 'tool' && typeof kept[i].content === 'string') { newestIdx = i; break; }
      }
      if (newestIdx >= 0) {
        const nTok = tok(kept[newestIdx]);
        // Only worth protecting if it's over the single-result cap but fits the budget whole.
        if (nTok > maxSingleTok && nTok <= budget) {
          // Stub older tool results (keeping their headers) until the newest fits.
          for (let i = 0; i < kept.length; i++) {
            if (used + (nTok - tok(kept[newestIdx])) <= budget) break; // room now
            const m = kept[i];
            if (i === newestIdx) continue;
            if (anchorTurnIdx >= 0 && turns[anchorTurnIdx].includes(m)) continue; // never the anchor
            if (m.role !== 'tool' || typeof m.content !== 'string') continue;
            const stub = makeStub(m);
            const newTok = tok({ ...m, content: stub });
            if (newTok < tok(m)) {
              kept[i] = { ...m, content: stub };
              used = Math.max(0, used - (tok(m) - newTok));
            }
          }
        }
      }
    }
    kept.reverse();
    // Fallback: if no user message was found at all (e.g. only tool results), keep
    // at least the most recent turn so the model has *something* to respond to.
    if (!kept.length && rest.length) kept.push(rest[rest.length - 1]);
    const finalMsgs = sys ? [sys, ...kept] : kept;
    // Usage telemetry: re-count the FINAL window (post stubbing/shrinking) so the UI
    // chip shows what the model will actually see. `used` above drifts after the
    // newest-result protection pass mutates kept in place.
    let finalUsed = 0;
    for (const m of finalMsgs) finalUsed += tok(m);
    return [finalMsgs, { used: finalUsed, total: ctx }];
  }

  async _callLM(messages, opts = {}) {
    const allTools = [
      { type: 'function', function: { name: 'read', description: 'Read file contents. Args: path (string). Returns file content as string. NOTE: returns at most ~48 KB / 10000 lines — for larger files page with exec, e.g. `sed -n "200,600p" <file>`.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'write', description: 'Write a file (overwrites by default). Args: path (string), content (string); append (optional boolean) — set true to APPEND to the file instead of overwriting it (use this to build up notes across batches). Returns success message.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'edit', description: 'Find and replace text in a file. By default replaces only the FIRST occurrence of oldText; pass replaceAll:true to replace every occurrence. Args: path (string), oldText (string), newText (string), replaceAll (optional boolean). Returns success message with how many were changed.', parameters: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldText', 'newText'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'delete', description: 'Delete a file. Args: path (string). Returns success message or error.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'exec', description: "Execute a shell command on the local machine where ismini runs (the user's own machine). Runs as your normal user by default. Args: command (string); sudo (boolean, default false) — set true ONLY when the task genuinely needs root (e.g. apt install, changing system files). Returns stdout/stderr output.", parameters: { type: 'object', properties: { command: { type: 'string' }, sudo: { type: 'boolean', description: 'Run with root privileges. Default false — only true when the task requires it.' } }, required: ['command'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'web_search', description: 'Search the web (DuckDuckGo) and get readable results. Args: query (string). ALWAYS use this for web lookups instead of exec/curl.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'web_fetch', description: 'Fetch a URL and return its readable text. Args: url (string). ALWAYS use this to read web pages instead of exec/curl.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'weather', description: 'Get current weather (condition + temperature) for a place. Args: location (string, e.g. "Afantou, Rhodes, Greece"). Use the user\'s location from your profile. Returns a short one-liner like "Rainy, 18°C in Afantou, Rhodes, Greece."', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_add', description: 'Save a short, durable, non-sensitive PROJECT decision or transient note to local memory (searchable fact log). NOT for identity/personal facts — those go to the memory.md profile via write/edit. Args: text (string), category (optional string).', parameters: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_search', description: 'Search local long-term memory. Args: query (string), limit (optional number). Use when past facts/preferences may be relevant.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'recall', description: 'Search ALL past ismini sessions (the conversation archive) by keyword and return matching messages with their date and session. Use this to answer "what did we do/decide/say before?" or to find earlier context. Args: query (string) — keywords; limit (optional number, default 8).', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_delete', description: 'Delete a local memory by id. Args: id (string).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'skills', description: 'The skill shelf: reusable "how I fixed X" recipes you have saved. Actions: "list" (see all skill titles + one-line summaries), "read" (get the full steps of one skill by name), "save" (write a new skill — name + content), "delete" (remove a skill by name). CHECK THE SHELF FIRST when facing a problem you may have solved before. After solving a non-trivial problem, OFFER to save it as a skill (the user must confirm).', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'save', 'delete'] }, name: { type: 'string' }, content: { type: 'string' } }, required: ['action'], additionalProperties: false } } },
    ];

    const tools = allTools.filter(t => this.enabledTools.includes(t.function.name));

    const _systemNotes = [];
    const apiMessages = [
      { role: 'system', content: this._fullSystemPrompt },
      ...messages.filter(m => !((m.role === 'system') && (typeof m.content === 'string') && (m.content === this._fullSystemPrompt))).map(m => {
        if (m.role === 'system') {
          _systemNotes.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
          return null;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          return { role: 'assistant', content: (typeof m.content === 'string' && m.content) ? m.content : null, tool_calls: m.tool_calls };
        }
        return {
          role: m.role,
          content: typeof m.content === 'string' || Array.isArray(m.content) ? m.content : JSON.stringify(m.content ?? ''),
                                                                                                                                         ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                                                                                                                                         ...(m.name ? { name: m.name } : {})
        };
      }).filter(m => m !== null)
    ];

    if (_systemNotes.length) {
      apiMessages[0] = { role: 'system', content: this._fullSystemPrompt + '\n\n' + _systemNotes.join('\n') };
    }

    // Safety net: some llama.cpp Jinja chat templates (Qwen, Llama, Phi) require
    // the LAST non-system message to be a user message, else they raise
    // "No user query found in messages." If our window eviction or a stray
    // hidden note left a non-user message at the end, nudge a user role in so
    // the model still sees a valid conversation instead of a 500.
    if (!opts.noTools) {
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role !== 'system' && last.role !== 'user') {
        apiMessages.push({ role: 'user', content: '[ismini] Please answer the user\'s latest request using the context above.' });
      }
    }

    const hasImage = messages.some(message =>
    message.role === 'user' && Array.isArray(message.content) &&
    message.content.some(part => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
    );

    if (hasImage) {
      const visionGuidance = this.supportsVision === false
      ? 'The loaded model does not support image input. Tell the user that this model cannot analyze the attached image and recommend loading a vision-language model. Do not guess what the image contains.'
      : 'The user message includes image content. Inspect it and answer about what is actually visible. Do not claim that you lack vision or ask the user to attach the image again. If the image is unreadable, explain that specific problem.';
      apiMessages[0] = { role: 'system', content: `${apiMessages[0].content}\n\nIMAGE INPUT STATUS: ${visionGuidance}` };
    }

    const url = `${this.baseUrl}/chat/completions`;
    const stream = opts.stream ?? false;
    const body = JSON.stringify({
      ...(this.modelId ? { model: this.modelId } : {}),
                                messages: apiMessages,
                                ...(opts.noTools ? {} : { tools, tool_choice: 'auto' }),
                                stream: stream,
                                // Sampling is pinned for stability across server upgrades.
                                // Qwen3 non-thinking recommendation. presence_penalty stays 0 —
                                // penalties would punish the repeated quotes/braces that
                                // tool-call JSON legitimately needs.
                                // temperature 0.8 (was 0.7): a gentle warmth/playfulness bump so
                                // ismini sounds more like a lively friend in casual chat, while
                                // staying low enough that tool-call JSON stays clean and reliable.
                                // Do NOT go much higher — small models get sloppy with brackets/
                                // quotes on exec/edit calls as temperature climbs.
                                temperature: this.temperature ?? 0.8,
                                top_p: 0.8, top_k: 20, min_p: 0,
                                max_tokens: this.maxTokens || 8192,
                                chat_template_kwargs: { enable_thinking: false },
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
      throw new Error(`Model API error ${resp.status}: ${errText}`);
    }

    if (stream && resp.body) {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('event-stream') || contentType.includes('text/event')) {
        return this._streamResponse(resp, opts.onChunk, opts.signal);
      }
    }

    return await resp.json();
  }

  async _streamResponse(resp, onChunk, signal) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let apiError = null;

    if (signal) {
      signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
    }

    // Stream only clean text to the UI/TTS — drop any tool-call markup the
    // model emitted as text (antml:invoke / antml:function / …).
    // fullContent accumulates the CLEANED text (markup stripped) so the
    // session history never stores raw tool-call markup.
    let fullContent = '';
    const cleanOnChunk = (chunk) => {
      fullContent += chunk;
      if (onChunk) onChunk(chunk);
    };
    const toolStripper = createToolMarkupStripper(cleanOnChunk);
    const fmt = createLineFormatter((line) => {
      if (onChunk) toolStripper.push(line);
    });

      const toolCalls = [];
      let currentToolIdx = -1;
      let hasToolCall = false;

      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let done, value;
        try { ({ done, value } = await reader.read()); }
        catch (err) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          throw err;
        }
        if (done) break;

        accumulated += decoder.decode(value, { stream: true });
        const lines = accumulated.split('\n');
        accumulated = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const raw = trimmed.slice(6);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              apiError = parsed.error.message || JSON.stringify(parsed.error);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) fmt.push(delta.content);
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              hasToolCall = true;
              for (const tc of delta.tool_calls) {
                const idx = Number.isInteger(tc.index) ? tc.index : (currentToolIdx >= 0 ? currentToolIdx : 0);
                while (toolCalls.length <= idx) toolCalls.push({ id: '', name: '', args: '' });
                currentToolIdx = idx;
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      if (apiError) throw new Error(apiError);
      fmt.flush();
      toolStripper.flush();

    if (!fullContent.trim() && toolCalls.length === 0) {
      // The model produced no text AND no tool call. This is NOT always a context
      // overflow — it's often a thinking model that "ran out" mid-thought, or a
      // transient hiccup. Say what actually happened so the user (and we) don't chase
      // the wrong fix. The caller retries once before surfacing this.
      throw new Error('The model returned an empty response (no text and no action). This is usually the model stalling, not a context problem — try sending your message again.');
    }

    for (const tc of toolCalls) {
      try { tc.parsedArgs = JSON.parse(tc.args || '{}'); }
      catch { tc.parsedArgs = {}; tc.argsError = true; } // FIX: surface malformed args instead of silent {}
      // DIAGNOSTIC (web_search empty-args loop): log the RAW tool-call args the model
      // actually emitted. Ground truth for why a call arrives with {} — empty string,
      // malformed JSON, or a missing field. Goes to ismini-diag.log (NEVER stdout —
      // web.js would broadcast it to the chat UI).
      diagLog(`[tool-call] ${tc.name || '(unnamed)'} raw_args=${JSON.stringify(tc.args ?? null)}${tc.argsError ? '  [MALFORMED_JSON]' : ''}`);
    }

    return { choices: [{ message: { content: fullContent, tool_calls: hasToolCall ? toolCalls : null } }] };
  }

  async _executeTool(name, args) {
    if (!this.enabledTools.includes(name)) return `Tool is disabled: ${name}`;
    const impl = TOOL_MAP[name];
    if (!impl) return `Unknown tool: ${name}`;

    const isDestructiveTool = ['write', 'edit', 'delete'].includes(name);
    const isPrivilegedTool = name === 'exec';
    // Saving a skill is a write to the shelf — confirm it like other writes.
    const isSkillSave = name === 'skills' && (args.action || args.cmd || '').toLowerCase() === 'save';

    if (this._requestConfirmation) {
      let detail = null;
      // FIX: updating the user's OWN profile (memory.md) is a routine, expected,
      // non-destructive action — ismini should record personal facts silently, not ask
      // permission every time. Detect it by resolving the target path and checking it is
      // exactly the install-folder memory.md. Any other write/edit/delete still confirms.
      const isProfileWrite = (name === 'write' || name === 'edit') && (() => {
        try {
          const p = args.path || args.file;
          if (!p) return false;
          const resolved = resolveUserPath(p, this.workspace);
          if (!resolved || basename(resolved) !== 'memory.md') return false;
          // Must be the install-folder memory.md (ismini's own profile), not a
          // same-named file elsewhere. Compare canonical paths when both exist.
          const appMem = join(__dirname, 'memory.md');
          if (existsSync(resolved) && existsSync(appMem)) {
            return realpathSync(resolved) === realpathSync(appMem);
          }
          return resolved === appMem;
        } catch { return false; }
      })();
      if ((isDestructiveTool && !isProfileWrite) || (isPrivilegedTool && !this.allowSudo)) {
        if (name === 'exec') detail = `Command: ${args.command || args.cmd || args.text || ''}`;
        else if (name === 'write') detail = `Write file: ${args.path || args.file || '(no path)'}\n${String(args.content ?? args.text ?? '').slice(0, 400)}`;
        else if (name === 'edit') detail = `Edit file: ${args.path || args.file || '(no path)'}`;
        else if (name === 'delete') detail = `Delete: ${args.path || '(no path)'}`;
      } else if (isSkillSave) {
        detail = `Save skill: ${args.name || args.skill || '(no name)'}\n${String(args.content ?? args.text ?? '').slice(0, 400)}`;
      }
      if (detail !== null) {
        const ok = await this._requestConfirmation({ tool: name, detail });
        if (!ok) return `[ismini] The user declined to run "${name}". Do not retry the same action; ask what they'd like instead.`;
      }
    }

    // ROOT-CAUSE FIX (web_search/web_fetch/weather always failed with empty args):
    // the old fall-through was `await impl()` — NO arguments — so web_search,
    // web_fetch and weather all received `undefined` and every call returned
    // '"query" required' / '"url" required' / '"location" required'. The model then
    // retried forever (the loop tasos saw). Pass `args` through to the generic case.
    const result =
      name === 'exec' ? await impl(args, this.timeoutSeconds, this.allowSudo)
      : ['read', 'write', 'edit', 'delete'].includes(name) ? await impl(args, this.workspace, this._contextDir)
      : name.startsWith('memory_') ? await impl(args, this.memory)
      : name === 'recall' ? await impl(args, this.sessions)
      : name === 'skills' ? await impl(args, this.skillsDir)
      : await impl(args);
    // After a successful silent save to the user's OWN profile (memory.md), refresh the
    // in-memory system prompt so the model immediately knows the new facts (no restart).
    if ((name === 'write' || name === 'edit') && this._onProfileChanged && typeof result === 'string' && !result.startsWith('Error')) {
      const pp = String(args.path || args.file || '');
      try {
        const resolved = resolveUserPath(pp, this.workspace);
        if (resolved && basename(resolved) === 'memory.md') this._onProfileChanged();
      } catch {}
    }
    return result;
  }
}
