#!/usr/bin/env bash
# Launch an isolated herdr session with the parity fixture and run a
# command against the TUI (baseline) side of the herdr TUI ⇄ hoxay
# comparison (issue #640). Sibling of packaged.sh: same safety rules
# (isolated session, machine-global lease via the watchdog, reap-only-
# what-we-spawned), but no app — the command drives `run.ts tui` /
# `run.ts soak-tui` through the pty driver.
#
# Usage:
#   quality/tui-parity/tui.sh [session-name] -- <command...>
# The command runs with HERDR_SOCKET and HERDR_T3_FIXTURE exported; the
# isolated session is torn down when it returns.
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SESSION="${1:-ht3paritytui}"
if [[ "${2:-}" == "--" ]]; then
  shift 2
else
  shift 1
fi
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"

DIAG_DIR="$(mktemp -d -t parity-tui-diag)"
PIDS_FILE="$DIAG_DIR/pids.txt"
: >"$PIDS_FILE"
ISO_STATE="$(mktemp -d -t parity-tui-state)"
record_pid() { echo "$1 $2" >>"$PIDS_FILE"; }

cleanup() {
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
  --label "tui-parity-tui $SESSION" \
  --owner "${USER:-?}@$(hostname)" \
  --worktree "$REPO_ROOT" \
  --session "$SESSION" \
  >"$DIAG_DIR/watchdog.log" 2>&1 &
WATCHDOG_PID=$!
sleep 0.5
if ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
  cat "$DIAG_DIR/watchdog.log" >&2
  echo "tui.sh: watchdog/lease failed to start" >&2
  exit 1
fi

# Isolated herdr session (never the maintainer's live session).
if ! herdr --session "$SESSION" status server 2>/dev/null | grep -q "status: running"; then
  rm -f "$SOCK"
  herdr --session "$SESSION" server >"$DIAG_DIR/herdr.log" 2>&1 &
  record_pid $! herdr-server
fi
for i in $(seq 1 60); do
  [[ -S "$SOCK" ]] && break
  sleep 0.5
done
[[ -S "$SOCK" ]] || { echo "tui.sh: herdr session socket did not appear: $SOCK" >&2; exit 1; }

# Seed the fixture BEFORE any client attaches (same rule as packaged.sh).
FIXTURE_FILE="$DIAG_DIR/fixture.json"
bun quality/tui-parity/run.ts seed --session "$SESSION" --fixture-out "$FIXTURE_FILE" >/dev/null

export HERDR_SOCKET="$SOCK" HERDR_T3_FIXTURE="$FIXTURE_FILE" XDG_STATE_HOME="$ISO_STATE"

if [[ $# -gt 0 ]]; then
  "$@"
  exit $?
fi
echo "$SOCK"
