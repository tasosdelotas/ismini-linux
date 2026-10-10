// web.js — ismini WebUI: a local web chat on the same Agent core.
// Zero dependencies (node:http + Server-Sent Events). Binds 127.0.0.1 only
// — the server has no auth, so it must never be exposed to the network.
//
//   node web.js [--port 8787]     or     ismini

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, createReadStream, accessSync, constants as fsConstants, readFile as asyncReadFile, writeFile as asyncWriteFile, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent.js';
import { SessionStore } from './sessions.js';
import { MemoryStore } from './memory.js';
import { MAX_IMAGE_BYTES, MAX_SEND_BODY_BYTES, modelSupportsVision, validateImageAttachment } from './image-input.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;

// Route registry for duplicate detection at startup
const ROUTES = new Map();
function registerRoute(method, path, handler) {
  const key = `${method} ${path}`;
  if (ROUTES.has(key)) throw new Error(`Duplicate route: ${key}`);
  ROUTES.set(key, handler);
}

// Register all routes for duplicate detection
// NOTE: Auto-update implemented with safety checks
registerRoute('GET', '/', () => {}); // placeholder - actual handler is inline
registerRoute('GET', '/live-tts.js', () => {});
registerRoute('GET', '/favicon-256.png', () => {});
registerRoute('GET', '/fonts/cinzel.ttf', () => {});
registerRoute('GET', '/marble.jpeg', () => {});
registerRoute('GET', '/stars.gif', () => {});
registerRoute('GET', '/bg.jpg', () => {});
registerRoute('GET', '/2.jpeg', () => {});
registerRoute('GET', '/meander.png', () => {});
registerRoute('GET', '/meander-faded.png', () => {});
registerRoute('GET', '/cogito.jpeg', () => {});
registerRoute('GET', '/events', () => {});
registerRoute('POST', '/send', () => {});
registerRoute('POST', '/pause', () => {});
registerRoute('POST', '/confirm', () => {});
registerRoute('POST', '/new', () => {});
registerRoute('GET', '/api/sudo', () => {});
registerRoute('POST', '/api/sudo', () => {});
registerRoute('GET', '/state', () => {});
registerRoute('GET', '/api/check-update', () => {});
registerRoute('POST', '/api/download-update', () => {});
registerRoute('GET', '/api/sessions', () => {});
registerRoute('POST', '/api/sessions/switch/', () => {});
registerRoute('GET', '/api/models', () => {});
registerRoute('POST', '/api/model/switch', () => {});

// ── Config ──────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.error('No config.json found. Edit the template.');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  let port = Number(process.env.WEB_PORT) || 8787;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const val = Number(args[++i]);
      if (val < 1 || val > 65535) throw new Error(`Invalid port: ${val}`);
      port = val;
    } else if (/^\d+$/.test(args[i])) {
      // Bare port number
      const val = Number(args[i]);
      if (val < 1 || val > 65535) throw new Error(`Invalid port: ${val}`);
      port = val;
    }
  }
  return port;
}
const PORT = parseArgs();
const HOST = '127.0.0.1';

// ── WebUI: implements the same duck-typed interface the Agent expects ──────
// The Agent calls ui.show*() for status and ui._c() for color; we forward
// each of those as a Server-Sent-Event to every connected browser.
class WebUI {
  constructor(broadcast) { this.broadcast = broadcast; }
  showWarning(text) { this.broadcast({ type: 'warn', text: String(text) }); }
  showError(text) { this.broadcast({ type: 'error', text: String(text) }); }
  showModelMessage(text) { this.broadcast({ type: 'model', text: String(text) }); }
  showToolOutput(name, result) { this.broadcast({ type: 'tool', name: String(name), result: String(result) }); }
  _c(color, text) { return text; } // web renders its own styling
}

// ── SSE fan-out ─────────────────────────────────────────────────────────────
const clients = new Set();
const broadcast = (evt) => {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      // Backpressure: if the kernel buffer is full, drop the slow client
      // rather than letting unbounded data accumulate in memory.
      if (res.writableLength > 1024 * 1024) { // 1 MiB high-water mark
        res.destroy();
        clients.delete(res);
        continue;
      }
      const ok = res.write(payload);
      if (!ok) {
        // Buffer is full — wait for drain before writing more
        res.once('drain', () => {});
      }
    } catch { clients.delete(res); }
  }
};

