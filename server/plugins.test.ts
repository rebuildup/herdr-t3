import { describe, expect, test } from "bun:test";
import { localPluginHost, pluginChildEnv, PluginService, PLUGIN_ENV_SCRUB, type PluginExecOptions, type PluginExecOutcome, type PluginHost } from "./plugins.ts";
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
  // Contract read/write declaration (plugins-boundary): only these mutate.
  mutation_commands: ["settle", "snooze", "restore"],
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

/**
 * Real-subprocess execs can exceed their inner timeout purely from
 * external CPU contention: under a cold parallel `cargo build` the
 * `bun -e` child can be starved past `timeoutMs` before it execs
 * (issues #385/#402 — observed as `code: null, timedOut: true` after
 * ~15s while the same spawn takes ~30ms unloaded). The env contract
 * itself is covered deterministically by the `pluginChildEnv` tests
 * below; this retry only absorbs spawn/startup latency — it never
 * retries assertion failures or non-timeout errors.
 */
async function execWithTimeoutRetry(
  host: PluginHost,
  argv: string[],
  options: PluginExecOptions,
  attempts = 3,
): Promise<PluginExecOutcome> {
  let outcome = await host.exec(argv, options);
  for (let attempt = 1; attempt < attempts && outcome.timedOut; attempt++) {
    outcome = await host.exec(argv, options);
  }
  return outcome;
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

describe("pluginChildEnv (issues #385/#402)", () => {
  test("removes every PLUGIN_ENV_SCRUB key and keeps unrelated vars", () => {
    const base: NodeJS.ProcessEnv = { HERDR_T3_KEEP_ME: "1", PATH: "/usr/bin" };
    for (const key of PLUGIN_ENV_SCRUB) base[key] = "ambient-value";
    const env = pluginChildEnv({ envRemove: PLUGIN_ENV_SCRUB }, base);
    expect(env).toBeDefined();
    for (const key of PLUGIN_ENV_SCRUB) {
      expect(env?.[key]).toBeUndefined();
    }
    expect(env?.["HERDR_T3_KEEP_ME"]).toBe("1");
    expect(env?.["PATH"]).toBe("/usr/bin");
    // The caller's base object is never mutated.
    expect(base["GIT_DIR"]).toBe("ambient-value");
  });

  test("envSet is applied after envRemove and wins over it", () => {
    const env = pluginChildEnv(
      {
        envRemove: ["HERDR_SOCKET_PATH", "GIT_DIR"],
        envSet: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      },
      { HERDR_SOCKET_PATH: "ambient", GIT_DIR: "ambient", KEEP: "1" },
    );
    expect(env?.["HERDR_SOCKET_PATH"]).toBe("/tmp/herdr.sock");
    expect(env?.["GIT_DIR"]).toBeUndefined();
    expect(env?.["KEEP"]).toBe("1");
  });

  test("returns undefined when there is nothing to remove or set", () => {
    expect(pluginChildEnv({}, { A: "1" })).toBeUndefined();
    expect(pluginChildEnv({ envRemove: [], envSet: {} })).toBeUndefined();
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

  test("concurrent identical calls share one plugin exec; different args do not (issue #424)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const host: PluginHost = {
      async exec(argv: string[]): Promise<PluginExecOutcome> {
        calls.push([...argv]);
        if (argv[0] === "herdr") return ok(PLUGIN_LIST);
        if (argv[3] === "capability") return ok(CAPABILITY);
        if (argv[3] === "list") {
          await gate;
          return ok({ contract: "herdr-plugins.inbox/v1", items: [] });
        }
        return { code: 127, stdout: "", stderr: "no handler", timedOut: false };
      },
    };
    const svc = serviceFor(host);
    // No caller flag: "list" is absent from mutation_commands, so the
    // contract itself marks it readable and the execs coalesce.
    const p1 = svc.call("local", { plugin: "rebuildup.inbox", command: "list" });
    const p2 = svc.call("local", { plugin: "rebuildup.inbox", command: "list" });
    const p3 = svc.call("local", { plugin: "rebuildup.inbox", command: "list", args: ["extra"] });
    release();
    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1).toEqual(d2);
    expect(d3).toEqual(d1);
    // Two `list` execs total: p1+p2 coalesced, p3's distinct args ran its own.
    expect(calls.filter((c) => c[0] === "bun" && c[3] === "list")).toHaveLength(2);
  });

  test("contract-declared mutations never merge, even when identical and concurrent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[][] = [];
    const host: PluginHost = {
      async exec(argv: string[]): Promise<PluginExecOutcome> {
        calls.push([...argv]);
        if (argv[0] === "herdr") return ok(PLUGIN_LIST);
        if (argv[3] === "capability") return ok(CAPABILITY);
        if (argv[3] === "settle") {
          await gate;
          return ok({ contract: "herdr-plugins.inbox/v1", command: "settle", ok: true });
        }
        return { code: 127, stdout: "", stderr: "no handler", timedOut: false };
      },
    };
    const svc = serviceFor(host);
    // Identical concurrent calls to a contract-declared mutation: the
    // mutation_commands declaration wins — each runs its own exec.
    const p1 = svc.call("local", { plugin: "rebuildup.inbox", command: "settle", args: ["w1:p1"] });
    const p2 = svc.call("local", { plugin: "rebuildup.inbox", command: "settle", args: ["w1:p1"] });
    release();
    await Promise.all([p1, p2]);
    expect(calls.filter((c) => c[0] === "bun" && c[3] === "settle")).toHaveLength(2);
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

  test("every exec kind scrubs ambient GIT_* repo/config/transport targeting env (issue #280)", async () => {
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
    // Upstream git-core spreads process.env into every `git` spawn, so
    // ambient GIT_DIR/GIT_CONFIG_*/GIT_SSH* would redirect plugin git
    // operations (checkpoints capture/restore, git status/diff/stage)
    // to a foreign repository, object store, config or transport —
    // upstream herdr-plugins#96. Discovery, capability probes and
    // contract calls must all carry the extended scrub list.
    expect(host.calls).toHaveLength(3);
    for (const options of host.options) {
      expect(options.envRemove).toEqual(PLUGIN_ENV_SCRUB);
    }
    const scrub = host.options[0]?.envRemove ?? [];
    for (const name of [
      // Repo / index / object-store targeting.
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_PREFIX",
      "GIT_CEILING_DIRECTORIES",
      "GIT_DISCOVERY_ACROSS_FILESYSTEM",
      // Config targeting / env-config injection. GIT_CONFIG_COUNT
      // neutralizes the GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n>
      // indexed family (inert without it); GIT_CONFIG_PARAMETERS is
      // git's internal `-c` passthrough.
      "GIT_CONFIG",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      // Transport / subprocess lookup.
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "GIT_PROXY_COMMAND",
      "GIT_EXEC_PATH",
    ]) {
      expect(scrub).toContain(name);
    }
    // Editor/pager and identity vars are intentionally not scrubbed.
    expect(scrub).not.toContain("GIT_PAGER");
    expect(scrub).not.toContain("GIT_EDITOR");
  });

  test("localPluginHost removes scrubbed vars from the child environment", async () => {
    const keys = [
      "HERDR_SOCKET_PATH",
      "HERDR_SESSION",
      "HERDR_PANE_ID",
      "HERDR_PLUGIN_CONTEXT_JSON",
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_SSH_COMMAND",
    ];
    const saved = new Map<string, string | undefined>();
    for (const key of keys) {
      saved.set(key, process.env[key]);
      process.env[key] = "ambient-value";
    }
    process.env["HERDR_T3_KEEP_ME"] = "1";
    try {
      const outcome = await execWithTimeoutRetry(
        localPluginHost(),
        [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({socket:process.env.HERDR_SOCKET_PATH??null,session:process.env.HERDR_SESSION??null,pane:process.env.HERDR_PANE_ID??null,ctx:process.env.HERDR_PLUGIN_CONTEXT_JSON??null,gitdir:process.env.GIT_DIR??null,gitworktree:process.env.GIT_WORK_TREE??null,gitindex:process.env.GIT_INDEX_FILE??null,gitcfgcount:process.env.GIT_CONFIG_COUNT??null,gitcfgparams:process.env.GIT_CONFIG_PARAMETERS??null,gitssh:process.env.GIT_SSH_COMMAND??null,keep:process.env.HERDR_T3_KEEP_ME??null}))",
        ],
        { timeoutMs: 15_000, envRemove: PLUGIN_ENV_SCRUB },
      );
      expect(outcome.code).toBe(0);
      expect(JSON.parse(outcome.stdout)).toEqual({
        socket: null,
        session: null,
        pane: null,
        ctx: null,
        gitdir: null,
        gitworktree: null,
        gitindex: null,
        gitcfgcount: null,
        gitcfgparams: null,
        gitssh: null,
        keep: "1",
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env["HERDR_T3_KEEP_ME"];
    }
    // Spawns a real `bun -e` child whose own budget is 15s per attempt.
    // execWithTimeoutRetry absorbs pure spawn/startup starvation under
    // external CPU load (issues #385/#402); worst case is 3 attempts,
    // so the test timeout must cover ~45s of child budget.
  }, 60_000);

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

  test("partial-failure convention: stdout report + stderr error + exit 1 returns the report doc", async () => {
    // checkpoints-v1 save/restore-group/gc/prune print the full per-repo
    // report on stdout, a {kind:"partial_*"|"unreachable_repos"} summary
    // on stderr and exit 1. The bridge must not collapse that into a
    // bare HerdrError — the report doc comes back with `error` attached.
    const report = {
      contract: "herdr-plugins.checkpoints/v1",
      command: "save",
      ok: false,
      group: "grp-1",
      total: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { repo_root: "/a", ok: true, checkpoint: { id: "cp-1" } },
        { repo_root: "/b", ok: false, error: { kind: "not_a_repo", message: "no git" } },
      ],
    };
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: {
          code: 1,
          stdout: JSON.stringify(report),
          stderr: JSON.stringify({
            contract: "herdr-plugins.checkpoints/v1",
            ok: false,
            error: {
              code: "error",
              kind: "partial_save",
              message: "save grp-1: 1 of 2 repos failed",
            },
          }),
          timedOut: false,
        },
      },
    ]);
    const doc = await serviceFor(host).call("local", {
      plugin: "rebuildup.inbox",
      command: "settle",
      args: ["w1:p1"],
    });
    expect(doc["ok"]).toBe(false);
    expect(doc["group"]).toBe("grp-1");
    expect((doc["results"] as unknown[]).length).toBe(2);
    expect(doc["error"]).toMatchObject({ kind: "partial_save" });
  });

  test("exit-nonzero with ok:false stdout report and no stderr doc returns the report (secrets resolve)", async () => {
    // secrets-v1 `resolve` exits 1 when any binding is unresolved and
    // prints the per-binding report on stdout with ok:false — there is
    // no stderr error document for per-binding failures (issue #454).
    // The bridge must hand the report back as the result document with
    // the exit status attached, not collapse it into a bare error.
    const report = {
      contract: "herdr-plugins.secrets/v1",
      command: "resolve",
      ok: false,
      bindings: [
        { name: "alpha", env: "ALPHA_KEY", ref: "infisical:dev:/:ALPHA", status: "resolved" },
        { name: "missing", env: "MISSING_KEY", ref: "infisical:dev:/:MISSING", status: "unresolved", detail: "secret MISSING not found at dev:/" },
      ],
    };
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: { code: 1, stdout: JSON.stringify(report), stderr: "", timedOut: false },
      },
    ]);
    const doc = await serviceFor(host).call("local", {
      plugin: "rebuildup.inbox",
      command: "settle",
      args: ["w1:p1"],
    });
    expect(doc["ok"]).toBe(false);
    expect(doc["command"]).toBe("resolve");
    expect((doc["bindings"] as unknown[]).length).toBe(2);
    expect(doc["error"]).toMatchObject({ code: "plugin_exit", kind: "exit_1" });
  });

  test("non-zero exit with stdout doc that is NOT ok:false still throws", async () => {
    const host = inboxHost([
      {
        match: (a) => a[3] === "settle",
        outcome: {
          code: 1,
          stdout: JSON.stringify({ contract: "x/v1", ok: true, command: "settle" }),
          stderr: JSON.stringify({
            contract: "x/v1",
            ok: false,
            error: { code: "error", kind: "usage", message: "bad args" },
          }),
          timedOut: false,
        },
      },
    ]);
    await expect(
      serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "settle", args: ["w1:p1"] }),
    ).rejects.toMatchObject({ code: "usage" });
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

