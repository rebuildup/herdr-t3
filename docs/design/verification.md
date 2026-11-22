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
| Sidebar | empty, populated, workspace selected/hover, context menu open |
| Tab strip | single tab, multiple tabs, active/inactive, hover close, context menu |
| Pane grid | single pane, split panes, focused/unfocused border, zoomed |
| Terminal | idle shell, running agent, blocked prompt, scrollback |
| Global | light, dark (`html.dark`), connecting, reconnecting, offline, error |

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
