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
 *   attach-churn workspace-switch attach pattern: subscribe_terminal for
 *               every pane in a batch, unsubscribe, repeat — scroll-
 *               subscription reopens must coalesce per batch, not per pane
 *               (issue #527)
 *   terminal-io  demand-driven delivery leg (issue #572): one attach
 *               batch + bounded in-pane output + scroll/resize probes —
 *               initial-attach vs post-scroll delivery bytes, attach/
 *               detach counts, forwarded op counts (terminal.delivery.
 *               bytes meters, bridge.terminal.* counters)
 *   reconnect   WS drop + reconnect cycles — each connect must cost exactly
 *               one session.snapshot fetch + one subscription open
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
  "--plugin-refresh-ms",
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
// Store refresh cadence model: pre-#422 stores refreshed on every
// snapshot push debounced ~800 ms; post-#422 gates snapshot-triggered
// refreshes at 15 s per machine. Override to model either behavior.
const PLUGIN_REFRESH_MS = Number(flag("--plugin-refresh-ms", "800"));
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
  /** Quantity accumulators (bytes/frames) — absent on pre-#572 bridges. */
  meters?: Record<string, { count: number; total: number; avg: number; max: number; last: number }>;
  gauges: Record<string, number>;
}

export interface LegDelta {
  seconds: number;
  counters: Record<string, number>;
  timers: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }>;
  /** Absent on pre-#572 reports and hand-built deltas. */
  meters?: Record<string, { count: number; total: number; avg: number; max: number }>;
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
  const meters: LegDelta["meters"] = {};
  for (const k of new Set([...Object.keys(before.meters ?? {}), ...Object.keys(after.meters ?? {})])) {
    const b = before.meters?.[k];
    const a = after.meters?.[k];
    const count = (a?.count ?? 0) - (b?.count ?? 0);
    const total = (a?.total ?? 0) - (b?.total ?? 0);
    if (count > 0) {
      meters[k] = {
        count,
        total: Math.round(total * 100) / 100,
        avg: Math.round((total / count) * 100) / 100,
        max: Math.max(a?.max ?? 0, b?.max ?? 0),
      };
    }
  }
  return { seconds: 0, counters, timers, meters };
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

/** Sum `total` across meter keys matching `name` (optionally narrowed by a label fragment). */
function meterTotal(delta: LegDelta, name: string, label?: string): number {
  return Object.entries(delta.meters ?? {})
    .filter(([k]) =>
      label === undefined
        ? k === name || k.startsWith(`${name}{`)
        : k === `${name}{${label}}` || (k.startsWith(`${name}{`) && k.includes(label)),
    )
    .reduce((n, [, m]) => n + m.total, 0);
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

  if (leg === "attach-churn" || leg === "terminal-io") {
    const subs = issued["subscribe_terminal"] ?? 0;
    const batch = Math.max(1, issued["attach_batch"] ?? 1);
    const opens = counter(delta, "bridge.subscription.open");
    const phases = Math.ceil(subs / batch);
    notes.push(
      `subscription.open=${opens} across ${subs} subscribes in batches of ${batch} (~${phases} attach/detach phases)`,
    );
    // Each phase may legitimately reopen at most twice — once for the
    // attach batch, once for the detach batch. Reopens scaling with pane
    // count instead of phase count is the #416/#527 amplification.
    if (opens > 2 * phases + 4) {
      failures.push(
        `subscription.open=${opens} exceeds ~2 reopens per attach phase (${phases} phases, batch ${batch}) — per-pane reopen amplification`,
      );
    }
  }

  if (leg === "terminal-io") {
    // Demand-driven delivery leg (issue #572): scroll/resize ops must reach
    // a live slot exactly once — forwarded counts above issued counts are
    // amplification, below is dropped ops (both are defects worth flagging).
    const scrollIssued = issued["terminal_scroll"] ?? 0;
    const scrollFwd = counter(delta, "bridge.terminal.op", "op=scroll");
    const resizeIssued = issued["terminal_resize"] ?? 0;
    const resizeFwd = counter(delta, "bridge.terminal.op", "op=resize");
    notes.push(`terminal.op forwarded scroll=${scrollFwd}/${scrollIssued} resize=${resizeFwd}/${resizeIssued}`);
    if (scrollFwd > scrollIssued) {
      failures.push(`scroll ops forwarded ${scrollFwd} > ${scrollIssued} issued — amplification`);
    }
    if (resizeIssued > 0 && resizeFwd > resizeIssued) {
      failures.push(`resize ops forwarded ${resizeFwd} > ${resizeIssued} issued — amplification`);
    }
    const attaches = counter(delta, "bridge.terminal.attach");
    const detaches = counter(delta, "bridge.terminal.detach");
    const linkOpens = counter(delta, "terminal.link.open");
    const linkCloses = counter(delta, "terminal.link.close");
    const subs = issued["subscribe_terminal"] ?? 0;
    notes.push(
      `attach=${attaches} detach=${detaches} link.open=${linkOpens} link.close=${linkCloses} subscribes=${subs} unsubscribes=${issued["unsubscribe_terminal"] ?? 0}`,
    );
    // One attach attempt per new slot; re-subscribes of a live slot only
    // bump refs. More attaches than subscribes means duplicate attaches.
    if (subs > 0 && attaches > subs) {
      failures.push(`bridge.terminal.attach=${attaches} > ${subs} subscribes — duplicate attach attempts`);
    }
    if (subs > 0 && attaches === 0) {
      failures.push("subscribes issued but zero terminal attaches recorded");
    }
  }

  // Delivery volume is reported for every leg that produced terminal
  // bytes (issue #572): initial-attach vs post-scroll split is the
  // demand-driven signal — hidden/inactive panes must deliver ~nothing.
  const delivered = meterTotal(delta, "terminal.delivery.bytes");
  if (delivered > 0) {
    const initial = meterTotal(delta, "terminal.delivery.bytes", "phase=initial");
    const scrolled = meterTotal(delta, "terminal.delivery.bytes", "phase=scroll");
    const mib = (n: number) => (n / 1048576).toFixed(2);
    const secs = delta.seconds > 0 ? delta.seconds : 1;
    notes.push(
      `terminal delivery ${mib(delivered)}MiB (${(delivered / secs / 1048576).toFixed(2)}MiB/s): ` +
        `initial=${mib(initial)}MiB post-scroll=${mib(scrolled)}MiB`,
    );
  }

  if (leg === "reconnect") {
    const n = issued["reconnect"] ?? 0;
    const opens = counter(delta, "bridge.subscription.open");
    const snapFetches = timerCount(delta, "herdr.rpc", "method=session.snapshot");
    notes.push(`reconnects=${n} subscription.open=${opens} snapshot_fetches=${snapFetches}`);
    // One bridge session per WS connect: exactly one boot snapshot fetch
    // and one subscription open per reconnect; more is fan-out.
    if (n > 0 && opens > n) {
      failures.push(`subscription.open=${opens} > ${n} reconnects — duplicate sessions per connect`);
    }
    // session.snapshot fetches include legitimate event-scheduled refetches
    // (ambient herdr events debounce into pushSnapshot), so only a storm —
    // fetches far beyond reconnects + ambient churn — fails.
    if (n > 0 && snapFetches > n + 4) {
      failures.push(`session.snapshot fetches=${snapFetches} > ${n} reconnects (+4 ambient slack)`);
    }
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
  private url = "";
  private pending = new Map<string, Pending>();
  private nextId = 0;
  latencies: number[] = [];
  errors = 0;
  framesReceived = 0;
  frameCounts: Record<string, number> = {};

  async connect(url: string): Promise<void> {
    this.url = url;
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws connect failed"));
    });
    this.ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as { type?: string; id?: string; ok?: boolean; error?: { message?: string } };
      this.framesReceived += 1;
      const t = frame.type ?? "unknown";
      this.frameCounts[t] = (this.frameCounts[t] ?? 0) + 1;
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

  /** Fire-and-forget frame (subscribe_terminal and friends carry no id). */
  send(frame: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  /** Drop the WS and reconnect; the server builds a fresh session per connect. */
  async reconnect(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    await sleep(300); // let the server tear down the old session
    await this.connect(this.url);
    await sleep(400); // ready + initial snapshot settle
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

async function metrics(port: number): Promise<MetricsSnapshot | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
    if (!res.ok) return null;
    return (await res.json()) as MetricsSnapshot;
  } catch {
    return null;
  }
}

const EMPTY_SNAP: MetricsSnapshot = { ok: true, uptimeMs: 0, timestamp: "", counters: {}, timers: {}, gauges: {} };

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

interface LegRecord {
  delta: LegDelta | null;
  issued: Record<string, number>;
  verdict: LegVerdict;
  client_frames: Record<string, number>;
  plugin_exec_pids_observed: number;
}

interface LoadReport {
  format: "herdr-t3/bridge-load";
  version: 1;
  recorded_at: string;
  git_sha: string;
  host: ReturnType<typeof hostInfo>;
  condition: { loadavg_1m: number; loadavg_5m: number; loadavg_15m: number };
  leg_seconds: number;
  plugin_refresh_ms: number;
  server_metrics: boolean;
  plugins_discovered: string[];
  legs: Record<string, LegRecord>;
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

// Plugin CLI execs are `bun run src/cli.ts ...` children of the bridge;
// sampled via pgrep every 100 ms. Short execs can be missed — the count
// is a lower bound, calibrated against plugin.exec timers post-#446.
const spawnSeen = new Set<number>();
let spawnSampler: ReturnType<typeof setInterval> | null = null;

function startSpawnSampler(socketPath: string): void {
  spawnSampler = setInterval(() => {
    try {
      const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
      for (const line of out.split("\n")) {
        // plugin_call execs only, scoped to THIS bench's herdr socket —
        // ambient plugin CLIs (other sessions/repos) must not count.
        // Capability probes carry the same socket but are a separate,
        // TTL-cached exec kind and would inflate the fan-out signal.
        if (line.includes("src/cli.ts") && line.includes(socketPath) && !line.includes(" capability ")) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (pid > 0) spawnSeen.add(pid);
        }
      }
    } catch {
      /* ps failed */
    }
  }, 100);
}

function stopSpawnSampler(): void {
  if (spawnSampler) clearInterval(spawnSampler);
  spawnSampler = null;
}

async function runLeg(
  name: string,
  seconds: number,
  port: number,
  client: BridgeClient,
  drive: () => Promise<Record<string, number>>,
): Promise<LegRecord> {
  const before = await metrics(port);
  const framesBefore = { ...client.frameCounts };
  const pidsBefore = spawnSeen.size;
  const issued = await drive();
  const after = await metrics(port);
  const delta = before && after ? diffMetrics(before, after) : null;
  if (delta) delta.seconds = seconds;
  const verdict = evaluateLeg(name, delta ?? { seconds, counters: {}, timers: {} }, issued);
  const pidsObserved = spawnSeen.size - pidsBefore;
  const issuedCalls = issued["plugin_call"] ?? 0;
  if (issuedCalls > 0 && pidsObserved > issuedCalls) {
    // Informational only: ps sampling is a lower bound (~500 ms/call on a
    // loaded host) — server-side plugin.exec timers are the authority
    // when /api/metrics is available.
    verdict.notes.push(`plugin exec pids observed ${pidsObserved} vs ${issuedCalls} issued calls (lower bound)`);
  }
  const client_frames: Record<string, number> = {};
  for (const [k, v] of Object.entries(client.frameCounts)) {
    const d = v - (framesBefore[k] ?? 0);
    if (d > 0) client_frames[k] = d;
  }
  return {
    delta,
    issued,
    verdict,
    client_frames,
    plugin_exec_pids_observed: pidsObserved,
  };
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
      // Pre-#446 reports have no server metrics — fall back to the
      // client-observable signals (snapshot frames received, frames issued).
      const execRate = (l: LegRecord) =>
        l.delta
          ? Object.entries(l.delta.timers)
              .filter(([k]) => k.startsWith("plugin.exec{") && k.includes("what=plugin_call"))
              .reduce((n, [, t]) => n + t.count, 0) / l.delta.seconds
          : null;
      const pushRate = (l: LegRecord) =>
        l.delta
          ? (counter(l.delta, "bridge.snapshot.push") + counter(l.delta, "bridge.snapshot.push.unchanged")) / l.delta.seconds
          : null;
      const rpcAvg = (l: LegRecord) => {
        if (!l.delta) return null;
        const t = Object.entries(l.delta.timers).find(([k]) => k === "herdr.rpc" || k.startsWith("herdr.rpc{"));
        return t?.[1].avgMs ?? null;
      };
      const snapFrames = (l: LegRecord) => l.client_frames["snapshot"] ?? 0;
      const fmt = (n: number | null, d = 2) => (n === null ? "n/a" : n.toFixed(d));
      console.log(
        `[${leg}] plugin.exec/s ${fmt(execRate(la))} -> ${fmt(execRate(lb))}` +
        ` | snapshot.push/s ${fmt(pushRate(la))} -> ${fmt(pushRate(lb))}` +
        ` | snap_frames ${snapFrames(la)} -> ${snapFrames(lb)}` +
        ` | rpc_result ${la.client_frames["rpc_result"] ?? 0} -> ${lb.client_frames["rpc_result"] ?? 0}` +
        ` | plugin_call ${la.issued["plugin_call"] ?? 0} -> ${lb.issued["plugin_call"] ?? 0}` +
        ` | herdr.rpc avg ${rpcAvg(la) === null ? "n/a" : `${rpcAvg(la)!.toFixed(1)}ms`} -> ${rpcAvg(lb) === null ? "n/a" : `${rpcAvg(lb)!.toFixed(1)}ms`}`,
      );
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
        // Isolate the saved-machine registry: without this the bridge reads
        // the developer's real endpoints.json and every reconnect leg pays
        // SSH reachability probes (session.snapshot fetches) that look like
        // snapshot amplification to the reconnect verdict.
        XDG_STATE_HOME: work,
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
    let serverMetrics = true;
    startSpawnSampler(socket);

    // -- idle ----------------------------------------------------------------
    {
      const r = await runLeg("idle", legSeconds, BRIDGE_PORT, client, async () => {
        const end = Date.now() + legSeconds * 1000;
        while (Date.now() < end) await sleep(500);
        return {};
      });
      legs.idle = r;
      if (!r.delta) serverMetrics = false;
      console.log(`idle: pushes=${r.delta ? counter(r.delta, "bridge.snapshot.push") + counter(r.delta, "bridge.snapshot.push.unchanged") : "n/a"} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    // -- rpc-read --------------------------------------------------------------
    {
      const counts: Record<string, number> = { rpc: 0, rpc_read: 0 };
      const r = await runLeg("rpc-read", legSeconds, BRIDGE_PORT, client, async () => {
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
      if (!r.delta) serverMetrics = false;
      console.log(`rpc-read: rpc=${counts.rpc} schedule(cause=rpc)=${r.delta ? counter(r.delta, "bridge.snapshot.schedule", "cause=rpc") : "n/a"} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
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
          delta: null,
          issued: counts,
          verdict: { leg: "plugin-read", ok: true, failures: [], notes: ["skipped: none of the known surface plugins installed"] },
          client_frames: {},
          plugin_exec_pids_observed: 0,
        };
        console.log("plugin-read: skipped (no known plugins installed)");
      } else {
        const r = await runLeg("plugin-read", legSeconds, BRIDGE_PORT, client, async () => {
          const end = Date.now() + legSeconds * 1000;
          // mirror the stores: every ~800 ms each surface refreshes → one
          // plugin_call per surface per tick, all concurrent.
          while (Date.now() < end) {
            counts.plugin_call += reads.length;
            await Promise.all(
              reads.map((c) => client.pluginCall(c.plugin, c.command).catch(() => {})),
            );
            await sleep(PLUGIN_REFRESH_MS);
          }
          return counts;
        });
        legs["plugin-read"] = r;
        if (!r.delta) serverMetrics = false;
        console.log(`plugin-read: calls=${counts.plugin_call} execs=${r.delta ? timerCount(r.delta, "plugin.exec", "what=plugin_call") : "n/a"} pids=${r.plugin_exec_pids_observed} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
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
      const r = await runLeg("activity", legSeconds, BRIDGE_PORT, client, async () => {
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
            await sleep(PLUGIN_REFRESH_MS);
          }
        })();
        await Promise.all([churn, poll]);
        return counts;
      });
      legs.activity = r;
      if (!r.delta) serverMetrics = false;
      console.log(`activity: pushes=${r.delta ? counter(r.delta, "bridge.snapshot.push") : "n/a"} unchanged=${r.delta ? counter(r.delta, "bridge.snapshot.push.unchanged") : "n/a"} schedule=${r.delta ? counter(r.delta, "bridge.snapshot.schedule") : "n/a"} pids=${r.plugin_exec_pids_observed} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    // -- attach legs (attach-churn + terminal-io) ------------------------------
    // Shared fixture: the fixture workspace split up to 4 panes so attach
    // batches have distinct targets (a single pane cannot show per-pane
    // amplification). Both legs subscribe/unsubscribe the same targets.
    const snapshotPanes = async (): Promise<{ pane_id: string; workspace_id?: string }[]> => {
      const res = (await client.rpc("session.snapshot").catch(() => null)) as
        | { result?: { snapshot?: { panes?: { pane_id: string; workspace_id?: string }[] } } }
        | null;
      return res?.result?.snapshot?.panes ?? [];
    };
    let attachTargets: string[] = [];
    {
      let panes = (await snapshotPanes()).filter((p) => p.workspace_id === fixtureWs);
      for (let i = 0; i < 6 && panes.length < 4; i++) {
        await client
          .rpc("pane.split", {
            direction: "right",
            target_pane_id: panes[0]?.pane_id,
            focus: false,
          })
          .catch(() => {});
        await sleep(300);
        panes = (await snapshotPanes()).filter((p) => p.workspace_id === fixtureWs);
      }
      attachTargets = panes.slice(0, 4).map((p) => p.pane_id);
      await sleep(600); // let split-driven snapshot pushes settle
    }
    const targets = attachTargets;
    if (targets.length < 2) {
      for (const leg of ["attach-churn", "terminal-io"]) {
        legs[leg] = {
          delta: null,
          issued: {},
          verdict: {
            leg,
            ok: true,
            failures: [],
            notes: [`skipped: only ${targets.length} pane(s) in fixture workspace; need >=2`],
          },
          client_frames: {},
          plugin_exec_pids_observed: 0,
        };
      }
      console.log(`attach legs: skipped (${targets.length} pane(s))`);
    } else {
      // -- attach-churn -------------------------------------------------------
      // Workspace-switch attach pattern (issue #527): K visible panes each
      // send subscribe_terminal in one burst; the bridge must coalesce the
      // resulting scroll-subscription reopens, not reopen per pane.
      {
        const counts: Record<string, number> = {
          subscribe_terminal: 0,
          unsubscribe_terminal: 0,
          attach_batch: targets.length,
        };
        const r = await runLeg("attach-churn", legSeconds, BRIDGE_PORT, client, async () => {
          const end = Date.now() + legSeconds * 1000;
          while (Date.now() < end) {
            for (const paneId of targets) {
              client.send({ type: "subscribe_terminal", machine: "local", paneId, cols: 80, rows: 24 });
              counts.subscribe_terminal += 1;
            }
            await sleep(400);
            for (const paneId of targets) {
              client.send({ type: "unsubscribe_terminal", machine: "local", paneId });
              counts.unsubscribe_terminal += 1;
            }
            await sleep(400);
          }
          return counts;
        });
        legs["attach-churn"] = r;
        if (!r.delta) serverMetrics = false;
        console.log(`attach-churn: batch=${targets.length} subscribes=${counts.subscribe_terminal} subscription.open=${r.delta ? counter(r.delta, "bridge.subscription.open") : "n/a"} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
      }

      // -- terminal-io ----------------------------------------------------------
      // Demand-driven delivery leg (issue #572): one attach batch, then a
      // live output storm on the first pane plus scroll/resize probes on all
      // subscribed panes. Measures initial-attach vs post-scroll delivery
      // bytes, attach/detach counts and forwarded op counts per leg second.
      {
        // Bounded in-pane output: ~3.8 KiB lines until legSeconds+2 elapse.
        // (Padding via base64 — `tr '\0'` is not portable across tr impls.)
        const ioRunner = join(work, "io-runner.sh");
        writeFileSync(
          ioRunner,
          `line="perf-io $(head -c 3000 /dev/urandom | base64 | tr -d '\\n' | head -c 3800)"\n` +
            `end=$((SECONDS+${legSeconds + 2})); i=0\n` +
            `while [ $SECONDS -lt $end ]; do echo "$line$i"; i=$((i+1)); done\n`,
        );
        herdrCli(sessionName, ["pane", "run", targets[0]!, `bash ${ioRunner}`]);
        const counts: Record<string, number> = {
          subscribe_terminal: 0,
          unsubscribe_terminal: 0,
          terminal_scroll: 0,
          terminal_resize: 0,
          attach_batch: targets.length,
        };
        const r = await runLeg("terminal-io", legSeconds, BRIDGE_PORT, client, async () => {
          const end = Date.now() + legSeconds * 1000;
          for (const paneId of targets) {
            client.send({ type: "subscribe_terminal", machine: "local", paneId, cols: 80, rows: 24 });
            counts.subscribe_terminal += 1;
          }
          await sleep(500); // let the attach batch resolve before probing
          let tick = 0;
          while (Date.now() < end) {
            for (const paneId of targets) {
              // Alternate scroll direction: up pages into history, down
              // returns toward the live screen — both are AttachScroll.
              client.send({
                type: "terminal_scroll",
                machine: "local",
                paneId,
                direction: tick % 2 === 0 ? "up" : "down",
                lines: 5,
              });
              counts.terminal_scroll += 1;
            }
            client.send({
              type: "terminal_resize",
              machine: "local",
              paneId: targets[tick % targets.length]!,
              cols: 80 + (tick % 4) * 10,
              rows: 24,
            });
            counts.terminal_resize += 1;
            tick += 1;
            await sleep(500);
          }
          for (const paneId of targets) {
            client.send({ type: "unsubscribe_terminal", machine: "local", paneId });
            counts.unsubscribe_terminal += 1;
          }
          return counts;
        });
        legs["terminal-io"] = r;
        if (!r.delta) serverMetrics = false;
        console.log(
          `terminal-io: batch=${targets.length} delivery=${(r.delta ? r.verdict.notes.find((n) => n.startsWith("terminal delivery")) : undefined) ?? "n/a"} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`,
        );
        // Let the io-runner exit and its pane.exited/pane.updated events
        // flush before the reconnect leg's metrics window, or ambient
        // churn counts as reconnect snapshot fetches.
        await sleep(3000);
      }
    }

    // -- reconnect --------------------------------------------------------------
    {
      // Each WS connect builds a fresh MachineManager + bridge session:
      // the cost must be exactly one boot snapshot fetch + one subscription
      // open per reconnect — more is session/subscription fan-out (#527).
      const counts: Record<string, number> = { reconnect: 0 };
      const r = await runLeg("reconnect", legSeconds, BRIDGE_PORT, client, async () => {
        // reconnect() costs ~0.7-1 s; cap cycles so the leg stays bounded.
        const cycles = Math.max(1, Math.floor(legSeconds / 2));
        for (let i = 0; i < cycles; i++) {
          await client.reconnect();
          counts.reconnect += 1;
        }
        return counts;
      });
      legs.reconnect = r;
      if (!r.delta) serverMetrics = false;
      console.log(`reconnect: n=${counts.reconnect} subscription.open=${r.delta ? counter(r.delta, "bridge.subscription.open") : "n/a"} snapshot_fetches=${r.delta ? timerCount(r.delta, "herdr.rpc", "method=session.snapshot") : "n/a"} verdict=${r.verdict.ok ? "ok" : r.verdict.failures.join("; ")}`);
    }

    client.close();
    stopSpawnSampler();

    const lat = [...client.latencies].sort((a, b) => a - b);
    const report: LoadReport = {
      format: "herdr-t3/bridge-load",
      version: 1,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: hostInfo(),
      condition: { loadavg_1m: loadavg()[0], loadavg_5m: loadavg()[1], loadavg_15m: loadavg()[2] },
      leg_seconds: legSeconds,
      plugin_refresh_ms: PLUGIN_REFRESH_MS,
      server_metrics: serverMetrics,
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
