import { describe, expect, test } from "bun:test";
import type { WorkspaceInfo, WorktreeListEntry } from "../../shared/protocol";
import { resolveWorkspaceBranch } from "./worktrees";

function ws(id: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    workspace_id: id,
    active_tab_id: "",
    agent_status: "idle",
    focused: false,
    label: id,
    number: 1,
    pane_count: 1,
    tab_count: 1,
    ...overrides,
  };
}

function entry(path: string, branch: string | null, openId?: string): WorktreeListEntry {
  return {
    path,
    branch,
    is_bare: false,
    is_detached: branch === null,
    is_prunable: false,
    is_linked_worktree: true,
    open_workspace_id: openId ?? null,
    label: path,
  };
}

describe("resolveWorkspaceBranch", () => {
  const entries = [
    entry("/repo", "main", "ws-main"),
    entry("/repo/.worktrees/feature", "feature/x", "ws-feat"),
    entry("/repo/.worktrees/other", "other", undefined),
  ];

  test("matches via open_workspace_id first", () => {
    expect(resolveWorkspaceBranch(ws("ws-feat"), entries)).toBe("feature/x");
  });

  test("matches worktree checkout_path exactly", () => {
    const w = ws("ws-9", {
      worktree: {
        checkout_path: "/repo/.worktrees/other",
        is_linked_worktree: true,
        repo_key: "k",
        repo_name: "repo",
        repo_root: "/repo",
      },
    });
    expect(resolveWorkspaceBranch(w, entries)).toBe("other");
  });

  test("falls back to longest-prefix cwd match for plain git workspaces", () => {
    const w = ws("ws-cwd");
    expect(resolveWorkspaceBranch(w, entries, "/repo/.worktrees/feature/src")).toBe(
      "feature/x",
    );
    expect(resolveWorkspaceBranch(w, entries, "/repo")).toBe("main");
  });

  test("returns undefined when nothing matches or branch is absent", () => {
    expect(resolveWorkspaceBranch(ws("ws-none"), entries, "/elsewhere")).toBeUndefined();
    const detached = [entry("/repo", null, "ws-detached")];
    expect(resolveWorkspaceBranch(ws("ws-detached"), detached)).toBeUndefined();
  });
});
