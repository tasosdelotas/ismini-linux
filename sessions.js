// sessions.js — Session persistence for ismini.
// Archives sessions in sessions.json (capped at MAX_SESSIONS). Each session has all messages
// (user, assistant, tool calls) so the AI has full context on restore.
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Cap the number of archived sessions so sessions.json cannot grow without bound.
// Least-recently-used sessions are removed automatically when the limit is reached.
// Users can still delete individual sessions from the UI.
const MAX_SESSIONS = 20;
// Prevent a single session's sessions.json entry from growing infinitely during
// very long chats. We keep the most recent messages per session (see saveActive).
const MAX_SESSION_MESSAGES = 500;
// Byte budget for a single session's saved messages. The count cap alone allows one
// session to hold ~24 MB (500 × up-to-48 KB tool results), and saveActive rewrites the
// WHOLE file synchronously every turn — at that size the event loop blocks for seconds,
// which is a real "ismini froze" source on heavy multi-file audits. 2 MB keeps ~40 full-size
// tool results, far more than the rolling context window can use anyway.
const MAX_SESSION_BYTES = 2 * 1024 * 1024;

export class SessionStore {
  constructor(dir) {
    this.file = join(dir, 'sessions.json');
    this.data = { activeId: null, sessions: [] };
    this.lastSaveFailed = false;
    this.lastError = null;
    this.loadError = null;
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));

      // Validate structure.
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('invalid session data');

      // Salvage per-session instead of all-or-nothing: a single malformed message
      // anywhere used to rename the WHOLE file to .corrupt-* and wipe every session.
      // Now we drop only the bad messages (and sessions with no valid id/messages) and
      // keep everything else. Timestamps are normalized so a missing/invalid one can't
      // turn new Date(...) into Invalid Date and break the sort order in list()/search().
      const okMsg = (m) => m && typeof m === 'object' && typeof m.role === 'string'
        && ['user', 'assistant', 'tool', 'system'].includes(m.role);
      const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v))) ? v : new Date().toISOString();

      const salvaged = parsed.sessions
        .filter(s => s && typeof s.id === 'string' && Array.isArray(s.messages))
        .map(s => ({ ...s, messages: s.messages.filter(okMsg), started: iso(s.started), lastActive: iso(s.lastActive) }));
      if (parsed.sessions.length && !salvaged.length) throw new Error('no salvageable sessions');

      this.data = { activeId: parsed.activeId ?? null, sessions: salvaged };

      // Fallback if activeId points to a deleted session.
      if (this.data.activeId && !this.data.sessions.some(s => s.id === this.data.activeId)) {
        this.data.activeId = this.data.sessions[0]?.id || null;
      }
    } catch (err) {
      // Corrupt/unreadable file: preserve it for inspection, start fresh. Record the
      // reason so web.js can surface it — silent loss of all history should never look
      // like "you never told me."
      console.error(`[sessions] could not load ${this.file} (${err.message}) — starting with a fresh session`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = { activeId: null, sessions: [] };
      this.loadError = `could not load sessions.json (${err.message}); previous file kept as ${this.file}.corrupt-…`;
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
      this.lastSaveFailed = false;
      return true;
    } catch (err) {
      console.error(`[sessions] save failed: ${err.message}`);
      this.lastSaveFailed = true;
      this.lastError = err.message;
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
      return false;
    }
  }

  getActive() {
    if (!this.data.activeId) return null;
    return this.data.sessions.find(s => s.id === this.data.activeId) || null;
  }

  list() {
    // lastActive is normalized to ISO-8601 on load, so lexicographic compare == time order.
    return [...this.data.sessions].sort((a, b) => String(b.lastActive).localeCompare(String(a.lastActive)));
  }

  get(id) {
    return this.data.sessions.find(s => s.id === id) || null;
  }

  // Delete a session by id. Returns the deleted session, or null if not found.
  // If the deleted session was the active one, the active pointer moves to the most
  // recently used remaining session — and if that was the LAST one, a fresh session is
  // created so the next conversation is still saved (a null activeId would silently
  // stop saveActive from persisting anything).
  delete(id) {
    const idx = this.data.sessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    const [removed] = this.data.sessions.splice(idx, 1);
    if (this.data.activeId === id) {
      const next = this.list()[0];
      if (next) this.data.activeId = next.id;
      else { this._save(); this.create(); return removed; }
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
    // Keep single-character CJK terms (猫, 車, 家) — length>=2 alone dropped them, so a
    // Japanese/Chinese query returned nothing. Same fix as memory.js.
    const terms = q.split(/\s+/).filter(w => w.length >= 2 || /[^\x00-\x7F]/.test(w));
    if (!terms.length) return [];
    const results = [];
    for (const s of this.list()) { // already sorted newest-first
      for (const m of s.messages) {
        // Deliberately user/assistant only: recall is for recovering what was SAID, not
        // dumping 48 KB tool blobs into a search result. The notes file is the durable
        // record of audit findings — don't "fix" this by including tool messages.
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
    results.sort((a, b) => (b.score - a.score) || String(b.sessionDate).localeCompare(String(a.sessionDate)));
    // Clamp so a model asking for limit:10000 can't dump thousands of full-text matches
    // into one tool result of pure noise.
    return results.slice(0, Math.min(Math.max(1, Number(limit) || 8), 50));
  }

  // Delete every session. Always leaves a live session so the next conversation is saved.
  deleteAll() {
    const count = this.data.sessions.length;
    this.data.sessions = [];
    this.data.activeId = null;
    this.create();          // creates + saves + sets activeId
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

    // Enforce MAX_SESSIONS: remove the LEAST-recently-used session when over the limit.
    // (shift() removed by creation order, so a daily-used session opened weeks ago was
    // evicted before an abandoned one from yesterday — same LRU bug as memory.js.)
    // The active session is never evicted: if it happens to be the oldest, skip it and
    // evict the next-oldest instead (stopping would leave the store over the cap).
    const evicted = [];
    while (this.data.sessions.length > MAX_SESSIONS) {
      let oldest = -1;
      for (let i = 0; i < this.data.sessions.length; i++) {
        if (this.data.sessions[i].id === this.data.activeId) continue;
        if (oldest === -1 || String(this.data.sessions[i].lastActive) < String(this.data.sessions[oldest].lastActive)) oldest = i;
      }
      if (oldest === -1) break; // only the active session remains — nothing safe to evict
      const [gone] = this.data.sessions.splice(oldest, 1);
      evicted.push(gone.id);
      console.log(`[sessions] archived limit reached — removed least-recently-used session ${gone.id}`);
    }

    this._save();
    return { ...session, evicted };
  }

  saveActive(messages) {
    const s = this.getActive();
    if (!s) return null;

    // Cap both the COUNT and the BYTES of saved messages so sessions.json can't grow
    // into hundreds of MB (each tool result is up to 48 KB). Keep the most recent
    // non-system messages, then trim from the front until under the byte budget.
    const systemMsgs = messages.filter(m => m.role === 'system');
    let out = messages.filter(m => m.role !== 'system').slice(-MAX_SESSION_MESSAGES);

    const sizeOf = (m) =>
      (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length) +
      (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
    let total = out.reduce((sum, m) => sum + sizeOf(m), 0);
    while (total > MAX_SESSION_BYTES && out.length > 8) {
      total -= sizeOf(out[0]);
      out.shift();
    }

    // A blind slice can start MID-turn, on a `tool` message whose preceding
    // assistant.tool_calls was cut. On restore that orphaned tool message makes
    // llama.cpp's Jinja template reject the whole conversation (permanently unloadable).
    // Never start on an orphan — same invariant _enforceContextWindow protects.
    while (out.length && out[0].role === 'tool') out.shift();

    // Copy the objects so the store doesn't alias the live agent's message objects
    // (a latent hazard if either side ever mutates them in place).
    s.messages = [...systemMsgs, ...out.map(m => ({ ...m }))];

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
}
