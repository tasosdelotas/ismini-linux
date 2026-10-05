#!/bin/bash
# ismini uninstaller: stops the server and removes the app and all its traces.
APP="$HOME/ismini"

# 1) stop a running server started from this app dir (never a generic "node")
for pid in $(pgrep -f "$APP/web\.js" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(pgrep -f "$APP/web\.js" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done

# 2) desktop icon + app menu entry
rm -f "$HOME/Desktop/ismini.desktop"
rm -f "$HOME/.local/share/applications/ismini.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# 3) stray launcher log + pid file (kept in the app dir, not world-readable /tmp)
rm -f "$APP/ismini.log" "$APP/ismini.pid"
rm -f /tmp/ismini.log # legacy location from older versions

# 4) Protect personal data before deleting the app. sessions.json holds chat
# history and memory.json holds long-term memories — both live in $APP and would
# be destroyed by rm -rf with no way back. Warn, offer a backup, and require an
# explicit confirmation (unless --yes is passed for non-interactive use).
SESSIONS="$APP/sessions.json"
MEMORY="$APP/memory.json"
have_data=0
[ -f "$SESSIONS" ] && have_data=1
[ -f "$MEMORY" ] && have_data=1

if [ "$have_data" -eq 1 ]; then
  echo
  echo "ismini has personal data that will be DELETED:"
  [ -f "$SESSIONS" ] && echo "  - $SESSIONS (chat history)"
  [ -f "$MEMORY" ]   && echo "  - $MEMORY (long-term memory)"
  echo

  # Back up the data (always, even with --yes — it's cheap and safe), then
  # require an explicit confirmation unless --yes was passed for non-interactive use.
  BACKUP_DIR="$HOME/ismini-backup-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  [ -f "$SESSIONS" ] && cp -a "$SESSIONS" "$BACKUP_DIR/"
  [ -f "$MEMORY" ]   && cp -a "$MEMORY" "$BACKUP_DIR/"
  echo "Backed up to: $BACKUP_DIR"

  if [ "${1:-}" != "--yes" ]; then
    printf 'Delete ismini and its data? This cannot be undone. Type YES to confirm: '
    read -r confirm || confirm=""
    if [ "$confirm" != "YES" ]; then
      echo "Aborted — nothing was deleted (backup kept at $BACKUP_DIR)."
      exit 0
    fi
  fi
fi

# 5) the app itself (config, persona, code)
rm -rf "$APP"

echo "Uninstalled ismini (app dir: $APP)."
