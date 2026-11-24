/*
 * Sidebar body — T3 Code's Sidebar list structure (issue #83) driven by
 * real bridge data (issue #84): search field + primary action, workspace
 * rows grouped under machine folders when more than one machine is
 * configured, flat list otherwise (app-shell.md §2). Mutations go through
 * whitelisted herdr RPC; snapshots pushed by the bridge update the UI.
 */
import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  MonitorIcon,
  MousePointerClickIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  UnplugIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import {
  SidebarContent,
  SidebarGroup,
  SidebarInput,
  SidebarMenuButton,
} from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { statusIcon } from "~/components/statusIcons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { AgentHoverCard } from "./AgentHoverCard";
import { getGeneralSettings } from "~/lib/settings";
import { getLocalStorageBoolean, setLocalStorageBoolean } from "~/lib/localStorage";
import { createSidebarListMotion } from "~/lib/sidebarListMotion";
import { machineConnect, machineDisconnect } from "~/lib/api";
import type { MachineInfo, PaneInfo, WorkspaceInfo } from "../../shared/protocol";
import { PaneDetailsDialog } from "~/components/PaneDetailsDialog";
import {
  AGENT_SECTIONS,
  AGENT_SECTION_LABELS,
  COLLAPSIBLE_AGENT_SECTIONS,
  agentAuxStateLabels,
  agentDisplayName,
  agentRowSignature,
  agentStateLabel,
  agentWorkTarget,
  collectAgentEntries,
  partitionAgents,
  shortPaneId,
  type AgentListEntry,
  type CollapsibleAgentSection,
} from "./agents";
import { workspaceTitle } from "~/lib/workspace";
import { moveInsertIndex } from "~/lib/reorder";
import { machineStale, useRouteWorkspace } from "./view";
import {
  callRpc,
  ensureMachine,
  machineListOf,
  newWorkspace,
  selectWorkspace,
  useBridgeState,
} from "./bridge";
import { RenameDialog, type RenameTarget } from "~/components/RenameDialog";
import { useWorkspaceBranch, useWorkspaceBranchIndex } from "./worktrees";
import { LOCAL_MACHINE } from "~/lib/api";

interface RenameState {
  target: RenameTarget;
  machine: string;
}

