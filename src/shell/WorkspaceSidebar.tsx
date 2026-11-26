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
  CheckCheckIcon,
  ChevronDownIcon,
  CopyIcon,
  InfoIcon,
  MonitorIcon,
  MoonIcon,
  MousePointerClickIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
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
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { statusIcon } from "~/components/statusIcons";
import { isAgentKindName } from "~/components/agentKind";
import { AgentProviderIcon } from "~/components/agentIcons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { ShowMoreButton } from "~/components/ui/show-more-button";
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
  UNCAPPED_AGENT_SECTIONS,
  agentAuxStateLabels,
  agentDisplayName,
  agentOrganizeKey,
  agentRowSignature,
  agentShelfEntryKey,
  agentShelfInitialLimit,
  agentShelfPage,
  agentStateLabel,
  agentWorkTarget,
  collectAgentEntries,
  partitionAgents,
  shelfRows,
  shortPaneId,
  type AgentListEntry,
  type AgentSection,
} from "./agents";
import {
  inboxOrganize,
  useInboxOrganize,
  useInboxStates,
  type InboxUnavailableReason,
} from "./inbox";
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
      data-sidebar-workspace={workspace.workspace_id}
      onClick={() => selectWorkspace(machine.id, workspace.workspace_id)}
      className={cn(
        // Two-line hierarchy per info-architecture.md §7 (herdr spaces token
        // rows): identity on line 1, branch/meta on line 2 — never squeezed
        // into one truncating row (issue #153).
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-(--control-radius) py-1.5 text-left outline-none transition-colors",
        inFolder
          ? "ps-7 pe-(--sidebar-row-content-inset)"
          : "px-(--sidebar-row-content-inset)",
        // T3 keeps the hover fill off the active row so the selected
        // surface does not flicker under the pointer (SidebarThreadRow).
        !isActive && "hover:bg-sidebar-row-hover",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isActive &&
          // T3's active thread row treatment (SidebarThreadRow): the
          // sidebar-row-active token stays clearly distinct from
          // row-hover in both themes — the old foreground/6% fill sat
          // between the dark hover (8%) and selected (7%) tints and read
          // as the same fill (issue #417). The light ring keeps the
          // white active surface from floating on zinc-50 (issue #128).
          "bg-sidebar-row-active font-medium text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
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
            className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

type AgentOrganizeAction = "settle" | "snooze" | "restore";

/** Why organize actions are unavailable on a machine (ADR-0011 §10). */
const INBOX_UNAVAILABLE_LABELS: Record<InboxUnavailableReason, string> = {
  not_installed: "inbox plugin not installed",
  disabled: "inbox plugin disabled",
  incompatible: "inbox contract incompatible",
  unreachable: "inbox host unreachable",
  error: "inbox unavailable",
};

/** Snooze presets offered by the plugin contract (`--until` specs). */
const SNOOZE_PRESETS = [
  { label: "1 hour", spec: "+1h" },
  { label: "1 day", spec: "+1d" },
  { label: "1 week", spec: "+7d" },
] as const;

function formatSnoozeUntil(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * One agent row in the Agents shelves. Two lines per T3
 * `SidebarThreadRow`'s hierarchy (issue #200,
 * info-architecture.md §6.1): line 1 is context at secondary weight
 * (status icon, workspace/tab/machine) — the resolved state name is
 * icon/section/hover-card/aria only, never printed text (issue #381) —
 * line 2 leads with the work target — the live pane's terminal title —
 * with agent identity, pane disambiguator and auxiliary labels as meta.
 * Clicking jumps to the agent's workspace and focuses its pane
 * (`pane.focus` resolves across tabs and workspaces in herdr), mirroring
 * the TUI agent sidebar's click-to-focus.
 */
function AgentRow({
  entry,
  multiMachine,
  showPaneId,
  pane,
  shelf,
  inboxReady,
  inboxReason,
  snoozedUntil,
  onDetails,
  onOrganize,
}: {
  entry: AgentListEntry;
  multiMachine: boolean;
  /** Sibling rows render identically without it — append the pane token (issue #165). */
  showPaneId: boolean;
  pane: PaneInfo | undefined;
  /** User-organize shelf the row currently sits in, if any (#173/#219). */
  shelf: "settled" | "snoozed" | undefined;
  /** Whether the host's inbox plugin can accept organize mutations. */
  inboxReady: boolean;
  inboxReason?: InboxUnavailableReason | undefined;
  /** Plugin-reported snooze deadline (snoozed rows only). */
  snoozedUntil?: string | undefined;
  onDetails: (entry: AgentListEntry, pane: PaneInfo) => void;
  onOrganize: (entry: AgentListEntry, action: AgentOrganizeAction, snoozeSpec?: string) => void;
}) {
  const { machine, agent } = entry;
  const stateLabel = agentStateLabel(agent);
  const displayName = agentDisplayName(agent);
  const workTarget = agentWorkTarget(agent, pane);
  const auxLabels = agentAuxStateLabels(agent);
  // Line 2 leads with the work target; the agent name joins the meta
  // only when it adds information beyond the title.
  const rowTitle = workTarget ?? displayName;
  // When the display name is just the agent kind (any spelling of it),
  // the trailing icon already carries that identity — repeating the
  // label as meta is noise, so drop it and give the title back the
  // width (issue #204 review, generalized in #335: independent of which
  // icon family renders, including the generic glyph and unknown kinds).
  const nameIsAgentKind = isAgentKindName(displayName, agent.agent);
  const metaParts = [
    workTarget !== null && workTarget !== displayName && !nameIsAgentKind
      ? displayName
      : null,
    showPaneId ? shortPaneId(agent.pane_id) : null,
    shelf === "snoozed" && snoozedUntil
      ? (() => {
          const until = formatSnoozeUntil(snoozedUntil);
          return until ? `until ${until}` : null;
        })()
      : null,
  ].filter((part): part is string => part !== null);
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
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) py-1.5 text-left outline-none transition-colors",
        !agent.focused && "hover:bg-sidebar-row-hover",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        agent.focused &&
          "bg-sidebar-row-active font-medium text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-sidebar-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {statusIcon(agent.agent_status)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {entry.workspaceTitle}
          {entry.tabLabel ? ` · ${entry.tabLabel}` : null}
          {multiMachine ? ` · ${machine.label}` : null}
        </span>
        {/* The state name lives in the hover card and in the accessible
            name only (issue #381): the icon's color/animation and the
            section shelf already carry it, so printing "working" beside
            the Working shelf triple-reports the same fact (T3
            SidebarThreadRow shows the status slot only when it adds
            information the row does not already have). */}
        <span className="sr-only">{stateLabel}</span>
      </span>
      {/* ps-6 aligns line 2 with line 1's text: size-4 icon (16px) +
          gap-2 (8px) = 24px. ps-6.5 left a 2px rail mismatch (issue
          #204 review). */}
      <span className="flex w-full min-w-0 items-center gap-2 ps-6">
        {/* Title and meta are separate flex items (issue #204 review):
            concatenating them inside one truncating node sliced mid-
            separator ("update onboarding docs ...") and dropped the
            agent name entirely on long titles. The title truncates;
            the meta keeps its own bounded width. */}
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
          {rowTitle}
        </span>
        {metaParts.length > 0 ? (
          <span className="max-w-40 shrink-0 truncate text-2xs text-sidebar-muted-foreground">
            {metaParts.join(" · ")}
          </span>
        ) : null}
        {auxLabels.length > 0 ? (
          <span className="max-w-32 shrink-0 truncate text-2xs text-sidebar-muted-foreground">
            {auxLabels.join(" · ")}
          </span>
        ) : null}
        <AgentProviderIcon agent={agent.agent} className="size-3" />
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
            sideOffset={16}
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
        {/* User-side shelf organization (#173, plugin-backed per ADR-0011):
            herdr state is untouched; the host's rebuildup.inbox plugin owns
            organize state. Shelved rows can be restored or moved to the
            other shelf; natural-section rows offer Settle/Snooze. T3 keeps
            snoozed threads reachable for manual unsnooze — the Snoozed
            shelf mirrors that. When the host has no usable inbox plugin the
            actions are disabled with the reason, never silently local. */}
        <ContextMenuSeparator />
        {!inboxReady ? (
          <ContextMenuItem disabled>
            {INBOX_UNAVAILABLE_LABELS[inboxReason ?? "error"]}
          </ContextMenuItem>
        ) : (
          <>
            {shelf === "settled" || shelf === "snoozed" ? (
              <ContextMenuItem onSelect={() => onOrganize(entry, "restore")}>
                <RotateCcwIcon /> Restore
              </ContextMenuItem>
            ) : null}
            {shelf !== "snoozed" ? (
              <ContextMenuItem onSelect={() => onOrganize(entry, "settle")}>
                <CheckCheckIcon /> Settle
              </ContextMenuItem>
            ) : null}
            {shelf !== "settled" ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <MoonIcon /> Snooze
                </ContextMenuSubTrigger>
                <ContextMenuSubPopup>
                  {SNOOZE_PRESETS.map((preset) => (
                    <ContextMenuItem
                      key={preset.spec}
                      onSelect={() => onOrganize(entry, "snooze", preset.spec)}
                    >
                      {preset.label}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubPopup>
              </ContextMenuSub>
            ) : null}
          </>
        )}
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

  // User-side settle/snooze overlay (#173 → ADR-0011): the host's
  // rebuildup.inbox plugin owns organize state; this store only projects
  // it into the AgentOrganizeMap partitionAgents consumes. Plugin-sourced
  // records carry seq=MAX so the plugin's own generation/expiry
  // resolution is authoritative — the client never re-derives it.
  const inboxOrganizeMap = useInboxOrganize();
  const inboxStates = useInboxStates();
  // Machines without a usable snapshot cannot resolve organize records —
  // partitionAgents carries their records through instead of pruning them
  // on absent data (app start before the first snapshot would otherwise
  // wipe every settle/snooze). `null` while the machine list itself has
  // not loaded: nothing can be resolved yet.
  const unresolvedAgentMachines = useMemo(() => {
    const set = new Set<string>();
    for (const m of machines) {
      if (machineStale(m) || bridge.snapshots[m.id] === undefined) set.add(m.id);
    }
    return set;
  }, [machines, bridge.snapshots]);
  const agentPartition = useMemo(
    () =>
      partitionAgents(
        agentEntries,
        inboxOrganizeMap,
        machines.length === 0 ? null : unresolvedAgentMachines,
      ),
    [agentEntries, inboxOrganizeMap, machines.length, unresolvedAgentMachines],
  );
  const agentSections = agentPartition.sections;
  // Every section is a collapsible shelf (issue #211): the whole Agents
  // region docks at the sidebar bottom — inline at the end of the scroll
  // list below md, in the pinned dock at md and up.
  const hasAgentEntries = AGENT_SECTIONS.some(
    (section) => agentSections[section].length > 0,
  );
  const renderAgentRow = (
    entry: AgentListEntry,
    shelf?: "settled" | "snoozed",
    className?: string,
  ) => {
    const inboxState = inboxStates.get(entry.machine.id);
    const organizeRecord =
      shelf !== undefined
        ? inboxOrganizeMap[agentOrganizeKey(entry.machine.id, entry.agent.pane_id)]
        : undefined;
    return (
      <li key={`${entry.machine.id}:${entry.agent.pane_id}`} className={cn("list-none", className)}>
        <AgentRow
          entry={entry}
          multiMachine={machines.length > 1}
          showPaneId={(agentSignatureCounts.get(agentRowSignature(entry)) ?? 0) > 1}
          pane={entry.pane}
          shelf={shelf}
          inboxReady={inboxState?.status.kind === "ready"}
          inboxReason={
            inboxState?.status.kind === "unavailable" ? inboxState.status.reason : undefined
          }
          snoozedUntil={organizeRecord?.until}
          onDetails={(e, p) => setAgentDetails({ machine: e.machine.id, pane: p })}
          onOrganize={organizeAgent}
        />
      </li>
    );
  };

  // Organize mutations go to the host's inbox plugin (ADR-0011); the
  // projection refreshes from the plugin's own `list` — the client never
  // writes organize state itself.
  const organizeAgent = (
    entry: AgentListEntry,
    action: AgentOrganizeAction,
    snoozeSpec?: string,
  ) => {
    void inboxOrganize(entry.machine.id, entry.agent.pane_id, action, snoozeSpec);
  };

  // Rows that would render identically get a pane-id disambiguator
  // (issue #165): count agentRowSignature across section membership —
  // disclosure paging must not change a row's content as it reveals
  // (issue #389), so hidden rows still count toward ambiguity.
  const visibleAgentEntries = useMemo(
    () => AGENT_SECTIONS.flatMap((section) => agentSections[section]),
    [agentSections],
  );
  const agentSignatureCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of visibleAgentEntries) {
      const key = agentRowSignature(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [visibleAgentEntries]);

  // Shelf expansion persists per section like T3's shelf toggles
  // (issue #211): Attention defaults expanded so blocked agents are never
  // hidden; the other five default collapsed, matching T3's
  // useLocalStorage(..., false) defaults (Sidebar.tsx).
  const [agentShelves, setAgentShelves] = useState<
    Record<AgentSection, boolean>
  >(() => {
    const initial = {} as Record<AgentSection, boolean>;
    for (const section of COLLAPSIBLE_AGENT_SECTIONS) {
      initial[section] =
        getLocalStorageBoolean(`herdr-t3:sidebar:agents:${section}`) ??
        section === "attention";
    }
    return initial;
  });
  const toggleAgentShelf = (section: AgentSection) => {
    setAgentShelves((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      setLocalStorageBoolean(`herdr-t3:sidebar:agents:${section}`, next[section]);
      return next;
    });
  };
  // Progressive disclosure inside expanded shelves (issue #389): capped
  // sections start at their initial window (agentShelfInitialLimit —
  // Working opens at 4 per issue #418) and each "Show N more" adds a
  // page (agentShelfPage). Session-scoped like T3's settledTail —
  // not persisted; collapsing the shelf resets nothing because the count
  // only matters while expanded.
  const [agentShelfLimits, setAgentShelfLimits] = useState<
    Record<AgentSection, number>
  >(() => {
    const initial = {} as Record<AgentSection, number>;
    for (const section of AGENT_SECTIONS) {
      initial[section] = agentShelfInitialLimit(section);
    }
    return initial;
  });
  const showMoreShelfRows = (section: AgentSection) => {
    setAgentShelfLimits((prev) => ({
      ...prev,
      [section]: prev[section] + agentShelfPage(section),
    }));
  };
  // The route-selected agent (T3 `routeThreadOnly`): the agent whose pane
  // is focused in the routed workspace's active tab. Collapsed shelves
  // keep this one row reachable; capped shelves never hide it behind the
  // disclosure either.
  const routeAgentKey = useMemo(() => {
    const paneId = view.focusedPane?.pane_id;
    if (!view.workspace || paneId === undefined) return null;
    const entry = agentEntries.find(
      (e) => e.machine.id === routeMachine && e.agent.pane_id === paneId,
    );
    return entry ? agentShelfEntryKey(entry) : null;
  }, [agentEntries, routeMachine, view.workspace, view.focusedPane]);
  const [agentDetails, setAgentDetails] = useState<{
    machine: string;
    pane: PaneInfo;
  } | null>(null);

  // FLIP motion for agent rows (issue #151, Sidebar.motion.ts port):
  // rows animate on add/move/remove and section collapse, keyed on the
  // rendered membership+order so unrelated renders do not re-measure.
  // Two list shapes exist — the <md inline shelves share one <ul> inside
  // the sidebar scroll, while the md+ dock gives every expanded shelf its
  // own scroll container so headers never scroll away (issue #418). Each
  // dock <ul> gets its own motion instance since only one layout is
  // visible at a time.
  const agentsMotionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const agentsDockMotionRefs = useRef(
    new Map<AgentSection, ReturnType<typeof createSidebarListMotion>>(),
  );
  const attachAgentsList = useCallback((node: HTMLUListElement | null) => {
    agentsMotionRef.current?.dispose();
    agentsMotionRef.current = node ? createSidebarListMotion(node) : null;
    agentsMotionRef.current?.update(false);
  }, []);
  // Stable per-section ref callbacks (created once) so React does not
  // detach/reattach — and recreate motion — on every render.
  const agentsDockAttaches = useMemo(() => {
    const attaches = {} as Record<
      AgentSection,
      (node: HTMLUListElement | null) => void
    >;
    for (const section of AGENT_SECTIONS) {
      attaches[section] = (node) => {
        const motions = agentsDockMotionRefs.current;
        motions.get(section)?.dispose();
        if (node) motions.set(section, createSidebarListMotion(node));
        else motions.delete(section);
        motions.get(section)?.update(false);
      };
    }
    return attaches;
  }, []);
  const agentsLayoutKey = useMemo(() => {
    if (agentEntries.length === 0) return "";
    return AGENT_SECTIONS.map(
      (section) =>
        `${section}:${agentShelves[section] ? 1 : 0}:${agentShelfLimits[section]}:` +
        agentSections[section]
          .map(
            (e) =>
              `${e.machine.id}:${e.agent.pane_id}:${e.agent.agent_status}:${e.agent.state_change_seq ?? e.agent.revision}`,
          )
          .join(","),
    ).join("|");
  }, [agentEntries.length, agentSections, agentShelves, agentShelfLimits]);
  useLayoutEffect(() => {
    agentsMotionRef.current?.update(true);
    for (const motion of agentsDockMotionRefs.current.values()) {
      motion.update(true);
    }
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

  // Disclosure header shared by the inline and dock shelf renderers.
  // Attention keeps its warning tint through the header tone — the role
  // the old always-visible AgentSectionLabel played.
  const agentShelfHeader = (
    section: AgentSection,
    count: number,
    expanded: boolean,
  ) => (
    <CollapsibleSectionHeader
      chevron="leading"
      expanded={expanded}
      onClick={() => toggleAgentShelf(section)}
      tone={section === "attention" ? "warning" : "muted"}
      accessory={<span className="font-normal tabular-nums">{count}</span>}
    >
      {AGENT_SECTION_LABELS[section]}
    </CollapsibleSectionHeader>
  );

  // One shelf block shared by the <md inline list — disclosure header +
  // expanded rows inside the sidebar's single scroll region.
  const renderAgentShelf = (section: AgentSection) => {
    const list = agentSections[section];
    if (list.length === 0) return null;
    const expanded = agentShelves[section];
    const shelfKind =
      section === "settled" || section === "snoozed" ? section : undefined;
    // Progressive disclosure (issue #389): collapsed shelves keep only
    // the route-selected row; expanded capped shelves show their initial
    // window (+ pages) with the route row pinned. Attention is uncapped —
    // blocked agents are never hidden.
    const capped = !UNCAPPED_AGENT_SECTIONS.includes(section);
    const { visible, hidden } = shelfRows(
      list,
      expanded,
      capped ? agentShelfLimits[section] : null,
      routeAgentKey,
    );
    return (
      <Fragment key={section}>
        <li className="list-none">
          {agentShelfHeader(section, list.length, expanded)}
        </li>
        {visible.map((entry) => renderAgentRow(entry, shelfKind))}
        {expanded && hidden > 0 ? (
          <li className="list-none">
            <ShowMoreButton
              remaining={Math.min(hidden, agentShelfPage(section))}
              onToggle={() => showMoreShelfRows(section)}
              className="h-9"
            />
          </li>
        ) : null}
      </Fragment>
    );
  };

  // Dock variant (md+, issue #418): the toggle/count header sits outside
  // the row list's scroll container, so scrolling Working rows never
  // carries the Working toggle away. Each expanded shelf's <ul> scrolls
  // independently inside the dock's shared max-height — headers of every
  // shelf stay reachable while the lists divide the available space.
  const renderAgentShelfDock = (section: AgentSection) => {
    const list = agentSections[section];
    if (list.length === 0) return null;
    const expanded = agentShelves[section];
    const shelfKind =
      section === "settled" || section === "snoozed" ? section : undefined;
    const capped = !UNCAPPED_AGENT_SECTIONS.includes(section);
    const { visible, hidden } = shelfRows(
      list,
      expanded,
      capped ? agentShelfLimits[section] : null,
      routeAgentKey,
    );
    return (
      <div key={section} className="flex min-h-0 flex-col">
        <div className="shrink-0">
          {agentShelfHeader(section, list.length, expanded)}
        </div>
        {visible.length > 0 ? (
          <ul
            ref={agentsDockAttaches[section]}
            className="flex min-h-0 flex-col gap-px overflow-y-auto"
            role="list"
          >
            {visible.map((entry) => renderAgentRow(entry, shelfKind))}
            {expanded && hidden > 0 ? (
              <li className="list-none">
                <ShowMoreButton
                  remaining={Math.min(hidden, agentShelfPage(section))}
                  onToggle={() => showMoreShelfRows(section)}
                  className="h-9"
                />
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    );
  };

  return (
    <>
    <SidebarContent
      fixedHeader={
        // The hairline separates the sticky search row from scrolled
        // content — without it a mid-scroll cut leaves rows looking
        // orphaned directly under the search field (issue #204 review).
        <>
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
        <div aria-hidden className="h-px w-full bg-sidebar-border/60" />
        </>
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
      {!searching && hasAgentEntries ? (
        // Below md the pinned dock would starve the list on short sheets
        // (issue #204 review): every shelf renders inline at the end of
        // this scroll list instead, so the whole agents region scrolls
        // as one (issue #211).
        <div className="mt-1 border-t border-sidebar-border/60 pt-1 md:hidden">
        <SidebarGroup>
          <ul ref={attachAgentsList} className="relative flex flex-col gap-px" role="list">
            {AGENT_SECTIONS.map(renderAgentShelf)}
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
      {/* Pinned shelf dock (issues #204/#211/#418): every Agents section
          is a collapsible shelf whose header stays visible above the
          footer regardless of how long the workspace list grows. Each
          expanded shelf's rows scroll inside their own container so the
          toggles never scroll away; the lists share the dock's
          max-height. */}
      {!searching && hasAgentEntries ? (
        <div className="hidden max-h-[45%] shrink-0 flex-col border-t border-sidebar-border px-(--sidebar-content-inset) pb-(--sidebar-content-inset) pt-1 md:flex">
          {AGENT_SECTIONS.map(renderAgentShelfDock)}
        </div>
      ) : null}
    </>
  );
}
