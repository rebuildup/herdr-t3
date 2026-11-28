# Contract: mcp surface — server diagnostics (B3)

Version: 1. Scope: consuming `herdr-plugins.mcp/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/hoxay-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as the other plugin surfaces). The plugin is a
**local stdio MCP server** exposing herdr sessions and sibling plugin
contracts to outside MCP clients; contract status is **stable**
(read/mutation/events surfaces all implemented upstream, T2–T4).
This client renders DIAGNOSTICS ONLY (issue #454): it never spawns
`serve`, never speaks MCP protocol, and never invokes a tool.
Upstream spec: `hoxay-plugins/docs/contracts/mcp-v1.md`.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document on stdout:

- `capability` → the ONLY command consumed and the eager per-machine
  read. Reports `contract`, `contract_status` (`stable`), per-surface
  `surfaces` map (`read`/`mutation`/`events` → stability), `version`,
  `commands` (`capability`, `serve`, `help`), `socket`,
  `session_resolution` (the contract-order targeting rule echo:
  `--socket` > `--session`/`HERDR_SESSION` > `HERDR_SOCKET_PATH` >
  default; pane env ignored), live `session` probe
  (`reachable`/`session_name`/`error`), `access_levels`
  (`levels`/`default`/`semantics`/`t3_mapping`),
  `negotiated_access_level`, `tools[]` (`name`/`access`/
  `read_only`/`status`/`backs_onto`), `plugins[]` sibling-plugin
  availability (`plugin`/`contract`/`available`/`resolved_via`/
  `error`), `error_codes`, `upstream_gaps`, `remote`
  (`status: excluded_v1` + tracking ref), `state` note.

The store requires `capability` in `commands`.

## Operations NOT consumed

- `serve` — spawns the long-running stdio MCP server. This client is
  not an MCP client; spawning it would leak a process the bridge
  cannot supervise. Diagnostics surface the tool table instead.
- `help` — human text, redundant with `capability`.
- All MCP tools (`herdr_capability`, `session_snapshot`,
  `agent_*`, `workspace_*`, `pane_*`, `conversations_*`, `git_*`,
  `projects_list`, `usage_report`, `events_*`, mutation tools) —
  they exist only inside `serve`. Access levels (`read-only` /
  `supervised` / `full`) and the `t3_mapping` are rendered as
  diagnostics so the user can see what a future MCP client would
  negotiate; this surface never negotiates anything.
- Mutations: there are no mutation *commands* — mutations are MCP
  tools gated server-side inside `serve`. `MCP_MUTATION_COMMANDS` is
  an empty allowlist and `mcpSupportsMutation` fails closed for every
  command by design.

## Diagnostics rendered verbatim

- Session resolution: `resolved_via`, the targeting `rule`, and the
  live `session` verdict (`reachable`, `session_name`, or `error`) —
  an unreachable session is honest data, not a surface failure.
- Access levels: the level list, default, the plugin's semantics
  paragraph, the `t3_mapping` to this client's access bands, and the
  negotiated level.
- Tools: name, required access level, `read_only` annotation, status,
  and `backs_onto` (the herdr API / sibling CLI each tool maps to).
- Sibling plugins: availability verdicts — `plugin_unavailable` is
  honest data (`available: false` + `error`), never an error state.
- Remote status: `excluded_v1` with the upstream tracking ref
  (herdrdev/herdr#6199) and `upstream_gaps` rendered verbatim.
- `error_codes` vocabulary and the no-durable-state note.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side kinds stay `error` with verbatim detail.
- `refreshMcp(machine)` / the store refresh mirrors the other plugin
  stores: `plugin_list` discovery → enabled check → `capability`
  probe; refreshed on snapshot pushes (debounced 800ms), machine-
  status and machine-list changes via `initMcp()`. Capability TTL
  ~30s (10s on failure); a capability failure retains the last-good
  document and surfaces `capabilityError`.
- v1 writes no durable plugin state (per-client stdio process,
  in-memory only) — the surface copy says so.
