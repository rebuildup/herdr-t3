import { describe, expect, test } from "bun:test";
import type {
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import { deriveWorkspace, paneTitle, workspaceTitle } from "./workspace";

function ws(id: string, focused = false, activeTabId = ""): WorkspaceInfo {
  return {
    workspace_id: id,
    active_tab_id: activeTabId,
    agent_status: "idle",
    focused,
    label: id,
    number: 1,
    pane_count: 1,
    tab_count: 1,
  };
}

function tab(id: string, workspaceId: string): TabInfo {
  return {
    tab_id: id,
    workspace_id: workspaceId,
    label: id,
    number: 1,
    agent_status: "idle",
    focused: false,
    pane_count: 1,
  };
}

function pane(id: string, tabId: string, workspaceId: string): PaneInfo {
  return {
    pane_id: id,
    tab_id: tabId,
    workspace_id: workspaceId,
    terminal_id: `term-${id}`,
    agent_status: "idle",
    focused: false,
    revision: 1,
  };
}

function layout(tabId: string, workspaceId: string, focusedPaneId: string, zoomed = false): PaneLayoutSnapshot {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    area: { x: 0, y: 0, width: 100, height: 50 },
    focused_pane_id: focusedPaneId,
    panes: [
      { pane_id: focusedPaneId, focused: true, rect: { x: 0, y: 0, width: 100, height: 50 } },
    ],
    splits: [],
    zoomed,
  };
}

function snapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    agents: [],
    layouts: [],
    panes: [],
    protocol: 22,
    tabs: [],
    version: "test",
    workspaces: [],
    ...overrides,
  };
}

describe("deriveWorkspace", () => {
  test("returns the workspace named by id even when it is not herdr-focused", () => {
    const snap = snapshot({
      workspaces: [ws("ws-a", true, "tab-a"), ws("ws-b", false, "tab-b")],
      focused_workspace_id: "ws-a",
      tabs: [tab("tab-a", "ws-a"), tab("tab-b", "ws-b")],
      panes: [pane("p-a", "tab-a", "ws-a"), pane("p-b", "tab-b", "ws-b")],
      layouts: [layout("tab-b", "ws-b", "p-b")],
    });
    const view = deriveWorkspace(snap, "ws-b");
    expect(view.workspace?.workspace_id).toBe("ws-b");
    expect(view.activeTab?.tab_id).toBe("tab-b");
    expect(view.tabPanes.map((p) => p.pane_id)).toEqual(["p-b"]);
    expect(view.layout?.focused_pane_id).toBe("p-b");
    expect(view.focusedPane?.pane_id).toBe("p-b");
  });

  test("tabPanes covers only the active tab — hidden tabs never mount a terminal (issue #569)", () => {
    const snap = snapshot({
      workspaces: [ws("ws-a", true, "tab-a1")],
      focused_workspace_id: "ws-a",
      tabs: [tab("tab-a1", "ws-a"), tab("tab-a2", "ws-a")],
      panes: [
        pane("p-a1", "tab-a1", "ws-a"),
        pane("p-a2", "tab-a1", "ws-a"),
        pane("p-hidden", "tab-a2", "ws-a"),
      ],
    });
    const view = deriveWorkspace(snap, "ws-a");
    expect(view.activeTab?.tab_id).toBe("tab-a1");
    // Only active-tab panes reach PaneTerminal -> subscribe_terminal; the
    // hidden tab's pane must not appear in the mount set.
    expect(view.tabPanes.map((p) => p.pane_id).sort()).toEqual(["p-a1", "p-a2"]);
    expect(view.tabPanes.some((p) => p.pane_id === "p-hidden")).toBe(false);
  });

  test("falls back to the herdr-focused workspace when the id is absent", () => {
    const snap = snapshot({
      workspaces: [ws("ws-a"), ws("ws-b", true, "tab-b")],
      focused_workspace_id: "ws-b",
      tabs: [tab("tab-b", "ws-b")],
      panes: [pane("p-b", "tab-b", "ws-b")],
    });
    const view = deriveWorkspace(snap, "ws-gone");
    expect(view.workspace?.workspace_id).toBe("ws-b");
  });

  test("defaults to the focused workspace when no id is given", () => {
    const snap = snapshot({
      workspaces: [ws("ws-a"), ws("ws-b", true)],
      focused_workspace_id: "ws-b",
    });
    expect(deriveWorkspace(snap, null).workspace?.workspace_id).toBe("ws-b");
  });

  test("empty snapshot yields an empty view", () => {
    const view = deriveWorkspace(snapshot({}), null);
    expect(view.workspace).toBeUndefined();
    expect(view.tabs).toEqual([]);
    expect(view.tabPanes).toEqual([]);
    expect(view.layout).toBeUndefined();
    expect(view.focusedPane).toBeUndefined();
  });

  test("null snapshot yields an empty view", () => {
    expect(deriveWorkspace(null, "ws-x").workspace).toBeUndefined();
  });
});

describe("titles", () => {
  test("workspaceTitle prefers label, then worktree repo, then id", () => {
    expect(workspaceTitle(ws("ws-1"))).toBe("ws-1");
    const wt = {
      ...ws("ws-2"),
      label: "",
      worktree: {
        checkout_path: "/x",
        is_linked_worktree: false,
        repo_key: "k",
        repo_name: "repo",
        repo_root: "/x",
      },
    };
    expect(workspaceTitle(wt)).toBe("repo");
  });

  test("workspaceTitle prefers branch over derived label and repo name", () => {
    const wt = {
      ...ws("ws-3"),
      label: "repo",
      worktree: {
        checkout_path: "/x",
        is_linked_worktree: true,
        repo_key: "k",
        repo_name: "repo",
        repo_root: "/x",
      },
    };
    expect(workspaceTitle(wt, "feature/x")).toBe("feature/x");
    expect(workspaceTitle(wt)).toBe("repo");
  });

  test("workspaceTitle keeps a custom label ahead of the branch", () => {
    const custom = { ...ws("ws-4"), label: "my workspace" };
    expect(workspaceTitle(custom, "feature/x")).toBe("my workspace");
  });

  test("paneTitle prefers stripped terminal title", () => {
    const p = { ...pane("p1", "t1", "w1"), terminal_title_stripped: "dev" };
    expect(paneTitle(p)).toBe("dev");
    expect(paneTitle(pane("p2", "t1", "w1"))).toBe("p2");
  });
});
