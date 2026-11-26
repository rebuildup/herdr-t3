import { describe, expect, test } from "bun:test";
import type {
  AgentInfo,
  MachineInfo,
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentOrganizeKey,
  agentRowSignature,
  agentStateLabel,
  agentWorkTarget,
  collectAgentEntries,
  partitionAgents,
} from "../shell/agents";
import { deriveWorkspace } from "./workspace";
import {
  agentViewModel,
  deriveWorkspaceView,
  projectionRuntimeImpl,
} from "./projectionRuntime";

/* Product-path equivalence (issue #316): the wasm ViewModel must match the
 * TypeScript pipeline it replaces — same section membership/order, same
 * display fields, raw protocol objects embedded for zero-lookup rows. */

function ws(id: string, focused = false, activeTabId = ""): WorkspaceInfo {
  return {
    workspace_id: id,
    active_tab_id: activeTabId,
    agent_status: "idle",
    focused,
    label: id,
    number: 1,
    pane_count: 2,
    tab_count: 2,
  };
}

function tab(id: string, workspaceId: string, focused = false): TabInfo {
  return {
    tab_id: id,
    workspace_id: workspaceId,
    label: id,
    number: 1,
    agent_status: "idle",
    focused,
    pane_count: 2,
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

function snapshot(): SessionSnapshot {
  return {
    protocol: 1,
    version: "test",
    focused_workspace_id: "w1",
    workspaces: [ws("w1", true, "t1"), ws("w2")],
    tabs: [tab("t1", "w1", true), tab("t2", "w1"), tab("t3", "w2")],
    panes: [
      pane("p1", "t1", "w1", true),
      pane("p2", "t1", "w1"),
      pane("p3", "t2", "w1"),
      pane("p4", "t3", "w2"),
    ],
    layouts: [layout("t1", "w1", "p1"), layout("t2", "w1", "p3"), layout("t3", "w2", "p4")],
    agents: [],
  };
}

function agent(over: Partial<AgentInfo>): AgentInfo {
  return {
    agent_status: "working",
    focused: false,
    pane_id: "p1",
    revision: 1,
    state_change_seq: 1,
    tab_id: "t1",
    terminal_id: "term-p1",
    workspace_id: "w1",
    ...over,
  };
}

const MACHINE: MachineInfo = {
  id: "local",
  kind: "local",
  label: "Local",
  enabled: true,
  status: "online",
};

function agentsSnapshot(): SessionSnapshot {
  const s = snapshot();
  s.agents = [
    agent({ pane_id: "p1", agent_status: "blocked", state_change_seq: 5, display_agent: "claude" }),
    agent({ pane_id: "p2", agent_status: "working", state_change_seq: 3, name: "fix-tests" }),
    agent({ pane_id: "p3", agent_status: "done", state_change_seq: 9 }),
    agent({ pane_id: "p4", agent_status: "idle", state_change_seq: 1, workspace_id: "w2", tab_id: "t3" }),
  ];
  return s;
}

describe("projectionRuntime (issue #316)", () => {
  test("wasm artifact loads and reports the rust implementation", () => {
    expect(projectionRuntimeImpl()).toBe("rust");
  });

  test("deriveWorkspaceView matches deriveWorkspace", () => {
    const s = snapshot();
    for (const id of [null, "w1", "w2", "missing"]) {
      expect(deriveWorkspaceView(s, id)).toEqual(deriveWorkspace(s, id));
    }
    expect(deriveWorkspaceView(null, null)).toEqual(deriveWorkspace(null, null));
    expect(deriveWorkspaceView(s, "")).toEqual(deriveWorkspace(s, ""));
  });

  test("agentViewModel sections match collect+partition with display fields", () => {
    const snap = agentsSnapshot();
    const snapshots = { local: snap };
    const branchIndex = new Map<string, string>();
    const organize = {
      "local:p3": { settled_at: 123, settled_seq: 9 },
    };
    const input = {
      machines: [MACHINE],
      snapshots,
      stale: [] as string[],
      branchIndex,
      organize: organize as never,
      unresolvedMachines: null,
    };

    const view = agentViewModel(input);
    const entries = collectAgentEntries([MACHINE], snapshots, () => false, branchIndex);
    const expected = partitionAgents(entries, organize as never, null).sections;

    const tsKeys = (rows: typeof expected.attention) =>
      rows.map((e) => agentOrganizeKey(e.machine.id ?? "", e.agent.pane_id));
    for (const section of ["attention", "working", "done", "idle", "snoozed", "settled"] as const) {
      expect(view.sections[section].map((r) => r.key)).toEqual(tsKeys(expected[section]));
    }

    // Display fields are precomputed and equal the TS row helpers.
    const row = view.sections.attention[0]!;
    const tsEntry = expected.attention[0]!;
    expect(row.display_name).toBe(agentDisplayName(tsEntry.agent));
    expect(row.work_target).toBe(agentWorkTarget(tsEntry.agent, tsEntry.pane) ?? null);
    expect(row.state_label).toBe(agentStateLabel(tsEntry.agent));
    expect(row.aux_labels).toEqual(agentAuxStateLabels(tsEntry.agent));
    expect(row.row_signature).toBe(agentRowSignature(tsEntry));
    expect(row.key).toBe(agentOrganizeKey("local", tsEntry.agent.pane_id));

    // Raw protocol objects are embedded for zero-lookup row rendering.
    expect(row.agent.pane_id).toBe("p1");
    expect(row.machine.id).toBe("local");
    expect(row.workspace?.workspace_id).toBe("w1");
    expect(row.pane?.pane_id).toBe("p1");
  });

  test("stale machines and unresolved organize records preserve TS semantics", () => {
    const snap = agentsSnapshot();
    const organize = { "local:p3": { settled_at: 1, settled_seq: 9 } };
    const input = {
      machines: [{ ...MACHINE, status: "offline" as const }],
      snapshots: { local: snap },
      stale: ["local"],
      branchIndex: new Map<string, string>(),
      organize: organize as never,
      unresolvedMachines: new Set(["local"]),
    };
    const view = agentViewModel(input);
    const entries = collectAgentEntries(
      input.machines,
      input.snapshots,
      (m) => m.id === "local",
      input.branchIndex,
    );
    const expected = partitionAgents(entries, organize as never, input.unresolvedMachines).sections;
    for (const section of ["attention", "working", "done", "idle", "snoozed", "settled"] as const) {
      expect(view.sections[section].map((r) => r.key)).toEqual(
        expected[section].map((e) => agentOrganizeKey(e.machine.id ?? "", e.agent.pane_id)),
      );
    }
  });
});
