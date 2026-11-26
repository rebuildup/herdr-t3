import { describe, expect, test } from "bun:test";

import {
  MACHINES_CONTRACT_PREFIX,
  MACHINES_MUTATION_COMMANDS,
  MACHINES_PLUGIN_ID,
  classifyMachinesError,
  machinesCapabilityFromDoc,
  machinesListArgs,
  machinesListFromDoc,
  machinesProbeArgs,
  machinesProbeFromDoc,
  machinesSupports,
  machinesSupportsMutation,
} from "./machines";

const CONTRACT = "herdr-plugins.machines/v1";

const CAPABILITY_DOC = {
  contract: CONTRACT,
  contract_status: "draft",
  command: "capability",
  plugin: "rebuildup.machines",
  version: "0.1.0",
  read_only: true,
  mutation_commands: [],
  commands: ["capability", "list", "probe"],
  implemented_commands: ["capability", "list", "probe"],
  probe_states: ["ok", "disabled", "unreachable", "unsupported_remote", "error"],
  plugin_surfaces: ["supported", "unsupported", "unknown"],
  transport: "herdr machine list --json + herdr --machine <id> <cli> (SavedSshApiBridge)",
  state_file: "/state/plugins/rebuildup.machines/state.json",
  notes: ["Read-only inventory (ADR-0028)"],
  generated_at: "2026-01-03T00:00:00.000Z",
};

const PROBE_OK = {
  contract: CONTRACT,
  machine_id: "5ac021a5",
  state: "ok",
  probed_at: "2026-01-03T00:00:01.000Z",
  reachable: true,
  server_version: "0.9.5",
  protocol: 22,
  plugin_surface: "supported",
  plugins: [{ id: "rebuildup.git", name: "git", version: "0.4.0" }],
  plugin_surface_error: null,
  error_kind: null,
  error: null,
};

const LIST_DOC = {
  contract: CONTRACT,
  command: "list",
  total: 2,
  machines: [
    {
      machine: {
        id: "5ac021a5",
        label: "Ubuntu (WSL)",
        target: "device-wsl",
        session: "default",
        enabled: true,
        selected: false,
      },
      last_probe: PROBE_OK,
    },
    {
      machine: {
        id: "9f00",
        label: "Office",
        target: "office-pc",
        session: "work",
        enabled: false,
        selected: true,
      },
      last_probe: null,
    },
    { machine: { nope: true }, last_probe: null },
  ],
  state_file: "/state/plugins/rebuildup.machines/state.json",
  generated_at: "2026-01-03T00:00:02.000Z",
};

const PROBE_DOC = {
  contract: CONTRACT,
  command: "probe",
  total: 2,
  results: [
    PROBE_OK,
    {
      contract: CONTRACT,
      machine_id: "9f00",
      state: "unreachable",
      probed_at: "2026-01-03T00:00:03.000Z",
      reachable: false,
      server_version: null,
      protocol: null,
      plugin_surface: "unknown",
      plugins: null,
      plugin_surface_error: null,
      error_kind: "ssh_connect_failed",
      error: "ssh: connect to host office-pc port 22: timed out",
    },
  ],
  state_file: "/state/plugins/rebuildup.machines/state.json",
  generated_at: "2026-01-03T00:00:04.000Z",
};

describe("machines argv builders (herdr-plugins.machines/v1 @d23205af)", () => {
  test("list takes no arguments", () => {
    expect(machinesListArgs()).toEqual([]);
  });

  test("probe argv is a selector or --all", () => {
    expect(machinesProbeArgs("5ac021a5")).toEqual(["5ac021a5"]);
    expect(machinesProbeArgs("Ubuntu (WSL)")).toEqual(["Ubuntu (WSL)"]);
    expect(machinesProbeArgs()).toEqual(["--all"]);
    expect(machinesProbeArgs("")).toEqual(["--all"]);
  });
});

