#!/usr/bin/env bash
# Shared helpers sourced by other scripts. Not a standalone entry point.
# All functions are pure POSIX where possible; no external deps beyond core utils.

# is_netpulse_pid PID — succeeds (exit 0) only when:
#   1. PID is non-empty and numeric
#   2. The process is alive (kill -0 works)
#   3. The process's cmdline references netpulse (start.js / monitor.js / server.js)
#
# This guards against two common bugs with trusting a bare pidfile:
#   - Stale PID after crash+reboot → another unrelated process inherits the number
#   - Race: we read the file just after the process died and another started
# If a pidfile exists but this check fails, callers should treat it as stale
# and rm it.
is_netpulse_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  case "$pid" in *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  # `ps -o command=` is the portable cross-platform form (macOS + Linux).
  # We tolerate missing ps (very minimal containers) by falling back to
  # /proc/<pid>/cmdline on Linux.
  local cmd=""
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -z "$cmd" ] && [ -r "/proc/$pid/cmdline" ]; then
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
  fi
  case "$cmd" in
    *netpulse*|*start.js*|*monitor.js*|*server.js*) return 0 ;;
    *) return 1 ;;
  esac
}

# cleanup_stale_pidfile FILE — remove a pidfile that doesn't reference a live
# netpulse process. Safe to call even when the file doesn't exist.
cleanup_stale_pidfile() {
  local f="$1"
  [ -f "$f" ] || return 0
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  if is_netpulse_pid "$pid"; then
    return 1  # still valid; caller decides what to do
  fi
  rm -f "$f"
  return 0
}
