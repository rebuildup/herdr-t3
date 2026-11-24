import { describe, expect, test } from "bun:test";
import type {
  AgentInfo,
  MachineInfo,
  PaneInfo,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import { buildGotoRows, filterGotoRows, parseGotoQuery } from "./goto";

const MACHINE: MachineInfo = {
  id: "local",
  label: "This Mac",
  kind: "local",
  enabled: true,
  status: "online",
};

function workspace(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    active_tab_id: "t1",
    agent_status: "unknown",
    focused: false,
    label: "ws",
    number: 1,
    pane_count: 1,
    tab_count: 1,
    workspace_id: "w1",
    ...over,
  };
}

function tab(over: Partial<TabInfo>): TabInfo {
  return {
    agent_status: "unknown",
    focused: false,
    label: "1",
    number: 1,
    pane_count: 1,
    tab_id: "t1",
    workspace_id: "w1",
    ...over,
  };
}

function pane(over: Partial<PaneInfo>): PaneInfo {
  return {
    agent_status: "unknown",
    focused: false,
    pane_id: "p1",
    revision: 1,
    tab_id: "t1",
    terminal_id: "term1",
    workspace_id: "w1",
    ...over,
  };
}

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    agent_status: "working",
    focused: false,
    pane_id: "p1",
    revision: 1,
    tab_id: "t1",
    terminal_id: "term1",
    workspace_id: "w1",
    ...over,
  };
}

function snapshot(over: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    agents: [],
    layouts: [],
    panes: [],
    protocol: 1,
    tabs: [],
    version: "test",
    workspaces: [workspace({})],
    ...over,
  };
}

const BRANCHES = new Map([["local\nw1", "feature/goto"]]);

function rowsFor(snap: SessionSnapshot) {
  return buildGotoRows([
    { machine: MACHINE, snapshot: snap, branchIndex: BRANCHES },
  ]);
}

describe("buildGotoRows", () => {
  test("emits workspace, tab and pane rows in snapshot order", () => {
    const rows = rowsFor(
      snapshot({
        // label identical to repo_name is herdr's derived default, so the
        // branch wins the title (info-architecture §2)
        workspaces: [
          workspace({
            worktree: {
              checkout_path: "/repo",
              is_linked_worktree: false,
              repo_key: "k",
              repo_name: "ws",
              repo_root: "/repo",
            },
          }),
        ],
        tabs: [tab({})],
        panes: [pane({})],
        focused_workspace_id: "w1",
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["workspace", "tab", "pane"]);
    const ws = rows[0]!;
    expect(ws.label).toBe("feature/goto");
    expect(ws.meta).toBe("feature/goto");
    expect(ws.current).toBe(true);
  });

  test("pane rows carry agent status, kind and cwd for search", () => {
    const rows = rowsFor(
      snapshot({
        agents: [
          agent({
            agent: "claude",
            agent_status: "blocked",
            name: "fix-tests",
          }),
        ],
        tabs: [tab({})],
        panes: [
          pane({
            cwd: "/repo/src",
            foreground_cwd: "/repo/src/lib",
            label: "editor",
          }),
        ],
      }),
    );
    const p = rows.find((r) => r.kind === "pane")!;
    expect(p.status).toBe("blocked");
    expect(p.agentKind).toBe("claude");
    expect(p.label).toBe("editor");
    expect(p.meta).toBe("/repo/src/lib");
    expect(p.searchText).toContain("claude");
    expect(p.searchText).toContain("/repo/src");
    expect(p.searchText).toContain("p1");
  });

  test("multi-pane tabs suffix the pane index", () => {
    const rows = rowsFor(
      snapshot({
        tabs: [tab({ pane_count: 2 })],
        panes: [pane({ pane_id: "p1" }), pane({ pane_id: "p2", tab_id: "t1" })],
      }),
    );
    const panes = rows.filter((r) => r.kind === "pane");
    expect(panes.map((r) => r.label)).toEqual(["terminal · 1", "terminal · 2"]);
  });
});

describe("parseGotoQuery / filterGotoRows", () => {
  test("parses a leading status token and keeps the rest as words", () => {
    expect(parseGotoQuery("blocked fix")).toEqual({
      status: "blocked",
      words: ["fix"],
    });
    expect(parseGotoQuery("b")).toEqual({ status: "blocked", words: [] });
    expect(parseGotoQuery("herdr fix")).toEqual({
      status: null,
      words: ["herdr", "fix"],
    });
  });

  test("text query AND-matches across the search blob", () => {
    const rows = rowsFor(
      snapshot({
        agents: [agent({ agent: "claude", name: "fix-tests" })],
        tabs: [tab({})],
        panes: [pane({ cwd: "/repo/src" })],
      }),
    );
    const hits = filterGotoRows(rows, "claude src");
    expect(hits.some((r) => r.kind === "pane")).toBe(true);
    expect(hits.every((r) => r.searchText.includes("claude") && r.searchText.includes("src") || r.kind !== "pane")).toBe(true);
    expect(filterGotoRows(rows, "claude nonexistent")).toHaveLength(0);
  });

  test("status filter keeps only matching panes plus their ancestors", () => {
    const rows = rowsFor(
      snapshot({
        agents: [
          agent({ pane_id: "p1", agent_status: "blocked" }),
          agent({ pane_id: "p2", agent_status: "working", tab_id: "t1" }),
        ],
        tabs: [tab({})],
        panes: [
          pane({ pane_id: "p1" }),
          pane({ pane_id: "p2", tab_id: "t1" }),
        ],
      }),
    );
    const kinds = filterGotoRows(rows, "blocked").map((r) => `${r.kind}:${r.label ?? r.id}`);
    // workspace + tab ancestors stay as grouping; only the blocked pane survives
    expect(kinds).toEqual([
      `workspace:${rows[0]!.label}`,
      `tab:${rows[1]!.label}`,
      expect.stringContaining("pane"),
    ]);
    const paneRow = filterGotoRows(rows, "blocked").find((r) => r.kind === "pane");
    expect(paneRow?.paneId).toBe("p1");
    // working filter finds the other pane
    expect(
      filterGotoRows(rows, "working").find((r) => r.kind === "pane")?.paneId,
    ).toBe("p2");
  });
});
