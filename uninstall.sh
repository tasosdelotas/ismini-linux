#!/bin/bash
# ismini uninstaller — works for BOTH install methods, no matter how you installed.
#   - .deb  (sudo dpkg -i ismini_*.deb)  → app code in /opt/ismini
#   - install.sh (double-click)          → app code in ~/ismini
# Data (config, sessions, memory) always lives in ~/ismini and is preserved.
# Just run this one script — it figures out the rest.

HOME_DIR="${HOME:-$HOME}"
DEB_APP="/opt/ismini"      # where the .deb installs its code
SH_APP="$HOME_DIR/ismini"  # where install.sh puts everything (code + data)

# Detect which install method is present.
is_deb_installed=0
if dpkg --succeeds-if-installed ismini >/dev/null 2>&1; then
  is_deb_installed=1
fi
[ -d "$DEB_APP" ] && is_deb_installed=1

is_sh_installed=0
[ -d "$SH_APP" ] && is_sh_installed=1

if [ "$is_deb_installed" -eq 0 ] && [ "$is_sh_installed" -eq 0 ]; then
  echo "ismini does not appear to be installed (no /opt/ismini or ~/ismini found)."
  # Still clean up any stray desktop entries, in case a previous install left them.
  rm -f "$HOME_DIR/Desktop/ismini.desktop" \
        "$HOME_DIR/.local/share/applications/ismini.desktop" \
        /usr/share/applications/ismini.desktop 2>/dev/null || true
  update-desktop-database "$HOME_DIR/.local/share/applications" >/dev/null 2>&1 || true
  exit 0
fi

# ── 1) Stop any running ismini server (from either location) ────────────────
stop_server() {
  local pattern="$1/web\.js" pid
  for pid in $(pgrep -f "$pattern" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
}
[ "$is_deb_installed" -eq 1 ] && stop_server "$DEB_APP"
[ "$is_sh_installed" -eq 1 ] && stop_server "$SH_APP"
sleep 1
# Force-kill anything still alive.
for base in "$DEB_APP" "$SH_APP"; do
  [ -d "$base" ] || continue
  for pid in $(pgrep -f "$base/web\.js" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
done

# ── 2) Desktop icon + app menu entries (all locations, both methods) ────────
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -z "$DESKTOP_DIR" ] && DESKTOP_DIR="$HOME_DIR/Desktop"
rm -f "$DESKTOP_DIR/ismini.desktop" \
      "$HOME_DIR/Desktop/ismini.desktop" \
      "$HOME_DIR/.local/share/applications/ismini.desktop" \
      /usr/share/applications/ismini.desktop 2>/dev/null || true
update-desktop-database "$HOME_DIR/.local/share/applications" >/dev/null 2>&1 || true
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true

# ── 3) Stray launcher log + pid files (both locations, plus legacy /tmp) ────
rm -f "$DEB_APP/ismini.log" "$DEB_APP/ismini.pid" \
      "$SH_APP/ismini.log" "$SH_APP/ismini.pid" \
      /tmp/ismini.log 2>/dev/null || true

# ── 4) Protect personal data before deleting ────────────────────────────────
# Data lives in ~/ismini for BOTH methods (the .deb keeps runtime data there too).
SESSIONS="$SH_APP/sessions.json"
MEMORY="$SH_APP/memory.json"
have_data=0
[ -f "$SESSIONS" ] && have_data=1
[ -f "$MEMORY" ]   && have_data=1

if [ "$have_data" -eq 1 ]; then
  echo
  echo "ismini has personal data that will be DELETED:"
  [ -f "$SESSIONS" ] && echo "  - $SESSIONS (chat history)"
  [ -f "$MEMORY" ]   && echo "  - $MEMORY (long-term memory)"
  echo

  # Back up the data (always, even with --yes — it's cheap and safe), then
  # require an explicit confirmation unless --yes was passed for non-interactive use.
  BACKUP_DIR="$HOME_DIR/ismini-backup-$(date +%Y%m%d-%H%M%S)"
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

# ── 5) Remove the app code, per install method ───────────────────────────────
if [ "$is_deb_installed" -eq 1 ]; then
  # Prefer dpkg so it also clears its own bookkeeping and runs package hooks.
  if dpkg --succeeds-if-installed ismini >/dev/null 2>&1; then
    echo "Removing the .deb installation via dpkg..."
    # dpkg needs root; try sudo only if we're not already root.
    if [ "$(id -u)" = "0" ]; then
      dpkg --purge ismini >/dev/null 2>&1 || true
    else
      sudo dpkg --purge ismini >/dev/null 2>&1 || true
    fi
  fi
  # Belt and braces: remove any leftover code dir directly (needs root for /opt).
  if [ -d "$DEB_APP" ]; then
    if [ "$(id -u)" = "0" ]; then
      rm -rf "$DEB_APP"
    else
      sudo rm -rf "$DEB_APP" 2>/dev/null || true
    fi
  fi
fi

if [ "$is_sh_installed" -eq 1 ]; then
  rm -rf "$SH_APP"
fi

echo ""
echo "Uninstalled ismini."
[ "$is_deb_installed" -eq 1 ] && echo "  - removed .deb install (/opt/ismini)"
[ "$is_sh_installed" -eq 1 ] && echo "  - removed install.sh app (~/ismini)"
if [ "$have_data" -eq 1 ]; then
  echo "Your data was backed up to: $BACKUP_DIR"
else
  echo "No personal data was present."
fi
