import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, diagnose, main } from "./perf-observe.ts";

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
