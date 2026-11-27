/**
 * Scrollback delivery bench (issue #570, program #568).
 *
 * Measures what the herdr client-protocol attach stream actually delivers
 * on an isolated herdr session — never the maintainer's live session
 * (verify-guard enforced):
 *
 *   attach           bytes/frames from `AttachTerminal` until the stream
 *                    settles — proves whether attach replays scrollback or
 *                    only the viewport
 *   scroll-up        bytes per `AttachScroll` page step while paging
 *                    through host scrollback — the demand-driven fetch
 *                    volume
 *   scroll-past-top  extra `AttachScroll` up-steps beyond the scrollback
 *                    ceiling — detects wasted frames at the boundary
 *   reattach         a second attach after history exists — must cost the
 *                    same viewport-only bytes as the first
 *
 * Usage:
 *   bun scripts/perf-scrollback.ts record [--session NAME] [--socket PATH]
 *        [--out PATH] [--cols N] [--rows N] [--history-lines N]
 *
 * The script spawns `herdr --session <name> server` when the session
 * socket is absent and kills it on exit. All herdr traffic is fixture
 * output (`seq`) generated inside the isolated session.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, hostname, cpus, totalmem } from "node:os";
import { join } from "node:path";
import {
  resolveVerifyTarget,
  sessionSocketPath,
  VerifyIsolationError,
} from "./verify-guard";
import { herdrRpc } from "../server/herdr.ts";
import {
  openTerminalLink,
  clientSocketPath,
  type ServerEvent,
  type TerminalLink,
} from "../server/client-link.ts";
import { socketConnector } from "../server/socket.ts";
import { socketAddress } from "../server/herdr.ts";

const REPO_ROOT = join(import.meta.dir, "..");

// ---------- args ----------
const VALUE_FLAGS = new Set([
  "--session", "--socket", "--out", "--cols", "--rows", "--history-lines",
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

const SESSION = flag("--session", "ht3scroll");
const COLS = Number(flag("--cols", "120"));
const ROWS = Number(flag("--rows", "40"));
const HISTORY_LINES = Number(flag("--history-lines", "30000"));
const SETTLE_MS = 400;
const ATTACH_TIMEOUT_MS = 20_000;
const MAX_SCROLL_STEPS = 400;
const PAST_TOP_STEPS = 3;

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function herdrCli(session: string, cliArgs: string[]): string {
  return execFileSync("herdr", ["--session", session, ...cliArgs], { encoding: "utf8" });
}

interface PaneScroll {
  offset_from_bottom?: number;
  max_offset_from_bottom?: number;
  viewport_rows?: number;
}

interface SnapshotPane {
  pane_id: string;
  terminal_id: string;
  scroll?: PaneScroll | null;
}

async function snapshot(socket: string): Promise<{ panes: SnapshotPane[] }> {
  const result = await herdrRpc<{ snapshot: { panes: SnapshotPane[] } }>(
    "session.snapshot",
    {},
    { socketPath: socket, timeoutMs: 20000 },
  );
  return result.snapshot;
}

async function scrollInfo(socket: string, paneId: string): Promise<PaneScroll | null> {
  const snap = await snapshot(socket);
  return snap.panes.find((p) => p.pane_id === paneId)?.scroll ?? null;
}

interface ByteStats {
  frames: number;
  bytes: number;
  fullFrames: number;
  maxFrameBytes: number;
}

function zeroStats(): ByteStats {
  return { frames: 0, bytes: 0, fullFrames: 0, maxFrameBytes: 0 };
}

function addEvent(stats: ByteStats, event: ServerEvent): void {
  if (event.type !== "terminal") return;
  stats.frames += 1;
  stats.bytes += event.bytes.length;
  if (event.full) stats.fullFrames += 1;
  stats.maxFrameBytes = Math.max(stats.maxFrameBytes, event.bytes.length);
}

/** Resolve once the first Terminal frame lands (or the cap hits). */
function firstFrame(stats: ByteStats, timeoutMs: number): Promise<void> {
  if (stats.frames > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const started = stats.frames;
    const timer = setInterval(() => {
      if (stats.frames > started || stats.frames > 0) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, timeoutMs);
  });
}

/**
 * Wait until no Terminal frame has arrived for SETTLE_MS (or the cap
 * hits). `stats` is the live accumulator the attach handler keeps
 * mutating, so callers can also diff it around a single scroll step.
 */
async function waitQuiet(stats: ByteStats, timeoutMs = ATTACH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFrames = -1;
  let quietSince = Date.now();
  for (;;) {
    await sleep(25);
    if (stats.frames !== lastFrames) {
      lastFrames = stats.frames;
      quietSince = Date.now();
    }
    if (Date.now() - quietSince >= SETTLE_MS || Date.now() > deadline) return;
  }
}

