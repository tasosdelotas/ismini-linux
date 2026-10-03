# Changelog

All notable changes to ismini (Linux) are documented here.

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
