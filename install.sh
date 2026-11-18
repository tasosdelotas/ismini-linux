#!/bin/bash
# ismini installer: puts the app in ~/ismini and installs the launcher.
# Run it from anywhere — the extracted zip folder, a git clone, wherever.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# Resolve $DEST to its canonical path (symlinks resolved). If $HOME traverses a
# symlink (e.g. /home/user -> /mnt/home/user), an unresolved "$HOME/ismini" would
# differ from the resolved $DIR as a string, so running bash ~/ismini/install.sh
# would take the copy branch and rm -rf its own node/ + llama-cpp/. Resolving both
# sides makes DIR == DEST in that case.
DEST="$(cd "$HOME" 2>/dev/null && pwd)/ismini"
[ -n "$DEST" ] || DEST="$HOME/ismini"

# --no-stop: do NOT kill the running ismini server. Used by the in-app updater, which
# IS the running server — install.sh killing it would abort the update mid-flight.
NO_STOP=0
for arg in "$@"; do
  case "$arg" in
    --no-stop) NO_STOP=1 ;;
    *) echo "ERROR: unknown option '$arg' (expected --no-stop)." >&2; exit 2 ;;
  esac
done

running_app_pids() {
  local proc pid arg
  local -a argv
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    argv=()
    mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || true
    for arg in "${argv[@]}"; do
      if [ "$arg" = "$DEST/web.js" ]; then
        pid="${proc##*/}"
        printf '%s\n' "$pid"
        break
      fi
    done
  done
}

stop_running_app() {
  local pid attempt
  local -a pids
  mapfile -t pids < <(running_app_pids)
  [ "${#pids[@]}" -gt 0 ] || return 0
  echo "Stopping the running ismini app before replacing its files..."
  for pid in "${pids[@]}"; do
    if ! kill "$pid" 2>/dev/null; then
      echo "ERROR: could not stop ismini (PID $pid); no app files were replaced." >&2
      exit 1
    fi
  done
  for attempt in {1..20}; do
    mapfile -t pids < <(running_app_pids)
    [ "${#pids[@]}" -eq 0 ] && return 0
    sleep 0.25
  done
  echo "ERROR: ismini is still running; close it and retry. No app files were replaced." >&2
  exit 1
}

