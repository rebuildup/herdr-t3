#!/usr/bin/env bash
# Launch the PACKAGED hoxay app against an isolated herdr session and hand
# a CDP port to the caller (issue #640, herdr TUI ⇄ hoxay comparison).
#
# This is the measurement-side sibling of scripts/ui-electron.sh: same
# safety rules (isolated session, isolated userData, machine-global lease,
# independent watchdog, reap-only-what-we-spawned), but it stops at
# "the app is up and debuggable" and lets the comparison harness drive it.
#
# Usage:
#   quality/tui-parity/packaged.sh <app-path> [session-name] -- <command...>
# The command runs with CDP_PORT and HERDR_SOCKET exported; the app and the
# isolated session are torn down when it returns.
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

APP_PATH="${1:?usage: packaged.sh <app-path> [session-name] -- <command...>}"
SESSION="${2:-ht3parity}"
if [[ "${3:-}" == "--" ]]; then
  shift 3
else
  shift 2
fi
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
CDP_PORT="${CDP_PORT:-$(free_port)}"

DIAG_DIR="$(mktemp -d -t parity-diag)"
PIDS_FILE="$DIAG_DIR/pids.txt"
: >"$PIDS_FILE"
ISO_STATE="$(mktemp -d -t parity-state)"
record_pid() { echo "$1 $2" >>"$PIDS_FILE"; }

cleanup() {
  # The watchdog owns the machine-global lease; it must not outlive this
  # run, or the next run would be denied by a lease nobody releases.
  if [[ -n "${WATCHDOG_PID:-}" ]]; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [[ -s "$PIDS_FILE" ]]; then
    bun harness/ui/reap-cli.ts --pids-file "$PIDS_FILE" >/dev/null 2>&1 || true
  fi
  rm -rf "$ISO_STATE"
}
trap cleanup EXIT

# Independent watchdog: owns the machine-global lease and kills only the
# pids this run spawned when the budget expires.
bun harness/ui/watchdog-cli.ts \
  --budget-ms "${UI_BUDGET_RUN:-900000}" \
  --pids-file "$PIDS_FILE" \
  --diag-dir "$DIAG_DIR" \
  --label "tui-parity $SESSION" \
  --owner "${USER:-?}@$(hostname)" \
  --worktree "$REPO_ROOT" \
  --session "$SESSION" \
  --ports "cdp=$CDP_PORT" \
  >"$DIAG_DIR/watchdog.log" 2>&1 &
WATCHDOG_PID=$!
sleep 0.5
if ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
  cat "$DIAG_DIR/watchdog.log" >&2
  echo "packaged.sh: watchdog/lease failed to start" >&2
  exit 1
fi

# Isolated herdr session (never the maintainer's live session). A stale
# socket from an earlier run is not a running server — check the server
# itself, not the socket file.
if ! herdr --session "$SESSION" status server 2>/dev/null | grep -q "status: running"; then
  rm -f "$SOCK"
  herdr --session "$SESSION" server >"$DIAG_DIR/herdr.log" 2>&1 &
  record_pid $! herdr-server
fi
for i in $(seq 1 60); do
  [[ -S "$SOCK" ]] && break
  sleep 0.5
done
[[ -S "$SOCK" ]] || { echo "packaged.sh: herdr session socket did not appear: $SOCK" >&2; exit 1; }

# Seed the fixture BEFORE the app attaches: a pane the client owns cannot
# be driven with `pane run` once the client is attached to it.
FIXTURE_FILE="$DIAG_DIR/fixture.json"
bun quality/tui-parity/run.ts seed --session "$SESSION" --fixture-out "$FIXTURE_FILE" >/dev/null

if [[ -d "$APP_PATH" && "$APP_PATH" == *.app ]]; then
  APP_BIN="$(find "$APP_PATH/Contents/MacOS" -maxdepth 1 -type f | head -1)"
else
  APP_BIN="$APP_PATH"
fi
[[ -x "$APP_BIN" ]] || { echo "packaged.sh: not executable: $APP_BIN" >&2; exit 1; }

APP_SPAWN_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"
HERDR_SOCKET="$SOCK" HERDR_T3_PROFILE=dev XDG_STATE_HOME="$ISO_STATE" \
  HERDR_T3_APP_SPAWN_MS="$APP_SPAWN_MS" \
  "$APP_BIN" --remote-debugging-port="$CDP_PORT" >"$DIAG_DIR/app.log" 2>&1 &
record_pid $! hoxay

for i in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || {
  echo "packaged.sh: CDP endpoint never came up; log: $DIAG_DIR/app.log" >&2
  exit 1
}

export CDP_PORT HERDR_SOCKET="$SOCK" HERDR_T3_FIXTURE="$FIXTURE_FILE" HERDR_T3_APP_SPAWN_MS="$APP_SPAWN_MS"

if [[ $# -gt 0 ]]; then
  "$@"
  exit $?
fi
echo "$CDP_PORT $SOCK"
