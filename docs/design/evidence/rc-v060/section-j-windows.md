# Section J — Windows 11 leg (device-windows), v0.6.0 RC — right-panel re-verification

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, user `basic`,
reached via WSL2 sshd on port 2222 + `powershell.exe` interop; the
port-22222 sshd remains unused). Issue #309 section J: re-verify the
plugin surfaces shipped as a docked right panel (issue #333, PR #344)
plus regressions on the final RC head.

Candidate: `932ce11d341385006a6389591a329f74a550d9d4`.
Note: the branch advanced twice during this leg — the update first
targeted `e8a2b7b` (which also installed cleanly, EXIT=0), then was
re-run against `932ce11`, which adds the terminal-core unsafe/FFI
hardening (#321, PR #341) and the post-RC delta audit docs (#342, PR
#343) on top of the panel merge (#333, PR #344) and agent-icon
manifest / goto-picker work already in `e8a2b7b`. After verification,
`origin/release-0-6-0` advanced again to `54de277` (PRs #347, #350 —
the macOS section-j evidence leg and delivery docs); `git diff
932ce11..54de277` touches **only** `docs/` evidence/markdown — zero
code changes — so the verified build is functionally identical to the
current head.

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref 932ce11d341385006a6389591a329f74a550d9d4`
(`C:\Users\rebui\src\pc-setup`).

## J-1 — update / verify / launch smoke — PASS

- `update.ps1` run via `schtasks /ru basic /it` → `cmd /c` wrapper
  (`C:\Users\rebui\ht3-j-update.cmd`, log
  `C:\Users\rebui\ht3-j\update-932ce11.log`): clone → `mise install
  --locked` (40 tools cached) → `bun install --frozen-lockfile` → vite +
  `build-desktop.ts` + `electron-builder --publish never`. Tail:
  `[herdr-t3] installed 932ce11d341385006a6389591a329f74a550d9d4
  (932ce11d341385006a6389591a329f74a550d9d4); current -> 932ce11…`,
  `EXIT=0`.
- State: `current` = `932ce11d341385006a6389591a329f74a550d9d4`,
  `previous` = `e8a2b7b728aef8eec20de894646f0ed9ec71be30` (rollback
  intact).
- `herdr-t3.exe` VersionInfo: ProductVersion `0.6.0.0`, FileVersion
  `0.6.0`; release checkout `git rev-parse HEAD` = `932ce11…`.
- `verify.ps1` static: PASS (installed line + Start Menu shortcut match).
- `verify.ps1 -Live` after `launch.ps1`: PASS —
  `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock`.
- `launch.ps1` smoke: PASS (`launched 932ce11…`, correct
  win-unpacked exe). Final relaunch was clean (no debug flags; CDP
  port confirmed closed afterwards).

## J-2 — right-panel GUI E2E on the packaged app — PASS

Method: packaged `win-unpacked\herdr-t3.exe` (932ce11) launched with
`--remote-debugging-port=9223` on the **default** herdr session via
schtasks; driven through CDP `Runtime.evaluate` / `Input.*` (driver
`C:\Users\rebui\ht3-iso\drive.ts`, extended with a `drag` command;
`cdp9223.ts` extended with `win resize` / `metrics` / `narrowtest`).
1440×900 window. All captures are `Page.captureScreenshot` of the real
packaged window; pixel check (Pillow quantize + luminance stdev): every
shot has 66–168 used colors, luminance sd 10.5–28.2 — non-blank.

Fixture: git repo `C:\Users\rebui\ht3-j\throwaway-repo` (commits, modified
`a.txt`, untracked `b.txt`, `t3.json` with script `ht3j-hello` =
`echo HT3J_SCRIPT_OK`) + herdr workspace `HT3J-Local` (`w12`, pane
`w12:p1`). Mutations confined to this repo/workspace; both cleaned up
afterwards. A second scope (`~`, `wY:p1`, cwd `C:\Users\rebui`,
non-repo) was used for error paths. Note: a parallel section-j leg on
device-mac was active during this run (visible as `ht3j-sc` /
`ht3j-norepo` panes in the remote inbox listing); nothing of theirs was
touched.

- **Dock / open** (`j-03`): header ⋯ ("Pane actions") → "Source Control"
  opened `[data-right-panel]` docked at default width 540 px — a real
  docked tab strip (`Source Control · w12:p1`), **not** a modal
  (`role=dialog` absent). Source Control rendered live plugin data:
  `master · 3 changed · 1 unstaged · 2 untracked`, repo path, Changes /
  Commit / History / Compare / Sync / PRs sections, UNSTAGED/UNTRACKED
  groups.
- **Status + diff + mutation** (`j-04`, `j-05`): row "Stage" on `a.txt`
  → status flipped to `1 staged · 2 untracked`, "staged 1 path" notice,
  `a.txt` moved under STAGED with "Unstage". Selecting the row rendered
  the inline unified diff (`-line2` / `+line2 CHANGED`). History tab
  (`j-06`) listed both fixture commits.
- **≥2 simultaneous tabs** (`j-07`…`j-13`): Projects, Project Scripts,
  Checkpoints and Worktrees were all added as tabs beside Source
  Control — up to 5 simultaneous surfaces, all staying mounted (hidden
  when inactive) per `RightPanel.tsx`.
  - **Projects** (`j-07`): "Discover repos" listed `restro-pv` +
    `throwaway-repo`, correctly skipped `C:\Users\rebui` (`not_a_repo`).
    Register on the `throwaway-repo` row → project registered
    (`registered "throwaway-repo"`, PROJECTS `throwaway-repo · 1 repo`).
    (Care was taken to scope the click to the discover row containing
    `throwaway-repo`; the section-i ancestor-match pitfall did not
    recur.)
  - **Project Scripts** (`j-08`): project `throwaway-repo` → script
    `ht3j-hello` (`t3.json`) → Run → notice "started ht3j-hello —
    success"; Runs shows `success … exit 0`. Verified on the host:
    dedicated workspace `script: ht3j-hello (throwaway-repo-2)`
    (`w13`) pane read shows `HT3J_SCRIPT_OK` +
    `__HERDR_DONE_run-…__=0`. Real `scripts run` through plugin_call.
  - **Checkpoints** (`j-09`, `j-10`): label `ht3j-gui-test` → "Capture
    checkpoint" → `checkpoint mwx59cdk-59666dfd captured`; detail shows
    ref/commit/head/kind/label + STAT (`M a.txt`, `A b.txt`,
    `A t3.json`) + CHANGED FILES.
  - **Maintenance / GC dry-run** (`j-11`, `j-12`): "Maintenance…" opens a
    nested dialog *inside* the surface (destructive-op sub-dialog, by
    design — surfaces themselves are never modal). "Preview (dry-run)"
    → `dry-run preview ok … totals: 1 evaluated · 0 would delete ·
    0 protected · 1 kept · 0 errors`; the deleted section-i fixture repo
    was honestly reported `UNREACHABLE … git not found on the host`
    (plugin-side PATH note, see observations).
  - **Worktrees** (`j-13`): lists the repo's main worktree
    (`master · open · C:/Users/rebui/ht3-j/throwaway-repo · Focus`).
- **Tab switch / reorder / close**: clicking a tab activates it
  (verified via `bg-accent` class). HTML5 drag reorder exercised with
  synthetic DragEvents + DataTransfer: `Projects` moved from index 1 to
  last — order persisted in the store. Tab close ("Close \<title\>"
  X button) removed Checkpoints and activated a neighbour.
- **Resize + persistence**: `role=separator` "Resize panel" handle —
  keyboard ArrowLeft ×2 grew 540→572 and pointer drag (CDP mouse
  press/move/release, 869→789 px) grew 572→652; both persisted to
  `localStorage["herdr-t3:right-panel-width"]`. "Hide panel" removed the
  panel from the DOM while keeping surfaces (`isOpen:false` persisted);
  reopening via header restored all tabs. Per-workspace scope verified:
  switching to `~` (`wY`) showed no panel while `w12` state stayed
  intact, and switching back restored the tabs.
- **Terminal usable while panel open**: with the panel docked, clicked
  the canvas and typed `echo HT3J_PANEL_$((6*7))_OK` + Enter through the
  real GUI terminal → `herdr pane read wY:p1` shows `HT3J_PANEL_42_OK`.
- **Entry points**: header ⋯ menu (all 5 items), panel "+" "Add panel
  surface" menu (all 5 items), and Ctrl+K command menu (`panel-git` /
  `panel-projects` / `panel-scripts` / `panel-checkpoints` /
  `panel-worktrees` items all present; "Checkpoints" activated the
  surface). No surface opens a modal dialog anymore — `role=dialog`
  absent after every surface open (the only dialogs seen are the
  checkpoints Maintenance sub-dialog and the narrow-width Sheet, both
  intentional).
- **Narrow-width sheet** (`j-19`, 800×900): `Emulation.
  setDeviceMetricsOverride` to 800 px (this build honours it — see
  observations) → the docked panel correctly switched to the
  right-side `Sheet` (`role=dialog` "Workspace panel") containing all 5
  tabs; shot is 800×900.
- **Error display, one per surface** (all on the non-repo `~` scope or
  induced fixture faults):
  - Source Control (`j-14`): `not a git repository — no git work tree
    contains: C:\Users\rebui` + `files unavailable: …`.
  - Checkpoints (`j-17`): capture on the non-repo pane → `not a git
    repository — no git work tree contains: C:\Users\rebui`.
  - Worktrees (`j-15`): `Herdr worktree actions require a path inside a
    Git work tree`.
  - Projects (`j-16`): Register repo `C:\Users\rebui` → `not a git
    repository — no git work tree contains: C:\Users\rebui`.
  - Project Scripts (`j-18`): `t3.json` temporarily corrupted →
    `scripts unavailable: invalid t3.json — …\t3.json: invalid JSON`;
    restored afterwards and the list recovered (`ht3j-hello` back).

## J-3 — regression spot checks — PASS

- **Terminal I/O round-trip** on the candidate build (932ce11, which
  includes the #321 terminal-core FFI hardening): `HT3J_PANEL_42_OK`
  arithmetic echo and `HT3J_UNI_日本語_🦀` Unicode/emoji typed through
  the packaged GUI terminal, verified byte-visible via `herdr pane
  read`. PASS.
- **Packaged terminal pixels**: all 21 screenshots are real
  `Page.captureScreenshot` captures of the packaged win-unpacked window;
  non-blank verified (colors/luminance above). Terminal areas rendered
  throughout (`j-20` shows canvas + docked panel together).
- **Agent icons** (#311/#335 manifest): sidebar agent rows render
  provider icons as inline SVG data-URI `<img>` elements — all loaded
  (`complete && naturalWidth>0` for every img; dozens present).
  Visual check via `j-00`/`j-20` captures.
- **Perf**: `scripts/perf-baseline.ts record --iterations 7` inside the
  installed release checkout → `perf-932ce11.json` /
  `baseline-932ce11d.json`: 400-tick ANSI decode+frame, seed 42,
  1,912,344 cells; totals 122–464 ms, **p50 = 146 ms, p95 = 464 ms,
  cv = 60.5%**. Caveat: one 464 ms outlier (next highest 158 ms) inflates
  p95/cv — the section-i build measured p50 105 / p95 110 / cv 6.0% on
  the same host; likely transient host load (a parallel section-j leg
  was active on device-mac, not this host, but other local work was
  running). Recorded honestly; not a clean regression signal either way.

## J-4 — remote smoke Windows app → device-mac — PASS

Through the app's own IPC (`window.herdrT3.sendFrame`, machine id
`adbd2f44617d46e9e397ea1e6e4c97b5`):

- `plugin_list` → `ok:true`, all 4 plugins on the mac host with versions
  and `plugin_root` paths under
  `/Users/rebui/.config/herdr/plugins/github-installations/…`.
- `plugin_call rebuildup.inbox list` → `ok:true`, real document:
  `state_file /Users/rebui/.local/state/herdr/plugins/rebuildup.inbox/
  state.json`, counts total 10 / inbox 10, 10 pane items incl. the
  parallel leg's `/private/tmp/ht3j-sc` panes. **Remote plugin host
  execution verified — PASS.** No bun/PATH issue encountered on this
  path (the plugins run inside the mac herdr, not via a bare bun call).

## Defects / observations

1. **Emulated resize now works**: unlike the section-i build where
   `Emulation.setDeviceMetricsOverride` left `innerWidth` at 1440,
   this build honours the override (innerWidth became 800×900 and the
   narrow Sheet engaged). Not a defect — recorded because it closes the
   section-i caveat for the panel's narrow path. Real OS window resize
   still untested headlessly (`Browser.getWindowForTarget` is not
   implemented in this Electron's CDP).
2. **Plugin-side PATH note**: the checkpoints GC dry-run reported the
   deleted `ht3-i` fixture repo as `UNREACHABLE — git not found on the
   host: git executable not found on PATH`. That is the plugin host
   environment (herdr-plugins side), surfaced correctly by the UI —
   not a herdr-t3 defect, but worth a plugin-side look if `git` should
   resolve on Windows plugin hosts.
3. **Perf outlier**: single 464 ms iteration produced cv 60.5%; see J-3.
4. **Tooling notes (not product defects)**: PS5.1 `*>` quirk avoided via
   `cmd /c` redirection; SSH-spawned children need `schtasks /ru basic
   /it` for detached launches; `drive.ts` gained a `drag` command and
   `cdp9223.ts` gained `win resize`/`metrics`/`narrowtest` helpers —
   test-driver patches only, app code untouched.
5. **Shared-state caution**: the projects registry is per-herdr-session
   and shared with the parallel section-j leg; project id
   `throwaway-repo-2` (same `ht3-j` repo path) was left untouched —
   only my `throwaway-repo` registration was archived.

## Final machine state

- `current` = `932ce11d341385006a6389591a329f74a550d9d4`,
  `previous` = `e8a2b7b…` (rollback intact)
- App running clean via `launch.ps1` (no debug port — CDP 9223
  confirmed closed) on the default herdr session;
  `verify.ps1 -Live` PASS
- 4 plugins installed+enabled on the Windows default session, untouched
  (see `plugin-list.txt`); mac-side plugins untouched (read-only calls)
- Default herdr session workspaces back to `restro-pv` + `~` only;
  `HT3J-Local` (w12) and `script: ht3j-hello` (w13) closed
- Throwaway repo `C:\Users\rebui\ht3-j\throwaway-repo` deleted; test
  checkpoint `mwx59cdk-59666dfd` deleted via the surface; project
  `throwaway-repo` archived; `t3.json` restored before repo deletion;
  right-panel localStorage cleared (`{}`) and app reloaded
- schtasks tasks `HT3J-Update`, `HT3J-Debug`, `HT3J-Perf` left
  registered (harmless one-shot tasks)

## Evidence files

- `section-j-webp/section-j-win-00-initial.webp` …
  `section-j-win-20-w12-panel.webp` — 21 CDP screenshots
  (1440×900 except `j-19`/`section-j-win-19-narrow-sheet` at 800×900
  narrow override), non-blank verified; in-text `j-NN` references map
  to these files in order
- `section-j-perf-win-932ce11.json` — perf baseline report (copy of
  `perf-reports/baseline-932ce11d.json` in the release checkout)
- `section-j-plugin-list-win.txt` — `herdr plugin list --json` output
- `js/` — CDP eval snippets used for the GUI drive
- On-machine originals: `C:\Users\rebui\ht3-j\` (screenshots, logs,
  helper scripts), drivers under `C:\Users\rebui\ht3-iso\`
