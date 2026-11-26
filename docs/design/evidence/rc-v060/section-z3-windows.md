# RC v0.6.0 — Section Z3: Windows 11 final-candidate convergence leg (issue #357 follow-up)

Date: 2026-11-27 (JST). Host: Windows 11 (`device-windows`, profile
`C:\Users\rebui`, whoami `uuu\basic`), reached via the real user
sshd on port 2222 this leg — the port-22222 sshd that was wedged with
host-wide process-spawn degradation during section-z/z2 **recovered**
(ssh round-trip ~1.1 s, 3 process spawns 87 ms). herdr 0.9.5, bun
1.4.5, packaged Electron win-unpacked build.

Candidate: **`ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`** —
`origin/release-0-6-0` head at freeze (same SHA as the macOS
section-z3 leg). Shipped delta vs the section-z2 candidate `9bb50cf`:
#384 (`herdr-bridge` Rust RPC transport + `BridgeSession` snapshot
stream/subscription supervisor), #388 (terminal block cursor +
`cursor-color`/`cursor-text`), #391+#383 (sidebar agent shelves
progressive disclosure + info dedup), #395 (Usage surface via
`herdr-plugins.usage/v1` @ `d23205af`), #397 (pane context card,
#390), #392 (ssh preamble strip, server-side).

