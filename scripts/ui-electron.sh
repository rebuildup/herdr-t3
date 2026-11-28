#!/usr/bin/env bash
# Launch the full conformance stack and run UI scenarios against the real
# Electron app (issue #238; budgets/lease per the #416 program):
#
#   isolated herdr session (seeded fixtures) -> bridge -> vite -> electron
#
# The app under test is the REAL product: CDP drives actual mouse/wheel
# input and observes real app state via the read-only uiObserve bridge.
# Never point this at the maintainer's live herdr session — the fixture
# session is dedicated (default name "ht3ui") and is stopped on exit.
#
# Real-machine safety (issue #416 program):
#   - an exclusive lease (machine-global state dir, held by the watchdog
#     process) serializes real-machine verification across worktrees;
#   - an independent watchdog process enforces the whole-run budget and,
#     on expiry, writes diagnostics and kills ONLY pids this run spawned
#     (recorded in the pid file) — never another session's processes;
#   - every wait below is deadline-bounded; a hang fails, it does not stall.
#
# Usage: scripts/ui-electron.sh [extra run.ts args...]
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SESSION="${UI_SESSION:-ht3ui}"
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"

# Ports must be free before we spawn: a stale process holding the bridge
# port makes the run's bridge die with EADDRINUSE while the page still
# loads — the operable gate then fails for a reason unrelated to the
# product. Defaults are auto-allocated free ports so concurrent sessions
# and leftovers never collide; explicit UI_*_PORT / CDP_PORT overrides
# are honored but pre-flight checked (fail fast, name the holder).
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
port_holder() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -3; }

if [[ -n "${CDP_PORT:-}" ]]; then :; else CDP_PORT="$(free_port)"; fi
if [[ -n "${UI_BRIDGE_PORT:-}" ]]; then BRIDGE_PORT="$UI_BRIDGE_PORT"; else BRIDGE_PORT="$(free_port)"; fi
if [[ -n "${UI_VITE_PORT:-}" ]]; then VITE_PORT="$UI_VITE_PORT"; else VITE_PORT="$(free_port)"; fi
for spec in "cdp:$CDP_PORT" "bridge:$BRIDGE_PORT" "vite:$VITE_PORT"; do
  name="${spec%%:*}"; port="${spec##*:}"
  if holder="$(port_holder "$port")" && [[ -n "$holder" ]]; then
    echo "ui-electron: port $port ($name) already in use:" >&2
    echo "$holder" >&2
    echo "ui-electron: stop the holder or set CDP_PORT/UI_BRIDGE_PORT/UI_VITE_PORT; refusing to disturb it" >&2
    exit 1
  fi
done
# Lease defaults to the machine-global path inside watchdog-cli
# (shared by every worktree); UI_LEASE_FILE overrides for tests.
LEASE_ARGS=()
[[ -n "${UI_LEASE_FILE:-}" ]] && LEASE_ARGS=(--lease-file "$UI_LEASE_FILE")
DIAG_DIR="$(mktemp -d -t ui-diag)"
PIDS_FILE="$DIAG_DIR/pids.txt"
: >"$PIDS_FILE"
VITE_LOG="$DIAG_DIR/vite.log"
ELECTRON_LOG="$DIAG_DIR/electron.log"
HERDR_LOG="$DIAG_DIR/herdr.log"
BRIDGE_LOG="$DIAG_DIR/bridge.log"
WATCHDOG_LOG="$DIAG_DIR/watchdog.log"

HERDR_PID=""
VITE_PID=""
ELECTRON_PID=""
BRIDGE_PID=""
WATCHDOG_PID=""
# Isolate the machine registry: saved SSH endpoints live under
# $XDG_STATE_HOME/herdr/client/endpoints.json, and a reachable remote
# machine would add its panes to goto-picker rows and break the fixed
# row-count contract. The fixture must see only the local machine.
ISO_STATE="$(mktemp -d -t ui-state)"

record_pid() { echo "$1 $2" >>"$PIDS_FILE"; }

