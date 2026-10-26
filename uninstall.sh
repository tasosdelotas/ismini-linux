#!/bin/bash
# ismini uninstaller: stops the server and removes the app and all its traces.
set -euo pipefail

APP="$HOME/ismini"
# Fixed: was "$HOME/.ismini" — actual data lives inside ~/ismini alongside the app
DATA_DIR="$HOME/ismini"

# ── Confirmation dialog (GUI when double-clicked, terminal when run from CLI) ──
confirmed=false
if command -v zenity >/dev/null 2>&1; then
  if zenity --question \
    --title="Uninstall ismini" \
    --text="This will PERMANENTLY delete:
• All chat history (sessions.json)
• AI memory (memory.json)
• Downloaded models
• Custom settings
This cannot be undone." \
    --ok-label="Yes, uninstall" \
    --cancel-label="Cancel" \
    --width=400 2>/dev/null; then
    confirmed=true
  fi
elif command -v kdialog >/dev/null 2>&1; then
  if kdialog --yesno "This will PERMANENTLY delete all ismini data including chat history, memory, downloaded models, and settings.
This cannot be undone.
Continue?" \
    --title "Uninstall ismini" 2>/dev/null; then
    confirmed=true
  fi
else
  # Terminal fallback
  echo "⚠️  WARNING: This will completely remove ismini and ALL your data, including:"
  echo "   - Your chat history (sessions.json)"
  echo "   - Your AI's long-term memory (memory.json)"
  echo "   - Your custom settings and downloaded models"
  echo ""
  read -p "Are you sure you want to uninstall ismini? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    confirmed=true
  fi
fi

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling ismini..."

# 1) Stop a running server started from this app dir
echo "Stopping any running ismini processes..."
pids=$(pgrep -f "$APP/web\.js" 2>/dev/null || true)
if [ -n "$pids" ]; then
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  pids=$(pgrep -f "$APP/web\.js" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  fi
fi

# Also kill via PID file if the launcher created one
if [ -f "$DATA_DIR/server.pid" ]; then
  pid=$(cat "$DATA_DIR/server.pid" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  fi
fi

# 2) Desktop icon + app menu entry (handles non-English locales)
echo "Removing desktop shortcuts..."
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi
rm -f "$DESKTOP_DIR/ismini.desktop"
rm -f "$HOME/.local/share/applications/ismini.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# 3) Stray launcher logs, updater leftovers, and state
echo "Cleaning up temporary files..."
rm -f /tmp/ismini-server.log
rm -f /tmp/ismini.log
rm -f "$HOME/.ismini-update.zip"
rm -rf "$HOME/.ismini-update-temp"

# 4) The app itself (config, persona, code, downloaded models, sessions, memory)
#    Since DATA_DIR == APP, this single rm -rf removes everything.
echo "Removing application files and all user data..."
rm -rf "$APP"

# Show completion notification
if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Uninstalled" "ismini has been completely removed from your system."
fi

echo "✓ ismini has been completely uninstalled."
