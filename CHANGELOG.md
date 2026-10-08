# Changelog

All notable changes to ismini (Linux) are documented here.

## v10.0.0 - Major Security and Stability Release

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

### Files Changed
- `agent.js`: Path sandboxing with realpathSync, /dev blocking
- `web.js`: Removed auto-update endpoints (~140 lines), improved stdout buffer handling  
- `sessions.js`: Stable sort in `_enforceLimit()` with UUID secondary key
- `memory.js`: Async search with chunked processing and `setImmediate()`
- `image-input.js`: Strict base64 padding validation
- `install.sh`: Better port parsing, desktop entry path validation
- `uninstall.sh`: Improved PID verification and fuser command safety
- `ismini`: Enhanced CLI argument parsing with validation
- `web/index.html`: Removed update button and `checkForUpdates` function
- `test/*.test.js`: Added tests for new functionality

All tests pass (24/24).

## v10.0.15 - Bug Fixes

### Fixed
- **Duplicate API endpoints** — Removed duplicate `/api/update/check` and `/api/update/install` endpoints that were causing WebUI issues
- **autosize() closing brace** — Fixed missing closing brace in the `autosize()` function that was breaking JavaScript syntax
- **Extra closing brace** — Removed stray `}` that was causing a "Missing catch or finally after try" error