describe("PluginService probe failure caching (issue #339)", () => {
  /** Stateful host: the capability probe fails until `heal()` flips it. */
  function flakyCapabilityHost() {
    let healed = false;
    const calls: string[][] = [];
    const host: PluginHost & { calls: string[][]; heal: () => void } = {
      calls,
      heal: () => {
        healed = true;
      },
      async exec(argv: string[]): Promise<PluginExecOutcome> {
        calls.push([...argv]);
        if (argv[0] === "herdr" && argv.includes("plugin")) return ok(PLUGIN_LIST);
        if (argv[3] === "capability") {
          if (!healed) {
            return { code: 127, stdout: "", stderr: "bun: command not found", timedOut: false };
          }
          return ok(CAPABILITY);
        }
        return ok({ contract: "herdr-plugins.inbox/v1", command: argv[3], ok: true });
      },
    };
    return host;
  }

  test("a failed capability probe is retried on the next call, not served from cache", async () => {
    const host = flakyCapabilityHost();
    const svc = serviceFor(host);
    await expect(
      svc.call("m", { plugin: "rebuildup.inbox", command: "list" }),
    ).rejects.toMatchObject({ code: "plugin_error" });
    host.heal();
    const doc = await svc.call("m", { plugin: "rebuildup.inbox", command: "list" });
    expect(doc["ok"]).toBe(true);
    // discovery ran once (success is cached); capability probed twice —
    // the cold-start failure must not occupy the TTL window.
    const capabilityCalls = host.calls.filter((c) => c[3] === "capability");
    expect(capabilityCalls).toHaveLength(2);
  });

  test("a failed discovery probe is retried on the next call, not served from cache", async () => {
    let healed = false;
    const calls: string[][] = [];
    const host: PluginHost & { calls: string[][]; heal: () => void } = {
      calls,
      heal: () => {
        healed = true;
      },
      async exec(argv: string[]): Promise<PluginExecOutcome> {
        calls.push([...argv]);
        if (argv[0] === "herdr" && argv.includes("plugin")) {
          if (!healed) {
            return { code: 1, stdout: "", stderr: "ssh bridge reset", timedOut: false };
          }
          return ok(PLUGIN_LIST);
        }
        if (argv[3] === "capability") return ok(CAPABILITY);
        return ok({ contract: "herdr-plugins.inbox/v1", command: argv[3], ok: true });
      },
    };
    const svc = serviceFor(host);
    await expect(svc.listPlugins("m")).rejects.toMatchObject({ code: "plugin_error" });
    host.heal();
    const result = await svc.listPlugins("m");
    expect(result.plugins).toHaveLength(2);
    const discoveryCalls = host.calls.filter((c) => c[0] === "herdr" && c.includes("plugin"));
    expect(discoveryCalls).toHaveLength(2);
  });
});

