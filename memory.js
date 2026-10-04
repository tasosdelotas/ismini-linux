// memory.js — tiny local long-term memory for ismini.
// Zero dependencies, one JSON file, in-process keyword search.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const MAX_MEMORIES = 200;
const MAX_TEXT_LENGTH = 300;

export class MemoryStore {
  constructor(dir) {
    this.file = join(dir, 'memory.json');
    this.data = { version: 1, updatedAt: '', memories: [] };
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // Validate. category is optional in practice (a hand-edit may omit it),
      // so don't require it — only id/text/updatedAt are essential. If the file
      // is malformed, do NOT crash startup: log and start with empty memory.
      if (!parsed || !Array.isArray(parsed.memories)) throw new Error('invalid memory data');
      const valid = parsed.memories.every((m) =>
        m && typeof m === 'object' &&
        typeof m.id === 'string' &&
        typeof m.text === 'string'
      );
      if (!valid) throw new Error('invalid memory data');
      // Normalize: fill in any missing optional fields so downstream code is safe.
      const memories = parsed.memories.map((m) => ({
        id: m.id,
        text: m.text,
        category: typeof m.category === 'string' ? m.category : '',
        createdAt: m.createdAt || m.updatedAt || new Date().toISOString(),
        updatedAt: m.updatedAt || new Date().toISOString(),
      }));
      this.data = { version: 1, updatedAt: parsed.updatedAt || '', memories };
    } catch (err) {
      console.error(`[memory] could not load ${this.file} (${err.message}) — starting with empty memory`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = { version: 1, updatedAt: '', memories: [] };
    }
  }

  _save() {
    // A failed save must not crash the server (see sessions.js for why).
    this.data.updatedAt = new Date().toISOString();
    const temp = `${this.file}.tmp`;
    try {
      // mode 0o600: owner read/write only — memory holds personal facts,
      // don't leave it world-readable (the default 0644).
      writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    } catch (err) {
      console.error(`[memory] save failed: ${err.message}`);
      try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    }
  }

  add(text, category = '') {
    text = String(text || '').trim();
    if (!text) return null;

    const existing = this.data.memories.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      // Bump updatedAt so search ranking reflects the most recent re-adding
      existing.updatedAt = new Date().toISOString();
      this._save();
      return { memory: existing, evicted: null };
    }

    const now = new Date().toISOString();
    const memory = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`,
      text: text.slice(0, MAX_TEXT_LENGTH),
      category: String(category || '').trim().slice(0, 40),
      createdAt: now,
      updatedAt: now,
    };

    // Evict the oldest entry if at capacity — but REPORT it so the model can
    // tell the user what was dropped. Silent loss of a saved fact is worse than
    // a full memory; the message goes into the tool result, which the model sees.
    let evicted = null;
    while (this.data.memories.length >= MAX_MEMORIES) {
      evicted = this.data.memories.shift();
    }
    this.data.memories.push(memory);
    this._save();
    return { memory, evicted };
  }

  search(query = '', limit = 5) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.data.memories.slice(-limit).reverse();

    // Tokenise on Unicode word boundaries so non-Latin scripts (Greek, CJK,
    // etc.) work — the old [^a-z0-9] split dropped every non-Latin token.
    const tokens = [...new Set((q.match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1))];
    const scored = this.data.memories.map((m) => {
      const text = m.text.toLowerCase();
      let score = 0;
      if (text.includes(q)) score += 5;
      for (const token of tokens) if (text.includes(token)) score += 1;
      if (m.category && m.category.toLowerCase().includes(q)) score += 2;
      return { memory: m, score };
    });

    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, limit)
      .map((x) => x.memory);
  }

  delete(id) {
    const before = this.data.memories.length;
    this.data.memories = this.data.memories.filter((m) => m.id !== id);
    if (this.data.memories.length === before) return false;
    this._save();
    return true;
  }
}
