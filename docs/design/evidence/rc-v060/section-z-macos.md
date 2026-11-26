# RC v0.6.0 — Section Z: macOS final-candidate verification leg (issue #285/#309/#354/#357)

Date: 2026-11-26 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4, Electron 45.4.1. Worktree
`/Users/rebui/work/herdr-t3-final` (detached at the frozen SHA).

Candidate: **`2febbbf6cfe78e455c46c5709e171309295aaba0`** —
`release-0-6-0` head at freeze (`git rev-parse HEAD` verified in the
worktree). This is the first full verification leg since `e8a2b7b`;
the shipped-code delta under test includes #319 (terminal.input →
Rust wasm consumer), #315 (protocol.codec ingress guards → wasm),
#361/#362 (AutomationsSurface + lifecycle mutations), #316
(agent.projection wasm ViewModel), #339 (remote bun resolution),
#354/#373 (perf scene/frame bench infra).

**Host condition: LOADED, not idle.** `loadavg` during the leg was
~14–24 (1/5/15 min bands recorded per-bench below); other agent
workloads were running on this machine. All timing-sensitive results
carry that caveat per `docs/migration/performance-baseline.md`.

Screenshots: `section-z-webp/` (webp; raw png captures local-only).

## Z-1 — frozen-SHA install + launch smoke: PASS (Spotlight leg env-FAIL)

`components/herdr-t3/install.sh 2febbbf6cfe78e455c46c5709e171309295aaba0`
(positional SHA arg) from `/tmp/pc-setup-rc`: clone → `mise install
--locked` → `bun install --frozen-lockfile` → `desktop:pack` → staged
to `~/Applications/herdr-t3.app`. No MISE workaround needed this run
(the installer's isolated `MISE_GLOBAL_CONFIG_FILE` handled the
global-pin issue from section-j).

Commit stamp 3-path check — consistent:

- install log: `installed 2febbbf6cfe78e455c46c5709e171309295aaba0`
- `app.asar` contains `2febbbf` (5 matches)
- runtime log `~/Library/Application Support/herdr-t3/logs/herdr-t3.log`:
  `"version":"0.6.0","commit":"2febbbf"` on `app.ready`/`window.loaded`
  for pid 35065

`verify.sh --live` (`/tmp/pc-setup-rc/components/herdr-t3/verify.sh`):

- installed/commit/bundle-id legs: **PASS**
- **Spotlight leg: FAIL — environment/indexing, not an app defect**
  (same class as section-j). `mdfind
  "kMDItemCFBundleIdentifier == 'com.github.rebuildup.herdr-t3'"`
  returns nothing; `mdls` shows the bundle absent from the Spotlight
  index (`kMDItemCFBundleIdentifier = (null)`); `mdimport -t -d2`
  proves the attribute extracts correctly but the index never
  ingests the app within the 60 s poll. `lsregister -dump` DOES show
  `/Users/rebui/Applications/herdr-t3.app` registered as
  `com.github.rebuildup.herdr-t3` v0.6.0. One stale registration for
  a now-nonexistent path
  (`~/.cache/ovis-tmp/ht3-accept/apps/herdr-t3.app`, left from an
  older accept test) is present in the dump; it does not shadow the
  real app (different, older bundle path and the file no longer
  exists).
- Live layers verified manually (all green): app process running
  (pid 35065, `--remote-debugging-port=9223`), default herdr socket
  present, `bridge-status.json` fresh `ok:true` "10 panes, 10
  workspaces" via `~/.config/herdr/herdr.sock`.
- **pc-setup follow-up (repeat of section-j):** the verify Spotlight
  check remains fragile to index lag on this host; an
  `lsregister`-based fallback would avoid the env FAIL.

Launch smoke: CDP page target live on `:9223`,
`file:///…/app.asar/dist/index.html` loaded, `window.herdrT3` IPC
present (`sendFrame`/`onFrame`/`snapshot`/…), renderer attached to
the default herdr session. One benign renderer error at startup:
`ResizeObserver loop completed with undelivered notifications`
(chrome-benign, also seen on prior builds).

## Z-2 — core regression: PASS (with harness disclosures)

### verify-terminal-input (WASM input path, #319): 9/10 PASS, 1 BLOCKED

