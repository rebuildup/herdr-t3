/**
 * Bridge/plugin data-plane load bench (issues #416/#425).
 *
 * Drives the real dev bridge (`server/index.ts`) over its actual client
 * protocol — WebSocket frames + `/api/metrics` — against an isolated herdr
 * session, and records per-leg metric deltas so "before / after fix"
 * comparisons are measured, not guessed. Legs:
 *
 *   idle        WS connected, no requests — subscription baseline, zero churn
 *   rpc-read    N concurrent read-only `rpc` frames (session.snapshot) —
 *               must produce ZERO `bridge.snapshot.schedule{cause=rpc}`
 *               (#423) and exactly one herdr.rpc per frame
 *   plugin-read the 4 plugin surface stores' refresh pattern: plugin_list
 *               plus one read `plugin_call` per installed surface plugin,
 *               repeated on the stores' ~800 ms cadence — plugin.exec
 *               spawn count must stay <= issued calls (#424 coalescing)
 *   activity    external herdr workspace churn (create/focus/close via CLI)
 *               + client read polling — snapshot push/dedup, subscription
 *               stability, RPC wait under real event flow
 *
 * Usage:
 *   bun scripts/perf-bridge-load.ts record [--seconds N] [--session NAME]
 *        [--bridge-port N] [--out PATH]
 *   bun scripts/perf-bridge-load.ts compare <before.json> <after.json>
 *
 * Prerequisites: herdr CLI, bun. Ports default to bridge 4751. The session
 * defaults to `ht3load` and is enforced isolated via verify-guard — the
 * live session is refused. All spawned processes are killed on exit.
 * This is an RC/load measurement, not a per-commit gate; the fast gate is
 * scripts/perf-bridge-load.test.ts (fault injection on the detectors).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir, cpus, totalmem, platform, arch, hostname } from "node:os";
import { join } from "node:path";
import {
  assertBridgeTargetIsolated,
  resolveVerifyTarget,
  sessionSocketPath,
  VerifyIsolationError,
} from "./verify-guard";

const REPO_ROOT = join(import.meta.dir, "..");

// ---------- args ----------
const VALUE_FLAGS = new Set([
  "--session", "--socket", "--seconds", "--out", "--bridge-port",
]);
const args = new Map<string, string>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (VALUE_FLAGS.has(a)) args.set(a, process.argv[++i] ?? "");
  else if (a.startsWith("--")) args.set(a, "true");
  else positional.push(a);
}
const flag = (name: string, dflt: string) => args.get(name) ?? dflt;

const SESSION = flag("--session", "ht3load");
const BRIDGE_PORT = Number(flag("--bridge-port", "4751"));
const LEG_SECONDS = Number(flag("--seconds", "12"));
const OUT =
  positional[1] ??
  flag("--out", join(REPO_ROOT, "perf-reports", `bridge-load-${gitSha().slice(0, 8)}.json`));

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- metrics shapes (mirror server/metrics.ts output) ----------
export interface MetricsSnapshot {
  ok: true;
  uptimeMs: number;
  timestamp: string;
  counters: Record<string, number>;
  timers: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number }>;
  gauges: Record<string, number>;
}

export interface LegDelta {
  seconds: number;
  counters: Record<string, number>;
  timers: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }>;
}

/** Counter/timer deltas between two snapshots; missing keys count as 0. */
export function diffMetrics(before: MetricsSnapshot, after: MetricsSnapshot): LegDelta {
  const counters: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before.counters), ...Object.keys(after.counters)])) {
    const d = (after.counters[k] ?? 0) - (before.counters[k] ?? 0);
    if (d !== 0) counters[k] = d;
  }
  const timers: LegDelta["timers"] = {};
  for (const k of new Set([...Object.keys(before.timers), ...Object.keys(after.timers)])) {
    const b = before.timers[k];
    const a = after.timers[k];
    const count = (a?.count ?? 0) - (b?.count ?? 0);
    const totalMs = (a?.totalMs ?? 0) - (b?.totalMs ?? 0);
    if (count > 0) {
      timers[k] = {
        count,
        totalMs: Math.round(totalMs * 100) / 100,
        avgMs: Math.round((totalMs / count) * 100) / 100,
        maxMs: Math.max(a?.maxMs ?? 0, b?.maxMs ?? 0),
      };
    }
  }
  return { seconds: 0, counters, timers };
}

