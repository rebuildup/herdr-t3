import { execFileSync } from "node:child_process";
import { cpus, totalmem, platform, arch, hostname, loadavg } from "node:os";
import { join } from "node:path";

/**
 * Reproducible performance baseline + non-regression gate (issue #240).
 *
 * Wraps scripts/perf-terminal-bench.ts (issue #231): runs it ITERATIONS
 * times, records machine-readable stats + environment metadata, and can
 * compare a fresh run against a stored baseline. Numbers are only
 * comparable on the same machine class — the report records everything
 * needed to judge that (git SHA, OS, CPU, Bun version, workload seed).
 *
 * Usage:
 *   bun scripts/perf-baseline.ts record [--iterations N] [--out PATH]
 *   bun scripts/perf-baseline.ts check <baseline.json> [--threshold-pct N]
 *
 * Fast gate: `bun test scripts/perf-baseline.test.ts` covers stats and
 * fault detection only. Full benchmarks run at release-candidate freeze.
 */

export const REPORT_FORMAT = "herdr-t3/perf-baseline";
export const REPORT_VERSION = 1;

export interface BenchRun {
  command: string;
  iterations: number;
  totals_ms: number[];
  cells_decoded_total: number;
  /** paint ops emitted, scene bench only (issue #354) */
  ops_total?: number;
  p50_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  cv: number;
}

export interface PerfReport {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  recorded_at: string;
  git_sha: string;
  host: {
    platform: string;
    arch: string;
    hostname: string;
    cpu_model: string;
    cpu_count: number;
    mem_total_bytes: number;
  };
  bun_version: string;
  workload: {
    bench: string;
    seed: number;
    ticks: number;
    note: string;
  };
  bench: BenchRun;
  /**
   * Scene/paint-path bench (issue #354): SurfaceCore.tick + GhosttyScene
   * collect/render op emission under the same output storm plus scroll
   * jumps. Absent in baselines recorded before #354 — `check` skips the
   * comparison then rather than failing.
   */
  scene?: BenchRun & { workload: { ticks: number; note: string } };
  /** machine load at record time — evidence for leg comparability, not a gate */
  condition?: {
    loadavg_1m: number;
    loadavg_5m: number;
    loadavg_15m: number;
    /**
     * System-wide CPU busy fraction (0..1) measured from os.cpus() time
     * deltas across the whole bench run. loadavg is always 0 on win32, so
     * this is the only real load signal there; on POSIX it complements
     * loadavg with a utilization figure instead of a run-queue depth.
     */
    cpu_busy?: number;
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of empty sample");
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarizeRuns(totalsMs: number[]): Omit<BenchRun, "command" | "iterations"> {
  if (totalsMs.length === 0) throw new Error("no measurements recorded");
  for (const t of totalsMs) {
    if (!Number.isFinite(t) || t <= 0) throw new Error(`invalid measurement: ${t}`);
  }
  const sorted = [...totalsMs].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / sorted.length;
  const sd = Math.sqrt(variance);
  return {
    totals_ms: sorted,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    min_ms: sorted[0]!,
    max_ms: sorted[sorted.length - 1]!,
    cv: mean === 0 ? 0 : sd / mean,
    cells_decoded_total: 0, // filled by caller
  };
}

export interface RegressionVerdict {
  ok: boolean;
  baseline_p50_ms: number;
  current_p50_ms: number;
  delta_pct: number;
  threshold_pct: number;
  reason: string;
}

/**
 * Compare current p50 against baseline. Only meaningful on comparable
 * hosts — callers must check host/git metadata first (checkHostMatch).
 */
export function checkRegression(
  baseline: PerfReport,
  current: PerfReport,
  thresholdPct: number,
  benchKey: "bench" | "scene" = "bench",
): RegressionVerdict {
  const baselineBench = benchKey === "scene" ? baseline.scene : baseline.bench;
  const currentBench = benchKey === "scene" ? current.scene : current.bench;
  if (!baselineBench || !currentBench) {
    throw new Error(`no ${benchKey} measurements to compare`);
  }
  const b = baselineBench.p50_ms;
  const c = currentBench.p50_ms;
  const deltaPct = ((c - b) / b) * 100;
  const ok = deltaPct <= thresholdPct;
  return {
    ok,
    baseline_p50_ms: b,
    current_p50_ms: c,
    delta_pct: deltaPct,
    threshold_pct: thresholdPct,
    reason: ok
      ? `within threshold (${deltaPct.toFixed(1)}% <= ${thresholdPct}%)`
      : `regression ${deltaPct.toFixed(1)}% exceeds threshold ${thresholdPct}%`,
  };
}

/** Numbers from different machines/builds are not comparable — reject. */
export function checkHostMatch(baseline: PerfReport, current: PerfReport): string | null {
  const diffs: string[] = [];
  if (baseline.host.platform !== current.host.platform) diffs.push("platform");
  if (baseline.host.arch !== current.host.arch) diffs.push("arch");
  if (baseline.host.cpu_model !== current.host.cpu_model) diffs.push("cpu_model");
  if (baseline.bun_version !== current.bun_version) diffs.push("bun_version");
  if (baseline.workload.seed !== current.workload.seed) diffs.push("workload.seed");
  return diffs.length ? `incomparable environments: ${diffs.join(", ")}` : null;
}

const REPO_ROOT = join(import.meta.dir, "..");
const BENCH = join(REPO_ROOT, "scripts/perf-terminal-bench.ts");
const SCENE_BENCH = join(REPO_ROOT, "scripts/perf-scene-bench.ts");

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Parse `total=NNNms` (and rows/cells/ops) out of one bench run's stdout. */
export function parseBenchOutput(stdout: string): { total_ms: number; cells: number; ops: number } {
  const m = /total=([\d.]+)ms/.exec(stdout);
  const c = /cellsDecoded=(\d+)/.exec(stdout);
  const o = /ops=(\d+)/.exec(stdout);
  if (!m) throw new Error(`bench output missing total: ${stdout.slice(0, 200)}`);
  return { total_ms: Number(m[1]), cells: c ? Number(c[1]) : 0, ops: o ? Number(o[1]) : 0 };
}

function collect(iterations: number, bench: string): { totals: number[]; cells: number; ops: number } {
  const totals: number[] = [];
  let cells = 0;
  let ops = 0;
  for (let i = 0; i < iterations; i++) {
    const out = execFileSync(process.execPath, [bench], { cwd: REPO_ROOT, encoding: "utf8" });
    const parsed = parseBenchOutput(out);
    totals.push(parsed.total_ms);
    cells = parsed.cells;
    ops = parsed.ops;
  }
  return { totals, cells, ops };
}

function env(): PerfReport["host"] & { bun: string } {
  const cpu = cpus()[0];
  return {
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    cpu_model: cpu?.model ?? "unknown",
    cpu_count: cpus().length,
    mem_total_bytes: totalmem(),
    bun: Bun.version,
  };
}

function condition(): NonNullable<PerfReport["condition"]> {
  const [l1, l5, l15] = loadavg();
  return { loadavg_1m: l1, loadavg_5m: l5, loadavg_15m: l15 };
}

/** Aggregated os.cpus() jiffies; deltas across a run give real CPU busy. */
export interface CpuTimes {
  idle: number;
  total: number;
}

export function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Busy fraction (0..1) between two cpuTimes() snapshots, summed across
 * all cores — i.e. machine-wide utilization, not per-core. Returns null
 * when the interval had no measurable time (should not happen).
 */
export function cpuBusyFraction(before: CpuTimes, after: CpuTimes): number | null {
  const dTotal = after.total - before.total;
  const dIdle = after.idle - before.idle;
  if (!(dTotal > 0) || dIdle < 0) return null;
  return Math.min(1, Math.max(0, 1 - dIdle / dTotal));
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name: string, dflt: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1]! : dflt;
  };

