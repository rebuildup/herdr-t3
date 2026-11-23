/*
 * Workspace content header — T3 Code's ChatView header structure
 * (issue #83) driven by real bridge data (issue #84): 52px drag-region
 * row with breadcrumb (machine › workspace), tab strip, focused-pane
 * actions in an overflow menu. Every action is a whitelisted herdr RPC;
 * the pushed snapshot is what updates the UI.
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
import { AgentStatusBadge, PaneStatusDetail } from "~/components/AgentStatusBadge";
import { paneTitle, workspaceTitle } from "~/lib/workspace";
import type { PaneInfo, RpcMethod, TabInfo } from "../../shared/protocol";
import { useRouteWorkspace } from "./view";
import { callRpc } from "./bridge";
import { useWorkspaceBranch } from "./worktrees";
import { PaneMessageDialog } from "~/components/PaneMessageDialog";
import { RenameDialog, type RenameTarget } from "~/components/RenameDialog";

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
            className="[-webkit-app-region:no-drag]"
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
  const { machine, machineInfo, view } = useRouteWorkspace();
  const { workspace, tabs, activeTab, tabPanes, layout, focusedPane } = view;
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  // Tab drag-reorder (issue #111): HTML5 drag with an insertion indicator;
  // the drop maps to herdr `tab.move {tab_id, insert_index}`.
  const [tabDragId, setTabDragId] = useState<string | null>(null);
  const [tabDrop, setTabDrop] = useState<{ index: number; side: "before" | "after" } | null>(null);
  const branch = useWorkspaceBranch(machine, workspace?.workspace_id ?? "");
  const zoomed = layout?.zoomed === true;
  const rpc = (method: RpcMethod, params: Record<string, unknown> = {}) =>
    callRpc(machine, method, params);

  const headerClass = cn(
    "relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3",
    isElectron
      ? "drag-region bg-background px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
      : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
    COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  );

  if (!workspace || !activeTab) {
    return <header className={headerClass} />;
  }

  const focusedTitle = focusedPane ? paneTitle(focusedPane) : "pane";
  const wsTitle = workspaceTitle(workspace, branch);
  const wsDisplay = branch && wsTitle !== branch ? `${wsTitle} · ${branch}` : wsTitle;
  const paneCount = tabPanes.length;
  const commitTabRename = (tab: TabInfo) => {
    setRenamingTab(null);
    const label = tabDraft.trim();
    if (label) void rpc("tab.rename", { tab_id: tab.tab_id, label });
  };
  /** Focus the pane after `pane` in herdr's layout reading order. */
  const focusNextPane = () => {
    if (!focusedPane || paneCount < 2) return;
    const ordered = [...tabPanes].sort((a, b) => {
      const ra = layout?.panes.find((p) => p.pane_id === a.pane_id)?.rect;
      const rb = layout?.panes.find((p) => p.pane_id === b.pane_id)?.rect;
      if (!ra || !rb) return 0;
      return ra.y - rb.y || ra.x - rb.x;
    });
    const index = ordered.findIndex((p) => p.pane_id === focusedPane.pane_id);
    const next = ordered[(index + 1) % ordered.length];
    if (next) void rpc("pane.focus", { pane_id: next.pane_id });
  };

  return (
    <>
      <header className={headerClass}>
        <WorkspaceBreadcrumb ariaLabel="Workspace path">
          <WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbText>
              {machineInfo?.label ?? machine}
            </WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current>
            <WorkspaceBreadcrumbText>
              <MiddleTruncate value={wsDisplay} />
            </WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>

        {/* Tab strip — herdr tabs inside the selected workspace. The strip
            scrolls internally; the surrounding header space stays draggable.
            The new-tab action sits outside the scroller so it never slides
            out of view on narrow widths. */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
            {tabs.map((t, tabIndex) => {
              const selected = t.tab_id === activeTab.tab_id;
              const label = t.label || `Tab ${t.number}`;
              const dropHere = tabDrop?.index === tabIndex ? tabDrop.side : null;
              return (
                <div
                  key={t.tab_id}
                  draggable={renamingTab !== t.tab_id}
                  onDragStart={(e) => {
                    setTabDragId(t.tab_id);
                    e.dataTransfer.setData("text/plain", t.tab_id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (!tabDragId || tabDragId === t.tab_id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTabDrop({
                      index: tabIndex,
                      side: e.clientX < rect.left + rect.width / 2 ? "before" : "after",
                    });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const dragId = tabDragId ?? e.dataTransfer.getData("text/plain");
                    const side = dropHere ?? "before";
                    setTabDragId(null);
                    setTabDrop(null);
                    if (!dragId || dragId === t.tab_id) return;
                    const from = tabs.findIndex((x) => x.tab_id === dragId);
                    if (from < 0) return;
                    const to = tabIndex + (side === "after" ? 1 : 0);
                    const insertIndex = to > from ? to - 1 : to;
                    if (insertIndex === from) return;
                    void rpc("tab.move", { tab_id: dragId, insert_index: insertIndex });
                  }}
                  onDragEnd={() => {
                    setTabDragId(null);
                    setTabDrop(null);
                  }}
                  className={cn(
                    "group relative flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm",
                    tabDragId === t.tab_id && "opacity-50",
                    // Reserve the hover-revealed close button's width so the
                    // label hit area can never overlap it (issue #94).
                    selected
                      ? "shrink-0 bg-accent pe-8 font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {renamingTab === t.tab_id ? (
                    // oxlint-disable-next-line herdr-t3/no-raw-control -- inline rename field inside the tab row, mirrors T3 thread rename
                    <input
                      autoFocus
                      value={tabDraft}
                      onChange={(e) => setTabDraft(e.target.value)}
                      onBlur={() => commitTabRename(t)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitTabRename(t);
                        if (e.key === "Escape") setRenamingTab(null);
                      }}
                      className="w-24 rounded-sm border border-border bg-background px-1 text-sm outline-none"
                    />
                  ) : (
                    // oxlint-disable-next-line herdr-t3/no-raw-control -- tab label is part of a composite tab row, not a standalone control
                    <button
                      type="button"
                      onClick={() => void rpc("tab.focus", { tab_id: t.tab_id })}
                      onDoubleClick={() => {
                        setTabDraft(label);
                        setRenamingTab(t.tab_id);
                      }}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      {statusIcon(t.agent_status)}
                      <span className="min-w-0 max-w-40 truncate">{label}</span>
                    </button>
                  )}
                  {selected ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Close tab"
                      // oxlint-disable-next-line shadcn/no-restyle -- hover-reveal affordance; no Button variant covers group-hover opacity
                      className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100"
                      onClick={() => void rpc("tab.close", { tab_id: t.tab_id })}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  ) : null}
                  {dropHere ? (
                    <span
                      className={cn(
                        "absolute top-0 h-full w-0.5 rounded-full bg-primary",
                        dropHere === "before" ? "-left-0.5" : "-right-0.5",
                      )}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
          <HeaderIconButton
            label="New tab"
            onClick={() =>
              void rpc("tab.create", {
                workspace_id: workspace.workspace_id,
                focus: true,
              })
            }
          >
            <PlusIcon className="size-4" />
          </HeaderIconButton>
        </div>

        {/* Focused pane summary + actions. Shrinks (label truncates) before
            the tab strip does, so narrow widths keep tabs readable. */}
        <div className="flex min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="flex min-w-0 items-center gap-2 text-xs text-secondary-label max-sm:hidden" />
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {focusedPane ? statusIcon(focusedPane.agent_status) : null}
                <span className="truncate">
                  {focusedTitle}
                  {focusedPane?.agent ? ` · ${focusedPane.agent}` : ""}
                </span>
              </span>
              {focusedPane ? <AgentStatusBadge status={focusedPane.agent_status} /> : null}
            </TooltipTrigger>
            {focusedPane ? (
              <TooltipPopup side="bottom" className="max-w-64">
                <PaneStatusDetail pane={focusedPane} />
              </TooltipPopup>
            ) : null}
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Pane actions" />}
            >
              <EllipsisIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width="content">
              <DropdownMenuItem
                onClick={() =>
                  focusedPane &&
                  void rpc("pane.split", {
                    direction: "right",
                    target_pane_id: focusedPane.pane_id,
                    focus: true,
                  })
                }
                disabled={!focusedPane}
              >
                <Columns2 /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  focusedPane &&
                  void rpc("pane.split", {
                    direction: "down",
                    target_pane_id: focusedPane.pane_id,
                    focus: true,
                  })
                }
                disabled={!focusedPane}
              >
                <Rows2 /> Split down
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  focusedPane &&
                  void rpc("pane.swap", {
                    pane_id: focusedPane.pane_id,
                    direction: "right",
                  })
                }
                disabled={!focusedPane || paneCount < 2}
              >
                <SquareSplitHorizontalIcon /> Swap pane
              </DropdownMenuItem>
              <DropdownMenuItem onClick={focusNextPane} disabled={paneCount < 2}>
                <Columns2 /> Focus next pane
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  focusedPane && void rpc("pane.close", { pane_id: focusedPane.pane_id })
                }
                disabled={!focusedPane}
              >
                <XIcon /> Close pane
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  focusedPane && void rpc("pane.zoom", { pane_id: focusedPane.pane_id })
                }
                disabled={!focusedPane}
              >
                {zoomed ? <Minimize2 /> : <Maximize2 />}
                {zoomed ? "Unzoom" : "Zoom"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setTabDraft(activeTab.label || `Tab ${activeTab.number}`);
                  setRenamingTab(activeTab.tab_id);
                }}
              >
                <PencilIcon /> Rename tab
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  focusedPane &&
                  setRename({
                    kind: "pane",
                    id: focusedPane.pane_id,
                    label: focusedTitle,
                  })
                }
                disabled={!focusedPane}
              >
                <PencilIcon /> Rename pane
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => focusedPane && setMessagePane(focusedPane)}
                disabled={!focusedPane}
              >
                <MessageSquareTextIcon />
                {focusedPane?.agent ? "Prompt agent…" : "Send text to pane…"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void rpc("tab.close", { tab_id: activeTab.tab_id })}>
                <XIcon /> Close tab
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <RenameDialog
        target={rename}
        machine={machine}
        onClose={() => setRename(null)}
      />
      <PaneMessageDialog
        pane={messagePane}
        machine={machine}
        onClose={() => setMessagePane(null)}
      />
    </>
  );
}
