# Release-candidate visual review: herdr-t3 v0.5.0

You are reviewing release-candidate screenshots of **herdr-t3**, a desktop GUI client for the herdr terminal multiplexer (workspaces / tabs / panes containing real terminals). It is styled after T3 Code's design system, which is the design source of truth for spacing, density, color tokens, borders, radii, typography and affordances.

This is the v0.5.0 RELEASE CANDIDATE gate. v0.5.0 reworked the sidebar's information architecture and interaction model after a v0.4.0 real-use review found major gaps, then converged remaining UI-quality items against the T3 Code reference implementation. Judge the CURRENT state fresh — do not assume prior rounds' fixes are correct, and do not rubber-stamp.

## What changed in v0.5.0 (verify these specifically)

1. **Agents shelves** (`01`, `02`, `03`, `04`, `07`, `09`): T3 `Sidebar` model — the always-visible list (Attention for blocked agents, then Done, then Idle) comes first; the Working, Snoozed and Settled shelves stack at the **bottom**, all **collapsed by default** with chevron + count headers. Empty shelves hide their header.
2. **Agent row hierarchy** (`01`, `04`, `07`, `09`): two lines per T3 `SidebarThreadRow` card variant —
   - **line 1 (context + state, secondary/muted weight)**: status icon + workspace/tab/machine attribution + resolved state label at the trailing edge
   - **line 2 (work target, primary weight)**: the live pane terminal title leads; agent display name, pane short-id (only when sibling rows would render identically) and auxiliary state labels are meta; the **provider/harness brand icon** (Claude, Codex, OpenCode, Pi, Cursor, Grok, Kiro, Muse artwork; initials fallback for other harnesses) sits rightmost
   The terminal title — "what the agent is doing" — must be the most prominent text on the row.
3. **Agent hover card** (`02`): hovering an agent row opens a glass tooltip card (T3 `ThreadHoverCard` pattern). Title = the pane's terminal title; rows = status, agent name + provider icon, location, working directory, pane id. It must not occlude the row, must match popup styling, and must contain only real data.
4. **Agent context menu** (`03`): right-click offers Focus / Details / Settle / Snooze or Restore (shelf-dependent) / Copy pane ID / Copy workspace ID.
5. **Tab strip operations** (`05`, `06`): tabs have a context menu (Focus / Rename / Move left / Move right / Close) and a hover-revealed close button on inactive tabs (always visible on the active tab). The tab strip sits in the topbar next to the workspace breadcrumb; the topbar's split/right-pane controls are icon buttons with tooltips, low-frequency actions live in an overflow menu.
6. **Workspace rows** (`01`, `07`): two-line hierarchy — title + branch/meta second line; machine folders when multiple machines exist.
7. **Motion**: list add/move/remove uses FLIP animation and popups animate in — visible state changes should read as transitions, not jumps. (Animations are not visible in stills; judge whether the *resting* states look like they belong to an animated system — consistent radii, spacing, no layout jitter artifacts.)
8. **Light + narrow** (`07`, `08`, `09`): light theme contrast; 480px viewport and mobile sheet remain usable with the denser sidebar.

## Image set

- `01-sidebar-agents` — main window dark: workspace rows + Agents shelves (Attention/Done/Idle list, Working/Snoozed/Settled collapsed shelves at bottom, hairline-separated)
- `02-agent-hover-card` — agent row hover card open
- `03-agent-context-menu` — agent row context menu open
- `04-agent-shelf-expanded` — a bottom shelf (Working) expanded
- `05-tab-context-menu` — tab strip context menu open
- `06-tab-hover-close` — inactive tab hovered, close button revealed without layout shift
- `06b-header-tooltip` — header icon-button tooltip (Split right) open
- `07-light-agents` — main window light theme
- `07b-light-hover-card` — agent hover card in light theme
- `08-narrow` — 480x800 viewport (split buttons folded into overflow menu)
- `09-narrow-sheet-agents` — mobile sidebar sheet open with agents
- `contact-sheet` — all of the above in one grid

All captures are 2880x1800 (@2x of 1440x900) except `08`/`09` (480x800 @2x). The session is a real isolated herdr session with 12 live agents across harnesses (pi, codex, claude, opencode, grok, cursor, devin — the last exercises the initials fallback) in blocked/working/idle states, with realistic OSC terminal titles.

## What to evaluate

1. **Information hierarchy**: can you tell at a glance which workspace/tab each agent works in, what state it is in (blocked > working > done > idle), and what the work target is? Does the terminal title read as the row's primary information with the agent name demoted to meta, matching T3's thread rows?
2. **Provider icons**: do brand marks render crisply at row size in both themes (dark/light), aligned with the meta line, with the initials fallback looking intentional for harnesses without artwork?
3. **Shelf usability**: do the collapsible bottom shelves read as shelves (not arbitrary groups)? Are counts, chevrons, and section labels clear? Is Attention visually dominant without being garish?
4. **Row density**: two-line rows must stay scannable — no clipping, no overlapping text, truncation where appropriate, consistent alignment between line 1 and line 2.
5. **Hover card**: does it feel like a T3 hover card (glass, right-side, title + icon rows)? Is the content useful and non-redundant with the row?
6. **Context menus**: icons, destructive styling, item metrics consistent with the rest of the app.
7. **Tab strip / topbar**: context menu + hover close must not fight the tab labels; inactive-tab affordances must be discoverable but quiet; header icon buttons need visible toolchips on hover. Tab padding is constant so hover/focus reveal never shifts the strip; below `sm` the split buttons fold into the overflow menu and the tab scroller scrolls rather than colliding (`08` is the regression case for the previous mid-glyph collision).
8. **Themes**: light and dark — contrast of muted secondary text, accent usage, popup shadows, icon legibility in both themes (including the glass hover card, `07b`).
9. **Narrow/mobile**: sheet width, scrim, touch targets, agent rows usable at 480px.
10. **Row alignment**: agent row line 1 and line 2 must share the same left text rail; shelf section counts must align across collapsible and static headers; the shelf region must be visually separated from the always-visible list.

## What is NOT a defect

- Terminal content itself (shell prompts, agent TUIs like pi/opencode) vs conversational UI.
- herdr-specific features T3 lacks (agent status shelves driven by herdr AgentStatus, pane/workspace IDs in menus, worktree/goto dialogs).
- The Done/Idle sections being absent when empty (empty sections hide their header by design).
- Documented deferrals: terminal inner padding/corner radius; Windows-only concerns; FLIP animation itself (verify in RC manual pass, not from stills).
- Content differences vs T3 Code (T3 shows threads; herdr-t3 shows panes) — judge styling/hierarchy, not content parity.
- Harnesses without a T3 brand asset rendering initials text instead of a logo — that is the intended fallback.

## Output

For each finding: severity (blocker / major / minor / nit), image filename(s), what you see, concrete fix direction. Explicitly state whether each numbered area above (1-10) is SHIP-quality. End with overall verdict: SHIP / FIX-FIRST / NEEDS-ITERATION and a one-paragraph summary. Be specific and skeptical — this gate exists because v0.4.0 shipped interaction gaps that screenshots alone did not catch.
