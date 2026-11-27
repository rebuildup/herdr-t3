/*
 * Bridge-backed shell store (issue #84, ADR-0008 M2). Owns the bridge
 * connection lifecycle and per-machine session snapshots; the snapshot is
 * the single source of truth for machines/workspaces/tabs/panes. Mutations
 * go through the whitelisted herdr RPC contract — the UI never treats a
 * pending call as success; state changes arrive as pushed snapshots.
 *
 * Replaces the M1 fixture store (src/shell/store.ts) behind the same
 * shell contracts. Module-level store so palette/dialog handlers outside
 * the React tree can read state without prop drilling.
 */
import { useSyncExternalStore } from "react";
import type {
  MachineInfo,
  RpcMethod,
  SessionSnapshot,
} from "../../shared/protocol";
import {
  connectBridge,
  fetchSession,
  LOCAL_MACHINE,
  machineConnect,
  onMachineStatus,
  onMachines,
  onSnapshot,
  onStatus,
  rpc,
} from "../lib/api";
import { navigate, workspaceHash } from "./router";
import { startMemoryBudgetWatch } from "../lib/memoryBudget.ts";

export type BridgeConnection = "connecting" | "open" | "closed";

export interface ShellBridgeState {
  connection: BridgeConnection;
  /** machine id -> MachineInfo (local + saved SSH endpoints) */
  machines: Record<string, MachineInfo>;
  /** machine id -> latest session snapshot (absent until first push) */
  snapshots: Record<string, SessionSnapshot>;
  /** machine id -> last fetch/connect error message */
  errors: Record<string, string>;
  /** machine ids with a connect+fetch in flight */
  pendingMachines: Record<string, boolean>;
  /**
   * Machines whose held snapshot came from the server's reachability probe
   * (issue #212): displayable list data, but not backed by a live session.
   * ensureMachine treats these as absent so user actions still open a real
   * connection; the next non-probe snapshot clears the flag.
   */
  probeSnapshots: Record<string, boolean>;
}

let state: ShellBridgeState = {
  connection: "connecting",
  machines: {},
  snapshots: {},
  errors: {},
  pendingMachines: {},
  probeSnapshots: {},
};

const listeners = new Set<() => void>();
let started = false;

function setState(next: ShellBridgeState) {
  state = next;
  for (const listener of listeners) listener();
}

