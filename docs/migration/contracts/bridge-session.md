# Contract: bridge session (B2)

Version: 1. Scope: connecting to herdr, subscribing to state, attaching
panes, reconnecting — the observable session lifecycle of the bridge.
Normative rules: AGENTS.md §3 invariants; attach-stream semantics:
ADR-0010; wire shapes: protocol-frames.

## Operations

- Connect (local socket / SSH forwarded socket / Windows named pipe) →
  `ready` with full snapshot.
- `session.snapshot` / `events.subscribe` → `snapshot`/`event` stream.
  Only `events.subscribe` stays open; every other herdr RPC is
  one-connection-per-call.
- Snapshot push policy (issue #423, both TS and Rust implementations):
  - A successful client RPC schedules a snapshot refetch only for
    methods outside `READ_ONLY_RPC_METHODS` (`shared/protocol.ts`);
    read-only calls (`session.snapshot`, `agent.get/read/explain`,
    `pane.process_info`, `pane.link.resolve`, `worktree.list`) never
    trigger one. Unknown methods default to refreshing.
  - At most one `session.snapshot` fetch is in flight per session;
    triggers during a fetch queue a single trailing refetch.
  - A fetched snapshot identical to the last one delivered to the
    client is not re-pushed (dedup on content, not on fetch).
  - `READ_ONLY_RPC_METHODS`/`isReadOnlyRpcMethod` in
    `shared/protocol.ts` are the shared classification both
    implementations must honor. The TS session applies it where client
    RPC results are handled; the Rust `BridgeSession` has no client-RPC
    path of its own — a GPUI consumer that issues mutating RPCs must
    apply the same rule (schedule a refetch only for non-read-only
    methods) at its call site. Verification condition: the
    `rpc-read`/`activity` legs of `scripts/perf-bridge-load.ts` must
    show `bridge.snapshot.schedule{cause=rpc}` == 0 for read-only
    traffic on whichever implementation is under test.
- `subscribe_terminal` → attach stream (`terminal_data` frames) is the
  truth for that pane's screen; input flows back through
  `terminal_input`/`terminal_mouse`/`terminal_scroll`.
- Disconnect → UI keeps last snapshot; reconnect → fresh `ready` +
  snapshot; panes re-attach or fall back per terminal-session contract.

## Ordering and semantics

- Attach stream is authoritative for attached panes; `pane.read` is
  only for panes that cannot be attached (mirrored panes on hosts
  without a PTY bridge). Never assume a pty exists.
- While a writable attach is held, herdr fixes that pane's size to the
  client's cols/rows (ADR-0010, herdr protocol 22); the GUI reports its
  measured cell size via `terminal_resize` and does not negotiate. Only
  the operator pane holds writable attach — granted by input intent,
  released on focus change (issue #584,
  `terminal-noninterference.md`); all other panes observe.
- Nothing the user typed is sent automatically after a disconnect —
  typed input waits in a draft until the user sends or discards it.
- Prompt answers go through `agent.prompt` / the prompt-answer API,
  never guessed digit keys.

## Errors and failure modes

- herdr unreachable / socket refused / SSH failure → machine status
  transitions (`machine_status`), UI shows offline/stale; no fabricated
  snapshot.
- Attach target gone → `terminal_closed{reason}`; pane falls back to
  mirror read if applicable, else an explicit unavailable state.
- Timeout on herdr RPC → `rpc_result.ok=false` with a stable code;
  subscribe stream loss triggers resubscribe with the full subscription
  set, not a partial one.
- Backpressure: terminal output must not grow unboundedly in the bridge;
  slow consumers are throttled/dropped per current policy (#213).

## Negative cases

- draft auto-send after reconnect (forbidden);
- second subscribe on a held connection treated as success;
- `pane.read` used to rebuild an attachable pane;
- guessed digit-key prompt answers;
- tests pointed at the live herdr session (isolation vars required).

## Evidence today

`server/herdr.test.ts`, `server/bridge-core.ts` paths,
`server/bridge-core.test.ts` (attach-queue semantics: pre-attach frames
flush in order on attach, are dropped with no subscription, and are
abandoned on attach failure or session teardown — issue #356),
`scripts/verify-terminal-input.ts` (live attach-path checks),
`scripts/verify-reconnect-draft.ts` (attach→input→bridge kill→reconnect→
draft retained / outage input never delivered / explicit send only;
issue #356), `scripts/verify-guard.ts` (harness isolation enforcement).
Differential replay incl. fault injection: #237.
