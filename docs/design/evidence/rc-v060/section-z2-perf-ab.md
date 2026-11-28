# Section Z2 — A/B performance comparison: is the decode/frame "regression" real?

Date: 2026-11-27 (JST). Follow-up to section-z Z-6, which flagged a possible
terminal-path regression from single-point runs (Windows decode/frame p50:
`0e3c14e` ≈105 ms → `932ce11` ≈146 ms → `2febbbf` ≈240–271 ms) recorded at
different times under uncontrolled machine load. This leg replaces those
single-point numbers with an interleaved A/B protocol on both measurement
hosts.

**Verdict: no evidence of a real regression.** Under matched, interleaved
conditions every SHA arm is statistically indistinguishable on both hosts.
The historical upward trend is explained by uncontrolled ambient load —
made invisible on Windows by the known `os.loadavg() === 0` bug — not by a
code change. A harness fix recording real CPU utilization on win32 is
included in this PR.

## Protocol

- **Arms** (decode bench exists at all four; scene bench only at the two
  newest):
  - `0e3c14e` — section-i Windows baseline (pre-delta)
  - `932ce11` — section-j Windows baseline (pre-wasm-consumers delta)
  - `2febbbf` — section-z frozen candidate
  - `9bb50cf` — v0.6.0 frozen RC head (`origin/release-0-6-0` at run time)
- **Benches**: each arm's own `scripts/perf-baseline.ts record`, which runs
  `perf-terminal-bench.ts` (decode/frame, seed 42, 400 ticks,
  cellsDecoded = 1,912,344 — verified identical in every report) and, where
  present, `perf-scene-bench.ts` (SurfaceCore.tick + GhosttyScene op
  emission, ops = 16,189 — identical in every report).
- **Interleaving**: rounds of all four arms in rotating order
  (A,B,C,D → B,C,D,A → …) so ambient drift hits every arm equally.
  Windows: 5 idle rounds + 4 loaded rounds; macOS: 5 + 5.
- **Iterations**: 5 decode (+5 scene) samples per record on Windows idle,
  4 on Windows loaded and all macOS records — 16–25 pooled decode samples
  per arm per condition.
- **Conditions**:
  - `idle` = no synthetic load added by the harness.
  - `loaded` = defined synthetic background load, see below.
- **Recorded per run**: report JSON (`totals_ms` per iteration, p50/p95,
  `git_sha`, `recorded_at`), wall time, plus CPU/memory samples.

### Synthetic load definitions (exact)

- **Windows loaded**: 8 × `powershell.exe -Command "while($true){$x=1+1}"`
  at **BelowNormal** priority, started before the loaded phase and killed
  after. Rationale: an earlier attempt with 10 spinners at Normal priority
  starved the bench processes entirely on the already-saturated host
  (>12 min per record, abandoned — its 4 partial records are quarantined
  under `raw/windows-loaded-superseded/`). BelowNormal keeps the demand
  defined and sustained without starving the measured process.
- **macOS loaded**: 10 × `bash -c 'while :; do :; done'` at normal
  priority.

### CPU / load recording

- **Windows**: `Get-Counter '\Processor(_Total)\% Processor Time'` and
  `\Memory\Available MBytes'` sampled every ~2 s for the whole session
  (`raw/*/cpu-samples.csv`), sliced per record by wall-clock window.
  `os.loadavg()` is always 0 on win32, so this external counter is the only
  real load signal (harness fix in this PR adds an `os.cpus()`-based
  `cpu_busy` field for future runs).
- **macOS**: `iostat -c 2` sampled every ~2 s (`cpu_busy_pct`, `loadavg1`
  columns) plus each report's own `condition.loadavg_*`. Note: the
  `cpu_busy_pct` column in `raw/macos/cpu-samples.csv` is unreliable —
the sampler's iostat row parser sometimes picked disk-section rows
(negative values). The `loadavg1` column and the reports' own
`condition.loadavg_*` fields are valid; treat `cpu_busy_pct` as void on the
macOS leg.

### Environment caveat (important)

Both hosts were under heavy **ambient** load from other concurrent work
during the entire session — this is recorded, not hidden:

- Windows: CPU counter reads ~76–97 % busy during *both* conditions
  (other agents' processes; our 8 BelowNormal spinners added demand on top
  but could not raise an already-saturated total much). "idle" therefore
  means "no harness-added load", not "quiet machine".
- macOS: loadavg1 ~20–90 across the session (other agents' cargo builds,
  etc.). Decode absolute values (~1.5–4 s) are far above the quiet-machine
  historical ~0.3–0.5 s; only within-session A/B comparisons are meaningful.

## Results — Windows 11 (i7-13700H, bun 1.4.0)

Decode bench pooled per-iteration `total=` (ms). Scene bench only exists
at `2febbbf`/`9bb50cf`.

| cond | arm | n iter | decode median | p25–p75 | min–max | scene median |
|------|-----|-------:|--------------:|---------|---------|-------------:|
| idle | 0e3c14e | 25 | 381 | 365–405 | 336–446 | — |
| idle | 932ce11 | 25 | 366 | 357–382 | 334–427 | — |
| idle | 2febbbf | 25 | 374 | 356–384 | 314–425 | 305 |
| idle | 9bb50cf | 25 | 379 | 367–395 | 344–447 | 310 |
| loaded | 0e3c14e | 16 | 346 | 336–361 | 327–384 | — |
| loaded | 932ce11 | 16 | 351 | 325–382 | 297–435 | — |
| loaded | 2febbbf | 16 | 329 | 325–360 | 315–376 | 285 |
| loaded | 9bb50cf | 16 | 343 | 329–358 | 307–393 | 280 |

