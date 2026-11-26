# Contract: scheduled and event-triggered automations (B3)

Version: 2. Scope: consuming `herdr-plugins.automations/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/herdr-plugins@6c1cfa5` = tag `v0.7.0`). The plugin owns the
task registry, run records, missed-run derivation, and firing drivers;
herdr-t3 renders them and forwards the lifecycle mutations
`set-enabled`/`run-now`/`delete`/`reconcile` (issue #362; driver
commands stay unconsumed). Upstream spec:
`herdr-plugins/docs/contracts/automations-v1.md`
(STABLE since herdr-plugins #147).

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract, ok:true, …}` on stdout (`capability` emits
the bare discovery document without the `ok` envelope):

- `capability` → `{contract:"herdr-plugins.automations/v1", plugin,
  version, contract_status:"stable", commands:[…], schedules:[…],
  reserved_schedules:[…], hook_entrypoint, hook_events, state_file}`.
  `commands` advertises top-level words only (`schedule` covers
  `install|uninstall|status`); there is NO `mutation_commands` field —
  a contract gap candidate for herdr-plugins. Mutation gating therefore
  intersects the local `AUTOMATIONS_MUTATION_COMMANDS` allowlist
  (`set-enabled`, `run-now`, `delete`, `reconcile`) with the advertised
  flat `commands` list; `create`/`update` and driver commands are
  never treated as mutations by this client. This client requires
  `list`, `get`, `runs` for the read surface.
- `list [--enabled true|false] [--limit N]` → `{tasks:[TaskView…]}` —
  task records plus derived read-side fields `next_run_at`,
  `driver:{state,detail}`, `missed_total`, `missed_truncated`.
- `get <task_id>` → `{task:TaskView}`; unknown id → `task_not_found`.
- `runs [--task ID] [--status S] [--limit N] [--stored-only]` →
  `{runs:[RunView…]}` newest-first. Stored runs carry `run_id`;
  lazily derived missed occurrences carry `run_id:null`,
  `derived:true`, `status:"missed"` — rendered as derived, never as
  executed runs.

### Mutations (issue #362)

All go through `plugin_call` only; each is followed by a `list`
refresh so derived fields (`next_run_at`/`driver`/`missed_total`) can
never show stale state. Failures surface the classified
`error.kind`/detail verbatim — nothing is fabricated.

- `set-enabled <task_id> <true|false>` → `{task:TaskView}`. `false`
  materializes owed missed runs before closing the enabled window
  (contract §Missed-run policy); `true` opens a new owed window.
  `true` runs without confirm; `false` confirms (destructive).
- `run-now <task_id>` → `{run:RunView}`. Creates a
  `trigger:"manual"`, `scheduled_for:null` run delivered synchronously;
  a delivered-but-failed run is honest run history, not a client error.
  Confirms before executing.
- `delete <task_id>` → removes the task AND its run records;
  `task_not_found` on unknown id. Confirms (destructive).
- `reconcile [--task <task_id>]` → `{materialized:N}`. Idempotently
  materializes derived missed occurrences into real `missed` run
  records — a write, surfaced as a surface-level action with the
  plugin-reported count. A document without a numeric `materialized`
  is rejected (`plugin_bad_output`), never read as 0.

## Operations NOT consumed

- `create`, `update` — task authoring needs complex
  `--schedule`/`--destination` JSON; separate ticket.
- Drivers / firing: `fire`, `tick`, `watch`, `schedule
  install|uninstall|status` — long-running or execution commands,
  outside the `plugin_call` timeout envelope.
- `webhook` schedules: permanently unsupported in v1 (upstream gap,
  herdr-plugins ADR-0026); stored tasks render the type verbatim.

## Data shapes (defensive projections)

- `TaskView` = `TaskRecord` + derived fields. `schedule` is a
  discriminated union on `type`: `interval{every_ms}`,
  `fixed_time{time_of_day,weekdays?,time_zone?}`,
  `once{run_at}`, `event{on,filter?,debounce_ms?,cooldown_ms?,
  max_fires?}`; `webhook` and unknown types keep only `type`.
- `destination`: `{kind:"pane",pane_id}` or
  `{kind:"launch",surface,agent,launch_args?,via,handoff_record_id?}`;
  the client summarizes `surface` (`workspace <id>` | `new workspace` |
  `tab <id>`) and never fabricates a target.
- `driver.state` ∈ `os-scheduler|watch|none|install_failed|stale`
  (open string upstream); rendered verbatim with `detail`.
- `RunView` = `RunRecord` | `DerivedMissedRun`; `result`/`error`
  carry observed values only.

## Error model

Plugin errors arrive as `plugin_call` failures with the contract
`error.code` (`task_not_found`, `invalid_occurrence`,
`socket_unavailable`, `state_corrupt`, …). Boundary failures map to
the shared taxonomy: `plugin_not_installed` → `not_installed`,
`plugin_disabled` → `disabled`, `plugin_incompatible` /
`plugin_unsupported_command` / `plugin_bad_output` → `incompatible`,
transport failures → `unreachable`, everything else → `error`.
Foreign contracts and malformed documents are rejected by the parsers
(`plugin_bad_output`), never rendered as data.

## Freshness

`list` refetches on session-snapshot pushes (800 ms debounce), on
machine `online`, and on machine-set changes — the same triggers as
`rebuildup.inbox`. The plugin resolves `next_run_at`/`driver`/
`missed_total` lazily at read time, so refreshes cannot show stale
derived state; every mutation additionally triggers a `list` refresh.
Run history is fetched per expanded task.
