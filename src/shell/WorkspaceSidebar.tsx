/*
 * Sidebar body — port of T3 Code's Sidebar list structure (issue #83):
 * fixed header with search + primary action, machine-grouped workspace
 * rows (T3 project folders → herdr machines; T3 thread rows → workspaces),
 * empty states, context menus.
 * Local changes: fixture store, no DnD/drafts/snooze/pins/search-as-you-type
 * server search; filtering is local.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronDownIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
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
import type { FixtureMachine, FixtureWorkspace } from "./fixtures";
import { fixtureMachine } from "./fixtures";
import { navigate, workspaceHash, useRoute } from "./router";
import { activeTabOf, shellActions, useShellState } from "./store";

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
  workspace,
  machine,
  isActive,
  inFolder = false,
  onNewWorkspace,
}: {
  workspace: FixtureWorkspace;
  machine: FixtureMachine | undefined;
  isActive: boolean;
  inFolder?: boolean;
  onNewWorkspace: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(workspace.title);
  const tabCount = workspace.tabs.length;
  const paneCount = workspace.tabs.reduce((n, t) => n + t.panes.length, 0);
  const machineLabel = inFolder ? undefined : machine?.label;

  const commitRename = () => {
    setRenaming(false);
    shellActions.renameWorkspace(workspace.id, draft);
  };

  const rowButton = (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row inside a composite control, same exception as T3's thread rows
    <button
      type="button"
      data-sidebar-row={workspace.id}
      onClick={() => navigate(workspaceHash(workspace.id))}
      onDoubleClick={() => {
        setDraft(workspace.title);
        setRenaming(true);
      }}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] py-0 text-left outline-none transition-colors",
        inFolder
          ? "ps-7 pe-[var(--sidebar-row-content-inset)]"
          : "px-[var(--sidebar-row-content-inset)]",
        "hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        isActive &&
          "bg-sidebar-row-active font-medium text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70",
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {statusIcon(workspace.agentStatus)}
      </span>
      {renaming ? (
        // oxlint-disable-next-line herdr-t3/no-raw-control -- inline rename field inside the row, mirrors T3 ThreadRenameInput
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded-sm border border-sidebar-border bg-sidebar px-1 text-sm font-medium text-sidebar-foreground outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
          {workspace.title}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-2">
        {machineLabel ? (
          <span className="hidden max-w-20 truncate text-2xs text-sidebar-muted-foreground lg:inline">
            {machineLabel}
          </span>
        ) : null}
        <span className="text-2xs tabular-nums text-sidebar-muted-foreground">
          {tabCount}t · {paneCount}p
        </span>
      </span>
    </button>
  );

  const siblings = workspace.machineId;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">{rowButton}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => navigate(workspaceHash(workspace.id))}>
          Focus
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            setDraft(workspace.title);
            setRenaming(true);
          }}
        >
          Rename…
        </ContextMenuItem>
        <ContextMenuItem onSelect={onNewWorkspace}>New workspace here</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => shellActions.moveWorkspace(workspace.id, siblings, -1)}
        >
          Move up
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => shellActions.moveWorkspace(workspace.id, siblings, 1)}
        >
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => shellActions.closeWorkspace(workspace.id)}>
          Close
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
  machine: FixtureMachine;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onNewWorkspace: () => void;
}) {
  return (
    <li className="group/project-folder relative mt-2 list-none first:mt-0">
      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- folder header row is a composite disclosure control, same pattern as T3 SidebarProjectFolderHeader */}
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <MonitorIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {machine.label}
        </span>
        {collapsed ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {count}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
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
          <TooltipPopup>
            New workspace on {machine.label}
          </TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
}

export function WorkspaceSidebarBody({ settingsOpen }: { settingsOpen: boolean }) {
  const shell = useShellState();
  const route = useRoute();
  const [query, setQuery] = useState("");
  const [collapsedMachines, setCollapsedMachines] = useState<Record<string, boolean>>({});
  const searching = query.trim().length > 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shell.workspaces;
    return shell.workspaces.filter((w) => w.title.toLowerCase().includes(q));
  }, [shell.workspaces, query]);

  const byMachine = useMemo(() => {
    const map = new Map<string, FixtureWorkspace[]>();
    for (const machine of shell.machines) map.set(machine.id, []);
    for (const ws of filtered) {
      const list = map.get(ws.machineId);
      if (list) list.push(ws);
      else map.set(ws.machineId, [ws]);
    }
    return map;
  }, [shell.machines, filtered]);

  const visibleMachines = shell.machines.filter(
    (m) => (byMachine.get(m.id)?.length ?? 0) > 0,
  );
  const grouped = !searching && shell.machines.length > 1;
  const activeWorkspaceId =
    route.name === "workspace" ? (route.workspaceId ?? shell.workspaces[0]?.id) : null;

  const newWorkspaceOn = (machineId: string) => {
    const id = shellActions.newWorkspace(machineId);
    navigate(workspaceHash(id));
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") setQuery("");
  };

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
                    shell.machines.find((m) => m.status === "online") ?? shell.machines[0];
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
        {searching && filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
            No workspaces found
          </p>
        ) : null}
        {!searching && shell.workspaces.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
            <span>No workspaces yet</span>
            {/* oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 empty-state CTA; custom row chrome */}
            <button
              type="button"
              onClick={() => {
                const target = shell.machines[0];
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
            ? visibleMachines.map((machine) => {
                const workspaces = byMachine.get(machine.id) ?? [];
                const collapsed = collapsedMachines[machine.id] ?? false;
                return (
                  <li key={machine.id} className="contents">
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
                      ? workspaces.map((ws) => (
                          <li key={ws.id} className="list-none">
                            <WorkspaceRow
                              workspace={ws}
                              machine={fixtureMachine(ws.machineId)}
                              isActive={ws.id === activeWorkspaceId}
                              inFolder
                              onNewWorkspace={() => newWorkspaceOn(machine.id)}
                            />
                          </li>
                        ))
                      : null}
                  </li>
                );
              })
            : filtered.map((ws) => (
                <li key={ws.id} className="list-none">
                  <WorkspaceRow
                    workspace={ws}
                    machine={fixtureMachine(ws.machineId)}
                    isActive={ws.id === activeWorkspaceId}
                    onNewWorkspace={() => {
                      const target = shell.machines.find((m) => m.id === ws.machineId);
                      if (target) newWorkspaceOn(target.id);
                    }}
                  />
                </li>
              ))}
        </ul>
      </SidebarGroup>
    </SidebarContent>
  );
}
