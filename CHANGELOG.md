# Changelog

All notable changes to ismini (Linux) are documented here.

## v11.0.0 - Model Switching & Web UI Improvements

### New Features
- **Auto-update mechanism** — Click Update button to automatically download and install new versions without manual downloads
- **Model switching dropdown** — Added a dropdown menu in the web UI header that shows all models available from LM Studio; users can switch between any model without restarting ismini
- **Automatic context adaptation** — When switching models, ismini automatically detects and adjusts context window limits based on the newly loaded model's capabilities
- **Model capability detection** — Runtime detection of tool_use and vision support for each model, adapting features accordingly
- **Multi-port fallback** — Model list endpoint tries configured URL first, then falls back to port 1234 if that fails (helps when LM Studio changes ports)
- **Simplified model names in dropdown** — Dropdown displays only the model name after the last `/` (e.g., `qwen3-coder-next` instead of `qwen/qwen3-coder-next`)

### Technical Improvements
- **SSE hello event enhanced** — Server now includes full model list in initial SSE connection, eliminating an extra round-trip request for model data
- **API endpoint refactor** — Added `/api/models` (GET) and `/api/model/switch` (POST) endpoints with robust error handling and version-compatible LM Studio API support (both v0 and v1)
- **Model switching flow** — Unloads current models before loading target, waits briefly for cleanup, then updates agent configuration

### Bug Fixes
- **Console log filtering** — Added `[ismini]` prefix to stdout filter to prevent model switch debug messages from appearing in web chat

### Files Changed
- `agent.js`: Improved exec command parsing to accept multiple formats (command/cmd/text/first positional)
- `web.js`: Implemented `/api/models`, `/api/model/switch`, and `/api/download-update` endpoints (~280 lines added), SSE hello event with models array, stdout filter for `[ismini]` logs
- `web/index.html`: Added dropdown UI element, `loadModels()` function, model switching handler, simplified name display logic
- `config.json`: Updated version to 11.0.0 (manual update required)
- `package.json`: Version bumped to 11.0.0
- `README.md`: Updated version reference and added model switching feature bullet point

## v10.0.15 - Major Security and Stability Release

### Security Fixes (Critical)
- **Auto-update endpoint removed** — Completely removed `/api/update/check` and `/api/update/install` endpoints to prevent Remote Code Execution via MITM attacks
- **Path sandboxing with realpathSync** — Added symlink resolution before security checks to prevent path traversal bypasses through symlinks
- **Added /dev to blocked paths** — Extended blocklist to include `/dev` directory for comprehensive protection
- **Strict base64 validation** — Added padding length check (must be multiple of 4) in image input to prevent malformed data

### Bug Fixes
- **Session limit stable sort** — Fixed unstable sorting when sessions have identical timestamps using UUID as secondary key
- **Memory search async** — Converted synchronous search to chunked async processing to prevent event loop blocking during chat turns
- **CLI port parsing improved** — Added validation for `--port` flag and bare port numbers with clear error messages (1-65535 range)
- **DuckDuckGo HTML parsing** — Made attribute order agnostic in regex to handle DDG DOM changes
- **Uninstall script improvements** — Better PID verification with executable path checking and fuser command safety

### Improvements
- **Path sandboxing enhanced** — Now resolves symlinks before checking against blocklist, preventing symlink attacks
- **Better error handling** — Added proper validation for port numbers with descriptive error messages
- **Test coverage expanded** — Added tests for session limit enforcement and symlink sandboxing
- **Semver comparison fixed** — Replaced `sort -V` with Node.js-based semver comparison in publish.sh to handle edge cases like 1.10.0 vs 1.9.0 correctly

### Files Changed
- `agent.js`: Path sandboxing with realpathSync, /dev blocking
- `web.js`: Removed auto-update endpoints (~140 lines), restored file/folder picker handler  
- `sessions.js`: Stable sort in `_enforceLimit()` with UUID secondary key
- `memory.js`: Async search with chunked processing and `setImmediate()`
- `image-input.js`: Strict base64 padding validation
- `install.sh`: Added recursion guard to prevent infinite loops, better port parsing
- `uninstall.sh`: Improved PID verification and fuser command safety
- `ismini`: Enhanced CLI argument parsing with validation
- `web/index.html`: Fixed missing input keydown event listener, removed update button
- `publish.sh`: Node.js-based semver comparison for reliable version ordering
- `package.json`: Added metadata (description, author, license) and engines constraint
- `test/*.test.js`: Added tests for new functionality

All tests pass (24/24).

## v10.0.14 - Bug Fixes

### Fixed
- **Duplicate API endpoints** — Removed duplicate `/api/update/check` and `/api/update/install` endpoints that were causing WebUI issues
- **autosize() closing brace** — Fixed missing closing brace in the `autosize()` function that was breaking JavaScript syntax
- **Extra closing brace** — Removed stray `}` that was causing a "Missing catch or finally after try" error
