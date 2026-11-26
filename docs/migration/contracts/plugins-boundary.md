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
  projects/v1 @ `2dcb2abf`, inbox v0.1.0, checkpoints/v1 @ `ae4f214`,
  automations/v1 @ `6c1cfa5`, conversations/v1 @ `d23205af`,
  usage/v1 @ `d23205af`, artifacts/v1 @ `d23205af`,
  handoff/v1 @ `d23205af`, textgen/v1 @ `d23205af`,
  secrets/v1 @ `d23205af`, machines/v1 @ `d23205af`,
  mcp/v1 @ `d23205af`); a
  host running an older plugin build yields capability-gated UI, not
  errors.
- git-v1 strict parsing (ADR-0018): only documented flags per command,
  `--name=value` for `-`-leading values, exit `2`/`error.code=="usage"`
  for argument errors vs exit `1`/`error.kind` for runtime failures —
  the boundary preserves `code`/`kind` distinctly.
- Additive contract fields are tolerated; consumers must not depend on
  undocumented field order or presence.
- Ambient env scrub (ADR-0022, issue #270): every plugin-boundary exec —
  `plugin_list` discovery, `capability` probes and `plugin_call` — runs
  with `PLUGIN_ENV_SCRUB` removed from the child environment
  (`HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, `HERDR_SESSION`,
  `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`,
  `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_BIN_PATH`, `HERDR_ENV`, and all
  `HERDR_PLUGIN_*` runtime vars). Scrub is removal, not blanking:
  upstream socket resolution gives `HERDR_SOCKET_PATH` precedence over
  `--session`, and the `herdr` binary treats a present-but-empty var as
  set. Local spawn deletes the keys; the SSH path emits `unset` (POSIX)
  / `$env:X=$null` (PowerShell, which deletes) inside the remote
  command.
- Explicit session/socket targeting (issue #289): no plugin exec may
  resolve a different Host/Session than the bridge. The local host
  forwards the bridge's resolved socket (`herdrSocketPath()` —
  `HERDR_SOCKET` env or the default) to plugin CLIs as `--socket PATH`
  and to `herdr plugin list` as `HERDR_SOCKET_PATH` re-pinned after the
  scrub (the herdr CLI has no `--socket` flag); SSH hosts pass
  `--session <name>` to plugin CLIs and to the discovery `herdr` argv
  for non-`default` sessions.
- Ambient git env scrub (ADR-0023, issue #280): the same
  `PLUGIN_ENV_SCRUB` also removes `GIT_*` repo/config/transport
  targeting vars (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_PREFIX`,
  `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`,
  `GIT_CONFIG`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
  `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
  `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_PROXY_COMMAND`,
  `GIT_EXEC_PATH`) because upstream git invocations inherit the plugin
  CLI environment verbatim. `GIT_CONFIG_COUNT` is scrubbed so the
  indexed `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` family stays
  inert; editor/pager and identity vars are intentionally kept.
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
- no plugin exec resolving a different Host/Session than the bridge
  (local `HERDR_SOCKET` must reach every exec kind; SSH named sessions
  must reach discovery as well as contract calls);
- no ambient `HERDR_*` targeting env reaching any exec (discovery,
  capability, contract call) on local or SSH hosts;
- no ambient `GIT_*` repo/config/transport targeting env reaching any
  exec on local or SSH hosts;
- no offering mutations when `mutation_commands`/`capability` does not
  advertise them;
- no localStorage organize state surviving as authoritative after
  migration.

## Evidence today

`server/plugins.test.ts` (envelope parsing, error-kind preservation,
error-field passthrough/caps, capability gating, env scrub on every
exec kind + real local spawn, `--socket`/`HERDR_SOCKET_PATH` targeting
on every exec kind, issue #289),
`server/machines.test.ts` (`remoteArgvCommand` scrub/envSet tokens for
POSIX `unset`/`export` and PowerShell `$env:X=$null`/assignment,
`sshPluginHost` session targeting),
`shared/protocol.test.ts` (rpc_result error fields schema),
`src/shell/git.test.ts`, `src/shell/projects.test.ts`,
`src/shell/projectScripts.test.ts` (classifier field passthrough),
`src/shell/agents.test.ts` (organize overlay), `src/shell/inbox.ts`.
Live plugin hosts are RC verification.
