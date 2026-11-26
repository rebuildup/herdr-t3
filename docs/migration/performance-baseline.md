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
| Canvas2D rasterization (`GhosttyRenderer.paint`: fillText/drawImage onto canvas) | deferred — DOM-bound; needs CDP Performance/LongTasks or traced canvas timing in the real app |
| startup time, idle CPU/RSS, peak memory | deferred — needs packaged-app harness at RC |
| multi-pane / large output | partially — engine bench is single-grid; extend workload at RC |
| input-to-paint p50/p95/p99, scroll/resize/streaming | partially — scene path timed in Bun; end-to-end input→photon latency still needs renderer-side instrumentation |
| local/SSH/reconnect, plugin calls | deferred — bridge-level timing not yet instrumented |
| distribution artifact size | covered by release evidence manifests (`docs/design/evidence/rc-*`) |

The Rust port must reproduce **equivalent functionality and render
volume** before numbers are comparable — the gate assumes feature
equivalence per `docs/migration/contracts/`, it does not prove it.
No Rust-side improvement is assumed; the baseline exists to detect
regressions, not to promise wins.

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
drawImage rasterization) is DOM-bound and unmeasured in Bun. The
honest next step is CDP `Performance`/`LongTasks` (or a `console.time`
around `renderer.render()` in a dev build) during a scripted
scrollback+output workload in the real app — recorded here as
follow-up, not fabricated.

## Fast gate vs RC gate

- Fast gate (`bun test`, `./scripts/ci.sh`): only deterministic, cheap
  checks — `perf-baseline.test.ts` fault injection. No wall-clock
  benchmarks in CI per-commit.
- RC freeze: full `record` on reference macOS + Windows 11 hardware,
  `check` against committed baselines, packaged-app startup/memory
  suite, both-OS evidence committed under `docs/design/evidence/`.
