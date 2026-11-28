#!/usr/bin/env bun
/**
 * Lease CLI for real-machine UI verification (issue #416 program).
 *
 *   bun harness/ui/lease-cli.ts acquire <lease-file> --owner NAME --worktree PATH --session ID --ports k=v,...
 *   bun harness/ui/lease-cli.ts release <lease-file>
 *   bun harness/ui/lease-cli.ts status  <lease-file>
 *
 * acquire exits 0 on success, 4 when a live run already holds the lease.
 * The lease records owner pid + identity so concurrent sessions fail
 * fast and cleanup can never target another session's processes.
 */
import { hostname } from "node:os";
import { acquireLease, releaseLease, type LeaseOwner } from "./lib/watchdog.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const [cmd, leaseFile] = process.argv.slice(2);
if (!cmd || !leaseFile) {
  console.error("usage: lease-cli.ts <acquire|release|status> <lease-file> [opts]");
  process.exit(2);
}

if (cmd === "release") {
  releaseLease(leaseFile);
  process.exit(0);
}
if (cmd === "status") {
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(leaseFile)) {
    console.log("free");
    process.exit(0);
  }
  console.log(readFileSync(leaseFile, "utf8"));
  process.exit(0);
}
if (cmd === "acquire") {
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
    console.log(`lease acquired: ${JSON.stringify(owner)}`);
    process.exit(0);
  } catch (e) {
    console.error(`lease denied: ${e}`);
    process.exit(4);
  }
}
console.error(`unknown command ${cmd}`);
process.exit(2);
