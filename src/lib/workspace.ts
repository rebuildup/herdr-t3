import type {
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";

/*
 * Derived view of the selected machine's session snapshot: which workspace
 * is focused, which tab is active inside it, which panes that tab owns, and
 * the pane layout herdr reported for it. Pure derivation — the bridge
 * snapshot stays the single source of truth.
 */
export interface WorkspaceView {
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  activeWorkspace: WorkspaceInfo | undefined;
  workspaceTabs: TabInfo[];
  activeTab: TabInfo | undefined;
  tabPanes: PaneInfo[];
  layout: PaneLayoutSnapshot | undefined;
  focusedPane: PaneInfo | undefined;
}

export function workspaceTitle(ws: WorkspaceInfo): string {
  return ws.label || ws.worktree?.repo_name || ws.workspace_id;
}

export function deriveWorkspaceView(snapshot: SessionSnapshot | null): WorkspaceView {
  const workspaces = snapshot?.workspaces ?? [];
  const tabs = snapshot?.tabs ?? [];
  const panes = snapshot?.panes ?? [];
  const focusedWorkspaceId =
    snapshot?.focused_workspace_id ?? workspaces.find((w) => w.focused)?.workspace_id;
  const activeWorkspace =
    workspaces.find((w) => w.workspace_id === focusedWorkspaceId) ?? workspaces[0];
  const workspaceTabs = activeWorkspace
    ? tabs.filter((t) => t.workspace_id === activeWorkspace.workspace_id)
    : [];
  const activeTab =
    workspaceTabs.find((t) => t.tab_id === activeWorkspace?.active_tab_id) ?? workspaceTabs[0];
  const tabPanes = activeTab ? panes.filter((p) => p.tab_id === activeTab.tab_id) : [];
  const layout = snapshot?.layouts.find((l) => l.tab_id === activeTab?.tab_id);
  const focusedPane =
    tabPanes.find((p) => p.pane_id === layout?.focused_pane_id) ??
    tabPanes.find((p) => p.focused) ??
    tabPanes[0];
  return {
    workspaces,
    tabs,
    panes,
    activeWorkspace,
    workspaceTabs,
    activeTab,
    tabPanes,
    layout,
    focusedPane,
  };
}
