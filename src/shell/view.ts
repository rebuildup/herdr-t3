/*
 * Route -> bridge view resolution (issue #84). The hash route selects
 * (machine, workspace); the bridge snapshot supplies everything else.
 * Route machine/workspace ids that no longer exist fall back to the
 * machine's herdr-focused workspace rather than rendering stale data.
 */
import { useEffect } from "react";
import type { MachineInfo, MachineStatus, SessionSnapshot } from "../../shared/protocol";
import { LOCAL_MACHINE } from "../lib/api";
import { deriveWorkspace, type WorkspaceView } from "../lib/workspace";
import {
  ensureMachine,
  machineListOf,
  useBridgeState,
  type ShellBridgeState,
} from "./bridge";
import { useRoute } from "./router";

export interface RouteWorkspace {
  /** Resolved machine id (route value, or the default machine). */
  machine: string;
  machineInfo: MachineInfo | undefined;
  snapshot: SessionSnapshot | null;
  /** Workspace view for the routed workspace (or the focused default). */
  view: WorkspaceView;
  /** True when the route named a machine/workspace explicitly. */
  explicit: boolean;
  /**
   * True when a snapshot exists but the machine is hard-down — the data is
   * last-known state, not current. Surfaces must not present it as live.
   */
  stale: boolean;
  /**
   * True when the held snapshot came from the reachability probe
   * (issue #212): real list data, but no live bridge session backs it.
   * Surfaces that need a session (canvas panes) must not render it as live.
   */
  probe: boolean;
}

/** Statuses where held data cannot be current (session unreachable/closed). */
export const MACHINE_STALE_STATUSES = new Set<MachineStatus>([
  "offline",
  "unreachable",
  "error",
  "disabled",
  "auth_required",
  "incompatible",
]);

export function machineStale(info: MachineInfo | undefined): boolean {
  return info !== undefined && MACHINE_STALE_STATUSES.has(info.status);
}

/**
 * True while any live (non-stale) machine has not yet delivered its first
 * snapshot — until then an empty workspace list means "not loaded", not
 * "empty" (anti-case AC-005, info-architecture.md §10). Stale machines are
 * excluded so a permanently offline machine cannot suppress the empty
 * state forever.
 */
export function awaitingFirstSnapshots(
  machines: MachineInfo[],
  snapshots: ShellBridgeState["snapshots"],
): boolean {
  return machines.some(
    (m) => !machineStale(m) && snapshots[m.id] === undefined,
  );
}

function defaultMachine(s: ShellBridgeState): string {
  // Probe snapshots (issue #212) are display data without a session; the
  // default route must land on a machine with a live snapshot, or local
  // (which initBridge ensures eagerly) when none exists (issue #421).
  if (s.snapshots[LOCAL_MACHINE] && !s.probeSnapshots[LOCAL_MACHINE]) {
    return LOCAL_MACHINE;
  }
  const first = machineListOf(s).find(
    (m) => s.snapshots[m.id] && !s.probeSnapshots[m.id],
  );
  return first?.id ?? LOCAL_MACHINE;
}

export function useRouteWorkspace(): RouteWorkspace {
  const route = useRoute();
  const bridge = useBridgeState();
  const isWorkspaceRoute = route.name === "workspace";
  const routedMachine = isWorkspaceRoute ? route.machine : null;
  const routedWorkspace = isWorkspaceRoute ? route.workspaceId : null;

  const machine = routedMachine ?? defaultMachine(bridge);
  const snapshot = bridge.snapshots[machine] ?? null;
  const view = deriveWorkspace(snapshot, routedWorkspace);
  const machineInfo = bridge.machines[machine];

  // A routed machine without a live snapshot gets connected + fetched on
  // demand. Probe snapshots (issue #212) render the lists but are not a
  // session — an explicit route still brings the machine up.
  useEffect(() => {
    if (
      isWorkspaceRoute &&
      routedMachine &&
      (!bridge.snapshots[routedMachine] || bridge.probeSnapshots[routedMachine])
    ) {
      void ensureMachine(routedMachine);
    }
  }, [isWorkspaceRoute, routedMachine, bridge.snapshots, bridge.probeSnapshots]);

  return {
    machine,
    machineInfo,
    snapshot,
    view,
    explicit: routedWorkspace !== null,
    stale: snapshot !== null && machineStale(machineInfo),
    probe: snapshot !== null && bridge.probeSnapshots[machine] === true,
  };
}
