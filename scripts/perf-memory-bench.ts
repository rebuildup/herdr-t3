/*
 * Memory regression bench for issue #499: drives the real app (vite +
 * bridge + headless Chrome over CDP) against an isolated herdr session and
 * measures memory growth under controlled workloads.
 *
 * Isolation: same contract as perf-frame-bench — refuses the default
 * session; pass --session/--socket or HERDR_VERIFY_SESSION/HERDR_SOCKET.
 *
 * Usage:
 *   bun scripts/perf-memory-bench.ts [--session ht3mem] [--out perf-reports/mem-<sha>.json]
 *     [--storm-mb 256] [--storm-seconds 30] [--scenario all|storm|kitty|switch|idle]
 *     [--check] [--max-jsheap-mb 256] [--max-chrome-mb 2048] [--max-bridge-mb 512] [--max-herdr-mb 512]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { cpus, loadavg, totalmem, platform, arch, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBridgeTargetIsolated,
  resolveVerifyTarget,
  sessionSocketPath,
  VerifyIsolationError,
} from "./verify-guard";

const REPO_ROOT = join(import.meta.dir, "..");

const VALUE_FLAGS = new Set([
  "--session", "--socket", "--base-url", "--out",
  "--bridge-port", "--vite-port", "--cdp-port", "--chrome",
  "--storm-mb", "--storm-seconds", "--scenario", "--sample-ms", "--cpu-throttle", "--kitty-size",
  "--max-jsheap-mb", "--max-chrome-mb", "--max-bridge-mb", "--max-herdr-mb",
]);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (VALUE_FLAGS.has(a)) args.set(a, process.argv[++i] ?? "");
  else if (a.startsWith("--")) args.set(a, "true");
}
const flag = (n: string, d: string) => args.get(n) ?? d;

const SESSION = flag("--session", "ht3mem");
const SCENARIO = flag("--scenario", "all");
const BASE_URL = flag("--base-url", "http://localhost:5743");
const BRIDGE_PORT = Number(flag("--bridge-port", "4743"));
const VITE_PORT = Number(flag("--vite-port", "5743"));
const CDP_PORT = Number(flag("--cdp-port", "9335"));
const STORM_MB = Number(flag("--storm-mb", "256"));
const STORM_SECONDS = Number(flag("--storm-seconds", "30"));
const SAMPLE_MS = Number(flag("--sample-ms", "2000"));
const CPU_THROTTLE = Number(flag("--cpu-throttle", "1"));
const KITTY_SIZE = Number(flag("--kitty-size", "200"));
const CHROME = flag("--chrome", process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const OUT = flag("--out", join(REPO_ROOT, "perf-reports", `mem-${gitSha().slice(0, 8)}.json`));
const CHECK = flag("--check", "false") === "true";

/**
 * Absolute memory budgets enforced by --check (issue #499). These are
 * ceilings, not regression thresholds: the incident was an unbounded leak
 * reaching 28 GiB, so any scenario whose peak crosses these fails the gate
 * regardless of what the previous baseline measured. Values are generous
 * headroom over the post-fix measurements (~90 MB JS heap, ~800 MB Chrome
 * tree worst case) while staying far below the failure envelope.
 */
