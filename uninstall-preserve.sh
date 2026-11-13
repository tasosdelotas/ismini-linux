#!/bin/bash
# ismini uninstall-preserve: stops the server, removes the app code, but keeps user data.
#   Keeps: config.json, sessions.json, memory.json, memory.md, models/, skills/,
#          greeting-state.json, server.pid, server.log
#   Removes: app code (web.js, agent.js, llama-backend.js, etc.) and desktop shortcuts.
set -euo pipefail

APP="$HOME/ismini"
DATA_DIR="$HOME/ismini"

# --yes skips the confirmation (used when called from the web UI, which already confirmed)
if [[ "${1:-}" == "--yes" ]]; then
  confirmed=true
else
# ── Confirmation dialog (GUI when double-clicked, terminal when run from CLI) ──
confirmed=false
if command -v zenity >/dev/null 2>&1; then
  if zenity --question \
    --title="Uninstall ismini (keep your data)" \
    --text="This will remove the ismini app code but KEEP your data:
• Chat history (sessions.json) — KEPT
• AI memory (memory.json) — KEPT
• Downloaded models — KEPT
• Custom settings — KEPT

The app itself will be removed. Your data stays in ~/ismini.
This cannot be undone." \
    --ok-label="Yes, uninstall (keep my data)" \
    --cancel-label="Cancel" \
    --width=400 2>/dev/null; then
    confirmed=true
  fi
elif command -v kdialog >/dev/null 2>&1; then
  if kdialog --yesno "This will remove the ismini app code but KEEP your data:
• Chat history (sessions.json) — KEPT
• AI memory (memory.json) — KEPT
• Downloaded models — KEPT
• Custom settings — KEPT

The app itself will be removed. Your data stays in ~/ismini.
This cannot be undone.
Continue?" \
    --title "Uninstall ismini (keep your data)" 2>/dev/null; then
    confirmed=true
  fi
else
  # Terminal fallback
  echo "📋 ismini uninstall — KEEPING your data"
  echo "========================================"
  echo "This will remove the ismini app code but KEEP your data:"
  echo "   - Your chat history (sessions.json)"
  echo "   - Your AI's long-term memory (memory.json)"
  echo "   - Your downloaded models"
  echo "   - Your custom settings"
  echo ""
  echo "The app itself will be removed. Your data stays in ~/ismini."
  echo ""
  read -p "Are you sure you want to uninstall ismini (keeping your data)? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    confirmed=true
  fi
fi
fi # end of --yes else-branch

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling ismini app code (keeping your data)..."

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

# 1b) Kill ismini's OWN bundled llama-server (the model process). It is spawned by
#     web.js and, once the node server dies, gets reparented to systemd — becoming
#     an orphan that keeps holding the model in GPU/RAM forever. Match ONLY our own
#     binary path ($APP/llama-cpp) so we NEVER touch LM Studio's or anyone else's
#     llama-server.
echo "Stopping ismini's llama-server (model process)..."
llpids=$(pgrep -f "$APP/llama-cpp/.*llama-server" 2>/dev/null || true)
if [ -z "$llpids" ]; then
  llpids=$(pgrep -f "llama-server.*$APP" 2>/dev/null || true)
fi
if [ -n "$llpids" ]; then
  for pid in $llpids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  llpids=$(pgrep -f "$APP/llama-cpp/.*llama-server" 2>/dev/null || true)
  if [ -n "$llpids" ]; then
    for pid in $llpids; do kill -9 "$pid" 2>/dev/null || true; done
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

# 4) Remove app code only; keep user data.
echo "Removing application code (your data stays safe)..."
# Remove app code and non-data files, keep user data directories.
rm -f "$APP/web.js" "$APP/agent.js" "$APP/llama-backend.js" "$APP/install.sh" "$APP/uninstall.sh" "$APP/uninstall-preserve.sh" "$APP/ismini"
rm -f "$APP/image-input.js" "$APP/package.json" "$APP/LICENSE" "$APP/README.md" "$APP/CHANGELOG.md" "$APP/HANDOFF.md" "$APP/system-prompt.md"
rm -f "$APP/ismini.png"
rm -rf "$APP/llama-cpp" "$APP/node" "$APP/bin" "$APP/tools" "$APP/web"
# Remove desktop shortcuts (already removed above, but be thorough)
rm -f "$DESKTOP_DIR/ismini.desktop" "$HOME/.local/share/applications/ismini.desktop"

echo "✓ App code removed. Your data is preserved in $APP (config, sessions, memory, models, skills)."

# Show completion notification
if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Uninstalled" "ismini app code removed. Your data was preserved."
fi

echo "✓ ismini app code uninstalled. Your data was preserved in $APP."
