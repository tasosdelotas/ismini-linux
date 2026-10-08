// sessions.js — Session persistence for ismini.
// Stores up to 4 sessions in sessions.json. Each session has all messages
// (user, assistant, tool calls) so the AI has full context on restore.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_SESSIONS = 4;

export class SessionStore {
  constructor(dir) {
    this.file = join(dir, 'sessions.json');
    this.data = { activeId: null, sessions: [] };
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      // Validate structure. If it's malformed (hand-edit, partial write, etc.),
      // do NOT crash startup — log and start fresh so the server always boots.
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('invalid session data');
      const valid = parsed.sessions.every(s => s && typeof s.id === 'string' && Array.isArray(s.messages) &&
          s.messages.every(m => m && typeof m === 'object' && typeof m.role === 'string' &&
            ['user', 'assistant', 'tool', 'system'].includes(m.role)));
      if (!valid) throw new Error('invalid session data');
      this.data = parsed;
      if (this.data.activeId && !this.data.sessions.some(s => s.id === this.data.activeId)) {
        this.data.activeId = this.data.sessions[0]?.id || null;
      }
    } catch (err) {
      // Corrupt/unreadable file: preserve it for inspection, start fresh.
      console.error(`[sessions] could not load ${this.file} (${err.message}) — starting with a fresh session`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = { activeId: null, sessions: [] };
    }
  }

  _save() {
    // A failed save (full disk, bad permissions, a stray .tmp file/dir, etc.)
    // must NOT crash the server — runTurn isn't awaited, so an uncaught throw
    // here becomes an unhandled rejection and kills the process. Log and clean
    // up the temp file instead; the in-memory session stays intact.
    const temp = `${this.file}.tmp`;
    try {
      // mode 0o600: owner read/write only. Sessions hold chat history and
      // command output — don't leave them world-readable (the default 0644).
      writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    } catch (err) {
      console.error(`[sessions] save failed: ${err.message}`);
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  // Get the active session (or null if none)
  getActive() {
    if (!this.data.activeId) return null;
    return this.data.sessions.find(s => s.id === this.data.activeId) || null;
  }

  // Get all sessions (newest first)
  list() {
    return [...this.data.sessions].sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
  }

  // Get a specific session by ID
  get(id) {
    return this.data.sessions.find(s => s.id === id) || null;
  }

  // Create a new empty session and make it active
  create() {
    const session = {
      id: randomUUID(),
      started: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      messages: [],
    };
    this.data.sessions.push(session);
    this.data.activeId = session.id;
    this._enforceLimit();
    this._save();
    return session;
  }

  // Save messages to the active session
  saveActive(messages) {
    const s = this.getActive();
    if (!s) return null;
    s.messages = messages;
    s.lastActive = new Date().toISOString();
    this._save();
    return s;
  }

  // Switch active session to the given ID
  switchTo(id) {
    const s = this.get(id);
    if (!s) return null;
    this.data.activeId = id;
    this._save();
    return s;
  }

  // Archive current active session (it stays in the list) and create a new one
  archiveAndCreate() {
    // The current session is already saved — just create a new one
    return this.create();
  }

  // Keep only the last MAX_SESSIONS sessions (by lastActive, with stable secondary sort)
  _enforceLimit() {
    if (this.data.sessions.length <= MAX_SESSIONS) return;
    
    // Stable sort: primary by lastActive desc, secondary by id desc (UUIDs are time-sortable)
    const sorted = [...this.data.sessions].sort((a, b) => {
      const timeCmp = new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
      if (timeCmp !== 0) return timeCmp;
      return b.id.localeCompare(a.id); // Deterministic tiebreaker
    });
    
    const keepIds = new Set(sorted.slice(0, MAX_SESSIONS).map(s => s.id));
    this.data.sessions = this.data.sessions.filter(s => keepIds.has(s.id));
    
    if (!keepIds.has(this.data.activeId)) {
      // Always fall back to NEWEST kept session (first in sorted order)
      this.data.activeId = sorted.find(s => keepIds.has(s.id))?.id || null;
    }
  }
}
