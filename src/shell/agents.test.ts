import { describe, expect, test } from "bun:test";
import type {
  AgentInfo,
  MachineInfo,
  SessionSnapshot,
  WorkspaceInfo,
} from "../../shared/protocol";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentRowSignature,
  agentSection,
  agentStateLabel,
  agentWorkTarget,
  collectAgentEntries,
  compareAgents,
  partitionAgents,
  shortPaneId,
  type AgentListEntry,
} from "./agents";

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    agent_status: "working",
    focused: false,
    pane_id: "p1",
    revision: 1,
    state_change_seq: 1,
    tab_id: "t1",
    terminal_id: "term1",
    workspace_id: "w1",
    ...over,
  };
}

function entry(agentInfo: AgentInfo): AgentListEntry {
  return {
    machine: { id: "local", kind: "local", label: "Local", enabled: true, status: "online" },
    agent: agentInfo,
    workspace: undefined,
    workspaceTitle: "ws",
    tabLabel: null,
  };
}

describe("agentSection", () => {
  test("maps herdr statuses onto T3-style shelves", () => {
    expect(agentSection("blocked")).toBe("attention");
    expect(agentSection("working")).toBe("working");
    expect(agentSection("done")).toBe("done");
    expect(agentSection("idle")).toBe("idle");
    expect(agentSection("unknown")).toBe("idle");
    expect(agentSection("custom-status")).toBe("idle");
  });
});

describe("compareAgents", () => {
  test("orders by herdr status priority then state_change_seq desc", () => {
    const blocked = agent({ pane_id: "b", agent_status: "blocked", state_change_seq: 1 });
    const doneNew = agent({ pane_id: "d1", agent_status: "done", state_change_seq: 9 });
    const doneOld = agent({ pane_id: "d2", agent_status: "done", state_change_seq: 3 });
    const working = agent({ pane_id: "w", agent_status: "working", state_change_seq: 99 });
    const sorted = [working, doneOld, blocked, doneNew].sort(compareAgents);
    expect(sorted.map((a) => a.pane_id)).toEqual(["b", "d1", "d2", "w"]);
  });

  test("falls back to revision when state_change_seq is absent", () => {
    const a = agent({ pane_id: "a", agent_status: "idle", revision: 5 });
    const b = agent({ pane_id: "b", agent_status: "idle", revision: 7 });
    delete a.state_change_seq;
    delete b.state_change_seq;
    expect(compareAgents(a, b)).toBeGreaterThan(0);
  });
});

describe("agentStateLabel", () => {
  test("prefers the state_labels entry for the current status", () => {
    const a = agent({
      agent_status: "blocked",
      state_labels: { blocked: "needs approval", working: "compiling" },
    });
    expect(agentStateLabel(a)).toBe("needs approval");
  });

  test("falls back to herdr sidebar_status_text", () => {
    expect(agentStateLabel(agent({ agent_status: "blocked" }))).toBe("blocked");
    expect(agentStateLabel(agent({ agent_status: "done" }))).toBe("done");
    expect(agentStateLabel(agent({ agent_status: "working" }))).toBe("working");
    expect(agentStateLabel(agent({ agent_status: "idle" }))).toBe("idle");
    // herdr renders unknown as "idle" in the sidebar.
    expect(agentStateLabel(agent({ agent_status: "unknown" }))).toBe("idle");
  });

  test("ignores non-string and empty custom labels", () => {
    const a = agent({ agent_status: "working", state_labels: { working: "  " } });
    expect(agentStateLabel(a)).toBe("working");
    const b = agent({ agent_status: "working", state_labels: { working: 42 } });
    expect(agentStateLabel(b)).toBe("working");
  });
});

describe("agentAuxStateLabels", () => {
  test("returns only non-status custom labels, deduped", () => {
    const a = agent({
      agent_status: "working",
      state_labels: {
        working: "compiling",
        blocked: "needs approval",
        review: "in review",
        note: "in review",
      },
    });
    expect(agentAuxStateLabels(a)).toEqual(["in review"]);
  });

  test("empty when there are no custom labels", () => {
    expect(agentAuxStateLabels(agent({ state_labels: { working: "x" } }))).toEqual([]);
    expect(agentAuxStateLabels(agent({}))).toEqual([]);
  });
});

describe("row field resolution", () => {
  test("agentDisplayName follows herdr agent_label precedence", () => {
    expect(agentDisplayName(agent({ display_agent: "Claude", name: "n", agent: "a" }))).toBe("Claude");
    expect(agentDisplayName(agent({ name: "n", agent: "a" }))).toBe("n");
    expect(agentDisplayName(agent({ agent: "codex" }))).toBe("codex");
    expect(agentDisplayName(agent({ title: "fix bug" }))).toBe("fix bug");
    expect(agentDisplayName(agent({}))).toBe("agent");
  });

  test("agentWorkTarget prefers stripped terminal title", () => {
    expect(
      agentWorkTarget(
        agent({ terminal_title_stripped: "clean", terminal_title: "raw", title: "t" }),
      ),
    ).toBe("clean");
    expect(agentWorkTarget(agent({ terminal_title: "raw", title: "t" }))).toBe("raw");
    expect(agentWorkTarget(agent({ title: "t" }))).toBe("t");
    expect(agentWorkTarget(agent({}))).toBeNull();
  });
});

