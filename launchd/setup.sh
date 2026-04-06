#!/bin/bash
# Setup claude-peers broker as a launchd service
#
# Usage (on Mac mini):
#   cd /Users/flowos/meganebu-harness/tools/claude-peers-mcp
#   bash launchd/setup.sh
#
# Management:
#   launchctl stop  com.claude-peers.broker   # Stop
#   launchctl start com.claude-peers.broker   # Start
#   tail -f /tmp/claude-peers-broker.log      # View logs
#   launchctl unload ~/Library/LaunchAgents/com.claude-peers.broker.plist  # Disable

set -e

PLIST_NAME="com.claude-peers.broker.plist"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=== claude-peers broker setup ==="

# 1. Kill any existing broker processes
echo "Checking for existing broker processes..."
EXISTING=$(lsof -ti :7899 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
    echo "Killing existing processes on port 7899: $EXISTING"
    kill $EXISTING 2>/dev/null || true
    sleep 1
fi

# 2. Unload existing launchd job if present
if launchctl list | grep -q "com.claude-peers.broker"; then
    echo "Unloading existing launchd job..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# 3. Resolve bun path (differs between machines: homebrew vs ~/.bun)
BUN_PATH="$(which bun 2>/dev/null || echo "")"
if [ -z "$BUN_PATH" ]; then
    # Check common locations
    for p in /opt/homebrew/bin/bun "$HOME/.bun/bin/bun" /usr/local/bin/bun; do
        if [ -x "$p" ]; then
            BUN_PATH="$p"
            break
        fi
    done
fi
if [ -z "$BUN_PATH" ]; then
    echo "❌ bun not found. Install bun first: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi
echo "Bun path: $BUN_PATH"

# 4. Update WorkingDirectory and bun path in plist to match current environment
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
sed -e "s|/Users/flowos/meganebu-harness/tools/claude-peers-mcp|$REPO_DIR|g" \
    -e "s|__BUN_PATH__|$BUN_PATH|g" \
    "$PLIST_SRC" > "$PLIST_DST"
echo "Installed plist: $PLIST_DST"
echo "WorkingDirectory: $REPO_DIR"

# 5. Load and start
launchctl load "$PLIST_DST"
sleep 2

# 6. Verify
if curl -s http://localhost:7899/health | grep -q "ok"; then
    echo ""
    echo "✅ Broker is running!"
    echo "   Port: 7899"
    echo "   Logs: /tmp/claude-peers-broker.log"
    echo ""
    echo "Management commands:"
    echo "  launchctl stop  com.claude-peers.broker"
    echo "  launchctl start com.claude-peers.broker"
    echo "  tail -f /tmp/claude-peers-broker.log"
else
    echo ""
    echo "❌ Broker failed to start. Check logs:"
    echo "   cat /tmp/claude-peers-broker.log"
    exit 1
fi
