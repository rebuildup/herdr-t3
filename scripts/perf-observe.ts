#!/usr/bin/env bun
/**
 * Unified performance/memory observation tool (issues #416/#425/#499).
 *
 * Reads the artifacts the app already produces — no new instrumentation:
 *
 *   diagnose  userData/memory-history.jsonl + bridge-status.json
 *             → anomaly windows: sustained growth slopes, level
 *             transitions, dominant process type, OS-availability
 *             correlation. This is the post-hoc localizer for events
 *             like the 28.5 GB incident.
 *
 *   compare   two perf report JSONs (perf-memory-bench.ts `summary`
 *             reports or perf-frame-bench.ts per-window reports; issue
 *             #526 added the frame-report shape)
 *             → per-scenario/window deltas + regression flags, for
 *             commit/release/implementation comparisons.
 *
 * Usage:
 *   bun scripts/perf-observe.ts diagnose [--user-data <dir>] [--json]
 *   bun scripts/perf-observe.ts compare <baseline.json> <candidate.json> [--json]
 *                                       [--regression-pct 20]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface MemorySample {
  t: string;
  totalMb: number;
  byType: Record<string, number>;
  level: string;
  baselineMb: number;
  slopeMbPerMin: number;
  osAvailPct?: number;
}

interface ScenarioSummary {
  jsHeapPeakMb?: number;
  chromePeakMb?: number;
  chromeEndMb?: number;
  chromeTailSlopeMbPerMin?: number;
  bridgeEndMb?: number;
  herdrEndMb?: number;
  [k: string]: unknown;
}

const flag = (args: string[], name: string, dflt = ""): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};

function userDataDir(args: string[]): string {
  const explicit = flag(args, "--user-data");
  if (explicit) return explicit;
  const profile = process.env["HERDR_T3_PROFILE"] === "dev" ? "herdr-t3-dev" : "herdr-t3";
  return join(homedir(), "Library", "Application Support", profile);
}

export function diagnose(argv: string[] = []): number {
  const jsonOut = argv.includes("--json");
  const dir = userDataDir(argv);
  const histPath = join(dir, "memory-history.jsonl");
  const statusPath = join(dir, "bridge-status.json");
  if (!existsSync(histPath)) {
    console.error(`no memory history at ${histPath} — run a build with the #499 forensics`);
    return 1;
  }
  const samples: MemorySample[] = readFileSync(histPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as MemorySample;
      } catch {
        return null;
      }
    })
    .filter((s): s is MemorySample => s !== null && typeof s.totalMb === "number");
  if (samples.length < 2) {
    console.error(`only ${samples.length} samples — need more runtime`);
    return 1;
  }

  // Anomaly windows: contiguous runs where |slope| exceeds 96 MB/min or
  // level != ok, plus the largest single-sample jumps.
  const GROWTH_SLOPE = 96;
  const windows: {
    start: string; end: string; samples: number;
    fromMb: number; toMb: number; peakSlope: number; level: string;
    topType: string; osAvailMin?: number;
  }[] = [];
  let cur: (typeof windows)[number] | null = null;
  for (const s of samples) {
    const anomalous = Math.abs(s.slopeMbPerMin ?? 0) >= GROWTH_SLOPE || (s.level && s.level !== "ok");
    if (anomalous) {
      if (!cur) {
        const topType = Object.entries(s.byType ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?";
        cur = {
          start: s.t, end: s.t, samples: 0, fromMb: s.totalMb, toMb: s.totalMb,
          peakSlope: 0, level: s.level, topType, osAvailMin: s.osAvailPct,
        };
      }
      cur.end = s.t;
      cur.samples++;
      cur.toMb = Math.max(cur.toMb, s.totalMb);
      cur.peakSlope = Math.max(cur.peakSlope, Math.abs(s.slopeMbPerMin ?? 0));
      if ((s.osAvailPct ?? 100) < (cur.osAvailMin ?? 100)) cur.osAvailMin = s.osAvailPct;
      if (s.level && s.level !== "ok" && cur.level === "ok") cur.level = s.level;
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);

  // Largest process-type share at peak and its growth vs first sample.
  const peak = samples.reduce((a, b) => (b.totalMb > a.totalMb ? b : a));
  const first = samples[0]!;
  const typeDelta = Object.entries(peak.byType ?? {})
    .map(([k, v]) => ({ type: k, peakMb: v, deltaMb: v - (first.byType?.[k] ?? 0) }))
    .sort((a, b) => b.deltaMb - a.deltaMb);
  const levelTransitions = samples
    .filter((s, i) => i > 0 && s.level !== samples[i - 1]!.level)
    .map((s) => `${s.t}: ${samples[samples.indexOf(s) - 1]!.level} -> ${s.level} @${s.totalMb}MB`);

  const report = {
    generatedAt: new Date().toISOString(),
    source: histPath,
    samples: samples.length,
    span: { first: first.t, last: samples[samples.length - 1]!.t },
    totalMb: { first: first.totalMb, last: samples[samples.length - 1]!.totalMb, peak: peak.totalMb, peakAt: peak.t },
    levelTransitions,
    anomalyWindows: windows,
    processTypeDelta: typeDelta,
    osAvailPct: { min: Math.min(...samples.map((s) => s.osAvailPct ?? 100)), last: samples[samples.length - 1]!.osAvailPct },
  };
  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`memory history: ${report.samples} samples ${report.span.first} → ${report.span.last}`);
  console.log(`totalMb first=${report.totalMb.first} last=${report.totalMb.last} peak=${report.totalMb.peak}@${report.totalMb.peakAt}`);
  if (levelTransitions.length) {
    console.log("level transitions:");
    for (const t of levelTransitions) console.log(`  ${t}`);
  }
  if (windows.length) {
    console.log(`anomaly windows (|slope|>=${GROWTH_SLOPE}MB/min or level!=ok):`);
    for (const w of windows) {
      console.log(`  ${w.start}→${w.end} (${w.samples} samples) ${w.fromMb}→${w.toMb}MB peakSlope=${w.peakSlope}MB/min level=${w.level} top=${w.topType}${w.osAvailMin !== undefined ? ` osAvailMin=${w.osAvailMin}%` : ""}`);
    }
  } else {
    console.log("no anomaly windows");
  }
  console.log("process-type delta at peak vs first sample:");
  for (const d of typeDelta.slice(0, 5)) console.log(`  ${d.type}: ${d.peakMb}MB (Δ${d.deltaMb >= 0 ? "+" : ""}${d.deltaMb}MB)`);
  return 0;
}

interface ReportEnvelope {
  format?: string;
  summary?: Record<string, ScenarioSummary>;
  config?: Record<string, unknown>;
  workload?: Record<string, unknown>;
  host?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  sha?: string;
  git_sha?: string;
  [k: string]: unknown;
}

/** Workload keys compared for comparability across both report shapes
 *  (perf-memory-bench `config`, perf-frame-bench `workload`). Volatile
 *  keys like storm_attempts are deliberately excluded. */
