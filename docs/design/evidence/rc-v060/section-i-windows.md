# Section I — Windows 11 leg (device-windows), v0.6.0 RC final candidate

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, user `basic`,
reached via WSL2 sshd on port 2222 + `powershell.exe` interop; the
port-22222 sshd remains broken — not used). Issue #309 sections I-1..I-6,
Windows leg.

Candidate: `0e3c14eba55bf9a827f617cc78882bc524e69e1a`
(`sync-main-into-302` head, pending PR #308 merge; merge commit will have
an identical tree). Includes shipped refactor `afb7e0c` (surfaceCore
extraction) not present in the section-h build `7c562c9`.

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref 0e3c14eba55bf9a827f617cc78882bc524e69e1a` (checkout
`C:\Users\rebui\src\pc-setup`).

## Install / update (I-6 packaging smoke)

- First `update.ps1` attempt died silently: launched via `Start-Process`
  from an SSH-spawned shell — the WSL sshd kills the process tree when the
  session ends (known constraint). Relaunched via `schtasks` (`/ru basic
  /it`), which survives.
- Second attempt also died in seconds: the wrapper used PS `*>`
  redirection; PS 5.1 + `$ErrorActionPreference=Stop` inside
  `install.ps1` turns native-command stderr (mise/bun progress) into a
  fatal `NativeCommandError` — the documented quirk from section-d.
  Re-ran through `cmd /c "… > log 2>&1"` (`C:\Users\rebui\ht3-i-update2.cmd`)
  → full success.
- Log tail (`C:\Users\rebui\ht3-i\update-0e3c14e-2.log`):
  `[herdr-t3] installed 0e3c14eba55bf9a827f617cc78882bc524e69e1a
  (0e3c14eba55bf9a827f617cc78882bc524e69e1a); current -> 0e3c14e…`
  `EXIT=0`. Build: clone → `mise install --locked` (40 tools, cached) →
  `bun install --frozen-lockfile` (327 pkgs) → vite + `build-desktop.ts`
  + `electron-builder --publish never` (win-unpacked + NSIS).

## State files / verify (I-6)

- `current` = `0e3c14eba55bf9a827f617cc78882bc524e69e1a`
- `previous` = `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d` (rollback path intact)
- `current_app` = `…\releases\0e3c14e…\release\win-unpacked\herdr-t3.exe`
- `git rev-parse HEAD` in release dir = `0e3c14eba55bf9a827f617cc78882bc524e69e1a`
- `herdr-t3.exe` VersionInfo: ProductVersion `0.6.0.0`, FileVersion `0.6.0`
- `verify.ps1` static: PASS (installed line + Start Menu shortcut match)
- `verify.ps1 -Live` (final, clean launch): PASS —
  `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock`;
  `bridge-status.json` = `{"ok":true,"detail":"2 panes, 2 workspaces"}`
- `launch.ps1`: used for the final relaunch (`launched 0e3c14e…`,
  correct exe path, no debug flags). App left running on the **default**
  herdr session.

## I-1 — real plugin install on Windows default session — PASS

`herdr plugin list` before: "No plugins installed." Installed for real
into the default session registry via `herdr plugin install
<owner/repo/subdir> --ref <full-sha> -y` (all four resolved subdir names
confirmed against the herdr-plugins repo tree):

| plugin | subdir | pinned SHA | installed version |
| --- | --- | --- | --- |
| inbox | `plugins/inbox` | `414e87dea9faa5c221fb27508e5828f086849836` | 0.1.0 |
| git | `plugins/git` | `d0578307a856e53af210775f9cb95c9f593d6f87` | 0.2.0 |
| projects | `plugins/projects` | `2dcb2abfa57b0adcf5d1109f76087e19b3dfae07` | 0.3.0 |
| checkpoints | `plugins/checkpoints` | `ae4f214c523d05128354a8c4ba493b62cd8e843f` | 0.4.0 |

`--ref` accepted full SHAs directly (no release-branch fallback needed).
Final `herdr plugin list`: **4 plugins installed, all enabled** —
left installed (see `section-i-plugin-list.txt`).

## I-2 — GUI E2E on the packaged app (default session, CDP-driven) — PASS

Method: packaged `win-unpacked\herdr-t3.exe` launched with
`--remote-debugging-port=9223` on the **default** herdr session (stable
profile, no `HERDR_T3_PROFILE`/`HERDR_SOCKET` overrides) via schtasks;
driven through CDP `Runtime.evaluate`/`Input.*` (driver:
`C:\Users\rebui\ht3-iso\drive.ts`). All plugin surfaces below are the
real dialogs, exercised against the real installed plugins — not raw
frames.

Throwaway fixture: git repo `C:\Users\rebui\ht3-i\throwaway-repo`
(1 commit, modified `a.txt`, untracked `b.txt`, `t3.json` with one
script) + herdr workspace `ht3i-local` (`wZ:p1`) on the default session.
Mutations confined to this repo; workspace closed and repo deleted
afterwards.

- **Source Control dialog** (`section-i-02`–`04` webp captures): opened via workspace header
  ⋯ → "Source Control…". Showed `master · 2 changed · 1 unstaged ·
  1 untracked`, repo path, inline unified diff
  (`-line2`/`+line2 CHANGED`), History tab listing `84d59d9 init`.
  **Mutation**: clicked the row "Stage" on `a.txt` → status flipped to
  `1 staged · 1 untracked`, `a.txt` moved to the STAGED group with
  "staged 1 path" notice (`03`). PASS.
- **Projects dialog** (`05`–`06`): "Project registry on local via the
  host's projects plugin". "Discover repos" listed
  `restro-pv` + `throwaway-repo` (and correctly skipped
  `C:\Users\rebui` as `not_a_repo`). Registered
  `throwaway-repo` → project `HT3I-Local` appears in PROJECTS.
  **Defect-adjacent note (operator error, recorded honestly)**: my first
  automated "Register" click matched the wrong row's button (ancestor
  text-match walked up to the dialog root) and registered the user's
  real `restro-pv` repo. Undone via plugin CLI `archive restro-pv`
  (the contract has no delete); `throwaway-repo` was then registered
  correctly via CLI. Registry left with both entries `archived:true`.
- **Project Scripts dialog** (`07`): project `HT3I-Local` → script
  `ht3i-hello` (`t3.json`, `echo HT3I_SCRIPT_OK`) → Run → notice
  "started ht3i-hello — success", Runs list shows `success … exit 0`.
  The run created a dedicated `script: ht3i-hello (throwaway-repo)`
  workspace (closed afterwards). PASS — real `scripts run` through
  plugin_call.
- **Checkpoints dialog** (`08`–`09`): "Capture checkpoint" with label
  `ht3i-gui-test` on pane target → `checkpoint mwx12onl-6bc4240e
  captured`; list + detail showed ref/commit/head/kind/label and full
  STAT + CHANGED FILES (`M a.txt`, `A b.txt`, `A t3.json`).
  Maintenance… → "Preview (dry-run)" → `ok … 1 evaluated · 0 would
  delete · 1 kept` (gc dry-run display; destructive Run gc not
  exercised). PASS.
- **Inbox organize settle/snooze** (`10`–`11`): right-click context menu
  on agent-shelf entries → "Settle" moved `p1225-ae · Mac` Idle→Settled
  (Settled 1→2); "Snooze → 1 hour" moved `p1225-flashbeat · Mac`
  Idle→Snoozed with `until` timestamp (Snoozed 1→2, Idle 4→3). Both are
  **remote (device-mac) agents** — so these GUI actions also exercised
  machine-tagged `plugin_call` to the remote inbox plugin over SSH.
  Both restored afterwards via the same menu ("Restore"); final shelf
  baseline Idle4/Snoozed1/Settled1 — identical to pre-test counts.
- **Error display** (`12`): Source Control on the non-repo `~`
  workspace (`wY:p1`, `C:\Users\rebui`) → "not a git repository — no
  git work tree contains: C:\Users\rebui" + "history unavailable:
  not a git repository …". PASS.

## I-3 — remote ops Windows app → device-mac — PASS

- Created labeled workspace `HT3I-WIN` on the **remote mac** herdr via
  `herdr --machine Mac workspace create --cwd /tmp/ht3i-remote
  --label HT3I-WIN` → `wM9`, pane `wM9:p1` (cwd `/private/tmp/ht3i-remote`).
- In the app sidebar the `Mac` machine group listed `HT3I-WIN`; clicking
  it attached the remote pane (`section-i-13` webp). Typed
  `echo HT3I_REMOTE_$((6*7))` + Enter through the real GUI terminal via
  CDP → verified on the mac with `herdr pane read wM9:p1`:
  `HT3I_REMOTE_42`. **Real remote input round-trip — PASS** (closes the
  section-d "display-only" gap).
- Machine-tagged plugin boundary through the app's own IPC
  (`window.herdrT3.sendFrame`, machine id
  `adbd2f44617d46e9e397ea1e6e4c97b5`):
  - `plugin_list` → all 4 plugins on the mac host with versions and
    plugin_root paths under `/Users/rebui/.config/herdr/plugins/…`.
  - `plugin_call rebuildup.inbox list` → real document from the mac
    plugin state (`state_file
    /Users/rebui/.local/state/herdr/plugins/rebuildup.inbox/state.json`,
    17 items incl. organized entries). **Remote plugin host execution
    verified — PASS.**
- Cleanup: `herdr workspace close wM9` on the mac; `/tmp/ht3i-remote`
  removed. Parallel agent's `HT3I-*`/`p1225-*` workspaces untouched
  (only organize state settle/snooze/restore was exercised on two idle
  `p1225-*` agents and fully reverted).

## I-4 — packaged-app terminal pixels — PASS

Screenshots are `Page.captureScreenshot` of the real packaged window
(1440×900). Pixel check (Pillow, quantize 256 + luminance stats): every
capture has 213–256 used colors and luminance stdev 7–27 — non-blank.
Terminal-area captures: `13-remote-ht3i-win` / `14-remote-typed`
(remote pane before/after input — bytes differ, typed command visible),
`15-local-io` (`HT3I_42_OK` + `HT3I_UNI_日本語_🦀` on local pane),
`16-scrollback` / `19-px-scrollback` (after `1..60`/`1..80` output).
The ghostty canvas renderer (surfaceCore path `afb7e0c`) renders real
pixels in the packaged win-unpacked build.

## I-5 — perf on Windows — PASS (measured, first Windows data point)

`scripts/perf-baseline.ts record --iterations 7` inside the installed
release checkout (`bun 1.4.4`, i7-13700H, 32 GB, win32/x64):

- `perf-win-0e3c14e.json` (→ `section-i-perf-win-0e3c14e.json`):
  400-tick ANSI streaming decode+frame workload, seed 42,
  1,912,344 cells decoded; totals 95–110 ms,
  **p50 = 105 ms, p95 = 110 ms, cv = 6.0%**.
- Same workload on macOS M5 baseline (`perf-macos-7c562c9.json`):
  p50 = 3011 ms — different machine class, recorded for reference only,
  not a regression comparison.

## I-6 — shipped delta terminal verification — PASS (with one caveat)

- Local packaged terminal I/O on the candidate build (default session,
  throwaway pane `wZ:p1`/`w11:p1`): typed
  `echo HT3I_$((6*7))_OK` → pane read `HT3I_42_OK`; typed
  `echo HT3I_UNI_日本語_🦀` → pane read `HT3I_UNI_日本語_🦀`
  byte-identical (`section-i-15` webp). Unicode/emoji round-trip PASS.
- Scrollback: `1..60`/`1..80` rendered (`section-i-16`, `section-i-19` webp).
- **Emulated resize caveat**: `Emulation.setDeviceMetricsOverride`
  (900×600) returned success but `innerWidth` stayed 1440×900 and all
  screenshots were byte-identical (`16`=`17`=`18`, `19`=`20`=`21`;
  md5-verified). On section-h build `7c562c9` the same call re-laid-out
  the canvas. Could not confirm product defect vs CDP/environment
  (window occlusion/minimized state suppresses emulation?) — flagged as
  an observation for a human pass, same class as section-h's
  wheel-scroll gap. Real OS resize untested headlessly.
- Packaged install smoke: update.ps1 → verify.ps1 -Live → launch.ps1
  all exercised on the candidate (above). VersionInfo 0.6.0.0/0.6.0,
  commit stamp `0e3c14e` in release checkout and app bundle path.

## Defects / observations

1. **Accidental project registration (operator error, mitigated)**:
   automated GUI click registered the user's real `restro-pv` repo into
   the projects plugin before I caught it; archived via plugin CLI
   (`archive` is the only removal the contract offers — no delete).
   Registry now holds `restro-pv` and `throwaway-repo`, both
   `archived:true`. Documented for transparency; not a product defect.
2. **Emulated-resize no-op** (above) — observation, needs human check.
3. **Orphaned process from a previous leg**: `bun cdpwheel.ts -240`
   (pid chain from 2026-11-26 ~10:55, CDP wheel experiment) was still
   spinning at ~5000 CPU-seconds; killed before the build. Not a
   product defect; noted for host hygiene.
4. First `update.ps1` attempt via `Start-Process` over SSH died with the
   session (expected per known constraint) — schtasks is the reliable
   path; second attempt hit the PS5.1 `*>`+stderr quirk — `cmd /c`
   redirection works. Both are environment/tooling notes, not product
   defects.

## Final machine state

- `current` = `0e3c14eba55bf9a827f617cc78882bc524e69e1a`,
  `previous` = `7c562c9…` (rollback intact)
- App running clean via `launch.ps1` (no debug port) on default session;
  `verify.ps1 -Live` PASS; bridge `ok:true, "2 panes, 2 workspaces"`
  (original workspace set restored)
- 4 plugins installed+enabled on Windows default herdr session (left
  installed per task); remote mac plugins untouched (already installed)
- Default herdr session workspaces back to `restro-pv` + `~` only;
  remote `HT3I-WIN` closed; throwaway repo deleted; inbox organize
  state restored to baseline
- schtasks tasks `HT3I-Update`, `HT3I-Update2`, `HT3I-Launch`,
  `HT3I-Perf`, `HT3I-Final` left registered (harmless one-shot tasks)

## Evidence files

- `section-i-01-ht3i-local.webp` … `section-i-19-px-scrollback.webp`
  (16 CDP screenshots, converted to webp, 1440×900, non-blank verified;
  originals remain on-machine under `C:\Users\rebui\ht3-i\dom\*.png`)
- `section-i-perf-win-0e3c14e.json` — perf baseline report
- `section-i-plugin-list.txt` — final `herdr plugin list`
- On-machine: `C:\Users\rebui\ht3-i\` (dom/*.png full set,
  update-0e3c14e-2.log, perf.log, helper .ps1/.cmd),
  `C:\Users\rebui\ht3-iso\` (drive.ts/cdpem.ts CDP drivers)
