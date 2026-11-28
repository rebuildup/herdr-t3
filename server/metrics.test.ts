import { describe, expect, test, beforeEach } from "bun:test";
import {
  metricAdd,
  metricGauge,
  metricInc,
  metricObserve,
  metricTimed,
  metricsReset,
  metricsSnapshot,
} from "./metrics.ts";

describe("metrics", () => {
  beforeEach(() => metricsReset());

  test("counters accumulate per name+labels", () => {
    metricInc("a.b");
    metricInc("a.b");
    metricInc("a.b", { cause: "rpc" });
    metricInc("a.b", { cause: "event" });
    const s = metricsSnapshot();
    expect(s.counters["a.b"]!).toBe(2);
    expect(s.counters['a.b{cause=event}']!).toBe(1);
    expect(s.counters['a.b{cause=rpc}']!).toBe(1);
  });

  test("labels are sorted for stable keys", () => {
    metricInc("x", { b: "2", a: "1" });
    expect(metricsSnapshot().counters["x{a=1,b=2}"]).toBe(1);
  });

  test("timers record count/total/avg/max/last", () => {
    metricObserve("t", 10);
    metricObserve("t", 30);
    metricObserve("t", 20, { ok: "false" });
    const s = metricsSnapshot();
    expect(s.timers["t"]!.count).toBe(2);
    expect(s.timers["t"]!.avgMs).toBe(20);
    expect(s.timers["t"]!.maxMs).toBe(30);
    expect(s.timers['t{ok=false}']!.lastMs).toBe(20);
  });

  test("metricTimed records ok label and rethrows", async () => {
    await metricTimed("op", async () => "fine", { what: "x" });
    await expect(
      metricTimed("op", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const s = metricsSnapshot();
    expect(s.timers['op{ok=true,what=x}']!.count).toBe(1);
    expect(s.timers["op{ok=false}"]!.count).toBe(1);
  });

  test("meters accumulate quantities (bytes) per name+labels", () => {
    metricAdd("terminal.delivery.bytes", 100, { phase: "initial" });
    metricAdd("terminal.delivery.bytes", 300, { phase: "initial" });
    metricAdd("terminal.delivery.bytes", 50, { phase: "scroll" });
    const s = metricsSnapshot();
    expect(s.meters['terminal.delivery.bytes{phase=initial}']!).toEqual({
      count: 2, total: 400, avg: 200, max: 300, last: 300,
    });
    expect(s.meters['terminal.delivery.bytes{phase=scroll}']!.total).toBe(50);
    // Meters are quantities, not durations: no *Ms fields leak in.
    expect(s.meters['terminal.delivery.bytes{phase=initial}']!).not.toHaveProperty("totalMs");
  });

  test("gauges and snapshot metadata", () => {
    metricGauge("g", 42);
    const s = metricsSnapshot();
    expect(s.gauges["g"]!).toBe(42);
    expect(s.ok).toBe(true);
    expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof s.timestamp).toBe("string");
  });
});
