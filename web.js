// web.js — ismini WebUI: a local web chat on the same Agent core.
// Zero dependencies (node:http + Server-Sent Events). Binds 127.0.0.1 only
// — the server has no auth, so it must never be exposed to the network.
//
//   node web.js [--port 8787]     or     ismini

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.error('No config.json found. Edit the template.');
  process.exit(1);
}

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const PORT = Number(argVal('--port') || process.env.WEB_PORT || 8787);
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
    try { res.write(payload); } catch { clients.delete(res); }
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
function scheduleShutdown(reason) {
  if (!AUTO_EXIT || shutdownTimer || clients.size > 0) return;
  console.log(`last client gone (${reason}) — exiting in ${SHUTDOWN_GRACE_MS / 1000}s if nobody reconnects`);
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    console.log('no clients — shutting down');
    for (const res of clients) { try { res.end(); } catch { } }
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

const ui = new WebUI(broadcast);
const agent = new Agent({
  baseUrl: config.model.baseUrl,
  apiKey: config.model.apiKey,
  modelId: '',
  systemPrompt: config.agent.systemPrompt,
  timeoutSeconds: config.agent.timeoutSeconds || 3600,
  contextWindow: config.agent.contextWindow || 131072,
  temperature: config.agent.temperature,
  maxTokens: config.agent.maxTokens,
  sudo: config.tools?.sudo !== false,
  enabledTools: config.tools?.enabled || ['read', 'write', 'edit', 'exec', 'web_search', 'web_fetch'],
  ui: ui,
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

// ── Run orchestration ───────────────────────────────────────────────────────
// The Agent streams model tokens directly via process.stdout.write (and
// tools may console.log). While a turn is running we route those writes
// into the SSE 'token' stream instead of the terminal. Box borders
// (pure ─ lines) are terminal decoration — filtered out for the web chat.
let busy = false;
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
    const s = String(chunk);
    const t = s.trim();
    if (t && !/^─+$/.test(t)) broadcast({ type: 'token', text: s }); // skip border decoration
    if (typeof enc === 'function') enc();
    if (typeof cb === 'function') cb();
    return true;
  };
  let paused = false;
  try {
    await agent.run(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      paused = true;
      broadcast({ type: 'paused' });
    } else {
      broadcast({ type: 'error', text: err?.message || String(err) });
    }
  } finally {
    process.stdout.write = orig;
    busy = false;
    if (!paused) broadcast({ type: 'done', messages: agent.messages.length });
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
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

// ── HTTP server ─────────────────────────────────────────────────────────────
const INDEX_HTML = readFileSync(join(__dirname, 'web', 'index.html'), 'utf8');

// Favicon for the browser tab (served at /favicon-256.png)
const FAVICON_PNG = (() => {
  try { return readFileSync(join(__dirname, 'web', 'favicon-256.png')); }
  catch { return null; }
})();

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return sendJson(res, 400, { error: 'bad url' }); }

  try {
    cancelShutdown(); // any request means a client is present — cancel pending shutdown
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
    }
    else if (req.method === 'GET' && url.pathname === '/favicon-256.png') {
      if (!FAVICON_PNG) return sendJson(res, 404, { error: 'no favicon' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', 'content-length': FAVICON_PNG.length });
      res.end(FAVICON_PNG);
    }
    else if (req.method === 'GET' && url.pathname === '/fonts/cinzel.ttf') {
      // Cinzel (ancient-inscription display font) for the ISMINI wordmark
      let buf;
      try { buf = readFileSync(join(__dirname, 'web', 'fonts', 'cinzel.ttf')); }
      catch { return sendJson(res, 404, { error: 'no font' }); }
      res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/marble.jpeg') {
      // Black marble background for the marble theme (read per-request, like /bg.jpg)
      let buf;
      try { buf = readFileSync(join(__dirname, 'web', 'marble.jpeg')); }
      catch { return sendJson(res, 404, { error: 'no marble' }); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/stars.gif') {
      // Twinkling starfield for the dark theme (read per-request, like /bg.jpg)
      let buf;
      try { buf = readFileSync(join(__dirname, 'web', 'stars.gif')); }
      catch { return sendJson(res, 404, { error: 'no starfield' }); }
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/bg.jpg') {
      // Papyrus background for the light theme. Read per-request (not at startup)
      // so swapping the image file doesn't require a server restart.
      let buf;
      try { buf = readFileSync(join(__dirname, 'web', 'bg.jpg')); }
      catch { return sendJson(res, 404, { error: 'no background image' }); }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache', 'content-length': buf.length });
      res.end(buf);
    }
    else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
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
      try { res.write(`data: ${JSON.stringify({ type: 'hello', model, busy, messages: agent.messages.length })}\n\n`); } catch { }
    }
    else if (req.method === 'POST' && url.pathname === '/send') {
      if (busy) return sendJson(res, 409, { error: 'agent busy — wait for the current turn to finish' });
      const body = await readBody(req);
      let text;
      try { text = JSON.parse(body).text; } catch { return sendJson(res, 400, { error: 'expected {"text": "..."}' }); }
      if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'empty message' });
      sendJson(res, 202, { ok: true });
      runTurn(text.trim()); // streams via SSE; not awaited
    }
    else if (req.method === 'POST' && url.pathname === '/pause') {
      if (!busy) return sendJson(res, 409, { error: 'agent not running' });
      agent.pause();
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'POST' && url.pathname === '/new') {
      agent.reset();
      broadcast({ type: 'reset' });
      sendJson(res, 200, { ok: true });
    }
    else if (req.method === 'GET' && url.pathname === '/api/pick-file') {
      if (pickInProgress) return sendJson(res, 409, { error: 'a file picker is already open' });
      const mode = url.searchParams.get('mode') === 'folder' ? 'folder' : 'file';
      pickInProgress = true;
      try {
        const r = await pickNativeFile(mode);
        if (r.path) return sendJson(res, 200, { ok: true, path: r.path });
        if (r.cancelled) return sendJson(res, 200, { ok: false, cancelled: true });
        sendJson(res, 503, { error: r.error || 'file picker unavailable' });
      } finally {
        pickInProgress = false;
      }
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
    else if (req.method === 'GET' && url.pathname === '/state') {
      const model = await detectModel();
      sendJson(res, 200, {
        busy, model,
        messages: agent.messages.length,
        contextWindow: agent.contextWindow,
        maxTokens: agent.maxTokens,
      });
    }
    else if (req.method === 'GET' && url.pathname === '/transcript') {
      // For resync after a connection drop: the in-memory session so far.
      const messages = agent.messages
        .filter(m => m.role !== 'system')
        .map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : '',
          name: m.name || undefined,
          tools: Array.isArray(m.tool_calls)
            ? m.tool_calls.map((tc) => tc?.function?.name || tc?.name || 'tool')
            : undefined,
        }));
      sendJson(res, 200, { messages });
    }
    else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    try { sendJson(res, 500, { error: err?.message || String(err) }); } catch { }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ismini web UI  →  http://${HOST}:${PORT}`);
  console.log(`model endpoint →  ${config.model.baseUrl}   (Ctrl+C to stop)`);
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
