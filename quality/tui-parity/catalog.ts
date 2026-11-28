/**
 * Canonical comparison catalogue: herdr TUI (baseline) ⇄ hoxay
 * (issue #640).
 *
 * This file is the *正本* of what "can hoxay replace the herdr TUI for
 * daily work" is measured against. Every row states:
 *
 *   - the dimension being compared,
 *   - what the TUI does (the baseline) and what hoxay must match,
 *   - the deadline one operation must stay inside,
 *   - the pass criterion,
 *   - how the row is evidenced: `measured` (this harness measures it),
 *     `contract` (an existing, already-passed contract proves it — the
 *     reference is named and is NOT re-run), `manual` (only a human can
 *     exercise it; the procedure is fixed here), or `not-run`.
 *
 * A row that is not `measured` is never silently a pass: the report has
 * to carry it as an open item.
 */

export type Dimension =
  | "capability"
  | "startup"
  | "terminal-input"
  | "mouse"
  | "scroll"
  | "pane-ops"
  | "agent-management"
  | "reconnect"
  | "operational-efficiency"
  | "response-performance"
  | "long-run-stability";

export type SideDriver = "pty" | "cdp" | "cli" | "static" | "none";

export interface ScenarioSide {
  driver: SideDriver;
  /** what is done on this side */
  action: string;
  /** what counts as "done" on this side */
  expectation: string;
}

export interface Scenario {
  id: string;
  dimension: Dimension;
  /** the capability under comparison */
  capability: string;
  tui: ScenarioSide;
  hoxay: ScenarioSide;
  /** deadline for a single operation on either side */
  deadlineMs: number;
  /** pass criterion, stated so a reader can disagree with it */
  criterion: string;
  evidence: "measured" | "contract" | "manual" | "not-run";
  /** for `contract` rows: the already-passed evidence that covers it */
  reference?: string;
  /** for `manual` rows: the fixed procedure */
  procedure?: string;
  /**
   * For `measured` rows: the run.ts phases whose PASS closes this row.
   * Defaults to the scenario id's first segment. A row stays open until
   * EVERY listed phase has run and passed — a phase that never ran is
   * never a silent pass.
   */
  phases?: string[];
  /** notes / known caveats */
  note?: string;
}

