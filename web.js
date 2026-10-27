// web.js — ismini WebUI: complete server with llama.cpp backend
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, createReadStream, createWriteStream, accessSync, constants as fsConstants, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
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

const ROUTES = new Map();
function registerRoute(method, path, handler) {
  const key = `${method} ${path}`;
  if (ROUTES.has(key)) throw new Error(`Duplicate route: ${key}`);
  ROUTES.set(key, handler);
}

// Fixed: all () = > changed to () =>
registerRoute('GET', '/', () => {});
registerRoute('GET', '/live-tts.js', () => {});
registerRoute('GET', '/favicon-256.png', () => {});
registerRoute('GET', '/favicon-180.png', () => {});
registerRoute('GET', '/favicon-192.png', () => {});
registerRoute('GET', '/favicon-512.png', () => {});
registerRoute('GET', '/favicon-64.png', () => {});
registerRoute('GET', '/favicon-32.png', () => {});
registerRoute('GET', '/manifest.webmanifest', () => {});
registerRoute('GET', '/icons/icon-192.png', () => {});
registerRoute('GET', '/icons/icon-512.png', () => {});
registerRoute('GET', '/icons/icon-maskable-512.png', () => {});
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
registerRoute('GET', '/api/window-size', () => {});
registerRoute('POST', '/api/window-size', () => {});
registerRoute('GET', '/api/context', () => {});
registerRoute('POST', '/api/context', () => {});
registerRoute('GET', '/state', () => {});
registerRoute('GET', '/transcript', () => {});
registerRoute('GET', '/api/check-update', () => {});
registerRoute('POST', '/api/download-update', () => {});
registerRoute('GET', '/api/sessions', () => {});
registerRoute('GET', '/api/sessions/:id', () => {});
registerRoute('POST', '/api/sessions/switch/', () => {});
registerRoute('POST', '/api/sessions/delete/', () => {});
registerRoute('POST', '/api/sessions/delete-all', () => {});
registerRoute('GET', '/api/models', () => {});
registerRoute('POST', '/api/model/switch', () => {});
registerRoute('GET', '/api/huggingface/models', () => {});
registerRoute('GET', '/api/huggingface/model-details', () => {});
registerRoute('GET', '/api/huggingface/models-batch', () => {});
registerRoute('POST', '/api/model/download', () => {});
registerRoute('POST', '/api/model/download/pause', () => {});
registerRoute('POST', '/api/model/download/cancel', () => {});
registerRoute('GET', '/api/hf-token', () => {});
registerRoute('POST', '/api/hf-token', () => {});
registerRoute('DELETE', '/api/hf-token', () => {});
registerRoute('GET', '/api/pick-file', () => {});
registerRoute('GET', '/api/backend', () => {});

let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.error('No config.json found.');
  process.exit(1);
}

const LLAMA_PORT = config.llamaCpp?.port || 8080;
const LLAMA_BASE = `http://localhost:${LLAMA_PORT}`;
let backend = null;

async function getBackend() {
  if (!backend) {
    try {
      const module = await import('./llama-backend.js');
      backend = new module.LlamaBackend(config, { dataDir: DATA_DIR, modelsDir: join(DATA_DIR, 'models') });
    } catch (err) {
      console.error('[web] Failed to load llama-backend:', err.message);
    }
  }
  return backend;
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
      const val = Number(args[i]);
      if (val < 1 || val > 65535) throw new Error(`Invalid port: ${val}`);
      port = val;
    }
  }
  return port;
}

const PORT = parseArgs();
const HOST = '127.0.0.1';

class WebUI {
  constructor(broadcast) { this.broadcast = broadcast; }
  showWarning(text) { this.broadcast({ type: 'warn', text: String(text) }); }
  showError(text) { this.broadcast({ type: 'error', text: String(text) }); }
  showModelMessage(text) { this.broadcast({ type: 'model', text: String(text) }); }
  showToolOutput(name, result) { this.broadcast({ type: 'tool', name: String(name), result: String(result) }); }
  _c(color, text) { return text; }
}

const clients = new Set();
const broadcast = (evt) => {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); continue; }
      const ok = res.write(payload);
      if (!ok) res.once('drain', () => {});
    } catch { clients.delete(res); }
  }
};

const AUTO_EXIT = process.env.ISMINI_NO_AUTOEXIT !== '1';
const SHUTDOWN_GRACE_MS = 5000;
let shutdownTimer = null;

function cancelShutdown() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; console.log('client returned — staying alive'); }
}

let busy = false;
// Set true while an in-app update is running (download + install + relaunch). This
// BLOCKS the auto-exit below from suicide-firing mid-update: if the browser tab
// closes during the ~94 MB download, `clients` empties and the old code would call
// process.exit(0), killing the in-flight download → the browser saw "Failed to fetch".
let updating = false;

function scheduleShutdown(reason) {
  if (!AUTO_EXIT || shutdownTimer || clients.size > 0) return;
  if (busy || updating) return;
  console.log(`last client gone (${reason}) — exiting in ${SHUTDOWN_GRACE_MS / 1000}s`);
  shutdownTimer = setTimeout(async () => {
    shutdownTimer = null;
    if (busy) return;
    console.log('no clients — shutting down');
    const b = await getBackend();
    if (b) await b.stop();
    for (const res of clients) { try { res.end(); } catch {} }
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

function resolveDataDir() {
  const candidates = [];
  if (process.env.ISMINI_HOME) candidates.push(process.env.ISMINI_HOME);
  try { candidates.push(join(homedir(), 'ismini')); } catch {}
  candidates.push(__dirname);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(join(dir, 'sessions.json'))) return dir;
      accessSync(dir, fsConstants.W_OK);
      return dir;
    } catch {}
  }
  return __dirname;
}

const DATA_DIR = resolveDataDir();

if (DATA_DIR !== __dirname && existsSync(join(__dirname, 'sessions.json'))) {
  try { renameSync(join(__dirname, 'sessions.json'), join(DATA_DIR, 'sessions.json')); } catch {}
}
if (DATA_DIR !== __dirname && existsSync(join(__dirname, 'memory.json'))) {
  try { renameSync(join(__dirname, 'memory.json'), join(DATA_DIR, 'memory.json')); } catch {}
}

