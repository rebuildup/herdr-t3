# Contract: provider transcript index — sessions/history/search (B3)

Version: 1. Scope: consuming `herdr-plugins.conversations/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/hoxay-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`). The plugin owns the provider transcript index
(claude/codex/opencode JSONL/SQLite normalization), the per-session
event logs, and staleness verdicts; herdr-t3 renders the session list,
paged event history, search results, and `show` reference resolution,
and drives the explicit `index` mutation (issues #374/#457).
Upstream spec:
`hoxay-plugins/docs/contracts/conversations-v1.md` (STABLE since
hoxay-plugins v0.5.0).

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract, ok:true, …}` on stdout (`capability` emits
the bare discovery document without the `ok` envelope):

- `capability` → `{contract:"herdr-plugins.conversations/v1", plugin,
  version, read_only:false, mutation_commands:["index","refresh"],
  commands:[…], providers:[{id,status,reason?,formats,usage}],
  event_types:[…]}`. Unlike automations-v1, this contract DOES
  advertise `mutation_commands`, so mutation gating intersects the
  local `CONVERSATIONS_MUTATION_COMMANDS` allowlist (`index`,
  `refresh`) with the advertised `mutation_commands` set AND the flat
  `commands` list — a document missing the field never offers the
  mutation. This client requires `sessions`, `history`, `search`.
- `sessions [--offline]` → `{sessions:[SessionEntry…], count}` —
  indexed transcripts newest-activity first. Each entry carries
  read-time plugin verdicts rendered verbatim: `status`
  (`ok|missing|error`) + `error` kind, `stale`/`stale_reason`
  (`agent_session_changed` on pane-id reuse / new agent generation),
  `live` binding, `transcript_present` (provider-side file deleted or
  rotated), `event_count`/`turn_count`/`first|last_event_at`/
  `last_indexed_at`. `sessions[]` entries do NOT carry
  `events_present` (only the `history`/`search`/`show`/`usage`
  session blocks do) — the parser leaves it null rather than
  fabricating.
- `history (--session-id REF | --pane PANE) [--limit N] [--cursor OFF]
  [--offline]` → `{session:SessionEntry+events_present,
  selector_note, events:[ConversationEvent…], page:{limit, offset,
  returned, next_cursor, has_more, malformed_lines,
  duplicates_skipped, events_present, events_size}}`. `next_cursor` is
  a stringified byte offset — opaque to the client, passed back
  verbatim; a rewritten event log fails `cursor_invalid`.
  The pane context menu's copy-report dialog (issue #429,
  `docs/design/report-copy.md`) also consumes `history --pane` —
  bounded paging (≤8×200 events) on explicit invocation only — and
  applies the same identity/stale/truncated honesty rules; it adds no
  new contract surface.
- `search <query> [--pane PANE] [--session-id REF] [--provider ID]
  [--type TYPE] [--limit N] [--cursor CUR] [--offline]` →
  `{query, filters, selector_note, results:[{session_key, event_id,
  type, timestamp, turn_index, matched_fields, event}], page:{limit,
  returned, next_cursor, has_more, malformed_lines,
  duplicates_skipped, restarted_sessions}, sessions:[…]}`.
  `next_cursor` is an opaque base64url per-session-offset token —
  verbatim round-trip; `restarted_sessions` flags logs rewritten
  smaller between pages (duplicates possible, explicitly reported).
- `show <ref> [--session-id REF] [--pane PANE] [--provider ID]
  [--offline]` → `{ref, resolved:{kind}, selector_note,
  results:[{session_key, matched_fields, event}], matched, truncated,
  sessions:[…]}` (issue #457). `<ref>` is a bare `event_id`/
  `tool_use_id`, `tool:<tool_use_id>` (call/result pair), or
  `turn:<n>` (whole turn). No cursor — results cap at 200 upstream and
  `truncated` reports the cap; `resolved.kind` is the plugin's verdict
  rendered verbatim. The surface derives refs per history event row
  (`tool:` for tool events, `turn:` for turn boundaries, bare
  `event_id` otherwise) scoped via `--session-id`.

### Mutation (issue #374)

- `index` (alias `refresh`; this client always sends `index`) →
  `{indexed:[{key,provider,session_id,events_appended,total_events,
  reindexed,malformed_lines}], skipped:[{pane_id,provider,
  session_id,reason,cwd,…}], sessions_indexed, events_appended}`.
  Non-destructive — writes only plugin state under
  `HERDR_PLUGIN_STATE_DIR`, never herdr or provider files — so the
  surface offers an explicit "Index now" button with no confirm
  dialog. It is potentially slow, so the call carries the bridge
  maximum `timeout_ms` (120s); `plugin_timeout` classifies as
  `unreachable`. `skipped[].reason` values (`unknown_provider`,
  `unsupported_provider`, `no_agent_session`, `transcript_missing`,
  `session_not_found`, `unsupported_layout`, `open_failed`,
  `read_failed`, `sqlite_*`) are plugin-side detail — the surface
  reports counts and distinct reasons, never fabricated outcomes.
  Every index is followed by a `sessions` refresh.

`mutation_commands` advertises exactly `["index","refresh"]` — the
only mutations the v1 contract defines (verified against the pinned
`cli.ts` at d23205af for issue #457). No other command mutates plugin
or herdr state, so no additional mutation gating exists.

## Operations NOT consumed

- `usage` — token/cost aggregation read surface; separate ticket
  (#364).
- `index [--session NAME] [--socket PATH] [--timeout MS]` options —
  herdr-session/socket targeting stays plugin-side; the bridge already
  routes `plugin_call` to the owning host.

## Data shapes (defensive projections)

- `SessionEntry` = `key` (`<provider>:<session-id>`, the
  `history --session-id` selector), `provider`, `session_id`,
  `cwd`, `transcript_path`, `status`, `error`, `identity`,
  `live {pane_id, agent_session_value, state_change_seq}`,
  `live_session`, `stale`, `stale_reason`, `event_count`,
  `turn_count`, `first_event_at`, `last_event_at`, `last_indexed_at`,
  `transcript_present`, `events_present?`.
- `identity` = index-time herdr binding (`host`, `herdr_session`,
  `workspace_id`, `tab_id`, `pane_id`, `agent`,
  `agent_session {agent,kind,value}`, `state_change_seq`) — a
  historical fact, never re-resolved client-side.
- `ConversationEvent`: `event_id`, `type` (open string over the v1
  enum), `timestamp`, `identity`, `turn_index`, `model`, `usage`
  (`input_tokens`/`output_tokens`/`cache_*`/`thinking_tokens`, all
  nullable — absent usage is never zero-fabricated), `cost_usd`,
  `text`/`text_truncated`, `tool_use_id`/`tool_name`/`tool_input`/
  `input_truncated`, `is_error`, `subtype`, `sidechain`.
- `capability.providers[]`: `{id, status ("supported"|"unsupported"),
  reason?, formats[], usage.cache_tokens ("reported"|"unsupported")}`
  — the authoritative support matrix, rendered as parsed.

## Error model

Plugin errors arrive as `plugin_call` failures whose `code` is the
contract `error.kind` (`session_not_found`, `cursor_invalid`,
`session_unreachable`, `read_failed`, plus scanner kinds). Boundary
failures map to the shared taxonomy: `plugin_not_installed` →
`not_installed`, `plugin_disabled` → `disabled`,
`plugin_incompatible`/`plugin_unsupported_command`/
`plugin_bad_output` → `incompatible`, transport failures plus
`session_unreachable`/`plugin_timeout` → `unreachable`, everything
else → `error`. Structured `error.hint` (e.g. selector misses suggest
`index`) travels in `error.fields` and is surfaced verbatim via
`conversationsErrorHint`. Foreign contracts and malformed documents
are rejected by the parsers (`plugin_bad_output`), never rendered as
data.

## Freshness

`sessions` refetches on session-snapshot pushes (800 ms debounce), on
machine `online`, and on machine-set changes — the same triggers as
`rebuildup.inbox`/`rebuildup.automations`. `stale`/`transcript_present`/
`live` are recomputed plugin-side at every read, so a refresh can
never show stale verdicts; `history`/`search` are fetched lazily per
expanded session / submitted query and page via opaque cursors.