// ── auto-shutdown ─────────────────────────────────────────────────────────────
// The server's only clients are browser tabs, each holding one open SSE
// connection in `clients`. When the last one closes (user closed the tab or
// the whole browser), exit after a grace period — unless a client reconnects
// in time (refresh, new tab). Set ISMINI_NO_AUTOEXIT=1 to keep it alive.
const AUTO_EXIT = process.env.ISMINI_NO_AUTOEXIT !== '1';
const SHUTDOWN_GRACE_MS = 10000;
let shutdownTimer = null;
function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    console.log('client returned — staying alive');
  }
}
// busy is declared later in this module, but by the time scheduleShutdown runs
// it is initialized — referencing it here is safe (function body executes lazily).
let busy = false; // hoisted declaration so shutdown logic can read it before line 239
function scheduleShutdown(reason) {
  if (!AUTO_EXIT || shutdownTimer || clients.size > 0) return;
  // Never exit while a turn is running — that would kill the in-flight task,
  // skip its session save, and orphan any detached child commands. Wait for the
  // turn to finish (runTurn's finally block calls scheduleShutdown again).
  if (busy) {
    console.log(`last client gone (${reason}) — a turn is running; will exit after it finishes`);
    return;
  }
  console.log(`last client gone (${reason}) — exiting in ${SHUTDOWN_GRACE_MS / 1000}s if nobody reconnects`);
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    // Re-check at fire time: a turn may have started during the grace period.
    if (busy) { console.log('turn started during grace — staying alive'); return; }
    console.log('no clients — shutting down');
    for (const res of clients) { try { res.end(); } catch { } }
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

// Data dir: ~/ismini (user-writable) so a .deb install into root-owned
// /opt/ismini never blocks saving. ISMINI_HOME overrides; if the data dir is
// not writable, fall back to the app dir (install.sh layout).
function resolveDataDir() {
  const candidates = [];
  if (process.env.ISMINI_HOME) candidates.push(process.env.ISMINI_HOME);
  try { candidates.push(join(homedir(), 'ismini')); } catch {}
  candidates.push(__dirname);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      // If sessions.json exists, we can use this dir (it's writable since we just created it)
      if (existsSync(join(dir, 'sessions.json'))) return dir;
      // Otherwise check if directory is writable
      accessSync(dir, fsConstants.W_OK);
      return dir;
    } catch { /* try next */ }
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();

// One-time migration: data saved under the app dir (old .deb installs) moves to
// ~/ismini so upgrades keep chat history and memory.
if (DATA_DIR !== __dirname && existsSync(join(__dirname, 'sessions.json'))) {
  try { renameSync(join(__dirname, 'sessions.json'), join(DATA_DIR, 'sessions.json')); console.log(`[data] migrated sessions.json to ${DATA_DIR}`); } catch {}
}
if (DATA_DIR !== __dirname && existsSync(join(__dirname, 'memory.json'))) {
  try { renameSync(join(__dirname, 'memory.json'), join(DATA_DIR, 'memory.json')); console.log(`[data] migrated memory.json to ${DATA_DIR}`); } catch {}
}

const ui = new WebUI(broadcast);
const sessions = new SessionStore(DATA_DIR);
const memory = new MemoryStore(DATA_DIR);

// ── Conversation hygiene ─────────────────────────────────────────────────────
// Internal loop-control messages are needed by the model while a turn is running,
// but they must never be shown to the user or persisted as normal chat history.
const LEGACY_TOOL_PREFIX = '[NEED ANSWER] Command output below. Summarize it and give a direct text answer — do not call more tools unless the task explicitly requires it.\n\n';

function cleanMessage(m) {
  if (m?.role === 'tool' && typeof m.content === 'string' && m.content.startsWith(LEGACY_TOOL_PREFIX)) {
    return { ...m, content: m.content.slice(LEGACY_TOOL_PREFIX.length) };
  }
  return m;
}

function isDisplayableMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (!['user', 'assistant', 'tool'].includes(m.role)) return false;
  if (m.internal === true) return false;
  const content = typeof m.content === 'string' ? m.content : '';
  if (m.role === 'user' && (
    content.startsWith('You called exec above and got the result.') ||
    content.startsWith('[SYSTEM NOTE] The "')
  )) return false;
  return true;
}

function visibleMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter(isDisplayableMessage).map(cleanMessage)
    : [];
}

const agent = new Agent({
  baseUrl: config.model.baseUrl,
  apiKey: config.model.apiKey,
  modelId: '',
  systemPrompt: config.agent.systemPrompt,
  timeoutSeconds: config.agent.timeoutSeconds || 3600,
  contextWindow: config.agent.contextWindow || 131072,
  temperature: config.agent.temperature,
  maxTurns: config.agent.maxTurns,
  maxTokens: config.agent.maxTokens,
  sudo: config.tools?.sudo !== false,
  enabledTools: config.tools?.enabled || ['read', 'write', 'edit', 'exec', 'web_search', 'web_fetch', 'memory_add', 'memory_search', 'memory_delete'],
  memory,
  ui: ui,
  requestConfirmation, // gate destructive/privileged tools behind a user prompt
});

// ── Model badge (best effort, short timeout) ───────────────────────────────
async function detectModel() {
  const tries = [config.model.baseUrl + '/models', 'http://localhost:1234/api/v0/models'];
  for (const url of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      const id = j?.data?.[0]?.id;
      if (id) return id;
    } catch { /* try next */ }
  }
  return null;
}

