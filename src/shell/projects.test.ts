import { describe, expect, test } from "bun:test";
import {
  classifyProjectsError,
  projectMutationFromDoc,
  projectReposFromDoc,
  projectSettingsFromDoc,
  projectShowFromDoc,
  projectsCapabilityFromDoc,
  projectsDiscoverArgs,
  projectsDiscoverFromDoc,
  projectsFlagArgs,
  projectsListArgs,
  projectsListFromDoc,
  projectsRegisterArgs,
  projectsReposListArgs,
  projectsReposPathsArgs,
  projectsSettingsGetArgs,
  projectsSettingsSetArgs,
  projectsSettingsUnsetArgs,
  projectsShowArgs,
  projectsUpdateArgs,
} from "./projects";

const CONTRACT = "herdr-plugins.projects/v1";

const PROJECT = {
  id: "my-app",
  title: "My App",
  repos: [
    {
      root: "/abs/repo",
      remote: "github.com/org/repo",
      added_at: "2026-11-20T00:00:00.000Z",
    },
  ],
  pinned: true,
  archived: false,
  created_at: "2026-11-20T00:00:00.000Z",
  updated_at: "2026-11-21T00:00:00.000Z",
};

describe("projects argv builders (herdr-plugins.projects/v1 @c8460283)", () => {
  test("list/show/discover argv", () => {
    expect(projectsListArgs()).toEqual([]);
    expect(projectsListArgs({ all: true })).toEqual(["--all"]);
    expect(projectsShowArgs("my-app")).toEqual(["my-app"]);
    expect(projectsDiscoverArgs()).toEqual([]);
  });

  test("register: positional path, optional --title/--id", () => {
    expect(projectsRegisterArgs({ path: "/repo" })).toEqual(["/repo"]);
    expect(
      projectsRegisterArgs({ path: "/repo", title: "My App", id: "my-app" }),
    ).toEqual(["/repo", "--title", "My App", "--id", "my-app"]);
    expect(projectsRegisterArgs({ path: "/repo", title: "  " })).toEqual(["/repo"]);
  });

  test("update: id first, flags and repeated repo paths", () => {
    expect(projectsUpdateArgs("my-app")).toEqual(["my-app"]);
    expect(
      projectsUpdateArgs("my-app", {
        title: "New title",
        pinned: true,
        archived: false,
        repoAdd: ["/a", "/b"],
        repoRemove: ["/c"],
      }),
    ).toEqual([
      "my-app",
      "--title",
      "New title",
      "--pinned",
      "--unarchived",
      "--repo-add",
      "/a",
      "--repo-add",
      "/b",
      "--repo-remove",
      "/c",
    ]);
    expect(projectsUpdateArgs("my-app", { pinned: false, archived: true })).toEqual([
      "my-app",
      "--unpinned",
      "--archived",
    ]);
  });

  test("flag setters take only the id", () => {
    expect(projectsFlagArgs("my-app")).toEqual(["my-app"]);
  });

  test("settings argv: subcommand first under the settings command", () => {
    expect(projectsSettingsGetArgs("my-app")).toEqual(["get", "my-app"]);
    expect(projectsSettingsGetArgs("my-app", "display.title")).toEqual([
      "get",
      "my-app",
      "display.title",
    ]);
    expect(projectsSettingsSetArgs("my-app", "display.title", ["hello world"])).toEqual([
      "set",
      "my-app",
      "display.title",
      "hello world",
    ]);
    expect(projectsSettingsUnsetArgs("my-app", "display.title")).toEqual([
      "unset",
      "my-app",
      "display.title",
    ]);
  });

  test("repos argv: subcommand first, --path repeated for add/remove", () => {
    expect(projectsReposListArgs("my-app")).toEqual(["list", "my-app"]);
    expect(projectsReposPathsArgs("add", "my-app", ["/a", "/b"])).toEqual([
      "add",
      "my-app",
      "--path",
      "/a",
      "--path",
      "/b",
    ]);
    expect(projectsReposPathsArgs("remove", "my-app", ["/c"])).toEqual([
      "remove",
      "my-app",
      "--path",
      "/c",
    ]);
    expect(projectsReposPathsArgs("add", "my-app", ["  "])).toEqual(["add", "my-app"]);
  });
});

