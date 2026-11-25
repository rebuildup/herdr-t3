import { describe, expect, test } from "bun:test";
import {
  classifyProjectScriptsError,
  projectScriptsListArgs,
  projectScriptsListFromDoc,
  projectScriptsLogsArgs,
  projectScriptsResultsArgs,
  projectScriptsRunArgs,
  projectScriptsStopArgs,
  projectsCapabilityFromDoc,
  projectsListArgs,
  projectsListFromDoc,
  repoAmbiguousRepoRoots,
  scriptLogsFromDoc,
  scriptResultsFromDoc,
  scriptRunFromDoc,
  scriptRunResultFromDoc,
  scriptStopFromDoc,
} from "./projectScripts";

const LIST_DOC = {
  contract: "herdr-plugins.projects/v1",
  command: "list",
  projects: [
    {
      id: "my-app",
      title: "My App",
      repos: [
        { root: "/abs/repo", remote: "github.com/org/repo", added_at: "2026-11-01T00:00:00Z" },
        { root: "/abs/repo2", remote: null },
      ],
      pinned: true,
      archived: false,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-02T00:00:00Z",
      future_field: { nested: true },
    },
    { malformed: true },
  ],
  generated_at: "2026-11-25T00:00:00.000Z",
};

describe("projectsListFromDoc (herdr-plugins.projects/v1)", () => {
  test("projects the registry list for the picker", () => {
    const result = projectsListFromDoc(LIST_DOC);
    expect(result).not.toBeNull();
    expect(result?.projects).toHaveLength(1);
    const project = result?.projects[0];
    expect(project?.id).toBe("my-app");
    expect(project?.title).toBe("My App");
    expect(project?.pinned).toBe(true);
    expect(project?.archived).toBe(false);
    expect(project?.repos).toEqual([
      { root: "/abs/repo", remote: "github.com/org/repo" },
      { root: "/abs/repo2", remote: null },
    ]);
  });

  test("rejects foreign contracts and malformed docs", () => {
    expect(projectsListFromDoc({ ...LIST_DOC, contract: "herdr-plugins.git/v1" })).toBeNull();
    expect(projectsListFromDoc({ ...LIST_DOC, command: "show" })).toBeNull();
    expect(projectsListFromDoc({ contract: "herdr-plugins.projects/v1" })).toBeNull();
    expect(projectsListFromDoc({ projects: "nope" })).toBeNull();
  });
});

describe("projects argv builders", () => {
  test("list takes no positional args; --all is the only flag", () => {
    expect(projectsListArgs()).toEqual([]);
    expect(projectsListArgs({ all: true })).toEqual(["--all"]);
    expect(projectsListArgs({ all: false })).toEqual([]);
  });
});

