/**
 * Engine-floor measurement for the herdr TUI ⇄ hoxay comparison
 * (issue #640).
 *
 * Every herdr client — the TUI and hoxay alike — pays the cost of the
 * herdr server round trip for the same operation. That shared cost is the
 * *floor*: the part of hoxay's end-to-end latency that is not hoxay's
 * fault, and the part that the TUI also pays. Comparing clients means
 * comparing the overhead each client adds *above* this floor.
 *
 * The floor is measured directly against the herdr socket with the same
 * one-RPC-per-call rule the bridge uses (AGENTS.md §3), so the number is
 * engine + wire only — no renderer, no Electron, no bridge.
 *
 * Every call is deadline-bounded: a hung server fails the measurement
 * instead of stalling the comparison run.
 */
import { herdrRpc } from "../../../server/herdr.ts";

export interface FloorSample {
  method: string;
  /** round-trip ms per iteration */
  samples: number[];
}

export interface FloorResult {
  method: string;
  iterations: number;
  p50: number;
  p95: number;
  max: number;
  errors: number;
}

export interface FloorOptions {
  socketPath?: string;
  iterations?: number;
  /** per-call deadline; a call that exceeds it is an error, never a wait */
  timeoutMs?: number;
  /** settle time between iterations (ms) */
  gapMs?: number;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  // nearest-rank percentile
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarizeFloor(method: string, samples: number[], errors: number): FloorResult {
  return {
    method,
    iterations: samples.length,
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    max: samples.length ? round(Math.max(...samples)) : Number.NaN,
    errors,
  };
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Measure the round-trip latency of one RPC method against a herdr socket.
 * `paramsFn` is called per iteration so mutating calls (focus/split) do
 * not collapse into a server-side no-op fast path.
 */
export async function measureFloor(
  method: string,
  paramsFn: (i: number) => Record<string, unknown>,
  opts: FloorOptions = {},
): Promise<FloorResult> {
  const iterations = opts.iterations ?? 20;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const gapMs = opts.gapMs ?? 25;
  const samples: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    try {
      await herdrRpc(method, paramsFn(i), {
        timeoutMs,
        ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
      });
      samples.push(performance.now() - started);
    } catch {
      errors++;
    }
    if (gapMs > 0) await sleep(gapMs);
  }
  return summarizeFloor(method, samples, errors);
}

export interface FloorSuiteResult {
  socketPath: string;
  measuredAt: string;
  results: FloorResult[];
}

export interface FloorSuiteSpec {
  method: string;
  paramsFn: (i: number) => Record<string, unknown>;
  iterations?: number;
}

/**
 * Run a named suite of floor measurements against one socket.
 */
export async function measureFloorSuite(
  socketPath: string,
  specs: FloorSuiteSpec[],
  opts: FloorOptions = {},
): Promise<FloorSuiteResult> {
  const results: FloorResult[] = [];
  for (const spec of specs) {
    results.push(
      await measureFloor(spec.method, spec.paramsFn, {
        ...opts,
        socketPath,
        iterations: spec.iterations ?? opts.iterations,
      }),
    );
  }
  return { socketPath, measuredAt: new Date().toISOString(), results };
}
