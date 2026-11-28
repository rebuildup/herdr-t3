import { describe, expect, test } from "bun:test";
import {
  GPUI_LEGS,
  GPUI_REPORT_FORMAT,
  GPUI_REPORT_VERSION,
  sampleGpuiReport,
  validateGpuiReport,
} from "./perf-gpui-schema.ts";

/**
 * Schema contract tests for the GPUI product-path perf report
 * (issue #621). The validator is the single source of truth shared
 * with perf-contract-check — these tests prove it accepts the
 * canonical sample and rejects every class of drift: wrong format /
 * version, missing required leg fields, bad types, unknown legs, and
 * budgets that are not marked provisional.
 */

const clone = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(sampleGpuiReport())) as Record<string, unknown>;
const legs = (r: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  r["legs"] as Record<string, Record<string, unknown>>;

describe("validateGpuiReport — accept paths", () => {
  test("canonical sample validates clean", () => {
    expect(validateGpuiReport(sampleGpuiReport())).toEqual([]);
    expect(validateGpuiReport(clone())).toEqual([]);
  });

  test("minimal single-leg report validates", () => {
    const r = clone();
    r["legs"] = { startup: { startup_ms: 1234 } };
    delete r["budgets"];
    expect(validateGpuiReport(r)).toEqual([]);
  });

  test("full leg set validates", () => {
    const r = clone();
    const l = legs(r);
    l["storm"] = {
      frames: { count: 100, p50: 16, p95: 20, p99: 33, pct_over_16_7: 5 },
      input_paint: { p50: 10, p95: 30, p99: 60 },
      longtask_count: 2,
      longtask_total_ms: 80,
      task_utilization_pct: 40,
      cpu_utilization_pct: 25,
      switch_latency: { p50: 50, p95: 90, p99: 120 },
      memory: { rss_mb: 400, heap_mb: 120, host: null },
    };
    l["hidden"] = {
      delivery_bytes_total: 1024,
      attach_count: 3,
      rpc_counts: { resize: 2, scroll: 9, input: 4 },
    };
    expect(validateGpuiReport(r)).toEqual([]);
  });
});

describe("validateGpuiReport — reject paths", () => {
  test("wrong format rejected", () => {
    const r = clone();
    r["format"] = "herdr-t3/perf-frame";
    expect(validateGpuiReport(r).join("\n")).toContain("format");
  });

  test("wrong/absent version rejected", () => {
    for (const v of [0, 2, "1", undefined]) {
      const r = clone();
      if (v === undefined) delete r["version"];
      else r["version"] = v;
      expect(validateGpuiReport(r).join("\n")).toContain("version");
    }
  });

  test("empty legs rejected", () => {
    const r = clone();
    r["legs"] = {};
    expect(validateGpuiReport(r).join("\n")).toContain("legs");
  });

  test("unknown leg name rejected", () => {
    const r = clone();
    legs(r)["bogus"] = {};
    expect(validateGpuiReport(r).join("\n")).toContain("unknown leg");
  });

  test("missing required leg fields rejected", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["startup", {}],
      ["idle", {}],
      ["idle", { frames: { p50: 1, p95: 2 } }], // missing p99
      ["switch", { frames: { p50: 1, p95: 2, p99: 3 } }], // missing switch_latency
      ["terminal_io", { delivery_bytes_total: 1 }], // missing attach_count
      ["hidden", { attach_count: 1 }], // missing delivery_bytes_total
      ["longrun", { duration_s: 60, samples: [{ t: "x", rss_mb: 1 }] }], // <2 samples, missing slopes/peak
    ];
    for (const [name, leg] of cases) {
      const r = clone();
      r["legs"] = { [name]: leg };
      const failures = validateGpuiReport(r);
      expect(failures.length, `${name} ${JSON.stringify(leg)} should fail`).toBeGreaterThan(0);
    }
  });

  test("type violations rejected", () => {
    const r = clone();
    legs(r)["idle"]!["frames"] = { p50: "fast", p95: 2, p99: 3 };
    expect(validateGpuiReport(r).join("\n")).toContain("frames.p50");

    const r2 = clone();
    legs(r2)["terminal_io"]!["rpc_counts"] = { resize: "many" };
    expect(validateGpuiReport(r2).join("\n")).toContain("rpc_counts.resize");

    const r3 = clone();
    legs(r3)["idle"]!["cpu_utilization_pct"] = "high";
    expect(validateGpuiReport(r3).join("\n")).toContain("cpu_utilization_pct");
  });

  test("null is accepted for unavailable native probes", () => {
    const r = clone();
    const idle = legs(r)["idle"]!;
    idle["cpu_utilization_pct"] = null;
    idle["task_utilization_pct"] = null;
    (idle["memory"] as Record<string, unknown>)["rss_mb"] = null;
    expect(validateGpuiReport(r)).toEqual([]);
  });

  test("budgets must be marked provisional", () => {
    const r = clone();
    r["budgets"] = { input_paint_p95_ms: 100 };
    expect(validateGpuiReport(r).join("\n")).toContain("provisional");

    const r2 = clone();
    r2["budgets"] = { provisional: false, input_paint_p95_ms: 100 };
    expect(validateGpuiReport(r2).join("\n")).toContain("provisional");

    const r3 = clone();
    r3["budgets"] = { provisional: true, input_paint_p95_ms: "fast" };
    expect(validateGpuiReport(r3).join("\n")).toContain("budgets.input_paint_p95_ms");
  });

  test("memory host block mirrors diagnostics_json shape", () => {
    const r = clone();
    legs(r)["idle"]!["memory"] = {
      rss_mb: 500,
      heap_mb: 200,
      host: {
        memory: {
          level: "warn",
          totalMb: 700,
          baselineMb: 400,
          slopeMbPerMin: 12.5,
          osAvailPct: 0.4,
          hardCapMb: 9999,
        },
        budget: {
          totalBytes: 1024,
          budgetBytes: 2048,
          overBudget: false,
          sessions: 3,
          warning: "top: pane-a",
        },
      },
    };
    expect(validateGpuiReport(r)).toEqual([]);

    const bad = clone();
    legs(bad)["idle"]!["memory"] = { host: { budget: { overBudget: "yes" } } };
    expect(validateGpuiReport(bad).join("\n")).toContain("overBudget");
  });

  test("non-object input rejected without throwing", () => {
    for (const v of [null, undefined, 42, "report", []]) {
      expect(validateGpuiReport(v).length).toBeGreaterThan(0);
    }
  });
});

describe("schema constants", () => {
  test("leg set covers the assurance surface", () => {
    for (const leg of ["startup", "idle", "storm", "switch", "terminal_io", "hidden", "longrun"]) {
      expect(GPUI_LEGS).toContain(leg);
    }
    expect(GPUI_REPORT_FORMAT).toBe("herdr-t3/perf-gpui");
    expect(GPUI_REPORT_VERSION).toBe(1);
  });
});
