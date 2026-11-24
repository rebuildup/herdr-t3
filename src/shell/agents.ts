/*
 * Agents work surface logic (issue #151, docs/design/info-architecture.md
 * §6). Pure derivation over bridge snapshots — the snapshot stays the
 * single source of truth and herdr `AgentStatus` the only status source;
 * the Attention/Working/Done/Idle sections are a T3 settle/inbox-style
 * presentation mapping, not client-side state.
 *
 * Row model follows T3 `SidebarThreadRow`'s information hierarchy
 * (issue #200): line 1 is context + state (status icon, workspace/tab/
 * machine location, resolved state label), line 2 is the work target
 * (live pane terminal title) with agent identity and disambiguation as
 * secondary meta. Sort inside a section mirrors
 * `AgentPanelSortConfig::Priority`: status priority, then
 * `state_change_seq` descending.
 *
 * User-side organize state (settle/snooze, issue #173) is a separate
 * input: `AgentOrganizeMap` records which pane the user shelved and the
 * `state_change_seq` observed at that moment. It never alters herdr's
 * reported status — settled rows move to the Settled shelf, snoozed rows
 * move to the Snoozed shelf, and a `state_change_seq` advance
 * auto-returns the row to its natural section (info-architecture.md §6.2).
 */
import type {
  AgentInfo,
  AgentStatus,
  MachineInfo,
  PaneInfo,
  SessionSnapshot,
  WorkspaceInfo,
} from "../../shared/protocol";
import { workspaceTitle } from "../lib/workspace";

export type AgentSection =
  | "attention"
  | "working"
  | "done"
  | "idle"
  | "snoozed"
  | "settled";

// T3 sidebar order (Sidebar.logic.ts SidebarSection): the always-visible
// list first, then the working/snoozed/settled shelves stacked at the
// bottom — all collapsed by default.
export const AGENT_SECTIONS: readonly AgentSection[] = [
  "attention",
  "done",
  "idle",
  "working",
  "snoozed",
  "settled",
];

export const AGENT_SECTION_LABELS: Record<AgentSection, string> = {
  attention: "Attention",
  working: "Working",
  done: "Done",
  idle: "Idle",
  snoozed: "Snoozed",
  settled: "Settled",
};

/**
 * Sections that render as collapsible bottom shelves. Attention, Done and
 * Idle are the always-visible list (T3's active region has no collapse).
 */
export const COLLAPSIBLE_AGENT_SECTIONS = [
  "working",
  "snoozed",
  "settled",
] as const;
export type CollapsibleAgentSection = (typeof COLLAPSIBLE_AGENT_SECTIONS)[number];

export function isCollapsibleAgentSection(
  section: AgentSection,
): section is CollapsibleAgentSection {
  return (COLLAPSIBLE_AGENT_SECTIONS as readonly AgentSection[]).includes(section);
}

export function agentSection(status: AgentStatus): AgentSection {
  switch (status) {
    case "blocked":
      return "attention";
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      // idle, unknown and any status herdr adds later are not actionable.
      return "idle";
  }
}

/** herdr `status_priority` (src/client/shell.rs): higher sorts first. */
const AGENT_STATUS_PRIORITY: Record<string, number> = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

function statusPriority(status: AgentStatus): number {
  return AGENT_STATUS_PRIORITY[status] ?? 0;
}

export function agentStateSeq(agent: AgentInfo): number {
  return agent.state_change_seq ?? agent.revision;
}

/** herdr `AgentPanelSortConfig::Priority` order, pane_id as stable tiebreak. */
export function compareAgents(a: AgentInfo, b: AgentInfo): number {
  return (
    statusPriority(b.agent_status) - statusPriority(a.agent_status) ||
    agentStateSeq(b) - agentStateSeq(a) ||
    a.pane_id.localeCompare(b.pane_id)
  );
}

const KNOWN_STATUSES = new Set(["working", "blocked", "done", "idle", "unknown"]);

/**
 * State text for line 1: herdr's `state_labels[current status]` when it is
 * a non-empty string, else herdr's `sidebar_status_text` fallback
 * (unknown renders as "idle", matching the TUI).
 */
