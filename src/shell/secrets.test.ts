import { describe, expect, test } from "bun:test";

import {
  SECRETS_CONTRACT_PREFIX,
  SECRETS_MUTATION_COMMANDS,
  SECRETS_PLUGIN_ID,
  classifySecretsError,
  secretsCapabilityFromDoc,
  secretsInjectArgs,
  secretsInjectFromDoc,
  secretsResolveArgs,
  secretsResolveFromDoc,
  secretsRunArgs,
  secretsSupports,
  secretsSupportsMutation,
} from "./secrets";

const CONTRACT = "herdr-plugins.secrets/v1";

const CAPABILITY_DOC = {
  contract: CONTRACT,
  command: "capability",
  plugin: "rebuildup.secrets",
  version: "0.1.1",
  provider: {
    name: "infisical",
    domain: "https://secrets.rebuildup.dev/api",
    cli: {
      bin: "infisical",
      available: true,
      version: "infisical version 0.45.14",
    },
    project_id_configured: true,
    reachability: { status: "not_checked" },
  },
  bindings: [
    {
      name: "deepseek",
      env: "DEEPSEEK_API_KEY",
      ref: "infisical:dev:/shared:DEEPSEEK_API_KEY",
      projectId: "proj-1",
    },
    { name: "openai", env: "OPENAI_API_KEY", ref: "infisical:dev:/:OPENAI_KEY" },
  ],
  invalid_bindings: [{ name: "bad", error: "env name is reserved" }],
  config_warnings: ["managed-Cloud domain in use"],
  credential_boundary: { adr: "docs/adr/0027-…" },
  commands: ["capability", "resolve", "run", "inject", "config"],
  generated_at: "2026-01-03T00:00:00.000Z",
};

const RESOLVE_DOC = {
  contract: CONTRACT,
  command: "resolve",
  plugin: "rebuildup.secrets",
  ok: false,
  bindings: [
    {
      name: "deepseek",
      env: "DEEPSEEK_API_KEY",
      ref: "infisical:dev:/shared:DEEPSEEK_API_KEY",
      status: "resolved",
    },
    {
      name: "openai",
      env: "OPENAI_API_KEY",
      ref: "infisical:dev:/:OPENAI_KEY",
      status: "unresolved",
      detail: "secret OPENAI_KEY not found at dev:/",
    },
  ],
  generated_at: "2026-01-03T00:00:01.000Z",
};

const INJECT_DOC = {
  contract: CONTRACT,
  command: "inject",
  plugin: "rebuildup.secrets",
  ok: true,
  bindings: [
    {
      name: "deepseek",
      env: "DEEPSEEK_API_KEY",
      ref: "infisical:dev:/shared:DEEPSEEK_API_KEY",
      status: "resolved",
    },
  ],
  injected: {
    surface: "workspace",
    workspace_id: "w9",
    env_names: ["DEEPSEEK_API_KEY"],
  },
  generated_at: "2026-01-03T00:00:02.000Z",
};

describe("secrets argv builders (herdr-plugins.secrets/v1 @d23205af)", () => {
  test("resolve argv carries only --binding flags", () => {
    expect(secretsResolveArgs(["deepseek", "openai"])).toEqual([
      "--binding",
      "deepseek",
      "--binding",
      "openai",
    ]);
    expect(secretsResolveArgs([])).toEqual([]);
    expect(secretsResolveArgs([""])).toEqual([]);
  });

  test("run argv inserts the mandatory -- separator before the command", () => {
    // cli.ts parseArgs: everything after `--` is the wrapped command.
    expect(secretsRunArgs(["deepseek"], "infisical", ["run", "--", "env"])).toEqual([
      "--binding",
      "deepseek",
      "--",
      "infisical",
      "run",
      "--",
      "env",
    ]);
  });

  test("inject argv maps contract flags and omits unset options", () => {
    expect(
      secretsInjectArgs(["deepseek"], {
        surface: "pane",
        targetPaneId: "w1:p2",
        direction: "down",
        cwd: "/repo",
        label: "agent",
        focus: true,
        ratio: 0.4,
      }),
    ).toEqual([
      "--binding",
      "deepseek",
      "--surface",
      "pane",
      "--target-pane",
      "w1:p2",
      "--direction",
      "down",
      "--cwd",
      "/repo",
      "--label",
      "agent",
      "--focus",
      "--ratio",
      "0.4",
    ]);
    // workspace surface emits no targeting flags.
    expect(secretsInjectArgs(["a"], { surface: "workspace" })).toEqual([
      "--binding",
      "a",
      "--surface",
      "workspace",
    ]);
    // --workspace only applies to tab/pane targets.
    expect(
      secretsInjectArgs(["a"], { surface: "tab", workspaceId: "w1" }),
    ).toEqual(["--binding", "a", "--surface", "tab", "--workspace", "w1"]);
    expect(
      secretsInjectArgs(["a"], { surface: "workspace", workspaceId: "w1" }),
    ).toEqual(["--binding", "a", "--surface", "workspace"]);
  });
});