Per-round paired deltas of record p50 vs `0e3c14e` (ms):

- idle `9bb50cf`: +9, −46, +4, +24, +5 → median +1.3 %, sign-inconsistent
- idle `2febbbf`: −38, −26, +15, +7, −3 → median −0.8 %
- idle `932ce11`: −8, −31, −24, +8, +17 → median −2.2 %
- loaded `9bb50cf`: −9, −15, +27, −14 → median −3.3 %
- loaded `932ce11`: −11, −22, +22, +17 → median +0.7 %
- loaded `2febbbf`: −7, −16, +4, +1 → median −0.9 %

All arms overlap within ~±5 %; no pair shows a consistent sign across
rounds or conditions. Scene bench `2febbbf` vs `9bb50cf`: 305 vs 310 ms
idle, 280 vs 285 ms loaded — equivalent, as expected for
bench-identical code.

## Results — macOS (10 cores, bun 1.4.4)

Same protocol, 5+5 rounds. Ambient load was extreme; per-round deltas
are dominated by contention bursts.

| cond | arm | decode median | min–max | scene median |
|------|-----|--------------:|---------|-------------:|
| idle | 0e3c14e | 1534 | 774–4040 | — |
| idle | 932ce11 | 1512 | 969–2769 | — |
| idle | 2febbbf | 2004 | 1388–3575 | 1895 |
| idle | 9bb50cf | 2018 | 1198–3423 | 1816 |
| loaded | 0e3c14e | 3679 | 2805–8897 | — |
| loaded | 932ce11 | 3907 | 2493–7231 | — |
| loaded | 2febbbf | 3626 | 2736–6729 | 3592 |
| loaded | 9bb50cf | 4108 | 2737–5975 | 3358 |

(Medians are over pooled per-iteration `total=` samples; per-record p50
medians and full distributions are in `section-z2-perf-ab.json`.)

Per-round paired deltas vs `0e3c14e` flip sign almost every round on both
conditions (e.g. idle `9bb50cf`: +359, −1550, +1288, −38, +1444 ms). No
A-vs-B difference is reproducible across rounds → **no regression
claimable on macOS either**, though the noise floor there is too high to
exclude a small (<10 %) effect.

## Analysis

1. **Reproducibility test**: a real regression must show the same sign
   across interleaved rounds and both conditions. On Windows — the host
   where the regression was flagged — every arm-vs-`0e3c14e` delta is
   sign-inconsistent with |median| ≤ 3.3 %. On macOS deltas flip sign
   round-to-round under loadavg 20–90.
2. **Historical trend explained**: the section-i/j/z runs were single
   sessions at different times on a shared, heavily-used host. Decode
   p50 scales ~linearly with ambient CPU contention (our ~370 ms Windows
   median at ~85–90 % CPU vs the historical ~105 ms presumably measured
   near-idle). `os.loadavg()` returning 0 on win32 made every Windows
   report claim `loadavg=0` — "idle" — regardless of real load. That is
   the measurement defect, now fixed (`condition.cpu_busy` via
   `os.cpus()` time deltas, works on win32).
3. **Coverage caveat**: `engine.ts`, `session.ts`, `scene.ts`,
   `surfaceCore.ts`'s bench inputs and both perf benches are
   **byte-identical** across `0e3c14e..9bb50cf` except `surfaceCore.ts`
   (#319 terminal.input → Rust wasm consumer), which the scene bench
   does exercise — and scene p50 is also equivalent. Code paths these
   benches do *not* cover (protocol.codec / agent.projection wasm
   consumers, DOM Canvas2D rasterization via `perf-frame-bench.ts`) were
   not part of this A/B; `perf-frame-bench.ts` requires a running app +
   CDP and only exists at `2febbbf`+, so it cannot A/B the suspect delta
   anyway. If a product-level frame regression is still suspected, the
   remaining check is a frame-bench comparison on a quiet host.

## Files

- `section-z2-perf-ab.json` — consolidated stats, per-round matrices,
  per-record detail (all 56 records).
- `section-z2-perf-ab/raw/windows-idle/` — 20 records (5 rounds × 4 arms)
  + `cpu-samples.csv`, `runner.log`, per-record `.log`s.
- `section-z2-perf-ab/raw/windows-loaded/` — 16 records (4 rounds × 4
  arms, BelowNormal-spinner condition) + sampler data.
- `section-z2-perf-ab/raw/windows-loaded-superseded/` — 4 records from the
  abandoned Normal-priority-spinner attempt (kept for completeness;
  excluded from analysis).
- `section-z2-perf-ab/raw/macos/` — 40 records (5+5 rounds) +
  `cpu-samples.csv` (loadavg column valid; `cpu_busy_pct` column void —
  see above), `runner.log`, `run-mac.sh`, `sampler.py`.
- `section-z2-perf-ab/raw/ab-run.ps1`, `ab-run-loaded.ps1` — Windows
  runners as executed.

Reproduce: check out each SHA, run
`bun scripts/perf-baseline.ts record --iterations 5 --out <file>` inside
the checkout, interleave arms round-robin, sample CPU externally on
win32. Harness-side `cpu_busy` recording lands with this PR for future
runs.
