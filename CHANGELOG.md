# Changelog

All notable changes to ismini are documented in this file.

## [21.0.0] - 2026-11-18

**Long tasks stay alive, and the whole app got a full hardening pass.** This release
promotes everything built since v20.0.0 — the "ismini stops answering on long tasks"
fix (step budget, context-window math, two-phase watchdog, forced final answer),
twenty rounds of independent line-by-line review across every layer (agent loop,
server, model backend, tools, memory, sessions, UI, installer, uninstallers,
launcher, icons) — into a single stable release.

The headline behavior changes for users:

- **Long multi-file jobs (like a full codebase audit) always end with a real answer**
  instead of going silent. The step budget was raised (20 → 60), the context window no
  longer starves history, oversized tool results are shrunk to header-keeping stubs
  instead of dropped, and every exit path (step limit, repeat-action loop, empty reply,
  watchdog timeout) forces a final summary — ismini never ends a turn with nothing.
- **The re-read loop is fixed at the root.** Tool results carry `[read …]` / `[exec …]`
  headers in context; exact token counting via llama-server's `/tokenize`; the
  per-request send budget (`effectiveContextWindow`, default 32k) keeps prompts small
  and fast; a scratchpad/batch-notes strategy in the system prompt handles jobs bigger
  than any window.
- **Default context length raised 8k → 32k** so real work fits out of the box (low-RAM
  boxes lower it via the `ctx` chip).
- **No more "engine stopped" silences.** The llama.cpp backend layer was hardened end to
  end: spawn errors are caught and surfaced, model switches no longer orphan the old
  server, failed starts report WHY (exit code + last log lines) instead of waiting 90s,
  an OOM'd model is no longer persisted as the default, and logs rotate.
- **Security hardening.** SSRF guards now re-validate on every redirect hop in BOTH web
  fetch and web search; sudo is opt-in per command (never default-on); a real XSS hole
  in the Model Manager was closed (this app has a shell — that mattered); malformed
  tool-call JSON is surfaced to the model instead of silently running with empty args.
- **Data integrity.** Memory and sessions no longer report success on failed saves;
  eviction is true LRU; deleting all/last session always leaves a live one; a 2 MB
  per-session byte cap keeps `sessions.json` from stalling the event loop; corrupt
  files are salvaged per-entry instead of wiping everything.
- **Installer / uninstaller / launcher rebuilt.** The installer verifies source
  integrity BEFORE deleting anything (a failed tar can no longer destroy a working
  install), merges config on upgrade instead of wiping your tuning, and excludes user
  state from its tar. Both uninstallers got the same process-kill fixes (numeric PID +
  ownership check, TERM→poll→KILL, exact-argv matching) and a real success check; the
  full uninstaller honors `ISMINI_HOME`. The launcher no longer reports "ready" before
  the port is bound, and handles Wayland-only sessions.
- **Icon fix (Round 20).** All favicons regenerated from one square 512 master with the
  verified recipe; dedicated browser profile + cache busting so the title-bar icon is
  actually crisp. The uninstall scripts' fatal `${#1[@]}` syntax error (confirmation OK →
  silent death, nothing deleted) is fixed.
- **Icon files slimmed to exactly two (like Nio).** `web/` now carries just
  `favicon.ico` (multi-resolution, title bar / window icon) and `ismini-avatar.png`
  (in-app avatar + apple-touch-icon). Deleted: the ten per-size `favicon-*.png` files,
  the `favicon-backup-v15/` backup folder, the abandoned `1.jpeg` "I" logo, the
  PWA `manifest.webmanifest` + `web/icons/` (dead — no install-to-desktop flow), and
  their now-unused routes in `web.js`. The installer renders hicolor theme sizes from
  the single square master (`ismini.png`) via ImageMagick instead of copying shipped
  per-size PNGs.

The full round-by-round detail lives in the `## [20.1.0]` section below — it was never
published on its own; v21.0.0 ships all of it.

## [20.1.0] - 2026-11-15

**Long tasks no longer stop ismini mid-work.** A big multi-file job (like a full
codebase audit) could push ismini past her per-request step limit, after which she
would go **silent** — no answer, and the session saved with no reply. You'd only see
her "come back to life" when you sent another message, and she'd stop again on the
next budget. Fixed at the root so a long task always ends with a real answer.

