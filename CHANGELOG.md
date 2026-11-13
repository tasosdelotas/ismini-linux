# Changelog

All notable changes to ismini are documented in this file.

## [19.0.0] - 2026-11-13

**One Click Install.** No new agent features — ismini's brain is exactly the audited
v18.0.0. This release changes only HOW you get ismini: a double-click installer.

### ✨ What's new

- **📦 Double-click installer (`ismini-vX.Y.Z-linux-x64.AppImage`)** — download it from
  the release page, double-click it, wait for “✓ Ismini is Installed”, click the desktop
  icon. No extracting, no finding `install.sh`, no terminal.
  - It is a **fat script**: an executable bash installer with the full release (source +
    bundled Node + llama.cpp) appended as a compressed tar.gz payload. **No FUSE, no
    AppImage runtime** — works on any Linux distro with bash + tar + gzip.
  - On double-click it shows “The installation has begun — just wait a moment…”, installs
    silently into `~/ismini` (the exact same hardened `install.sh` path as the manual
    install), then confirms: “✓ Ismini is Installed — Now click on the desktop icon or
    find ismini in your app menu”. Dialog popup + system notification, both.
  - **No auto-launch** — the AppImage is a one-time installer (like a phone's .apk);
    the desktop icon is how you open ismini. Delete the file after installing.
  - If a file manager extracts it instead of running it, you get the folder with
    `install.sh` — the classic path. Never worse than before.
- **🔄 In-app Update button works with the new format** — `/api/download-update` now
  prefers the `.AppImage` asset (runs it with `--no-stop`, which the installer passes
  through to `install.sh`) and falls back to the classic `.zip` for older releases.
- **📦 The classic `.zip` asset is still published** alongside the AppImage, for power
  users and scripts. Same content, same version.

### 🐛 Bug fixes

- None needed — v18.0.0's agent code ships unchanged (it passed the full line-by-line
  audit). This release touches only packaging + the updater.

### ⚙️ Notes

- `install-ismini.sh` is new app code in the repo (the installer bootstrap).
- Repackaging recipe for future releases: see HANDOFF.md → “📦 PACKAGING RECIPE”.

---

## [18.0.0] - 2026-11-11

**A Friend Who Remembers.** This release consolidates everything built since v17.0.5
(17.1.0 → 17.3.3) into a single, stable, well-audited release. ismini now knows who you
are, greets you warmly, remembers how she fixed things, and ships with a full line-by-line
security + correctness audit. No new experimental features — just the personal, reliable
ismini, hardened.

### ✨ Features (since v17.0.5)

- **👤 User Profile (`memory.md`)** — ismini knows your name, location, PC specs, family,
  pets, habits, and preferences on *every* turn. Always in context, never re-asked.
  Human-readable, editable, preserved across upgrades.
- **🌅 Warm date-time-weather greeting** — once per day, ismini greets you by name, gives
  the date/time, and reports current weather (Open-Meteo, free, no key). Handles small
  villages. Same day after that → a normal "hi".
- **🧰 Skill Shelf** — ismini remembers *how* she fixed things. One markdown file per
  skill in `~/ismini/skills/` (preserved across upgrades). Checks the shelf before
  re-deriving a fix; offers to save (confirm-gated, never auto-save).