describe("collectAgentEntries", () => {
  const machine: MachineInfo = {
    id: "local",
    kind: "local",
    label: "Local",
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

  function snapshot(agents: AgentInfo[], workspaces: WorkspaceInfo[] = [workspace({})]): SessionSnapshot {
    return {
      agents,
      layouts: [],
      panes: [],
      protocol: 1,
      tabs: [],
      version: "test",
      workspaces,
    };
  }

  test("resolves workspace title, branch and tab label", () => {
    const snap = snapshot(
      [agent({ tab_id: "t2" })],
      [
        workspace({
          tab_count: 2,
          label: "proj",
          worktree: {
            checkout_path: "/repo",
            is_linked_worktree: false,
            repo_key: "k",
            repo_name: "proj",
            repo_root: "/repo",
          },
        }),
      ],
    );
    snap.tabs = [
      { agent_status: "unknown", focused: false, label: "Tab 2", number: 2, pane_count: 1, tab_id: "t2", workspace_id: "w1" },
    ];
    const entries = collectAgentEntries(
      [machine],
      { local: snap },
      () => false,
      new Map([["local\nw1", "feature/x"]]),
    );
    expect(entries).toHaveLength(1);
    // label equals repo name -> derived default, branch wins (info-architecture §2)
    expect(entries[0]!.workspaceTitle).toBe("feature/x");
    expect(entries[0]!.tabLabel).toBe("Tab 2");
  });

  test("hides tab label for single-tab workspaces and skips stale machines", () => {
    const snap = snapshot([agent({})]);
    snap.tabs = [
      { agent_status: "unknown", focused: false, label: "Tab 1", number: 1, pane_count: 1, tab_id: "t1", workspace_id: "w1" },
    ];
    const live = collectAgentEntries([machine], { local: snap }, () => false, new Map());
    expect(live[0]!.tabLabel).toBeNull();
    const stale = collectAgentEntries([machine], { local: snap }, () => true, new Map());
    expect(stale).toHaveLength(0);
  });
});

describe("partitionAgents", () => {
  test("groups entries into shelves preserving priority order", () => {
    const sections = partitionAgents([
      entry(agent({ pane_id: "w1", agent_status: "working", state_change_seq: 5 })),
      entry(agent({ pane_id: "b1", agent_status: "blocked", state_change_seq: 1 })),
      entry(agent({ pane_id: "d1", agent_status: "done", state_change_seq: 8 })),
      entry(agent({ pane_id: "i1", agent_status: "idle", state_change_seq: 2 })),
      entry(agent({ pane_id: "b2", agent_status: "blocked", state_change_seq: 9 })),
    ]);
    expect(sections.attention.map((e) => e.agent.pane_id)).toEqual(["b2", "b1"]);
    expect(sections.working.map((e) => e.agent.pane_id)).toEqual(["w1"]);
    expect(sections.done.map((e) => e.agent.pane_id)).toEqual(["d1"]);
    expect(sections.idle.map((e) => e.agent.pane_id)).toEqual(["i1"]);
  });
});

describe("agentRowSignature / shortPaneId", () => {
  test("identical rendered rows share a signature; pane id alone does not split it", () => {
    const a = entry(agent({ pane_id: "w1:p1", agent: "pi", terminal_title_stripped: "pi" }));
    const b = entry(agent({ pane_id: "w1:p2", agent: "pi", terminal_title_stripped: "pi" }));
    const c = entry(agent({ pane_id: "w1:p3", agent: "pi", terminal_title_stripped: "fix bug" }));
    expect(agentRowSignature(a)).toBe(agentRowSignature(b));
    expect(agentRowSignature(a)).not.toBe(agentRowSignature(c));
  });

  test("signature separates workspace, tab and agent label differences", () => {
    const base = agent({ agent: "pi" });
    const a = entry(base);
    const otherWs = { ...entry(base), workspaceTitle: "other" };
    const otherTab = { ...entry(base), tabLabel: "Tab 2" };
    const otherAgent = entry(agent({ agent: "claude", name: "claude" }));
    expect(agentRowSignature(a)).not.toBe(agentRowSignature(otherWs));
    expect(agentRowSignature(a)).not.toBe(agentRowSignature(otherTab));
    expect(agentRowSignature(a)).not.toBe(agentRowSignature(otherAgent));
  });

  test("shortPaneId strips the workspace prefix", () => {
    expect(shortPaneId("w1:p4")).toBe("p4");
    expect(shortPaneId("p4")).toBe("p4");
    expect(shortPaneId("host:w2:p9")).toBe("p9");
  });
});
