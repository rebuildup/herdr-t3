#!/usr/bin/env bun
/**
 * herdr TUI ⇄ hoxay comparison runner (issue #640).
 *
 * Phases (each one is independent and can be run alone; `all` runs the
 * ones that do not need a running app):
 *
 *   capability  herdr API vs hoxay's implemented surface (static + code)
 *   efficiency  actions-per-task comparison (static)
 *   floor       the shared herdr round-trip cost both clients pay
 *   gui         the packaged hoxay app, measured over CDP
 *   tui         the herdr TUI, measured in a pty
 *
 * Every measurement is deadline-bounded. A timeout is a failure, never a
 * successful measurement, and the report says so.
 *
 * Usage:
 *   bun quality/tui-parity/run.ts capability [--out DIR]
 *   bun quality/tui-parity/run.ts efficiency  [--out DIR]
 *   bun quality/tui-parity/run.ts floor --session NAME [--out DIR]
 *   bun quality/tui-parity/run.ts gui --cdp-port N --session NAME [--out DIR]
 *   bun quality/tui-parity/run.ts tui --session NAME [--out DIR]
 *   bun quality/tui-parity/run.ts soak-gui --cdp-port N --session NAME [--duration-ms M] [--interval-ms M]
 *   bun quality/tui-parity/run.ts soak-tui --session NAME [--duration-ms M] [--interval-ms M]
 */
import { execFileSync } from "node:child_process";
import { arch, cpus, loadavg, platform } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, type Scenario } from "./catalog.ts";
import {
  buildCapabilityReport,
  capabilityChecks,
  loadInventory,
  loadParityMarkdown,
  loadTuiParityMarkdown,
  tuiFeatureMappingCheck,
  type CapabilityCheck,
  type CapabilityReport,
} from "./lib/capability.ts";
import { compareEfficiency, EFFICIENCY_TASKS, type EfficiencyComparison } from "./lib/efficiency.ts";
import { measureFloorSuite, type FloorResult } from "./lib/floor.ts";
import { seedFixture, type Fixture } from "./lib/fixture.ts";
import { CdpClient, clickSelector, insertText, visibleBox } from "./lib/cdp.ts";
import {
  measureLatency,
  measureScroll,
  measureWorkspaceSwitch,
  observeState,
  terminalSelector,
  type LatencySample,
} from "./lib/hoxay.ts";
import { TuiDriver } from "./lib/tui.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

export interface PhaseResult {
  phase: string;
  pass: boolean;
  details: Record<string, unknown>;
  failures: string[];
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    }
  }
  return opts;
}

