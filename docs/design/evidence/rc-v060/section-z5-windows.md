# RC v0.6.0 — Section Z5: Windows leg at 8dde621 (post-#499/#504)

Date: 2026-11-28 (JST). Host: device-windows (Windows 11, user `rebui`),
herdr 0.9.5, bun 1.4.5, Electron packaged build.

Candidate: **`8dde6219d43aa7638ee6488bb6069f3377e2deea`** — same code as
the macOS z5 leg; current release head `1d9eaf8` adds only z5-macOS
evidence docs (no code delta).

Install: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref 8dde621…` run directly over ssh (mise → bun install → vite +
`build-desktop.ts` + `electron-builder --publish never`). Result:
`current` → `8dde621…`, `current_app` →
`%LOCALAPPDATA%\herdr-t3\releases\8dde621…\release\win-unpacked\herdr-t3.exe`,
`previous` retained for rollback. Launched via `schtasks /it`
(`HT3Z5-Debug` → `debug-launch.cmd` → `relaunch-debug.ps1`, z4 pattern)
with `--remote-debugging-port=9223` against the default herdr session —
ssh-launched instances are reaped with the session (z4 finding,
re-confirmed by convention).

Plugin pins: `herdr plugin list` on device — all 14 plugins at contract
pins identical to macOS, incl. machines/v1 @ `08f96a4` (an older
`d23205af` checkout dir exists but is inactive).

Screenshots: `section-z5-windows-webp/` (ffmpeg libwebp q82 on-device;
raw png + CDP drivers under `C:\Users\rebui\ht3-z4\` on device).
Independent multimodal review: codex on-device, two batches
(`z5-review1.log` 18 surfaces, `z5-review2.log` narrow/verify items).

## Z5-1 — surface sweep (15 right-panel surfaces): mostly PASS

| Surface | Verdict | Note |
|---|---|---|
| Source Control | **FAIL (new)** | Same non-Git error + path rendered twice, above and below the tab strip |
| Projects | PASS | Repo path ~2× optional field widths |
| Project Scripts | **FAIL (new)** | Empty state asks to select a project while also reporting none registered — contradictory |
| Checkpoints | PASS | Capture forms + history filters fit; Maintenance footer separate |
| Worktrees | **FAIL (new)** | Branch/Label collapse to ~24 px; Branch/Base labels run together |
| Automations | PASS | Honest empty state |
| Conversations | PASS | Disabled Search neutral fill (#480/V11 resolved) |
| Usage | PASS | Honest no-data, "used" labels, From aligned (A4 resolved) |
| Artifacts | PASS | Toolbar fits, labeled dropdowns, From/To dates (A2 resolved) |
| Handoffs | UNCERTAIN | Execute/Delegate not visible in list view (same as macOS) |
| Controls | PASS | Empty agent state + Start agent visible |
| Text Generation | **FAIL (new)** | Task descriptions truncated mid-phrase (Thread Title, Commit Message, PR Content) |
| Secrets | PASS | Provider status + Preview resolve fit |
| Machines | PASS | Reachability labels, Probe actions, wrapping plugin list |
| MCP | PASS | Single read-only badge per row, one scrollbar (V11 resolved) |

## Z5-2 — #480 fixed surfaces on Windows

- Artifacts toolbar, Usage no-data, Conversations Search, MCP badges,
  Projects widths: all PASS — the #417/#480 fixes hold on Windows.
- **Settings modal: FAIL (cross-platform residual)** — General tab still
  ~570 px empty below two settings in the 820 px modal; same as macOS.
- **Handoffs Execute/Delegate emphasis: UNCERTAIN** on both OS (detail
  view never opened in captures).

## Z5-3 — [verify] items

- **V7 cursor at prompt end: PASS** (`z5-00-main`, `z5-narrow960-main`).
- **V9 type/paste scale: PASS** — pixel diff confined to typed region.
- Possible redraw artifact in `z5-post-type`: cursor shown on an upper
  prompt row while typed continuation appeared lower — single frame,
  persistence unverified; flagged for follow-up, not confirmed defect.
- Workspace-switch blank-pane (V8 macOS finding) not re-tested on
  Windows this leg.

## Z5-4 — narrow layouts (CDP device-metrics emulation)

- 960×900: right panel renders as overlay sheet; **D5 context card
  PASS at captured geometry** — popover right edge x=1059 vs panel
  divider x=1080 (20 px clearance). Note: this differs from the macOS
  popover-overlap finding; Windows capture shows clearance, macOS
  capture showed overlap — treat D5 as platform/layout-dependent and
  keep the macOS FAIL standing.
- Tab labels clip at strip edge in narrow mode (`…jects`) — cosmetic,
  consistent with macOS minor findings.
- 560×900 emulation: **UNCERTAIN** — capture remains 1440×900 surface;
  reflow at true minimum width not visually confirmed (MoveWindow
  resize did not take effect over ssh session; z4 had same constraint).

## Z5-5 — light theme: FAIL (cross-platform)

`z5-light-main`, `z5-light-usage`: secondary text (MCP socket guidance,
tool descriptions, quota timestamp, coverage line) measures ~2.73:1
contrast — same defect class as macOS (~2.7:1). Confirmed on both OS.

## Z5-6 — open items for rc-fix triage (Windows-new marked *)

1. D5 popover-over-sheet overlap — macOS FAIL stands; Windows capture
   showed clearance (verify with real window resize later).
2. Settings modal oversized empty area — both OS.
3. Light-theme secondary text ~2.7:1 — both OS.
4. *Source Control duplicated error+path above/below tab strip.
5. *Text Generation truncated task descriptions.
6. *Project Scripts contradictory empty state.
7. *Worktrees collapsed Branch/Label fields.
8. Minor: narrow tab-label clipping; handoffs emphasis unverifiable;
   possible post-type cursor redraw artifact.
