/**
 * Main-process memory-pressure signal (issue #499). The Electron watchdog
 * samples `app.getAppMetrics()` and pushes a level when the renderer's
 * working set crosses the shed threshold. Listeners drop pure caches —
 * Kitty image canvases, glyph advance measurements — which are always safe
 * to lose (a miss just recomputes). This is the graceful degradation that
 * keeps a runaway pane from taking the whole OS down; it is not a
 * substitute for the bounded queues and caches elsewhere.
 */
export type MemoryPressureLevel = "warn" | "critical";

const listeners = new Set<(level: MemoryPressureLevel) => void>();

export function onMemoryPressure(listener: (level: MemoryPressureLevel) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Dispatch a watchdog level to every registered cache shedder. */
export function notifyMemoryPressure(level: string): void {
  const normalized: MemoryPressureLevel = level === "critical" ? "critical" : "warn";
  for (const listener of listeners) {
    try {
      listener(normalized);
    } catch {
      /* one bad shedder must not block the rest */
    }
  }
}
