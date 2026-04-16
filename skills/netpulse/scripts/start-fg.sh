#!/usr/bin/env bash
# Run netpulse in the foreground. Ctrl+C to stop.
# Use this for smoke-testing or when you don't need persistence.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"

if [ ! -f "$SKILL_DIR/app/node_modules/better-sqlite3/package.json" ]; then
  echo "→ node_modules not found; running install first…"
  "$SKILL_DIR/scripts/install.sh"
fi

cd "$SKILL_DIR/app"
exec node start.js
