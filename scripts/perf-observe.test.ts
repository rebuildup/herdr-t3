import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, diagnose, main } from "./perf-observe.ts";
import { sampleGpuiReport } from "./perf-gpui-schema.ts";

/**
 * Rejection-proof tests for the RC evaluation leg (issue #552): the
 * perf-observe verdict contract must be able to say no. `compare` exits
 * 0 only on a clean pass — regressions exit 1, and anything that cannot
 * attribute deltas to the code (condition mismatch, unmeasured metrics,
 * missing scenarios) exits 3, never 0. `diagnose` must fail gracefully
 * on missing or too-short history.
 */

const tmp = mkdtempSync(join(tmpdir(), "perf-observe-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeReport(name: string, body: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

/** Minimal perf-memory-bench-shaped report with one scenario. */
function memReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "herdr-t3/perf-memory",
    sha: "abc123",
    host: { platform: "darwin", arch: "arm64", cpus: 10, totalMemMb: 24576, loadavg: [1, 1, 1] },
    config: { stormMb: 128, stormSeconds: 15, scenario: "all" },
    summary: {
      idle: {
        jsHeapPeakMb: 100,
        chromePeakMb: 800,
        chromeEndMb: 700,
        chromeTailSlopeMbPerMin: 0,
        bridgeEndMb: 100,
        herdrEndMb: 50,
      },
    },
    ...over,
  };
}

describe("perf-observe compare verdicts", () => {
  test("identical reports → pass (exit 0)", () => {
    const a = writeReport("same-a.json", memReport());
    const b = writeReport("same-b.json", memReport());
    expect(compare(a, b)).toBe(0);
  });

  test("regression beyond threshold → fail (exit 1)", () => {
    const a = writeReport("base.json", memReport());
    const regressed = memReport();
    (regressed.summary as Record<string, { jsHeapPeakMb: number }>).idle!.jsHeapPeakMb = 200;
    const b = writeReport("cand.json", regressed);
    expect(compare(a, b)).toBe(1);
  });

  test("workload mismatch → inconclusive (exit 3), never pass", () => {
    const a = writeReport("w-base.json", memReport());
    const other = memReport({ config: { stormMb: 256, stormSeconds: 15, scenario: "all" } });
    const b = writeReport("w-cand.json", other);
    expect(compare(a, b)).toBe(3);
  });

  test("unmeasured metric → inconclusive (exit 3)", () => {
    // baseline reads 0 = "not measured"; candidate has a real value.
    const zeroBase = memReport();
    (zeroBase.summary as Record<string, { bridgeEndMb: number }>).idle!.bridgeEndMb = 0;
    const cand = memReport();
    (cand.summary as Record<string, { bridgeEndMb: number }>).idle!.bridgeEndMb = 100;
    const z = writeReport("u-zero.json", zeroBase);
    const b = writeReport("u-cand.json", cand);
    expect(compare(z, b)).toBe(3);
  });

  test("scenario missing on one side → inconclusive (exit 3)", () => {
    const a = writeReport("m-base.json", memReport());
    const cand = memReport();
    (cand.summary as Record<string, unknown>).storm = {
      jsHeapPeakMb: 100, chromePeakMb: 800, chromeEndMb: 700,
      chromeTailSlopeMbPerMin: 0, bridgeEndMb: 100, herdrEndMb: 50,
    };
    const b = writeReport("m-cand.json", cand);
    expect(compare(a, b)).toBe(3);
  });
});

/** Minimal herdr-t3/perf-gpui v1 report (issue #621) with frame-shaped
 *  legs — same field names as perf-frame windows plus GPUI-only legs. */
function gpuiReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  const r = sampleGpuiReport();
  r["legs"] = {
    startup: { startup_ms: 800, startup_to_first_paint_ms: 900 },
    idle: {
      seconds: 3,
      frames: { count: 180, p50: 16.5, p95: 17.2, p99: 18.1, pct_over_16_7: 4 },
      input_paint: { p50: 12, p95: 30, p99: 55 },
      longtask_count: 0,
      longtask_total_ms: 0,
      task_utilization_pct: 18,
      cpu_utilization_pct: 12,
      memory: { rss_mb: 420, heap_mb: 150 },
    },
    storm: {
      seconds: 8,
      frames: { count: 300, p50: 16.6, p95: 40, p99: 90, pct_over_16_7: 30 },
      input_paint: { p50: 15, p95: 120, p99: 300 },
      longtask_count: 3,
      longtask_total_ms: 210,
      task_utilization_pct: 55,
      cpu_utilization_pct: 40,
    },
    switch: {
      frames: { count: 120, p50: 16.7, p95: 45, p99: 100 },
      switch_latency: { p50: 60, p95: 140, p99: 260 },
      input_paint: { p50: 14, p95: 90, p99: 200 },
      task_utilization_pct: 30,
      cpu_utilization_pct: 22,
    },
    terminal_io: {
      delivery_bytes_total: 4_000_000,
      delivery_bytes_per_sec: 500_000,
      attach_count: 4,
      detach_count: 4,
      rpc_counts: { resize: 8, scroll: 24 },
    },
    longrun: {
      duration_s: 600,
      samples: [
        { t: "2026-01-01T00:00:00Z", rss_mb: 400, heap_mb: 140, cpu_pct: 10 },
        { t: "2026-01-01T00:10:00Z", rss_mb: 410, heap_mb: 145, cpu_pct: 11 },
      ],
      rss_slope_mb_per_min: 0.5,
      heap_slope_mb_per_min: 0.2,
      peak_rss_mb: 430,
      peak_heap_mb: 160,
    },
  };
  return { ...r, ...over };
}

/** perf-frame-shaped report with idle/storm/switch windows — for
 *  cross-kind compare against a GPUI report carrying the same legs. */
function frameReport(): Record<string, unknown> {
  const win = (p50: number, p95: number) => ({
    frames: { count: 180, p50, p95, p99: p95 * 2, pct_over_16_7: 4 },
    input_paint: { p50: 12, p95: 30, p99: 55 },
    longtask_count: 0,
    longtask_total_ms: 0,
    task_utilization_pct: 18,
    cpu_utilization_pct: 12,
  });
  return {
    format: "herdr-t3/perf-frame",
    version: 1,
    git_sha: "abc123",
    host: { platform: "darwin", arch: "arm64", cpu_model: "M5", cpu_count: 10, mem_total_bytes: 25769803776, loadavg: [1, 1, 1] },
    condition: { loadavg_1m: 1 },
    workload: { measure_seconds: 8, scenario: "sample" },
    idle: win(16.5, 17.2),
    storm: win(16.6, 40),
    switch: { ...win(16.7, 45), switch_latency: { p50: 60, p95: 140, p99: 260 } },
  };
}

