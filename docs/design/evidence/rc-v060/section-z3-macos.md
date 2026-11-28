# RC v0.6.0 — Section Z3: macOS final-candidate convergence leg (issue #357 follow-up)

Date: 2026-11-27 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4, Electron 45.4.1.

Candidate: **`ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`** —
`origin/release-0-6-0` head at freeze. Shipped delta vs the
section-z2 candidate `9bb50cf`: #384 (`herdr-bridge` Rust RPC
transport + `BridgeSession` snapshot stream/subscription supervisor),
#388 (terminal block cursor + `cursor-color`/`cursor-text`),
#391+#383 (sidebar agent shelves progressive disclosure + info dedup),
#395 (Usage surface via `herdr-plugins.usage/v1` @ `d23205af`),
#397 (pane context card, #390), #392 (ssh preamble strip,
server-side).

Screenshots: `section-z3-webp/` (webp via `cwebp -q 85`; raw png
captures local-only, `/tmp/z3-shots/`). Plugin list:
`section-z3-plugin-list.txt`.

## Z3-1 — frozen-SHA install + launch smoke: PASS (Spotlight leg env-FAIL)

`components/herdr-t3/update.sh
ab0ca3d47c13a6874286895f7c6ef5fe86d0186e` (positional SHA arg) from
`/tmp/pc-setup-rc`: reuse of the existing release clone → `mise
install --locked` → `bun install --frozen-lockfile` → `desktop:pack` →
staged to `~/Applications/herdr-t3.app`. `update.sh` recorded
`previous=9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`,
`current=ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`.

Commit stamp 3-path check — consistent:

- install log: `installed ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`
- `app.asar` contains `ab0ca3d` (5 matches)
- runtime log: `"version":"0.6.0","commit":"ab0ca3d"` on `app.ready`

`verify.sh --live`:

- installed/commit/bundle-id legs: **PASS**
- **Spotlight leg: FAIL — same known environment/indexing issue as
  section-z/z2/j** (mdfind/mdimport never ingest the app within 60 s;
  `lsregister` fallback still the suggested pc-setup follow-up).