const MEM_BUDGETS = {
  jsHeapPeakMb: Number(flag("--max-jsheap-mb", "256")),
  chromePeakMb: Number(flag("--max-chrome-mb", "2048")),
  bridgeEndMb: Number(flag("--max-bridge-mb", "512")),
  herdrEndMb: Number(flag("--max-herdr-mb", "512")),
};

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- storm generator (same seed-42 shape as perf-frame-bench) ----------
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
    if (r < 0.15) parts.push(`\x1b[1;32m✓\x1b[0m ${words[(rand() * words.length) | 0]} done in ${(rand() * 900 + 10) | 0}ms\n`);
    else if (r < 0.3) parts.push(`\x1b[33m⚠ warning\x1b[0m: unused import in ${words[(rand() * words.length) | 0]}\n`);
    else if (r < 0.4) parts.push(`\x1b[31m✗ test failed\x1b[0m ${words[(rand() * words.length) | 0]} assertion at line ${(rand() * 500) | 0}\n`);
    else if (r < 0.5) parts.push(`\x1b[36m→\x1b[0m agent: thinking about ${words[(rand() * words.length) | 0]} …\n`);
    else if (r < 0.6) parts.push(`  ${words[(rand() * words.length) | 0]} = ${((rand() * 1000) | 0) / 10}\n`);
    else {
      let line = "";
      while (line.length < COLS - 10) line += `${words[(rand() * words.length) | 0]} `;
      parts.push(line.slice(0, COLS - 1) + "\n");
    }
  }
  parts.push("日本語のテキストと絵文字 👨‍💻🚀 テスト出力\n");
  parts.push("progress: " + "█".repeat(40) + "░".repeat(20) + " 62%\n");
  return enc.encode(parts.join(""));
}

// kitty image payload: transmit raw RGB (f=24, dims via s/v, id via i) then
// place it (a=p) — the earlier c/r/q variant was rejected by the engine and
// only stressed scrollback with undecoded APC text.
function makeKittyChunk(id: number): Uint8Array {
  const w = KITTY_SIZE, h = Math.round(KITTY_SIZE * 0.6);
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 13 + id * 31) & 0xff;
  const b64 = Buffer.from(rgb).toString("base64");
  const cw = Math.max(1, Math.ceil(w / 9));
  const ch = Math.max(1, Math.ceil(h / 18));
  const text = `\x1b_Ga=T,f=24,s=${w},v=${h},i=${id};${b64}\x1b\\\x1b_Ga=p,i=${id},c=${cw},r=${ch}\x1b\\\n`;
  return enc.encode(text);
}

const LOOPER = `import { readdirSync } from "node:fs";
const dir = process.argv[2];
const ms = Number(process.argv[3] ?? "8000");
const gap = Number(process.argv[4] ?? "0");
const files = readdirSync(dir).filter((f) => f.endsWith(".bin")).sort();
const deadline = Date.now() + ms;
let i = 0;
while (Date.now() < deadline) {
  const b = await Bun.file(dir + "/" + files[i++ % files.length]).arrayBuffer();
  process.stdout.write(Buffer.from(b));
  if (gap > 0) await Bun.sleep(gap);
  else await Bun.sleep(0);
}
`;

// ---------- process memory helpers ----------
function procRssKb(pid: number): number {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch { return 0; }
}
/** RSS of pid plus all descendants (renderer/GPU/utility children). */
function treeRssKb(rootPid: number): { totalKb: number; procs: { pid: number; rssKb: number; kind: string }[] } {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const kids = new Map<number, number[]>();
  const info = new Map<number, { rssKb: number; kind: string }>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]), rss = Number(m[3]), args = m[4] ?? "";
    info.set(pid, { rssKb: rss, kind: args.includes("--type=") ? (args.match(/--type=(\S+)/)?.[1] ?? "?") : "browser" });
    const arr = kids.get(ppid) ?? [];
    arr.push(pid);
    kids.set(ppid, arr);
  }
  const procs: { pid: number; rssKb: number; kind: string }[] = [];
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const i = info.get(pid);
    if (i) procs.push({ pid, rssKb: i.rssKb, kind: i.kind });
    for (const c of kids.get(pid) ?? []) stack.push(c);
  }
  return { totalKb: procs.reduce((a, p) => a + p.rssKb, 0), procs: procs.sort((a, b) => b.rssKb - a.rssKb) };
}

