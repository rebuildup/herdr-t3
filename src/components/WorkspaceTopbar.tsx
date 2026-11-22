import {
  Columns2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Pencil,
  Plus,
  Rows2,
  SquareSplitHorizontal,
  X,
} from "lucide-react";
import type { PaneInfo, TabInfo } from "../../shared/protocol";
import { cn } from "../lib/utils";
import type { Bridge } from "../hooks/useBridge";
import type { WorkspaceView } from "../lib/workspace";
import { isElectron } from "../lib/env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { SidebarTrigger } from "./ui/sidebar";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/menu";
import { statusIcon } from "./statusIcons";
import { AgentStatusBadge } from "./AgentStatusBadge";

interface WorkspaceTopbarProps {
  bridge: Bridge;
  view: WorkspaceView;
  onRenameTab: (tab: TabInfo) => void;
  onMessagePane: (pane: PaneInfo) => void;
  onRenamePane: (pane: PaneInfo) => void;
}

export function WorkspaceTopbar({
  bridge,
  view,
  onRenameTab,
  onMessagePane,
  onRenamePane,
}: WorkspaceTopbarProps) {
  const { call } = bridge;
  const { activeWorkspace, workspaceTabs, activeTab, layout, focusedPane } = view;

  const paneTitle = (pane: PaneInfo) =>
    pane.terminal_title_stripped ?? pane.title ?? pane.label ?? pane.pane_id;

  return (
    <WorkspacePageHeader electron={isElectron} reserveNativeControls={isElectron}>
      <SidebarTrigger />
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {workspaceTabs.map((tab, index) => {
          const selected = tab.tab_id === activeTab?.tab_id;
          return (
            <ContextMenu key={tab.tab_id}>
              <ContextMenuTrigger>
                <div
                  className={cn(
                    "group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                    selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {/* oxlint-disable-next-line herdr-t3/no-raw-control -- tab label is part of a composite tab row, not a standalone control */}
                  <button
                    type="button"
                    onClick={() => void call("tab.focus", { tab_id: tab.tab_id })}
                    className="flex items-center gap-1.5"
                  >
                    {statusIcon(tab.agent_status)}
                    <span className="max-w-40 truncate">
                      {tab.label || `Tab ${tab.number}`}
                    </span>
                  </button>
                  {selected && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Close tab"
                      // oxlint-disable-next-line shadcn/no-restyle -- hover-reveal affordance; no Button variant covers group-hover opacity
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => void call("tab.close", { tab_id: tab.tab_id })}
                    >
                      <X className="size-3" />
                    </Button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void call("tab.focus", { tab_id: tab.tab_id })}>
                  Focus
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onRenameTab(tab)}>
                  Rename…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={index === 0}
                  onSelect={() =>
                    void call("tab.move", { tab_id: tab.tab_id, insert_index: index - 1 })
                  }
                >
                  Move left
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={index === workspaceTabs.length - 1}
                  onSelect={() =>
                    void call("tab.move", { tab_id: tab.tab_id, insert_index: index + 1 })
                  }
                >
                  Move right
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void call("tab.close", { tab_id: tab.tab_id })}>
                  Close
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {activeWorkspace && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="New tab"
            onClick={() =>
              void call("tab.create", {
                workspace_id: activeWorkspace.workspace_id,
                focus: true,
              })
            }
          >
            <Plus className="size-4" />
          </Button>
        )}
      </div>

      {focusedPane && (
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <div className="mr-1 h-4 w-px shrink-0 bg-border" />
          <span className="flex min-w-0 items-center gap-2 text-xs text-secondary-label">
            <span className="truncate">
              {paneTitle(focusedPane)}
              {focusedPane.agent ? ` · ${focusedPane.agent}` : ""}
            </span>
            <AgentStatusBadge status={focusedPane.agent_status} />
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            title={focusedPane.agent ? "Prompt agent" : "Send text"}
            onClick={() => onMessagePane(focusedPane)}
          >
            <MessageSquareText className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Split right"
            onClick={() =>
              void call("pane.split", {
                direction: "right",
                target_pane_id: focusedPane.pane_id,
                focus: true,
              })
            }
          >
            <Columns2 className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Split down"
            onClick={() =>
              void call("pane.split", {
                direction: "down",
                target_pane_id: focusedPane.pane_id,
                focus: true,
              })
            }
          >
            <Rows2 className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Swap pane"
            onClick={() =>
              void call("pane.swap", { pane_id: focusedPane.pane_id, direction: "right" })
            }
          >
            <SquareSplitHorizontal className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={layout?.zoomed ? "Unzoom" : "Zoom"}
            onClick={() => void call("pane.zoom", { pane_id: focusedPane.pane_id })}
          >
            {layout?.zoomed ? (
              <Minimize2 className="size-3.5" />
            ) : (
              <Maximize2 className="size-3.5" />
            )}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Rename pane"
            onClick={() => onRenamePane(focusedPane)}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Close pane"
            onClick={() => void call("pane.close", { pane_id: focusedPane.pane_id })}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}
    </WorkspacePageHeader>
  );
}