describe("secrets doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(SECRETS_PLUGIN_ID).toBe("rebuildup.secrets");
    expect(SECRETS_CONTRACT_PREFIX).toBe("herdr-plugins.secrets/");
    // Mutations ARE offered on this surface (run/inject behind
    // confirmation); config/eval stay out of the allowlist.
    expect(SECRETS_MUTATION_COMMANDS).toEqual(["run", "inject"]);
  });

  test("capability parses provider, bindings, invalid bindings, warnings", () => {
    const cap = secretsCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    expect(cap?.contract).toBe(CONTRACT);
    expect(cap?.version).toBe("0.1.1");
    expect(cap?.provider?.name).toBe("infisical");
    expect(cap?.provider?.domain).toBe("https://secrets.rebuildup.dev/api");
    expect(cap?.provider?.cli?.available).toBe(true);
    expect(cap?.provider?.cli?.version).toBe("infisical version 0.45.14");
    expect(cap?.provider?.projectIdConfigured).toBe(true);
    expect(cap?.provider?.reachability?.status).toBe("not_checked");
    expect(cap?.bindings).toHaveLength(2);
    expect(cap?.bindings[0]?.env).toBe("DEEPSEEK_API_KEY");
    expect(cap?.bindings[0]?.projectId).toBe("proj-1");
    expect(cap?.bindings[1]?.projectId).toBeNull();
    expect(cap?.invalidBindings).toEqual([
      { name: "bad", error: "env name is reserved" },
    ]);
    expect(cap?.configWarnings).toEqual(["managed-Cloud domain in use"]);
    expect(secretsSupports(cap, "resolve")).toBe(true);
    expect(secretsSupports(cap, "config")).toBe(true);
    expect(secretsSupports(cap, "nope")).toBe(false);
  });

  test("capability accepts mutation_commands when advertised (plugin >= v0.2.0)", () => {
    const cap = secretsCapabilityFromDoc({
      ...CAPABILITY_DOC,
      version: "0.2.0",
      mutation_commands: ["run", "inject", "config"],
    });
    expect(cap?.mutationCommands.has("run")).toBe(true);
    // config is advertised as a mutation upstream but is NOT in the
    // local allowlist — it stays unofferable.
    expect(secretsSupportsMutation(cap, "run")).toBe(true);
    expect(secretsSupportsMutation(cap, "inject")).toBe(true);
    expect(secretsSupportsMutation(cap, "config")).toBe(false);
    expect(secretsSupportsMutation(cap, "capability")).toBe(false);
  });

  test("resolve parses ok:false reports with per-binding statuses", () => {
    const report = secretsResolveFromDoc(RESOLVE_DOC);
    expect(report).not.toBeNull();
    expect(report?.ok).toBe(false);
    expect(report?.bindings).toHaveLength(2);
    expect(report?.bindings[0]?.status).toBe("resolved");
    expect(report?.bindings[1]?.status).toBe("unresolved");
    expect(report?.bindings[1]?.detail).toContain("not found");
  });

  test("inject parses env_names and surface ids — never values", () => {
    const result = secretsInjectFromDoc(INJECT_DOC);
    expect(result).not.toBeNull();
    expect(result?.surface).toBe("workspace");
    expect(result?.workspaceId).toBe("w9");
    expect(result?.envNames).toEqual(["DEEPSEEK_API_KEY"]);
  });

  test("parsers reject foreign contracts and wrong commands", () => {
    expect(
      secretsCapabilityFromDoc({ contract: "herdr-plugins.machines/v1" }),
    ).toBeNull();
    expect(secretsResolveFromDoc({ contract: "other/v9", command: "resolve" })).toBeNull();
    expect(
      secretsResolveFromDoc({ contract: CONTRACT, command: "run", bindings: [] }),
    ).toBeNull();
    expect(
      secretsInjectFromDoc({ contract: CONTRACT, command: "inject", ok: false, injected: {} }),
    ).toBeNull();
    expect(secretsResolveFromDoc({})).toBeNull();
  });

  test("SECRET VALUES ARE NEVER CAPTURED — value-shaped fields are dropped", () => {
    // Even if a buggy/future plugin emitted a value field, the parsers
    // must not carry it into any model the UI can render.
    const leaked = "sk-live-FAKE-SECRET-123";
    const resolveDoc = {
      ...RESOLVE_DOC,
      bindings: RESOLVE_DOC.bindings.map((b) => ({ ...b, value: leaked })),
      env: { DEEPSEEK_API_KEY: leaked },
    };
    const resolve = secretsResolveFromDoc(resolveDoc);
    expect(JSON.stringify(resolve)).not.toContain(leaked);

    const injectDoc = {
      ...INJECT_DOC,
      injected: { ...INJECT_DOC.injected, values: { DEEPSEEK_API_KEY: leaked } },
    };
    const inject = secretsInjectFromDoc(injectDoc);
    expect(JSON.stringify(inject)).not.toContain(leaked);

    const capDoc = {
      ...CAPABILITY_DOC,
      bindings: CAPABILITY_DOC.bindings.map((b) => ({ ...b, value: leaked })),
      resolved: { DEEPSEEK_API_KEY: leaked },
    };
    const cap = secretsCapabilityFromDoc(capDoc);
    expect(JSON.stringify(cap)).not.toContain(leaked);

    // argv builders have no value input at all — only names/flags.
    const runArgv = secretsRunArgs(["deepseek"], "env", []);
    expect(runArgv).not.toContain(leaked);
    const injectArgv = secretsInjectArgs(["deepseek"], { surface: "workspace" });
    expect(injectArgv).not.toContain(leaked);
  });
});