const WORKLOAD_KEYS = [
  "stormMb", "stormSeconds", "scenario",
  "measure_seconds", "warmup_seconds", "idle_seconds", "switch_cycles",
  "scroll", "preload_scrollback_lines", "input_probe", "storm",
];

function normWorkload(env: ReportEnvelope): Record<string, unknown> {
  return (env.config ?? env.workload ?? {}) as Record<string, unknown>;
}
function normSha(env: ReportEnvelope): string | undefined {
  return env.sha ?? env.git_sha;
}
function normHost(env: ReportEnvelope): { totalMemMb?: number; cpus?: number; cpuModel?: string } {
  const h = env.host ?? {};
  const mem = h["totalMemMb"] ??
    (typeof h["mem_total_bytes"] === "number" ? (h["mem_total_bytes"] as number) / 1048576 : undefined);
  return {
    totalMemMb: mem as number | undefined,
    cpus: (h["cpus"] ?? h["cpu_count"]) as number | undefined,
    cpuModel: h["cpu_model"] as string | undefined,
  };
}
function normLoadavg0(env: ReportEnvelope): number | undefined {
  const h = env.host?.["loadavg"];
  if (Array.isArray(h) && typeof h[0] === "number") return h[0];
  const c = env.condition?.["loadavg_1m"];
  return typeof c === "number" ? c : undefined;
}

