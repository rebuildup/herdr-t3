import { describe, expect, test } from "bun:test";
import type {
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import { handoffPaneId } from "./focusHandoff";

function ws(id: string, activeTabId: string, focused = false): WorkspaceInfo {
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

function pane(id: string, tabId: string, workspaceId: string, focused = false): PaneInfo {
  return {
    pane_id: id,
    tab_id: tabId,
    workspace_id: workspaceId,
    terminal_id: `term-${id}`,
    agent_status: "idle",
    focused,
    revision: 1,
  };
}

function layout(tabId: string, workspaceId: string, focusedPaneId: string): PaneLayoutSnapshot {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    area: { x: 0, y: 0, width: 100, height: 50 },
    focused_pane_id: focusedPaneId,
    panes: [
      { pane_id: focusedPaneId, focused: true, rect: { x: 0, y: 0, width: 100, height: 50 } },
    ],
    splits: [],
    zoomed: false,
  };
}

function snapshot(partial: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    agents: [],
    layouts: [],
    panes: [],
    protocol: 1,
    tabs: [],
    version: "test",
    workspaces: [],
    ...partial,
  };
}

// Two workspaces, each with two tabs; w1/t2 has two panes so the layout's
// focused_pane_id (not just pane.focused) decides the handoff target.
const SNAP = snapshot({
  focused_workspace_id: "w1",
  workspaces: [ws("w1", "t1b"), ws("w2", "t2a")],
  tabs: [tab("t1a", "w1"), tab("t1b", "w1"), tab("t2a", "w2"), tab("t2b", "w2")],
  panes: [
    pane("p1a", "t1a", "w1"),
    pane("p1b1", "t1b", "w1"),
    pane("p1b2", "t1b", "w1", true),
    pane("p2a", "t2a", "w2"),
    pane("p2b", "t2b", "w2"),
  ],
  layouts: [
    layout("t1a", "w1", "p1a"),
    layout("t1b", "w1", "p1b2"),
    layout("t2a", "w2", "p2a"),
    layout("t2b", "w2", "p2b"),
  ],
});

describe("handoffPaneId (issue #435)", () => {
  test("null ids resolve the herdr-focused workspace's focused pane", () => {
    // default route: focused workspace w1, its active tab t1b, layout-focused p1b2
    expect(handoffPaneId(SNAP, null, null)).toBe("p1b2");
  });

  test("explicit workspace + active tab resolve that tab's layout-focused pane", () => {
    // w2's active tab is t2a; t2b is still pending and yields null (covered
    // below). Requests for the already-active tab resolve immediately.
    expect(handoffPaneId(SNAP, "w2", "t2a")).toBe("p2a");
    expect(handoffPaneId(SNAP, "w2", null)).toBe("p2a");
  });

  test("a stale snapshot that has not activated the requested tab yields null", () => {
    // w1's active_tab_id is still t1b — asking for t1a must wait, not fall
    // back to whatever tab happens to be active.
    expect(handoffPaneId(SNAP, "w1", "t1a")).toBeNull();
  });

  test("an unknown workspace yields null instead of a fallback pane", () => {
    expect(handoffPaneId(SNAP, "w-gone", null)).toBeNull();
  });

  test("empty snapshot yields null", () => {
    expect(handoffPaneId(snapshot({}), null, null)).toBeNull();
    expect(handoffPaneId(null, null, null)).toBeNull();
  });

  test("tab whose panes are gone yields null rather than another tab's pane", () => {
    const noPanes = snapshot({
      focused_workspace_id: "w1",
      workspaces: [ws("w1", "t1b")],
      tabs: [tab("t1b", "w1")],
      panes: [],
      layouts: [layout("t1b", "w1", "p1b2")],
    });
    expect(handoffPaneId(noPanes, "w1", "t1b")).toBeNull();
  });
});
