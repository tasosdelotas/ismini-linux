# Changelog

All notable changes to ismini (Linux) are documented here.

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