/** perf-frame-bench reports carry per-window objects (idle/storm/switch)
 *  instead of a `summary` map. */
function isFrameWindow(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null &&
    ("frames" in v || "task_utilization_pct" in v || "input_paint" in v);
}
function isFrameReport(env: ReportEnvelope): boolean {
  return env.format === "herdr-t3/perf-frame" ||
    ["idle", "storm", "switch"].some((k) => isFrameWindow(env[k]));
}
const FRAME_WINDOWS = ["idle", "storm", "switch"] as const;

interface MetricDef {
  label: string;
  lowerBetter: boolean;
  get: (w: unknown) => number | undefined;
}
const MEMORY_METRICS: MetricDef[] = [
  { label: "jsHeapPeak", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.jsHeapPeakMb as number | undefined },
  { label: "chromePeak", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.chromePeakMb as number | undefined },
  { label: "chromeEnd", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.chromeEndMb as number | undefined },
  { label: "chromeTailSlope", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.chromeTailSlopeMbPerMin as number | undefined },
  { label: "bridgeEnd", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.bridgeEndMb as number | undefined },
  { label: "herdrEnd", lowerBetter: true, get: (w) => (w as ScenarioSummary | undefined)?.herdrEndMb as number | undefined },
];
const FRAME_METRICS: MetricDef[] = [
  { label: "frameP50ms", lowerBetter: true, get: (w) => ((w as { frames?: { p50?: number } })?.frames?.p50) },
  { label: "frameP95ms", lowerBetter: true, get: (w) => ((w as { frames?: { p95?: number } })?.frames?.p95) },
  { label: "frameP99ms", lowerBetter: true, get: (w) => ((w as { frames?: { p99?: number } })?.frames?.p99) },
  { label: "longtaskCount", lowerBetter: true, get: (w) => (w as { longtask_count?: number })?.longtask_count },
  { label: "longtaskTotalMs", lowerBetter: true, get: (w) => (w as { longtask_total_ms?: number })?.longtask_total_ms },
  { label: "canvasApiMs", lowerBetter: true, get: (w) => (w as { canvas_api_ms?: number })?.canvas_api_ms },
  { label: "taskUtilPct", lowerBetter: true, get: (w) => (w as { task_utilization_pct?: number })?.task_utilization_pct },
  { label: "inputPaintP50ms", lowerBetter: true, get: (w) => ((w as { input_paint?: { p50?: number } })?.input_paint?.p50) },
  { label: "inputPaintP95ms", lowerBetter: true, get: (w) => ((w as { input_paint?: { p95?: number } })?.input_paint?.p95) },
  { label: "inputPaintP99ms", lowerBetter: true, get: (w) => ((w as { input_paint?: { p99?: number } })?.input_paint?.p99) },
  { label: "cpuUtilPct", lowerBetter: true, get: (w) => (w as { cpu_utilization_pct?: number })?.cpu_utilization_pct },
];

