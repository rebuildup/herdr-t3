# RC v0.6.0 — Section J: macOS panel-surface re-verification (issue #333 follow-up)

Date: 2026-11-26 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4. Worktree `/Users/rebui/work/herdr-t3-j`.

Candidate: `e8a2b7b728aef8eec20de894646f0ed9ec71be30`
(`origin/release-0-6-0` head at leg start; includes PR #344 — plugin
surfaces moved from modal dialogs to the docked right-panel host —
plus #311/#335 agent-icon manifest unification and #328 goto-picker
model port). Section-i verified the *dialog* containers of the same
surfaces; this leg re-verifies the shipped panel implementation.

## Release-head delta during the leg

`origin/release-0-6-0` moved to `91a2e39` before this leg finished.
Delta `e8a2b7b..91a2e39`: `f44051e` terminal-core unsafe/FFI hardening
(`crates/terminal-core/src/engine.rs` — the Rust GPUI-migration crate,
not part of the packaged Electron/`desktop:pack` path), plus docs and
section-i Windows evidence merges. The packaged surface under test is
unchanged between the two SHAs; all results below are for `e8a2b7b`.

## J-1 — candidate install: PASS (with env notes)

- `components/herdr-t3/install.sh e8a2b7b…` (positional ref; `-Ref`
  is not a flag — first attempt failed fast on arg parsing, no state
  changed). First real attempt failed inside `mise install --locked`:
  user-global `~/.config/mise/config.local.toml` pins
  `github:rebuildup/skill-graph@0.3.0`, which is not in the repo
  lockfile. Worked around with `MISE_CONFIG_DIR=/tmp/ht3j/misecfg`
  (empty dir) so only repo `mise.toml` (bun 1.4.4, node 24 — both
  already installed) applied. **pc-setup follow-up candidate:** the
  installer is fragile to user-global mise pins; consider documenting
  or isolating `MISE_CONFIG_DIR` in `install.sh`.
- Commit stamp 3-path check: install log `installed
  e8a2b7b728aef8eec20de894646f0ed9ec71be30`, `app.asar` contains
  `e8a2b7b`, runtime log
  `~/Library/Application Support/herdr-t3/logs/*.log` reports
  `"version":"0.6.0","commit":"e8a2b7b"`. Consistent.