export const CATALOG: Scenario[] = [
  {
    id: "capability.rpc-surface",
    dimension: "capability",
    capability: "herdr JSON API reachability from the client",
    tui: {
      driver: "static",
      action: "the TUI drives the same server API (102 methods in herdr 0.9.5)",
      expectation: "every method a client needs is reachable",
    },
    hoxay: {
      driver: "static",
      action: "bridge whitelist (shared/protocol.ts) is compared against the herdr API and the canonical table",
      expectation: "no method is reachable-but-unclassified, and no whitelisted method is unknown to herdr",
    },
    deadlineMs: 5000,
    criterion:
      "quality/tui-parity/lib/capability.ts: every herdr method is implemented by the bridge or explicitly classified in docs/design/herdr-parity.md",
    evidence: "measured",
    phases: ["capability"],
  },
  {
    id: "capability.tui-only-features",
    dimension: "capability",
    capability: "features the TUI has that hoxay does not",
    tui: {
      driver: "static",
      action: "the derived inventory lists every TUI-visible feature (modes, overlays, copy mode, agent view, mouse reporting)",
      expectation: "the full TUI surface is enumerated",
    },
    hoxay: {
      driver: "static",
      action: "each enumerated feature is mapped to a hoxay surface or declared absent",
      expectation: "no TUI feature is silently missing",
    },
    deadlineMs: 5000,
    criterion:
      "every TUI feature in quality/tui-parity/tui/inventory.json is either implemented in hoxay or listed as an accepted deficit in docs/design/tui-parity.md",
    evidence: "measured",
    phases: ["capability"],
  },
  {
    id: "startup.packaged-5s",
    dimension: "startup",
    capability: "packaged app spawn → operable",
    tui: {
      driver: "pty",
      action: "attach to an existing session and wait for the first rendered frame",
      expectation: "the TUI is usable",
    },
    hoxay: {
      driver: "cdp",
      action: "spawn the packaged app and probe the operable state",
      expectation: "operable within the 5s product contract",
    },
    deadlineMs: 5000,
    criterion: "spawn → operable ≤ 5000 ms (the 5s product contract, #601/#603)",
    evidence: "measured",
    phases: ["gui"],
    reference: "#601/#603 established the measurement path; #640 re-runs it on the current candidate",
  },
  {
    id: "response.workspace-switch",
    dimension: "response-performance",
    capability: "switching the focused workspace",
    tui: {
      driver: "pty",
      action: "press the workspace-switch keys and wait for the visible screen to change",
      expectation: "the screen reflects the new workspace",
    },
    hoxay: {
      driver: "cdp",
      action: "click the workspace row and wait for the app's own observation to report the new selection",
      expectation: "the app reports the new selection",
    },
    deadlineMs: 1000,
    criterion:
      "each side's own overhead above the shared herdr floor is ≤ 1000 ms, and hoxay's total is not more than 3× the TUI's total",
    evidence: "measured",
    phases: ["gui", "tui"],
    note: "the shared herdr round trip is measured separately (engine floor) so the comparison is client overhead, not wire time",
  },
  {
    id: "response.scroll",
    dimension: "response-performance",
    capability: "scrolling the focused pane's scrollback",
    tui: {
      driver: "pty",
      action: "scroll and wait for the visible screen to change",
      expectation: "the scrollback moves",
    },
    hoxay: {
      driver: "cdp",
      action: "wheel the terminal and wait for the app to report a new scroll offset",
      expectation: "the offset changes",
    },
    deadlineMs: 1000,
    criterion: "same as response.workspace-switch",
    evidence: "measured",
    phases: ["gui", "tui"],
  },
  {
    id: "terminal.input-delivery",
    dimension: "terminal-input",
    capability: "typed input reaches the pane through the client",
    tui: {
      driver: "pty",
      action: "type into the focused pane",
      expectation: "the pane receives the bytes (the fixture pane records what it received)",
    },
    hoxay: {
      driver: "cdp",
      action: "type into the focused terminal surface",
      expectation: "the pane receives the bytes (the fixture pane records what it received)",
    },
    deadlineMs: 3000,
    criterion:
      "the pane's recorded bytes match what was typed, on both sides; the delivery path differs (pty vs attach stream) but the observable result is identical",
    evidence: "measured",
    phases: ["gui", "tui"],
    reference: "#434/#478 covered bracketed-paste delivery on the GUI side; #640 adds the TUI side of the same check",
  },
  {
    id: "terminal.paste-multiline",
    dimension: "terminal-input",
    capability: "multi-line paste delivered as one bracketed-paste payload",
    tui: {
      driver: "pty",
      action: "paste two lines into the pane",
      expectation: "the pane receives them without unintended per-line commit",
    },
    hoxay: {
      driver: "cdp",
      action: "paste two lines into the terminal surface",
      expectation: "the pane receives them without unintended per-line commit",
    },
    deadlineMs: 3000,
    criterion: "the pane's recorded bytes are identical on both sides for the same pasted content",
    evidence: "contract",
    reference: "#434/#478 (GUI side, PASS); the TUI side is covered by the same contract in the upstream client",
  },
  {
    id: "terminal.ime-composition",
    dimension: "terminal-input",
    capability: "CJK IME composition reaches the pane exactly once",
    tui: {
      driver: "manual",
      action: "compose Japanese text in the focused pane",
      expectation: "one commit, no leaked keys",
    },
    hoxay: {
      driver: "manual",
      action: "compose Japanese text in the focused pane",
      expectation: "one commit, no leaked keys",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour (docs/design/terminal-io.md §7)",
    evidence: "contract",
    reference: "src/lib/ghostty/inputPolicy.test.ts (deterministic half) + docs/design/verification.md row 1 (real IME leg)",
  },
  {
    id: "mouse.capture-reporting",
    dimension: "mouse",
    capability: "mouse events reach a mouse-capturing app (vim/htop) instead of selecting text",
    tui: {
      driver: "manual",
      action: "click and drag inside a mouse-reporting pane",
      expectation: "the app receives the events",
    },
    hoxay: {
      driver: "manual",
      action: "click and drag inside a mouse-reporting pane",
      expectation: "the app receives the events",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour (docs/design/terminal-io.md §7)",
    evidence: "contract",
    reference: "docs/design/verification.md rows 4–6 (real-machine checklist)",
  },
  {
    id: "mouse.shift-drag-select",
    dimension: "mouse",
    capability: "shift-drag selects locally without sending to the app",
    tui: {
      driver: "manual",
      action: "shift-drag across text in a mouse-capturing pane",
      expectation: "the app receives no mouse events; the selection is local",
    },
    hoxay: {
      driver: "manual",
      action: "shift-drag across text in a mouse-capturing pane",
      expectation: "the app receives no mouse events; the selection is local",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour",
    evidence: "contract",
    reference: "docs/design/verification.md row 5; #427 (inverse drag), #433 (edge auto-scroll), #436 (scroll follow), #440/#441 (copy-on-select, overlay motion)",
  },
  {
    id: "scroll.selection-and-copy",
    dimension: "scroll",
    capability: "selecting text across scrollback and copying it",
    tui: {
      driver: "manual",
      action: "select across screen boundaries in copy mode and yank",
      expectation: "the copied text matches the selection",
    },
    hoxay: {
      driver: "manual",
      action: "select across screen boundaries and copy",
      expectation: "the copied text matches the selection",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour",
    evidence: "contract",
    reference: "#427/#433/#436/#440/#441 (GUI side, PASS); the TUI's copy mode is the baseline behaviour",
  },
  {
    id: "pane-ops.equivalence",
    dimension: "pane-ops",
    capability: "split / zoom / focus / rename / close panes and tabs",
    tui: {
      driver: "cli",
      action: "the same operations expressed with the TUI's prefix bindings",
      expectation: "the resulting layout is identical",
    },
    hoxay: {
      driver: "cdp",
      action: "the same operations expressed with the GUI's controls",
      expectation: "the resulting layout is identical",
    },
    deadlineMs: 2000,
    criterion:
      "the resulting layout tree is identical on both sides, and every operation is reachable in the GUI without a keyboard mode",
    evidence: "not-run",
    note:
      "GUI pane ops are covered piecemeal by the #413 RC evidence and docs/design/verification.md, but an automated identical-layout-tree comparison against the TUI does not exist yet — left open rather than claimed",
    procedure:
      "manual: perform split/zoom/focus/rename/close on both clients against the same fixture and diff `herdr pane layout` / `tab get` output",
  },
  {
    id: "agent.management",
    dimension: "agent-management",
    capability: "seeing agent state and acting on a blocked agent",
    tui: {
      driver: "manual",
      action: "read the agent sidebar, jump to a blocked agent, answer its prompt",
      expectation: "the agent's state and prompt are visible and answerable",
    },
    hoxay: {
      driver: "manual",
      action: "read the Agents shelves, jump to a blocked agent, answer its prompt",
      expectation: "the agent's state and prompt are visible and answerable",
    },
    deadlineMs: 5000,
    criterion:
      "identical capability; prompt answers go through agent.prompt on both sides (AGENTS.md §3 — never guessed digit keys)",
    evidence: "contract",
    reference: "#151 (agent shelves), #113 (agent actions), docs/design/verification.md row 7",
  },
  {
    id: "reconnect.draft-preserved",
    dimension: "reconnect",
    capability: "reconnecting after an outage without losing typed input",
    tui: {
      driver: "manual",
      action: "kill the server while a draft is pending, reconnect, and send the draft explicitly",
      expectation: "nothing is sent automatically; the draft survives",
    },
    hoxay: {
      driver: "manual",
      action: "kill the bridge while a draft is pending, reconnect, and send the draft explicitly",
      expectation: "nothing is sent automatically; the draft survives",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour (AGENTS.md §3)",
    evidence: "contract",
    reference: "#5 / scripts/verify-reconnect-draft.ts (GUI side, PASS on both OS)",
  },
  {
    id: "reconnect.resume-session",
    dimension: "reconnect",
    capability: "reattaching to a live session keeps the sessions alive",
    tui: {
      driver: "manual",
      action: "detach and reattach",
      expectation: "every agent keeps running",
    },
    hoxay: {
      driver: "manual",
      action: "quit and relaunch the app",
      expectation: "every agent keeps running",
    },
    deadlineMs: 5000,
    criterion: "identical observable behaviour; the GUI must never kill herdr sessions on close",
    evidence: "contract",
    reference: "#5 (session survival), AGENTS.md §3",
  },
  {
    id: "efficiency.actions-per-task",
    dimension: "operational-efficiency",
    capability: "how many user actions a common task costs on each client",
    tui: {
      driver: "static",
      action: "count the keystrokes the documented keybindings require",
      expectation: "a small, bounded number",
    },
    hoxay: {
      driver: "static",
      action: "count the pointer/keyboard actions the GUI requires",
      expectation: "no more actions than the TUI for the same task",
    },
    deadlineMs: 1000,
    criterion: "for every task in the efficiency catalogue, hoxay's action count is ≤ the TUI's",
    evidence: "measured",
    phases: ["efficiency"],
    note: "counts come from the derived keybinding inventory and from hoxay's own control inventory — both re-derivable",
  },
  {
    id: "stability.long-run",
    dimension: "long-run-stability",
    capability: "sustained use without memory growth, hangs or session loss",
    tui: {
      driver: "pty",
      action: "keep the TUI attached while the fixture produces output",
      expectation: "no hang, no lost session",
    },
    hoxay: {
      driver: "cdp",
      action: "keep the app attached while the fixture produces output",
      expectation: "no hang, no lost session",
    },
    deadlineMs: 900000,
    criterion:
      "neither side hangs (every wait deadline-bounded) and memory stays inside the product's memory budget (server/metrics.ts)",
    evidence: "measured",
    phases: ["stability.gui-soak", "stability.tui-soak"],
    note:
      "the soak legs keep each client attached under fixture output and probe on a fixed cadence; the memory-budget half is measured separately by scripts/perf-memory-bench.ts (#499)",
  },
  {
    id: "workflow.continuous-development",
    dimension: "response-performance",
    capability: "a continuous development session (editor + agent + shell) completes without falling back to the TUI",
    tui: {
      driver: "manual",
      action: "the reference workflow on the TUI",
      expectation: "the workflow completes",
    },
    hoxay: {
      driver: "manual",
      action: "the same workflow on hoxay",
      expectation: "the workflow completes without a TUI fallback",
    },
    deadlineMs: 3600000,
    criterion:
      "the workflow completes on hoxay with no fallback to the TUI and no interruption; the procedure is fixed in docs/design/tui-parity.md",
    evidence: "manual",
    procedure: "see docs/design/tui-parity.md §「一連の開発作業の通し検証」",
  },
];

export function byDimension(): Map<Dimension, Scenario[]> {
  const out = new Map<Dimension, Scenario[]>();
  for (const s of CATALOG) {
    const list = out.get(s.dimension) ?? [];
    list.push(s);
    out.set(s.dimension, list);
  }
  return out;
}

export function measuredScenarios(): Scenario[] {
  return CATALOG.filter((s) => s.evidence === "measured");
}
