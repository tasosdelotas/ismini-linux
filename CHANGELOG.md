# Changelog

All notable changes to ismini (Linux) are documented here.

## v13.0.0 - Standalone llama.cpp Integration

### New Features
- **Standalone architecture** — Full standalone operation with embedded Node.js and llama.cpp (no LM Studio required)
- **Vulkan GPU acceleration** — Native Vulkan backend with CPU fallback for all Linux systems
- **GGUF model support** — Load GGUF format models directly from local storage
- **Built-in model manager** — Browse and download models from HuggingFace directly in the UI
- **Internal HTTP API server** — llama.cpp runs as subprocess on port 8080

### Bug Fixes (from v12.0.0)
- **Path sandbox bypass** — Fixed `SENSITIVE_PATTERNS` to match exact path segments instead of substring matches, preventing false positives for legitimate paths like `shadow-game`
- **Context window bypass** — Removed shortcut that skipped token calculation for short histories, ensuring large single messages are properly truncated
- **process.stdout.write encoding fix** — Corrected argument parsing to handle both `(chunk, encoding, callback)` and `(chunk, callback)` signatures
- **memory.js missing import** — Added `unlinkSync` to imports, preventing crashes during failed save cleanup

## v12.0.0 - Major Refactor & Bug Fixes

### Critical Bug Fixes