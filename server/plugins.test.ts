import { describe, expect, test } from "bun:test";
import { localPluginHost, PluginService, PLUGIN_ENV_SCRUB, type PluginExecOptions, type PluginExecOutcome, type PluginHost } from "./plugins.ts";
import { HerdrError } from "./herdr.ts";

/** Scripted host: each exec pops the next outcome for its argv match. */
function fakeHost(handlers: Array<{ match: (argv: string[]) => boolean; outcome: PluginExecOutcome }>): PluginHost & { calls: string[][]; options: PluginExecOptions[] } {
  const calls: string[][] = [];
  const options: PluginExecOptions[] = [];
  return {
    calls,
    options,
    async exec(argv: string[], execOptions: PluginExecOptions): Promise<PluginExecOutcome> {
      calls.push([...argv]);
      options.push(execOptions);
      const hit = handlers.find((h) => h.match(argv));
      if (!hit) return { code: 127, stdout: "", stderr: "no handler", timedOut: false };
      return hit.outcome;
    },
  };
}

const ok = (doc: unknown): PluginExecOutcome => ({
  code: 0,
  stdout: JSON.stringify(doc),
  stderr: "",
  timedOut: false,
});

const PLUGIN_LIST = {
  id: "x",
  result: {
    plugins: [
      {
        plugin_id: "rebuildup.inbox",
        name: "Inbox",
        version: "0.1.0",
        enabled: true,
        plugin_root: "/plugins/inbox",
      },
      { plugin_id: "other.off", enabled: false, plugin_root: "/plugins/off" },
      { plugin_id: "broken.no_root" },
    ],
  },
};

const CAPABILITY = {
  contract: "herdr-plugins.inbox/v1",
  version: "0.1.0",
  commands: ["list", "settle", "snooze", "restore", "capability"],
};

function inboxHost(extra: Array<{ match: (argv: string[]) => boolean; outcome: PluginExecOutcome }> = []) {
  return fakeHost([
    { match: (a) => a[0] === "herdr" && a.includes("plugin"), outcome: ok(PLUGIN_LIST) },
    { match: (a) => a[3] === "capability", outcome: ok(CAPABILITY) },
    ...extra,
  ]);
}

function serviceFor(host: PluginHost): PluginService {
  return new PluginService(async () => host);
}

describe("PluginService.listPlugins (ADR-0011)", () => {
  test("parses herdr plugin list --json envelope and drops malformed entries", async () => {
    const host = inboxHost();
    const result = await serviceFor(host).listPlugins("local");
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0]).toMatchObject({
      plugin_id: "rebuildup.inbox",
      enabled: true,
      plugin_root: "/plugins/inbox",
    });
    expect(result.plugins[1]?.enabled).toBe(false);
    // discovery ran `herdr plugin list --json` as argv
    expect(host.calls[0]).toEqual(["herdr", "plugin", "list", "--json"]);
  });

  test("surfaces transport failure as HerdrError", async () => {
    const host = fakeHost([
      { match: () => true, outcome: { code: null, stdout: "", stderr: "ssh died", timedOut: false, error: "ssh died" } },
    ]);
    await expect(serviceFor(host).listPlugins("m")).rejects.toMatchObject({ code: "plugin_exec_failed" });
  });
});

