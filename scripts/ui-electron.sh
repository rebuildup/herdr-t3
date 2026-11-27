#!/usr/bin/env bash
# Launch the full conformance stack and run UI scenarios against the real
# Electron app (issue #238):
#
#   isolated herdr session (seeded fixtures) -> bridge -> vite -> electron
#
# The app under test is the REAL product: CDP drives actual mouse/wheel
# input and observes real app state via the read-only uiObserve bridge.
# Never point this at the maintainer's live herdr session — the fixture
# session is dedicated (default name "ht3ui") and is stopped on exit.
#
# Usage: scripts/ui-electron.sh [extra run.ts args...]
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SESSION="${UI_SESSION:-ht3ui}"
SOCK="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"
CDP_PORT="${CDP_PORT:-9223}"
BRIDGE_PORT="${UI_BRIDGE_PORT:-4741}"
VITE_LOG="$(mktemp -t ui-vite)"
ELECTRON_LOG="$(mktemp -t ui-electron)"
HERDR_LOG="$(mktemp -t ui-herdr)"
BRIDGE_LOG="$(mktemp -t ui-bridge)"

HERDR_PID=""
VITE_PID=""
ELECTRON_PID=""
BRIDGE_PID=""
# Isolate the machine registry: saved SSH endpoints live under
# $XDG_STATE_HOME/herdr/client/endpoints.json, and a reachable remote
# machine would add its panes to goto-picker rows and break the fixed
# row-count contract. The fixture must see only the local machine.
ISO_STATE="$(mktemp -d -t ui-state)"

cleanup() {
  kill "$ELECTRON_PID" "$VITE_PID" "$BRIDGE_PID" "$HERDR_PID" 2>/dev/null || true
  wait "$ELECTRON_PID" "$VITE_PID" "$BRIDGE_PID" "$HERDR_PID" 2>/dev/null || true
  rm -rf "$ISO_STATE"
}
trap cleanup EXIT

# --- isolated herdr session --------------------------------------------
if [[ ! -S "$SOCK" ]]; then
  herdr --session "$SESSION" server >"$HERDR_LOG" 2>&1 &
  HERDR_PID=$!
fi
for i in $(seq 1 60); do
  [[ -S "$SOCK" ]] && break
  sleep 0.5
done
[[ -S "$SOCK" ]] || { echo "herdr session socket did not appear: $SOCK" >&2; tail -20 "$HERDR_LOG" >&2; exit 1; }

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
  [[ "$max" -gt 300 ]] || { echo "fixture pane $p did not accumulate scrollback (max=$max)" >&2; exit 1; }
done
echo "seeded session $SESSION: $id_a/$pane_a + $id_b/$pane_b (scrollback ready)"

# --- bridge + vite + electron -------------------------------------------
PORT="$BRIDGE_PORT" HERDR_T3_PORT="$BRIDGE_PORT" HERDR_SOCKET="$SOCK" \
  HERDR_T3_ALLOWED_ORIGINS="http://localhost:5737,http://127.0.0.1:5737" \
  XDG_STATE_HOME="$ISO_STATE" \
  bun run server >"$BRIDGE_LOG" 2>&1 &
BRIDGE_PID=$!

HERDR_T3_PORT="$BRIDGE_PORT" bun --bun vite --port 5737 --strictPort >"$VITE_LOG" 2>&1 &
VITE_PID=$!

for i in $(seq 1 60); do
  curl -sf http://localhost:5737 >/dev/null 2>&1 && break
  sleep 0.5
done

# Rebuild the desktop bundle first: desktop/main.cjs is a gitignored build
# artifact and a stale one silently drops newer ClientFrame types
# (terminal_scroll/terminal_mouse/plugin_*) at the IPC guard.
bun run desktop:build >/dev/null

# The desktop main embeds the bridge in-process and resolves the herdr
# socket from HERDR_SOCKET itself — it must be pointed at the fixture
# session explicitly or it would attach to the live default session.
HERDR_T3_DEV_URL=http://localhost:5737 HERDR_T3_PROFILE=dev HERDR_SOCKET="$SOCK" \
  XDG_STATE_HOME="$ISO_STATE" \
  ./node_modules/.bin/electron . --remote-debugging-port="$CDP_PORT" >"$ELECTRON_LOG" 2>&1 &
ELECTRON_PID=$!

for i in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || {
  echo "electron CDP did not come up; log:" >&2
  tail -30 "$ELECTRON_LOG" >&2
  exit 1
}

bun harness/ui/run.ts --adapter electron --cdp-port "$CDP_PORT" "$@"
