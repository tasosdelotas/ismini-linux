#!/bin/bash
# install-ismini.sh — the "double-click installer" for ismini.
#
# This file is BOTH a bash script AND its own payload: after the marker line
# below, a gzip-compressed tar of the full ismini release (source + node/ +
# llama-cpp/) is appended. The result is ONE self-contained downloadable file
# (shipped as ismini-vX.Y.Z-linux-x64.AppImage). No FUSE, no AppImage runtime —
# it works on any Linux distro with bash + tar + gzip.
#
# What happens on double-click:
#   1. Splits itself into script + payload (marker line below is the boundary)
#   2. Extracts the payload to a temp dir
#   3. Runs the real install.sh from there (installs into ~/ismini, generates
#      icons + desktop entry — exactly the manual-install path)
#   4. Shows ONE small confirmation dialog (zenity → kdialog → notify-send):
#        "✓ Ismini is Installed — Now click on the desktop icon or find ismini
#         in your app menu"
#   5. Cleans up the temp dir. No terminal window, no auto-launch of ismini.
#
# On failure: same dialog style, pointing at ~/ismini-install.log.
# If the user's file manager EXTRACTS this file instead of running it (some do),
# they get a folder containing install.sh — the classic manual path. Never worse.
#
# Building the final file is done by push-to-github.sh (step 5b): it stages the
# release tree, tars+gzips it, and appends it after the marker in this script.

set -u

LOG="$HOME/ismini-install.log"
: > "$LOG" 2>/dev/null || LOG="/tmp/ismini-install.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }

# ── Find a dialog tool (never fatal — worst case we skip the popup) ─────────
# System notification (all modern desktops have one). Fired IN PARALLEL with the
# dialog popup, so the user gets both: a visible window AND a tray/desktop notice.
show_notification() { # $1=title  $2=message
  if command -v notify-send >/dev/null 2>&1; then
    timeout 5 notify-send -a ismini -c ismini-install "$1" "$2" 2>/dev/null || true
  fi
}

show_dialog() { # $1=title  $2=message
  local title="$1" msg="$2"
  show_notification "$title" "$msg" &   # parallel — never blocks the popup
  # NO timeout: the dialog stays up until the user clicks OK.
  if command -v zenity >/dev/null 2>&1; then
    zenity --info --title="$title" --text="$msg" --width=420 >/dev/null 2>&1 || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --title "$title" --icon MessageBox-information --msgbox "$msg" 2>/dev/null || true
  fi
  wait 2>/dev/null || true   # let the backgrounded notification finish delivering
}

# Immediate feedback the moment the user double-clicks: a dialog popup (waits for
# OK, so it's unmistakable that something is happening) + a system notification.
show_dialog "ismini" "The installation has begun — just wait a moment…"

# ── Locate the payload (everything after the marker line) ────────────────────
# Resolve our own path. readlink -f is absent on some minimal systems (busybox)
# and can exit non-zero — fall back to $0 so this NEVER aborts the install.
SELF="$0"
if command -v readlink >/dev/null 2>&1; then
  RESOLVED="$(readlink -f "$SELF" 2>/dev/null)" || RESOLVED=""
  [ -n "$RESOLVED" ] && SELF="$RESOLVED"
fi
MARKER="__ISMINI_PAYLOAD_BELOW__"
# -a: treat as text (the payload after the marker is binary). Anchor to line start
# so we match the REAL marker line, not the MARKER="..." variable definition above.
MARK_LINE="$(grep -an "^${MARKER}$" "$SELF" | head -n1 | cut -d: -f1)"
if [ -z "$MARK_LINE" ]; then
  log "ERROR: payload marker not found in $SELF — file may be truncated."
  show_dialog "ismini installer" "Install didn't finish — the downloaded file looks incomplete.
Please download it again and try.

Details: $LOG"
  exit 1
fi

WORK="$(mktemp -d /tmp/ismini-install.XXXXXX)" || { log "ERROR: mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

log "Splitting payload from $SELF (marker at line $MARK_LINE)..."
# Payload starts right after the marker line.
tail -n +"$((MARK_LINE + 1))" "$SELF" > "$WORK/payload.tar.gz" || {
  log "ERROR: could not read payload."
  show_dialog "ismini installer" "Install didn't finish — details in $LOG"
  exit 1
}

# ── Extract the full release tree ────────────────────────────────────────────
log "Extracting to $WORK/app ..."
mkdir -p "$WORK/app"
if ! tar -xzf "$WORK/payload.tar.gz" -C "$WORK/app" >>"$LOG" 2>&1; then
  log "ERROR: extraction failed."
  show_dialog "ismini installer" "Install didn't finish — details in $LOG"
  exit 1
fi

# The payload contains a top-level ismini/ folder (same layout as the zip asset).
APP_DIR="$WORK/app/ismini"
if [ ! -f "$APP_DIR/install.sh" ]; then
  # Layout-agnostic fallback: find the dir that actually holds install.sh.
  APP_DIR="$(find "$WORK/app" -maxdepth 2 -name install.sh -print -quit 2>/dev/null | xargs -r dirname)"
fi
if [ -z "${APP_DIR:-}" ] || [ ! -f "$APP_DIR/install.sh" ]; then
  log "ERROR: install.sh not found in payload."
  show_dialog "ismini installer" "Install didn't finish — details in $LOG"
  exit 1
fi

# ── Run the real installer (silent; it already handles icons/desktop/data) ───
# Extra args are passed THROUGH to install.sh. The in-app updater calls
# `bash <this-file> --no-stop` so install.sh does NOT kill the running server.
INSTALL_ARGS=()
for a in "$@"; do INSTALL_ARGS+=("$a"); done
log "Running $APP_DIR/install.sh ${INSTALL_ARGS[*]:-} ..."
if ! bash "$APP_DIR/install.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} >>"$LOG" 2>&1; then
  log "ERROR: install.sh failed."
  show_dialog "ismini installer" "Install didn't finish — details in $LOG"
  exit 1
fi

log "Install complete."
show_dialog "ismini" "✓ Ismini is Installed — Now click on the desktop icon or find ismini in your app menu"
exit 0

# The release payload (tar.gz of ismini/) begins on the NEXT line.
__ISMINI_PAYLOAD_BELOW__
