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
 *   compare   two perf report JSONs (perf-memory-bench.ts output, or any
 *             JSON with a `summary` map of the same shape)
 *             → per-scenario deltas + regression flags, for
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

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string, dflt = ""): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};
const JSON_OUT = args.includes("--json");
const REGRESSION_PCT = Number(flag("--regression-pct", "20"));

function userDataDir(): string {
  const explicit = flag("--user-data");
  if (explicit) return explicit;
  const profile = process.env["HERDR_T3_PROFILE"] === "dev" ? "herdr-t3-dev" : "herdr-t3";
  return join(homedir(), "Library", "Application Support", profile);
}

function diagnose(): number {
  const dir = userDataDir();
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
  if (JSON_OUT) {
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

function compare(baselinePath: string, candidatePath: string): number {
  const load = (p: string): Record<string, ScenarioSummary> => {
    const j = JSON.parse(readFileSync(p, "utf8")) as { summary?: Record<string, ScenarioSummary> };
    return j.summary ?? {};
  };
  const base = load(baselinePath);
  const cand = load(candidatePath);
  const scenarios = [...new Set([...Object.keys(base), ...Object.keys(cand)])].sort();
  const METRICS: { key: keyof ScenarioSummary; label: string; lowerBetter: boolean }[] = [
    { key: "jsHeapPeakMb", label: "jsHeapPeak", lowerBetter: true },
    { key: "chromePeakMb", label: "chromePeak", lowerBetter: true },
    { key: "chromeEndMb", label: "chromeEnd", lowerBetter: true },
    { key: "chromeTailSlopeMbPerMin", label: "chromeTailSlope", lowerBetter: true },
    { key: "bridgeEndMb", label: "bridgeEnd", lowerBetter: true },
    { key: "herdrEndMb", label: "herdrEnd", lowerBetter: true },
  ];
  const rows: Record<string, unknown>[] = [];
  let regressions = 0;
  for (const sc of scenarios) {
    const b = base[sc] ?? {};
    const c = cand[sc] ?? {};
    const deltas: Record<string, { base?: number; cand?: number; deltaPct?: number; flag?: string }> = {};
    for (const m of METRICS) {
      const bv = b[m.key] as number | undefined;
      const cv = c[m.key] as number | undefined;
      if (bv === undefined || cv === undefined) continue;
      const deltaPct = bv === 0 ? (cv === 0 ? 0 : 100) : ((cv - bv) / bv) * 100;
      const worse = m.lowerBetter ? cv > bv : cv < bv;
      const flag = worse && Math.abs(deltaPct) >= REGRESSION_PCT ? `regression >${REGRESSION_PCT}%` : undefined;
      if (flag) regressions++;
      deltas[m.label] = { base: bv, cand: cv, deltaPct: Math.round(deltaPct * 10) / 10, flag };
    }
    rows.push({ scenario: sc, deltas });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    baseline: baselinePath,
    candidate: candidatePath,
    regressionPct: REGRESSION_PCT,
    regressions,
    scenarios: rows,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    return regressions > 0 ? 1 : 0;
  }
  for (const r of rows) {
    const parts = Object.entries(r.deltas as Record<string, { deltaPct?: number; flag?: string }>)
      .map(([k, v]) => `${k} ${v.deltaPct! >= 0 ? "+" : ""}${v.deltaPct}%${v.flag ? " ⚠" : ""}`);
    console.log(`${(r as { scenario: string }).scenario}: ${parts.join(", ") || "n/a"}`);
  }
  console.log(regressions ? `\n${regressions} regression(s) beyond ±${REGRESSION_PCT}%` : "\nno regressions beyond threshold");
  return regressions > 0 ? 1 : 0;
}

function main(): number {
  if (mode === "diagnose") return diagnose();
  if (mode === "compare" && args[1] && args[2] && !args[1].startsWith("--")) {
    return compare(args[1], args[2]);
  }
  console.error("usage: perf-observe.ts diagnose [--user-data <dir>] [--json]\n" +
    "       perf-observe.ts compare <baseline.json> <candidate.json> [--json] [--regression-pct 20]");
  return 2;
}

process.exit(main());