  if (cmd === "record") {
    const iterations = Number(arg("--iterations", "7"));
    const out = arg("--out", join(REPO_ROOT, "perf-reports", `baseline-${gitSha().slice(0, 8)}.json`));
    const cpuBefore = cpuTimes();
    const { totals, cells } = collect(iterations, BENCH);
    const sceneRun = collect(iterations, SCENE_BENCH);
    const e = env();
    const stats = summarizeRuns(totals);
    stats.cells_decoded_total = cells;
    const sceneStats = { ...summarizeRuns(sceneRun.totals), ops_total: sceneRun.ops };
    const cond = condition();
    const cpuBusy = cpuBusyFraction(cpuBefore, cpuTimes());
    if (cpuBusy !== null) cond.cpu_busy = cpuBusy;
    const report: PerfReport = {
      format: REPORT_FORMAT,
      version: REPORT_VERSION,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: {
        platform: e.platform,
        arch: e.arch,
        hostname: e.hostname,
        cpu_model: e.cpu_model,
        cpu_count: e.cpu_count,
        mem_total_bytes: e.mem_total_bytes,
      },
      bun_version: e.bun,
      workload: {
        bench: "scripts/perf-terminal-bench.ts",
        seed: 42,
        ticks: 400,
        note: "ANSI streaming decode+frame, base64 bridge hop; fixed LCG seed 42 inside bench",
      },
      bench: {
        command: `bun ${BENCH}`,
        iterations,
        ...stats,
      },
      scene: {
        command: `bun ${SCENE_BENCH}`,
        iterations,
        ...sceneStats,
        workload: {
          ticks: 200,
          note: "SurfaceCore.tick + GhosttyScene collect/render op emission, output storm + scroll jumps; Canvas2D rasterization excluded (DOM-bound)",
        },
      },
      condition: cond,
    };
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
    console.log(`p50=${report.bench.p50_ms.toFixed(1)}ms p95=${report.bench.p95_ms.toFixed(1)}ms cv=${(report.bench.cv * 100).toFixed(1)}%`);
    if (report.scene) {
      console.log(`scene p50=${report.scene.p50_ms.toFixed(1)}ms p95=${report.scene.p95_ms.toFixed(1)}ms cv=${(report.scene.cv * 100).toFixed(1)}% ops=${report.scene.ops_total ?? 0}`);
    }
    console.log(`condition loadavg=${report.condition?.loadavg_1m.toFixed(2)}/${report.condition?.loadavg_5m.toFixed(2)}/${report.condition?.loadavg_15m.toFixed(2)} cpu_busy=${report.condition?.cpu_busy?.toFixed(3) ?? "n/a"}`);
    return 0;
  }

