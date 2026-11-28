# Performance baseline & non-regression gate (issue #240)

Reproducible measurement foundation for the GPUI migration: the same
workloads must run against the current TS/Electron implementation and
the future Rust/GPUI one, with recorded environments, so "faster" or
"no regression" is evidence, not impression. Issue #231's bench results
alone do not establish whole-app bottlenecks — this doc scopes what is
and is not covered.

## What exists today

- `scripts/perf-terminal-bench.ts` (#231): microbenchmark — 400 ticks of
  ANSI streaming decode + base64 bridge hop + engine frame on a
  120x40 grid, fixed LCG seed 42. Measures decode/frame throughput.
- `scripts/perf-scene-bench.ts` (#354): scene/paint-path microbenchmark —
  200 timed ticks (20 warmup) driving `SurfaceCore.write`/`tick`/`scroll`
  and `GhosttyScene.collect`/`render` op emission on the same 120x40 grid
  and seed-42 output storm, plus a scroll jump into history every 8th
  tick and a return-to-bottom every 16th. Uses the harness FakeMetrics
  policy shared with `crates/terminal-render`, so TS scene numbers are
  comparable to the Rust port's. `total=` covers the whole scripted frame
  loop; the printed `scene=`/`decode=`/`tick=`/`collect=`/`render=`
  breakdown separates the #294/#301-changed path from engine decode.
  Canvas2D rasterization (`GhosttyRenderer.paint`) is DOM-bound and is
  NOT measured here — see Coverage map.
- `scripts/perf-frame-bench.ts` (#354 follow-up, extended by #526):
  real frame-time bench — drives the running app (isolated herdr
  session → bridge → vite → headless Chrome CDP) through the same
  seed-42 output storm plus CDP wheel scroll traversal, and records rAF
  frame intervals (p50/p95/p99), longtasks + container attribution,
  task utilization, Canvas2D API time, input→paint latency and
  Chrome-tree CPU% per window (idle/storm/switch). Self-contained
  (spawns and reaps its own stack); reports to
  `perf-reports/frame-*.json`; `--check` gates provisional absolute
  budgets.
- `scripts/perf-baseline.ts`: runner + gate.
  - `record --iterations N --out PATH` → machine-readable report
    (`perf-reports/baseline-<sha>.json`) with `bench` (decode/frame),
    `scene` (scene/paint path), and `condition` (loadavg at record time)
  - `check <baseline> [--threshold-pct N]` → re-runs and compares p50
    for every section the baseline contains; reports recorded before
    #354 have no `scene` section and compare decode-only (the verdict
    output says which benches ran — never a silent pass)
- `scripts/perf-baseline.test.ts`: fault-injection tests — invalid
  measurements rejected, intentional +50% slowdown detected,
  cross-machine comparisons refused.

## Report contents (machine-readable)

`format`, `version`, `recorded_at`, `git_sha`, host (`platform`,
`arch`, `hostname`, `cpu_model`, `cpu_count`, `mem_total_bytes`),
`bun_version`, workload (`bench`, `seed`, `ticks`, `note`), bench
stats: per-iteration `totals_ms`, `p50/p95/min/max`, coefficient of
variation, cells decoded. Reports recorded after #354 add:

- `scene`: same stat shape for `perf-scene-bench.ts` plus
  `ops_total` (paint ops emitted per run) and its own `workload`
  (`ticks: 200`, note describing the scroll-storm mix).
- `condition`: `loadavg_1m/5m/15m` captured at record time — evidence
  for leg comparability, deliberately not part of `checkHostMatch`
  (load is recorded, not gated; see Unified conditions below).

**Comparability rule:** numbers from different machines are never
compared directly — `check` refuses when platform/arch/cpu_model/
bun_version/workload.seed differ. Baselines are per-machine-class;
RC freeze collects both-OS evidence on reference hardware.

## Methodology rules

- **Warmup:** the bench compiles WASM and warms inside the first ticks;
  each `bun` invocation is a cold process — iteration spread captures
  process-start noise. p50 is the gate metric (robust to outliers);
  p95 is reported for tail visibility.
- **Iterations:** default 7 for `record`/`check`; raise at RC freeze.
  Reject runs with CV > ~15% as noisy (re-run, don't average away).
- **Unified conditions (#354):** every leg records `condition.loadavg`
  at measure time. Legs are comparable when host metadata matches AND
  the recorded loadavg is in the same band — an idle-host number and a
  saturated-host number are different measurements, not a regression.
  Preferred condition is an otherwise-idle reference machine; when the
  dev host is shared (other agents/builds running), record the loadavg
  and treat the leg as "loaded-host" evidence. `check` does not refuse
  on loadavg — it is context for humans reading the report, matching
  how section-i/j legs already handled host noise.
- **Threshold:** default `--threshold-pct 20`, **provisional** — chosen
  conservatively until RC freeze measures real run-to-run variance on
  reference hardware; the justified value gets recorded here before the
  gate is enforced in CI.
- **Measurement failure ≠ regression:** `check` exits 2 (incomparable
  environment / bad baseline) distinctly from exit 1 (regression).
  Skips and impossible runs never count as PASS.

## Coverage map (what is measured vs deferred)

| Workload | Status |
|---|---|
| terminal decode/frame microbench (streaming ANSI, base64 hop) | ✅ `perf-terminal-bench.ts` via `perf-baseline.ts` |
| scene build + paint-op emission (SurfaceCore.tick → GhosttyScene collect/render, scroll storm) | ✅ `perf-scene-bench.ts` via `perf-baseline.ts` `scene` section (#354) |
| Canvas2D rasterization (`GhosttyRenderer.paint`: fillText/drawImage onto canvas) | ✅ measured — `perf-frame-bench.ts` (CDP, real app); loaded-host legs only so far, see Frame-bench section |
| memory growth / leaks (JS heap, Chrome tree, bridge, herdr) under idle/storm/kitty/switch workloads | ✅ `perf-memory-bench.ts` (CDP, real app, isolated herdr session; issue #499). `--check` enforces absolute per-scenario budgets (default jsHeap 256 MB / Chrome tree 2048 MB / bridge 512 MB / herdr 512 MB) plus convergence gates: tail-slope flattening for idle/switch and storm2-vs-storm peak reuse. Kitty chunks exercise the full transmit/place/move/delete lifecycle. Since #572 every scenario also records a bridge `/api/metrics` delta (delivery bytes, attach/op counts) and the `hidden` scenario gates hidden-workspace non-delivery. Evidence: `perf-reports/mem-*.json` |
| startup time, idle CPU/RSS | partially — workload CPU% measured by `perf-frame-bench.ts` (#526); startup time and idle RSS still deferred to the packaged-app harness at RC |
| multi-pane / large output | partially — engine bench is single-grid; extend workload at RC |
| input-to-paint p50/p95/p99, scroll/resize/streaming | ✅ input→paint p50/p95/p99 (trusted wheel+click → next rAF frame), Chrome-tree CPU%, and longtask container attribution under idle/storm/workspace-switch workloads — `perf-frame-bench.ts` (#526), gated by `--check` with provisional budgets; resize leg and true photon-present latency still deferred |
| local/SSH/reconnect, plugin calls | ✅ bridge data-plane leg — `scripts/perf-bridge-load.ts` (#425/#416); SSH transport still deferred |
| multi-client non-interference (observe vs writable: size/focus/scroll authority) | ✅ contract tests — `server/bridge-core.test.ts` "non-interference" describes (#571/#572, strengthened #586); C5 conformance corpus `harness/scenarios/bridge/` + `harness/lib/adapters/bridge.ts` (#600); live two-client leg deferred |
| operator handoff (writable follows focus; demote/promote mode flips) | ✅ contract test — `server/bridge-core.test.ts` "operator handoff" (#586), pins CURRENT per-slot semantics; `src/lib/windowActivity.test.ts` + `WorkspaceCanvas` gate release/suppress the role while the GUI window is hidden/blurred (#600 verifying #584); #584 may add server-side single-writable arbitration — revisit on landing |
| window inactive/blur → no operator promotion, resize lock released | ✅ contract test — `src/lib/windowActivity.test.ts` + `WorkspaceCanvas` wiring (#600); live blur leg deferred to RC manual check |
| unselected-host summary delivery (#585 `machine_select` detail mode) | ✅ contract tests — `server/bridge-core.test.ts` / `server/machine-manager.test.ts` "summary detail mode" + `harness/scenarios/bridge/summary-detail-gates.json` (#600); live second-host leg deferred (needs SSH machines) |
| local history scroll (viewport-only paging, zero RPC/attach/refetch) | ✅ contract test — `server/bridge-core.test.ts` "local history scroll" (#586) + `terminal-io` leg delivery meters (#572) |
| host scaling (N machines × M visible panes → O(visible) RPC/attach/subscription) | ✅ fake-machine contract test — `server/bridge-core.test.ts` "host scaling" (#586); live multi-host leg deferred (needs SSH machines) |
| distribution artifact size | covered by release evidence manifests (`docs/design/evidence/rc-*`) |

The Rust port must reproduce **equivalent functionality and render
volume** before numbers are comparable — the gate assumes feature
equivalence per `docs/migration/contracts/`, it does not prove it.
No Rust-side improvement is assumed; the baseline exists to detect
regressions, not to promise wins.

### Memory budget contract (issue #499, both implementations)

Every terminal engine instance carries bounded resources with the same
contract on TS (`shared/ghostty`, Electron) and Rust (`crates/terminal-*`,
GPUI path):

- **Per-pane caps**: Kitty image storage 64 MiB (`KITTY_IMAGE_STORAGE_LIMIT`
  / `images`), scrollback byte cap 64 MiB applied *with* the line cap
  (`SCROLLBACK_MAX_BYTES` / `scrollback_bytes`), decoded-image LRU and
  pending-queue/attach-queue byte ceilings in the host layer.
- **Aggregate budget**: the host sums per-session WASM/native heap
  high-water marks against a machine-scaled budget (renderer:
  `src/lib/memoryBudget.ts`; native: `crates/terminal-render/src/memory_budget.rs`
  for the budget/watchdog math, `memory_host.rs` for the host-side
  wiring — issue #553). Over budget → lossless cache shedding only;
  WASM/native heap cannot shrink without session disposal, so shedding
  is rate-limited and attributed (top sessions named) rather than
  thrashing.
- **Watchdog**: main process derives warn/critical/breach from physical
  RAM, a 2 h measured baseline, a 15 min RSS slope, and OS free-memory
  pressure (`osFreePct`); only breach reloads. `herdr-t3:memory-pressure`
  pushes drive renderer shedding. The native port reproduces the same
  level semantics in `memory_budget::MemoryWatchdog` — a fixed absolute
  threshold is a defect, not a design — fed by `memory_host::MemoryHost`
  with process RSS and platform-aware OS-available memory
  (`os_mem.rs`: `vm_stat` on macOS, `MemAvailable` on Linux). Breach is
  a signal to the host (`MemoryHostEvent::SurfaceReloadDue`, 10 min
  cooldown); session disposal stays a host decision that preserves
  drafts/attach state — the crate never kills sessions.
- **Measurement**: `perf-memory-bench.ts --check` gates absolute budgets
  plus convergence (tail slope, storm2/switch2 reuse). The same
  scenarios must run against the GPUI host before parity is claimed.

### Assurance coverage (issue #586, program #416/#425/#568)

Cheap deterministic contract tests pin the four assurance properties the
RC legs measure live. They run in `bun test server/bridge-core.test.ts`
(part of `bun run test` / `./scripts/ci.sh`) and are also asserted by
`scripts/perf-contract-check.ts` (piece `assurance-noninterference-handoff`)
so a removed contract fails loudly:

- **Non-interference** — "non-interference contract: observe cannot move
  the writable link": an observe client (`writable:false`) plus a second
  observe subscribe cannot add Resize/Detach/Input/AttachScroll frames or
  a re-attach to the writable link; dropped observer ops are still counted
  in `bridge.terminal.op`; the writable path stays functional afterwards.
- **Operator handoff** — "operator handoff: writable follows focus":
  demote flips the slot to `ObserveTerminal` on a new connection (old
  link gets Detach = resize authority released), observe-mode input is
  dropped and counted, re-promote restores the writable AttachTerminal
  with in-flight input flushed in order. Written against CURRENT merged
  semantics (`writable` is per-slot; the renderer sends it only for the
  focused pane): if #584 lands server-side single-writable arbitration
  these tests must be revisited.
- **Local history scroll** — "local history scroll is viewport-only":
  12 alternating scroll ticks + a stray scroll on an unsubscribed pane
  produce zero new herdr requests (no `session.snapshot` refetch, no
  `events.subscribe` reopen, no RPC, no re-attach), exactly one
  `AttachScroll` (variant 6) per issued scroll, `pane.scroll_changed`
  stays event-only, and post-scroll bytes meter as
  `terminal.delivery.bytes{phase=scroll}`.
- **Host scaling** — "host scaling: cost tracks visible panes": 3 fake
  machines × 6 panes each; mounting 2 visible panes per machine yields
  exactly 6 attach connections, scroll subscriptions covering only the
  visible ids, 1 snapshot fetch + ≤2 `events.subscribe` per machine;
  growing the visible set to all 6 panes/machine grows attaches linearly
  while RPC/subscription-reopen counts stay flat.

**C5 conformance corpus & window gate (issue #600, program
#233/#416/#568)**: `harness/scenarios/bridge/*.json` is the shared
`terminal-noninterference@3` corpus — seven scenarios driven through the
new TS bridge adapter (`harness/lib/adapters/bridge.ts`, in-process
`createBridgeSession` + fake connectors) covering the eight C5 checklist
points, takeover arbitration, detach grant release, and the #585
summary/detail `machine_select` gate. `oracle: "spec"`, `adapters:
["ts"]`; a Rust `herdr-bridge` adapter consumes the same files when it
lands (see `harness/README.md`). The client-side window-activity gate
(`src/lib/windowActivity.ts` + `WorkspaceCanvas`) demotes/releases the
operator role on window hide/blur and refuses promotion while inactive.
All of these are pinned by `perf-contract-check.ts` pieces
`c5-conformance-corpus`, `window-activity-operator-gate`,
`summary-detail-mode`, and `attach-egress-promotion-bounds`.

**RC / live legs** (isolated herdr sessions only — never the live
session; `verify-guard` enforces):

```sh
bun test server/bridge-core.test.ts     # fast gate, deterministic
bun test harness/                       # C5 corpus + codec/terminal/projection scenarios
bun scripts/perf-contract-check.ts      # contract pieces incl. #586/#600
bun scripts/perf-contract-check.ts --self-test
# RC measurement legs (heavy, run at freeze):
bun scripts/perf-bridge-load.ts record --session ht3load   # attach-churn + terminal-io legs
bun scripts/perf-memory-bench.ts --session ht3mem --scenario hidden  # hidden-workspace non-delivery gate
bun scripts/perf-observe.ts compare <before.json> <after.json>
```

The live legs still own wall-clock/volume evidence (delivery MiB/s,
attach rates under real herdr); the contract tests own the invariants.

## RC section-l re-measurement (issue #354, 2026-11-26)

First unified-condition leg on release head `5fb972b` (includes #294
scene split, #301 surfaceCore extraction, #319 Rust input consumer,
#333 right panel). Host: MacBook "mac", Apple M5, 10 cores, 24 GB,
bun 1.4.4 — same host class as `baseline-3aea0e41`. Report:
`perf-reports/baseline-5fb972b7.json`.

**Condition: loaded host.** Other agent workloads were running;
`condition.loadavg` = 12.2/11.1/9.2 (1/5/15 min) at record time —
saturated for a 10-core machine. Per the methodology this leg is
"loaded-host" evidence; CVs exceed the ~15% noise guideline
(decode 25.2%, scene 41.9%) and the totals spread confirms it. An
idle-host re-run at RC freeze is still required for gate-grade
numbers.

| bench | p50 ms | p95 ms | cv | notes |
|---|---|---|---|---|
| decode/frame (`bench`, 400 ticks) | 692 | 1087 | 25.2% | totals 411–1087 |
| scene/paint (`scene`, 200 ticks) | 675 | 1316 | 41.9% | totals 349–1316, 16 189 ops/run |

Scene-path breakdown (single-run means over 200 ticks): decode≈50–90 ms,
tick (SurfaceCore decisions)≈10–25 ms, collect (engine frame + row
cache)≈135–300 ms, render (op emission)≈170–370 ms — collect+render is
~85% of the scene path, i.e. the #294/#301-changed code dominates what
this bench measures.

Cross-check vs `baseline-3aea0e41` (decode bench only — the old report
has no `scene` section): `check` → **PASS, delta −85.7%**
(current p50 432 ms vs baseline p50 3011 ms). Because
`perf-terminal-bench.ts`, `ghostty-vt.wasm` and the bun version are all
unchanged since that baseline, this delta is environmental (host load
at the 3aea0e41 record time vs now), not a code improvement — exactly
the leg-comparability problem `condition.loadavg` now records. Prior
section-i/j legs show the same band (p50 375–3032 ms across hosts
legs), so no regression is indicated, but absolute decode numbers
should only be compared within the same loadavg band.

**#294/#301/#333 impact:** the scene bench exercises the real
`SurfaceCore` + `GhosttyScene` code paths (verified: `git show
--stat` of the #333 merge touches no `src/lib/ghostty`, `crates/`, or
terminal files — the right panel is a sibling dock, not on the
terminal path). First scene-path numbers exist; there is no pre-#294
scene baseline to diff against, so "no regression" for the refactor is
established only in the weak sense that absolute frame cost is ~1–3.5
ms/tick under load — well inside a 16 ms frame budget even at p95.
A pre-refactor scene measurement is impossible retroactively; the
Rust `terminal-render` port can be compared against these TS numbers
directly via the shared FakeMetrics policy.

**Remaining gap:** `GhosttyRenderer.paint` (Canvas2D fillText /
drawImage rasterization) is DOM-bound and unmeasured in Bun — now
covered by `scripts/perf-frame-bench.ts` (CDP, real app); see the
Frame-bench section below for method, legs and remaining gaps.

## Frame-bench: real frame time via CDP (issue #354 follow-up, 2026-11-26)

`scripts/perf-frame-bench.ts` closes the gap `perf-scene-bench.ts`
documents: it measures the DOM-bound half — real rAF frame intervals,
longtasks, main-thread task utilization, and Canvas2D API time — inside
the running app, not a Bun-side simulation.

**Method.** The script orchestrates the whole stack itself: isolated
herdr session (default `ht3frame`, enforced by `verify-guard.ts` —
`assertBridgeTargetIsolated` re-checks `/api/health` so the harness can
never silently measure the live session) → dev bridge → vite →
headless Chrome over CDP. It seeds one `perf-frame` workspace whose
pane first gets 400 scrollback lines, then runs the same seed-42 ANSI
chunk generator as the scene/terminal benches (24 chunk files streamed
round-robin every 8 ms by an in-pane bun looper), while CDP
`Input.dispatchMouseEvent` wheel bursts (~100 lines/event, alternating
direction every ~350 ms) traverse scrollback — the same scroll-storm
mix as the scene bench. Inside the page it injects a
`PerformanceObserver("longtask")` + rAF timestamp recorder + a
`CanvasRenderingContext2D.fillText/drawImage` timer, and cross-checks
with CDP `Performance.getMetrics` (`TaskDuration`/`ScriptDuration`
deltas). Reports land in `perf-reports/frame-<sha>*.json` with
`condition.loadavg`, host metadata and per-window stats; a window that
navigates mid-run (vite HMR full-reload under load) is detected via
`performance.timeOrigin` and the storm attempt is retried once.

**What it measures that the scene bench cannot:** whether frames
actually make the vsync deadline in the real renderer (Canvas2D
rasterization, style/layout, GC, compositor pacing included), how many
longtasks the storm produces, and how much wall time the Canvas2D API
calls themselves consume.

**Legs recorded (release head `1f376bf`, macOS arm64, bun 1.4.4,
headless Chrome, 1440x900@2x):**

| leg | loadavg (1/5/15m) | storm frame p50/p95 | frames | storm >16.7 ms | longtasks | canvas API | task util |
|---|---|---|---|---|---|---|---|
| run 2 (`frame-1f376bf3-run2.json`) | 24/27/35 | 300/1000 ms | 10 | 100 % | 31 | 481 ms / 1601 calls | 96 % |
| run 3 (`frame-1f376bf3-run3.json`) | 15/16/21 | 33.4/183 ms | 230 | 77.8 % | 36 | 546 ms / 10 921 calls | 53 % |

Both legs are **loaded-host** evidence — other agent workloads were
running (same caveat as the section-l leg). The two legs show how
steeply the numbers move with host load: at loadavg ~24–35 the
renderer main thread is saturated (96 % task utilization, <1 fps
frame production, only 10 frames in the window); at loadavg ~15–21
the same storm yields 230 frames at p50 33 ms with 53 % utilization.
Frame-interval p50/p95 under either condition is dominated by CPU
starvation, not raster cost — treat absolute values as loaded-host
evidence only.

**Findings:**

- **Canvas2D API submission is not the bottleneck.** `fillText` +
  `drawImage` wall time is ~0.5 s per ~15–17 s storm window — ~3 % of
  `TaskDuration` in the saturated leg, ~6 % in the lighter leg
  (546 ms / 8875 ms), at ~0.05–0.3 ms/call. Real but small next to
  decode + scene op emission, which the scene bench prices at
  ~1.2–6 ms/tick on the same host (`perf-scene-bench.ts`: 1232 ms
  scene path / 200 ticks at loadavg ~28).
- **Headless idle frame intervals are not a usable idle-fps signal:**
  with no visual damage Chrome's frame sink throttles rAF to ~8–10
  fps even though task utilization is only ~19 % (run 3 idle:
  p50 117 ms, 44 frames, 0 canvas calls). The storm leg — constant
  canvas damage — is the meaningful one; idle cost is better read
  from `task_utilization_pct` (~19 %) than frame intervals.
- Scroll traversal (wheel bursts into history) is included in the
  storm window, so scroll-repaint cost is inside these numbers, not
  a separate leg.

**Remaining gaps (honest):**

- No idle-host leg yet — all numbers above are loaded-host; absolute
  frame pacing is not established.
- Headless Chrome vsync cadence under CPU starvation is itself
  degraded (~12 fps ceiling observed on `about:blank` at loadavg
  ~100); `frames` counts produced frames, and `>16.7 ms` percentages
  should be read as "missed the 60 fps budget", not "missed display
  vsync".
- `canvas_api_ms` measures time inside the Canvas2D API calls
  (raster submission), not compositor present — true photon latency
  still needs renderer-side instrumentation or a traced capture.
- The bench drives vite dev (React dev build), not the packaged
  Electron app; a packaged-app leg is still deferred to RC.

### Input→paint / CPU / longtask attribution (issue #526)

`perf-frame-bench.ts` now emits, per measured window (`idle`, `storm`,
`switch`):

- **`input_paint`** — p50/p95/p99/min/max/mean of the latency from a
  trusted input event to the next rAF frame callback's execution time
  (`performance.now()` inside the rAF callback — deliberately not the
  vsync timestamp, which under load can predate the event and clamp to
  0). The
  in-page recorder stamps `wheel`/`pointerdown` events and drains them
  on each rAF tick; the harness dispatches CDP
  `Input.dispatchMouseEvent` wheel bursts (storm), periodic wheel+click
  probes (idle baseline), and wheel+click probes after each workspace
  switch. This measures input→paint *scheduling* (event → the frame
  that carries its damage), not photon-present latency — compositor
  present still needs a traced capture. It is the least invasive
  reliable signal: no app instrumentation, works for any input the
  page sees.
- **`cpu_utilization_pct`** — cumulative CPU-seconds delta across the
  window for the whole Chrome process tree, normalized to % of total
  machine CPU capacity. Primary source is `ps` process-tree accounting
  (same walk as perf-memory-bench's RSS sampler); CDP
  `SystemInfo.getProcessInfo` on the browser target is the Windows
  fallback — its `cpuTime` was verified to underreport (~3 s busy loop
  → ~1.4 s), so it is not trusted on POSIX. `null` when neither source
  is available; `cpu_time_ms` carries the raw delta.
- **`longtask_attribution`** — the existing longtask observer now
  captures `TaskAttributionTiming` container type(+name) per entry and
  the window aggregates `{count, total_ms}` per bucket
  (`unattributed` when the entry carries none).
- **`switch` leg** — `--switch-cycles N` (default 4, `0` disables)
  alternates the hash route `#/w/local/<id>` between two fixture
  workspaces (same React unmount/mount path as perf-memory-bench's
  switch scenario) while probes measure input→paint on freshly mounted
  surfaces.
- **`--check`** — provisional absolute budgets
  (`--max-input-paint-p95-ms` default 1000,
  `--max-cpu-util-pct` default 95) enforced on the storm and switch
  legs. Unmeasured metrics and mid-window navigations fail — a skipped
  probe is not a pass. Budgets are catastrophe ceilings pending RC
  freeze variance data, same convention as the memory gate.
- **`perf-observe.ts compare`** accepts frame reports: it normalizes
  both report shapes (`config`/`workload`, `host`/`condition`,
  `sha`/`git_sha`), diffs workload + host + cpuModel for
  comparability, and reports per-window deltas for frame p50/p95/p99,
  longtask count/total, canvas API ms, task utilization,
  input→paint p50/p95/p99 and CPU% under the same
  `--regression-pct` rule.

Honest gaps: input→paint is measured to the next rAF frame callback
execution, not compositor present; attribution is container-level (the page's own
longtasks all share the window container); the `--check` budgets are
provisional and uncalibrated; keyboard/text input is not probed (only
wheel + click — keystroke injection could type into the pane).

## Bridge/plugin data-plane load bench (issues #416/#425)

`scripts/perf-bridge-load.ts` measures the system-level workloads the
terminal benches cannot: snapshot push policy, RPC fan-out, plugin CLI
spawn rate, subscription stability and RPC wait — the exact surfaces the
#416 regression lived on. It drives the **real** dev bridge
(`server/index.ts`) over its actual client protocol (WebSocket frames +
`/api/metrics`) against an isolated herdr session (`--session`, default
`ht3load`, enforced by `verify-guard.ts` — the live session is refused).
No vite/Chrome needed; all spawned processes are reaped on exit.

**Legs** (each `--seconds N`, default 12):

| leg | workload | invariants checked |
|---|---|---|
| `idle` | WS connected, no requests | baseline subscription count, ~zero churn |
| `rpc-read` | 4 concurrent readers × `session.snapshot` every 400 ms | `bridge.snapshot.schedule{cause=rpc}` must be **0** (#423 read-only exemption); `herdr.rpc` count == frames issued |
| `plugin-read` | the 4 surface stores' refresh pattern — one read `plugin_call` per installed surface plugin every 800 ms, all concurrent | `plugin.exec{what=plugin_call}` ≤ issued calls — single-flight merges, never amplifies (#424) |
| `activity` | external herdr workspace churn (create/focus/close ~700 ms) + client read polling | snapshot push/dedup counts, `subscription.reopen` must be 0, RPC wait under real event flow |
| `attach-churn` | workspace-switch attach pattern: `subscribe_terminal` for every pane in a ~4-pane batch, then unsubscribe, repeated | `bridge.subscription.open` must stay ~2 per attach/detach phase — per-pane reopens are the #416/#527 amplification |
| `terminal-io` | demand-driven delivery (issue #572): one attach batch + bounded ~4 KiB-line output storm on the first pane + scroll up/down and resize probes on all subscribed panes | `bridge.terminal.op{op=scroll|resize}` forwarded ≤ issued (no amplification); `bridge.terminal.attach` ≤ subscribes (no duplicate attaches); delivery bytes/meters reported per leg |
| `reconnect` | WS drop + reconnect cycles | each connect costs exactly 1 `session.snapshot` fetch + 1 `subscription.open`; more is session/subscription fan-out |

**Report** (`perf-reports/bridge-load-<sha>.json`): per-leg metric
*deltas* (not cumulative counters) for every `bridge.*`,
`herdr.rpc{method=…}`, `plugin.exec{what=…,command=…}`,
`plugin.discovery/capability`, `client.frame`, `machine.*` key, plus
client-side rpc_result latency p50/p95/max, `condition.loadavg`, host
metadata and git SHA — same comparability rules as the terminal baselines
(same host class + same loadavg band; `compare` refuses cross-host).
Since #572 the deltas also cover `meters` (quantity accumulators, see
below) and every leg's verdict notes include a `terminal delivery`
line — total MiB, MiB/s, and the initial vs post-scroll split — whenever
terminal bytes flowed.

**Detectors** (`evaluateLeg`, exported + fault-injection tested in
`scripts/perf-bridge-load.test.ts`): a leg fails only on hard invariant
breaks — read-RPC snapshot scheduling, subscription flapping, plugin exec
fan-out beyond issued calls. Timing regressions are *reported* (avg/max
`herdr.rpc`, `plugin.exec` durations) but wall-clock gating stays with
`perf-baseline.ts`; provisional thresholds get justified at RC freeze,
same convention as the 20 % decode/scene gate.

**#416 before/after protocol:** run `record` on the pre-fix SHA and on
the post-fix SHA under the same `--session`/`--seconds` and comparable
loadavg, then `compare before.json after.json` — it prints per-leg
plugin.exec/s, snapshot.push/s and herdr.rpc avg side by side. The
plugin-read leg only exercises plugins actually installed on the host;
legs with zero known plugins are recorded as skipped, never passed.

**Honest scope:** this measures the bridge↔herdr↔plugin-CLI data plane.
herdr *本体* workspace-switch latency inside its own TUI is a herdr-side
metric and is tracked on #416 via the `herdr.rpc`/`machine.*` timers plus
manual TUI observation — herdr-t3 cannot instrument herdr's renderer.
CPU/RAM of the herdr-t3 process itself is covered by the deferred
packaged-app startup/memory suite at RC freeze (see Coverage map).

## Demand-driven delivery & non-interference metrics (issue #572, program #568)

Assurance metrics for the demand-driven terminal-data program: measure
that only visible surfaces cost delivery/RPC, and that an observing
client cannot perturb a writable one. All numbers come from the existing
benches — no parallel harness.

**New server metrics** (`server/metrics.ts` gained `metricAdd`/`meters`
— quantity accumulators distinct from duration timers, exposed on
`/api/metrics` and the `herdr-t3:metrics` IPC):

| metric | kind | meaning |
|---|---|---|
| `terminal.delivery.bytes{phase=initial}` | meter (bytes) | terminal bytes delivered between AttachTerminal resolution and the first AttachScroll on that link — the initial-attach delivery per attach (`count` = frames; divide `total` by `terminal.link.open` for per-pane average) |
| `terminal.delivery.bytes{phase=scroll}` | meter (bytes) | bytes delivered after the first scroll gesture — history paging **plus** live output; an upper bound on paging volume, since herdr protocol v22 has no separate history-fetch message (AttachScroll is the only paging trigger) |
| `terminal.link.open` / `terminal.link.close` | counter | client-protocol attach/detach lifecycle |
| `bridge.terminal.attach` / `bridge.terminal.detach` | counter | bridge attach attempts / slot teardowns (clean unsubscribe and failure paths) |
| `bridge.terminal.op{op=input|resize|mouse|scroll}` | counter | client ops that reached a live or attaching slot — compare against `client.frame{type=…}` issued counts to spot drops/amplification |

**Bench legs.**

- `perf-bridge-load.ts` gained the `terminal-io` leg (see legs table
  above): attach batch → bounded output storm → scroll/resize probes →
  detach. `evaluateLeg` fails on op amplification, duplicate attaches,
  and subscription reopen amplification; delivery bytes are *reported*
  per leg (MiB, MiB/s, initial/post-scroll split) — thresholds are
  provisional until RC freeze, same convention as the other legs.
- `perf-memory-bench.ts` gained the `hidden` scenario (in `all`): N
  workspaces (`--hidden-workspaces`, default 6) run a throttled ~300
  KiB/s/pane chunk looper for 14 s while the UI stays on the fixture
  workspace. Every scenario now also records a `bridge` delta
  (`/api/metrics` counters+meters over the scenario window), so
  attach/detach counts per workspace switch and per-scenario delivery
  bandwidth are in `summary[<scenario>].bridge`. `--check` enforces
  `HIDDEN_DELIVERY_MAX_BYTES` (default 4 MiB,
  `--max-hidden-delivery-mb`): hidden panes stream ~25 MiB aggregate,
  so a demand-driven regression exceeds the ceiling ~6× while visible-
  pane idle noise stays orders below; unmeasured bridge metrics fail.
- Contract tests (`bun test`, no live herdr): `server/bridge-core.test.ts`
  "demand-driven delivery" asserts unsubscribed panes open zero
  client-protocol connections (load scales with visible usage), scroll
  encodes AttachScroll and meters post-scroll bytes; "multi-client
  non-interference" asserts the second client's AttachTerminal carries
  `takeover=false` vs the writable client's `true`, observer
  input/resize/scroll never reach the writable link, an
  `ObserveTerminal` (`writable:false`, issue #571) client is dropped at
  the bridge for input/scroll/mouse while resize flows on its own link
  only, and observer detach leaves the writable link alive; machine-tag
  propagation covers multi-host isolation, and
  `server/machine-manager.test.ts` proves an unknown-machine rpc is
  refused once, never forwarded to local. The attach-mode contract itself
  is specified in `docs/migration/contracts/terminal-noninterference.md`.

**Honest gaps.**

- The non-interference tests pin *what the bridge sends* (takeover flag,
  per-link isolation, observe-mode drops). Whether herdr itself honors a
  non-takeover `AttachTerminal` against a live TUI client is upstream
  semantics — `ObserveTerminal` (variant 7) is implemented since #571 and
  `ControlTerminal` (variant 8, a writable-attach alias) remains
  unimplemented in `client-link.ts`; the full observe/control split is
  specified in `docs/migration/contracts/terminal-noninterference.md`
  and tracked as upstream-contract work under #568.
- `terminal.delivery.bytes` meters **every** client-protocol terminal
  stream, including `ObserveTerminal` links — observe streams can never
  scroll, so their bytes all land in `phase=initial`.
- `bridge.terminal.attach` counts link-open *attempts*: a #571
  observe↔writable mode switch closes the old link and re-attaches, so
  it counts as a second attach while `bridge.terminal.detach` (slot
  teardown) stays single; pair with `terminal.link.open/close` for the
  socket-level view.
- `phase=scroll` bytes include live output after the first scroll, so it
  overstates pure history paging; a dedicated paging counter needs a
  protocol signal that does not exist yet.
- The hidden leg measures bridge→client delivery; herdr-internal
  scrollback retention for hidden panes is herdr's own concern (its
  scrollback caps apply regardless of clients).

**RC evaluation commands** (extend the #552 leg; same isolated-session
and committed-baseline rules):

```sh
# 1. Bridge data-plane incl. the terminal-io delivery leg.
bun scripts/perf-bridge-load.ts record --seconds 12 --out perf-reports/bridge-load-<rc-sha>-572.json

# 2. Memory bench incl. the hidden non-interference leg, gated.
bun scripts/perf-memory-bench.ts --check --scenario all --out perf-reports/mem-<rc-sha>-572.json

# 3. Contract gate (per-commit, already in ci.sh).
bun scripts/perf-contract-check.ts && bun scripts/perf-contract-check.ts --self-test
```

## Fast gate vs RC gate

- Fast gate (`bun test`, `./scripts/ci.sh`): only deterministic, cheap
  checks — `perf-baseline.test.ts`, `perf-bridge-load.test.ts` and
  `perf-frame-bench.test.ts` fault injection, plus
  `scripts/perf-observe.test.ts` verdict/diagnose rejection tests and
  `scripts/perf-contract-check.ts` (wired into `ci.sh`), which asserts
  every bounded resource the benches rely on still exists and is
  unit-covered: scrollback byte cap (`SCROLLBACK_MAX_BYTES` /
  `scrollback_bytes`, TS + Rust), the `memoryBudget` shed path, bridge
  `slot.queue` caps, `PaneTerminal` pending caps, the plugin exec
  semaphore, `LruCache` bounds, the #572 demand-driven delivery metrics
  (`metricAdd`/meters, per-phase delivery bytes, attach/op counters) and
  the non-interference contract (takeover flag, observer isolation,
  hidden-surface gate) — plus the committed baselines under
  `perf-reports/`. No wall-clock benchmarks in CI per-commit.
- RC freeze: full `record` on reference macOS + Windows 11 hardware,
  `check` against committed baselines, packaged-app startup/memory
  suite, both-OS evidence committed under `docs/design/evidence/`.

### RC-freeze evaluation leg (issue #552)

The release-candidate performance verdict is a manual, on-demand leg —
it is deliberately NOT wired into per-PR or release-path CI
(`.github/workflows/release-path.yml` only validates branch shape; the
benches need ~10-minute real-app runs on reference hardware, which CI
does not provide). Run it on the RC freeze commit, on an otherwise-idle
reference machine, macOS and Windows 11 separately:

```sh
# 1. Absolute-budget benches under --check (memory + frame).
#    Same fixed conditions for every leg: default storm size/seconds,
#    default budgets, no --cpu-throttle.
bun scripts/perf-memory-bench.ts --check --out perf-reports/mem-<rc-sha>-rc.json
bun scripts/perf-frame-bench.ts  --check --out perf-reports/frame-<rc-sha>-rc.json

# 2. Compare each candidate against the committed baseline of the same
#    report kind. Exit codes: 0=pass, 1=regression, 3=inconclusive,
#    2=usage. --json emits the machine-readable verdict.
bun scripts/perf-observe.ts compare perf-reports/mem-baseline-0e5d6a7.json   perf-reports/mem-<rc-sha>-rc.json
bun scripts/perf-observe.ts compare perf-reports/frame-2febbbf.json          perf-reports/frame-<rc-sha>-rc.json

# 3. Verdict rule: BOTH compares must print verdict "pass" (exit 0).
#    "inconclusive" (exit 3) is NOT a pass — it means the runs differed
#    in workload shape, host class, loadavg band, or had unmeasured/
#    missing metrics, so no code-attributable delta exists. Fix the
#    conditions (idle host, same --storm-* flags, same machine class)
#    and re-run; never average inconclusive legs into a pass.
```

Notes:

- The committed anchors are `perf-reports/mem-baseline-0e5d6a7.json`
  (memory, `stormMb:128/15s`) and `perf-reports/frame-2febbbf.json`
  (frame). `compare` refuses cross-workload/cross-host pairs, so the
  RC legs must reuse the anchors' workload shape; if the anchor's
  recorded `condition.loadavg` band cannot be matched on the freeze
  machine, record a new same-condition anchor first and commit it.
- `--check` on the benches is the absolute-ceiling gate (memory:
  jsHeap/Chrome/bridge/herdr budgets + convergence; frame: provisional
  input→paint p95 / CPU budgets). A `--check` breach exits 1 and fails
  the leg regardless of the compare verdict.
- Post-hoc diagnosis of a suspect run:
  `bun scripts/perf-observe.ts diagnose --user-data "<userData dir>"`
  analyzes `memory-history.jsonl` anomaly windows; it exits 1 on
  missing/insufficient history — a diagnose failure is evidence of
  missing forensics, not a pass.
