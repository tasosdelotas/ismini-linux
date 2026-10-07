#!/bin/bash
# ismini installer: puts the app in ~/ismini and installs the launcher.
# Run it from anywhere — the extracted zip folder, a git clone, wherever.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/ismini"

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

# prerequisite: Node.js 18+ (ismini is pure Node stdlib, no npm packages)
# Prefer a system node; fall back to the one bundled with LM Studio.
node_path="$(command -v node 2>/dev/null || true)"
if [ -z "$node_path" ]; then
  for candidate in \
    "$HOME/.lmstudio/bin/node" \
    "$HOME/.lmstudio/.internal/utils/node" \
    /usr/lib/lm-studio/node \
    /opt/venice-ai/node; do
    if [ -x "$candidate" ]; then node_path="$candidate"; break; fi
  done
fi
if [ -z "$node_path" ]; then
  echo
  echo "ERROR: Node.js was not found on this system."
  echo "ismini runs on the Node.js that comes with LM Studio — install it from https://lmstudio.ai,"
  echo "load a model, and re-run this installer. (A standalone node also works: https://nodejs.org)"
  exit 1
fi
node_version="$("$node_path" --version 2>/dev/null || echo v0.0.0)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
if [ "$node_major" -lt 18 ]; then
  echo
  echo "ERROR: found Node.js $node_version, but ismini needs 18 or newer."
  echo
  echo "Install the latest version here:  https://nodejs.org/"
  echo "then re-run this installer."
  exit 1
fi
echo "Node.js $node_version found - OK."

# canonical location: copy the app to ~/ismini so there is one live copy.
# The source folder is left untouched (it may be your dev copy or a zip you
# just extracted) — re-run install.sh from it after updating the app.
if [ "$DIR" != "$DEST" ]; then
  stop_running_app
  mkdir -p "$DEST"
  tar -C "$DIR" \
    --exclude='./.git' \
    --exclude='./config.json' \
    --exclude='./sessions.json' \
    --exclude='./sessions.json.*' \
    --exclude='./memory.json' \
    --exclude='./memory.json.*' \
    -cf - . | tar -C "$DEST" -xf -
  # Restore executable permissions (GitHub ZIP downloads often strip them)
  chmod +x "$DEST/ismini" "$DEST/install.sh" "$DEST/uninstall.sh" "$DEST/publish.sh" 2>/dev/null || true
  if [ ! -e "$DEST/config.json" ]; then
    # Fresh install — use the bundled config as-is.
    cp "$DIR/config.json" "$DEST/config.json"
  else
    # Upgrade — keep the user's existing config, but MERGE in any newly-added
    # default tools (e.g. memory_add/memory_delete) so they get enabled without
    # forcing a full config replacement. Uses Node (already a prerequisite).
    if ! "$node_path" -e '
      const fs = require("fs");
      const [dest, src] = process.argv.slice(1);
      let cur; try { cur = JSON.parse(fs.readFileSync(dest, "utf8")); } catch { process.exit(0); }
      let def; try { def = JSON.parse(fs.readFileSync(src, "utf8")); } catch { process.exit(0); }
      const curTools = (cur.tools && Array.isArray(cur.tools.enabled)) ? cur.tools.enabled : [];
      const defTools = (def.tools && Array.isArray(def.tools.enabled)) ? def.tools.enabled : [];
      // Add any default tools the current config is missing, preserving order.
      const merged = [...new Set([...curTools, ...defTools.filter(t => !curTools.includes(t))])];
      if (merged.length !== curTools.length) {
        cur.tools = cur.tools || {};
        cur.tools.enabled = merged;
        fs.writeFileSync(dest, JSON.stringify(cur, null, 2) + "\n", { mode: 0o600 });
        console.log("config.json updated: enabled new tools " + defTools.filter(t => !curTools.includes(t)).join(", "));
      }
    ' "$DEST/config.json" "$DIR/config.json"; then
      echo "WARNING: could not merge config defaults; keeping existing $DEST/config.json as-is."
    fi
  fi
  echo "App installed to: $DEST (source folder left untouched: $DIR)"
  # Run the installer from DEST in a SUBSHELL (not exec). `exec` would replace
  # this process, so on failure the retry hint below could never print. A normal
  # call lets us catch the exit status and show actionable guidance.
  if ! bash "$DEST/install.sh"; then
    echo ""
    echo "NOTE: Files were copied to $DEST, but the final setup step failed."
    echo "Re-run from the source folder to retry:  bash $DIR/install.sh"
    exit 1
  fi
fi

[ -f "$DIR/web.js" ] || { echo "ERROR: app not found in $DIR"; exit 1; }

# Desktop folder: use xdg-user-dir so it works on non-English locales (e.g. a
# Greek desktop uses ~/Πίνακας, not ~/Desktop). Fall back to ~/Desktop if xdg-user-dir
# is unavailable or returns nothing.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi
if [ -d "$DESKTOP_DIR" ]; then
  cat > "$DESKTOP_DIR/ismini.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=ismini
Comment=Minimal local agent runtime (Web UI)
Exec=$DIR/ismini
Icon=$DIR/ismini.png
Terminal=false
Categories=Development;Network;Utility;
EOF
  chmod +x "$DESKTOP_DIR/ismini.desktop"
  gio set "$DESKTOP_DIR/ismini.desktop" metadata::trusted true 2>/dev/null || true
  echo "Desktop launcher installed: $DESKTOP_DIR/ismini.desktop"
else
  echo "NOTE: no desktop folder found (looked for $(xdg-user-dir DESKTOP 2>/dev/null || echo ~/Desktop))."
  echo "The app menu entry below still works; you can also start ismini with: $DIR/ismini"
fi

if [ -d "$HOME/.local/share/applications" ]; then
  cp "$DIR/ismini.desktop" "$HOME/.local/share/applications/ismini.desktop"
  sed -i "s|^Exec=.*|Exec=$DIR/ismini|; s|^Icon=.*|Icon=$DIR/ismini.png|" "$HOME/.local/share/applications/ismini.desktop"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "App menu entry installed."
fi
echo "Done. Start ismini with: $DIR/ismini"
