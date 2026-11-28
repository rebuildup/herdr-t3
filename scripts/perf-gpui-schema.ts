#!/usr/bin/env bun
/**
 * Versioned schema for the GPUI product-path performance report
 * (issue #621, program #416/#233/#425).
 *
 * The Electron assurance legs (`perf-memory-bench.ts`,
 * `perf-frame-bench.ts`) emit `herdr-t3/perf-memory` and
 * `herdr-t3/perf-frame` reports. The future Rust/GPUI host emits ONE
 * report per run in this format so `perf-observe.ts compare` can apply
 * identical verdict semantics (pass / fail / inconclusive, exit
 * 0/1/3) once live legs exist at RC freeze.
 *
 *   format:    "herdr-t3/perf-gpui"
 *   version:   1  (bump on any breaking field change; compare refuses
 *              unknown versions via the validator, never silently)
 *
 * Design rules (mirroring the Electron reports):
 *
 * - Legs reuse the `perf-frame` window field names for shared
 *   semantics (`frames.{p50,p95,p99}`, `input_paint.{p50,p95,p99}`,
 *   `longtask_count`, `longtask_total_ms`, `task_utilization_pct`,
 *   `cpu_utilization_pct`) so cross-implementation `compare` diffs the
 *   same metrics. On the native side `longtask_*` means "frames over
 *   the frame budget" — there is no DOM Long Tasks API.
 * - `memory` blocks mirror `crates/terminal-render`'s
 *   `MemoryHost::diagnostics_json()` (camelCase `memory.*` /
 *   `budget.*`, issue #499 parity) plus leg-level `rssMb`/`heapMb`
 *   where `heapMb` is the aggregate session-probe high-water mark —
 *   the native heap-equivalent.
 * - `budgets`, when present, MUST carry `"provisional": true` — the
 *   same convention as `perf-frame-bench.ts --check` provisional
 *   ceilings. Calibrated budgets are a schema-version decision, not a
 *   silent flag flip.
 * - Omit unmeasured metrics entirely; an explicit `0` follows the
 *   compare tool's existing "baseline 0 = unmeasured" rule.
 *
 * This module is the single source of truth for the shape: the
 * contract check (`perf-contract-check.ts` piece `gpui-report-schema`)
 * and the unit tests both exercise `validateGpuiReport`.
 */

export const GPUI_REPORT_FORMAT = "herdr-t3/perf-gpui";
export const GPUI_REPORT_VERSION = 1;

/** Known leg names for schema v1. A report must use a non-empty subset. */
export const GPUI_LEGS = [
  "startup", // process start → first presented frame
  "idle", // no workload; frame/input/cpu/memory baseline
  "storm", // seed-42 ANSI output storm + scroll traversal (parity w/ frame bench)
  "switch", // workspace-switch cycles; adds switch_latency percentiles
  "terminal_io", // attach batch + bounded output + scroll/resize probes (parity w/ bridge-load terminal-io)
  "hidden", // non-visible workspaces streaming; delivery-byte gate (parity w/ mem-bench hidden)
  "longrun", // sustained run; stability samples + RSS/heap slopes (parity w/ memory-history diagnose)
] as const;
export type GpuiLegName = (typeof GPUI_LEGS)[number];

