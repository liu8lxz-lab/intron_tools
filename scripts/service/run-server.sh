#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/a682/Documents/New project 2"
LOG_DIR="$PROJECT_DIR/storage/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PORT="${PORT:-3000}"
export HOST="0.0.0.0"
export APP_EXPOSURE="admin-only"

if [[ -z "${ALLOWED_HOSTS:-}" ]]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  if [[ -n "$LAN_IP" ]]; then
    export ALLOWED_HOSTS="localhost,127.0.0.1,::1,$LAN_IP,intron-tools.local"
  else
    export ALLOWED_HOSTS="localhost,127.0.0.1,::1,intron-tools.local"
  fi
fi

exec npm run dev
