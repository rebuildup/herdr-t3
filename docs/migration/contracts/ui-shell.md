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
  SVG → generic glyph) at a 20px slot with the brand art at 12px,
  plus a perimeter status ring carrying `agent_status` and, where the
  state asks for attention, a marker — a centered overlay disc for
  blocked, corner badges for done/unknown (issue #550). Ring grammar: working = rotating primary
  arc around the *static* brand mark (started/stopped only by the
  shared visibility control — on-screen + document visible + motion
  allowed; static full ring under reduced-motion), blocked =
  destructive ring at a heavier stroke + centered red "!" disc that
  covers the brand mark, done = success ring + small success check
  badge on the bottom-right corner, idle = quiet solid muted ring with
  no marker, unknown/unrecognized = dashed muted ring + small muted
  "?" badge on the bottom-right corner. Motion grammar: every marker
  enters with an overshoot pop and exits with a quick fade+shrink;
  blocked's "!" disc then runs a periodic attention shake while its
  ring breathes, done/unknown badges keep a soft pulse, and hovering
  the glyph or its row lifts the glyph and swells the ring stroke —
  all collapsed to instant under reduced-motion. Every agent
  work-status indicator — sidebar agent rows, workspace rows, tab
  pills, goto pane rows, hover/context card rows, status badges —
  renders this one component; `sm` (16px) is the same grammar at
  dense-chrome density and `lg` (24px) is the promo density for
  notification toasts, never a bare icon-glyph substitute. State
  name is never
  printed on the row; it lives
  in the shelf, hover card and accessible name. GPUI must reproduce
  the same asset resolution, state→ring+overlay mapping and 20px footprint —
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

- Canvas session states are a defined contract (issue #421,
  `docs/design/info-architecture.md` §10): loading/connecting are a
  single restrained status line; probe-only snapshots are never rendered
  as live panes; machine down/disabled/fetch-error/genuine-empty
  (`workspaces: []`, reachable because herdr keeps the session after
  its last workspace closes) each get a distinct `Empty*` presentation
  with a recovery action. GPUI must reproduce the same state→display
  mapping, including "no 'No workspaces' during loading" and "stale is
  never live".
- Other empty states (no machines, no workspaces in sidebar,
  disconnected bridge), reconnecting, offline machine groups — all have
  defined presentations in `verification.md`.
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