// ── Model-agnostic support ─────────────────────────────────────────────────
// Never pin a model: whatever LM Studio has loaded is used. Auto-detect the
// loaded model's real context length so limits adapt to ANY model — and to
// mid-session model swaps.
async function detectLoadedModel(base) {
  try {
    const root = base.replace(/\/v1\/?$/, '');
    const resp = await fetch(root + '/api/v0/models', { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const all = data.data || [];
    const m = all.find(x => x.state === 'loaded' || x.loaded_context_length) || all[0];
    if (!m) return null;
    return {
      id: m.id,
      context: m.loaded_context_length || m.max_context_length || null,
      tools: Array.isArray(m.capabilities) && m.capabilities.includes('tool_use'),
      vision: modelSupportsVision(m),
    };
  } catch {
    return null; // older LM Studio / API unavailable — fall back to config values
  }
}

function applyLoadedModel(agent, det, cfg) {
  const cfgCtx = cfg.agent.contextWindow || 131072;
  const cfgMax = cfg.agent.maxTokens || 8192;
  const ctx = det?.context ? Math.min(cfgCtx, det.context) : cfgCtx;
  const max = Math.max(256, Math.min(cfgMax, ctx - 1024));
  agent.contextWindow = ctx;
  agent.maxTokens = max;
  agent.loadedModel = det;
  // Set modelId so _enforceContextWindow can pick a realistic chars/token
  // estimate for THIS model. Previously it stayed '' and always used the
  // conservative default, overestimating tokens and wasting most of the window.
  if (det?.id) agent.modelId = det.id;
  if (det) agent.supportsVision = det.vision ?? null;
  return { ctx, max };
}

// Apply at startup (best effort — server must work even if detection fails)
try {
  const det = await detectLoadedModel(config.model.baseUrl);
  if (det) {
    applyLoadedModel(agent, det, config);
    console.log(`model          →  ${det.id}` + (det.context ? `  (ctx ${det.context.toLocaleString()})` : '') + (det.tools ? '' : '  ⚠ no tool_use capability'));
  }
} catch { /* fall back to config values */ }

// ── Restore active session on startup ─────────────────────────────────────
const rawActiveSession = sessions.getActive();
const activeMessages = visibleMessages(rawActiveSession?.messages || []);
if (rawActiveSession) {
  agent.loadMessages(activeMessages);
  sessions.saveActive(activeMessages); // also cleans any legacy internal notes from disk
  console.log(`session        →  restored (${activeMessages.length} messages)`);
} else {
  // No saved session — create a fresh one
  sessions.create();
  console.log('session        →  new (no previous session found)');
}

// ── Run orchestration ───────────────────────────────────────────────────────
// The Agent streams model tokens directly via process.stdout.write (and
// tools may console.log). While a turn is running we route those writes
// into the SSE 'token' stream instead of the terminal. Box borders
// (pure ─ lines) are terminal decoration — filtered out for the web chat.
// ── Confirmation gate for destructive / privileged tools ───────────────────
// The agent blocks on this before running exec/write/edit/delete/sudo. We push
// a 'confirm' event to the UI and wait (up to CONFIRM_TIMEOUT_MS) for the user
// to answer via POST /confirm. If they don't answer in time, we deny — fail safe.
let pendingConfirm = null;
const CONFIRM_TIMEOUT_MS = 120000; // 2 minutes to decide
async function requestConfirmation({ tool, detail }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; pendingConfirm = null; resolve(ok); } };
    pendingConfirm = { tool, detail, finish };
    broadcast({ type: 'confirm', tool, detail });
    setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS).unref();
  });
}

async function runTurn(text) {
  busy = true;
  // Re-detect the loaded model every turn — supports swapping models in
  // LM Studio mid-session; limits adapt automatically.
  try {
    const det = await detectLoadedModel(config.model.baseUrl);
    const prevId = agent.loadedModel?.id;
    applyLoadedModel(agent, det, config);
    if (det && det.id !== prevId) {
      broadcast({ type: 'modelSwitch', id: det.id });
    }
  } catch { /* keep previous limits */ }
  const orig = process.stdout.write;
  process.stdout.write = (chunk, enc, cb) => {
    const s = Buffer.isBuffer(chunk) ? chunk.toString(enc || 'utf8') : String(chunk);
    const t = s.trim();
    // Filter out internal log messages that shouldn't appear in web chat
    if (t && !/^─+$/.test(t)) {
      // Skip internal logs: [turn], [data], model/session info, shutdown messages
      if (!/^\[(turn|data|ismini)\]/.test(t) && 
          !/^(model|session|last client|no clients|client returned)/.test(t) &&
          !/^bye!/.test(t)) {
        broadcast({ type: 'token', text: s });
      }
    }
    if (typeof enc === 'function') enc();
    if (typeof cb === 'function') cb();
    return true;
  };
  let paused = false;
  const turnStart = Date.now();
  try {
    await agent.run(text);
    console.log(`[turn] ok in ${((Date.now() - turnStart) / 1000).toFixed(1)}s — history: ${agent.messages.length} messages`);
  } catch (err) {
    if (err.name === 'AbortError') {
      paused = true;
      console.log(`[turn] paused after ${((Date.now() - turnStart) / 1000).toFixed(1)}s — history: ${agent.messages.length} messages`);
      broadcast({ type: 'paused' });
    } else {
      // Log the FULL error (not just the message) so a silent model failure
      // in a long session is diagnosable from ~/ismini/ismini.log.
      console.error(`[turn] FAILED after ${((Date.now() - turnStart) / 1000).toFixed(1)}s — history: ${agent.messages.length} messages:\n${err?.stack || err}`);
      broadcast({ type: 'error', text: err?.message || String(err) });
    }
  } finally {
    process.stdout.write = orig;
    busy = false;
    // Auto-save session after each turn (internal loop-control messages excluded)
    sessions.saveActive(visibleMessages(agent.messages));
    if (!paused) broadcast({ type: 'done', messages: visibleMessages(agent.messages).length });
    // If the tab closed mid-turn, scheduleShutdown was deferred. Now that the
    // turn is done (and saved), re-check so we can exit cleanly.
    if (clients.size === 0) scheduleShutdown('turn finished');
  }
}

