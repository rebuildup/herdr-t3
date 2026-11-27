import { describe, expect, it } from "bun:test";
import { LruCache } from "./lru.ts";

describe("LruCache", () => {
  it("evicts the oldest entry past the entry cap", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("d")).toBe(4);
  });

  it("get refreshes recency so hot keys survive", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a is now most-recent
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  it("enforces the byte budget across entries", () => {
    const cache = new LruCache<number, { w: number }>(100, 100, (v) => v.w);
    cache.set(1, { w: 60 });
    cache.set(2, { w: 60 }); // total 120 > 100 -> evict 1
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.byteSize).toBe(60);
  });

  it("keeps a lone entry larger than the byte budget", () => {
    const cache = new LruCache<number, { w: number }>(100, 100, (v) => v.w);
    cache.set(1, { w: 500 });
    expect(cache.has(1)).toBe(true);
    cache.set(2, { w: 10 }); // evicts the oversized entry first? no — oldest first
    expect(cache.byteSize).toBeLessThanOrEqual(510);
  });

  it("re-set replaces bytes instead of double counting", () => {
    const cache = new LruCache<number, { w: number }>(10, 100, (v) => v.w);
    cache.set(1, { w: 50 });
    cache.set(1, { w: 50 });
    expect(cache.byteSize).toBe(50);
    cache.set(1, { w: 10 });
    expect(cache.byteSize).toBe(10);
  });

  it("delete and clear release accounted bytes", () => {
    const cache = new LruCache<number, { w: number }>(10, 100, (v) => v.w);
    cache.set(1, { w: 50 });
    expect(cache.delete(1)).toBe(true);
    expect(cache.byteSize).toBe(0);
    cache.set(2, { w: 50 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
