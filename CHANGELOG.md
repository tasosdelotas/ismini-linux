# Changelog

All notable changes to ismini (Linux) are documented here.

## v9.0.4

### Changed
- **`.deb` now installs to `~/ismini`** (your home folder), just like `install.sh`. The app is user-owned, so no permission issues with logs, sessions, or memory. Upgrades from the old `/opt/ismini` layout work automatically — data in `~/ismini` is preserved.

## v9.0.3

### Fixed
- **`.deb` install: "ismini did not start" on launch.** The launcher tried to write `ismini.log`/`ismini.pid` next to the app files in `/opt/ismini`, which are root-owned — so startup died before it even began. Log and PID now live in `~/ismini`.
- **Data always lives in `~/ismini`** (sessions, memory) regardless of install method; a one-time migration moves any data saved under the app dir on upgrade. `ISMINI_HOME` can override the location.

## v9.0.2

### Changed
- **Wording cleanup** — the `.deb` description and README no longer say LM Studio "includes everything ismini needs"; ismini stands on its own, LM Studio just provides the model (and a runtime it can use if no system Node.js exists).

## v9.0.1

### Changed
- **"All you need is LM Studio."** The `.deb` description, README, installer and launcher no longer tell newcomers to install Node.js separately — LM Studio ships the runtime ismini uses.
- **The launcher (`ismini`) now finds Node.js automatically.** It prefers a system `node`, then falls back to the one bundled with LM Studio (AppImage, `.deb`/`.rpm` and snap layouts are all probed). If none exists it points you at lmstudio.ai instead of nodejs.org.
- **`install.sh`** uses the same fallback when checking prerequisites.

## v9.0.0

### Added
- **`.deb` package** — install on Ubuntu/Kubuntu/Mint with a double-clickable `ismini_<version>_amd64.deb`, built from the new `packaging/` scripts (`bash packaging/build-deb.sh`). The app installs to `/opt/ismini`; your data stays in `~/ismini`. Full sudo, no sandbox — ismini runs exactly as designed.
- **README "Why ismini?" section** — explains how ismini differs from LM Studio's built-in chat (an agent that acts vs. a chatbot that talks), its minimal-by-design philosophy, and its three hand-crafted themes.

### Changed
- **`uninstall.sh` now handles every install method.** It auto-detects both the `.deb` install (`/opt/ismini`) and the `install.sh` install (`~/ismini`), stops any running server, removes the app and desktop entries, and works on all Linux distros. One uninstaller for everything — no need to remember how you installed.
- **README** now states clearly that ismini runs on every Linux distro (Ubuntu, Kubuntu, Lubuntu, Xubuntu, Mint, Fedora, Arch, openSUSE, …) and documents both install options plus the universal uninstall.

## v8.0.2

### Changed
- **The sudo toggle now controls all approvals.** With it **ON**, exec/write/edit/delete run hands-off with no per-command confirmation prompts — the user has opted into elevated, autonomous operation. Dangerous commands are still silently blocked by the blocklist (that check always runs). With it **OFF**, ismini asks before each exec/write/edit/delete so a normal-user session stays in control. Read and web tools never prompt.
- This removes the annoyance of approving every routine command (including harmless ones) while keeping a clear, single safety switch.

## v8.0.1

### Fixed
- **Streaming duplication** — a bad "streaming feel" change in v8.0.0 re-sent the entire partial line to the UI on every token, so replies cascaded into repeated text (e.g. "Ready to… Ready to help… Ready to help with…"). Removed it; streaming is back to clean line-buffered output.

## v8.0.0

A large stability and security release. This version fixes a long list of bugs found in an external code review, with a focus on reliability (the server no longer freezes or crashes), safety (a confirmation prompt before destructive actions), and correctness across the agent loop, web UI, tools, and installer.

### Security
- **Confirmation prompt** — exec, write, edit, delete, and sudo now require explicit approval in the browser before running. A new `/confirm` endpoint + SSE events drive an approve/ignore dialog with a timeout fallback. This is the primary protection against a malicious web page or file steering the agent.
- `web_fetch` blocks private/loopback IP ranges (127.x, 10.x, 192.168.x, 169.254.x) to stop server-side request forgery and internal data leaks
- Removed the "add NOPASSWD: ALL" hint from the sudo-failure message — it made the whole chain root; the message now explains the safe path instead
- Data files (`sessions.json`, `memory.json`) are written with mode `0600` (owner-only) instead of world-readable `0644`
- Security headers now applied to **every** HTTP response, including static assets (`/live-tts.js`, images, fonts) and the SSE stream — previously only `/` and JSON responses had them

