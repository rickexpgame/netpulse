#!/usr/bin/env bash
# Clean removal of netpulse — stops the service and optionally wipes state.
# Does NOT uninstall the plugin itself (use `claude plugin remove netpulse`).
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NETPULSE_DIR="${NETPULSE_DIR:-$HOME/.netpulse}"
LABEL="com.netpulse"
OS="$(uname -s)"

echo "=== Uninstalling netpulse ==="

# 1. Stop whatever's running
"$SKILL_DIR/scripts/stop.sh" || true

# 2. Remove persistence artifacts
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "✓ Removed launchd plist"
  fi
fi
if [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/netpulse.service"
  if [ -f "$UNIT" ]; then
    systemctl --user disable netpulse.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload
    echo "✓ Removed systemd unit"
  fi
fi

# 3. Offer to wipe state directory
if [ -d "$NETPULSE_DIR" ]; then
  echo ""
  echo "  State directory still present: $NETPULSE_DIR"
  echo "  ($(du -sh "$NETPULSE_DIR" 2>/dev/null | cut -f1) of config + data + logs)"
  echo ""
  # Default: keep state unless --purge flag given (so re-install preserves history)
  if [ "${1:-}" = "--purge" ]; then
    rm -rf "$NETPULSE_DIR"
    echo "✓ Purged $NETPULSE_DIR"
  else
    echo "  To also wipe state:  $0 --purge"
    echo "  (this deletes config.json, data.db, logs — cannot be undone)"
  fi
fi

# 4. Offer to clean node_modules
if [ -d "$SKILL_DIR/app/node_modules" ]; then
  echo ""
  echo "  app/node_modules is $(du -sh "$SKILL_DIR/app/node_modules" | cut -f1) — left in place."
  echo "  To reclaim:  rm -rf $SKILL_DIR/app/node_modules"
fi

echo ""
echo "✓ Service stopped."
echo "  To fully remove the plugin too:  claude plugin remove netpulse"
