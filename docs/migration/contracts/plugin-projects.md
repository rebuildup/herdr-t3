# Contract: projects registry and project scripts (B3)

Version: 3 (additive revision: `scripts run --shell`, run-record
`shell_family`/`shell_source`, new error kinds, #69 audit semantics;
run records remain schema v2). Scope: consuming
`herdr-plugins.projects/v1` through `plugin_call` (ADR-0011 boundary,
ADR-0014 pin amended by ADR-0015/ADR-0019/ADR-0020 at
`rebuildup/hoxay-plugins@2dcb2abf`).
The plugin owns the registry and script run records; herdr-t3 renders
them and forwards explicit user operations only.

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
- `scripts run <project> <name> [--repo PATH] [--shell
  auto|sh|cmd|powershell]` → dedicated herdr workspace/pane execution;
  `--repo` required for multi-repo projects (`repo_ambiguous`
  otherwise — never auto-picked). `--shell` overrides the detected
  shell family (`auto` = detect; invalid values fail
  `invalid_shell`); the resolved family and its source are recorded
  on the run record.
- `scripts stop <run-id|project>` → ownership re-validation, then
  ctrl+c + close + bounded exit confirmation on recorded panes only;
  outcomes include `stale_pane`/`stop_unconfirmed`. `scripts results
  [project]` → run records with lazy ownership-checked reconcile;
  `scripts logs <run-id>` → bounded log tail, read only after
  ownership validation. Since @`3b28349` (upstream #68, ADR-0019) both
  lazily re-scan the OWNED pane's scrollback for the durable
  `__HERDR_DONE_<run-id>__=<code>` receipt and finalize a timed-out
  `running` record to `success`/`failed` (+ `exit_code`,
  `finished_at`, bounded log tail) — a `running` record may
  legitimately become terminal on the next refresh.
- Run records are schema v2: `host`, `session_key`, and
  `stop_requested_at` join the v1 fields (v1 records load them
  `null`). Since @`2dcb2abf` (upstream #67, ADR-0020) records also
  carry `shell_family` ∈ `sh|cmd|powershell` and `shell_source` ∈
  `flag|process_info|host_default` (both `null` on pre-#67 records);
  `command_line` is the two injected lines (command + per-family
  marker echo) and `script_path` may be a per-family
  `runs/<id>.sh|.cmd|.ps1` file. `result` gains
  `stopping`/`stop_unconfirmed`; the active
  set is `running | stopping | stop_unconfirmed`. Before any
  input/close/read the plugin re-validates the ownership tuple
  (host + session_key + pane/workspace/tab + started_at) via
  `pane.get`; foreign or mismatched panes yield `stale_pane` with zero
  pane side effects.
- Shell-family resolution (#67): flag → `pane.process_info` foreground
  → conservative host-OS default recorded as
  `shell_source:"host_default"` (never silent). A positively
  identified unsupported shell fails `shell_unknown`; a non-shell
  foreground fails `not_a_shell` — both abort BEFORE injection, close
  the just-created pane, and persist NO run record.

## Ordering and semantics

- `capability.commands` advertises top-level words only; mutations are
  gated on `mutation_commands` entries that include the subcommand
  (`"settings set"`, `"scripts run"`). The client maps
  command+subcommand pairs before enabling any control.
- Registry state is host-global; reads (`list`/`show`/`capability`)
  work without a session, `discover`/`scripts *` require one and surface
  transport failure as unavailable, not empty.
- `scripts results` may legitimately report `running`/`stopping`/
  `stop_unconfirmed` for a dead or unconfirmed pane — the plugin
  reconciles lazily after ownership re-validation, then re-scans owned
  pane scrollback for the completion receipt (ADR-0019) and may return
  the record already finalized; the client displays
  the record as returned, shows stopping states as in-flight
  confirmation (never success/failure), and never upgrades it to
  `success`. `stale_pane` outcomes/record errors are classified
  distinctly — the pane was provably not the record's.
- `runOnWorktreeCreate`/`runOnSettle`/`stopOnSettle` are listed but have
  no upstream execution mapping (hoxay-plugins#60): the UI marks them
  inert and provides no trigger affordance.
- Remote identity (#69, @`2dcb2abf`): `repos[].remote` keeps the path
  case verbatim (case-sensitive forges exist); host is lowercased and
  a non-default port is kept. Consumers compare the identity exactly —
  never re-normalize case.
- `has_submodules` in `repos list` live inspection is tri-state
  (#69): probed `true`/`false`, `null` = unknown on probe failure or
  unreachable checkout — `null` is never reported as `false` and the
  UI renders it distinctly.
- Settings (#69): a corrupt settings file reads as empty
  (overrides are non-authoritative); the next `settings set`/`unset`
  rewrites it wholesale — no `settings_corrupt` error exists.

## Errors

- Boundary codes: `plugin_not_installed`, `plugin_disabled`,
  `plugin_incompatible`, `plugin_unsupported_command`,
  `plugin_host_unreachable`.
- Plugin `error.kind` passthrough: `project_not_found`,
  `project_exists`, `repo_already_registered`, `repo_not_found`,
  `invalid_project_id`, `settings_key_not_allowed`, `t3json_invalid`,
  `invalid_script_list`, `unknown_script`, `ambiguous_script`,
  `no_repos`, `repo_ambiguous`, `ambiguous_run`, `run_not_found`,
  `no_running_runs`, `script_run_error`, `shell_unknown`, `not_a_shell`,
  `invalid_shell` (the last three are `scripts run` pre-injection
  aborts / `--shell` value errors — plugin errors, never run-record
  failures), plus git kinds
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

`docs/adr/ADR-0014.md` + `docs/adr/ADR-0015.md` + `docs/adr/ADR-0019.md`
+ `docs/adr/ADR-0020.md`
(pin + scope + schema v2 re-pin + completion receipt + shell families /
audit convergence). Implementation
evidence lands with
#252/#253 (`src/shell/projects*.ts`, dialog tests). Live plugin hosts
are RC verification.
