import { describe, expect, it } from "bun:test";
import { compare } from "./lib/compare.ts";
import { normalizeObservation } from "./lib/normalize.ts";

/**
 * Fault-injection proof (issue #237): the comparator and normalizer must
 * detect intentional violations — ordering changes, missing state,
 * decode errors, and volatile-field leaks — rather than wave them
 * through. These tests fail if the judge itself regresses.
 */
describe("harness fault injection", () => {
  it("detects an ordering violation inside an array", () => {
    const expected = { rows: [{ y: 0 }, { y: 1 }, { y: 2 }] };
    const observed = { rows: [{ y: 0 }, { y: 2 }, { y: 1 }] };
    const r = compare(expected, observed);
    expect(r.ok).toBe(false);
    expect(r.diffs.join(" ")).toContain("rows[1]");
  });

  it("detects missing state", () => {
    const r = compare({ a: 1, b: 2 }, { a: 1 });
    expect(r.ok).toBe(false);
    expect(r.diffs.join(" ")).toContain("b");
  });

  it("detects unexpected extra state in exact mode", () => {
    const r = compare({ a: 1 }, { a: 1, b: 2 }, "exact");
    expect(r.ok).toBe(false);
  });

  it("subset mode still enforces array order and length", () => {
    const r = compare({ rows: [1, 2] }, { rows: [1] }, "subset");
    expect(r.ok).toBe(false);
  });

  it("normalization masks volatile strings but keeps structure", () => {
    const out = normalizeObservation(
      { id: "123e4567-e89b-42d3-a456-426614174000", at: "2026-11-25T10:00:00Z", keep: "stable" },
      {},
    ) as Record<string, unknown>;
    expect(out["id"]).toBe("<volatile>");
    expect(out["at"]).toBe("<volatile>");
    expect(out["keep"]).toBe("stable");
  });

  it("normalize.drop removes only the listed paths", () => {
    const out = normalizeObservation(
      { a: { drop_me: 1, keep: 2 }, b: 3 },
      { normalize: { drop: ["a.drop_me"] } },
    ) as Record<string, unknown>;
    expect(out).toEqual({ a: { keep: 2 }, b: 3 });
  });
});
