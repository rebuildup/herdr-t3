# T3 Code feature-parity inventory

Canonical mapping of T3 Code's feature surface (checkout pinned at
`9cc4018c`, see `docs/upstream.md`) onto herdr-t3. Governed by ADR-0009
and issue #188. Each feature is classified by where its data comes from:

- **[herdr]** — herdr already provides the data; client work only.
- **[cli]** — obtainable via an external CLI/integration (`gh`, agent CLIs).
- **[upstream]** — requires a herdr protocol/state extension; prepared as
  an upstream proposal, not fabricated.
- **[excluded]** — would make herdr-t3 own orchestration state; conflicts
  with the herdr boundary (ADR-0009).

## Sidebar / agent rows

| T3 feature | Class | Notes |
|---|---|---|
| Provider/harness icon on agent rows | [herdr] | `agent` name → icon map; T3 shows provider artwork |
| Thread status indicators (working/blocked/done) | [herdr] | `agent_status` + `state_change_seq` already mapped |
| Settle / Snooze / settled shelf | [herdr] | implemented (#173, T3 semantics in §6.2) |
| Thread hover card with title + agent row | [herdr] | needs terminal title in row data |
| Shelf ordering bottom-anchored (settled at bottom) | [herdr] | UI fix, in flight |
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
| Files / diff surface | [cli] | `git` in pane cwd; read-only browsing feasible |
| Issue detail panel | [cli]/[upstream] | needs issue identity (see Issues below) |
| PR detail panel | [cli]/[upstream] | needs PR identity |

## Issues / pull requests

| T3 feature | Class | Notes |
|---|---|---|
| Issues list page + saved views + search | [cli] | `gh issue list` per repo from pane cwd; heavy but feasible |
| PR list column/page | [cli] | `gh pr list`; T3 `pullRequest/` ≈30 components to port selectively |
| Issue/PR ↔ pane linking | [upstream] | herdr has no issue/PR identity field; link via cwd+branch heuristics [cli] as stopgap |

## Usage

| T3 feature | Class | Notes |
|---|---|---|
| Usage page, provider charts, price overrides | [upstream] | T3 meters provider API usage; herdr exposes no token/cost data. Needs herdr upstream field or agent-CLI scraping — upstream proposal required |
| Usage limits / pooled display | [upstream] | same dependency |

## Settings (~25 T3 sections)

| T3 feature | Class | Notes |
|---|---|---|
| Appearance (theme, density) | [herdr] | partially exists; complete to T3 set |
| Keybindings | [herdr] | client-side |
| Archived/threads/projects/devices/connections | mixed | only sections meaningful to herdr data ports; per-section triage in phase plan |
| Providers/secrets/scheduled-tasks/voice/MCP | mostly [excluded]/[upstream] | provider execution and scheduling are orchestration; voice/MCP have no herdr analog |

## Phasing (proposal for #188 children)

1. **v0.5.x polish (already in flight):** IME fix, shelf order, topbar
   icon+overflow, provider icons, hover-card title.
2. **v0.6.0 — surfaces:** right-panel host, agent details, files/diff
   (git read-only), settings sections that map to existing data.
3. **v0.6.x — integrations:** `gh`-backed issue/PR lists + detail panels;
   branch/worktree pickers via git.
4. **upstream-gated:** usage metering, issue/PR identity — blocked on
   herdrdev/herdr proposals (track alongside #6178 focus-report thread).

## Explicit exclusions (ADR-0009)

Thread/checkpoint lifecycle ownership, scheduled tasks, provider
execution settings, cloud sync, mobile — herdr or out of product scope.
