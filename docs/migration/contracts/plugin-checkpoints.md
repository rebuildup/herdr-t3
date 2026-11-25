# Contract: worktree checkpoints (B3)

Version: 1. Scope: consuming `herdr-plugins.checkpoints/v1` through
`plugin_call` (ADR-0011 boundary, ADR-0016 pin at
`rebuildup/herdr-plugins@4aab1a7`). The plugin owns capture, hidden git
refs (`refs/herdr-plugins/checkpoints/<repo-key>/<id>`), and the state
index; herdr-t3 renders them and forwards explicit user operations
only. Upstream spec:
`herdr-plugins/docs/contracts/checkpoints-v1.md`.

## Operations

Commands are flat `plugin_call` command words (no subcommand argv):

- `capability` → `{contract, commands, mutation_commands:["create","delete"],
  read_only:false, requires:{git,bun}}`.
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
- `delete <id>` → removes the state entry always; deletes the hidden
  ref when it still exists.

## Ordering and semantics

- Checkpoint identity: `id` = `<base36-ms>-<8hex>`; `repo_key` =
  sha256(canonical repo root)[:16]; `ref` =
  `refs/herdr-plugins/checkpoints/<repo_key>/<id>`; `commit` is a
  synthetic commit whose first parent is the captured HEAD.
- `show` reports `ref.exists:false` while still returning the entry —
  the ref may have been deleted out-of-band; the client renders that
  state, never drops the row.
- `delete` is idempotent: `ref_existed:false` + `warnings` when the ref
  was already gone or the repo is unreachable.
- Capture never touches the user's index/worktree (temporary
  `GIT_INDEX_FILE`); submodule gitlinks are recorded but submodule
  worktree contents are not captured (record-and-warn).
- v1 non-goals (herdr-plugins#73–#75): no restore, no turn-boundary
  auto-capture, no multi-repo orchestration, no checkpoint GC, no
  private object store/quarantine, no submodule worktree capture.

## Errors

- Boundary codes: `plugin_not_installed`, `plugin_disabled`,
  `plugin_incompatible`, `plugin_unsupported_command`,
  `plugin_host_unreachable`, `plugin_bad_output`.
- Plugin `error.kind` passthrough: `not_a_repo`, `bare_repo`,
  `empty_repo`, `sparse_checkout`, `unknown_checkpoint`, `cross_repo`,
  `pane_not_found`, `no_pane_cwd`, `git_missing`, `timeout`,
  `git_error`, `usage`.

## Negative cases

- No direct reads of plugin state files or hidden refs — resolution is
  the plugin's job.
- No restore/auto-capture/GC affordances — not in the v1 contract.
- No Electron/Node-only APIs in the consuming code — everything flows
  through `plugin_call` frames so the GPUI port keeps the same surface.
- No offering of mutations the host's `mutation_commands` does not
  advertise.
- `create` never combines `--repo` with a pane id.

## Evidence today

`docs/adr/ADR-0016.md` (pin + scope). Implementation evidence:
`src/shell/checkpoints.ts` + `src/shell/checkpoints.test.ts`,
`src/components/CheckpointsDialog.tsx`, menu wiring in
`src/shell/WorkspaceHeader.tsx`. Live plugin hosts are RC verification.
