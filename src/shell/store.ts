/*
 * Fixture shell store for the M1 reproduction (issue #83). Holds mutable
 * copies of the dummy machines/workspaces so sidebar/header interactions
 * (rename, reorder, close, new, tab/pane ops) behave like the real app.
 * M2 replaces this with the bridge snapshot behind the same contracts.
 */
import { useSyncExternalStore } from "react";
import {
  FIXTURE_MACHINES,
  FIXTURE_WORKSPACES,
  type FixtureMachine,
  type FixturePane,
  type FixtureTab,
  type FixtureWorkspace,
} from "./fixtures";

export interface ShellState {
  machines: FixtureMachine[];
  workspaces: FixtureWorkspace[];
  /** workspaceId -> active tabId */
  activeTabByWorkspace: Record<string, string>;
  /** tabId -> zoomed pane focus (single visible pane) */
  zoomedTab: string | null;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function initialState(): ShellState {
  const activeTabByWorkspace: Record<string, string> = {};
  for (const ws of FIXTURE_WORKSPACES) {
    activeTabByWorkspace[ws.id] = ws.tabs[0]?.id ?? "";
  }
  return {
    machines: clone(FIXTURE_MACHINES),
    workspaces: clone(FIXTURE_WORKSPACES),
    activeTabByWorkspace,
    zoomedTab: null,
  };
}

let state = initialState();
const listeners = new Set<() => void>();

function setState(next: ShellState) {
  state = next;
  for (const listener of listeners) listener();
}

function update(mutate: (draft: ShellState) => void) {
  const draft = clone(state);
  mutate(draft);
  setState(draft);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShellState(): ShellState {
  return state;
}

export function useShellState(): ShellState {
  return useSyncExternalStore(subscribe, getShellState, getShellState);
}

export function activeTabOf(workspace: FixtureWorkspace, s: ShellState): FixtureTab | undefined {
  const id = s.activeTabByWorkspace[workspace.id];
  return workspace.tabs.find((t) => t.id === id) ?? workspace.tabs[0];
}

export const shellActions = {
  selectTab(workspaceId: string, tabId: string) {
    update((s) => {
      s.activeTabByWorkspace[workspaceId] = tabId;
    });
  },

  newWorkspace(machineId: string) {
    const id = `ws-new-${Date.now().toString(36)}`;
    const tabId = `${id}-tab-1`;
    const paneId = `${id}-pane-1`;
    update((s) => {
      const ws: FixtureWorkspace = {
        id,
        machineId,
        title: "untitled",
        agentStatus: "idle",
        tabs: [
          {
            id: tabId,
            workspaceId: id,
            label: "main",
            number: 1,
            agentStatus: "idle",
            panes: [{ id: paneId, title: "zsh", agentStatus: "idle" }],
          },
        ],
      };
      s.workspaces.push(ws);
      s.activeTabByWorkspace[id] = tabId;
    });
    return id;
  },

  renameWorkspace(workspaceId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    update((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId);
      if (ws) ws.title = trimmed;
    });
  },

  closeWorkspace(workspaceId: string) {
    update((s) => {
      s.workspaces = s.workspaces.filter((w) => w.id !== workspaceId);
      delete s.activeTabByWorkspace[workspaceId];
      if (s.zoomedTab) {
        const gone = !s.workspaces.some((w) =>
          w.tabs.some((t) => t.id === s.zoomedTab),
        );
        if (gone) s.zoomedTab = null;
      }
    });
  },

  moveWorkspace(workspaceId: string, machineId: string, direction: -1 | 1) {
    update((s) => {
      // Reorder only within the machine's own subsequence, preserving the
      // positions other machines' workspaces occupy in the flat list.
      const slots = s.workspaces
        .map((w, i) => (w.machineId === machineId ? i : -1))
        .filter((i) => i >= 0);
      const group = slots.map((i) => s.workspaces[i]!);
      const index = group.findIndex((w) => w.id === workspaceId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= group.length) return;
      const [moved] = group.splice(index, 1);
      group.splice(target, 0, moved!);
      slots.forEach((slot, i) => {
        s.workspaces[slot] = group[i]!;
      });
    });
  },

  newTab(workspaceId: string) {
    const tabId = `tab-${Date.now().toString(36)}`;
    const paneId = `${tabId}-pane-1`;
    update((s) => {
      const ws = s.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return;
      const number = ws.tabs.length + 1;
      ws.tabs.push({
        id: tabId,
        workspaceId,
        label: `Tab ${number}`,
        number,
        agentStatus: "idle",
        panes: [{ id: paneId, title: "zsh", agentStatus: "idle" }],
      });
      s.activeTabByWorkspace[workspaceId] = tabId;
    });
  },

  closeTab(tabId: string) {
    update((s) => {
      for (const ws of s.workspaces) {
        const index = ws.tabs.findIndex((t) => t.id === tabId);
        if (index < 0) continue;
        ws.tabs.splice(index, 1);
        if (ws.tabs.length === 0) {
          // A workspace always keeps at least one tab in herdr; fixture
          // mirrors that by giving it a fresh empty tab.
          const freshId = `${ws.id}-tab-new`;
          ws.tabs.push({
            id: freshId,
            workspaceId: ws.id,
            label: "main",
            number: 1,
            agentStatus: "idle",
            panes: [{ id: `${freshId}-p1`, title: "zsh", agentStatus: "idle" }],
          });
        }
        if (s.activeTabByWorkspace[ws.id] === tabId) {
          s.activeTabByWorkspace[ws.id] = ws.tabs[0]!.id;
        }
      }
      if (s.zoomedTab === tabId) s.zoomedTab = null;
    });
  },

  renameTab(tabId: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    update((s) => {
      for (const ws of s.workspaces) {
        const tab = ws.tabs.find((t) => t.id === tabId);
        if (tab) tab.label = trimmed;
      }
    });
  },

  splitPane(tabId: string, direction: "right" | "down") {
    update((s) => {
      for (const ws of s.workspaces) {
        const tab = ws.tabs.find((t) => t.id === tabId);
        if (!tab) continue;
        const n = tab.panes.length + 1;
        tab.panes.push({
          id: `${tabId}-pane-${n}`,
          title: direction === "right" ? "zsh" : "zsh",
          agentStatus: "idle",
        });
      }
    });
  },

  closePane(paneId: string) {
    update((s) => {
      for (const ws of s.workspaces) {
        for (const tab of ws.tabs) {
          const index = tab.panes.findIndex((p) => p.id === paneId);
          if (index < 0) continue;
          tab.panes.splice(index, 1);
          if (tab.panes.length === 0) {
            tab.panes.push({
              id: `${tab.id}-pane-fresh`,
              title: "zsh",
              agentStatus: "idle",
            });
          }
        }
      }
    });
  },

  toggleZoom(tabId: string) {
    update((s) => {
      s.zoomedTab = s.zoomedTab === tabId ? null : tabId;
    });
  },
};
