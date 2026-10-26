// sessions.js — Session persistence for ismini.
// Stores up to 4 sessions in sessions.json. Each session has all messages
// (user, assistant, tool calls) so the AI has full context on restore.
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Unlimited session archive: keep every session on disk so users can go back
// to any past conversation. (Was 4.) Sessions can still be deleted from the UI.
const MAX_SESSIONS = Infinity;
// Prevent a single session's sessions.json entry from growing infinitely during
// very long chats. We keep the system prompts + the last 500 messages per session.
const MAX_SESSION_MESSAGES = 500;

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
      
      // Validate structure
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('invalid session data');
      
      const valid = parsed.sessions.every(s => 
        s && typeof s.id === 'string' && 
        Array.isArray(s.messages) &&
        s.messages.every(m => 
          m && typeof m === 'object' && 
          typeof m.role === 'string' && 
          ['user', 'assistant', 'tool', 'system'].includes(m.role)
        )
      );
      if (!valid) throw new Error('invalid session data');

      this.data = parsed;
      
      // Fallback if activeId points to a deleted session
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
    // Atomic save: write to .tmp then rename. Prevents corruption if the app crashes mid-save.
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

  getActive() {
    if (!this.data.activeId) return null;
    return this.data.sessions.find(s => s.id === this.data.activeId) || null;
  }

  list() {
    return [...this.data.sessions].sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
  }

  get(id) {
    return this.data.sessions.find(s => s.id === id) || null;
  }

  // Delete a session by id. Returns the deleted session, or null if not found.
  // If the deleted session was the active one, the active pointer moves to the
  // most recently used remaining session (or null if none are left).
  delete(id) {
    const idx = this.data.sessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const [removed] = this.data.sessions.splice(idx, 1);
    if (this.data.activeId === id) {
      const next = this.list()[0];
      this.data.activeId = next ? next.id : null;
    }
    this._save();
    return removed;
  }

  // Keyword-search across ALL sessions (newest first) and return matching
  // messages. Each result: { sessionId, sessionDate, role, text, score }.
  // `query` is split into words; a message matches if it contains any of them
  // (case-insensitive). Results are ranked by how many query words they contain.
  search(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(w => w.length >= 2);
    if (!terms.length) return [];
    const results = [];
    for (const s of this.list()) { // already sorted newest-first
      for (const m of s.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join(' ') : '');
        if (!text || !text.trim()) continue;
        const lower = text.toLowerCase();
        let score = 0;
        for (const t of terms) if (lower.includes(t)) score++;
        if (score > 0) {
          results.push({ sessionId: s.id, sessionDate: s.lastActive, role: m.role, text: text.trim(), score });
        }
      }
    }
    // Rank: more matched terms first, then newest session first (stable).
    results.sort((a, b) => (b.score - a.score) || (new Date(b.sessionDate) - new Date(a.sessionDate)));
    return results.slice(0, Math.max(1, Number(limit) || 8));
  }

  // Delete every session. Returns the number of sessions removed.
  deleteAll() {
    const count = this.data.sessions.length;
    this.data.sessions = [];
    this.data.activeId = null;
    this._save();
    return count;
  }

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

  saveActive(messages) {
    const s = this.getActive();
    if (!s) return null;

    // Cap the number of saved messages to prevent sessions.json from growing
    // infinitely during long chats. Keep system prompts + the most recent messages.
    if (messages.length > MAX_SESSION_MESSAGES) {
      const systemMsgs = messages.filter(m => m.role === 'system');
      const recentMsgs = messages.filter(m => m.role !== 'system').slice(-MAX_SESSION_MESSAGES);
      s.messages = [...systemMsgs, ...recentMsgs];
    } else {
      s.messages = messages;
    }

    s.lastActive = new Date().toISOString();
    this._save();
    return s;
  }

  switchTo(id) {
    const s = this.get(id);
    if (!s) return null;
    this.data.activeId = id;
    this._save();
    return s;
  }

  archiveAndCreate() {
    // The current session is already saved via saveActive() before this is called.
    return this.create();
  }

  _enforceLimit() {
    if (this.data.sessions.length <= MAX_SESSIONS) return;
    
    // Sort: primary by lastActive desc, secondary by id desc as a deterministic tiebreaker
    const sorted = [...this.data.sessions].sort((a, b) => {
      const timeCmp = new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime();
      if (timeCmp !== 0) return timeCmp;
      return b.id.localeCompare(a.id); 
    });
    
    const keepIds = new Set(sorted.slice(0, MAX_SESSIONS).map(s => s.id));
    this.data.sessions = this.data.sessions.filter(s => keepIds.has(s.id));
    
    // If the active session was dropped, fall back to the newest kept session
    if (!keepIds.has(this.data.activeId)) {
      this.data.activeId = sorted.find(s => keepIds.has(s.id))?.id || null;
    }
  }
}