describe("plugin host session/socket targeting (issue #289)", () => {
  const SOCKET = "/cfg/herdr/sessions/ht3rc/herdr.sock";

  function socketHost() {
    const host = inboxHost([
      {
        match: (a) => a[3] === "list",
        outcome: ok({ contract: "herdr-plugins.inbox/v1", items: [] }),
      },
    ]);
    host.pluginSocket = SOCKET;
    return host;
  }

  test("every exec kind targets the bridge socket: --socket argv + HERDR_SOCKET_PATH env", async () => {
    const host = socketHost();
    const svc = serviceFor(host);
    await svc.call("local", { plugin: "rebuildup.inbox", command: "list" });
    // call order: discovery, capability probe, contract call.
    expect(host.calls).toHaveLength(3);
    // `herdr plugin list` has no --socket flag; the bridge-resolved
    // socket travels as HERDR_SOCKET_PATH, re-pinned after the scrub.
    expect(host.calls[0]).toEqual(["herdr", "plugin", "list", "--json"]);
    expect(host.options[0]?.envSet).toEqual({ HERDR_SOCKET_PATH: SOCKET });
    expect(host.options[0]?.envRemove).toEqual(PLUGIN_ENV_SCRUB);
    // Plugin CLIs take the explicit --socket (beats env/default upstream).
    expect(host.calls[1]).toEqual(["bun", "run", "src/cli.ts", "capability", "--socket", SOCKET]);
    expect(host.calls[2]).toEqual(["bun", "run", "src/cli.ts", "list", "--socket", SOCKET]);
    // Plugin-CLI execs need no env pin: --socket already wins over any
    // ambient HERDR_SOCKET_PATH/HERDR_SESSION.
    expect(host.options[1]?.envSet).toBeUndefined();
    expect(host.options[2]?.envSet).toBeUndefined();
  });

  test("--socket wins over --session when a host sets both", async () => {
    const host = socketHost();
    host.pluginSession = "work";
    await serviceFor(host).call("local", { plugin: "rebuildup.inbox", command: "list" });
    const callArgv = host.calls.find((c) => c[0] === "bun" && c[3] === "list");
    expect(callArgv).toEqual(["bun", "run", "src/cli.ts", "list", "--socket", SOCKET]);
  });

  test("localPluginHost resolves HERDR_SOCKET as pluginSocket (the #289 scenario)", () => {
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = SOCKET;
    try {
      expect(localPluginHost().pluginSocket).toBe(SOCKET);
    } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
    }
    // An explicit path still wins for tests/custom wiring.
    expect(localPluginHost("/explicit/herdr.sock").pluginSocket).toBe("/explicit/herdr.sock");
  });

  test("envSet re-pins HERDR_SOCKET_PATH after the scrub in the local spawn", async () => {
    const outcome = await execWithTimeoutRetry(
      localPluginHost(),
      [process.execPath, "-e", "console.log(process.env.HERDR_SOCKET_PATH ?? 'unset')"],
      {
        timeoutMs: 15_000,
        envRemove: ["HERDR_SOCKET_PATH"],
        envSet: { HERDR_SOCKET_PATH: SOCKET },
      },
    );
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.trim()).toBe(SOCKET);
    // Real subprocess spawn; see the scrubbed-vars test above — the
    // inner 15s budget needs headroom over spawn starvation under load.
  }, 60_000);

  test("localPluginHost writes stdin payload and closes it (issue #458)", async () => {
    const outcome = await execWithTimeoutRetry(
      localPluginHost(),
      [
        process.execPath,
        "-e",
        "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify({got:d})))",
      ],
      { timeoutMs: 15_000, stdin: '{"task":"commit_message"}' },
    );
    expect(outcome.code).toBe(0);
    expect(JSON.parse(outcome.stdout)).toEqual({ got: '{"task":"commit_message"}' });
    // No stdin → immediate EOF (a stdin-reading CLI must not hang).
    const empty = await execWithTimeoutRetry(
      localPluginHost(),
      [process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('eof'))"],
      { timeoutMs: 15_000 },
    );
    expect(empty.code).toBe(0);
    expect(empty.stdout.trim()).toBe("eof");
    // Real subprocess spawns; same headroom as the tests above.
  }, 120_000);
});
