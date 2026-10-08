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

# 3) stray launcher log
rm -f /tmp/ismini.log

# 4) the app itself (config, persona, code)
rm -rf "$APP"

echo "Uninstalled ismini (app dir: $APP)."