describe("projects document parsers", () => {
  test("list projects the document and tolerates additive fields", () => {
    const result = projectsListFromDoc({
      contract: CONTRACT,
      command: "list",
      projects: [PROJECT, { malformed: true }, { id: "x" }],
      generated_at: "2026-11-25T00:00:00.000Z",
      future_field: { nested: true },
    });
    expect(result).not.toBeNull();
    expect(result?.projects).toHaveLength(1);
    expect(result?.projects[0]?.id).toBe("my-app");
    expect(result?.projects[0]?.repos[0]?.remote).toBe("github.com/org/repo");
    expect(result?.projects[0]?.pinned).toBe(true);
    expect(result?.generated_at).toBe("2026-11-25T00:00:00.000Z");
  });

  test("list rejects foreign contracts, wrong command, malformed docs", () => {
    const doc = { contract: CONTRACT, command: "list", projects: [] };
    expect(projectsListFromDoc({ ...doc, contract: "herdr-plugins.inbox/v1" })).toBeNull();
    expect(projectsListFromDoc({ ...doc, command: "show" })).toBeNull();
    expect(projectsListFromDoc({ contract: CONTRACT, command: "list" })).toBeNull();
    expect(projectsListFromDoc({ contract: CONTRACT, projects: [] })).not.toBeNull();
  });

  test("show requires a project payload", () => {
    const ok = projectShowFromDoc({
      contract: CONTRACT,
      command: "show",
      project: PROJECT,
    });
    expect(ok?.project.id).toBe("my-app");
    expect(projectShowFromDoc({ contract: CONTRACT, command: "show" })).toBeNull();
    expect(
      projectShowFromDoc({ contract: CONTRACT, command: "list", project: PROJECT }),
    ).toBeNull();
  });

  test("discover projects repos and skipped entries", () => {
    const result = projectsDiscoverFromDoc({
      contract: CONTRACT,
      command: "discover",
      repos: [
        {
          cwd: "/pane/cwd",
          root: "/repo/root",
          remote: "github.com/org/repo",
          registered_project_id: "my-app",
        },
        { cwd: "/other", root: "/other/root", remote: null, registered_project_id: null },
      ],
      skipped: [{ cwd: "/not/git", reason: "not_a_repo" }],
      generated_at: "2026-11-25T00:00:00.000Z",
    });
    expect(result?.repos).toHaveLength(2);
    expect(result?.repos[0]?.registered_project_id).toBe("my-app");
    expect(result?.repos[1]?.remote).toBeNull();
    expect(result?.skipped).toEqual([{ cwd: "/not/git", reason: "not_a_repo" }]);
    expect(
      projectsDiscoverFromDoc({ contract: CONTRACT, command: "discover" }),
    ).toBeNull();
  });

  test("repos list projects live inspection fields and skipped entries", () => {
    const result = projectReposFromDoc({
      contract: CONTRACT,
      command: "repos list",
      project_id: "my-app",
      repos: [
        {
          root: "/abs/repo",
          remote: "github.com/org/repo",
          added_at: "2026-11-20T00:00:00.000Z",
          branch: "main",
          dirty: false,
          has_submodules: true,
        },
        // Unreachable checkout keeps stored fields, live fields null.
        { root: "/abs/gone", remote: null, added_at: null, branch: null, dirty: null, has_submodules: null },
      ],
      skipped: [{ root: "/abs/gone", reason: "git_error" }],
      generated_at: "2026-11-25T00:00:00.000Z",
    });
    expect(result?.project_id).toBe("my-app");
    expect(result?.repos).toHaveLength(2);
    expect(result?.repos[0]?.branch).toBe("main");
    expect(result?.repos[0]?.has_submodules).toBe(true);
    expect(result?.repos[1]?.dirty).toBeNull();
    expect(result?.skipped).toEqual([{ root: "/abs/gone", reason: "git_error" }]);
    expect(
      projectReposFromDoc({ contract: CONTRACT, command: "repos add", project_id: "x" }),
    ).toBeNull();
  });

  test("settings get whole-map vs key forms", () => {
    const map = projectSettingsFromDoc(
      {
        contract: CONTRACT,
        command: "settings",
        op: "get",
        project: "my-app",
        settings: { "display.title": "My App", ignored: 42 },
      },
      "get",
    );
    expect(map?.project).toBe("my-app");
    expect(map?.settings).toEqual({ "display.title": "My App" });
    expect(map?.key).toBeNull();

    const key = projectSettingsFromDoc(
      {
        contract: CONTRACT,
        command: "settings",
        op: "get",
        project: "my-app",
        key: "display.title",
        value: "My App",
      },
      "get",
    );
    expect(key?.key).toBe("display.title");
    expect(key?.value).toBe("My App");

    // op mismatch and wrong op argument reject.
    expect(
      projectSettingsFromDoc(
        { contract: CONTRACT, command: "settings", op: "set", project: "my-app" },
        "get",
      ),
    ).toBeNull();
    expect(
      projectSettingsFromDoc(
        { contract: CONTRACT, command: "settings", op: "get", project: "my-app" },
        "set",
      ),
    ).toBeNull();
  });

  test("settings set/unset echo the settings map", () => {
    const set = projectSettingsFromDoc(
      {
        contract: CONTRACT,
        command: "settings",
        op: "set",
        project: "my-app",
        key: "display.title",
        settings: { "display.title": "New" },
      },
      "set",
    );
    expect(set?.settings?.["display.title"]).toBe("New");
    const unset = projectSettingsFromDoc(
      {
        contract: CONTRACT,
        command: "settings",
        op: "unset",
        project: "my-app",
        key: "display.title",
        settings: {},
      },
      "unset",
    );
    expect(unset?.settings).toEqual({});
  });

  test("mutation documents require command match and a project payload", () => {
    const doc = {
      contract: CONTRACT,
      command: "update",
      project: PROJECT,
      generated_at: "2026-11-25T00:00:00.000Z",
    };
    expect(projectMutationFromDoc(doc, "update")?.project.id).toBe("my-app");
    expect(projectMutationFromDoc(doc, "register")).toBeNull();
    expect(
      projectMutationFromDoc({ ...doc, contract: "other/v9" }, "update"),
    ).toBeNull();
    expect(projectMutationFromDoc({ contract: CONTRACT, command: "update" }, "update")).toBeNull();
    // repos subcommands carry the two-word command.
    const reposAdd = {
      contract: CONTRACT,
      command: "repos add",
      project: PROJECT,
    };
    expect(projectMutationFromDoc(reposAdd, "repos add")?.project.id).toBe("my-app");
    expect(projectMutationFromDoc(reposAdd, "repos remove")).toBeNull();
    // Missing contract/command fields are tolerated (additive tolerance).
    const { contract: _c, command: _cmd, ...bare } = doc;
    expect(projectMutationFromDoc(bare, "update")).not.toBeNull();
  });
});

