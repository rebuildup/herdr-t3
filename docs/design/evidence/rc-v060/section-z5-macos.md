# RC v0.6.0 — Section Z5: macOS leg at 8dde621 (post-#499/#504)

Date: 2026-11-28 (JST). Host: MacBook Pro Apple M5, macOS arm64,
Electron packaged build of `origin/release-0-6-0`.

Candidate: **`8dde6219d43aa7638ee6488bb6069f3377e2deea`** — release head
after the #499 memory-bound fixes (#501 image-cache LRU + process
budget, #504 queue/advanceCache bounds).

Install: `components/herdr-t3/update.sh 8dde621…` → staged
`~/Applications/herdr-t3.app`, launched with
`HERDR_SOCKET=~/.config/herdr/sessions/ht3z5rc/herdr.sock
--remote-debugging-port=9223` against dedicated isolated herdr session
`ht3z5rc` (workspaces `w1`/`w2`, repo worktree `herdr-t3-rc060`).
Plugin pins resolved via
`~/.config/herdr/plugins/github-installations` checkouts — all 14 at
contract pins (`section-z5-plugin-list.txt`).

Screenshots: `section-z5-webp/` (cwebp q82; raw png in `/tmp/z5-shots/`).
Independent multimodal review: codex gpt-6.2-sol, two batches
(surfaces/defects, then [verify] items).

## Z5-1 — #480 fixed-surface re-verification: PASS (one residual)

- **D1 sheet identity / disabled Search**: PASS (prior batch).
- **Artifacts toolbar (A2)**: PASS — `z5-surface-artifacts.webp`. Refresh
  fits, intro wraps, Kind/Creator labeled, pane hint fits, From/To date
  labels present. Minor residual: standalone search placeholder clips to
  "Search artifact metadat".
- **Usage no-data (A4)**: PASS — `z5-surface-usage.webp`,
  `z5-usage-detail.webp`. Honest no-data state, no fabricated 0 totals or
  green badges; quota shows "used". Residual: Codex Session reset time
  differs between Quota (22:0x:xx) and Divergence (21:55:21) sections —
  likely two different window semantics, worth a docs/label pass.
- **MCP (V11)**: PASS — single read-only badge per row, one scrollbar.
  Tab strip clips "Controls" label at right edge (minor).
- **Conversations**: PASS — disabled Search neutral fill (was blue).
- **Handoffs**: UNCERTAIN — Execute/Delegate buttons not visible in list
  view; emphasis unverifiable from captures.
- **Projects**: PASS — repo path is widest field (~334 px).
- **Settings modal**: **FAIL (residual)** — General modal still ~1152×820
  px with mostly empty content below two settings. #480 narrowed max
  width but the empty area persists; fix insufficient or needs section
  density. New defect candidate for rc-fix triage.
- **Checkpoints narrow layout**: PASS — Diff A/B selectors reachable
  after scrolling (`z5-narrow960-checkpoints-bottom2.webp`, captured with
  context card closed).
- **Pane context card (D5)**: **FAIL — probable #480 regression**.
  `PaneContextCard.tsx` `rightInset` only applies in *inline* placement;
  at 960 px the card renders as a floating popover near top-right
  (~x580–900, ~483 px tall) overlapping the right-panel sheet
  (`z5-narrow960-contextcard2.webp`, `z5-narrow960-sheet-checkpoints.webp`).
  Needs rc-fix: extend inset to popover placement or suppress popover
  while a sheet is open.

## Z5-2 — [verify] items re-evaluation

- **V7 cursor position**: UNCERTAIN→likely artifact. Cursor sits at
  prompt end in `z5-cursor-ws-switch.webp`; return capture showed blank
  pane (see V8). Two-row offset not reproduced.
- **V8 blank Done pane**: **FAIL→transient**. `z5-cursor-ws-back.webp`
  showed w1:p1 blank except cursor after workspace switch-back with no
  empty-state label. Re-check (`z5-blank-check*.png`, `pane read`)
  confirmed content intact — pane re-attaches and scrollback restores;
  the blank is a capture-timing artifact of re-attach, not data loss.
  Residual UX nit: no "reattaching" indicator during the gap.
- **V9 paste font scale**: PASS — `z5-pre-paste.webp` vs
  `z5-post-paste.webp`: identical glyph size/spacing; pasted
  `PASTED-TEXT-12345` reached pane at same scale.
- **Artifacts register/delete roundtrip**: verified earlier this leg
  (`z5-03-artifacts-registered.webp`, `z5-04-artifacts-after-delete.webp`,
  `z5-05-artifacts-empty.webp`) — register → listed → delete → empty
  state all correct.

## Z5-3 — light theme

`z5-light-main.webp`, `z5-light-usage.webp`: layout fine, but secondary
text (Usage coverage, quota-window duration) measures ~2.7:1 contrast —
**FAIL** for light-theme legibility. Distinct from #6 (terminal ANSI
palette); this is UI secondary-text color. New defect candidate.

## Z5-4 — packaged-build memory (carried from #499 verification)

Real packaged app @8dde621, isolated session `ht3rc8`, CDP probes:
- RSS flat 363–458 MB over ~14 rounds incl. kitty-image storm + input
  flood (4 processes; JS heap ~17–18 MB).
- `HERDR_T3_MEMORY_LIMIT_MB=400` → `memory.budgetExceeded` +
  `memory.reload` in diag log; renderer reloaded, status recovered.
- Attach-stall queue bound: herdr `kill -STOP` + 700× input →
  `terminal_closed`/`attach_overrun` shown; after `CONT` typed marker
  text appeared in pane (input preserved).
- Full evidence: https://github.com/rebuildup/herdr-t3/issues/499#issuecomment-7212828738

## Z5-5 — open items for rc-fix triage

1. **D5 popover-over-sheet overlap** (likely #480 regression) — release
   blocker candidate.
2. **Settings modal oversized empty area** — residual from #480.
3. **Light-theme secondary text ~2.7:1 contrast** — new defect.
4. Minor: artifacts search placeholder clip; MCP/Conversations/Handoffs
   tab-strip edge clipping; Usage Codex reset-time label ambiguity;
   transient blank pane on re-attach lacks indicator.
