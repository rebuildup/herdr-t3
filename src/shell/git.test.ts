import { describe, expect, test } from "bun:test";
import {
  classifyForgeError,
  classifyGitError,
  gitBranchArgs,
  gitCapabilityFromDoc,
  gitCommitArgs,
  gitCompareFromDoc,
  gitDiffFromDoc,
  gitFetchArgs,
  gitFilesFromDoc,
  gitLogFromDoc,
  gitMutationFromDoc,
  gitPrCreateArgs,
  gitPrCreateFromDoc,
  gitPrListArgs,
  gitPrListFromDoc,
  gitPrStatusFromDoc,
  gitPrViewFromResultDoc,
  gitPushArgs,
  gitStageArgs,
  gitStatusFromDoc,
  gitUnstageArgs,
  gitUpstreamArgs,
} from "./git";

const STATUS_DOC = {
  contract: "herdr-plugins.git/v1",
  command: "status",
  pane_id: "w1:p1",
  generated_at: "2026-11-25T00:00:00.000Z",
  repo: {
    root: "/repo/worktree",
    git_dir: "/repo/.git/worktrees/wt1",
    git_common_dir: "/repo/.git",
    bare: false,
  },
  branch: {
    name: "feature/x",
    detached: false,
    upstream: "origin/feature/x",
    ahead: 2,
    behind: 1,
  },
  changes: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
  warnings: ["w1"],
};

describe("gitStatusFromDoc (herdr-plugins.git/v1)", () => {
  test("projects the status document", () => {
    const status = gitStatusFromDoc(STATUS_DOC);
    expect(status).not.toBeNull();
    expect(status?.pane_id).toBe("w1:p1");
    expect(status?.branch.name).toBe("feature/x");
    expect(status?.branch.ahead).toBe(2);
    expect(status?.changes).toEqual({ staged: 1, unstaged: 2, untracked: 3, conflicted: 0 });
    expect(status?.repo.git_dir).not.toBe(status?.repo.git_common_dir);
    expect(status?.warnings).toEqual(["w1"]);
  });

  test("tolerates additive fields and missing optionals", () => {
    const status = gitStatusFromDoc({
      pane_id: "w1:p2",
      repo: { root: "/r", bare: false },
      branch: { name: "HEAD", detached: true },
      changes: {},
      future_field: { nested: true },
    });
    expect(status?.branch.detached).toBe(true);
    expect(status?.branch.upstream).toBeNull();
    expect(status?.changes.staged).toBe(0);
    expect(status?.warnings).toEqual([]);
  });

  test("rejects foreign contracts and malformed docs", () => {
    expect(gitStatusFromDoc({ ...STATUS_DOC, contract: "herdr-plugins.inbox/v1" })).toBeNull();
    expect(gitStatusFromDoc({ contract: "herdr-plugins.git/v1" })).toBeNull();
    expect(gitStatusFromDoc({ pane_id: "w1:p1", repo: {}, branch: {}, changes: {} })).toBeNull();
  });
});

describe("classifyGitError", () => {
  const err = (code: string, message = "m") => Object.assign(new Error(message), { code });

  test("boundary codes map to unavailable reasons", () => {
    expect(classifyGitError(err("plugin_not_installed"))).toMatchObject({
      kind: "unavailable",
      reason: "not_installed",
    });
    expect(classifyGitError(err("plugin_disabled"))).toMatchObject({
      kind: "unavailable",
      reason: "disabled",
    });
    expect(classifyGitError(err("plugin_unsupported_command"))).toMatchObject({
      kind: "unavailable",
      reason: "incompatible",
    });
    expect(classifyGitError(err("plugin_host_unreachable"))).toMatchObject({
      kind: "unavailable",
      reason: "unreachable",
    });
  });

  test("plugin repo kinds stay distinct repo errors", () => {
    for (const code of [
      "not_a_repo",
      "bare_repo",
      "git_missing",
      "pane_not_found",
      "timeout",
      "usage",
    ]) {
      expect(classifyGitError(err(code))).toMatchObject({ kind: "repo_error", code });
    }
  });

  test("unknown codes degrade to git_error, never a fake success", () => {
    expect(classifyGitError(err("something_new"))).toMatchObject({
      kind: "repo_error",
      code: "git_error",
    });
    expect(classifyGitError("boom")).toMatchObject({ kind: "repo_error", code: "git_error" });
  });
});

