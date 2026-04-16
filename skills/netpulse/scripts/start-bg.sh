#!/usr/bin/env bash
# Start netpulse as a background service that survives shell exit + reboots.
# Auto-selects the best persistence mechanism for the platform:
#   macOS      → launchd user agent  (~/Library/LaunchAgents/com.netpulse.plist)
#   Linux      → systemd --user unit (~/.config/systemd/user/netpulse.service)
#   fallback   → nohup + pidfile     ($NETPULSE_DIR/netpulse.pid)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$SKILL_DIR/app"
NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"
LOG_FILE="$NETPULSE_DIR/logs/netpulse.log"
PID_FILE="$NETPULSE_DIR/netpulse.pid"
LABEL="com.netpulse"

mkdir -p "$NETPULSE_DIR/logs"

# Ensure dependencies exist before we register a service that can't boot.
if [ ! -f "$APP_DIR/node_modules/better-sqlite3/package.json" ]; then
  "$SKILL_DIR/scripts/install.sh"
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "✗ node not on PATH" >&2; exit 1
fi

OS="$(uname -s)"

# ── macOS: launchd ──────────────────────────────────────────────────────────
start_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$APP_DIR/start.js</string>
    </array>
    <key>WorkingDirectory</key><string>$APP_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>$LOG_FILE</string>
    <key>StandardErrorPath</key><string>$LOG_FILE</string>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- /sbin first: macOS ships ping at /sbin/ping -->
        <key>PATH</key><string>/sbin:/usr/sbin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>$HOME</string>
        <key>NETPULSE_DIR</key><string>$NETPULSE_DIR</string>
    </dict>
</dict>
</plist>
PLIST

  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "✓ Restarted launchd service: $LABEL"
  else
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
    echo "✓ Loaded launchd service: $LABEL"
  fi
}

# ── Linux: systemd --user ───────────────────────────────────────────────────
start_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/netpulse.service"
  mkdir -p "$unit_dir"
  cat > "$unit" <<UNIT
[Unit]
Description=netpulse — network stability & speed monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $APP_DIR/start.js
WorkingDirectory=$APP_DIR
# ping lives in /usr/bin on most Linux; include /sbin and /usr/sbin for BSD/Alpine edge cases
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=NETPULSE_DIR=$NETPULSE_DIR
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now netpulse.service
  echo "✓ Enabled systemd --user service: netpulse.service"
  echo "  (enable linger for boot-time start: sudo loginctl enable-linger \$USER)"
}

# ── Fallback: nohup + pidfile ───────────────────────────────────────────────
start_nohup() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "✓ Already running (pid $(cat "$PID_FILE"))"
    return
  fi
  cd "$APP_DIR"
  NETPULSE_DIR="$NETPULSE_DIR" nohup "$NODE_BIN" start.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 0.5
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "✓ Started (pid $(cat "$PID_FILE")) via nohup. Logs: $LOG_FILE"
    echo "  Note: no boot-time auto-start. For that, add a cron @reboot entry or use a supervisor."
  else
    echo "✗ Process died immediately. Check $LOG_FILE" >&2
    exit 1
  fi
}

case "$OS" in
  Darwin)  start_launchd ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
      start_systemd
    else
      echo "→ systemd --user not available; falling back to nohup."
      start_nohup
    fi
    ;;
  *)       start_nohup ;;
esac

sleep 1.5

# Verify port is listening (cross-platform)
PORT="$(node -e "console.log(require('$APP_DIR/config.default.json').port)" 2>/dev/null || echo 8089)"
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo ""
    echo "  Dashboard: http://127.0.0.1:$PORT/"
  else
    echo ""
    echo "  Service started but port $PORT isn't listening yet — check logs: $LOG_FILE"
  fi
else
  echo ""
  echo "  Dashboard (once up): http://127.0.0.1:$PORT/"
fi
