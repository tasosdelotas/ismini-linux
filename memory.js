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
      if (!Array.isArray(parsed.memories) || !parsed.memories.every((m) =>
        m && typeof m === 'object' &&
        typeof m.id === 'string' &&
        typeof m.text === 'string' &&
        typeof m.category === 'string' &&
        typeof m.updatedAt === 'string'
      )) throw new Error('invalid memory data');
      this.data = { version: 1, updatedAt: parsed.updatedAt || '', memories: parsed.memories };
    } catch (err) {
      throw new Error(`Could not load memory from ${this.file}: ${err.message}`);
    }
  }

  _save() {
    this.data.updatedAt = new Date().toISOString();
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
    renameSync(temp, this.file);
  }

  add(text, category = '') {
    text = String(text || '').trim();
    if (!text) return null;

    const existing = this.data.memories.find((m) => m.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      // Bump updatedAt so search ranking reflects the most recent re-adding
      existing.updatedAt = new Date().toISOString();
      this._save();
      return existing;
    }

    const now = new Date().toISOString();
    const memory = {
      id: `mem_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`,
      text: text.slice(0, MAX_TEXT_LENGTH),
      category: String(category || '').trim().slice(0, 40),
      createdAt: now,
      updatedAt: now,
    };

    this.data.memories.push(memory);
    while (this.data.memories.length > MAX_MEMORIES) this.data.memories.shift();
    this._save();
    return memory;
  }

  search(query = '', limit = 5) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return this.data.memories.slice(-limit).reverse();

    const tokens = [...new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length > 1))];
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