// ---------- CDP ----------
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let ws: WebSocket;
function cdpSend(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}
async function cdpEval(expression: string): Promise<unknown> {
  const res = (await cdpSend("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
    result?: { value?: unknown }; exceptionDetails?: unknown;
  };
  if (res.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(res.exceptionDetails)}`);
  return res.result?.value;
}
async function cdpMetrics(): Promise<Record<string, number>> {
  const res = (await cdpSend("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
  const out: Record<string, number> = {};
  for (const m of res.metrics) out[m.name] = m.value;
  return out;
}

interface Sample {
  t: number;
  scenario: string;
  jsHeapUsedMb: number;
  jsHeapTotalMb: number;
  nodes: number;
  chromeTreeMb: number;
  chromeTop: { kind: string; mb: number }[];
  bridgeMb: number;
  herdrMb: number;
}
const samples: Sample[] = [];
let sampling = false;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let bridgePid = 0;
let herdrPid = 0;
let chromePid = 0;
let currentScenario = "boot";

async function takeSample(): Promise<void> {
  try {
    const metrics = await cdpMetrics();
    const tree = chromePid ? treeRssKb(chromePid) : { totalKb: 0, procs: [] };
    samples.push({
      t: Date.now(),
      scenario: currentScenario,
      jsHeapUsedMb: (metrics["JSHeapUsedSize"] ?? 0) / 1048576,
      jsHeapTotalMb: (metrics["JSHeapTotalSize"] ?? 0) / 1048576,
      nodes: metrics["Nodes"] ?? 0,
      chromeTreeMb: tree.totalKb / 1024,
      chromeTop: tree.procs.slice(0, 4).map((p) => ({ kind: p.kind, mb: p.rssKb / 1024 })),
      bridgeMb: bridgePid ? procRssKb(bridgePid) / 1024 : 0,
      herdrMb: herdrPid ? procRssKb(herdrPid) / 1024 : 0,
    });
  } catch { /* CDP hiccup; skip */ }
}

function startSampling(): void {
  if (sampleTimer) return;
  sampling = true;
  void takeSample();
  sampleTimer = setInterval(() => void takeSample(), SAMPLE_MS);
}
function stopSampling(): void {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  sampling = false;
}

// ---------- spawn helpers ----------
interface Proc { kill: () => void; pid?: number }
function spawnLogged(cmd: string[], env: Record<string, string>, log: string): Proc {
  const p = Bun.spawn(cmd, { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  void Bun.write(log, p.stdout as ReadableStream);
  void Bun.write(`${log}.err`, p.stderr as ReadableStream);
  return { kill: () => p.kill(), pid: p.pid };
}
async function waitHttp(url: string, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { const res = await fetch(url); if (res.ok || res.status < 500) return; } catch {}
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
  let sessionName = SESSION;
  let workDir = "";
  let paneId = "";
  let wsId = "";
  try {
    const hasTarget =
      args.has("--session") || args.has("--socket") ||
      !!process.env.HERDR_VERIFY_SESSION || !!process.env.HERDR_SESSION || !!process.env.HERDR_SOCKET;
    const guardArgv = hasTarget ? process.argv.slice(2) : [...process.argv.slice(2), "--session", SESSION];
    const target = resolveVerifyTarget({ argv: guardArgv });
    const socket = target.socketPath ?? sessionSocketPath(target.session ?? SESSION);
    sessionName = target.session ?? /sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(socket)?.[1] ?? SESSION;

    const sockAlive = existsSync(socket);
    if (!sockAlive) {
      if (target.socketPath) throw new VerifyIsolationError(`socket ${socket} does not exist`);
      console.log(`starting isolated herdr session ${sessionName} (${socket})`);
      const log = join(tmpdir(), `ht3mem-herdr-${process.pid}.log`);
      tmpDirs.push(log, `${log}.err`);
      const p = Bun.spawn(["herdr", "--session", sessionName, "server"], { stdout: "pipe", stderr: "pipe" });
      void Bun.write(log, p.stdout as ReadableStream);
      void Bun.write(`${log}.err`, p.stderr as ReadableStream);
      procs.push({ kill: () => p.kill(), pid: p.pid });
      herdrStarted = true;
      herdrPid = p.pid;
      for (let i = 0; i < 60; i++) { if (existsSync(socket)) break; await sleep(500); }
      if (!existsSync(socket)) throw new Error(`herdr session socket never appeared: ${socket}`);
    } else {
      // find the running herdr server pid for this socket
      const found = spawnSync("pgrep", ["-f", `herdr server`], { encoding: "utf8" });
      herdrPid = Number(found.stdout.trim().split("\n")[0]) || 0;
    }

    let wsList: { result: { workspaces: { workspace_id: string }[] } } | null = null;
    for (let i = 0; i < 20; i++) {
      try { wsList = JSON.parse(herdrCli(sessionName, ["workspace", "list"])); break; } catch { await sleep(400); }
    }
    if (!wsList) throw new Error(`herdr session ${sessionName} did not answer workspace list`);
    for (const w of wsList.result.workspaces) herdrCli(sessionName, ["workspace", "close", w.workspace_id]);
    const created = JSON.parse(
      herdrCli(sessionName, ["workspace", "create", "--label", "mem-bench", "--no-focus"]),
    ).result as { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
    wsId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    console.log(`fixture workspace ${wsId} pane ${paneId}`);
    await sleep(800);

    workDir = mkdtempSync(join(tmpdir(), "ht3mem-"));
    tmpDirs.push(workDir);
    const work = workDir;

    // storm payload files
    for (let i = 0; i < 24; i++) writeFileSync(join(work, `chunk-${String(i).padStart(2, "0")}.bin`), makeChunk());
    // kitty payload files (distinct image ids so the renderer cache must track them)
    const kittyDir = join(work, "kitty");
    mkdirSync(kittyDir);
    for (let i = 0; i < 48; i++) writeFileSync(join(kittyDir, `img-${String(i).padStart(3, "0")}.bin`), makeKittyChunk(i));
    writeFileSync(join(work, "storm.ts"), LOOPER);
    writeFileSync(join(work, "kitty.ts"), LOOPER);

    const bridgeLog = join(work, "bridge.log");
    const viteLog = join(work, "vite.log");
    const allowedOrigins = `${new URL(BASE_URL).origin},http://localhost:${VITE_PORT},http://127.0.0.1:${VITE_PORT}`;
    const bridge = spawnLogged(
      ["bun", "run", "server/index.ts"],
      {
        PORT: String(BRIDGE_PORT), HERDR_T3_PORT: String(BRIDGE_PORT), HOST: "127.0.0.1",
        HERDR_SOCKET: socket, HERDR_T3_ALLOWED_ORIGINS: allowedOrigins,
      },
      bridgeLog,
    );
    procs.push(bridge);
    bridgePid = bridge.pid ?? 0;
    await waitHttp(`http://127.0.0.1:${BRIDGE_PORT}/api/health`);

    procs.push(spawnLogged(
      ["bun", "--bun", "vite", "--port", String(VITE_PORT), "--strictPort"],
      { HERDR_T3_PORT: String(BRIDGE_PORT) }, viteLog,
    ));
    await waitHttp(`${BASE_URL}/`);
    await assertBridgeTargetIsolated(BASE_URL, { argv: guardArgv });

    const chrome = Bun.spawn(
      [CHROME, "--headless=new", `--remote-debugging-port=${CDP_PORT}`, "--no-first-run",
       "--user-data-dir=" + join(work, "cdp-profile"), "--window-size=1440,900", "about:blank"],
      { stdout: "ignore", stderr: "ignore" },
    );
    procs.push({ kill: () => chrome.kill() });
    chromePid = chrome.pid;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const targets = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[];
        const page = targets.find((t) => t.type === "page");
        if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
      } catch {}
      await sleep(250);
    }
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp ws failed")); });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id === undefined) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    };
    await cdpSend("Page.enable");
    await cdpSend("Runtime.enable");
    await cdpSend("Performance.enable");
    if (CPU_THROTTLE > 1) {
      await cdpSend("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
      console.log(`renderer CPU throttled x${CPU_THROTTLE}`);
    }

    // navigate to the mem-bench workspace
    await cdpSend("Page.navigate", { url: `${BASE_URL}/#/w/${encodeURIComponent("local")}/${encodeURIComponent(wsId)}` });
    // wait for a live ghostty surface (engine created + subscribed)
    let attached = false;
    for (let i = 0; i < 80; i++) {
      const found = await cdpEval(`!!document.querySelector(".ghostty-surface")`);
      if (found === true) { attached = true; break; }
      await sleep(500);
    }
    if (!attached) throw new Error("ghostty surface never appeared");
    await sleep(3000); // settle: initial scrollback decode + first frames
    console.log("surface attached; baseline settle done");

    startSampling();

    const runScenario = async (name: string, fn: () => Promise<void>) => {
      currentScenario = name;
      console.log(`--- scenario: ${name}`);
      await takeSample();
      await fn();
      await sleep(1500);
      await takeSample();
    };

    const storm = async (mb: number, seconds: number) => {
      // stream `mb` MiB of ANSI storm through the pane via `pane run`
      const chunkBytes = 6 * 1024;
      const chunks = Math.ceil((mb * 1024 * 1024) / chunkBytes);
      const cat = Array.from({ length: chunks }, (_, i) => `cat ${work}/chunk-${String(i % 24).padStart(2, "0")}.bin; `).join("");
      // write a runner script that loops chunks until deadline
      const runner = join(work, "runner.sh");
      writeFileSync(runner, `end=$((SECONDS+${seconds})); i=0; while [ $SECONDS -lt $end ]; do cat ${work}/chunk-$(printf %02d $((i%24))).bin; i=$((i+1)); done\n`);
      herdrCli(sessionName, ["pane", "run", paneId, `bash ${runner}`]);
      await sleep(seconds * 1000 + 2000);
    };

    const kitty = async (seconds: number) => {
      const runner = join(work, "kitty-runner.sh");
      writeFileSync(runner, `end=$((SECONDS+${seconds})); i=0; while [ $SECONDS -lt $end ]; do cat ${kittyDir}/img-$(printf %03d $((i%48))).bin; i=$((i+1)); done\n`);
      herdrCli(sessionName, ["pane", "run", paneId, `bash ${runner}`]);
      await sleep(seconds * 1000 + 2000);
    };

    const idle = async (seconds: number) => sleep(seconds * 1000);

    const switchWs = async (cycles: number) => {
      // create a second workspace, then alternate the UI route — the real
      // React unmount/mount path for PaneTerminal/GhosttySession.
      const created2 = JSON.parse(
        herdrCli(sessionName, ["workspace", "create", "--label", "mem-bench-2", "--no-focus"]),
      ).result as { workspace: { workspace_id: string } };
      const ws2 = created2.workspace.workspace_id;
      for (let i = 0; i < cycles; i++) {
        await cdpEval(`location.hash = ${JSON.stringify(`#/w/local/${wsId}`)}; "ok"`);
        await sleep(700);
        await cdpEval(`location.hash = ${JSON.stringify(`#/w/local/${ws2}`)}; "ok"`);
        await sleep(700);
      }
      await cdpEval(`location.hash = ${JSON.stringify(`#/w/local/${wsId}`)}; "ok"`);
      await sleep(700);
      herdrCli(sessionName, ["workspace", "close", ws2]);
    };

    if (SCENARIO === "all" || SCENARIO === "idle") await runScenario("idle", () => idle(12));
    if (SCENARIO === "all" || SCENARIO === "storm") await runScenario("storm", () => storm(STORM_MB, STORM_SECONDS));
    if (SCENARIO === "all" || SCENARIO === "kitty") await runScenario("kitty", () => kitty(20));
    if (SCENARIO === "all" || SCENARIO === "switch") await runScenario("switch", () => switchWs(10));
    if (SCENARIO === "all" || SCENARIO === "storm2") await runScenario("storm2", () => storm(STORM_MB, STORM_SECONDS));

    stopSampling();
    await takeSample();

    // ---------- report ----------
    const byScenario = new Map<string, Sample[]>();
    for (const s of samples) {
      const arr = byScenario.get(s.scenario) ?? [];
      arr.push(s);
      byScenario.set(s.scenario, arr);
    }
    const summary: Record<string, unknown> = {};
    for (const [name, arr] of byScenario) {
      const first = arr[0]!, last = arr[arr.length - 1]!;
      const peak = arr.reduce((a, s) => (s.chromeTreeMb > a.chromeTreeMb ? s : a), first);
      summary[name] = {
        samples: arr.length,
        jsHeapStartMb: +first.jsHeapUsedMb.toFixed(1),
        jsHeapEndMb: +last.jsHeapUsedMb.toFixed(1),
        jsHeapPeakMb: +Math.max(...arr.map((s) => s.jsHeapUsedMb)).toFixed(1),
        chromeStartMb: +first.chromeTreeMb.toFixed(1),
        chromeEndMb: +last.chromeTreeMb.toFixed(1),
        chromePeakMb: +peak.chromeTreeMb.toFixed(1),
        chromePeakTop: peak.chromeTop,
        bridgeEndMb: +last.bridgeMb.toFixed(1),
        herdrEndMb: +last.herdrMb.toFixed(1),
      };
    }
    const report = {
      issue: 499,
      sha: gitSha(),
      session: sessionName,
      at: new Date().toISOString(),
      host: { platform: platform(), arch: arch(), cpus: cpus().length, totalMemMb: Math.round(totalmem() / 1048576), loadavg: loadavg() },
      config: { stormMb: STORM_MB, stormSeconds: STORM_SECONDS, scenario: SCENARIO },
      summary,
      samples,
    };
    mkdirSync(join(REPO_ROOT, "perf-reports"), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
    console.log(JSON.stringify(summary, null, 2));

    if (CHECK) {
      // Memory gate for the #425 infra (issue #499): absolute ceilings per
      // scenario — a leak fails here even when timings look fine.
      let ok = true;
      for (const [name, s] of Object.entries(summary) as [string, {
        jsHeapPeakMb: number; chromePeakMb: number; bridgeEndMb: number; herdrEndMb: number;
      }][]) {
        const breaches: string[] = [];
        if (s.jsHeapPeakMb > MEM_BUDGETS.jsHeapPeakMb) breaches.push(`jsHeap ${s.jsHeapPeakMb}MB > ${MEM_BUDGETS.jsHeapPeakMb}MB`);
        if (s.chromePeakMb > MEM_BUDGETS.chromePeakMb) breaches.push(`chrome ${s.chromePeakMb}MB > ${MEM_BUDGETS.chromePeakMb}MB`);
        if (s.bridgeEndMb > MEM_BUDGETS.bridgeEndMb) breaches.push(`bridge ${s.bridgeEndMb}MB > ${MEM_BUDGETS.bridgeEndMb}MB`);
        if (s.herdrEndMb > MEM_BUDGETS.herdrEndMb) breaches.push(`herdr ${s.herdrEndMb}MB > ${MEM_BUDGETS.herdrEndMb}MB`);
        if (breaches.length) {
          ok = false;
          console.error(`FAIL  ${name}: ${breaches.join("; ")}`);
        } else {
          console.log(`PASS  ${name}: within memory budgets`);
        }
      }
      return ok ? 0 : 1;
    }
    return 0;
  } finally {
    stopSampling();
    for (const p of procs.reverse()) { try { p.kill(); } catch {} }
    await sleep(300);
    if (herdrStarted && wsId) {
      try { herdrCli(sessionName, ["workspace", "close", wsId]); } catch {}
    }
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error("perf-memory-bench failed:", error);
  process.exit(1);
});
