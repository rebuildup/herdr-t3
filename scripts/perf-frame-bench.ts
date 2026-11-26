/*
 * Real frame-time benchmark for issue #354 follow-up: measures what
 * scripts/perf-scene-bench.ts cannot reach — the DOM-bound half of the
 * frame (Canvas2D rasterization inside the real renderer's rAF callback,
 * plus compositor/vsync pacing) in the running app.
 *
 * Method: isolated herdr session -> dev bridge -> vite -> headless
 * Chrome over CDP. The pane runs the same seed-42 ANSI output storm as
 * perf-scene-bench/perf-terminal-bench (chunk files generated here,
 * streamed by a tiny in-pane looper), while CDP `Input.dispatchMouseEvent`
 * wheel bursts traverse scrollback. Frame timing is captured inside the
 * page by an injected PerformanceObserver("longtask") + rAF timestamp
 * recorder + a CanvasRenderingContext2D fillText/drawImage timer, and
 * cross-checked with CDP Performance.getMetrics (TaskDuration /
 * ScriptDuration deltas over the same window).
 *
 * Isolation (issue #356): the harness refuses to run unless the target
 * is explicitly isolated — pass --session/--socket (default session
 * `ht3frame`) or set HERDR_VERIFY_SESSION/HERDR_SOCKET. The dev bridge
 * it spawns gets HERDR_SOCKET pointed at the same isolated socket, and
 * assertBridgeTargetIsolated re-checks /api/health so env mismatches
 * cannot silently measure the live session. All spawned processes
 * (herdr server if started here, bridge, vite, chrome) are killed on
 * exit; the fixture workspace is closed.
 *
 * Usage:
 *   bun scripts/perf-frame-bench.ts [--session ht3frame] [--seconds 8]
 *     [--base-url http://localhost:5742] [--out perf-reports/frame-<sha>.json]
 *
 * Prerequisites: herdr CLI, bun, Chrome at $CHROME or the default macOS
 * path. Ports default to bridge 4742 / vite 5742 / CDP 9334 — override
 * with --bridge-port/--vite-port/--cdp-port if taken.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem, platform, arch, hostname, tmpdir } from "node:os";
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
  "--session",
  "--socket",
  "--base-url",
  "--seconds",
  "--warmup-seconds",
  "--idle-seconds",
  "--out",
  "--bridge-port",
  "--vite-port",
  "--cdp-port",
  "--chrome",
]);
const args = new Map<string, string>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (VALUE_FLAGS.has(a)) {
    args.set(a, process.argv[++i] ?? "");
  } else if (a.startsWith("--")) {
    args.set(a, "true");
  } else {
    positional.push(a);
  }
}
const flag = (name: string, dflt: string) => args.get(name) ?? dflt;

const SESSION = flag("--session", "ht3frame");
const BASE_URL = flag("--base-url", "http://localhost:5742");
const BRIDGE_PORT = Number(flag("--bridge-port", "4742"));
const VITE_PORT = Number(flag("--vite-port", "5742"));
const CDP_PORT = Number(flag("--cdp-port", "9334"));
const MEASURE_SECONDS = Number(flag("--seconds", "8"));
const WARMUP_SECONDS = Number(flag("--warmup-seconds", "2"));
const IDLE_SECONDS = Number(flag("--idle-seconds", "1.5"));
const CHROME =
  flag("--chrome", process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const OUT =
  positional[0] ??
  flag("--out", join(REPO_ROOT, "perf-reports", `frame-${gitSha().slice(0, 8)}.json`));

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- seed-42 storm generator (same shape as perf-scene-bench) ----------
const COLS = 120;
const enc = new TextEncoder();
const words = [
  "src/components/PaneTerminal.tsx", "server/bridge-core.ts", "shared/protocol.ts",
  "compiled", "passed", "failed", "warning", "error", "12ms", "1.2s", "ok",
  "herdr-t3", "workspace", "snapshot", "attach", "scrollback", "render",
];
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makeChunk(): Uint8Array {
  const parts: string[] = [];
  const lines = 30 + Math.floor(rand() * 40);
  for (let i = 0; i < lines; i++) {
    const r = rand();
    if (r < 0.15) {
      parts.push(`\x1b[1;32m✓\x1b[0m ${words[(rand() * words.length) | 0]} done in ${(rand() * 900 + 10) | 0}ms\n`);
    } else if (r < 0.3) {
      parts.push(`\x1b[33m⚠ warning\x1b[0m: unused import in ${words[(rand() * words.length) | 0]}\n`);
    } else if (r < 0.4) {
      parts.push(`\x1b[31m✗ test failed\x1b[0m ${words[(rand() * words.length) | 0]} assertion at line ${(rand() * 500) | 0}\n`);
    } else if (r < 0.5) {
      parts.push(`\x1b[36m→\x1b[0m agent: thinking about ${words[(rand() * words.length) | 0]} …\n`);
    } else if (r < 0.6) {
      parts.push(`  ${words[(rand() * words.length) | 0]} = ${((rand() * 1000) | 0) / 10}\n`);
    } else {
      let line = "";
      while (line.length < COLS - 10) line += `${words[(rand() * words.length) | 0]} `;
      parts.push(line.slice(0, COLS - 1) + "\n");
    }
  }
  parts.push("日本語のテキストと絵文字 👨‍💻🚀 テスト出力\n");
  parts.push("progress: " + "█".repeat(40) + "░".repeat(20) + " 62%\n");
  return enc.encode(parts.join(""));
}

const STORM_LOOP = `// in-pane storm looper: streams chunk files round-robin for \`ms\` ms.
import { readdirSync } from "node:fs";
const dir = process.argv[2];
const ms = Number(process.argv[3] ?? "8000");
const gap = Number(process.argv[4] ?? "8");
const files = readdirSync(dir).filter((f) => f.endsWith(".bin")).sort();
const deadline = Date.now() + ms;
let i = 0;
while (Date.now() < deadline) {
  const b = await Bun.file(dir + "/" + files[i++ % files.length]).arrayBuffer();
  process.stdout.write(Buffer.from(b));
  await Bun.sleep(gap);
}
`;

// ---------- stats (pure, unit-tested) ----------
export interface IntervalStats {
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  pct_over_16_7: number;
  pct_over_33_4: number;
  pct_over_50: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of empty sample");
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** rAF timestamps -> frame intervals (ms), gaps > 1s dropped as non-frames. */
export function frameIntervals(timestamps: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const d = timestamps[i]! - timestamps[i - 1]!;
    if (d > 0 && d < 1000) out.push(d);
  }
  return out;
}

