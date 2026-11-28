import { describe, expect, it } from "bun:test";
import type { MachineInfo, SessionSnapshot } from "../../shared/protocol";
import { awaitingFirstSnapshots, machineStale, MACHINE_STALE_STATUSES } from "./view";

function machine(status: MachineInfo["status"], id = "m"): MachineInfo {
  return { id, label: "M", kind: "ssh", enabled: true, status };
}

describe("machineStale", () => {
  it("treats hard-down statuses as stale", () => {
    for (const status of MACHINE_STALE_STATUSES) {
      expect(machineStale(machine(status))).toBe(true);
    }
  });

  it("keeps live and transitional statuses current", () => {
    for (const status of ["online", "connecting", "reconnecting"] as const) {
      expect(machineStale(machine(status))).toBe(false);
    }
  });

  it("is not stale without machine info", () => {
    expect(machineStale(undefined)).toBe(false);
  });
});

describe("awaitingFirstSnapshots", () => {
  const snap = {} as SessionSnapshot;

  it("is true while a live machine has no snapshot (AC-005 cold start)", () => {
    expect(awaitingFirstSnapshots([machine("online")], {})).toBe(true);
    expect(awaitingFirstSnapshots([machine("connecting")], {})).toBe(true);
  });

  it("is false only once every live machine has a snapshot", () => {
    expect(awaitingFirstSnapshots([machine("online")], { m: snap })).toBe(false);
    expect(
      awaitingFirstSnapshots(
        [machine("online"), machine("online", "n")],
        { m: snap },
      ),
    ).toBe(true);
    expect(
      awaitingFirstSnapshots(
        [machine("online"), machine("online", "n")],
        { m: snap, n: snap },
      ),
    ).toBe(false);
  });

  it("ignores stale machines so offline hosts never block the empty state", () => {
    for (const status of MACHINE_STALE_STATUSES) {
      expect(awaitingFirstSnapshots([machine(status)], {})).toBe(false);
    }
    expect(
      awaitingFirstSnapshots(
        [machine("online"), machine("offline", "n")],
        { m: snap },
      ),
    ).toBe(false);
  });

  it("is false with no machines", () => {
    expect(awaitingFirstSnapshots([], {})).toBe(false);
  });
});