export function compare(
  baselinePath: string,
  candidatePath: string,
  argv: string[] = [],
): number {
  const jsonOut = argv.includes("--json");
  const regressionPct = Number(flag(argv, "--regression-pct", "20"));
  const load = (p: string): ReportEnvelope => JSON.parse(readFileSync(p, "utf8")) as ReportEnvelope;
  const baseEnv = load(baselinePath);
  const candEnv = load(candidatePath);

  // Environment consistency (issue #416): deltas are only meaningful when
  // both runs used the same workload shape and host class. Reports with
  // different storm sizes/seconds or a different host produce flags that
  // are artifacts, not regressions — observed with mem-baseline
  // (128 MiB/15 s, load ~10) vs mem-postfix (256 MiB/20 s, load ~16)
  // where every "regression" dissolved under the heavier run.
  const bw = normWorkload(baseEnv);
  const cw = normWorkload(candEnv);
  const workloadDiffs = WORKLOAD_KEYS
    .filter((k) => bw[k] !== undefined && cw[k] !== undefined && bw[k] !== cw[k])
    .map((k) => `${k}: ${bw[k]} vs ${cw[k]}`);
  const bh = normHost(baseEnv);
  const ch = normHost(candEnv);
  const hostDiffs: string[] = [];
  if (bh.totalMemMb !== undefined && ch.totalMemMb !== undefined && bh.totalMemMb !== ch.totalMemMb) {
    hostDiffs.push(`totalMemMb ${bh.totalMemMb} vs ${ch.totalMemMb}`);
  }
  if (bh.cpus !== undefined && ch.cpus !== undefined && bh.cpus !== ch.cpus) {
    hostDiffs.push(`cpus ${bh.cpus} vs ${ch.cpus}`);
  }
  if (bh.cpuModel !== undefined && ch.cpuModel !== undefined && bh.cpuModel !== ch.cpuModel) {
    hostDiffs.push(`cpuModel ${bh.cpuModel} vs ${ch.cpuModel}`);
  }
  const bLoad = normLoadavg0(baseEnv);
  const cLoad = normLoadavg0(candEnv);
  const loadDelta = bLoad !== undefined && cLoad !== undefined ? Math.abs(cLoad - bLoad) : 0;
  // A large loadavg gap means the two runs saw different host contention;
  // deltas can no longer be attributed to the code under test.
  const hostLoadSuspect = loadDelta > 4;
  const comparable = workloadDiffs.length === 0 && hostDiffs.length === 0 && !hostLoadSuspect;
  const comparability = {
    comparable,
    workloadDiffs,
    hostDiffs,
    loadavg1Delta: Math.round(loadDelta * 100) / 100,
    hostLoadSuspect,
    note: comparable
      ? "same workload shape and host class"
      : "deltas are NOT comparable — differences reflect the changed conditions, not the code",
  };

  const frameMode = isFrameReport(baseEnv) || isFrameReport(candEnv);
  const scenarios: string[] = [];
  const getWindow = (env: ReportEnvelope, sc: string): unknown =>
    frameMode ? env[sc] : env.summary?.[sc];
  const metrics = frameMode ? FRAME_METRICS : MEMORY_METRICS;
  if (frameMode) {
    for (const w of FRAME_WINDOWS) {
      if (isFrameWindow(baseEnv[w]) || isFrameWindow(candEnv[w])) scenarios.push(w);
    }
  } else {
    const base = baseEnv.summary ?? {};
    const cand = candEnv.summary ?? {};
    scenarios.push(...[...new Set([...Object.keys(base), ...Object.keys(cand)])].sort());
  }

  const rows: Record<string, unknown>[] = [];
  let regressions = 0;
  let unmeasured = 0;
  const missingScenarios: string[] = [];
  for (const sc of scenarios) {
    const b = getWindow(baseEnv, sc);
    const c = getWindow(candEnv, sc);
    if (b === undefined || c === undefined) missingScenarios.push(sc);
    const deltas: Record<string, { base?: number; cand?: number; deltaPct?: number; flag?: string }> = {};
    for (const m of metrics) {
      const bv = m.get(b);
      const cv = m.get(c);
      if (typeof bv !== "number" || typeof cv !== "number") continue;
      // A zero baseline means "not measured" (e.g. herdr pid uncaptured),
      // not "zero usage" — flag it instead of reporting a fake +100%.
      // Both-zero is a real zero and compares normally.
      if (bv === 0 && cv === 0) {
        deltas[m.label] = { base: bv, cand: cv, deltaPct: 0 };
        continue;
      }
      if (bv === 0) {
        deltas[m.label] = { base: bv, cand: cv, flag: "baseline-unmeasured" };
        unmeasured++;
        continue;
      }
      if (cv === 0) {
        deltas[m.label] = { base: bv, cand: cv, flag: "candidate-unmeasured" };
        unmeasured++;
        continue;
      }
      const deltaPct = ((cv - bv) / bv) * 100;
      const worse = m.lowerBetter ? cv > bv : cv < bv;
      const flag = worse && Math.abs(deltaPct) >= regressionPct ? `regression >${regressionPct}%` : undefined;
      if (flag) regressions++;
      deltas[m.label] = { base: bv, cand: cv, deltaPct: Math.round(deltaPct * 10) / 10, flag };
    }
    rows.push({ scenario: sc, deltas });
  }
  // Verdict precedence: inconclusive beats fail beats pass. A comparison that
  // cannot attribute deltas to the code (condition mismatch, unmeasured or
  // missing metrics) must never certify a performance PASS.
  const inconclusiveReasons: string[] = [];
  if (!comparable) inconclusiveReasons.push("conditions differ");
  if (missingScenarios.length) inconclusiveReasons.push(`scenarios missing on one side: ${missingScenarios.join(",")}`);
  if (unmeasured) inconclusiveReasons.push(`${unmeasured} metric(s) unmeasured`);
  const verdict =
    inconclusiveReasons.length > 0 ? "inconclusive" : regressions > 0 ? "fail" : "pass";
  const report = {
    generatedAt: new Date().toISOString(),
    baseline: baselinePath,
    candidate: candidatePath,
    baselineSha: normSha(baseEnv),
    candidateSha: normSha(candEnv),
    reportKind: frameMode ? "perf-frame" : "perf-memory",
    comparability,
    missingScenarios,
    unmeasuredMetrics: unmeasured,
    verdict,
    inconclusiveReasons,
    regressionPct: regressionPct,
    regressions,
    scenarios: rows,
  };
  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2));
    return verdict === "pass" ? 0 : verdict === "fail" ? 1 : 3;
  }
  if (!comparability.comparable) {
    console.log(`WARNING: ${comparability.note}`);
    for (const d of [...comparability.workloadDiffs, ...comparability.hostDiffs]) console.log(`  ${d}`);
    if (comparability.hostLoadSuspect) console.log(`  loadavg[0] delta ${comparability.loadavg1Delta} (>4 — host load differed)`);
    console.log("");
  }
  for (const r of rows) {
    const parts = Object.entries(r.deltas as Record<string, { deltaPct?: number; flag?: string }>)
      .map(([k, v]) => `${k} ${v.deltaPct !== undefined ? (v.deltaPct >= 0 ? "+" : "") + v.deltaPct + "%" : "n/a"}${v.flag ? ` ⚠${v.flag}` : ""}`);
    console.log(`${(r as { scenario: string }).scenario}: ${parts.join(", ") || "n/a"}`);
  }
  if (regressions) console.log(`\n${regressions} regression(s) beyond ±${regressionPct}%`);
  else console.log("\nno regressions beyond threshold");
  if (verdict === "inconclusive") {
    console.log(`INCONCLUSIVE — cannot certify PASS: ${inconclusiveReasons.join("; ")}`);
    return 3;
  }
  return regressions > 0 ? 1 : 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const mode = argv[0];
  if (mode === "diagnose") return diagnose(argv.slice(1));
  if (mode === "compare" && argv[1] && argv[2] && !argv[1].startsWith("--")) {
    return compare(argv[1], argv[2], argv.slice(3));
  }
  console.error("usage: perf-observe.ts diagnose [--user-data <dir>] [--json]\n" +
    "       perf-observe.ts compare <baseline.json> <candidate.json> [--json] [--regression-pct 20]\n" +
    "  exit codes: 0=pass, 1=regression, 3=inconclusive (conditions/measurements cannot certify a pass), 2=usage");
  return 2;
}

if (import.meta.main) process.exit(main());