> ### 🐛 Regression fix (2026-11-16): the deep-dive audit was still failing — and one of our own fixes made it worse
> After the v20.1.0 loop/watchdog/silence fixes, the full-folder audit **still** failed, and
> the `effectiveContextWindow` cap we added actually made it fail **sooner** (~5 reads + 2 execs,
> then "empty response" + step-limit fallback). A line-by-line re-audit (cross-checked against an
> independent review of the real source) found **two root-cause bugs in our own code**, plus the
> cap was the wrong lever. All fixed now:
>
> - **The repeat-action guard was firing on DIFFERENT files (the "crashed too soon" cause).**
>   `run()` read `tc.parsedArgs` — a field that is **always undefined** (`parseToolCalls()` returns
>   `.args`). So every stored tool-call had `arguments: "{}"`, and the loop-guard's signature was
>   `read:{}` for *every* read — meaning reading 3 **different** files looked like the same action
>   3× in a row and force-stopped the audit. The model also literally could not see *which* file it
>   had already read (the call's args were blank), re-opening the re-read loop. **Fix:** use `tc.args`
>   in both the stored `tool_calls` and the action signature. Verified: 3 different reads no longer
>   trip the guard; the same file 3× still does.
> - **The empty-response retry was dead code.** In streaming mode `_streamResponse` *throws* on an
>   empty reply, so `response = await callOnce()` never completed and the "retry" branch below it was
>   unreachable — the throw jumped straight out of `run()`, no assistant message was pushed, and the
>   session saved empty (the "stops for good until I nudge her" symptom). The mitigation we thought we'd
>   shipped was never actually running. **Fix:** catch that specific throw, retry **once with the same
>   window** (shrinking it further only starves the model of the file content the task needs), then force
>   a real final answer if still empty. Real API errors are never retried. Verified by driving the real
>   `Agent.run()` with a stubbed `_callLM`: empty → retry → answer, recovered in 2 calls.
> - **The hidden 32k send cap starved the model.** The old default `min(contextWindow, 32768)` made the
>   per-result cap (~14k tokens) *smaller* than one big file read (~22k), so even the **newest** read was
>   instantly stubbed to a 600-char tail — the model never saw a full file. **Fix:** no hidden cap anymore;
>   the send budget is the configured context (keep it in sync with llama-server's `-c` via the ctx chip),
>   optionally lowered *only* by an explicit `agent.effectiveContextWindow` for slow hardware. The per-result
>   cap was also raised (0.6 → 0.8 of budget) and a **protect-the-newest** pass stubs *older* results (keeping
>   their `[read …]` headers) so the file being actively audited stays whole whenever it fits the context.
>   At a 32k default a single 49 KB file still can't fit whole — that's expected and is why the scratchpad
>   pattern below exists; raise the ctx chip (e.g. to 128k) and the newest file stays full.
> - **Stubs no longer invite re-read loops.** The old stub text said "re-run this action if you need the full
>   result" — actively inviting the loop it was meant to prevent — and cut mid-line, which could leave a half
>   JSON line the model tried to "fix." Now one shared builder cuts at a **line boundary** and says the action
>   **ALREADY COMPLETED** (prefer your notes; re-read only if you truly need it).
> - **Silent-tool-turn limit 3 → configurable (default 8).** Batch audits legitimately make many silent reads;
>   the old hard limit of 3 force-stopped real jobs. True loops are caught by the repeat-action guard (now with
>   real args). Set `agent.maxSilentToolTurns` to tune.
> - **Scratchpad / batch strategy for many-file tasks (system-prompt.md).** The real architectural fix: a 20-file
>   audit is ~440k tokens — no context window holds it all. ismini is now instructed to work in batches (read 1–2
>   files → append findings to a notes file → move on) and build the final report from the notes, so big jobs
>   always fit instead of overflowing.
>
> **Verified:** `node --check` clean on agent.js + web.js; config.json parses. Simulation of the real failing
> audit (8 × 49 KB reads): at 32k the newest file is protected and older ones stub with headers; at 128k the
> newest + 2 recent files stay whole. Repeat-guard, history-args, and empty-retry all unit-verified against the
> real `Agent` class.
>
> ### 🐛 Round-2 hardening (2026-11-16): "make it perfect, not just patched"
> A second independent line-by-line review (cross-checked against the **real** round-1 source) found that
> round 1 was correct but left real gaps — including **one new overflow vector that round 1 itself created**.
> All fixed surgically in `agent.js` (+ one `web.js`-facing schema change). No publish until tasos says go.
>
> - **Tool-call arguments were never counted toward the context budget (the round-1 bug).** Round 1 made
>   history store REAL tool-call args (`tc.args`) so the model could see what it had done — but the token
>   estimator only counted `content`, so a 30 KB `write` payload was budgeted as ~4 tokens and could silently
>   overflow the context. **Fix:** the estimator now counts `tool_calls` args too.
> - **Exact token counting via llama-server's built-in `POST /tokenize`.** The old chars/rate heuristic
>   over-counts normal code ~50% (wasting half the window → premature stubbing) and under-counts base64/CJK
>   (overflow). ismini now primes a per-message exact-token cache from the server's `/tokenize` endpoint
>   (zero new dependencies; confirmed present in the bundled build) and falls back to the heuristic if it's
>   unavailable. `_enforceContextWindow` is now async for this.
> - **sudo is now opt-in per command.** The old default-on (`args.sudo === true || !('sudo' in args)`) ran
>   *every* command as root whenever the toggle was on — `ls`, a typo'd `rm`, all with full privileges. Now
>   the model must explicitly pass `sudo:true` (the tool schema says so; the sudo-password hint already teaches
>   it to retry elevated). Non-root exec is unchanged.
> - **Correct quoting for the sudo wrapper.** `JSON.stringify` does not escape `$`/backticks, which the outer
>   `sh -c` would expand before sudo saw them. Now POSIX single-quote escaping (`'…'\''…'`).
> - **Malformed tool-call JSON is surfaced, not swallowed.** A bad `arguments` blob used to become `{}` and run
>   the tool with no path/command (wasted turn + confusing error). Now the model gets a clear "re-issue with
>   valid JSON" result instead.
> - **Sampling pinned for determinism** (Qwen3 non-thinking: temp 0.7, top_p 0.8, top_k 20, min_p 0;
>   presence_penalty stays 0 so tool-call JSON isn't penalized).
> - **Oversized user pastes spill to a file.** A pasted file that alone exceeds the context budget used to
>   overflow the request; now it's saved to `.ismini-paste-*.txt` and the prompt keeps a short head + pointer
>   (matches the scratchpad pattern).
> - **Monotonic stubbing for KV-prefix stability.** Once a tool result is stubbed it keeps the *same* stub every
>   turn, so a message that would un-stub when budget frees up no longer rewrites the prompt prefix and forces
>   llama.cpp to re-evaluate a 60k prompt from scratch.
> - **`collectProcessTree` is now a single `/proc` pass** (was O(levels × nproc) on the kill path).
> - **Repeat-action guard resets at the start of every run** — a "continue" that legitimately repeated the
>   previous run's last action no longer trips the 3× force-stop.
> - **Watchdog settle guard made explicit** (`if (settled) return;`); dead code removed (`fileURLToPath`/
>   `__dirname`, `_consecutiveToolTurns`, unused `replaced`).
>
> **Verified:** `node --check` clean on agent.js + web.js. `/tokenize` route + format confirmed against the
> llama.cpp server README (root path, `{content}` → `{tokens:[…]}`). All edits are surgical on the real source.
>
> ### ⚙️ UX: no permission prompts for sudo (when ON) or profile saves (2026-11-16)
> tasos wanted two confirmation behaviors gone:
> - **sudo:** ismini should NOT ask when the sudo toggle is **ON** — only when it's **OFF**. The code already
>   never prompted for exec with sudo ON (`isPrivilegedTool && !this.allowSudo`); the asking was coming from the
>   system prompt's Safety rule, which listed "sudo" as a wait-for-go-ahead action. **Fix:** removed sudo from that
>   rule and added an explicit "if the toggle is on, just run it — do not ask." (agent.js confirm gate unchanged;
>   `system-prompt.md` only.)
> - **memory / profile:** ismini was asking permission to record personal facts because she writes them to
>   `memory.md` via the **edit/write tool, which is confirm-gated**. (`memory_add` itself never prompted.) **Fix:**
>   updating ismini's OWN profile — a write/edit whose resolved path is exactly the install-folder `memory.md`
>   (canonical-path compared) — now bypasses the confirmation gate, so she saves personal facts silently. Any
>   other file still confirms. The system prompt was also updated to tell her to save profile facts silently.
>
> **Verified:** `node --check` clean on agent.js + web.js. Profile detection is scoped to the app's own
> `memory.md` only (a same-named file elsewhere still confirms).
>
> ### 🌐 Round-3: `web.js` hardening (2026-11-16) — the server layer that could defeat the fixed agent
> Rounds 1–2 fixed `agent.js`; a third independent review of the **real** `web.js` found several bugs in the
> *server* layer that could still break a long audit even with a correct agent. Each claim was verified against
> the actual source (the reviewer's pastes are character-corrupted, so nothing was applied verbatim). All fixed
> surgically in `web.js` (+ one 2-line change to `agent.js`). No publish until tasos says go.
>
> - **Context budget now comes from the RUNNING server, not a stale config value (critical).**
>   `detectLoadedModel()` read `config.llamaCpp.context`, so if the config said 32768 while llama-server
>   actually ran with a different `-c` (e.g. raised to 128k via the ctx chip before a restart), the agent budgeted
>   for the wrong window and starved or overflowed every file read. Now it reads `backend.status().context`
>   (the real `-c` llama-server launched with) and falls back to config only if that's unavailable.
> - **Vision detection actually wired (was dead).** The same function hardcoded `vision: null`, so
>   `agent.supportsVision` was always unknown. Now it reflects whether llama-server was started with an mmproj
>   (`status().mmproj`) — true when vision is on, neutral otherwise.
> - **Self-defending send-budget cap.** `applyLoadedModel` now clears an explicit
>   `agent.effectiveContextWindow` if it is ≥ the real context (a cap that can't be lower than the window is
>   pointless and would pin the budget to a stale value). A cap *below* ctx for slow hardware still wins.
> - **`/send` no longer wedges `busy` on an early throw (high).** An oversized paste (413) or a malformed image
>   could throw *after* `busy = true` but before the turn's own cleanup, leaving every later message stuck at
>   "agent busy" until restart. Both calls are now wrapped so `busy` is always reset on failure.
> - **A tab reload / SSE blip no longer kills a running turn (high).** The `/events` close handler aborted any
>   in-flight turn the moment *one* client disconnected — exactly what was cutting off long audits. Now it only
>   aborts if **no** clients remain after a 3-second grace period; `scheduleShutdown` still handles the genuine exit.
> - **Day-aware greeting note now reaches the model (was dead code).** The note was pushed as an internal system
>   message *before* `run()`, but `run()`'s first line strips all internal system messages — so the model never
>   saw it. It's now passed into `run(userMessage, internalNote)`, which pushes it after the filter (this turn only).
> - **Pause no longer hangs on a pending confirmation (medium).** `/pause` now settles any open confirmation
>   immediately instead of waiting up to the 2-minute timeout; the confirm timer is stored and cleared so it can't linger.
> - **Model download: HF token + correct file filter + per-segment URL encoding (medium).** The download used a bare
>   `User-Agent` header (gated repos 401 even with a saved token), listed mmproj/imatrix/sharded files as downloadable,
>   and encoded the whole path (`/` → `%2F`, breaking nested files). Now it sends `hfHeaders()`, filters to real
>   single-file GGUF weights, and encodes each path segment separately.
> - **Updater temp-dir leak + silent early failures (low).** `tempDir` was declared inside the `else` block but
>   referenced in cleanup → a swallowed `ReferenceError` meant the temp dir was never removed; `updateProgress` was
>   defined inside the `try`, so an early failure's "failed" progress never reached the page. Both are hoisted.
> - **Polish / dead code.** `todayStr()` now uses the local calendar day (the once-per-day greeting reset at 02:00 in
>   Greece, not midnight); removed unused `LLAMA_PORT`/`LLAMA_BASE` and the `execSync` import; de-duplicated repeated
>   alternatives in the greeting regex.
>
> **Verified:** `node --check` clean on web.js + agent.js. `config.json` confirmed to carry no stale
> `agent.effectiveContextWindow`. All edits surgical on the real source.
>
> ### 📝 Round-4: `system-prompt.md` consistency + a real `append` tool (2026-11-16)
> A fourth independent review of **`system-prompt.md`** found that several instructions *contradicted the
> code* — and, more importantly, that the batch-audit strategy had **no working append path**. The reviewer was
> looking at a pre-round-2 version of the prompt, so ~half his points were already fixed; each remaining claim
> was verified against the real source before changing anything. Fixes in `system-prompt.md` + small `agent.js`
> changes. No publish until tasos says go.
>
> - **The notes file had no append path (critical — defeated the whole batch-audit design).** The prompt told
>   ismini to "append findings to a notes file," but `toolWrite` only did `writeFileSync` (**truncate**) and the
>   schema had no `append`. So every batch's write *destroyed* the previous findings. **Fix:** added a real
>   `append: true` mode to the `write` tool (`appendFileSync`) + documented it in the schema and prompt. Verified:
>   two writes (overwrite then append) preserve both batches.
> - **"Re-reading is always wrong" contradicted the elision reality (critical).** The absolute NEVER forced the
>   model to *guess* file contents once a result was stubbed to `[read …]`. Now conditional: don't repeat when the
>   full result is still visible; re-read freely once it's been elided. Never reconstruct from memory.
> - **"Act on ALL of them in that same message" → batched.** For many files/large outputs, defer to the one-or-two
>   batches pattern instead of firing 20 reads at once (the overflow trigger).
> - **`recall` pointed at the wrong tool mid-task.** It searches *past* sessions only; the prompt told the model to
>   "proactively use recall" when losing track during a long current task. Now: re-read your notes file, not recall.
> - **Filler-text rule resolved (the "let me begin…" loop).** "Include a brief text response alongside" + "do NOT
>   announce" were mutually exclusive and produced generic filler. Now: tool calls may carry no text; speak only on
>   a result or a genuine question.
> - **Greeting section made note-driven.** Added an explicit first line: follow the server's per-day greeting note;
>   if already greeted (or no note) → one warm sentence, ZERO tool calls. (The round-3 fix that delivers the note
>   into `run()` is what makes this reachable.)
> - **sudo guidance corrected.** The old "if the toggle is on, just run it" line was wrong after sudo became opt-in
>   per call. Now: normal user by default; pass `sudo:true` only when root is genuinely needed; confirmation is expected.
> - **Profile refreshes without a restart (was stale).** The profile was captured once in the constructor, so a
>   silent mid-session save to memory.md wasn't seen until restart. Added `setUserProfile()` + an `onProfileChanged`
>   hook: web.js re-reads the profile after ismini writes its own memory.md.
> - **Honest scope + docs.** "Full local shell and file access" → accurate (home+workspace, some paths/commands
>   blocked by design); documented `read`'s ~48 KB / 10k-line cap with an exec-paging hint; "parallel" → "batched in
>   one turn"; bounded Error Recovery to 1–2 diagnostic calls; `memory_add` description now says project/transient
>   notes only (identity facts go to memory.md).
>
> **Verified:** `node --check` clean on web.js + agent.js. Append path functionally tested (overwrite → append keeps
> both batches). All edits surgical on the real source.
>
> ### 🔧 Round-5: `llama-backend.js` hardening (2026-11-16) — why the engine silently stops
> A fifth independent review of **`llama-backend.js`** (the layer that spawns and owns the bundled
> llama-server) found several bugs in how ismini launches, watches, and recovers from its own model process.
> These are the root cause of the recurring "The engine stopped" / silent-failure symptoms. Each claim was
> verified against the **real** source *and* by probing the bundled binary's `--help` before changing anything
> (the reviewer's pastes are character-corrupted, so nothing was applied verbatim). No publish until tasos says go.
>
> - **A missing/failed binary could kill the whole server.** The spawned child had no `'error'` handler, so an
>   `ENOENT` (bad path to `llama-server`) threw an unhandled event and took down node. Now caught; the reason is
>   stored in `_lastError` and surfaced to the UI.
> - **A model switch could orphan the old server.** On a switch, the OLD child's `'exit'` fires *after* the NEW
>   child is assigned; the handler nulled `this.child` unconditionally → dropped the new server and left an orphaned
>   llama-server holding the model in VRAM. Now identity-checked (`if (this.child === child)`).
> - **Two streams into one log with `end:true` could throw + leak a fd.** When stdout ended, the default pipe called
>   `log.end()`; a later stderr write then threw `ERR_STREAM_WRITE_AFTER_END` on an fs WriteStream with no `'error'`
>   listener. Both pipes now use `{ end: false }` and the stream is closed once on `'close'`.
> - **A failed start waited 90s for nothing, then said only "stopped."** `_waitReady` polled `/health` the full 90s
>   even after the child had already died. Now it bails out immediately when `exitCode !== null`. On failure the state
>   now carries a real `error` (spawn error → exit code/signal → last 40 lines of llama.log) so the user sees WHY.
> - **A model that OOMs became the persisted default.** The model was written to `llama-state.json` *before* it was
>   proven loadable, so a failing model was retried on every launch. Persistence now happens only after `_waitReady`
>   succeeds.
> - **`status()` did a full recursive FS walk on every `/api/backend` poll.** `listModels()` is now cached for 5s;
>   pass `force=true` to bypass (done after a download and a successful start so new models appear immediately).
> - **Per-slot context math.** `lastContext = floor(ctx / parallel)` so web.js sizes the agent window to what each
>   slot really has (equals `-c` at the default `-np 1`). The misleading "RAM-adaptive" comment was rewritten.
> - **`isRunning()` was wrong for a self-exited process.** Now `exitCode === null && !killed`.
> - **Log rotation.** llama.log rotates to `.old` at 10 MB (mirrors web.js's ismini.log) so it never grows unbounded.
> - **web.js: surface the reason + align the fallback.** The backend error is now broadcast (`error` field), logged,
>   shown in the frontend toast, and included in the `/send` 409 message. `detectLoadedModel()`'s no-server context
>   fallback changed 8192 → 32768 to match the backend's own default (the live path already reads the real `-c`).
>
> **Flagged, not applied (behavior change / needs tasos's box):** KV quantization (`--cache-type-k/v q8_0`) is
> supported by this build and is the real lever for 128k on limited RAM, but it changes model behavior — test before
> shipping. The `--alias` port-conflict check and mmproj auto-attach-without-family-match were also flagged rather
> than changed blindly. **Verified flags** via `llama-server --help`: `--reasoning`, `--flash-attn auto`, `--kv-unified`
> are all valid in the bundled build (so the existing launch args were left untouched).
>
> **Verified:** `node --check` clean on llama-backend.js + web.js. All edits surgical on the real source.
>
> ### 🌦️ Round-6: `tools/weather.js` hardening (2026-11-16) — turn-killing crash + wrong failures
> A sixth independent review of **`tools/weather.js`** (Open-Meteo, no API key) found one crash that can kill an
> entire turn and two correctness bugs. Each claim was verified against the real source before changing anything.
> The broader "prepare for public GitHub" / i18n / config-threading suggestions in that review were **out of scope**
> (publish prep + speculative settings) and are NOT applied. No publish until tasos says go.
>
> - **A non-string `location` killed the whole turn.** The old `(location || '').trim()` threw a `TypeError` if the
>   model emitted `{"location":123}` or an object, and neither `toolWeather` nor `_executeTool` had a try/catch — so
>   it propagated out of `run()` and died the turn. **Fix:** `String(location ?? '').trim()` in weather.js + a
>   try/catch in `toolWeather` (matching `toolRead`/`toolWebSearch`) so a bad arg becomes a tool error the model can
>   fix, not a crash.
> - **Network failures were blamed on the place name.** The geocode loop did `catch { /* try next */ }`, swallowing
>   timeouts/DNS/HTTP-429, so a down network produced "Could not find location: X — try a more specific name" and the
>   model rephrased forever. **Fix:** distinguish *empty result* (try the shorter candidate) from *error* (stop and
>   report `Weather geocoding failed: …`).
> - **`Math.round(null)` → "NaN°C"** and `latitude=undefined` → HTTP 400. Now validates `Number.isFinite(t)` on the
>   temperature and `Number.isFinite(lat/lon)` before building the query.
> - **Ambiguous names resolved to the wrong country.** `count:1` took the geocoder's single best guess and the fallback
>   threw away the disambiguating context ("Athens, Greece" → "Athens" → could be Athens, GA). **Fix:** request
>   `count:5` and score hits against the *full* original input (`pickBest`), with an exact-name short-circuit so
>   non-Latin input (東京 / Αθήνα) still resolves correctly.
> - **Unit read from the API** (`fc.current_units.temperature_2m`) instead of a hardcoded `°C`; dropped the unused
>   `timezone:'auto'` param.
> - **`isToolError`:** added `Weather data unavailable` so a real failure counts as a failure (it was counted as
>   success before).
>
> **Verified:** `node --check` clean on tools/weather.js + agent.js. All edits surgical on the real source.
>
> ### 🌐 Round-7: `tools/web-fetch.js` hardening (2026-11-16) — SSRF redirect bypass + turn-killing errors
> A seventh independent review of **`tools/web-fetch.js`** found one security bypass that defeats the SSRF guard and
> the same turn-killing error flaw as weather.js. Each claim was verified against the real source (the reviewer's paste
> was character-mangled, but the key regexes in the actual file were confirmed intact). No publish until tasos says go.
>
> - **Redirects bypassed the SSRF guard entirely (HIGH).** `assertPublicHost` ran once on the initial host, then
>   `redirect:'follow'` let a public page 302 → `http://127.0.0.1:8080` (ismini's own llama-server) or the cloud
>   metadata IP with no re-check. **Fix:** follow redirects manually (`redirect:'manual'`, max 5 hops) and re-run
>   `assertPublicHost` on *every* hop; a non-http protocol at any hop is rejected.
> - **Four paths threw instead of returning a tool error → the turn died.** URL-parse failure, non-http protocol, the
>   SSRF block, and DNS failure all happened *outside* the `.then().catch()`, and `toolWebFetch` had no try/catch (unlike
>   the other tools). **Fix:** wrap the whole `fetch()` body in try/catch returning a `Fetch error …` string, plus a
>   try/catch + object guard in `toolWebFetch`. These now count toward the tool-fail streak via the existing
>   `^Fetch error\b` pattern.
> - **Binary responses were fed to the model as mojibake.** No content-type gate — a PDF/ZIP returned 200 and ~20k chars
>   of garbage went into context. **Fix:** refuse non-text content types (allowing `octet-stream` through for mislabeled
>   HTML) with a hint to use `exec` + pdftotext/unzip.
> - **Uppercase `<SCRIPT>`/`<IFRAME>` leaked JS into context.** Tag matching in `stripNonContentBlocks` was
>   case-sensitive. **Fix:** match the tag name case-insensitively by comparing a small slice (not lowercasing the whole
>   string, which can change length for some Unicode) and find the closing tag with a case-insensitive regex.
> - **Dead code removed (zero behavior change).** Dropped the `const remaining0 = limit - 0` no-op (now uses `limit`
>   directly), renamed the confusing `net` alias to `rawFetch`, and the unreachable `isClosing` branch in the tag
>   stripper was already gone after the case-insensitive rewrite.
>
> **Flagged, NOT applied (lower risk / larger change):** IPv6 NAT64/Teredo/6to4 hardening in the SSRF guard (#6);
> DNS-rebinding TOCTOU — fully closing it needs pinning the validated IP at connect time via a custom `lookup` instead
> of global fetch (#7, follow-up); plus low/cleanup items (prototype-chain entity lookup, reserved IPv4 ranges, anchor
> href preservation, configurable UA/Accept-Language, dead code). All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on tools/web-fetch.js + agent.js. Case-insensitive tag stripping unit-tested
> (uppercase SCRIPT/IFRAME stripped, normal content preserved).
>
> ### 🔎 Round-8: `tools/web-search.js` hardening (2026-11-16) — unguarded fetch of search results + dead fallback
> An eighth independent review of **`tools/web-search.js`** found a worse SSRF hole than web-fetch.js (search-result URLs
> are fetched with no guard at all) and a fallback path that was dead by construction. Each claim was verified against the
> real source (the reviewer's paste was character-mangled; the key regexes in the actual file were confirmed intact).
> No publish until tasos says go.
>
> - **`fetchPageContent` bypassed the SSRF guard entirely (CRITICAL).** It used global `fetch` with `redirect:'follow'`
>   and never called `assertPublicHost`. Search-result URLs are attacker-influenceable (SEO poisoning), so a result pointing
>   at `http://127.0.0.1:8080` (ismini's own llama-server) or the cloud metadata IP was fetched unguarded, and a public
>   result could bounce into loopback via redirect. **Fix:** export `assertPublicHost` from web-fetch.js and add a shared
>   `safeGet()` that follows redirects manually (max 5 hops) re-validating the guard on *every* hop; `fetchPageContent`
>   now uses it.
> - **The DDG-HTML fallback regex was dead by construction.** It matched relative `/l/…` links, then rejected them because
>   they didn't start with `http` — so whenever the primary `result__a` regex missed (markup change), the fallback found
>   candidates and threw every one away → zero results, no error. **Fix:** resolve each candidate against the DDG base URL
>   (`new URL(u, base)`) *before* filtering, then accept any `http(s)` result.
>
> **Flagged, NOT applied (markup-coupling / speculative):** order-independent anchor parsing (#4 — rewrites the core parser
> to decouple from DuckDuckGo's HTML; a behavior change to something that works and can't be tested against live markup from
> here), bot-diagnosis accumulation across engines (#3), nav-boilerplate stripping + content-type gate in fetchPageContent
> (#5), ad/engine-internal URL filtering (#6); plus low/polish (aggregate deadline, locale, UA consistency, cache,
> pluggable provider/ToS). All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on tools/web-search.js + tools/web-fetch.js. SSRF guard unit-tested — 127.0.0.1,
> 169.254.169.254, 10.0.0.5, and localhost (→ ::1) all blocked.
>
> ### ⚙️ Round-9: `config.json` + `agent.js` — the unbudgeted system prompt (2026-11-16)
> A ninth independent review of **`config.json`** found a real overflow vector hiding in `agent.js` plus a dead config key.
> Each claim was verified against the real source. No publish until tasos says go.
>
> - **The system prompt + tool schemas were never counted toward the context budget (overflow bug, agent.js).**
>   `_callLM` injects `{ role:'system', content: this._fullSystemPrompt }` *after* budgeting, and `this.messages` never
>   holds the real system prompt — so in `_enforceContextWindow`, `sys = messages.find(m => m.role==='system')` was almost
>   always undefined and `sysTok = 0`. That left ~5k tokens of fixed overhead (system prompt + 13 tool schemas) unbudgeted,
>   so `system + tools + history + reserve` could exceed the context → 400s / silent context shifts. **Fix:** count
>   `this._fullSystemPrompt` (exact count via the `/tokenize` cache when available, heuristic otherwise) plus a 2200-token
>   tool-schema allowance into `sysTok`. Any internal system note still counts too.
> - **Dead key removed.** `"backend": "llama-cpp"` in config.json was read by nothing — removed.
>
> **Flagged, NOT applied (config-tuning / your call):** `maxTokens: 32768` equals the whole context, so the reply reserve
> (`min(maxTokens, ctx×0.4)`) eats the history budget — lowering it (e.g. 8192) frees room for audits, but that's tasos's
> tuning choice tied to his RAM/model. `timeoutSeconds: 3600` doubles as the per-command exec timeout (a hung `exec`
> blocks a turn for an hour) — fixing it needs a new `execTimeoutSeconds` setting. Raising context to 64k / `kvType q8_0`
> is the KV-quantization behavior change tasos already asked to leave alone. A startup config validator was also suggested
> (nice-to-have, not a bug). All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on agent.js; config.json parses and no longer carries `backend`.
>
> ### 🖼️ Round-10: `image-input.js` + `web.js` — the 25% image-limit bug + dead code (2026-11-16)
> A tenth independent review of **`image-input.js`** (and its callers in web.js / agent.js) confirmed the module's
> base64 validation is solid and found one real unit-mismatch bug plus a pile of dead code. Each claim was verified
> against the real source; two of the reviewer's "bugs" turned out to be already fixed in Round-3. No publish until
> tasos says go.
>
> - **The 4 MiB image limit was really ~3 MiB (unit mismatch, web.js).** `/send` re-checked `Buffer.byteLength(image.dataUrl)
>   > MAX_IMAGE_BYTES`, but `image.dataUrl` is the **base64 string** — a real 4 MiB image is ~5.59 M chars of base64,
>   so any image whose *decoded* size exceeded ~3 MiB was rejected as "exceeds 4 MiB". The check was also redundant:
>   `validateImageAttachment` already rejects decoded images over the limit in the correct units. **Fix:** deleted the
>   web.js check (and its now-unused `MAX_IMAGE_BYTES` import); real ~3–4 MiB images now work.
> - **Dead code removed.** `modelSupportsVision()` was unused everywhere (Round-3 already switched vision detection to
>   `status().mmproj` and dropped the import) — deleted. `removeLegacyVisionInstructions()` had a broken regex that never
>   matched anything, is called on every startup, and its target sentence no longer exists in system-prompt.md (replaced
>   on every upgrade) — deleted, along with its agent.js import and the now-misleading "clean up legacy vision
>   instructions" comment.
>
> **Already fixed in Round-3 (reviewer's #1/#3, re-verified):** the `/send` busy-wedge (`readBody` / `validateImageAttachment`
> throws now reset `busy`) and mmproj-based vision detection — both already in place; nothing to change.
>
> **Flagged, NOT applied:** a PNG decoded-dimension guard (a speculative DoS defense against malicious web-pasted images;
> ismini is local and the base64 round-trip already guarantees valid decodable data) and small polish (the `name` field
> is unused by agent.js; empty-image / non-canonical-base64 / `image/jpg`-alias edge cases are fine for browser-produced
> data URLs). All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on web.js, agent.js, image-input.js; no dangling references to the removed symbols.
>
> ### 🧠 Round-11: `memory.js` + `agent.js` — three ways memory lost data while reporting success (2026-11-16)
> An eleventh independent review of **`memory.js`** confirmed the fundamentals are right (atomic temp+rename, `0o600`,
> corrupt-file preservation, Unicode tokenization) and found three data-integrity bugs plus a couple of guards. Each claim
> was verified against the real source and unit-tested. No publish until tasos says go.
>
> - **A failed save was reported to the model as "Saved" (data loss).** `_save()` swallowed every error and returned nothing,
>   so `add()` / `delete()` always reported success — a full disk, read-only home, or permission problem meant the note never
>   reached disk but the user was told it was stored. **Fix:** `_save()` now returns true/false; `add()` / `delete()` return a
>   `persisted` flag and agent.js appends a WARNING ("could not write memory.json to disk — lost on restart, tell the user")
>   when it is false.
> - **Eviction dropped the most-used memory, not the oldest.** `memories.shift()` removed by *insertion* order, but a dedup
>   hit bumps `updatedAt` without moving the entry — so a fact reinforced weekly sat at index 0 and was evicted first, while a
>   one-off note from yesterday survived. **Fix:** evict the min-`updatedAt` entry (a correct LRU by last reinforcement). The
>   dedup hit also now refreshes `category` (previously ignored).
> - **Silent 300-char truncation + a dedup bug.** `text.slice(0, MAX_TEXT_LENGTH)` cut without telling anyone, and dedup
>   compared the *full* text against already-truncated stored text — so re-adding a long note whose first 300 chars matched an
>   existing entry created a **duplicate** instead of refreshing it. **Fix:** truncate first, then dedup; `add()` returns a
>   `truncated` flag and agent.js tells the model the note was cut ("save the full detail to a file if it matters").
> - **`add('   ')` threw in the caller.** Whitespace-only input is truthy, passed the guard, then `add()` returned null and
>   destructuring threw. **Fix:** agent.js guards the null result.
> - **Unclamped search limit could dump the whole store into context.** A model asking for `limit: 200` got ~60 KB (~20k
>   tokens) in one tool result. **Fix:** clamped to [1, 20] in both `memory.search` and `toolMemorySearch`.
> - **Malformed timestamps crashed every search.** `_load` accepted any `updatedAt`; a hand-edited file with `updatedAt: 123`
>   reached `.localeCompare` → TypeError. **Fix:** normalize to ISO-8601 on load, and guard the sort comparison with `String()`.
>
> **Also:** exported `MAX_MEMORIES` / `MAX_TEXT_LENGTH` from memory.js so agent.js interpolates the real caps into its
> messages instead of hardcoding "(200 max)" (which would lie if the cap ever changed).
>
> **Flagged, NOT applied:** surfacing a corrupt-file wipe to the UI (real but UX-scope creep — already console.errors and
> preserves the file as `.corrupt-…`), and all low/cleanup items (CJK single-char tokens, the `setImmediate` chunking, the
> `.gitignore` gap — out of scope per tasos's no-GitHub rule, fsync-before-rename, `_load` clamp/dedup, version guard,
> `crypto.randomUUID`). All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on memory.js, agent.js, web.js. Unit-tested against the real `MemoryStore`: truncation +
> flag, dedup-after-truncate (no duplicate), whitespace→null, limit clamp, malformed-timestamp no-crash, LRU eviction keeps
> the reinforced entry, and a forced EACCES save failure returns `persisted: false` for both add and delete.
>
> ### 🗂️ Round-12: `sessions.js` + `web.js` — two-click data loss + unloadable sessions (2026-11-16)
> A twelfth independent review of **`sessions.js`** confirmed the fundamentals match memory.js (atomic temp+rename, `0o600`,
> corrupt-file preservation, `randomUUID`) and found a two-click data-loss path plus a cap that could save a session that
> crashes on restore. Each claim was verified against the real source and unit-tested. No publish until tasos says go.
>
> - **Deleting all sessions (or the last one) silently stopped saving history.** `deleteAll()` / deleting the only session set
>   `activeId = null` and nothing created a new one, so the next turn's `saveActive()` found no active session, returned null,
>   and wrote nothing — the whole next conversation was never persisted until "New" or a restart. **Fix:** both now always leave
>   a live session (`create()`), and web.js broadcasts the real new id instead of null.
> - **The 500-message cap could save an unloadable session.** A blind `slice(-500)` can start mid-turn on a `tool` message whose
>   preceding `assistant.tool_calls` was cut; on restore that orphan makes llama.cpp's Jinja template reject the whole
>   conversation. **Fix:** after slicing, shift off any leading `tool` messages so a session never starts on an orphan (the same
>   invariant `_enforceContextWindow` protects).
> - **`_save()` failures were silent** (same class as memory.js). Full disk / read-only home lost every turn's history while the
>   UI reported success, and "deleted" sessions reappeared on restart. **Fix:** `_save()` returns true/false + `lastSaveFailed`;
>   web.js surfaces it once via a broadcast so the user knows the conversation won't survive a restart.
> - **No byte cap — `sessions.json` could reach hundreds of MB and block every turn.** The count cap allowed one session to hold
>   ~24 MB (500 × up-to-48 KB tool results); `saveActive` rewrites the whole file synchronously each turn, so at that size the
>   event loop stalled for seconds — a real "ismini froze" source on heavy audits. **Fix:** a 2 MB per-session byte budget trims
>   from the front (O(n), no repeated stringify), then re-checks pairing.
> - **Eviction was by creation order, not last use** (same LRU bug as memory.js). A daily-used session opened weeks ago was evicted
>   before an abandoned one from yesterday. **Fix:** evict the min-`lastActive` session; the active session is never evicted — if it
>   happens to be the oldest, skip it and evict the next-oldest (stopping would leave the store over the cap).
> - **One bad message wiped all 20 sessions.** `every(…)` validation was all-or-nothing: a single malformed message renamed the whole
>   file to `.corrupt-*` and started empty. **Fix:** salvage per-session — drop only the bad messages/sessions, keep the rest; record
>   `loadError` so web.js can surface it (a silent wipe of all history should never look like "you never told me"). Timestamps are now
>   normalized to ISO-8601 on load, which also fixes unvalidated `started`/`lastActive` breaking the sort order in `list()` / `search()`.
> - **`search()` — clamped the limit + fixed CJK terms.** A model asking for `limit: 10000` got thousands of full-text matches into
>   one tool result; and `length >= 2` dropped single-character CJK terms (猫, 車). **Fix:** clamp to [1, 50] and keep non-ASCII
>   single-char terms (same fix as memory.js).
>
> **Also:** `saveActive` now copies the message objects (no aliasing of the live agent's objects), and a comment documents why
> recall deliberately skips tool messages.
>
> **Flagged, NOT applied:** surfacing per-session eviction toasts (returns evicted ids from `create()`; cosmetic), the
> `.gitignore` gap (out of scope per tasos's no-GitHub rule), fsync-before-rename (same tradeoff as memory.js), and renaming
> `archiveAndCreate()`. All off the audit path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on sessions.js, web.js, agent.js. Unit-tested against the real `SessionStore`: delete-all /
> delete-last leave a live session, no orphaned tool at the front after capping, byte cap reduces count, per-session salvage + bad-msg
> drop + timestamp normalization, CJK search + limit clamp, and a forced EACCES save sets `lastSaveFailed`. LRU eviction verified for
> both the normal case and the edge where the active session is the oldest (next-oldest evicted, store ends at cap).
>
> ### 🔊 Round-13: `web/live-tts.js` — dead code removed + tracker fixes (2026-11-16)
> A thirteenth independent review of **`web/live-tts.js`** assumed the module's `speakText()` was the live TTS path. It is not —
> verifying against `web/index.html` showed the UI imports **only** `createLiveResponseTracker`, and has its **own inline TTS**
> (`speak()` / `startTTS()` / `textForSpeech()`) that already strips markdown, picks a voice by index, and handles onend/onerror.
> So most of the review targeted code that never runs. Each claim was verified against the real source; only what's actually live
> was changed. No publish until tasos says go.
>
> - **Dead code removed.** `speakText()` and `stopSpeaking()` were never imported by the UI (index.html imports only
>   `createLiveResponseTracker`) — the app's real speech is its own inline TTS. They were removed rather than "fixed" into a second,
>   parallel TTS engine (which would have violated minimalism). A comment now records why.
> - **The tracker doc comment was wrong.** It said the tracker "accumulates", but `update()` REPLACES — and that's correct, because
>   the UI accumulates the streamed tokens into `liveText` itself and calls `update(liveText)` with the whole bubble text on each
>   token (verified by grep). The comment now says so. An `append(chunk)` method was added for callers that stream fragments.
> - **`cancel()` didn't stop speech.** The Pause / error / reset paths call `liveResponse.cancel()`, but the previous answer kept
>   talking over the new one. **Fix:** `cancel()` now also calls `speechSynthesis.cancel()` (guarded, no-throw when there's no
>   window). An `isActive()` method was added so the UI can tell whether a response is being tracked.
>
> **Flagged, NOT applied (target the dead code or are larger frontend changes):** Qwen's 🔴 #1 (chunking — long answers truncate at
> ~15s) and #3/#4/#5/#6 (async `getVoices()`, markdown stripping, language/voice fallback, no-voices error) all target the now-removed
> `speakText()`; the real inline TTS already strips markdown and picks a voice. The genuine remaining gap — long **live-mode** answers
> can still truncate at ~15s because index.html's `startTTS()` speaks one utterance, and `getVoices()` can be empty on first call —
> lives in `web/index.html`, not this module; fixing it is a larger frontend change (sequential chunking + voiceschanged await) that
> should be done deliberately, not silently. All off the agent path; no regression risk to prior fixes.
>
> **Verified:** `node --check` clean on web/live-tts.js; no dangling references to the removed exports. Unit-tested the tracker:
> update-replaces (full-bubble path), append-accumulates, cancel clears + stops speech, finish-after-cancel returns empty, and cancel
> with no window does not throw.
>
> ### 🖥️ Round-14: `web/index.html` — XSS in the model manager + UI freezes + TTS voice (2026-11-16)
> A fourteenth independent review of **`web/index.html`** (the browser UI) found a real security hole plus several
> correctness/perf bugs. Every claim was verified against the real source before changing anything; only live, confirmed issues
> were fixed. No publish until tasos says go.
>
> - **XSS in `renderDetails` — and this app has a shell (critical).** The Model Manager injected HuggingFace model-card data raw
>   (`d.name`, `d.author`, `d.params`, `d.license`, `d.description`, `data-file="…"`) into `innerHTML`. A malicious `license:
>   <img src=x onerror=…>` in a model card would execute in ismini's origin — which can run shell commands with sudo. **Fix:**
>   every interpolation is now wrapped in `esc()` (which also escapes quotes for the attribute values), and a `rel="noopener"`
>   was added to the external link. A CSP `<meta>` tag was added as defense-in-depth (it blocks remote code / forms / frame
>   access; note it must allow `'unsafe-inline'` scripts because this is a single-file app, so escaping remains the primary fix).
> - **The voice you picked was not the voice you got (high).** `populateVoices()` sorted the voice array and stored each option's
>   *sorted index* as its value, but `speak()` / `startTTS()` re-fetched a fresh (unsorted) `getVoices()` array and indexed into it —
>   so the spoken voice was whatever happened to be at that position in the original order. Saving an index also broke whenever the
>   browser/OS voice list changed. **Fix:** options now store the voice *name*; a new `currentVoice()` resolves by name (robust against
>   reordering), and both TTS paths use it.
> - **O(n²) re-render froze the UI on long answers (high).** `onToken` re-parsed the whole growing markdown string + replaced
>   `innerHTML` + forced a layout on *every* token — a 20k-char audit report meant thousands of full re-renders, exactly ismini's
>   heaviest workload. It also unconditionally scrolled to the bottom, yanking the user down so they couldn't read up while
>   streaming. **Fix:** `queueLiveRender()` batches rendering to at most once per animation frame and only auto-scrolls if the user
>   is already within 80px of the bottom.
> - **`restoringTranscript` could stick at `true` forever → TTS muted permanently (medium).** In `resync` / `switchSession` /
>   `deleteSession`, the flag was set true, the restore loop ran, then false — all in one try. One malformed message throwing mid-loop
>   left it true, and the `addModel` wrapper's `!restoringTranscript` guard then silenced *all* future speech. **Fix:** each loop is now
>   wrapped in `try { … } finally { restoringTranscript = false; }`.
> - **`send()` could silently lose your message (medium).** It rendered the bubble and cleared the input *before* knowing the POST
>   succeeded; on 409 / error / network failure it only toasted, so the text vanished on reload. **Fix:** a `restoreInput()` puts the
>   text + attached image back into the box on any failure.
> - **Model-list fetch had no staleness token (medium).** `enrich` and `select` had tokens but `loadOfficialModels` didn't, so a slow
>   earlier search could overwrite a newer one. **Fix:** added `mmListToken`; bail if the response is stale.
> - **"reconnecting…" was never cleared (low).** `es.onerror` set it but `es.onopen` only touched the dot, so one SSE blip left the
>   status stuck. **Fix:** `onopen` now restores the busy/idle status text.
> - **Dead code removed.** `fmtCtx()` (the chip uses `toLocaleString()`), `hideUpdateProgress()`, and `mmModalEl()` were defined but
>   never called — all removed.
> - **Help text: `<N>k ctx` parsed as an unknown HTML tag (low).** Two spots rendered "k ctx" instead of the literal chip label. Now
>   escaped as `&lt;N&gt;k`.
>
> **Flagged, NOT applied:** #1 — routing TTS through a shared module would *re-introduce* the dead `speakText()`/`stopSpeaking()`
> exports just removed in Round-13 (the UI already owns working inline TTS); the real remaining gap is long **live-mode** answers
> truncating at ~15s, which needs sequential utterance chunking in index.html. #8 — the live-mic "permanently deaf" fix needs `recGen`
> threaded through a nested closure and can't be safely verified without live testing. Help-text factual corrections ("default is 8k"
> vs the real 32768 default, "unlimited" sessions vs the 20 cap, "26B" example) were left for tasos to confirm exact wording before
> publishing. All off the agent path; no regression risk to prior fixes.
>
> **Verified:** extracted both inline `<script>` blocks and ran `node --check` — both parse clean. No dangling references to the removed
> functions; `currentVoice()` is a hoisted function declaration (safe at both call sites). Note: web.js caches index.html into memory
> at startup, so this requires restarting ismini, not just a browser reload.
>
> ### 📦 Round-15: `install.sh` — two ways the installer could destroy a working install + config wipe (2026-11-16)
> A fifteenth independent review of **`install.sh`** found two paths by which the installer could *destroy* a working install, an
> exclusion gap that makes a fresh install uninstall itself, and a config wipe on every upgrade. Every claim was verified against the
> real source before changing anything; only live, confirmed issues were fixed. No publish until tasos says go.
>
> - **It deleted `node/` + `llama-cpp/` + `bin/` BEFORE verifying the source (critical).** With `set -euo pipefail`, any tar failure
>   (disk full, unreadable file, Ctrl-C) aborts right after those dirs are gone — no Node, no llama-server, no recovery. And one input
>   *guaranteed* failure: the Node detection accepted the legacy `node-v*-linux-x64/` layout, but the post-install check demanded
>   `$DEST/node/bin/node`, so a legacy-layout source passed the gate, got its old Node deleted, copied `node-v*` over, then failed and
>   exited — destroying a working install. **Fix:** a source-integrity check now runs *before* anything is deleted (verifies the full
>   module-load chain + bundled Node exist in `$DIR`, refusing to touch an existing install if any are missing), and the legacy `node-v*`
>   branch was dropped (the error message explains the required layout).
> - **Symlinked `$HOME` made it self-destruct (critical).** `DIR` is resolved (symlinks gone) but `DEST="$HOME/ismini"` was not, so with a
>   symlinked home they differ as strings → running `bash ~/ismini/install.sh` took the copy branch and `rm -rf`'d its own `node/` +
>   `llama-cpp/`, then tarred the dir onto itself. **Fix:** `DEST` is now resolved to its canonical path, so `DIR == DEST` in that case.
> - **The tar exclusion list was missing five things that matter (critical).** The old list shipped user state into the install: a stray
>   `.uninstall-request` (the launcher checks it on *every* launch → fresh app uninstalls itself), `models/` (overwrites the user's
>   `installed.json` → their downloads vanish, or copies tens of GB), `hf-token` (a credential that overwrites theirs),
>   `llama-state.json` (our last-loaded model path → ismini tries to load a file that doesn't exist on their box), and the logs. **Fix:**
>   all five (plus `config.json.bak`, `*.corrupt-*`, `node_modules`) are now excluded; `mkdir -p models` still recreates an empty dir.
> - **`config.json` was replaced on every upgrade — wiping the user's tuning (high).** web.js writes config at runtime for the sudo
>   toggle, window size, and the context length the user tuned for their RAM; a blind `cp` reset all of them each update (and
>   re-introduced the history-starvation arithmetic). **Fix:** the installer now *merges* — starts from the new release defaults, then
>   overlays only the user's known runtime-tuned keys (`llamaCpp.context`, `agent.contextWindow`, `agent.maxTokens`, `tools.sudo`,
>   `windowSize`). New/renamed keys adopt the release default; removed tools are gone. The old config is still backed up to
>   `config.json.bak` first, and a merge failure falls back to the release defaults.
> - **"In-place upgrade complete" printed on a fresh install (medium).** The test ran *after* `cp config.json`, so it was always true.
>   **Fix:** capture `WAS_UPGRADE` from `sessions.json` before copying; only print the notice on a real prior install.
> - **The icon fallback reintroduced the blur we fought (medium).** Without ImageMagick, the full 642×655 master was copied into the
>   16px slot (the WM downscales it = blur), and `-filter Lanczos` sat *after* `-resize` so it never applied. **Fix:** use the shipped
>   crisp pre-rendered `web/favicon-{size}.png` first for the sizes we have, fall back to ImageMagick (with `-filter` before `-resize`)
>   or a raw copy otherwise.
> - **The integrity check omitted files whose absence crashes at import (medium).** It only checked 4 files; `web.js → agent.js →
>   ./tools/*` is a module-load chain, so a partial copy missing `tools/` passed and then died on launch. **Fix:** the post-install check
>   now verifies the full chain + bundled Node (same list as the new source-integrity gate).
> - **~100 lines of desktop/icon logic were duplicated verbatim in both branches (medium).** A fix to one never reached the other.
>   **Fix:** extracted into a single `register_desktop_entries()` function called from both paths.
> - **Low / cleanup.** Unknown flags are now rejected (a typo'd `--nostop` used to silently leave `NO_STOP=0`, so the updater killed
>   itself mid-update); `Exec=` in the `.desktop` file is now quoted (paths with spaces were invalid); the `notify-send --icon` arg is
>   now quoted.
>
> **Flagged, NOT applied:** #4's *alternative* "ship `config.example.json`" was rejected — it contradicts tasos's standing rule that
> config.json is app code replaced on upgrade; the merge-preserve (his preferred fallback) is what's implemented instead. The bash ≥ 4.4
> note (empty-array expansion under `set -u`) and an install log are optional polish, not applied.
>
> **Verified:** `bash -n` clean. The config-merge program was extracted and unit-tested against the real bundled Node: fresh install ==
> release defaults; upgrade preserves context/maxTokens/sudo/windowSize while adopting new defaults; corrupt old config falls back to
> defaults; partial old config keeps present keys + adopts missing ones (11/11 pass). `register_desktop_entries` is defined once and
> called from both branches; no leftover duplication.
>
> ### 🗑️ Round-16: `uninstall-preserve.sh` — reinstall loop + PID-reuse kill hazard + drifted delete list (2026-11-16)
> A sixteenth independent review of the preserve-uninstaller found one full *reinstall loop*, two process-kill hazards, and a
> hand-maintained delete list that had already drifted from the real module set. Every claim was verified against the real source;
> only live, confirmed issues were fixed. No publish until tasos says go.
>
> - **A reinstall uninstalled itself (critical).** `web.js /api/uninstall` writes `.uninstall-request` as the *reliable* trigger and the
>   launcher checks it on EVERY launch — but this script never removed it. So: preserve-uninstall → reinstall into `~/ismini` (the flow
>   the dialog advertises: "Reinstall any time and ismini will remember you") → first launch sees the file → **the fresh install
>   uninstalls itself**. This was the other half of the gap Round-15 closed in `install.sh`'s tar. **Fix:** `.uninstall-request` is now
>   in the delete list.
> - **The PID-file kill could SIGKILL an unrelated process, and defeated graceful shutdown (critical).** The old code read `server.pid`
>   then sent TERM followed *immediately* by KILL — no numeric validation, no check that the PID still belongs to ismini (stale file +
>   PID reuse = killing something the user owns), and zero time for web.js's SIGTERM handler to run `_killBackend()` (the primary orphan
>   prevention). **Fix:** the pid must be numeric AND its `/proc/$pid/cmdline` must contain `$APP/web.js` before any signal; then a shared
>   `stop_pids_gracefully()` sends TERM, polls up to ~5 s, and escalates to KILL only if still alive.
> - **The llama-server escalation re-checked only the FIRST pgrep pattern (critical).** The fallback pattern is the *only* one that matches
>   `$APP/bin/llama-server` — a path `llama-backend._findBinary()` explicitly supports. A slow-to-die server on that path got SIGTERM, the
>   escalation re-pgrep found nothing, and it survived holding VRAM — then section 4 deleted its binary, so it couldn't even be identified
>   afterwards. **Fix:** one combined pgrep collects all PIDs once; `stop_pids_gracefully()` polls the SAME collected PIDs.
> - **The delete list had drifted (critical).** It named `web.js agent.js llama-backend.js image-input.js` but NOT `sessions.js` /
>   `memory.js` (both imported by web.js) — after a preserve-uninstall they stayed in `~/ismini` forever, and a later reinstall of a
>   different version could leave stale code behind. **Fix:** inverted for code — every top-level `.js` is app code (`find -name '*.js'`
>   -delete), data files (`.json`/`.md`/`hf-token`) are preserved by construction; new modules can never be left behind again.
> - **`pgrep -f "$APP/web\.js"` killed anything with that string in its cmdline (medium).** `code ~/ismini/web.js`, `tail -f`, a grep.
>   **Fix:** the same exact-argv-element matcher install.sh uses (`/proc/*/cmdline`) — both scripts now agree on what "ismini is running"
>   means.
> - **`$HOME` empty or symlinked → wrong target, silent no-op (medium).** **Fix:** guard + canonical-path resolution (same class as
>   Round-15's install.sh fix).
> - **Success was unconditional (medium).** `rm -f` never fails on missing files, so "✓ removed" printed even when nothing was removed.
>   **Fix:** the script now exits 1 with an error if `$APP/web.js` still exists after the delete.
> - **hicolor icons never cleaned (low).** install.sh writes 9 sizes to `~/.local/share/icons/hicolor/*/apps/ismini.png`; this removed only
>   the `.desktop` files, leaving a stale taskbar icon. **Fix:** hicolor copies removed + caches busted.
> - **Keep-list in header/dialog was inaccurate (low).** It omitted `skills/`, `hf-token`, `greeting-state.json`, `llama-state.json`, the
>   logs — and promised a `server.log` that doesn't exist. **Fix:** dialog text now matches reality.
> - **Low / cleanup.** GUI branch gated on an actual display (a headless box with zenity installed fell through to "cancelled" instead of
>   the terminal prompt); `read -r … || confirm=""` (EOF on a non-TTY = clean cancel, not an abort under `set -e`); `--yes` now checked
>   across ALL args (`--force --yes` no longer falls into interactive mode).
>
> **Flagged, NOT applied:** the predictable `/tmp/ismini.log` path (multi-user hygiene — would require coordinating a new location with
> web.js's `LOG_FILE`; cosmetic for this app's single-user desktop reality). Everything else in the review was real and is fixed.
>
> **Verified:** `bash -n` clean. The exact-argv matcher was unit-tested against live decoy processes: a process whose cmdline merely
> *contains* `$APP/web.js` (e.g. `tail -f … web.js`) is NOT matched, while one with it as an exact argv element IS; a stale `server.pid`
> pointing at an unrelated long-running process is correctly refused by the ownership check.
>
> ### 💥 Round-17: `uninstall.sh` — "delete everything" could delete the wrong thing, miss relocated data, or lie about success (2026-11-16)
> A seventeenth independent review of the full uninstaller (blast radius: `rm -rf` in the user's home) found four new critical issues plus the four
> shared process-kill bugs from Round-16. Every claim was verified against the real source; only live, confirmed issues were fixed. No publish until
> tasos says go.
>
> - **It didn't honor `ISMINI_HOME` — "delete everything" could leave ALL your data on disk (critical).** `web.js resolveDataDir()` checks `ISMINI_HOME`
>   first, then `~/ismini`. The script hardcoded both to `~/ismini`, so a user who relocated their data (models are tens of GB) would get the app deleted
>   while `sessions.json` / `memory.md` / `hf-token` / `models/` survived untouched — and the script printed "completely removed". A privacy failure, not
>   just a bug. **Fix:** targets now collect `$APP` + `$ISMINI_HOME` (when set and different); every target is shown in the confirmation and each is deleted.
> - **No check that the target is actually an ismini install before `rm -rf` (critical).** If `~/ismini` held something else, it was gone. **Fix:**
>   `looks_like_ismini()` requires at least one marker — code (`web.js`) OR data (`sessions.json`, `memory.json`, `models/`, `config.json`). Accepting data
>   markers matters: after a preserve-uninstall the code is gone but the data remains, and the user must still be able to wipe it.
> - **A failed `rm -rf` aborted silently under `set -e` (critical).** Undeletable file → non-zero exit → no message, half-deleted install, and the scripts
>   live inside the very dir being deleted so nothing is left to retry. Root-owned files are plausible (ismini runs commands with sudo). **Fix:** errors are
>   captured and printed with an explicit "Finish manually: `sudo rm -rf '…'`" hint.
> - **"All its traces" was false — hicolor icons + caches survived (critical).** install.sh writes 9 icon sizes under the hicolor theme; neither uninstaller
>   cleaned them, so a ghost icon persisted. **Fix:** same cleanup as Round-16's preserve script.
> - **The four shared process-kill bugs from Round-16, applied identically (high).** Exact-argv-element matcher (agrees with install.sh); PID-file kill
>   numeric-validated + ownership-checked; TERM→poll(~5 s)→KILL so web.js's `_killBackend()` gets its window; llama-server collected once with the combined
>   pattern and escalated by polling the SAME PIDs. In a full uninstall these matter doubly: a survivor would keep 8–32 GB of KV cache resident with its
>   binary already deleted.
> - **The confirmation hid what it was about to destroy (medium).** No path, no size, omitted `skills/` / `hf-token` / `memory.md` / logs. **Fix:** the dialog
>   now lists each real target with its size (`du -sh`); if nothing exists it prints "Nothing to remove" and exits 0.
> - **Low / cleanup.** `$HOME` guard + canonical path; GUI gated on an actual display; `read -r … || confirm=""`; `--yes` across ALL args; success verified
>   per target instead of unconditional. Two stale `~/.ismini` comments (launcher + web.js) cleaned — the launcher comment now notes that web.js honors
>   `ISMINI_HOME` while the launcher always uses `~/ismini`.
>
> **Flagged, NOT applied:** the reviewer's structural suggestion to extract a shared `uninstall-common.sh` sourced by both uninstallers (a refactor tasos can
> decide on; both scripts now carry identical, unit-tested kill logic anyway). The predictable `/tmp/ismini.log` path remains flagged from Round-16. No
> browser-profile cleanup was needed: verified the launcher uses the user's **normal** browser profile (no dedicated `--user-data-dir`) — that part of the
> review was wrong.
>
> **Verified:** `bash -n` clean on `uninstall.sh` and the launcher; `node --check` clean on web.js. The `looks_like_ismini` guard was unit-tested against real
> dirs (data-marked dir → allowed; unrelated dir → refused; nonexistent path → refused). The `ISMINI_HOME` collection logic was unit-tested (unset → single
> target; set-and-different → both targets).
>
> ### 🚀 Round-18: `ismini` launcher — one relative path made every process matcher dead code + a browser that opened at a dead port (2026-11-16)
> An eighteenth independent review of the **launcher** resolved three open questions from earlier reviews (correcting two of our own earlier claims in the process) and
> confirmed the biggest one with a one-word fix that repairs three scripts at once. Every claim was verified against the real source; only live, confirmed issues were
> fixed. No publish until tasos says go.
>
> - **`web.js` was launched with a RELATIVE path — every process matcher in three scripts was dead code (critical).** The cmdline was `./node/bin/node web.js --port
>   8787`, so install.sh's exact-argv check and both uninstallers' kill paths could NEVER match: a manual reinstall *replaced files under a live server* (the "No app files
>   were replaced" guard never fired), and the uninstallers survived only via the `server.pid` path. **Fix:** one word — `"$NODE_BIN" "$PWD/web.js" …`; the matchers stay as
>   they are and become correct.
> - **The readiness loop reported "ready!" before the port was bound (critical).** `kill -0 "$pid"` succeeded on iteration 1 because the node process exists before
>   `server.listen()` runs — the browser opened instantly at a dead port (the "Failed to fetch" class in Help → Troubleshooting). **Fix:** poll the actual port (curl
>   `/state`, `/dev/tcp` fallback) up to ~10 s; detect early death (tail the log, clean the pidfile, exit 1); on timeout, tail the log.
> - **Unguarded `$DISPLAY` under `set -u` killed the launcher on Wayland-only sessions (critical).** The probes used `${DISPLAY:-:0}` but the ozone check used bare
>   `$DISPLAY` → "DISPLAY: unbound variable" *after* the server started (server running, no window, no explanation). **Fix:** `${DISPLAY:-}`.
> - **An empty/truncated `.uninstall-request` wiped ALL data (critical).** `full|*)` made the destructive branch the default; a half-written request file (disk full,
>   interrupted write) → `mode=""` → full uninstall, chat history and models gone. **Fix:** only exact `full`/`preserve` run; anything else warns and KEEPS the file for
>   inspection; the script's existence is verified before consuming the request.
> - **`is_server_running` had two false-positive paths (high).** `kill -0 "$pid"` succeeds for ANY process with that PID — a stale pidfile + PID reuse made the launcher
>   skip starting and open a browser at a dead port. **Fix:** the pid must also own a cmdline containing `$PWD/web.js`.
> - **Centering used the multi-monitor bounding box (medium).** On two 1920×1080 outputs the window centered across the bezel. **Fix:** primary monitor's geometry from
>   `xrandr --listmonitors` (the `*` row), offset by its position; the old `current WxH` line remains as single-monitor fallback.
> - **The progress-window size was clobbered (low, latent).** Set to 440×320 twice, then unconditionally overwritten by 1200×820 and the saved size. **Fix:** progress mode
>   keeps its small size and skips the saved-size read.
> - **`> "$LOG_FILE"` truncated on every launch (low).** A crash log was destroyed by the very relaunch a user does to investigate. **Fix:** rotate to `server.log.old`
>   first, append with `>>`.
> - **Companion one-liners (low).** install.sh's tar now also excludes `server.pid` / `server.log*`; `uninstall-preserve.sh` deletes the stale `server.pid` (process state,
>   not user data); symlink invocation fixed via `readlink -f` so a launcher linked from `~/.local/bin` still finds `web.js`.
>
> **Flagged, NOT applied:** the dedicated `--user-data-dir="$HOME/.ismini-browser"` proposal. It's real (with the normal profile, `--app` opens in the already-running browser
> process, so `--class`/`--window-size`/`--window-position`/`--ozone-platform=x11` are ignored — all icon/geometry work only takes effect on a cold start), but it's a
> behavior change with a real tradeoff (a fresh profile may lack Edge's natural TTS voices; adopting it would make Round-17's "profile leftover" finding real again).
> **Decision needed from tasos:** test TTS voices in a clean profile, then adopt + add the cleanup, or document the limitation.
>
> **Verified:** `bash -n` clean on all three touched scripts. Readiness loop unit-tested both ways (nothing listening → never ready; live TCP listener → `/dev/tcp`
> fallback connects). Request-file handler unit-tested: empty mode → refused + file kept; `full` → ran + consumed; garbage mode → refused + file kept.
>
> ### 🎨 Round-19: title-bar / taskbar icon blur fix (2026-11-16)
> The ismini window icon was blurry in the title bar and thrashed against the taskbar icon. Root cause was
> three-way: (1) a shared browser profile meant `--class`/geometry/ozone flags were ignored when Edge was already
> running, plus a year-long favicon cache; (2) the master `ismini.png` was 642×655 (non-square) and ImageMagick's
> `-filter Lanczos` was applied *after* `-resize`, degrading small sizes; (3) the page head linked no 16px icon,
> so the WM downscaled one large icon into the 16px slot. All three addressed.
>
> - **All favicons regenerated from ONE square master (512×512).** `-filter Lanczos` applied *before* `-resize`,
>   fit+pad (never crop — head intact). Sizes: 16/32/48/64 (with `-unsharp` for legibility at small px), 128/192/
>   256/512 (pure Lanczos), 180 (apple-touch), plus a multi-res `favicon.ico` (16–256). Visually verified 16/32/48.
> - **Dedicated browser profile (`--user-data-dir=$HOME/.ismini-browser`).** The launcher now opens the app window
>   in its own Chromium profile, so `--class=ismini`, `--window-size`, `--window-position`, and `--ozone-platform`
>   all take effect (WM_CLASS is correct → KDE matches the hicolor icon; Wayland surface identity is stable).
>   A version-keyed favicon-cache wipe (`$PROFILE_DIR/Default/Favicons`) runs on app upgrade so a regenerated
>   icon shows immediately without manual cache clearing.
> - **`web/index.html` head:** now leads with `favicon.ico` (multi-res) + PNG links for 16/32/48/64/256 (all
>   `?v=15`). Apple-touch bumped to `?v=15`. The one-time auto-`location.reload()` block (and its stale comment)
>   was **deleted** — it closed the SSE ~1.2s after load and could abort a running turn.
> - **`web.js` favicon route:** regex now includes 128; cache-control changed from `max-age=31536000` to
>   `no-cache` (matches the `.ico` route) so a regenerated icon is picked up immediately.
> - **Launcher `ismini`:** `[ -n "$ISMINI_ICON" ]` → `[ -f "$ISMINI_ICON" ]` (the old always-true check could pass
>   a non-existent path to `--app-icon`). Profile block + version-keyed cache wipe added before the browser call.
> - **`uninstall.sh`:** now removes `$HOME/.ismini-browser` (resolves Round-18's flagged "profile leftover" finding).
>
> **Flagged, NOT applied (art decision — needs tasos's eye):** at 16px a photographic statue is ~8 pixels of
> head; no filter fixes that. Options: (a) crop *to* the head for ≤32px variants only, or (b) ship a simplified
> high-contrast mark for 16/22/24. Also: tasos should test Edge TTS voices in the fresh dedicated profile — a
> clean profile may not have his natural voices pre-loaded.
>
> **Verified:** `bash -n` clean on `ismini`, `uninstall.sh`, `install.sh`, `uninstall-preserve.sh`; `node --check`
> clean on web.js. All 10 favicon routes return 200 with correct content-type + `cache-control: no-cache` (live
> server test). Auto-reload block confirmed removed from index.html.
>
> ### 🎨 Round-20: icon fix — reverted to Qwen's correct recipe + uninstall crash fix (2026-11-17)
> tasos reported the title-bar icon was **worse** after Round-19, and that both uninstall scripts did
> nothing (confirmation appeared, click OK, nothing deleted). Two separate issues found and fixed.
>
> **Icon:** The Round-19 regeneration used a head-crop + 4-color quantization that made the icon look
> *corrupted/glitchy* rather than crisp. Reverted to Qwen4-max's exact recipe (`/home/tasos/Downloads/18.txt`):
> full statue composition, square master (512×512, `-filter Lanczos` BEFORE `-resize`, fit+pad, never crop),
> then per-size Lanczos resize with `-unsharp 0x0.6+0.7+0.008` for ≤64px. This is the same recipe that
> produced Round-19's icons — the difference now is that the dedicated profile + `no-cache` + `?v=17`
> actually force the browser to fetch and display them (Round-19's pipeline was correct but the browser
> may have been showing a cached version from before the dedicated profile existed).
>
> - All favicon PNGs (16/24/32/48/64/128/180/192/256/512) + multi-res `favicon.ico` regenerated from the
>   square master using Qwen's exact commands.
> - Hicolor icons (`~/.local/share/icons/hicolor/*/apps/ismini*.png`) updated to match.
> - Cache busting: `?v=17` in index.html. Dedicated-profile favicon cache cleared.
> - Old (bold-quantized) icons backed up to `web/favicon-backup-v15/` (the v15 originals are also there).
>
> **Uninstall crash (critical):** Both `uninstall.sh` and `uninstall-preserve.sh` had a **bash syntax error**
> that killed the script immediately after the confirmation dialog, before any files were deleted. The line:
> ```
> [ "${#1[@]}" -gt 0 ] || return 0
> ```
> is an invalid substitution (tries to get the length of an array named `1`). Under `set -e` this exits the
> script with a "bad substitution" error. The user sees the zenity/kdialog confirmation, clicks OK, the
> script proceeds to `stop_pids_gracefully`, hits the bad line, and **dies silently** (no error shown because
> it's spawned with `stdio: 'ignore'` from web.js). **Fix:** `${#1[@]}` → `$#` (the standard "number of
> arguments" parameter). One character-class fix in each script.
>
> **Uninstall-preserve left `install-ismini.sh` behind:** The explicit delete list in `uninstall-preserve.sh`
> included `install.sh` but not `install-ismini.sh` (the AppImage installer bootstrap), nor `push-to-github.sh`
> or `ismini.desktop`. These are app code, not user data, and should be removed. **Fix:** added all three to
> the brace list. (The full `uninstall.sh` is unaffected — it does `rm -rf` on the entire directory.)
>
> **Title-bar icon: "I" logo tried, then REVERTED to the statue.** tasos first provided a bold blue "I" mark
> with a sparkle (`web/1.jpeg`) as the title-bar icon; all favicons + hicolor were regenerated from it. After
> testing (and confirming the residual title-bar blur was a KDE/Wayland downscaling artifact, not a KDE-only bug),
> he changed his mind and asked to **revert everything to the statue**. Done: all favicon PNGs (16–512 + .ico),
> `ismini.png` (the `--app-icon` source), hicolor icons, and the in-app avatar are back to the original statue
> master. Cache bumped to `?v=20`, profile cache cleared.
>
> **Avatar split kept (statue everywhere).** The in-app avatar remains a dedicated file — `web/ismini-avatar.png`
> (256×256 statue) served by a `GET /ismini-avatar.png` route in web.js (`cache-control: public, max-age=31536000`).
> All four in-app references in `web/index.html` use `src="/ismini-avatar.png"`; the `<link rel="icon">` in the head
> (title bar) now serves the statue favicon again. Net effect: the statue is the single icon across title bar,
> taskbar, and in-app — no more "I" logo anywhere.
>
> **Verified:** `bash -n` clean on both scripts. `node --check` clean on web.js. All regenerated favicons are the
> statue (visually confirmed at 32px + 512 master); `ismini.png` is the square 512 statue; cache `?v=20`.

### 🐛 Bug fixes

- **ismini stopped answering on long tool-heavy tasks (and only woke on a new message).**
  Two-part fix:
  - **She no longer gives up silently.** When a turn runs out of steps without a final
    answer, ismini now forces one last, tool-free call and tells you *what she found so far*
    plus *what's still left* — instead of ending the turn with no assistant message at all.
    A short banner ("Reached my step limit (N) — here's what I have so far") also appears
    so it's never a mystery. The "too many silent tool turns" path was refactored to share
    the same code, so neither exit can ever go quiet again.
  - **The step budget is now big enough for real work.** `agent.maxTurns` added to
    `config.json` (default **60**, was an implicit 20). A full audit of ~20 files needs
    30–40+ read/exec steps; 20 cut it off mid-job. 60 comfortably covers a whole-folder
    deep dive while still bounding runaway loops.
- **ismini re-read the same files over and over on long tasks** ("let me read them…"
  ×4, each time claiming she should have read them). Root cause: the context-window
  budget math starved history — with an 8k context, a single big file read (~22k tokens)
  was *always* evicted from the window before the next model call, so ismini never saw
  that she had already done the work and repeated it forever. (Proven from a real saved
  session: identical re-reads of the same 3 files, even with a strong 27B model — this was
  a deterministic code bug, not model fragility.) Three-part fix:
  - **The history budget can no longer starve.** The reply reserve is now `min(maxTokens,
    ~40% of context)` instead of `ctx − 2048`, and history is guaranteed at least ~35% of
    the context (1k tokens of headroom under the model's real limit always kept). An 8k
    context now keeps ~3.2k tokens of history (was ~1.3k); a 32k context keeps ~22.9k.
  - **Every tool result is tagged** with a tiny header — `[read /path/to/file]`,
    `[exec <cmd>]` — stored in the session, so even when a large body is evicted the model
    can see what it already did and won't repeat it.
  - **Oversized tool turns are shrunk, never dropped.** When a turn with big tool results
    doesn't fit the budget, its tool outputs are truncated to short stubs that KEEP the
    header (plus a note that the full output can be re-read) instead of being thrown away.
    The old code skipped such turns entirely — which is exactly what erased all evidence
    of completed work and caused the loop. Verified with a simulation of the real failing
    conversation: all 9 tool results survive windowing, every one with its `[read …]`
    header visible.
- **Bigger default context length: 8k → 32k.** The old 8,192-token default made users
  hit the context wall on real work and blame the app. ismini now ships with a **32,768**
  context by default — enough room for long multi-file jobs and big tool outputs. Low-RAM
  boxes can still lower it any time via the `ctx` chip in the top bar (4k → 256k); if a box
  can't afford 32k, llama.cpp OOMs softly and the user just clicks the chip down. No new
  dependencies; `web.js` unchanged (it already reads all three config fields).
- **Tool-call labels are now copyable in a transcript.** When you right-click → Copy a
  conversation, the tool cards (the little `read` / `exec` bubbles with the ▸ arrow) used to
  be skipped — their label had `user-select: none` — so a pasted transcript lost the evidence
  of *what* ismini did. Now the label text is selectable, and it shows the tool's target
  (`read /home/…`, `exec ls -la …`) instead of just the bare name, plus an accessible name on
  the whole card — so a copied/pasted session reads like `[read /path]` and you can see exactly
  which file or command was used. (`web/index.html` only.)
- **ismini no longer "cracks"/freezes under heavy reading (big prompts).** This was the big
  one. When a job reads many large files, the prompt balloons (a real audit hit ~63k tokens), and
  llama.cpp spends **minutes just processing that prompt** before it emits its first output token.
  ismini's inactivity watchdog only had a single **2-minute** timer — and because no tokens stream
  *during* prompt processing, the timer expired mid-processing and **cancelled the request**
  (llama.log: `W srv stop: cancel task`). To you it looked like ismini froze/cracked. Fixed by
  making the watchdog **two-phase**: a long allowance (**10 min**) to get the *first* token (covers
  slow big-prompt processing), then the original short **2-min** between-tokens timeout (which still
  catches a genuinely hung generation). So heavy jobs now just take their time instead of dying. (`agent.js` only.)
- **ismini no longer loops on the same repeated action.** On a long audit she could get stuck
  issuing the *exact same* tool call over and over (e.g. `exec cat agent.js` + "Let me begin…"
  again and again), burning her whole step budget making no progress — and only stopping when you
  nudged her. The existing loop guards missed this: the "silent tool turns" guard resets on any
  text (and she always had text), and the tool-fail guard only counts *errors* (but the exec
  *succeeded*). New **repeated-action guard**: ismini now tracks a signature of each turn's tool
  actions (name + args); if the *identical* action is issued 3 times in a row, she stops and gives
  you a final summary of what she has + what's still missing — instead of re-doing the same step
  forever. Different files/commands are unaffected. (`agent.js` only.)
- **The "empty response" error no longer blames the context, and ismini retries once.**
  When the model came back with no text and no action, ismini showed
  *"the context may be too large for this model"* — which was a **wrong diagnosis** (in the
  real case the prompt was only ~5.9k tokens on a 32k server; the model had simply stalled).
  That false message sent debugging down the wrong path. Now: (1) the message is honest — it
  says the model stalled and to retry, not that the context is too big; and (2) ismini
  **automatically retries the request once** before giving up, so a single flaky empty response
  no longer kills the whole turn. Real API errors are still surfaced as-is (never retried).
  (`agent.js` only.)
- **A timed-out request no longer ends the turn in silence.** This closed the last gap left by
  the two-phase watchdog above. Even with the 10-min first-token allowance, a request that is
  *genuinely* aborted (a real hang past the limit, or any watchdog trip) used to surface as a
  **"paused"** event — exactly like you had hit the Pause button — so ismini went quiet with no
  reply and the session saved with nothing. That was the "she stops for good until I nudge her"
  symptom. Now `run()` tells the two apart: a **watchdog-triggered** abort routes through the same
  `_forceFinalAnswer` path as the other exits, so ismini shows a banner ("The model stopped
  responding — here's what I have so far") and gives you a real summary of what she'd gathered,
  instead of vanishing. A **user Pause** (or the run timer) still behaves exactly as before — it
  stays "paused", no surprise summary. The watchdog tags its own aborts with a flag so `run()`
  can tell them apart; the summary call gets a fresh abort controller so it isn't instantly
  cancelled by the already-aborted one. (`agent.js` only.)
- **The prompt no longer balloons to 60k+ tokens (the real reason the deep-dive audit failed).**
  This was the last, biggest piece. Even with all the loop/watchdog fixes in, a full-folder audit
  still failed — and now we can see exactly why from llama.log: with context set high (131k), ismini
  kept *every* full file read + exec dump in context, so the prompt grew to **~60k tokens**. At that
  size your local model takes **3–4 minutes just to process the prompt** per turn and then **returns
  empty** (Qwen3.8-27B gave up at 59k tokens). Bionic / LM Studio don't have this because they cap
  how much context they actually *send* (a working window well under the model's max). ismini now does
  the same: a new **`effectiveContextWindow`** caps the per-request send budget at a sane working size
  (default **32k**, independent of the raw llama.cpp context you set via the ctx chip). Old file dumps
  are shrunk to short stubs that keep their `[read …]` / `[exec …]` header, so ismini still knows what
  she's done (the re-read loop stays fixed) but the prompt stays small and fast. Verified against a
  simulation of the real failing audit: the sent prompt drops from **~51k → ~1.5k tokens**, every kept
  tool result still carries its header. Low-RAM / small-model boxes benefit most; if your box + model
  genuinely want more, set `agent.effectiveContextWindow` in config.json to raise it.
- **An empty model reply now recovers smartly instead of failing the turn.** When the model comes back
  with no text and no action (the "stalling" case), ismini used to just re-send the *same* huge prompt,
  which fails identically. Now it **re-asks with a smaller window** (forcing the rolling window to shrink
  old results further) — and if that's still empty, it **forces a final answer from what's already in
  context** instead of ending the turn on an error. So even a genuinely oversized prompt ends with a real
  summary, never silence or a dead-end error. (`agent.js` only.)
- **ismini's internal scaffolding text can no longer leak into her answers.** Under a very large prompt a
  local model occasionally echoed an internal note it saw in context back into its reply (you saw this:
  *"That looks like it leaked from ismini's internal message template"* and a line of agent.js source in
  the bubble). A new `stripInternalNotes()` pass removes any line that is (or starts with) an internal
  marker — `[HARD STOP]`, `[SYSTEM NOTE]`, `[SYSTEM]`, `[ismini]`, `[NEED ANSWER]` — or that merely
  comments on such a leak, from both the normal final answer and the forced-summary path. Normal text is
  untouched. (`agent.js` only.)

### ⚙️ Notes

- `agent.js` — extracted `_forceFinalAnswer(line, note)` (one tool-free streaming call that
  always leaves the user a real assistant message) and wired it into both the max-turns exit
  and the silent-tool-turns exit. Rewrote the `_enforceContextWindow` budget math + added
  `toolResultHeader()` + shrink-instead-of-skip for oversized tool turns. Added the
  two-phase watchdog (`raceWithInactivity` now takes a long first-token allowance) and a
  `_watchdogAborted` flag: when the watchdog (not a user Pause / run timer) aborts a request,
  `run()` routes it through `_forceFinalAnswer` with a fresh abort controller so the turn ends
  with a real summary instead of a silent "paused". The run timeout timer is now `.unref()`ed
  so it can't keep the process alive after the last turn.
- `config.json` — new `agent.maxTurns: 60` and `agent.effectiveContextWindow: 32768` (the cap on
  how much context is actually sent per request, independent of the raw llama.cpp context). As app
  code, config.json is replaced on every upgrade (your old value is backed up to `config.json.bak`).
  If you raise the ctx chip above 32k, the effective cap still keeps prompts in the reliable range;
  set `agent.effectiveContextWindow` explicitly to change that.
- `system-prompt.md` — two Tool-Calling-Discipline rules added: never repeat an action whose
  result is already in context (results are tagged `[read …]` / `[exec …]`), and act on ALL
  files/actions the user lists in one message instead of echoing the list back.
- **Default context raised to 32k.** `config.json` now ships `llamaCpp.context: 32768`,
  `agent.contextWindow: 32768`, and `agent.maxTokens: 32768` (all three kept in sync, exactly
  as the in-app ctx chip sets them). The fallback constant in `llama-backend.js`
  (`_resolveContext`) was raised to match. As app code, config.json is replaced on every
  upgrade (your old value → `config.json.bak`). Verified with a windowing simulation: at 32k,
  three full big-file reads now survive in the rolling window (was zero at 8k), and every
  surviving tool result still keeps its `[read …]` header.
- Passes `node --check` + JSON parse + windowing simulation (5 scenarios, at both 8k and 32k).

## [20.0.0] - 2026-11-13

**Uninstall from the Web UI + a clean shutdown.** ismini now has a proper, reliable
way to say goodbye — and it no longer leaves its model process running in the
background after an uninstall.

### ✨ What's new

- **👋 Uninstall right from the Web UI** — two buttons at the bottom of the
  **⚙️ Settings** popover:
  - **Uninstall (keep my data)** — removes the app code but keeps your chats,
    memory, models, and settings in `~/ismini`. Reinstall any time and ismini
    remembers you.
  - **Uninstall everything** — removes ismini and **all** your data. Cannot be undone.
  - Each opens a clear in-app confirmation dialog (no terminal, no external dialog
    tool — works on every distro), then shows a warm goodbye screen before the
    window closes itself.
- **🧹 Clean shutdown — no more orphaned model process.** The bundled `llama-server`
  (the model) is now killed whenever the Node server exits for **any** reason
  (normal quit, SIGTERM, crash, or uninstall). Previously, if the server died before
  the uninstall script ran, the model process was reparented to systemd and kept
  holding your GPU/RAM forever. Fixed at the source **and** as a safety net in both
  uninstall scripts (which now also kill ismini's own `llama-server`, matching only
  its bundled binary path — LM Studio's or anyone else's is never touched).
- **📄 Reliable uninstall trigger.** The Web UI writes an uninstall-request file that
  the `ismini` launcher checks on every start, so the uninstall completes even if the
  HTTP response to your click is lost. The launcher runs this check before the
  `web.js` existence check (the app code may already be half-gone).

### 🐛 Bug fixes

- **Orphaned `llama-server` after uninstall** — root-caused and fixed (see Clean
  shutdown above). Verified: after a Web-UI uninstall, the model process is gone and
  GPU memory returns to baseline with no manual kill.
- `install.sh` now also makes `uninstall-preserve.sh` executable on install (it was
  copied but not chmod'd).
- `push-to-github.sh` verify list now includes `uninstall-preserve.sh`.

### ✏️ Cosmetic

- **Welcome screen trimmed** — removed the "💬 Want to get to know me a little?…"
  paragraph and the "Type a message — or use the dropdown above to switch brains."
  line. The welcome now shows just ismini's name, her one-line memory intro, and the
  Cogito image. Cleaner and more minimal.

### ⚙️ Notes

- No changes to the agent brain — v18.0.0's audited code ships unchanged.
- This release touches: `web.js` (uninstall endpoint + shutdown handlers),
  `web/index.html` (buttons, confirmation, goodbye, welcome trim), the `ismini`
  launcher (request-file handler), `uninstall.sh` / `uninstall-preserve.sh`
  (`--yes` flag + llama-server kill), `install.sh`, and `push-to-github.sh`.

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