function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string;
  children?: ReactNode;
} & Omit<
  React.ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function WorkspaceRow({
  machine,
  workspace,
  isActive,
  inFolder = false,
  onNewWorkspace,
  onRename,
  onClose,
}: {
  machine: MachineInfo;
  workspace: WorkspaceInfo;
  isActive: boolean;
  inFolder?: boolean;
  onNewWorkspace: () => void;
  onRename: (target: RenameTarget, machine: string) => void;
  onClose: () => void;
}) {
  const machineLabel = inFolder ? undefined : machine.label;
  const branch = useWorkspaceBranch(machine.id, workspace.workspace_id);
  const title = workspaceTitle(workspace, branch);

  const rowButton = (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row inside a composite control, same exception as T3's thread rows
    <button
      type="button"
      data-sidebar-row={workspace.workspace_id}
      onClick={() => selectWorkspace(machine.id, workspace.workspace_id)}
      className={cn(
        // Two-line hierarchy per info-architecture.md §7 (herdr spaces token
        // rows): identity on line 1, branch/meta on line 2 — never squeezed
        // into one truncating row (issue #153).
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-[var(--control-radius)] py-1.5 text-left outline-none transition-colors",
        inFolder
          ? "ps-7 pe-[var(--sidebar-row-content-inset)]"
          : "px-[var(--sidebar-row-content-inset)]",
        "hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isActive &&
          // Tinted neutral fill, no ring: a white bordered card on the
          // zinc-50 sidebar read as a floating box in light mode, and a
          // bare accent tint was too faint — foreground/6% keeps figure-
          // ground separation in both themes (issue #128).
          "bg-foreground/[0.06] font-medium text-sidebar-foreground",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {statusIcon(workspace.agent_status)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
          {title}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 ps-6.5 text-2xs text-sidebar-muted-foreground">
        {branch && title !== branch ? (
          <span className="min-w-0 truncate">{branch}</span>
        ) : null}
        <span className="shrink-0 tabular-nums">
          {workspace.tab_count}t · {workspace.pane_count}p
        </span>
        {machineLabel ? (
          <span className="min-w-0 truncate">{machineLabel}</span>
        ) : null}
      </span>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">{rowButton}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => selectWorkspace(machine.id, workspace.workspace_id)}
        >
          <MousePointerClickIcon /> Focus
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            onRename(
              {
                kind: "workspace",
                id: workspace.workspace_id,
                label: title,
              },
              machine.id,
            )
          }
        >
          <PencilIcon /> Rename…
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewWorkspace}>
          <SquarePenIcon /> New workspace here
        </ContextMenuItem>
        {/* Internal IDs stay out of the default UI (info-architecture.md
            §5/§7); the context menu is where they can be inspected. */}
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(workspace.workspace_id)}
        >
          <CopyIcon /> Copy workspace ID
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={onClose}>
          <XIcon /> Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MachineFolderHeader({
  machine,
  count,
  collapsed,
  onToggle,
  onNewWorkspace,
}: {
  machine: MachineInfo;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onNewWorkspace: () => void;
}) {
  const offline = machine.status !== "online" && machine.status !== "connecting";
  return (
    <li className="group/project-folder relative mt-2 list-none first:mt-0">
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          {/* oxlint-disable-next-line herdr-t3/no-raw-control -- folder header row is a composite disclosure control, same pattern as T3 SidebarProjectFolderHeader */}
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {offline ? (
              <WifiOffIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
            ) : (
              <MonitorIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm font-medium",
                offline ? "text-sidebar-muted-foreground" : "text-sidebar-foreground/90",
              )}
            >
              {machine.label}
            </span>
            {collapsed ? (
              <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
                {count}
              </span>
            ) : null}
            {/* An expanded group with zero workspaces has nothing to
                disclose — hide the chevron instead of implying content
                (issue #130). */}
            {collapsed || count > 0 ? (
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
                  collapsed && "-rotate-90",
                )}
              />
            ) : null}
          </button>
          <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`New workspace on ${machine.label}`}
                    onClick={onNewWorkspace}
                  />
                }
              >
                <PlusIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>New workspace on {machine.label}</TooltipPopup>
            </Tooltip>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {offline ? (
            <ContextMenuItem onSelect={() => machineConnect(machine.id)}>
              <WifiIcon /> Connect
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => machineDisconnect(machine.id)}>
              <UnplugIcon /> Disconnect
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={onNewWorkspace}>
            <SquarePenIcon /> New workspace here
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * Static section label for the Attention shelf — always expanded
 * (info-architecture.md §6.2), so it is a label, not a disclosure.
 */
function AgentSectionLabel({
  label,
  count,
  attention = false,
}: {
  label: string;
  count: number;
  /** Attention is always expanded, so it has no chevron — reserve the
      column anyway so counts align, and tint the label warning (issue #165). */
  attention?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-8 w-full items-center gap-2 px-2 text-xs font-medium",
        attention ? "text-warning-foreground" : "text-sidebar-muted-foreground",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="min-w-0 flex-1" />
      <span className="font-normal tabular-nums">{count}</span>
      <span aria-hidden className="size-3 shrink-0" />
    </div>
  );
}

/**
 * One agent row in the Agents shelves. Two lines per herdr's agent token
 * rows (info-architecture.md §6.1): line 1 is where (status icon +
 * workspace/tab/machine at primary weight), line 2 is state + what.
 * Clicking jumps to the agent's workspace and focuses its pane
 * (`pane.focus` resolves across tabs and workspaces in herdr), mirroring
 * the TUI agent sidebar's click-to-focus.
 */
function AgentRow({
  entry,
  multiMachine,
  showPaneId,
  pane,
  onDetails,
}: {
  entry: AgentListEntry;
  multiMachine: boolean;
  /** Sibling rows render identically without it — append the pane token (issue #165). */
  showPaneId: boolean;
  pane: PaneInfo | undefined;
  onDetails: (entry: AgentListEntry, pane: PaneInfo) => void;
}) {
  const { machine, agent } = entry;
  const stateLabel = agentStateLabel(agent);
  const displayName = agentDisplayName(agent);
  const workTarget = agentWorkTarget(agent);
  const auxLabels = agentAuxStateLabels(agent);
  const showWorkTarget = workTarget !== null && workTarget !== displayName;
  const focusAgent = () => {
    selectWorkspace(machine.id, agent.workspace_id);
    void ensureMachine(machine.id).then(() =>
      callRpc(machine.id, "pane.focus", { pane_id: agent.pane_id }).catch(() => {}),
    );
  };
  const rowButton = (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row inside a composite list, same exception as workspace rows
    <button
      type="button"
      data-sidebar-row={agent.pane_id}
      onClick={focusAgent}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-left outline-none transition-colors",
        "hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        agent.focused && "bg-foreground/[0.06] font-medium text-sidebar-foreground",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {statusIcon(agent.agent_status)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
          {entry.workspaceTitle}
          {entry.tabLabel ? ` · ${entry.tabLabel}` : null}
          {multiMachine ? ` · ${machine.label}` : null}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 ps-6.5 text-2xs text-sidebar-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {stateLabel}
          {" · "}
          {displayName}
          {showWorkTarget ? ` · ${workTarget}` : null}
          {showPaneId ? ` · ${shortPaneId(agent.pane_id)}` : null}
        </span>
        {auxLabels.length > 0 ? (
          <span className="max-w-32 shrink-0 truncate">{auxLabels.join(" · ")}</span>
        ) : null}
      </span>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">
        {/* T3 ThreadHoverCard: hover/focus shows the facts the two-line row
            truncates (issue #154). The tooltip trigger renders the row
            button itself so there is no nested interactive element. */}
        <Tooltip>
          <TooltipTrigger render={rowButton} />
          <TooltipPopup
            side="right"
            align="start"
            sideOffset={4}
            variant="glass"
            className="text-left"
          >
            <AgentHoverCard entry={entry} multiMachine={multiMachine} pane={pane} />
          </TooltipPopup>
        </Tooltip>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={focusAgent}>
          <MousePointerClickIcon /> Focus
        </ContextMenuItem>
        {pane ? (
          <ContextMenuItem onSelect={() => onDetails(entry, pane)}>
            <InfoIcon /> Details…
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(agent.pane_id)}
        >
          <CopyIcon /> Copy pane ID
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void navigator.clipboard?.writeText(agent.workspace_id)}
        >
          <CopyIcon /> Copy workspace ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WorkspaceSidebarBody({ settingsOpen }: { settingsOpen: boolean }) {
  const bridge = useBridgeState();
  const { machine: routeMachine, view } = useRouteWorkspace();
  const [query, setQuery] = useState("");
  const [collapsedMachines, setCollapsedMachines] = useState<Record<string, boolean>>({});
  const [rename, setRename] = useState<RenameState | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ machine: string; workspace: WorkspaceInfo } | null>(null);
  const searching = query.trim().length > 0;
  const branchIndex = useWorkspaceBranchIndex();
  // Workspace drag-reorder (issue #111): HTML5 drag on each row, drop maps
  // to herdr `workspace.move {workspace_id, insert_index}` within the same
  // machine's ordered workspace list. Disabled while search-filtered.
  const [wsDrag, setWsDrag] = useState<{ machine: string; id: string } | null>(null);
  const [wsDrop, setWsDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);

  const machines = machineListOf(bridge);

  // Workspace rows per machine, from each machine's own snapshot. Machines
  // in a hard-down status show no rows — their held snapshot is stale and
  // must not be presented as current (issue #84).
  const workspacesByMachine = useMemo(() => {
    const map = new Map<string, WorkspaceInfo[]>();
    for (const m of machines) {
      map.set(
        m.id,
        machineStale(m) ? [] : (bridge.snapshots[m.id]?.workspaces ?? []),
      );
    }
    return map;
  }, [machines, bridge.snapshots]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: { machine: MachineInfo; workspace: WorkspaceInfo }[] = [];
    for (const m of machines) {
      for (const ws of workspacesByMachine.get(m.id) ?? []) {
        const branch = branchIndex.get(`${m.id}\n${ws.workspace_id}`);
        if (
          !q ||
          workspaceTitle(ws, branch).toLowerCase().includes(q) ||
          ws.workspace_id.toLowerCase().includes(q)
        ) {
          all.push({ machine: m, workspace: ws });
        }
      }
    }
    return all;
  }, [machines, workspacesByMachine, query, branchIndex]);

  // Per-machine ordered id lists for drop-index math (flat mode only —
  // grouped mode uses each folder's own `workspaces` array).
  const flatIdsByMachine = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const f of filtered) {
      const list = map.get(f.machine.id) ?? [];
      list.push(f.workspace.workspace_id);
      map.set(f.machine.id, list);
    }
    return map;
  }, [filtered]);

  const wsDragEnabled = !searching;
  const wsDragProps = (
    machineId: string,
    wsId: string,
    orderedIds: string[],
    index: number,
    key: string,
  ) => ({
    draggable: wsDragEnabled,
    onDragStart: (e: DragEvent) => {
      setWsDrag({ machine: machineId, id: wsId });
      e.dataTransfer.setData("text/plain", wsId);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent) => {
      if (!wsDrag || wsDrag.machine !== machineId || wsDrag.id === wsId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      setWsDrop({
        key,
        side: e.clientY < rect.top + rect.height / 2 ? "before" : "after",
      });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const drag = wsDrag;
      const side = wsDrop?.key === key ? wsDrop.side : "before";
      setWsDrag(null);
      setWsDrop(null);
      if (!drag || drag.machine !== machineId || drag.id === wsId) return;
      const from = orderedIds.indexOf(drag.id);
      if (from < 0) return;
      // herdr `insert_index` is a pre-removal insertion point (the item
      // lands before the element currently at that index; `length`
      // appends). Adjacent drops are no-ops. Verified on herdr 0.9.5.
      const insertIndex = moveInsertIndex(from, index, side);
      if (insertIndex === null) return;
      void callRpc(machineId, "workspace.move", {
        workspace_id: drag.id,
        insert_index: insertIndex,
      });
    },
    onDragEnd: () => {
      setWsDrag(null);
      setWsDrop(null);
    },
  });

  const grouped = !searching && machines.length > 1;
  const activeWorkspaceId = view.workspace?.workspace_id ?? null;
  const activeMachineId = view.workspace
    ? routeMachine
    : null;

  const newWorkspaceOn = (machineId: string) => {
    void newWorkspace(machineId);
  };

  // Settings → General "Confirm before closing workspace" (issue #85):
  // workspaces that still have panes ask first; empty ones close directly.
  const requestClose = (machine: MachineInfo, workspace: WorkspaceInfo) => {
    if (getGeneralSettings().confirmCloseWorkspace && workspace.pane_count > 0) {
      setConfirmClose({ machine: machine.id, workspace });
      return;
    }
    void callRpc(machine.id, "workspace.close", { workspace_id: workspace.workspace_id });
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setQuery("");
  };

  const totalWorkspaces = machines.reduce(
    (n, m) => n + (workspacesByMachine.get(m.id)?.length ?? 0),
    0,
  );

  // Agents shelves (issue #151, info-architecture.md §6): every agent
  // across live machines partitioned into Attention/Working/Done/Idle —
  // a T3 settle/inbox-style presentation over herdr AgentStatus, which
  // stays the only status source. Hidden while searching and on stale
  // machines whose snapshot is last-known state.
  const agentEntries = useMemo(
    () => collectAgentEntries(machines, bridge.snapshots, machineStale, branchIndex),
    [machines, bridge.snapshots, branchIndex],
  );
  const agentSections = useMemo(() => partitionAgents(agentEntries), [agentEntries]);

  // Rows that would render identically get a pane-id disambiguator
  // (issue #165): count agentRowSignature across all entries.
  const agentSignatureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of agentEntries) {
      const key = agentRowSignature(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [agentEntries]);

  // Shelf expansion persists per section like T3's shelf toggles:
  // Working defaults open (it is the live work list), Done/Idle default
  // collapsed (settled-shelf equivalents).
  const [agentShelves, setAgentShelves] = useState<
    Record<CollapsibleAgentSection, boolean>
  >(() => {
    const initial = {} as Record<CollapsibleAgentSection, boolean>;
    for (const section of COLLAPSIBLE_AGENT_SECTIONS) {
      initial[section] =
        getLocalStorageBoolean(`herdr-t3:sidebar:agents:${section}`) ??
        section === "working";
    }
    return initial;
  });
  const toggleAgentShelf = (section: CollapsibleAgentSection) => {
    setAgentShelves((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      setLocalStorageBoolean(`herdr-t3:sidebar:agents:${section}`, next[section]);
      return next;
    });
  };
  const [agentDetails, setAgentDetails] = useState<{
    machine: string;
    pane: PaneInfo;
  } | null>(null);

  // FLIP motion for agent rows (issue #151, Sidebar.motion.ts port):
  // rows animate on add/move/remove and section collapse, keyed on the
  // rendered membership+order so unrelated renders do not re-measure.
  const agentsMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attachAgentsList = useCallback((node: HTMLUListElement | null) => {
    agentsMotionRef.current?.dispose();
    agentsMotionRef.current = node ? createSidebarListMotion(node) : null;
    agentsMotionRef.current?.update(false);
  }, []);
  const agentsLayoutKey = useMemo(() => {
    if (agentEntries.length === 0) return "";
    return AGENT_SECTIONS.map(
      (section) =>
        `${section}:${section === "attention" ? "-" : agentShelves[section]}:` +
        agentSections[section]
          .map(
            (e) =>
              `${e.machine.id}:${e.agent.pane_id}:${e.agent.agent_status}:${e.agent.state_change_seq ?? e.agent.revision}`,
          )
          .join(","),
    ).join("|");
  }, [agentEntries.length, agentSections, agentShelves]);
  useLayoutEffect(() => {
    agentsMotionRef.current?.update(true);
  }, [agentsLayoutKey]);

  // FLIP motion for workspace rows (issue #154): same Sidebar.motion.ts
  // port as the agents list — rows animate on add/remove/reorder/collapse.
  // The key covers membership and order per machine plus folder collapse
  // and search filtering, so unrelated snapshot churn does not re-measure.
  const workspacesMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attachWorkspacesList = useCallback((node: HTMLUListElement | null) => {
    workspacesMotionRef.current?.dispose();
    workspacesMotionRef.current = node ? createSidebarListMotion(node) : null;
    workspacesMotionRef.current?.update(false);
  }, []);
  const workspacesLayoutKey = useMemo(() => {
    if (searching) {
      return filtered.map((f) => `${f.machine.id}:${f.workspace.workspace_id}`).join("|");
    }
    return machines
      .map((m) => {
        const ids = (workspacesByMachine.get(m.id) ?? []).map((w) => w.workspace_id);
        return `${m.id}${collapsedMachines[m.id] ? ":c" : ""}:${ids.join(",")}`;
      })
      .join("|");
  }, [searching, filtered, machines, workspacesByMachine, collapsedMachines]);
  useLayoutEffect(() => {
    workspacesMotionRef.current?.update(true);
  }, [workspacesLayoutKey]);

  return (
    <SidebarContent
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex items-center gap-1">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70">
              <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              <SidebarInput
                nativeInput
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search"
                aria-label="Search workspaces"
                className="min-w-0 flex-1"
              />
              {searching ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear workspace search"
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center">
              <SidebarHeaderIconButton
                label="New workspace"
                onClick={() => {
                  const target =
                    machines.find((m) => m.status === "online") ??
                    machines.find((m) => m.id === LOCAL_MACHINE) ??
                    machines[0];
                  if (target) newWorkspaceOn(target.id);
                }}
              >
                <SquarePenIcon />
              </SidebarHeaderIconButton>
            </div>
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup className="flex-1" role="presentation">
        {bridge.connection !== "open" ? (
          <p className="px-2 py-2 text-center text-2xs text-sidebar-muted-foreground">
            {bridge.connection === "connecting" ? "Connecting to herdr…" : "Bridge disconnected — retrying…"}
          </p>
        ) : null}
        {searching && filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
            No workspaces found
          </p>
        ) : null}
        {!searching && totalWorkspaces === 0 && bridge.connection === "open" ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
            <span>No workspaces yet</span>
            {/* oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 empty-state CTA; custom row chrome */}
            <button
              type="button"
              onClick={() => {
                const target = machines[0];
                if (target) newWorkspaceOn(target.id);
              }}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <PlusIcon className="-mx-0.5 size-3" />
              New workspace
            </button>
          </div>
        ) : null}
        <ul ref={attachWorkspacesList} className="relative flex flex-col gap-px" role="list">
          {grouped
            ? machines.map((machine) => {
                const workspaces = workspacesByMachine.get(machine.id) ?? [];
                const collapsed = collapsedMachines[machine.id] ?? false;
                return (
                  <Fragment key={machine.id}>
                    <MachineFolderHeader
                      machine={machine}
                      count={workspaces.length}
                      collapsed={collapsed}
                      onToggle={() =>
                        setCollapsedMachines((prev) => ({
                          ...prev,
                          [machine.id]: !collapsed,
                        }))
                      }
                      onNewWorkspace={() => newWorkspaceOn(machine.id)}
                    />
                    {!collapsed
                      ? workspaces.map((ws, wsIndex) => {
                          const orderedIds = workspaces.map((w) => w.workspace_id);
                          const key = `${machine.id}:${ws.workspace_id}`;
                          const dropSide = wsDrop?.key === key ? wsDrop.side : null;
                          return (
                            <li
                              key={ws.workspace_id}
                              className={cn(
                                "relative list-none",
                                wsDrag?.machine === machine.id &&
                                  wsDrag.id === ws.workspace_id &&
                                  "opacity-60",
                              )}
                              {...wsDragProps(
                                machine.id,
                                ws.workspace_id,
                                orderedIds,
                                wsIndex,
                                key,
                              )}
                            >
                              {dropSide ? (
                                <span
                                  className={cn(
                                    "absolute left-0 top-0 h-0.5 w-full bg-primary",
                                    dropSide === "after" && "top-auto bottom-0",
                                  )}
                                />
                              ) : null}
                              <WorkspaceRow
                              machine={machine}
                              workspace={ws}
                              isActive={
                                ws.workspace_id === activeWorkspaceId &&
                                machine.id === activeMachineId
                              }
                              inFolder
                              onNewWorkspace={() => newWorkspaceOn(machine.id)}
                              onRename={(target, machineId) =>
                                setRename({ target, machine: machineId })
                              }
                              onClose={() => requestClose(machine, ws)}
                              />
                            </li>
                          );
                        })
                      : null}
                  </Fragment>
                );
              })
            : filtered.map(({ machine, workspace }) => {
                const key = `${machine.id}:${workspace.workspace_id}`;
                const orderedIds = flatIdsByMachine.get(machine.id) ?? [];
                const wsIndex = orderedIds.indexOf(workspace.workspace_id);
                const dropSide = wsDrop?.key === key ? wsDrop.side : null;
                return (
                  <li
                    key={key}
                    className={cn(
                      "relative list-none",
                      wsDrag?.machine === machine.id &&
                        wsDrag.id === workspace.workspace_id &&
                        "opacity-60",
                    )}
                    {...wsDragProps(
                      machine.id,
                      workspace.workspace_id,
                      orderedIds,
                      wsIndex,
                      key,
                    )}
                  >
                    {dropSide ? (
                      <span
                        className={cn(
                          "absolute left-0 top-0 h-0.5 w-full bg-primary",
                          dropSide === "after" && "top-auto bottom-0",
                        )}
                      />
                    ) : null}
                    <WorkspaceRow
                      machine={machine}
                      workspace={workspace}
                      isActive={
                        workspace.workspace_id === activeWorkspaceId &&
                        machine.id === activeMachineId
                      }
                      onNewWorkspace={() => newWorkspaceOn(machine.id)}
                      onRename={(target, machineId) =>
                        setRename({ target, machine: machineId })
                      }
                      onClose={() => requestClose(machine, workspace)}
                    />
                  </li>
                );
              })}
        </ul>
      </SidebarGroup>
      {!searching && agentEntries.length > 0 ? (
        <div className="mt-1 border-t border-sidebar-border/60 pt-1">
        <SidebarGroup>
          <ul ref={attachAgentsList} className="relative flex flex-col gap-px" role="list">
            {AGENT_SECTIONS.map((section) => {
              const list = agentSections[section];
              if (list.length === 0) return null;
              const expanded =
                section === "attention" || agentShelves[section];
              return (
                <Fragment key={section}>
                  <li className="list-none">
                    {section === "attention" ? (
                      <AgentSectionLabel
                        label={AGENT_SECTION_LABELS[section]}
                        count={list.length}
                        attention
                      />
                    ) : (
                      <CollapsibleSectionHeader
                        expanded={agentShelves[section]}
                        onClick={() => toggleAgentShelf(section)}
                        accessory={
                          <span className="font-normal tabular-nums">{list.length}</span>
                        }
                      >
                        {AGENT_SECTION_LABELS[section]}
                      </CollapsibleSectionHeader>
                    )}
                  </li>
                  {expanded
                    ? list.map((entry) => {
                        const pane = bridge.snapshots[entry.machine.id]?.panes.find(
                          (p) => p.pane_id === entry.agent.pane_id,
                        );
                        return (
                          <li
                            key={`${entry.machine.id}:${entry.agent.pane_id}`}
                            className="list-none"
                          >
                            <AgentRow
                              entry={entry}
                              multiMachine={machines.length > 1}
                              showPaneId={
                                (agentSignatureCounts.get(agentRowSignature(entry)) ?? 0) > 1
                              }
                              pane={pane}
                              onDetails={(e, p) =>
                                setAgentDetails({ machine: e.machine.id, pane: p })
                              }
                            />
                          </li>
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
          </ul>
        </SidebarGroup>
        </div>
      ) : null}
      <RenameDialog
        target={rename?.target ?? null}
        machine={rename?.machine ?? LOCAL_MACHINE}
        onClose={() => setRename(null)}
      />
      <PaneDetailsDialog
        pane={agentDetails?.pane ?? null}
        machine={agentDetails?.machine ?? LOCAL_MACHINE}
        onClose={() => setAgentDetails(null)}
      />
      <Dialog open={confirmClose !== null} onOpenChange={(open) => !open && setConfirmClose(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close workspace</DialogTitle>
            <DialogDescription>
              “{confirmClose ? workspaceTitle(confirmClose.workspace) : ""}” still has{" "}
              {confirmClose?.workspace.pane_count ?? 0} pane
              {(confirmClose?.workspace.pane_count ?? 0) === 1 ? "" : "s"}. Closing it ends those
              sessions on the machine.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmClose(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                const pending = confirmClose;
                setConfirmClose(null);
                if (pending) {
                  void callRpc(pending.machine, "workspace.close", {
                    workspace_id: pending.workspace.workspace_id,
                  });
                }
              }}
            >
              Close workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarContent>
  );
}