describe("gitDiffFromDoc (herdr-plugins.git/v1 @62309b9c)", () => {
  test("reads the 0.2.x output fields", () => {
    const diff = gitDiffFromDoc({
      contract: "herdr-plugins.git/v1",
      command: "diff",
      pane_id: "w1:p1",
      format: "patch",
      output: "diff --git a/x b/x\n",
      stat_output: null,
      name_status_output: null,
      numstat_output: null,
      paths: ["x"],
      truncated: true,
      bytes: 42,
      staged: false,
      revisions: [],
    });
    expect(diff).not.toBeNull();
    expect(diff?.format).toBe("patch");
    expect(diff?.field).toBe("output");
    expect(diff?.text).toContain("diff --git");
    expect(diff?.truncated).toBe(true);
    expect(diff?.bytes).toBe(42);
  });

  test("selects the format-matched output field", () => {
    const stat = gitDiffFromDoc(
      {
        contract: "herdr-plugins.git/v1",
        pane_id: "w1:p1",
        format: "stat",
        output: null,
        stat_output: " x | 2 +-\n",
        name_status_output: null,
        numstat_output: null,
      },
      "stat",
    );
    expect(stat?.field).toBe("stat_output");
    expect(stat?.text).toContain("x |");
    const numstat = gitDiffFromDoc(
      {
        contract: "herdr-plugins.git/v1",
        pane_id: "w1:p1",
        format: "numstat",
        output: null,
        stat_output: null,
        name_status_output: null,
        numstat_output: "1\t2\tx\n",
      },
      "numstat",
    );
    expect(numstat?.field).toBe("numstat_output");
  });

  test("falls back to the drifted Stage-1 diff/stat field names", () => {
    const patch = gitDiffFromDoc({
      contract: "herdr-plugins.git/v1",
      pane_id: "w1:p1",
      diff: "old patch text",
      stat: "old stat text",
    });
    expect(patch?.field).toBe("diff");
    expect(patch?.text).toBe("old patch text");
    const stat = gitDiffFromDoc(
      { contract: "herdr-plugins.git/v1", pane_id: "w1:p1", diff: "p", stat: "s" },
      "stat",
    );
    expect(stat?.field).toBe("stat");
    expect(stat?.text).toBe("s");
  });

  test("treats an all-null output doc as an empty diff, not a failure", () => {
    const diff = gitDiffFromDoc({
      contract: "herdr-plugins.git/v1",
      pane_id: "w1:p1",
      format: "patch",
      output: null,
      stat_output: null,
      name_status_output: null,
      numstat_output: null,
    });
    expect(diff?.text).toBe("");
    expect(diff?.truncated).toBe(false);
  });

  test("rejects foreign contracts", () => {
    expect(
      gitDiffFromDoc({ contract: "herdr-plugins.inbox/v1", pane_id: "w1:p1", output: "x" }),
    ).toBeNull();
  });
});