function counter(delta: LegDelta, name: string, label?: string): number {
  if (label === undefined) return delta.counters[name] ?? 0;
  return delta.counters[`${name}{${label}}`] ?? 0;
}

function timerCount(delta: LegDelta, name: string, label?: string): number {
  if (label === undefined) {
    return Object.entries(delta.timers)
      .filter(([k]) => k === name || k.startsWith(`${name}{`))
      .reduce((n, [, t]) => n + t.count, 0);
  }
  return Object.entries(delta.timers)
    .filter(([k]) => k === `${name}{${label}}` || k.startsWith(`${name}{`) && k.includes(label))
    .reduce((n, [, t]) => n + t.count, 0);
}

/**
 * Non-regression verdicts for one leg (issue #425). Thresholds are
 * provisional until RC freeze measures real variance — same convention as
 * performance-baseline.md. A leg "fails" only on hard invariant breaks
 * (read RPC scheduling a refetch, subscription flapping, spawn fan-out
 * above issued calls); timing regressions are reported, not gated here —
 * wall-clock gates live in perf-baseline.ts.
 */
export interface LegVerdict {
  leg: string;
  ok: boolean;
  failures: string[];
  notes: string[];
}

export function evaluateLeg(leg: string, delta: LegDelta, issued: Record<string, number>): LegVerdict {
  const failures: string[] = [];
  const notes: string[] = [];

  const rpcScheduled = counter(delta, "bridge.snapshot.schedule", "cause=rpc");
  const rpcFrames = issued["rpc"] ?? 0;
  const readRpcFrames = issued["rpc_read"] ?? 0;
  if (readRpcFrames > 0 && rpcScheduled > 0) {
    failures.push(`read-only rpc scheduled ${rpcScheduled} snapshot refetch(es) across ${readRpcFrames} frames (#423)`);
  } else if (rpcFrames > 0) {
    notes.push(`snapshot.schedule{cause=rpc}=${rpcScheduled} for ${rpcFrames} rpc frames`);
  }

  const reopens = counter(delta, "bridge.subscription.reopen");
  if (reopens > 0) failures.push(`subscription reopened ${reopens}x — flapping (#416)`);

  const pluginCalls = issued["plugin_call"] ?? 0;
  const execs = timerCount(delta, "plugin.exec", "what=plugin_call");
  if (pluginCalls > 0) {
    const ratio = execs / pluginCalls;
    notes.push(`plugin.exec/plugin_call=${ratio.toFixed(2)} (${execs} execs / ${pluginCalls} calls)`);
    // Single-flight can only merge, never duplicate: >1 exec per issued
    // call means fan-out amplification — the exact #416 regression.
    if (execs > pluginCalls) {
      failures.push(`plugin exec fan-out ${execs} > ${pluginCalls} issued calls`);
    }
  }
  const herdrTimer = Object.entries(delta.timers).find(([k]) => k === "herdr.rpc" || k.startsWith("herdr.rpc{"));
  if (herdrTimer) {
    const t = herdrTimer[1];
    notes.push(`herdr.rpc avg=${t.avgMs}ms max=${t.maxMs}ms n=${t.count}`);
  }
  const pushes = counter(delta, "bridge.snapshot.push");
  const unchanged = counter(delta, "bridge.snapshot.push.unchanged");
  if (pushes + unchanged > 0) {
    notes.push(`snapshot pushes=${pushes} unchanged=${unchanged} scheduled=${counter(delta, "bridge.snapshot.schedule")}`);
  }
  return { leg, ok: failures.length === 0, failures, notes };
}

