import { describe, expect, test } from "bun:test";
import { classifyGitError, gitStatusFromDoc } from "./git";

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
    for (const code of ["not_a_repo", "bare_repo", "git_missing", "pane_not_found", "timeout"]) {
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