describe("gitFilesFromDoc", () => {
  const FILES_DOC = {
    contract: "herdr-plugins.git/v1",
    command: "files",
    pane_id: "w1:p1",
    repo_root: "/repo",
    pathspec: ["src"],
    files: [
      {
        path: "src/a.ts",
        index: "M",
        worktree: " ",
        kind: "modified",
        staged: true,
        unstaged: false,
        binary: false,
      },
      {
        path: "src/b.ts",
        old_path: "src/old.ts",
        index: "R",
        worktree: " ",
        kind: "renamed",
        staged: true,
        unstaged: false,
        binary: false,
      },
      {
        path: "new.txt",
        index: "?",
        worktree: "?",
        kind: "untracked",
        staged: false,
        unstaged: true,
        binary: null,
      },
      { malformed: true },
    ],
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("projects the files document", () => {
    const result = gitFilesFromDoc(FILES_DOC);
    expect(result).not.toBeNull();
    expect(result?.files).toHaveLength(3);
    expect(result?.files[0]).toMatchObject({
      path: "src/a.ts",
      kind: "modified",
      staged: true,
      binary: false,
    });
    expect(result?.files[1]?.old_path).toBe("src/old.ts");
    expect(result?.files[2]?.binary).toBeNull();
    expect(result?.pathspec).toEqual(["src"]);
    expect(result?.repo_root).toBe("/repo");
  });

  test("rejects malformed and foreign docs", () => {
    expect(gitFilesFromDoc({ contract: "herdr-plugins.git/v1" })).toBeNull();
    expect(gitFilesFromDoc({ contract: "herdr-plugins.git/v1", pane_id: "w1:p1" })).toBeNull();
    expect(
      gitFilesFromDoc({ contract: "other/v9", pane_id: "w1:p1", files: [] }),
    ).toBeNull();
    expect(gitFilesFromDoc({ pane_id: "w1:p1", files: "nope" })).toBeNull();
  });
});

describe("gitLogFromDoc", () => {
  test("projects commits and pagination", () => {
    const result = gitLogFromDoc({
      contract: "herdr-plugins.git/v1",
      command: "log",
      pane_id: "w1:p1",
      commits: [
        {
          sha: "abcdef1234567890",
          parents: ["1111111"],
          author: { name: "A U Thor", email: "a@example.com", date: "2026-11-24T10:00:00Z" },
          committer: { name: "A U Thor", email: "a@example.com", date: "2026-11-24T10:00:00Z" },
          subject: "add feature",
        },
      ],
      has_more: true,
      limit: 1,
      skip: 0,
      repo_root: "/repo",
      generated_at: "2026-11-25T00:00:00.000Z",
    });
    expect(result?.commits).toHaveLength(1);
    expect(result?.commits[0]?.sha).toBe("abcdef1234567890");
    expect(result?.commits[0]?.author.name).toBe("A U Thor");
    expect(result?.commits[0]?.parents).toEqual(["1111111"]);
    expect(result?.has_more).toBe(true);
    expect(result?.limit).toBe(1);
  });

  test("rejects malformed and foreign docs", () => {
    expect(gitLogFromDoc({ contract: "herdr-plugins.git/v1", pane_id: "w1:p1" })).toBeNull();
    expect(
      gitLogFromDoc({ contract: "x/v1", pane_id: "w1:p1", commits: [] }),
    ).toBeNull();
    expect(gitLogFromDoc({ pane_id: "w1:p1", commits: [{ no_sha: true }] })).not.toBeNull();
    expect(gitLogFromDoc({ pane_id: "w1:p1", commits: [{ no_sha: true }] })?.commits).toHaveLength(0);
  });
});

describe("gitCompareFromDoc", () => {
  test("projects the compare document", () => {
    const result = gitCompareFromDoc({
      contract: "herdr-plugins.git/v1",
      command: "compare",
      pane_id: "w1:p1",
      base: "origin/main",
      head: "HEAD",
      merge_base: "deadbeefcafe",
      ahead: 3,
      behind: 1,
      files: [
        { status: "M", path: "src/a.ts", old_path: null },
        { status: "R100", path: "src/new.ts", old_path: "src/old.ts" },
      ],
      stat: " src/a.ts | 2 +-\n",
      patch: "diff --git a/src/a.ts b/src/a.ts\n",
      patch_truncated: false,
      patch_bytes: 128,
      repo_root: "/repo",
      generated_at: "2026-11-25T00:00:00.000Z",
    });
    expect(result?.ahead).toBe(3);
    expect(result?.behind).toBe(1);
    expect(result?.merge_base).toBe("deadbeefcafe");
    expect(result?.files).toHaveLength(2);
    expect(result?.files[1]?.old_path).toBe("src/old.ts");
    expect(result?.patch_truncated).toBe(false);
  });

  test("rejects malformed and foreign docs", () => {
    expect(gitCompareFromDoc({ contract: "herdr-plugins.git/v1", pane_id: "w1:p1" })).toBeNull();
    expect(
      gitCompareFromDoc({ contract: "other/v1", pane_id: "w1:p1", files: [] }),
    ).toBeNull();
    expect(gitCompareFromDoc({ pane_id: "w1:p1", files: [] })).not.toBeNull();
  });
});

describe("gitCapabilityFromDoc", () => {
  test("normalizes commands and mutation_commands", () => {
    const cap = gitCapabilityFromDoc({
      contract: "herdr-plugins.git/v1",
      version: "0.2.0",
      read_only: false,
      commands: ["capability", "status", "files", "diff", "log", "compare"],
      mutation_commands: ["stage", "commit"],
    });
    expect(cap?.contractOk).toBe(true);
    expect(cap?.commands.has("files")).toBe(true);
    expect(cap?.commands.has("log")).toBe(true);
    expect(cap?.commands.has("compare")).toBe(true);
    expect(cap?.mutationCommands.has("commit")).toBe(true);
    expect(cap?.readOnly).toBe(false);
  });

  test("an older Stage-1 plugin lacks the new commands (gated, not broken)", () => {
    const cap = gitCapabilityFromDoc({
      contract: "herdr-plugins.git/v1",
      read_only: true,
      commands: ["capability", "status", "diff", "project"],
      mutation_commands: [],
    });
    expect(cap?.commands.has("status")).toBe(true);
    expect(cap?.commands.has("files")).toBe(false);
    expect(cap?.commands.has("log")).toBe(false);
    expect(cap?.commands.has("compare")).toBe(false);
  });

  test("rejects foreign or missing contracts", () => {
    expect(gitCapabilityFromDoc({ contract: "herdr-plugins.inbox/v1", commands: [] })).toBeNull();
    expect(gitCapabilityFromDoc({ commands: ["status"] })).toBeNull();
    expect(gitCapabilityFromDoc({ contract: "herdr-plugins.git/v1" })?.commands.size).toBe(0);
  });
});

describe("gitMutationFromDoc (issue #228)", () => {
  const STAGE_DOC = {
    contract: "herdr-plugins.git/v1",
    command: "stage",
    pane_id: "w1:p1",
    repo_root: "/repo",
    ok: true,
    all: false,
    paths: ["src/a.ts"],
    output: "",
    generated_at: "2026-11-25T00:00:00.000Z",
  };

  test("accepts a well-formed mutation document", () => {
    const base = gitMutationFromDoc(STAGE_DOC, "stage");
    expect(base).not.toBeNull();
    expect(base?.pane_id).toBe("w1:p1");
    expect(base?.repo_root).toBe("/repo");
    expect(base?.command).toBe("stage");
  });

  test("rejects foreign contracts, ok!=true, command mismatch, missing pane", () => {
    expect(gitMutationFromDoc({ ...STAGE_DOC, contract: "herdr-plugins.inbox/v1" }, "stage")).toBeNull();
    expect(gitMutationFromDoc({ ...STAGE_DOC, ok: false }, "stage")).toBeNull();
    expect(gitMutationFromDoc({ ...STAGE_DOC, ok: undefined }, "stage")).toBeNull();
    expect(gitMutationFromDoc({ ...STAGE_DOC, command: "unstage" }, "stage")).toBeNull();
    expect(gitMutationFromDoc({ ...STAGE_DOC, pane_id: undefined }, "stage")).toBeNull();
    // A missing contract field is tolerated (additive tolerance).
    const { contract: _c, ...noContract } = STAGE_DOC;
    expect(gitMutationFromDoc(noContract, "stage")).not.toBeNull();
  });
});

describe("mutation argv builders (herdr-plugins.git/v1 @62309b9c)", () => {
  test("stage/unstage: pane first, --all or repeated --path", () => {
    expect(gitStageArgs("w1:p1", { all: true })).toEqual(["w1:p1", "--all"]);
    expect(gitStageArgs("w1:p1", { paths: ["a.ts", "b.ts"] })).toEqual([
      "w1:p1",
      "--path",
      "a.ts",
      "--path",
      "b.ts",
    ]);
    expect(gitStageArgs("w1:p1", {})).toEqual(["w1:p1"]);
    expect(gitUnstageArgs("w1:p1", { paths: ["a.ts"] })).toEqual([
      "w1:p1",
      "--path",
      "a.ts",
    ]);
  });

  test("commit: pane first, repeated -m pairs, explicit --allow-empty", () => {
    expect(gitCommitArgs("w1:p1", { messages: ["one", "two"], allowEmpty: true })).toEqual([
      "w1:p1",
      "-m",
      "one",
      "-m",
      "two",
      "--allow-empty",
    ]);
    expect(gitCommitArgs("w1:p1", { messages: ["  ", "real"] })).toEqual([
      "w1:p1",
      "-m",
      "real",
    ]);
  });

  test("branch: subcommand shape with pane before name", () => {
    expect(gitBranchArgs("create", "w1:p1", "feature")).toEqual([
      "branch",
      "create",
      "w1:p1",
      "feature",
    ]);
    expect(gitBranchArgs("create", "w1:p1", "feature", { switchTo: true })).toEqual([
      "branch",
      "create",
      "w1:p1",
      "feature",
      "--switch",
    ]);
    expect(gitBranchArgs("switch", "w1:p1", "main")).toEqual([
      "branch",
      "switch",
      "w1:p1",
      "main",
    ]);
  });

  test("upstream/fetch/push argv shapes", () => {
    expect(gitUpstreamArgs("w1:p1", "origin/main")).toEqual(["upstream", "w1:p1", "origin/main"]);
    expect(gitFetchArgs("w1:p1")).toEqual(["fetch", "w1:p1"]);
    expect(gitFetchArgs("w1:p1", { remote: "origin", prune: true })).toEqual([
      "fetch",
      "w1:p1",
      "origin",
      "--prune",
    ]);
    expect(
      gitPushArgs("w1:p1", {
        remote: "origin",
        refspec: "HEAD:main",
        setUpstream: true,
        forceWithLease: true,
      }),
    ).toEqual([
      "push",
      "w1:p1",
      "origin",
      "HEAD:main",
      "--set-upstream",
      "--force-with-lease",
    ]);
    // No plain --force exists in the contract.
    expect(gitPushArgs("w1:p1", { remote: "origin" })).toEqual(["push", "w1:p1", "origin"]);
  });
});

/* ------------------------------ forge (pr) ---------------------------- */

const PR_BASE = {
  contract: "herdr-plugins.git/v1",
  command: "pr",
  pane_id: "w1:p1",
  repo_root: "/repo/worktree",
  repo: "owner/repo",
  generated_at: "2026-11-25T00:00:00.000Z",
};

const PR_SUMMARY = {
  number: 42,
  title: "Add forge surface",
  state: "OPEN",
  isDraft: false,
  author: { login: "octocat" },
  headRefName: "feature/x",
  baseRefName: "main",
  updatedAt: "2026-11-24T12:00:00.000Z",
  url: "https://github.com/owner/repo/pull/42",
};

const PR_VIEW = {
  ...PR_SUMMARY,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  body: "body text",
  body_truncated: false,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  createdAt: "2026-11-20T00:00:00.000Z",
  statusCheckRollup: [
    { name: "ci", status: "COMPLETED", conclusion: "SUCCESS", workflow: "ci.yml" },
  ],
  checks_truncated: false,
  reviews: [{ author: "hubot", state: "APPROVED", submittedAt: "2026-11-21T00:00:00.000Z" }],
};

describe("pr argv builders (herdr-plugins.git/v1 @62309b9c)", () => {
  test("list argv: action first, pane second, flags separate", () => {
    expect(gitPrListArgs("w1:p1")).toEqual(["list", "w1:p1"]);
    expect(
      gitPrListArgs("w1:p1", {
        state: "all",
        limit: 50,
        head: "feature/x",
        repo: "owner/repo",
      }),
    ).toEqual([
      "list",
      "w1:p1",
      "--state",
      "all",
      "--limit",
      "50",
      "--head",
      "feature/x",
      "--repo",
      "owner/repo",
    ]);
  });

  test("create argv: --title required, body xor body-file, optional flags", () => {
    expect(gitPrCreateArgs("w1:p1", { title: "T" })).toEqual([
      "create",
      "w1:p1",
      "--title",
      "T",
    ]);
    expect(
      gitPrCreateArgs("w1:p1", {
        title: "T",
        body: "long body",
        draft: true,
        base: "main",
        head: "feature/x",
        repo: "owner/repo",
      }),
    ).toEqual([
      "create",
      "w1:p1",
      "--title",
      "T",
      "--body",
      "long body",
      "--draft",
      "--base",
      "main",
      "--head",
      "feature/x",
      "--repo",
      "owner/repo",
    ]);
    // bodyFile wins over body (mutually exclusive contract-side).
    expect(
      gitPrCreateArgs("w1:p1", { title: "T", body: "b", bodyFile: "-" }),
    ).toEqual(["create", "w1:p1", "--title", "T", "--body-file", "-"]);
  });
});

describe("pr document parsers", () => {
  test("list projects prs and rejects foreign/mismatched docs", () => {
    const doc = { ...PR_BASE, action: "list", prs: [PR_SUMMARY] };
    const result = gitPrListFromDoc(doc);
    expect(result).not.toBeNull();
    expect(result!.prs).toHaveLength(1);
    expect(result!.prs[0]!.number).toBe(42);
    expect(result!.repo).toBe("owner/repo");
    expect(gitPrListFromDoc({ ...doc, contract: "other/v9" })).toBeNull();
    expect(gitPrListFromDoc({ ...doc, action: "view" })).toBeNull();
    expect(gitPrListFromDoc({ ...doc, prs: "nope" })).toBeNull();
  });

  test("status: pr:null is a normal state; pr object parses bounded view", () => {
    const none = gitPrStatusFromDoc({
      ...PR_BASE,
      action: "status",
      branch: "feature/x",
      detached: false,
      pr: null,
    });
    expect(none).not.toBeNull();
    expect(none!.pr).toBeNull();
    expect(none!.branch).toBe("feature/x");

    const withPr = gitPrStatusFromDoc({
      ...PR_BASE,
      action: "status",
      branch: "HEAD",
      detached: true,
      pr: PR_VIEW,
    });
    expect(withPr!.detached).toBe(true);
    expect(withPr!.pr!.number).toBe(42);
    expect(withPr!.pr!.checks).toHaveLength(1);
    expect(withPr!.pr!.reviews[0]!.author).toBe("hubot");
  });

  test("view requires the nested pr object", () => {
    const ok = gitPrViewFromResultDoc({ ...PR_BASE, action: "view", pr: PR_VIEW });
    expect(ok!.pr.title).toBe("Add forge surface");
    expect(ok!.pr.bodyTruncated).toBe(false);
    expect(gitPrViewFromResultDoc({ ...PR_BASE, action: "view", pr: null })).toBeNull();
  });

  test("create requires ok:true and a url", () => {
    const doc = {
      ...PR_BASE,
      action: "create",
      ok: true,
      url: "https://github.com/owner/repo/pull/43",
      number: 43,
    };
    const result = gitPrCreateFromDoc(doc);
    expect(result!.url).toContain("/pull/43");
    expect(result!.number).toBe(43);
    expect(gitPrCreateFromDoc({ ...doc, ok: false })).toBeNull();
    expect(gitPrCreateFromDoc({ ...doc, url: null })).toBeNull();
  });
});

describe("classifyForgeError", () => {
  test("gh kinds keep their code; other errors delegate", () => {
    const missing = Object.assign(new Error("gh not found"), { code: "gh_missing" });
    const classified = classifyForgeError(missing);
    expect(classified.kind).toBe("repo_error");
    expect((classified as { code?: string }).code).toBe("gh_missing");

    const notInstalled = Object.assign(new Error("no plugin"), {
      code: "plugin_not_installed",
    });
    expect(classifyForgeError(notInstalled).kind).toBe("unavailable");
    expect(classifyGitError(notInstalled).kind).toBe("unavailable");
  });
});