describe("projectScriptsListFromDoc", () => {
  const SCRIPTS_DOC = {
    contract: "herdr-plugins.projects/v1",
    command: "scripts list",
    project_id: "my-app",
    repo_root: "/abs/repo",
    scripts: [
      {
        id: "dev",
        name: "Dev server",
        command: "bun run dev",
        icon: "play",
        runOnWorktreeCreate: true,
        runOnSettle: false,
        source: "t3.json",
      },
      {
        name: "Lint",
        command: "bun run lint",
        source: "override",
        runOnSettle: true,
        stopOnSettle: true,
        async: true,
        previewUrl: "http://localhost:3000",
        autoOpenPreview: true,
      },
      { malformed: true },
    ],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("projects resolved script definitions with optional fields", () => {
    const result = projectScriptsListFromDoc(SCRIPTS_DOC);
    expect(result).not.toBeNull();
    expect(result?.project_id).toBe("my-app");
    expect(result?.repo_root).toBe("/abs/repo");
    expect(result?.scripts).toHaveLength(2);
    const dev = result?.scripts[0];
    expect(dev?.id).toBe("dev");
    expect(dev?.name).toBe("Dev server");
    expect(dev?.runOnWorktreeCreate).toBe(true);
    expect(dev?.runOnSettle).toBe(false);
    expect(dev?.source).toBe("t3.json");
    // `id` falls back to `name` when absent.
    const lint = result?.scripts[1];
    expect(lint?.id).toBe("Lint");
    expect(lint?.asyncRun).toBe(true);
    expect(lint?.previewUrl).toBe("http://localhost:3000");
    expect(lint?.autoOpenPreview).toBe(true);
    expect(lint?.stopOnSettle).toBe(true);
  });

  test("project_id is null for a bare repo path target", () => {
    const result = projectScriptsListFromDoc({
      ...SCRIPTS_DOC,
      project_id: null,
      scripts: [],
    });
    expect(result?.project_id).toBeNull();
    expect(result?.scripts).toEqual([]);
  });

  test("rejects foreign contracts, wrong command, and malformed docs", () => {
    expect(
      projectScriptsListFromDoc({ ...SCRIPTS_DOC, contract: "herdr-plugins.inbox/v1" }),
    ).toBeNull();
    expect(projectScriptsListFromDoc({ ...SCRIPTS_DOC, command: "scripts run" })).toBeNull();
    expect(projectScriptsListFromDoc({ ...SCRIPTS_DOC, scripts: "nope" })).toBeNull();
  });
});

describe("script argv builders (subcommands are args, not command words)", () => {
  test("scripts list: subcommand + target + optional --repo pair", () => {
    expect(projectScriptsListArgs("my-app")).toEqual(["list", "my-app"]);
    expect(projectScriptsListArgs("my-app", { repo: "/abs/repo2" })).toEqual([
      "list",
      "my-app",
      "--repo",
      "/abs/repo2",
    ]);
    expect(projectScriptsListArgs("/abs/repo", { repo: "  " })).toEqual(["list", "/abs/repo"]);
  });

  test("scripts run: project + name + optional --repo; never auto-picks", () => {
    expect(projectScriptsRunArgs("my-app", "dev")).toEqual(["run", "my-app", "dev"]);
    expect(projectScriptsRunArgs("my-app", "dev", { repo: "/abs/repo" })).toEqual([
      "run",
      "my-app",
      "dev",
      "--repo",
      "/abs/repo",
    ]);
  });

  test("scripts stop/results/logs argv shapes", () => {
    expect(projectScriptsStopArgs("run-abc123")).toEqual(["stop", "run-abc123"]);
    expect(projectScriptsStopArgs("my-app")).toEqual(["stop", "my-app"]);
    expect(projectScriptsResultsArgs()).toEqual(["results"]);
    expect(projectScriptsResultsArgs("my-app")).toEqual(["results", "my-app"]);
    expect(projectScriptsResultsArgs("  ")).toEqual(["results"]);
    expect(projectScriptsLogsArgs("run-abc")).toEqual(["logs", "run-abc"]);
  });
});

const RUN_DOC = {
  run_id: "run-mj3k2x-9f3ab1",
  project_id: "my-app",
  script: { id: "dev", name: "Dev server", command: "bun run dev", source: "t3.json" },
  repo: { root: "/abs/repo", remote: "github.com/org/repo" },
  pane_id: "wKN:p1",
  workspace_id: "wKN",
  tab_id: "wKN:t1",
  cwd: "/abs/repo",
  command_line: 'bun run dev; echo "__HERDR_DONE_run-mj3k2x-9f3ab1__=$?"',
  script_path: null,
  started_at: "2026-11-25T00:00:00.000Z",
  finished_at: "2026-11-25T00:05:00.000Z",
  exit_code: 0,
  result: "success",
  log_path: "runs/run-mj3k2x-9f3ab1.log",
  error: null,
};

describe("scriptRunFromDoc", () => {
  test("projects a full run record", () => {
    const run = scriptRunFromDoc(RUN_DOC);
    expect(run).not.toBeNull();
    expect(run?.run_id).toBe("run-mj3k2x-9f3ab1");
    expect(run?.result).toBe("success");
    expect(run?.exit_code).toBe(0);
    expect(run?.script?.name).toBe("Dev server");
    expect(run?.repo?.root).toBe("/abs/repo");
    expect(run?.finished_at).toBe("2026-11-25T00:05:00.000Z");
  });

  test("tolerates missing optional fields; running is honest", () => {
    const run = scriptRunFromDoc({
      run_id: "run-x",
      project_id: null,
      result: "running",
      exit_code: null,
      finished_at: null,
    });
    expect(run?.result).toBe("running");
    expect(run?.exit_code).toBeNull();
    expect(run?.script).toBeNull();
    expect(run?.repo).toBeNull();
    expect(run?.pane_id).toBeNull();
  });

  test("rejects docs without run_id", () => {
    expect(scriptRunFromDoc({ result: "success" })).toBeNull();
    expect(scriptRunFromDoc("nope")).toBeNull();
    expect(scriptRunFromDoc(null)).toBeNull();
  });
});

describe("script result document parsers", () => {
  test("scripts run document", () => {
    const doc = {
      contract: "herdr-plugins.projects/v1",
      command: "scripts run",
      run: RUN_DOC,
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = scriptRunResultFromDoc(doc);
    expect(result?.run.run_id).toBe("run-mj3k2x-9f3ab1");
    expect(scriptRunResultFromDoc({ ...doc, contract: "other/v1" })).toBeNull();
    expect(scriptRunResultFromDoc({ ...doc, command: "scripts stop" })).toBeNull();
    expect(scriptRunResultFromDoc({ ...doc, run: { nope: true } })).toBeNull();
  });

  test("scripts stop document with outcomes", () => {
    const doc = {
      contract: "herdr-plugins.projects/v1",
      command: "scripts stop",
      outcomes: [
        { run: { ...RUN_DOC, result: "stopped", exit_code: null }, action: "stopped" },
        { run: RUN_DOC, action: "already_finished" },
        { run: { ...RUN_DOC, result: "unknown" }, action: "pane_gone" },
      ],
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = scriptStopFromDoc(doc);
    expect(result?.outcomes).toHaveLength(3);
    expect(result?.outcomes[0]?.action).toBe("stopped");
    expect(result?.outcomes[0]?.run.result).toBe("stopped");
    expect(result?.outcomes[2]?.action).toBe("pane_gone");
    expect(scriptStopFromDoc({ ...doc, outcomes: "nope" })).toBeNull();
    expect(scriptStopFromDoc({ ...doc, contract: "x/v9" })).toBeNull();
  });

  test("scripts results document", () => {
    const doc = {
      contract: "herdr-plugins.projects/v1",
      command: "scripts results",
      project_id: "my-app",
      runs: [RUN_DOC, { run_id: "run-y", result: "running" }, { bad: true }],
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = scriptResultsFromDoc(doc);
    expect(result?.project_id).toBe("my-app");
    expect(result?.runs).toHaveLength(2);
    expect(result?.runs[1]?.result).toBe("running");
    expect(scriptResultsFromDoc({ ...doc, runs: [] })).not.toBeNull();
    expect(scriptResultsFromDoc({ ...doc, command: "scripts list" })).toBeNull();
  });

  test("scripts logs document; log may be null", () => {
    const doc = {
      contract: "herdr-plugins.projects/v1",
      command: "scripts logs",
      run_id: "run-mj3k2x-9f3ab1",
      run: RUN_DOC,
      log_path: "runs/run-mj3k2x-9f3ab1.log",
      log: "line1\nline2\n",
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    const result = scriptLogsFromDoc(doc);
    expect(result?.run_id).toBe("run-mj3k2x-9f3ab1");
    expect(result?.log).toContain("line1");
    expect(result?.run?.run_id).toBe("run-mj3k2x-9f3ab1");
    expect(scriptLogsFromDoc({ ...doc, log: null })?.log).toBeNull();
    expect(scriptLogsFromDoc({ ...doc, run_id: null })).toBeNull();
    expect(scriptLogsFromDoc({ ...doc, contract: "x/v1" })).toBeNull();
  });
});

describe("projectsCapabilityFromDoc", () => {
  test("normalizes commands and mutation_commands pairs", () => {
    const cap = projectsCapabilityFromDoc({
      contract: "herdr-plugins.projects/v1",
      version: "0.1.0",
      read_only: false,
      commands: ["capability", "list", "show", "discover", "register", "update", "settings", "scripts", "repos"],
      mutation_commands: [
        "register",
        "update",
        "repos add",
        "repos remove",
        "archive",
        "unarchive",
        "pin",
        "unpin",
        "settings set",
        "settings unset",
        "scripts run",
        "scripts stop",
      ],
    });
    expect(cap?.contractOk).toBe(true);
    expect(cap?.commands.has("scripts")).toBe(true);
    expect(cap?.commands.has("list")).toBe(true);
    // Subcommands are NOT commands; they live in mutation_commands pairs.
    expect(cap?.commands.has("scripts run")).toBe(false);
    expect(cap?.mutationCommands.has("scripts run")).toBe(true);
    expect(cap?.mutationCommands.has("scripts stop")).toBe(true);
    expect(cap?.readOnly).toBe(false);
  });

  test("rejects foreign or missing contracts", () => {
    expect(projectsCapabilityFromDoc({ contract: "herdr-plugins.git/v1", commands: [] })).toBeNull();
    expect(projectsCapabilityFromDoc({ commands: ["list"] })).toBeNull();
    expect(
      projectsCapabilityFromDoc({ contract: "herdr-plugins.projects/v1" })?.commands.size,
    ).toBe(0);
  });
});

describe("classifyProjectScriptsError", () => {
  const err = (code: string, message = "m") => Object.assign(new Error(message), { code });

  test("boundary codes map to unavailable reasons", () => {
    expect(classifyProjectScriptsError(err("plugin_not_installed"))).toMatchObject({
      kind: "unavailable",
      reason: "not_installed",
    });
    expect(classifyProjectScriptsError(err("plugin_disabled"))).toMatchObject({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(classifyProjectScriptsError(err("plugin_unsupported_command"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyProjectScriptsError(err("plugin_incompatible"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyProjectScriptsError(err("plugin_host_unreachable"))).toMatchObject({
      kind: "unavailable",
      reason: "unreachable",
    });
    expect(classifyProjectScriptsError(err("plugin_bad_output"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
  });

  test("plugin kinds pass through with their code preserved", () => {
    for (const code of [
      "project_not_found",
      "repo_not_found",
      "no_repos",
      "repo_ambiguous",
      "unknown_script",
      "ambiguous_script",
      "ambiguous_run",
      "run_not_found",
      "no_running_runs",
      "script_run_error",
      "t3json_invalid",
      "invalid_script_list",
      "not_a_repo",
      "bare_repo",
      "git_missing",
      "timeout",
      "git_error",
      "usage",
    ]) {
      expect(classifyProjectScriptsError(err(code))).toMatchObject({
        kind: "plugin",
        code,
      });
    }
  });

  test("unknown codes degrade to plugin_error, never a fake success", () => {
    expect(classifyProjectScriptsError(err("something_new"))).toMatchObject({
      kind: "plugin",
      code: "plugin_error",
    });
    expect(classifyProjectScriptsError("boom")).toMatchObject({
      kind: "plugin",
      code: "plugin_error",
    });
  });

  test("bounded contract error fields pass through to the classified error", () => {
    const withFields = Object.assign(new Error("pick a repo"), {
      code: "repo_ambiguous",
      fields: { project_id: "my-app", repos: ["/abs/a", "/abs/b"] },
    });
    expect(classifyProjectScriptsError(withFields)).toMatchObject({
      kind: "plugin",
      code: "repo_ambiguous",
      fields: { project_id: "my-app", repos: ["/abs/a", "/abs/b"] },
    });
    // Non-record fields are ignored; unavailable reasons never carry them.
    const badFields = Object.assign(new Error("m"), { code: "repo_ambiguous", fields: "nope" });
    expect(classifyProjectScriptsError(badFields)).not.toHaveProperty("fields");
    const boundary = Object.assign(new Error("m"), {
      code: "plugin_disabled",
      fields: { key: "x" },
    });
    expect(classifyProjectScriptsError(boundary)).not.toHaveProperty("fields");
  });
});

describe("repoAmbiguousRepoRoots (issue #257)", () => {
  test("reads repos from error fields; null without usable fields", () => {
    const err = Object.assign(new Error("m"), {
      code: "repo_ambiguous",
      fields: { repos: ["/abs/a", "/abs/b", 3, ""] },
    });
    expect(repoAmbiguousRepoRoots(err)).toEqual(["/abs/a", "/abs/b"]);
    // Older plugin revisions: no fields at all → caller falls back to list.
    expect(repoAmbiguousRepoRoots(new Error("m"))).toBeNull();
    expect(repoAmbiguousRepoRoots(Object.assign(new Error("m"), { fields: {} }))).toBeNull();
    expect(
      repoAmbiguousRepoRoots(Object.assign(new Error("m"), { fields: { repos: "nope" } })),
    ).toBeNull();
    expect(
      repoAmbiguousRepoRoots(Object.assign(new Error("m"), { fields: { repos: [] } })),
    ).toBeNull();
  });
});

// Fetch/mutation wrappers (fetchProjectScriptsList, runProjectScript,
// stopProjectScripts, fetchScriptResults, fetchScriptLogs) are thin
// pluginCall pass-throughs validated by the parsers and argv builders
// above; they carry no additional logic to unit-test without a host.
