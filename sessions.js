// sessions.js — Session persistence for ismini.
// Stores up to 4 sessions in sessions.json. Each session has all messages
// (user, assistant, tool calls) so the AI has full context on restore.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
    } catch {
      this.data = { activeId: null, sessions: [] };
    }
  }

  _save() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
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

  // Keep only the last MAX_SESSIONS sessions (by lastActive)
  _enforceLimit() {
    if (this.data.sessions.length > MAX_SESSIONS) {
      const sorted = [...this.data.sessions].sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
      const keep = new Set(sorted.slice(0, MAX_SESSIONS).map(s => s.id));
      this.data.sessions = this.data.sessions.filter(s => keep.has(s.id));
      // If active was deleted, switch to newest
      if (!keep.has(this.data.activeId)) {
        this.data.activeId = sorted[0]?.id || null;
      }
    }
  }
}
