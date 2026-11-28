/**
 * hoxay (packaged GUI) side of the herdr TUI ⇄ hoxay comparison
 * (issue #640).
 *
 * Every measurement here is an *end-to-end* one: the user's input is
 * synthesized through the real app (CDP mouse/keyboard) and the stop
 * condition is an observable state change in the running product. The
 * measurement resolution is one poll interval (16 ms) plus one CDP
 * round trip, so the numbers are comparable between runs but should be
 * read as "±20 ms", not as precision.
 */
import { CdpClient, clickSelector, insertText, pollUntil, wheelSelector } from "./cdp.ts";

export interface LatencySample {
  operation: string;
  /** ms from input dispatch to the first observed state change */
  ms: number;
  deadlineMs: number;
  detail?: Record<string, unknown>;
}

export class MeasurementTimeout extends Error {
  constructor(operation: string, deadlineMs: number) {
    super(`${operation}: no state change within ${deadlineMs}ms`);
    this.name = "MeasurementTimeout";
  }
}

/** The app's own read-only observation surface (src/lib/uiObserve.ts). */
export interface UiState {
  route: string;
  selected_workspace: string | null;
  sidebar_open: boolean | null;
  appearance_mode: string;
  theme_resolved: "dark" | "light";
  terminals: Record<string, number>;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
}

export async function observeState(cdp: CdpClient): Promise<UiState> {
  return cdp.evaluate<UiState>("window.__herdrT3Ui.observe()");
}

/**
 * Dispatch an input, then poll until `ready()` returns true. The
 * returned sample is the measured latency. A deadline breach throws —
 * a timeout is never a successful measurement.
 */
export async function measureLatency(
  operation: string,
  dispatch: () => Promise<void>,
  ready: () => Promise<boolean>,
  deadlineMs: number,
  detail?: Record<string, unknown>,
): Promise<LatencySample> {
  const t0 = Date.now();
  await dispatch();
  try {
    await pollUntil(ready, deadlineMs, 16);
  } catch {
    throw new MeasurementTimeout(operation, deadlineMs);
  }
  // pollUntil's deadline is checked between polls; a single blocked CDP
  // evaluate can overshoot it. The contract is wall-clock: a response
  // that lands after the deadline is a breach, not a slow success.
  const elapsed = Date.now() - t0;
  if (elapsed > deadlineMs) throw new MeasurementTimeout(operation, deadlineMs);
  return { operation, ms: elapsed, deadlineMs, ...(detail ? { detail } : {}) };
}

/** Click a sidebar workspace row and wait until it becomes the selection. */
export async function measureWorkspaceSwitch(
  cdp: CdpClient,
  workspaceId: string,
  deadlineMs: number,
): Promise<LatencySample> {
  return measureLatency(
    `workspace.switch(${workspaceId})`,
    async () => {
      await clickSelector(cdp, `[data-sidebar-workspace="${workspaceId}"]`);
    },
    async () => {
      const s = await observeState(cdp);
      return s.selected_workspace === workspaceId;
    },
    deadlineMs,
    { workspaceId },
  );
}

/** CSS selector for a pane's terminal host. The DOM marks it with
 *  `data-ui-terminal="${machine}\n${paneId}"` AND `data-pane-id`
 *  (PaneTerminal.tsx); the parity fixture only ever exercises the
 *  local machine, and a CSS string cannot hold the literal newline the
 *  ui-terminal key contains, so `data-pane-id` is the usable hook. */
export function terminalSelector(paneId: string): string {
  return `[data-pane-id="${paneId}"]`;
}

/**
 * Wheel the focused terminal and wait until the app reports a
 * scrollback offset different from `fromOffset`.
 */
export async function measureScroll(
  cdp: CdpClient,
  paneId: string,
  rows: number,
  fromOffset: number,
  deadlineMs: number,
): Promise<LatencySample> {
  return measureLatency(
    `terminal.scroll(${rows})`,
    async () => {
      await wheelSelector(cdp, terminalSelector(paneId), rows);
    },
    async () => {
      const s = await observeState(cdp);
      const offset = s.terminals[`local\n${paneId}`];
      return typeof offset === "number" && offset !== fromOffset;
    },
    deadlineMs,
    { paneId, rows, fromOffset },
  );
}

/**
 * Type a line into the focused terminal. Delivery is verified out of
 * band (the fixture pane writes what it receives to a file) — the GUI
 * has no DOM surface for terminal cell content, and `pane.read` must
 * never be used to reconstruct an attached terminal (AGENTS.md §3).
 */
export async function typeIntoTerminal(
  cdp: CdpClient,
  text: string,
  deadlineMs: number,
): Promise<LatencySample> {
  return measureLatency(
    "terminal.input.type",
    async () => {
      await insertText(cdp, text);
    },
    async () => true, // dispatch completion is the observable boundary
    deadlineMs,
    { length: text.length },
  );
}

/** Read the app's route/selection snapshot (used for evidence). */
export async function snapshotState(cdp: CdpClient): Promise<UiState> {
  return observeState(cdp);
}
