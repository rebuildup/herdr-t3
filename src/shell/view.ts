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
  if (s.snapshots[LOCAL_MACHINE]) return LOCAL_MACHINE;
  const first = machineListOf(s).find((m) => s.snapshots[m.id]);
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

  // A routed machine without a snapshot gets connected + fetched on demand.
  useEffect(() => {
    if (isWorkspaceRoute && routedMachine && !bridge.snapshots[routedMachine]) {
      void ensureMachine(routedMachine);
    }
  }, [isWorkspaceRoute, routedMachine, bridge.snapshots]);

  return {
    machine,
    machineInfo,
    snapshot,
    view,
    explicit: routedWorkspace !== null,
    stale: snapshot !== null && machineStale(machineInfo),
  };
}
