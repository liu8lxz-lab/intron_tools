#!/bin/zsh
set -euo pipefail

LABEL="com.intron.tools"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "LaunchAgent: $PLIST_PATH"
if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Status: not installed"
  exit 0
fi

launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null || {
  echo "Status: installed but not loaded"
  exit 1
}
