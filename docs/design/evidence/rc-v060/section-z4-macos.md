# RC v0.6.0 — Section Z4: macOS final-candidate leg at b49bceb

Date: 2026-11-27 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4, Electron 45.4.1.

Candidate: **`b49bcebb3d7762cae97edf9d2f50e42443de0a4f`** —
`origin/release-0-6-0` head at freeze. Shipped delta vs the
section-z3 candidate `ab0ca3d` (51 commits): eight new right-panel
surfaces (artifacts, handoffs, controls, textgen, secrets, machines,
mcp — conversations/usage verified in z3), plugin mutations
(handoff execute/delegate/merge-back #451, artifacts
register/delete/deliver/gc #455, textgen generate #454 + `plugin_call`
stdin/600 s ceiling #458), settings modal, pane context card T3 port
(#390/#406), mode-aware pane paste (#434), selection-history binding
(#433/#436), and bridge/terminal follow-ups (herdr-bridge Rust RPC
transport, terminal-render/surface crates, block cursor follow-ups).

Screenshots: `section-z4-webp/` (webp via `cwebp -q 85`; raw png
captures local-only, `/tmp/z4-shots/`). Plugin list:
`section-z4-plugin-list.txt`.

**Session isolation**: all plugin/surface/mutation verification ran
against a dedicated isolated herdr session `ht3z4`
(`HERDR_SOCKET=~/.config/herdr/sessions/ht3z4/herdr.sock`, workspaces
`w1` "~" and `w2` "HT3Z4-Repo" with cwd
`/Users/rebui/work/herdr-t3-z4`). The user's live default session was
not touched; plugin installs are global herdr state (same as z3).
Evidence work ran in the `herdr-t3-z4` worktree; the main checkout
was not modified.

## Z4-1 — frozen-SHA install + launch smoke: PASS

`components/herdr-t3/update.sh
b49bcebb3d7762cae97edf9d2f50e42443de0a4f` (positional SHA arg) from
`/tmp/pc-setup-rc`: reuse of the existing release clone → `mise
install --locked` → `bun install --frozen-lockfile` → `desktop:pack` →
staged to `~/Applications/herdr-t3.app`. `update.sh` recorded
`previous=ab0ca3d47c13a6874286895f7c6ef5fe86d0186e`,
`current=b49bcebb3d7762cae97edf9d2f50e42443de0a4f`.

Commit stamp 3-path check — consistent:

- install log: `installed b49bcebb3d7762cae97edf9d2f50e42443de0a4f`
- `app.asar` contains `b49bceb` (5 matches)
- runtime log: `"version":"0.6.0","commit":"b49bceb"` on `app.ready`
  (pid 86211, then relaunched instances)

`verify.sh --live`: **fully PASS — including the Spotlight leg**,
which env-failed in sections z/z2/z3/j on this host (mdfind resolved
`com.github.rebuildup.herdr-t3` to `~/Applications/herdr-t3.app`
within the 60 s poll this time). Live layers: app process running,
default herdr socket present, `bridge-status.json` fresh
`ok:true` via the session socket under test.

Launch smoke: packaged app launched with
`HERDR_SOCKET=<ht3z4 sock> --remote-debugging-port=9223`; CDP page
live, `app.asar/dist/index.html` loaded, sidebar lists the isolated
session's workspaces; `bridge-status.json` reported `ok:true`
"2 panes, 2 workspaces" via the ht3z4 socket.

## Z4-2 — plugin set: 14/14 enabled at contract pins: PASS

The device had the z3 set (7 plugins). Installed the seven missing
pins from `docs/migration/contracts/plugins-boundary.md` @ b49bceb
(all `d23205af0cd2ff7dba25f72e1f3b872762a108ee`):

```
herdr plugin install rebuildup/herdr-plugins/plugins/<name> \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee -y
```

for `artifacts`, `handoff`, `textgen`, `controls`, `secrets`,
`machines`, `mcp`. `herdr plugin list` now reports **14 plugins
installed, all enabled** at the pinned commits (inbox
`414e87de` v0.1.0, git `d0578307`, projects `2dcb2abf`, checkpoints
`ae4f214c`, automations `6c1cfa50`, and conversations/usage/
artifacts/handoff/textgen/controls/secrets/machines/mcp all
`d23205af`) — saved as `section-z4-plugin-list.txt`.

Enabled state persists across app relaunch: the packaged app was
relaunched four times during the leg (crash recovery + session-server
restart) and every surface kept rendering plugin data; `herdr plugin
list` still shows 14/14 enabled. **Left installed+enabled** —
normal-use environment.

## Z4-3 — delta E2E (packaged app, CDP :9223, isolated session ht3z4)

All fifteen right-panel surfaces were opened as docked tabs on `w2`
via the "+" add-surface menu (scrollable tab strip;
`z4-macos-panel-all`). Per-surface results:

### artifacts: PASS (mutations exercised)

Renders the `rebuildup.artifacts` v1 registry honestly: empty state
copy ("no artifacts registered … an empty registry is honest, not an
error"), `Register…`/`GC…`/`Refresh`/`Search`/`Verify` controls gated
on the advertised `mutation_commands: [register, delete, deliver,
gc]`.

Mutation round-trip via UI:

1. `Register…` dialog → path `/tmp/z4-artifact-fixture.html`
   (121 B html fixture), title `z4-fixture` → result
   `art-c5cd6646fa261761f80ab1e0`, `state_copy` into plugin state.
2. Registry lists the artifact (kind html, size, resolved path,
   "render isolation required … never rendered inline").
3. `Delete` → confirm dialog ("state_copy payloads are deleted …
   path_ref external files are NEVER removed") → record gone;
   verified via plugin CLI `list` (`total: 0`) and empty
   `~/.local/state/herdr/plugins/rebuildup.artifacts/artifacts/`.

`Deliver…`/`GC…` present but not exercised (deliver prompts an
agent/pane; gc is housekeeping — gating verified, register+delete
cover the mutation path). Evidence: `z4-surface-artifacts`,
`z4-artifacts-registered`, `z4-artifacts-deleted`, dialog captures.

### handoffs: PASS (mutation exercised, record-only)

Renders `rebuildup.handoff/v1 v0.6.0` records with status lifecycle,
`execution: same_host_and_remote_saved_machines`. `create` is
agent-side per contract, so a record was seeded via the plugin CLI
against the isolated session:

```
cd <plugin_root> && env -u HERDR_SOCKET_PATH \
  bun run src/cli.ts create w2:p1 --note "z4 verification handoff" \
  --socket ~/.config/herdr/sessions/ht3z4/herdr.sock
→ ho-mwy8a2qc-1f8a7316 (pending, portable_context, src w2:p1)
```

Surface lists it; selecting the record opens Record detail with
`Execute`/`Delegate` offered — capability gating works through the
`commands`-allowlist fallback (the pinned plugin predates
`mutation_commands`; `execute`/`delegate`/`merge-back` are top-level
`commands`, so they are correctly offered).

Mutation exercised: `Delegate` → dialog → **"Record intent only —
skip the execute/delivery pipeline"** checked → `delegate →
recorded`: child `ho-mwy8jdby-22647340` (`subagent_spawn`, parent
`ho-mwy8a2qc-1f8a7316`) appears in the list; parent shows `1 child`.
This drives the real `plugin_call delegate` mutation path without
spawning an agent. `Execute`/`Merge back` share the same gated code
path; `execute` was not run because it `agent.start`s a real provider
agent (heavyweight, out of scope for a "safe" mutation). Residue:
the two handoff records persist in plugin state (the contract has no
delete command); they reference only the throwaway ht3z4 session.
Evidence: `z4-surface-handoffs-record2`, `z4-handoffs-detail3`,
`z4-handoffs-delegate-result`, `z4-handoffs-after-delegate`.

### controls: PASS (read + gating; no safe mutation target)

Renders `herdr-plugins.controls/v1 v0.6.0` · `mutation_commands:
send, command, interrupt, rename, start` · 24 providers, upstream
capability gaps honestly disclosed (approval/question/attachments/
goals/subagent_approvals unsupported → pty_level fallback). The
isolated session has shell panes only → "no agents in the snapshot"
empty state plus the `Start agent…` launch section (per-provider
launch options). No mutation exercised: every mutation targets an
agent pane and none exists; starting an agent was out of scope.
Evidence: `z4-surface-controls`.

### textgen: PASS (capability gating verified; generate gated off)

Renders the task registry (thread_title, branch_name, commit_message,
pr_content, review_guide, next_prompt) with per-task providers
(agent/api) and I/O contracts. `GENERATE` is **gated off** with the
honest reason "generate is not in this host's mutation_commands (or
not allowlisted client-side)". Verified against the plugin directly:
`capability` advertises `commands: [capability, generate,
git-context, watch-next-prompt, config]` but **no
`mutation_commands` field** — so the surface correctly refuses to
offer the mutation (contract: unadvertised commands are never
offered). Consequence: the `plugin_call` stdin + 600 s timeout path
(#458) is not exercisable through the UI on this host — disclosed,
not a defect of the gating itself. Evidence:
`z4-surface-textgen`.

### secrets: PASS (honest gate)

Renders `herdr-plugins.secrets/v1` · plugin v0.1.1: provider probe is
real (`infisical` CLI 0.45.14 available, `https://secrets.rebuildup.dev/api`
reachable, "no project id", `reachability: not_checked`). No bindings
are declared in `config.json` on this host → BINDINGS empty and
`inject`/`run` mutations disabled with "select at least one binding"
— correct gating, values never displayed. Mutations not exercised
(no bindings configured; resolve is metadata-only by contract).
Evidence: `z4-surface-secrets`.

### machines: FAIL — defect (see Defects #1)

Surface renders its header and contract line but the list call fails:
"list failed: error — unexpected argument: --socket / machine list
unavailable on this host". Reproduced directly against the pinned
plugin: `bun run src/cli.ts list` works (`total: 3` machines) while
`list --socket <path>` returns
`{"ok":false,"error":{"code":"usage","message":"unexpected argument: --socket"}}`.
herdr-t3 forwards `--socket PATH` to every plugin CLI on local hosts
(plugins-boundary contract, issue #289), so every machines contract
call fails on this host. Cross-repo incompatibility between
`rebuildup.machines@d23205af` and the boundary contract.
Evidence: `z4-surface-machines`.

### mcp: PASS (read-only by design)

Renders `herdr-plugins.mcp` diagnostics: session target resolved via
socket to the ht3z4 socket and reachable; access-level ladder
(read-only/supervised/full) with t3 mapping; 24-tool table; explicit
copy that `serve` is never spawned and MCP tools never invoked.
Evidence: `z4-surface-mcp`.

### usage (re-check): PASS

Same real plugin data as z3: claude `credential_expired`, codex `ok`
plan Plus Session 0% / Weekly 77% with reset timestamps, opencode
`unsupported` — honest upstream states, `mutation_commands: []` →
only `Refresh` offered.
Evidence: `z4-surface-usage`.

## Z4-4 — regression sanity: PASS (one defect disclosed)

- **Terminal I/O + Unicode**: focused `.ghostty-input` on `w2:p1`,
  `Input.insertText` `echo HT3Z4_$((6*7)); echo
  こんにちは-テスト-Z4` + Enter → `herdr --session ht3z4 pane read
  w2:p1` shows `HT3Z4_42` and `こんにちは-テスト-Z4` — real bytes
  through the packaged attach/input path incl. Unicode
  (`z4-io-term`).
- **Block cursor**: `.ghostty-canvas.is-overlay` pixel check — 480
  opaque px in a 15×32 device-px bbox, solid `rgb(180,203,255)`
  (identical signature to z3). `z4-macos-blockcursor-ws`,
  `z4-macos-blockcursor-clip`.
- **Reconnect-draft invariant**: `verify-reconnect-draft.ts
  --session ht3z4draft` run from the b49bceb release checkout —
  **6/6 PASS** (draft type, echo while connected, type during outage,
  draft retained after reconnect, outage input never reached pty,
  explicit Enter sends draft `occurrences 1 -> 2`). Isolated session
  and throwaway workspace auto-closed by the harness.
- **Existing surfaces**: all render real plugin data on the isolated
  session — Git (`detached HEAD`, `0 changed`, linked worktree
  `/Users/rebui/work/herdr-t3-z4`), Projects (honest empty +
  Discover/Register), Project Scripts (real run history),
  Checkpoints, Worktrees (real list), Automations ("no scheduled
  tasks"), Conversations (indexed claude fixture persisted across
  reinstall), Usage. Evidence: `z4-surface-*`.
- **Settings modal**: palette `Open settings` → `#/settings` with
  General/Appearance/Connections/Terminal/Diagnostics/About sections.
  Save verified: toggling "Confirm before closing workspace" wrote
  `{"confirmCloseWorkspace":true}` to
  `localStorage["herdr-t3:settings:general"]`, reverted to `false`;
  Launch-at-login untouched. Evidence: `z4-settings-modal2`,
  `z4-settings-saved`.
- **Pane context card (#406 T3 port)**: `button[aria-label="Context
  card"]` (renamed from z3's "Pane context") opens the card — real
  data only: pane `w2:p1`, cwd `/Users/rebui/work/herdr-t3-z4`,
  workspace `HT3Z4-Repo` · Local · `1 tab · 1 pane`, Version Control
  `HEAD (detached)` / `working tree clean`, Actions `Details…`,
  `Source Control`, `Checkpoints`, `Copy pane ID`, `Copy workspace
  ID`. Evidence: `z4-context-card2`.
- **Paste mode-aware (#434)**: paste routes through
  `onPasteText` → `pane.send_text` (PaneTerminal.tsx). Live repro:
  multiline paste arrived **unbracketed** — first line executed,
  consistent with raw-byte delivery. Code-verified upstream gap:
  herdr `handle_pane_send_text` sends `Bytes::from(params.text)`
  verbatim (src/app/api/panes.rs); `\x1b[200~…\x1b[201~` wrapping
  exists only in `encode_api_text`, used by `pane.send_input`
  (src/app/api_helpers.rs) — which is not in the app's RpcMethod
  allowlist (shared/protocol.ts). See Defects #2.
  Evidence: `z4-paste-term`.

## Z4-5 — visual review capture set

Comprehensive packaged-app captures (CDP `:9223`, isolated session
ht3z4; throwaway workspaces only):

| file | content |
| --- | --- |
| `z4-macos-01-main-dark` | main window, dark — sidebar + terminal, isolated session |
| `z4-macos-02-light` | same chrome, light theme |
| `z4-macos-08-narrow` / `z4-macos-09-narrow-sheet` | ~480 px viewport + sidebar sheet (CDP device-metrics emulation) |
| `z4-macos-panel-all` | right panel docked with all 15 surface tabs (scrollable strip) |
| `z4-surface-git` … `z4-surface-mcp` | each right-panel surface (15) |
| `z4-surface-handoffs-record2` / `z4-handoffs-detail3` | handoff record + detail with gated Execute/Delegate |
| `z4-handoffs-delegate-result` | delegate record-only mutation result |
| `z4-artifacts-registered` / `z4-artifacts-deleted` | artifacts mutation round-trip |
| `z4-context-card2` | T3 context card popover/inline card |
| `z4-settings-modal2` / `z4-settings-saved` | settings modal + persisted toggle |
| `z4-macos-blockcursor-ws` / `-clip` | terminal with block cursor |
| `z4-io-term` | Unicode I/O round-trip output |
| `z4-paste-term` | post-paste terminal state |

## Defects / disclosures

1. **Machines surface unusable — `--socket` argument rejected**
   (cross-repo, blocks `machines/v1` consumption). herdr-t3 forwards
   `--socket <path>` to plugin CLIs on local hosts; the pinned
   `rebuildup.machines@d23205af` `list`/`probe` CLIs reject it
   (`unexpected argument: --socket`). Repro:
   `cd ~/.config/herdr/plugins/github-installations/rebuildup.machines-*/…/plugins/machines &&
   bun run src/cli.ts list --socket ~/.config/herdr/herdr.sock` →
   `{"ok":false,"error":{"code":"usage","message":"unexpected
   argument: --socket"}}`; without `--socket`, `list` returns
   `total: 3`. Either the plugin must accept `--socket` (contract
   expectation, issue #289) or the boundary must scope the flag per
   contract. All other six new surfaces accept `--socket` fine.
2. **Paste mode-awareness (#434) is inert on herdr 0.9.5** —
   `pane.send_text` does not wrap `\x1b[200~…\x1b[201~`; only
   `pane.send_input` does (upstream `encode_api_text`), and
   `pane.send_input` is not in the app's allowlist. Effect: paste is
   always delivered unbracketed, so on panes that enabled mode 2004
   (agent TUIs) a multiline paste is not delivered as one bracketed
   paste — the bug #434 set out to fix persists for mode-on panes.
   `docs/design/terminal-io.md` §6 asserts `pane.send_text` wraps per
   pane mode; that premise does not hold on herdr 0.9.5 or current
   upstream master. Mode-off panes see standard unbracketed-paste
   semantics (documented as acceptable). Needs either an upstream
   herdr change or an app-side switch to an encoding path that
   brackets.
3. **Packaged app instability on this host (env, recurring)**:
   the app exited once mid-leg (GPU process `abnormal-exit 512`, no
   `DiagnosticReports` crash entry; same unexplained-exit pattern as
   z3's two), and twice presented a wedged `about:blank` renderer /
   unresponsive CDP endpoint requiring relaunch. The isolated
   session's herdr server also wedged once (recurring "timed out
   reading api request" → bridge `write EPIPE` until restart). All
   recovered on relaunch; host was under heavy load (concurrent
   Rust builds from other agents, disk ~93% full). Not reproduced as
   an app logic defect; disclosed for the record.
4. **textgen `generate` gated off** — the pinned plugin does not
   advertise `mutation_commands`, so the surface correctly refuses
   the mutation; the stdin/600 s `plugin_call` path (#458) is
   therefore untested end-to-end on this host. If the contract
   intends `generate` to be mutable, the plugin should advertise it.
5. **Handoff mutation coverage**: `delegate` exercised via
   record-only; `execute`/`merge-back` share the gated path but were
   not run (they spawn real agents / need a parent-child execute
   chain). Two test records remain in plugin state (no delete in
   contract).
6. Controls/secrets/machines mutations not exercised for lack of a
   safe target (no agents, no secret bindings, machines surface
   broken by defect #1).

## Cleanup

- Isolated sessions: `ht3z4draft` torn down by the harness
  (throwaway workspace auto-closed); `ht3z4` server stopped after
  the leg, its two throwaway workspaces (`~`, `HT3Z4-Repo`) removed
  with it.
- App: debug-port instance killed; clean packaged app relaunched via
  `launch.sh` (default session, no debug port).
- Artifacts fixture: registered artifact deleted through the UI
  (state_copy payload removed); `/tmp/z4-artifact-fixture.html`
  removed with `/tmp/z4-shots` raw pngs retained locally per leg
  convention.
- Plugins: all 14 left installed+enabled at pins (normal-use env).
- Handoff test records `ho-mwy8a2qc-1f8a7316` /
  `ho-mwy8jdby-22647340` remain in plugin state (no delete command;
  they reference only the removed ht3z4 session).
- Not touched: the user's live default herdr session (read-only
  sidebar data was never mutated), Windows-side work, other agents'
  worktrees/sessions, the main `~/work/herdr-t3` checkout.
