import type {
  PaneInfo,
  PaneLayoutSnapshot,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";

/*
 * Derived view of one workspace inside a machine's session snapshot: its
 * tabs, the tab herdr marks active, that tab's panes, and the pane layout
 * herdr reported. Pure derivation — the bridge snapshot stays the single
 * source of truth. Works for the herdr-focused workspace and for any
 * other workspace in the same snapshot (M2 multi-workspace display).
 */
export interface WorkspaceView {
  workspace: WorkspaceInfo | undefined;
  tabs: TabInfo[];
  activeTab: TabInfo | undefined;
  tabPanes: PaneInfo[];
  layout: PaneLayoutSnapshot | undefined;
  focusedPane: PaneInfo | undefined;
}

export function workspaceTitle(
  ws: WorkspaceInfo,
  branch?: string | null,
): string {
  const label = ws.label?.trim();
  const repo = ws.worktree?.repo_name?.trim();
  // A label identical to the repo name is herdr's derived default, not a
  // user-chosen name — the branch is more informative (info-architecture §2).
  if (label && label !== repo) return label;
  return branch?.trim() || repo || label || ws.workspace_id;
}

export function paneTitle(pane: PaneInfo): string {
  return (
    pane.terminal_title_stripped ??
    pane.title ??
    pane.label ??
    pane.pane_id
  );
}

export function deriveWorkspace(
  snapshot: SessionSnapshot | null | undefined,
  workspaceId: string | null,
): WorkspaceView {
  const workspaces = snapshot?.workspaces ?? [];
  const workspace =
    (workspaceId
      ? workspaces.find((w) => w.workspace_id === workspaceId)
      : undefined) ??
    workspaces.find((w) => w.workspace_id === snapshot?.focused_workspace_id) ??
    workspaces.find((w) => w.focused) ??
    workspaces[0];
  const tabs = workspace
    ? (snapshot?.tabs ?? []).filter((t) => t.workspace_id === workspace.workspace_id)
    : [];
  const activeTab =
    tabs.find((t) => t.tab_id === workspace?.active_tab_id) ?? tabs[0];
  const tabPanes = activeTab
    ? (snapshot?.panes ?? []).filter((p) => p.tab_id === activeTab.tab_id)
    : [];
  const layout = snapshot?.layouts.find((l) => l.tab_id === activeTab?.tab_id);
  const focusedPane =
    tabPanes.find((p) => p.pane_id === layout?.focused_pane_id) ??
    tabPanes.find((p) => p.focused) ??
    tabPanes[0];
  return { workspace, tabs, activeTab, tabPanes, layout, focusedPane };
}
