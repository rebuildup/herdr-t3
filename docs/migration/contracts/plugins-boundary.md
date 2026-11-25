# Contract: plugin boundary (B2/B3)

Version: 1. Scope: consuming published `herdr-plugins` contracts through
`plugin_list`/`plugin_call` (ADR-0011), with per-host capability gating
(ADR-0012). Plugins own feature state; herdr-t3 never opens plugin
state files and never duplicates plugin-owned capabilities via direct
CLI implementations.

## Operations

- `plugin_list` → installed plugins with contract id/version,
  `capability.commands`, `mutation_commands`, enabled state.
- `plugin_call(plugin, command, args[])` → the contract's JSON document
  on `rpc_result`; failures carry the plugin's own `error.kind` as the
  code plus optional bounded `error.fields` extras (issue #257).
- Consumers gate every operation on the host's advertised
  `capability.commands`/`mutation_commands` — an unadvertised command
  is never offered.

## Ordering and semantics

- Contract versions are pinned per integration (git-v1 @ `d057830`,
  projects/v1 @ `3b28349`, inbox v0.1.0, checkpoints/v1 @ `4aab1a7`); a
  host running an older plugin build yields capability-gated UI, not
  errors.
- git-v1 strict parsing (ADR-0018): only documented flags per command,
  `--name=value` for `-`-leading values, exit `2`/`error.code=="usage"`
  for argument errors vs exit `1`/`error.kind` for runtime failures —
  the boundary preserves `code`/`kind` distinctly.
- Additive contract fields are tolerated; consumers must not depend on
  undocumented field order or presence.
- Organize state (settle/snooze) is plugin-owned; the #173 localStorage
  overlay is a legacy migration source only, removed per ADR-0011 — it
  must not become a second source of truth.

## Errors

- Distinct failure codes: `not_installed`, `disabled`,
  `unsupported_command`, `incompatible` (missing contract), plugin
  `error.kind` passthrough (e.g. git repo-state kinds), transport
  timeout, non-JSON stdout.
- `rpc_result.error.fields` (issue #257): contract errors may flatten
  non-secret extras (`repos`, `key`, `run_id`, `project_id`, …) into the
  plugin's `error` object; the bridge forwards only an allowlisted,
  bounded subset — ≤24 keys, key ≤64 chars, strings truncated at 2048,
  values depth/size-capped — so env vars, config/state contents and
  unbounded strings can never cross. Older plugins emit kind+message
  only and simply produce no `fields`.
- Timeout and non-JSON output are contract failures, never empty
  results.

## Negative cases

- no shell interpolation of `args` on any OS;
- no reading of plugin state files;
- no `--session` for the default session;
- no offering mutations when `mutation_commands`/`capability` does not
  advertise them;
- no localStorage organize state surviving as authoritative after
  migration.

## Evidence today

`server/plugins.test.ts` (envelope parsing, error-kind preservation,
error-field passthrough/caps, capability gating),
`shared/protocol.test.ts` (rpc_result error fields schema),
`src/shell/git.test.ts`, `src/shell/projects.test.ts`,
`src/shell/projectScripts.test.ts` (classifier field passthrough),
`src/shell/agents.test.ts` (organize overlay), `src/shell/inbox.ts`.
Live plugin hosts are RC verification.
