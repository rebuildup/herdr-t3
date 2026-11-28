/**
 * Renderer-side app-wide memory budget (issue #499 follow-up).
 *
 * Per-resource caps (image cache bytes, slot queue bytes, scrollback bytes)
 * bound each buffer, but nothing summed them: N panes × M buffers could
 * still exceed what the machine has. This module is the aggregate layer:
 *
 * - every live `GhosttySession` registers a byte probe (WASM linear memory
 *   high-water mark — it only grows, so it never under-reports);
 * - every shed-able cache registers a shedder (image pixel cache, scene
 *   advance cache);
 * - `evaluateMemoryBudget` sums the probes and, past the budget, runs every
 *   shedder once. Shedding is lossless — caches rebuild from the engine on
 *   next paint — so it is safe under pressure;
 * - `startMemoryBudgetWatch` re-evaluates on a timer and on pressure pushes
 *   from the main process (`herdr-t3:memory-pressure`).
 *
 * The budget itself scales with `navigator.deviceMemory`: the renderer's
 * share is capped at 50% of reported RAM (max 6 GiB) so it can never claim
 * the OS's headroom even if every probe is accurate.
 */
import { onMemoryPressure } from "./api.ts";

const MIB = 1024 * 1024;

function rendererBudgetBytes(): number {
  // navigator.deviceMemory is capped at 8 by spec and may be absent (and is
  // not in the TS DOM lib).
  const gb =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memGb = typeof gb === "number" && gb > 0 ? gb : 8;
  return Math.min(memGb * 0.5, 6) * 1024 * MIB;
}

const BUDGET_BYTES = rendererBudgetBytes();
/** Evaluate this often even without external pressure pushes. */
const WATCH_INTERVAL_MS = 30_000;

const probes = new Map<string, () => number>();
const shedders = new Map<string, () => void>();
let watching = false;
let lastTotalBytes = 0;

export interface MemoryBudgetStatus {
  totalBytes: number;
  budgetBytes: number;
  overBudget: boolean;
  sessions: number;
}

/** Sum of all registered WASM/session byte probes. */
export function memoryBudgetTotalBytes(): number {
  let total = 0;
  for (const probe of probes.values()) total += probe();
  return total;
}

/**
 * Register a byte probe (typically `session.memoryBytes`). Returns an
 * unregister function. Re-registering the same id replaces the probe.
 */
export function registerMemoryProbe(id: string, probe: () => number): () => void {
  probes.set(id, probe);
  scheduleEvaluate();
  return () => {
    if (probes.get(id) === probe) probes.delete(id);
  };
}

/**
 * Register a cache shedder. `shed` must be idempotent and lossless — it is
 * invoked when the aggregate budget is exceeded or on pressure pushes.
 */
export function registerMemoryShedder(id: string, shed: () => void): () => void {
  shedders.set(id, shed);
  return () => {
    if (shedders.get(id) === shed) shedders.delete(id);
  };
}

/** Run every registered shedder once (lossless cache eviction). */
export function shedMemoryCaches(): number {
  let shed = 0;
  for (const shedFn of shedders.values()) {
    try {
      shedFn();
      shed++;
    } catch {
      /* a broken shedder must not break the others */
    }
  }
  return shed;
}

/**
 * WASM linear memory only grows, so `memoryBytes()` probes are
 * high-water marks: once sessions have grown, the summed total can stay
 * over budget even after every recoverable cache is shed. Shedding is
 * therefore rate-limited — running it on every 30 s tick while the
 * high-water mark sits over budget would thrash the caches it just
 * cleared. A new shed round runs when the interval elapsed AND the total
 * grew meaningfully since the last round (early reaction to fast
 * growth), or when the interval elapsed regardless (slow drift).
 */
const SHED_MIN_INTERVAL_MS = 60_000;
const SHED_GROWTH_BYTES = 64 * MIB;
let lastShedAt = 0;
let lastShedTotalBytes = 0;
let lastOverBudgetWarnAt = 0;

/** Largest byte probes, for over-budget attribution in diagnostics. */
function topProbes(limit = 3): { id: string; mib: number }[] {
  return [...probes.entries()]
    .map(([id, probe]) => {
      try {
        return { id, mib: probe() / MIB };
      } catch {
        return { id, mib: 0 };
      }
    })
    .sort((a, b) => b.mib - a.mib)
    .slice(0, limit);
}

/**
 * Evaluate the aggregate budget: if the summed probes exceed it, shed all
 * caches and re-measure. Returns the post-shed status. Called on register/
 * dispose, on a timer, and on main-process pressure pushes.
 */
export function evaluateMemoryBudget(now: number = Date.now()): MemoryBudgetStatus {
  let total = memoryBudgetTotalBytes();
  let overBudget = total > BUDGET_BYTES;
  if (overBudget) {
    const grew = total - lastShedTotalBytes >= SHED_GROWTH_BYTES;
    const due = now - lastShedAt >= SHED_MIN_INTERVAL_MS;
    if (due || grew) {
      lastShedAt = now;
      lastShedTotalBytes = total;
      shedMemoryCaches();
      total = memoryBudgetTotalBytes();
      overBudget = total > BUDGET_BYTES;
    }
    if (overBudget && now - lastOverBudgetWarnAt >= SHED_MIN_INTERVAL_MS) {
      lastOverBudgetWarnAt = now;
      // Still over after shedding: the residual is WASM linear memory,
      // which cannot shrink without disposing the session. The
      // main-process watchdog owns the hard cap and reload; naming the
      // largest sessions keeps the pressure attributable.
      console.warn(
        `[memory-budget] ${(total / MIB).toFixed(0)}MiB over the ` +
          `${(BUDGET_BYTES / MIB).toFixed(0)}MiB budget; top sessions: ` +
          topProbes()
            .map((p) => `${p.id}=${p.mib.toFixed(0)}MiB`)
            .join(", "),
      );
    }
  } else {
    lastShedTotalBytes = total;
  }
  lastTotalBytes = total;
  return { totalBytes: total, budgetBytes: BUDGET_BYTES, overBudget, sessions: probes.size };
}

export function memoryBudgetStatus(): MemoryBudgetStatus {
  return {
    totalBytes: lastTotalBytes || memoryBudgetTotalBytes(),
    budgetBytes: BUDGET_BYTES,
    overBudget: lastTotalBytes > BUDGET_BYTES,
    sessions: probes.size,
  };
}

function scheduleEvaluate(): void {
  // Coalesce bursts of register/dispose into one evaluation per microtask
  // flush — enough to react without evaluating per keystroke-scale events.
  queueMicrotask(() => {
    if (!watching) return;
    evaluateMemoryBudget();
  });
}

/**
 * Start the periodic watch and subscribe to main-process pressure pushes.
 * Idempotent; returns a stop function.
 */
export function startMemoryBudgetWatch(): () => void {
  if (watching) return () => {};
  watching = true;
  const timer = setInterval(evaluateMemoryBudget, WATCH_INTERVAL_MS);
  const offPressure = onMemoryPressure?.((push) => {
    // warn → shed caches now (cheap, lossless); critical/breach → shed and
    // let the main-process watchdog decide on reload.
    shedMemoryCaches();
    evaluateMemoryBudget();
    if (push.level !== "ok") {
      console.warn(`[memory-budget] pressure ${push.level}: ${(push.totalMb ?? 0)}MB total RSS`);
    }
  });
  evaluateMemoryBudget();
  return () => {
    watching = false;
    clearInterval(timer);
    offPressure?.();
  };
}
