import { describe, expect, test } from "bun:test";

import {
  TEXTGEN_CONTRACT_PREFIX,
  TEXTGEN_MUTATION_COMMANDS,
  TEXTGEN_PLUGIN_ID,
  classifyTextgenError,
  textgenCapabilityFromDoc,
  textgenErrorHint,
  textgenGenerateArgs,
  textgenGenerateFromDoc,
  textgenGitContextArgs,
  textgenGitContextFromDoc,
  textgenSupports,
  textgenSupportsMutation,
} from "./textgen";

const CONTRACT = "herdr-plugins.textgen/v1";

const CAPABILITY_DOC = {
  contract: CONTRACT,
  command: "capability",
  plugin: "rebuildup.textgen",
  version: "0.7.0",
  integrations: {
    git: {
      status: "resolved",
      plugin_id: "rebuildup.git",
      plugin_root: "/plugins/git",
      resolved_via: "config.gitPluginRoot",
      contract: "herdr-plugins.git/v1",
      git_tasks: ["branch_name", "commit_message", "pr_content"],
    },
  },
  tasks: [
    {
      kind: "thread_title",
      description: "Short title summarizing a conversation/thread context.",
      paths: ["agent", "api"],
      input_fields: ["context", "instruction"],
      required_input: ["context"],
      output: "text",
      max_output_chars: 200,
      requires_opt_in: false,
    },
    {
      kind: "review_guide",
      description: "Read-only multi-step review guide.",
      paths: ["agent"],
      input_fields: ["target", "instructions", "cwd"],
      required_input: ["target"],
      output: "text",
      max_output_chars: 20000,
      requires_opt_in: true,
      opt_in: "guards.expensiveTaskOptIn in config.json or --allow-expensive",
    },
    { junk: true },
  ],
  guards: {
    expensive_task_opt_in: false,
    quota_check: {
      enabled: true,
      max_used_percent: 95,
      provider: "rebuildup.usage quota (read-only, soft dependency)",
    },
  },
  providers: {
    agent: [
      {
        id: "agent:claude",
        path: "agent",
        kind: "claude",
        enabled: true,
        availability: "manifest",
        model: "claude-sonnet-4",
        cost_note: "uses the provider's own subscription/CLI credentials via herdr",
      },
      {
        id: "agent:gemini",
        path: "agent",
        kind: "gemini",
        enabled: true,
        availability: "not_in_manifests",
        warning: "not listed in server.agent_manifests",
      },
    ],
    api: [
      {
        id: "api:openai",
        path: "api",
        generator: "openai",
        kind: "openai",
        endpoint: "https://api.openai.com",
        model: "gpt-4o-mini",
        enabled: true,
        credential_configured: true,
        cost_note: "per-token API billing; opt-in only (ADR-0018)",
      },
    ],
    cli: {
      status: "unsupported",
      reason: "headless provider CLI subprocess rejected by ADR-0017",
    },
  },
  agent_manifests: "queried",
  config: { defaultProvider: "agent:claude" },
  config_warnings: ["unknown config key ignored: foo"],
  commands: ["capability", "generate", "git-context", "watch-next-prompt", "config"],
  mutation_commands: [
    "generate",
    "watch-next-prompt",
    "config set-default-provider",
    "config set-default-model",
    "config add-api-generator",
    "config remove-api-generator",
  ],
  generated_at: "2026-01-03T00:00:00.000Z",
};

const GIT_CONTEXT_DOC = {
  contract: CONTRACT,
  command: "git-context",
  ok: true,
  task: "commit_message",
  pane_id: "w1:p1",
  git_plugin: {
    plugin_id: "rebuildup.git",
    plugin_root: "/plugins/git",
    resolved_via: "sibling",
  },
  repo_root: "/repo",
  branch: "feature/x",
  input: { diff: "diff --git a/f b/f", conventions: "AGENTS.md" },
  sources: ["git-v1:status", "git-v1:diff --staged", "file:AGENTS.md"],
  warnings: ["forge context unavailable"],
  generated_at: "2026-01-03T00:00:00.000Z",
};

