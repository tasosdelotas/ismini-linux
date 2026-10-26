// llama-backend.js — owns the built-in llama.cpp server.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class LlamaBackend {
  constructor(config, opts = {}) {
    this.config = config || {};
    this.port = this.config.llamaCpp?.port || 8080;
    this.host = '127.0.0.1';
    this.base = `http://${this.host}:${this.port}`;
    this.dataDir   = opts.dataDir   || join(process.env.HOME || '', 'ismini');
    this.modelsDir = opts.modelsDir || join(this.dataDir, 'models');
    this.stateFile = join(this.dataDir, 'llama-state.json');
    this.logFile   = join(this.dataDir, 'llama.log');

    // Every place models can live, with the ID prefix web.js uses for each.
    // Must stay in sync with the scanPaths in web.js /api/models.
    this.modelRoots = [
      { path: this.modelsDir, prefix: '' },
      { path: join(homedir(), '.cache', 'lm-studio', 'models'), prefix: 'lm-studio/' },
      { path: join(homedir(), '.lmstudio', 'models'), prefix: 'lm-studio-old/' },
    ];

    this.binary = opts.binary || this._findBinary();
    this.child = null;
    this.currentModel = null;
    this.currentMmproj = null;
    this.lastContext = null; // the actual -c we launched llama-server with (RAM-adaptive)
    this._busy = false;
    this.state = 'idle';
    this.onStateChange = null;
  }

  _findBinary() {
    const candidates = [
      join(__dirname, 'llama-cpp', 'bin', 'llama-server'),
      join(__dirname, 'llama-cpp', 'llama-server'),
      join(__dirname, 'bin', 'llama-server'),
      join(this.dataDir, 'llama-cpp', 'bin', 'llama-server'),
      join(this.dataDir, 'llama-cpp', 'llama-server'),
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return 'llama-server';
  }

  // ── Edit 4 helper: turn a (possibly prefixed) model id into a real absolute path ──
  // Bulletproof resolver: tries every model root with the id as-is AND with
  // any known prefix stripped, so web.js and llama-backend can never disagree.
  _resolveModelPath(file) {
    if (!file) return null;
    if (file.startsWith('/') && existsSync(file)) return file;

    const knownPrefixes = this.modelRoots.map(r => r.prefix).filter(Boolean);
    const variants = new Set([file]);
    for (const p of knownPrefixes) {
      if (file.startsWith(p)) variants.add(file.slice(p.length));
    }

    for (const root of this.modelRoots) {
      if (!existsSync(root.path)) continue;
      for (const v of variants) {
        const candidate = join(root.path, v);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  // ── Scans every model root, returns relative paths, filters split files & mmproj ──
  listModels() {
    const models = [];
    for (const root of this.modelRoots) {
      if (!existsSync(root.path)) continue;

      const scanDir = (dir, basePath) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          let isDir = entry.isDirectory();
          let isFile = entry.isFile();

          if (entry.isSymbolicLink()) {
            try {
              const st = statSync(fullPath);
              isDir = st.isDirectory();
              isFile = st.isFile();
            } catch { continue; }
          }

          if (isDir && !entry.name.startsWith('.') && entry.name !== '__MACOSX') {
            scanDir(fullPath, basePath ? `${basePath}/${entry.name}` : entry.name);
          } else if (isFile && entry.name.toLowerCase().endsWith('.gguf') && !/mmproj/i.test(entry.name)) {
            const splitMatch = entry.name.match(/-(\d{5})-of-(\d{5}).gguf$/i);
            if (splitMatch && splitMatch[1] !== '00001') continue;

            const relPath = basePath ? `${basePath}/${entry.name}` : entry.name;
            models.push(root.prefix + relPath);
          }
        }
      };

      scanDir(root.path, '');
    }
    return models;
  }

  // ── Find matching mmproj file (uses resolver, supports all roots + subfolders) ──
  _findMmproj(modelFile) {
    const modelFullPath = this._resolveModelPath(modelFile);
    if (!modelFullPath) return null;

    const modelDir = dirname(modelFullPath);
    if (!existsSync(modelDir)) return null;

    // Strip extension + quant suffix + the word "mmproj" to get a comparable family name
    const normalize = (name) => name
    .replace(/\.gguf$/i, '')
    .replace(/[-_ ]?(q\d+[a-z0-9_]*|iq\d+[a-z0-9_]*|f16|f32|bf16|fp16|fp32|fp8)$/i, '')
    .replace(/[-_ .]?mmproj/i, '')
    .toLowerCase()
    .replace(/[-_ .]+/g, ' ')
    .trim();

    const baseName = normalize(basename(modelFile));

    try {
      const files = readdirSync(modelDir);
      const mmprojFiles = files.filter(f => /mmproj/i.test(f) && f.toLowerCase().endsWith('.gguf'));

      if (!mmprojFiles.length) return null;

      if (mmprojFiles.length === 1) {
        console.log(`[llama] Vision adapter found: ${mmprojFiles[0]}`);
        return join(modelDir, mmprojFiles[0]);
      }

      const baseTokens = baseName.split(' ').filter(t => t.length > 1);
      let best = mmprojFiles[0], bestScore = -1;

      for (const f of mmprojFiles) {
        const mmTokens = normalize(f).split(' ').filter(t => t.length > 1);
        let score = 0;
        for (const bt of baseTokens) if (mmTokens.includes(bt)) score++;
        if (score > bestScore) { bestScore = score; best = f; }
      }

      console.log(`[llama] Vision adapter found: ${best}`);
      return join(modelDir, best);
    } catch { return null; }
  }

  _readState()  { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  _writeState(s){ try { writeFileSync(this.stateFile, JSON.stringify(s, null, 2) + '\n'); } catch {} }

  _setState(state, extra = {}) {
    this.state = state;
    try { this.onStateChange?.(state, extra); } catch {}
  }

  status() {
    return {
      state: this.state,
      model: this.currentModel,
      mmproj: this.currentMmproj,
      port: this.port,
      context: this.lastContext,
      models: this.listModels(),
    };
  }

  pickModel() {
    const models = this.listModels();
    if (!models.length) return null;

    const last = this._readState().model;
    if (last && models.includes(last)) return last;
    if (last) {
      const byName = models.find(m => basename(m) === basename(last));
      if (byName) return byName;
    }

    return models.find(f => /q4_k_m/i.test(f))
    || models.find(f => /q4/i.test(f))
    || models[0];
  }

  // ── RAM-adaptive context length ──────────────────────────────────────────
  // Context length is MANUAL. The user sets it in Settings (or it defaults to 16k).
  // No auto-detection — the user knows their hardware better than we do.
  // If the box can't afford the chosen context, llama.cpp will OOM and the user
  // can lower it. Simple, predictable, honest.
  _resolveContext() {
    const DEFAULT = 16384;     // safe default for every box
    const MIN = 4096;          // hard floor
    const MAX = 262144;        // hard ceiling (256k)

    const cfg = Number(this.config.llamaCpp?.context);
    const ctx = Number.isFinite(cfg) && cfg >= MIN ? cfg : DEFAULT;
    const final = Math.max(MIN, Math.min(MAX, ctx));

    console.log(`[llama] context: manual=${ctx} => -c ${final}`);
    return final;
  }

  _args(modelPath, mmprojPath) {
    const ctx = this._resolveContext(modelPath);
    // ── Reasoning / thinking ────────────────────────────────────────────
    // llama-server's --reasoning defaults to 'auto' (detect from template), which
    // for a thinking-capable model means THINKING IS ON — the model emits a full
    // (invisible) reasoning trace before its first visible token. That silent phase
    // is what made ismini feel "slow / frozen" vs. LM Studio. We default it OFF so
    // the model goes straight to the answer. It's a SERVER-LEVEL gate, so it works
    // regardless of the model's chat template (the per-request enable_thinking kwarg
    // is ignored by this build). Configurable via llamaCpp.reasoning ('off'|'on'|'auto')
    // to enable a fast/careful toggle later.
    const reasoning = this.config.llamaCpp?.reasoning || 'off';
    // ── CPU threads ─────────────────────────────────────────────────────
    // Auto-detect PHYSICAL cores (not logical/SMT threads) for the best
    // prompt-processing throughput without thread contention. llama.cpp
    // defaults to -1 (all logical threads), which on a 16c/32t chip means
    // 32 threads — often *slower* than 16 due to SMT contention. We read
    // /proc/cpuinfo to count physical cores (unique core_ids per socket) and
    // pass that as -t. Falls back to logical CPU count, then to 8, if the
    // file is unreadable (non-Linux). A user can still override via
    // config.llamaCpp.threads (a positive integer) if they know better.
    let threads = null;
    const cfgThreads = Number(this.config.llamaCpp?.threads);
    if (Number.isInteger(cfgThreads) && cfgThreads > 0) {
      threads = cfgThreads;
    } else {
      try {
        const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
        const coreIds = new Set();
        let logical = 0;
        for (const line of cpuinfo.split('\n')) {
          if (line.startsWith('processor')) logical++;
          if (line.startsWith('core id')) {
            const parts = line.split(':');
            if (parts[1]) coreIds.add(parts[1].trim());
          }
        }
        // On most x86/ARM Linux boxes, unique core_ids = physical cores.
        // If core_ids are all 0 (some VMs/hypervisors), fall back to logical/2.
        threads = coreIds.size > 0 ? coreIds.size : Math.max(2, Math.floor(logical / 2));
      } catch {
        threads = 8; // safe default if /proc/cpuinfo is unavailable
      }
    }
    const args = [
      '-m', modelPath,
      '--host', this.host,
      '--port', String(this.port),
      '-c', String(ctx),
      '--reasoning', reasoning,
      '-ngl', '99',
      '--jinja',
      '--flash-attn', 'auto',
      '-t', String(threads),
      '-b', '2048',
      '-ub', '512',
      '-np', String(this.config.llamaCpp?.parallel || 1),
      '--kv-unified',
    ];
    console.log(`[llama] threads: ${threads} (auto-detected physical cores)`);
    this.lastContext = ctx; // remember the real -c so web.js can size the agent's window to it
    if (mmprojPath && existsSync(mmprojPath)) {
      args.push('--mmproj', mmprojPath);
      console.log(`[llama] Vision enabled: ${basename(mmprojPath)}`);
    }
    return args;
  }

  isRunning() { return !!this.child && !this.child.killed; }

  async start(modelFile) {
    if (this._busy) return false;
    this._busy = true;

    try {
      if (this.isRunning()) await this.stop();

      const file = modelFile || this.pickModel();
      if (!file) { this._setState('idle'); return false; }

      // ── Edit 4: resolve across ALL model roots, not just ~/ismini/models ──
      const modelPath = this._resolveModelPath(file);
      console.log(`[llama] start requested: ${file}`);
      console.log(`[llama] resolved path: ${modelPath}`);
      console.log(`[llama] file exists: ${modelPath ? existsSync(modelPath) : false}`);

      if (!modelPath) {
        console.error(`[llama] Model file not found for: ${file}`);
        this._setState('idle');
        return false;
      }

      const mmprojPath = this._findMmproj(file);
      this._setState('starting', { model: file, mmproj: mmprojPath ? basename(mmprojPath) : null });
      console.log(`[llama] starting llama-server with ${file} on :${this.port}`);

      const log = createWriteStream(this.logFile, { flags: 'a' });
      this.child = spawn(this.binary, this._args(modelPath, mmprojPath), { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout.pipe(log);
      this.child.stderr.pipe(log);

      this.child.stderr.on('data', (d) => {
        const s = d.toString();
        if (/error|fail|abort/i.test(s)) console.error(`[llama-server] ${s.trim()}`);
      });

      this.child.on('exit', (code) => {
        console.log(`[llama] llama-server exited with code ${code}`);
        this.child = null;
      });

      this.currentModel = file;
      this.currentMmproj = mmprojPath ? basename(mmprojPath) : null;
      this._writeState({ model: file, mmproj: this.currentMmproj });

      const ready = await this._waitReady();
      this._setState(ready ? 'ready' : 'error', { model: file, mmproj: this.currentMmproj });
      return ready;
    } catch (err) {
      console.error('[llama] start failed:', err);
      this._setState('error');
      throw err;
    } finally {
      this._busy = false;
    }
  }

  async stop() {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    this._setState('idle');

    try { c.kill('SIGTERM'); } catch {}
    await new Promise(resolve => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} resolve(); }, 3000);
      c.on('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  async switchModel(modelFile) {
    console.log(`[llama] switchModel → ${modelFile}`);
    await this.stop();
    return this.start(modelFile);
  }

  async _waitReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(this.base + '/health', { signal: AbortSignal.timeout(1500) });
        if (r.ok) { console.log('[llama] server ready'); return true; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    console.warn('[llama] server did not become ready in time');
    return false;
  }
}
