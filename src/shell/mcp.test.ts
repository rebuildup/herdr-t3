import { describe, expect, test } from "bun:test";

import {
  MCP_CONTRACT_PREFIX,
  MCP_MUTATION_COMMANDS,
  MCP_PLUGIN_ID,
  classifyMcpError,
  mcpCapabilityFromDoc,
  mcpSupports,
  mcpSupportsMutation,
} from "./mcp";

const CONTRACT = "herdr-plugins.mcp/v1";

const CAPABILITY_DOC = {
  contract: CONTRACT,
  contract_status: "stable",
  surfaces: { read: "stable", mutation: "stable", events: "stable" },
  plugin: "rebuildup.mcp",
  version: "0.7.0",
  commands: ["capability", "serve", "help"],
  actions: [],
  events: [],
  startup: [],
  state_file: null,
  config_dir: "/cfg/plugins/rebuildup.mcp",
  socket: "/run/herdr/herdr.sock",
  session_resolution: {
    resolved_via: "env-socket",
    session_name_flag: null,
    rule: "--socket > --session/HERDR_SESSION > HERDR_SOCKET_PATH > default; pane env ignored",
  },
  session: { reachable: true, session_name: "default" },
  access_levels: {
    levels: ["read-only", "supervised", "full"],
    default: "read-only",
    semantics:
      "read-only: read tools only; supervised: + mutations with identity echo and stale guards (provider permission mode capped); full: + environment-level operations. Below-level mutation calls fail capability_denied.",
    t3_mapping: {
      "read-only": "read-only",
      supervised: "approval-required..auto band",
      full: "full-access",
    },
  },
  negotiated_access_level: "read-only",
  tools: [
    {
      name: "herdr_capability",
      access: "read-only",
      read_only: true,
      status: "implemented",
      backs_onto: "contract version, access level, resolved session, tool list",
    },
    {
      name: "agent_prompt",
      access: "supervised",
      read_only: false,
      status: "implemented",
      backs_onto: "rebuildup.controls send",
    },
    {
      name: "events_wait",
      access: "read-only",
      read_only: true,
      status: "implemented",
      backs_onto: "events.subscribe",
    },
  ],
  plugins: [
    {
      plugin: "rebuildup.conversations",
      contract: "herdr-plugins.conversations/v1",
      available: true,
      resolved_via: "sibling",
    },
    {
      plugin: "rebuildup.controls",
      contract: "herdr-plugins.controls/v1",
      available: false,
      error: "rebuildup.controls plugin not found; install it or set HERDR_MCP_ROOT_CONTROLS",
    },
  ],
  error_codes: ["capability_denied", "not_found", "stale_generation"],
  upstream_gaps: ["remote HTTP/OAuth (herdrdev/herdr#6199)"],
  remote: {
    status: "excluded_v1",
    tracking: "herdrdev/herdr#6199",
    note: "no inbound HTTP/OAuth in herdr; local stdio only",
  },
  state: "no durable state in v1 (per-client stdio process; ADR-0025 §5)",
};

describe("mcp doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(MCP_PLUGIN_ID).toBe("rebuildup.mcp");
    expect(MCP_CONTRACT_PREFIX).toBe("herdr-plugins.mcp/");
    // Diagnostics only: serve/tools are never invoked from this client.
    expect(MCP_MUTATION_COMMANDS).toHaveLength(0);
  });

  test("capability parses session, access levels, tools, plugins, diagnostics", () => {
    const cap = mcpCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    expect(cap?.contractStatus).toBe("stable");
    expect(cap?.version).toBe("0.7.0");
    expect(cap?.socket).toBe("/run/herdr/herdr.sock");
    expect(cap?.sessionResolution?.resolvedVia).toBe("env-socket");
    expect(cap?.sessionResolution?.rule).toContain("--socket");
    expect(cap?.session?.reachable).toBe(true);
    expect(cap?.session?.sessionName).toBe("default");
    expect(cap?.accessLevels?.levels).toEqual(["read-only", "supervised", "full"]);
    expect(cap?.accessLevels?.defaultLevel).toBe("read-only");
    expect(cap?.accessLevels?.t3Mapping["supervised"]).toBe(
      "approval-required..auto band",
    );
    expect(cap?.negotiatedAccessLevel).toBe("read-only");
    expect(cap?.tools).toHaveLength(3);
    expect(cap?.tools[1]?.access).toBe("supervised");
    expect(cap?.tools[1]?.readOnly).toBe(false);
    expect(cap?.tools[1]?.backsOnto).toBe("rebuildup.controls send");
    expect(cap?.plugins).toHaveLength(2);
    expect(cap?.plugins[0]?.available).toBe(true);
    expect(cap?.plugins[0]?.resolvedVia).toBe("sibling");
    // plugin_unavailable is honest data, not an error.
    expect(cap?.plugins[1]?.available).toBe(false);
    expect(cap?.plugins[1]?.error).toContain("not found");
    expect(cap?.surfaces).toEqual({
      read: "stable",
      mutation: "stable",
      events: "stable",
    });
    expect(cap?.remote?.status).toBe("excluded_v1");
    expect(cap?.remote?.tracking).toBe("herdrdev/herdr#6199");
    expect(cap?.upstreamGaps[0]).toContain("6199");
    expect(cap?.stateNote).toContain("no durable state");
    expect(mcpSupports(cap, "capability")).toBe(true);
    expect(mcpSupports(cap, "serve")).toBe(true);
    expect(mcpSupports(cap, "nope")).toBe(false);
  });

  test("capability tolerates an unreachable session as data", () => {
    const cap = mcpCapabilityFromDoc({
      ...CAPABILITY_DOC,
      session: { reachable: false, error: "connect ECONNREFUSED" },
      plugins: [],
    });
    expect(cap?.session?.reachable).toBe(false);
    expect(cap?.session?.error).toBe("connect ECONNREFUSED");
    expect(cap?.plugins).toEqual([]);
  });

  test("parsers reject foreign contracts", () => {
    expect(
      mcpCapabilityFromDoc({ contract: "herdr-plugins.secrets/v1" }),
    ).toBeNull();
    // Contract prefix alone (no version suffix yet) still parses.
    expect(mcpCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = mcpCapabilityFromDoc({
      contract: CONTRACT,
      commands: "capability",
    });
    expect(noCommands?.commands.size).toBe(0);
    expect(mcpSupports(noCommands, "capability")).toBe(false);
  });
});

describe("mcp capability gating", () => {
  test("mutation gating fails closed — mutations live inside serve", () => {
    const cap = mcpCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    for (const command of ["capability", "serve", "help", "agent_prompt"]) {
      expect(mcpSupportsMutation(cap, command)).toBe(false);
    }
    expect(mcpSupportsMutation(undefined, "serve")).toBeNull();
    expect(mcpSupportsMutation(null, "serve")).toBe(false);
  });
});

describe("mcp error classification", () => {
  test("boundary codes map to the shared taxonomy", () => {
    expect(classifyMcpError({ code: "plugin_not_installed" }).reason).toBe(
      "not_installed",
    );
    expect(classifyMcpError({ code: "plugin_disabled" }).reason).toBe("disabled");
    expect(classifyMcpError({ code: "plugin_incompatible" }).reason).toBe(
      "incompatible",
    );
    expect(classifyMcpError({ code: "plugin_timeout" }).reason).toBe("unreachable");
    expect(classifyMcpError(new Error("boom")).reason).toBe("error");
  });
});
