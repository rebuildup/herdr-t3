import { describe, expect, test } from "bun:test";
import {
  checkHostMatch,
  checkRegression,
  cpuBusyFraction,
  parseBenchOutput,
  percentile,
  summarizeRuns,
  type PerfReport,
} from "./perf-baseline.ts";

/**
 * Fault-injection tests for the perf gate (issue #240): the checker must
 * reject invalid measurements, detect intentional slowdowns, and refuse
 * cross-machine comparisons — never wave a bad run through.
 */

function report(p50: number, over: Partial<PerfReport> = {}): PerfReport {
  return {
    format: "herdr-t3/perf-baseline",
    version: 1,
    recorded_at: "2026-01-01T00:00:00Z",
    git_sha: "abc123",
    host: {
      platform: "darwin",
      arch: "arm64",
      hostname: "bench",
      cpu_model: "Apple M4",
      cpu_count: 10,
      mem_total_bytes: 16e9,
    },
    bun_version: "1.4.4",
    workload: { bench: "b", seed: 42, ticks: 400, note: "" },
    bench: {
      command: "bun b",
      iterations: 7,
      totals_ms: [p50],
      cells_decoded_total: 1,
      p50_ms: p50,
      p95_ms: p50,
      min_ms: p50,
      max_ms: p50,
      cv: 0,
    },
    ...over,
  };
}

describe("summarizeRuns", () => {
  test("computes p50/p95/min/max/cv over sorted samples", () => {
    const s = summarizeRuns([30, 10, 20, 40, 50]);
    expect(s.p50_ms).toBe(30);
    expect(s.p95_ms).toBe(50);
    expect(s.min_ms).toBe(10);
    expect(s.max_ms).toBe(50);
    expect(s.totals_ms).toEqual([10, 20, 30, 40, 50]);
    expect(s.cv).toBeGreaterThan(0);
  });

  test("rejects empty and invalid measurements", () => {
    expect(() => summarizeRuns([])).toThrow();
    expect(() => summarizeRuns([10, NaN])).toThrow();
    expect(() => summarizeRuns([10, 0])).toThrow();
    expect(() => summarizeRuns([10, -5])).toThrow();
  });

  test("percentile clamps to sample bounds", () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("checkRegression", () => {
  test("passes within threshold", () => {
    const v = checkRegression(report(100), report(110), 20);
    expect(v.ok).toBe(true);
    expect(v.delta_pct).toBeCloseTo(10);
  });

  test("detects intentional slowdown beyond threshold", () => {
    const v = checkRegression(report(100), report(150), 20);
    expect(v.ok).toBe(false);
    expect(v.delta_pct).toBeCloseTo(50);
  });

  test("improvement is not a failure", () => {
    const v = checkRegression(report(100), report(80), 20);
    expect(v.ok).toBe(true);
  });
});

describe("checkHostMatch", () => {
  test("same environment → comparable", () => {
    expect(checkHostMatch(report(100), report(100))).toBeNull();
  });

  test("different cpu / bun / seed → refused", () => {
    const other = report(100, {
      host: { ...report(100).host, cpu_model: "Intel i9" },
    });
    expect(checkHostMatch(report(100), other)).toContain("cpu_model");

    const otherBun = report(100, { bun_version: "0.0.0" });
    expect(checkHostMatch(report(100), otherBun)).toContain("bun_version");

    const otherSeed = report(100, {
      workload: { bench: "b", seed: 7, ticks: 400, note: "" },
    });
    expect(checkHostMatch(report(100), otherSeed)).toContain("workload.seed");
  });
});

describe("cpuBusyFraction", () => {
  test("idle machine → ~0, saturated → ~1", () => {
    // 10 cores, 1s interval: all idle
    expect(cpuBusyFraction({ idle: 0, total: 0 }, { idle: 10, total: 10 })).toBe(0);
    // all busy
    expect(cpuBusyFraction({ idle: 0, total: 0 }, { idle: 0, total: 10 })).toBe(1);
    // half busy
    expect(cpuBusyFraction({ idle: 5, total: 10 }, { idle: 10, total: 20 })).toBeCloseTo(0.5);
  });

  test("rejects empty/invalid intervals", () => {
    expect(cpuBusyFraction({ idle: 0, total: 0 }, { idle: 0, total: 0 })).toBeNull();
    expect(cpuBusyFraction({ idle: 5, total: 10 }, { idle: 4, total: 20 })).toBeNull();
  });
});

describe("parseBenchOutput", () => {
  test("parses totals and cell counts", () => {
    const out = parseBenchOutput("ticks=400 rowsDrawn=999 cellsDecoded=12345 total=432.5ms\n");
    expect(out.total_ms).toBe(432.5);
    expect(out.cells).toBe(12345);
  });

  test("rejects output missing the total", () => {
    expect(() => parseBenchOutput("garbage\n")).toThrow();
  });
});
