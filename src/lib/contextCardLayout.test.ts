import { describe, expect, test } from "bun:test";

import {
  CONTEXT_CARD_GAP,
  CONTEXT_CARD_MIN_HEIGHT,
  CONTEXT_CARD_MIN_REMAINING,
  CONTEXT_CARD_WIDTH,
  resolveContextCardDensity,
  resolveContextCardPlacement,
} from "./contextCardLayout";

describe("resolveContextCardDensity", () => {
  test("full when the measured full height fits", () => {
    expect(resolveContextCardDensity(500, { full: 400, compact: 200 })).toBe("full");
  });
  test("unmeasured full height counts as fitting (first paint)", () => {
    expect(resolveContextCardDensity(100, { full: 0, compact: 0 })).toBe("full");
  });
  test("compact when only the compact height fits", () => {
    expect(resolveContextCardDensity(300, { full: 500, compact: 250 })).toBe("compact");
  });
  test("essential when nothing fits", () => {
    expect(resolveContextCardDensity(100, { full: 500, compact: 250 })).toBe("essential");
  });
  test("density follows height in both directions", () => {
    const content = { full: 500, compact: 250 };
    expect(resolveContextCardDensity(600, content)).toBe("full");
    expect(resolveContextCardDensity(300, content)).toBe("compact");
    expect(resolveContextCardDensity(600, content)).toBe("full");
  });
});

describe("resolveContextCardPlacement", () => {
  test("places the card at the canvas top-right when it fits", () => {
    const p = resolveContextCardPlacement({ container: { width: 1200, height: 800 } });
    expect(p).toEqual({
      right: CONTEXT_CARD_GAP,
      top: CONTEXT_CARD_GAP,
      width: CONTEXT_CARD_WIDTH,
      height: 800 - CONTEXT_CARD_GAP * 2,
    });
  });
  test("null when the remaining pane area drops below the minimum", () => {
    const narrow = CONTEXT_CARD_WIDTH + CONTEXT_CARD_GAP * 2 + CONTEXT_CARD_MIN_REMAINING - 1;
    expect(resolveContextCardPlacement({ container: { width: narrow, height: 800 } })).toBeNull();
    expect(
      resolveContextCardPlacement({
        container: { width: narrow + 1, height: 800 },
      }),
    ).not.toBeNull();
  });
  test("null when the canvas is too short for a useful card", () => {
    expect(
      resolveContextCardPlacement({
        container: { width: 1200, height: CONTEXT_CARD_MIN_HEIGHT + CONTEXT_CARD_GAP * 2 - 1 },
      }),
    ).toBeNull();
  });
});
