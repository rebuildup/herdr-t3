# Contract: agent projection, inbox and attention (B3)

Version: 1. Scope: how herdr agent state becomes the Agents UI —
shelves, row content, organize state, attention notices. Data sources:
herdr snapshot (`AgentInfo`), `rebuildup.inbox` plugin (organize),
client-side notice store. Canonical UX reference: T3 sidebar settle/
inbox model (ADR-0008/0009).

## Operations

- Agent rows grouped into shelves: Attention, Working, Done, Idle
  (collapsed/expandable), plus plugin-driven Settled/Snoozed overlays.
- Row content: provider/harness icon, display name (herdr
  `agent_label` precedence), work target (stripped terminal title →
  pane metadata title), workspace title + branch/meta, tab label
  (hidden for single-tab workspaces), agent kind + status badge.
- Organize actions (settle/snooze/restore) → plugin contract calls;
  the #173 localStorage overlay is migration input only.
- Attention: snapshot diff per machine → notices (blocked → "needs
  attention", done → "Agent finished") with Open action; first snapshot
  per machine is a baseline and never notifies.
- Row click → navigate to workspace+pane; context menu →
  Focus/Details/Copy IDs; hover → detail card.

## Ordering and semantics

- Shelf order is fixed (Attention → Settled overlay semantics per
  #211); within a shelf, `compareAgents` orders by herdr status
  priority then `state_change_seq` desc (fallback `revision`).
- Organize records key on `(machine, pane_id)`; `state_change_seq`
  advance auto-returns the row and drops the record; unchanged seq
  stays shelved; attention rows are never hidden by organize records.
- Notices dedupe on state signature — repeated identical snapshots do
  not re-fire.
- Stale machines (hard-down status) are excluded from live lists but
  their organize records are preserved, not pruned.

## Malformed input (projection adapter boundary)

- `agent_entries`/`agent_partition` adapter inputs (`machines`,
  `snapshots`, `stale`, `branch_index`, `organize`,
  `unresolved_machines`) must have the declared JSON container types.
  The Rust adapter rejects non-conforming inputs where the TS adapter
  coerces some of them (e.g. a non-object `organize` yields an empty
  organize view in TS). Both reject the clearly invalid cases; the
  accept/reject decision can differ on out-of-contract input, which is
  excluded from differential scenarios.
- On sparse snapshots the TS projection can throw (e.g. a referenced
  snapshot missing `workspaces` hits `snap.workspaces.map`); the Rust
  port returns the empty projection. herdr snapshots always carry
  these arrays, so this is unreachable on contract-conforming data —
  documented as an intentional divergence (#288).

## Errors

- Plugin organize call failure → UI keeps last known state and
  surfaces the plugin error; it must not fall back to writing
  localStorage as authoritative.
- Missing/unknown `agent_status` → `unknown` shelf mapping, never a
  crash or fabricated status.

## Negative cases

- attention notification on baseline snapshot;
- organize state applied across machines with the same `pane_id`;
- localStorage overlay overriding plugin state after migration;
- row signature changes causing spurious re-notification.

## Evidence today

`src/shell/agents.test.ts` (487 lines covering shelves, organize
overlay, signatures), `attention.test.ts`, `notices.ts`, `inbox.ts`,
`agentOrganizeStore.ts`. Visual/interaction states: `verification.md`
row 7 + `docs/design/evidence/`.
