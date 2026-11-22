#!/usr/bin/env bash
# Development profile launcher: bridge + Vite HMR.
#
# - Bridge binds 127.0.0.1:4738 (PORT override) — never the stable 4737.
# - Vite serves on :5737 and proxies /api + /ws to the dev bridge.
# - Set HERDR_SOCKET to an isolated herdr session socket for tests; unset
#   uses the default session socket.
# - The dev Vite origin is admitted through HERDR_T3_ALLOWED_ORIGINS; the
#   stable profile does not set it.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${PORT:-4738}"
export HERDR_T3_PORT="${HERDR_T3_PORT:-$PORT}"
export HERDR_T3_ALLOWED_ORIGINS="${HERDR_T3_ALLOWED_ORIGINS:-http://localhost:5737,http://127.0.0.1:5737}"

bun run server &
bridge_pid=$!
trap 'kill "$bridge_pid" 2>/dev/null || true' EXIT

exec bun --bun vite
