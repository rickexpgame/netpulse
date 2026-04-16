#!/usr/bin/env bash
# Stop netpulse however it was started. Tries all three mechanisms —
# whichever applies wins; the rest are no-ops.
set -euo pipefail

NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"
PID_FILE="$NETPULSE_DIR/netpulse.pid"
LABEL="com.netpulse"
OS="$(uname -s)"

stopped_any=0

# launchd (macOS)
if [ "$OS" = "Darwin" ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist"
  echo "✓ Stopped launchd service"
  stopped_any=1
fi

# systemd --user (Linux)
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet netpulse.service 2>/dev/null; then
    systemctl --user stop netpulse.service
    echo "✓ Stopped systemd --user service"
    stopped_any=1
  fi
fi

# nohup fallback
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    sleep 0.5
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    echo "✓ Stopped background process (pid $PID)"
    stopped_any=1
  fi
  rm -f "$PID_FILE"
fi

if [ "$stopped_any" = "0" ]; then
  echo "  Nothing running."
fi