function evidenceDir(opts: Record<string, string>): string {
  const dir = opts["out"] ?? join("docs", "design", "evidence", "tui-parity", gitSha().slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/* capability phase                                                    */
/* ------------------------------------------------------------------ */

export function capabilityPhase(): { result: PhaseResult; report: CapabilityReport } {
  const inventory = loadInventory();
  const report = buildCapabilityReport(inventory, loadParityMarkdown());
  const checks: CapabilityCheck[] = [
    ...capabilityChecks(report),
    tuiFeatureMappingCheck(inventory, loadTuiParityMarkdown()),
  ];
  const failures = checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.failures.join(", ")}`);
  return {
    result: {
      phase: "capability",
      pass: failures.length === 0,
      failures,
      details: {
        herdrVersion: report.herdrVersion,
        herdrMethods: report.herdrMethodCount,
        hoxayMethods: report.bridgeMethodCount,
        checks: checks.map((c) => ({ id: c.id, pass: c.pass, failures: c.failures })),
      },
    },
    report,
  };
}

/* ------------------------------------------------------------------ */
/* efficiency phase                                                    */
/* ------------------------------------------------------------------ */

export function efficiencyPhase(): { result: PhaseResult; comparison: EfficiencyComparison[] } {
  const comparison = compareEfficiency(EFFICIENCY_TASKS);
  const failures = comparison.filter((c) => !c.pass).map((c) => `${c.id}: hoxay ${c.hoxayActions} > TUI ${c.tuiActions}`);
  return {
    result: {
      phase: "efficiency",
      pass: failures.length === 0,
      failures,
      details: { tasks: comparison },
    },
    comparison,
  };
}

/* ------------------------------------------------------------------ */
/* floor phase                                                         */
/* ------------------------------------------------------------------ */

export async function floorPhase(session: string): Promise<{ result: PhaseResult; floors: FloorResult[] }> {
  const socketPath = join(process.env.HOME ?? "", ".config", "herdr", "sessions", session, "herdr.sock");
  const fixture = await seedFixture({ session });
  const ids = fixture.panes.map((p) => p.workspaceId);
  const suite = await measureFloorSuite(
    socketPath,
    [
      { method: "session.snapshot", paramsFn: () => ({}) },
      {
        method: "workspace.focus",
        // alternate so the server never collapses into a no-op fast path
        paramsFn: (i) => ({ workspace_id: ids[i % ids.length] }),
      },
    ],
    { iterations: 20, timeoutMs: 5000 },
  );
  const failures = suite.results
    .filter((r) => r.errors > 0 || !Number.isFinite(r.p95))
    .map((r) => `${r.method}: ${r.errors} errors, p95=${r.p95}`);
  return {
    result: {
      phase: "floor",
      pass: failures.length === 0,
      failures,
      details: { socketPath, results: suite.results },
    },
    floors: suite.results,
  };
}

/* ------------------------------------------------------------------ */
/* gui phase                                                           */
/* ------------------------------------------------------------------ */

/** The packaged app's spawn timestamp (ms epoch), exported by packaged.sh. */
const APP_SPAWN_MS = Number(process.env.HERDR_T3_APP_SPAWN_MS ?? 0);
/** The 5s spawn->operable product contract (#601/#603). */
const STARTUP_DEADLINE_MS = 5000;

/**
 * The operable probe — identical to the one the RC harness enforces
 * (harness/ui/adapters/electron.ts): observe() must answer AND the
 * product health path must respond. A live CDP port alone is not
 * operable.
 */
const OPERABLE_PROBE = `(async () => {
  const s = await window.__herdrT3Ui?.observe?.();
  if (!s || typeof s !== "object" || typeof s.route !== "string") return "observe-unavailable";
  if (window.herdrT3?.health) {
    try { await window.herdrT3.health(); return "ok"; }
    catch (e) { return "health-ipc-error"; }
  }
  return fetch("/api/health").then((r) => (r.ok ? "ok" : "health-" + r.status)).catch(() => "health-unreachable");
})()`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Recent pane output, read through herdr — the same verification path
 *  scripts/verify-terminal-input.ts uses for the RC input contract. */
function herdrPaneRead(session: string, paneId: string, lines = 30): string {
  try {
    return execFileSync(
      "herdr",
      ["--session", session, "pane", "read", paneId, "--source", "recent", "--lines", String(lines)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return "";
  }
}

/** The session's currently focused pane id, or null. */
function herdrCurrentPane(session: string): string | null {
  try {
    const out = execFileSync("herdr", ["--session", session, "pane", "current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = out.indexOf("{");
    if (start < 0) return null;
    const json = JSON.parse(out.slice(start)) as { result?: { pane_id?: string; pane?: { pane_id?: string } } };
    return json.result?.pane_id ?? json.result?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

export async function guiPhase(
  cdpPort: number,
  session: string,
  presetFixture?: Fixture,
): Promise<PhaseResult> {
  const failures: string[] = [];
  const samples: LatencySample[] = [];
  const details: Record<string, unknown> = { cdpPort, session };
  // The fixture has to exist BEFORE the app attaches: a pane the client
  // owns cannot be driven with `pane run` afterwards.
  const fixture = presetFixture ?? (await seedFixture({ session }));

  let cdp: CdpClient;
  try {
    cdp = await CdpClient.connect({ port: cdpPort, callMs: 10_000, discoverMs: 30_000 });
  } catch (e) {
    // A spawn-anchored run that cannot even reach CDP inside the window
    // is a startup failure, not a harness error.
    failures.push(`startup.cdp-connect: ${(e as Error).message}`);
    return { phase: "gui", pass: false, failures, details };
  }

  try {
    // startup.packaged-5s: spawn -> operable, anchored at the app's own
    // spawn timestamp so CDP discovery time counts against the contract.
    if (APP_SPAWN_MS > 0) {
      const deadline = APP_SPAWN_MS + STARTUP_DEADLINE_MS;
      let readyMs: number | null = null;
      let lastStatus = "pending";
      do {
        lastStatus = await cdp
          .evaluate<string>(OPERABLE_PROBE)
          .catch((e) => `evaluate-error:${String(e).slice(0, 80)}`);
        if (lastStatus === "ok") {
          readyMs = Date.now() - APP_SPAWN_MS;
          break;
        }
        await sleep(100);
      } while (Date.now() < deadline);
      // CDP discovery alone can eat the whole window on a loaded host,
      // so the do-while may observe "ok" after the deadline — that is a
      // breach, not a pass. Only an in-deadline readiness counts.
      if (readyMs === null || readyMs > STARTUP_DEADLINE_MS) {
        failures.push(
          `startup.operable: ${readyMs === null ? `stuck at ${lastStatus}` : `operable at ${readyMs}ms`} — spawn→operable exceeded ${STARTUP_DEADLINE_MS}ms`,
        );
        if (readyMs !== null) {
          details["startup.operable.actualMs"] = readyMs;
        }
      } else {
        samples.push({
          operation: "startup.operable",
          ms: readyMs,
          deadlineMs: STARTUP_DEADLINE_MS,
          detail: { spawnMs: APP_SPAWN_MS },
        });
      }
    } else {
      details["startup"] = "not measured: HERDR_T3_APP_SPAWN_MS not set (run via packaged.sh)";
    }

    // The app must be showing the fixture session's workspaces. Before
    // the renderer finishes booting `__herdrT3Ui` is absent and
    // observeState throws — that is the same "not operable yet" state
    // the startup probe measures. A breached 5s contract is already
    // recorded above; give a slow (loaded) host a bounded grace period
    // so the remaining legs still produce real measurements instead of
    // cascading synthetic errors.
    let state: Awaited<ReturnType<typeof observeState>> | null = null;
    const graceDeadline = Date.now() + 20_000;
    while (Date.now() < graceDeadline) {
      state = await observeState(cdp).catch(() => null);
      if (state?.route) break;
      await sleep(250);
    }
    if (!state?.route) {
      failures.push("app did not report a route");
    } else {
    const [a, b] = fixture.panes;
    if (!a || !b) {
      failures.push("fixture did not provide two workspaces");
    } else {
      // switch to the second workspace, then back
      for (const [from, to] of [[a, b], [b, a]] as const) {
        try {
          const sample = await measureWorkspaceSwitch(cdp, to.workspaceId, 2000);
          samples.push(sample);
        } catch (e) {
          failures.push(`workspace.switch(${from.label}→${to.label}): ${(e as Error).message}`);
        }
      }
    }

    // scroll the focused pane and wait for the offset to move. The pane
    // must live in the *selected* workspace — a terminal for another
    // workspace is not mounted, so `focused_pane_id` alone is not a
    // sufficient target when a switch measurement timed out.
    const focused = await observeState(cdp).catch(() => null);
    if (!focused) {
      failures.push("observe surface lost before scroll check");
    } else {
    const selPane = fixture.panes.find((p) => p.workspaceId === focused.selected_workspace);
    const focusedInSelection = fixture.panes.some(
      (p) => p.paneId === focused.focused_pane_id && p.workspaceId === focused.selected_workspace,
    );
    const paneId = focusedInSelection ? focused.focused_pane_id : (selPane?.paneId ?? null);
    if (!paneId) {
      failures.push("no mounted pane to scroll");
    } else {
      const key = `local\n${paneId}`;
      const before = focused.terminals[key] ?? 0;
      try {
        const sample = await measureScroll(cdp, paneId, 10, before, 2000);
        samples.push(sample);
      } catch (e) {
        failures.push(`terminal.scroll: ${(e as Error).message}`);
      }
    }
    }

    // terminal.input-delivery: click the terminal surface to focus it,
    // type a unique token + Enter, and verify the pane echoes it back.
    // Delivery is proven out of band through `herdr pane read` — the
    // same path scripts/verify-terminal-input.ts uses for the RC
    // input contract — never through the client's own screen. Same
    // mounted-pane rule as the scroll check above.
    const inputState = await observeState(cdp).catch(() => null);
    if (!inputState) {
      failures.push("observe surface lost before input-delivery check");
    } else {
    const inputSelPane = fixture.panes.find((p) => p.workspaceId === inputState.selected_workspace);
    const inputFocusedMounted = fixture.panes.some(
      (p) => p.paneId === inputState.focused_pane_id && p.workspaceId === inputState.selected_workspace,
    );
    const inputPaneId = inputFocusedMounted
      ? inputState.focused_pane_id
      : (inputSelPane?.paneId ?? null);
    if (!inputPaneId) {
      failures.push("no mounted pane for the input-delivery check");
    } else {
      const token = `parity-${Date.now().toString(36)}`;
      try {
        const sample = await measureLatency(
          "terminal.input-delivery",
          async () => {
            await clickSelector(cdp, terminalSelector(inputPaneId));
            await insertText(cdp, token);
            for (const type of ["keyDown", "keyUp"] as const) {
              await cdp.send("Input.dispatchKeyEvent", {
                type,
                key: "Enter",
                code: "Enter",
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 36,
              });
            }
          },
          async () => herdrPaneRead(session, inputPaneId).includes(token),
          3000,
          { paneId: inputPaneId },
        );
        samples.push(sample);
      } catch (e) {
        failures.push(`terminal.input-delivery: ${(e as Error).message}`);
      }
    }
    }
    }
  } finally {
    await cdp.close();
  }

  return {
    phase: "gui",
    pass: failures.length === 0,
    failures,
    details: { ...details, samples },
  };
}

/* ------------------------------------------------------------------ */
/* tui phase                                                           */
/* ------------------------------------------------------------------ */

const CTRL_B = 0x02;

export async function tuiPhase(session: string, presetFixture?: Fixture): Promise<PhaseResult> {
  const failures: string[] = [];
  const fixture = presetFixture ?? (await seedFixture({ session }));
  const driver = await TuiDriver.start({ session, rows: 30, cols: 100 });
  const samples: { label: string; ms: number }[] = [];
  if (driver.readyMs !== null) {
    samples.push({ label: "startup.first-frame", ms: driver.readyMs });
  }

  try {
    // let the TUI paint its first frame
    await new Promise((r) => setTimeout(r, 1500));
    const initial = driver.screenText();
    if (!initial.trim()) failures.push("TUI produced no visible screen");

    // The TUI is mouse-native and keeps UI focus on the sidebar until a
    // pane surface is clicked — a real user's first action. Everything
    // below assumes that focus.
    try {
      await driver.clickPane();
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      failures.push(`pane focus click: ${(e as Error).message}`);
    }

    // workspace.switch, staged and content-verified: the fixture
    // workspaces have DISTINCT scrollback (ui-a ends at "400", ui-b at
    // "500"), so a real switch is proven by the target's marker becoming
    // visible — not by "any text changed", which a coincidental repaint
    // could fake. goto (prefix+g) is deterministic: type the label,
    // Enter. The picker (prefix+w) is the fallback; Down+Enter lands on
    // whichever row is selected, so it is only accepted when "500"
    // appears.
    const switchCandidates: {
      label: string;
      open: number[];
      pick: number[];
      verify: string;
    }[] = [
      { label: "prefix+g → 'ui-b' → Enter", open: [CTRL_B, 0x67], pick: [0x75, 0x69, 0x2d, 0x62, 0x0d], verify: "500" },
      { label: "prefix+w → Down → Enter", open: [CTRL_B, 0x77], pick: [0x1b, 0x5b, 0x42, 0x0d], verify: "500" },
    ];
    let switched = false;
    const switchErrors: string[] = [];
    for (const candidate of switchCandidates) {
      const t0 = Date.now();
      try {
        const before = driver.screenText();
        await driver.send(new Uint8Array(candidate.open));
        // the picker is a text overlay — wait for it to appear
        await driver.waitForOutput(3000, () => driver.screenText() !== before);
        await sleep(250);
        await driver.send(new Uint8Array(candidate.pick));
        await driver.waitForOutput(3000, () => driver.screenText().includes(candidate.verify));
        samples.push({ label: `workspace.switch via ${candidate.label}`, ms: Date.now() - t0 });
        switched = true;
        break;
      } catch (e) {
        switchErrors.push(`${candidate.label}: ${(e as Error).message}`);
      }
    }
    if (!switched) failures.push(...switchErrors, "no candidate key sequence switched the TUI workspace");

    // terminal.input-delivery (TUI leg): focus the first fixture
    // workspace through herdr, click the pane to focus it, type a
    // unique token, and verify the pane echoes it back via
    // `herdr pane read`.
    try {
      const target = fixture.panes[0];
      execFileSync("herdr", ["--session", session, "workspace", "focus", target.workspaceId], {
        stdio: "pipe",
      });
      await new Promise((r) => setTimeout(r, 700));
      await driver.clickPane();
      await new Promise((r) => setTimeout(r, 300));
      // Which workspace is the TUI actually showing? ui-b's viewport ends
      // at "500", ui-a's at "400" — verify on the pane that is visible,
      // not on the one the CLI says is focused (the TUI may lag the
      // server-side focus change).
      const screen = driver.screenText();
      const paneId = screen.includes("500") ? fixture.panes[1].paneId : target.paneId;
      const token = `tui-${Date.now().toString(36)}`;
      const t0 = Date.now();
      await driver.sendText(token);
      await driver.send(new Uint8Array([0x0d]));
      const deadline = Date.now() + 3000;
      let seen = false;
      while (Date.now() < deadline) {
        if (herdrPaneRead(session, paneId).includes(token)) {
          seen = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!seen) throw new Error(`pane ${paneId} did not echo ${token} within 3000ms`);
      samples.push({ label: "terminal.input-delivery", ms: Date.now() - t0 });
    } catch (e) {
      failures.push(`terminal.input-delivery: ${(e as Error).message}`);
    }

    // scroll, staged: prefix+[ enters copy mode (per herdr docs; the
    // inventory's edit_scrollback is prefix+e — try both), PageUp moves
    // into scrollback, q leaves. Each stage must visibly change the
    // screen or the measurement fails.
    const scrollOpeners: { label: string; keys: number[] }[] = [
      { label: "prefix+[ (copy mode)", keys: [CTRL_B, 0x5b] },
      { label: "prefix+e (edit scrollback)", keys: [CTRL_B, 0x65] },
    ];
    let scrolled = false;
    const scrollErrors: string[] = [];
    for (const opener of scrollOpeners) {
      const t0 = Date.now();
      try {
        // Mode entry (copy/edit mode) may repaint attributes only — no
        // text diff — so the opener stage waits for the next output
        // event, not a screen-text change. The scroll itself MUST change
        // the visible text.
        await driver.send(new Uint8Array(opener.keys));
        await driver.waitFor((e) => e.type === "out", 2000).catch(() => null);
        await sleep(250);
        const mid = driver.screenText();
        await driver.send(new Uint8Array([0x1b, 0x5b, 0x35, 0x7e])); // PageUp
        await driver.waitForOutput(3000, () => driver.screenText() !== mid);
        samples.push({ label: `scroll via ${opener.label} → PageUp`, ms: Date.now() - t0 });
        scrolled = true;
        break;
      } catch (e) {
        scrollErrors.push(`scroll via ${opener.label}: ${(e as Error).message}`);
        // leave whatever mode we may have entered before trying the next
        await driver.send(new Uint8Array([0x71])); // 'q'
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!scrolled) failures.push(...scrollErrors, "no scroll key sequence changed the TUI screen");
  } finally {
    await driver.quit();
  }

  return {
    phase: "tui",
    pass: failures.length === 0,
    failures,
    details: { session, panes: fixture.panes.length, samples },
  };
}

/* ------------------------------------------------------------------ */
/* soak phase (stability.long-run)                                     */
/* ------------------------------------------------------------------ */

/**
 * Sustained-use leg of stability.long-run: keep a client attached while
 * the fixture panes keep producing output, and probe it on a fixed
 * cadence. Every probe is deadline-bounded — a hang is a failure, never
 * a slow success. Memory is sampled so growth is visible in the report.
 */
export async function soakGui(
  cdpPort: number,
  session: string,
  fixture: Fixture,
  durationMs: number,
  intervalMs: number,
): Promise<PhaseResult> {
  const failures: string[] = [];
  const probes: { at: number; ok: boolean; ms?: number; heapMb?: number }[] = [];
  const cdp = await CdpClient.connect({ port: cdpPort, callMs: 10_000, discoverMs: 30_000 });
  const [a, b] = fixture.panes;
  let toggle = false;
  try {
    // Operability gate: on a loaded host the packaged app can take tens
    // of seconds to render the sidebar. Probing before that produces
    // harness artifacts ("no visible element"), not product failures —
    // wait for the real precondition, bounded, and fail once if it
    // never arrives.
    const readyDeadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const s = await observeState(cdp).catch(() => null);
      const box = a
        ? await visibleBox(cdp, `[data-sidebar-workspace="${a.workspaceId}"]`).catch(() => null)
        : null;
      if (s?.route && box) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    if (!ready) {
      failures.push("app never became operable for soak (60s bound)");
      return {
        phase: "stability.gui-soak",
        pass: false,
        failures,
        details: { durationMs, intervalMs, probes: 0 },
      };
    }
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        // Alternate workspace switches — the heaviest routine operation.
        const target = toggle && a && b ? b : a;
        toggle = !toggle;
        if (target) {
          // Soak probes measure *hangs*, not latency: the deadline is a
          // liveness bound, deliberately looser than the 2s operation
          // contract the gui phase enforces.
          await measureWorkspaceSwitch(cdp, target.workspaceId, 10_000);
        }
        const s = await observeState(cdp);
        if (!s.route) throw new Error("observe() returned no route");
        const metrics = await cdp.send<{ metrics: { name: string; value: number }[] }>(
          "Performance.getMetrics",
        );
        const heap =
          metrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value ??
          (await cdp
            .evaluate<number | undefined>("performance.memory?.usedJSHeapSize")
            .catch(() => undefined));
        probes.push({
          at: Date.now(),
          ok: true,
          ms: Date.now() - t0,
          ...(typeof heap === "number" ? { heapMb: Math.round(heap / 1048576) } : {}),
        });
      } catch (e) {
        probes.push({ at: Date.now(), ok: false });
        failures.push(`soak probe at +${Date.now() - (deadline - durationMs)}ms: ${(e as Error).message}`);
      }
      await sleep(intervalMs);
    }
  } finally {
    await cdp.close();
  }
  const heaps = probes.map((p) => p.heapMb).filter((h): h is number => typeof h === "number");
  return {
    phase: "stability.gui-soak",
    pass: failures.length === 0,
    failures,
    details: {
      durationMs,
      intervalMs,
      probes: probes.length,
      heapMb: heaps.length ? { first: heaps[0], last: heaps[heaps.length - 1], max: Math.max(...heaps) } : null,
    },
  };
}

export async function soakTui(
  session: string,
  fixture: Fixture,
  durationMs: number,
  intervalMs: number,
): Promise<PhaseResult> {
  const failures: string[] = [];
  const probes: { at: number; ok: boolean; ms?: number }[] = [];
  const driver = await TuiDriver.start({ session, rows: 30, cols: 100 });
  const deadline = Date.now() + durationMs;
  try {
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < deadline) {
      const t0 = Date.now();
      try {
        // Inject output into EVERY fixture pane through herdr itself;
        // each pane's `cat` echoes it, so whichever workspace the TUI is
        // showing must repaint. The measured quantity is output ->
        // visible change, i.e. real responsiveness.
        const before = driver.screenText();
        for (const pane of fixture.panes) {
          execFileSync("herdr", ["--session", session, "pane", "send-text", pane.paneId, `soak-${probes.length}`], {
            stdio: "pipe",
          });
          execFileSync("herdr", ["--session", session, "pane", "send-keys", pane.paneId, "Enter"], {
            stdio: "pipe",
          });
        }
        await driver.waitForOutput(2000, () => driver.screenText() !== before);
        probes.push({ at: Date.now(), ok: true, ms: Date.now() - t0 });
      } catch (e) {
        probes.push({ at: Date.now(), ok: false });
        failures.push(`tui soak probe: ${(e as Error).message}`);
      }
      await sleep(intervalMs);
    }
  } finally {
    await driver.quit();
  }
  return {
    phase: "stability.tui-soak",
    pass: failures.length === 0,
    failures,
    details: { durationMs, intervalMs, probes: probes.length },
  };
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

export interface ComparisonReport {
  format: "hoxay/tui-parity-report";
  version: 1;
  git_sha: string;
  recorded_at: string;
  host: { platform: string; arch: string; loadavg: number[]; cpus: number };
  herdr_version: string;
  phases: PhaseResult[];
  catalog: { id: string; dimension: string; evidence: string; reference?: string }[];
  open_items: { id: string; dimension: string; evidence: string; note?: string }[];
}

export function computeOpenItems(phases: PhaseResult[]): ComparisonReport["open_items"] {
  const passById = new Map(phases.map((p) => [p.phase, p.pass]));
  return CATALOG.filter((s) => {
    if (s.evidence === "measured") {
      // a measured row is closed only when EVERY phase that evidences
      // it ran and passed; a phase that never ran is an open item,
      // never a silent pass
      const required = s.phases ?? [s.id.split(".")[0]];
      return required.some((p) => passById.get(p) !== true);
    }
    return s.evidence !== "contract";
  }).map((s) => ({
    id: s.id,
    dimension: s.dimension,
    evidence: s.evidence,
    ...(s.note ? { note: s.note } : {}),
  }));
}

export function buildReport(phases: PhaseResult[]): ComparisonReport {
  const catalog = CATALOG.map((s) => ({
    id: s.id,
    dimension: s.dimension,
    evidence: s.evidence,
    ...(s.reference ? { reference: s.reference } : {}),
  }));
  const openItems = computeOpenItems(phases);

  return {
    format: "hoxay/tui-parity-report",
    version: 1,
    git_sha: gitSha(),
    recorded_at: new Date().toISOString(),
    host: {
      platform: platform(),
      arch: arch(),
      loadavg: loadavg(),
      cpus: cpus().length,
    },
    herdr_version: loadInventory().derived_from.herdr_version,
    phases,
    catalog,
    open_items: openItems,
  };
}

function writeEvidence(dir: string, report: ComparisonReport): void {
  const path = join(dir, "report.json");
  let merged = report;
  try {
    // Phases run one invocation at a time; merge into the existing
    // report for the same SHA so evidence accumulates instead of each
    // phase overwriting the last.
    const prev = JSON.parse(readFileSync(path, "utf8")) as ComparisonReport;
    if (prev.git_sha === report.git_sha && Array.isArray(prev.phases)) {
      const byPhase = new Map(prev.phases.map((p) => [p.phase, p]));
      for (const p of report.phases) byPhase.set(p.phase, p);
      const mergedPhases = [...byPhase.values()];
      // open_items must reflect the MERGED phase set — computing it
      // from this invocation alone would resurrect rows whose evidence
      // already passed in an earlier phase run.
      merged = { ...report, phases: mergedPhases, open_items: computeOpenItems(mergedPhases) };
    }
  } catch {
    /* no prior report — write fresh */
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const [phase, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const dir = phase === "seed" ? "" : evidenceDir(opts);
  const phases: PhaseResult[] = [];

  switch (phase) {
    case "capability": {
      const { result } = capabilityPhase();
      phases.push(result);
      break;
    }
    case "efficiency": {
      const { result } = efficiencyPhase();
      phases.push(result);
      break;
    }
    case "floor": {
      const session = opts["session"] ?? "ht3parityfloor";
      const { result } = await floorPhase(session);
      phases.push(result);
      break;
    }
    case "seed": {
      const session = opts["session"] ?? "ht3parity";
      const fixture = await seedFixture({ session });
      const target = opts["fixture-out"];
      if (target) {
        writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
      } else {
        console.log(JSON.stringify(fixture, null, 2));
      }
      return 0;
    }
    case "gui": {
      const port = Number(opts["cdp-port"] ?? process.env.CDP_PORT ?? "0");
      if (!port) {
        console.error("gui phase needs --cdp-port");
        return 2;
      }
      const session = opts["session"] ?? "ht3parity";
      const fixturePath = opts["fixture"] ?? process.env.HERDR_T3_FIXTURE;
      const preset = fixturePath
        ? (JSON.parse(await Bun.file(fixturePath).text()) as Fixture)
        : undefined;
      phases.push(await guiPhase(port, session, preset));
      break;
    }
    case "tui": {
      const session = opts["session"] ?? "ht3paritytui";
      const fixturePath = opts["fixture"] ?? process.env.HERDR_T3_FIXTURE;
      const preset = fixturePath
        ? (JSON.parse(await Bun.file(fixturePath).text()) as Fixture)
        : undefined;
      phases.push(await tuiPhase(session, preset));
      break;
    }
    case "soak-gui": {
      const port = Number(opts["cdp-port"] ?? process.env.CDP_PORT ?? "0");
      if (!port) {
        console.error("soak-gui needs --cdp-port");
        return 2;
      }
      const session = opts["session"] ?? "ht3parity";
      const fixturePath = opts["fixture"] ?? process.env.HERDR_T3_FIXTURE;
      const fixture = fixturePath
        ? (JSON.parse(await Bun.file(fixturePath).text()) as Fixture)
        : await seedFixture({ session });
      phases.push(
        await soakGui(
          port,
          session,
          fixture,
          Number(opts["duration-ms"] ?? 600_000),
          Number(opts["interval-ms"] ?? 5_000),
        ),
      );
      break;
    }
    case "soak-tui": {
      const session = opts["session"] ?? "ht3paritytui";
      const fixturePath = opts["fixture"] ?? process.env.HERDR_T3_FIXTURE;
      // Re-seeding here would close the workspaces the attached TUI is
      // displaying — reuse the fixture the wrapper already seeded.
      const fixture = fixturePath
        ? (JSON.parse(await Bun.file(fixturePath).text()) as Fixture)
        : await seedFixture({ session });
      phases.push(
        await soakTui(
          session,
          fixture,
          Number(opts["duration-ms"] ?? 600_000),
          Number(opts["interval-ms"] ?? 5_000),
        ),
      );
      break;
    }
    case "all": {
      phases.push(capabilityPhase().result);
      phases.push(efficiencyPhase().result);
      break;
    }
    default:
      console.error("usage: run.ts <capability|efficiency|floor|gui|tui|soak-gui|soak-tui|all> [options]");
      return 2;
  }

  if (phase !== "seed") {
    const report = buildReport(phases);
    writeEvidence(dir, report);
    console.log(`evidence: ${join(dir, "report.json")}`);
  }
  for (const p of phases) {
    console.log(`${p.pass ? "PASS" : "FAIL"} ${p.phase}${p.failures.length ? ` — ${p.failures.join("; ")}` : ""}`);
  }
  return phases.every((p) => p.pass) ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