cleanup() {
  # Reap only pids this run recorded plus their descendants (Electron
  # GPU/renderer helpers) — cross-platform via reap-cli; concurrent
  # sessions' processes are never touched.
  if [[ -s "$PIDS_FILE" ]]; then
    bun harness/ui/reap-cli.ts --pids-file "$PIDS_FILE" >/dev/null 2>&1 || true
  fi
  [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
  rm -rf "$ISO_STATE"
}
trap cleanup EXIT
fail() {
  echo "ui-electron: $*" >&2
  echo "diagnostics kept at: $DIAG_DIR" >&2
  exit 1
}

# --- exclusive lease + independent watchdog ------------------------------
# The watchdog process holds the lease for the run's lifetime: its pid is
# the lease owner, so the lease is valid exactly while verification runs.
RUN_BUDGET_MS="${UI_BUDGET_RUN:-900000}"
# Packaged mode (UI_PACKAGED_APP=<binary or .app path>): verify the REAL
# distributed artifact — no vite dev server, no separate bridge; the app
# embeds the bridge in-process and loads dist/ over file://. The READY
# budget stays at its 5s product default: this is the spawn->operable
# contract the shipped app must meet. Dev mode keeps its measured
# environment budget instead.
PACKAGED="${UI_PACKAGED_APP:-}"
if [[ -z "$PACKAGED" ]]; then
  # Dev-server harness budget: measured spawn->operable on this dev
  # environment is ~8s idle but ~20s under realistic multi-worktree load
  # (Electron cold start to CDP ~8s + vite-served module waterfall ~10s).
  # The 5s UI_BUDGET_READY default remains the PRODUCT contract verified
  # on packaged builds; the dev harness gets its own measured budget so
  # hangs still fail fast without false-positiving on dev-server
  # transform/startup overhead. Override with UI_BUDGET_READY.
  export UI_BUDGET_READY="${UI_BUDGET_READY:-45000}"
fi
bun harness/ui/watchdog-cli.ts \
  --budget-ms "$RUN_BUDGET_MS" \
  --pids-file "$PIDS_FILE" \
  --diag-dir "$DIAG_DIR" \
  --label "ui-electron $SESSION" \
  ${LEASE_ARGS[@]+"${LEASE_ARGS[@]}"} \
  --owner "${USER:-?}@$(hostname)" \
  --worktree "$REPO_ROOT" \
  --session "$SESSION" \
  --ports "cdp=$CDP_PORT,bridge=$BRIDGE_PORT,vite=$VITE_PORT" \
  >"$WATCHDOG_LOG" 2>&1 &
WATCHDOG_PID=$!
# Lease denial exits 4 quickly; give it a moment then check.
sleep 0.5
if ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
  cat "$WATCHDOG_LOG" >&2
  fail "watchdog/lease failed to start (see above)"
fi

# --- isolated herdr session --------------------------------------------
if [[ ! -S "$SOCK" ]]; then
  herdr --session "$SESSION" server >"$HERDR_LOG" 2>&1 &
  HERDR_PID=$!
  record_pid "$HERDR_PID" herdr-server
fi
for i in $(seq 1 60); do
  [[ -S "$SOCK" ]] && break
  sleep 0.5
done
[[ -S "$SOCK" ]] || fail "herdr session socket did not appear: $SOCK"

# Seed fixtures deterministically: two workspaces, each with a pane that
# has >300 rows of scrollback and a live foreground process.
for ws in $(herdr --session "$SESSION" workspace list | python3 -c "import json,sys; [print(w['workspace_id']) for w in json.load(sys.stdin)['result']['workspaces']]"); do
  herdr --session "$SESSION" workspace close "$ws" >/dev/null
done

ws_a=$(herdr --session "$SESSION" workspace create --label ui-a --no-focus | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print(d['workspace']['workspace_id'], d['root_pane']['pane_id'])")
ws_b=$(herdr --session "$SESSION" workspace create --label ui-b --no-focus | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print(d['workspace']['workspace_id'], d['root_pane']['pane_id'])")
read -r id_a pane_a <<<"$ws_a"
read -r id_b pane_b <<<"$ws_b"

herdr --session "$SESSION" pane run "$pane_a" "seq 1 400; cat" >/dev/null
herdr --session "$SESSION" pane run "$pane_b" "seq 101 500; cat" >/dev/null

for p in "$pane_a" "$pane_b"; do
  for i in $(seq 1 40); do
    max=$(herdr --session "$SESSION" pane get "$p" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['pane']['scroll']['max_offset_from_bottom'])")
    [[ "$max" -gt 300 ]] && break
    sleep 0.5
  done
  [[ "$max" -gt 300 ]] || fail "fixture pane $p did not accumulate scrollback (max=$max)"
done
echo "seeded session $SESSION: $id_a/$pane_a + $id_b/$pane_b (scrollback ready)"

# --- bridge + vite + electron -------------------------------------------
APP_BIN=""
if [[ -n "$PACKAGED" ]]; then
  # Resolve a .app bundle or bare binary to the executable inside.
  if [[ -d "$PACKAGED" && "$PACKAGED" == *.app ]]; then
    APP_BIN="$(find "$PACKAGED/Contents/MacOS" -maxdepth 1 -type f | head -1)"
  else
    APP_BIN="$PACKAGED"
  fi
  [[ -x "$APP_BIN" ]] || fail "packaged app binary not executable: $APP_BIN"
else
  PORT="$BRIDGE_PORT" HERDR_T3_PORT="$BRIDGE_PORT" HERDR_SOCKET="$SOCK" \
    HERDR_T3_ALLOWED_ORIGINS="http://localhost:$VITE_PORT,http://127.0.0.1:$VITE_PORT" \
    XDG_STATE_HOME="$ISO_STATE" \
    bun run server >"$BRIDGE_LOG" 2>&1 &
  BRIDGE_PID=$!
  record_pid "$BRIDGE_PID" bridge

  HERDR_T3_PORT="$BRIDGE_PORT" bun --bun vite --port "$VITE_PORT" --strictPort >"$VITE_LOG" 2>&1 &
  VITE_PID=$!
  record_pid "$VITE_PID" vite

  for i in $(seq 1 60); do
    curl -sf "http://localhost:$VITE_PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf "http://localhost:$VITE_PORT" >/dev/null || fail "vite did not come up on :$VITE_PORT"

  # Rebuild the desktop bundle first: desktop/main.cjs is a gitignored build
  # artifact and a stale one silently drops newer ClientFrame types
  # (terminal_scroll/terminal_mouse/plugin_*) at the IPC guard.
  bun run desktop:build >/dev/null
fi

# The desktop main embeds the bridge in-process and resolves the herdr
# socket from HERDR_SOCKET itself — it must be pointed at the fixture
# session explicitly or it would attach to the live default session.
# ELECTRON_SPAWN_MS anchors the single spawn->operable deadline (READY
# budget): CDP connect, init and the operable probe all share it —
# launch latency can never hide outside the budget. Packaged mode keeps
# the 5s product default; dev mode uses the measured environment budget.
ELECTRON_SPAWN_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"
if [[ -n "$PACKAGED" ]]; then
  # HERDR_T3_PROFILE=dev isolates userData (herdr-t3-dev) so the packaged
  # binary never touches the maintainer's real settings; dist/ inside the
  # bundle is the shipped artifact either way.
  HERDR_SOCKET="$SOCK" HERDR_T3_PROFILE=dev XDG_STATE_HOME="$ISO_STATE" \
    "$APP_BIN" --remote-debugging-port="$CDP_PORT" >"$ELECTRON_LOG" 2>&1 &
else
  HERDR_T3_DEV_URL="http://localhost:$VITE_PORT" HERDR_T3_PROFILE=dev HERDR_SOCKET="$SOCK" \
    XDG_STATE_HOME="$ISO_STATE" \
    ./node_modules/.bin/electron . --remote-debugging-port="$CDP_PORT" >"$ELECTRON_LOG" 2>&1 &
fi
ELECTRON_PID=$!
record_pid "$ELECTRON_PID" electron

# CDP endpoint up is necessary but NOT sufficient — the adapter's
# operable-state probe (observe() round-trip + /api/health through the
# page origin) inside the single spawn->operable deadline (READY budget,
# default 5s, anchored at ELECTRON_SPAWN_MS) is the real launch-success
# gate. A hung launch fails the run and cleanup reaps only this run's
# recorded pids plus their descendants.
for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || \
  fail "electron CDP did not come up; log: $ELECTRON_LOG"

# Startup breakdown evidence: spawn -> CDP endpoint vs the shared
# spawn -> operable deadline the adapter now enforces.
CDP_UP_MS="$(python3 -c 'import time; print(int(time.time()*1000))')"
echo "electron CDP endpoint up $((CDP_UP_MS - ELECTRON_SPAWN_MS))ms after spawn"

UI_ELECTRON_SPAWN_MS="$ELECTRON_SPAWN_MS" \
  bun harness/ui/run.ts --adapter electron --cdp-port "$CDP_PORT" "$@"
