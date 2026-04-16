#!/usr/bin/env bash
# Report netpulse status — service registration, port listening, data freshness.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib.sh
. "$SKILL_DIR/scripts/lib.sh"

NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"
CFG="$NETPULSE_DIR/config.json"
DB="$NETPULSE_DIR/data.db"
PID_FILE="$NETPULSE_DIR/netpulse.pid"
LABEL="com.netpulse"
OS="$(uname -s)"

PORT=8089
if [ -f "$CFG" ] && command -v node >/dev/null 2>&1; then
  PORT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CFG', 'utf8')).port)" 2>/dev/null || echo 8089)"
fi

echo "=== netpulse status ==="
echo "  State dir:  $NETPULSE_DIR"
echo "  Config:     $([ -f "$CFG" ] && echo "present" || echo "missing — run install.sh")"
echo "  Database:   $([ -f "$DB" ] && echo "present ($(du -h "$DB" | cut -f1))" || echo "not yet created")"
echo ""

# Service registration
echo "  Service registration:"
if [ "$OS" = "Darwin" ]; then
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    PID=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -oE 'pid = [0-9]+' | awk '{print $3}')
    echo "    launchd:  RUNNING${PID:+ (pid $PID)}"
  else
    echo "    launchd:  not registered"
  fi
fi
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet netpulse.service 2>/dev/null; then
    echo "    systemd:  RUNNING"
  elif systemctl --user cat netpulse.service >/dev/null 2>&1; then
    echo "    systemd:  registered but not active"
  else
    echo "    systemd:  not registered"
  fi
fi
if [ -f "$PID_FILE" ]; then
  PID_CONTENT="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_netpulse_pid "$PID_CONTENT"; then
    echo "    nohup:    RUNNING (pid $PID_CONTENT)"
  else
    echo "    nohup:    stale pidfile ($PID_FILE, pid=$PID_CONTENT) — run stop.sh to clean"
  fi
fi

# Port
echo ""
echo "  Port $PORT:"
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "    listening"
    if command -v curl >/dev/null 2>&1; then
      CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" || echo "000")
      echo "    HTTP GET /  → $CODE"
    fi
  else
    echo "    not listening"
  fi
fi

# Data freshness
if [ -f "$DB" ] && command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Data:"
  node <<NODE 2>/dev/null || echo "    (query failed)"
const Database = require('$SKILL_DIR/app/node_modules/better-sqlite3');
try {
  const db = new Database('$DB', { readonly: true });
  const p = db.prepare('SELECT COUNT(*) n, MAX(ts) last FROM pings').get();
  const s = db.prepare('SELECT COUNT(*) n FROM speed_samples').get();
  const t = db.prepare('SELECT COUNT(*) n FROM ttfb').get();
  const first = db.prepare('SELECT MIN(ts) ts FROM pings').get();
  const now = Date.now();
  if (p.n === 0) { console.log('    empty (daemon just started?)'); process.exit(0); }
  const lastAgo = Math.round((now - p.last) / 1000);
  const durHr = ((p.last - first.ts) / 3600_000).toFixed(1);
  console.log('    pings=' + p.n + ' speed=' + s.n + ' ttfb=' + t.n);
  console.log('    span=' + durHr + 'h, last sample ' + lastAgo + 's ago');
} catch (e) { console.log('    error: ' + e.message); }
NODE
fi