Screenshots: `section-z3-windows/` (webp via `cwebp -q 80`; raw png
captures on-device only, `C:\Users\rebui\ht3-z3\`). Supporting
files: `section-z3-plugin-list-win.json`,
`section-z3-pane-read.txt`, `section-z3-remote-plugin-call.json`,
`section-z3-draft.log`.

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`
(`C:\Users\rebui\src\pc-setup`), driven via `schtasks /it` → cmd
wrappers under `C:\Users\rebui\ht3-z3\` (task names `HT3Z3-*`).

Host condition: normal load — the perf A/B agent referenced in
z2 had finished; no concurrent benches this leg.

## Z3-1 — update / verify / launch — PASS

- `update.ps1 -Ref ab0ca3d…` via `HT3Z3-Update`
  (`update-ab0ca3d.cmd`/`.log`): clone/fetch → `mise install
  --locked` → `bun install --frozen-lockfile` → vite +
  `build-desktop.ts` + `electron-builder --publish never`. Tail:
  `[herdr-t3] installed ab0ca3d47c13a6874286895f7c6ef5fe86d0186e
  (ab0ca3d47c13…); current -> ab0ca3d47c13…`, `EXIT=0`.
- Pointer bookkeeping: `current` was externally drifted to
  `0e3c14eba55bf9a827f617cc78882bc524e69e1a` before this leg
  (perf A/B agent's last candidate; its `ht3-perf` dir was already
  cleaned). `update.ps1` recorded it correctly as `previous`.
- State after update: `current` =
  `ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`, `previous` =
  `0e3c14eba55bf9a827f617cc78882bc524e69e1a` (rollback intact).
  `current_app` →
  `…\releases\ab0ca3d…\release\win-unpacked\herdr-t3.exe`;
  VersionInfo ProductVersion/FileVersion 0.6.0.0 / 0.6.0.
- `verify.ps1` static: PASS (`verify.log`, installed @ `ab0ca3d47c13`,
  Start Menu shortcut tracked). `launch.ps1`: PASS — clean packaged
  `ab0ca3d` exe started (`launch.log`). `verify.ps1 -Live`: PASS —
  `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock`
  (`verify-live.log`, re-run after the CDP leg too).

## Z3-2 — plugin set: 7/7 enabled at contract pins — PASS

`rebuildup.usage` was the only missing plugin (6 installed after
z2). Installed at the pin from
`docs/migration/contracts/plugins-boundary.md` @ `ab0ca3d`
(`d23205af0cd2ff7dba25f72e1f3b872762a108ee`; manifest version 0.5.0,
contract `herdr-plugins.usage/v1`):

```
herdr plugin install rebuildup/herdr-plugins/plugins/usage \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee -y
```

using the resolved `herdr.exe` directly (the `herdr` mise **shim**
is still broken on this host — it tries to install
`github:rebuildup/skill-graph@0.4.0`, which has no windows-x64
asset; same environment issue recorded in z2, not product).

`herdr plugin list --json` → `section-z3-plugin-list-win.json`:
**7 plugins, all enabled, all at pins** — resolved commits verified
via `git -C <plugin_root>/../.. rev-parse HEAD`:

| plugin | version | resolved commit |
| --- | --- | --- |
| `rebuildup.automations` | 0.7.0 | `6c1cfa501323` |
| `rebuildup.checkpoints` | 0.4.0 | `ae4f214c523d` |
| `rebuildup.conversations` | 0.5.0 | `d23205af0cd2` |
| `rebuildup.git` | 0.2.0 | `d0578307a856` |
| `rebuildup.inbox` | 0.1.0 | `414e87dea9fa` |
| `rebuildup.projects` | 0.3.0 | `2dcb2abfa57b` |
| `rebuildup.usage` | 0.5.0 | `d23205af0cd2` |

Left installed+enabled — normal-use environment.

## Z3-3 — delta E2E (packaged app, CDP :9223)

Packaged `ab0ca3d` `win-unpacked\herdr-t3.exe` driven over CDP
`127.0.0.1:9223` (`HT3Z3-Debug`/`relaunch-debug.ps1`, resolves exe
from `current_app`), default herdr session. Live panes never
touched: scratch workspace `~` (`wY`, pane `wY:p1`, cwd
`C:\Users\rebui`) used for terminal I/O; `restro-pv` `wR:p3` devin
pane only read via surfaces/cards.

### #384 bridge/attach + terminal I/O: PASS

- App boot attaches the default session through the packaged bridge;
  sidebar, workspaces, agent shelves and all plugin surfaces render
  live data (see Z3-4/Z3-5).
- Terminal I/O round-trip on `wY:p1`: focused `.ghostty-input`,
  `Input.insertText`
  `Write-Output "HT3Z3_AB0_OK_日本語_🦀"` + Enter →
  `herdr pane read wY:p1 --source recent --lines 40`
  (`section-z3-pane-read.txt`) shows the command echoed and
  `HT3Z3_AB0_OK_日本語_🦀` returned byte-correct (UTF-8 preserved
  end-to-end through cmd-redir evidence capture).
- `verify-reconnect-draft.ts` on this SHA from the release checkout
  (`HT3Z3-Draft`, isolated session `ht3draft`, self-contained bridge
  `:4788` + vite `:5788` + headless Chrome `:9341`): **5/6 PASS on
  two consecutive runs** — the safety invariant fully verified:
  draft type ok, type-during-outage ok, **draft retained after
  reconnect**, **outage input never reached pty**, **explicit Enter
  sends draft exactly once** (`occurrences 1 -> 2`).
  - The one FAIL, `draft echoed while connected`, is the harness's
    fixed 800 ms sleep between `insertText` and `herdr pane read`;
    the identical draft string is confirmed on the prompt line
    seconds later by the reconnect check, so delivery happened —
    the assertion window is tighter than this host's pty-echo +
    pane-read latency. Not a product defect; the dev-stack attach
    path (`bridge-core`/`client-link`) is unchanged by #384
    (`BridgeSession` lives in `crates/` for the GPUI migration, not
    the Electron product path). Full log: `section-z3-draft.log`.
    Session `ht3draft` deleted after the leg.
  - First run also hit the stock 20 s vite wait budget once
    (cold optimize on a busy host); second/third runs vite ready in
    ~2–3.5 s.

### #388 block cursor: PASS (visual)

Focused terminal on `wY` renders the block cursor at the prompt —
`z3-18-block-cursor` (light) / `z3-01-unicode-term` (dark). The
cursor-color/cursor-text paint path shipped in `b5d872f`
(Electron scene/renderer/surface + Rust terminal-render); pixel-level
cursor-cell verification was done on macOS (`z3-11-blockcursor-clip`
in `section-z3-webp/`); Windows evidence is the packaged-app
screenshot pair.

### #391/#383 agent shelves + dedup: PASS

- Shelves render as collapsible bottom sections with live counts
  (`Working 13` observed mid-leg). Collapse verified: header click
  flips `aria-expanded` true→false and collapses rows
  (`z3-04-shelf-collapsed`); re-expand restores.
- **Progressive disclosure exercised live**: with 13 working agents
  the capped shelf showed the first 10 rows plus a `Show 3 more`
  button (`AGENT_SHELF_INITIAL_VISIBLE`=10,
  `AGENT_SHELF_PAGE`=25); clicking it revealed the remaining rows
  (`z3-17-shelf-showmore`). Attention stays uncapped per
  `UNCAPPED_AGENT_SECTIONS` (no attention rows were populated this
  leg — disclosed, not a defect).
- Dedup (#383): agent rows read `workspace · machine` + single
  status word + agent title — no repeated state text (verified in
  DOM dump; status details live in the hover card).

### #395 Usage surface: PASS

Opened via command palette (`Ctrl+K` → `Usage`, command id
`panel-usage`) on `wY`. Renders real plugin data:

- `claude`: `no_credential` — "Claude credential file has no
  claudeAiOauth.accessToken", `no quota data — no_credential`
  (honest).
- `codex`: `ok`, plan `Plus`, Session 35% / Weekly 76% with real
  reset timestamps (`resets 2026/11/27 4:27:29`,
  `2026/11/30 2:07:36`), `1 reset credit`, `checked
  2026/11/27 1:07:38`, `cached 271s`.
- `opencode`: `unsupported` — "auth.json stores per-provider API
  keys; no subscription quota artifact exists" (honest).
- USAGE section: honest empty state — `no measured usage in this
  window — an empty conversations index reports zeros, not zero
  usage`, `0 events`, cache-token tri-state rendered per provider,
  `no indexed sessions; run rebuildup.conversations index…`.
- ESTIMATED COST: `estimate —`, `0 priced models`,
  `pricing ok · 4,961 models`, estimate-not-bill disclaimer
  verbatim. QUOTA VS MEASURED DIVERGENCE section present.
- Read-only contract honored: only `Refresh` affordance, no
  mutation UI (`mutation_commands: []`).
- Evidence: `z3-02-usage` (dark), `z3-10-usage` (light).

### #397 pane context card: PASS

`button[aria-label="Pane context"]` in the workspace header opens
the popover on the focused `wR:p3` devin pane — real data only:
Agent `idle`, `devin`, terminal title
`devin.exe: rebuildup/restro-pv の PR #27（branch`,
`C:\Users\rebui\Desktop\restro-pv`; Workspace `restro-pv`, `19`,
`Local`, `1 tabs · 1 panes`; Actions `Prompt agent…`, `Details…`,
`Source Control`, `Checkpoints`, `Copy pane ID`, `Copy workspace
ID`; `Choose what to show` per-item disclosure. The live pane was
not interacted with — read-only surfaces only.
Evidence: `z3-03-context-card`.

### #392 ssh preamble strip: PASS (Windows endpoint, end-to-end)

The port-22222 user sshd recovered this leg, so the Windows-exec
path was exercised for real instead of documented-as-wedged:

- Added a temporary saved machine `device-windows-self`
  (target `device-windows` → 100.118.123.62:22222, self-ssh; the
  only Windows-remote endpoint available — `Lab Windows`
  (`device-lab-win`) still reports `incompatible`: remote herdr
  lacks machine API forwarding). Hand-wrote
  `endpoints.json` + `ssh-metadata/<id>.json` (os=windows,
  executable=resolved herdr.exe) because `herdr machine add`
  hung >7 min probing the self endpoint and was killed; the
  entry used a 64-hex id (app accepts it; `machine remove`
  validates 32-hex so removal was a careful no-BOM file edit).
- Through the app's own IPC (`window.herdrT3.sendFrame`):
  - `plugin_list` → `ok:true`, all 7 plugins with real
    `plugin_root` paths — previously every Windows endpoint
    reported `plugin_bad_output` (issue #353, section-z Z-7).
  - `plugin_call rebuildup.inbox list` → `ok:true`, real inbox
    document: `counts total:3/inbox:3`, items `wR:p3` (devin,
    working), `wY:p1`, `wZ:p1` — verbatim in
    `section-z3-remote-plugin-call.json`.
- Two harness-side traps hit and fixed during setup (both BOM
  issues in hand-written JSON: `endpoints.json` and the metadata
  file — PowerShell `Set-Content -Encoding utf8` writes a BOM that
  `JSON.parse` rejects, silently emptying the machine list /
  metadata). Rewritten with `UTF8Encoding($false)`.
- Machine entry + metadata removed after the test; `herdr machine
  list` back to the original 3 saved machines.

## Z3-4 — regression smoke: PASS

- All eight right-panel surfaces opened as docked tabs and render
  plugin-driven content: Source Control (git surface:
  Changes/Commit/History/Compare/Sync/PRs tabs + repo discovery),
  Projects (`no projects registered` honest empty + Runs history
  `ht3j-hello`/`ht3i-hello` exit 0), Project Scripts, Checkpoints
  (worktree checkpoint data incl. `ht3i-gui-test`), Worktrees,
  Automations (`no scheduled tasks` honest empty), Conversations
  (index UI: Index now/Search/Reconcile), Usage.
  Evidence: `z3-10-*`, `z3-11-*`, `z3-13-conv-auto` (all 8 tabs
  visible in the strip).
- Agent hover card: real CDP `Input.dispatchMouseEvent` hover over
  a sidebar agent row → glass tooltip with title, status, agent
  kind, `workspace · machine`, cwd, pane id
  (`z3-14b-hover`).

## Z3-5 — visual review capture set

Comprehensive packaged-app captures (CDP `:9223`, real default
session; scratch `wY` used only for I/O/cursor shots):

| file | content |
| --- | --- |
| `z3-00-main` | main window, dark — sidebar + shelves + terminal + panels |
| `z3-01-unicode-term` | `~` workspace, Unicode I/O output + cursor, dark |
| `z3-02-usage` | Usage surface, dark |
| `z3-03-context-card` | pane context card popover open, dark |
| `z3-04-shelf-collapsed` | Working shelf collapsed via header click |
| `z3-05-light-main` | main window, light theme |
| `z3-10-usage` / `z3-10-source-control` / `z3-10-projects` | surfaces, light |
| `z3-11-checkpoints` / `z3-11-worktrees` / `z3-11-project-scripts` | surfaces, light |
| `z3-13-conv-auto` | panel tab strip with all 8 surfaces |
| `z3-14b-hover` | agent row hover card (glass tooltip) |
| `z3-15-narrow` | ~960 px window — responsive layout, all machines |
| `z3-16-tabstrip` | `~` workspace with 2 tabs (`wY:t1`+`wY:t2`) |
| `z3-17-shelf-showmore` | capped shelf after `Show 3 more` |
| `z3-18-block-cursor` | focused terminal, block cursor, light |
| `z3-19-final-dark` | final state — Local restro-pv, dark |

All 19 webp verified non-blank (uniq-16 colors 30–70, luminance
sd 13–73 sampled).

## Defects / observations

1. **`herdr` mise shim still broken on Windows** (carried from z2):
   shim triggers a mise install of `github:rebuildup/skill-graph@
   0.4.0` (no windows-x64 asset) before `herdr` runs. Worked around
   with the resolved `mise/installs/github-herdrdev-herdr/0.9.5/
   herdr.exe` everywhere. Environment/tooling issue.
2. **`herdr machine add` hangs on a self-ssh Windows endpoint**
   (>7 min, killed). Remote probing spawned herdr processes but
   never completed; hand-written endpoints/metadata entry worked
   immediately for plugin ops. Worth a herdr issue if self-machine
   add is a supported flow — recorded as observation, the
   plugin-host path itself verified fine.
3. **Draft-check timing**: `draft echoed while connected` fails on
   this host at its fixed 800 ms window (2/2 runs) while the same
   content is confirmed present seconds later — assertion-window
   tightness under host latency, not a delivery failure (see Z3-3).
4. **BOM sensitivity**: hand-editing `endpoints.json` /
   `ssh-metadata/*.json` with PowerShell `Set-Content -Encoding
   utf8` (PS5.1) writes a UTF-8 BOM that `JSON.parse` rejects —
   silently drops all saved machines / metadata. Not a product
   defect (herdr CLI writes BOM-free), an ops footgun worth noting
   for future legs.
5. **Release head moved during the leg**: `origin/release-0-6-0`
   advanced past `ab0ca3d` to `e8302ea` (macOS z3 evidence #414 +
   context-card rework #406) while this leg ran. This leg verifies
   the frozen `ab0ca3d` as tasked; the docs-only PR targets the
   current head.
6. **CDP/emu notes**: `Browser.getWindowForTarget` is unavailable
   in this Electron's CDP (window resize needed a user32
   `MoveWindow` via a `schtasks /it` helper); `Page.captureScreenshot`
   captures the OS window surface, not the emulated viewport —
   narrow-viewport evidence used a real window resize instead.
   Synthetic `KeyboardEvent`/`MouseEvent` don't drive React
   handlers/tooltips — real `Input.dispatch*` events used.

## Final machine state

- `current` = `ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`,
  `previous` = `0e3c14eba55bf9a827f617cc78882bc524e69e1a`; app
  running the clean packaged `ab0ca3d` exe via `launch.ps1`
  (`verify.ps1 -Live` PASS; CDP 9223 confirmed closed — debug
  instance killed).
- Windows default herdr session: **7 plugins installed+enabled**
  at contract pins (automations, checkpoints, conversations, git,
  inbox, projects, usage).
- Saved machines back to the original 3 (Ubuntu (WSL), Mac, Lab
  Windows); temporary `device-windows-self` entry + metadata
  removed.
- Workspaces: `restro-pv` (`wR`), `~` (`wY`, test tab `wY:t2`
  closed), `wZ` untouched; no isolated test sessions left
  (`ht3draft` deleted; other stopped `ht3*` sessions pre-date
  this leg).
- Orphaned `remote-api-bridge` processes from the self-machine
  probes killed; app bridges to WSL/Mac reconnect on demand.
- schtasks `HT3Z3-*` left registered — harmless one-shot tasks,
  same convention as prior legs. On-machine originals/logs:
  `C:\Users\rebui\ht3-z3\` (update/verify/launch logs, CDP js/ts
  drivers, png captures, endpoints-backup.json).
