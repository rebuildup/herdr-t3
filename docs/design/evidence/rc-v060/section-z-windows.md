# Section Z — Windows 11 leg: frozen RC final-candidate verification

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, profile
`C:\Users\rebui`, whoami `uuu\basic`, reached via WSL2 sshd on port
2222 + `powershell.exe` interop; the port-22222 sshd remains unused).
Issue #357 section Z:
final-candidate verification of the v0.6.0 RC head on Windows before
release sign-off.

Candidate: `2febbbf6cfe78e455c46c5709e171309295aaba0`
(`origin/release-0-6-0` head, merge of PR #373 / `354-canvas-frame`).
Last fully verified Windows build was section-j's
`932ce11d341385006a6389591a329f74a550d9d4`; the delta to `2febbbf`
includes the wasm product-path consumers (#319 `terminal.input`, #315
`protocol.codec`, #316 `agent.projection`), the Automations read +
lifecycle-mutation surface (#361/#362), remote plugin bun resolution +
probe-failure caching fix (#339), Windows reconnect-draft harness
support (#356/#368), and the scene/frame perf benches (#354).

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref 2febbbf6cfe78e455c46c5709e171309295aaba0`
(`C:\Users\rebui\src\pc-setup`).

## Z-1 — update / verify / launch — PASS

- `update.ps1` via `schtasks /ru basic /it` → `cmd /c` wrapper
  (`C:\Users\rebui\ht3-z\update-2feb.cmd`, log
  `update-2feb.log`): clone → `mise install --locked` → `bun install
  --frozen-lockfile` → vite + `build-desktop.ts` + `electron-builder
  --publish never`. Tail: `[herdr-t3] installed
  2febbbf6cfe78e455c46c5709e171309295aaba0 …; current -> 2febbbf…`,
  `EXIT=0`.
- State: `current` = `2febbbf6cfe78e455c46c5709e171309295aaba0`,
  `previous` = `932ce11d341385006a6389591a329f74a550d9d4` (rollback
  intact). `current_app` points at
  `…\releases\2febbbf…\release\win-unpacked\herdr-t3.exe`;
  VersionInfo 0.6.0.0 / 0.6.0.
- `verify.ps1` static: PASS (`verify.log`). `launch.ps1`: PASS
  (`launch-final.log`, "already running; activating"). `verify.ps1
  -Live`: PASS — `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock` (`verify-live.log`).
- Final app is the clean packaged exe (no `--remote-debugging-port`);
  CDP `127.0.0.1:9223` confirmed closed (`ECONNREFUSED`) after the
  debug instance was killed.

## Z-2 — packaged terminal I/O, scrollback, reconnect-draft — PASS

Packaged `win-unpacked\herdr-t3.exe` (2febbbf) driven over CDP 9223 on
the **default** herdr session, workspace `~` (`wY`, pane `wY:p1`,
cwd `C:\Users\rebui`). The live `restro-pv` (`wR`) devin pane was not
touched.

- **Unicode/emoji I/O**: typed
  `Write-Output "HT3Z_2FEB_OK_日本語_🦀"` + Enter through the real GUI
  terminal; `herdr pane read wY:p1 --source recent --lines 140`
  (`pane-read.txt`) shows the command echoed and
  `HT3Z_2FEB_OK_日本語_🦀` returned byte-correct.
- **Scrollback**: typed `1..80`; pane read shows `1`…`80` rendered and
  the prompt returned. Screenshot
  `section-z-webp/section-z-win-01-scrollback.webp`.
- **Reconnect-draft regression**: `C:\Users\rebui\ht3-draft` checkout
  at frozen SHA `2febbbf` (detached) ran
  `bun scripts\verify-reconnect-draft.ts --session ht3zw` via
  `run-draft.cmd`/`draft-ht3zw.cmd` (`draft-ht3zw.log`): **6/6 PASS** —
  draft typed while connected, input during bridge outage never
  reached the pty, draft retained after reconnect, explicit Enter sent
  it exactly once. Isolated session `ht3zw` only; default session
  untouched.
- **Harness cleanup caveat**: the script logged `workspace cleanup
  failed (left for manual cleanup): ShellError … exit code 1` after
  `=== summary: 6/6 passed ===`. Manual cleanup completed: restarted
  `herdr --session ht3zw server`, closed leftover workspace `w1`, then
  `herdr session stop/delete ht3zw`; `herdr session list` shows no
  `ht3zw` remains. Treated as a Windows harness cleanup defect, not a
  product regression — the six product assertions all passed.

## Z-3 — CDP smoke: Automations + two panel surfaces — PASS

The Automations surface (#361/#362) is not one of the four default
plugins, so it was installed for this leg at the contract-pinned ref:

```
herdr plugin install rebuildup/herdr-plugins/plugins/automations \
  --ref 6c1cfa501323772e7c1c008c3dbcd7e364feb0b3 -y
```

`plugin-list.txt` (`herdr plugin list --json`, captured during the
smoke) shows `rebuildup.automations` 0.7.0 enabled alongside the four
baseline plugins. After the smoke the plugin was uninstalled
(`plugin-uninstall.log`), restoring the 4-plugin baseline.

- **Fixture task**: created disabled via the plugin CLI
  (`auto-create.log`): `HT3Z smoke`, prompt `echo HT3Z_AUTOMATION`,
  schedule `once` at `2030-01-01T00:00:00Z`, destination
  `{"kind":"pane","pane_id":"wY:p1"}`, `enabled=false`. Far-future
  schedule + disabled state ⇒ no firing path was exercised.
- **Surface open**: header "Pane actions" → "Automations" opened the
  docked right panel (`[data-right-panel]`, not a modal). First paint
  showed `no scheduled tasks` because the store had cached a ready-empty
  list from app start (before the fixture existed); the surface only
  auto-refreshes while `loading`, so a manual **Refresh** was required
  to show the task — recorded as a minor UX observation, not a defect.
  After Refresh the row rendered: `HT3Z smoke`, `once at
  2030-01-01…`, `pane wY:p1`, `disabled`, driver `none`
  (`section-z-win-02-automations.webp`).
- **Mutation**: clicked **Enable** → notice `task enabled`, badge
  flipped to `enabled`, `next 2030/1/1 9:00:00`, actions became
  Disable/Run now/Delete. Clicked **Delete** → confirmation dialog
  (`Delete task? … cannot be undone`) → confirmed → `no scheduled
  tasks`. `auto-list.json` post-delete returns `tasks: []`.
- **Two surfaces as tabs**: panel "+" → **Projects** opened a second
  tab beside Automations; both stayed mounted (hidden when inactive)
  per `RightPanel.tsx`. Automations tab re-activated cleanly and showed
  the empty state (`section-z-win-03-two-surfaces.webp`,
  `section-z-win-04-automations-empty.webp`).

## Z-4 — packaged pixel check — PASS

Four real `Page.captureScreenshot` captures of the packaged window,
all 1440×900, verified non-blank by ffmpeg rawvideo stats (downscaled
RGB): ~78–88 quantized colors, luminance sd 11.95–13.12 — comparable
to prior legs' non-blank range.

- `section-z-win-01-scrollback.webp` — terminal scrollback (`1..80`)
- `section-z-win-02-automations.webp` — Automations surface with the
  disabled fixture task
- `section-z-win-03-two-surfaces.webp` — Automations + Projects tabs,
  Projects active
- `section-z-win-04-automations-empty.webp` — Automations tab after
  fixture deletion, Projects tab still present

## Z-5 — remote plugin smoke Windows app → device-mac — PASS

Through the app's own IPC (`window.herdrT3.sendFrame`, Mac machine id
`adbd2f44617d46e9e397ea1e6e4c97b5`, status `online`):

- `plugin_list` → `ok:true`, 5 plugins on the mac host:
  `rebuildup.automations` 0.7.0, `rebuildup.checkpoints` 0.4.0,
  `rebuildup.git` 0.2.0, `rebuildup.inbox` 0.1.0,
  `rebuildup.projects` 0.3.0, with `plugin_root` paths under
  `/Users/rebui/.config/herdr/plugins/github-installations/…`.
- `plugin_call rebuildup.inbox list` → `ok:true`, real document:
  `state_file
  /Users/rebui/.local/state/herdr/plugins/rebuildup.inbox/state.json`,
  counts `total:9 / inbox:9`, 9 pane items. **Remote plugin host
  execution verified — PASS.** Read-only calls only; mac plugins and
  sessions untouched. Full frames: `section-z-remote-plugin-smoke.json`.

## Z-6 — perf baseline — recorded (regression signal flagged)

`scripts/perf-baseline.ts record --iterations 7 --out
C:\Users\rebui\ht3-z\perf-2febbbf*.json` inside the installed release
checkout (`ht3-z-perf.cmd`/`ht3-z-perf2.cmd`, `perf.log`/`perf2.log`):

- Run 1 (`section-z-perf-win-2febbbf.json`): terminal bench
  `totals_ms` 251–306, **p50 = 271 ms, p95 = 306 ms, cv = 5.8%**;
  scene bench p50 = 232 ms, p95 = 261 ms, cv = 6.1%, ops = 16,189;
  cells decoded 1,912,344 (seed 42, 400 ticks).
- Run 2 (`section-z-perf-win-2febbbf-run2.json`): terminal bench
  222–372, **p50 = 240 ms, p95 = 372 ms, cv = 18.5%**; scene p50 =
  220 ms, p95 = 250 ms, cv = 9.5%.

Comparison on the same host/workload: section-i `0e3c14e` p50 = 105
ms; section-j `932ce11` p50 = 146 ms (with a 464 ms outlier); section-z
`2febbbf` p50 = 240–271 ms across two runs. The upward trend is
consistent enough to flag as a **possible terminal-path regression**
(wasm consumers #319/#315 landed in this delta) rather than dismiss as
noise — recorded honestly for follow-up; not a launch blocker for the
RC evidence leg.

## Defects / observations

1. **Reconnect-draft harness cleanup (Windows)**: `verify-reconnect-
   draft.ts` passed 6/6 but reported `workspace cleanup failed (left
   for manual cleanup)` on the spawned `ht3zw` server path; manual
   close+session-delete completed. Harness-side issue, not product.
2. **Automations store freshness**: opening the surface while the
   store already held a ready-empty list did not auto-refresh; manual
   Refresh was needed to show a task created after app start. Minor UX
   observation.
3. **CDP tooling**: `drive.ts shot` (`Page.captureScreenshot`) hung
   twice with no response; `shot2.ts` (`Page.bringToFront` + 20 s
   timeout) succeeded for the remaining captures. `Browser.
   getWindowForTarget` remains unimplemented in this Electron CDP, so
   real OS window resize is still untested headlessly.
4. **Perf trend**: Windows terminal bench p50 rose 105 → 146 →
   240–271 ms across sections i/j/z; see Z-6.
5. **Plugin baseline restored**: `rebuildup.automations` was installed
   only for the Z-3 smoke and uninstalled afterwards; final Windows
   default session is back to the four baseline plugins
   (checkpoints/git/inbox/projects). Mac plugins untouched.

## Final machine state

- `current` = `2febbbf6cfe78e455c46c5709e171309295aaba0`,
  `previous` = `932ce11…` (rollback intact); app running clean via
  `launch.ps1` (no debug port — CDP 9223 refused); `verify.ps1 -Live`
  PASS.
- Windows default herdr session workspaces: `restro-pv` (`wR`) + `~`
  (`wY`) only; isolated `ht3zw` session deleted; fixture automation
  task deleted; right-panel localStorage cleared.
- 4 plugins installed+enabled on the Windows default session
  (automations removed post-smoke); mac-side plugins untouched
  (read-only calls).
- schtasks task `HT3Z-Update` (and prior-leg `HT3I-*`/`HT3J-*`
  tasks) left registered — harmless one-shot tasks.

## Evidence files

- `section-z-webp/section-z-win-01-scrollback.webp` …
  `section-z-win-04-automations-empty.webp` — 4 CDP screenshots
  (1440×900), non-blank verified.
- `section-z-perf-win-2febbbf.json`,
  `section-z-perf-win-2febbbf-run2.json` — perf baseline reports.
- `section-z-plugin-list-win.txt` — `herdr plugin list --json` captured
  during the smoke (5 plugins incl. automations).
- `section-z-remote-plugin-smoke.json` — `plugin_list`/`plugin_call`
  frames for device-mac.
- `section-z-pane-read.txt` — `herdr pane read wY:p1` proof of
  Unicode/emoji I/O and `1..80` scrollback.
- On-machine originals/logs: `C:\Users\rebui\ht3-z\` (update/verify/
  launch/draft/perf/automations logs, screenshots, `js/` CDP snippets,
  `auto-create.cmd`/`auto-list.cmd`), drivers under
  `C:\Users\rebui\ht3-iso\`, draft checkout `C:\Users\rebui\ht3-draft`.
