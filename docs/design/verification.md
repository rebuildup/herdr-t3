# T3 design fidelity verification (Issue #4)

T3 Code (`t3code` @ `9cc4018c75ff4c61be8e86a6391d49a6c2d79830`, see
`docs/upstream.md`) is the design source of truth. Fidelity is verified at
two levels; screenshots alone are not sufficient.

## 1. Component / token comparison

For every UI surface, compare against the pinned T3 implementation:

- primitives: `src/components/ui/` vs `t3code/apps/web/src/components/ui/`
- tokens: `src/index.css` custom properties vs T3's theme tokens
- layout/density: sidebar width, row padding, tab strip height, pane chrome

Record each comparison in the ticket PR or `docs/design/evidence/` notes:
what matches, what deviates, and why (herdr-t3 is a terminal multiplexer,
not a thread UI — deliberate deviations must be justified, not accidental).

## 2. State-by-state screen comparison

Capture real screens from an **isolated herdr test session only** (never
the maintainer's live session). Required states:

| Surface | States |
| --- | --- |
| Sidebar | empty, populated, workspace selected/hover, context menu open, drag-reorder indicator, offline machine group |
| Tab strip | single tab, multiple tabs, active/inactive, hover close, context menu, per-tab agent status, drag-reorder indicator, overflow scroll |
| Pane grid | single pane, split panes, focused/unfocused (dimmed unfocused per `interaction.md`), zoomed, split-ratio drag, pane drag/swap affordance |
| Pane chrome | agent kind + status indicator, title fallback chain, details/diagnostics access |
| Status/utility area | bridge connecting/reconnecting, attention aggregate (blocked count), transient notice |
| Terminal | idle shell, running agent, blocked prompt, scrollback, background image (fit/position/opacity variants), IME composition |
| Global | light, dark (`html.dark`), connecting, reconnecting, offline, error, `prefers-reduced-motion` |

v0.4.0 additions (issues #107–#115): every new interactive surface added by
the program must appear here before its ticket merges; drag states and
status badges are required captures, not optional.

v0.5.0 additions (issues #149–#155):

| Surface | Additional required states |
| --- | --- |
| Terminal input | IME composition in progress (composition text visible at cursor, candidate window anchored), committed/cancelled composition, focus-report-enabled app focus transitions, mouse-capture app click/drag/scroll/hover, Shift+drag selection inside a mouse-capture app, scrollback wheel vs app wheel |
| Agents section | each status section (Attention/Working/Done collapsed/Idle), two-line row content, section transitions on status change, context menu open |
| Tab strip | hover close affordance on unselected tab, context menu open, selected/hover/focus-visible distinction, direct split/zoom icons |
| Workspace rows | two-line hierarchy (title + branch/meta), narrow sheet width |
| Global | motion enabled vs `prefers-reduced-motion` for list add/move/remove and menu/popover transitions |

Contract-level coverage (issue #155) is separate from captures: IME
composition lifecycle, focus in/out reports, mouse-mode event sequences
and selection-vs-report branching are verified by deterministic tests
defined in `terminal-io.md` §7 — a screenshot cannot prove them.

Procedure:

```bash
# isolated herdr session (see server tests for HERDR_* isolation vars)
herdr --session ht3verify ...
HERDR_SOCKET=~/.config/herdr/sessions/ht3verify/herdr.sock PORT=<port> bun run server
bun run build
# drive http://127.0.0.1:<port>/ with Playwright; save PNGs under
# docs/design/evidence/<ticket>/ and note the herdr-t3 SHA + t3code SHA
```

Compare each capture side-by-side with the equivalent T3 screen (or the
T3 component in isolation) and record the verdict per state.

## Evidence

`docs/design/evidence/` holds baseline captures. `baseline-*.png` is the
current scaffold-era layout (sidebar + tab strip + pane grid, dark/light)
captured against the isolated `ht3probe` session at the time of writing —
it is a starting point for diff review, not a fidelity claim.

### Capture and review pipeline (issue #69)

- `bun scripts/capture-evidence.ts <outDir> [baseUrl]` drives headless
  Chrome over CDP against the dev build and an isolated herdr session.
  Every state is asserted before the PNG is saved: DOM checks for sidebar
  collapse, palette, context menus, themes and the mobile sheet; session
  facts (`/api/session` layout `zoomed`, pane counts) for split/zoom.
- `python3 scripts/build-evidence-sheets.py docs/design/evidence/<ticket>`
  converts raw PNG captures to committed WebP (q88) originals, builds
  labeled contact sheets, side-by-side herdr-t3 vs T3 Code comparisons at
  matched viewport/theme, and detail crops. Raw PNGs are gitignored local
  artifacts; `manifest.json` records dimensions and byte sizes.
- T3 Code reference captures come from the pinned checkout's dev server
  on an isolated `--home-dir` seeded by `vp run migrate-dev-db`, paired
  with a one-time token.
- Multimodal review: `codex exec --sandbox read-only -i <image> -` with a
  review prompt (see issue #69 for the prompt text) evaluates layout,
  spacing, density, hierarchy and affordances against the T3 reference.
  A separate pass checks full-resolution captures for sensitive strings
  before publishing.