- `verify.sh --live`: **FAIL on the Spotlight leg only** —
  `mdfind "kMDItemCFBundleIdentifier == 'com.github.rebuildup.herdr-t3'"`
  returns nothing; `mdls` shows the bundle is not in the Spotlight
  index at all (`kMDItemFSName = null`). Environment/indexing issue,
  not an app defect: `mdimport -t -d2` proves the attribute extracts
  correctly, `lsregister -dump` shows `~/Applications/herdr-t3.app`
  registered as `com.github.rebuildup.herdr-t3` v0.6, and two stale
  shadow registrations were cleaned during diagnosis (gitignored
  `release/` artifact in the main checkout — removed; old accept-test
  copy under `~/.cache/ovis-tmp` — unregistered). All other live legs
  verified manually and green: app process running, herdr socket
  present, `bridge-status.json` fresh (`ok:true`, "7 panes, 7
  workspaces" via the default socket). **pc-setup follow-up
  candidate:** the verify Spotlight check is fragile to index lag;
  consider an `lsregister`-based fallback.
- Launch smoke: app started with `--remote-debugging-port=9223`, CDP
  page target live, `window.herdrT3` IPC present, bridge reached the
  default herdr session (8 workspaces incl. fixtures).

## J-2 — panel GUI E2E on the packaged app: PASS

Driven over CDP (`window.herdrT3` IPC + `Input.*`/`Runtime.evaluate`)
against throwaway fixtures: repo `/tmp/ht3j-sc` (workspace `wMD`
"HT3J-Verify", pane `wMD:p1`) and non-repo `/tmp/ht3j-norepo`
(workspace `wME` "HT3J-Err", pane `wME:p1`). Screenshots
`section-j-webp/section-j-mac-*` (webp; raw png captures gitignored).

- **Dock/resize/persist**: panel docks at the right edge beside the
  canvas (`[data-right-panel]`, default width 540). Dragging the
  `role=separator` resize strip grew it 540→660; ArrowLeft keyboard
  resize →676; both persisted to
  `localStorage["herdr-t3:right-panel-width"]`. Full `location.reload()`
  restored width 676 **and** the open tab set — surface state is
  persisted per scope under `herdr-t3:right-panel:v1`
  (`j05-after-reload`).
- **Source Control** (`j03`–`j04`): status (`main`, changed counts),
  unstaged/untracked file list, inline diff; **stage mutation** —
  clicking Stage on `a.txt` produced "staged 1 path" and `git status`
  shows `M  a.txt`. No `[role=dialog]` present while the surface is
  open.
- **Projects** (`j11b`–`j12`): list, register — `/tmp/ht3j-sc`
  registered as project `ht3j-sc` ("1 repo", notice
  `registered "ht3j-sc"`).
- **Project Scripts** (`j13`–`j18`, `j35`–`j39`): project select →
  `t3.json` script list; **run into dedicated pane** — `ht3j-hello`
  run `run-mwx4yj6q-70e77a` executed in dedicated workspace `wMF`
  pane `wMF:p1`, result `success` exit 0, Runs list updated
  ("started ht3j-hello — success").
- **Checkpoints** (`j19`–`j24`): list renders real plugin entries;
  **capture** — "checkpoint mwx4zxa3-9e07879f captured" for
  `/tmp/ht3j-sc` appears in the list. **Maintenance** opens a nested
  `Dialog` (see note below); GC **dry-run preview** renders policy +
  per-repo evaluated/kept totals (`3 evaluated · 0 would delete`),
  and "Run gc" stays gated until a fresh preview.
- **Worktrees** (`j09`, `j32`, `j45`): repo worktree list with
  Focus/Open actions; non-repo workspace shows an honest error.
- **Multi-tab**: 5 surfaces open simultaneously as tabs; tab switch,
  HTML5 drag reorder (Source Control moved to end — store order
  changed accordingly), and tab close (Worktrees removed,
  `activeSurfaceId` correctly fell back to Projects) all verified.
- **Per-workspace scope**: surfaces/tabs on `wMD` do not leak into
  `wME` — `wME` started with no panel; each scope persists
  independently in `herdr-t3:right-panel:v1`.
- **Terminal usable while panel open**: typed
  `echo HT3J_PANEL_$((6*7))` into the `wMD:p1` ghostty input with the
  panel open; `herdr pane read` shows `HT3J_PANEL_42`.
- **Entry points**: WorkspaceHeader "Pane actions" menu and
  CommandMenu (⌘K → filter → Enter) both open surfaces as panel tabs.
  The old per-surface dialogs are gone — no `[role=dialog]` appears
  for surface open/close (the command palette itself is a
  `CommandDialog` and the Checkpoints *Maintenance* section remains a
  nested `Dialog` by design — `CheckpointsSurface.tsx:1949`; noted,
  not a defect of the #333 scope).
- **Narrow width**: `Emulation.setDeviceMetricsOverride` 900px →
  docked panel unmounts and the same tab strip renders inside
  `SheetPopup` (`data-slot=sheet-popup`, "Workspace panel"); restoring
  width returns the docked panel (`j46`/`j47`). Breakpoint 980px per
  `RightPanel.tsx` `NARROW_QUERY`.
- **Error displays (≥1 per surface)**:
  - git: `wME` non-repo pane → "not a git repository — no git work
    tree contains: /private/tmp/ht3j-norepo" + "files unavailable"
    (`j28`/`j29`).
  - projects: bad path `/tmp/ht3j-does-not-exist` → "git not found on
    the host — git executable not found on PATH" (plugin
    `git_missing`, confirmed via direct `plugin_call`);
    `/tmp/ht3j-norepo` → "not a git repository — no git work tree
    contains: /tmp/ht3j-norepo" (`j30`/`j31`).
  - scripts: `ht3j-fail` (`exit 3`) run → record `unknown` with
    `pane_not_found: pane wMG:p1 not found` shown in the run detail
    (`j39`). The dedicated run pane vanished before the done-marker —
    plugin-side quirk (upstream contract), UI reports it honestly.
  - checkpoints: capture on `wME:p1` → "not a git repository — no git
    work tree contains: /private/tmp/ht3j-norepo" (`j34`).
  - worktrees: `wME` non-repo workspace → "Herdr worktree actions
    require a path inside a Git work tree" (`j32`).

## J-3 — regression spot checks: PASS

- `HERDR_VERIFY_SESSION=ht3iver bun scripts/verify-terminal-input.ts
  http://localhost:5742/ w2:p1` on the candidate worktree build
  (bridge :4761 → isolated session `ht3iver`, vite :5742): **9/10
  PASS, 1 BLOCKED** — `3 focus report I/O` blocked on the known
  upstream `AttachFocus` gap (blur +0 focus +0), identical to
  section-i/g. All SGR mouse, wheel, IME composition/commit/dedup
  and shift-drag checks pass. Note: ports 4760/5741 were occupied by
  a stale prior-leg dev stack (ht3verify session, days old); this leg
  used fresh ports to avoid cross-talk. The stale stack was left
  running (not spawned by this leg).
- **Agent icons** (#311/#335): sidebar agent rows render the brand
  icon svg (T3 brand treatment with filter defs) per agent plus the
  status glyph; hover card opens with agent detail
  (`j48`/`j49`). All visible agents are `devin` kind — icon resolution
  exercised for that kind; other kinds not present in the session.
- **Packaged terminal pixels**: `pngstat.py` on `j40` (panel open,
  typed command) — terminal region (400,200)-(1700,1600): 48 908 px
  above luminance 60, 6 720 above 200, max 255. Non-blank canvas,
  consistent with section-i magnitudes.
- **Perf sanity**: `bun scripts/perf-baseline.ts record --iterations 7`
  → `perf-macos-e8a2b7b.json`: **p50 1081 ms, p95 2258 ms, cv 42.6%**
  (totals 499–1540+ ms spread; host noisy — this leg's CDP E2E and the
  packaged app were running concurrently). Well inside the section-i
  band (p50 2325 ms) and below it; **no regression indicated**. Same
  caveat as section-i: bench measures ANSI decode+frame through the
  base64 bridge hop, not the panel/paint path.

## J-4 — remote spot check: PASS

- `plugin_list` per machine via the packaged app's IPC: local returns
  the 4 installed plugins; machine `device-wsl`
  (`5ac021a51c055c8627fe0ef3f783daf2`) returns `plugins: []` (remote
  installs were removed in section-i; the `~/.local/bin/bun` symlink
  left there remains).
- Remote workspace `wD` "HT3J-REMOTE" created via `workspace.create`
  on device-wsl; navigated the app to `#/w/<wsl-id>/wD` — remote
  terminal attached (`terms` shows the remote pane).
- **Projects surface on the remote workspace** queries the remote
  host: "Project registry on 5ac021a5… via the host's projects plugin
  … not supported by this plugin version / projects plugin
  unavailable" (`j51`) — machine scoping intact, no local data leaked.
- **Source Control surface on the remote workspace** (via CommandMenu)
  targets remote pane `wD:p1`: "git plugin not installed — plugin
  rebuildup.git is not installed on this host / git plugin
  unavailable" (`j54`) — pane-scoped, remote-scoped, honest error.
- Pane-actions dropdown rendered empty on the remote workspace during
  one attempt (menu items `[]`); CommandMenu path worked, so entry
  coverage stands. Worth a glance if reproducible — likely a
  focus/timing artifact, not confirmed as a defect.
- Cleanup: remote `wD` closed (`workspace.list` on device-wsl shows
  only the user's `wC`); no remote plugin state touched.

## Final state / cleanup

- Candidate `e8a2b7b…` remains installed at
  `~/Applications/herdr-t3.app` (v0.6.0); app left running with CDP
  on :9223.
- Plugins: all four remain installed/enabled in the default session
  at the section-i pinned SHAs.
- Local throwaway workspaces `wMD`/`wME`/`wMF` closed; `wMG` (failed
  run) already gone. Project `ht3j-sc` archived via `projects archive`
  (plugin state retains the archived record, same as section-i's
  `ht3i-sc`). Checkpoint `mwx4zxa3-9e07879f` captured against
  `/tmp/ht3j-sc` remains in plugin state; the repo is under `/tmp`
  (ephemeral).
- Isolated session `ht3iver` server stopped; leg bridge (:4761) and
  vite (:5742) killed. Stale prior-leg dev stack (bridge :4740/vite
  :5741, ht3verify session) left untouched.
- Throwaway fixtures remain under `/tmp/ht3j*` (ephemeral).
- Release head at leg end: `91a2e39` (delta noted above — packaged
  surface unchanged).
