/**
 * Verification time budgets (issue #416 program; hang-detection contract).
 *
 * Every wait in the UI verification path must be bounded by an explicit
 * deadline. A missing deadline is a defect: a hung target must surface as
 * a failure inside the budget, never as a silent stall. Fixed sleeps are
 * only allowed as poll *intervals* inside a deadline-bounded loop.
 */

export class BudgetExceeded extends Error {
  readonly label: string;
  readonly budgetMs: number;
  constructor(label: string, budgetMs: number) {
    super(`${label}: exceeded ${budgetMs}ms budget`);
    this.name = "BudgetExceeded";
    this.label = label;
    this.budgetMs = budgetMs;
  }
}

/** Reject `promise` if it does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded(label, ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface WaitForOptions {
  /** total budget; exceeding it throws BudgetExceeded */
  timeoutMs: number;
  /** poll interval (default 100ms) */
  intervalMs?: number;
  /** human-readable label for diagnostics */
  label?: string;
}

/**
 * Poll `fn` until it returns a truthy value or the budget expires.
 * Returns the last observed value on success; throws BudgetExceeded on
 * timeout. `fn` errors are treated as "not yet" and retried until budget.
 */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: WaitForOptions,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 100;
  const label = opts.label ?? "waitFor";
  let last: unknown;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BudgetExceeded(`${label} (last=${JSON.stringify(last)?.slice(0, 200)})`, opts.timeoutMs);
    }
    try {
      // Bound each poll by the *remaining* budget: a hung fn must not
      // overrun the deadline (e.g. a CDP call with a larger per-call
      // timeout inside a shorter ready budget).
      const v = await withTimeout(
        Promise.resolve().then(() => fn()),
        remaining,
        label,
      );
      last = v;
      if (v) return v as T;
    } catch {
      /* retry until budget */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Canonical budgets for the UI verification path. Env overrides use the
 *  UI_BUDGET_<NAME> convention (ms). */
export interface UiBudgets {
  /** single CDP/IPC call must answer within this */
  cdpCallMs: number;
  /** electron process -> page reports operable (__herdrT3Ui + readyState) */
  readyMs: number;
  /** one scenario's total wall-clock budget */
  scenarioMs: number;
  /** one adapter act/observe/resolve call */
  stepCallMs: number;
  /** fixture setup incl. reload + bridge reconnect */
  fixtureMs: number;
  /** whole ui-electron.sh orchestration incl. builds and all scenarios */
  runMs: number;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[`UI_BUDGET_${name}`];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function uiBudgets(): UiBudgets {
  return {
    cdpCallMs: envMs("CDP_CALL", 10_000),
    readyMs: envMs("READY", 5_000),
    scenarioMs: envMs("SCENARIO", 180_000),
    stepCallMs: envMs("STEP_CALL", 15_000),
    fixtureMs: envMs("FIXTURE", 60_000),
    runMs: envMs("RUN", 900_000),
  };
}
