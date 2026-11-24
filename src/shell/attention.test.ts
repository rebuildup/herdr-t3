import { describe, expect, test } from "bun:test";
import type { AgentInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol";
import { observeSnapshotAttention } from "./attention";
import { dismissNotice, getNotices, pushNotice } from "./notices";

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

function snapshot(agents: AgentInfo[]): SessionSnapshot {
  return {
    agents,
    layouts: [],
    panes: [],
    protocol: 1,
    tabs: [],
    version: "test",
    workspaces: [workspace({})],
  };
}

function snapshotWith(agents: AgentInfo[], workspaces: WorkspaceInfo[]): SessionSnapshot {
  return { ...snapshot(agents), workspaces };
}

function sink() {
  const calls: { machine: string; workspaceId: string; paneId: string }[] = [];
  return {
    calls,
    sink: {
      focusAgent: (machine: string, workspaceId: string, paneId: string) => {
        calls.push({ machine, workspaceId, paneId });
      },
    },
  };
}

// Module-level dedupe state in attention.ts is keyed per machine; every
// test uses a unique machine id so cases stay isolated.
let machineSeq = 0;
function machine() {
  machineSeq += 1;
  return `test-machine-${machineSeq}`;
}

function clearNotices() {
  for (const n of getNotices()) dismissNotice(n.id);
}

describe("observeSnapshotAttention", () => {
  test("first snapshot per machine is a baseline and never notifies", () => {
    clearNotices();
    const m = machine();
    const { sink: s } = sink();
    observeSnapshotAttention(
      m,
      null,
      snapshot([agent({ agent_status: "blocked" })]),
      s,
    );
    expect(getNotices().length).toBe(0);
  });

  test("transition into blocked pushes a notice with an Open action", () => {
    clearNotices();
    const m = machine();
    const { sink: s, calls } = sink();
    observeSnapshotAttention(m, null, snapshot([agent({})]), s);
    observeSnapshotAttention(
      m,
      snapshot([agent({})]),
      snapshot([agent({ agent_status: "blocked", state_change_seq: 2 })]),
      s,
    );
    const notice = getNotices().find((n) => n.title === "Agent needs input");
    expect(notice).toBeDefined();
    expect(notice?.body).toContain("ws");
    notice?.action?.run();
    expect(calls).toEqual([{ machine: m, workspaceId: "w1", paneId: "p1" }]);
    dismissNotice(notice!.id);
  });

  test("transition into done pushes 'Agent finished'", () => {
    clearNotices();
    const m = machine();
    const { sink: s } = sink();
    observeSnapshotAttention(m, null, snapshot([agent({})]), s);
    observeSnapshotAttention(
      m,
      snapshot([agent({})]),
      snapshot([agent({ agent_status: "done", state_change_seq: 2 })]),
      s,
    );
    expect(getNotices().some((n) => n.title === "Agent finished")).toBe(true);
    for (const n of getNotices().filter((n) => n.title === "Agent finished")) dismissNotice(n.id);
  });

  test("non-attention statuses never notify", () => {
    clearNotices();
    const m = machine();
    const { sink: s } = sink();
    observeSnapshotAttention(m, null, snapshot([agent({ agent_status: "idle" })]), s);
    observeSnapshotAttention(
      m,
      snapshot([agent({ agent_status: "idle" })]),
      snapshot([agent({ agent_status: "working", state_change_seq: 2 })]),
      s,
    );
    expect(getNotices().filter((n) => n.body?.includes("· ws")).length).toBe(0);
  });

  test("repeated snapshot pushes do not re-fire for the same state signature", () => {
    clearNotices();
    const m = machine();
    const { sink: s } = sink();
    const working = snapshot([agent({})]);
    observeSnapshotAttention(m, null, working, s);
    const blocked = snapshot([agent({ agent_status: "blocked", state_change_seq: 2 })]);
    observeSnapshotAttention(m, working, blocked, s);
    const count = getNotices().filter((n) => n.title === "Agent needs input").length;
    // Same agent re-enters blocked from a different status -> notifies once
    // more; identical seq with no status change -> never (dedupe key).
    observeSnapshotAttention(m, blocked, blocked, s);
    expect(getNotices().filter((n) => n.title === "Agent needs input").length).toBe(count);
    const workingAgain = snapshot([agent({ agent_status: "working", state_change_seq: 3 })]);
    observeSnapshotAttention(m, blocked, workingAgain, s);
    observeSnapshotAttention(
      m,
      workingAgain,
      snapshot([agent({ agent_status: "blocked", state_change_seq: 4 })]),
      s,
    );
    expect(getNotices().filter((n) => n.title === "Agent needs input").length).toBe(count + 1);
    for (const n of getNotices()) dismissNotice(n.id);
  });

  test("notice body falls back to workspace_id when the workspace is gone", () => {
    clearNotices();
    const m = machine();
    const { sink: s } = sink();
    const next = snapshotWith(
      [agent({ agent_status: "blocked", state_change_seq: 9 })],
      [],
    );
    observeSnapshotAttention(m, null, snapshot([agent({})]), s);
    observeSnapshotAttention(m, snapshot([agent({})]), next, s);
    const notice = getNotices().find((n) => n.title === "Agent needs input");
    expect(notice?.body).toContain("w1");
    if (notice) dismissNotice(notice.id);
  });
});

describe("notices store", () => {
  test("pushNotice/dismissNotice round-trip", () => {
    const id = pushNotice({ kind: "info", title: "t", body: "b" });
    expect(getNotices().some((n) => n.id === id)).toBe(true);
    dismissNotice(id);
    expect(getNotices().some((n) => n.id === id)).toBe(false);
  });
});
