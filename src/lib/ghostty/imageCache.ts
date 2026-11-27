/**
 * Byte-budgeted LRU for decoded kitty-image canvases (issue #499). The WASM
 * engine already caps image storage at 64 MiB per pane; this keeps the
 * renderer's decoded RGBA copies proportional to that instead of growing
 * once per unique image id ever painted.
 */
export interface GhosttyImageCacheEntry {
  generation: number;
  canvas: HTMLCanvasElement;
}

const BYTES_PER_PIXEL = 4;

export class GhosttyImageCache {
  private readonly entries = new Map<number, GhosttyImageCacheEntry>();
  private bytes = 0;

  constructor(private readonly budgetBytes: number) {}

  get(id: number): GhosttyImageCacheEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      // refresh recency: Map order is the LRU order
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
    return entry;
  }

  set(id: number, entry: GhosttyImageCacheEntry): void {
    const old = this.entries.get(id);
    if (old) {
      this.bytes -= old.canvas.width * old.canvas.height * BYTES_PER_PIXEL;
      this.entries.delete(id);
    }
    this.entries.set(id, entry);
    this.bytes += entry.canvas.width * entry.canvas.height * BYTES_PER_PIXEL;
    for (const [key, evicted] of this.entries) {
      if (this.bytes <= this.budgetBytes) return;
      this.bytes -= evicted.canvas.width * evicted.canvas.height * BYTES_PER_PIXEL;
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }
}
