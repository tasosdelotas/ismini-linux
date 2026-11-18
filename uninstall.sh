#!/bin/bash
# ismini uninstaller: stops the server and removes the app AND all its data.
set -euo pipefail

# ── Guard: $HOME must be a sane absolute path, resolved through symlinks so
#    every target matches the real on-disk location. ──────────────────────────
if [ -z "${HOME:-}" ] || [ "${HOME#/}" = "$HOME" ]; then
  echo "ERROR: \$HOME is not an absolute path — refusing to touch anything." >&2
  exit 1
fi
APP="$(cd "$HOME" && pwd)/ismini"

# ── Data locations. web.js resolveDataDir() checks ISMINI_HOME first, then
#    ~/ismini — so if the user relocated their data (models are tens of GB), a
#    "delete everything" that only touches ~/ismini would leave sessions/memory/
#    hf-token/models behind and still claim they're gone. Collect every real one.
DATA_DIRS=("$APP")
if [ -n "${ISMINI_HOME:-}" ] && [ "$ISMINI_HOME" != "$APP" ]; then
  DATA_DIRS+=("$ISMINI_HOME")
fi

# ── Sanity: only rm -rf something that actually looks like an ismini install.
#    Accept data markers too, so a full uninstall still works AFTER a preserve
#    uninstall (code gone, data remains). ─────────────────────────────────────
looks_like_ismini() {
  [ -f "$1/web.js" ] || [ -f "$1/sessions.json" ] || [ -f "$1/memory.json" ] \
    || [ -d "$1/models" ] || [ -f "$1/config.json" ]
}

# ── Flags: --yes skips confirmation. Check ALL args, not just $1. ────────────
confirmed=false
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=true ;;
  esac
done

if [ "$confirmed" != "true" ]; then
  # Show exactly what will be destroyed (path + size) — for an irreversible
  # rm -rf in the user's home, "Downloaded models — 47 GB" is information the
  # user genuinely needs before clicking.
  TARGETS=""
  for d in "${DATA_DIRS[@]}"; do
    if [ -e "$d" ]; then
      sz="$(du -sh "$d" 2>/dev/null | cut -f1 || echo '?')"
      TARGETS="${TARGETS}• ${d} (${sz})
"
    fi
  done
  if [ -z "$TARGETS" ]; then
    echo "Nothing to remove: no ismini install or data found."
    exit 0
  fi

  # GUI only when there is actually a display AND a tool for it (a headless box
  # with zenity installed would otherwise report "cancelled" and never reach the
  # terminal prompt).
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v zenity >/dev/null 2>&1; then
    if zenity --question \
      --title="Uninstall ismini" \
      --text="This will PERMANENTLY delete:
${TARGETS}
including all chat history (sessions.json), AI memory (memory.md / memory.json),
downloaded models, custom settings, Hugging Face token, and saved skills.
This cannot be undone." \
      --ok-label="Yes, uninstall" \
      --cancel-label="Cancel" \
      --width=420 2>/dev/null; then
      confirmed=true
    fi
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v kdialog >/dev/null 2>&1; then
    if kdialog --yesno "This will PERMANENTLY delete:
${TARGETS}
including all chat history, AI memory, downloaded models, settings, and skills.
This cannot be undone.
Continue?" \
      --title "Uninstall ismini" 2>/dev/null; then
      confirmed=true
    fi
  else
    echo "⚠️  WARNING: This will completely remove ismini and ALL your data."
    echo "Permanently deleting:"
    for d in "${DATA_DIRS[@]}"; do
      [ -e "$d" ] && echo "   • $d ($(du -sh "$d" 2>/dev/null | cut -f1 || echo '?'))"
    done
    echo ""
    echo "   (chat history, AI memory, downloaded models, settings, HF token, skills)"
    echo ""
    read -r -p "Are you sure you want to uninstall ismini? [y/N] " confirm || confirm=""
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      confirmed=true
    fi
  fi
fi

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling ismini..."

# ── Process matching that AGREES with install.sh: exact argv-element equality
#    via /proc/*/cmdline, so `code ~/ismini/web.js`, `tail -f`, or a grep can
#    never be mistaken for the running server. ────────────────────────────────
running_app_pids() {
  local proc pid arg
  local -a argv
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    argv=()
    mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || true
    for arg in "${argv[@]}"; do
      if [ "$arg" = "$APP/web.js" ]; then
        pid="${proc##*/}"
        printf '%s\n' "$pid"
        break
      fi
    done
  done
}

