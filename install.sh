#!/bin/bash
# ismini installer: puts the app in ~/ismini and installs the launcher.
# Run it from anywhere — the extracted zip folder, a git clone, wherever.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/ismini"

# --no-stop: do NOT kill the running ismini server. Used by the in-app updater, which
# IS the running server — install.sh killing it would abort the update mid-flight.
NO_STOP=0
for arg in "$@"; do
  [ "$arg" = "--no-stop" ] && NO_STOP=1
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

# ── Prerequisite: ismini's OWN bundled Node (18+) — no system Node is used ──
# ismini is 100% self-contained: it ships Node in the 'node/' folder and runs on
# that binary only. The installer therefore REQUIRES the bundled Node and never
# falls back to a system-wide node (that fallback was a leftover from when ismini
# borrowed LM Studio's Node).
node_path=""
if [ -x "$DIR/node/bin/node" ]; then
  node_path="$DIR/node/bin/node"
elif [ -d "$DIR/node-v"*"-linux-x64" ]; then
  for c in "$DIR"/node-v*-linux-x64/bin/node; do
    [ -x "$c" ] && node_path="$c" && break
  done
fi
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

  tar -C "$DIR" \
      --exclude='./.git' \
      --exclude='./config.json' \
      --exclude='./sessions.json' \
      --exclude='./sessions.json.*' \
      --exclude='./memory.json' \
      --exclude='./memory.json.*' \
      -cf - . | tar -C "$DEST" -xf -

  chmod +x "$DEST/ismini" "$DEST/install.sh" "$DEST/uninstall.sh" "$DEST/publish.sh" 2>/dev/null || true

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

  if [ ! -e "$DEST/config.json" ]; then
    cp "$DIR/config.json" "$DEST/config.json"
  else
    if ! "$node_path" -e '
      const fs = require("fs");
      const [dest, src] = process.argv.slice(1);
      let cur; try { cur = JSON.parse(fs.readFileSync(dest, "utf8")); } catch { process.exit(0); }
      let def; try { def = JSON.parse(fs.readFileSync(src, "utf8")); } catch { process.exit(0); }
      const curTools = (cur.tools && Array.isArray(cur.tools.enabled)) ? cur.tools.enabled : [];
      const defTools = (def.tools && Array.isArray(def.tools.enabled)) ? def.tools.enabled : [];
      const merged = [...new Set([...curTools, ...defTools.filter(t => !curTools.includes(t))])];
      let changedTools = merged.length !== curTools.length;
      if (changedTools) { cur.tools = cur.tools || {}; cur.tools.enabled = merged; }
      // Upgrade existing installs UP to a newer default context length (e.g. the
      // 16384 -> 32768 bump) without clobbering a value the user set deliberately.
      const defCtx = def.llamaCpp && Number(def.llamaCpp.context);
      const curCtx = cur.llamaCpp && Number(cur.llamaCpp.context);
      let changedCtx = Number.isFinite(defCtx) && (!Number.isFinite(curCtx) || curCtx < defCtx);
      if (changedCtx) { cur.llamaCpp = cur.llamaCpp || {}; cur.llamaCpp.context = defCtx; }
      // Add the reasoning default (off) to existing installs that lack it, so an
      // in-place upgrade does not leave a box silently thinking (slow). Only added if
      // missing; never overrides a value the user set deliberately.
      const defReasoning = def.llamaCpp && def.llamaCpp.reasoning;
      const changedReasoning = !!defReasoning && !(cur.llamaCpp && cur.llamaCpp.reasoning);
      if (changedReasoning) { cur.llamaCpp = cur.llamaCpp || {}; cur.llamaCpp.reasoning = defReasoning; }
      if (changedTools || changedCtx || changedReasoning) {
        fs.writeFileSync(dest, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
        console.log("config.json updated: " +
          (changedTools ? "enabled new tools " + defTools.filter(t => !curTools.includes(t)).join(", ") + "; " : "") +
          (changedCtx ? "context " + (Number.isFinite(curCtx) ? curCtx : "(unset)") + " -> " + defCtx + "; " : "") +
          (changedReasoning ? "reasoning -> " + defReasoning : "").replace(/; $/, ""));
      }
    ' "$DEST/config.json" "$DIR/config.json"; then
      echo "WARNING: could not merge config defaults; keeping existing $DEST/config.json as-is."
    fi
  fi

  # ── In-place upgrade notice + integrity check ─────────────────────────
  # If an existing install was detected (config or sessions survived), tell the
  # user this was an upgrade, not a fresh install, and verify the core files are
  # all present so a half-broken in-place copy is caught immediately.
  if [ -f "$DEST/sessions.json" ] || [ -f "$DEST/config.json" ]; then
    echo ""
    echo "↻ In-place upgrade complete."
    echo "  • Your chat history, memory, models, and settings were PRESERVED."
    echo "  • App code was replaced with the new version; stale files removed."
  fi
  for REQUIRED in web.js agent.js llama-backend.js ismini; do
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

  if ! bash "$DEST/install.sh"; then
    echo ""
    echo "NOTE: Files were copied to $DEST, but the final setup step failed."
    echo "Re-run from the source folder to retry:  bash $DIR/install.sh"
    exit 1
  fi
  exit 0
fi

# ── Desktop Entries (Runs when DIR == DEST) ─────────────────────────────────
[ -f "$DIR/web.js" ] || { echo "ERROR: app not found in $DIR"; exit 1; }

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi

EXEC_PATH="$DEST/ismini"
ICON_PATH="$DEST/ismini.png"

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
  HC_ICON_DIR="$HOME/.local/share/icons/hicolor"
  # KDE/KWin want CRISP SQUARE icons in the fixed-size taskbar + title-bar slots.
  # The blurry-icon bug came from TWO mistakes, fixed here:
  #   1. Padding: a fit-to-square WITH transparent padding leaves a small statue in
  #      a big box → soft at 16-24px. We want the statue to FILL the square.
  #   2. "-resize px" (no !) only shrinks-to-fit → tiny statue in a transparent box.
  # The master is 642x655 (only ~13px taller than wide), so a center fill-crop to
  # square trims a negligible sliver and the head stays FULLY INTACT (verified).
  # Single source now: generate from the master ismini.png (the 256px appicon was
  # removed — the master downscales fine and is the one icon we maintain).
  APPICON_SRC="$ICON_PATH"

  for px in 16 22 24 32 48 64 128 256 512; do
    mkdir -p "$HC_ICON_DIR/${px}x${px}/apps"
    if command -v convert >/dev/null 2>&1; then
      # Exact px×px render ("!" forces it), Lanczos anti-aliased. The source already
      # fills the square, so this just resamples crisply — no padding box, no head crop.
      convert "$APPICON_SRC" -resize ${px}x${px}! -filter Lanczos \
        -define png:color-type=6 \
        "$HC_ICON_DIR/${px}x${px}/apps/ismini.png" 2>/dev/null \
        || cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/ismini.png"
    else
      cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/ismini.png"
    fi
  done
  gtk-update-icon-cache "$HC_ICON_DIR" >/dev/null 2>&1 || true
  # Bust any stale desktop icon caches so the WM picks up the new icon
  # immediately (KDE's icon-cache.kcache, GTK's per-size caches, etc.).
  rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
  find "$HOME/.cache" -maxdepth 2 -name 'icon-cache.*' -delete 2>/dev/null || true
  echo "Icon registered in hicolor theme as square 'ismini' icons (caches refreshed)."
fi

if [ -d "$DESKTOP_DIR" ]; then
  cat > "$DESKTOP_DIR/ismini.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=ismini
Comment=Minimal local AI agent (Web UI)
Exec=$EXEC_PATH
$([ -n "$ICON_PATH" ] && echo "Icon=$ICON_PATH")
Terminal=false
Categories=Development;Network;Utility;
StartupWMClass=ismini
EOF
  chmod +x "$DESKTOP_DIR/ismini.desktop"
  gio set "$DESKTOP_DIR/ismini.desktop" metadata::trusted true 2>/dev/null || true
  echo "Desktop launcher installed: $DESKTOP_DIR/ismini.desktop"
else
  echo "NOTE: no desktop folder found."
fi

if [ -d "$HOME/.local/share/applications" ]; then
  cat > "$HOME/.local/share/applications/ismini.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=ismini
Comment=Minimal local AI agent (Web UI)
Exec=$EXEC_PATH
$([ -n "$ICON_PATH" ] && echo "Icon=$ICON_PATH")
Terminal=false
Categories=Development;Network;Utility;
StartupWMClass=ismini
EOF
  chmod +x "$HOME/.local/share/applications/ismini.desktop"
  if command -v desktop-file-validate >/dev/null 2>&1; then
    if ! desktop-file-validate "$HOME/.local/share/applications/ismini.desktop" 2>/dev/null; then
      echo "WARNING: desktop entry validation failed"
    fi
  fi
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "App menu entry installed."
fi

echo "Done. Start ismini with: $DIR/ismini"

if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Installation Complete" \
              "ismini has been installed successfully! Click the ismini icon to start." \
              ${ICON_PATH:+--icon=$ICON_PATH}
fi