export function agentStateLabel(agent: AgentInfo): string {
  const status = agent.agent_status;
  const key = KNOWN_STATUSES.has(status) ? status : "unknown";
  const custom = agent.state_labels?.[key];
  if (typeof custom === "string" && custom.trim().length > 0) return custom;
  switch (status) {
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "working":
      return "working";
    default:
      return "idle";
  }
}

/**
 * Auxiliary labels for line 2: `state_labels` entries keyed by something
 * other than a known status (custom annotations herdr reports), deduped.
 * Labels for *other* statuses are not shown — they describe a state the
 * agent is not in.
 */
export function agentAuxStateLabels(agent: AgentInfo): string[] {
  const labels = agent.state_labels;
  if (!labels) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(labels)) {
    if (KNOWN_STATUSES.has(key)) continue;
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 2) break;
  }
  return out;
}

/** herdr `agent_label`: display_agent > name > agent > title. */
export function agentDisplayName(agent: AgentInfo): string {
  return (
    agent.display_agent ??
    agent.name ??
    agent.agent ??
    agent.title ??
    "agent"
  );
}

/**
 * Work target: the live pane's OSC terminal title first (agent records can
 * lag it), then the agent record's own title fields, then the agent title.
 */
export function agentWorkTarget(agent: AgentInfo, pane?: PaneInfo | null): string | null {
  return (
    pane?.terminal_title_stripped ??
    pane?.terminal_title ??
    // Display metadata title (`pane report-metadata --title`, agent
    // self-reports) is the pane's own "what am I doing" label — it beats
    // the agent record's possibly-stale title fields (issue #204 review:
    // untitled panes rendered the bare agent name as the row's work
    // target even when the pane carried a meaningful title).
    pane?.title ??
    agent.terminal_title_stripped ??
    agent.terminal_title ??
    agent.title ??
    null
  );
}

/**
 * Identity signature for row disambiguation (issue #165): two agents that
 * would render the same two lines — same machine, workspace, tab, agent
 * label and work target — share a signature and need the pane id shown.
 */
export function agentRowSignature(entry: AgentListEntry): string {
  const { machine, agent } = entry;
  return [
    machine.id,
    entry.workspaceTitle,
    entry.tabLabel ?? "",
    agentDisplayName(agent),
    agentWorkTarget(agent, entry.pane) ?? "",
  ].join("\u001f");
}

/** Short pane token for disambiguation: `w1:p4` → `p4`, bare ids pass through. */
export function shortPaneId(paneId: string): string {
  const idx = paneId.lastIndexOf(":");
  return idx >= 0 ? paneId.slice(idx + 1) : paneId;
}

export interface AgentListEntry {
  machine: MachineInfo;
  agent: AgentInfo;
  workspace: WorkspaceInfo | undefined;
  /** Live pane record for the agent's pane, when the snapshot has one. */
  pane?: PaneInfo | undefined;
  workspaceTitle: string;
  /** Tab label, shown only when the workspace has more than one tab (herdr `tab` token rule). */
  tabLabel: string | null;
}

/**
 * Every agent across live machines with its resolved display context.
 * Machines whose snapshot is stale (`isStale`) contribute nothing — their
 * held snapshot is last-known state, not current.
 */
export function collectAgentEntries(
  machines: MachineInfo[],
  snapshots: Record<string, SessionSnapshot>,
  isStale: (machine: MachineInfo) => boolean,
  branchIndex: ReadonlyMap<string, string>,
): AgentListEntry[] {
  const list: AgentListEntry[] = [];
  for (const machine of machines) {
    if (isStale(machine)) continue;
    const snap = snapshots[machine.id];
    if (!snap) continue;
    const wsById = new Map(snap.workspaces.map((w) => [w.workspace_id, w]));
    const tabById = new Map(snap.tabs.map((t) => [t.tab_id, t]));
    const paneById = new Map(snap.panes.map((p) => [p.pane_id, p]));
    for (const agent of snap.agents) {
      const ws = wsById.get(agent.workspace_id);
      const branch = ws ? branchIndex.get(`${machine.id}\n${ws.workspace_id}`) : undefined;
      const tab = tabById.get(agent.tab_id);
      list.push({
        machine,
        agent,
        workspace: ws,
        pane: paneById.get(agent.pane_id),
        workspaceTitle: ws ? workspaceTitle(ws, branch) : agent.workspace_id,
        tabLabel: ws && ws.tab_count > 1 ? (tab?.label ?? null) : null,
      });
    }
  }
  return list;
}

