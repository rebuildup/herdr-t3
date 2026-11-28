import { describe, expect, test } from "bun:test";
import type { MachineInfo, SessionSnapshot } from "../../shared/protocol";
import { resolveCanvasSession, type CanvasSessionInput } from "./canvasState";

function machine(
  status: MachineInfo["status"],
  overrides: Partial<MachineInfo> = {},
): MachineInfo {
  return { id: "m", label: "Test machine", kind: "ssh", enabled: true, status, ...overrides };
}

function snapshot(workspaces = 1): SessionSnapshot {
  return {
    agents: [],
    layouts: [],
    panes: [],
    protocol: 22,
    tabs: [],
    version: "test",
    workspaces: Array.from({ length: workspaces }, (_, i) => ({
      workspace_id: `ws-${i}`,
      active_tab_id: "",
      agent_status: "idle",
      focused: i === 0,
      label: `ws-${i}`,
      number: i + 1,
      pane_count: 0,
      tab_count: 0,
    })),
  };
}

function input(overrides: Partial<CanvasSessionInput> = {}): CanvasSessionInput {
  return {
    snapshot: null,
    probeSnapshot: false,
    machineInfo: machine("online"),
    bridgeConnection: "open",
    machineError: undefined,
    machinePending: false,
    ...overrides,
  };
}

describe("resolveCanvasSession", () => {
  test("cold start: no snapshot, bridge still connecting", () => {
    expect(resolveCanvasSession(input({ bridgeConnection: "connecting" }))).toEqual({
      kind: "bridge",
      connection: "connecting",
    });
  });

  test("cold start: bridge closed while a fetch is pending", () => {
    // Bridge transport state wins over per-machine progress: nothing can
    // arrive until the WS is open again.
    expect(
      resolveCanvasSession(
        input({ bridgeConnection: "closed", machinePending: true, machineError: "boom" }),
      ),
    ).toEqual({ kind: "bridge", connection: "closed" });
  });

  test("first fetch in flight shows connecting, not an empty state", () => {
    expect(resolveCanvasSession(input({ machinePending: true }))).toEqual({
      kind: "connecting",
    });
  });

  test("awaiting first snapshot with no signals is loading", () => {
    expect(resolveCanvasSession(input())).toEqual({ kind: "loading" });
  });

  test("failed fetch surfaces the error instead of loading forever", () => {
    expect(
      resolveCanvasSession(input({ machineError: "ssh: connection refused" })),
    ).toEqual({ kind: "error", message: "ssh: connection refused" });
  });

  test("probe snapshot alone is connecting, never live", () => {
    // issue #212: probe data is displayable list data, not a session.
    expect(
      resolveCanvasSession(input({ snapshot: snapshot(), probeSnapshot: true })),
    ).toEqual({ kind: "connecting" });
  });

  test("probe → live transition flips to live once the real snapshot lands", () => {
    expect(resolveCanvasSession(input({ snapshot: snapshot() }))).toEqual({
      kind: "live",
    });
  });

  test("live snapshot with zero workspaces is live — the empty view is the caller's job", () => {
    // Last-workspace delete leaves a real empty session (herdr
    // close_workspaces); the resolver must not relabel it as loading.
    expect(resolveCanvasSession(input({ snapshot: snapshot(0) }))).toEqual({
      kind: "live",
    });
  });

  test("held snapshot on a hard-down machine is stale, not live", () => {
    for (const status of ["offline", "unreachable", "error", "auth_required", "incompatible"] as const) {
      expect(
        resolveCanvasSession(input({ snapshot: snapshot(), machineInfo: machine(status) })),
      ).toEqual({ kind: "stale" });
    }
  });

  test("hard-down machine with nothing held is down", () => {
    expect(
      resolveCanvasSession(input({ machineInfo: machine("unreachable") })),
    ).toEqual({ kind: "down" });
  });

  test("disabled machine never resolves to live or stale-with-retry", () => {
    expect(
      resolveCanvasSession(
        input({ snapshot: snapshot(), machineInfo: machine("disabled", { enabled: false }) }),
      ),
    ).toEqual({ kind: "disabled" });
    expect(
      resolveCanvasSession(input({ machineInfo: machine("disabled", { enabled: false }) })),
    ).toEqual({ kind: "disabled" });
  });

  test("missing machine info is not stale — absence of data is not evidence of failure", () => {
    expect(resolveCanvasSession(input({ machineInfo: undefined }))).toEqual({
      kind: "loading",
    });
  });

  test("transitional machine status without pending still reads as connecting", () => {
    expect(
      resolveCanvasSession(input({ machineInfo: machine("reconnecting") })),
    ).toEqual({ kind: "connecting" });
  });
});
