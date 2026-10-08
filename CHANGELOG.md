# Changelog

All notable changes to ismini (Linux) are documented here.

## v10.0.15 - Bug Fixes

### Fixed
- **Duplicate API endpoints** — Removed duplicate `/api/update/check` and `/api/update/install` endpoints that were causing WebUI issues
- **autosize() closing brace** — Fixed missing closing brace in the `autosize()` function that was breaking JavaScript syntax
- **Extra closing brace** — Removed stray `}` that was causing a "Missing catch or finally after try" error

## v10.0.0 - Major Security and Stability Release