export function intervalStats(intervals: number[]): IntervalStats | null {
  if (intervals.length === 0) return null;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const over = (t: number) => (sorted.filter((v) => v > t).length / sorted.length) * 100;
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    pct_over_16_7: over(16.7),
    pct_over_33_4: over(33.4),
    pct_over_50: over(50),
  };
}

interface WindowMetrics {
  seconds: number;
  /** page navigated/reloaded inside the window — counters reset, stats unreliable */
  navigated: boolean;
  frames: IntervalStats | null;
  longtask_count: number;
  longtask_total_ms: number;
  longtask_max_ms: number;
  canvas_api_ms: number;
  canvas_calls: number;
  task_duration_ms: number;
  script_duration_ms: number;
  task_utilization_pct: number;
}

// ---------- CDP plumbing (same shape as capture-evidence.ts) ----------
let seq = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
let ws: WebSocket;

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

async function evaluate(expression: string): Promise<unknown> {
  const res = (await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (res.exceptionDetails) {
    throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

const RECORDER = `(() => {
  const w = window.__fb = { frames: [], longtasks: [], canvas: { fillText: 0, drawImage: 0, calls: 0 }, t0: performance.now(), origin: performance.timeOrigin };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.longtasks.push({ s: e.startTime, d: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) { w.longtaskErr = String(e); }
  const pt = CanvasRenderingContext2D.prototype;
  for (const name of ["fillText", "drawImage"]) {
    const orig = pt[name];
    pt[name] = function (...a) {
      const t = performance.now();
      try { return orig.apply(this, a); } finally {
        w.canvas[name] += performance.now() - t;
        w.canvas.calls++;
      }
    };
  }
  const tick = (t) => { w.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return "ok";
})()`;

interface FbState {
  frames: number[];
  longtasks: { s: number; d: number }[];
  canvas: { fillText: number; drawImage: number; calls: number };
  origin?: number;
  longtaskErr?: string;
}

async function ensureRecorder(): Promise<void> {
  const ok = await evaluate(`window.__fb ? "ok" : (${RECORDER})`);
  if (ok !== "ok") throw new Error("frame recorder injection failed");
}

async function readFb(): Promise<FbState> {
  const raw = await evaluate(`window.__fb ? JSON.stringify(window.__fb) : null`);
  if (raw === null || raw === undefined) {
    // page navigated/reloaded after injection — reinstall and retry once
    await ensureRecorder();
    const again = await evaluate(`JSON.stringify(window.__fb)`);
    return JSON.parse(again as string) as FbState;
  }
  return JSON.parse(raw as string) as FbState;
}

async function cdpMetrics(): Promise<Record<string, number>> {
  const res = (await send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  const out: Record<string, number> = {};
  for (const m of res.metrics) out[m.name] = m.value;
  return out;
}

async function measureWindow(
  seconds: number,
  during?: () => Promise<void>,
): Promise<WindowMetrics> {
  const tStart = (await evaluate("performance.now()")) as number;
  const m0 = await cdpMetrics();
  const origin0 = (await evaluate(`window.__fb ? window.__fb.origin : null`)) as number | null;
  const c0 = (await evaluate(
    `({ f: window.__fb.canvas.fillText, d: window.__fb.canvas.drawImage, c: window.__fb.canvas.calls })`,
  )) as { f: number; d: number; c: number };

  if (during) await during();
  else await sleep(seconds * 1000);
  await sleep(400); // let the last rAF/longtask land inside the window
  const tEnd = (await evaluate("performance.now()")) as number;
  const m1 = await cdpMetrics();
  const fb1 = await readFb();
  const origin1 = fb1.origin ?? null;
  const navigated = origin0 !== null && origin1 !== null && origin0 !== origin1;
  const c1 = (await evaluate(
    `({ f: window.__fb.canvas.fillText, d: window.__fb.canvas.drawImage, c: window.__fb.canvas.calls })`,
  )) as { f: number; d: number; c: number };

  // frame intervals whose END timestamp lands inside the window; the
  // predecessor frame may start before tStart (straddling interval is real)
  const intervalsList: number[] = [];
  for (let i = 1; i < fb1.frames.length; i++) {
    const end = fb1.frames[i]!;
    if (end > tEnd) break;
    const d = end - fb1.frames[i - 1]!;
    if (end >= tStart && d > 0 && d < 1000) intervalsList.push(d);
  }
  const intervals = intervalStats(intervalsList);

  const longtasks = fb1.longtasks.filter(
    (e) => e.s < tEnd && e.s + e.d > tStart,
  );
  const span = (tEnd - tStart) / 1000;
  // counters reset on navigation — clamp rather than report negative ms
  const taskMs = Math.max(0, ((m1["TaskDuration"] ?? 0) - (m0["TaskDuration"] ?? 0)) * 1000);
  return {
    seconds: span,
    navigated,
    frames: intervals,
    longtask_count: longtasks.length,
    longtask_total_ms: longtasks.reduce((a, e) => a + e.d, 0),
    longtask_max_ms: longtasks.reduce((a, e) => Math.max(a, e.d), 0),
    canvas_api_ms: Math.max(0, c1.f + c1.d - c0.f - c0.d),
    canvas_calls: Math.max(0, c1.c - c0.c),
    task_duration_ms: taskMs,
    script_duration_ms: Math.max(0, ((m1["ScriptDuration"] ?? 0) - (m0["ScriptDuration"] ?? 0)) * 1000),
    task_utilization_pct: span > 0 ? (taskMs / (span * 1000)) * 100 : 0,
  };
}

// ---------- process helpers ----------
interface Proc { kill: () => void }
/** Spawn with output teed to log files (stdout -> log, stderr -> log.err). */
function spawnLogged(cmd: string[], env: Record<string, string>, log: string): Proc {
  const p = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  void Bun.write(log, p.stdout as ReadableStream);
  void Bun.write(`${log}.err`, p.stderr as ReadableStream);
  return { kill: () => p.kill() };
}

async function waitHttp(url: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

function herdrCli(session: string, args: string[]): string {
  return execFileSync("herdr", ["--session", session, ...args], { encoding: "utf8" });
}

// ---------- main ----------
async function main(): Promise<number> {
  const procs: Proc[] = [];
  const tmpDirs: string[] = [];
  let herdrStarted = false;
  let succeeded = false;
  // hoisted for the finally block (try-scoped consts are invisible there)
  let sessionName = SESSION;
  let workDir = "";
  try {
    // --- resolve + enforce isolation BEFORE touching anything ----------
    // Append the default --session unless the caller already gave a target
    // (flagValue takes the first occurrence, so an explicit user flag wins).
    const hasTarget =
      args.has("--session") || args.has("--socket") ||
      !!process.env.HERDR_VERIFY_SESSION || !!process.env.HERDR_SESSION ||
      !!process.env.HERDR_SOCKET;
    const guardArgv = hasTarget
      ? process.argv.slice(2)
      : [...process.argv.slice(2), "--session", SESSION];
    const target = resolveVerifyTarget({ argv: guardArgv });
    const socket =
      target.socketPath ??
      sessionSocketPath(target.session ?? SESSION);
    // herdr CLI calls need a session name; for socket-only targets recover
    // it from the standard .../sessions/<name>/herdr.sock layout.
    sessionName =
      target.session ??
      /sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(socket)?.[1] ??
      SESSION;

    // --- isolated herdr session -----------------------------------------
    const sockAlive = existsSync(socket);
    if (!sockAlive) {
      if (target.socketPath) {
        throw new VerifyIsolationError(`socket ${socket} does not exist`);
      }
      console.log(`starting isolated herdr session ${sessionName} (${socket})`);
      const log = join(tmpdir(), `ht3frame-herdr-${process.pid}.log`);
      tmpDirs.push(log, `${log}.err`);
      const p = Bun.spawn(["herdr", "--session", sessionName, "server"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      void Bun.write(log, p.stdout as ReadableStream);
      void Bun.write(`${log}.err`, p.stderr as ReadableStream);
      procs.push({ kill: () => p.kill() });
      herdrStarted = true;
      for (let i = 0; i < 60; i++) {
        if (existsSync(socket)) break;
        await sleep(500);
      }
      if (!(existsSync(socket))) {
        throw new Error(`herdr session socket never appeared: ${socket} (log ${log})`);
      }
    }

    // --- fixture workspace + pane ----------------------------------------
    // the socket file can appear before the server answers — retry briefly
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
      herdrCli(sessionName, ["workspace", "create", "--label", "perf-frame", "--no-focus"]),
    ).result as { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
    const paneId = created.root_pane.pane_id;
    console.log(`fixture workspace ${created.workspace.workspace_id} pane ${paneId}`);
    await sleep(800); // let the pane shell come up

    // scrollback preload so wheel traversal has history immediately
    // kept modest — attach-time scrollback decode competes with the
    // measurement window on a loaded host.
    herdrCli(sessionName, ["pane", "run", paneId, "seq 1 400 | sed 's/^/hist-/'"]);
    await sleep(1500);

    // --- storm payload -----------------------------------------------------
    workDir = mkdtempSync(join(tmpdir(), "ht3frame-"));
    const work = workDir;
    tmpDirs.push(work);
    for (let i = 0; i < 24; i++) {
      writeFileSync(join(work, `chunk-${String(i).padStart(2, "0")}.bin`), makeChunk());
    }
    writeFileSync(join(work, "storm.ts"), STORM_LOOP);

    // --- bridge + vite ------------------------------------------------------
    const bridgeLog = join(work, "bridge.log");
    const viteLog = join(work, "vite.log");
    const allowedOrigins = `${new URL(BASE_URL).origin},http://localhost:${VITE_PORT},http://127.0.0.1:${VITE_PORT}`;
    procs.push(spawnLogged(
      ["bun", "run", "server/index.ts"],
      {
        PORT: String(BRIDGE_PORT),
        HERDR_T3_PORT: String(BRIDGE_PORT),
        HOST: "127.0.0.1",
        HERDR_SOCKET: socket,
        HERDR_T3_ALLOWED_ORIGINS: allowedOrigins,
      },
      bridgeLog,
    ));
    await waitHttp(`http://127.0.0.1:${BRIDGE_PORT}/api/health`);

    procs.push(spawnLogged(
      ["bun", "--bun", "vite", "--port", String(VITE_PORT), "--strictPort"],
      { HERDR_T3_PORT: String(BRIDGE_PORT) },
      viteLog,
    ));
    await waitHttp(`${BASE_URL}/`);

    // --- verify the bridge is bound to the isolated socket, not live ------
    try {
      await assertBridgeTargetIsolated(BASE_URL, { argv: guardArgv });
    } catch (error) {
      if (error instanceof VerifyIsolationError) throw error;
      throw error;
    }

    // --- headless chrome ----------------------------------------------------
    const chrome = Bun.spawn(
      [
        CHROME,
        "--headless=new",
        `--remote-debugging-port=${CDP_PORT}`,
        "--no-first-run",
        "--user-data-dir=" + join(work, "cdp-profile"),
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    procs.push({ kill: () => chrome.kill() });
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const targets = (await res.json()) as { type: string }[];
        if (targets.some((t) => t.type === "page")) break;
      } catch {}
      await sleep(250);
    }
    const targets = (await (
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    ).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no CDP page target (chrome failed to start)");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!;
        pending.delete(m.id);
        if (m.error) p.reject(new Error(`CDP ${m.error.code}: ${m.error.message}`));
        else p.resolve(m.result);
      }
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Performance.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    });
    await send("Page.navigate", { url: BASE_URL });

    // wait for the terminal surface (attach + first paint)
    let surf: { cx: number; cy: number } | null = null;
    for (let i = 0; i < 60; i++) {
      surf = (await evaluate(`(() => {
        const el = document.querySelector(".ghostty-surface");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      })()`)) as { cx: number; cy: number } | null;
      if (surf) break;
      await sleep(500);
    }
    if (!surf) throw new Error("no .ghostty-surface after navigate (app did not attach?)");
    // let attach scrollback decode + first paints settle before idling
    await sleep(4000);

    await ensureRecorder();
    const wheel = (deltaY: number) =>
      send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: surf!.cx, y: surf!.cy, deltaX: 0, deltaY,
      });

    // --- idle window ---------------------------------------------------------
    const idle = await measureWindow(IDLE_SECONDS);

    // --- storm + scroll traversal --------------------------------------------
    // One attempt = storm (warmup + measure + 1s slack, self-terminating)
    // with CDP wheel bursts inside the measured window only. Retried once
    // if the page navigates mid-window (vite HMR full-reload under load
    // resets every counter).
    const stormMs = (WARMUP_SECONDS + MEASURE_SECONDS + 1) * 1000;
    const runStormAttempt = async (): Promise<WindowMetrics> => {
      herdrCli(sessionName, [
        "pane", "run", paneId,
        // process.execPath is the bun binary running this bench — the pane
        // shell may not have bun on PATH.
        `${process.execPath} ${join(work, "storm.ts")} ${work} ${stormMs} 8`,
      ]);
      await sleep(WARMUP_SECONDS * 1000); // warmup storm, outside the window
      const scrollLoop = (async () => {
        const end = Date.now() + (MEASURE_SECONDS + 0.5) * 1000;
        let up = true;
        while (Date.now() < end) {
          // ~100 lines per event (deltaY/40); burst up through history, then back
          for (let i = 0; i < 8; i++) await wheel(up ? -4000 : 4000);
          up = !up;
          await sleep(350);
        }
      })();
      const result = await measureWindow(MEASURE_SECONDS, () => scrollLoop);
      await sleep(500); // drain: storm self-terminated; let the attach stream land
      return result;
    };
    let storm = await runStormAttempt();
    let stormAttempts = 1;
    if (storm.navigated) {
      console.log("storm window navigated mid-run; retrying once");
      storm = await runStormAttempt();
      stormAttempts = 2;
    }

    const [l1, l5, l15] = loadavg();
    const cpu = cpus()[0];
    const report = {
      format: "herdr-t3/perf-frame",
      version: 1,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: {
        platform: platform(), arch: arch(), hostname: hostname(),
        cpu_model: cpu?.model ?? "unknown", cpu_count: cpus().length,
        mem_total_bytes: totalmem(),
      },
      bun_version: Bun.version,
      condition: { loadavg_1m: l1, loadavg_5m: l5, loadavg_15m: l15 },
      app: {
        base_url: BASE_URL,
        bridge_port: BRIDGE_PORT,
        vite_port: VITE_PORT,
        cdp_port: CDP_PORT,
        session: target.session ?? sessionName,
        socket,
        pane_id: paneId,
        headless_chrome: true,
        viewport: "1440x900@2x",
      },
      workload: {
        storm: "seed-42 ANSI chunks (same generator as perf-scene-bench), 24 files round-robin every 8ms via in-pane bun looper",
        measure_seconds: MEASURE_SECONDS,
        warmup_seconds: WARMUP_SECONDS,
        scroll: "CDP mouseWheel bursts: 8x|deltaY|=4000 (~100 lines) alternating up/down every ~350ms",
        preload_scrollback_lines: 400,
        storm_attempts: stormAttempts,
      },
      idle,
      storm,
      notes: [
        "frames = rAF timestamp intervals inside the measured window; >16.7/33.4/50ms percentages are frame-budget misses",
        "canvas_api_ms = wall time inside CanvasRenderingContext2D fillText/drawImage calls (raster submission, not compositor present)",
        "task_duration_ms = CDP Performance TaskDuration delta (all renderer main-thread task time in window)",
        "longtask = PerformanceObserver longtask entries (>50ms) overlapping the window",
      ],
    };
    mkdirSync(join(OUT, ".."), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

    const f = storm.frames;
    console.log(`wrote ${OUT}`);
    console.log(
      `storm frames=${f?.count ?? 0} p50=${f?.p50.toFixed(1) ?? "-"}ms p95=${f?.p95.toFixed(1) ?? "-"}ms ` +
        `>16.7ms=${f?.pct_over_16_7.toFixed(1) ?? "-"}% >33.4ms=${f?.pct_over_33_4.toFixed(1) ?? "-"}% ` +
        `longtasks=${storm.longtask_count} canvas_api=${storm.canvas_api_ms.toFixed(0)}ms/${storm.canvas_calls}calls ` +
        `task=${storm.task_duration_ms.toFixed(0)}ms util=${storm.task_utilization_pct.toFixed(0)}%` +
        `${storm.navigated ? " NAVIGATED" : ""}${idle.navigated ? " (idle navigated)" : ""}`,
    );
    console.log(
      `idle  frames=${idle.frames?.count ?? 0} p50=${idle.frames?.p50.toFixed(1) ?? "-"}ms ` +
        `p95=${idle.frames?.p95.toFixed(1) ?? "-"}ms longtasks=${idle.longtask_count}`,
    );
    console.log(
      `condition loadavg=${l1.toFixed(2)}/${l5.toFixed(2)}/${l15.toFixed(2)} sha=${gitSha().slice(0, 8)}`,
    );
    succeeded = true;
    return 0;
  } finally {
    // close the fixture workspace FIRST — it needs the herdr server,
    // which is itself one of the procs killed below
    try {
      const list = JSON.parse(herdrCli(sessionName, ["workspace", "list"])).result
        .workspaces as { workspace_id: string; label?: string }[];
      for (const w of list) {
        if (w.label === "perf-frame") herdrCli(sessionName, ["workspace", "close", w.workspace_id]);
      }
    } catch {}
    for (const p of procs) {
      try { p.kill(); } catch {}
    }
    await sleep(300);
    // keep bridge/vite logs for postmortem when the run failed
    if (!succeeded && workDir) {
      try {
        const { copyFileSync, readdirSync } = await import("node:fs");
        const dest = join(REPO_ROOT, "perf-reports", `frame-debug-${Date.now()}`);
        mkdirSync(dest, { recursive: true });
        for (const f of readdirSync(workDir)) {
          if (f.endsWith(".log") || f.endsWith(".err")) {
            copyFileSync(join(workDir, f), join(dest, f));
          }
        }
        console.error(`debug logs kept in ${dest}`);
      } catch {}
    }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    if (herdrStarted) {
      try { execFileSync("herdr", ["--session", sessionName, "server", "stop"], { stdio: "ignore" }); } catch {}
    }
  }
}

if (import.meta.main) process.exit(await main());