/**
 * Attach to `terminalId` and measure delivered bytes until the stream
 * goes quiet. The returned `stats` object stays live: the attach
 * handler keeps mutating it for the life of `link`, so later phases can
 * diff it per scroll step.
 */
async function measureAttach(
  clientSock: string,
  terminalId: string,
  label: string,
): Promise<{ stats: ByteStats; link: TerminalLink }> {
  const stats = zeroStats();
  const link = await openTerminalLink(
    terminalId,
    { cols: COLS, rows: ROWS, connect: socketConnector(socketAddress(clientSock)) },
    {
      onEvent: (event) => {
        addEvent(stats, event);
      },
      onClose: (reason) => {
        console.error(`attach ${label} closed: ${reason}`);
      },
    },
  );
  // openTerminalLink resolves after Welcome+AttachTerminal; the first
  // Terminal frame follows asynchronously.
  await firstFrame(stats, ATTACH_TIMEOUT_MS);
  await waitQuiet(stats);
  return { stats, link };
}

async function main(): Promise<number> {
  const command = positional[0] ?? "record";
  if (command !== "record") {
    console.error("usage: perf-scrollback.ts record [--session NAME] [--socket PATH] [--out PATH]");
    return 2;
  }

  const hasTarget =
    args.has("--session") || args.has("--socket") ||
    !!process.env.HERDR_VERIFY_SESSION || !!process.env.HERDR_SESSION || !!process.env.HERDR_SOCKET;
  const guardArgv = hasTarget
    ? process.argv.slice(2)
    : [...process.argv.slice(2), "--session", SESSION];
  const target = resolveVerifyTarget({ argv: guardArgv });
  const socket = target.socketPath ?? sessionSocketPath(target.session ?? SESSION);
  const sessionName =
    target.session ??
    /sessions[/\\]([^/\\]+)[/\\]herdr\.sock$/.exec(socket)?.[1] ??
    SESSION;

  const procs: { kill: () => void }[] = [];
  const tmpFiles: string[] = [];
  try {
    if (!existsSync(socket)) {
      if (target.socketPath) throw new VerifyIsolationError(`socket ${socket} does not exist`);
      console.log(`starting isolated herdr session ${sessionName} (${socket})`);
      const log = join(tmpdir(), `ht3scroll-herdr-${process.pid}.log`);
      tmpFiles.push(log, `${log}.err`);
      const p = Bun.spawn(["herdr", "--session", sessionName, "server"], { stdout: "pipe", stderr: "pipe" });
      void Bun.write(log, p.stdout as ReadableStream);
      void Bun.write(`${log}.err`, p.stderr as ReadableStream);
      procs.push({ kill: () => p.kill() });
      for (let i = 0; i < 60; i++) {
        if (existsSync(socket)) break;
        await sleep(500);
      }
      if (!existsSync(socket)) throw new Error(`herdr session socket never appeared: ${socket}`);
    }

    // Fixture: one workspace with one pane, then scrollback output.
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
      herdrCli(sessionName, ["workspace", "create", "--label", "perf-scroll", "--no-focus"]),
    ).result as { workspace: { workspace_id: string } };
    const fixtureWs = created.workspace.workspace_id;
    console.log(`fixture workspace ${fixtureWs}`);
    await sleep(800);

    const snap0 = await snapshot(socket);
    const pane0 = snap0.panes[0];
    if (!pane0) throw new Error("fixture workspace has no pane");
    const paneId = pane0.pane_id;
    const terminalId = pane0.terminal_id;
    console.log(`fixture pane ${paneId} terminal ${terminalId}`);

    // Generate scrollback: seq writes HISTORY_LINES lines into the pane.
    herdrCli(sessionName, [
      "pane", "run", paneId,
      `seq 1 ${HISTORY_LINES}`,
    ]);
    // Wait for the scrollback to materialize (poll scroll metrics).
    let maxOffset = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const info = await scrollInfo(socket, paneId).catch(() => null);
      maxOffset = info?.max_offset_from_bottom ?? 0;
      if (maxOffset >= HISTORY_LINES - ROWS - 5) break;
    }
    console.log(`scrollback ready: max_offset_from_bottom=${maxOffset}`);

    const clientSock =
      process.env["HERDR_CLIENT_SOCKET_PATH"] ??
      clientSocketPath({ HERDR_SOCKET: socket });
    if (!existsSync(clientSock)) {
      throw new Error(`herdr client socket missing: ${clientSock}`);
    }

    // --- Phase 1: initial attach ---------------------------------------
    const t0 = Date.now();
    const first = await measureAttach(clientSock, terminalId, "first");
    const attachMs = Date.now() - t0;
    const attachStats = { ...first.stats };
    console.log(
      `attach: ${attachStats.frames} frames, ${attachStats.bytes} bytes ` +
        `(${attachMs}ms, full=${attachStats.fullFrames}, maxFrame=${attachStats.maxFrameBytes})`,
    );

    // --- Phase 2: scroll up through host scrollback --------------------
    // first.stats stays live: the attach handler keeps mutating it, so
    // each step's delivered bytes are the delta around link.scroll().
    const live = first.stats;
    const scrollSteps: {
      step: number;
      lines: number;
      frames: number;
      bytes: number;
      offset_from_bottom: number | null;
      max_offset_from_bottom: number | null;
    }[] = [];
    for (let step = 0; step < MAX_SCROLL_STEPS; step++) {
      const markFrames = live.frames;
      const markBytes = live.bytes;
      first.link.scroll("up", ROWS);
      await waitQuiet(live);
      const info = await scrollInfo(socket, paneId).catch(() => null);
      scrollSteps.push({
        step: step + 1,
        lines: ROWS,
        frames: live.frames - markFrames,
        bytes: live.bytes - markBytes,
        offset_from_bottom: info?.offset_from_bottom ?? null,
        max_offset_from_bottom: info?.max_offset_from_bottom ?? null,
      });
      const offset = info?.offset_from_bottom ?? 0;
      const max = info?.max_offset_from_bottom ?? 0;
      if (offset >= max) break;
    }
    const scrollFrames = scrollSteps.reduce((n, s) => n + s.frames, 0);
    const scrollBytes = scrollSteps.reduce((n, s) => n + s.bytes, 0);
    console.log(`scroll-up: ${scrollSteps.length} page steps, ${scrollFrames} frames, ${scrollBytes} bytes`);

    // --- Phase 3: scroll past the top ----------------------------------
    const pastTop: { step: number; frames: number; bytes: number }[] = [];
    for (let i = 0; i < PAST_TOP_STEPS; i++) {
      const markFrames = live.frames;
      const markBytes = live.bytes;
      first.link.scroll("up", ROWS);
      await waitQuiet(live);
      pastTop.push({ step: i + 1, frames: live.frames - markFrames, bytes: live.bytes - markBytes });
    }
    console.log(`past-top bytes per step: ${pastTop.map((p) => p.bytes).join(", ")}`);

    // --- Phase 4: back to bottom, detach, re-attach --------------------
    for (let i = 0; i < MAX_SCROLL_STEPS * 2; i++) {
      const info = await scrollInfo(socket, paneId).catch(() => null);
      if ((info?.offset_from_bottom ?? 0) === 0) break;
      first.link.scroll("down", ROWS * 4);
      await sleep(SETTLE_MS * 3);
    }
    first.link.close();
    await sleep(300);

    const t1 = Date.now();
    const second = await measureAttach(clientSock, terminalId, "second");
    const reattachMs = Date.now() - t1;
    const secondStats = { ...second.stats };
    console.log(
      `reattach: ${secondStats.frames} frames, ${secondStats.bytes} bytes (${reattachMs}ms)`,
    );
    second.link.close();

    const infoEnd = await scrollInfo(socket, paneId).catch(() => null);

    const out =
      positional[1] ??
      flag("--out", join(REPO_ROOT, "perf-reports", `scrollback-${gitSha().slice(0, 8)}.json`));
    const report = {
      format: "herdr-t3/scrollback-delivery",
      version: 1,
      recorded_at: new Date().toISOString(),
      git_sha: gitSha(),
      host: {
        platform: platform(),
        arch: arch(),
        hostname: hostname(),
        cpu_model: cpus()[0]?.model ?? "unknown",
        cpu_count: cpus().length,
        mem_total_bytes: totalmem(),
      },
      herdr: { version: herdrCli(sessionName, ["--version"]).trim() },
      session: { name: sessionName, socket, isolated: true },
      fixture: {
        workspace_id: fixtureWs,
        pane_id: paneId,
        terminal_id: terminalId,
        cols: COLS,
        rows: ROWS,
        history_command_lines: HISTORY_LINES,
        scrollback_max_offset_from_bottom: infoEnd?.max_offset_from_bottom ?? maxOffset,
      },
      attach: {
        first: { ...attachStats, elapsed_ms: attachMs },
        second: { ...secondStats, elapsed_ms: reattachMs },
        note: "bytes delivered by Terminal frames until the stream settled; viewport is cols×rows",
      },
      scroll_up: {
        page_step_lines: ROWS,
        steps: scrollSteps,
        total_frames: scrollFrames,
        total_bytes: scrollBytes,
      },
      scroll_past_top: pastTop,
      verdict_inputs: {
        attach_replays_scrollback:
          attachStats.bytes > COLS * ROWS * 4 && maxOffset > ROWS * 2,
        scroll_is_demand_paged: scrollSteps.length > 1 && scrollBytes > 0,
      },
    };
    writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
    console.log(`wrote ${out}`);
    return 0;
  } finally {
    for (const p of procs) p.kill();
    for (const f of tmpFiles) {
      try {
        execFileSync("rm", ["-f", f]);
      } catch {
        /* best effort */
      }
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
