#!/usr/bin/env bun
/**
 * Reap CLI for scripts/ui-electron.sh cleanup (issue #416 program).
 *
 *   bun harness/ui/reap-cli.ts --pids-file F [--grace-ms N]
 *
 * SIGTERM->SIGKILL every pid recorded in the file plus their descendants
 * (Electron GPU/renderer/utility helpers). Cross-platform: the process
 * table comes from ps on POSIX and CIM/PowerShell on Windows. Only
 * processes descended from recorded pids are ever signalled.
 */
import { reapRecorded } from "./lib/watchdog.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pidsFile = arg("--pids-file");
const graceMs = Number(arg("--grace-ms") ?? 500);
if (!pidsFile) {
  console.error("usage: reap-cli.ts --pids-file F [--grace-ms N]");
  process.exit(2);
}
const targets = await reapRecorded(pidsFile, { graceMs: Number.isFinite(graceMs) ? graceMs : 500 });
console.error(`[reap] signalled ${targets.length} process(es)`);