describe("textgen argv builders (herdr-plugins.textgen/v1 @d23205af)", () => {
  test("git-context argv carries task/pane and optional git root", () => {
    // cli.ts parseArgs: git-context --task <kind> --git-pane <pane>
    //   [--git-root <dir>] — session/socket/timeout are CallOptions,
    //   never argv.
    expect(textgenGitContextArgs({ task: "commit_message", paneId: "w1:p1" })).toEqual([
      "--task",
      "commit_message",
      "--git-pane",
      "w1:p1",
    ]);
    expect(
      textgenGitContextArgs({
        task: "pr_content",
        paneId: "w2:p3",
        gitRoot: "/plugins/git",
      }),
    ).toEqual([
      "--task",
      "pr_content",
      "--git-pane",
      "w2:p3",
      "--git-root",
      "/plugins/git",
    ]);
    expect(
      textgenGitContextArgs({ task: "branch_name", paneId: "w1:p1", gitRoot: "" }),
    ).toEqual(["--task", "branch_name", "--git-pane", "w1:p1"]);
  });
});

describe("textgen doc parsers", () => {
  test("constants match the pinned contract", () => {
    expect(TEXTGEN_PLUGIN_ID).toBe("rebuildup.textgen");
    expect(TEXTGEN_CONTRACT_PREFIX).toBe("herdr-plugins.textgen/");
    // Issue #458: `generate` is the one allowlisted mutation; the
    // watcher and config writes stay gated off.
    expect(TEXTGEN_MUTATION_COMMANDS).toEqual(["generate"]);
  });

  test("capability parses tasks, providers, guards and git integration", () => {
    const cap = textgenCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    expect(cap?.contractOk).toBe(true);
    expect(cap?.version).toBe("0.7.0");
    expect(cap?.plugin).toBe("rebuildup.textgen");
    // The malformed task entry is skipped.
    expect(cap?.tasks).toHaveLength(2);
    const [title, review] = cap?.tasks ?? [];
    expect(title?.kind).toBe("thread_title");
    expect(title?.paths).toEqual(["agent", "api"]);
    expect(title?.requiredInput).toEqual(["context"]);
    expect(title?.output).toBe("text");
    expect(title?.maxOutputChars).toBe(200);
    expect(title?.requiresOptIn).toBe(false);
    expect(review?.requiresOptIn).toBe(true);
    expect(review?.optIn).toContain("expensiveTaskOptIn");
    // Providers verbatim — credential_configured stays a boolean.
    expect(cap?.agentProviders).toHaveLength(2);
    expect(cap?.agentProviders[0]?.availability).toBe("manifest");
    expect(cap?.agentProviders[1]?.availability).toBe("not_in_manifests");
    expect(cap?.apiProviders).toHaveLength(1);
    expect(cap?.apiProviders[0]?.credentialConfigured).toBe(true);
    expect(cap?.cliProvider?.status).toBe("unsupported");
    expect(cap?.guards?.expensiveTaskOptIn).toBe(false);
    expect(cap?.guards?.quotaEnabled).toBe(true);
    expect(cap?.guards?.quotaMaxUsedPercent).toBe(95);
    expect(cap?.gitIntegration?.status).toBe("resolved");
    expect(cap?.gitIntegration?.gitTasks).toEqual([
      "branch_name",
      "commit_message",
      "pr_content",
    ]);
    expect(cap?.agentManifests).toBe("queried");
    expect(cap?.configWarnings).toEqual(["unknown config key ignored: foo"]);
    expect(cap?.generatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(textgenSupports(cap, "git-context")).toBe(true);
    expect(textgenSupports(cap, "generate")).toBe(true);
    expect(textgenSupports(cap, "nope")).toBe(false);
  });

  test("capability rejects foreign contracts", () => {
    expect(
      textgenCapabilityFromDoc({ contract: "herdr-plugins.artifacts/v1" }),
    ).toBeNull();
    expect(textgenCapabilityFromDoc({ contract: CONTRACT })).not.toBeNull();
    const noCommands = textgenCapabilityFromDoc({
      contract: CONTRACT,
      commands: "capability",
    });
    expect(noCommands?.commands.size).toBe(0);
    expect(textgenSupports(noCommands, "capability")).toBe(false);
  });

  test("git-context parses collected input, sources and warnings", () => {
    const report = textgenGitContextFromDoc(GIT_CONTEXT_DOC);
    expect(report).not.toBeNull();
    expect(report?.task).toBe("commit_message");
    expect(report?.paneId).toBe("w1:p1");
    expect(report?.gitPluginRoot).toBe("/plugins/git");
    expect(report?.repoRoot).toBe("/repo");
    expect(report?.branch).toBe("feature/x");
    expect(report?.input["diff"]).toBe("diff --git a/f b/f");
    expect(report?.sources).toHaveLength(3);
    expect(report?.warnings).toEqual(["forge context unavailable"]);
  });

  test("git-context rejects foreign contract, wrong command and non-ok", () => {
    expect(
      textgenGitContextFromDoc({ contract: "other/v9", command: "git-context", ok: true }),
    ).toBeNull();
    expect(
      textgenGitContextFromDoc({ contract: CONTRACT, command: "generate", ok: true }),
    ).toBeNull();
    expect(
      textgenGitContextFromDoc({ contract: CONTRACT, command: "git-context", ok: false }),
    ).toBeNull();
    expect(textgenGitContextFromDoc({})).toBeNull();
  });
});

describe("textgen capability gating", () => {
  test("mutation gating allows generate only (issue #458)", () => {
    const cap = textgenCapabilityFromDoc(CAPABILITY_DOC);
    expect(cap).not.toBeNull();
    // generate is advertised in both commands and mutation_commands.
    expect(textgenSupportsMutation(cap, "generate")).toBe(true);
    // Everything else — including advertised mutations — stays gated.
    for (const command of [
      "watch-next-prompt",
      "config set-default-provider",
      "config set-default-model",
      "config add-api-generator",
      "config remove-api-generator",
      "capability",
      "git-context",
    ]) {
      expect(textgenSupportsMutation(cap, command)).toBe(false);
    }
    // Probe states mirror textgenSupports: undefined = probing.
    expect(textgenSupportsMutation(undefined, "generate")).toBeNull();
    expect(textgenSupportsMutation(null, "generate")).toBe(false);
  });

  test("generate fails closed when the plugin does not advertise it", () => {
    const cap = textgenCapabilityFromDoc({
      ...CAPABILITY_DOC,
      commands: ["capability", "git-context"],
      mutation_commands: [],
    });
    expect(textgenSupportsMutation(cap, "generate")).toBe(false);
    const mutationsOnly = textgenCapabilityFromDoc({
      ...CAPABILITY_DOC,
      commands: ["capability"],
      mutation_commands: ["generate"],
    });
    expect(textgenSupportsMutation(mutationsOnly, "generate")).toBe(false);
  });
});

describe("textgen generate argv + result doc (issue #458)", () => {
  test("generate argv carries task and optional flags, never input", () => {
    // cli.ts parseArgs: input JSON travels on stdin (the plugin_call
    // `stdin` field), never argv — --input FILE has no remote channel.
    expect(
      textgenGenerateArgs({
        task: "commit_message",
        input: { diff: "diff --git a/f b/f" },
      }),
    ).toEqual(["--task", "commit_message"]);
    expect(
      textgenGenerateArgs({
        task: "pr_content",
        input: {},
        provider: "agent:claude",
        model: "claude-sonnet-4",
        paneId: "w1:p1",
        gitRoot: "/plugins/git",
        cwd: "/repo",
        timeoutMs: 300_000,
        allowExpensive: true,
      }),
    ).toEqual([
      "--task",
      "pr_content",
      "--provider",
      "agent:claude",
      "--model",
      "claude-sonnet-4",
      "--timeout",
      "300000",
      "--cwd",
      "/repo",
      "--git-pane",
      "w1:p1",
      "--git-root",
      "/plugins/git",
      "--allow-expensive",
    ]);
    // Empty optionals are omitted.
    expect(
      textgenGenerateArgs({
        task: "branch_name",
        input: {},
        provider: "",
        model: "",
        paneId: "",
        gitRoot: "",
        cwd: "",
      }),
    ).toEqual(["--task", "branch_name"]);
  });

  test("generate result parses task/provider/result/warnings/git_context", () => {
    const report = textgenGenerateFromDoc({
      contract: CONTRACT,
      command: "generate",
      ok: true,
      task: "commit_message",
      provider: "agent:claude",
      path: "agent",
      model: null,
      result: ["feat: add generation (#458)"],
      elapsed_ms: 12345,
      warnings: ["agent_availability_unverified"],
      git_context: {
        pane_id: "w1:p1",
        repo_root: "/repo",
        branch: "feature/x",
        sources: ["git-v1:status"],
      },
    });
    expect(report).not.toBeNull();
    expect(report?.task).toBe("commit_message");
    expect(report?.provider).toBe("agent:claude");
    expect(report?.path).toBe("agent");
    expect(report?.result).toEqual(["feat: add generation (#458)"]);
    expect(report?.elapsedMs).toBe(12345);
    expect(report?.warnings).toEqual(["agent_availability_unverified"]);
    expect(report?.gitContext?.paneId).toBe("w1:p1");
    expect(report?.gitContext?.sources).toEqual(["git-v1:status"]);
  });

  test("generate result rejects foreign contract, wrong command, failure", () => {
    expect(
      textgenGenerateFromDoc({ contract: "other/v9", command: "generate", ok: true, result: "x" }),
    ).toBeNull();
    expect(
      textgenGenerateFromDoc({ contract: CONTRACT, command: "capability", ok: true, result: "x" }),
    ).toBeNull();
    expect(
      textgenGenerateFromDoc({ contract: CONTRACT, command: "generate", ok: false, error: {} }),
    ).toBeNull();
    expect(
      textgenGenerateFromDoc({ contract: CONTRACT, command: "generate", ok: true }),
    ).toBeNull();
    expect(textgenGenerateFromDoc({})).toBeNull();
  });
});

describe("classifyTextgenError", () => {
  const err = (code: string, message = "boom") =>
    Object.assign(new Error(message), { code });

  test("plugin_* boundary codes map to the shared taxonomy", () => {
    expect(classifyTextgenError(err("plugin_not_installed")).reason).toBe("not_installed");
    expect(classifyTextgenError(err("plugin_disabled")).reason).toBe("disabled");
    for (const code of [
      "plugin_incompatible",
      "plugin_unsupported_command",
      "plugin_bad_output",
    ]) {
      expect(classifyTextgenError(err(code)).reason).toBe("incompatible");
    }
    for (const code of [
      "plugin_host_unreachable",
      "connect_failed",
      "unreachable",
      "machine_unavailable",
      "plugin_timeout",
    ]) {
      expect(classifyTextgenError(err(code)).reason).toBe("unreachable");
    }
  });

  test("plugin-side kinds stay error with verbatim detail", () => {
    for (const code of [
      "git_unavailable",
      "git_cli_failed",
      "task_not_opted_in",
      "quota_exceeded",
      "provider_unknown",
      "no_provider",
      "output_invalid_json",
      "usage",
    ]) {
      const classified = classifyTextgenError(err(code, `detail for ${code}`));
      expect(classified.reason).toBe("error");
      expect(classified.detail).toBe(`detail for ${code}`);
    }
  });

  test("textgenErrorHint surfaces structured hints verbatim", () => {
    const withHint = Object.assign(new Error("boom"), {
      code: "plugin_error",
      fields: { hint: "enable the api generator first" },
    });
    expect(textgenErrorHint(withHint)).toBe("enable the api generator first");
    expect(textgenErrorHint(new Error("plain"))).toBeNull();
    expect(textgenErrorHint(null)).toBeNull();
  });
});