describe("PluginService.call", () => {
  test("runs <plugin_root>/src/cli.ts <command> as argv and returns the JSON doc", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: ok({ contract: "herdr-plugins.inbox/v1", command: "settle", ok: true }),
      },
    ]);
    const doc = await serviceFor(host).call("local", {
      plugin: "rebuildup.inbox",
      command: "settle",
      args: ["w1:p1"],
    });
    expect(doc["ok"]).toBe(true);
    const exec = host.calls.find((c) => c.includes("settle"));
    expect(exec).toEqual(["bun", "run", "src/cli.ts", "settle", "w1:p1"]);
  });

  test("appends --session only when the host names a non-default session", async () => {
    const host = inboxHost([
      { match: (a) => a[3] === "list", outcome: ok({ contract: "herdr-plugins.inbox/v1", items: [] }) },
    ]);
    host.pluginSession = "work";
    await serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "list" });
    const exec = host.calls.find((c) => c[3] === "list");
    expect(exec).toEqual(["bun", "run", "src/cli.ts", "list", "--session", "work"]);
  });

  test("not-installed / disabled / unsupported-command stay distinct", async () => {
    const svc = serviceFor(inboxHost());
    await expect(svc.call("local", { plugin: "nope.x", command: "list" })).rejects.toMatchObject({
      code: "plugin_not_installed",
    });
    await expect(svc.call("local", { plugin: "other.off", command: "list" })).rejects.toMatchObject({
      code: "plugin_disabled",
    });
    await expect(
      svc.call("local", { plugin: "rebuildup.inbox", command: "teleport" }),
    ).rejects.toMatchObject({ code: "plugin_unsupported_command" });
  });

  test("plugin contract error preserves the plugin's own code", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "snooze",
        outcome: {
          code: 2,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.inbox/v1",
            ok: false,
            error: { code: "usage", message: "--until is required" },
          }),
          timedOut: false,
        },
      },
    ]);
    await expect(
      serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "snooze", args: ["w1:p1"] }),
    ).rejects.toMatchObject({ code: "usage", message: "--until is required" });
  });

  test("timeout and non-JSON stdout are contract failures, not empty results", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "restore",
        outcome: { code: null, stdout: "", stderr: "", timedOut: true },
      },
    ]);
    await expect(
      serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "restore", args: ["w1:p1"] }),
    ).rejects.toMatchObject({ code: "plugin_timeout" });

    const host2 = inboxHost([
      { match: (a) => a[3] === "restore", outcome: { code: 0, stdout: "not json", stderr: "", timedOut: false } },
    ]);
    await expect(
      serviceFor(host2).call("local", { plugin: "rebuildup.inbox", command: "restore", args: ["w1:p1"] }),
    ).rejects.toMatchObject({ code: "plugin_bad_output" });
  });

  test("every exec kind scrubs ambient herdr targeting env (issues #228/#270)", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: ok({ contract: "herdr-plugins.inbox/v1", command: "settle", ok: true }),
      },
    ]);
    await serviceFor(host).call("local", {
      plugin: "rebuildup.inbox",
      command: "settle",
      args: ["w1:p1"],
    });
    // Plugin CLIs resolve the socket as HERDR_SOCKET_PATH >
    // --session/HERDR_SESSION > default (upstream resolveSocketPath), so
    // an ambient HERDR_SOCKET_PATH would override even the explicit
    // --session appended for named sessions — and HERDR_PANE_ID /
    // HERDR_PLUGIN_CONTEXT_JSON would hijack pane selection. Discovery
    // (`herdr plugin list` resolves a socket too), capability probes and
    // contract calls must all carry the same scrub list.
    expect(host.calls).toHaveLength(3);
    for (const options of host.options) {
      expect(options.envRemove).toEqual(PLUGIN_ENV_SCRUB);
    }
    expect(host.options[0]?.envRemove).toContain("HERDR_SOCKET_PATH");
    expect(host.options[0]?.envRemove).toContain("HERDR_SESSION");
    expect(host.options[0]?.envRemove).toContain("HERDR_PANE_ID");
    expect(host.options[0]?.envRemove).toContain("HERDR_PLUGIN_CONTEXT_JSON");
  });

  test("localPluginHost removes scrubbed vars from the child environment", async () => {
    const keys = ["HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_PANE_ID", "HERDR_PLUGIN_CONTEXT_JSON"];
    const saved = new Map<string, string | undefined>();
    for (const key of keys) {
      saved.set(key, process.env[key]);
      process.env[key] = "ambient-value";
    }
    process.env["HERDR_T3_KEEP_ME"] = "1";
    try {
      const outcome = await localPluginHost().exec(
        [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({socket:process.env.HERDR_SOCKET_PATH??null,session:process.env.HERDR_SESSION??null,pane:process.env.HERDR_PANE_ID??null,ctx:process.env.HERDR_PLUGIN_CONTEXT_JSON??null,keep:process.env.HERDR_T3_KEEP_ME??null}))",
        ],
        { timeoutMs: 15_000, envRemove: PLUGIN_ENV_SCRUB },
      );
      expect(outcome.code).toBe(0);
      expect(JSON.parse(outcome.stdout)).toEqual({
        socket: null,
        session: null,
        pane: null,
        ctx: null,
        keep: "1",
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env["HERDR_T3_KEEP_ME"];
    }
  });

  test("plugin error.kind is preserved as the failure code (git-v1 repo states)", async () => {
    const gitHost = fakeHost([
      {
        match: (a) => a[0] === "herdr" && a.includes("plugin"),
        outcome: ok({
          id: "x",
          result: {
            plugins: [
              {
                plugin_id: "rebuildup.git",
                enabled: true,
                plugin_root: "/plugins/git",
              },
            ],
          },
        }),
      },
      {
        match: (a) => a[3] === "capability",
        outcome: ok({
          contract: "herdr-plugins.git/v1",
          commands: ["capability", "status", "diff", "project"],
        }),
      },
      {
        match: (a) => a[3] === "status",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.git/v1",
            ok: false,
            error: { code: "error", kind: "not_a_repo", message: "no git work tree" },
          }),
          timedOut: false,
        },
      },
    ]);
    await expect(
      serviceFor(gitHost).call("local", { plugin: "rebuildup.git", command: "status", args: ["w1:p1"] }),
    ).rejects.toMatchObject({ code: "not_a_repo", message: "no git work tree" });
  });

  test("contract error extras are forwarded as bounded fields (issue #257)", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "snooze",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.inbox/v1",
            ok: false,
            error: {
              code: "error",
              kind: "repo_ambiguous",
              message: "pick a repo",
              project_id: "my-app",
              repos: ["/abs/repo", "/abs/repo2"],
              // Non-allowlisted / reserved keys must not cross the bridge.
              env: { SECRET: "x" },
              token: "abc",
              nested: { deep: { deeper: { deepest: "no" } } },
            },
          }),
          timedOut: false,
        },
      },
    ]);
    await expect(
      serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "snooze", args: ["w1:p1"] }),
    ).rejects.toMatchObject({
      code: "repo_ambiguous",
      fields: { project_id: "my-app", repos: ["/abs/repo", "/abs/repo2"] },
    });
  });

  test("checkpoints restore extras (panes, pre_restore_*) cross the bridge (#264)", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "restore",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.checkpoints/v1",
            ok: false,
            error: {
              code: "error",
              kind: "shared_worktree",
              message: "2 live panes share worktree",
              panes: ["w1:p1", "w2:p3"],
            },
          }),
          timedOut: false,
        },
      },
    ]);
    const shared = await serviceFor(host)
      .call("local", { plugin: "rebuildup.inbox", command: "restore", args: ["cp-1"] })
      .then(() => null)
      .catch((e: unknown) => e as HerdrError);
    expect(shared?.code).toBe("shared_worktree");
    expect(shared?.fields).toEqual({ panes: ["w1:p1", "w2:p3"] });

    const host2 = inboxHost([
      {
        match: (a) => a[3] === "restore",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.checkpoints/v1",
            ok: false,
            error: {
              code: "error",
              kind: "restore_failed",
              message: "git restore exited 1",
              pre_restore_checkpoint_id: "pre-9",
              pre_restore_ref: "refs/herdr-plugins/checkpoints/k/pre-9",
              pre_restore_commit: "abc123",
              env: { SECRET: "dropped" },
            },
          }),
          timedOut: false,
        },
      },
    ]);
    const failed = await serviceFor(host2)
      .call("local", { plugin: "rebuildup.inbox", command: "restore", args: ["cp-1"] })
      .then(() => null)
      .catch((e: unknown) => e as HerdrError);
    expect(failed?.code).toBe("restore_failed");
    expect(failed?.fields).toEqual({
      pre_restore_checkpoint_id: "pre-9",
      pre_restore_ref: "refs/herdr-plugins/checkpoints/k/pre-9",
      pre_restore_commit: "abc123",
    });
  });

  test("error fields are capped: field count, string length, value size", async () => {
    const long = "x".repeat(5000);
    const error: Record<string, unknown> = {
      code: "error",
      kind: "script_run_error",
      message: "boom",
      name: long, // truncated to the string cap
      // Serialized value exceeds the per-field cap → dropped entirely.
      reason: Array.from({ length: 64 }, () => "y".repeat(3000)),
    };
    // Non-allowlisted keys are dropped regardless of count.
    for (let i = 0; i < 40; i += 1) error[`target_${i}`] = `v${i}`;
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({ contract: "herdr-plugins.inbox/v1", ok: false, error }),
          timedOut: false,
        },
      },
    ]);
    const failure = await serviceFor(host)
      .call("local", { plugin: "rebuildup.inbox", command: "settle", args: ["w1:p1"] })
      .then(() => null)
      .catch((e: unknown) => e as HerdrError);
    expect(failure?.code).toBe("script_run_error");
    const fields = failure?.fields ?? {};
    expect(Object.keys(fields).length).toBeLessThanOrEqual(24);
    expect((fields["name"] as string).length).toBeLessThanOrEqual(2048);
    expect(fields["reason"]).toBeUndefined();
    // `target_N` keys are not in the allowlist — none may appear.
    expect(Object.keys(fields).every((k) => !k.startsWith("target_"))).toBe(true);
  });

  test("legacy contract errors without extras carry no fields", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "restore",
        outcome: {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({
            contract: "herdr-plugins.inbox/v1",
            ok: false,
            error: { code: "error", kind: "usage", message: "bad args" },
          }),
          timedOut: false,
        },
      },
    ]);
    const failure = await serviceFor(host)
      .call("local", { plugin: "rebuildup.inbox", command: "restore", args: ["w1:p1"] })
      .then(() => null)
      .catch((e: unknown) => e as HerdrError);
    expect(failure?.code).toBe("usage");
    expect(failure?.fields).toBeUndefined();
  });

  test("non-JSON stderr failures never produce fields", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "list",
        outcome: { code: 1, stdout: "", stderr: "segfault-ish text", timedOut: false },
      },
    ]);
    const failure = await serviceFor(host)
      .call("local", { plugin: "rebuildup.inbox", command: "list" })
      .then(() => null)
      .catch((e: unknown) => e as HerdrError);
    expect(failure?.code).toBe("plugin_error");
    expect(failure?.fields).toBeUndefined();
  });

  test("capability documents without a contract are incompatible", async () => {
    const host = fakeHost([
      { match: (a) => a[0] === "herdr" && a.includes("plugin"), outcome: ok(PLUGIN_LIST) },
      { match: (a) => a[3] === "capability", outcome: ok({ commands: ["list"] }) },
    ]);
    await expect(
      serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "list" }),
    ).rejects.toMatchObject({ code: "plugin_incompatible" });
  });
});
