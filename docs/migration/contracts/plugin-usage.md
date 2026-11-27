# Contract: usage read surface — quota/usage/cost/divergence (B3)

Version: 1. Scope: consuming `herdr-plugins.usage/v1` through
`plugin_call` (ADR-0011 boundary, pinned at
`rebuildup/hoxay-plugins@d23205af0cd2ff7dba25f72e1f3b872762a108ee` =
tag `v0.9.0`, same pin as conversations-v1). The plugin owns token
aggregation over the `rebuildup.conversations` index, subscription
quota/reset reporting (provider endpoints + CLIProxyAPI-compatible
hubs), list-price cost estimates, and the quota-vs-measured
divergence report; herdr-t3 renders all four read surfaces (issue
#375). Upstream spec:
`hoxay-plugins/docs/contracts/usage-v1.md` (STABLE since
hoxay-plugins v0.5.0).

The plugin is **read-only**: `capability` advertises
`read_only: true` and `mutation_commands: []`. This client consumes
only the read surface — no mutation is ever offered, and the local
`USAGE_MUTATION_COMMANDS` allowlist stays empty so a future contract
revision fails closed until deliberately extended.

## Operations consumed

Commands are flat `plugin_call` command words; the plugin emits one
JSON document `{contract, ok:true, …}` on stdout (`capability` emits
the bare discovery document without the `ok` envelope):

- `capability` → `{contract:"herdr-plugins.usage/v1", plugin,
  version, read_only:true, mutation_commands:[], commands:[…],
  sources:[…]}`. This client requires `usage`, `quota`, `cost`,
  `divergence` in `commands`. `sources[]` is parsed for the
  `conversations-index` row (`id`/`kind`/`status`/`detail`) so the
  surface can show an honest hint when the index dependency is
  unavailable — additive rows are tolerated.
- `quota [--provider ID] [--refresh] [--timeout MS]` →
  `{cache:{ttl_seconds}, providers:[QuotaProvider…],
  hubs:[QuotaHub…], generated_at}`. Conversations-index
  independent — fetched eagerly per machine by the store.
  `providers[]` carry `status` (`ok|unsupported|no_credential|
  credential_expired|request_failed` — data, not errors), `plan`,
  `windows[]` (`id`/`label`/`kind`/`used_percent`/`resets_at`/
  `window_duration_mins`), `checked_at`/`fetched_at`, `stale`/
  `stale_reason`, `reset_credits_available`, and the cache
  `{hit,age_seconds,ttl_seconds}` triple — all rendered verbatim.
  Non-`ok` statuses always carry `windows: []`; missing quota data
  is never rendered as a zero window. `hubs[]` report
  CLIProxyAPI-compatible hubs with per-account outcomes
  (`accounts[]` reuse the provider status taxonomy).
- `usage [--pane PANE] [--session-id ID] [--provider ID] [--from ISO]
  [--to ISO] [--session NAME] [--socket PATH] [--timeout MS]
  [--offline]` → `{window, filters, totals, cache_tokens, breakdowns,
  coverage, sessions, source, warnings, hint?, generated_at}`.
  `--from`/`--to` are ISO-8601 instants, inclusive, compared against
  provider timestamps. `totals` sums the four canonical token buckets
  plus `thinking_tokens` (reported separately, never double-counted)
  and `provider_reported_cost_usd` — both `null` when no contributing
  event reported them, never zero-fabricated.
  `cache_tokens.providers[]` is the per-provider tri-state
  (`reported`|`unsupported`|`unknown`) rendered verbatim — never
  collapsed to a zero measurement. `breakdowns` carries six
  dimensions (`by_provider`/`by_model`/`by_host`/`by_project`/
  `by_session`/`by_pane`), each sorted by `total_tokens` desc;
  `key: null` means the dimension was unreported. `coverage` reports
  registry truth separate from measured totals — missing is not
  zero. A missing conversations index is NOT an error: the plugin
  returns `totals.events: 0` plus a `hint` suggesting
  `rebuildup.conversations index`; the surface renders both verbatim.
- `cost` (same selector args plus `--refresh`) → the `usage` body plus
  `cost:{estimate:true, disclaimer, estimated_cost_usd,
  estimate_complete, priced_models, unpriced_models[],
  provider_reported_cost_usd, pricing, by_model[]}`. The estimate is
  always labeled per the contract disclaimer — a list-price estimate,
  never a bill; `estimated_cost_usd` sums priced models only and is
  `null` when nothing could be priced. `cost_source` per row is
  `model_priced`|`unpriced` — unpriced rows carry
  `estimated_cost_usd: null`, never a guessed price. Provider-
  reported cost stays a separate figure, never blended. `pricing`
  reports table provenance (`status` `ok`|`stale`|`unavailable`,
  source URL, cache triple, `known_models`, `user_overrides`).
- `divergence` (same selector args plus `--refresh`) →
  `{window, filters, comparisons[], hubs[], notes[], source,
  generated_at}`. `comparisons[]` place quota windows and measured
  token sums side by side per provider with a `verdict`
  (`different_units`|`no_measured_usage`|`quota_unavailable`|
  `no_data`) — different units from different sources, reported side
  by side, never reconciled or converted. `window_alignment`
  (`unbounded`|`matches_quota_window`|`custom_window`|`unknown`)
  describes only whether the requested span matches a reported quota
  window duration. `hubs[]` mirrors the `quota` hub shape; hub
  accounts are excluded from `comparisons` (noted in `notes[]`).

## Operations NOT consumed

- No mutation commands — the contract advertises none
  (`mutation_commands: []`, `read_only: true`). If a future revision
  adds writes (e.g. cache GC), they stay out of scope until a
  dedicated ticket reviews them.
- `--session`/`--socket`/`--timeout` herdr-session targeting for
  live-binding checks inside the conversations read are supported by
  the argv builder but unused by the surface (the bridge already
  routes `plugin_call` to the owning host).
- `usage.sessions[]` contributing-session detail and
  `cost.by_model` beyond the estimate columns are parsed only where
  the surface renders them; the full session registry stays
  conversations-owned.

## Errors and freshness

- Boundary failures classify into the shared
  `not_installed|disabled|incompatible|unreachable|error` taxonomy;
  plugin-side `kind` values (`conversations_unavailable`,
  `conversations_error`, `usage_error`, …) stay `error` with verbatim
  detail — `conversations_unavailable` (the usage plugin cannot
  resolve its conversations source) maps to `unreachable`. Structured
  `error.hint` fields surface verbatim via `usageErrorHint`.
- `refreshUsage(machine)` mirrors the conversations store: plugin
  discovery → enabled check → capability probe → eager `quota`
  fetch, refreshed on snapshot pushes (debounced 800ms), machine
  online transitions, and machine-list changes via `initUsage()`.
  A `quota` failure keeps the machine `ready` with `quotaError` set —
  the index-dependent commands may still work and last-good quota is
  retained.
- `usage`/`cost`/`divergence` are lazy surface fetches with 400ms
  debounce on the provider/from/to filters; the breakdown dimension
  selector is client-side over the six contract dimensions (no
  refetch).
