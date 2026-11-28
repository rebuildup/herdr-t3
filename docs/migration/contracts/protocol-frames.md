# Contract: protocol frames (B1)

Version: 1. Scope: the wire contract between bridge and UI —
`shared/protocol.ts` (`ClientFrame`, `ServerFrame`, `SessionSnapshot`,
`RPC_METHODS`, plugin boundary types) and the binary attach codec in
`server/client-link.ts`. Implementation-independent: any future bridge
(Rust or otherwise) must satisfy this contract, not the TypeScript types.

## Operations

- `rpc(id, method, params, machine?)` → `rpc_result(id, ok, result|error{code,message}, machine?)`.
  One outstanding call per id; ids are caller-chosen and may be reused
  after the answer arrives.
- `subscribe_terminal(paneId, cols?, rows?, machine?, takeover?)` →
  `terminal_data` frames then steady-state attach stream;
  `unsubscribe_terminal(paneId)` detaches.
- `terminal_input(paneId, data)`, `terminal_resize(paneId, cols, rows)`,
  `terminal_mouse(...)`, `terminal_scroll(...)` → attach-stream client
  messages; no direct response (see terminal-session contract).
- `list_machines`, `machine_connect/disconnect/add/remove/update` →
  `machines` / `machine_status` frames.
- `machine_select(machine)` → declares the single machine whose session
  runs in full detail mode (issue #585): canvas layouts, pane scroll
  state and terminal attach eligibility. Every other connected machine
  stays in summary mode — the same `events.subscribe` structure +
  agent-status stream and snapshot pushes, but with canvas detail
  stripped. Idempotent; also connects the machine on demand.
- `plugin_list(id, machine?)`, `plugin_call(id, machine, plugin, command, args, session?)`
  → `rpc_result` tagged with `machine`.
- Server → client: `ready{snapshot,machine,detail?}`,
  `snapshot{snapshot,machine,probe?,detail?}`, `event{event,machine}`,
  `terminal_data`, `terminal_mouse_capture`, `terminal_closed{reason?}`,
  `machines`, `machine_status`. `detail?: "summary"` marks a snapshot
  pushed by a summary-mode session (issue #585): workspaces, tabs,
  agents and pane identity/status are intact; `layouts` is empty and
  `panes[].scroll` is absent. Absent `detail` means full detail.

## Ordering and semantics

- `ready` carries the first full `SessionSnapshot`; later `snapshot`
  frames are authoritative replacements, not deltas. `probe` snapshots
  describe a machine that is not connected and must not be treated as
  live state.
- `rpc_result` answers are matched by `id`; a bridge must not emit two
  answers for one id.
- Snapshot fields herdr adds later are tolerated (additive tolerance);
  a consumer must not depend on field order or on fields outside the
  declared types.
- The attach codec (`client-link.ts`, bincode-2 varint + tagged frames)
  is versioned by herdr's protocol (22 at the pinned baseline,
  `docs/upstream.md`). Frame decode must reject truncated input and skip
  unknown variants without mis-framing the stream.

## Malformed input (adapter boundary)

- Both adapters reject non-object frames/snapshots and server frames
  whose envelope fails the contract shape check; the accept/reject
  decision is identical, error text differs.
- The Rust typed codec is intentionally stricter on *wrong-typed
  declared fields* inside otherwise-valid payloads (e.g. a
  `machine_status.machine.id` that is not a string, or snapshot
  `workspaces` entries with a non-string `workspace_id`): serde decode
  fails where the TS bare cast tolerates and echoes the value. This is
  a documented strengthening (#275), not a behavioral regression —
  real payloads come from herdr's typed encoder. Differential scenarios
  therefore cover malformed envelopes and well-formed payloads, and
  exclude wrong-typed declared fields (covered by Rust unit tests).

## Errors

- `rpc_result.ok=false` carries `{code,message}`; codes are stable
  strings (`machine_update_failed`, plugin contract codes such as
  `not_installed`/`unsupported_command`/repo-state kinds — see
  plugins-boundary). Transport-level failures surface as connection
  loss, not fabricated `ok` results.
- Malformed client frames are rejected; the bridge must not crash or
  emit partial state.

## Negative cases (must be verified)

- second `events.subscribe` on a held subscribe connection is ignored —
  callers must reopen with the full subscription set (AGENTS.md §3);
- `pane.process_info` must take `pane_id`, never `target` (silent
  wrong-pane answer otherwise);
- unknown/garbage frames never produce a snapshot mutation;
- `plugin_call` args are `string[]` elements — no shell interpolation.

## Evidence today

`shared/protocol.test.ts`, `server/client-link.test.ts`,
`server/guard.test.ts` (dev-server request guard), live attach exercised
by `scripts/verify-terminal-input.ts`. Differential replay: #237.