// ---------- WS client ----------
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  sentAt: number;
}

class BridgeClient {
  private ws!: WebSocket;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  latencies: number[] = [];
  errors = 0;
  framesReceived = 0;

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws connect failed"));
    });
    this.ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as { type?: string; id?: string; ok?: boolean; error?: { message?: string } };
      this.framesReceived += 1;
      if (frame.type === "rpc_result" && frame.id && this.pending.has(frame.id)) {
        const p = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        this.latencies.push(performance.now() - p.sentAt);
        if (frame.ok === false) {
          this.errors += 1;
          p.reject(new Error(frame.error?.message ?? "rpc error"));
        } else {
          p.resolve(frame);
        }
      }
    };
  }

  call(frame: Record<string, unknown>): Promise<unknown> {
    const id = `load-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt: performance.now() });
      this.ws.send(JSON.stringify({ ...frame, id }));
    });
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.call({ type: "rpc", method, params });
  }

  pluginCall(plugin: string, command: string, args: string[] = []): Promise<unknown> {
    return this.call({ type: "plugin_call", plugin, command, args });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------- orchestration ----------
const KNOWN_READ_CALLS: Record<string, { plugin: string; command: string }> = {
  inbox: { plugin: "rebuildup.inbox", command: "list" },
  automations: { plugin: "rebuildup.automations", command: "list" },
  conversations: { plugin: "rebuildup.conversations", command: "sessions" },
  usage: { plugin: "rebuildup.usage", command: "quota" },
};

async function metrics(port: number): Promise<MetricsSnapshot> {
  const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
  return (await res.json()) as MetricsSnapshot;
}

function herdrCli(session: string, cliArgs: string[]): string {
  return execFileSync("herdr", ["--session", session, ...cliArgs], { encoding: "utf8" });
}

interface Proc {
  kill: () => void;
}

function spawnLogged(cmd: string[], env: Record<string, string>, log: string): Proc {
  const p = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  void Bun.write(log, p.stdout as ReadableStream);
  void Bun.write(`${log}.err`, p.stderr as ReadableStream);
  return { kill: () => p.kill() };
}

async function waitHttp(url: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

interface LoadReport {
  format: "herdr-t3/bridge-load";
  version: 1;
  recorded_at: string;
  git_sha: string;
  host: ReturnType<typeof hostInfo>;
  condition: { loadavg_1m: number; loadavg_5m: number; loadavg_15m: number };
  leg_seconds: number;
  plugins_discovered: string[];
  legs: Record<string, { delta: LegDelta; issued: Record<string, number>; verdict: LegVerdict }>;
  client: { rpc_latencies_ms: { p50: number; p95: number; max: number }; errors: number; frames_received: number };
}

function hostInfo() {
  const cpu = cpus()[0];
  return {
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    cpu_model: cpu?.model ?? "unknown",
    cpu_count: cpus().length,
    mem_total_bytes: totalmem(),
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

async function runLeg(
  name: string,
  seconds: number,
  port: number,
  drive: () => Promise<Record<string, number>>,
): Promise<{ delta: LegDelta; issued: Record<string, number>; verdict: LegVerdict }> {
  const before = await metrics(port);
  const issued = await drive();
  const after = await metrics(port);
  const delta = diffMetrics(before, after);
  delta.seconds = seconds;
  const verdict = evaluateLeg(name, delta, issued);
  return { delta, issued, verdict };
}

async function main(): Promise<number> {
  const cmd = positional[0] ?? "record";

  if (cmd === "compare") {
    const [aPath, bPath] = positional.slice(1);
    if (!aPath || !bPath) {
      console.error("usage: perf-bridge-load.ts compare <before.json> <after.json>");
      return 2;
    }
    const { readFileSync } = await import("node:fs");
    const a = JSON.parse(readFileSync(aPath, "utf8")) as LoadReport;
    const b = JSON.parse(readFileSync(bPath, "utf8")) as LoadReport;
    if (a.host.platform !== b.host.platform || a.host.arch !== b.host.arch ||
        a.host.cpu_model !== b.host.cpu_model) {
      console.error("incomparable hosts — numbers from different machines are not comparable");
      return 2;
    }
    for (const leg of Object.keys(b.legs)) {
      const la = a.legs[leg];
      const lb = b.legs[leg];
      if (!la || !lb) continue;
      const execA = Object.entries(la.delta.timers).filter(([k]) => k.startsWith("plugin.exec{") && k.includes("what=plugin_call")).reduce((n, [, t]) => n + t.count, 0) / la.delta.seconds;
      const execB = Object.entries(lb.delta.timers).filter(([k]) => k.startsWith("plugin.exec{") && k.includes("what=plugin_call")).reduce((n, [, t]) => n + t.count, 0) / lb.delta.seconds;
      const pushA = (counter(la.delta, "bridge.snapshot.push") + counter(la.delta, "bridge.snapshot.push.unchanged")) / la.delta.seconds;
      const pushB = (counter(lb.delta, "bridge.snapshot.push") + counter(lb.delta, "bridge.snapshot.push.unchanged")) / lb.delta.seconds;
      const rpcAvg = (d: LegDelta) => {
        const t = Object.entries(d.timers).find(([k]) => k === "herdr.rpc" || k.startsWith("herdr.rpc{"));
        return t?.[1].avgMs ?? 0;
      };
      console.log(`[${leg}] plugin.exec/s ${execA.toFixed(2)} -> ${execB.toFixed(2)} | snapshot.push/s ${pushA.toFixed(2)} -> ${pushB.toFixed(2)} | herdr.rpc avg ${rpcAvg(la.delta).toFixed(1)}ms -> ${rpcAvg(lb.delta).toFixed(1)}ms`);
    }
    return 0;
  }

  // --- record -------------------------------------------------------------
  const procs: Proc[] = [];
  const tmpDirs: string[] = [];
  let herdrStarted = false;
  let succeeded = false;
  let sessionName = SESSION;
  try {
    const hasTarget =
      args.has("--session") || args.has("--socket") ||
      !!process.env.HERDR_VERIFY_SESSION || !!process.env.HERDR_SESSION || !!process.env.HERDR_SOCKET;
    const guardArgv = hasTarget
      ? process.argv.slice(2)
      : [...process.argv.slice(2), "--session", SESSION];
    const target = resolveVerifyTarget({ argv: guardArgv });
    const socket = target.socketPath ?? sessionSocketPath(target.session ?? SESSION);
    sessionName =
      target.session ??
      /sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(socket)?.[1] ??
      SESSION;

    if (!existsSync(socket)) {
      if (target.socketPath) throw new VerifyIsolationError(`socket ${socket} does not exist`);
      console.log(`starting isolated herdr session ${sessionName} (${socket})`);
      const log = join(tmpdir(), `ht3load-herdr-${process.pid}.log`);
      tmpDirs.push(log, `${log}.err`);
      const p = Bun.spawn(["herdr", "--session", sessionName, "server"], { stdout: "pipe", stderr: "pipe" });
      void Bun.write(log, p.stdout as ReadableStream);
      void Bun.write(`${log}.err`, p.stderr as ReadableStream);
      procs.push({ kill: () => p.kill() });
      herdrStarted = true;
      for (let i = 0; i < 60; i++) {
        if (existsSync(socket)) break;
        await sleep(500);
      }
      if (!existsSync(socket)) throw new Error(`herdr session socket never appeared: ${socket}`);
    }

    // fixture: one workspace so focus/mutation legs have a target
    let wsList: { result: { workspaces: { workspace_id: string }[] } } | null = null;
    for (let i = 0; i < 20; i++) {
      try {
        wsList = JSON.parse(herdrCli(sessionName, ["workspace", "list"]));
        break;
      } catch {
        await sleep(400);
      }
    }
    if (!wsList) throw new Error(`herdr session ${sessionName} did not answer workspace list`);
    for (const w of wsList.result.workspaces) {
      herdrCli(sessionName, ["workspace", "close", w.workspace_id]);
    }
    const created = JSON.parse(
      herdrCli(sessionName, ["workspace", "create", "--label", "perf-load", "--no-focus"]),
    ).result as { workspace: { workspace_id: string } };
    const fixtureWs = created.workspace.workspace_id;
    console.log(`fixture workspace ${fixtureWs}`);
    await sleep(800);

    // --- bridge ------------------------------------------------------------
    const work = mkdtempSync(join(tmpdir(), "ht3load-"));
    tmpDirs.push(work);
    const bridgeLog = join(work, "bridge.log");
    procs.push(spawnLogged(
      ["bun", "run", "server/index.ts"],
      {
        PORT: String(BRIDGE_PORT),
        HERDR_T3_PORT: String(BRIDGE_PORT),
        HOST: "127.0.0.1",
        HERDR_SOCKET: socket,
      },
      bridgeLog,
    ));
    await waitHttp(`http://127.0.0.1:${BRIDGE_PORT}/api/health`);
    await assertBridgeTargetIsolated(`http://127.0.0.1:${BRIDGE_PORT}`, { argv: guardArgv });

    const client = new BridgeClient();
    await client.connect(`ws://127.0.0.1:${BRIDGE_PORT}/ws`);
    await sleep(500); // ready + initial snapshot settle

    const legSeconds = LEG_SECONDS;
    const legs: LoadReport["legs"] = {};

    // -- idle ----------------------------------------------------------------
    {
      const r = await runLeg("idle", legSeconds, BRIDGE_PORT, async () => {
        const end = Date.now() + legSeconds * 1000;
        while (Date.now() < end) await sleep(500);
        return {};
      });
      legs.idle = r;
      console.log(`idle: pushes=${counter(r.delta, "bridge.snapshot.push") + counter(r.delta, "bridge.snapshot.push.unchanged")} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    // -- rpc-read --------------------------------------------------------------
    {
      const counts: Record<string, number> = { rpc: 0, rpc_read: 0 };
      const r = await runLeg("rpc-read", legSeconds, BRIDGE_PORT, async () => {
        const end = Date.now() + legSeconds * 1000;
        // 4 concurrent readers on a 400 ms cadence — the shape that used to
        // amplify into snapshot refetches before #423.
        const readers = Array.from({ length: 4 }, async () => {
          while (Date.now() < end) {
            counts.rpc += 1;
            counts.rpc_read += 1;
            await client.rpc("session.snapshot").catch(() => {});
            await sleep(400);
          }
        });
        await Promise.all(readers);
        return counts;
      });
      legs["rpc-read"] = r;
      console.log(`rpc-read: rpc=${counts.rpc} schedule(cause=rpc)=${counter(r.delta, "bridge.snapshot.schedule", "cause=rpc")} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    // -- plugin-read ------------------------------------------------------------
    {
      // discover which of the known surface plugins are installed
      const list = (await client.call({ type: "plugin_list" }).catch(() => null)) as
        | { result?: { plugins?: { plugin_id: string }[] } }
        | null;
      const installed = new Set((list?.result?.plugins ?? []).map((p) => p.plugin_id));
      const reads = Object.values(KNOWN_READ_CALLS).filter((c) => installed.has(c.plugin));
      const counts: Record<string, number> = { plugin_call: 0 };
      if (reads.length === 0) {
        legs["plugin-read"] = {
          delta: { seconds: legSeconds, counters: {}, timers: {} },
          issued: counts,
          verdict: { leg: "plugin-read", ok: true, failures: [], notes: ["skipped: none of the known surface plugins installed"] },
        };
        console.log("plugin-read: skipped (no known plugins installed)");
      } else {
        const r = await runLeg("plugin-read", legSeconds, BRIDGE_PORT, async () => {
          const end = Date.now() + legSeconds * 1000;
          // mirror the stores: every ~800 ms each surface refreshes → one
          // plugin_call per surface per tick, all concurrent.
          while (Date.now() < end) {
            counts.plugin_call += reads.length;
            await Promise.all(
              reads.map((c) => client.pluginCall(c.plugin, c.command).catch(() => {})),
            );
            await sleep(800);
          }
          return counts;
        });
        legs["plugin-read"] = r;
        console.log(`plugin-read: calls=${counts.plugin_call} execs=${timerCount(r.delta, "plugin.exec", "what=plugin_call")} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
      }
    }

    // -- activity -----------------------------------------------------------------
    {
      const counts: Record<string, number> = { rpc: 0, rpc_read: 0, plugin_call: 0 };
      // reuse discovered reads if the plugin leg ran
      const list = (await client.call({ type: "plugin_list" }).catch(() => null)) as
        | { result?: { plugins?: { plugin_id: string }[] } }
        | null;
      const installed = new Set((list?.result?.plugins ?? []).map((p) => p.plugin_id));
      const reads = Object.values(KNOWN_READ_CALLS).filter((c) => installed.has(c.plugin));
      let wsIds = [fixtureWs];
      const r = await runLeg("activity", legSeconds, BRIDGE_PORT, async () => {
        const end = Date.now() + legSeconds * 1000;
        // external churn: create → focus → close workspaces on ~700 ms ticks
        const churn = (async () => {
          let n = 0;
          while (Date.now() < end) {
            try {
              const c = JSON.parse(
                herdrCli(sessionName, ["workspace", "create", "--label", `perf-load-${n}`, "--no-focus"]),
              ).result as { workspace: { workspace_id: string } };
              wsIds.push(c.workspace.workspace_id);
              herdrCli(sessionName, ["workspace", "focus", c.workspace.workspace_id]);
              await sleep(300);
              herdrCli(sessionName, ["workspace", "close", c.workspace.workspace_id]);
            } catch {
              /* churn best-effort */
            }
            n += 1;
            await sleep(400);
          }
        })();
        // client side: read rpc + plugin reads at store cadence
        const poll = (async () => {
          while (Date.now() < end) {
            counts.rpc += 1;
            counts.rpc_read += 1;
            await client.rpc("session.snapshot").catch(() => {});
            if (reads.length > 0) {
              counts.plugin_call += reads.length;
              await Promise.all(reads.map((c) => client.pluginCall(c.plugin, c.command).catch(() => {})));
            }
            await sleep(800);
          }
        })();
        await Promise.all([churn, poll]);
        return counts;
      });
      legs.activity = r;
      console.log(`activity: pushes=${counter(r.delta, "bridge.snapshot.push")} unchanged=${counter(r.delta, "bridge.snapshot.push.unchanged")} schedule=${counter(r.delta, "bridge.snapshot.schedule")} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    client.close();

    const lat = [...client.latencies].sort((a, b) => a - b);
    const report: LoadReport = {
      format: "herdr-t3/bridge-load",
      version: 1,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: hostInfo(),
      condition: { loadavg_1m: loadavg()[0], loadavg_5m: loadavg()[1], loadavg_15m: loadavg()[2] },
      leg_seconds: legSeconds,
      plugins_discovered: [],
      legs,
      client: {
        rpc_latencies_ms: { p50: pct(lat, 50), p95: pct(lat, 95), max: lat[lat.length - 1] ?? 0 },
        errors: client.errors,
        frames_received: client.framesReceived,
      },
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(OUT, ".."), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${OUT}`);
    succeeded = true;
    return 0;
  } finally {
    for (const p of procs) p.kill();
    if (herdrStarted) {
      try {
        herdrCli(sessionName, ["server", "stop"]);
      } catch {
        /* best-effort */
      }
    }
    void tmpDirs;
    void succeeded;
  }
}

if (import.meta.main) process.exit(await main());