### Fixed
- **Pause / timeouts no longer freeze the server.** `collectProcessTree` re-queued already-found PIDs on every pass, so any command with a child (normal for `sudo`, `&&`, pipes) spun at 100% CPU forever. Now each PID is visited once.
- Closing the last tab mid-task no longer kills the server; shutdown is deferred until the in-flight turn finishes and saves
- A failed session save no longer crashes the server (`runTurn` errors are caught, plus a global `unhandledRejection` net)
- Corrupt `sessions.json` / `memory.json` no longer crash startup — they're preserved (renamed `.corrupt-*`) and the store starts fresh
- The 3-tool-turn hard stop now makes one final model call for an answer instead of ending with none; stale `[SYSTEM]` loop notes are pruned so they don't pile into every later request
- `hadPriorExec` no longer blocks tools for the whole conversation — it's scoped to the turn that ran exec, so multi-step tasks proceed
- Tool output is capped (`MAX_TOOL_OUTPUT`) so a 60 MB read can't blow out the context window and session file
- Heading formatter no longer mangles titles containing `-`, `*`, or `+` (e.g. `## Self-hosted setup`, `## C++ basics`)
- A killed command now reports its real exit signal instead of "exited with code null"
- Pausing mid tool-batch backfills placeholder results for orphaned `tool_calls` so strict servers don't reject the next request
- Model completion uses an inactivity timeout (2 min) instead of a 300 s total cap, so slow local models aren't cut off
- Greek / non-Latin memory search now works (tokenization was ASCII-only)
- `web_fetch`: no longer flags normal pages as bot-walled just because the footer mentions reCAPTCHA; decodes ISO-8859-7 and other charsets correctly; fixes double-decoding of HTML entities; clearer error messages
- The quadratic `<script|style>` strip that froze the server on large pages is now linear
- `~/…` paths are expanded in read/write/edit/delete (previously resolved to `$HOME/~/…`)
- Multibyte output no longer corrupts at chunk boundaries (`setEncoding('utf8')`)
- `edit` replaces only the first occurrence by default (pass `replaceAll:true` for all) instead of silently replacing every match
- Context budget now uses a realistic chars/token estimate from the detected model instead of always assuming 1.5
- `cleanupModelOutput` no longer turns a lone "Hi!" into an empty string or "…anything else" into "Sure,"
- **Auto-sudo prefix** now wraps compound commands as `sudo -n sh -c '<cmd>'` so `cd x && make`, redirects, and multi-part commands all run correctly (previously only the first word was elevated)
- Stdin is set to `ignore` for exec so commands that read stdin (`cat`, `[Y/n]` prompts) don't hang until the 1-hour timeout
- **Front-end rendering:** numbered lists keep their numbers, tables render as aligned rows instead of raw `|` lines, and a failed send no longer clears your typed text. Streaming flushes long single-line paragraphs as they grow instead of all at once. Other tabs now rebuild when a session is switched elsewhere.
- Launcher (`ismini`) shows a GUI error dialog (zenity/kdialog) when Node or xdg-open is missing, logs to the app folder instead of world-readable `/tmp`, and accepts `--port`