Isolated session `ht3z` (socket
`~/.config/herdr/sessions/ht3z/herdr.sock`), fixture workspace
`ht3z-verify` (w2, pane `w2:p1`) running `cat -v` with mouse
1000/1002/1006 + focus 1004 reporting. Dev bridge `:4760` + vite
`:5760` from the frozen worktree (ports 4740/5741 were already held
by stale Nov-24 dev servers bound to `ht3verify` — **not killed, not
ours**; the ht3z stack used alternate ports).

Result (`bun scripts/verify-terminal-input.ts --session ht3z
http://localhost:5760/ w2:p1`, loadavg ~15–20):

- PASS 4a click→SGR press/release (+1/+1), 4b drag→motion (+3),
  6a wheel→app (+1), 5 shift+drag no app leak, 1 IME composition
  visible, 1/2 IME commit reaches pane once (日本語 delta=1),
  2 composition cleared, 2b non-echo insertText (テスト delta=1),
  2c cancelled composition sends nothing.
- BLOCKED 3 focus report I/O — known upstream gap (herdr has no
  AttachFocus client message; herdrdev/herdr discussion #6178), same
  as every prior leg.

**Harness disclosures (environment, not product defects):**

1. The frozen script's fixed `sleep(8000)` after `Page.navigate` is
   too short on this loaded host — the ghostty surface mounts at
   ~15–20 s under loadavg ~20 (verified by polling probe: absent at
   8 s, present at 15 s). Three runs of the byte-identical frozen
   script failed `setup: no .ghostty-surface`; the recorded 9/10 run
   used a copy identical except that one wait bumped to 60 s
   (`scripts/.verify-terminal-input-slow.tmp.ts`, untracked, not
   committed). Worth a follow-up: make the wait poll-based.
2. The script assumes the verify pane is the *visible* terminal
   ("only workspace -> auto"). `ht3z` had a second workspace `~`
   (w1) which the app auto-selected, so input went to the wrong pane
   and every pane-read assertion read `w2:p1` → first full run
   scored 4/10. Closing `w1` (`herdr --session ht3z workspace close
   w1`) made `ht3z-verify` the only workspace and the run went
   9/10. Fixture requirement, not a defect.

### verify-reconnect-draft (draft invariant, #356): 6/6 PASS

`bun scripts/verify-reconnect-draft.ts --session ht3z2` — self-contained
(own bridge `:4788`, vite `:5788`, CDP `:9341`, throwaway workspace
`ht3draft-rc` created and closed by the harness):

- PASS setup type draft, draft echoed while connected, setup type
  during outage, draft retained after reconnect, outage input never
  reached pty, explicit Enter sends draft to herdr.

Precondition note: on macOS a named herdr session does **not**
auto-start for `herdr --session <name> workspace list`
(`server_not_running`); the script's POSIX path assumes it does and
failed fast on a cold `ht3z2`. Starting `herdr --session ht3z2
server` first made the run clean — same class of portability gap the
Windows leg fixed in `c103838`; a small follow-up could spawn the
server on POSIX too.

### Packaged-app terminal I/O + pixel check: PASS

On the installed `~/Applications/herdr-t3.app` (CDP `:9223`,
default session, throwaway workspace `HT3Z-Verify` wMN/pane `wMN:p1`,
closed afterwards): focused `.ghostty-input`, `Input.insertText`
`echo HT3Z_$((6*7)); echo こんにちは-テスト-漢字` + Enter →
`herdr pane read wMN:p1` shows `HT3Z_42` and
`こんにちは-テスト-漢字` — real bytes through the WASM input path on
the packaged build. Clipped `Page.captureScreenshot` of
`.ghostty-surface` (1124×822 css px): BMP pixel sample has 115
unique byte values — non-blank rendered glyphs (`ht3z-01-terminal-io`,
`ht3z-after-enter`).

## Z-3 — Automations surface E2E (#361/#362): PASS

`rebuildup.automations` was **not** among the four RC plugins;
installed it at the contract pin for this leg:

```
herdr plugin install rebuildup/herdr-plugins/plugins/automations \
  --ref 6c1cfa501323772e7c1c008c3dbcd7e364feb0b3 --yes
```

→ `rebuildup.automations` enabled, contract
`herdr-plugins.automations/v1` v0.7.0 (matches the pin in
`src/shell/automations.ts`). **Left installed+enabled** (the surface
requires it; uninstalling would regress the shipped feature).

Fixture: throwaway task `task_4580dcf2-7b21-47ee-bdfe-8e7fffb74465`
("ht3z-throwaway", interval 1d, destination pane `wMN:p1`) created via
the plugin CLI against the default session — `create` is intentionally
not a UI command. All UI mutations below went through the real
right-panel surface on the packaged app (workspace `HT3Z-Verify`,
panel opened via WorkspaceHeader → Pane actions → Automations).

- **List** (`ht3z-auto-panel`): name, `every 1d` schedule, `pane
  wMN:p1` destination, `next 2026/11/27 21:33:18`, `0 runs`,
  `enabled` badge, honest driver line (`driver: no firing driver
  reporting — occurrences resolve as missed until schedule install or
  watch runs`), action row Reconcile/Refresh/Disable/Run now/Delete.
- **Run now** (`ht3z-auto-runnow-confirm/done`): confirm Dialog
  "Run task now? … delivers its prompt to pane wMN:p1 immediately,
  outside the schedule" → confirm → notice `manual run recorded`,
  run count `0 runs`→`1 run`. (The manual run is recorded honestly;
  delivery to a plain shell pane is the plugin's domain.)
- **Disable** (`ht3z-auto-disable-confirm`, `ht3z-auto-disabled`):
  confirm Dialog "Disable task? … Owed missed occurrences are
  materialized as missed runs before the enabled window closes"
  → `disabled` badge, `next —`, action flips to Enable, notice
  `task disabled`.
- **Delete** (`ht3z-auto-deleted`): confirm Dialog "Delete task? …
  and all of its run records are removed permanently" → empty state
  `no scheduled tasks`. Fixture fully removed through the UI.
- **Error/unavailable display** (`ht3z-auto-disabled-plugin2`):
  `herdr plugin disable rebuildup.automations` + panel Refresh →
  `automations plugin disabled — rebuildup.automations` (classified
  `disabled` reason, verbatim plugin id). Plugin re-enabled after
  the shot. First Refresh immediately after `plugin disable` still
  showed the stale ready state; a second Refresh surfaced the
  unavailable state — consistent with the documented freshness
  triggers (snapshot push / explicit refresh), noted not as a defect.

## Z-4 — panel regression spot-check: PASS

On the packaged app, workspace `HT3Z-Verify` (wMN):

- **Two surfaces simultaneously** (`ht3z-z4-two-surfaces`):
  Automations + Source Control open as docked right-panel tabs;
  Source Control on the non-repo `/tmp` cwd renders its honest error
  (`not a git repository — no git work tree contains:
  /private/tmp`, `files unavailable`) — no fabricated data.
- **Resize persist** (`ht3z-z4-resized`, `ht3z-z4-after-reload`):
  separator focused + ArrowLeft ×3 → width 676→724, persisted to
  `localStorage["herdr-t3:right-panel-width"]`; full
  `location.reload()` restored width 724 **and** both open tabs
  (Automations + Source Control) under
  `herdr-t3:right-panel:v1`. Disclosure: the CDP
  `Input.dispatchMouseEvent` drag on the separator did not register
  a resize this leg (mouse-press/move/release at the separator
  rect); the keyboard resize path — the same code path's keyboard
  handler — was verified instead. Prior leg j verified pointer drag;
  not re-verified here.
- **Terminal non-blocking** (`ht3z-z4-terminal-panel`): with both
  surfaces open, typed `echo HT3Z_PANEL_$((6*7))` into the
  `wMN:p1` ghostty input → pane shows `HT3Z_PANEL_42`.

## Z-5 — idle perf leg: recorded under LOAD (loaded-host evidence)

Host was **loaded** (loadavg ~14–24 across the leg), not idle — same
caveat class as the section-l/frame-bench legs; numbers are
loaded-host evidence only.

- `bun scripts/perf-baseline.ts record --iterations 7 --out
  perf-reports/baseline-2febbbf.json` → decode/frame p50 2006 ms,
  p95 2727 ms, cv 13.9%; scene p50 1957 ms, p95 2409 ms, ops 16189;
  `condition.loadavg` 21.5/22.8/24.5.
- `bun scripts/perf-baseline.ts check
  perf-reports/baseline-5fb972b7.json` → **FAIL** decode/frame
  +184.2 %, scene/paint +217.8 % vs thresholds. The baseline was
  recorded at loadavg ~12.2 — a different load band; per
  performance-baseline.md's unified-condition rule these legs are
  not comparable and the FAIL is attributed to host load, not a
  demonstrated regression. No idle-host leg exists yet on this
  candidate (same gap the frame-bench doc already records).
- `bun scripts/perf-baseline.ts check
  perf-reports/baseline-3aea0e41.json` → **PASS** decode/frame
  −14.5 % (that pre-#354 baseline has no scene section; decode-only
  comparison, slower absolute numbers from an older host state).
- `bun scripts/perf-scene-bench.ts` standalone: 200 ticks,
  scene=752.6 ms (decode=222.3, tick=12.6, collect=345.0,
  render=395.0, ops=16189, fillText=7173) at loadavg ~22.
- `bun scripts/perf-frame-bench.ts --session ht3frame --out
  perf-reports/frame-2febbbf.json` (self-contained isolated stack):
  storm frames=48 p50=133.3 ms p95=400 ms, >16.7 ms 91.7 %,
  longtasks=34, canvas API 813 ms/2540 calls, task util 86 %;
  `condition.loadavg` 23.9/22.8/24.0. Sits between the two prior
  loaded-host legs (run2 @ ~24–35 → p50 300 ms; run3 @ ~15–21 →
  p50 33.4 ms) — consistent with load-driven frame starvation, not
  a new raster regression (canvas API share stays small).

Reports committed: `perf-reports/baseline-2febbbf.json`,
`perf-reports/frame-2febbbf.json`.

## Z-6 — T3 visual comparison (#357 partial): captured, notes below

T3 Code dev stack (`/Users/rebui/work/t3code`, `npm run dev` →
dev-runner, web `:5733` + server `:13773`, `baseDir=/Users/rebui/.t3`)
under the same loaded host. Pairing URL from stdout
(`pair#token=…`), paired in headless Chrome (`/tmp/t3z-cdp` profile).
Cold vite transform + server PATH probe (`spawnSync /bin/zsh
ETIMEDOUT` under load) made first paint take ~50 s — environment,
not a defect; server then came up and printed the pairing URL.

Captured (`section-z-webp/t3-*`):

- `t3-00-after-pair` / `t3-01-main-loaded`: post-pair thread list +
  composer ("Ask anything. @ files, $ skills, / commands", model
  picker "6 Astra Medium", project/script/ref pickers).
- `t3-02-terminal-drawer`: after "Toggle terminal drawer".
- `t3-03-right-panel`: right panel surface launcher — "Open a
  surface": Browser B, Terminal T, Files F, Diff D, Pull request P,
  Linked items L, Device M, Side chat S.
- `t3-04-terminal-surface`: Terminal surface opened ("Terminal 2").

herdr-t3 equivalents (`section-z-webp/ht3z-*`): `ht3z-00-main`
(sidebar workspace/agent list + attached terminal), `ht3z-01-terminal-io`,
`ht3z-auto-panel` (Automations in the docked right panel),
`ht3z-z4-two-surfaces` (two panel tabs).

**Structural/visual comparison notes (not pixel-perfect):**

- **Information architecture differs by design.** T3 is
  thread/agent-centric: left sidebar lists threads grouped by
  project with Settle/Snooze affordances; the main canvas is a
  conversation surface with a composer; the right panel is a
  *launcher* for surfaces (Browser/Terminal/Files/Diff/PR/Linked
  items/Device/Side chat). herdr-t3 is workspace/pane-centric per
  the herdr boundary: left sidebar lists herdr workspaces + agent
  rows; the canvas IS the attached terminal; the right panel hosts
  plugin-backed surfaces (Source Control, Projects, Project Scripts,
  Worktrees, Checkpoints, Automations) as persisted tabs — no
  composer, no fabricated conversation model. This matches ADR-0009 /
  `docs/design/t3-parity.md` scope: T3 features that do not conflict
  with the herdr boundary are in scope; forcing panes into T3's
  Thread model is explicitly out.
- **Right panel vs right panel:** both dock right and host multiple
  surfaces, but T3's panel is a generic surface launcher incl.
  Browser/Side chat (T3-native capabilities herdr-t3 does not and
  should not replicate), while herdr-t3's hosts herdr-plugin
  contracts only. Visual language (tab strip, resize separator,
  persisted width/tabs) is intentionally parallel — section-j
  verified the dock/resize/persist behavior matches the T3
  reference.
- **Terminal:** T3's Terminal is a launcher surface inside its
  thread model; herdr-t3's terminal is the primary canvas (real
  ghostty-vt session per pane, WASM input path now). Visually
  distinct surfaces per AGENTS.md §4 — terminal ≠ chat.
- **Theme/controls:** both use the T3 Code design system tokens
  (herdr-t3 ports `src/components/ui` primitives + `index.css`
  tokens); side-by-side shots show the same density/typography
  language. No approximate-"T3-style" regressions observed in the
  captured surfaces.

## Z-7 — remote smoke: PASS (plugin transport verified end-to-end)

Over the dev bridge WS (`ws://127.0.0.1:4760/ws`, which also
exercises the #315 wasm `isClientFrame` ingress guard on every
frame):

- `plugin_list` per machine:
  - `local` → ok, 5 plugins (incl. `rebuildup.automations` 0.7.0).
  - `5ac021a5…` (**device-wsl**, "Ubuntu (WSL)") → ok; initially
    `plugins:[]` — the remote plugin *registry* was empty even though
    old checkouts remained under
    `~/.config/herdr/plugins/github-installations`. Reinstalled
    `rebuildup.inbox` at the RC pin
    (`--ref 414e87dea9faa5c221fb27508e5828f086849836`) on device-wsl
    → now lists `rebuildup.inbox 0.1.0 enabled`. **Left installed**
    (matches the pre-existing intent; section-i had it enabled).
  - `3f85952b…` (device-windows) and `5979abac…` (device-lab-win) →
    `plugin_bad_output` — same unreachable/unhealthy-remote class as
    section-i (Windows sshd wrapper issues), unchanged.
- `plugin_call` → device-wsl `rebuildup.inbox list` → **ok:true**,
  real remote document: `contract herdr-plugins.inbox/v1`,
  `state_file /home/basic/.local/state/herdr/plugins/rebuildup.inbox/state.json`,
  counts total 2 / inbox 2, two real pane items. **The #339 remote
  bun-resolution fix is verified**: before the fix the first remote
  plugin_call failed `bun: command not found` (exit 127) on the
  non-login ssh PATH; now the call resolves bun on the remote and
  returns contract data. Before installing inbox the same call
  returned a proper contract error `plugin_not_installed` — also
  proof the transport + error taxonomy work remotely.

## Defects / follow-ups (reported, not fixed — freeze in effect)

1. **verify-terminal-input harness timing**: fixed 8 s post-nav wait
   is load-fragile; surface mounts ~15–20 s at loadavg ~20. Suggest
   poll-for-surface (verify-reconnect-draft already polls 60×500 ms).
2. **verify-reconnect-draft POSIX session start**: assumes named
   session auto-starts; `workspace list` returns
   `server_not_running` on a cold session — spawn
   `herdr --session <name> server` on POSIX too (Windows leg already
   does this in `c103838`).
3. **pc-setup verify.sh Spotlight leg**: still env-fails on this
   host (index never ingests the app); repeat of section-j
   follow-up — consider `lsregister -dump` fallback.
4. **Perf gate load-band**: `perf-baseline.ts check` has no
   loadavg-band guard — a loaded-host re-run FAILs against an
   idle-ish baseline (observed +184 %/+218 % at loadavg ~22 vs ~12).
   The report records `condition.loadavg` but `check` ignores it;
   consider warning/failing-soft when bands differ.
5. **Automations freshness**: first Refresh right after
   `herdr plugin disable` kept the stale ready state; needed a
   second refresh (or snapshot push). Matches documented triggers —
   noted for awareness only.

## Cleanup

- Throwaway fixtures removed: herdr-t3 workspace `HT3Z-Verify`
  (wMN) closed via pane close; automations task
  `task_4580dcf2…` deleted through the UI (runs included);
  `ht3draft-rc` workspace auto-closed by the harness; `ht3z`
  workspace `~` (w1) closed manually, `ht3z-verify` (w2) left in the
  isolated `ht3z` session (session itself isolated, harmless).
- Plugins: 4 RC plugins untouched in default session;
  `rebuildup.automations@6c1cfa5` **added and left enabled** (required
  by the shipped surface); `rebuildup.inbox@414e87d` **reinstalled on
  device-wsl and left enabled** (was registered-empty before).
- Processes: dev bridge `:4760` + vite `:5760` (ht3z) killed; T3 dev
  runner + children stopped (verified no listeners on 5733/13773 and
  no stray t3code processes from this leg); packaged app left running
  (it is the installed RC — prior legs also left it running);
  headless Chrome instances self-terminated.
- Not touched: stale Nov-24 dev servers on `:4740`/`:5741`
  (ht3verify, other owner), other agents' T3 dev-runner
  (`--home-dir /tmp/t3-m1-home`, ports unrelated), live default
  herdr session workspaces (only the HT3Z-Verify fixture was added
  and removed).
- Disk: ~39 GiB free at leg start; evidence adds <50 MB.