# Graceful stop: SIGTERM, poll up to ~5 s (web.js's own shutdown can take a few
# seconds — it must get the chance to run _killBackend()), then escalate.
stop_pids_gracefully() {
  local pid attempt alive
  [ "$#" -gt 0 ] || return 0
  for pid in "$@"; do kill "$pid" 2>/dev/null || true; done
  for attempt in {1..20}; do
    alive=0
    for pid in "$@"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && return 0
    sleep 0.25
  done
  for pid in "$@"; do kill -9 "$pid" 2>/dev/null || true; done
}

# 1) Stop a running server started from this app dir
echo "Stopping any running ismini processes..."
mapfile -t pids < <(running_app_pids)
stop_pids_gracefully "${pids[@]}"

# Also stop via PID file — but ONLY after verifying the PID still belongs to
# ismini's web.js (a stale pidfile + PID reuse must never SIGKILL an unrelated
# process), and only after giving SIGTERM time for web.js's graceful shutdown.
if [ -f "$DATA_DIRS[0]/server.pid" ]; then
  pid="$(head -n1 "$DATA_DIRS[0]/server.pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ -r "/proc/$pid/cmdline" ] &&
     tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$APP/web.js"; then
    stop_pids_gracefully "$pid"
  fi
  rm -f "$DATA_DIRS[0]/server.pid"
fi

# 1b) Kill ismini's OWN bundled llama-server (the model process). It is spawned by
#     web.js and, once the node server dies, gets reparented to systemd — becoming
#     an orphan that keeps holding the model in GPU/RAM forever. Match ONLY our own
#     binary path ($APP/llama-cpp or $APP/bin) so we NEVER touch LM Studio's or
#     anyone else's llama-server. Collect once, escalate the SAME PIDs by polling —
#     a slow-to-die server must not escape just because its path only matched one
#     of the two patterns. (In a full uninstall this matters doubly: a survivor
#     would keep 8–32 GB of KV cache resident with its binary about to be deleted.)
echo "Stopping ismini's llama-server (model process)..."
mapfile -t llpids < <(pgrep -f "$APP/(llama-cpp|bin)/.*llama-server|llama-server.*$APP" 2>/dev/null || true)
stop_pids_gracefully "${llpids[@]}"

# 2) Desktop icon + app menu entry (handles non-English locales)
echo "Removing desktop shortcuts..."
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi
rm -f "$DESKTOP_DIR/ismini.desktop"
rm -f "$HOME/.local/share/applications/ismini.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# 2b) hicolor theme icons — install.sh writes 9 sizes under hicolor/*/apps/ and
#     busts the caches; without this, a stale "ismini" icon persists after uninstall.
rm -f "$HOME"/.local/share/icons/hicolor/*/apps/ismini.png 2>/dev/null || true
gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
find "$HOME/.cache" -maxdepth 2 -name 'icon-cache.*' -delete 2>/dev/null || true

# 3) Stray launcher logs, updater leftovers, and state
echo "Cleaning up temporary files..."
rm -f /tmp/ismini-server.log
rm -f /tmp/ismini.log
rm -f "$HOME/.ismini-update.zip"
rm -rf "$HOME/.ismini-update-temp"
# The dedicated browser profile (launcher's --user-data-dir). Holds the favicon
# cache + localStorage (theme, TTS voice, STT language) — part of "all its traces".
rm -rf "$HOME/.ismini-browser"

# 4) The app itself + all user data (config, persona, code, models, sessions,
#    memory). rm -rf must be allowed to fail loudly: under set -e a silent abort
#    would leave a half-deleted install with no message and no installer left to
#    retry (the scripts live inside the very dir being deleted). Root-owned files
#    are plausible — ismini can run commands with sudo.
echo "Removing application files and all user data..."
errfile="$(mktemp)"
for d in "${DATA_DIRS[@]}"; do
  [ -e "$d" ] || continue
  if ! looks_like_ismini "$d"; then
    echo "ERROR: $d does not look like an ismini install — refusing to delete it." >&2
    exit 1
  fi
  if ! rm -rf "$d" 2>"$errfile"; then
    echo "ERROR: could not fully remove $d:" >&2
    cat "$errfile" >&2
    echo "" >&2
    echo "Some files may be owned by root (ismini can run commands with sudo)." >&2
    echo "Finish manually:  sudo rm -rf '$d'" >&2
    exit 1
  fi
done
rm -f "$errfile"

# 5) Verify before claiming success.
for d in "${DATA_DIRS[@]}"; do
  if [ -e "$d" ]; then
    echo "ERROR: $d still exists — removal failed (permissions?)." >&2
    exit 1
  fi
done

# Show completion notification
if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Uninstalled" "ismini has been completely removed from your system."
fi

echo "✓ ismini has been completely uninstalled."