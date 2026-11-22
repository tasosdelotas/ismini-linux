# BUILD-APPIMAGE — how to ship a new ismini version (step by step, every release)

> **Read this before repackaging.** This is the complete, verified procedure. The heavy
> lifting lives in `push-to-github.sh` (single source of truth) — this recipe tells you what
> to do around it and WHY each piece exists. (Extracted from HANDOFF.md 2026-11-22 so the
> recipe has its own home; keep both in sync if either changes.)

## What gets published (the shape)

- **GitHub repo** = SOURCE ONLY (`.js`, `install.sh`, `install-ismini.sh`, `web/`,
  `config.json`, docs…). NEVER `node/` or `llama-cpp/` (GitHub hard-blocks regular files
  >100 MiB; `node/bin/node` is ~144 MB). No Git LFS — LFS would make the auto "Source code
  (zip)" contain ~130-byte pointer files = broken installs.
- **GitHub Release assets** (2 of them, same version):
  1. `ismini-vX.Y.Z-linux-x64.AppImage` (~94 MB) — **newcomer path**: double-click installer
     (fat script + tar.gz payload; no FUSE).
  2. `ismini-vX.Y.Z-linux-x64.zip` (~94 MB compressed) — **power-user path**: extract +
     `install.sh`. Kept for scripts/automation and as the updater's fallback for old releases.
- Both assets contain the SAME tree: source + real `node/` + real `llama-cpp/`, under a
  top-level `ismini/` folder.

## Step-by-step (do these in order)

1. **Code is final in `/home/tasos/Labor/ismini-linux/`.** All changes made + verified
   (`node --check` / `bash -n`). Nothing half-done.
2. **Bump the version** in `package.json` ONLY (e.g. 21.0.0 → 22.0.0). The script reads it
   from there; it becomes tag `vX.Y.Z` and both asset names.
3. **CHANGELOG.md** — new entry at the top: `## [X.Y.Z] - YYYY-MM-DD` + what changed.
4. **README.md** — only if user-facing behavior/setup changed (version line in the header
   too). For pure bug-fix releases the README often needs no change.
5. **HANDOFF.md** — update "Current state" (standing rule: every fix/change gets recorded
   there so a fresh session never re-learns context).
6. **Local sanity pass:**
   - `bash -n install.sh install-ismini.sh uninstall.sh uninstall-preserve.sh push-to-github.sh ismini`
   - `./node/bin/node --check web.js agent.js llama-backend.js sessions.js memory.js image-input.js tools/*.js web/live-tts.js`
7. **(Optional but recommended for packaging changes)** build a test AppImage locally and
   double-click it in the desktop session:
   ```
   TMP=$(mktemp -d); mkdir -p $TMP/stage/ismini
   rsync -a --exclude='HANDOFF.md' --exclude='push-to-github.sh' --exclude='.git' \
     --exclude='__pycache__' --exclude='*.pyc' /home/tasos/Labor/ismini-linux/ $TMP/stage/ismini/
   cp install-ismini.sh $TMP/test.AppImage
   tar -czf $TMP/p.tar.gz -C $TMP/stage ismini && cat $TMP/p.tar.gz >> $TMP/test.AppImage
   chmod +x $TMP/test.AppImage   # → double-click it on the desktop
   ```
   Note: `BUILD-APPIMAGE.md` ships in the payload (it's just a doc — harmless either way).
   The payload MUST include `web/Golden_Temple.mp4` (ships automatically via tar).
8. **PUBLISH (only when tasos explicitly says go):**
   ```
   cd /home/tasos/Labor/ismini-linux && export GITHUB_TOKEN=<token> && bash push-to-github.sh
   ```
   What the script does (no manual steps): clone repo → wipe tracked files → rsync SOURCE
   (excluding node/, llama-cpp/, HANDOFF.md, push-to-github.sh) → verify core files present
   (incl. `install-ismini.sh`) → commit + push → stage FULL tree (source+binaries) → build
   `.zip` (step 5a) → build `.AppImage` = `install-ismini.sh` + tar.gz payload, validate its
   script part with `bash -n` (step 5b) → create/fetch release tag → upload BOTH assets
   (`--data-binary`, fresh `upload_url`, delete-old-asset-first) → verify each by size from
   the UPLOAD RESPONSE (listing-poll fallback) → clean up temp dirs.
9. **Verify on GitHub:**
   ```
   curl -fsSL -H "Authorization: token $GITHUB_TOKEN" \
     api.github.com/repos/tasosdelotas/ismini-linux/releases/latest
   ```
   Both assets present with real sizes (~94 MB each, NOT 0 / NOT pointer-file sizes).
10. **End-to-end proof (tasos's rule: verify every upload):** download the `.AppImage` from
    the release on a clean path (or in the test copy), double-click it, confirm install +
    dialogs + desktop icon. For the in-app Update button: run an old-version install and
    click Update → it should pick the AppImage asset, install, and say "close and reopen".

## Gotchas (learned the hard way — do not relearn)

- **`upload_url` is one-shot.** Always take it from the FRESH create/GET response; strip the
  `?name={name}&label={label}` template before appending `?name=<asset>`.
- **Delete pre-existing same-named asset first** (by asset ID) or re-upload 422s.
- **`--data-binary @file`, never `-d`** (large bodies mangle as form fields).
- **Verify via the upload RESPONSE** (GitHub echoes the created asset's real size). The
  release LISTING lags right after big uploads and returns size 0 → false failure.
- **The AppImage's script part must pass `bash -n` AFTER building** — the marker line is
  found with `grep -an "^__ISMINI_PAYLOAD_BELOW__$"` (anchored: the unanchored pattern also
  matches the `MARKER="…"` variable definition inside the script, which silently breaks the
  split). The payload must start on the line AFTER the marker.
- **`install-ismini.sh` must stay in the repo** (it's app code now) AND in the asset stage
  (the zip contains it too — harmless; the AppImage is built FROM it).
- **The updater (`web.js`) prefers `.AppImage`, falls back to `.zip`.** If you ever rename
  the assets, update the regexes there (`/\.AppImage$/i`, `/\.zip$/i`) or v19+ users can't
  update.
- **`--no-stop` pass-through:** `install-ismini.sh` forwards all its args to `install.sh`
  (`INSTALL_ARGS`). The in-app updater relies on this. Don't "simplify" the arg loop away.
- Source folder is NEVER a git repo — the script clones fresh every time; don't `git init`
  it.
