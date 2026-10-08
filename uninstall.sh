#!/bin/bash
# ismini uninstaller: stops the server and removes the app and all its traces.
APP="${ISMINI_HOME:-$HOME/ismini}"
PIDFILE="$APP/ismini.pid"

# 1) stop a running server started from this app dir (never a generic "node")
# First, try to use the PID file if it exists
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE" 2>/dev/null)
  # Validate PID is numeric and process exists
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping ismini server (PID: $pid)..."
    # Send SIGTERM first, wait with timeout
    kill -TERM "$pid" 2>/dev/null || true
    
    # Wait up to 5 seconds for graceful shutdown
    timeout=0
    while [ $timeout -lt 5 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      timeout=$((timeout + 1))
    done
    
    # If still running, force kill
    if kill -0 "$pid" 2>/dev/null; then
      echo "Force killing ismini server (PID: $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "PID file exists but process not running (stale PID: $pid)"
  fi
  rm -f "$PIDFILE"
fi

# Fallback: if PID file is missing or process still running, verify and stop ismini processes
for pid in $(pgrep -f "$APP/web\.js" 2>/dev/null); do
  # Verify this is actually an ismini web.js process:
  # - First argument must be node (or nodejs)
  # - Second argument must be the exact path to our web.js
  if [ -r "/proc/$pid/cmdline" ]; then
    mapfile -d '' argv < /proc/$pid/cmdline 2>/dev/null || continue
    # Check: first arg contains 'node', second is exactly $APP/web.js
    if [[ "${argv[0]}" == *"node"* && "${argv[1]:-}" == "$APP/web.js" ]]; then
      echo "Stopping ismini server (verified PID: $pid)..."
      kill "$pid" 2>/dev/null || true
    fi
  fi
done
sleep 1
for pid in $(pgrep -f "$APP/web\.js" 2>/dev/null); do
  if [ -r "/proc/$pid/cmdline" ]; then
    mapfile -d '' argv < /proc/$pid/cmdline 2>/dev/null || continue
    if [[ "${argv[0]}" == *"node"* && "${argv[1]:-}" == "$APP/web.js" ]]; then
      echo "Force killing ismini server (verified PID: $pid)..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
done
# Fallback: if anything is still listening on ismini's port (8787), it was
# started from an unusual path — find it via the socket and stop it too.
if command -v fuser >/dev/null 2>&1; then
  # Only kill if the process on 8787 is actually node running web.js
  fuser_pid=$(fuser 8787/tcp 2>/dev/null | tr -d ' ')
  if [ -n "$fuser_pid" ]; then
    # Verify it's our web.js before killing
    if [ -f "/proc/$fuser_pid/cmdline" ] && grep -q "web\.js" /proc/$fuser_pid/cmdline 2>/dev/null; then
      echo "Stopping ismini server (fuser PID: $fuser_pid)..."
      fuser -k 8787/tcp >/dev/null 2>&1 || true
    else
      echo "Port 8787 in use but not by ismini web.js (PID: $fuser_pid)"
    fi
  fi
fi

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
[ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && echo "Backup kept at: $BACKUP_DIR" || true
