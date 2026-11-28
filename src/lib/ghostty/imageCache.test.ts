import { describe, expect, it } from "bun:test";
import { GhosttyImageCache } from "./imageCache.ts";

const canvas = (w: number, h: number) => ({ width: w, height: h }) as HTMLCanvasElement;
const bytes = (w: number, h: number) => w * h * 4;

describe("GhosttyImageCache", () => {
  it("keeps entries under the byte budget, evicting least-recently-used first", () => {
    const cache = new GhosttyImageCache(1000);
    cache.set(1, { generation: 0, canvas: canvas(10, 10) }); // 400B
    cache.set(2, { generation: 0, canvas: canvas(10, 10) }); // 400B
    cache.get(1); // touch 1 so 2 becomes oldest
    cache.set(3, { generation: 0, canvas: canvas(10, 10) }); // 400B → evicts 2
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBeDefined();
    expect(cache.get(3)).toBeDefined();
    expect(cache.usedBytes).toBe(800);
  });

  it("replaces a same-id entry without double counting", () => {
    const cache = new GhosttyImageCache(10_000);
    cache.set(1, { generation: 0, canvas: canvas(10, 10) });
    cache.set(1, { generation: 1, canvas: canvas(20, 20) }); // 1600B replaces 400B
    expect(cache.usedBytes).toBe(bytes(20, 20));
    expect(cache.get(1)?.generation).toBe(1);
  });

  it("evicts everything rather than exceed the budget for one oversized image", () => {
    const cache = new GhosttyImageCache(100);
    cache.set(1, { generation: 0, canvas: canvas(10, 10) });
    cache.set(2, { generation: 0, canvas: canvas(100, 100) }); // 40_000B > budget
    expect(cache.size).toBe(0);
    expect(cache.usedBytes).toBe(0);
  });

  it("clear() resets accounting", () => {
    const cache = new GhosttyImageCache(1000);
    cache.set(1, { generation: 0, canvas: canvas(10, 10) });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.usedBytes).toBe(0);
  });
});
