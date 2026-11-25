import { describe, expect, test } from "bun:test";
import { PluginService, type PluginExecOptions, type PluginExecOutcome, type PluginHost } from "./plugins.ts";
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

  test("contract calls scrub herdr pane env vars via envRemove (issue #228)", async () => {
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
    const index = host.calls.findIndex((c) => c[3] === "settle");
    expect(index).toBeGreaterThanOrEqual(0);
    // Plugin CLIs resolve the pane from HERDR_PANE_ID /
    // HERDR_PLUGIN_CONTEXT_JSON when env is present — and for
    // branch/upstream env beats the positional — so every contract call
    // must strip them or a server running inside a herdr pane would
    // silently target the wrong pane.
    expect(host.options[index]?.envRemove).toEqual([
      "HERDR_PANE_ID",
      "HERDR_PLUGIN_CONTEXT_JSON",
    ]);
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
