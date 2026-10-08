#!/usr/bin/env sh
# tokencheck launcher — opens the dashboard once the server is listening.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[tokencheck] 未找到 Node.js，请先安装 Node 22.5 或更高版本。" >&2
  exit 1
fi

PORT="${TOKENCHECK_PORT:-7788}"
echo "[tokencheck] 启动中 → http://127.0.0.1:${PORT}/"

node --experimental-sqlite src/server.mjs &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' INT TERM EXIT

# Open a browser if one is available; never fail the launcher over it.
sleep 1
URL="http://127.0.0.1:${PORT}/"
if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
fi

wait "$SERVER_PID"
