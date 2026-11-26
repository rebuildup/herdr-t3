# Contract: handoff read surface — list/status/resume-info (B3)

Version: 1. Scope: consuming `herdr-plugins.handoff/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/herdr-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`). The plugin owns handoff/delegation records — payload
*references* (never transcript copies) bound to a source
pane/agent generation, a `pending|ready|delivered|done|failed|
superseded` lifecycle, execution targets, and derived lineage; this
client consumes the read surface only (issue #404). Upstream spec:
`herdr-plugins/docs/contracts/handoff-v1.md` (**v1 stable** since
herdr-plugins v0.6.0 / plugin v0.6.0).

The contract DOES advertise writes — `create`, `execute`, `delegate`,
`merge-back` are top-level commands, not `mutation_commands` entries.
This surface never calls them: `HANDOFF_MUTATION_COMMANDS` is an empty
allowlist and `handoffsSupportsMutation` fails closed, so a mutation
ticket must extend the allowlist deliberately.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract:"herdr-plugins.handoff/v1", command, …}` on
stdout (`capability` emits the bare discovery document):

- `capability` → `{contract, plugin:"rebuildup.handoff", version,
  commands:[…], execution:"same_host_and_remote_saved_machines",
  lineage:{…}, execution_surface:{…}, limits:{…}}`. This client
  requires `list`, `status`, `resume-info` in `commands` (the read
  surface); `create`/`execute`/`delegate`/`merge-back`/`remote-probe`
  are recognized but never invoked.
- `list [--status S] [--limit N]` → `{total, count, truncated, items[],
  state_file, generated_at}`. Eager per-machine store read (fetched
  with `--limit 500`, the contract maximum; `truncated` is still
  rendered verbatim). Each item carries `id`, `status`, `strategy`,
  `created_at`/`updated_at`, `relationship` (or null), derived
  `child_count`, the `transfer` identity subset, `target` (recorded
  intent), `target_pane_id` (execution target once run), `ref_count`,
  `has_excerpt`, and a per-item `transfer_check` verdict —
  `{state:"ok"}` | `{state:"stale",reason}` |
  `{state:"unchecked",reason:"snapshot_unavailable|other_session"}`.
  `unchecked` is honest data (foreign session or unreachable
  snapshot), never guessed stale. An empty registry (`items: []`,
  `total: 0`) is the common case — records are created by agents via
  CLI/MCP — rendered verbatim.
- `status <handoff-id> --no-reconcile` → `{handoff:<full record>,
  lineage, transfer_check, target_check, remote_check,
  payload_resolution[]|null, missing_refs, state_file, generated_at}`.
  On-demand only: ref resolution shells out to owner plugin CLIs
  (`rebuildup.conversations`, `rebuildup.checkpoints`, self state) and
  can be slow. **`--no-reconcile` is always passed** — the contract's
  lazy `delivered → done` reconciliation persists plugin state, and a
  read surface must not write. `--no-resolve-refs` is deliberately
  NOT passed: per-ref resolution is the point of the detail view.
  - `handoff` record: `transfer` identity (host/session_key/pane/
    agent_session/state_change_seq generation signals), `target`
    intent, `relationship` lineage link, `payload.refs` discriminated
    union (`conversation_session`/`checkpoint`/`handoff_record`/
    `external` — unknown future kinds kept verbatim), bounded
    `excerpt`, `requirements`, and the optional `execution` block
    (strategy_used/decision/resume_args/target/agent/prompt/error/
    observed/remote/worktree) parsed field-by-field.
  - `transfer_check`/`target_check`/`remote_check` verdicts rendered
    verbatim; `target_check.state` ∈ `ok|pane_missing|unchecked` with
    the plugin's `reason` (`not_executed|snapshot_unavailable|
    other_session|remote_target_requires_flag|remote_mismatch`).
  - `payload_resolution[].state` ∈ `resolved|missing_ref|unchecked|
    error|external` — `error` is NEVER collapsed into `missing_ref`;
    `missing_refs` counts only confirmed absences.
  - `lineage` reports the record's own `relationship`, the linked
    `parent` (`missing` flag when evicted), and derived `children`
    ordered by `created_at`; parent/child rows are clickable and
    re-fetch `status` for that id.
- `resume-info [--provider KIND]` → `{providers[], notes[],
  generated_at}`. Provider native-resume capability table
  (`native_resume: supported|unsupported|unknown`,
  `session_id_source`, `resume_args_template` with `{session_id}`
  placeholder, `model_flag`, `notes`). `unknown` is honest
  non-support — rendered verbatim, never upgraded. On-demand fetch
  behind a Load/Hide toggle.

## Operations NOT consumed

- All mutations: `create`, `execute`, `delegate`, `merge-back`,
  `remote-probe` (a read but mutation-adjacent probe — out of scope
  for this surface). They are separate tickets; the empty local
  mutation allowlist fails closed regardless of what `commands`
  advertises.
- `status --remote <machine>` — remote target checks require the
  saved-machine probe; remote-executed records render their
  `remote_check`/`target_check` verdicts verbatim from a local
  `status` call (`remote_target_requires_flag`/`remote_mismatch` stay
  honest), but the client never passes `--remote`.
- `create`/`execute`/`delegate`/`merge-back` argv builders — not
  implemented at all; there is no code path that could emit them.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side kinds (`handoff_not_found`, `unsupported_strategy`,
  `other_session`, `remote_*`, `usage`, …) stay `error` with verbatim
  detail. Structured `error.hint` fields surface verbatim via
  `handoffErrorHint`.
- `refreshHandoffs(machine)` mirrors the usage store: plugin
  discovery → enabled check → capability probe → eager `list` fetch,
  refreshed on snapshot pushes (debounced 800ms), machine online
  transitions, and machine-list changes via `initHandoffs()`. A `list`
  failure keeps the machine `ready` with `listError` and last-good
  list — `status`/`resume-info` may still work.
- `status`/`resume-info` are lazy surface fetches, never cached
  store-side and never polled; the record detail refetches when the
  selection changes. A `--status` filter is a lazy `list --status`
  refetch (contract max `--limit 500`).
