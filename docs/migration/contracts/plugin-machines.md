# Contract: machines surface — saved-machine inventory + probe (B3)

Version: 1. Scope: consuming `herdr-plugins.machines/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/herdr-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as the other plugin surfaces). The plugin owns
read-only saved-machine inventory: live `herdr machine list` merged
with last-known probe metadata, plus an on-demand live probe over the
saved-machine SSH bridge. This client renders the surface (issue
#454). Upstream spec: `herdr-plugins/docs/contracts/machines-v1.md`
(**draft** contract status at plugin v0.1.0 — additive changes only
once stable).

Scope is fixed upstream by ADR-0028: **read-only**. Machine
lifecycle (add/remove/rename/enable/disable/reconnect) is owned by
the herdr CLI and is never part of this contract. The plugin handles
no credentials; SSH auth is OpenSSH-owned.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document on stdout:

- `capability` → eager per-machine read: `contract_status`,
  `read_only`, `mutation_commands` (empty), `commands`,
  `probe_states` vocabulary (`ok|disabled|unreachable|
  unsupported_remote|error`), `plugin_surfaces` vocabulary
  (`supported|unsupported|unknown`), `transport`, `state_file`,
  `notes`. The store requires `capability` in `commands`.
- `list` → live enumeration merged with last-known probe metadata.
  **Never probes** — cheap enough for the eager per-machine read.
  `machines[]` entries carry the live `machine` record
  (`id`/`label`/`target`/`session`/`enabled`/`selected`) plus
  `last_probe` (`MachineProbe` or `null` when never probed).
  `machine_list_failed` (exit 1) when `herdr machine list --json`
  fails — an inventory that cannot enumerate fails honestly.
- `probe <selector|--all>` → LIVE remote probe, on-demand only.
  Selector resolution: exact `id` match, then case-insensitive
  `label` match; `machine_ambiguous`/`machine_not_found` are usage
  errors. Per machine the plugin runs `herdr --machine <id> api
  snapshot` (reachability + `server_version`/`protocol`) and
  `herdr --machine <id> plugin list --json` (remote plugin surface),
  recording last-known metadata before returning.

  **Slow by design** (SSH + two remote calls per machine): the UI
  invokes it only on explicit user action (per-row or probe-all) with
  the maximum `plugin_call` timeout (120s default). Probe outcomes are
  data, not command failure — `probe` exits 0 even when individual
  machines report `unreachable`; only usage errors and
  `machine_list_failed` exit non-zero.

## Probe semantics rendered verbatim

- `state`: `ok` (snapshot answered), `disabled` (no SSH attempt —
  enable via `herdr machine enable`), `unreachable` (SSH/bridge/
  timeout), `unsupported_remote` (remote lacks machine API
  forwarding — upgrade remote herdr), `error` (remote error envelope
  / malformed output).
- `plugin_surface`: `supported` (remote plugin inventory
  enumerated), `unsupported` (call failed — consumers MUST treat as
  "unknown remote plugin inventory", NOT "no plugins installed"),
  `unknown` (not probed).
- `reachable` is `null` when not probed (disabled); `plugins` is
  `null` when not enumerated; `error_kind`/`error` carry coarse kind +
  human detail when `state != "ok"`.
- `last_probe` keyed by stable machine id; probe metadata for machines
  absent from `machine list` is ignored upstream — never applied to a
  different machine.

## Operations NOT consumed

- Machine lifecycle — `herdr machine add/remove/enable/disable/…` is
  herdr CLI territory; this surface is inventory + probe only.
- The plugin's internal `state.json` — consumers MUST NOT depend on
  its format; `list`/`probe` documents are the only interface.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side kinds (`machine_list_failed`, `machine_not_found`,
  `machine_ambiguous`, `machine_unavailable`, `remote_*`) stay
  `error` with verbatim detail.
- `refreshMachines(machine)` mirrors the other plugin stores:
  `plugin_list` discovery → enabled check → `capability` probe →
  eager `list` (never probes live). Refreshed on snapshot pushes
  (debounced 800ms), machine-status and machine-list changes via
  `initMachines()`; capability TTL ~30s (10s on failure). A `list`
  failure keeps the machine `ready` with `listError` set — `probe`
  may still work and a transient list outage must not un-render the
  surface; last-good list is retained.
- Empty inventory (`machines: []`) and never-probed machines
  (`last_probe: null`) render as honest states — never fabricated.
- `MACHINES_MUTATION_COMMANDS` is an empty allowlist: the contract is
  read-only (`read_only: true`, `mutation_commands: []`) and
  `machinesSupportsMutation` fails closed for every command even if a
  future revision advertises writes.
