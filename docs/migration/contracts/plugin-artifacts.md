# Contract: artifacts surface — reads + mutations (B3)

Version: 2 (was 1 — mutation surface added, issue #455). Scope:
consuming `herdr-plugins.artifacts/v1` through `plugin_call`
(ADR-0011 boundary, pinned at
`rebuildup/herdr-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as usage-v1/conversations-v1). The plugin owns
the artifact registry — register/validate/index references to
generated files (HTML pages, images, PDFs, generic files) — and this
client renders its read surfaces (issue #396) plus the mutation
surface (issue #455). Upstream spec:
`herdr-plugins/docs/contracts/artifacts-v1.md` (STABLE since
herdr-plugins v0.7.0; plugin `rebuildup.artifacts` v0.2.0+).

The contract advertises mutations (`read_only: false`,
`mutation_commands: ["register", "delete", "deliver", "gc"]`). This
client consumes all four, gated by the local
`ARTIFACTS_MUTATION_COMMANDS` allowlist ∩ advertised
`mutation_commands` ∩ `commands` — a command missing from any of the
three fails closed.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract, ok:true, …}` on stdout (`capability` emits
the bare discovery document without the `ok` envelope):

- `capability` → `{contract:"herdr-plugins.artifacts/v1",
  contract_status:"stable", plugin, version, read_only:false,
  mutation_commands:[…], commands:[…], implemented_commands:[…],
  kinds:[html|image|pdf|file|other], storage_modes:[state_copy|
  path_ref], limits:{max_bytes, path_ref_oversize}, …}`. This client
  requires `export`, `search`, `verify` in `commands`; `kinds` feeds
  the kind filter (fallback to the contract's five kinds when
  unadvertised).
- `export [--kind KIND] [--pane PANE] [--agent SESSION]
  [--created-by CREATED_BY] [--session NAME] [--limit N]` →
  `{session, artifacts:[…], total, returned, complete, filters,
  orphans, corrupt, generated_at}`. This is the contract-designated
  client read surface: the same annotated records as `list` plus the
  honest truncation echo (`complete:false` + `returned < total` when
  `--limit` applies; default is complete). Fetched eagerly per machine
  by the store and re-fetched lazily with the surface's filter args.
- `search <query> [--kind KIND] [--pane PANE] [--agent SESSION]
  [--created-by CREATED_BY] [--session NAME] [--since ISO]
  [--until ISO] [--limit N]` → the `export` body plus `query` echo.
  Free-text matching over identity, kind/mime, filename, owner
  fields, host, session and `refs` — metadata only, never payload
  bytes. `--since`/`--until` are inclusive ISO-8601 bounds on
  `created_at`. Run on submit only (not debounced-poll).
- `verify [artifact_id]` → `{results:[{artifact_id, status:
  ok|corrupt|missing, issues[], checks:{payload_exists, sha256_match,
  size_match, mime_match}, artifact}], summary:{total, ok, corrupt,
  missing}, orphans, corrupt}`. Read-only health report — the plugin
  exits 0 even when artifacts are unhealthy. Button-triggered only:
  it re-hashes every payload plugin-side, so it is never polled. With
  no id the whole index is verified.

### Mutations (issue #455)

All four advertised `mutation_commands` are consumed; each runs only
behind a confirmation dialog naming the exact target (artifact id,
kind, resolved path, deliver pane, gc cutoff) and renders the plugin's
result document verbatim. A successful mutation bumps a registry
refresh nonce and re-fetches `export` — the surface never assumes the
post-mutation index. Failures surface `error.kind`/detail verbatim
(`referenced`, `missing_ref`, `target_not_found`, `agent_not_found`,
`delivery_failed` + `rpc_code`, `too_large`, `session_unreachable`,
`state_corrupt`, `lock_timeout`, `usage`, …).

- `register --path FILE [--kind KIND] [--storage MODE] [--title T]
  [--pane PANE] [--created-by C] [--ref REF ...]` → `{artifact}`.
  `--stdin` is deliberately never sent (payload bytes cannot cross
  `plugin_call`); kind/storage/created-by/refs are optional and unset
  values are inferred/defaulted plugin-side. Refs are entered one per
  line.
- `delete <artifact_id> [--force]` → `{artifact_id, storage_mode,
  removed_payload}`. Records with non-empty `refs` refuse without
  `--force` (`referenced`); the dialog shows the refs and requires an
  explicit force opt-in. `path_ref` external files are never removed —
  `removed_payload:false` says so honestly.
- `deliver <artifact_id> --agent PANE | --pane PANE [--note TEXT]` →
  `{target:{kind,pane_id}, method, message, artifact}`. `--agent`
  sends via `agent.prompt` (preferred for agent panes); `--pane` sends
  literal text via `pane.send_text` — the dialog warns that embedded
  newlines reach the PTY as Enter (contract caveat). The exact `message`
  sent is rendered verbatim on success.
- `gc --older-than ISO [--dry-run]` → `{policy, dry_run, evaluated,
  expired, entries[], totals{…}, orphans, corrupt}`. The dialog defaults
  to dry-run (full evaluation, zero mutation); entries keep verbatim
  `action` (`deleted`/`would_delete`/`skipped`) and `reason`
  (`referenced`/`invalid_created_at`/`delete_failed`) plus per-entry
  `error`s and `totals.errors`. `gc` is pure plugin-state work and
  needs no live session.

### Artifact record (annotated)

Every `artifacts[]` entry is the contract record plus read-time
annotations: `missing_ref` (payload gone/unsafe), `owner_stale`
(owner pane absent from the live snapshot), recomputed `oversize`,
and merged `warnings[]`. `storage.resolved_path` is the absolute path
a consumer may open — metadata only, never payload bytes. `meta.render`
(`{isolation:"required", policy:"client"}`) appears on `kind:"html"`
records as the render-isolation notice.

## Operations NOT consumed

- `list` and `get` — not separately consumed: `export` carries the
  identical annotated record shape and is the stable client read
  surface per the contract.
- `--session NAME` record-session filter — **unusable upstream**: the
  CLI's top-level `parseArgs` consumes `--session` as the herdr
  CallOptions session selector before command flags are parsed, so
  the flag can never reach the record filter. The argv builder
  deliberately never emits it (recorded as an upstream quirk; a fix
  belongs in herdr-plugins).
- Payload bytes / inline rendering — `resolved_path` is displayed as
  text with a copy affordance only. No shell-open bridge exists in
  herdr-t3 yet, so "open" is copy-then-open-external; `kind:"html"`
  is never rendered inline (client-side isolated rendering with
  sandbox/CSP is a later concern per the contract safety boundary).

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side `kind` values (`session_unreachable`, `state_corrupt`,
  `lock_timeout`, `artifact_not_found`, `missing_ref`, `referenced`,
  `too_large`, `usage`, …) stay `error` with verbatim detail, except
  `session_unreachable` which maps to `unreachable` (the live herdr
  session the plugin needs for owner/staleness checks cannot be
  reached). Structured `error.hint` fields surface verbatim via
  `artifactsErrorHint`.
- `refreshArtifacts(machine)` mirrors the usage store: plugin
  discovery → enabled check → capability probe → eager `export`
  fetch, refreshed on snapshot pushes (debounced 800ms), machine
  online transitions, and machine-list changes via `initArtifacts()`.
  An export failure keeps the machine `ready` with `reportError` set
  and last-good data retained.
- `missing_ref`/`owner_stale`/`oversize`/`orphans`/`corrupt` are
  rendered verbatim — honest degradation, never failures. An empty
  registry (producers may not exist yet) renders as an honest empty
  state, not an error.
