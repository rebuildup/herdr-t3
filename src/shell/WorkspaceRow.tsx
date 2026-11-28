/*
 * Sidebar workspace row — extracted from WorkspaceSidebar (issue #550)
 * so the real component is Storybook-reviewable. Leads with the unified
 * AgentIdentityIcon sm glyph for the workspace's aggregate agent_status.
 */
import {
  CopyIcon,
  MousePointerClickIcon,
  PencilIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { workspaceTitle } from "~/lib/workspace";
import { requestFocusHandoff } from "~/lib/focusHandoff";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
import type { RenameTarget } from "~/components/RenameDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { selectWorkspace } from "./bridge";
import { useWorkspaceBranch } from "./worktrees";
import type { MachineInfo, WorkspaceInfo } from "../../shared/protocol";

export function WorkspaceRow({
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
      onClick={() => {
        // Issue #435: workspace selection hands focus to the displayed
        // workspace's focused pane once snapshot + surface agree.
        requestFocusHandoff({
          machine: machine.id,
          workspaceId: workspace.workspace_id,
        });
        selectWorkspace(machine.id, workspace.workspace_id);
      }}
      className={cn(
        // Two-line hierarchy per info-architecture.md §7 (herdr spaces token
        // rows): identity on line 1, branch/meta on line 2 — never squeezed
        // into one truncating row (issue #153). `items-center` keeps the
        // identity glyph vertically centered against the whole two-line
        // block, matching AgentRow (issue #550 review).
        "flex w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) py-1.5 text-left outline-none transition-colors",
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
      {/* Workspace-level agent_status uses the same unified glyph as
          agent rows (generic mark — a workspace has no provider). */}
      <AgentIdentityIcon agent={null} status={workspace.agent_status} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90 leading-tight">
          {title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 text-2xs leading-tight text-sidebar-muted-foreground">
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
      </span>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger className="w-full">{rowButton}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            requestFocusHandoff({
              machine: machine.id,
              workspaceId: workspace.workspace_id,
            });
            selectWorkspace(machine.id, workspace.workspace_id);
          }}
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
