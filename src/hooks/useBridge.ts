import { useEffect, useState } from "react";
import type { MachineInfo, SessionSnapshot } from "../../shared/protocol";
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
import type { RpcMethod } from "../../shared/protocol";

export type BridgeConnection = "connecting" | "open" | "closed";

/*
 * Owns the bridge connection lifecycle and per-machine session snapshots.
 * One WebSocket carries status/machine/snapshot events; every RPC call is
 * still one-shot over HTTP per the bridge contract.
 */
export function useBridge() {
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({});
  const [machines, setMachines] = useState<Record<string, MachineInfo>>({});
  const [selectedMachine, setSelectedMachine] = useState<string>(LOCAL_MACHINE);
  const [connection, setConnection] = useState<BridgeConnection>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const disconnect = connectBridge();
    const offSnapshot = onSnapshot((next, machine) => {
      setSnapshots((prev) => ({ ...prev, [machine]: next }));
      setError(null);
    });
    const offStatus = onStatus(setConnection);
    const offMachines = onMachines((list) => {
      setMachines(Object.fromEntries(list.map((m) => [m.id, m])));
    });
    const offMachineStatus = onMachineStatus((m) => {
      setMachines((prev) => ({ ...prev, [m.id]: m }));
    });
    void fetchSession(LOCAL_MACHINE)
      .then((snap) => setSnapshots((prev) => ({ ...prev, [LOCAL_MACHINE]: snap })))
      .catch((e: Error) => setError(e.message));
    return () => {
      disconnect();
      offSnapshot();
      offStatus();
      offMachines();
      offMachineStatus();
    };
  }, []);

  const selectMachine = (id: string) => {
    setSelectedMachine(id);
    setError(null);
    if (!snapshots[id]) {
      machineConnect(id);
      void fetchSession(id)
        .then((snap) => setSnapshots((prev) => ({ ...prev, [id]: snap })))
        .catch((e: Error) => setError(e.message));
    }
  };

  const snapshot = snapshots[selectedMachine] ?? null;
  const machine = selectedMachine;
  const call = (method: RpcMethod, params: Record<string, unknown> = {}) =>
    rpc(method, params, machine);

  return {
    snapshots,
    machines,
    machineList: Object.values(machines).sort((a, b) =>
      a.kind === "local" ? -1 : b.kind === "local" ? 1 : a.label.localeCompare(b.label),
    ),
    selectedMachine,
    selectMachine,
    connection,
    error,
    snapshot,
    machine,
    call,
  };
}

export type Bridge = ReturnType<typeof useBridge>;
