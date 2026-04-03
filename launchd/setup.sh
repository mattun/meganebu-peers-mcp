#!/bin/bash
# Setup claude-peers broker as a launchd service
#
# Usage (on Mac mini):
#   cd /Users/flowos/meganebu-peers-mcp
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

# 3. Update WorkingDirectory in plist to match current repo location
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
sed "s|/Users/flowos/meganebu-peers-mcp|$REPO_DIR|g" "$PLIST_SRC" > "$PLIST_DST"
echo "Installed plist: $PLIST_DST"
echo "WorkingDirectory: $REPO_DIR"

# 4. Load and start
launchctl load "$PLIST_DST"
sleep 2

# 5. Verify
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
