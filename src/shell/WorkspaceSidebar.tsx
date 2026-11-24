/*
 * Sidebar body — T3 Code's Sidebar list structure (issue #83) driven by
 * real bridge data (issue #84): search field + primary action, workspace
 * rows grouped under machine folders when more than one machine is
 * configured, flat list otherwise (app-shell.md §2). Mutations go through
 * whitelisted herdr RPC; snapshots pushed by the bridge update the UI.
 */
import { Fragment, useMemo, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronDownIcon,
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { getGeneralSettings } from "~/lib/settings";
import { machineConnect, machineDisconnect } from "~/lib/api";
import type { AgentInfo, MachineInfo, WorkspaceInfo } from "../../shared/protocol";
import { workspaceTitle } from "~/lib/workspace";
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
        "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] py-0 text-left outline-none transition-colors",
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
      <span className="flex size-4 shrink-0 items-center justify-center">
        {statusIcon(workspace.agent_status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
        {title}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {branch && title !== branch ? (
          <span className="hidden max-w-28 truncate text-2xs text-sidebar-muted-foreground lg:inline">
            {branch}
          </span>
        ) : null}
        {machineLabel ? (
          <span className="hidden max-w-20 truncate text-2xs text-sidebar-muted-foreground lg:inline">
            {machineLabel}
          </span>
        ) : null}
        <span className="text-2xs tabular-nums text-sidebar-muted-foreground">
          {workspace.tab_count}t · {workspace.pane_count}p
        </span>
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
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
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

/** herdr agent_sidebar parity (issue #113): status-priority ordering. */
const AGENT_STATUS_RANK: Record<string, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
};

function agentRank(status: string): number {
  return AGENT_STATUS_RANK[status] ?? 4;
}

function agentLabel(agent: AgentInfo): string {
  return agent.name ?? agent.display_agent ?? agent.agent ?? "agent";
}

interface AgentListEntry {
  machine: MachineInfo;
  agent: AgentInfo;
  workspace: WorkspaceInfo | undefined;
  workspaceTitle: string;
}

/**
 * One agent row in the Agents section. Clicking jumps to the agent's
 * workspace and focuses its pane (`pane.focus` resolves across tabs and
 * workspaces in herdr), mirroring the TUI agent sidebar's click-to-focus.
 */
function AgentRow({ entry, multiMachine }: { entry: AgentListEntry; multiMachine: boolean }) {
  const { machine, agent } = entry;
  const label = agentLabel(agent);
  const stateLabel = Object.values(agent.state_labels ?? {}).find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row inside a composite list, same exception as workspace rows
    <button
      type="button"
      data-sidebar-row={agent.pane_id}
      onClick={() => {
        selectWorkspace(machine.id, agent.workspace_id);
        void ensureMachine(machine.id).then(() =>
          callRpc(machine.id, "pane.focus", { pane_id: agent.pane_id }).catch(() => {}),
        );
      }}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-0 text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {statusIcon(agent.agent_status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
        {label}
        {stateLabel ? (
          <span className="text-sidebar-muted-foreground"> · {stateLabel}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="hidden max-w-28 truncate text-2xs text-sidebar-muted-foreground lg:inline">
          {entry.workspaceTitle}
        </span>
        {multiMachine ? (
          <span className="hidden max-w-20 truncate text-2xs text-sidebar-muted-foreground lg:inline">
            {machine.label}
          </span>
        ) : null}
      </span>
    </button>
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
      const to = index + (side === "after" ? 1 : 0);
      // herdr `insert_index` is a pre-removal insertion point (the item
      // lands before the element currently at that index; `length`
      // appends). Adjacent drops are no-ops. Verified on herdr 0.9.5.
      if (to === from || to === from + 1) return;
      void callRpc(machineId, "workspace.move", {
        workspace_id: drag.id,
        insert_index: to,
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

  // Agents section (issue #113, herdr agent_sidebar parity): every agent
  // across live machines, ordered by attention — blocked first, matching
  // herdr's status-priority sort. Hidden while searching and on stale
  // machines whose snapshot is last-known state.
  const agents = useMemo<AgentListEntry[]>(() => {
    const list: AgentListEntry[] = [];
    for (const m of machines) {
      if (machineStale(m)) continue;
      const snap = bridge.snapshots[m.id];
      if (!snap) continue;
      const wsById = new Map(snap.workspaces.map((w) => [w.workspace_id, w]));
      for (const a of snap.agents) {
        const ws = wsById.get(a.workspace_id);
        const branch = ws ? branchIndex.get(`${m.id}\n${ws.workspace_id}`) : undefined;
        list.push({
          machine: m,
          agent: a,
          workspace: ws,
          workspaceTitle: ws ? workspaceTitle(ws, branch) : a.workspace_id,
        });
      }
    }
    return list.sort(
      (x, y) => agentRank(x.agent.agent_status) - agentRank(y.agent.agent_status),
    );
  }, [machines, bridge.snapshots, branchIndex]);

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
        <ul className="relative flex flex-col gap-px" role="list">
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
      {!searching && agents.length > 0 ? (
        <SidebarGroup>
          <div className="px-2 pb-1 text-2xs font-medium text-sidebar-muted-foreground">
            Agents
          </div>
          <ul className="relative flex flex-col gap-px" role="list">
            {agents.map((entry) => (
              <li
                key={`${entry.machine.id}:${entry.agent.pane_id}`}
                className="list-none"
              >
                <AgentRow entry={entry} multiMachine={machines.length > 1} />
              </li>
            ))}
          </ul>
        </SidebarGroup>
      ) : null}
      <RenameDialog
        target={rename?.target ?? null}
        machine={rename?.machine ?? LOCAL_MACHINE}
        onClose={() => setRename(null)}
      />
      <Dialog open={confirmClose !== null} onOpenChange={(open) => !open && setConfirmClose(null)}>
        <DialogContent>
          <DialogTitle>Close workspace</DialogTitle>
          <DialogDescription>
            “{confirmClose ? workspaceTitle(confirmClose.workspace) : ""}” still has{" "}
            {confirmClose?.workspace.pane_count ?? 0} pane
            {(confirmClose?.workspace.pane_count ?? 0) === 1 ? "" : "s"}. Closing it ends those
            sessions on the machine.
          </DialogDescription>
          <div className="flex justify-end gap-2">
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
          </div>
        </DialogContent>
      </Dialog>
    </SidebarContent>
  );
}
