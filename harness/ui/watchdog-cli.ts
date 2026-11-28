#!/usr/bin/env bun
/**
 * Watchdog + lease holder for scripts/ui-electron.sh (issue #416 program).
 *
 *   bun harness/ui/watchdog-cli.ts --budget-ms N --pids-file F --diag-dir D \
 *     [--label L] [--lease-file L --owner NAME --worktree PATH --session ID --ports k=v,...]
 *
 * Runs as an independent process for the whole verification: it holds the
 * exclusive real-machine lease (its own pid is the lease owner, so the
 * lease stays valid exactly as long as the watchdog lives) and, on budget
 * expiry, writes diagnostics into --diag-dir and kills only the pids
 * recorded in --pids-file. It never talks to the app under test, so a
 * hung target cannot stall the timeout mechanism.
 *
 * Exit code 0 = stopped cleanly before budget; 3 = budget fired;
 * 4 = lease denied (another live run holds it).
 */
import { hostname } from "node:os";
import { startWatchdog, acquireLease, releaseLease, type LeaseOwner } from "./lib/watchdog.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const budgetMs = Number(arg("--budget-ms"));
const pidsFile = arg("--pids-file");
const diagDir = arg("--diag-dir");
const label = arg("--label") ?? "ui-run";
const leaseFile = arg("--lease-file");

if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !pidsFile || !diagDir) {
  console.error("usage: watchdog-cli.ts --budget-ms N --pids-file F --diag-dir D [--label L] [--lease-file L ...]");
  process.exit(2);
}

if (leaseFile) {
  const ports: Record<string, number> = {};
  for (const kv of (arg("--ports") ?? "").split(",")) {
    const [k, v] = kv.split("=");
    if (k && v) ports[k] = Number(v);
  }
  const owner: LeaseOwner = {
    pid: process.pid,
    owner: `${hostname()}:${process.env.USER ?? "?"}`,
    worktree: arg("--worktree") ?? process.cwd(),
    session: arg("--session") ?? "unknown",
    startedAt: new Date().toISOString(),
    ports,
  };
  try {
    acquireLease(leaseFile, owner);
  } catch (e) {
    console.error(`lease denied: ${e}`);
    process.exit(4);
  }
}

const wd = startWatchdog({ budgetMs, pidsFile, diagDir, label });
wd.fired.then((err) => {
  console.error(`[watchdog] ${err.message} — diagnostics: ${diagDir}`);
  if (leaseFile) releaseLease(leaseFile);
  process.exit(3);
});
process.on("SIGTERM", () => {
  void wd.stop().then(() => {
    if (leaseFile) releaseLease(leaseFile);
    process.exit(0);
  });
});
