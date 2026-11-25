# Contract: worktree checkpoints (B3)

Version: 2. Scope: consuming `herdr-plugins.checkpoints/v1` through
`plugin_call` (ADR-0011 boundary, ADR-0016 pin re-pinned by ADR-0017 at
`rebuildup/herdr-plugins@c8dc3b3`). The plugin owns capture, hidden git
refs (`refs/herdr-plugins/checkpoints/<repo-key>/<id>`), the state
index, and restore execution; herdr-t3 renders them and forwards
explicit user operations only. Upstream spec:
`herdr-plugins/docs/contracts/checkpoints-v1.md`.

## Operations

Commands are flat `plugin_call` command words (no subcommand argv):

- `capability` → `{contract, commands, mutation_commands:["create","delete",
  "restore"], read_only:false, requires:{git,bun}}`.
- `create [--repo PATH | <pane_id>] [--label TEXT]` → synthetic commit
  parented to HEAD, stored under the hidden ref; `--repo` and a pane id
  are mutually exclusive. Pane ids resolve through the herdr session
  snapshot plugin-side (same path as `rebuildup.git`).
- `list [--repo PATH] [--limit N]` → entries newest-first
  (`created_at` desc), default limit 100, max 1000; `truncated`/`total`
  report plugin-side pagination.
- `show <id> [--max-bytes N]` → entry + `ref:{name,exists,oid}` probe +
  bounded `git show --stat` (`summary`, `summary_error`).
- `diff <id|HEAD> <id|HEAD> [--max-bytes N]` → bounded
  `git diff --no-color`; at least one side must be a checkpoint id and
  both checkpoint sides must share `repo_root`.
- `plan <id> [--repo PATH]` → read-only restore preview:
  `{plan:{files_to_change, untracked_to_delete, already_matches},
  warnings}` + `ref` probe + `commit` (live ref target, else recorded
  commit with a warning). `untracked_to_delete` counts files the
  post-restore `git clean -fd` passes would permanently delete — the
  UI labels that explicitly. Never mutates, never touches the session.
- `restore <id> [--repo PATH] [--force]` → safe restore into the target
  worktree (default the checkpoint's `repo_root`; `--repo` may select
  another worktree of the SAME repository only — shared git common dir,
  else `repo_mismatch`). Sequence: ref existence check
  (`checkpoint_ref_missing`) → shared-worktree isolation via herdr
  `session.snapshot` (≥2 panes under the repo root → `shared_worktree`
  with `error.panes`; unreachable session → `session_unreachable`;
  `--force` bypasses, reports `isolation:"forced"` + warning) →
  mandatory `pre-restore:<id>` checkpoint persisted before any mutation
  (capture failure refuses the restore) → `git restore --source
  --worktree --staged` + up to 4 `git clean -fd` passes → post-verify.
  Success: `{restored_commit, pre_restore:{id,ref,commit,label},
  isolation, sharing_panes, clean_passes, warnings}`; submodule
  gitlinks are NOT restored (root repo only — warning surfaced).
- `delete <id>` → removes the state entry always; deletes the hidden
  ref when it still exists.

## Ordering and semantics

- Checkpoint identity: `id` = `<base36-ms>-<8hex>`; `repo_key` =
  sha256(canonical repo root)[:16]; `ref` =
  `refs/herdr-plugins/checkpoints/<repo_key>/<id>`; `commit` is a
  synthetic commit whose first parent is the captured HEAD.
- `show`/`plan` report `ref.exists:false` while still returning the
  entry — the ref may have been deleted out-of-band; the client renders
  that state, never drops the row.
- `delete` is idempotent: `ref_existed:false` + `warnings` when the ref
  was already gone or the repo is unreachable.
- `restore` never runs implicitly: the UI requires the `plan` preview
  and an explicit confirm; `--force` is appended only from a separate
  labelled user action after `shared_worktree`/`session_unreachable`.
- Mutation-phase restore failures carry `pre_restore_checkpoint_id` /
  `pre_restore_ref` / `pre_restore_commit` (bridge error `fields`) —
  surfaced with a recovery affordance (`restore <pre-restore-id>`).
- Capture never touches the user's index/worktree (temporary
  `GIT_INDEX_FILE`); submodule gitlinks are recorded but submodule
  worktree contents are not captured or restored (record-and-warn).
- v1 non-goals (herdr-plugins#74–#75): no turn-boundary auto-capture,
  no multi-repo orchestration, no checkpoint GC, no private object
  store/quarantine, no submodule worktree capture/restore.

## Errors

- Boundary codes: `plugin_not_installed`, `plugin_disabled`,
  `plugin_incompatible`, `plugin_unsupported_command`,
  `plugin_host_unreachable`, `plugin_bad_output`.
- Plugin `error.kind` passthrough: `not_a_repo`, `bare_repo`,
  `empty_repo`, `sparse_checkout`, `unknown_checkpoint`, `cross_repo`,
  `pane_not_found`, `no_pane_cwd`, `repo_mismatch`,
  `checkpoint_ref_missing`, `shared_worktree` (with `error.panes`),
  `session_unreachable`, `restore_failed`, `clean_failed`,
  `clean_incomplete`, `restore_verify_failed` (mutation failures carry
  `pre_restore_*` fields), `git_missing`, `timeout`, `git_error`,
  `usage`.
- Bridge forwards allowlisted error extras only (`panes`,
  `pre_restore_checkpoint_id`, `pre_restore_ref`,
  `pre_restore_commit` added for this contract); everything else is
  dropped server-side.

## Negative cases

- No direct reads of plugin state files or hidden refs — resolution is
  the plugin's job.
- No auto-capture/GC affordances — not in the v1 contract.
- No implicit or automatic `--force` restore; forcing is always an
  explicit secondary user action.
- No Electron/Node-only APIs in the consuming code — everything flows
  through `plugin_call` frames so the GPUI port keeps the same surface.
- No offering of mutations the host's `mutation_commands` does not
  advertise (`restore` gates on `mutation_commands`, `plan` on
  `commands`).
- `create` never combines `--repo` with a pane id.

## Evidence today

`docs/adr/ADR-0016.md` (initial pin) + `docs/adr/ADR-0017.md` (re-pin +
plan/restore scope). Implementation evidence:
`src/shell/checkpoints.ts` + `src/shell/checkpoints.test.ts`,
`src/components/CheckpointsDialog.tsx`, menu wiring in
`src/shell/WorkspaceHeader.tsx`, error-field allowlist in
`server/plugins.ts` + `server/plugins.test.ts`. Live plugin hosts are
RC verification.