// Compare two version strings (e.g., "10.0.2" vs "10.0.3")
// Returns: -1 if a < b, 0 if equal, 1 if a > b
function compareVersions(a, b) {
  const partsA = a.split(".").map(n => parseInt(n, 10));
  const partsB = b.split(".").map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const vA = partsA[i] || 0;
    const vB = partsB[i] || 0;
    if (vA < vB) return -1;
    if (vA > vB) return 1;
  }
  return 0;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

// Compare two version strings (e.g., '10.0.2' vs '10.0.3')
// Returns: -1 if a < b, 0 if equal, 1 if a > b

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (d) => {
      if (tooLarge) return;
      size += d.length;
      if (size > limit) {
        tooLarge = true;
        req.destroy(); // stop receiving data — free the socket
        const error = new Error('request body is too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      port === String(PORT);
  } catch {
    return false;
  }
}

// ── Native file picker ──────────────────────────────────────────────────────
// Opens a native DESKTOP dialog (zenity on GNOME, kdialog on KDE) and
// returns the chosen path — a file or a folder. Nothing is opened or
// uploaded: the path is only inserted into the chat input.
function runPicker(bin, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ran: false });
    }
    let out = '', errOut = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { }
      resolve({ ran: true, error: 'file picker timed out' });
    }, 300000); // 5 minutes to pick
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ran: false }); }); // binary missing
    child.on('close', (code) => {
      clearTimeout(timer);
      const path = out.trim().split('\n')[0].trim();
      if (code === 0 && path) return resolve({ ran: true, path });
      // Non-zero exit = user cancelled (zenity: 1, kdialog: 10) — unless
      // stderr shows the dialog couldn't open at all (no display), in which
      // case we let the caller try the next tool.
      if (!/display|cannot open/i.test(errOut)) return resolve({ ran: true, cancelled: true });
      resolve({ ran: false });
    });
  });
}

async function pickNativeFile(mode) {
  // mode: 'file' or 'folder'. kdialog has no single dialog for both
  // (in file mode, picking a folder just navigates into it), so each
  // mode gets its own native dialog per desktop.
  const candidates = mode === 'folder'
    ? [
        { bin: 'zenity', args: ['--directory', '--title=Pick a folder for ismini'] },
        { bin: 'kdialog', args: ['--getexistingdirectory', '', '--title', 'Pick a folder for ismini'] },
      ]
    : [
        { bin: 'zenity', args: ['--file-selection', '--title=Pick a file for ismini'] },
        { bin: 'kdialog', args: ['--getopenfilename', '', '--title', 'Pick a file for ismini'] },
      ];
  for (const c of candidates) {
    const r = await runPicker(c.bin, c.args);
    if (r.ran) return r; // success, cancel, or timeout — don't try the next tool
  }
  return { error: 'no native file dialog available (install zenity or kdialog)' };
}

let pickInProgress = false; // one dialog at a time (button double-clicks)
let pickLockPromise = Promise.resolve(); // serializes file picker requests

// ── HTTP server ─────────────────────────────────────────────────────────────
const INDEX_HTML = readFileSync(join(__dirname, 'web', 'index.html'), 'utf8')
  .replaceAll('__ISMINI_VERSION__', APP_VERSION);
const LIVE_TTS_MODULE = readFileSync(join(__dirname, 'web', 'live-tts.js'), 'utf8');

// Static assets cached at startup to avoid blocking the event loop
function cacheFile(path) {
  try { return readFileSync(path); }
  catch { return null; }
}

const STATIC_ASSETS = {
  // Favicon for the browser tab (served at /favicon-256.png)
  favicon: cacheFile(join(__dirname, 'web', 'favicon-256.png')),
  
  // Faded meander stripe (pre-baked 25% alpha) — served at /meander-faded.png
  meanderFaded: cacheFile(join(__dirname, 'web', 'transpmeander-faded.png')),
  
  // Black marble background for the marble theme
  marbleBg: cacheFile(join(__dirname, 'web', 'marble.jpeg')),
  
  // Twinkling starfield for the dark theme
  starsBg: cacheFile(join(__dirname, 'web', 'stars.gif')),
  
  // Hero screenshot on the welcome screen
  heroImage: cacheFile(join(__dirname, 'web', '2.jpeg')),
  
  // Full-strength meander border
  meander: cacheFile(join(__dirname, 'web', 'transpmeander.png')),
  
  // Cogito image
  cogito: cacheFile(join(__dirname, 'web', 'Cogito,ergo sum.jpeg')),
  
  // Papyrus background for the light theme (cached at startup)
  bgJpg: cacheFile(join(__dirname, 'web', 'bg.jpg')),
};

