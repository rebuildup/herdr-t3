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
- `scripts/perf-frame-bench.ts` (#354 follow-up): real frame-time bench —
  drives the running app (isolated herdr session → bridge → vite →
  headless Chrome CDP) through the same seed-42 output storm plus CDP
  wheel scroll traversal, and records rAF frame intervals, longtasks,
  task utilization and Canvas2D API time per window. Self-contained
  (spawns and reaps its own stack); reports to `perf-reports/frame-*.json`.
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
| memory growth / leaks (JS heap, Chrome tree, bridge, herdr) under idle/storm/kitty/switch workloads | ✅ `perf-memory-bench.ts` (CDP, real app, isolated herdr session; issue #499). `--check` enforces absolute per-scenario budgets (default jsHeap 256 MB / Chrome tree 2048 MB / bridge 512 MB / herdr 512 MB) plus convergence gates: tail-slope flattening for idle/switch and storm2-vs-storm peak reuse. Kitty chunks exercise the full transmit/place/move/delete lifecycle. Evidence: `perf-reports/mem-*.json` |
| startup time, idle CPU/RSS | deferred — needs packaged-app harness at RC |
| multi-pane / large output | partially — engine bench is single-grid; extend workload at RC |
| input-to-paint p50/p95/p99, scroll/resize/streaming | partially — scene path timed in Bun; `perf-frame-bench.ts` gives frame-interval/longtask/task-utilization under storm, but input→photon latency still needs renderer-side instrumentation |
| local/SSH/reconnect, plugin calls | ✅ bridge data-plane leg — `scripts/perf-bridge-load.ts` (#425/#416); SSH transport still deferred |
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
  `src/lib/memoryBudget.ts`; native: TBD — must land before GPUI ships
  panes). Over budget → lossless cache shedding only; WASM/native heap
  cannot shrink without session disposal, so shedding is rate-limited
  and attributed (top sessions named) rather than thrashing.
- **Watchdog**: main process derives warn/critical/breach from physical
  RAM, a 2 h measured baseline, a 15 min RSS slope, and OS free-memory
  pressure (`osFreePct`); only breach reloads. `herdr-t3:memory-pressure`
  pushes drive renderer shedding. The native port must reproduce the
  same level semantics — a fixed absolute threshold is a defect, not a
  design.
- **Measurement**: `perf-memory-bench.ts --check` gates absolute budgets
  plus convergence (tail slope, storm2/switch2 reuse). The same
  scenarios must run against the GPUI host before parity is claimed.

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
| `reconnect` | WS drop + reconnect cycles | each connect costs exactly 1 `session.snapshot` fetch + 1 `subscription.open`; more is session/subscription fan-out |

**Report** (`perf-reports/bridge-load-<sha>.json`): per-leg metric
*deltas* (not cumulative counters) for every `bridge.*`,
`herdr.rpc{method=…}`, `plugin.exec{what=…,command=…}`,
`plugin.discovery/capability`, `client.frame`, `machine.*` key, plus
client-side rpc_result latency p50/p95/max, `condition.loadavg`, host
metadata and git SHA — same comparability rules as the terminal baselines
(same host class + same loadavg band; `compare` refuses cross-host).

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

## Fast gate vs RC gate

- Fast gate (`bun test`, `./scripts/ci.sh`): only deterministic, cheap
  checks — `perf-baseline.test.ts` and `perf-bridge-load.test.ts` fault
  injection. No wall-clock benchmarks in CI per-commit.
- RC freeze: full `record` on reference macOS + Windows 11 hardware,
  `check` against committed baselines, packaged-app startup/memory
  suite, both-OS evidence committed under `docs/design/evidence/`.
