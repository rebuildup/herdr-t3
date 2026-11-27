# Contract: UI shell semantics (B6/B7)

Version: 1. Scope: the T3 Code application shell as *semantics*, not
implementation — ADR-0008 canonical structure, `docs/design/*` rules,
`docs/design/verification.md` state matrix. React/Tailwind/Base UI are
the current implementation; GPUI must reproduce the observable
behavior, not the DOM.

## Operations (semantic actions)

- Shell: sidebar (chrome header, searchable item list, footer
  utilities), offcanvas collapse, floating control trigger, window-
  controls insets; content routes (utility pages vs main view with
  52px drag-region header + breadcrumb + actions).
- Command palette (⌘K / Ctrl+K) and goto dialog: fuzzy row search over
  workspaces/tabs/panes with status-token filter.
- Sidebar: workspace tree (machine folders, two-line rows,
  drag-reorder), agent shelves w/ hover card, context menus, notices.
  Agent row identity/status glyph (issue #419): a single shared
  component leads each agent row — brand provider mark (resolution
  order in `shared/agent-icons.json`: T3 artwork → bundled official
  SVG → generic glyph) at a 20px slot with the brand art at 16px,
  plus a perimeter status ring carrying `agent_status`. Ring grammar:
  working = rotating primary arc around the *static* brand mark
  (started/stopped only by the shared visibility control —
  on-screen + document visible + motion allowed; static full ring
  under reduced-motion), blocked = heavier warning ring, done =
  success ring, idle = quiet muted ring, unknown/unrecognized =
  dashed muted ring. State name is never printed on the row; it lives
  in the shelf, hover card and accessible name. GPUI must reproduce
  the same asset resolution, state→ring mapping and 20px footprint —
  not a renderer-specific variant.
- Tab strip: select/close/rename/move/drag, hover affordances,
  overflow scroll, per-tab agent status.
- Pane grid: split/zoom/swap, split-ratio drag, focus dimming,
  reading-order pane focus.
- Dialogs: rename, machine add/edit, pane details/message, git,
  worktrees, theme mode tiles, settings modal.
- Global: light/dark/system theme, `prefers-reduced-motion`, shortcuts,
  toasts.

## Ordering and semantics

- Keyboard: `mod` = Meta on macOS / Ctrl elsewhere; shortcuts are
  centralized (`src/lib/shortcuts.ts`, `useShortcuts`); every
  user-visible action reachable via palette or documented shortcut.
- Focus: visible focus states, focus trap in dialogs/menus, focus
  returns to invoker on close; pane focus vs chrome focus drives
  terminal focus reports (see terminal-session known gaps).
- Motion: list add/move/remove and menu/popover transitions honor
  `prefers-reduced-motion` (instant swap).
- Density/typography come from `src/index.css` tokens — the semantic
  contract is the token *roles* (surface/fg/accent/etc.), not literal
  values; #238 asserts roles, visual review asserts fidelity.
- Window chrome: macOS hiddenInset + traffic-light positioning,
  Windows `titleBarOverlay` (WCO), both collapsing in fullscreen —
  part of the shell contract (B7 boundary, asserted here because it is
  visually shell-level).

## Errors / edge states

- Empty states (no machines, no workspaces, disconnected bridge),
  reconnecting, offline machine groups — all have defined presentations
  in `verification.md`.
- Narrow viewport: toolbar/panes remain usable (issue #79 history);
  mobile sheet behavior for sidebar.

## Negative cases

- pixel-perfect equality is NOT required — semantic equivalence is;
- no fabricated conversation/thread/tool-call data (AGENTS.md §4);
- no T3 Thread-model forcing of herdr panes;
- OS-specific chrome must degrade explicitly, not silently differ.

## Evidence today

`docs/design/verification.md` state matrix + RC checklist,
`scripts/capture-evidence.ts` + `docs/design/evidence/`,
`docs/design/rules.md` lint contract, `src/shell/*.test.ts`,
`src/lib/*.test.ts`. Scenario harness: #238.
