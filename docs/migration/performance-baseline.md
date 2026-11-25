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
- `scripts/perf-baseline.ts`: runner + gate.
  - `record --iterations N --out PATH` → machine-readable report
    (`perf-reports/baseline-<sha>.json`)
  - `check <baseline> [--threshold-pct N]` → re-runs and compares p50
- `scripts/perf-baseline.test.ts`: fault-injection tests — invalid
  measurements rejected, intentional +50% slowdown detected,
  cross-machine comparisons refused.

## Report contents (machine-readable)

`format`, `version`, `recorded_at`, `git_sha`, host (`platform`,
`arch`, `hostname`, `cpu_model`, `cpu_count`, `mem_total_bytes`),
`bun_version`, workload (`bench`, `seed`, `ticks`, `note`), and bench
stats: per-iteration `totals_ms`, `p50/p95/min/max`, coefficient of
variation, cells decoded.

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
| startup time, idle CPU/RSS, peak memory | deferred — needs packaged-app harness at RC |
| multi-pane / large output | partially — engine bench is single-grid; extend workload at RC |
| input-to-paint p50/p95/p99, scroll/resize/streaming | deferred — needs renderer-side instrumentation |
| local/SSH/reconnect, plugin calls | deferred — bridge-level timing not yet instrumented |
| distribution artifact size | covered by release evidence manifests (`docs/design/evidence/rc-*`) |

The Rust port must reproduce **equivalent functionality and render
volume** before numbers are comparable — the gate assumes feature
equivalence per `docs/migration/contracts/`, it does not prove it.
No Rust-side improvement is assumed; the baseline exists to detect
regressions, not to promise wins.

## Fast gate vs RC gate

- Fast gate (`bun test`, `./scripts/ci.sh`): only deterministic, cheap
  checks — `perf-baseline.test.ts` fault injection. No wall-clock
  benchmarks in CI per-commit.
- RC freeze: full `record` on reference macOS + Windows 11 hardware,
  `check` against committed baselines, packaged-app startup/memory
  suite, both-OS evidence committed under `docs/design/evidence/`.
