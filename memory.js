// memory.js — tiny local long-term memory for ismini.
// Zero dependencies, one JSON file, in-process keyword search.
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { setImmediate } from 'node:timers';
import { join } from 'node:path';

// Exported so agent.js can interpolate the real caps into its messages instead of
// hardcoding them (the old "(200 max)" string would lie the moment the cap changed).
export const MAX_MEMORIES = 200;
export const MAX_TEXT_LENGTH = 300;

export class MemoryStore {
  constructor(dir) {
    this.file = join(dir, 'memory.json');
    this.data = { version: 1, updatedAt: '', memories: [] };
    this._lastSaveFailed = false;
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.memories)) throw new Error('invalid memory data');
      
      const valid = parsed.memories.every((m) =>
        m && typeof m === 'object' &&
        typeof m.id === 'string' &&
        typeof m.text === 'string'
      );
      if (!valid) throw new Error('invalid memory data');

      // Timestamps must be valid ISO-8601 strings: a hand-edited file with
      // updatedAt: 123 would otherwise crash search's localeCompare on every query.
      const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v))) ? v : new Date().toISOString();
      const memories = parsed.memories.map((m) => ({
        id: m.id,
        text: m.text,
        category: typeof m.category === 'string' ? m.category : '',
        createdAt: iso(m.createdAt || m.updatedAt),
        updatedAt: iso(m.updatedAt),
      }));
      
      this.data = { version: 1, updatedAt: parsed.updatedAt || '', memories };
    } catch (err) {
      console.error(`[memory] could not load ${this.file} (${err.message}) — starting with empty memory`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = { version: 1, updatedAt: '', memories: [] };
    }
  }

  _save() {
    this.data.updatedAt = new Date().toISOString();
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      this._lastSaveFailed = false;
      return true;
    } catch (err) {
      console.error(`[memory] save failed: ${err.message}`);
      this._lastSaveFailed = true;
      try { if (existsSync(temp)) unlinkSync(temp); } catch {}
      return false;
    }
  }

  add(text, category = '') {
    if (this._lastSaveFailed) {
      console.warn('[memory] previous save failed — new memory may not persist');
    }
    
    const full = String(text || '').trim();
    if (!full) return null;
    // Truncate FIRST, then dedup: stored text is already capped at MAX_TEXT_LENGTH,
    // so comparing the full (longer) text against it would never match and a re-added
    // long note would create a duplicate instead of refreshing the existing entry.
    const clipped = full.slice(0, MAX_TEXT_LENGTH);
    const truncated = clipped.length < full.length;

    const existing = this.data.memories.find((m) => m.text.toLowerCase() === clipped.toLowerCase());
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      // Refresh the category on a dedup hit too — it was previously ignored.
      const cat = String(category || '').trim().slice(0, 40);
      if (cat) existing.category = cat;
      return { memory: existing, evicted: null, persisted: this._save(), truncated };
    }

    const now = new Date().toISOString();
    const memory = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`,
      text: clipped,
      category: String(category || '').trim().slice(0, 40),
      createdAt: now,
      updatedAt: now,
    };

    let evicted = null;
    // Evict the entry with the OLDEST last-use (min updatedAt) when at capacity.
    // shift() removed by insertion order instead, so a fact reinforced weekly (bumped
    // updatedAt but still at index 0) was evicted before a one-off note from yesterday.
    if (this.data.memories.length >= MAX_MEMORIES) {
      let oldest = 0;
      for (let i = 1; i < this.data.memories.length; i++) {
        if (String(this.data.memories[i].updatedAt) < String(this.data.memories[oldest].updatedAt)) oldest = i;
      }
      evicted = this.data.memories.splice(oldest, 1)[0];
    }

    this.data.memories.push(memory);
    return { memory, evicted, persisted: this._save(), truncated };
  }

  async search(query = '', limit = 5) {
    // Clamp so a model asking for limit:200 can't dump the whole store (~60 KB,
    // ~20k tokens) into one tool result — exactly the context pressure we fight.
    const lim = Math.min(Math.max(1, Number(limit) || 5), 20);
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.data.memories.slice(-lim).reverse();
    
    const tokens = [...new Set(
      (q.match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length > 1)
    )];
    
    const scored = [];
    const CHUNK = 25;
    
    for (let i = 0; i < this.data.memories.length; i += CHUNK) {
      for (const m of this.data.memories.slice(i, i + CHUNK)) {
        const text = m.text.toLowerCase();
        let score = text.includes(q) ? 5 : 0;
        for (const t of tokens) if (text.includes(t)) score++;
        if (m.category?.toLowerCase().includes(q)) score += 2;
        if (score > 0) scored.push({ memory: m, score });
      }
      // Yield control to prevent blocking the event loop
      if (i + CHUNK < this.data.memories.length) {
        await new Promise(r => setImmediate(r));
      }
    }
    
    return scored
      .sort((a, b) => b.score - a.score || String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt)))
      .slice(0, lim)
      .map(x => x.memory);
  }

  delete(id) {
    const before = this.data.memories.length;
    this.data.memories = this.data.memories.filter((m) => m.id !== id);
    if (this.data.memories.length === before) return false;
    const persisted = this._save();
    return { deleted: true, persisted };
  }
}