describe("machines doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(MACHINES_PLUGIN_ID).toBe("rebuildup.machines");
    expect(MACHINES_CONTRACT_PREFIX).toBe("herdr-plugins.machines/");
    // Read-only contract: the local allowlist stays empty.
    expect(MACHINES_MUTATION_COMMANDS).toHaveLength(0);
  });

  test("capability parses read_only, vocabularies, notes", () => {
    const cap = machinesCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    expect(cap?.contractStatus).toBe("draft");
    expect(cap?.readOnly).toBe(true);
    expect(cap?.commands.has("probe")).toBe(true);
    expect(cap?.probeStates).toContain("unsupported_remote");
    expect(cap?.pluginSurfaces).toEqual(["supported", "unsupported", "unknown"]);
    expect(cap?.notes[0]).toContain("Read-only");
    expect(machinesSupports(cap, "list")).toBe(true);
    expect(machinesSupports(cap, "nope")).toBe(false);
  });

  test("list merges live machines with last-known probes", () => {
    const report = machinesListFromDoc(LIST_DOC);
    expect(report).not.toBeNull();
    expect(report?.total).toBe(2);
    // The malformed machine entry is skipped.
    expect(report?.machines).toHaveLength(2);
    const [first, second] = report?.machines ?? [];
    expect(first?.machine.label).toBe("Ubuntu (WSL)");
    expect(first?.machine.enabled).toBe(true);
    expect(first?.lastProbe?.state).toBe("ok");
    expect(first?.lastProbe?.serverVersion).toBe("0.9.5");
    expect(first?.lastProbe?.protocol).toBe(22);
    expect(first?.lastProbe?.pluginSurface).toBe("supported");
    expect(first?.lastProbe?.plugins?.[0]?.id).toBe("rebuildup.git");
    expect(second?.machine.enabled).toBe(false);
    expect(second?.machine.selected).toBe(true);
    // Never probed → null, rendered as honest "never probed".
    expect(second?.lastProbe).toBeNull();
  });

  test("probe parses per-machine verdicts incl. unreachable", () => {
    const report = machinesProbeFromDoc(PROBE_DOC);
    expect(report).not.toBeNull();
    expect(report?.results).toHaveLength(2);
    expect(report?.results[0]?.state).toBe("ok");
    expect(report?.results[1]?.state).toBe("unreachable");
    expect(report?.results[1]?.reachable).toBe(false);
    expect(report?.results[1]?.pluginSurface).toBe("unknown");
    expect(report?.results[1]?.plugins).toBeNull();
    expect(report?.results[1]?.errorKind).toBe("ssh_connect_failed");
    expect(report?.results[1]?.error).toContain("timed out");
  });

  test("parsers reject foreign contracts and wrong commands", () => {
    expect(
      machinesListFromDoc({ contract: "herdr-plugins.secrets/v1", machines: [] }),
    ).toBeNull();
    expect(
      machinesProbeFromDoc({ contract: CONTRACT, command: "list", results: [] }),
    ).toBeNull();
    expect(machinesListFromDoc({ contract: CONTRACT })).toBeNull();
    expect(machinesProbeFromDoc({})).toBeNull();
  });
});

describe("machines capability gating", () => {
  test("mutation gating fails closed on a read-only contract", () => {
    const cap = machinesCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    for (const command of ["capability", "list", "probe", "enable", "remove"]) {
      expect(machinesSupportsMutation(cap, command)).toBe(false);
    }
    expect(machinesSupportsMutation(undefined, "list")).toBeNull();
    expect(machinesSupportsMutation(null, "list")).toBe(false);
  });
});

describe("machines error classification", () => {
  test("boundary codes map to the shared taxonomy", () => {
    expect(
      classifyMachinesError({ code: "plugin_not_installed" }).reason,
    ).toBe("not_installed");
    expect(classifyMachinesError({ code: "plugin_disabled" }).reason).toBe("disabled");
    expect(classifyMachinesError({ code: "plugin_incompatible" }).reason).toBe(
      "incompatible",
    );
    expect(classifyMachinesError({ code: "machine_unavailable" }).reason).toBe(
      "unreachable",
    );
    // Plugin-side usage kinds (machine_not_found/machine_ambiguous)
    // stay "error" with verbatim detail.
    const classified = classifyMachinesError(
      Object.assign(new Error("no saved machine matches"), {
        code: "machine_not_found",
      }),
    );
    expect(classified.reason).toBe("error");
    expect(classified.detail).toBe("no saved machine matches");
  });
});