### Added
- **Tests & packaging** — added an `npm test` script (works on Node 22+) and a new test file covering exec, SSRF protection in web_fetch, streaming, and server syntax. Existing regression tests updated to match the graceful-recovery behavior.
- `.gitattributes` with `eol=lf` so line endings stay consistent across platforms
- `temperature` and `maxTurns` are now configurable via `config.json`
- Thinking/reasoning is disabled for all models (Qwen3's `enable_thinking=false` plus the standard off flags)

### Changed
- README wording corrected: security headers described accurately, and the command blocklist is framed as a best-effort guard rather than an absolute boundary
- Upgrades merge newly-added default tools into an existing `config.json` so memory/delete tools get enabled without replacing your config
- `uninstall.sh` backs up `sessions.json` / `memory.json` before deleting them and asks for confirmation
- Installer uses `xdg-user-dir DESKTOP` (works on Greek/translated desktops) and no longer uses `exec bash` so the retry hint can print

## v7.1.0

### Security
- Broadened dangerous-command blocks: `rm -rf /` variants with swapped flag order (`rm -fr /`), trailing arguments (`--no-preserve-root`), wildcard (`rm -rf /*`), and `find / … -delete` are now all blocked
- `chmod -R 777 /` (and other flag-prefixed variants) is now blocked
- Added security headers to all HTTP responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
- SSE broadcast now enforces backpressure — slow clients with >1 MiB buffered are dropped instead of accumulating unbounded data in memory
- Oversized request bodies now destroy the socket immediately instead of letting the client keep sending

### Fixed
- Model output cleanup no longer strips a standalone `hi!` / `hello!` from the middle of a response (regex was anchored to any line via `/m`; now anchored to string start only)
- Duplicate system prompts no longer accumulate in memory across turns (each `run()` call was prepending another copy; now checks before injecting)
- `delete` tool returns a clear error when given a directory path, directing the model to use `exec` with `rm -rf` instead of failing with an opaque `ENOTDIR`
- `read` tool now blocks binary file types (PDF, ZIP, archives, executables, media, design files) with a helpful suggestion, instead of returning garbled UTF-8 mojibake that wastes context window
- Removed redundant `max_completion_tokens` from the API request body (was sent alongside `max_tokens`, which some backends reject)
- Process kill on pause/timeout now sends SIGTERM first, waits 2 seconds, then escalates to SIGKILL — well-behaved processes get a chance to flush files and clean up
- CORS origin check now accepts `https:` in addition to `http:` (supports local reverse-proxy setups)
- `memory_add` on an existing fact now bumps its `updatedAt` timestamp so search ranking reflects recency
- Session store validates that every message has a valid `role` field on load, preventing malformed entries from reaching the agent loop
- DuckDuckGo parser failure message now hints that the page structure may have changed and suggests `web_fetch` as a fallback
- `install.sh` prints a clear retry instruction if the post-copy setup step fails
- `publish.sh` falls back to sequential `git push` when Git < 2.19 is detected (no `--atomic` support)
- Fixed CRLF line endings in `uninstall.sh` that broke bash `for` loops on Linux

### Changed
- Web markdown renderer now supports 4-space indented code blocks (previously only fenced ```` ``` ```` blocks were recognized)
- Removed unused `braceDepth` variable from the tool-list stripper (dead code)

## v7.0.0

### Fixed
- Live Chat now speaks each final response once instead of restarting playback; intermediate tool-preface text is not spoken
- Live Chat waits for speech recognition to end before starting TTS, with a bounded timeout fallback

## v6.0.4

### Added
- Attach JPEG, PNG, WebP, or GIF images up to 4 MiB to chat; images are sent to LM Studio and persisted in local session history
- Running application version badge in the bottom-right corner of the web interface

### Changed
- Detect LM Studio vision model metadata and guide image-capable models to analyze attached images without false no-vision refusals
- Updated the image-file read response to direct users to attach the image in chat
- Installer upgrades stop the running app before replacing files, fail clearly if it cannot stop, and preserve config, session, and memory data

## v5.0.0

### Added
- 🧠 **Local long-term memory** — tiny dependency-free `memory.json` store with `memory_add`, `memory_search`, and `memory_delete` tools, enabled by default in `config.json`
- Memory usage guidance and privacy guardrails in the agent's system prompt (never store passwords, tokens, secrets, keys, or credentials)

### Changed
- Session, transcript, and status APIs now expose only user-visible messages; internal loop-control prompts are kept out of the UI and saved chat history
- `publish.sh` excludes personal `memory.json` as well as `sessions.json`

### Fixed
- Legacy `[NEED ANSWER]` prefixes are cleaned from stored tool output when sessions are loaded or served
- Session counts, previews, and transcript resync no longer include hidden internal messages
- Transcript/session endpoints normalize assistant messages with missing content, preventing client-side rendering errors

## v4.0.0

### Added
- 🏛️ **Greek meander border** — classic thunder-pattern frames the left and right edges of the interface (fixed, stays in place while scrolling)
- 🖼️ **ismini 3D banner** — 3D rendered logo in the header
- ✨ **"Cogito, ergo sum"** — welcome screen greeting

### Fixed
- **Pause button behavior** — fixed pause/redirect flow
- **Blank area at bottom** — removed footer gradient that was painting over the theme background (present since v2)
- **300s timeout** — now aborts the in-flight model stream (previously the request kept running in the background, and late output could bleed into the next turn)
- **Non-streaming JSON response** — now displayed in the UI (previously invisible until transcript reload)
- **STT / Live mode** — `no-speech` errors no longer stop microphone listening while Live mode is active
- **Edit tool** — rejects empty `oldText` (previously could insert text between every character in a file)

## v3.0.0 (2026-08)

### Added
- 🎙️ **Dictation** — speech-to-text via Web Speech API
- 🔊 **Text-to-Speech (TTS)** — ismini reads replies aloud with voice selection
- 🎧 **Live Chat** — continuous voice conversation mode
- 🧠 **Memory** — persistent facts across sessions
- 📋 **Sessions** — current + 3 archived conversations
- 🎨 **Three themes** — Papyrus, Stars, Marble
- 📁 **Folder picker button** alongside file picker
- Sudo ON/OFF toggle in header

### Changed
- Single in-memory session (session IDs removed)
- Web tools: soft nudge instead of permanent tool removal
- System prompt trimmed for efficiency

### Fixed
- Sudo toggle OFF now strips/blocks model-written sudo
- Web tools no longer vanish mid-session
- exec blocks curl/wget (use web_search/web_fetch instead)
- Connection health check verifies model is loaded
- Tool path resolution from ismini's own directory
- Edit tool: replace ALL occurrences + warns on >5 matches

## v2.x

### Added
- Three themes (Papyrus, Stars, Marble)
- File picker button
- Web search & fetch tools

## v1.0.0

- Initial release — minimal local agent runtime
