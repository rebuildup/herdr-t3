/**
 * In-process performance counters for the bridge core (issue #425, program
 * #416). Dependency-free: counters, timing summaries and gauges accumulated
 * in memory and exposed as one JSON snapshot via `/api/metrics` (dev server)
 * and `herdr-t3:metrics` IPC (desktop). They exist so perf regressions are
 * measured, not guessed: every counter maps to a user-observable symptom
 * (snapshot churn, RPC fan-out, plugin spawn rate, subscription flapping).
 *
 * Cardinality rule: label values must come from closed sets (RPC method
 * names, frame types, plugin command names) — never pane/workspace ids or
 * user data.
 */

export interface MetricsLabels {
  [key: string]: string;
}

interface TimerStat {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

/**
 * Quantity accumulator for non-duration measurements (bytes delivered,
 * frames, cells). Same cardinality rules as counters; `total`/`avg`/`max`/
 * `last` carry the recorded unit — the metric name documents it.
 */
interface MeterStat {
  count: number;
  total: number;
  max: number;
  last: number;
}

interface MetricsReport {
  ok: true;
  uptimeMs: number;
  timestamp: string;
  counters: Record<string, number>;
  timers: Record<
    string,
    { count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number }
  >;
  meters: Record<
    string,
    { count: number; total: number; avg: number; max: number; last: number }
  >;
  gauges: Record<string, number>;
}

const counters = new Map<string, number>();
const timers = new Map<string, TimerStat>();
const meters = new Map<string, MeterStat>();
const gauges = new Map<string, number>();
const startedAt = Date.now();

function key(name: string, labels?: MetricsLabels): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

/** Increment a counter. */
export function metricInc(name: string, labels?: MetricsLabels): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + 1);
}

/** Record a duration sample in milliseconds. */
export function metricObserve(name: string, ms: number, labels?: MetricsLabels): void {
  const k = key(name, labels);
  const stat = timers.get(k) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
  stat.count += 1;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  stat.lastMs = ms;
  timers.set(k, stat);
}

/**
 * Accumulate a quantity (bytes, frames, …) — the non-duration sibling of
 * `metricObserve`. Use for throughput/volume measurements where `total`
 * and `avg` are meaningful; keep durations on `metricObserve` so the
 * `*Ms` fields stay honest.
 */
export function metricAdd(name: string, value: number, labels?: MetricsLabels): void {
  const k = key(name, labels);
  const stat = meters.get(k) ?? { count: 0, total: 0, max: 0, last: 0 };
  stat.count += 1;
  stat.total += value;
  if (value > stat.max) stat.max = value;
  stat.last = value;
  meters.set(k, stat);
}

/** Set a gauge to an absolute value. */
export function metricGauge(name: string, value: number): void {
  gauges.set(name, value);
}

/** Time an async block: `await metricTimed("x", fn, labels)`. Records an
 * `ok=true|false` label derived from whether fn resolved or threw. */
export async function metricTimed<T>(
  name: string,
  fn: () => Promise<T>,
  labels?: MetricsLabels,
): Promise<T> {
  const t0 = performance.now();
  let ok = true;
  try {
    return await fn();
  } catch (error) {
    ok = false;
    throw error;
  } finally {
    metricObserve(name, performance.now() - t0, { ...labels, ok: ok ? "true" : "false" });
  }
}

/** JSON snapshot of everything collected since process start (or reset). */
export function metricsSnapshot(): MetricsReport {
  const out: MetricsReport["timers"] = {};
  for (const [k, s] of timers) {
    out[k] = {
      count: s.count,
      totalMs: Math.round(s.totalMs * 100) / 100,
      avgMs: s.count === 0 ? 0 : Math.round((s.totalMs / s.count) * 100) / 100,
      maxMs: Math.round(s.maxMs * 100) / 100,
      lastMs: Math.round(s.lastMs * 100) / 100,
    };
  }
  const outMeters: MetricsReport["meters"] = {};
  for (const [k, s] of meters) {
    outMeters[k] = {
      count: s.count,
      total: Math.round(s.total * 100) / 100,
      avg: s.count === 0 ? 0 : Math.round((s.total / s.count) * 100) / 100,
      max: Math.round(s.max * 100) / 100,
      last: Math.round(s.last * 100) / 100,
    };
  }
  return {
    ok: true,
    uptimeMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    counters: Object.fromEntries(counters),
    timers: out,
    meters: outMeters,
    gauges: Object.fromEntries(gauges),
  };
}

/** Clear all counters (tests and manual baseline resets). */
export function metricsReset(): void {
  counters.clear();
  timers.clear();
  meters.clear();
  gauges.clear();
}
