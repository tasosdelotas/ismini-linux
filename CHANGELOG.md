# Changelog

All notable changes to ismini are documented in this file.

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