describe("projectsCapabilityFromDoc", () => {
  test("normalizes commands and mutation_commands", () => {
    const cap = projectsCapabilityFromDoc({
      contract: CONTRACT,
      version: "0.3.0",
      read_only: false,
      commands: [
        "capability",
        "list",
        "show",
        "discover",
        "register",
        "update",
        "archive",
        "unarchive",
        "pin",
        "unpin",
        "settings",
        "repos",
      ],
      mutation_commands: [
        "register",
        "settings set",
        "settings unset",
        "repos add",
        "repos remove",
        "archive",
      ],
    });
    expect(cap?.contractOk).toBe(true);
    expect(cap?.commands.has("list")).toBe(true);
    expect(cap?.commands.has("repos")).toBe(true);
    expect(cap?.mutationCommands.has("settings set")).toBe(true);
    expect(cap?.mutationCommands.has("repos add")).toBe(true);
    expect(cap?.readOnly).toBe(false);
  });

  test("rejects foreign or missing contracts", () => {
    expect(projectsCapabilityFromDoc({ contract: "herdr-plugins.git/v1", commands: [] })).toBeNull();
    expect(projectsCapabilityFromDoc({ commands: ["list"] })).toBeNull();
    expect(projectsCapabilityFromDoc({ contract: CONTRACT })?.commands.size).toBe(0);
  });
});

describe("classifyProjectsError", () => {
  const err = (code: string, message = "m") => Object.assign(new Error(message), { code });

  test("boundary codes map to unavailable reasons", () => {
    expect(classifyProjectsError(err("plugin_not_installed"))).toMatchObject({
      kind: "unavailable",
      reason: "not_installed",
    });
    expect(classifyProjectsError(err("plugin_disabled"))).toMatchObject({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(classifyProjectsError(err("plugin_unsupported_command"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyProjectsError(err("plugin_host_unreachable"))).toMatchObject({
      kind: "unavailable",
      reason: "unreachable",
    });
  });

  test("project and git kinds stay distinct projects errors", () => {
    for (const code of [
      "project_not_found",
      "project_exists",
      "repo_already_registered",
      "repo_not_found",
      "invalid_project_id",
      "settings_key_not_allowed",
      "not_a_repo",
      "bare_repo",
      "git_missing",
      "timeout",
      "git_error",
      "usage",
    ]) {
      expect(classifyProjectsError(err(code))).toMatchObject({
        kind: "projects_error",
        code,
      });
    }
  });

  test("script kinds shared with #253 are preserved", () => {
    for (const code of [
      "unknown_script",
      "repo_ambiguous",
      "run_not_found",
      "script_run_error",
    ]) {
      expect(classifyProjectsError(err(code))).toMatchObject({
        kind: "projects_error",
        code,
      });
    }
  });

  test("unknown codes degrade to plugin_error, never a fake success", () => {
    expect(classifyProjectsError(err("something_new"))).toMatchObject({
      kind: "projects_error",
      code: "plugin_error",
    });
    expect(classifyProjectsError("boom")).toMatchObject({
      kind: "projects_error",
      code: "plugin_error",
    });
  });

  test("bounded contract error fields pass through (issue #257)", () => {
    const withFields = Object.assign(new Error("m"), {
      code: "settings_key_not_allowed",
      fields: { key: "display.title" },
    });
    expect(classifyProjectsError(withFields)).toMatchObject({
      kind: "projects_error",
      code: "settings_key_not_allowed",
      fields: { key: "display.title" },
    });
    const badFields = Object.assign(new Error("m"), {
      code: "settings_key_not_allowed",
      fields: ["not", "a", "record"],
    });
    expect(classifyProjectsError(badFields)).not.toHaveProperty("fields");
  });
});