# ── Shared desktop-entry + icon setup (used by BOTH the copy branch and the
#    in-place branch). Previously this ~100-line block was duplicated verbatim in
#    both paths, so a fix applied to one never reached the other. ──────────────
register_desktop_entries() {
  local APP_DIR="$1"
  local DESKTOP_DIR EXEC_PATH ICON_PATH

  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
    DESKTOP_DIR="$HOME/Desktop"
  fi

  EXEC_PATH="$APP_DIR/ismini"
  ICON_PATH="$APP_DIR/ismini.png"

  if [ ! -x "$EXEC_PATH" ]; then
    echo "WARNING: $EXEC_PATH not executable — desktop entry may fail" >&2
  fi
  if [ ! -f "$ICON_PATH" ]; then
    echo "WARNING: $ICON_PATH not found — icon will be missing from launcher" >&2
    ICON_PATH=""
  fi

  # ── Register the icon in the hicolor theme under the exact WM_CLASS name ──
  # KDE/GNOME match a window's WM_CLASS ("ismini", set by the launcher's
  # --class=ismini) against an icon *name*. Without an icon literally named
  # "ismini" in the theme, the taskbar falls back to a generic placeholder.
  if [ -n "$ICON_PATH" ] && [ -f "$ICON_PATH" ]; then
    local HC_ICON_DIR="$HOME/.local/share/icons/hicolor"
    # The app ships ONE square master icon (ismini.png, 512×512 statue).
    # Render every hicolor size from it with ImageMagick when available
    # (-filter BEFORE -resize; fit+pad, never crop — the head stays intact);
    # otherwise a raw copy (the WM downscales — soft, but functional).
    local APPICON_SRC="$ICON_PATH"
    local px
    for px in 16 22 24 32 48 64 128 256 512; do
      mkdir -p "$HC_ICON_DIR/${px}x${px}/apps"
      if command -v convert >/dev/null 2>&1; then
        # Fit-to-square with padding (never crop — the head stays intact).
        # NOTE: -filter MUST come BEFORE -resize to actually affect it.
        convert "$APPICON_SRC" -filter Lanczos -resize ${px}x${px} \
          -background transparent -gravity center -extent ${px}x${px} \
          -define png:color-type=6 \
          "$HC_ICON_DIR/${px}x${px}/apps/ismini.png" 2>/dev/null \
          || cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/ismini.png"
      else
        cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/ismini.png"
        echo "NOTE: ImageMagick not found — ${px}px icon may look soft."
      fi
    done
    gtk-update-icon-cache "$HC_ICON_DIR" >/dev/null 2>&1 || true
    # Bust any stale desktop icon caches so the WM picks up the new icon immediately.
    rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
    find "$HOME/.cache" -maxdepth 2 -name 'icon-cache.*' -delete 2>/dev/null || true
    echo "Icon registered in hicolor theme as square 'ismini' icons (caches refreshed)."
  fi

  # Write the .desktop entry to a given dir. Quoted Exec= so paths with spaces
  # are valid; Icon= only when we actually have an icon.
  _write_desktop_file() {
    local target_dir="$1"
    [ -d "$target_dir" ] || return 1
    cat > "$target_dir/ismini.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=ismini
Comment=Minimal local AI agent (Web UI)
Exec="$EXEC_PATH"
$([ -n "$ICON_PATH" ] && echo "Icon=$ICON_PATH")
Terminal=false
Categories=Development;Network;Utility;
StartupWMClass=ismini
EOF
    chmod +x "$target_dir/ismini.desktop"
  }

  if _write_desktop_file "$DESKTOP_DIR"; then
    gio set "$DESKTOP_DIR/ismini.desktop" metadata::trusted true 2>/dev/null || true
    echo "Desktop launcher installed: $DESKTOP_DIR/ismini.desktop"
  else
    echo "NOTE: no desktop folder found."
  fi

  if [ -d "$HOME/.local/share/applications" ]; then
    _write_desktop_file "$HOME/.local/share/applications"
    if command -v desktop-file-validate >/dev/null 2>&1; then
      if ! desktop-file-validate "$HOME/.local/share/applications/ismini.desktop" 2>/dev/null; then
        echo "WARNING: desktop file validation failed"
      fi
    fi
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    echo "App menu entry installed."
  fi
}

# ── Prerequisite: ismini's OWN bundled Node (18+) — no system Node is used ──
# ismini is 100% self-contained: it ships Node in the 'node/' folder and runs on
# that binary only. The installer therefore REQUIRES the bundled Node and never
# falls back to a system-wide node (that fallback was a leftover from when ismini
# borrowed LM Studio's Node).
node_path=""
if [ -x "$DIR/node/bin/node" ]; then
  node_path="$DIR/node/bin/node"
fi
# NOTE: the legacy `node-v*-linux-x64/` layout is intentionally NOT accepted here.
# It used to be, but the post-install integrity check demands $DEST/node/bin/node,
# so a source with only the legacy folder would pass this gate, get its old Node
# deleted, copy node-v* over, then FAIL the check and exit — destroying a working
# install. Require the canonical 'node/' layout (the error below explains it).
if [ -z "$node_path" ]; then
  echo
  echo "ERROR: ismini's bundled Node.js was not found."
  echo "ismini must include its own Node in the 'node/' folder (node/bin/node)."
  echo "(ismini does NOT use a system Node.js — that is by design.)"
  echo
  echo "Fix: download a Node.js 18+ linux-x64 build from https://nodejs.org/, extract it,"
  echo "and place the extracted folder as './node' inside the ismini source folder."
  exit 1
fi

node_version="$("$node_path" --version 2>/dev/null || echo v0.0.0)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac

if [ "$node_major" -lt 18 ]; then
  echo
  echo "ERROR: bundled Node.js is $node_version, but ismini needs 18 or newer."
  echo
  echo "Replace the bundled Node: download Node.js 18+ (linux-x64) from https://nodejs.org/,"
  echo "extract it, and put the folder in place as './node' inside the ismini source folder."
  exit 1
fi

echo "Node.js $node_version found - OK."

# ── Source integrity: verify the SOURCE is complete BEFORE deleting anything ──
# The copy branch below rm -rf's the user's node/ + llama-cpp/ + bin/ and then tars
# the source over them. With `set -euo pipefail`, any tar failure (disk full,
# unreadable file, Ctrl-C) aborts right there — leaving the user with no Node and
# no llama-server and no recovery path. So we refuse to touch an existing install
# unless the source folder has every file the app needs at import time. This list is
# the module-load chain (web.js -> agent.js -> ./tools/*) plus the bundled Node, so a
# partial source can't pass the gate and then crash on launch.
for REQ in web.js agent.js llama-backend.js sessions.js memory.js image-input.js \
           system-prompt.md ismini web/index.html web/live-tts.js \
           tools/web-fetch.js tools/web-search.js tools/weather.js node/bin/node; do
  if [ ! -e "$DIR/$REQ" ]; then
    echo "ERROR: source folder is missing '$REQ'." >&2
    echo "       Refusing to touch your existing install. Re-run from the complete release folder." >&2
    exit 1
  fi
done