// Helper function to get SHA256 hash of a release asset from GitHub API
async function getReleaseAssetHash(version, assetName) {
  try {
    const resp = await fetch(`https://api.github.com/repos/tasosdelotas/ismini-linux/releases/tags/v${version.replace(/^v/, '')}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    
    const data = await resp.json();
    const asset = data.assets?.find(a => a.name === assetName);
    if (asset && asset.browser_download_url) {
      // For now, just verify the asset exists and return its hash
      // In production, you'd download and compare hashes
      return null; // Hash verification disabled for simplicity - use at your own risk
    }
  } catch { /* ignore */ }
  return null;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin && !isLocalOrigin(origin)) || (!origin && fetchSite === 'cross-site')) {
    return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
  }

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: 'bad url' }); }

  try {
    cancelShutdown(); // any request means a client is present — cancel pending shutdown
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
    }
    else if (req.method === 'GET' && url.pathname === '/live-tts.js') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(LIVE_TTS_MODULE);
    }
    else if (req.method === 'GET' && url.pathname === '/favicon-256.png') {
      if (!STATIC_ASSETS.favicon) return sendJson(res, 404, { error: 'no favicon' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': STATIC_ASSETS.favicon.length });
      res.end(STATIC_ASSETS.favicon);
    }
    else if (req.method === 'GET' && url.pathname === '/fonts/cinzel.ttf') {
      // Cinzel (ancient-inscription display font) for the ISMINI wordmark
      const path = join(__dirname, 'web', 'fonts', 'cinzel.ttf');
      try { statSync(path); }
      catch { return sendJson(res, 404, { error: 'no font' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'font/ttf', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
      return;
    }
    else if (req.method === 'GET' && url.pathname === '/marble.jpeg') {
      // Black marble background for the marble theme
      const path = join(__dirname, 'web', 'marble.jpeg');
      try { statSync(path); }
      catch { return sendJson(res, 404, { error: 'no marble' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
      return;
    }
    else if (req.method === 'GET' && url.pathname === '/stars.gif') {
      // Twinkling starfield for the dark theme
      const path = join(__dirname, 'web', 'stars.gif');
      try { statSync(path); }
      catch { return sendJson(res, 404, { error: 'no starfield' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/gif', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
      return;
    }
    else if (req.method === 'GET' && url.pathname === '/bg.jpg') {
      // Papyrus background for the light theme
      const buf = STATIC_ASSETS.bgJpg;
      if (!buf) return sendJson(res, 404, { error: 'no background image' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/2.jpeg') {
      // Hero screenshot on the welcome screen
      const buf = STATIC_ASSETS.heroImage;
      if (!buf) return sendJson(res, 404, { error: 'no hero image' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/meander.png') {
      const buf = STATIC_ASSETS.meander;
      if (!buf) return sendJson(res, 404, { error: 'no meander image' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/meander-faded.png') {
      const buf = STATIC_ASSETS.meanderFaded;
      if (!buf) return sendJson(res, 404, { error: 'no faded meander' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/cogito.jpeg') {
      const buf = STATIC_ASSETS.cogito;
      if (!buf) return sendJson(res, 404, { error: 'no image' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { ...SECURITY_HEADERS,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      cancelShutdown();
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
      res.on('close', () => { clearInterval(ping); clients.delete(res); scheduleShutdown('tab closed'); });
      // initial state for this client
      const model = await detectModel();
      let models = [];
      try {
        const root = config.model.baseUrl.replace(/\/v1\/?$/, '');
        let resp, data;
        const tries = [root];
        if (!root.includes(':1234')) tries.push('http://localhost:1234');
        for (const r of tries) {
          try {
            resp = await fetch(r + '/api/v0/models', { signal: AbortSignal.timeout(5000) });
            if (resp.ok) { data = await resp.json(); break; }
          } catch { /* continue */ }
          try {
            resp = await fetch(r + '/api/v1/models', { signal: AbortSignal.timeout(5000) });
            if (resp.ok) { data = await resp.json(); break; }
          } catch { /* continue */ }
        }
        if (data && resp?.ok) {
          function getSimpleModelName(fullId) {
            return fullId ? fullId.split('/').pop() : '';
          }
          if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => ({ id: m.id, name: getSimpleModelName(m.id), loaded: m.state === 'loaded' || !!m.loaded_context_length }));
          } else if (data.models && Array.isArray(data.models)) {
            models = data.models.map(m => ({ id: m.key || m.id, name: getSimpleModelName(m.key || m.id), loaded: !!m.loaded_instances?.length }));
          }
        }
      } catch { /* ignore model list errors */ }
      try { res.write(`data: ${JSON.stringify({ type: 'hello', model, busy, messages: visibleMessages(agent.messages).length, models })}\n\n`); } catch { }
    }
    else if (req.method === 'POST' && url.pathname === '/send') {
      if (busy) return sendJson(res, 409, { error: 'agent busy — wait for the current turn to finish' });
      const body = await readBody(req, MAX_SEND_BODY_BYTES);
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected a JSON message' }); }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      const image = validateImageAttachment(payload?.image);
      if (!text && !image) return sendJson(res, 400, { error: 'enter a message or attach an image' });
      // Additional check: dataUrl string size (base64 overhead can make it larger than decoded bytes)
      if (image && Buffer.byteLength(image.dataUrl, 'utf8') > MAX_IMAGE_BYTES) {
        return sendJson(res, 413, { error: 'Image exceeds 4 MiB limit' });
      }
      const content = image
        ? [
          { type: 'text', text: text || 'What is in this image?' },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ]
        : text;
      sendJson(res, 202, { ok: true });
      runTurn(content); // streams via SSE; not awaited
    }
    else if (req.method === 'POST' && url.pathname === '/pause') {
      if (!busy) return sendJson(res, 409, { error: 'agent not running' });
      agent.pause();
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'POST' && url.pathname === '/confirm') {
      // Answer a pending destructive/privileged tool confirmation.
      const body = await readBody(req);
      let approved;
      try { approved = JSON.parse(body).approved; } catch { return sendJson(res, 400, { error: 'expected {"approved": true|false}' }); }
      if (typeof approved !== 'boolean') return sendJson(res, 400, { error: 'expected {"approved": true|false}' });
      if (!pendingConfirm) return sendJson(res, 200, { ok: false, ignored: true }); // already answered / timed out
      pendingConfirm.finish(approved);
      broadcast({ type: 'confirmed', approved });
      sendJson(res, 200, { ok: true, approved });
    }
    else if (req.method === 'POST' && url.pathname === '/new') {
      if (busy) return sendJson(res, 409, { error: 'agent busy — wait for the current turn to finish' });
      // Archive current session and start fresh
      sessions.saveActive(visibleMessages(agent.messages)); // ensure current state is saved
      const newSession = sessions.archiveAndCreate();
      agent.reset();
      broadcast({ type: 'reset', sessionId: newSession.id });
      sendJson(res, 200, { ok: true, sessionId: newSession.id });
    }
    else if (req.method === 'GET' && url.pathname === '/api/sudo') {
      sendJson(res, 200, { enabled: agent.allowSudo });
    }
    else if (req.method === 'POST' && url.pathname === '/api/sudo') {
      const body = await readBody(req);
      let enabled;
      try { enabled = JSON.parse(body).enabled; }
      catch { return sendJson(res, 400, { error: 'expected {"enabled": true|false}' }); }
      if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: 'expected {"enabled": true|false}' });
      agent.allowSudo = enabled; // applies live — next exec call picks it up
      config.tools = config.tools || {};
      config.tools.sudo = enabled;
      try {
        writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
      } catch (err) {
        return sendJson(res, 500, { error: 'applied for this run, but saving to config.json failed: ' + err.message });
      }
      sendJson(res, 200, { ok: true, enabled });
    }
    else if (req.method === 'GET' && url.pathname === '/api/pick-file') {
      const mode = url.searchParams.get('mode') === 'folder' ? 'folder' : 'file';
      
      // Serialize file picker requests using promise chaining to prevent race conditions
      pickLockPromise = pickLockPromise.then(async () => {
        if (pickInProgress) return sendJson(res, 409, { error: 'a file picker is already open' });
        
        pickInProgress = true;
        try {
          const r = await pickNativeFile(mode);
          if (r.path) return sendJson(res, 200, { ok: true, path: r.path });
          if (r.cancelled) return sendJson(res, 200, { ok: false, cancelled: true });
          sendJson(res, 503, { error: r.error || 'file picker unavailable' });
        } finally {
          pickInProgress = false;
        }
      }).catch(err => {
        pickInProgress = false;
        return sendJson(res, 500, { error: err.message });
      });
      
      // Wait for the promise to complete before returning
      await pickLockPromise;
    }
    else if (req.method === 'GET' && url.pathname === '/state') {
      const model = await detectModel();
      sendJson(res, 200, {
        busy, model,
        messages: visibleMessages(agent.messages).length,
        contextWindow: agent.contextWindow,
        maxTokens: agent.maxTokens,
        sessionId: sessions.getActive()?.id || null,
      });
    }
    else if (req.method === 'GET' && url.pathname === '/api/check-update') {
      // Check for new GitHub releases
      let currentVersion;
      try { currentVersion = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; }
      catch { currentVersion = APP_VERSION || '0.0.0'; }
      try {
        const r = await fetch('https://api.github.com/repos/tasosdelotas/ismini-linux/releases/latest');
        if (!r.ok) throw new Error('Failed to check GitHub releases');
        const data = await r.json();
        const latestVersion = data.tag_name.replace(/^v/, '');
        // Simple semver comparison
        const [curMaj, curMin, curPat] = currentVersion.split('.').map(Number);
        const [latMaj, latMin, latPat] = latestVersion.split('.').map(Number);
        const isNewer = latMaj > curMaj ||
          (latMaj === curMaj && latMin > curMin) ||
          (latMaj === curMaj && latMin === curMin && latPat > curPat);
        sendJson(res, 200, {
          currentVersion,
          latestVersion,
          tagName: data.tag_name,
          hasUpdate: isNewer,
          releaseUrl: data.html_url,
          body: data.body ? data.body.substring(0, 500) + (data.body.length > 500 ? '...' : '') : ''
        });
      } catch (err) {
        sendJson(res, 200, {
          currentVersion,
          latestVersion: null,
          hasUpdate: false,
          error: err.message
        });
      }
    }
    else if (req.method === 'POST' && url.pathname === '/api/download-update') {
      // POST /api/download-update — download and install the latest version
      try {
        const body = await readBody(req, 256);
        const payload = JSON.parse(body);
        const tagName = payload.tagName || '';
        
        if (!tagName) return sendJson(res, 400, { error: 'tagName required' });
        
        // Security check: only allow tags that look like versions (v1.2.3)
        if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
          return sendJson(res, 400, { error: 'Invalid tag format' });
        }
        
        // Get release info
        const releaseResp = await fetch(`https://api.github.com/repos/tasosdelotas/ismini-linux/releases/tags/${tagName}`);
        if (!releaseResp.ok) {
          throw new Error(`Failed to get release: ${releaseResp.status}`);
        }
        
        const releaseData = await releaseResp.json();
        const zipballUrl = releaseData.zipball_url;
        if (!zipballUrl) {
          throw new Error('No zipball URL found in release');
        }
        
        // Download the release
        const archiveResp = await fetch(zipballUrl, { signal: AbortSignal.timeout(120000) });
        if (!archiveResp.ok) {
          throw new Error(`Failed to download update: ${archiveResp.status}`);
        }
        
        // Save the archive
        const archivePath = join(homedir(), '.ismini-update.zip');
        const archiveBuffer = Buffer.from(await archiveResp.arrayBuffer());
        writeFileSync(archivePath, archiveBuffer);
        
        // Install: extract and replace files
        const destDir = join(homedir(), 'ismini');
        const tempDir = join(homedir(), '.ismini-update-temp');
        
        // Create temp directory
        mkdirSync(tempDir, { recursive: true });
        execSync(`unzip -q -o ${archivePath} -d ${tempDir}`);
        
        // Find the extracted folder (it has a naming pattern like tasosdelotas-ismini-linux-abcdef123)
        const extractedDirs = readdirSync(tempDir).filter(d => d.startsWith('tasosdelotas-ismini-linux-'));
        if (extractedDirs.length === 0) {
          throw new Error('Could not find extracted ismini folder');
        }
        
        const sourceDir = join(tempDir, extractedDirs[0]);
        
        // Replace files using rsync if available, otherwise cp
        try {
          execSync(`rsync -a ${sourceDir}/ ${destDir}/ --exclude='.git' 2>/dev/null`);
        } catch (err) {
          console.log('[ismini] rsync failed, trying cp: ' + err.message);
          execSync(`cp -r ${sourceDir}/* ${destDir}/`);
        }
        // Ensure package.json is updated
        try {
          const srcPkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
          writeFileSync(join(destDir, 'package.json'), JSON.stringify(srcPkg, null, 2));
          console.log('[ismini] Updated package.json to version: ' + srcPkg.version);
        } catch (err) {
          console.warn('[ismini] Could not update package.json:', err.message);
        }
        
        // Cleanup
        unlinkSync(archivePath);
        execSync(`rm -rf ${tempDir}`);
        
        sendJson(res, 200, { success: true, version: tagName, message: 'Update installed successfully. Please restart ismini.' });
        
        // Stop the running app (after response sent)
        try {
          execSync(`pkill -f "node.*web.js" || true`);
        } catch (err) {
          console.log('[ismini] Could not stop running app: ' + err.message);
        }
      } catch (err) {
        console.error('[ismini] Update failed:', err.message);
        try { unlinkSync(join(homedir(), '.ismini-update.zip')); } catch {}
        try { execSync(`rm -rf ${join(homedir(), '.ismini-update-temp')}`); } catch {}
        sendJson(res, 500, { error: 'Update failed: ' + err.message });
      }
    }
    else if (req.method === 'GET' && url.pathname === '/api/sessions') {
      // List all sessions (newest first, max 3)
      const list = sessions.list().map(s => {
        const msgs = visibleMessages(s.messages);
        return ({
          id: s.id,
          started: s.started,
          lastActive: s.lastActive,
          messageCount: msgs.length,
          preview: msgs.find(m => m.role === 'user')?.content?.substring(0, 80) || '(empty)',
          active: s.id === sessions.data.activeId,
        });
      });
      sendJson(res, 200, { sessions: list, activeId: sessions.data.activeId });
    }
    else if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      // GET /api/sessions/:id — get full session
      const id = url.pathname.split('/').pop();
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      sendJson(res, 200, { id: s.id, started: s.started, lastActive: s.lastActive, messages: visibleMessages(s.messages) });
    }
    else if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/switch/')) {
      // POST /api/sessions/switch/:id — switch active session
      if (busy) return sendJson(res, 409, { error: 'agent busy — wait for current turn to finish' });
      const id = url.pathname.split('/').pop();
      const s = sessions.switchTo(id);
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      const msgs = visibleMessages(s.messages);
      agent.loadMessages(msgs);
      sessions.saveActive(msgs); // persist the cleaned history
      broadcast({ type: 'sessionSwitched', sessionId: s.id, messages: msgs.length });
      sendJson(res, 200, { ok: true, sessionId: s.id, messages: msgs.length });
    }
    else if (req.method === 'GET' && url.pathname === '/api/models') {
      // GET /api/models — list all models from LM Studio
      try {
        const root = config.model.baseUrl.replace(/\/v1\/?$/, '');
        let resp, data;
        
        // Try configured URL first, then fall back to port 1234 if that fails
        const tries = [root];
        if (!root.includes(':1234')) tries.push('http://localhost:1234');
        
        for (const r of tries) {
          try {
            resp = await fetch(r + '/api/v0/models', { signal: AbortSignal.timeout(5000) });
            if (resp.ok) { data = await resp.json(); break; }
          } catch { /* continue */ }
          
          try {
            resp = await fetch(r + '/api/v1/models', { signal: AbortSignal.timeout(5000) });
            if (resp.ok) { data = await resp.json(); break; }
          } catch { /* continue */ }
        }
        
        if (!data || !resp?.ok) throw new Error('Failed to fetch models');
        
        let models = [];
        // Helper: extract model name after last /
        function getSimpleModelName(fullId) {
          if (!fullId) return '';
          const parts = fullId.split('/');
          return parts[parts.length - 1];
        }
        // v0 API: {"data":[{"id":"...","state":"loaded",...]}
        if (data.data && Array.isArray(data.data)) {
          models = data.data.map(m => ({
            id: m.id,
            name: getSimpleModelName(m.id),
            loaded: m.state === 'loaded' || !!m.loaded_context_length,
            context: m.loaded_context_length || m.max_context_length || null
          }));
        }
        // v1 API: {"models":[{"id":"...","key":...,...]}
        else if (data.models && Array.isArray(data.models)) {
          models = data.models.map(m => ({
            id: m.key || m.id,
            name: getSimpleModelName(m.key || m.id),
            loaded: !!m.loaded_instances?.length,
            context: m.max_context_length || null
          }));
        }
        
        sendJson(res, 200, { models });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to fetch models: ' + err.message });
      }
    }
    else if (req.method === 'POST' && url.pathname === '/api/model/switch') {
      // POST /api/model/switch — switch loaded model
      try {
        const body = await readBody(req, 1024);
        const payload = JSON.parse(body);
        const targetId = payload.modelId;
        
        if (!targetId) return sendJson(res, 400, { error: 'modelId required' });
        if (busy) return sendJson(res, 409, { error: 'agent busy — wait for current turn to finish' });
        
        const root = config.model.baseUrl.replace(/\/v1\/?$/, '');
        
        // First, unload currently loaded model(s)
        let listResp = await fetch(root + '/api/v0/models', { signal: AbortSignal.timeout(5000) });
        if (!listResp.ok) listResp = await fetch(root + '/api/v1/models', { signal: AbortSignal.timeout(5000) });
        
        if (listResp.ok) {
          const listData = await listResp.json();
          let loadedModels = [];
          
          // v0 format
          if (listData.data && Array.isArray(listData.data)) {
            loadedModels = listData.data.filter(m => m.state === 'loaded' || !!m.loaded_context_length);
          }
          // v1 format  
          else if (listData.models && Array.isArray(listData.models)) {
            loadedModels = listData.models.filter(m => m.loaded_instances?.length > 0);
          }
          
          for (const m of loadedModels) {
            const instanceId = m.key || m.id;
            try {
              // Try v1 unload first
              let unloadResp = await fetch(root + '/api/v1/models/unload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ instance_id: instanceId }),
                signal: AbortSignal.timeout(30000),
              });
              
              if (!unloadResp.ok) {
                // Fallback to v0 DELETE
                await fetch(root + '/api/v0/models/' + encodeURIComponent(instanceId), {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  signal: AbortSignal.timeout(30000),
                });
              }
            } catch (err) {
              console.warn('[ismini] Failed to unload model:', instanceId, err.message);
            }
          }
        }
        
        // Wait a moment for unloading to complete
        await new Promise(r => setTimeout(r, 500));
        
        // Load the target model via v1 load API
        const loadResp = await fetch(root + '/api/v1/models/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: targetId }),
          signal: AbortSignal.timeout(90000), // 90 seconds for loading large models
        });
        
        if (!loadResp.ok) {
          throw new Error('Load failed with status ' + loadResp.status);
        }
        
        const loadResult = await loadResp.json();
        // Only log to console - do not output to chat
        console.log('[ismini] Model switched:', targetId);
        console.log('[ismini] Load result:', JSON.stringify(loadResult, (key, value) => {
          // Remove any 'type' field that might be confused with SSE message types
          if (key === 'type') return '[redacted]';
          return value;
        }));
        
        // Update agent to use the new model
        console.log('[ismini] About to update agent with new model:', targetId);
        broadcast({ type: 'modelSwitch', id: targetId });
        const det = await detectLoadedModel(config.model.baseUrl);
        console.log('[ismini] detectLoadedModel returned:', JSON.stringify(det));
        applyLoadedModel(agent, det, config);
        console.log('[ismini] Agent updated successfully');
        
        sendJson(res, 200, { ok: true, message: 'Model switched to: ' + targetId, loadedModel: det });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to switch model: ' + err.message });
      }
    }
    else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    try { sendJson(res, err?.statusCode || 500, { error: err?.message || String(err) }); } catch { }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ismini web UI  →  http://${HOST}:${PORT}`);
  console.log(`model endpoint →  ${config.model.baseUrl}   (Ctrl+C to stop)`);
});

// Safety net: runTurn is fire-and-forget, so an uncaught async error anywhere
// in a turn would otherwise become an unhandled rejection and crash the whole
// server. Log it and keep serving — one bad turn shouldn't take down ismini.
process.on('unhandledRejection', (err) => {
  console.error('[ismini] unhandled rejection (ignored, staying alive):', err?.stack || err);
});

process.on('SIGINT', () => {
  console.log('\nbye!');
  for (const res of clients) { try { res.end(); } catch { } }
  process.exit(0);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node web.js --port ${PORT + 1}`);
    process.exit(1);
  }
  throw err;
});
