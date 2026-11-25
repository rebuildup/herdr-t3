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
  code.
- Consumers gate every operation on the host's advertised
  `capability.commands`/`mutation_commands` — an unadvertised command
  is never offered.

## Ordering and semantics

- Contract versions are pinned per integration (git-v1 @ `62309b9c`,
  inbox v0.1.0); a host running an older plugin build yields
  capability-gated UI, not errors.
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
capability gating), `src/shell/git.test.ts`, `src/shell/agents.test.ts`
(organize overlay), `src/shell/inbox.ts`. Live plugin hosts are RC
verification.
