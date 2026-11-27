import { describe, expect, test } from "bun:test";
import {
  frameIntervals,
  intervalStats,
  latencyStats,
  percentile,
} from "./perf-frame-bench.ts";

describe("percentile", () => {
  test("nearest-rank on sorted input", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([10], 50)).toBe(10);
  });
  test("rejects empty", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("frameIntervals", () => {
  test("diffs consecutive timestamps, drops non-frame gaps", () => {
    // 16.7ms frames, one 2s gap (occluded/backgrounded), one backwards step
    const ts = [0, 16.7, 33.4, 50.1, 2050.1, 2066.8, 30];
    const got = frameIntervals(ts);
    expect(got.length).toBe(4);
    for (const v of got) expect(v).toBeCloseTo(16.7, 1);
  });
});

describe("intervalStats", () => {
  test("computes budget-miss percentages", () => {
    const stats = intervalStats([16.7, 16.7, 20, 40, 60])!;
    expect(stats.count).toBe(5);
    expect(stats.p50).toBe(20);
    expect(stats.pct_over_16_7).toBeCloseTo(60);
    expect(stats.pct_over_33_4).toBeCloseTo(40);
    expect(stats.pct_over_50).toBeCloseTo(20);
  });
  test("null on empty", () => {
    expect(intervalStats([])).toBeNull();
  });
  test("reports p99", () => {
    const stats = intervalStats([16.7, 17, 18, 20, 500])!;
    expect(stats.p99).toBe(500);
  });
});

describe("latencyStats", () => {
  test("computes p50/p95/p99 over clean samples", () => {
    const stats = latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!;
    expect(stats.count).toBe(10);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(100);
    expect(stats.p99).toBe(100);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(100);
    expect(stats.mean).toBeCloseTo(55);
  });
  test("drops non-finite and negative samples", () => {
    const stats = latencyStats([5, -1, Number.NaN, 15])!;
    expect(stats.count).toBe(2);
    expect(stats.p50).toBe(5);
  });
  test("null when nothing usable", () => {
    expect(latencyStats([])).toBeNull();
    expect(latencyStats([-1, Number.NaN])).toBeNull();
  });
});
