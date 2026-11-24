# Release-candidate visual review: herdr-t3 v0.5.0

You are reviewing release-candidate screenshots of **herdr-t3**, a desktop GUI client for the herdr terminal multiplexer (workspaces / tabs / panes containing real terminals). It is styled after T3 Code's design system, which is the design source of truth for spacing, density, color tokens, borders, radii, typography and affordances.

This is the v0.5.0 RELEASE CANDIDATE gate. v0.5.0 reworked the sidebar's information architecture and interaction model after a v0.4.0 real-use review found major gaps. Judge the CURRENT state fresh — do not assume prior rounds' fixes are correct, and do not rubber-stamp.

## What changed in v0.5.0 (verify these specifically)

1. **Agents section redesign** (`01`, `02`, `03`, `04`, `07`, `09`): the flat agent list was replaced by status shelves — Attention (blocked, always expanded), Working, Done, Idle (collapsible, Done/Idle collapsed by default). Each row is two lines: line 1 = status icon + state label + workspace/tab/machine attribution; line 2 = agent name + work target (terminal title) + auxiliary state labels. The agent *tool name* must NOT be the top-line information — "where is the work and what state is it in" must read first.
2. **Agent hover card** (`02`): hovering an agent row opens a glass tooltip card (T3 `ThreadHoverCard` pattern) with the work target as title and detail rows (status, agent, location, directory, pane title). It must not occlude the row, must match popup styling, and must contain only real data.
3. **Agent context menu** (`03`): right-click offers Focus / Details / Copy pane ID / Copy workspace ID.
4. **Shelf expansion** (`04`): the Idle shelf expanded shows idle agent rows; collapse state must be visually clear (chevron, count, section separation).
5. **Tab strip operations** (`05`, `06`): tabs have a context menu (Focus / Rename / Move left / Move right / Close) and a hover-revealed close button on inactive tabs (always visible on the active tab). The tab strip sits in the topbar next to the workspace breadcrumb.
6. **Workspace rows** (`01`, `07`): two-line hierarchy — title + branch/meta second line; machine folders when multiple machines exist.
7. **Motion**: list add/move/remove uses FLIP animation and popups animate in — visible state changes should read as transitions, not jumps. (Animations are not visible in stills; judge whether the *resting* states look like they belong to an animated system — consistent radii, spacing, no layout jitter artifacts.)
8. **Light + narrow** (`07`, `08`, `09`): light theme contrast; 480px viewport and mobile sheet remain usable with the denser sidebar.

## Image set

- `01-sidebar-agents` — main window dark: workspace rows + Agents shelves (Attention + Working open, Done/Idle collapsed headers)
- `02-agent-hover-card` — agent row hover card open
- `03-agent-context-menu` — agent row context menu open
- `04-agent-shelf-idle-expanded` — Idle shelf expanded
- `05-tab-context-menu` — tab strip context menu open
- `06-tab-hover-close` — inactive tab hovered, close button revealed
- `07-light-agents` — main window light theme
- `08-narrow` — 480x800 viewport
- `09-narrow-sheet-agents` — mobile sidebar sheet open with agents
- `contact-sheet` — all of the above in one grid
- `cmp-sidebar-dark`, `cmp-sidebar-light` — side-by-side herdr-t3 vs T3 Code main window (matched theme)

All captures are 1440x900 @2x except `08`/`09` (480x800 @2x). The session is a real isolated herdr session with 6 live agents (blocked/working/idle states).

## What to evaluate

1. **Information hierarchy**: can you tell at a glance which workspace/tab each agent works in, what state it is in (blocked > working > done > idle), and what the work target is? Is the agent tool name demoted to secondary info as intended?
2. **Shelf usability**: do the collapsible sections read as shelves (not arbitrary groups)? Are counts, chevrons, and section labels clear? Is Attention visually dominant without being garish?
3. **Row density**: two-line rows must stay scannable — no clipping, no overlapping text, truncation where appropriate, consistent alignment between line 1 and line 2.
4. **Hover card**: does it feel like a T3 hover card (glass, right-side, title + icon rows)? Is the content useful and non-redundant with the row?
5. **Context menus**: icons, destructive styling, item metrics consistent with the rest of the app.
6. **Tab strip**: context menu + hover close must not fight the tab labels; inactive-tab affordances must be discoverable but quiet.
7. **Themes**: light and dark — contrast of muted secondary text (line-2 agent rows are the lowest-contrast text; check they remain legible), accent usage, popup shadows.
8. **Narrow/mobile**: sheet width, scrim, touch targets, agent rows usable at 480px.

## What is NOT a defect

- Terminal content itself (shell prompts, agent TUIs like pi/opencode) vs conversational UI.
- herdr-specific features T3 lacks (agent status shelves driven by herdr AgentStatus, pane/workspace IDs in menus, worktree/goto dialogs).
- The Done shelf being absent when empty (empty sections hide their header by design).
- Documented deferrals: terminal inner padding/corner radius; Windows-only concerns; FLIP animation itself (verify in RC manual pass, not from stills).
- Content differences vs T3 Code (T3 shows threads; herdr-t3 shows panes) — judge styling/hierarchy, not content parity.

## Output

For each finding: severity (blocker / major / minor / nit), image filename(s), what you see, concrete fix direction. Explicitly state whether each numbered area above (1-8) is SHIP-quality. End with overall verdict: SHIP / FIX-FIRST / NEEDS-ITERATION and a one-paragraph summary. Be specific and skeptical — this gate exists because v0.4.0 shipped interaction gaps that screenshots alone did not catch.
