import { describe, expect, test } from "bun:test";
import {
  diffMetrics,
  evaluateLeg,
  type LegDelta,
  type MetricsSnapshot,
} from "./perf-bridge-load.ts";

/**
 * Fault-injection tests for the bridge-load detectors (issues #416/#425):
 * the leg evaluator must flag the exact regression shapes the perf program
 * fixed — read-RPC snapshot amplification, subscription flapping, plugin
 * exec fan-out — and pass a healthy leg. No wall-clock benchmarks here;
 * this is the fast gate. Full legs run at RC / manual measurement.
 */

function snap(counters: Record<string, number> = {}, timers: MetricsSnapshot["timers"] = {}): MetricsSnapshot {
  return { ok: true, uptimeMs: 0, timestamp: "", counters, timers, gauges: {} };
}

function timer(count: number, totalMs: number, maxMs = 10): MetricsSnapshot["timers"][string] {
  return { count, totalMs, avgMs: totalMs / count, maxMs, lastMs: 10 };
}

function delta(counters: Record<string, number> = {}, timers: LegDelta["timers"] = {}): LegDelta {
  return { seconds: 10, counters, timers };
}

describe("diffMetrics", () => {
  test("computes counter and timer deltas, ignoring unchanged keys", () => {
    const before = snap(
      { "bridge.snapshot.push": 5, "client.frame{type=rpc}": 10 },
      { "herdr.rpc": timer(10, 100), "plugin.exec{what=plugin_call}": timer(4, 40) },
    );
    const after = snap(
      { "bridge.snapshot.push": 8, "client.frame{type=rpc}": 10, "bridge.snapshot.push.unchanged": 3 },
      { "herdr.rpc": timer(16, 170), "plugin.exec{what=plugin_call}": timer(6, 66) },
    );
    const d = diffMetrics(before, after);
    expect(d.counters["bridge.snapshot.push"]).toBe(3);
    expect(d.counters["bridge.snapshot.push.unchanged"]).toBe(3);
    expect(d.counters["client.frame{type=rpc}"]).toBeUndefined();
    expect(d.timers["herdr.rpc"]).toEqual({ count: 6, totalMs: 70, avgMs: 11.67, maxMs: 10 });
    expect(d.timers["plugin.exec{what=plugin_call}"]?.count).toBe(2);
  });
});

describe("evaluateLeg", () => {
  test("healthy rpc-read leg passes: read RPCs schedule no refetch", () => {
    const d = delta(
      { "bridge.snapshot.schedule{cause=event}": 2, "bridge.snapshot.push": 2 },
      { "herdr.rpc": { count: 40, totalMs: 400, avgMs: 10, maxMs: 30 } },
    );
    const v = evaluateLeg("rpc-read", d, { rpc: 40, rpc_read: 40 });
    expect(v.ok).toBe(true);
    expect(v.failures).toHaveLength(0);
  });

  test("#423 regression: read-only rpc scheduling snapshot refetches fails", () => {
    const d = delta({ "bridge.snapshot.schedule{cause=rpc}": 12 });
    const v = evaluateLeg("rpc-read", d, { rpc: 40, rpc_read: 40 });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("snapshot refetch");
  });

  test("#416 regression: subscription flapping fails", () => {
    const v = evaluateLeg("activity", delta({ "bridge.subscription.reopen": 3 }), { rpc: 5, rpc_read: 5 });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("reopened");
  });

  test("#424 regression: plugin exec fan-out beyond issued calls fails", () => {
    const d = delta({}, {
      "plugin.exec{command=list,ok=true,what=plugin_call}": { count: 30, totalMs: 300, avgMs: 10, maxMs: 20 },
    });
    const v = evaluateLeg("plugin-read", d, { plugin_call: 20 });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("fan-out");
  });

  test("coalesced plugin leg passes: execs <= issued calls", () => {
    const d = delta({}, {
      "plugin.exec{command=list,ok=true,what=plugin_call}": { count: 12, totalMs: 120, avgMs: 10, maxMs: 20 },
    });
    const v = evaluateLeg("plugin-read", d, { plugin_call: 20 });
    expect(v.ok).toBe(true);
    expect(v.notes.some((n) => n.includes("plugin.exec/plugin_call=0.60"))).toBe(true);
  });

  test("mutating rpc may schedule refetches without failing", () => {
    const d = delta({ "bridge.snapshot.schedule{cause=rpc}": 4, "bridge.snapshot.schedule{cause=event}": 9 });
    const v = evaluateLeg("activity", d, { rpc: 6, rpc_read: 0 });
    expect(v.ok).toBe(true);
  });

  test("#527 regression: per-pane subscription reopens on attach churn fails", () => {
    // 4-pane batch × 15 cycles = 60 subscribes; coalesced ≈ 2 opens/phase
    // (~30), per-pane amplification ≈ 2 opens/subscribe (120).
    const amplified = delta({ "bridge.subscription.open": 120 });
    const v = evaluateLeg("attach-churn", amplified, {
      subscribe_terminal: 60,
      unsubscribe_terminal: 60,
      attach_batch: 4,
    });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("per-pane reopen amplification");

    const coalesced = delta({ "bridge.subscription.open": 30 });
    const ok = evaluateLeg("attach-churn", coalesced, {
      subscribe_terminal: 60,
      unsubscribe_terminal: 60,
      attach_batch: 4,
    });
    expect(ok.ok).toBe(true);
  });

  test("#527 regression: duplicate sessions per reconnect fail", () => {
    const d = delta(
      { "bridge.subscription.open": 12 },
      { "herdr.rpc{method=session.snapshot,ok=true}": { count: 14, totalMs: 140, avgMs: 10, maxMs: 20 } },
    );
    const v = evaluateLeg("reconnect", d, { reconnect: 6 });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.includes("reconnects"))).toBe(true);

    const healthy = delta(
      { "bridge.subscription.open": 6 },
      { "herdr.rpc{method=session.snapshot,ok=true}": { count: 6, totalMs: 60, avgMs: 10, maxMs: 20 } },
    );
    const ok = evaluateLeg("reconnect", healthy, { reconnect: 6 });
    expect(ok.ok).toBe(true);
  });
});