  if (cmd === "check") {
    const baselinePath = rest[0];
    if (!baselinePath) {
      console.error("usage: perf-baseline.ts check <baseline.json> [--threshold-pct N]");
      return 2;
    }
    const threshold = Number(arg("--threshold-pct", "20"));
    const { readFileSync } = await import("node:fs");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as PerfReport;
    const iterations = Number(arg("--iterations", "7"));
    const cpuBefore = cpuTimes();
    const { totals, cells } = collect(iterations, BENCH);
    // The scene bench runs only when the baseline has a scene section —
    // reports recorded before #354 compare decode-only.
    const sceneCollected = baseline.scene ? collect(iterations, SCENE_BENCH) : null;
    const e = env();
    const stats = summarizeRuns(totals);
    stats.cells_decoded_total = cells;
    const cond = condition();
    const cpuBusy = cpuBusyFraction(cpuBefore, cpuTimes());
    if (cpuBusy !== null) cond.cpu_busy = cpuBusy;
    const current: PerfReport = {
      format: REPORT_FORMAT,
      version: REPORT_VERSION,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: {
        platform: e.platform, arch: e.arch, hostname: e.hostname,
        cpu_model: e.cpu_model, cpu_count: e.cpu_count, mem_total_bytes: e.mem_total_bytes,
      },
      bun_version: e.bun,
      workload: baseline.workload,
      bench: { command: `bun ${BENCH}`, iterations: totals.length, ...stats },
      condition: cond,
    };
    // The scene bench exists only in reports recorded after #354; when the
    // baseline lacks it the comparison is decode-only (documented, not a
    // silent pass — the verdict line says which benches ran).
    if (baseline.scene && sceneCollected) {
      current.scene = {
        command: `bun ${SCENE_BENCH}`,
        iterations: sceneCollected.totals.length,
        ...summarizeRuns(sceneCollected.totals),
        ops_total: sceneCollected.ops,
        workload: baseline.scene.workload,
      };
    }
    const hostIssue = checkHostMatch(baseline, current);
    if (hostIssue) {
      console.error(`cannot compare: ${hostIssue}`);
      return 2;
    }
    const verdict = checkRegression(baseline, current, threshold);
    console.log(`${verdict.ok ? "PASS" : "FAIL"}  decode/frame ${verdict.reason}`);
    console.log(`  baseline p50=${verdict.baseline_p50_ms.toFixed(1)}ms  current p50=${verdict.current_p50_ms.toFixed(1)}ms  delta=${verdict.delta_pct.toFixed(1)}%`);
    let ok = verdict.ok;
    if (current.scene && baseline.scene) {
      const sceneVerdict = checkRegression(baseline, current, threshold, "scene");
      console.log(`${sceneVerdict.ok ? "PASS" : "FAIL"}  scene/paint ${sceneVerdict.reason}`);
      console.log(`  baseline p50=${sceneVerdict.baseline_p50_ms.toFixed(1)}ms  current p50=${sceneVerdict.current_p50_ms.toFixed(1)}ms  delta=${sceneVerdict.delta_pct.toFixed(1)}%`);
      ok = ok && sceneVerdict.ok;
    } else {
      console.log("scene/paint: skipped (baseline has no scene section)");
    }
    return ok ? 0 : 1;
  }

  console.error("usage: perf-baseline.ts record|check ...");
  return 2;
}

if (import.meta.main) process.exit(await main());
