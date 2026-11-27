# Contract: textgen surface — capability/git-context/generate (B3)

Version: 2. Scope: consuming `herdr-plugins.textgen/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/hoxay-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as artifacts-v1/usage-v1/conversations-v1).
The plugin owns structured text generation — thread titles, branch
names, commit-message candidates, PR content, review guides and
next-prompt predictions — and this client renders its surfaces
(issues #442 read surface, #458 generation). Upstream spec:
`hoxay-plugins/docs/contracts/textgen-v1.md` (STABLE since
hoxay-plugins v0.6.0; plugin `rebuildup.textgen` v0.7.0+).

The contract advertises mutations (`mutation_commands`: `generate`,
`watch-next-prompt`, `config set-default-provider`,
`config set-default-model`, `config add-api-generator`,
`config remove-api-generator`). This client consumes `generate` —
the one allowlisted mutation — behind a confirm dialog; every other
mutation stays gated off by the local `TEXTGEN_MUTATION_COMMANDS`
allowlist. There are still NO list/history/result commands:
generation results are returned to the caller and never persisted
plugin-side, so the surface renders the latest result transiently
with an explicit "not retained" label (retention gap recorded
upstream as rebuildup/hoxay-plugins#249).

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract, ok:true, …}` on stdout (`capability` emits
the bare discovery document without the `ok` envelope):

- `capability` → `{contract:"herdr-plugins.textgen/v1", plugin,
  version, integrations:{git:{status:resolved|unavailable, …}},
  tasks:[{kind, description, paths, input_fields, required_input,
  output, max_output_chars, requires_opt_in, opt_in?}],
  guards:{expensive_task_opt_in, quota_check:{enabled,
  max_used_percent, provider}}, providers:{agent:[{id, kind, enabled,
  availability, warning?, model?, cost_note}], api:[{id, generator,
  kind, endpoint, model, enabled, credential_configured, cost_note}],
  cli:{status, reason}}, agent_manifests, config (redacted),
  config_warnings, commands, mutation_commands, generated_at}`.
  This is the eager per-machine read — the store requires `capability`
  in `commands`; `git-context`/`generate` support is probed separately
  via `textgenSupports`/`textgenSupportsMutation`. API provider rows
  carry `credential_configured` booleans only — key material never
  crosses the bridge.
- `git-context --task <kind> --git-pane <pane> [--git-root <dir>]` →
  `{task, pane_id, git_plugin:{plugin_root, resolved_via}, repo_root,
  branch, input, sources, warnings, generated_at}`. Read-only: runs
  the same collection `generate --git-pane` performs (status/diff/
  log/compare/pr-status through the rebuildup.git plugin's read-only
  git-v1 CLI plus convention-file probes) WITHOUT invoking any
  provider. Lazy surface fetch, submit-triggered only. The herdr
  session/socket/timeout flags are CallOptions-level and never argv.
- `generate --task <kind> [--provider <id>] [--model <m>]
  [--timeout MS] [--cwd DIR] [--git-pane <pane>] [--git-root <dir>]
  [--allow-expensive]` → `{task, provider, path, model, result,
  elapsed_ms, warnings, git_context?}`. Mutation — confirm-gated.
  The task input JSON is NOT argv: it is serialized to the plugin
  CLI's **stdin** via the `plugin_call.stdin` field added for this
  ticket (bounded 256 KiB, protocol-validated, written then closed
  on both the local spawn and the ssh host). Rationale: the contract
  reads input from stdin/`--input FILE`, and `plugin_call` is
  argv-only — stdin is the only portable payload channel. `--raw`
  is never passed so warnings/`git_context` stay visible.
  `plugin_call.timeout_ms` ceiling was raised to 600 s to cover the
  agent path's per-task defaults (`review_guide` 600 s); an explicit
  `--timeout` gets a 90 s overhead buffer for pane setup/teardown.

## Operations NOT consumed

- `watch-next-prompt` — a mutation (long-running JSONL watcher that
  spawns agent panes and records `textgen_next_prompt` pane
  metadata). Out of scope; composer presentation is a separate
  concern.
- `config show|set-default-provider|set-default-model|
  add-api-generator|remove-api-generator` — `config show` is
  read-only but redundant (`capability` already carries the redacted
  config); the write subcommands are mutations and stay gated off.
- Auto-apply — adopting a generated result into git/forge/composer
  is always the caller's explicit action. This surface never applies
  anything; the separation is contractual (ADR-0017 upstream).
- Result retention/history — the contract persists nothing; if
  upstream adds retention (rebuildup/hoxay-plugins#249), a follow-up
  ticket adds history/review on top of this generate path.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side `kind` values (`git_unavailable`, `git_cli_failed`,
  `git_contract_mismatch`, `git_bare_repo`, `git_task_unsupported`,
  `task_not_opted_in`, `quota_exceeded`, `provider_*`,
  `output_invalid_json`, `input_*`, `usage`, …) stay `error` with
  verbatim detail — guard refusals and provider failures render the
  plugin's own wording. Structured `error.hint` fields surface
  verbatim via `textgenErrorHint`.
- `refreshTextgen(machine)` mirrors the artifacts store: plugin
  discovery → enabled check → `capability` probe, refreshed on
  snapshot pushes (debounced 800ms), machine online transitions, and
  machine-list changes via `initTextgen()`. A capability failure
  keeps the machine `unavailable` while retaining the last-good
  document for display.
- Empty/absent data is honest: no tasks advertised, no providers, or
  an unavailable git integration render as explicit states — never
  fabricated. `requires_opt_in` tasks (`review_guide`) render their
  opt-in badge and plugin explanation verbatim, and the generate
  form only offers `--allow-expensive` for them.
