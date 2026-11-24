/*
 * "Go to" picker model (issue #114): the herdr TUI navigator
 * (`prefix+g`) lists every workspace with its panes, searchable by
 * name/cwd/agent kind and filterable by agent status. This module builds
 * the same row set from bridge snapshots — workspace / tab / pane jump
 * targets across all live machines — as pure data so the dialog stays a
 * thin renderer and the matching rules are unit-testable.
 *
 * Jump semantics (verified against herdr's API):
 * - workspace -> `selectWorkspace` (route + `workspace.focus`)
 * - tab       -> `selectWorkspace` + `tab.focus`
 * - pane      -> `selectWorkspace` + `pane.focus` (herdr activates the
 *   pane's tab inside `focus_pane_in_workspace`)
 */
import type {
  AgentInfo,
  AgentStatus,
  MachineInfo,
  PaneInfo,
  SessionSnapshot,
  TabInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import { paneTitle, workspaceTitle } from "../lib/workspace";

export type GotoKind = "workspace" | "tab" | "pane";

export interface GotoRow {
  id: string;
  kind: GotoKind;
  machine: string;
  machineLabel: string;
  workspaceId: string;
  tabId?: string | undefined;
  paneId?: string | undefined;
  /** primary line, e.g. workspace title or pane name */
  label: string;
  /** secondary line, e.g. branch or cwd */
  meta?: string | undefined;
  /** tertiary context, e.g. "ws / tab / pane_id" */
  detail?: string | undefined;
  agentKind?: string | undefined;
  status?: AgentStatus | undefined;
  /** everything the text query may match, lowercased words joined */
  searchText: string;
  current: boolean;
}

export interface GotoMachineSnapshot {
  machine: MachineInfo;
  snapshot: SessionSnapshot;
  /** `${machine}\n${workspace_id}` -> branch, from the worktree index */
  branchIndex: ReadonlyMap<string, string>;
}

function agentKindOf(agent: AgentInfo | undefined): string | undefined {
  return agent?.agent ?? agent?.display_agent ?? undefined;
}

function branchFor(
  machineId: string,
  branchIndex: ReadonlyMap<string, string>,
  ws: WorkspaceInfo,
): string | undefined {
  return branchIndex.get(`${machineId}\n${ws.workspace_id}`);
}

/**
 * Build navigator rows in herdr's order: machines in registry order,
 * workspaces in snapshot order, tabs in snapshot order, panes in
 * snapshot order. Stale machines are skipped by the caller (their
 * snapshot is last-known state, not live truth).
 */
export function buildGotoRows(entries: GotoMachineSnapshot[]): GotoRow[] {
  const rows: GotoRow[] = [];
  const multiMachine = entries.length > 1;

  for (const { machine, snapshot, branchIndex } of entries) {
    const agentsByPane = new Map(snapshot.agents.map((a) => [a.pane_id, a]));
    const tabsByWs = new Map<string, TabInfo[]>();
    for (const tab of snapshot.tabs) {
      const list = tabsByWs.get(tab.workspace_id) ?? [];
      list.push(tab);
      tabsByWs.set(tab.workspace_id, list);
    }
    const panesByTab = new Map<string, PaneInfo[]>();
    for (const pane of snapshot.panes) {
      const list = panesByTab.get(pane.tab_id) ?? [];
      list.push(pane);
      panesByTab.set(pane.tab_id, list);
    }

    for (const ws of snapshot.workspaces) {
      const branch = branchFor(machine.id, branchIndex, ws);
      const wsTitle = workspaceTitle(ws, branch);
      const wsDetail =
        ws.worktree?.checkout_path ?? ws.worktree?.repo_name ?? ws.workspace_id;
      const wsSearch = [
        wsTitle,
        ws.label,
        branch,
        ws.worktree?.repo_name,
        ws.worktree?.checkout_path,
        ws.workspace_id,
        machine.label,
      ]
        .filter(Boolean)
        .join(" ");
      rows.push({
        id: `ws:${machine.id}:${ws.workspace_id}`,
        kind: "workspace",
        machine: machine.id,
        machineLabel: machine.label,
        workspaceId: ws.workspace_id,
        label: wsTitle,
        meta: branch,
        detail: multiMachine ? `${machine.label} · ${wsDetail}` : wsDetail,
        searchText: wsSearch.toLowerCase(),
        current:
          snapshot.focused_workspace_id === ws.workspace_id || ws.focused,
      });

      const tabs = tabsByWs.get(ws.workspace_id) ?? [];
      for (const tab of tabs) {
        const tabPanes = panesByTab.get(tab.tab_id) ?? [];
        const tabLabel =
          tab.label.trim().length > 0 ? tab.label : `Tab ${tab.number}`;
        rows.push({
          id: `tab:${machine.id}:${tab.tab_id}`,
          kind: "tab",
          machine: machine.id,
          machineLabel: machine.label,
          workspaceId: ws.workspace_id,
          tabId: tab.tab_id,
          label: tabLabel,
          detail: `${wsTitle} / ${tabLabel}`,
          searchText: `${tabLabel} ${wsSearch} ${tab.tab_id}`.toLowerCase(),
          current:
            (snapshot.focused_tab_id === tab.tab_id || tab.focused) &&
            snapshot.focused_workspace_id === ws.workspace_id,
        });

        tabPanes.forEach((pane, index) => {
          const agent = agentsByPane.get(pane.pane_id);
          const agentKind = agentKindOf(agent);
          const name =
            pane.label ??
            agent?.name ??
            pane.terminal_title_stripped ??
            pane.title ??
            agentKind ??
            "terminal";
          const label =
            tabPanes.length > 1 ? `${name} · ${index + 1}` : name;
          const cwd = pane.foreground_cwd ?? pane.cwd ?? undefined;
          const title =
            agent?.title ?? pane.terminal_title_stripped ?? pane.title ?? undefined;
          const paneSearch = [
            label,
            name,
            title,
            cwd,
            pane.cwd,
            agentKind,
            agent?.display_agent,
            agent?.name,
            pane.pane_id,
            tabLabel,
            wsSearch,
            multiMachine ? machine.label : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          rows.push({
            id: `pane:${machine.id}:${pane.pane_id}`,
            kind: "pane",
            machine: machine.id,
            machineLabel: machine.label,
            workspaceId: ws.workspace_id,
            tabId: tab.tab_id,
            paneId: pane.pane_id,
            label,
            meta: cwd,
            detail: `${wsTitle} / ${tabLabel} / ${pane.pane_id}`,
            agentKind,
            status: agent?.agent_status ?? "unknown",
            searchText: paneSearch.toLowerCase(),
            current:
              snapshot.focused_pane_id === pane.pane_id ||
              (pane.focused && snapshot.focused_workspace_id === ws.workspace_id),
          });
        });
      }
    }
  }
  return rows;
}

export type GotoStatusFilter = "blocked" | "working" | "idle" | "done";

const STATUS_PREFIXES: Record<string, GotoStatusFilter> = {
  blocked: "blocked",
  working: "working",
  idle: "idle",
  done: "done",
  b: "blocked",
  w: "working",
  i: "idle",
  d: "done",
};

export interface GotoQuery {
  /** status filter parsed from a leading `blocked:`/`b` style token */
  status: GotoStatusFilter | null;
  /** remaining lowercase words; every word must match (AND) */
  words: string[];
}

/**
 * Parse the picker query. A leading status token (`blocked`, `working`,
 * `idle`, `done`, or the single letters `b`/`w`/`i`/`d`) sets the filter;
 * everything after it is the text query. Documented in the input
 * placeholder.
 */
export function parseGotoQuery(query: string): GotoQuery {
  const trimmed = query.trim();
  if (!trimmed) return { status: null, words: [] };
  const firstEnd = trimmed.search(/\s/);
  const first = (firstEnd === -1 ? trimmed : trimmed.slice(0, firstEnd)).toLowerCase();
  const status = STATUS_PREFIXES[first];
  const rest = firstEnd === -1 ? "" : trimmed.slice(firstEnd + 1);
  const effective = status ? rest : trimmed;
  const words = effective
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return { status: status ?? null, words };
}

/**
 * Apply the parsed query to rows. Without a status filter every row kind
 * participates in text matching. With a status filter only panes whose
 * agent status matches survive, and their ancestor workspace/tab rows are
 * kept as grouping context — the same shape as herdr's navigator, where a
 * status filter narrows to matching panes under their workspace headers.
 */
export function filterGotoRows(rows: GotoRow[], query: string): GotoRow[] {
  const { status, words } = parseGotoQuery(query);
  const textMatch = (row: GotoRow) =>
    words.every((word) => row.searchText.includes(word));
  if (!status) return rows.filter(textMatch);

  const matchingPanes = rows.filter(
    (row) =>
      row.kind === "pane" && row.status === status && textMatch(row),
  );
  const keepWorkspaces = new Set(matchingPanes.map((r) => r.workspaceId));
  const keepTabs = new Set(
    matchingPanes
      .filter((r) => r.tabId)
      .map((r) => `${r.workspaceId}/${r.tabId}`),
  );
  const paneIds = new Set(matchingPanes.map((r) => r.id));
  return rows.filter((row) => {
    if (paneIds.has(row.id)) return true;
    if (row.kind === "workspace") return keepWorkspaces.has(row.workspaceId);
    if (row.kind === "tab")
      return keepTabs.has(`${row.workspaceId}/${row.tabId ?? ""}`);
    return false;
  });
}
