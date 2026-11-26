# Section Z2 — Windows 11 leg: post-`2febbbf` delta + acceptance items at `9bb50cf`

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, profile
`C:\Users\rebui`, whoami `uuu\basic`, reached via WSL2 sshd on port
2222 + `powershell.exe` interop; the port-22222 sshd remains unused).
Issue #357 follow-up leg: final-candidate verification at the frozen
SHA **`9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`** on Windows,
mirroring the section-z structure and covering the shipped delta
after `2febbbf` plus outstanding acceptance items.

Post-`2febbbf` shipped delta under test:

- `1823bc6` — Conversations surface via `herdr-plugins.conversations/v1`
  (issue #374): right-panel surface with sessions list, paged history,
  search, and explicit `index`/`refresh` mutations gated on the
  contract's `mutation_commands`.
- `e985a19` — `crates/ui-kit` GPUI design-system primitives crate +
  ui-test-host panel (issue #322). **Note only**: the crate is not
  referenced by `package.json`, `desktop/`, or `electron-builder.yml`;
  it is not in the Electron product path. No UI verification applies.

Previous fully verified Windows build: section-z `2febbbf`
(`docs/design/evidence/rc-v060/section-z-windows.md`).

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref 9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`
(`C:\Users\rebui\src\pc-setup`), driven via `schtasks /ru basic /it` →
`cmd /c` wrappers under `C:\Users\rebui\ht3-z2\`.

Host condition: **loaded, not idle** — a concurrent perf A/B bench
agent was running on the device; WSL loadavg ~11–21 and Windows
process spawns intermittently took 17–90 s during the leg. All
timing-sensitive observations carry that caveat; no timing assertions
were made in this leg.

## Z2-1 — update / verify / launch — PASS

- `update.ps1 -Ref 9bb50cf…` via `schtasks` task `HT3Z2-Update`
  (`update-9bb50cf.cmd`/`update-9bb50cf.log`): clone → `mise install
  --locked` → `bun install --frozen-lockfile` → vite +
  `build-desktop.ts` + `electron-builder --publish never`. Tail:
  `[herdr-t3] installed 9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c …;
  current -> 9bb50cf…`, `EXIT=0`.
- State after update: `current` =
  `9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`, `previous` =
  `2febbbf6cfe78e455c46c5709e171309295aaba0` (rollback intact).
  `current_app` points at
  `…\releases\9bb50cf…\release\win-unpacked\herdr-t3.exe`;
  VersionInfo ProductVersion/FileVersion 0.6.0.0 / 0.6.0.
- `verify.ps1` static: PASS (`verify.log`, installed @ `9bb50cf0f6bd`,
  Start Menu shortcut tracked). `launch.ps1`: PASS — old `2febbbf`
  processes stopped, clean packaged `9bb50cf` exe started
  (`launch.log`, `restart-clean.cmd`). `verify.ps1 -Live`: PASS —
  `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock`
  (`verify-live.log`).

## Z2-2 — plugin set unified to the 6-plugin contract pins — PASS

Before this leg the Windows default herdr session had the four
baseline plugins (inbox/git/projects/checkpoints); `automations` had
been uninstalled after section-z and `conversations` was never
installed. Installed the two missing plugins at the contract pins
(`docs/migration/contracts/plugins-boundary.md`) via the official
path, using the resolved `herdr.exe` directly
(`C:\Users\rebui\AppData\Local\mise\installs\github-herdrdev-herdr\
0.9.5\herdr.exe` — the `herdr` mise **shim** currently fails on this
host trying to install `github:rebuildup/skill-graph@0.4.0`, which
has no windows-x64 asset; environment issue, not product):

```
herdr plugin install rebuildup/herdr-plugins/plugins/automations \
  --ref 6c1cfa501323772e7c1c008c3dbcd7e364feb0b3 -y
herdr plugin install rebuildup/herdr-plugins/plugins/conversations \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee -y
```

`herdr plugin list --json` after install (`section-z2-plugin-list-win.json`)
shows **6 plugins, all enabled, all at pins** — identical set to the
macOS leg:

| plugin | version | resolved commit |
| --- | --- | --- |
| `rebuildup.automations` | 0.7.0 | `6c1cfa501323` |
| `rebuildup.checkpoints` | 0.4.0 | `ae4f214c523d` |
| `rebuildup.conversations` | 0.5.0 | `d23205af0cd2` |
| `rebuildup.git` | 0.2.0 | `d0578307a856` |
| `rebuildup.inbox` | 0.1.0 | `414e87dea9fa` |
| `rebuildup.projects` | 0.3.0 | `2dcb2abfa57b` |

The inbox pin `414e87dea9faa5c221fb27508e5828f086849836` matches
pc-setup `plugin-set.ps1` (the contract doc pins inbox by contract
version v0.1.0 only). Installs stay — this is the normal-use
environment; automations and conversations are required by shipped
surfaces, so they are left installed+enabled (same rationale as the
macOS leg leaving automations installed).

## Z2-3 — Conversations surface E2E (packaged app, CDP 9223) — PASS

Packaged `9bb50cf` `win-unpacked\herdr-t3.exe` driven over CDP
`127.0.0.1:9223` (`--remote-debugging-port` debug instance via
`HT3Z2-Debug`/`relaunch-debug.ps1`, which resolves the exe from
`current_app`), default herdr session, workspace `restro-pv` (`wR`)
selected — the live `devin` pane `wR:p3` was not touched.

- **Open**: Ctrl+K command menu → "Conversations" opened the docked
  right panel (`[data-right-panel]`). First paint showed the honest
  intro + `no indexed sessions — run Index now to scan provider
  transcripts` (`z2-01-conversations-empty.webp`).
- **Index mutation (gated, advertised)**: "Index now" button present
  ⇒ `mutation_commands` advertised `index`. Click ran the real
  `plugin_call … index`; notice rendered verbatim:
  `index: 0 sessions indexed, 0 events appended, 2 skipped
  (unknown_provider)`. Honest result: the Windows default session's
  agent panes run `devin` agents; the plugin's v1 adapters cover
  claude/codex/opencode only, so candidates are skipped with reasons
  — no fabricated sessions. Plugin source confirms candidates come
  from the herdr session snapshot (`paneAgentEntries`), not a
  transcript-dir scan.
- **Search**: typed `devin` into "Search conversations" → Search →
  `no matches for "devin"` (`z2-02-conversations-search.webp`).
- **Disabled-plugin error state**: `herdr plugin disable
  rebuildup.conversations` + panel Refresh → first refresh kept the
  stale ready state (documented freshness triggers), second refresh
  rendered `conversations plugin disabled — rebuildup.conversations`
  — verbatim plugin id, classified `disabled` (`z2-04-…webp`).
  Re-enabled via `herdr plugin enable`; after refreshes the surface
  recovered to the ready state.
- **Two surfaces + smoke**: panel "+" / command menu opened
  **Automations** as a second docked tab beside Conversations; both
  stayed mounted (`z2-03-two-surfaces.webp`). Automations rendered
  its honest empty state `no scheduled tasks` — surface still works
  with the plugin now permanently installed.
- Paged history / session expand could not be exercised: zero
  supported-provider sessions exist on this host (see Index result).
  Recorded honestly rather than fabricated.

CDP tooling note: `Runtime.evaluate` scripts that declare top-level
`const` collide across invocations (global lexical scope persists) —
wrap snippets in IIFEs; same class of harness quirk as section-z's
`drive.ts shot` hang (used `shot2.ts` `Page.bringToFront` + timeout
for all captures).

## Z2-4 — packaged terminal I/O (Unicode/emoji) — PASS

On the packaged `9bb50cf` app, default session, scratch workspace `~`
(`wY`, pane `wY:p1`, cwd `C:\Users\rebui` — same scratch pane as
section-z; the live `restro-pv` `wR:p3` devin pane untouched):
focused `.ghostty-input`, typed
`Write-Output "HT3Z2_9BB_OK_日本語_🦀"` + Enter through the real GUI
terminal; `herdr pane read wY:p1 --source recent --lines 40`
(`section-z2-pane-read.txt`) shows the command echoed and
`HT3Z2_9BB_OK_日本語_🦀` returned byte-correct. Screenshot
`z2-06-unicode-io.webp` (also `z2-05-ws-tilde.webp` workspace view).

## Z2-5 — rollback evidence (#357 gap) — PASS

Mechanism (pc-setup `components/herdr-t3/rollback.ps1`): pointer flip
only, no rebuild — sets `current` and `current_app` to the
`previous` release and re-points the Start Menu shortcut; the
superseded release dir stays on disk. Relaunch required.

- Pre-state: `current` = `9bb50cf…`, `previous` = `2febbbf…`.
- `rollback.ps1` via `HT3Z2-Rollback` (`rollback.log`):
  `[herdr-t3] rolled back to 2febbbf6cfe78e455c46c5709e171309295aaba0
  …; relaunch the app to apply`, `EXIT=0`. `current`/`current_app`
  now `2febbbf…`.
- Relaunched via `HT3Z2-Restart2` (`restart-clean2.cmd` /
  `launch-rollback.log`): clean packaged `2febbbf` exe running (no
  debug port). `verify.ps1 -Live`: PASS — `installed: 2febbbf… @
  2febbbf6cfe7`, Start Menu shortcut tracks the `2febbbf` exe, `live:
  app running, herdr endpoint present`. CDP `127.0.0.1:9223`
  confirmed closed (`curl` → `000`).
- **Restore**: `update.ps1 -Ref 9bb50cf…` re-run via `HT3Z2-Restore`
  (`update-restore.cmd`/`update-restore.log`) — reinstall selects the
  same SHA, `previous` stays `2febbbf…`, `current` returns to
  `9bb50cf…`; app relaunched clean and `verify.ps1 -Live` re-PASS
  (see Final machine state).

## Defects / observations

1. **`herdr` mise shim broken on Windows**: invoking the `herdr` shim
   triggers a mise install of `github:rebuildup/skill-graph@0.4.0`,
   which has no windows-x64 asset → shim exits nonzero before `herdr`
   runs. Worked around by calling the resolved
   `mise/installs/github-herdrdev-herdr/0.9.5/herdr.exe` directly.
   Environment/tooling issue (pc-setup/mise config), not herdr-t3.
2. **Plugin-surface freshness**: first Refresh after
   `plugin disable`/`enable` keeps the stale state; a second refresh
   (or snapshot push) is needed. Same documented behavior the macOS
   leg recorded — not a new defect.
3. **Conversations index coverage on this host**: 2 agent panes
   skipped `unknown_provider` (devin agents; plugin v1 supports
   claude/codex/opencode). Honest skip, but means sessions/history
   paths had no data to render — coverage gap is host data, not a
   product defect.
4. **CDP eval quirk**: top-level `const` in `Runtime.evaluate`
   scripts persists globally; re-running a file throws a redeclaration
   error (surfaced as `undefined` results). Harness note only.
5. **Transient Windows interop slowness**: during concurrent perf
   benches, Windows process spawns took 17–90 s and one schtasks
   `/query` hung >2 min; all recovered without intervention. The
   `HT3Z2-Restart2` task eventually completed (log flushed late).
   Environment load, recorded for the perf agent's benefit.
6. **Release head moved during the leg**: `origin/release-0-6-0`
   advanced past `9bb50cf` (now `e18078c`, incl. #329 BridgeSession,
   #322-block-cursor, #386) while this leg ran. This leg verifies the
   frozen `9bb50cf` as tasked; the evidence branch is based on the
   current release head for the docs-only PR.

## Final machine state

- `current` = `9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`,
  `previous` = `2febbbf6cfe78e455c46c5709e171309295aaba0`; app running
  the clean packaged `9bb50cf` exe via `launch.ps1`
  (`verify.ps1 -Live` PASS; CDP 9223 closed — debug instance killed).
- Windows default herdr session: **6 plugins installed+enabled** at
  contract pins (automations, checkpoints, conversations, git, inbox,
  projects) — unified with macOS.
- Workspaces: `restro-pv` (`wR`) + `~` (`wY`) only; no isolated test
  sessions left; no fixture tasks (Automations `no scheduled tasks`).
- schtasks tasks `HT3Z2-*` left registered — harmless one-shot tasks,
  same convention as prior legs.
- On-machine originals/logs: `C:\Users\rebui\ht3-z2\` (update/
  verify/launch/rollback/relaunch logs, `js/` CDP snippets, PNG
  captures), drivers reused from `C:\Users\rebui\ht3-iso\`.

## Evidence files

- `section-z2-webp/z2-00-main.webp` … `z2-06-unicode-io.webp` — 7 CDP
  screenshots (1440×900-class), non-blank verified (uniq colors /
  luminance sd sampled).
- `section-z2-plugin-list-win.json` — `herdr plugin list --json` with
  the unified 6-plugin set.
- `section-z2-pane-read.txt` — `herdr pane read wY:p1` proof of
  Unicode/emoji I/O.
- On-machine logs listed above under `C:\Users\rebui\ht3-z2\`.
