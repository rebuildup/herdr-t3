# Contract: projects registry and project scripts (B3)

Version: 1. Scope: consuming `herdr-plugins.projects/v1` through
`plugin_call` (ADR-0011 boundary, ADR-0014 pin at
`rebuildup/herdr-plugins@c8460283`). The plugin owns the registry and
script run records; herdr-t3 renders them and forwards explicit user
operations only.

## Operations

Registry (`rebuildup.projects`, top-level command word):

- `list [--all]` → projects sorted pinned-first; `show <id>` → one
  project with repos/settings.
- `discover` → git repos reachable from session pane cwds, with
  `registered_project_id` links and honest `skipped` reasons.
- `register <repo-path> [--title] [--id]` → create; `update <id>` →
  title/pin/archive/repo membership; `archive|unarchive|pin|unpin <id>`
  → flag setters; `settings get|set|unset`; `repos list|add|remove`.

Scripts:

- `scripts list <project|repo> [--repo PATH]` → resolved definitions
  with `source` layer and `runOn*` flags.
- `scripts run <project> <name> [--repo PATH]` → dedicated herdr
  workspace/pane execution; `--repo` required for multi-repo projects
  (`repo_ambiguous` otherwise — never auto-picked).
- `scripts stop <run-id|project>` → ctrl+c + close on recorded panes
  only; `scripts results [project]` → run records with lazy liveness
  reconcile; `scripts logs <run-id>` → bounded log tail.

## Ordering and semantics

- `capability.commands` advertises top-level words only; mutations are
  gated on `mutation_commands` entries that include the subcommand
  (`"settings set"`, `"scripts run"`). The client maps
  command+subcommand pairs before enabling any control.
- Registry state is host-global; reads (`list`/`show`/`capability`)
  work without a session, `discover`/`scripts *` require one and surface
  transport failure as unavailable, not empty.
- `scripts results` may legitimately report `running` for a dead pane —
  the plugin reconciles lazily; the client displays the record as
  returned and never upgrades it to `success`.
- `runOnWorktreeCreate`/`runOnSettle`/`stopOnSettle` are listed but have
  no upstream execution mapping (herdr-plugins#60): the UI marks them
  inert and provides no trigger affordance.

## Errors

- Boundary codes: `plugin_not_installed`, `plugin_disabled`,
  `plugin_incompatible`, `plugin_unsupported_command`,
  `plugin_host_unreachable`.
- Plugin `error.kind` passthrough: `project_not_found`,
  `project_exists`, `repo_already_registered`, `repo_not_found`,
  `invalid_project_id`, `settings_key_not_allowed`, `t3json_invalid`,
  `invalid_script_list`, `unknown_script`, `ambiguous_script`,
  `no_repos`, `repo_ambiguous`, `ambiguous_run`, `run_not_found`,
  `no_running_runs`, `script_run_error`, plus git kinds
  (`not_a_repo`, `bare_repo`, `git_missing`, `timeout`). Contract
  extras (`repos`, `key`, `run_id`, `project_id`, …) reach the client
  as bounded `rpc_result.error.fields` (issue #257).

## Negative cases

- No direct reads of plugin state files or `t3.json` — resolution is
  the plugin's job.
- No auto-pick of a repo for multi-repo script runs.
- No fabricated run success; `unknown`/`running` are displayed as-is.
- No Electron/Node-only APIs in the consuming code — everything flows
  through `plugin_call` frames so the GPUI port keeps the same surface.
- No offering of mutations the host's `mutation_commands` does not
  advertise.

## Evidence today

`docs/adr/ADR-0014.md` (pin + scope). Implementation evidence lands with
#252/#253 (`src/shell/projects*.ts`, dialog tests). Live plugin hosts
are RC verification.