- Live layers verified manually (all green): app process running
  (pid 61766, `--remote-debugging-port=9223`), default herdr socket
  present, `bridge-status.json` fresh `ok:true` "10 panes, 10
  workspaces" via `~/.config/herdr/herdr.sock` — the packaged app's
  new `BridgeSession` path (#384) connects to the live default
  session.

Launch smoke: CDP page target live on `:9223`,
`file:///…/app.asar/dist/index.html` loaded, workspace list and
agent shelves populated from the default session.

## Z3-2 — plugin set: 7/7 enabled at contract pins: PASS

`rebuildup.usage` was the only missing plugin. Installed at the pin
from `docs/migration/contracts/plugins-boundary.md`
(`d23205af0cd2ff7dba25f72e1f3b872762a108ee`; plugin manifest versions
`0.5.0`, contract `herdr-plugins.usage/v1`):

```
herdr plugin install rebuildup/herdr-plugins/plugins/usage \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee --yes
```

→ enabled. `herdr plugin list` now reports **7 plugins installed,
all enabled** (inbox, git, projects, checkpoints, automations,
conversations, usage) — saved as `section-z3-plugin-list.txt`.
**Left installed+enabled** — normal-use environment.

## Z3-3 — delta E2E (packaged app, CDP :9223)

### #384 bridge/attach + terminal I/O: PASS

- App boot attaches the default session through the new bridge path:
  sidebar lists all 11 workspaces, `bridge-status.json` reports
  `ok:true` "10 panes, 10 workspaces".
- Terminal I/O round-trip on throwaway workspace `HT3Z3-Verify`
  (wMT, pane `wMT:p1`, cwd `/tmp`, closed afterwards): focused
  `.ghostty-input`, `Input.insertText`
  `echo HT3Z3_$((6*7)); echo こんにちは-テスト` + Enter →
  `herdr pane read wMT:p1` shows `HT3Z3_42` and `こんにちは-テスト`
  — real bytes through the packaged attach/input path including
  Unicode (`z3-io-term`, `z3-10-blockcursor-ws`).
- `verify-reconnect-draft` **6/6 PASS** on this SHA (isolated session
  `ht3z3draft`, self-contained bridge `:4788` + vite `:5788` + CDP
  `:9341`; throwaway workspace auto-closed): draft type, echo while
  connected, type during outage, draft retained after reconnect,
  outage input never reached pty, explicit Enter sends draft
  (`occurrences 1 -> 2`). The z2 load-fragility did not recur —
  host load was lower this leg. Script run from the ab0ca3d release
  checkout with only the Chrome-endpoint wait widened 60→300×200 ms
  (untracked `zz-` copy, removed after the run; headless Chrome cold
  start still exceeds the stock 12 s budget under load).

### #388 block cursor: PASS

- zsh pane (`wMT:p1`) renders the Ghostty block cursor. Pixel-level
  verification on the packaged app: the `.ghostty-canvas.is-overlay`
  2d canvas contains exactly 480 opaque pixels in a 15×32 device-px
  bbox — one full character cell filled solid `rgb(180,203,255)`
  (theme cursor colour), i.e. an opaque block, not a bar/underline.
- Visual evidence: `z3-11-blockcursor-clip` (2× clip of the prompt
  line), `z3-10-blockcursor-ws`.

### #391/#383 agent shelves + dedup: PASS

- Shelves render as collapsible bottom sections with counts:
  `Working 11`→`12`, `Idle 1` during the leg (counts track live
  agents). Attention/Done/Snoozed/Settled sections render only when
  non-empty — none were populated, so Attention dominance could not
  be exercised live (code path: Attention is uncapped per
  `UNCAPPED_AGENT_SECTIONS`; disclosed, not a defect).
- Collapse/expand verified via `aria-expanded` toggling on the
  shelf header buttons; capped shelves show
  `AGENT_SHELF_INITIAL_VISIBLE` (10) rows with `Show 1 more`
  disclosure (`AGENT_SHELF_PAGE` 25).
- Dedup (#383): agent rows read `workspace · machine` + single
  status word + agent title (e.g. `ae-a8n · Local` `working`
  `devin: https://github.com/ido-bata/…`) — no repeated state text;
  status details live only in the hover card.

### #395 Usage surface: PASS

Opened via command palette (`Cmd+K` → `Usage`, command id
`panel-usage`) on workspace `wK3`; renders real plugin data:

- `claude`: `credential_expired` — "Claude OAuth token expired at
  2026-11-25T13:31:20.781Z; token refresh is out of scope",
  `no quota data — credential_expired` (honest upstream state).
- `codex`: `ok`, plan `Plus`, Session 35% / Weekly 76% with real
  reset timestamps, `1 reset credit`, `checked 2026/11/27 1:04:31`.
- `opencode`: `unsupported` — "auth.json stores per-provider API
  keys; no subscription quota artifact exists" (honest).
- Header copy states figures are plugin-reported and estimated cost
  is a list-price estimate, never a bill. The plugin advertises
  `mutation_commands: []` and the surface offers only `Refresh` —
  no mutation affordance exists to gate.
- Evidence: `z3-surface-usage`, `z3-panel-all`.

### #397 pane context card: PASS

`button[aria-label="Pane context"]` in the workspace header opens
the popover (`aria-expanded=true`). On `wMT:p1` it shows real data
only: Agent `Unknown`, `wMT:p1`, `/private/tmp`; Workspace
`HT3Z3-Verify`, `Local`, `1 tabs · 1 panes`; Process `shell pid
84148`, `84148 -zsh`; Actions `Details…`, `Source Control`,
`Checkpoints`, `Copy pane ID`, `Copy workspace ID`; and the `Choose
what to show` per-item disclosure. No fabricated fields.
Evidence: `z3-context-card`.

### #392 ssh preamble strip: N/A (noted)

Server-side Windows exec path only; this leg is local macOS. The
change does not touch the local attach path verified above.

## Z3-4 — regression smoke: PASS

- **Git surface (existing)**: opened `Source Control · wK3:p1` on the
  real `~/work/herdr-t3` checkout — real data: `detached HEAD`,
  `7 changed` (3 unstaged + 4 untracked), file list with per-file
  `Stage` actions, diff view, Changes/Commit/History/Compare/Sync/PRs
  tabs. Mutation buttons present but not exercised.
  Evidence: `z3-surface-git`, `z3-panel-git`.
- **Conversations surface (existing)**: tab renders the indexed
  session list including the z2-leg claude fixture
  (`claude:f2da40f1-…`, `/Users/rebui/work/herdr-t3`, `3 events`,
  `wMR:p1`) — plugin state persisted correctly across the app
  reinstall.
  Evidence: `z3-surface-conversations`.
- All eight right-panel surfaces opened as docked tabs on `wK3`:
  Source Control, Projects, Project Scripts, Checkpoints, Worktrees,
  Automations, Conversations, Usage — each renders its own header
  and plugin-driven content (`z3-surface-*`, `z3-panel-all`).

## Z3-5 — visual review capture set

Comprehensive packaged-app captures (CDP `:9223`, real default
session; throwaway workspace `HT3Z3-Verify` used only for the I/O
and cursor shots, closed afterwards):

| file | content |
| --- | --- |
| `z3-01-main-dark` | main window, dark — sidebar + agent shelves + terminal, 2-tab strip |
| `z3-02-light` | same chrome, light theme |
| `z3-surface-git` … `z3-surface-usage` | each right-panel surface (8) |
| `z3-panel-all` / `z3-panel-git` | full panel with all surface tabs |
| `z3-context-card` | pane context card popover open |
| `z3-agent-hover` | agent row hover card (glass tooltip, real facts) |
| `z3-08-narrow` / `z3-09-narrow-sheet` | ~480 px viewport + mobile sidebar sheet (CDP device-metrics emulation) |
| `z3-10-blockcursor-ws` / `z3-11-blockcursor-clip` | terminal with block cursor |
| `z3-io-term` | Unicode I/O round-trip output |

## Defects / disclosures

1. **Stray input during first I/O attempt (disclosed, benign)**: the
   first `Input.insertText` ran while the app still had workspace
   `wMQ` ("herdr-t3 minifixes", a live devin agent pane) focused —
   navigation via a synthetic `.click()` had not yet taken effect.
   The text `echo HT3Z3_$((6*7)); echo こんにちは-テスト` was
   submitted to that agent as a prompt; the agent answered it as a
   trivial shell check ("Shell encoding/arithmetic both fine") and
   continued its work — no state damage. The verified I/O round-trip
   was then re-run on the throwaway workspace after confirming herdr
   focus (`wMT:p1`). Harness lesson recorded: always assert the
   app's focused pane before typing.
2. **Packaged app exited twice mid-leg** (no `DiagnosticReports`
   crash entry for herdr-t3; `current`/`previous` and the bundle
   were untouched). Relaunched with the same command each time;
   captures resumed. Cause not determined — possibly an external
   quit (another local agent runs pc-setup legs on this host).
3. **verify.sh Spotlight leg**: still env-fails on this host (repeat
   of section-j/z/z2); `lsregister -dump` fallback remains the
   suggested pc-setup fix.
4. Attention-shelf dominance not exercised (no attention agents
   live); collapse/expand and counts verified on Working/Idle.
5. The unrelated dirty working tree in `~/work/herdr-t3` (context
   card rework by another agent) was observed via the Git surface —
   evidence work was done in the `herdr-t3-z3` worktree; the main
   checkout was not touched.

## Cleanup

- Throwaway fixtures removed: herdr workspace `HT3Z3-Verify` (wMT,
  tabs t1+t2, panes `wMT:p1`/tab-2 pane) closed via
  `herdr workspace close`; isolated session `ht3z3draft` server
  stopped, its throwaway workspace auto-closed by the harness.
- The `rebuildup.conversations` index retains the stale z2 fixture
  record (honest lifecycle, same as z2).
- Plugins: all seven left installed+enabled at pins (normal-use
  env).
- Processes: debug-port app instances killed after captures; clean
  packaged app relaunched via `launch.sh` (no debug port). Patched
  draft-verify script copy removed from the release checkout.
- Not touched: Windows-side work, perf benches, other agents'
  worktrees/sessions, the user's live default session beyond the
  plugin install, the throwaway workspace above, and the single
  disclosed stray prompt.
