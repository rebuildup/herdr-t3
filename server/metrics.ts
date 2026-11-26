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

interface MetricsReport {
  ok: true;
  uptimeMs: number;
  timestamp: string;
  counters: Record<string, number>;
  timers: Record<
    string,
    { count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number }
  >;
  gauges: Record<string, number>;
}

const counters = new Map<string, number>();
const timers = new Map<string, TimerStat>();
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
  return {
    ok: true,
    uptimeMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    counters: Object.fromEntries(counters),
    timers: out,
    gauges: Object.fromEntries(gauges),
  };
}

/** Clear all counters (tests and manual baseline resets). */
export function metricsReset(): void {
  counters.clear();
  timers.clear();
  gauges.clear();
}
