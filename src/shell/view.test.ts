import { describe, expect, it } from "bun:test";
import type { MachineInfo } from "../../shared/protocol";
import { machineStale, MACHINE_STALE_STATUSES } from "./view";

function machine(status: MachineInfo["status"]): MachineInfo {
  return { id: "m", label: "M", kind: "ssh", enabled: true, status };
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
