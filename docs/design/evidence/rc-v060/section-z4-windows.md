# RC v0.6.0 — Section Z4: Windows 11 delta leg @ `b49bceb` (new plugin surfaces + regression sanity)

Date: 2026-11-27 (JST). Host: Windows 11 (`device-windows`, profile
`C:\Users\rebui`, whoami `uuu\basic`), reached via the real user
sshd on port 2222 — stable all leg (no recurrence of the z/z2 sshd
wedging; round-trips normal). herdr 0.9.5, bun 1.4.5, packaged
Electron win-unpacked build.

Candidate: **`b49bcebb3d7762cae97edf9d2f50e42443de0a4f`** — the
frozen RC head supplied for this leg (51 commits past the section-z3
candidate `ab0ca3d`; `origin/release-0-6-0` had already advanced to
`9f6dcb3` at leg start, so the candidate was checked out in a detached
worktree). Delta under test: nine new right-panel plugin surfaces
(usage was already in z3; new: artifacts, handoffs, controls, textgen,
secrets, machines, mcp — plus the settings modal, pane context-card
T3 port #406, selection-history #433/#436, pane paste mode-aware
#434, `plugin_call` stdin + 600 s ceiling #458, agent-shelf
restructure #418, hairline dividers #432, perf throttle #422,
RC review fixes #417).

Screenshots: `section-z4-windows/` (webp via `cwebp -q 80`; raw png
captures on-device only, `C:\Users\rebui\ht3-z4\`). Supporting
files: `section-z4-plugin-list-win.json`, `section-z4-pane-read.txt`,
`section-z4-draft.log`, `section-z4-update.log`,
`section-z4-verify.log`, `section-z4-verify-live.log`.

Install path: `rebuildup/pc-setup` `components/herdr-t3/update.ps1
-Ref b49bcebb3d7762cae97edf9d2f50e42443de0a4f`
(`C:\Users\rebui\src\pc-setup`), driven via `schtasks /it` → cmd
wrappers under `C:\Users\rebui\ht3-z4\` (task names `HT3Z4-*`).

Host condition: normal load; no concurrent benches.

## Z4-1 — update / verify / launch — PASS (with launch.ps1 caveat)

- `update.ps1 -Ref b49bceb…` via `HT3Z4-Update`
  (`update-b49bceb.cmd`/`.log`): clone/fetch → `mise install
  --locked` → `bun install --frozen-lockfile` → vite +
  `build-desktop.ts` + `electron-builder --publish never`. Tail:
  `[herdr-t3] installed b49bcebb3d7762cae97edf9d2f50e42443de0a4f
  (b49bceb…); current -> b49bceb…`, `EXIT=0`
  (`section-z4-update.log`).
- State after update: `current` =
  `b49bcebb3d7762cae97edf9d2f50e42443de0a4f`, `previous` =
  `ab0ca3d47c13a6874286895f7c6ef5fe86d0186e` (z3 candidate —
  rollback intact). `current_app` →
  `…\releases\b49bceb…\release\win-unpacked\herdr-t3.exe`;
  VersionInfo 0.6.0.0 / 0.6.0.
- `verify.ps1` static: PASS (`verify.log`, installed @ `b49bceb`).
  `launch.ps1`: **caveat** — it is idempotent ("already running;
  activating") and does NOT restart a running older build; the
  still-running `ab0ca3d` instance was only activated. Clean
  relaunch was done with the z3 `relaunch-debug.ps1` pattern via
  `schtasks /it` (`HT3Z4-Debug`): all `herdr-t3` processes stopped,
  packaged `b49bceb` exe started with
  `--remote-debugging-port=9223`. `verify.ps1 -Live`: PASS —
  `live: app running, herdr endpoint present:
  C:\Users\rebui\AppData\Roaming\herdr\herdr.sock`
  (`verify-live.log`).
- **Process-lifetime note**: launching the exe directly over ssh
  (`Start-Process` from an sshd-spawned powershell) puts it in the
  sshd session's 1024×768 virtual desktop and the process is reaped
  when the ssh session ends — use `schtasks /it` for any launch that
  must persist (same convention as z3, now confirmed twice).

## Z4-2 — plugin set: 14/14 enabled at contract pins — PASS

Seven new plugins installed at the pin
(`docs/migration/contracts/plugins-boundary.md` @ `b49bceb`:
artifacts/handoff/textgen/controls/secrets/machines/mcp all
`d23205af0cd2ff7dba25f72e1f3b872762a108ee`) via the documented path,
using the resolved `herdr.exe` directly (the `herdr` mise **shim**
is still broken on this host — same environment issue as z2/z3):

```
herdr plugin install rebuildup/herdr-plugins/plugins/<name> \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee -y
```

`herdr plugin list --json` → `section-z4-plugin-list-win.json`:
**14 plugins, all enabled, all at pins**, and every manifest
declares `platforms: ["linux","macos","windows"]` — no Windows
platform-support gap:

| plugin | version | resolved commit |
| --- | --- | --- |
| `rebuildup.artifacts` | 0.2.0 | `d23205af0cd2` |
| `rebuildup.automations` | 0.7.0 | `6c1cfa501323` |
| `rebuildup.checkpoints` | 0.4.0 | `ae4f214c523d` |
| `rebuildup.controls` | 0.6.0 | `d23205af0cd2` |
| `rebuildup.conversations` | 0.5.0 | `d23205af0cd2` |
| `rebuildup.git` | 0.2.0 | `d0578307a856` |
| `rebuildup.handoff` | 0.6.0 | `d23205af0cd2` |
| `rebuildup.inbox` | 0.1.0 | `414e87dea9fa` |
| `rebuildup.machines` | 0.1.0 | `d23205af0cd2` |
| `rebuildup.mcp` | 0.7.0 | `d23205af0cd2` |
| `rebuildup.projects` | 0.3.0 | `2dcb2abfa57b` |
| `rebuildup.secrets` | 0.1.1 | `d23205af0cd2` |
| `rebuildup.textgen` | 0.6.0 | `d23205af0cd2` |
| `rebuildup.usage` | 0.5.0 | `d23205af0cd2` |

Enabled state persists across app relaunches — verified implicitly:
the packaged app was killed/relaunched three times during the leg
(CDP debug instance) and all surfaces kept rendering plugin data;
final `herdr plugin list` still shows 14 enabled.

## Z4-3 — new surfaces E2E (packaged app, CDP :9223)

Packaged `b49bceb` `win-unpacked\herdr-t3.exe` driven over CDP
`127.0.0.1:9223` (same `drive.ts`-style harness as z3, extended with
`clipshot`/`emu`), default herdr session, workspace `~` (`wY`,
pane `wY:p1`, cwd `C:\Users\rebui`) used for terminal I/O; the live
`restro-pv` `wR:p3` devin pane was only read via surfaces/cards.
Surfaces opened through the panel "+" add-surface menu
(`Add panel surface`), which lists all 16 entries.

Direct `plugin_call` evidence was taken through the app's own IPC
(`window.herdrT3.sendFrame` + `onFrame` `rpc_result`, id `z4call`)
— the same path the surfaces use.

### Artifacts — PASS (read + mutations)

Surface renders the contract intro, capability-gated mutation
affordances (`Register…`, `GC…`, per-row `Deliver…`/`Delete`),
filters, SEARCH and INTEGRITY VERIFY sections (`z4-01-artifacts`).

Safe mutations exercised through the real UI dialogs:

- **register**: created `C:\Users\rebui\ht3-z4\artifact-test.txt`
  (67 B text/plain), Register dialog → path field → `Register` →
  record `art-575f1986f64c6ceff2619f9b` appears in REGISTRY
  (`state_copy`, `by cli`, resolved payload path under
  `%LOCALAPPDATA%\herdr\plugins\rebuildup.artifacts\…`)
  (`z4-02-artifacts-registered`).
- **delete**: row `Delete` → confirmation dialog naming the exact
  artifact id/kind/path + force-ref warning → `Delete` → registry
  back to honest `no artifacts registered — … an empty registry is
  honest, not an error` (`z4-03-artifacts-after-delete`).

### Handoffs — PASS (read + mutation)

Surface renders honest empty state + `PROVIDER RESUME CAPABILITY`
section (`z4-04-handoffs`). Capability probe via `plugin_call
capability` → `herdr-plugins.handoff/v1` v0.6.0, commands
`create/list/status/execute/resume-info/remote-probe/delegate/
merge-back/capability`, `execution:
same_host_and_remote_saved_machines`, lineage model documented —
no `mutation_commands` field, so gating falls back to the
commands allowlist as designed.

Safe mutation: `plugin_call create wY:p1 --strategy
portable_context` → record `ho-mwy8e7bk-d51fff67` (`status:
pending`, transfer identity `host UUU / wY / wY:t1 / wY:p1 /
C:\Users\rebui`, `transfer_check: ok`). After panel refresh the
surface lists the record (`pending portable_context created
2026/11/27 9:16:34 src wY:p1 0 refs`) (`z4-05-handoffs-record`).
`list` returns `total:1`. `execute`/`delegate`/`merge-back` were
NOT fired — they spawn/attach real agents; `create` covers the
mutation path. Record left in plugin state (no delete command
exists in v1).

### Controls — PASS (read + capability gating)

Surface renders per-pane agent rows with real data (`idle wR:p3
seq 33 session turquoise-mavoset`-class fields), OPERATIONS
(`Slash command…`, `Interrupt…`, `Wait now`, `Wait…`), LAUNCH
(`Start agent…` with per-provider option note), and the
structured-dialogs capability line (`approval=unsupported,
question=unsupported, … interactive_fallback=pty_level · upstream
gaps: 5`) (`z4-06-controls`). `capability` via `plugin_call`:
`mutation_commands: ["send","command","interrupt","rename","start"]`,
commands `capability/send/command/wait/interrupt/read/rename/start`,
per-operation API mapping (`agent.prompt`/`agent.wait`/
`agent.send_keys` pty-level/`agent.read`/`agent.rename`/
`agent.start`). Mutations not fired against live panes — gating
visible, contract honored.

### Text Generation — PASS (surface) / generate BLOCKED by provider (documented)

Surface renders provider resolution table (agent path for
claude/codex/gemini/grok/opencode/copilot/droid/kimi/kiro/qwen
manifests; `cli path: unsupported — headless provider CLI subprocess
rejected by ADR-0017`), GUARDS (`expensiveTaskOptIn off`, quota
check disabled via rebuildup.usage, agent manifests queried),
GIT/FORGE CONTEXT resolved via sibling `rebuildup.git` @ pin, and a
working GIT CONTEXT PREVIEW (`branch_name`) (`z4-07-textgen`).
`capability`/`config show` verified via `plugin_call`
(`mutation_commands` includes `generate`; `commands` includes
`capability/generate/git-context/watch-next-prompt/config`).

`generate` mutation attempts (stdin JSON path, `timeout_ms`
600000 — the #458 path) all reached the plugin and returned
structured errors; the dedicated workspaces were cleaned up each
time (`herdr workspace list` confirms no leftovers):

1. default provider resolution → `agent_execution: agent.prompt
   failed: agent_prompt_stalled: … no observed working or blocked
   state within 5000 ms`.
2. `--provider claude` → `agent_blocked: agent
   textgen-thread-title-… is blocked and requires interactive
   input` (fresh workspace agent hits an interactive prompt —
   e.g. trust/onboarding — headlessly).
3. `--provider codex` → `agent entered blocked state during
   generation`.

Assessment: the herdr-t3 side is verified end-to-end (capability
gating, `plugin_call` argv+stdin transport, 600 s ceiling, honest
error surfacing). Successful generation is blocked by provider
agents requiring interactive input in a fresh dedicated workspace
on this host — a plugin/host-data limitation, not a herdr-t3
defect; recorded for upstream follow-up.

### Secrets — PASS (read + gating; value guarantee held)

Surface renders PROVIDER probe (`infisical`,
`https://secrets.rebuildup.dev/api`, `no project id`, `cli infisical
available`, `infisical version 0.45.14`, `reachability
not_checked`), honest empty BINDINGS (`no bindings declared in
config.json on this host`), RESOLVE PREVIEW (metadata-only), and
MUTATIONS disabled until a binding is selected (`z4-08-secrets`).
No value-returning command exists in the contract — honored.

### Machines — **FAIL — defect** (see Defects #1)

Surface opens, renders intro + Refresh, then:
`list failed: error — unexpected argument: --socket` /
`machine list unavailable on this host` (`z4-09-machines`).

Root cause (verified in source): the bridge appends the session
targeting argv `--socket <path>` to EVERY `plugin_call`
(`server/plugins.ts` `pluginTargetArgs`, issue #289 — local hosts
always set `pluginSocket`). `rebuildup.machines@d23205af`
`plugins/machines/src/cli.ts` `list` rejects any argument
(`args[0] !== "--help"` → `fail("unexpected argument: …")`), and
`probe`'s `positional()` counts the `--socket` VALUE as a
positional, so `probe` fails too. `capability` ignores args and
works — which is why the surface can show contract info but never
data. The plugin declares windows support and installs fine; the
CLI simply does not tolerate the CallOptions flags every other
plugin accepts via `packages/herdr-client`. Unchanged upstream at
herdr-plugins HEAD (`d09b48b`) — needs a plugin-side fix (accept
and ignore/pass-through `--socket`/`--session`) or a bridge-side
compat decision. **Machines surface is non-functional at the
frozen pins on every host, not just Windows.**

### MCP — PASS (read-only diagnostics)

Surface renders the MCP tool/diagnostics table with real data:
sibling-plugin integrations (`rebuildup.git/projects/usage/
controls/handoff` all `available via sibling` with contract
versions), per-tool access levels (`read-only`/`supervised`/
`implemented`), DIAGNOSTICS (`read: stable`, `mutation: stable`,
`events: stable`, `remote: excluded_v1 … local stdio only`,
`no durable state in v1`, structured error-code list), contract
`herdr-plugins.mcp/v1 (stable)` v0.7.0 (`z4-10-mcp`). No mutation
commands exist by design — `serve` is never spawned.

## Z4-4 — regression sanity — PASS (one env caveat)

- **Terminal I/O + Unicode**: scratch `wY:p1`, focused
  `.ghostty-input`, `Input.insertText`
  `Write-Output "HT3Z4_B49_OK_日本語_🦀"` + Enter →
  `herdr pane read wY:p1 --source recent --lines 40`
  (`section-z4-pane-read.txt`) shows the marker returned
  byte-correct. `z4-11-ws-tilde`, `z4-12-unicode-io`.
- **verify-reconnect-draft** (#368 win32 path): packaged-sha
  `scripts/verify-reconnect-draft.ts --session ht3draft` from the
  `b49bceb` release checkout via `HT3Z4-Draft`
  (`draft.cmd`/`section-z4-draft.log`): **6/6 PASS** — draft type,
  type-during-outage, draft retained after reconnect, outage input
  never reached pty, explicit Enter sends draft exactly once
  (occurrences 1→2), and this time `draft echoed while connected`
  also passed (the z3 timing flake did not recur). Harness note:
  `workspace cleanup failed … left for manual cleanup` — the
  `ht3draft` isolated session was deleted afterwards.
- **Existing surfaces**: Projects (`no projects registered` honest
  empty + Discover/Register UI, `z4-21-projects`), Checkpoints
  (loading → checkpoint list/diff/compare/maintenance chrome,
  `z4-22-checkpoints`). The 10-tab strip (Conversations, Automations,
  Artifacts, Handoffs, Controls, Text Generation, Secrets, Machines,
  MCP + others) renders scrollable tabs — visible in `z4-18-dark-main`.
  Usage surface was exercised via the context card's embedded
  QUOTA section (real codex `Plus` quota, honest `no_credential`/
  `unsupported` for claude/opencode).
- **Settings modal**: `#/settings` route → modal with General /
  Appearance / Connections / Terminal / Diagnostics / About sections,
  Launch at login, Confirm before closing workspace (`z4-13-settings`).
- **Context card (#406 T3 port)**: `Context card` header trigger on
  `wY` renders the card inline in the workspace canvas — pane
  identity (`wY:p1`, `C:\Users\rebui`, `~`, `Local`, `1 tab · 1
  pane`), Version Control with honest error (`git error: no git
  work tree contains: C:\Users\rebui`), Actions (Details…,
  Source Control, Checkpoints, Copy pane ID, Copy workspace ID),
  and embedded Usage/QUOTA plugin sections (`z4-14-context-card`).
- **Block cursor (#388 follow-ups)**: focused `wY` terminal renders
  the block cursor at the prompt — `z4-19-block-cursor` (dark),
  `z4-20-block-cursor-clip`.
- **Agent shelves (#418 restructure)**: sidebar shows per-section
  dock shelves with live counts (`Done 1`, `Working 9-10`,
  `Idle 1`) in every capture.
- **Pane paste mode-aware (#434) / selection-history (#433/#436)**:
  code paths shipped; not separately exercised headlessly this leg
  (no clipboard/selection automation attempted) — covered by unit
  tests in the delta; noted honestly.

## Z4-5 — visual review capture set

CDP `:9223` packaged-app captures, real default session (scratch
`wY` for I/O/cursor only); all webp verified non-blank via manifest
dimensions (`section-z4-windows/manifest.json`):

| file | content |
| --- | --- |
| `z4-00-main` | main window on arrival, dark — sidebar + shelves + terminal + restored panel tabs |
| `z4-01-artifacts` | Artifacts surface, dark, before mutation |
| `z4-02-artifacts-registered` | register dialog result — `art-575f…` in REGISTRY |
| `z4-03-artifacts-after-delete` | post-delete honest empty registry |
| `z4-04-handoffs` | Handoffs surface, dark, empty state |
| `z4-05-handoffs-record` | created handoff record `ho-mwy8…` listed |
| `z4-06-controls` | Controls surface — ops/launch/gating, dark |
| `z4-07-textgen` | TextGen surface — providers/guards/git-context, dark |
| `z4-08-secrets` | Secrets surface — infisical probe, honest empty bindings |
| `z4-09-machines` | Machines surface — **error state** (`--socket` defect) |
| `z4-10-mcp` | MCP surface — diagnostics/tool table |
| `z4-11-ws-tilde` | `~` workspace terminal view |
| `z4-12-unicode-io` | Unicode/emoji I/O output, dark |
| `z4-13-settings` | Settings modal (General) |
| `z4-14-context-card` | context card inline in canvas, dark |
| `z4-15-light-main` | main window, **light** theme |
| `z4-16-narrow` | narrow layout at app-enforced min-width 960 px (see Defects #3) |
| `z4-18-dark-main` | final dark state — all 10 surface tabs in strip |
| `z4-19-block-cursor` / `z4-20-block-cursor-clip` | block cursor, dark |
| `z4-21-projects` / `z4-22-checkpoints` | regression surfaces |

## Defects / observations

1. **Machines surface non-functional at frozen pins (product/plugin
   defect, all platforms)**: `plugin_call … machines list` fails
   `unexpected argument: --socket` because the bridge always appends
   `--socket <path>` (`server/plugins.ts:691`) and
   `rebuildup.machines@d23205af` `cli.ts` rejects/positional-miscounts
   it for both `list` and `probe`. Repro: open Machines surface on
   any host, or `plugin_call rebuildup.machines list`. Fix belongs
   plugin-side (tolerate CallOptions flags) — unchanged at
   herdr-plugins HEAD.
2. **textgen `generate` cannot complete on this host**: agent-path
   generation spawns dedicated-workspace agents that land in
   interactive-blocked states (claude trust/onboarding, codex
   blocked) — honest structured errors, workspaces cleaned up.
   Host/provider-data limitation; herdr-t3 transport verified.
3. **External window resize broken on this host (environment, NOT a
   b49bceb regression)**: any programmatic `MoveWindow`/
   `SetWindowPos` on the packaged window sets height to 32767/65535
   (width clamps to the app's `minWidth: 960` correctly). A/B tested
   against the still-installed `ab0ca3d` build — identical behavior,
   so it is a host/session-geometry quirk (the interactive session's
   display metrics; sshd sessions see a separate 1024×768 virtual
   desktop). Narrow evidence was captured at the enforced minimum
   960 px width (which is inside the app's `max-width: 980px` narrow
   breakpoint) via a clipped screenshot; a true ~480 px viewport is
   unattainable — the app enforces `minWidth: 960`
   (`desktop/main.ts:173`). z3 captured 960×892 on the same host
   earlier, so the resize path itself worked then; recorded as env
   drift, not product.
4. **`herdr` mise shim still broken** (carried from z2/z3): resolved
   `herdr.exe` used directly everywhere.
5. **ssh-launched app instances are reaped**: `Start-Process` from
   sshd puts the app in the sshd virtual desktop and it dies with
   the session; `schtasks /it` is required for persistent launches.
6. **CDP notes**: `Emulation.setDeviceMetricsOverride` does not
   resize the windowed Electron viewport (innerWidth unchanged);
   `Page.captureScreenshot` needed `clip` for the narrow capture
   because the broken-height window reports a 32759 px viewport.

## Final machine state

- `current` = `b49bcebb3d7762cae97edf9d2f50e42443de0a4f`,
  `previous` = `ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`; app left
  running the clean packaged `b49bceb` exe via `launch.ps1` +
  `HT3Z4-Debug` CDP instance — **CDP 9223 was closed at leg end**
  (debug instance killed; relaunched clean via `launch.ps1` —
  see below). Plugins: **14 installed+enabled** at contract pins.
- Workspaces: `restro-pv` (`wR`), `~` (`wY`); scratch artifacts
  register/delete round-tripped clean; handoff record
  `ho-mwy8e7bk-d51fff67` remains in plugin state (no delete in v1);
  `ht3draft` session deleted; no leftover textgen workspaces.
- schtasks `HT3Z4-*` left registered — harmless one-shot tasks,
  same convention as prior legs. On-machine originals/logs:
  `C:\Users\rebui\ht3-z4\` (update/verify/launch/draft/narrow logs,
  CDP js/ts drivers, png captures, plugin-list-win.json).
