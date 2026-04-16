#!/usr/bin/env bash
# Install netpulse runtime state + npm dependencies.
# Idempotent: safe to re-run.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$SKILL_DIR/app"
NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"

# Private-by-default: config/db may contain identifying info on shared hosts
umask 077

echo "→ Creating state directory: $NETPULSE_DIR"
mkdir -p "$NETPULSE_DIR/logs"
chmod 700 "$NETPULSE_DIR" 2>/dev/null || true

# Seed config from defaults (don't clobber user edits)
if [ ! -f "$NETPULSE_DIR/config.json" ]; then
  cp "$APP_DIR/config.default.json" "$NETPULSE_DIR/config.json"
  chmod 600 "$NETPULSE_DIR/config.json" 2>/dev/null || true
  echo "→ Seeded config: $NETPULSE_DIR/config.json"
else
  echo "→ Keeping existing config: $NETPULSE_DIR/config.json"
fi

# Node version sanity check
if ! command -v node >/dev/null 2>&1; then
  echo "✗ node not found on PATH. Install Node 18+ first."
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ node $NODE_MAJOR detected; netpulse requires Node 18+."
  exit 1
fi

# curl + ping sanity check (used by monitor.js)
for cmd in curl ping; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ $cmd not on PATH. netpulse needs both curl and ping."
    exit 1
  fi
done

# Install native deps if missing. npm ci is faster but needs lockfile;
# fall back to npm install if the user cloned without one.
echo "→ Installing Node dependencies (better-sqlite3 compiles natively)…"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent
else
  npm install --omit=dev --silent
fi

echo ""
echo "✓ netpulse installed."
echo ""
echo "  Config:  $NETPULSE_DIR/config.json"
echo "  Data:    $NETPULSE_DIR/data.db  (created on first run)"
echo ""
echo "  Next:"
echo "    $SKILL_DIR/scripts/start-bg.sh    # run in background (recommended)"
echo "    $SKILL_DIR/scripts/start-fg.sh    # run in foreground (for debugging)"
