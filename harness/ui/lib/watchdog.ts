/**
 * Independent watchdog + exclusive lease for real-machine UI verification
 * (issue #416 program; hang-detection contract).
 *
 * The watchdog runs as a separate process (watchdog-cli.ts) so a hung
 * target cannot stall the timeout mechanism itself: it only reads a pid
 * file and writes diagnostics — it never talks to the app.
 *
 * The lease is machine-global (not per-worktree) and acquired atomically
 * (O_EXCL create), so concurrent sessions on any worktree of this repo —
 * or of a sibling checkout — serialize instead of racing. Cleanup only
 * ever signals pids the run itself recorded plus their descendants —
 * never another session's processes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/** Machine-global lease location, shared by every worktree of this repo
 *  on this machine. XDG_STATE_HOME on POSIX, LOCALAPPDATA on Windows. */
export function defaultLeasePath(): string {
  const stateHome =
    process.env.UI_VERIFY_STATE_DIR ??
    process.env.XDG_STATE_HOME ??
    (process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
      : join(homedir(), ".local", "state"));
  return join(stateHome, "herdr-t3", "ui-verify.lease.json");
}

const LEASE_ATTEMPTS = 100;
const LEASE_RETRY_MS = 50;

/**
 * Acquire the exclusive verification lease atomically.
 *
 * Uses O_EXCL create so two racing acquirers cannot both win. If the
 * lease exists and its owner pid is alive, throws immediately with the
 * owner's identity. If the owner is dead or the file is corrupt, the
 * stale lease is removed and acquisition retried — the retry loop also
 * covers the race where two processes both observe the same stale lease
 * (only one O_EXCL create can win; the loser re-reads and sees a live
 * owner).
 */
export function acquireLease(path: string, owner: LeaseOwner): void {
  mkdirSync(dirname(path), { recursive: true });
  const data = `${JSON.stringify(owner, null, 2)}\n`;
  for (let attempt = 0; attempt < LEASE_ATTEMPTS; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, data);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // Lease file exists: live owner -> deny; stale/corrupt -> remove + retry.
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
    try {
      rmSync(path, { force: true });
    } catch {
      /* another acquirer may have removed it first — retry handles both */
    }
    // brief yield so a concurrent winner's file is visible before retry
    const end = Date.now() + LEASE_RETRY_MS;
    while (Date.now() < end) {
      /* spin briefly; lease contention is rare and short */
    }
  }
  throw new Error(`could not acquire UI verification lease at ${path} after ${LEASE_ATTEMPTS} attempts`);
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

export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Process table snapshot. POSIX: ps; Windows: CIM via PowerShell.
 *  Best-effort — returns [] when the platform query fails. */
export function listProcesses(): ProcInfo[] {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const parsed = JSON.parse(out || "[]") as
        | { ProcessId: number; ParentProcessId: number; CommandLine?: string | null }
        | { ProcessId: number; ParentProcessId: number; CommandLine?: string | null }[];
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((p) => Number.isFinite(p.ProcessId))
        .map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine ?? "" }));
    }
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? "" } : null;
      })
      .filter((p): p is ProcInfo => p !== null);
  } catch {
    return [];
  }
}

/** Pids recorded in the file plus every descendant (transitive) found in
 *  the given process table. Descendants of our spawned processes are ours
 *  by definition — e.g. Electron's GPU/renderer/utility helpers. */
export function collectTree(pids: number[], table: ProcInfo[]): Set<number> {
  const result = new Set<number>(pids);
  const childrenOf = new Map<number, number[]>();
  for (const p of table) {
    const list = childrenOf.get(p.ppid) ?? [];
    list.push(p.pid);
    childrenOf.set(p.ppid, list);
  }
  const queue = [...pids];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    for (const child of childrenOf.get(pid) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

export interface ReapOptions {
  /** injectable for tests */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  listProcesses?: () => ProcInfo[];
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reap a run's processes: SIGTERM the recorded pids and their
 * descendants, wait `graceMs`, then SIGKILL survivors. Only processes
 * descended from recorded pids are touched.
 */
export async function reapRecorded(pidsFile: string, opts: ReapOptions = {}): Promise<number[]> {
  const kill = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const table = (opts.listProcesses ?? listProcesses)();
  const roots = readPids(pidsFile).map((p) => p.pid);
  const targets = [...collectTree(roots, table)];
  const signalAll = (sig: NodeJS.Signals) => {
    for (const pid of targets) {
      try {
        kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalAll("SIGTERM");
  await (opts.sleep ?? defaultSleep)(opts.graceMs ?? 500);
  signalAll("SIGKILL");
  return targets;
}

/** Snapshot diagnostics for a timed-out run into diagDir. */
export function writeDiagnostics(
  diagDir: string,
  label: string,
  procList: () => ProcInfo[] = listProcesses,
): string {
  mkdirSync(diagDir, { recursive: true });
  const stamp = new Date().toISOString();
  const out: string[] = [`# watchdog timeout: ${label} at ${stamp}`, ""];
  try {
    const table = procList().filter((p) =>
      /herdr|electron|vite|bun|chrome|node/i.test(p.command),
    );
    out.push(
      "## processes (verification-related)",
      "```",
      table.map((p) => `${p.pid}\t${p.ppid}\t${p.command.slice(0, 200)}`).join("\n"),
      "```",
      "",
    );
  } catch (e) {
    out.push(`## process snapshot failed: ${e}`, "");
  }
  writeFileSync(join(diagDir, "diagnostics.md"), out.join("\n"));
  return diagDir;
}

export interface WatchdogOptions {
  budgetMs: number;
  pidsFile: string;
  diagDir: string;
  label: string;
  /** injectable for tests */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  listProcesses?: () => ProcInfo[];
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

/**
 * Start the watchdog. It polls and, when the budget expires, writes
 * diagnostics then reaps every recorded pid and its descendants.
 * It never touches processes it did not record.
 */
export function startWatchdog(opts: WatchdogOptions): WatchdogHandle {
  const now = Date.now;
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
          writeDiagnostics(
            opts.diagDir,
            opts.label,
            opts.listProcesses ?? listProcesses,
          );
          await reapRecorded(opts.pidsFile, {
            ...(opts.kill ? { kill: opts.kill } : {}),
            ...(opts.listProcesses ? { listProcesses: opts.listProcesses } : {}),
            sleep,
          });
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
