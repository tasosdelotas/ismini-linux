#!/bin/bash
# ismini uninstall-preserve: stops the server, removes the app code, but keeps user data.
#   Keeps: config.json, sessions.json, memory.json, memory.md, models/, skills/,
#          hf-token, greeting-state.json, llama-state.json, logs (ismini.log*, llama.log*),
#          server.pid — everything that is NOT app code.
#   Removes: ALL app code (every top-level .js, the launcher, scripts, docs, icons,
#            and the node/, llama-cpp/, tools/, web/ directories) + desktop shortcuts.
set -euo pipefail

# ── Guard: $HOME must be a sane absolute path, and resolve through symlinks so
#    $APP matches the real install dir (a symlinked $HOME would make every rm a
#    silent no-op against the wrong path). ─────────────────────────────────────
if [ -z "${HOME:-}" ] || [ "${HOME#/}" = "$HOME" ]; then
  echo "ERROR: \$HOME is not an absolute path — refusing to touch anything." >&2
  exit 1
fi
APP="$(cd "$HOME" && pwd)/ismini"
DATA_DIR="$APP"

# ── Flags: --yes skips confirmation. Check ALL args, not just $1, so
#    `uninstall-preserve.sh --force --yes` still takes the non-interactive path. ──
confirmed=false
for arg in "$@"; do
  case "$arg" in
    --yes) confirmed=true ;;
  esac
done

# ── Confirmation dialog (GUI when double-clicked, terminal when run from CLI) ──
if [ "$confirmed" != "true" ]; then
  # Only offer the GUI path when there is actually a display AND a tool for it —
  # on a headless box with zenity installed, zenity would fail and we'd report
  # "cancelled" without ever reaching the terminal prompt.
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v zenity >/dev/null 2>&1; then
    if zenity --question \
      --title="Uninstall ismini (keep your data)" \
      --text="This will remove the ismini app code but KEEP your data:
• Chat history (sessions.json) — KEPT
• AI memory (memory.md / memory.json) — KEPT
• Downloaded models — KEPT
• Custom settings & Hugging Face token — KEPT
• Skills you saved — KEPT

The app itself will be removed. Your data stays in ~/ismini.
This cannot be undone." \
      --ok-label="Yes, uninstall (keep my data)" \
      --cancel-label="Cancel" \
      --width=400 2>/dev/null; then
      confirmed=true
    fi
  elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v kdialog >/dev/null 2>&1; then
    if kdialog --yesno "This will remove the ismini app code but KEEP your data:
• Chat history (sessions.json) — KEPT
• AI memory (memory.md / memory.json) — KEPT
• Downloaded models — KEPT
• Custom settings & Hugging Face token — KEPT
• Skills you saved — KEPT

The app itself will be removed. Your data stays in ~/ismini.
This cannot be undone.
Continue?" \
      --title "Uninstall ismini (keep your data)" 2>/dev/null; then
      confirmed=true
    fi
  else
    # Terminal fallback (-r: no backslash mangling; || confirm="": EOF on a
    # non-TTY must mean "cancelled", not an abort under set -e)
    echo "📋 ismini uninstall — KEEPING your data"
    echo "========================================"
    echo "This will remove the ismini app code but KEEP your data:"
    echo "   - Your chat history (sessions.json)"
    echo "   - Your AI's long-term memory (memory.md / memory.json)"
    echo "   - Your downloaded models"
    echo "   - Your custom settings and Hugging Face token"
    echo "   - Your saved skills (skills/)"
    echo ""
    echo "The app itself will be removed. Your data stays in ~/ismini."
    echo ""
    read -r -p "Are you sure you want to uninstall ismini (keeping your data)? [y/N] " confirm || confirm=""
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
      confirmed=true
    fi
  fi
fi

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling ismini app code (keeping your data)..."

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
# process), and only after giving SIGTERM time to run web.js's graceful shutdown.
if [ -f "$DATA_DIR/server.pid" ]; then
  pid="$(head -n1 "$DATA_DIR/server.pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [ -r "/proc/$pid/cmdline" ] &&
     tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$APP/web.js"; then
    stop_pids_gracefully "$pid"
  fi
  rm -f "$DATA_DIR/server.pid"
fi

# 1b) Kill ismini's OWN bundled llama-server (the model process). It is spawned by
#     web.js and, once the node server dies, gets reparented to systemd — becoming
#     an orphan that keeps holding the model in GPU/RAM forever. Match ONLY our own
#     binary path ($APP/llama-cpp or $APP/bin) so we NEVER touch LM Studio's or
#     anyone else's llama-server. The escalation re-checks the SAME collected PIDs
#     (polling, not sleep) — a slow-to-die server mid model-load must not escape
#     just because its path only matched one of the two patterns.
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
# server.pid is process STATE, not user data — a stale one shipped into a fresh
# install is exactly the PID-reuse hazard the launcher's ownership check guards
# against. (server.log / logs are kept: they're diagnostics the user may want.)
rm -f "$DATA_DIR/server.pid"

# 4) Remove app code only; keep user data.
echo "Removing application code (your data stays safe)..."
# Drift-proof: EVERY top-level .js is app code (data files are .json/.md/hf-token).
# New modules can never be left behind by a stale hand-maintained list.
find "$APP" -maxdepth 1 -type f -name '*.js' -delete
rm -f "$APP"/{ismini,ismini.png,ismini.desktop,install.sh,install-ismini.sh,\
uninstall.sh,uninstall-preserve.sh,push-to-github.sh,\
package.json,LICENSE,README.md,CHANGELOG.md,HANDOFF.md,system-prompt.md,\
config.example.json,memory.example.md,.uninstall-request}
rm -rf "$APP"/{llama-cpp,node,bin,tools,web} "$APP"/node-v*-linux-x64

# 5) Verify before claiming success — rm -f never fails on missing files, so the
#    old unconditional "✓ removed" could print when nothing was actually removed.
if [ -e "$APP/web.js" ]; then
  echo "ERROR: $APP/web.js still exists — removal failed (permissions?)." >&2
  exit 1
fi

echo "✓ App code removed. Your data is preserved in $APP (config, sessions, memory, models, skills, token)."

# Show completion notification
if command -v notify-send >/dev/null 2>&1; then
  notify-send "ismini Uninstalled" "ismini app code removed. Your data was preserved."
fi

echo "✓ ismini app code uninstalled. Your data was preserved in $APP."