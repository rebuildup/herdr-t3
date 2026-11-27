/**
 * Bounded LRU map for renderer-side caches (issue #499). Insertion order is
 * recency: `get` refreshes, `set` evicts the oldest entry until both the
 * entry cap and the optional byte budget hold. A lone entry larger than
 * `maxBytes` is kept — the producer's own cap bounds it, and evicting it
 * would reintroduce per-frame recompute.
 *
 * Eviction is silent: callers treat a miss as "recompute", which is always
 * safe for caches. This is the memory-budget mechanism for caches that
 * would otherwise grow for the life of the pane (Kitty image canvases,
 * grapheme advance measurements).
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number = Number.POSITIVE_INFINITY,
    private readonly sizeOf: (value: V) => number = () => 1,
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** total bytes across entries, per `sizeOf` (entries when no sizer given) */
  get byteSize(): number {
    return this.bytes;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    const old = this.map.get(key);
    if (old !== undefined) this.bytes -= this.sizeOf(old);
    this.map.delete(key);
    this.map.set(key, value);
    this.bytes += this.sizeOf(value);
    this.evict();
  }

  delete(key: K): boolean {
    const value = this.map.get(key);
    if (value === undefined) return false;
    this.map.delete(key);
    this.bytes -= this.sizeOf(value);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      if (this.map.size <= 1) return;
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) return;
      const value = this.map.get(oldest);
      this.map.delete(oldest);
      if (value !== undefined) this.bytes -= this.sizeOf(value);
    }
  }
}