describe("perf-observe compare — GPUI reports (issue #621)", () => {
  test("identical GPUI reports → pass (exit 0)", () => {
    const a = writeReport("g-same-a.json", gpuiReport());
    const b = writeReport("g-same-b.json", gpuiReport());
    expect(compare(a, b)).toBe(0);
  });

  test("GPUI leg regression → fail (exit 1)", () => {
    const a = writeReport("g-base.json", gpuiReport());
    const regressed = gpuiReport();
    const legs = regressed["legs"] as Record<string, Record<string, unknown>>;
    (legs["storm"]!["frames"] as Record<string, number>).p95 = 200; // +400%
    const b = writeReport("g-cand.json", regressed);
    expect(compare(a, b)).toBe(1);
  });

  test("GPUI workload mismatch → inconclusive (exit 3)", () => {
    const a = writeReport("g-w-base.json", gpuiReport());
    const other = gpuiReport();
    (other["workload"] as Record<string, unknown>)["scenario"] = "different";
    const b = writeReport("g-w-cand.json", other);
    expect(compare(a, b)).toBe(3);
  });

  test("GPUI leg missing on one side → inconclusive (exit 3)", () => {
    const a = writeReport("g-m-base.json", gpuiReport());
    const cand = gpuiReport();
    delete (cand["legs"] as Record<string, unknown>)["longrun"];
    const b = writeReport("g-m-cand.json", cand);
    expect(compare(a, b)).toBe(3);
  });

  test("GPUI vs perf-frame report compares shared leg metrics → pass when equal", () => {
    // Cross-implementation parity leg: frame-window field names are
    // shared, so identical numbers must not regress; GPUI-only metrics
    // (memory.*, switch_latency extras) are absent on the frame side
    // and skipped, not "unmeasured". Legs must match on both sides —
    // a leg present on only one side is inconclusive (covered above).
    const frame = frameReport();
    const gpui = gpuiReport();
    gpui["legs"] = {
      idle: { ...(frame["idle"] as Record<string, unknown>), memory: { rss_mb: 420, heap_mb: 150 } },
      storm: frame["storm"],
      switch: frame["switch"],
    };
    // Same host class + workload shape: frame uses mem_total_bytes,
    // gpui uses mem_total_mb — both normalize to 24 GiB.
    gpui["host"] = {
      platform: "darwin", arch: "arm64", cpu_model: "M5", cpu_count: 10,
      mem_total_mb: 24576, loadavg: [1, 1, 1],
    };
    gpui["workload"] = frame["workload"];
    gpui["condition"] = frame["condition"];
    const a = writeReport("x-frame.json", frame);
    const b = writeReport("x-gpui.json", gpui);
    expect(compare(a, b)).toBe(0);
  });

  test("GPUI vs perf-frame with unpaired legs → inconclusive (exit 3)", () => {
    // The gpuiReport fixture carries startup/terminal_io/longrun legs
    // the frame report cannot measure — missing scenarios, never pass.
    const a = writeReport("x-frame2.json", frameReport());
    const b = writeReport("x-gpui3.json", gpuiReport());
    expect(compare(a, b)).toBe(3);
  });

  test("GPUI vs perf-memory report → inconclusive (kind mismatch, exit 3)", () => {
    const mem = writeReport("x-mem.json", memReport());
    const gpui = writeReport("x-gpui2.json", gpuiReport());
    expect(compare(mem, gpui)).toBe(3);
    expect(compare(gpui, mem)).toBe(3);
  });
});

describe("perf-observe diagnose", () => {
  test("missing memory history → exit 1", () => {
    const dir = mkdtempSync(join(tmp, "nohist-"));
    expect(diagnose(["--user-data", dir])).toBe(1);
  });

  test("empty history → exit 1", () => {
    const dir = mkdtempSync(join(tmp, "empty-"));
    writeFileSync(join(dir, "memory-history.jsonl"), "");
    expect(diagnose(["--user-data", dir])).toBe(1);
  });

  test("single sample → exit 1 (need more runtime)", () => {
    const dir = mkdtempSync(join(tmp, "one-"));
    writeFileSync(
      join(dir, "memory-history.jsonl"),
      JSON.stringify({ t: "2026-01-01T00:00:00Z", totalMb: 500, byType: {}, level: "ok", baselineMb: 400, slopeMbPerMin: 0 }) + "\n",
    );
    expect(diagnose(["--user-data", dir])).toBe(1);
  });

  test("two clean samples → exit 0", () => {
    const dir = mkdtempSync(join(tmp, "ok-"));
    const sample = (t: string, totalMb: number) =>
      JSON.stringify({ t, totalMb, byType: { renderer: totalMb }, level: "ok", baselineMb: 400, slopeMbPerMin: 1 }) + "\n";
    writeFileSync(
      join(dir, "memory-history.jsonl"),
      sample("2026-01-01T00:00:00Z", 500) + sample("2026-01-01T00:01:00Z", 510),
    );
    expect(diagnose(["--user-data", dir, "--json"])).toBe(0);
  });
});

describe("perf-observe CLI contract", () => {
  test("usage errors exit 2; unknown modes exit 2", () => {
    expect(main([])).toBe(2);
    expect(main(["bogus"])).toBe(2);
    expect(main(["compare", "only-one.json"])).toBe(2);
  });
});