export interface AgentSections {
  attention: AgentListEntry[];
  working: AgentListEntry[];
  done: AgentListEntry[];
  idle: AgentListEntry[];
  /** User-snoozed rows (issue #173) — hidden behind a collapsed shelf, manually restorable. */
  snoozed: AgentListEntry[];
  /** User-settled rows (issue #173) — herdr status is unchanged, only shelf membership. */
  settled: AgentListEntry[];
}

/**
 * User-side organize record (issue #173): which shelf the user put the
 * agent on, plus the `state_change_seq` observed at action time. A later
 * seq advance means the agent did something new and the row returns to
 * its natural section automatically (T3 inbox return equivalent).
 */
export type AgentOrganizeKind = "settled" | "snoozed";

export interface AgentOrganizeRecord {
  kind: AgentOrganizeKind;
  seq: number;
}

/**
 * Organize records keyed by machine + pane. pane_id alone is not unique
 * across machines, so the key carries both (same `\n` convention as the
 * workspace branch index).
 */
export type AgentOrganizeMap = Record<string, AgentOrganizeRecord>;

export function agentOrganizeKey(machineId: string, paneId: string): string {
  return `${machineId}\n${paneId}`;
}

export interface AgentPartition {
  sections: AgentSections;
  /**
   * Organize records still in effect after this partition: auto-restored
   * rows (seq advanced) and records for panes that vanished are dropped,
   * so persisting this map prunes stale entries.
   */
  organize: AgentOrganizeMap;
}

/**
 * Partition into T3-style shelves; each shelf keeps herdr priority order.
 * `organize` is the user-side settle/snooze overlay: settled rows go to
 * the Settled shelf, snoozed rows go to the Snoozed shelf (T3 keeps
 * snoozed threads reachable for manual unsnooze — a fully hidden snooze
 * is a one-way door), and either returns to its natural section once
 * `state_change_seq` advances past the recorded value.
 */
export function partitionAgents(
  entries: AgentListEntry[],
  organize: AgentOrganizeMap = {},
  unresolvedMachines: ReadonlySet<string> | null = new Set(),
): AgentPartition {
  const sections: AgentSections = {
    attention: [],
    working: [],
    done: [],
    idle: [],
    snoozed: [],
    settled: [],
  };
  const active: AgentOrganizeMap = {};
  const seenKeys = new Set<string>();
  const sorted = [...entries].sort((a, b) => compareAgents(a.agent, b.agent));
  for (const entry of sorted) {
    const key = agentOrganizeKey(entry.machine.id, entry.agent.pane_id);
    seenKeys.add(key);
    const record = organize[key];
    // State advanced since the user shelved it — auto-return to the
    // natural section and drop the record (T3 inbox return; herdr state
    // itself never changed).
    const shelved =
      record !== undefined && agentStateSeq(entry.agent) <= record.seq
        ? record
        : undefined;
    if (shelved !== undefined) {
      active[key] = shelved;
      sections[shelved.kind].push(entry);
      continue;
    }
    sections[agentSection(entry.agent.agent_status)].push(entry);
  }
  // Records that could not be resolved this pass must survive: a machine
  // without a usable snapshot (still connecting, or stale/offline) has no
  // entries, and pruning on absent data would wipe settle/snooze on every
  // app start before the first snapshot lands. `null` means the machine
  // list itself has not loaded — nothing can be resolved, keep everything.
  // Resolved machines still prune records for panes that genuinely vanished.
  for (const [key, record] of Object.entries(organize)) {
    if (active[key] !== undefined || seenKeys.has(key)) continue;
    const machineId = key.slice(0, key.indexOf("\n"));
    if (unresolvedMachines === null || unresolvedMachines.has(machineId)) {
      active[key] = record;
    }
  }
  return { sections, organize: active };
}