const FRAME_LEGS = new Set<GpuiLegName>(["idle", "storm", "switch"]);
const DELIVERY_LEGS = new Set<GpuiLegName>(["terminal_io", "hidden"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
/** number | null — native reports use null for "probe unavailable". */
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);

function checkNum(v: unknown, path: string, failures: string[]): void {
  if (!isNum(v)) failures.push(`${path}: expected number, got ${JSON.stringify(v)}`);
}
function checkNumOrNull(v: unknown, path: string, failures: string[]): void {
  if (!isNumOrNull(v)) failures.push(`${path}: expected number|null, got ${JSON.stringify(v)}`);
}
function checkOptNum(v: unknown, path: string, failures: string[]): void {
  if (v !== undefined) checkNum(v, path, failures);
}
function checkOptNumOrNull(v: unknown, path: string, failures: string[]): void {
  if (v !== undefined) checkNumOrNull(v, path, failures);
}
function checkRecord(v: unknown, path: string, failures: string[]): Record<string, unknown> | null {
  if (!isRecord(v)) {
    failures.push(`${path}: expected object, got ${JSON.stringify(v)?.slice(0, 80)}`);
    return null;
  }
  return v;
}

/** Validate a percentile triple {p50,p95,p99} (all numbers, ms). */
function checkPercentiles(v: unknown, path: string, failures: string[]): void {
  const o = checkRecord(v, path, failures);
  if (!o) return;
  for (const k of ["p50", "p95", "p99"] as const) checkNum(o[k], `${path}.${k}`, failures);
}

/**
 * The `memory` block carried by legs (and optionally top-level).
 * `host` mirrors `MemoryHost::diagnostics_json()` exactly — camelCase
 * `memory.*`/`budget.*` field names are the wire contract.
 */
function checkMemoryBlock(v: unknown, path: string, failures: string[]): void {
  const o = checkRecord(v, path, failures);
  if (!o) return;
  checkOptNumOrNull(o["rss_mb"], `${path}.rss_mb`, failures);
  checkOptNumOrNull(o["heap_mb"], `${path}.heap_mb`, failures);
  if (o["host"] === undefined || o["host"] === null) return;
  const host = checkRecord(o["host"], `${path}.host`, failures);
  if (!host) return;
  if (host["memory"] !== undefined && host["memory"] !== null) {
    const m = checkRecord(host["memory"], `${path}.host.memory`, failures);
    if (m) {
      if (!isStr(m["level"])) failures.push(`${path}.host.memory.level: expected string`);
      for (const k of ["totalMb", "baselineMb", "hardCapMb"] as const) {
        checkNum(m[k], `${path}.host.memory.${k}`, failures);
      }
      checkNum(m["slopeMbPerMin"], `${path}.host.memory.slopeMbPerMin`, failures);
      checkNum(m["osAvailPct"], `${path}.host.memory.osAvailPct`, failures);
    }
  }
  if (host["budget"] !== undefined) {
    const b = checkRecord(host["budget"], `${path}.host.budget`, failures);
    if (b) {
      checkNum(b["totalBytes"], `${path}.host.budget.totalBytes`, failures);
      checkNum(b["budgetBytes"], `${path}.host.budget.budgetBytes`, failures);
      checkNum(b["sessions"], `${path}.host.budget.sessions`, failures);
      if (!isBool(b["overBudget"])) {
        failures.push(`${path}.host.budget.overBudget: expected boolean`);
      }
      if (b["warning"] !== undefined && !isStr(b["warning"])) {
        failures.push(`${path}.host.budget.warning: expected string`);
      }
    }
  }
}

/** Fields every leg may carry regardless of kind. */
function checkCommonLegFields(leg: Record<string, unknown>, path: string, failures: string[]): void {
  checkOptNum(leg["seconds"], `${path}.seconds`, failures);
  if (leg["memory"] !== undefined) checkMemoryBlock(leg["memory"], `${path}.memory`, failures);
}

/** Shared frame-window fields (perf-frame parity names). */
function checkFrameFields(leg: Record<string, unknown>, path: string, failures: string[]): void {
  const frames = checkRecord(leg["frames"], `${path}.frames`, failures);
  if (frames) {
    for (const k of ["p50", "p95", "p99"] as const) {
      checkNum(frames[k], `${path}.frames.${k}`, failures);
    }
    checkOptNum(frames["count"], `${path}.frames.count`, failures);
    checkOptNum(frames["pct_over_16_7"], `${path}.frames.pct_over_16_7`, failures);
  }
  if (leg["input_paint"] !== undefined && leg["input_paint"] !== null) {
    checkPercentiles(leg["input_paint"], `${path}.input_paint`, failures);
  }
  for (const k of ["longtask_count", "longtask_total_ms", "longtask_max_ms"] as const) {
    checkOptNum(leg[k], `${path}.${k}`, failures);
  }
  checkOptNumOrNull(leg["task_utilization_pct"], `${path}.task_utilization_pct`, failures);
  checkOptNumOrNull(leg["cpu_utilization_pct"], `${path}.cpu_utilization_pct`, failures);
  checkOptNumOrNull(leg["cpu_time_ms"], `${path}.cpu_time_ms`, failures);
  checkOptNumOrNull(leg["canvas_api_ms"], `${path}.canvas_api_ms`, failures);
  if (leg["navigated"] !== undefined) {
    if (!isBool(leg["navigated"])) failures.push(`${path}.navigated: expected boolean`);
  }
  // Workspace-switch latency — required content of the `switch` leg,
  // permitted (and validated) on any frame leg.
  if (leg["switch_latency"] !== undefined && leg["switch_latency"] !== null) {
    checkPercentiles(leg["switch_latency"], `${path}.switch_latency`, failures);
  }
}

function checkDeliveryFields(leg: Record<string, unknown>, path: string, failures: string[]): void {
  checkNum(leg["delivery_bytes_total"], `${path}.delivery_bytes_total`, failures);
  checkNum(leg["attach_count"], `${path}.attach_count`, failures);
  checkOptNum(leg["detach_count"], `${path}.detach_count`, failures);
  for (const k of [
    "delivery_bytes_initial",
    "delivery_bytes_scroll",
    "delivery_bytes_per_sec",
  ] as const) {
    checkOptNum(leg[k], `${path}.${k}`, failures);
  }
  if (leg["rpc_counts"] !== undefined) {
    const rpc = checkRecord(leg["rpc_counts"], `${path}.rpc_counts`, failures);
    if (rpc) {
      for (const [k, v] of Object.entries(rpc)) {
        if (!isNum(v)) failures.push(`${path}.rpc_counts.${k}: expected number`);
      }
    }
  }
}

function checkLongrunFields(leg: Record<string, unknown>, path: string, failures: string[]): void {
  checkNum(leg["duration_s"], `${path}.duration_s`, failures);
  checkNum(leg["rss_slope_mb_per_min"], `${path}.rss_slope_mb_per_min`, failures);
  checkNum(leg["peak_rss_mb"], `${path}.peak_rss_mb`, failures);
  checkOptNum(leg["heap_slope_mb_per_min"], `${path}.heap_slope_mb_per_min`, failures);
  checkOptNum(leg["peak_heap_mb"], `${path}.peak_heap_mb`, failures);
  checkOptNum(leg["sample_interval_s"], `${path}.sample_interval_s`, failures);
  const samples = leg["samples"];
  if (!Array.isArray(samples) || samples.length < 2) {
    failures.push(`${path}.samples: expected array of >=2 stability samples`);
  } else {
    samples.forEach((s, i) => {
      const sp = `${path}.samples[${i}]`;
      const o = checkRecord(s, sp, failures);
      if (!o) return;
      if (!isStr(o["t"])) failures.push(`${sp}.t: expected ISO timestamp string`);
      checkNum(o["rss_mb"], `${sp}.rss_mb`, failures);
      checkOptNumOrNull(o["heap_mb"], `${sp}.heap_mb`, failures);
      checkOptNumOrNull(o["cpu_pct"], `${sp}.cpu_pct`, failures);
    });
  }
  if (leg["memory_events"] !== undefined && !Array.isArray(leg["memory_events"])) {
    failures.push(`${path}.memory_events: expected array`);
  }
  if (leg["level_transitions"] !== undefined) {
    if (!Array.isArray(leg["level_transitions"]) ||
        leg["level_transitions"].some((t) => !isStr(t))) {
      failures.push(`${path}.level_transitions: expected array of strings`);
    }
  }
}

function checkLeg(name: string, leg: unknown, failures: string[]): void {
  const path = `legs.${name}`;
  const o = checkRecord(leg, path, failures);
  if (!o) return;
  checkCommonLegFields(o, path, failures);
  if (name === "startup") {
    checkNum(o["startup_ms"], `${path}.startup_ms`, failures);
    checkOptNum(o["startup_to_first_paint_ms"], `${path}.startup_to_first_paint_ms`, failures);
  } else if (FRAME_LEGS.has(name as GpuiLegName)) {
    checkFrameFields(o, path, failures);
    if (name === "switch" && o["switch_latency"] === undefined) {
      failures.push(`${path}.switch_latency: switch leg must carry switch latency percentiles`);
    }
  } else if (DELIVERY_LEGS.has(name as GpuiLegName)) {
    checkDeliveryFields(o, path, failures);
  } else if (name === "longrun") {
    checkLongrunFields(o, path, failures);
  }
}

/**
 * Validate a parsed GPUI perf report. Returns a list of failure
 * reasons; empty = schema-valid. Never throws — callers (contract
 * check, tests, future emitters) get the full problem list.
 */
export function validateGpuiReport(value: unknown): string[] {
  const failures: string[] = [];
  const env = checkRecord(value, "report", failures);
  if (!env) return failures;

  if (env["format"] !== GPUI_REPORT_FORMAT) {
    failures.push(`format: expected "${GPUI_REPORT_FORMAT}", got ${JSON.stringify(env["format"])}`);
  }
  if (env["version"] !== GPUI_REPORT_VERSION) {
    failures.push(`version: expected ${GPUI_REPORT_VERSION}, got ${JSON.stringify(env["version"])}`);
  }
  if (!isStr(env["generated_at"])) failures.push("generated_at: expected ISO timestamp string");
  if (!isStr(env["git_sha"])) failures.push("git_sha: expected string");

  const host = checkRecord(env["host"], "host", failures);
  if (host) {
    if (!isStr(host["platform"])) failures.push("host.platform: expected string");
    if (!isStr(host["arch"])) failures.push("host.arch: expected string");
    checkOptNumOrNull(host["cpu_count"], "host.cpu_count", failures);
    checkOptNumOrNull(host["mem_total_mb"], "host.mem_total_mb", failures);
    checkOptNumOrNull(host["mem_total_bytes"], "host.mem_total_bytes", failures);
    if (host["cpu_model"] !== undefined && !isStr(host["cpu_model"])) {
      failures.push("host.cpu_model: expected string");
    }
    if (host["loadavg"] !== undefined) {
      if (!Array.isArray(host["loadavg"]) || host["loadavg"].some((v) => !isNum(v))) {
        failures.push("host.loadavg: expected array of numbers");
      }
    }
  }

  if (env["condition"] !== undefined) {
    const c = checkRecord(env["condition"], "condition", failures);
    if (c) {
      for (const k of ["loadavg_1m", "loadavg_5m", "loadavg_15m"] as const) {
        checkOptNum(c[k], `condition.${k}`, failures);
      }
    }
  }

  const workload = checkRecord(env["workload"], "workload", failures);
  if (workload === null) {
    // checkRecord already pushed the failure; nothing more to do.
  } else if (workload) {
    // Workload is intentionally open-ended (same role as perf-frame's
    // `workload` description map) — compare's WORKLOAD_KEYS pick the
    // comparable subset.
  }

  const legs = checkRecord(env["legs"], "legs", failures);
  if (legs) {
    const names = Object.keys(legs);
    if (names.length === 0) failures.push("legs: must contain at least one leg");
    for (const name of names) {
      if (!(GPUI_LEGS as readonly string[]).includes(name)) {
        failures.push(`legs.${name}: unknown leg (allowed: ${GPUI_LEGS.join(", ")})`);
        continue;
      }
      checkLeg(name, legs[name], failures);
    }
  }

  // Optional top-level memory snapshot (end-of-run MemoryHost state).
  if (env["memory"] !== undefined) {
    checkMemoryBlock(env["memory"], "memory", failures);
  }

  // Provisional budgets: when present they MUST be marked provisional —
  // calibrated absolute budgets are a schema-version decision (same
  // convention as perf-frame-bench --check, issue #526).
  if (env["budgets"] !== undefined) {
    const b = checkRecord(env["budgets"], "budgets", failures);
    if (b) {
      if (b["provisional"] !== true) {
        failures.push(
          'budgets.provisional: must be true — GPUI budgets are provisional until RC freeze calibration',
        );
      }
      for (const [k, v] of Object.entries(b)) {
        if (k === "provisional") continue;
        if (!isNum(v)) failures.push(`budgets.${k}: expected number`);
      }
    }
  }

  if (env["notes"] !== undefined && !isStr(env["notes"])) {
    failures.push("notes: expected string");
  }

  return failures;
}

/**
 * Minimal schema-valid report — the canonical fixture shared by the
 * contract check and unit tests. NOT a measurement; every number is a
 * placeholder that satisfies the type contract.
 */
export function sampleGpuiReport(): Record<string, unknown> {
  return {
    format: GPUI_REPORT_FORMAT,
    version: GPUI_REPORT_VERSION,
    generated_at: "1970-01-01T00:00:00.000Z",
    git_sha: "0000000",
    host: {
      platform: "darwin",
      arch: "arm64",
      cpu_model: "sample",
      cpu_count: 8,
      mem_total_mb: 16384,
      loadavg: [1, 1, 1],
    },
    condition: { loadavg_1m: 1 },
    workload: { scenario: "sample" },
    legs: {
      startup: { startup_ms: 0, startup_to_first_paint_ms: 0 },
      idle: {
        seconds: 0,
        frames: { count: 0, p50: 0, p95: 0, p99: 0, pct_over_16_7: 0 },
        input_paint: { p50: 0, p95: 0, p99: 0 },
        longtask_count: 0,
        longtask_total_ms: 0,
        task_utilization_pct: 0,
        cpu_utilization_pct: 0,
        memory: {
          rss_mb: 0,
          heap_mb: 0,
          host: {
            memory: {
              level: "ok",
              totalMb: 0,
              baselineMb: 0,
              slopeMbPerMin: 0,
              osAvailPct: 1,
              hardCapMb: 0,
            },
            budget: {
              totalBytes: 0,
              budgetBytes: 0,
              overBudget: false,
              sessions: 0,
            },
          },
        },
      },
      switch: {
        frames: { count: 0, p50: 0, p95: 0, p99: 0 },
        switch_latency: { p50: 0, p95: 0, p99: 0 },
      },
      terminal_io: {
        delivery_bytes_total: 0,
        attach_count: 0,
        detach_count: 0,
        rpc_counts: { resize: 0, scroll: 0 },
      },
      longrun: {
        duration_s: 0,
        samples: [
          { t: "1970-01-01T00:00:00.000Z", rss_mb: 0, heap_mb: 0, cpu_pct: 0 },
          { t: "1970-01-01T00:01:00.000Z", rss_mb: 0, heap_mb: 0, cpu_pct: 0 },
        ],
        rss_slope_mb_per_min: 0,
        peak_rss_mb: 0,
      },
    },
    budgets: { provisional: true, input_paint_p95_ms: 0, cpu_utilization_pct: 0 },
  };
}
