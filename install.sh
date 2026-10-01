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
node_path="$(command -v node 2>/dev/null || true)"
if [ -z "$node_path" ]; then
  echo
  echo "ERROR: Node.js was not found on this system."
  echo "ismini needs Node.js 18 or newer to run."
  echo
  echo "Install the latest version here:  https://nodejs.org/"
  echo "then re-run this installer."
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
  if [ ! -e "$DEST/config.json" ]; then
    cp "$DIR/config.json" "$DEST/config.json"
  fi
  echo "App installed to: $DEST (source folder left untouched: $DIR)"
  exec bash "$DEST/install.sh"
fi

[ -f "$DIR/web.js" ] || { echo "ERROR: app not found in $DIR"; exit 1; }

if [ -d "$HOME/Desktop" ]; then
  cat > "$HOME/Desktop/ismini.desktop" <<EOF
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
  chmod +x "$HOME/Desktop/ismini.desktop"
  gio set "$HOME/Desktop/ismini.desktop" metadata::trusted true 2>/dev/null || true
  echo "Desktop launcher installed: $HOME/Desktop/ismini.desktop"
fi

if [ -d "$HOME/.local/share/applications" ]; then
  cp "$DIR/ismini.desktop" "$HOME/.local/share/applications/ismini.desktop"
  sed -i "s|^Exec=.*|Exec=$DIR/ismini|; s|^Icon=.*|Icon=$DIR/ismini.png|" "$HOME/.local/share/applications/ismini.desktop"
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "App menu entry installed."
fi
echo "Done. Start ismini with: $DIR/ismini"