function patch(partial: Partial<ShellBridgeState>) {
  setState({ ...state, ...partial });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBridgeState(): ShellBridgeState {
  return state;
}

export function useBridgeState(): ShellBridgeState {
  return useSyncExternalStore(subscribe, getBridgeState, getBridgeState);
}

/** Sorted machine list: local first, then label order (T3 environment order). */
export function machineListOf(s: ShellBridgeState = state): MachineInfo[] {
  return Object.values(s.machines).sort((a, b) =>
    a.kind === "local" ? -1 : b.kind === "local" ? 1 : a.label.localeCompare(b.label),
  );
}

function setMachineError(machine: string, message: string | null) {
  const errors = { ...state.errors };
  if (message === null) delete errors[machine];
  else errors[machine] = message;
  patch({ errors });
}

function setPending(machine: string, pending: boolean) {
  const pendingMachines = { ...state.pendingMachines };
  if (pending) pendingMachines[machine] = true;
  else delete pendingMachines[machine];
  patch({ pendingMachines });
}

/** Machine statuses where a held snapshot is still plausibly current. */
const LIVE_STATUSES = new Set(["online", "connecting", "reconnecting"]);

/**
 * Ensure a machine has a live bridge session and a snapshot. Local is
 * fetched eagerly at connect; remote machines connect + fetch on demand.
 * A snapshot held for a machine whose status is hard-down is stale: the
 * call reconnects instead of returning it. Resolves with the snapshot or
 * null on failure — callers must not assume success.
 */
export function ensureMachine(machine: string): Promise<SessionSnapshot | null> {
  const existing = state.snapshots[machine];
  const info = state.machines[machine];
  if (info?.enabled === false) {
    setMachineError(machine, "machine is disabled");
    return Promise.resolve(null);
  }
  // A probe snapshot is list data, not a session: callers that reach
  // ensureMachine want a live connection, so fall through to connect.
  if (existing && !state.probeSnapshots[machine] && (!info || LIVE_STATUSES.has(info.status))) {
    return Promise.resolve(existing);
  }
  if (state.pendingMachines[machine]) {
    // A fetch is already in flight; resolve on the next snapshot however
    // it arrives (pushed frame, the in-flight fetch's store write), or
    // null once the attempt finishes without one.
    return new Promise((resolve) => {
      const done = (snapshot: SessionSnapshot | null) => {
        offStore();
        offSnapshot();
        resolve(snapshot);
      };
      const offStore = subscribe(() => {
        const snap = state.snapshots[machine];
        if (snap && !state.probeSnapshots[machine]) done(snap);
        else if (!state.pendingMachines[machine]) done(null);
      });
      const offSnapshot = onSnapshot((snapshot, m, probe) => {
        // Probe pushes are display data; a waiter asked for a live session.
        if (m === machine && !probe) done(snapshot);
      });
    });
  }
  setPending(machine, true);
  setMachineError(machine, null);
  machineConnect(machine);
  return fetchSession(machine)
    .then((snapshot) => {
      // The pushed snapshot frame may race the fetch reply; keep whichever
      // the listener stored, and make sure this one is stored too.
      if (!state.snapshots[machine]) {
        patch({ snapshots: { ...state.snapshots, [machine]: snapshot } });
      }
      setPending(machine, false);
      return state.snapshots[machine] ?? snapshot;
    })
    .catch((error: unknown) => {
      setPending(machine, false);
      setMachineError(machine, error instanceof Error ? error.message : String(error));
      return null;
    });
}

/** Whitelisted herdr RPC on one machine. Rejects on bridge/RPC failure. */
export function callRpc<T = unknown>(
  machine: string,
  method: RpcMethod,
  params: Record<string, unknown> = {},
): Promise<T> {
  return rpc<T>(method, params, machine);
}

/**
 * Select a workspace: navigate the content route, bring the machine's
 * bridge session up, then focus the workspace in herdr so TUI-side focus
 * and this client's view agree. Focus failures are non-fatal — the
 * snapshot stays the truth and will correct the UI.
 */
export function selectWorkspace(machine: string, workspaceId: string) {
  navigate(workspaceHash(machine, workspaceId));
  void ensureMachine(machine).then((snapshot) => {
    if (!snapshot) return;
    const ws = snapshot.workspaces.find((w) => w.workspace_id === workspaceId);
    if (!ws) return;
    const focused =
      snapshot.focused_workspace_id ??
      snapshot.workspaces.find((w) => w.focused)?.workspace_id;
    if (focused === workspaceId) return;
    void callRpc(machine, "workspace.focus", { workspace_id: workspaceId }).catch(
      () => {},
    );
  });
}

/**
 * Create a workspace on a machine (`workspace.create` + `focus`), then
 * return to the default route so the herdr-focused workspace shows.
 * Resolves false when the machine is unreachable or the RPC fails.
 */
export async function newWorkspace(machine: string): Promise<boolean> {
  const snapshot = await ensureMachine(machine);
  if (!snapshot) return false;
  try {
    await callRpc(machine, "workspace.create", { focus: true });
  } catch {
    return false;
  }
  navigate("#/");
  return true;
}

/** Start the bridge connection. Call once from the app root effect. */
export function initBridge(): () => void {
  if (started) return () => {};
  started = true;
  // Listeners must subscribe before connectBridge(): the desktop IPC path
  // notifies "open" synchronously inside connect(), so a later subscription
  // would miss it and the status would stay "connecting" forever (issue #92).
  const offSnapshot = onSnapshot((snapshot, machine, probe) => {
    setMachineError(machine, null);
    // Store the snapshot before clearing pending so waiters observing the
    // pending flag never resolve null ahead of the data they waited for.
    // A probe push is display data only: it must not satisfy a pending
    // live-session fetch (issue #212).
    const probeSnapshots = { ...state.probeSnapshots };
    if (probe) probeSnapshots[machine] = true;
    else delete probeSnapshots[machine];
    patch({
      snapshots: { ...state.snapshots, [machine]: snapshot },
      probeSnapshots,
    });
    if (!probe) setPending(machine, false);
  });
  const offStatus = onStatus((connection) => patch({ connection }));
  const offMachines = onMachines((list) => {
    patch({ machines: Object.fromEntries(list.map((m) => [m.id, m])) });
  });
  const offMachineStatus = onMachineStatus((machine) => {
    patch({ machines: { ...state.machines, [machine.id]: machine } });
  });
  const disconnect = connectBridge();
  // Aggregate WASM/session memory budget watch (issue #499): sheds rebuildable
  // caches on pressure and logs when the summed probes exceed the budget.
  const stopMemoryWatch = startMemoryBudgetWatch();
  void ensureMachine(LOCAL_MACHINE);
  return () => {
    started = false;
    disconnect();
    stopMemoryWatch();
    offSnapshot();
    offStatus();
    offMachines();
    offMachineStatus();
  };
}
