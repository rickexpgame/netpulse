#!/usr/bin/env bash
# Run netpulse in the foreground. Ctrl+C to stop.
# Use this for smoke-testing or when you don't need persistence.
set -euo pipefail

# Private-by-default — every file the daemon creates lands at mode 600.
# monitor.js/server.js also call process.umask(0o077) as defense in depth.
umask 077

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"

if [ ! -f "$SKILL_DIR/app/node_modules/better-sqlite3/package.json" ]; then
  echo "→ node_modules not found; running install first…"
  "$SKILL_DIR/scripts/install.sh"
fi

cd "$SKILL_DIR/app"
exec node start.js
