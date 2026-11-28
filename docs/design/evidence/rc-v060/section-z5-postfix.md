# RC v0.6.0 — Section Z5 post-fix verification at eb59868 (both OS)

Date: 2026-11-27 (JST). Follow-up to `section-z5-macos.md` /
`section-z5-windows.md`: the 7 confirmed z5 defects were fixed via
PR #511 (6744fac) plus the textgen unwrap follow-up PR #520 (eb59868),
which is the current `release-0-6-0` head together with #513
(#499 adaptive watchdog — non-visual delta).

Candidates verified:

- **6744fac** — full 8-item defect sweep, packaged builds, both OS
- **eb59868** — release head; textgen re-verification + spot checks
  (settings, light usage, 960px context card) on both OS. #513 touches
  only desktop/main memory watchdog, memoryBudget and scrollback byte
  caps — no renderer/surface code — so the 6744fac surface evidence
  carries over.

Install: `components/herdr-t3/install.sh|update.ps1 -Ref <sha>` on both
devices; `current`/`current_app` now point at `eb59868…` on macOS
(`~/Applications/herdr-t3.app`) and Windows
(`%LOCALAPPDATA%\herdr-t3\releases\eb59868…\win-unpacked`). macOS ran
against isolated herdr session `ht3z5rc`; Windows against the default
session (dedicated device, same convention as the z5 Windows leg).

Screenshots: `section-z5-postfix-webp/{macos,windows}/` (raw PNGs in
`/tmp/z5fix-shots`, `/tmp/z5fix-win`). Independent multimodal review:
codex gpt-6.2-sol, one batch per OS per candidate.

## Fix verification results

| # | Defect | macOS 6744fac | Windows 6744fac | eb59868 re-check |
|---|--------|---------------|-----------------|------------------|
| 1 | Settings modal empty area | PASS (~295pt, both themes) | PASS | PASS (light) |
| 2 | Light-theme secondary contrast | PASS (~5.5:1 sampled) | PASS | PASS |
| 3+4 | Context card vs right panel @960px | PASS (card ends ~80px before panel) | PASS (~21px gap, real 964px window) | PASS both OS |
| 5 | GitSurface duplicate repo_error | PASS (single error above tabs) | PASS | n/a (unchanged) |
| 6 | TextGenSurface truncated descriptions | PASS at 6744fac; **FAIL follow-up** — 2-line clamp still ellipsized `review_guide` at narrow width (Windows) | FAIL → fixed by #520 | **PASS both OS** — descriptions wrap fully (`review_guide` 3 lines, no ellipsis) |
| 7 | ProjectScriptsSurface contradictory empty state | PASS | PASS | n/a |
| 8 | WorktreesSurface collapsed Branch/Label inputs | PASS | PASS | n/a |

## Residual observations (non-blocking nits, recorded not fixed)

- TextGen `input fields:` metadata row still single-line `truncate`
  (`pr_content` ends `instru…`) — compact metadata row, pre-existing
  pattern, full field list is contract-stable.
- Context card shows a double outline / mismatched radii and slightly
  larger action icons — pre-existing card chrome, unrelated to the
  popover-anchor fix.
- Project Scripts renders "no projects registered" once per pane
  column — consistent per-pane empty state, not a contradiction.
- Transient "Agent finished" toasts can overlap lower surface content
  in captures; toast auto-dismisses.
- Windows capture environment note: `Emulation.setDeviceMetricsOverride`
  does not affect the packaged Windows window; narrow-width evidence
  used real `MoveWindow` resize via scheduled task (window height
  clamped by the OS to a degenerate value — width was correct at
  964 CSS px, `max-width:1024px` matched).

## #499 memory state at eb59868

#513 (merged by parallel session) adds the adaptive watchdog +
aggregate renderer budget + 64 MiB scrollback byte cap on top of #501's
image-cache LRU and #504's queue bounds. `bridge-status.json` on the
macOS verification instance reported `memory.totalMb ≈ 286` across
Browser/GPU/Utility/Tab at idle — the telemetry channel is live.
Long-run soak acceptance remains the #499 RC-leg item.
