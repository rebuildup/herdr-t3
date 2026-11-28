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
import { machineSelect } from "../lib/api";
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
  /**
   * True when the held snapshot came from a summary-mode session
   * (issue #585): sidebar-grade structure + agent status with canvas
   * detail stripped. Surfaces that need detail must wait for the full
   * snapshot the selection upgrade pushes.
   */
  summary: boolean;
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

  // A routed machine without a live full-detail snapshot gets connected +
  // fetched on demand. Probe snapshots (issue #212) render the lists but
  // are not a session, and summary snapshots (issue #585) are stripped —
  // an explicit route still brings the machine up. Selection itself is
  // declared once by useMachineSelection (App root), not per hook caller.
  const summarySnapshot = bridge.summarySnapshots[machine] === true;
  useEffect(() => {
    if (!isWorkspaceRoute) return;
    if (
      !bridge.snapshots[machine] ||
      bridge.probeSnapshots[machine] ||
      bridge.summarySnapshots[machine]
    ) {
      void ensureMachine(machine);
    }
  }, [
    isWorkspaceRoute,
    machine,
    bridge.snapshots,
    bridge.probeSnapshots,
    bridge.summarySnapshots,
  ]);

  return {
    machine,
    machineInfo,
    snapshot,
    view,
    explicit: routedWorkspace !== null,
    stale: snapshot !== null && machineStale(machineInfo),
    probe: snapshot !== null && bridge.probeSnapshots[machine] === true,
    summary: snapshot !== null && summarySnapshot,
  };
}

/**
 * Declare the detail machine to the bridge exactly once (issue #585).
 * Called from the App root — useRouteWorkspace has many callers and a
 * per-caller machine_select would spam the wire. The resolved machine is
 * the routed one, or the default machine on the default workspace route;
 * non-workspace routes (settings) keep the last selection. The
 * `bridge.connection` dep re-declares after a reconnect: a fresh
 * MachineManager knows no selection and would otherwise leave every
 * session — including local — in summary mode.
 */
export function useMachineSelection(): void {
  const route = useRoute();
  const bridge = useBridgeState();
  const isWorkspaceRoute = route.name === "workspace";
  const routedMachine = isWorkspaceRoute ? route.machine : null;
  const machine = isWorkspaceRoute
    ? (routedMachine ?? defaultMachine(bridge))
    : null;
  useEffect(() => {
    if (machine !== null) machineSelect(machine);
  }, [machine, bridge.connection]);
}