describe("secrets capability gating", () => {
  test("mutations require local allowlist AND advertised command", () => {
    const cap = secretsCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    // Pinned plugin v0.1.1 has no mutation_commands field — gating
    // falls back to the advertised commands list.
    expect(secretsSupportsMutation(cap, "run")).toBe(true);
    expect(secretsSupportsMutation(cap, "inject")).toBe(true);
    // Reads and out-of-allowlist commands stay closed.
    for (const command of ["capability", "resolve", "config", "nope"]) {
      expect(secretsSupportsMutation(cap, command)).toBe(false);
    }
    // Probe states mirror secretsSupports: undefined = probing.
    expect(secretsSupportsMutation(undefined, "run")).toBeNull();
    expect(secretsSupportsMutation(null, "run")).toBe(false);
  });

  test("an explicit mutation_commands deny overrides commands", () => {
    const cap = secretsCapabilityFromDoc({
      ...CAPABILITY_DOC,
      mutation_commands: ["inject"], // run deliberately absent
    });
    expect(secretsSupportsMutation(cap, "run")).toBe(false);
    expect(secretsSupportsMutation(cap, "inject")).toBe(true);
  });
});

describe("secrets error classification", () => {
  test("boundary codes map to the shared taxonomy", () => {
    expect(
      classifySecretsError({ code: "plugin_not_installed", message: "x" }).reason,
    ).toBe("not_installed");
    expect(classifySecretsError({ code: "plugin_disabled" }).reason).toBe("disabled");
    expect(classifySecretsError({ code: "plugin_incompatible" }).reason).toBe(
      "incompatible",
    );
    expect(classifySecretsError({ code: "plugin_timeout" }).reason).toBe("unreachable");
    // Plugin-side kinds (resolution_failed/config_error/spawn_failed)
    // stay "error" with verbatim detail.
    const classified = classifySecretsError(
      Object.assign(new Error("one or more bindings could not be resolved"), {
        code: "resolution_failed",
      }),
    );
    expect(classified.reason).toBe("error");
    expect(classified.detail).toContain("could not be resolved");
    expect(classifySecretsError(new Error("boom")).reason).toBe("error");
  });
});
