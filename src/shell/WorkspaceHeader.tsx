/*
 * Workspace content header — port of T3 Code's ChatView header structure
 * (issue #83): 52px drag-region row with breadcrumb (machine › workspace),
 * tab strip, focused-pane actions in an overflow menu.
 * Local changes: herdr tabs/panes instead of thread actions; pane
 * operations live in a dropdown menu, not a raw button row.
 */
import {
  Columns2,
  EllipsisIcon,
  Maximize2,
  MessageSquareTextIcon,
  Minimize2,
  PencilIcon,
  PlusIcon,
  Rows2,
  SquareSplitHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { isElectron } from "~/lib/env";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "~/components/WorkspaceBreadcrumb";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { statusIcon } from "~/components/statusIcons";
import { AgentStatusBadge } from "~/components/AgentStatusBadge";
import { fixtureMachine, fixtureWorkspace } from "./fixtures";
import { useRoute } from "./router";
import { activeTabOf, focusedPaneOf, shellActions, useShellState } from "./store";

function HeaderIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function WorkspaceHeader() {
  const route = useRoute();
  const shell = useShellState();
  const workspace = fixtureWorkspace(
    route.name === "workspace" ? route.workspaceId : null,
  );
  const machine = workspace ? fixtureMachine(workspace.machineId) : undefined;
  const tab = workspace ? activeTabOf(workspace, shell) : undefined;
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  const zoomed = tab !== undefined && shell.zoomedTab === tab.id;

  if (!workspace || !tab) {
    return (
      <header
        className={cn(
          "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3",
          isElectron
            ? "drag-region px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
            : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      />
    );
  }

  const focusedPane = focusedPaneOf(tab, shell);
  const paneTitle = focusedPane?.title ?? "pane";
  const paneCount = tab.panes.length;

  return (
    <header
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3",
        isElectron
          ? "drag-region bg-background px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
          : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <WorkspaceBreadcrumb ariaLabel="Workspace path">
        <WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbText>{machine?.label ?? "local"}</WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <WorkspaceBreadcrumbText>
            <MiddleTruncate value={workspace.title} />
          </WorkspaceBreadcrumbText>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>

      {/* Tab strip — herdr tabs inside the selected workspace. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag]">
        {workspace.tabs.map((t) => {
          const selected = t.id === tab.id;
          return (
            <div
              key={t.id}
              className={cn(
                "group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                selected
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {renamingTab === t.id ? (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- inline rename field inside the tab row, mirrors T3 thread rename
                <input
                  autoFocus
                  value={tabDraft}
                  onChange={(e) => setTabDraft(e.target.value)}
                  onBlur={() => {
                    setRenamingTab(null);
                    shellActions.renameTab(t.id, tabDraft);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setRenamingTab(null);
                      shellActions.renameTab(t.id, tabDraft);
                    }
                    if (e.key === "Escape") setRenamingTab(null);
                  }}
                  className="w-24 rounded-sm border border-border bg-background px-1 text-sm outline-none"
                />
              ) : (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- tab label is part of a composite tab row, not a standalone control
                <button
                  type="button"
                  onClick={() => shellActions.selectTab(workspace.id, t.id)}
                  onDoubleClick={() => {
                    setTabDraft(t.label);
                    setRenamingTab(t.id);
                  }}
                  className="flex items-center gap-1.5"
                >
                  {statusIcon(t.agentStatus)}
                  <span className="max-w-40 truncate">{t.label || `Tab ${t.number}`}</span>
                </button>
              )}
              {selected ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close tab"
                  // oxlint-disable-next-line shadcn/no-restyle -- hover-reveal affordance; no Button variant covers group-hover opacity
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => shellActions.closeTab(t.id)}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </div>
          );
        })}
        <HeaderIconButton
          label="New tab"
          onClick={() => shellActions.newTab(workspace.id)}
        >
          <PlusIcon className="size-4" />
        </HeaderIconButton>
      </div>

      {/* Focused pane summary + actions. */}
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <div className="mr-1 flex min-w-0 items-center gap-2 text-xs text-secondary-label">
          <span className="flex min-w-0 items-center gap-1.5">
            {focusedPane ? statusIcon(focusedPane.agentStatus) : null}
            <span className="truncate">
              {paneTitle}
              {focusedPane?.agent ? ` · ${focusedPane.agent}` : ""}
            </span>
          </span>
          {focusedPane ? <AgentStatusBadge status={focusedPane.agentStatus} /> : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button size="icon-sm" variant="ghost" aria-label="Pane actions" />}
          >
            <EllipsisIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width="content">
            <DropdownMenuItem onClick={() => shellActions.splitPane(tab.id, "right")}>
              <Columns2 /> Split right
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => shellActions.splitPane(tab.id, "down")}>
              <Rows2 /> Split down
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => shellActions.swapFocusedPane(tab.id)}
              disabled={paneCount < 2}
            >
              <SquareSplitHorizontalIcon /> Swap pane
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => shellActions.focusNextPane(tab.id)}
              disabled={paneCount < 2}
            >
              <Columns2 /> Focus next pane
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => focusedPane && shellActions.closePane(focusedPane.id)}
              disabled={!focusedPane}
            >
              <XIcon /> Close pane
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => shellActions.toggleZoom(tab.id)}>
              {zoomed ? <Minimize2 /> : <Maximize2 />}
              {zoomed ? "Unzoom" : "Zoom"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setTabDraft(tab.label);
                setRenamingTab(tab.id);
              }}
            >
              <PencilIcon /> Rename tab
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled
              title="Available once the bridge is connected (M2)"
            >
              <MessageSquareTextIcon /> Send text to pane…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => shellActions.closeTab(tab.id)}>
              <XIcon /> Close tab
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