const LOG_FILE = join(DATA_DIR, 'ismini.log');
try {
  const stats = statSync(LOG_FILE);
  if (stats.size > 10 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.old');
} catch {}

const HF_TOKEN_FILE = join(DATA_DIR, 'hf-token');

function getHfToken() {
  try { return readFileSync(HF_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function hfHeaders() {
  const headers = { 'User-Agent': 'ismini-agent' };
  const token = getHfToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// Remove a model's subdirectory if it ended up empty after a cancelled/failed download
function cleanupEmptyModelDir(dir) {
  try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch {}
}

const ui = new WebUI(broadcast);
const sessions = new SessionStore(DATA_DIR);
const memory = new MemoryStore(DATA_DIR);

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
  if (m.role === 'user' && (content.startsWith('You called exec above and got the result.') || content.startsWith('[SYSTEM NOTE] The "'))) return false;
  return true;
}

function visibleMessages(messages) {
  return Array.isArray(messages) ? messages.filter(isDisplayableMessage).map(cleanMessage) : [];
}

function getAgentConfig() {
  return { baseUrl: `http://localhost:${config.llamaCpp?.port || 8080}`, apiKey: '' };
}

const agentConfig = getAgentConfig();
const agent = new Agent({
  baseUrl: agentConfig.baseUrl,
  apiKey: agentConfig.apiKey,
  modelId: '',
  systemPrompt: config.agent.systemPrompt,
  timeoutSeconds: config.agent.timeoutSeconds || 3600,
  contextWindow: config.agent.contextWindow || 16384,
  temperature: config.agent.temperature,
  maxTurns: config.agent.maxTurns,
  maxTokens: config.agent.maxTokens,
  sudo: config.tools?.sudo !== false,
  enabledTools: config.tools?.enabled || ['read', 'write', 'edit', 'exec', 'web_search', 'web_fetch', 'memory_add', 'memory_search', 'memory_delete', 'recall'],
  memory,
  sessions,
  ui: ui,
  requestConfirmation,
});

async function detectModel() {
  try {
    const r = await fetch(`http://localhost:${config.llamaCpp?.port || 8080}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j?.data?.[0]?.id || null;
  } catch { return null; }
}

async function detectLoadedModel() {
  try {
    const resp = await fetch(`http://localhost:${config.llamaCpp?.port || 8080}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const m = (data.data || [])[0];
    if (!m) return null;
    // The context is whatever the user set in config (manual, no auto-detection).
    const ctx = config.llamaCpp?.context || 16384;
    return { id: m.id, context: ctx, tools: true, vision: null };
  } catch { return null; }
}

function applyLoadedModel(agent, det, cfg) {
  const ctx = det?.context || cfg.agent.contextWindow || 16384;
  const cfgMax = cfg.agent.maxTokens || 8192;
  const max = Math.max(256, Math.min(cfgMax, ctx - 1024));
  agent.contextWindow = ctx;
  agent.maxTokens = max;
  agent.loadedModel = det;
  if (det?.id) agent.modelId = det.id;
  if (det) agent.supportsVision = det.vision ?? null;
  return { ctx, max };
}

try {
  const det = await detectLoadedModel();
  if (det) { applyLoadedModel(agent, det, config); console.log(`model → ${det.id}`); }
} catch {}

const rawActiveSession = sessions.getActive();
const activeMessages = visibleMessages(rawActiveSession?.messages || []);
if (rawActiveSession) {
  agent.loadMessages(activeMessages);
  sessions.saveActive(activeMessages);
  console.log(`session → restored (${activeMessages.length} messages)`);
} else {
  sessions.create();
  console.log('session → new');
}

let pendingConfirm = null;
const CONFIRM_TIMEOUT_MS = 120000;

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
  try {
    const det = await detectLoadedModel();
    const prevId = agent.loadedModel?.id;
    applyLoadedModel(agent, det, config);
    if (det && det.id !== prevId) broadcast({ type: 'modelSwitch', id: det.id });
  } catch {}

  const orig = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    const enc = typeof encoding === 'string' ? encoding : 'utf8';
    const cb = typeof encoding === 'function' ? encoding : callback;
    const s = Buffer.isBuffer(chunk) ? chunk.toString(enc) : String(chunk);
    const t = s.trim();
    if (t && !/^─+$/.test(t)) {
      if (!/^\[?(turn|data|ismini)\]/.test(t) && !/^(model|session|last client|no clients|client returned)/.test(t) && !/^bye!/.test(t)) {
        broadcast({ type: 'token', text: s });
      }
    }
    if (typeof callback === 'function') callback();
    else if (typeof cb === 'function') cb();
    return true;
  };

  let paused = false;
  const turnStart = Date.now();
  try {
    await agent.run(text);
    console.log(`[turn] ok in ${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err.name === 'AbortError') { paused = true; broadcast({ type: 'paused' }); }
    else { console.error(`[turn] FAILED:\n${err?.stack || err}`); broadcast({ type: 'error', text: err?.message || String(err) }); }
  } finally {
    process.stdout.write = orig;
    busy = false;
    sessions.saveActive(visibleMessages(agent.messages));
    if (!paused) broadcast({ type: 'done', messages: visibleMessages(agent.messages).length });
    if (clients.size === 0) scheduleShutdown('turn finished');
  }
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooLarge = false;
    req.on('data', (d) => { if (tooLarge) return; size += d.length; if (size > limit) { tooLarge = true; req.destroy(); const error = new Error('request body is too large'); error.statusCode = 413; reject(error); return; } chunks.push(d); });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && port === String(PORT);
  } catch { return false; }
}

function runPicker(bin, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ ran: false }); }
    let out = '', errOut = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ran: true, error: 'file picker timed out' }); }, 300000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ ran: false }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const path = out.trim().split('\n')[0].trim();
      if (code === 0 && path) return resolve({ ran: true, path });
      if (!/display|cannot open/i.test(errOut)) return resolve({ ran: true, cancelled: true });
      resolve({ ran: false });
    });
  });
}

async function pickNativeFile(mode) {
  const candidates = mode === 'folder'
    ? [{ bin: 'zenity', args: ['--directory', '--title=Pick a folder for ismini'] }, { bin: 'kdialog', args: ['--getexistingdirectory', '', '--title', 'Pick a folder for ismini'] }]
    : [{ bin: 'zenity', args: ['--file-selection', '--title=Pick a file for ismini'] }, { bin: 'kdialog', args: ['--getopenfilename', '', '--title', 'Pick a file for ismini'] }];
  for (const c of candidates) { const r = await runPicker(c.bin, c.args); if (r.ran) return r; }
  return { error: 'no native file dialog available' };
}

let pickInProgress = false;
let pickLockPromise = Promise.resolve();

let INDEX_HTML = readFileSync(join(__dirname, 'web', 'index.html'), 'utf8').replaceAll('ISMINI_VERSION', APP_VERSION);
INDEX_HTML = INDEX_HTML.replace(
  /(<style[^>]*>)/i,
  `$1\n.mm-item .mm-size{font-size:11px;color:var(--dim);margin-left:8px;opacity:.7}\nhtml,body{height:100dvh!important;max-height:100dvh!important}`
);

const LIVE_TTS_MODULE = readFileSync(join(__dirname, 'web', 'live-tts.js'), 'utf8');

function cacheFile(path) { try { return readFileSync(path); } catch { return null; } }

const STATIC_ASSETS = {
  favicon: cacheFile(join(__dirname, 'web', 'favicon-256.png')),
  meanderFaded: cacheFile(join(__dirname, 'web', 'transpmeander-faded.png')),
  marbleBg: cacheFile(join(__dirname, 'web', 'marble.jpeg')),
  starsBg: cacheFile(join(__dirname, 'web', 'stars.gif')),
  heroImage: cacheFile(join(__dirname, 'web', '2.jpeg')),
  meander: cacheFile(join(__dirname, 'web', 'transpmeander.png')),
  cogito: cacheFile(join(__dirname, 'web', 'Cogito,ergo sum.jpeg')),
  bgJpg: cacheFile(join(__dirname, 'web', 'bg.jpg')),
};

const activeDownloads = new Map();

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin && !isLocalOrigin(origin)) || (!origin && fetchSite === 'cross-site')) return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad url' }); }

  try {
    cancelShutdown();

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
    }
    else if (req.method === 'GET' && url.pathname === '/live-tts.js') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(LIVE_TTS_MODULE);
    }
    else if (req.method === 'GET' && /^\/favicon-(16|32|48|64|180|192|256|512)\.png$/.test(url.pathname)) {
      // Serve any favicon size. The small sizes (16/32) are what Chromium embeds
      // into the window's _NET_WM_ICON for the title bar, so they must be crisp.
      const path = join(__dirname, 'web', url.pathname.replace(/^\//, ''));
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no favicon' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      // Chromium uses favicon.ico for the window icon (_NET_WM_ICON). Serve it
      // with no-cache so a regenerated icon is picked up immediately (the padded
      // favicon was being cached in the browser profile and re-served as a blurry
      // 16x16 title-bar icon).
      const path = join(__dirname, 'web', 'favicon.ico');
      try { const buf = readFileSync(path); res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/x-icon', 'cache-control': 'no-cache', 'content-length': buf.length }); res.end(buf); }
      catch { return sendJson(res, 404, { error: 'no favicon.ico' }); }
    }
    else if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const path = join(__dirname, 'web', 'manifest.webmanifest');
      try { const buf = readFileSync(path); res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache', 'content-length': buf.length }); res.end(buf); }
      catch { return sendJson(res, 404, { error: 'no manifest' }); }
    }
    else if (req.method === 'GET' && /^\/icons\/icon-(192|512|maskable-512)\.png$/.test(url.pathname)) {
      const path = join(__dirname, 'web', url.pathname.replace(/^\//, ''));
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no icon' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/fonts/cinzel.ttf') {
      const path = join(__dirname, 'web', 'fonts', 'cinzel.ttf');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no font' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'font/ttf', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/marble.jpeg') {
      const path = join(__dirname, 'web', 'marble.jpeg');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no marble' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/stars.gif') {
      const path = join(__dirname, 'web', 'stars.gif');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no starfield' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/gif', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/bg.jpg') {
      if (!STATIC_ASSETS.bgJpg) return sendJson(res, 404, { error: 'no background' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'content-length': STATIC_ASSETS.bgJpg.length });
      res.end(STATIC_ASSETS.bgJpg);
    }
    else if (req.method === 'GET' && url.pathname === '/2.jpeg') {
      if (!STATIC_ASSETS.heroImage) return sendJson(res, 404, { error: 'no hero' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': STATIC_ASSETS.heroImage.length });
      res.end(STATIC_ASSETS.heroImage);
    }
    else if (req.method === 'GET' && url.pathname === '/meander.png') {
      if (!STATIC_ASSETS.meander) return sendJson(res, 404, { error: 'no meander' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': STATIC_ASSETS.meander.length });
      res.end(STATIC_ASSETS.meander);
    }
    else if (req.method === 'GET' && url.pathname === '/meander-faded.png') {
      if (!STATIC_ASSETS.meanderFaded) return sendJson(res, 404, { error: 'no faded meander' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': STATIC_ASSETS.meanderFaded.length });
      res.end(STATIC_ASSETS.meanderFaded);
    }
    else if (req.method === 'GET' && url.pathname === '/cogito.jpeg') {
      if (!STATIC_ASSETS.cogito) return sendJson(res, 404, { error: 'no cogito' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': STATIC_ASSETS.cogito.length });
      res.end(STATIC_ASSETS.cogito);
    }
    else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      cancelShutdown();
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      res.on('close', () => { clearInterval(ping); clients.delete(res); scheduleShutdown('tab closed'); });
      const model = await detectModel();
      let models = [];
      try {
        const resp = await fetch(`http://localhost:${config.llamaCpp?.port || 8080}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const data = await resp.json();
          models = (data.data || []).map(m => ({ id: m.id, name: m.id ? m.id.split('/').pop() : '', loaded: true }));
        }
      } catch {}
      const b0 = await getBackend();
      const backendInfo = b0 ? { state: b0.state, model: b0.currentModel } : { state: 'error', model: null };
      try { res.write(`data: ${JSON.stringify({ type: 'hello', model, busy, messages: visibleMessages(agent.messages).length, contextWindow: agent.contextWindow, models, backend: backendInfo })}\n\n`); } catch {}
    }
    else if (req.method === 'POST' && url.pathname === '/send') {
      if (busy) return sendJson(res, 409, { error: 'agent busy' });
      const b = await getBackend();
      if (!b || b.state !== 'ready') {
        const msg = !b ? 'The model engine could not start.' : b.state === 'idle' ? 'No model yet — open 🤖 Models and download one.' : b.state === 'starting' ? 'Your model is still loading. ⏳' : 'The engine stopped.';
        return sendJson(res, 409, { error: msg });
      }
      const body = await readBody(req, MAX_SEND_BODY_BYTES);
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected JSON' }); }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      const image = validateImageAttachment(payload?.image);
      if (!text && !image) return sendJson(res, 400, { error: 'enter a message or attach an image' });
      if (image && Buffer.byteLength(image.dataUrl, 'utf8') > MAX_IMAGE_BYTES) return sendJson(res, 413, { error: 'Image exceeds 4 MiB limit' });
      const content = image ? [{ type: 'text', text: text || 'What is in this image?' }, { type: 'image_url', image_url: { url: image.dataUrl } }] : text;
      sendJson(res, 202, { ok: true });
      runTurn(content);
    }
    else if (req.method === 'POST' && url.pathname === '/pause') {
      if (!busy) return sendJson(res, 409, { error: 'agent not running' });
      agent.pause();
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'POST' && url.pathname === '/confirm') {
      const body = await readBody(req);
      let approved;
      try { approved = JSON.parse(body).approved; } catch { return sendJson(res, 400, { error: 'expected { approved: bool }' }); }
      if (typeof approved !== 'boolean') return sendJson(res, 400, { error: 'expected { approved: bool }' });
      if (!pendingConfirm) return sendJson(res, 200, { ok: false, ignored: true });
      pendingConfirm.finish(approved);
      broadcast({ type: 'confirmed', approved });
      sendJson(res, 200, { ok: true, approved });
    }
    else if (req.method === 'POST' && url.pathname === '/new') {
      if (busy) return sendJson(res, 409, { error: 'agent busy' });
      sessions.saveActive(visibleMessages(agent.messages));
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
      try { enabled = JSON.parse(body).enabled; } catch { return sendJson(res, 400, { error: 'expected { enabled: bool }' }); }
      if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: 'expected { enabled: bool }' });
      agent.allowSudo = enabled;
      config.tools = config.tools || {};
      config.tools.sudo = enabled;
      try { writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch {}
      sendJson(res, 200, { ok: true, enabled });
    }
    else if (req.method === 'GET' && url.pathname === '/api/window-size') {
      const ws = config.windowSize;
      const ok = ws && Number.isInteger(ws.width) && Number.isInteger(ws.height) && ws.width >= 200 && ws.height >= 150;
      sendJson(res, 200, ok ? { width: ws.width, height: ws.height } : {});
    }
    else if (req.method === 'POST' && url.pathname === '/api/window-size') {
      const body = await readBody(req);
      let width, height;
      try { width = JSON.parse(body).width; height = JSON.parse(body).height; } catch { return sendJson(res, 400, { error: 'expected { width: int, height: int }' }); }
      width = Math.round(Number(width)); height = Math.round(Number(height));
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || width > 8000 || height < 150 || height > 8000) {
        return sendJson(res, 400, { error: 'expected integer width (200-8000) and height (150-8000)' });
      }
      config.windowSize = { width, height };
      try { writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch {}
      sendJson(res, 200, { ok: true, width, height });
    }
    else if (req.method === 'GET' && url.pathname === '/api/context') {
      // Report the configured context length and what the backend is actually using.
      let activeCtx = null;
      try { const b = await getBackend(); activeCtx = b?.status?.()?.context || null; } catch {}
      const cfg = Number(config.llamaCpp?.context);
      sendJson(res, 200, {
        active: activeCtx || null,
        configured: Number.isFinite(cfg) && cfg > 0 ? cfg : 16384,
      });
    }
    else if (req.method === 'POST' && url.pathname === '/api/context') {
      const body = await readBody(req);
      let value;
      try { value = JSON.parse(body).value; } catch { return sendJson(res, 400, { error: 'expected { value: int }' }); }
      if (busy) return sendJson(res, 409, { error: 'ismini is busy — try again in a moment' });
      const b = await getBackend();
      if (!b) return sendJson(res, 503, { error: 'backend not available' });
      const v = Math.round(Number(value));
      if (!Number.isInteger(v) || v < 4096 || v > 262144) return sendJson(res, 400, { error: 'context must be an integer 4096–262144' });
      config.llamaCpp = config.llamaCpp || {};
      config.llamaCpp.context = v;
      config.agent = config.agent || {};
      config.agent.contextWindow = v;
      try { writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch {}
      // Restart the backend so the new -c takes effect (KV cache is allocated at
      // llama-server startup, so a context change requires a restart).
      broadcast({ type: 'toast', msg: 'Applying context length… (reloading model)' });
      const ok = await b.switchModel(b.currentModel);
      if (!ok) return sendJson(res, 500, { error: 'Could not restart the model — context change not applied' });
      const det = await detectLoadedModel();
      applyLoadedModel(agent, det, config);
      broadcast({ type: 'toast', msg: `Context length set to ${v.toLocaleString()} tokens` });
      sendJson(res, 200, { ok: true, active: v, value: v });
    }
    else if (req.method === 'GET' && url.pathname === '/api/pick-file') {
      const mode = url.searchParams.get('mode') === 'folder' ? 'folder' : 'file';
      pickLockPromise = pickLockPromise.then(async () => {
        if (pickInProgress) return sendJson(res, 409, { error: 'picker already open' });
        pickInProgress = true;
        try {
          const r = await pickNativeFile(mode);
          if (r.path) return sendJson(res, 200, { ok: true, path: r.path });
          if (r.cancelled) return sendJson(res, 200, { ok: false, cancelled: true });
          sendJson(res, 503, { error: r.error });
        } finally { pickInProgress = false; }
      }).catch(err => { pickInProgress = false; return sendJson(res, 500, { error: err.message }); });
      await pickLockPromise;
    }
    else if (req.method === 'GET' && url.pathname === '/state') {
      const model = await detectModel();
      sendJson(res, 200, { busy, model, messages: visibleMessages(agent.messages).length, contextWindow: agent.contextWindow, maxTokens: agent.maxTokens, sessionId: sessions.getActive()?.id || null });
    }
    else if (req.method === 'GET' && url.pathname === '/transcript') {
      const s = sessions.getActive();
      const msgs = s ? visibleMessages(s.messages) : [];
      sendJson(res, 200, { messages: msgs, busy, sessionId: s?.id || null });
    }
    else if (req.method === 'GET' && url.pathname === '/api/check-update') {
      let currentVersion;
      try { currentVersion = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; } catch { currentVersion = APP_VERSION || '0.0.0'; }
      try {
        const r = await fetch('https://api.github.com/repos/tasosdelotas/ismini-linux/releases/latest');
        if (!r.ok) throw new Error('Failed to check GitHub');
        const data = await r.json();
        const latestVersion = data.tag_name.replace(/^v/, '');
        const [curMaj, curMin, curPat] = currentVersion.split('.').map(Number);
        const [latMaj, latMin, latPat] = latestVersion.split('.').map(Number);
        const isNewer = latMaj > curMaj || (latMaj === curMaj && latMin > curMin) || (latMaj === curMaj && latMin === curMin && latPat > curPat);
        sendJson(res, 200, { currentVersion, latestVersion, tagName: data.tag_name, hasUpdate: isNewer, releaseUrl: data.html_url, body: data.body ? data.body.substring(0, 500) : '' });
      } catch (err) { sendJson(res, 200, { currentVersion, latestVersion: null, hasUpdate: false, error: err.message }); }
    }
    else if (req.method === 'POST' && url.pathname === '/api/download-update') {
      // AUTO-UPDATE = download the release zip, extract it, then drive install.sh
      // (reusing the SAME safe in-place logic as a manual reinstall: config merge,
      // icon/hicolor regeneration, stale-file cleanup, bundled-Node check). We do NOT
      // do a raw rsync/cp — that would bypass all of that and could leave a broken
      // install. Then we stop ONLY ismini's own server (not a broad pkill) and relaunch.
      const TAG_RE = /^v\d+\.\d+\.\d+[a-z0-9]*$/; // allow v16.1.0 and v13.0.2d-style tags
      try {
        const body = await readBody(req, 256);
        const payload = JSON.parse(body);
        const tagName = (payload.tagName || '').trim();
        if (!tagName || !TAG_RE.test(tagName)) return sendJson(res, 400, { error: 'Invalid tag' });
        if (busy) return sendJson(res, 409, { error: 'agent busy' });
        if (updating) return sendJson(res, 409, { error: 'update already in progress' });
        updating = true; // block auto-exit for the whole update (download + install + relaunch)

        // 1) Resolve the release + download the release asset.
        const releaseResp = await fetch(`https://api.github.com/repos/tasosdelotas/ismini-linux/releases/tags/${encodeURIComponent(tagName)}`);
        if (!releaseResp.ok) throw new Error('GitHub release not found');
        const releaseData = await releaseResp.json();
        // PREFER the real release ASSET (e.g. ismini-v17.0.0-linux-x64.zip), which contains the
        // actual node + llama-cpp binaries. Fall back to the Source-code zipball ONLY if no asset
        // is uploaded — but warn, because the zipball ships Git-LFS *pointer files* (not real
        // binaries) unless the repo has "Include Git LFS objects in archives" enabled.
        const asset = (releaseData.assets || []).find(
          a => /\.zip$/i.test(a.name) && /linux|ismini/i.test(a.name)
        ) || (releaseData.assets || []).find(a => /\.zip$/i.test(a.name));
        const archiveUrl = asset ? asset.browser_download_url : releaseData.zipball_url;
        if (!archiveUrl) throw new Error('Release has no downloadable archive (no .zip asset and no zipball)');
        console.log('[update] Downloading:', asset ? 'ASSET ' + asset.name : 'zipball (LFS pointer risk!)');
        const archiveResp = await fetch(archiveUrl, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
        if (!archiveResp.ok) throw new Error('Download failed');
        const archivePath = join(homedir(), '.ismini-update.zip');
        writeFileSync(archivePath, Buffer.from(await archiveResp.arrayBuffer()));

        // 2) Extract to a temp dir and find the release folder.
        const tempDir = join(homedir(), '.ismini-update-temp');
        execSync(`rm -rf '${tempDir}' && mkdir -p '${tempDir}'`);
        execSync(`unzip -q -o '${archivePath}' -d '${tempDir}'`);
        // The release archive has a single top-level folder. Its name differs by source:
        //   • GitHub auto-zipball → 'tasosdelotas-ismini-linux-<tag>/'
        //   • our uploaded asset  → 'ismini/'
        //   • a flat zip (no wrapper) → files sit directly in tempDir
        // Find the folder that actually contains install.sh (works for all three).
        const entries = readdirSync(tempDir);
        const topDirs = entries.filter(d => {
          if (!existsSync(join(tempDir, d))) return false; // must be a directory
          return existsSync(join(tempDir, d, 'install.sh'));
        });
        let sourceDir;
        if (topDirs.length === 1) {
          sourceDir = join(tempDir, topDirs[0]);
        } else if (topDirs.length > 1) {
          // Multiple wrappers — pick the one whose name looks like an ismini release.
          const pick = topDirs.find(d => /ismini/i.test(d)) || topDirs[0];
          sourceDir = join(tempDir, pick);
        } else if (existsSync(join(tempDir, 'install.sh'))) {
          sourceDir = tempDir; // flat zip, files at top level
        } else {
          throw new Error('Could not find install.sh in the release archive (unexpected zip layout)');
        }

        // 3) INSTALL FIRST (while we're still alive so we can report the result),
        //    THEN stop the old server, THEN relaunch the new one. This ordering is the
        //    fix for "Failed to fetch" / silent crash: the previous version killed the
        //    server BEFORE install — and because `server.pid` / `process.pid` both point
        //    at THIS process, it was SIGKILLing ITSELF mid-update (instant, no error).
        //    install.sh itself also stops the running app by PID (a second guard).
        const destDir = join(homedir(), 'ismini');
        execSync(`bash '${sourceDir}/install.sh'`, { stdio: 'inherit', timeout: 300000 });

        // 4) Clean up the temp artifacts (safe — the zip is already installed).
        try { unlinkSync(archivePath); } catch {}
        try { execSync(`rm -rf '${tempDir}'`); } catch {}

        // 5) Tell the browser the update succeeded (flush BEFORE we kill anything).
        sendJson(res, 200, { success: true, version: tagName, message: 'Update installed — restarting ismini' });

        // 6) Stop our own backend (frees port 8080) and drop browser clients.
        try { const b = await getBackend(); if (b && b.stop) await b.stop(); } catch {}
        clients.clear();

        // 7) Launch the NEW ismini FIRST — fully detached in its OWN process group/session
        //    (so it is independent of this process and survives when we exit). The old
        //    server is still holding port 8787, so the new instance's first bind may fail
        //    and it retries; once the old server dies below, it wins the port.
        const webPort = 8787; // ismini web UI port (fixed in the launcher)
        const launcher = join(destDir, 'ismini');
        let child = null;
        try {
          child = spawn('setsid', [launcher], { detached: true, stdio: 'ignore', cwd: destDir });
          child.unref();
          console.log(`[update] spawned new ismini (detached, own group) pid=${child.pid}`);
        } catch (e) { console.log(`[update] spawn failed: ${e.message}`); }

        // 8) Now kill the OLD server (this process) to free port 8787. The new instance is
        //    already alive and in its own process group, so this self-kill CANNOT take it
        //    down — it just frees the port so the new instance's retry loop binds it.
        console.log('[update] old server stopping itself to free port 8787 (new instance already spawned)');
        clients.clear();
        try { server.unref(); } catch {}
        // SIGTERM, brief grace, SIGKILL — guarantee the port is released.
        try { process.kill(process.pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 1200));
        try { process.kill(process.pid, 'SIGKILL'); } catch {}
        // The new instance (own group) keeps retrying until it grabs the now-free port.
        // Nothing more to do — this process is exiting; the new one is independent.
        // (If it somehow didn't come up, the user's manual relaunch is the fallback.)
      } catch (err) {
        console.error('[update] Error:', err);
        updating = false;
        sendJson(res, 500, { error: 'Update failed: ' + err.message });
      } finally {
        // Safety net: if the success path already killed the old process, this never
        // runs; if it errored, clear the flag so the auto-exit isn't left wedged.
        try { if (updating) { updating = false; } } catch {}
      }
    }
    else if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const list = sessions.list().map(s => {
        const msgs = visibleMessages(s.messages);
        return { id: s.id, started: s.started, lastActive: s.lastActive, messageCount: msgs.length, preview: msgs.find(m => m.role === 'user')?.content?.substring(0, 80) || '(empty)', active: s.id === sessions.data.activeId };
      });
      sendJson(res, 200, { sessions: list, activeId: sessions.data.activeId });
    }
    else if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.split('/').pop();
      const s = sessions.get(id);
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      sendJson(res, 200, { id: s.id, started: s.started, lastActive: s.lastActive, messages: visibleMessages(s.messages) });
    }
    else if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/switch/')) {
      if (busy) return sendJson(res, 409, { error: 'agent busy' });
      const id = url.pathname.split('/').pop();
      const s = sessions.switchTo(id);
      if (!s) return sendJson(res, 404, { error: 'session not found' });
      const msgs = visibleMessages(s.messages);
      agent.loadMessages(msgs);
      sessions.saveActive(msgs);
      broadcast({ type: 'sessionSwitched', sessionId: s.id, messages: msgs.length });
      sendJson(res, 200, { ok: true, sessionId: s.id, messages: msgs.length });
    }
    else if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/delete/')) {
      const id = url.pathname.split('/').pop();
      const removed = sessions.delete(id);
      if (!removed) return sendJson(res, 404, { error: 'session not found' });
      // If we deleted the active session, load the new active one into the agent
      // so the in-memory state matches what's on disk.
      const nowActive = sessions.getActive();
      if (nowActive) agent.loadMessages(visibleMessages(nowActive.messages));
      else agent.reset();
      broadcast({ type: 'sessionDeleted', sessionId: id, activeId: sessions.data.activeId });
      sendJson(res, 200, { ok: true, deleted: id, activeId: sessions.data.activeId });
    }
    else if (req.method === 'POST' && url.pathname === '/api/sessions/delete-all') {
      const removed = sessions.deleteAll();
      agent.reset();
      broadcast({ type: 'sessionsCleared', activeId: null, removed });
      sendJson(res, 200, { ok: true, removed });
    }
    // ══════════════════════════════════════════════════════════════
    // GET /api/models — Recursive local scan + server loaded model
    // ══════════════════════════════════════════════════════════════
    else if (req.method === 'GET' && url.pathname === '/api/models') {
      try {
        // Helper: strip .gguf + trailing quant tag from a model filename
        const cleanModelName = (s) => {
          let n = String(s || '').replace(/\.gguf$/i, '');
          n = n.replace(/[-_.]?(q\d{1,2}[_\w]*)$/i, '').replace(/[-_.]+$/, '');
          return n;
        };

        let serverModels = [];
        try {
          const root = `http://localhost:${config.llamaCpp?.port || 8080}`;
          const resp = await fetch(root + '/v1/models', { signal: AbortSignal.timeout(3000) });
          if (resp.ok) {
            const data = await resp.json();
            serverModels = (data.data || []).map(m => ({
              id: m.id,
              name: m.id ? cleanModelName(m.id.split('/').pop()) : '',
              loaded: true,
              local: false,
            }));
          }
        } catch {}

        let localModels = [];
        const scanPaths = [
          { dir: join(DATA_DIR, 'models'), prefix: '' },
          { dir: join(homedir(), '.cache', 'lm-studio', 'models'), prefix: 'lm-studio/' },
          { dir: join(homedir(), '.lmstudio', 'models'), prefix: 'lm-studio-old/' },
        ];

        function scanDir(baseDir, prefix, subDir, basePath) {
          if (!existsSync(baseDir)) return;
          const fullPath = subDir ? join(baseDir, subDir) : baseDir;
          if (!existsSync(fullPath)) return;
          let entries;
          try { entries = readdirSync(fullPath, { withFileTypes: true }); } catch { return; }
          for (const entry of entries) {
            const entryPath = join(fullPath, entry.name);
            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
              try {
                const st = statSync(entryPath);
                isDir = st.isDirectory();
                isFile = st.isFile();
              } catch { continue; }
            }
            if (isDir) {
              if (!entry.name.startsWith('.') && entry.name !== '__MACOSX') {
                const newSubDir = subDir ? `${subDir}/${entry.name}` : entry.name;
                const newBasePath = basePath ? `${basePath}/${entry.name}` : entry.name;
                scanDir(baseDir, prefix, newSubDir, newBasePath);
              }
            } else if (isFile && entry.name.toLowerCase().endsWith('.gguf')) {
              if (/mmproj/i.test(entry.name)) continue;
              try {
                const st = statSync(entryPath);
                const sizeBytes = st.size;
                const sizeStr = sizeBytes >= 1073741824
                  ? (sizeBytes / 1073741824).toFixed(1) + ' GB'
                  : Math.round(sizeBytes / 1048576) + ' MB';
                const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
                const rawName = entry.name.replace(/\.gguf$/i, '');
                const displayName = cleanModelName(entry.name);
                const fullId = prefix + relPath;
                const isLoaded = serverModels.some(sm =>
                  sm.id === fullId || sm.id === relPath || sm.id === entry.name ||
                  sm.name === displayName || sm.id.split('/').pop() === displayName
                );
                localModels.push({
                  id: 'local/' + fullId,
                  name: displayName,
                  loaded: isLoaded,
                  local: true,
                  size: sizeStr,
                });
              } catch {}
            }
          }
        }

        for (const { dir, prefix } of scanPaths) {
          scanDir(dir, prefix, '', '');
        }

        // Dedupe: a server model is a duplicate if any local model has the same filename (basename).
        const localBasenames = new Set(localModels.map(m => m.id.split('/').pop()));
        const serverOnly = serverModels.filter(m => !localBasenames.has(m.id.split('/').pop()));
        sendJson(res, 200, { models: [...localModels, ...serverOnly] });
      } catch (err) {
        console.error('[models] Scan failed:', err);
        sendJson(res, 500, { error: 'Failed to fetch models: ' + err.message });
      }
    }
    // ══════════════════════════════════════════════════════════════
    // POST /api/model/switch
    // ══════════════════════════════════════════════════════════════
    else if (req.method === 'POST' && url.pathname === '/api/model/switch') {
      try {
        const body = await readBody(req, 1024);
        const payload = JSON.parse(body);
        const targetId = payload.modelId;
        if (!targetId) return sendJson(res, 400, { error: 'modelId required' });
        if (busy) return sendJson(res, 409, { error: 'agent busy' });
        const b = await getBackend();
        if (!b) return sendJson(res, 503, { error: 'backend not available' });
        let modelFile = targetId.startsWith('local/') ? targetId.slice('local/'.length) : targetId;
        broadcast({ type: 'toast', msg: 'Switching model…' });
        const ok = await b.switchModel(modelFile);
        if (!ok) return sendJson(res, 500, { error: 'Could not start model' });
        broadcast({ type: 'modelSwitch', id: modelFile });
        const det = await detectLoadedModel();
        applyLoadedModel(agent, det, config);
        sendJson(res, 200, { ok: true, message: 'Model switched', loadedModel: det });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to switch: ' + err.message });
      }
    }
    // ══════════════════════════════════════════════════════════════
    // HuggingFace Model Manager endpoints
    // ══════════════════════════════════════════════════════════════
    else if (req.method === 'GET' && url.pathname === '/api/huggingface/models') {
      try {
        const search = (url.searchParams.get('search') || '').trim();
        const sort = url.searchParams.get('sort') || 'popular';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '150', 10), 200);
        const officialOnly = url.searchParams.get('official') !== '0';

        const OFFICIAL_AUTHORS = [
          'Qwen', 'meta-llama', 'meta-models', 'google', 'mistralai',
          'deepseek-ai', 'HuggingFaceTB', 'microsoft', 'nvidia',
          'stabilityai', 'BAAI', 'THUDM', '01-ai', 'lmstudio-community'
        ];
        const officialSet = new Set(OFFICIAL_AUTHORS.map(a => a.toLowerCase()));

        const QUANTIZERS = [
          'unsloth', 'bartowski', 'MaziyarPanahi', 'mradermacher',
          'QuantFactory', 'TheBloke', 'NousResearch'
        ];

        const hfSort = sort === 'latest' ? 'lastModified' : 'downloads';
        let merged = [];

        const fetchAuthor = async (author, extra = '') => {
          const aUrl = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&filter=gguf&sort=${hfSort}&direction=-1&limit=40${extra}`;
          try {
            const r = await fetch(aUrl, { signal: AbortSignal.timeout(15000), headers: hfHeaders() });
            if (!r.ok) return [];
            return await r.json();
          } catch { return []; }
        };

        if (search) {
          if (officialOnly) {
            const perAuthor = await Promise.all(OFFICIAL_AUTHORS.map(a =>
              fetchAuthor(a, `&search=${encodeURIComponent(search)}`)
            ));
            for (const list of perAuthor) for (const m of (list || [])) merged.push(m);
          } else {
            const apiUrl = `https://huggingface.co/api/models?search=${encodeURIComponent(search)}&filter=gguf&sort=${hfSort}&direction=-1&limit=150`;
            try {
              const r = await fetch(apiUrl, { signal: AbortSignal.timeout(15000), headers: hfHeaders() });
              if (r.ok) merged = await r.json() || [];
            } catch {}
          }
        } else {
          const authors = officialOnly ? OFFICIAL_AUTHORS : [...OFFICIAL_AUTHORS, ...QUANTIZERS];
          const perAuthor = await Promise.all(authors.map(a => fetchAuthor(a)));
          for (const list of perAuthor) for (const m of (list || [])) merged.push(m);
        }

        const seen = new Set();
        const dedup = [];
        for (const m of merged) {
          if (!m?.id || seen.has(m.id)) continue;
          seen.add(m.id);
          dedup.push(m);
        }

        if (sort === 'latest') {
          dedup.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
        } else {
          dedup.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
        }

        let installed = {};
        try { installed = JSON.parse(readFileSync(join(DATA_DIR, 'models', 'installed.json'), 'utf8')); } catch {}

        sendJson(res, 200, {
          models: dedup.slice(0, limit).map(m => {
            // ── IMPROVED SIZE REGEX ──
            // Check repo name separately for better matching of patterns like
            // "Qwen2.5-VL-7B-Instruct-GGUF", "Llama-3.2-3B", "0.5B", etc.
            const repoName = m.id.split('/').pop() || '';
            const sizeMatch = repoName.match(/(\d+(?:\.\d+)?)\s*[BbMm]\b/)
              || m.id.match(/(\d+(?:\.\d+)?)[BbMm](?![a-z])/);
            const sizeLabel = sizeMatch ? sizeMatch[0].toUpperCase().replace(/\s+/g, '') : null;
            return {
              id: m.id,
              author: m.id.split('/')[0],
              downloads: m.downloads || 0,
              lastModified: m.lastModified || '',
              gated: !!(m.gated),
              avatar: `https://huggingface.co/api/avatars/${m.id.split('/')[0]}`,
              size: sizeLabel,
            };
          }),
          installed: Object.keys(installed),
          hasToken: !!getHfToken(),
          officialOnly,
        });
      } catch (err) { sendJson(res, 500, { error: 'Failed to fetch: ' + err.message }); }
    }
    else if (req.method === 'GET' && url.pathname === '/api/huggingface/model-details') {
      const modelId = url.searchParams.get('modelId');
      if (!modelId) return sendJson(res, 400, { error: 'modelId required' });
      try {
        const resp = await fetch(`https://huggingface.co/api/models/${modelId}?blobs=true`, { signal: AbortSignal.timeout(30000), headers: hfHeaders() });
        if (!resp.ok) throw new Error('HuggingFace error: ' + resp.status);
        const data = await resp.json();

        const fmt = (b) => !b ? '' : (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
        const ggufs = (data.siblings || [])
          .filter(f => f.rfilename?.toLowerCase().endsWith('.gguf'))
          .filter(f => !/(imatrix|mmproj)/i.test(f.rfilename))
          .filter(f => !/-\d{5}-of-\d{5}/.test(f.rfilename))
          .map(f => ({ file: f.rfilename, bytes: f.size || 0, size: fmt(f.size || 0) }))
          .sort((a, b) => a.bytes - b.bytes);

        const recommended = ggufs.find(f => /q4_k_m/i.test(f.file)) || ggufs.find(f => /q4/i.test(f.file)) || ggufs[0] || null;

        const license = data.cardData?.license || '';

        // ── Smart description: strip HTML/markup, pick first real prose paragraph ──
        const stripHtml = (s) => String(s || '')
          .replace(/<\s*(img|br|hr|input|link|meta|a)\b[^>]*>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/\s+/g, ' ')
          .trim();
        const isRealProse = (s) => {
          const clean = stripHtml(s);
          if (clean.length < 30) return false;
          // Must be mostly letters (reject CSS, emoji blocks, badge spam)
          const letters = (clean.match(/[A-Za-z]/g) || []).length;
          if (letters / clean.length < 0.60) return false;
          // Reject markdown headers, tables, code fences
          if (/^\s*#{1,6}\s/.test(s)) return false;
          if (/^\s*\|/.test(s)) return false;
          if (clean.startsWith('```')) return false;
          // Reject CSS fragments (comments, properties, selectors)
          if (clean.startsWith('/*') || clean.startsWith('*') && clean.includes('*/')) return false;
          if (/\b(border|margin|padding|display|width|height|color|font|background|overflow|position)\s*[:=]/i.test(clean)) return false;
          if (/\{[^}]*\}/.test(clean) && letters / clean.length < 0.5) return false;
          // Reject lines that are mostly URLs or badges
          if ((clean.match(/https?:\/\//g) || []).length > 2) return false;
          // Reject pipe-separated metadata ("Hugging Face | GitHub | License : ...")
          const pipeCount = (clean.match(/\|/g) || []).length;
          if (pipeCount >= 3) return false;
          // Reject bold-only lines like "**Authors:** ... **License:** ..."
          const boldMatches = (clean.match(/\*\*[^*]+\*\*/g) || []);
          if (boldMatches.length >= 2 && boldMatches.join('').length / clean.length > 0.4) return false;
          return true;
        };

        let description = '';
        const cand = data.cardData?.description || data.cardData?.summary;
        if (cand && isRealProse(cand)) description = stripHtml(cand).slice(0, 600);
        if (!description) {
          try {
            const md = await fetch(`https://huggingface.co/${modelId}/raw/main/README.md`, { signal: AbortSignal.timeout(15000), headers: hfHeaders() });
            if (md.ok) {
              const text = await md.text();
              const body = text.replace(/^---[\s\S]*?---/, '');
              const paragraphs = body.split(/\n\s*\n/).map(p => p.trim());
              const found = paragraphs.find(p => p && isRealProse(p));
              if (found) description = stripHtml(found).slice(0, 600);
            }
          } catch {}
        }

        // ── IMPROVED PARAMS REGEX (same fix as size) ──
        const repoName = modelId.split('/').pop() || '';
        const paramsMatch = repoName.match(/(\d+(?:\.\d+)?)\s*[BbMm]\b/)
          || modelId.match(/(\d+(?:\.\d+)?)[BbMm](?![a-z])/);
        const params = paramsMatch ? paramsMatch[0].toUpperCase().replace(/\s+/g, '') : '';

        sendJson(res, 200, { id: modelId, name: (data.id || modelId).split('/').pop(), author: modelId.split('/')[0], description: description || 'No description available.', license, params, downloads: data.downloads || 0, likes: data.likes || 0, ggufs, recommended, gated: !!(data.gated), gatedType: data.gated === 'manual' ? 'manual' : (data.gated ? 'auto' : null) });
      } catch (err) { sendJson(res, 500, { error: 'Failed to load details: ' + err.message }); }
    }
    // ══════════════════════════════════════════════════════════════
    // GET /api/huggingface/models-batch — enrich a list of models with
    // description + recommended GGUF size without N round-trips from the UI.
    // Accepts ?ids=a,b,c  (up to 50). Returns { [id]: { description, recommendedSize, totalSize, params } }.
    // ══════════════════════════════════════════════════════════════
    else if (req.method === 'GET' && url.pathname === '/api/huggingface/models-batch') {
      const rawIds = (url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!rawIds.length) return sendJson(res, 400, { error: 'ids required' });
      const ids = rawIds.slice(0, 50);
      const fmt = (b) => !b ? '' : (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');

      const extract = async (modelId) => {
        try {
          const resp = await fetch(`https://huggingface.co/api/models/${modelId}?blobs=true`, { signal: AbortSignal.timeout(20000), headers: hfHeaders() });
          if (!resp.ok) return null;
          const data = await resp.json();
          const ggufs = (data.siblings || [])
            .filter(f => f.rfilename?.toLowerCase().endsWith('.gguf'))
            .filter(f => !/(imatrix|mmproj)/i.test(f.rfilename))
            .filter(f => !/-\d{5}-of-\d{5}/.test(f.rfilename))
            .map(f => ({ file: f.rfilename, bytes: f.size || 0 }))
            .sort((a, b) => a.bytes - b.bytes);
          const recommended = ggufs.find(f => /q4_k_m/i.test(f.file)) || ggufs.find(f => /q4/i.test(f.file)) || ggufs[0] || null;
          const totalBytes = ggufs.reduce((s, f) => s + (f.bytes || 0), 0);

          // Description: cardData → README first real prose paragraph.
          const stripHtml = (s) => String(s || '')
            .replace(/<\s*(img|br|hr|input|link|meta|a)\b[^>]*>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
          const isRealProse = (s) => {
            const clean = stripHtml(s);
            if (clean.length < 30) return false;
            const letters = (clean.match(/[A-Za-z]/g) || []).length;
            if (letters / clean.length < 0.60) return false;
            if (/^\s*#{1,6}\s/.test(s)) return false;
            if (/^\s*\|/.test(s)) return false;
            if (clean.startsWith('```')) return false;
            if (clean.startsWith('/*') || clean.startsWith('*') && clean.includes('*/')) return false;
            if (/\b(border|margin|padding|display|width|height|color|font|background|overflow|position)\s*[:=]/i.test(clean)) return false;
            if (/\{[^}]*\}/.test(clean) && letters / clean.length < 0.5) return false;
            if ((clean.match(/https?:\/\//g) || []).length > 2) return false;
            const pipeCount = (clean.match(/\|/g) || []).length;
            if (pipeCount >= 3) return false;
            const boldMatches = (clean.match(/\*\*[^*]+\*\*/g) || []);
            if (boldMatches.length >= 2 && boldMatches.join('').length / clean.length > 0.4) return false;
            return true;
          };

          let description = '';
          const cand = data.cardData?.description || data.cardData?.summary;
          if (cand && isRealProse(cand)) description = stripHtml(cand).slice(0, 300);
          if (!description) {
            try {
              const md = await fetch(`https://huggingface.co/${modelId}/raw/main/README.md`, { signal: AbortSignal.timeout(10000), headers: hfHeaders() });
              if (md.ok) {
                const text = await md.text();
                const body = text.replace(/^---[\s\S]*?---/, '');
                const paragraphs = body.split(/\n\s*\n/).map(p => p.trim());
                const found = paragraphs.find(p => p && isRealProse(p) && !p.startsWith('```') && !/^[#*\-|\t<\s]+$/.test(p));
                if (found) description = stripHtml(found).slice(0, 300);
              }
            } catch {}
          }

          // Params from repo name (e.g. 8B, 70B, 0.5B)
          const repoName = modelId.split('/').pop() || '';
          const pm = repoName.match(/(\d+(?:\.\d+)?)\s*[BbMm]\b/) || modelId.match(/(\d+(?:\.\d+)?)[BbMm](?![a-z])/);
          const params = pm ? pm[0].toUpperCase().replace(/\s+/g, '') : '';

          return {
            description: description || '',
            recommendedSize: recommended ? fmt(recommended.bytes) : '',
            totalSize: totalBytes ? fmt(totalBytes) : '',
            params,
          };
        } catch { return null; }
      };

      // Fetch in parallel with a small concurrency cap to avoid hammering HF.
      const results = {};
      const queue = [...ids];
      const workers = Array.from({ length: Math.min(6, ids.length) }, async () => {
        while (queue.length) {
          const id = queue.shift();
          if (!id) break;
          const r = await extract(id);
          if (r) results[id] = r;
        }
      });
      await Promise.all(workers);

      sendJson(res, 200, { models: results, fetched: Object.keys(results).length, requested: ids.length });
    }
    // ══════════════════════════════════════════════════════════════
    // POST /api/model/download
    // ══════════════════════════════════════════════════════════════
    else if (req.method === 'POST' && url.pathname === '/api/model/download') {
      const body = await readBody(req, 4096);
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected JSON' }); }
      if (!payload?.modelId) return sendJson(res, 400, { error: 'modelId required' });
      const resume = payload.resume === true;
      let state = null;
      try {
        const modelDir = join(DATA_DIR, 'models');
        mkdirSync(modelDir, { recursive: true });
        const filesResp = await fetch(`https://huggingface.co/api/models/${payload.modelId}?blobs=true`, { signal: AbortSignal.timeout(30000), headers: hfHeaders() });
        if (!filesResp.ok) throw new Error('Failed to list files');
        const filesData = await filesResp.json();
        const siblings = filesData.siblings || [];
        const ggufFiles = siblings.filter(f => f.rfilename?.toLowerCase().endsWith('.gguf'));
        if (ggufFiles.length === 0) return sendJson(res, 404, { error: 'No GGUF file found' });
        const preferred = payload.fileName ? ggufFiles.find(f => f.rfilename === payload.fileName) : null;
        const ggufFile = preferred || ggufFiles.find(f => /q4_k_m/i.test(f.rfilename)) || ggufFiles[0];

        const repoName = payload.modelId.replace(/[\\/]/g, '__');
        const subDir = join(modelDir, repoName);
        mkdirSync(subDir, { recursive: true });
        const safeName = ggufFile.rfilename.replace(/[\\/]/g, '__');
        const finalPath = join(subDir, safeName);
        const partPath = finalPath + '.part';

        let startByte = 0;
        if (resume && existsSync(partPath)) startByte = statSync(partPath).size;

        const controller = new AbortController();
        state = { controller, modelId: payload.modelId, file: ggufFile.rfilename, partPath, finalPath, received: startByte, total: 0, paused: false, cancelled: false };
        activeDownloads.set(payload.modelId, state);

        const headers = { 'User-Agent': 'ismini-agent' };
        if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;
        const downloadUrl = `https://huggingface.co/${payload.modelId}/resolve/main/${encodeURIComponent(ggufFile.rfilename)}`;
        const fileResp = await fetch(downloadUrl, { signal: controller.signal, headers });
        if (!fileResp.ok && fileResp.status !== 206) throw new Error('Download failed: ' + fileResp.status);
        if (startByte > 0 && fileResp.status === 200) { startByte = 0; state.received = 0; }
        const contentLength = parseInt(fileResp.headers.get('content-length') || '0', 10);
        state.total = startByte + contentLength;

        broadcast({ type: 'downloadStart', modelId: payload.modelId, file: ggufFile.rfilename, total: state.total, resumed: startByte > 0 });

        const ws = createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' });
        const reader = fileResp.body.getReader();
        let lastSent = Date.now();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.write(Buffer.from(value));
            state.received += value.length;
            const now = Date.now();
            if (now - lastSent >= 400) {
              lastSent = now;
              broadcast({ type: 'downloadProgress', modelId: payload.modelId, received: state.received, total: state.total, percent: state.total > 0 ? Math.round((state.received / state.total) * 100) : null });
            }
          }
          ws.end();
          await new Promise((resolve, reject) => { ws.on('finish', resolve); ws.on('error', reject); });
          renameSync(partPath, finalPath);
          activeDownloads.delete(payload.modelId);
          broadcast({ type: 'downloadDone', modelId: payload.modelId, file: ggufFile.rfilename });

          try {
            const manifestPath = join(modelDir, 'installed.json');
            let manifest = {};
            try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
            manifest[payload.modelId] = manifest[payload.modelId] || [];
            const relPath = `${repoName}/${safeName}`;
            if (!manifest[payload.modelId].includes(relPath)) manifest[payload.modelId].push(relPath);
            writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
          } catch {}

          try { const b = await getBackend(); if (b && !b.isRunning()) await b.start(`${repoName}/${safeName}`); } catch {}
          sendJson(res, 200, { success: true, path: finalPath, file: ggufFile.rfilename });
        } catch (streamErr) {
          ws.destroy();
          if (state.cancelled) { try { unlinkSync(partPath); } catch {} cleanupEmptyModelDir(subDir); activeDownloads.delete(payload.modelId); broadcast({ type: 'downloadCancelled', modelId: payload.modelId }); return sendJson(res, 200, { cancelled: true }); }
          if (state.paused) { broadcast({ type: 'downloadPaused', modelId: payload.modelId, received: state.received, total: state.total }); return sendJson(res, 200, { paused: true, received: state.received }); }
          try { unlinkSync(partPath); } catch {}
          cleanupEmptyModelDir(subDir);
          activeDownloads.delete(payload.modelId);
          throw streamErr;
        }
      } catch (err) {
        console.error('[download] Error:', err);
        if (state) activeDownloads.delete(payload.modelId);
        broadcast({ type: 'downloadError', modelId: payload.modelId, error: err?.message || String(err) });
        sendJson(res, 500, { error: 'Failed to download: ' + (err?.message || String(err)) });
      }
    }
    else if (req.method === 'POST' && url.pathname === '/api/model/download/pause') {
      const body = await readBody(req, 1024);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const state = payload.modelId ? activeDownloads.get(payload.modelId) : activeDownloads.values().next().value;
      if (!state) return sendJson(res, 404, { error: 'no active download' });
      state.paused = true;
      state.controller.abort();
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'POST' && url.pathname === '/api/model/download/cancel') {
      const body = await readBody(req, 1024);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const state = payload.modelId ? activeDownloads.get(payload.modelId) : activeDownloads.values().next().value;
      if (!state) return sendJson(res, 404, { error: 'no active download' });
      state.cancelled = true;
      state.controller.abort();
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'GET' && url.pathname === '/api/hf-token') {
      sendJson(res, 200, { hasToken: !!getHfToken() });
    }
    else if (req.method === 'POST' && url.pathname === '/api/hf-token') {
      const body = await readBody(req, 1024);
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected JSON' }); }
      const token = String(payload?.token || '').trim();
      if (!token) return sendJson(res, 400, { error: 'token required' });
      if (!/^hf_[A-Za-z0-9_-]{20,}$/.test(token)) return sendJson(res, 400, { error: 'HF tokens start with hf_' });
      try { writeFileSync(HF_TOKEN_FILE, token, { mode: 0o600 }); sendJson(res, 200, { ok: true }); } catch (err) { sendJson(res, 500, { error: 'Could not save: ' + err.message }); }
    }
    else if (req.method === 'DELETE' && url.pathname === '/api/hf-token') {
      try { unlinkSync(HF_TOKEN_FILE); } catch {}
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'GET' && url.pathname === '/api/backend') {
      const b = await getBackend();
      sendJson(res, 200, b ? b.status() : { state: 'error', models: [] });
    }
    else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    try { sendJson(res, err?.statusCode || 500, { error: err?.message || String(err) }); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ismini web UI → http://${HOST}:${PORT}`);
  console.log(`model endpoint → http://localhost:${config.llamaCpp?.port || 8080}`);
});

{
  const b = await getBackend();
  if (b) {
    b.onStateChange = (state, extra = {}) => {
      console.log(`[web] backend → ${state}${extra.model ? ' (' + extra.model + ')' : ''}`);
      broadcast({ type: 'backend', state, model: extra.model || b.currentModel || null });
    };
    b.start().then(ok => { if (ok) console.log('[web] llama.cpp backend is up'); else console.log('[web] no model yet'); }).catch(err => console.error('[web] backend start failed:', err.message));
  }
}

process.on('unhandledRejection', (err) => { console.error('[ismini] unhandled rejection:', err?.stack || err); });
process.on('SIGINT', () => { console.log('\nbye!'); for (const res of clients) { try { res.end(); } catch {} } process.exit(0); });
server.on('error', (err) => { if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT} is already in use.`); process.exit(1); } throw err; });