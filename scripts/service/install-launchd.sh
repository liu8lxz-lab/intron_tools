#!/bin/zsh
set -euo pipefail

LABEL="com.intron.tools"
PROJECT_DIR="/Users/a682/Documents/New project 2"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/storage/logs"
NODE_BIN="$(command -v node || true)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Cannot find executable node. Install Node.js or load nvm before installing the service." >&2
  exit 1
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string><![CDATA[
set -euo pipefail
PROJECT_DIR="/Users/a682/Documents/New project 2"
mkdir -p "\$PROJECT_DIR/storage/logs"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"
export PORT="\${PORT:-3000}"
export HOST="0.0.0.0"
export APP_EXPOSURE="admin-only"
if [[ -z "\${ALLOWED_HOSTS:-}" ]]; then
  LAN_IP="\$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  if [[ -n "\$LAN_IP" ]]; then
    export ALLOWED_HOSTS="localhost,127.0.0.1,::1,\$LAN_IP,intron-tools.local"
  else
    export ALLOWED_HOSTS="localhost,127.0.0.1,::1,intron-tools.local"
  fi
fi
exec "$NODE_BIN" "\$PROJECT_DIR/src/server.js"
    ]]></string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/intron-tools.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/intron-tools.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

chmod 644 "$PLIST_PATH"
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started $LABEL"
echo "Admin: http://localhost:3000/admin.html"
echo "Logs: $LOG_DIR/intron-tools.out.log and $LOG_DIR/intron-tools.err.log"
