# Contract: secrets surface — bindings + env injection (B3)

Version: 1. Scope: consuming `herdr-plugins.secrets/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/herdr-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as artifacts-v1/usage-v1/conversations-v1/
handoff-v1/textgen-v1). The plugin owns secret-reference resolution
and env injection — binding declarations, per-binding resolve status,
`run` (child env) and `inject` (surface-create env params) — and this
client renders its surfaces (issue #454). Upstream spec:
`herdr-plugins/docs/contracts/secrets-v1.md`.

The contract advertises mutations (`commands` includes `run` and
`inject`; plugin v0.9.0 does not emit `mutation_commands` — gating
falls back to `commands` ∩ local allowlist). This client offers only
the local allowlist `SECRETS_MUTATION_COMMANDS = ["run", "inject"]`;
`config` (including `--init`) is NEVER offered and `eval`-style
emission does not exist in v1 by contract.

## THE VALUE GUARANTEE (non-negotiable)

No command in this contract ever returns, logs, persists, or places
in argv a resolved secret value. `resolve` is metadata-only; `run`
routes values to the child environment; `inject` routes values to
herdr surface-create `env` params; both report `env_names` — names
only. Provider stderr/stdout are never echoed verbatim into any
emitted envelope (sanitized `detail` carries only classified,
exit-code-level diagnostics).

herdr-t3 enforces the guarantee twice:

1. **Parser level** — `secretsCapabilityFromDoc` /
   `secretsResolveFromDoc` / `secretsInjectFromDoc` build models
   field-by-field; any `value`/`env`/`values`-shaped extra a buggy
   or future plugin emits is dropped. Unit tests assert a planted
   `sk-live-…` sentinel never survives `JSON.stringify(model)`.
2. **Argv level** — `secretsResolveArgs`/`secretsRunArgs`/
   `secretsInjectArgs` have no value input at all; only binding
   names, flags and surface options can reach argv.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document on stdout (errors on stderr with
`{contract, ok:false, error:{code, kind?, message, …}}`):

- `capability` → eager per-machine read: `provider` (`name`,
  `domain`, `cli{bin,available,version,detail?}` — `detail` is only
  the `--version` exit code, never provider output),
  `project_id_configured`, `reachability.status`, `bindings[]`
  (`name`/`env`/`ref`/`projectId`), `invalid_bindings[]`,
  `config_warnings[]`, `credential_boundary`, `commands`,
  `generated_at`. The store requires the full command set
  (`capability`, `resolve`, `run`, `inject`, `config`) in `commands`
  before treating the plugin as compatible.
- `capability --probe` → on-demand reachability probe: resolves a
  guaranteed-absent sentinel secret to classify `reachability.status`
  as `ok|unresolved|provider_unreachable|auth_missing|provider_error`
  without touching a real value. Spawns the provider CLI — explicit
  user action only, never eager.
- `resolve --binding <name>...` → metadata-only per-binding status:
  `resolved|unresolved|provider_unreachable|auth_missing|
  provider_error`, plus sanitized `detail`. Exits 1 when any binding
  fails; the bridge surfaces that `ok:false` document as the result,
  so the store returns the report rather than throwing — per-binding
  statuses ARE the answer.
- `run --binding <name>... -- <cmd> [args...]` → MUTATION (gated):
  resolves bindings, spawns `<cmd>` with `env = process.env +
  resolved` and inherited stdio (sink 1). Any binding failure →
  `resolution_failed` before the child starts.
  **Bridge caveat:** the child's stdio is inherited by the plugin
  process, which the plugin_call bridge pipes and JSON-parses — a
  successful run can only surface as a bridge-level
  `plugin_bad_output`/`plugin_error`, never a success document.
  The env injection still happens plugin-side; the UI must treat ANY
  non-`resolution_failed` result as "ran, output not streamed" and
  never fabricate success.
- `inject --binding <name>... --surface workspace|tab|pane [opts]`
  → MUTATION (gated): resolves bindings, then creates a herdr
  surface with resolved env in the creation `env` params (sink 2).
  Options: `--workspace <id>` (tab/pane target), `--target-pane <id>`
  + `--direction right|down` + `--ratio <n>` (pane split), `--cwd`,
  `--label`, `--focus`. Success returns surface ids + `env_names`
  (names only); any binding failure → `resolution_failed`, exit 1,
  **no surface is created**.

## Operations NOT consumed

- `config [--init]` — `config show` output is redundant (capability
  already carries domain/projectId/tokenEnv *name*/binding
  declarations + warnings); `--init` writes plugin config — out of
  scope for this client. Not in the local allowlist.
- No `eval`/`--emit-env` exists in v1 by contract (requires a
  successor ADR upstream).
- Binding creation/editing is config-file territory owned by the
  plugin's `config` command and the user's editor — the surface is
  read + resolve/run/inject only.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side `kind` values (`config_error`, `resolution_failed`,
  `spawn_failed`, provider statuses) stay `error` with verbatim
  detail via `secretsErrorKind`/`secretsErrorHint`. Sanitized
  provider diagnostics never contain values — the contract forbids
  it and the UI additionally never renders provider output.
- `refreshSecrets(machine)` mirrors the other plugin stores:
  `plugin_list` discovery → enabled check → `capability` probe;
  refreshed on snapshot pushes (debounced 800ms), machine-status and
  machine-list changes via `initSecrets()`. Capability TTL ~30s
  (10s on failure). A capability failure retains the last-good
  document.
- Empty/absent data is honest: no bindings, no valid bindings, a
  missing provider CLI, or `reachability.status != ok` render as
  explicit states — never fabricated. `invalid_bindings` entries
  render verbatim (name + sanitized error).
- Mutations are gated on `secretsSupportsMutation` = local allowlist
  ∩ advertised commands (with `mutation_commands` honored when a
  future plugin version emits it — an explicit deny wins over
  `commands`). `run`/`inject` additionally require explicit
  confirmation in the UI before invocation.
