/*
 * Workspace canvas session-state contract (issue #421).
 *
 * Maps the bridge's real signals — held snapshot, probe flag, machine
 * status, per-machine fetch error/pending, bridge connection — onto the
 * canvas's display states, so loading, probe-only, stale, disabled,
 * error and genuinely-empty are never collapsed into one explanatory
 * message. State authority stays with herdr: this module only decides
 * what an already-fetched (or absent) snapshot may be presented as.
 *
 * Upstream lifecycle evidence (herdr @ e8d7d97):
 * - `AppState::close_workspaces` removes workspaces and, when the list
 *   empties, sets `active = None` — the server session keeps running
 *   (`src/app/actions.rs`). `workspace.close`, `pane.close` on the last
 *   pane and `tab.close` on the last tab all funnel into it, so a live
 *   session snapshot with `workspaces: []` is a real, reachable state.
 * - `session_snapshot` then reports `focused_workspace_id: null` and
 *   empty lists (`src/app/api/session.rs`); `workspace.create` still
 *   works from that state (`src/app/api/workspaces.rs`,
 *   `src/app/creation.rs`), which is the recovery path.
 * - A tab never persists with zero panes and a workspace never persists
 *   with zero tabs (`src/workspace.rs` `close_pane`/`close_active_tab`),
 *   so "workspace resolved but no panes" is anomalous/transient only.
 */
import type { MachineInfo, SessionSnapshot } from "../../shared/protocol";
import { machineStale } from "./view";

export type CanvasSessionState =
  /** Machine is hard-down but a snapshot (live or probe) is held: last-known data, not live. */
  | { kind: "stale" }
  /** Machine is hard-down and nothing is held — unreachable/offline/error/auth/incompatible. */
  | { kind: "down" }
  /** Machine is disabled in herdr's registry; ensureMachine refuses it. */
  | { kind: "disabled" }
  /** Bridge WS to the herdr-t3 server is not open and no live data is held. */
  | { kind: "bridge"; connection: "connecting" | "closed" }
  /** Last connect/fetch for this machine failed; nothing live is held. */
  | { kind: "error"; message: string }
  /** A connect+fetch is in flight, or only a probe snapshot is held. */
  | { kind: "connecting" }
  /** Awaiting the first snapshot with no error/pending signal yet. */
  | { kind: "loading" }
  /** A live (non-probe) snapshot is held — render the derived workspace view. */
  | { kind: "live" };

export interface CanvasSessionInput {
  /** Held snapshot for the resolved machine, or null before the first push/fetch. */
  snapshot: SessionSnapshot | null;
  /** `bridge.probeSnapshots[machine]` — held data is probe-sourced, not a session. */
  probeSnapshot: boolean;
  machineInfo: MachineInfo | undefined;
  bridgeConnection: "connecting" | "open" | "closed";
  /** `bridge.errors[machine]` — last connect/fetch failure detail. */
  machineError: string | undefined;
  /** `bridge.pendingMachines[machine]` — connect+fetch in flight. */
  machinePending: boolean;
}

/**
 * Resolve which session-level presentation the canvas may show.
 *
 * Ordering rules:
 * - disabled beats stale: a disabled machine's held snapshot is not
 *   "last-known live data" the user can reconnect into — ensureMachine
 *   refuses it, so it gets its own state with no retry action.
 * - hard-down with held data is `stale`; hard-down with nothing held is
 *   `down` — both get the same restrained notice + Reconnect affordance;
 *   the held snapshot stays last-known data and is never rendered as
 *   live panes (the sidebar hides stale machines' rows the same way).
 * - probe snapshots never reach `live`: they are list data (issue #212),
 *   so a probe-only machine resolves to `connecting` while its session
 *   is being brought up (explicit routes trigger ensureMachine; the
 *   default route never selects probe-only machines — see view.ts).
 * - `error` beats `connecting`/`loading`: a failed fetch must surface
 *   instead of spinning forever.
 */
export function resolveCanvasSession(input: CanvasSessionInput): CanvasSessionState {
  const { snapshot, probeSnapshot, machineInfo } = input;
  const held = snapshot !== null;
  const live = held && !probeSnapshot;

  if (machineInfo?.enabled === false) return { kind: "disabled" };
  if (machineStale(machineInfo)) return held ? { kind: "stale" } : { kind: "down" };
  if (live) return { kind: "live" };

  if (input.bridgeConnection !== "open") {
    return { kind: "bridge", connection: input.bridgeConnection };
  }
  if (input.machineError) return { kind: "error", message: input.machineError };
  if (input.machinePending || probeSnapshot) return { kind: "connecting" };
  if (
    machineInfo?.status === "connecting" ||
    machineInfo?.status === "reconnecting"
  ) {
    return { kind: "connecting" };
  }
  return { kind: "loading" };
}