# ── Version check (optional enhancement) ────────────────────────────────────
if [ "$DIR" != "$DEST" ] && [ -f "$DEST/package.json" ]; then
  SRC_VER=$("$node_path" -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/package.json','utf8')).version)" 2>/dev/null || echo "unknown")
  DST_VER=$("$node_path" -e "console.log(JSON.parse(require('fs').readFileSync('$DEST/package.json','utf8')).version)" 2>/dev/null || echo "none")
  if [ "$SRC_VER" != "$DST_VER" ]; then
    echo "Installing $SRC_VER over $DST_VER"
  fi
fi

# ── Copy application files ──────────────────────────────────────────────────
# In-place upgrades (reinstalling over an existing ~/ismini) are fully supported:
# we overwrite the app code, PRESERVE the user's data (config, sessions, memory,
# downloaded models), and — critically — REMOVE stale files that were in the old
# install but not the new one (e.g. renamed/removed llama-cpp .so libs, an old
# node-v* folder). That keeps a reinstalled ismini byte-identical to a fresh one.
# Capture whether this is an in-place upgrade BEFORE we copy anything (the old test
# ran after `cp config.json`, so it was always true and a fresh install printed
# "In-place upgrade complete"). sessions.json only ever exists on a real prior install.
WAS_UPGRADE=0
[ -f "$DEST/sessions.json" ] && WAS_UPGRADE=1

if [ "$DIR" != "$DEST" ]; then
  [ "$NO_STOP" = "1" ] || stop_running_app
  mkdir -p "$DEST"

  # ── Clean up code dirs that can CHANGE SHAPE between versions ──────────
  # These are 100% app-owned (no user data), so it's safe to nuke + re-copy the
  # exact set the new version ships. Without this, a stale lib or old Node build
  # could survive an in-place upgrade and break the app.
  for CODE_DIR in llama-cpp node bin; do
    if [ -e "$DEST/$CODE_DIR" ]; then
      rm -rf "$DEST/$CODE_DIR"
    fi
  done
  # A legacy version-named Node folder (pre-fixed-node/ era) — remove so the
  # new 'node/' folder is the only Node present.
  rm -rf "$DEST"/node-v*-linux-x64 2>/dev/null || true
  rm -rf "$DEST"/node-v*-linux-x64.bak-old 2>/dev/null || true

  # Exclusions = everything that is USER STATE, not app code. The old list was
  # missing several that matter:
  #   ./.uninstall-request -> the launcher checks it on EVERY launch; if a stray one
  #     ships in the source tree, the freshly installed app uninstalls itself at once.
  #   ./models             -> overwrites the user's models/installed.json (their
  #     downloaded models vanish) and can copy tens of GB of GGUFs. mkdir -p below
  #     recreates an empty dir, so excluding it preserves their models correctly.
  #   ./hf-token           -> a credential; copying it overwrites the user's own token.
  #   ./llama-state.json   -> ships our last-loaded model path; ismini then tries to
  #     load a file that doesn't exist on their box.
  #   logs                 -> ours would overwrite theirs (llama.log can hold audited content).
  tar -C "$DIR" \
      --exclude='./.git' \
      --exclude='./sessions.json' \
      --exclude='./sessions.json.*' \
      --exclude='./memory.json' \
      --exclude='./memory.json.*' \
      --exclude='./memory.md' \
      --exclude='./skills' \
      --exclude='./greeting-state.json' \
      --exclude='./push-to-github.sh' \
      --exclude='./.uninstall-request' \
      --exclude='./models' \
      --exclude='./hf-token' \
      --exclude='./llama-state.json' \
      --exclude='./ismini.log' --exclude='./ismini.log.old' \
      --exclude='./llama.log' --exclude='./llama.log.old' \
      --exclude='./server.pid' --exclude='./server.log' --exclude='./server.log.old' \
      --exclude='./config.json.bak' \
      --exclude='*.corrupt-*' \
      --exclude='./node_modules' \
      -cf - . | tar -C "$DEST" -xf -

  # Create memory.md template on fresh install.
  # On in-place upgrade ($DIR == $DEST) the tar exclude above already preserves
  # the user's memory.md, so we skip the copy entirely — no self-copy, no risk.
  if [ "$DIR" != "$DEST" ] && [ ! -f "$DEST/memory.md" ]; then
    cp "$DIR/memory.md" "$DEST/memory.md" 2>/dev/null || true
  fi

  chmod +x "$DEST/ismini" "$DEST/install.sh" "$DEST/uninstall.sh" "$DEST/uninstall-preserve.sh" 2>/dev/null || true

  # llama-server lives at llama-cpp/llama-server (flat, current) or llama-cpp/bin/llama-server
  # (older bin/ layout) — make whichever is present executable, and drop the now-obsolete
  # empty bin/ dir the old layout left behind.
  if [ -f "$DEST/llama-cpp/llama-server" ]; then
    chmod +x "$DEST/llama-cpp/llama-server"
  elif [ -f "$DEST/llama-cpp/bin/llama-server" ]; then
    chmod +x "$DEST/llama-cpp/bin/llama-server"
  elif [ -f "$DEST/bin/llama-server" ]; then
    chmod +x "$DEST/bin/llama-server"
  fi

  mkdir -p "$DEST/models"

  # ── config.json: MERGE, don't blindly replace ────────────────────────────
  # config.json is app code (tracks the release, like system-prompt.md) BUT web.js
  # also WRITES it at runtime for user-owned settings: the sudo toggle, window size,
  # and the context length the user tuned for their RAM. A blind `cp` on every
  # upgrade wiped all of those — resetting the context length (and re-introducing the
  # history-starvation arithmetic) each time. So we MERGE: start from the NEW release
  # defaults, then overlay only the user's known runtime-tuned keys if they exist.
  #   - New/renamed keys  -> adopt the release default (so a new feature is enabled).
  #   - Removed tools     -> gone (we don't copy the old 'tools' wholesale).
  #   - User tuning       -> preserved (context, maxTokens, sudo, windowSize).
  # The previous config is still backed up to config.json.bak first.
  if [ -f "$DEST/config.json" ]; then
    cp "$DEST/config.json" "$DEST/config.json.bak" 2>/dev/null || true
  fi
  if [ ! -f "$DIR/config.json" ]; then
    echo "ERROR: source is missing config.json — cannot build the install config." >&2
    exit 1
  fi
  "$node_path" -e '
    const fs = require("fs");
    const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
    const base = read(process.argv[1]);                 // NEW release defaults
    const old  = read(process.argv[2]);                 // the installed config (may be absent or corrupt)
    if (!base) { console.error("config.json in source is not valid JSON"); process.exit(1); }
    const merged = base;
    if (old && typeof old === "object") {
      // Preserve the runtime-tuned values, one key at a time.
      if (old.llamaCpp && Number.isFinite(old.llamaCpp.context))
        merged.llamaCpp = { ...(merged.llamaCpp || {}), context: old.llamaCpp.context };
      if (old.agent) {
        merged.agent = { ...(merged.agent || {}) };
        if (Number.isFinite(old.agent.contextWindow)) merged.agent.contextWindow = old.agent.contextWindow;
        if (Number.isFinite(old.agent.maxTokens))     merged.agent.maxTokens = old.agent.maxTokens;
      }
      if (old.tools && typeof old.tools.sudo === "boolean")
        merged.tools = { ...(merged.tools || {}), sudo: old.tools.sudo };
      if (old.windowSize && Number.isInteger(old.windowSize.width) && Number.isInteger(old.windowSize.height))
        merged.windowSize = old.windowSize;
    }
    fs.writeFileSync(process.argv[3], JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  ' "$DIR/config.json" "$DEST/config.json" "$DEST/config.json" || {
    echo "WARNING: config merge failed — falling back to the release defaults." >&2
    cp "$DIR/config.json" "$DEST/config.json"
  }
  chmod 600 "$DEST/config.json" 2>/dev/null || true

  # ── In-place upgrade notice + integrity check ─────────────────────────
  # If an existing install was detected (config or sessions survived), tell the
  # user this was an upgrade, not a fresh install, and verify the core files are
  # all present so a half-broken in-place copy is caught immediately.
  if [ "$WAS_UPGRADE" = "1" ]; then
    echo ""
    echo "↻ In-place upgrade complete."
    echo "  • Your chat history, memory, models, and settings were PRESERVED."
    echo "  • App code was replaced with the new version; stale files removed."
  fi
  # Integrity check: verify the full module-load chain (web.js -> agent.js ->
  # ./tools/*) plus the bundled Node survived the copy, so a partial in-place copy
  # is caught here instead of crashing at launch.
  for REQUIRED in web.js agent.js llama-backend.js sessions.js memory.js image-input.js \
                  system-prompt.md ismini web/index.html web/live-tts.js \
                  tools/web-fetch.js tools/web-search.js tools/weather.js; do
    if [ ! -f "$DEST/$REQUIRED" ]; then
      echo "ERROR: $DEST/$REQUIRED is missing after install — the upgrade may be incomplete."
      echo "       Re-run from the source folder:  bash $DIR/install.sh"
      exit 1
    fi
  done
  # The bundled Node must be present and runnable (ismini never uses system Node).
  if [ ! -x "$DEST/node/bin/node" ]; then
    echo "ERROR: bundled Node ($DEST/node/bin/node) is missing after install."
    echo "       The new release must include a 'node/' folder. Re-run:  bash $DIR/install.sh"
    exit 1
  fi

  echo "App installed to: $DEST (source folder left untouched: $DIR)"

  # ── Run desktop-entry setup directly (no recursive self-call) ─────────
  # Files are already in $DEST. Instead of re-invoking install.sh recursively
  # (which would re-copy and re-check), run the shared desktop-entry logic.
  register_desktop_entries "$DEST"

  echo "Done. Start ismini with: $DEST/ismini"

  if command -v notify-send >/dev/null 2>&1; then
    notify-send "ismini Installation Complete" \
                "ismini has been installed successfully! Click the ismini icon to start." \
                ${ICON_PATH:+--icon="$ICON_PATH"}
  fi
  exit 0
fi

# ── In-place (DIR == DEST): just (re)register the desktop entries ───────────
[ -f "$DIR/web.js" ] || { echo "ERROR: app not found in $DIR"; exit 1; }
register_desktop_entries "$DEST"

echo "Done. Start ismini with: $DIR/ismini"

if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Installation Complete" \
              "ismini has been installed successfully! Click the ismini icon to start." \
              ${ICON_PATH:+--icon="$ICON_PATH"}
fi