- **📝 System prompt in its own file** — `system-prompt.md` (ismini's character), replaced
  on every upgrade so it always tracks the latest release. Not user-customizable.
- **🗑️ Two uninstall methods** — `uninstall.sh` (full removal) and `uninstall-preserve.sh`
  (removes app code, **keeps** your sessions, memory, models, and settings).
- **❓ Troubleshooting section in Help modal** — 7 newcomer-friendly tips (session ends
  early, slow responses, "failed to fetch", model won't load, ismini seems stuck, voice/TTS,
  update broke something).

### 🐛 Bug fixes (since v17.0.5)

- **Tool-call markup no longer leaks to screen/TTS** — the streaming-safe
  `createToolMarkupStripper()` drops raw `antml:*` / `<function=…>` / `<invoke …>` markup
  before it reaches the UI and TTS. Buffers across chunk boundaries.
- **sudo toggle stuck at ON** — click handler now uses the tracked state (`next = !sudoOn`).
- **Markup stripper expanded** — catches `antml:*`, `<function=…>`, `<parameter …>`,
  `<tool_call>`, `<invoke …>`, `</function>`, etc. Prose with the word "function" (no angle
  brackets) is NOT stripped.
- **Reliable send / shutdown / turn flow** — fixed 3 regressions from the weather feature:
  "network error: failed to fetch", "freezes after a couple turns", "stays alive forever
  after close" (all in `web.js`).
- **Update flow failure UI** — `/api/download-update` now shows "Update failed" + the error
  instead of spinning forever when `install.sh --no-stop` fails.
- **Session cap 20 + LRU eviction** — `sessions.json` no longer grows unbounded.
- **`rm -rf $HOME` blocklist** — `$HOME` gap closed in DANGEROUS_PATTERNS.
- **Busy-race fix** in `/send` (fire-and-forget pattern; `busy` always reset).
- **Command-injection hardening** — `execSync` shell interpolation → `spawnSync` array args.
- **Help-modal title overlap** — widened `.help-key` column, removed `white-space: nowrap`,
  so long titles no longer overlap the description text.

### 🔍 Deep-dive audit (full record in HANDOFF.md)

A complete line-by-line review of every source file. Findings resolved/verified:
context-window aligned to 8192 across `config.json` / `llama-backend.js` / `web.js`;
model-switch body limit set to 8 KB; exec tool confirmed implemented; icon generation
confirmed fit-to-square + padding (never cropped); dead code removed (ROUTES Map,
`registerRoute`, `spawnDetached`, favicon cache, `_enforceLimit`, `marbleBg`, `starsBg`);
`install.sh` no longer self-invokes recursively; `memory.md` copy guarded on upgrade.

### ⚙️ Defaults

- **`config.json` is app code** — replaced on every install/upgrade (backed up to
  `config.json.bak` first). The source `config.json` is the single source of truth.
- **Default context 8192** (was 16384) — safe baseline for any PC; raise via the in-app
  ctx chip.
- **sudo ON by default** — ismini's target user is a newcomer who wants the agent to *do
  things*. The `exec` tool is sandboxed (`resolveUserPath` blocks `/etc`, `/boot`, `/sys`,
  `/proc`, `/dev` + sensitive dotfiles; `spawnSync` array args; curl/wget blocked). Turn
  off in the UI if you prefer.

### 🧹 Dead code removed

~60 lines across `web.js` (ROUTES Map, 36 `registerRoute` calls, `spawnDetached`, dead
favicon cache), dead `_enforceLimit`, stale comments, `marbleBg`/`starsBg`.

---

## [17.3.3] - 2026-11-08

### 🔧 Fixes from deep-dive review

- **#2.3 Update flow failure UI:** `/api/download-update` in `web.js` now calls `updateProgress('failed', ...)` in the catch block, so the in-app progress page shows "Update failed" with the error message instead of spinning forever when `install.sh --no-stop` fails.
- **#2.2 Icon never cropped:** `install.sh` already uses fit-to-square + padding (`-resize ${px}x${px} -background transparent -gravity center -extent ${px}x${px}`) with no forced-crop `!` flag — the statue's head stays intact at all sizes.
- **#3.2 No recursive self-call:** `install.sh` runs desktop-entry setup directly instead of re-invoking itself recursively.
- **#3.3 memory.md copy guarded:** `install.sh` only copies `memory.md` on fresh install (`$DIR != $DEST` and destination missing), preserving user edits on upgrade.
- **#2.4 Uninstall preserve (new script):** Added `uninstall-preserve.sh` — a separate script that removes the app code but **keeps** user data (sessions, memory, models, settings). `uninstall.sh` is unchanged and still deletes everything. Documented in the Help modal.
- **#3.1 Session limit capped at 20:** `sessions.js` `MAX_SESSIONS = 20` with LRU eviction of oldest sessions. Prevents `sessions.json` from growing unbounded.
- **#2.1 exec tool:** Already fully implemented in `agent.js` (`toolExec` at lines 478-553, registered at 743). No change needed.
- **#3.4 Dead code removed:** Removed `marbleBg` and `starsBg` from `STATIC_ASSETS` in `web.js`.
- **Help modal title overlap:** `web/index.html` — widened `.help-key` column from 118px to 150px, removed `white-space: nowrap`, changed `align-items` to `start` so long titles (e.g. "Voice (TTS) is quiet/absent") no longer overlap the description text.

### ⚙️ Defaults

- **sudo toggle ON by default:** `config.json` `"sudo": true` (was `false`). Users can turn it off in the UI.


### 🐛 Bug fixes — sudo toggle + expanded markup stripper

**Bug 1 — sudo toggle stuck at ON:** the click handler computed
`next = !sudoBtn.classList.contains("off")` — when the button had NO `.off` class
(i.e. sudo was ON), `contains("off")` was `false`, so `next = !false = true` →
always sent `enabled: true`. **Fix:** `next = !sudoOn` (use the tracked state,
negate it). File: `web/index.html`.

**Bug 2 — markup stripper too narrow:** v17.3.1 only caught `antml:` tags.
Gemma also emits `<function=read>`, `<parameter name=…>`, `<tool_call>`,
`<invoke name=…>` — none of which matched. **Fix:** expanded the regex to catch
all tool-call markup formats: `antml:*`, `<function=…>`, `<parameter …>`,
`<tool_call>`, `<invoke …>`, `</function>`, `</parameter>`, etc. Prose that
mentions the word "function" without angle brackets is NOT stripped. File:
`agent.js`.

Both pass `node --check` + 7 streaming tests.

## [17.3.1] - 2026-11-06

### 🐛 Bug fix — tool-call markup no longer leaks to screen/TTS

**Bug:** after several tool calls (e.g. a long `apt`/`exec` session), ismini would
print the raw tool-call markup (`antml:invoke`, `antml:function`, `antml:parameter`)
on screen, read it aloud with TTS, then freeze until the user typed again.

**Root cause:** some models (Gemma) emit tool calls as *text* in `delta.content`
instead of native `tool_calls`. The streaming parser pushed every `delta.content`
chunk straight to the UI (`onChunk` → `process.stdout.write` → `broadcast({type:'token'})`),
so the markup hit the live bubble and TTS. The malformed text also wasn't parsed
as a real tool call, so the turn stalled.

**Fix:** new `createToolMarkupStripper()` in `agent.js` — a streaming-safe filter
that drops any line containing a tool-call tag (`antml:invoke|function|parameter|
content|…`) before it reaches the UI/TTS. It buffers across chunk boundaries so a
tag split across two chunks is still caught. Clean text and blank lines pass
through untouched. Wired into `_streamResponse` so only clean text is streamed.

**File:** `agent.js` only. Passes `node --check` + 6 streaming tests.

## [17.3.0] - 2026-11-06

### ⚙️ config.json is now app code — replaced on every upgrade

**Decision (tasos):** `config.json` tracks the release, exactly like `system-prompt.md`.
We ship the canonical defaults in the source; on install/upgrade the user's copy is
**replaced** with the new one. The user's previous config is backed up to
`config.json.bak` first, so nothing is ever lost.

**Why:** we change `config.json` frequently (new tools, defaults), and the old
field-by-field merge was fragile — it only *added* tools and never *removed*
deprecated ones, so a removed tool would linger forever in a user's config. Now the
shipped config is the single source of truth, and the in-app Update button applies it
cleanly. If a user wants a custom value, they set it *after* the update (it's their
choice, and their old config is one `cp config.json.bak config.json` away).

**Files:** `install.sh` (replaced the ~40-line merge block with replace+backup;
removed `config.json` from the tar excludes), `config.json` (now the canonical
default; `skills` added), `web.js` (comment updated). All pass `bash -n` / `node --check`.

**Default context:** `llamaCpp.context` and `agent.contextWindow` both set to
**8192** (was 16384). `agent.maxTokens` was already 8192. This is a safe baseline
for unknown user hardware — `applyLoadedModel` derives a 7168-token reply budget,
and `_enforceContextWindow` reserves a 6144-token reply window, both healthy.
Users can raise context via the in-app ctx chip after update. The ctx chip
(`web/index.html`) now includes 8,192 as the lowest option.

**Help — Troubleshooting section:** new `Troubleshooting` section in the in-app
Help modal (`web/index.html`) with 7 newcomer-friendly tips: session ends too
soon (raise context), slow responses (smaller model/context), "failed to fetch"
(re-launch), model won't load (RAM guidance), ismini seems stuck (Pause),
voice/TTS (browser speech), update broke something (config.json.bak restore).
Also fixed the stale ctx chip description ("default is 16k" → "default is 8k").

### 🧰 Skill Shelf — ismini remembers how she fixed things

New **`skills`** tool: a growing shelf of reusable "how I fixed X" recipes, one
markdown file per skill, stored in `~/ismini/skills/` (preserved across upgrades).

**How it works:**
- **Check first:** when you describe a problem ismini may have solved before, she
  lists the shelf and reads the matching skill, then follows its steps instead of
  re-deriving the fix. This *reduces* work on small models rather than adding rules.
- **Offer to save (never auto-save):** after solving a genuinely non-trivial problem,
  she offers "Want me to save this as a skill?" The save is **confirm-gated** —
  nothing is written until you approve, so the shelf can't get polluted.
- **One file per skill:** human-readable, editable, deletable. `skills` actions:
  `list` (titles + one-line summaries), `read` (full steps), `save` (write), `delete`.

**Design (tasos's calls):** one file per skill · confirm-before-save · auto-check
the shelf when a problem is described.

**Files:** `agent.js` (new `toolSkills` + `skillsDir` + tool definition + dispatch
+ confirm-gating for `save`), `web.js` (passes `skillsDir: DATA_DIR/skills`, enables
`skills` tool), `system-prompt.md` (new `# Skill Shelf` section), `install.sh`
(excludes `skills/` from the copy so it survives upgrades). All pass `node --check`
/ `bash -n`.

## [17.2.1] - 2026-11-06

### 🐛 Bug fixes — restored reliable send, shutdown, and turn flow

Three regressions introduced by v17.2.0's weather-greeting feature, all in `web.js`:

| Bug | Root cause | Fix |
|-----|-----------|-----|
| "network error: failed to fetch" on first send | `/send` used `await runTurn()`, blocking the HTTP response for the entire turn | Reverted to fire-and-forget: `sendJson(res, 202, {ok:true})` immediately, then `runTurn()` in background |
| "Freezes after a couple turns" | Same `await` pattern could leave `busy` stuck if the connection dropped mid-turn | Fire-and-forget ensures `runTurn`'s `finally` always resets `busy` |
| "Stays alive forever after close" (especially after Pause) | 5-second SSE grace period skipped `scheduleShutdown` if connection was <5s old; `busy` guard blocked the retry | Removed the grace period; SSE close always calls `scheduleShutdown`. Abort + `killActiveChild` ensure the turn finishes quickly so `busy` clears. |

**File:** `web.js` only. No new dependencies. All pass `node --check`.

## [17.2.0] - 2026-11-05

### 🌅 Greeting with weather — ismini now knows your sky

When the user says **hi / hello / good morning**, ismini responds with a warm,
informed greeting:

> *"Hi Tasos. Today is Thursday, November 5, 2026, and it's 20:53. Clear sky,
> 19°C in Afántou, South Aegean, Greece. How can I help you?"*

**How it works:**
- New **`weather` tool** (`tools/weather.js`) — geocodes the user's location
  (from `memory.md`) and fetches current condition + temperature via
  **Open-Meteo** (free, no API key, no account). Returns a short one-liner.
- The tool handles small villages gracefully: tries the full location string
  first, then falls back to the place name (e.g. "Afantou" from
  "Afantou, Rhodes, Greece").
- **`system-prompt.md`** — new `# Greetings` section: on a greeting, ismini
  greets by name, states date + time, calls the weather tool with the
  user's location, and asks "How can I help you?". 2–3 sentences, no briefing.
  If no location in profile, skips weather gracefully.
- **`agent.js`** — `weather` added to `TOOL_MAP`, `allTools`, default
  `enabledTools`, and the fail-streak detector.
- **`config.json`** — `weather` added to the default enabled tools list.
- **`web.js`** — `weather` added to the fallback `enabledTools` list.

**Design decision (tasos):** weather is always in the greeting (Option 1).
One small, harmless internet call to a free weather service — not a
"phone home" concern. The user asked for the weather; ismini fetches it.

**Refinements (same day):**
- **Once-per-day logic** — the rich greeting (date/time/weather) happens at most
  ONCE per calendar day. The server tracks the day in `greeting-state.json`
  (`lastGreeted` date). Same day after that → normal "hi". Next day → rich greeting again.
- **Name/location onboarding** — if the profile is missing a name or location,
  ismini asks for it during the greeting, then saves it to memory.md.
- **Greeting detection** — keyword match on hi/hello/hey/good morning/etc.
  (multi-language). Questions and full sentences are NOT treated as greetings.
- **`web.js`** — new: `greeting-state.json` tracking, `isGreeting()`,
  `profileHas()`, day-aware note injection in `/send` + `runTurn()`.

**Files changed:** `tools/weather.js` (new), `agent.js`, `web.js`,
`config.json`, `system-prompt.md`

## [17.1.1] - 2026-11-05

### ✨ System prompt refinements (ismini self-reviewed)

Ismini reviewed its own `system-prompt.md` and suggested improvements. After comparing
against the original, three genuine gaps were identified and merged in:

- **Contradiction rule** — if the user says something in the current session that
  contradicts `memory.md`, the most recent statement wins and `memory.md` is updated.
  (Previously there was no explicit rule for this case.)
- **Proactive recall** — if the conversation has grown long and ismini is losing track of
  earlier context, it should proactively use `recall` to pull in relevant details rather
  than guessing. (Previously recall was only triggered when the user explicitly referenced
  past work.)
- **Advanced troubleshooting** — if a shell command (`exec`) fails, ismini should try to
  diagnose first (grep, tail, dmesg on relevant logs) before reporting back. (Previously
  it just said "explain what went wrong and suggest alternatives.")

**Not adopted** (ismini's suggestions dropped these, but they were deliberate fixes for
specific bugs):
- Anti-hallucination line ("never invent a database, file path, or mechanism")
- Explicit `~/ismini/memory.md` path
- "Do NOT re-ask what the profile already states"
- Vision/image handling instruction
- "If the user says 'im fine', accept it"
- `memory_search` vs `recall` distinction

**Files changed:** `system-prompt.md` (3 lines added, nothing removed)

### 🔧 Deep-dive code inspection — 12 fixes

A full line-by-line review of every ismini source file uncovered dead code, a race
condition, a security gap, and stale references. All fixed:

| # | File | Fix |
|---|------|-----|
| 1 | `agent.js` | Restored `fileURLToPath` import (was accidentally removed; `__dirname` depends on it). Removed now-unused `dirname` from the `__dirname` computation. |
| 2 | `web.js` | Removed ~60 lines of dead code: the `ROUTES` Map, `registerRoute()` function, and 36 no-op `registerRoute(...)` calls. Real routing is the if/else chain. |
| 3 | `web.js` | Removed `STATIC_ASSETS.favicon` — cached a 25 KB PNG at boot that was never served. |
| 4 | `agent.js` | Fixed stale comment ("defined by the user in config.json") → now correctly says the prompt lives in `system-prompt.md`. |
| 5 | `install.sh` | `chmod +x` referenced non-existent `publish.sh` → corrected to `push-to-github.sh`. |
| 6 | `web.js` | Removed `spawnDetached()` — defined but never called. |
| 7 | `sessions.js` | Removed dead `_enforceLimit()` method and its call in `create()` (was a no-op since `MAX_SESSIONS = Infinity`). |
| 8 | `web.js` | Simplified `/api/pick-file` lock: removed redundant `pickInProgress` flag (the promise chain already serializes). |
| 9 | `web.js` | Replaced `execSync` shell-string interpolation with `spawnSync` (array args) in the update flow — eliminates a command-injection anti-pattern. |
| 10 | `agent.js` | Added `rm -rf $HOME` / `rm -rf ${HOME}` to `DANGEROUS_PATTERNS` (shell variable expansion was bypassing the existing `~`/`/home` block). |
| 11 | `web.js` | Fixed `busy` race in `/send`: set `busy = true` immediately after the check (before any `await`s) and reset on early-return paths. |
| 12 | `web.js` | (merged with #11) |

**Files changed:** `agent.js`, `web.js`, `sessions.js`, `install.sh`

## [17.1.0] - 2026-11-04

### ✨ User Profile (memory.md) — ismini now knows who you are

A new **`memory.md`** file (plain markdown, in `~/ismini/`) holds the user's core profile:
name, location, PC specs, family, pets, habits, preferences, and ongoing wants/needs.

**How it works:**
- `memory.md` is **always injected into the system prompt** — the model knows the user's
  basics on every single turn, with zero tool calls. No more "what's my name?" or re-explaining
  your setup.
- When the user shares a new fact or corrects an existing one ("my dog's name is Zeus",
  "I moved to Thessaloniki"), ismini **updates `memory.md`** using its existing `edit`/`write`
  tools. The file is the single source of truth for who the user is.
- The file is **human-readable and editable** — open it in any text editor and adjust it.
- On fresh install, a template with section headers is created. On upgrade, the user's
  existing `memory.md` is preserved.

**Difference from `memory.json` (keyword-searchable facts):**
| | `memory.json` | `memory.md` |
|---|---|---|
| Access | Model must call `memory_search` | Always in context, no tool call |
| Use case | Transient facts, project decisions | Core identity: name, setup, family, habits |
| Format | JSON | Plain markdown (readable, editable) |

### 🏗️ System prompt moved to `system-prompt.md` (always updates on upgrade)

**Problem:** The system prompt (ismini's character) lived inside `config.json` as a JSON
string. On an in-place upgrade, `config.json` is *never replaced* (it's user data), so the
prompt only changed if the merge logic explicitly carried it over — which it didn't for the
memory.md feature. Result: ismini didn't know about `memory.md` and hallucinated a database.

**Fix:** Moved the system prompt out of `config.json` into its own file, **`system-prompt.md`**.
- `system-prompt.md` is **app code** — it gets replaced on every in-place install / WebUI
  update, exactly like `agent.js` and `web.js`. No merge rule needed, ever.
- `config.json` no longer has a `systemPrompt` field (it keeps only settings: context, port,
  tools, sudo).
- `web.js` — new `resolveSystemPrompt()`: reads `system-prompt.md`; if missing, uses a
  minimal default. (No config.json fallback — the prompt is not in config.json.)
- `install.sh` — `system-prompt.md` is NOT excluded from the copy (so it's replaced on
  upgrade). The old systemPrompt merge rule was removed (no longer needed).
- **Design decision (tasos):** ismini's character is NOT user-customizable. The prompt always
  tracks the latest release. Users who want a different personality can edit
  `system-prompt.md` locally, but it will be overwritten on the next upgrade.

**Files changed:**
- `system-prompt.md` — new file (the prompt, as clean markdown)
- `web.js` — new `resolveSystemPrompt()`, Agent now uses it
- `config.json` — `systemPrompt` field removed
- `install.sh` — removed the systemPrompt merge rule; `system-prompt.md` is copied normally

**Verified:** `node --check` clean; `resolveSystemPrompt()` tested (file present → uses file;
file missing + config has prompt → uses config; both missing → default). Live install updated.

### 🐛 Fixed: ismini ignored memory.md and used memory_add instead

**Problem:** On an in-place upgrade, ismini did not know about `memory.md` — it saved
user facts via `memory_add` (memory.json) and, when asked where it kept them, hallucinated
a "local database / SQLite" and "no static file path."

**Root cause:** the system prompt (which tells ismini about `memory.md`) lived inside
`config.json`, and `config.json` is *never replaced* on an upgrade (it's user data). So the
live prompt stayed old and ismini had no idea `memory.md` existed.

**Fix (two parts):**
- **Moved the prompt to `system-prompt.md`** (see the entry above) so it updates with every
  release — this is the real fix. ismini now always knows about `memory.md`.
- **Made the rule unambiguous in the prompt** — the "User Profile" section is now a
  **PRIORITY RULE**: personal facts (name, location, PC, family, pets, habits, preferences,
  wants/needs) go to `memory.md` **FIRST** via the edit/write tool; `memory_add` is demoted
  to a fallback for transient facts. Added the exact file location (`~/ismini/memory.md`)
  and an explicit anti-hallucination line ("never invent a database, file path, or mechanism
  you do not actually have").

**Verified:** `node --check` + `bash -n` clean; live install updated and re-tested.

### ✨ Welcome screen — warmer, more minimal

The welcome screen's intro was replaced with a personal, on-brand greeting that also
teaches the new memory feature:
> "Hi, I'm **Ismini**. I'll remember things about you — tell me your name, what you're
> working on, about your family, your PC specs, or anything you'd like me to always know,
> and I'll keep it for your eyes only."

The old "💡 New here?" bullet list (download a model / pick files / stays on your PC) was
removed to keep the screen minimal. The state-specific headlines (loading / no-model /
error) and the model-download steps remain.

**Files changed (welcome):**
- `web/index.html` — `renderWelcome()` intro text replaced; "New here?" block removed

**Files changed (profile):**
- `agent.js` — accepts `opts.userProfile`, appends it to the system prompt
- `web.js` — new `readUserProfile()` reads `memory.md` from the data dir, passes to Agent
- `system-prompt.md` — the "User Profile (memory.md)" section with usage rules (PRIORITY RULE)
- `install.sh` — excludes `memory.md` from the copy (preserved on upgrade) + creates template on fresh install
- `memory.md` — new template file (shipped in source)

## [17.0.5] - 2026-10-27

### ✨ Update button — finally reliable (keep it simple)

The in-app **Update button now works end-to-end.** After several versions of a fragile
*auto-restart* mechanism (kill the old browser window, spawn a progress window, self-kill the
server, relaunch via a detached watchdog — which kept leaving the old window open, producing
blank/`ERR_CONNECTION_REFUSED` windows, or "Failed to fetch"), we **removed the auto-restart
entirely** and replaced it with the simple flow that just works:

1. Click OK → a **persistent progress banner** appears (Downloading → Extracting → Installing).
2. The new version installs into `~/ismini` (via `install.sh --no-stop`, so the installer never
   kills the running updater mid-flight).
3. The banner ends with: **"Installed ✓ — please close and reopen ismini to use the new version."**

The server keeps running the old (in-memory) code for the whole update, so progress keeps flowing
and nothing crashes. No self-kill, no watchdog, no window-killing — and it's **browser-agnostic**
(Edge/Chrome/Brave/Firefox) because it stops fighting the browser's process model.

- `web.js` `/api/download-update` — removed the self-kill / relaunch-watchdog / backend-stop;
  ends with the "close and reopen" message. `catch`/`finally` still reset the `updating` guard.
- `install.sh` — new `--no-stop` flag so the installer doesn't kill the running updater.
- `web/index.html` — progress banner text updated to the "close and reopen" instruction.

Your session, models, and settings are preserved. Just close and reopen ismini to use the new version.

> **Note:** the 17.0.2 / 17.0.3 / 17.0.4 entries below describe the earlier *auto-restart*
> approach, which is now superseded by 17.0.5. They are kept for history.

## [17.0.4] - 2026-10-27

### 🐛 Fixes

- **Fixed the in-app Update button so it actually restarts ismini.** Several bugs were stacked on top of each other:
  - The updater was **killing its own process mid-update** (`process.kill(process.pid, …)`), causing an instant silent death → the browser saw "Update failed: Failed to fetch". Removed the self-kill from the download path.
  - The old stop step used `pkill -f 'ismini.*web.js'`, which matched **nothing** (ismini runs as `node web.js --port 8787`), so it killed nothing and then spawned a second instance on the busy port → a stale old-version window. Replaced with reliable PID-based handling.
  - The relaunch kept dying because the new instance shared the old server's process group (reaped on exit) and couldn't bind port 8787 while the old server held it. The updater now **spawns the new instance first in its own detached session** (`setsid` + `detached`), then stops the old server to free the port — so exactly one clean instance comes up.
  - The `updating` guard (from 17.0.3) still blocks the auto-exit from firing mid-download.
  Net result: click Update → old window closes → one new window opens on the new version, no "Failed to fetch", no stale second window. Your session, models, and settings are preserved.

## [17.0.3] - 2026-10-27

### 🐛 Fixes

- **Fixed "Update failed: Failed to fetch" when the tab closed mid-download.** ismini auto-exits ~5s after the last browser tab disconnects (to free RAM when idle); an in-app update wasn't excluded, so a tab closing during the ~94 MB download made the server `process.exit(0)` and killed the in-flight download. The updater now sets an `updating` flag for the whole update (download → install → relaunch) that blocks the auto-exit, so the update completes even if the window is closed.

## [17.0.2] - 2026-10-27

### 🐛 Fixes

- **Fixed the Update button leaving a stale window behind.** The updater's stop step used `pkill -f 'ismini.*web.js'`, but ismini runs as `node web.js --port 8787` (no `ismini` in the command line), so it killed nothing — then spawned a second instance on the still-busy port, leaving an old-version window open. It now stops ismini reliably via the PID file (`~/ismini/server.pid`, SIGTERM→SIGKILL) before installing and relaunching, so the old window closes and the new version opens cleanly.

## [17.0.1] - 2026-10-27

### 🐛 Fixes

- **Fixed the in-app "Update" button.** It previously downloaded the release's *Source code (zip)*, which ships Git-LFS *pointer files* (not real binaries) — so `node` + `llama-cpp` arrived as ~130-byte stubs and `install.sh` failed ("bundled Node.js is v0.0.0"). The updater now downloads the real **release asset** (`ismini-vX.Y.Z-linux-x64.zip`, ~94 MB, genuine binaries) and falls back to the zipball only if no asset exists. Release packaging (`push-to-github.sh`) now ships the app as a real asset (source-only repo, no 144 MB LFS blob) and verifies the uploaded size before declaring success.

## [17.0.0] - 2026-10-26

### ⚙️ Configuration

#### Context length is now MANUAL + visible in the top bar
- **REMOVED:** the RAM-adaptive context sizing (`_detectTotalMemory`, BPT formula, KV budget math). It was giving wrong numbers on unified-memory boxes and confusing users
- **NEW:** context length is set manually. Default: **16,384 tokens** (safe for every box). User raises it if their hardware can handle more
- **Top bar dropdown:** the `<N>k ctx` chip is now **clickable** — opens a dropdown with 6 values (16k / 32k / 64k / 96k / 128k / 256k). No more hidden Settings menu. The active value is highlighted
- **Settings popup:** the context dropdown was removed from Settings. A pointer line says "click the ctx chip in the top bar"
- **If the box can't afford the chosen context**, llama.cpp will OOM and the user lowers it. Simple, predictable, honest
- **`config.json`:** `llamaCpp.context: 16384` (default), `agent.contextWindow: 16384`
- **`web.js`:** `/api/context` GET returns `{ active, configured }`. POST accepts an integer (4096–262144), sets both config fields, restarts the backend
- **`llama-backend.js`:** `_resolveContext()` just reads `config.llamaCpp.context` (default 16384). No memory detection
- **`web/index.html`:** new `.ctx-drop` CSS + dropdown HTML in the chip + click handlers. Removed `ctxLenSel`/`ctxLenHint`/`refreshCtxLen` (old Settings-based code)
- **Help & Shortcuts modal:** updated the `<N>k ctx` row ("Click the chip to change it") and the Sessions row ("unlimited, ✕ to delete, Clear all")
- **`install.sh`:** merge upgrades up to 16384 without clobbering a higher user-set value
- Verified: `node --check` clean. No broken references to removed elements

#### TTS no longer reads symbols aloud
- **Problem:** TTS was reading `*` as "star", flag emojis as country names, and other symbols as words
- **Fix:** `textForSpeech()` now strips ALL asterisks (`*`), regional indicator symbols (flag emojis 🇬🇷🇫🇷🇺🇸), and any remaining non-text characters before passing to the SpeechSynthesis API
- **Result:** clean text only. "I love Greece" instead of "I love Greece [beep] greece"
- Verified: bold/italic/stray asterisks/flag emojis/regular emojis all stripped correctly

#### Settings popup no longer hides at window edges
- **Problem:** the ⚙️ popup was anchored `right: 0` (extends leftward). When the button wrapped to the left side (narrow window), the popup went off-screen
- **Fix:** on click, the popup checks the button's position and flips: **above** when <220px below, **right** when <260px from left edge. Both flips are independent (can combine)
- **Result:** the popup is always fully visible, regardless of window size or button position
- Verified: gear at left edge → popup extends rightward, fully visible

#### llama.cpp settings audit — explicit flags for previously-default settings
- `-np 1` (max concurrent predictions) — pinned to a single slot. Configurable via `llamaCpp.parallel` in `config.json`. Takes effect on next model load
- `--kv-unified` — explicitly enabled. With `-np 1` set (not auto), the default condition ("enabled if slot count is auto") no longer applies; explicit is safer. No config knob — always on
- All other llama.cpp flags (temperature, top-k, top-p, min-p, seed, penalties, load-mode, kv-offload, cache types, batch sizes, etc.) remain at llama.cpp defaults — ismini does not override them
- Verified: `node --check` clean; flags parse correctly in build 11838

## [16.1.1] - 2026-10-24

### 📝 Notes

#### System prompt revised (behavioral refinement — no code change)
- Rewrote the `systemPrompt` in `config.json` to tighten the agent's behavior. No backend/agent/web changes — this is prompt-only
- **Tool-calling discipline hardened** — 10 explicit anti-narration rules: no action → no tool calls; never invent a user request; no "please/okay" prefixes; no "I'll do X now" / "let me check" / "I'm checking" / "I'll fix that" / "I found X" / "as you can see" / "done!" filler. The model now stays quiet when nothing is actionable instead of narrating or over-calling tools
- **Memory tools clarified** — the prompt now distinguishes `memory_add` / `memory_search` (saved durable facts) from `recall` (the conversation archive), with explicit "when to use which" guidance so the agent stops calling `memory_search` for "what did we do before?" questions
- **Safety section added** — read-only commands just run; destructive / `sudo` / actions outside `/home/tasos` state what will happen and wait for a go-ahead; "smallest command" rule (bound output with `head`/`grep`/`-l` instead of dumping whole logs); independent checks batched in parallel
- **Error recovery clarified** — "model returns an error" now names the llama.cpp backend and calls out context-overflow vs malformed-request vs backend-failure, so the agent diagnoses instead of guessing
- **Tone** — "unrestricted" → "full local shell access"; emoji guidance tightened from "frequently" to "sparing, never as filler on technical answers"
- **Note:** this updates the source `config.json` in `ismini-linux/`; the live install at `~/ismini/config.json` is intentionally untouched until an explicit sync

## [16.1.0] - 2026-10-22

### ✨ New Features

#### Auto-update is now safe (drives install.sh)
- Rewrote `web.js` `/api/download-update`: instead of a raw `rsync`/`cp` over `~/ismini` (which bypassed all in-place safety and could leave a broken install), it now downloads the release zipball, stops only ismini's own server, **drives `install.sh`** (the same safe in-place path a manual reinstall uses), cleans up, and relaunches
- Relaxed the tag regex to accept `v13.0.2d`-style suffixes (the old strict `v#.#.#` rejected them → "Invalid tag"). `check-update`'s semver compare verified correct across real tags
- End-to-end test needed: push a `v16.1.0` release, run the Update button from an older install, confirm it upgrades and keeps user data

#### Window icons — accepted state (taskbar sharp, title bar bigger-but-soft)
- Final accepted outcome: **taskbar icon sharp**, **title-bar favicon bigger** (as wanted), title bar soft. tasos chose to keep this trade and move on — do NOT re-open as a bug
- `web/index.html` — favicon links reordered to **lead with 48px** (bigger) then 64/32, all crisp on disk; `?v=` bumped to 14 to bust the cache
- `ismini` launcher — `--app-icon=ismini-appicon.png` (crisp **PNG**) + **`--ozone-platform=x11`** (required for a crisp taskbar under Wayland; Chromium #522869961 / KDE #447845). Note: this x11 flag is what softens the title bar — a genuine trade-off, not an independent knob
- Old blurry favicon set backed up to `web/favicon-blurry.bak-20261023/`

#### ismini is now always fast — model thinking disabled by default
- ROOT CAUSE of the "slow / frozen" feel: the built-in `llama-server` (b11796) defaults `--reasoning` to `auto` (detect from template), which for a thinking-capable model means **thinking is ON** — the model emits a full invisible reasoning trace before its first visible token. ismini's per-request `enable_thinking:false` kwarg is ignored by this build (it gates thinking at the server level), so the model was silently reasoning every turn
- `llama-backend.js::_args()` now passes **`--reasoning off`** (valid flag for this build, verified via `--help`) — a server-level gate that works regardless of the model's chat template, so the model goes straight to the answer
- `config.json` — new `llamaCpp.reasoning: "off"` (default; no UI toggle — ismini is always fast). `install.sh` adds `reasoning:off` to existing installs that lack it (never overrides a user-set value)

#### In-place upgrades are now first-class
- Reinstalling ismini over an existing `~/ismini` is now explicitly supported and verified. `install.sh`:
  - **Stale-file cleanup** — before copying, removes app-owned code dirs that can change shape between versions (`llama-cpp/`, `node/`, `bin/`) plus any legacy `node-v*-linux-x64*` folders, then re-copies the exact set the new release ships. A renamed/removed `.so` lib or old Node build can't survive an upgrade and break the app
  - **User data preserved** — `config.json`, `sessions.json`, `memory.json`, and `models/` are still excluded from the copy, so chat history, memory, models, and settings survive the upgrade
  - **In-place upgrade notice** — if a prior install is detected, prints "↻ In-place upgrade complete" and confirms data was preserved
  - **Post-copy integrity check** — verifies `web.js`, `agent.js`, `llama-backend.js`, `ismini`, and `node/bin/node` exist; aborts with a clear re-run message if the copy is incomplete
  - **llama-server exec-bit** now handles the flat layout (`llama-cpp/llama-server`) as well as the older `bin/` layout, and no longer recreates a stray empty `llama-cpp/bin/`
- Verified with a dry in-place simulation (stale libs + an old `node-v22` folder + user data): data preserved, stale files gone, all core files present, no stray `bin/`. `bash -n` clean.

#### Context-length indicator in the top bar
- `web/index.html` — a compact chip (e.g. **`32k ctx`**, **`64k ctx`**, **`8k ctx`**) next to the model badge shows the loaded model's active context, with a hover tooltip explaining what context is and that it's sized to the machine + model. Formatting is **exact binary** (powers of two render precisely — 32768→"32k", 65536→"64k"), never a bogus rounded value. Shown when a model is ready, hidden when idle/error
- `web.js` — the `hello` SSE payload and `/state` now include `contextWindow` (the agent's real rolling-window budget, which tracks the server's true RAM-adaptive context), so the chip reflects the actual value on every box. Re-read after a model switch via a new `refreshContextChip()`
- `web/index.html` — the **Help & Shortcuts** modal gained a **`<N>k ctx`** row in the "Header buttons" section, explaining what context length is, that it's sized to the PC + model, and that ismini keeps the conversation inside the limit automatically

### ⚙️ Configuration

#### Context length is now RAM- + model-adaptive (replaces the fixed 32768)
- `16384` was too short for real agent work, but a hard-coded `32768` is a guess that's wrong for some machines. The context is now **measured**: `llama-backend.js::_resolveContext()` reads total RAM (`/proc/meminfo`) + the model file size, reserves ~40% of RAM for the KV-cache, estimates bytes-per-token by scaling with model size, and solves for `-c`. Clamped to **8192–65536**; a wrong guess fails **soft** (smaller context), never hard (OOM)
- `config.json` — `llamaCpp.context: 32768` is now a **ceiling** on the adaptive result (a deliberate pin), not a fixed value; `agent.maxTokens` stays 8192
- `web.js` — `detectLoadedModel()` now reports the backend's **real** `-c` (`backend.status().context`) instead of assuming the config value, so the agent's rolling window (`agent.contextWindow`) tracks the server's true context on **every** box — this closes the re-crash risk on low-RAM machines where the server got a smaller `-c`
- `llama-backend.js` — new `lastContext` field (the actual `-c` launched) exposed via `status().context`
- `install.sh` — the config merge still upgrades existing installs' `llamaCpp.context` up to the 32768 default (now the ceiling) without clobbering a higher user pin
- Verified live on a 62 GB box: 7B/14B models → 32768, 32B → 20480, no-ceiling 7B → 65536. All four files pass `node --check` / `bash -n`. A **server restart** is required for the new `-c` to take effect (KV cache is allocated at llama-server startup)

### 🐛 Bug Fixes

#### Fixed "ismini stops mid-conversation after several execs" (`exceeds the available context size` 400)
- A short chat with many `exec` calls could still overflow a small model's context (e.g. 16k) and make ismini look dead. ROOT CAUSE: `_enforceContextWindow` in `agent.js` walked turns newest→oldest and **stopped at the first turn that didn't fit** — so a single huge tool result (the old `MAX_TOOL_OUTPUT` was 200 KB ≈ 50k tokens) would make the window keep only that one giant turn, which was still over budget → 400 → agent stops
- `agent.js` — the rolling window now **skips** oversized turns and keeps evicting older ones (the user's latest question is always anchored in), so the request is **always under budget** no matter how big individual outputs are
- `agent.js` — new `maxSingleTok` (≈60% of budget) hard-caps any single message so one giant result can't force an overflow on its own
- `agent.js` — token estimate is now **conservative for tool results** (≤2.2 chars/token) so the budget is no longer under-counted
- `agent.js` — `MAX_TOOL_OUTPUT` lowered **200 KB → 48 KB** (still head 70% + tail 30%); 48 KB is far more than any realistic answer needs and keeps the window sane for a 16k model

## [16.0.0] - 2026-10-20

### ✨ New Features

#### 🧠 Recall — search all past sessions
- New **`recall`** tool: keyword-searches the **entire session archive** and returns the most relevant past messages (with date + session), so ismini can answer "what did we decide/do/say before?" and pull earlier context into the current chat
- `sessions.js` — added `search(query, limit)` (ranks by matched keywords, newest-first); `agent.js` — added `toolRecall` + tool definition + routing; `web.js`/`config.json` — enabled the `recall` tool (auto-merged into existing configs by `install.sh`)

#### Unlimited session archive + delete sessions
- `sessions.js` — removed the 4-session cap (now **unlimited**); every conversation is kept on disk so users can go back to any past session. Each session is still capped at 500 messages to keep the file healthy
- Added a `delete(id)` method to the session store (removes a session, and if it was the active one, moves the active pointer to the most recently used remaining session)
- `web.js` — new `POST /api/sessions/delete/:id` endpoint (404 for unknown ids; syncs the in-memory agent to the new active session after deleting the active one)
- `index.html` — a **✕ delete button** on every entry in the **Sessions** dropdown, plus a **"🗑 Clear all sessions"** button at the bottom (both with confirm dialogs); the chat view refreshes to the now-active session after a delete
- `sessions.js` + `web.js` — added `deleteAll()` and `POST /api/sessions/delete-all` (clears every session, resets the active pointer; a fresh session is created automatically on the next message)

### 🐛 Bug Fixes

#### Rolling context window (no more "exceeds the available context size")
- Long conversations with large web-search/file results could push the prompt past a small model's context window (e.g. 16k), causing `400 exceeds the available context size` errors and making the model act confused
- `agent.js` — rewrote `_enforceContextWindow` as a true **rolling window**: it keeps the **most recent turns** that fit in a safe token budget (context minus the reply reserve), so the prompt always fits. It groups an assistant tool-call with its tool results so they're **never split** (which would be an invalid sequence), always keeps your latest question, and works in token estimates (chars/token by model family, ~4k per image)
- Removed a redundant second trim in `_callLM` so there's now exactly **one** consistent context manager

#### Sharp taskbar icon (KDE/Wayland)
- The ismini app-window (browser `--app`/PWA mode) showed a **soft/blurry icon** in the KDE taskbar on Wayland, while the same site was crisp in a normal browser tab. Root cause: a Chromium/Edge bug where `--app` windows render the window/taskbar icon incorrectly **under Wayland** (Chromium [#522869961](https://issues.chromium.org/issues/522869961), KDE [#447845](https://bugs.kde.org/show_bug.cgi?id=447845))
- **Fix:** the launcher (`ismini`) now starts the app window with `--ozone-platform=x11` (the documented upstream workaround), applied **only when an X display exists** (i.e. XWayland is available), so it is a safe no-op elsewhere and stays cross-distro
- Added a dedicated crisp **128×128** window icon (`ismini-appicon.png`, head intact) passed via `--app-icon`
- `install.sh` — hicolor theme icons are now generated **crisp** (fit-to-square with padding, Lanczos anti-aliasing — the previous `-resize` without `!` produced a tiny statue in a large transparent box at small sizes); the desktop entry keeps the full, nicely-sized icon
- `web/index.html` — sensible crisp favicon set (512/192/64/32)

#### Crisp title-bar icon (and sharper taskbar icon)
- The **title-bar** icon (top-left of the app window) was **blurry**. Deep diagnosis (reading the live window's `_NET_WM_ICON`, testing with an unmistakable green `--app-icon`, fresh browser profiles, and pixel-level favicon checks) showed the title bar is a **16×16 `_NET_WM_ICON`** built from a **padded** favicon (statue as a small blob in a transparent box). The old `web/favicon-*.png` set was the *padded* version — a different, blurry source than the crisp master/appicon
- **Fix (icon sources):** regenerated the **entire favicon set** (`favicon-16/32/48/64/180/192/256/512`, `favicon.ico`, and `web/icons/*`) from the crisp **fill-the-square** source so the 16×16 Chromium embeds is sharp (statue fills the frame, **head fully intact**). Also regenerated `ismini-appicon.png` as a crisp **256×256 fill** icon (master is 642×655, so a center fill-crop trims a negligible sliver — head stays intact)
- **Fix (serving):** `web.js` now serves `favicon-16.png` (added `16` to the favicon route) and a new **`/favicon.ico`** route with `no-cache`, so a regenerated icon is picked up immediately instead of a stale padded one from the browser profile
- **Fix (hicolor):** `install.sh` generates the hicolor-theme icon sizes from the crisp `ismini-appicon.png` (fallback: master)
- **Why earlier attempts "didn't work" (important):** on KDE, **KWin caches each window's decoration icon by its class (`--class=ismini`)** and re-serves the old blurry bitmap even after the files on disk are fixed. The icon files are now all verified crisp; if the title bar still looks soft, **restart the Plasma shell** (`kquitapp5 plasmashell && kstart5 plasmashell`) or **log out/in** to clear KWin's icon cache, then relaunch
- The launcher (`ismini`) is **unchanged**; `--app-icon` + `--ozone-platform=x11` are untouched, so the original KDE/Wayland taskbar fix is preserved. Old padded icons backed up as `web/favicon-padded.bak-20261021/` and `ismini-appicon.png.bak-20261021` (source + test copy)

#### No more "Model API error 500: No user query found in messages"
- A multi-tool turn could end with a 500 from llama.cpp's Jinja chat template ("No user query found in messages") and then ismini would act as if it had lost the search results ("No specific search was requested"). Two hidden **`role:'user'`** system notes (the exec reminder + the tool-failure note) were never stripped (only `role:'system'` notes are), so they sat at the end of the message array; the rolling context window then kept that hidden note while **evicting the real user question**, and the template saw no valid user query
- **Fix (`agent.js`):** the exec reminder and tool-failure note are now `role:'system'` + `internal` (stripped at the start of the next turn, like the others); the rolling window now **always anchors the last real user turn** in the kept set so the question is never evicted; and `_callLM` has a safety net that nudges a `user` role in if the last non-system message would otherwise be non-user, so the model never 500s on this

#### No more duplicated final answer (double model bubble)
- When ismini was forced to a final answer after several tool calls, the reply appeared **twice** in the chat. The forced-final path streamed tokens to the UI (building a live bubble) **and** broadcast a `model` event, which rendered the same text a second time
- **Fix (`agent.js`):** the forced-final-answer path now skips the `model` broadcast when tokens were already streamed (`if (!finalStreamedContent.trim())`), matching the guard the normal final-answer path already had

#### Missing-argument tool errors no longer count as tool failures
- Calling a tool with a missing required arg (e.g. `web_search` with no `query`) returns `Error: "query" required.` — the **model's** mistake, not the tool's. It was being counted toward the tool-fail streak, which could trigger a confusing "this tool has failed 3 times" note for the model's own bad args
- **Fix (`agent.js`):** `isToolError()` now excludes `Error: "<arg>" required` messages from the fail streak

### 📝 Notes
- Bumped version `15.1.0` → `16.0.0` — a milestone release covering the Model Manager size/description + batch enrichment, the Help & Shortcuts modal, clean model names, auto-sizing chat input, the turn-timing leak fix, and the sharp KDE/Wayland taskbar icon

## [15.1.0] - 2026-10-19

### ✨ New Features

#### ❓ Help & Shortcuts modal
- New **❓ Help** button in the header opens a modal documenting every ismini feature and keyboard shortcut
- Sections: **Chat**, **Header buttons**, **Message-box buttons**, **What ismini can do**, and **Uninstall**
- Documents the `Enter` / `Shift + Enter` / `Escape` shortcuts, on-the-fly model switching, LM Studio auto-detection, and the `./uninstall.sh` data-loss warning
- Reuses the Model Manager's design tokens so it matches all three themes (Papyrus, Stars, Marble)
- Closes via the ✕ button, backdrop click, or `Escape`

### 🐛 Bug Fixes

#### Turn timing no longer leaks into the UI or TTS
- `web.js` — the stdout interceptor filter used a broken **character class** regex (`/^[(turn|data|ismini)]/`) that only blocked single letters, so `[turn] ok in 5.3s` was broadcast to the chat and read aloud
- Replaced with a proper alternation `/^\[?(turn|data|ismini)\]/` — the `[turn]` timing line (and `[turn] FAILED:` error logs) are now suppressed from the UI while real AI output (e.g. "turnaround", "turns") is untouched

#### Model Manager now shows size + description for every model
- `web.js` — HuggingFace API calls now use `?blobs=true`; without it the `size` field was always `0`, so no file sizes were displayed
- Added a new `GET /api/huggingface/models-batch` endpoint that enriches a list of models (description, recommended GGUF size, total size, params) in one parallel request instead of N round-trips
- `index.html` — the model list auto-enriches the top 30 rows with size + description snippets on load (fire-and-forget, with stale-response token guarding)
- Fixed a bug where clicking a top-30 model froze the details panel: batch data was polluting `mmCache`, so `selectModel()` early-returned and rendered a partial object. `mmCache` now holds only full detail responses; batch data lives in a separate `mmEnrich` cache
- Added a token guard to `selectModel()` so clicking a different model mid-load no longer lets a stale response overwrite the panel
- Description extraction hardened: strips HTML/markdown and rejects CSS fragments, `**bold:**`-only lines, pipe-separated metadata, tables, and badge spam — so real prose is shown

#### Clean model names in the switcher dropdown
- `web.js` — removed the `[lm-studio-old]` / `[lm-studio]` location prefix from model display names
- Stripped trailing quantization tags (`-Q4_K_M`, `_q8_0`, `.q8_0`, `-Q5_0`, `-qat-q4_0`, …) and the `.gguf` extension from display names, leaving just the model name (e.g. `Qwen3-Coder-Next`)
- Fixed duplicate entries: the loaded model previously appeared twice (once from the local scan, once from the llama-server list). Deduplication now matches by filename, and the loaded model's name is cleaned the same way
- The model `id` is unchanged, so switching still resolves to the correct file

#### Auto-sizing chat input
- `index.html` — the message box now grows line-by-line as you type (up to 160px, then scrolls). The existing `autosize()` helper was already called after file/voice/send actions but not on each keystroke; it is now wired to the `input` event, fixing the issue where a second line of text was hidden

### 📝 Notes
- Bumped version `15.0.1` → `15.1.0`
- All changes are pure built-in Node.js modules + vanilla JS/CSS — no new dependencies

## [15.0.1] - 2026-10-18

### 🔧 Critical Fixes (Code Integrity Audit)

This release addresses widespread token-level corruption introduced during prior editing sessions. Every source file was audited and repaired.

#### `web.js`
- Fixed all malformed arrow functions (`() = >` → `() =>`) across 30+ route registrations
- Verified `/transcript` endpoint exists and returns correct session data
- Verified `resolveDataDir()` is defined before `DATA_DIR` assignment
- Confirmed `100dvh` CSS injection for mobile taskbar compatibility

#### `agent.js`
- Repaired 30+ corrupted tokens throughout the file:
  - Arrow functions: `= >` → `=>` in `emitRaw`, `filter`, `Promise`, spawn callbacks
  - Logical operators: `& &` → `&&` in conditionals and stderr checks
  - Spaced identifiers: `fix ed` → `fixed`, `b lankRun` → `blankRun`, `args.new Text` → `args.newText`
  - Broken string literals: `'utf 8'` → `'utf8'`, `'wri te'` → `'write'`, `'u rl'` → `'url'`, `'s tring'` → `'string'`
  - Corrupted regex patterns in `DANGEROUS_PATTERNS` array restored to valid syntax
- All tool definitions in `_callLM` now have clean parameter names matching `TOOL_MAP` keys

#### `llama-backend.js`
- Fixed `listModels()` method — was completely broken due to corrupted `scanDir` inner function:
  - `(dir, basePath) = >` → `(dir, basePath) =>`
  - `e ntry.isDirectory()` → `entry.isDirectory()`
  - `contin ue` → `continue`
  - All `& &` → `&&` in directory/file/split-file conditions
- Model discovery now works correctly at startup

#### `live-tts.js`
- Added missing module-level exports required by the browser-native TTS system:
  - `speakText(text, options?)` — Uses Web Speech API with rate/pitch/voice support
  - `stopSpeaking()` — Calls `speechSynthesis.cancel()`
- Existing `createLiveResponseTracker` preserved unchanged

#### `index.html`
- Merged duplicate `body` CSS rules into a single block (was split across two selectors)
- Fixed version placeholder: `__ISMINI_VERSION__` → `ISMINI_VERSION` to match `web.js` replace pattern exactly

#### `config.json`
- Removed trailing spaces from **all** JSON keys and values
- Restored correct system prompt loading (was falling back to generic `"You are a helpful assistant."`)
- Restored correct context window (16384 instead of fallback 131072)
- All tool names in `enabled` array cleaned to match `TOOL_MAP` keys

#### `package.json`
- Removed trailing spaces from all keys and values
- Fixed `"type": "module"` recognition (was `"type ": "module "` — prevented all ES module imports)
- Fixed version string (was `"15.0.0 "` with trailing space — broke semver comparison in update checker)

#### `ismini.sh` (launcher)
- Fixed `LOG_DIR` from `$HOME/.ismini` → `$HOME/ismini` to align with actual data directory used by all other modules
- PID file and server logs now written to the correct location

#### `uninstall.sh`
- Fixed `DATA_DIR` from `$HOME/.ismini` → `$HOME/ismini`
- PID file lookup now finds the correct file for clean process shutdown
- Removed redundant `rm -rf "$DATA_DIR"` step (now identical to `$APP`)

### ✅ Verified Clean (No Changes Needed)
- `sessions.js` — Atomic saves, corruption recovery, message capping all correct
- `memory.js` — Non-blocking search, eviction, atomic saves all correct
- `image-input.js` — Strict validation, round-trip integrity, legacy cleanup all correct
- `install.sh` — Config merge, desktop entries, Node version check all correct

### 📝 Documentation
- Updated `README.md` with current version and cleaned formatting
- Created `CHANGELOG.md` with full audit record