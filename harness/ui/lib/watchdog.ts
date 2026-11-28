/**
 * Independent watchdog + exclusive lease for real-machine UI verification
 * (issue #416 program; hang-detection contract).
 *
 * The watchdog runs as a separate process (watchdog-cli.ts) so a hung
 * target cannot stall the timeout mechanism itself: it only needs to
 * read a pid file and write diagnostics — it never talks to the app.
 *
 * The lease makes real-machine verification exclusive: one run at a
 * time, with owner identity recorded, so concurrent sessions fail fast
 * instead of fighting over ports/processes. Cleanup only ever signals
 * PIDs the run itself recorded — never another session's processes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BudgetExceeded } from "./budget.ts";

export interface LeaseOwner {
  pid: number;
  owner: string;
  worktree: string;
  session: string;
  startedAt: string;
  ports: Record<string, number>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the exclusive verification lease. Throws with owner details
 *  when a live run already holds it; takes over stale leases. */
export function acquireLease(path: string, owner: LeaseOwner): void {
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, "utf8")) as LeaseOwner;
      if (prev.pid && pidAlive(prev.pid)) {
        throw new Error(
          `UI verification lease held by pid ${prev.pid} (${prev.owner} @ ${prev.worktree}, session=${prev.session}, started ${prev.startedAt}). ` +
            `Wait for it or stop it deliberately; concurrent real-machine runs are not allowed.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("lease held")) throw e;
      /* corrupt lease file -> treat as stale */
    }
  }
  writeFileSync(path, `${JSON.stringify(owner, null, 2)}\n`);
}

export function releaseLease(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best effort */
  }
}

/** Append a spawned pid+label to the run's pid file. */
export function recordPid(pidsFile: string, pid: number, label: string): void {
  appendFileSync(pidsFile, `${pid} ${label}\n`);
}

export function readPids(pidsFile: string): { pid: number; label: string }[] {
  if (!existsSync(pidsFile)) return [];
  return readFileSync(pidsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [pid, ...rest] = l.split(/\s+/);
      return { pid: Number(pid), label: rest.join(" ") };
    })
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

/** Snapshot diagnostics for a timed-out run: process table, pid file,
 *  lease content. Written into diagDir which the caller populates with
 *  the infra logs. */
export function writeDiagnostics(diagDir: string, label: string): string {
  mkdirSync(diagDir, { recursive: true });
  const stamp = new Date().toISOString();
  const out: string[] = [`# watchdog timeout: ${label} at ${stamp}`, ""];
  try {
    out.push("## ps (verification-related)", "```",
      execFileSync("ps", ["-axo", "pid,ppid,etime,%cpu,command"], { encoding: "utf8" })
        .split("\n")
        .filter((l) => /herdr|electron|vite|bun|chrome/i.test(l))
        .join("\n"),
      "```", "");
  } catch (e) {
    out.push(`## ps failed: ${e}`, "");
  }
  writeFileSync(join(diagDir, "diagnostics.md"), out.join("\n"));
  return diagDir;
}

export interface WatchdogOptions {
  budgetMs: number;
  pidsFile: string;
  diagDir: string;
  label: string;
  /** injectable for tests: defaults to process.kill */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** injectable clock/sleep for tests */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** called once when budget expires, before kills */
  onTimeout?: () => void;
}

export interface WatchdogHandle {
  /** resolves when the watchdog fires its timeout */
  readonly fired: Promise<BudgetExceeded>;
  stop(): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start the watchdog. It polls the pid file and, when the budget
 * expires, writes diagnostics then SIGTERM->SIGKILLs every recorded
 * pid. It never touches processes it did not record.
 */
export function startWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const kill = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollMs ?? 250;
  const started = now();
  let stopped = false;
  let firedResolve!: (e: BudgetExceeded) => void;
  const fired = new Promise<BudgetExceeded>((r) => (firedResolve = r));

  const loop = (async () => {
    for (;;) {
      await sleep(pollMs);
      if (stopped) return;
      if (now() - started >= opts.budgetMs) {
        const err = new BudgetExceeded(`watchdog: ${opts.label}`, opts.budgetMs);
        try {
          opts.onTimeout?.();
          writeDiagnostics(opts.diagDir, opts.label);
          const pids = readPids(opts.pidsFile);
          for (const { pid } of pids) {
            try {
              kill(pid, "SIGTERM");
            } catch {
              /* already gone */
            }
          }
          await sleep(500);
          for (const { pid } of pids) {
            try {
              kill(pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        } finally {
          firedResolve(err);
        }
        return;
      }
    }
  })();

  return {
    fired,
    async stop() {
      stopped = true;
      await loop.catch(() => {});
    },
  };
}
