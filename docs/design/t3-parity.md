# T3 Code feature-parity inventory

Canonical mapping of T3 Code's feature surface (checkout pinned at
`9cc4018c`, see `docs/upstream.md`) onto herdr-t3. Governed by ADR-0009
and issue #188. The machine-readable capability ledger for the GPUI
migration program lives in `docs/migration/capabilities.json` (issue
#235); entries there reference this inventory via `parity` and must not
duplicate its classifications — this file remains the feature-mapping
source of truth. Each feature is classified by where its data comes from:

- **[herdr]** — herdr already provides the data; client work only.
- **[cli]** — obtainable via an external CLI/integration (`gh`, agent CLIs).
- **[upstream]** — requires a herdr protocol/state extension; prepared as
  an upstream proposal, not fabricated.
- **[excluded]** — would make herdr-t3 own orchestration state; conflicts
  with the herdr boundary (ADR-0009).
- **[plugin]** — owned by a published `herdr-plugins` contract consumed
  through the ADR-0011 boundary (`plugin_list`/`plugin_call`); supersedes
  `[cli]` where a plugin owns the capability (#219/#220).

## Sidebar / agent rows

| T3 feature | Class | Notes |
|---|---|---|
| Provider/harness icon on agent rows | [herdr] | `agent` name → icon map; T3 shows provider artwork |
| Thread status indicators (working/blocked/done) | [herdr] | `agent_status` + `state_change_seq` already mapped |
| Settle / Snooze / settled shelf | [plugin] | `rebuildup.inbox` v1 owns organize state (#219, ADR-0011); #173 localStorage migrated |
| Thread hover card with title + agent row | [herdr] | needs terminal title in row data |
| Shelf ordering bottom-anchored (settled at bottom) | [herdr] | UI fix, in flight |
| Progressive disclosure: collapsed shelf keeps route row; "Show N more" paging | [herdr] | #389 — T3 `routeThreadOnly` + settled tail / `ThreadDetailsMoreButton` port |
| Worktree base-branch picker | [cli]/[upstream] | cwd is known; branch ops need git |
| Archived threads | [excluded] | thread lifecycle is orchestration state |

## Topbar / toolbar

| T3 feature | Class | Notes |
|---|---|---|
| Icon buttons for common actions + overflow "…" menu | [herdr] | T3 `PanelLayoutControls` pattern |
| Breadcrumb / workspace header | [herdr] | exists; polish to T3 pattern |
| Command palette (⌘K) | [herdr] | actions over existing panes/workspaces |
| Keyboard shortcuts / keybindings settings | [herdr] | client-side |

## Right panel / surfaces

| T3 feature | Class | Notes |
|---|---|---|
| Agent details panel | [herdr] | cwd, status, seq, machine |
| Preview browser surface | [excluded-adjacent] | T3 preview is provider-tooling; revisit if a herdr-native analog exists |
| Files / diff surface | [plugin] | `herdr-plugins.git/v1` pinned @d057830 (ADR-0012/0018): status + grouped files/path-scoped diff + log + compare connected (#220/#227), explicit-only mutations (stage/unstage/commit/branch/upstream/fetch/push, `remote` list) connected (#228, capability-gated per host); forge `pr status|list|view|create` connected (#229, gh-gated: `gh_missing`/`gh_error` shown as reasons); strict argv parsing with `usage` exit-2 errors classified distinctly (#265) |
| Issue detail panel | [cli]/[upstream] | needs issue identity (see Issues below) |
| PR detail panel | [cli]/[upstream] | needs PR identity |
| Projects registry (multi-repo, pin/archive, settings, repo membership) | [plugin] | `herdr-plugins.projects/v1` pinned @2dcb2abf (ADR-0014/0015/0019/0020): registry UI connected (#252, capability-gated per host); #69 audit semantics (verbatim remote case, `has_submodules` tri-state, wholesale settings rewrite) consumed |
| Project Scripts (list/run/stop/results/logs) | [plugin] | same contract: scripts UI connected (#253, schema v2 run ownership + stop confirmation per #259; durable scrollback completion receipt per #265/ADR-0019 — `running` may finalize on refresh; shell-family `--shell` selector + `shell_family`/`shell_source` display per #269/ADR-0020); auto triggers upstream-gated (herdr-plugins#60) |
| Checkpoints | [plugin] | `herdr-plugins.checkpoints/v1` pinned @ae4f214 (ADR-0016/0017/0021/0024): list/show/diff/create/delete + plan/restore surface connected (#260/#264, capability-gated per host; plan preview, shared-worktree isolation, explicit-only `--force`, pre-restore recovery); work-unit auto-capture consumed (#268: `kind` badges, `auto_captures` drain outcomes surfaced, explicit `create --auto`); multi-repo save groups + restore-group + bounded gc/prune connected (#279: `group_id` badges/`--group` filter, mandatory dry-run preview, per-repo partial results via the bridge stdout-report convention); per-turn capture remains upstream-gated |
| Conversations (indexed transcript sessions/history/search) | [plugin] | `herdr-plugins.conversations/v1` pinned @d23205af (ADR-0027): sessions list + expandable paged event history + search surface connected (#374, capability-gated per host; opaque `next_cursor` paging verbatim, stale/missing verdicts rendered as the plugin reports them); explicit `index` mutation gated on `mutation_commands`; `show` remains a separate ticket, `usage` aggregation is consumed via `herdr-plugins.usage` (#375) |
| Automations (scheduled/event tasks) | [plugin] | `herdr-plugins.automations/v1` pinned @6c1cfa5 (ADR-0026): task/run surface connected (#361 read + #362 lifecycle mutations); driver commands remain out of scope |

> **Container rule (maintainer directive, #333):** plugin surfaces are docked
> right-panel tabs in the T3 `ChatRightPanel`/`RightPanelTabs` pattern — a
> small non-modal control panel — never bespoke modal dialogs. The current
> `*Dialog.tsx` implementations are interim containers pending migration to
> the right-panel host.

## Issues / pull requests

| T3 feature | Class | Notes |
|---|---|---|
| Issues list page + saved views + search | [cli] | `gh issue list` per repo from pane cwd; heavy but feasible |
| PR list column/page | [cli] | `gh pr list`; T3 `pullRequest/` ≈30 components to port selectively |
| Issue/PR ↔ pane linking | [upstream] | herdr has no issue/PR identity field; link via cwd+branch heuristics [cli] as stopgap |

## Usage

| T3 feature | Class | Notes |
|---|---|---|
| Usage page, provider charts, price overrides | [plugin] | `herdr-plugins.usage/v1` pinned @d23205af (ADR-0028): usage/cost/divergence aggregation over the conversations index connected (#375 — token totals, six breakdown dimensions, cache-token tri-state, labeled cost estimate with unpriced-model disclosure); price overrides stay plugin config-side (`modelPrices`), not GUI-consumed |
| Usage limits / pooled display | [plugin] | same contract: quota provider windows (`used_percent`/`resets_at`/plan/stale) + CLIProxyAPI hub accounts rendered verbatim (#375); pooled cross-provider rollup remains unbuilt |

## Settings (~25 T3 sections)

| T3 feature | Class | Notes |
|---|---|---|
| Appearance (theme, density) | [herdr] | partially exists; complete to T3 set |
| Keybindings | [herdr] | client-side |
| Archived/threads/projects/devices/connections | mixed | only sections meaningful to herdr data ports; per-section triage in phase plan |
| Providers/secrets/scheduled-tasks/voice/MCP | mostly [excluded]/[upstream] | provider execution and scheduling are orchestration; voice/MCP have no herdr analog |

## Phasing (canonical; issue ownership follows this)

Release scope rule (maintainer directive): **existing-UI quality and UX
parity items ship in v0.5.0; new feature surfaces ship in v0.6.0+**.

1. **v0.5.0 — UI quality parity (existing surfaces only):** IME fix (#190),
   shelf order (#192), topbar icon+overflow (#194), provider icons on agent
   rows, hover-card terminal title + agent row, agent-row info hierarchy,
   tooltips, motion/animation parity. No new panels or data sources.
2. **v0.6.0 — new surfaces:** right-panel host + plugin surface
   migration (#333: `src/shell/rightPanelStore.ts` +
   `src/shell/RightPanel.tsx`, workspace-scoped docked tabs replacing the
   interim `*Dialog` containers), agent details panel,
   files/diff surface via `herdr-plugins.git` (#220 read-only;
   #227 reads / #228 mutations / #229 forge PRs landed on the pinned
   contract), projects registry + scripts via `herdr-plugins.projects`
   (#252/#253 on the @2dcb2abf pin), checkpoints via
   `herdr-plugins.checkpoints` (#260/#264 on the @c8dc3b3 pin,
   work-unit auto-capture on the @55df8d0a pin via #268, save groups +
   retention on the @ae4f214 pin via #279), automations surface
   via `herdr-plugins.automations` (#361 read + #362 lifecycle
   mutations on the @6c1cfa5 pin — scheduled tasks are plugin-owned;
   the GUI renders task/run state and drives set-enabled/run-now/
   delete/reconcile), conversations surface via
   `herdr-plugins.conversations` (#374 on the @d23205af pin —
   sessions/history/search reads plus the explicit `index` mutation;
   `show` remains a separate ticket), usage surface via
   `herdr-plugins.usage` (#375 on the @d23205af pin — quota/usage/
   cost/divergence reads; read-only contract, no mutations),
   settings sections that map to existing data.
3. **upstream-gated (any release):** issue/PR identity —
   blocked on herdrdev/herdr proposals (track alongside #6178
   focus-report thread).

## Explicit exclusions (ADR-0009)

Thread/checkpoint lifecycle ownership, scheduled-task orchestration
(plugin-owned via `rebuildup.automations`; herdr-t3 renders the
surface and drives lifecycle mutations — task authoring and driver
management remain separate tickets), provider
execution settings, cloud sync, mobile — herdr or out of product scope.
