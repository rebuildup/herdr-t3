# Contract: plugin boundary (B2/B3)

Version: 1. Scope: consuming published `hoxay-plugins` contracts through
`plugin_list`/`plugin_call` (ADR-0011), with per-host capability gating
(ADR-0012). Plugins own feature state; herdr-t3 never opens plugin
state files and never duplicates plugin-owned capabilities via direct
CLI implementations.

## Operations

- `plugin_list` → installed plugins with contract id/version,
  `capability.commands`, `mutation_commands`, enabled state.
- `plugin_call(plugin, command, args[], stdin?, timeout_ms?)` → the
  contract's JSON document on `rpc_result`; failures carry the
  plugin's own `error.kind` as the code plus optional bounded
  `error.fields` extras (issue #257). `stdin` (issue #458) is a
  bounded string (≤256 KiB, protocol- and codec-validated) written
  to the plugin CLI's stdin and closed immediately — the only
  portable payload channel for contracts that read input from
  stdin/`--input FILE` (textgen-v1 `generate`). `timeout_ms` ceiling
  is 600 s to cover agent-path generation; stdin is never logged.
- Consumers gate every operation on the host's advertised
  `capability.commands`/`mutation_commands` — an unadvertised command
  is never offered.

## Ordering and semantics

- Contract versions are pinned per integration (git-v1 @ `d057830`,
  projects/v1 @ `2dcb2abf`, inbox v0.1.0, checkpoints/v1 @ `ae4f214`,
  automations/v1 @ `6c1cfa5`, conversations/v1 @ `d23205af`,
  usage/v1 @ `d23205af`, artifacts/v1 @ `d23205af`,
  handoff/v1 @ `d23205af`, textgen/v1 @ `d23205af`,
  controls/v1 @ `d23205af`,
  secrets/v1 @ `d23205af`, machines/v1 @ `08f96a4`,
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

## Pinned upstream contract + drift procedure (issue #555)

Audited 2026-11-27 against live upstream sources:

- **herdr side** — latest tag `v0.9.5` (the RC pin). `master` was
  diffed file-by-file: `src/api/schema/plugins.rs`
  (`InstalledPluginInfo`), `src/api/schema/response.rs`
  (`ResponseResult::PluginList` → `result.type:"plugin_list"` +
  `result.plugins[]`), `src/cli.rs` `print_response`, and the
  `herdr plugin list --json` flag (reworked by herdrdev/herdr#5212's
  CLI-projection refactor) are **unchanged** in every field this
  boundary consumes. No drift.
- **Plugin side** (`rebuildup/herdr-plugins`, rebranded
  `hoxay-plugins`; contract ids unchanged) — `main` @ `359593d8`.
  Every `herdr-plugins.<name>/v1` contract id is still v1; the
  capability document still carries `contract`/`commands`/
  `mutation_commands` (new fields like `tui`, `actions`, `events`,
  `startup`, `state_file`, `socket` are additive and ignored or
  tolerated); the error envelope is still
  `{contract, ok:false, error:{code,message,kind?,…extras}}` on
  stderr with exit 1/2. All 14 plugin CLIs accept `--socket`/
  `--session` as global pre-dispatch flags — the machines plugin's
  rejection of them was fixed upstream (herdr-plugins#264). No
  drift requiring a herdr-t3 change.
- **Conformance fixture** — `server/plugins.test.ts` feeds the real
  captured `plugin_list` envelopes
  (`docs/design/evidence/rc-v060/section-z*-plugin-list-*.json|txt`,
  herdr v0.9.5, 5/6/14-plugin installs) through the discovery parser
  and asserts every forwarded field including `min_herdr_version`/
  `platforms`, plus the `pluginHerdrSkew` classification. This is the
  regression tripwire for silent upstream drift.

**Upgrade procedure.** When a new herdr release or plugin contract
revision ships:

1. Diff `src/api/schema/plugins.rs`, `src/api/schema/response.rs`
   (`PluginList`), `src/cli.rs` (`print_response`, `--json` handling)
   and `src/cli/plugin.rs` between the old and new tag in
   `herdrdev/herdr`; diff `docs/contracts/*.md` and each plugin's
   `src/cli.ts` capability/error emitters in `rebuildup/herdr-plugins`.
2. Re-run the conformance fixture; extend the capture set with a fresh
   `herdr plugin list --json` envelope from the new version if the
   schema legitimately changed.
3. A herdr-t3 change is required only for **breaking** drift:
   renamed/removed `result.plugins[]` fields the bridge forwards
   (`plugin_id`, `name`, `version`, `enabled`, `plugin_root`,
   `description`, `min_herdr_version`, `platforms`), a changed
   envelope (`result.type`, top-level `id`/`result`), a changed
   capability contract (`contract` id prefix `herdr-plugins.<name>/vN`,
   `commands`, `mutation_commands` semantics), a changed error envelope
   (`ok:false` + `error.{code,message,kind}` on stderr, exit 1/2), or
   plugin CLIs dropping the global `--socket`/`--session` flags.
   Additive fields/commands (e.g. the `tui/v1` surface, new inbox
   commands) need no bridge change — capability gating already hides
   unadvertised surfaces.
4. Pending upstream work that *will* require a herdr-t3 change when it
   lands: rebuildup/herdr-plugins#263 (per-command side-effect /
   idempotency / coalescibility / freshness / invalidation
   declarations) replaces the coarse `mutation_commands` read bit used
   for exec coalescing (see "Data-plane coalescing" above).

## Data-plane coalescing (issue #424, program #416)

Concurrent identical `plugin_call`s may share one in-flight plugin CLI
execution — single-flight at the `host.exec` boundary, keyed by
machine + plugin root + command + args + stdin + effective timeout.
Nothing is cached: entries are removed on settle, so only *simultaneous*
callers merge and every caller still receives the plugin's own document.

Classification is contract-driven, never name- or flag-guessed:

- a command **absent** from the plugin's advertised
  `capability.mutation_commands` is a contract read and may coalesce;
- a command **declared** in `mutation_commands` never coalesces — each
  caller runs its own exec, even when calls are identical and concurrent;
- a plugin that omits `mutation_commands` fails closed: nothing
  coalesces for it;
- a call carrying `stdin` never joins a shared execution — the payload
  is per-call input.

`plugin_list` discovery coalesces unconditionally (it is read-only by
contract) at both the client (`api.ts`) and service layers.

Upstream dependency: `mutation_commands` is a coarse read/write bit.
Per-command side-effects, idempotency, coalescibility, freshness and
invalidation declarations are tracked as the source of truth in
rebuildup/hoxay-plugins#263; once that contract extension lands, this
classification is replaced by the declared per-command semantics rather
than extended heuristically. Until then, TTL caching of `plugin_call`
results is deliberately NOT performed — staleness cannot be bounded
without freshness declarations.

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
- no coalescing of `mutation_commands`-declared mutations, of plugins
  omitting the field, or of calls carrying `stdin`;
- no localStorage organize state surviving as authoritative after
  migration.

## Evidence today

`server/plugins.test.ts` (envelope parsing, error-kind preservation,
error-field passthrough/caps, capability gating, env scrub on every
exec kind + real local spawn, `--socket`/`HERDR_SOCKET_PATH` targeting
on every exec kind, issue #289, real-capture `plugin_list`
conformance, issue #555),
`server/machines.test.ts` (`remoteArgvCommand` scrub/envSet tokens for
POSIX `unset`/`export` and PowerShell `$env:X=$null`/assignment,
`sshPluginHost` session targeting),
`shared/protocol.test.ts` (rpc_result error fields schema),
`src/shell/git.test.ts`, `src/shell/projects.test.ts`,
`src/shell/projectScripts.test.ts` (classifier field passthrough),
`src/shell/agents.test.ts` (organize overlay), `src/shell/inbox.ts`.
Live plugin hosts are RC verification.
