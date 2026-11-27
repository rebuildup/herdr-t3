/*
 * Workspace content header — T3 Code's ChatView header structure
 * (issue #83) driven by real bridge data (issue #84): 52px drag-region
 * row with breadcrumb (machine › workspace), tab strip, focused-pane
 * actions in an overflow menu. Every action is a whitelisted herdr RPC;
 * the pushed snapshot is what updates the UI.
 */
import {
  ArrowLeftRightIcon,
  BotIcon,
  CalendarClockIcon,
  Columns2,
  EllipsisIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  GaugeIcon,
  GitBranchIcon,
  HistoryIcon,
  InfoIcon,
  KeyRoundIcon,
  Maximize2,
  MessagesSquareIcon,
  MessageSquareTextIcon,
  Minimize2,
  PackageIcon,
  PencilIcon,
  PlugIcon,
  Rows2,
  ServerIcon,
  SquarePlayIcon,
  SquareSplitHorizontalIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { focusPaneTerminal } from "~/lib/focusHandoff";
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
import { AgentStatusBadge, isKnownAgentStatus, PaneStatusDetail } from "~/components/AgentStatusBadge";
import { paneTitle, workspaceTitle } from "~/lib/workspace";
import { nextPaneInReadingOrder } from "~/lib/paneOrder";
import type { PaneInfo, RpcMethod, TabInfo } from "../../shared/protocol";
import { HeaderIconButton } from "./HeaderIconButton";
import { TabStrip } from "./TabStrip";
import { useRouteWorkspace } from "./view";
import { callRpc } from "./bridge";
import { useWorkspaceBranch } from "./worktrees";
import { PaneMessageDialog } from "~/components/PaneMessageDialog";
import { PaneDetailsDialog } from "~/components/PaneDetailsDialog";
import { ContextCardTrigger } from "./PaneContextCard";
import { openSurface, RIGHT_PANEL_NARROW_QUERY, useRightPanelState, type RightPanelSurface } from "./rightPanelStore";
import { RenameDialog, type RenameTarget } from "~/components/RenameDialog";

export function WorkspaceHeader() {
  const { machine, machineInfo, view } = useRouteWorkspace();
  const { workspace, tabs, activeTab, tabPanes, layout, focusedPane } = view;
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);
  const [detailsPane, setDetailsPane] = useState<PaneInfo | null>(null);
  // Tab rename state stays here (not inside TabStrip) because the pane
  // actions overflow menu can start a rename on the active tab too.
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  const branch = useWorkspaceBranch(machine, workspace?.workspace_id ?? "");
  const zoomed = layout?.zoomed === true;
  const rpc = (method: RpcMethod, params: Record<string, unknown> = {}) =>
    callRpc(machine, method, params);
  // Issue #333: plugin surfaces open as docked right-panel tabs scoped to
  // this workspace — Source Control targets the focused pane's repo.
  const panelScope = `${machine}\n${workspace?.workspace_id ?? ""}`;
  const openPanelSurface = (surface: RightPanelSurface) =>
    openSurface(panelScope, surface);
  // T3 ChatView `inlineRightPanelOwnsTitleBar` / `reserveNativeControls`:
  // while the inline (wide) right panel is open on Electron its tab bar
  // owns the desktop titlebar — drag region, `wco:` inset and the fixed
  // controls strip all live there — so this header must NOT also reserve
  // the native-controls inset (the caption strip sits over the panel's
  // top-right corner, not over this column's right edge).
  const rightPanelState = useRightPanelState(panelScope);
  const narrowPanel = useMediaQuery(RIGHT_PANEL_NARROW_QUERY);
  const inlinePanelOwnsTitleBar = rightPanelState.isOpen && !narrowPanel;

  const headerClass = cn(
    "relative flex h-(--workspace-topbar-height) min-h-(--workspace-topbar-height) shrink-0 items-center gap-3",
    isElectron
      ? cn(
          "drag-region bg-background px-3 sm:px-5",
          !inlinePanelOwnsTitleBar && "wco:pr-(--workspace-native-controls-inset)",
        )
      : "pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
    COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
  );

  if (!workspace || !activeTab) {
    return <header className={headerClass} />;
  }

  const focusedTitle = focusedPane ? paneTitle(focusedPane) : "pane";
  // Pane actions return focus to the terminal afterwards (issue #128):
  // the deferred focus wins over the menu's own restoration to the trigger.
  const paneAct = (fn: () => void) => () => {
    fn();
    setTimeout(() => focusPaneTerminal(), 0);
  };
  const wsTitle = workspaceTitle(workspace, branch);
  const wsDisplay = branch && wsTitle !== branch ? `${wsTitle} · ${branch}` : wsTitle;
  const paneCount = tabPanes.length;
  const commitTabRename = (tab: TabInfo) => {
    setRenamingTab(null);
    const label = tabDraft.trim();
    if (label) void rpc("tab.rename", { tab_id: tab.tab_id, label });
  };
  const startTabRename = (tab: TabInfo) => {
    setTabDraft(tab.label || `Tab ${tab.number}`);
    setRenamingTab(tab.tab_id);
  };
  /** Focus the pane after `pane` in herdr's layout reading order. */
  const focusNextPane = () => {
    if (!focusedPane) return;
    const next = nextPaneInReadingOrder(tabPanes, layout, focusedPane.pane_id);
    if (next) void rpc("pane.focus", { pane_id: next });
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

        {/* Tab strip — extracted to ./TabStrip (issue #550) so the real
            component is Storybook-reviewable. Rename state stays
            controlled here: the overflow menu below can start a rename
            on the active tab too. */}
        <TabStrip
          tabs={tabs}
          activeTabId={activeTab.tab_id}
          machine={machine}
          workspaceId={workspace.workspace_id}
          rpc={rpc}
          renamingTabId={renamingTab}
          renameDraft={tabDraft}
          onRenameDraftChange={setTabDraft}
          onRenameStart={startTabRename}
          onRenameCommit={commitTabRename}
          onRenameCancel={() => setRenamingTab(null)}
        />

        {/* Focused pane summary + actions. Shrinks (label truncates) before
            the tab strip does, so narrow widths keep tabs readable. The
            summary is capped so its "title · agent" text gives up width
            (agent metadata truncates first — it is the tail of the single
            truncating node) before the workspace breadcrumb does
            (issue #417). Below `md` it hides entirely: at ~480–700px
            windows it could only render "r…"/"devin.exe: re…", and the
            workspace/session breadcrumb is the higher-value label there
            (issue #417 Windows leg). */}
        <div className="flex min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
          <Tooltip>
            <TooltipTrigger
              render={
                <div className="flex min-w-0 max-w-48 items-center gap-2 text-xs text-secondary-label max-md:hidden" />
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {/* The pane title keeps priority inside the cap; the agent
                    name is capped and truncates first so a long agent
                    label cannot starve the title (issue #417 Windows
                    leg). */}
                <span className="min-w-0 truncate">{focusedTitle}</span>
                {focusedPane?.agent ? (
                  <span className="min-w-0 max-w-28 shrink truncate">
                    · {focusedPane.agent}
                  </span>
                ) : null}
              </span>
              {focusedPane && isKnownAgentStatus(focusedPane.agent_status) ? (
                <AgentStatusBadge status={focusedPane.agent_status} />
              ) : null}
            </TooltipTrigger>
            {focusedPane ? (
              <TooltipPopup side="bottom" className="max-w-64">
                <PaneStatusDetail pane={focusedPane} />
              </TooltipPopup>
            ) : null}
          </Tooltip>
          {zoomed ? (
            <Button
              variant="secondary"
              size="compact"
              aria-label="Unzoom pane"
              onClick={() =>
                focusedPane && void rpc("pane.zoom", { pane_id: focusedPane.pane_id })
              }
            >
              <Minimize2 className="size-3.5" />
              <span className="max-sm:hidden">Zoomed</span>
            </Button>
          ) : null}
          {/* Frequent pane layout actions stay visible as icon buttons —
              T3's PanelLayoutControls pattern: common operations are icons,
              the rest live in the overflow menu (issue #194). Below `sm`
              they fold into the menu so the tab strip keeps the width
              (issue #204); the menu carries the same actions. */}
          <div className="hidden items-center gap-1 sm:flex">
            <HeaderIconButton
              label="Split right"
              disabled={!focusedPane}
              onClick={paneAct(
                () =>
                  focusedPane &&
                  void rpc("pane.split", {
                    direction: "right",
                    target_pane_id: focusedPane.pane_id,
                    focus: true,
                  }),
              )}
            >
              <Columns2 className="size-4" />
            </HeaderIconButton>
            <HeaderIconButton
              label="Split down"
              disabled={!focusedPane}
              onClick={paneAct(
                () =>
                  focusedPane &&
                  void rpc("pane.split", {
                    direction: "down",
                    target_pane_id: focusedPane.pane_id,
                    focus: true,
                  }),
              )}
            >
              <Rows2 className="size-4" />
            </HeaderIconButton>
          </div>
          {/* Context card trigger (issue #390): T3's ThreadDetailsPanel
              toggle — the card itself renders inside the workspace
              canvas (inline) or as a popover anchored to this button. */}
          <ContextCardTrigger
            scope={`${machine}\n${workspace?.workspace_id ?? ""}`}
            disabled={!focusedPane}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Pane actions"
                  // Neutral focus ring: the default blue ring read as a
                  // stuck highlight after menu actions (issue #128).
                  // oxlint-disable-next-line shadcn/no-restyle -- no variant provides a non-ring focus treatment
                  className="focus-visible:ring-1 focus-visible:ring-foreground/30"
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width="content">
              <DropdownMenuItem
                onClick={paneAct(
                  () =>
                    focusedPane &&
                    void rpc("pane.split", {
                      direction: "right",
                      target_pane_id: focusedPane.pane_id,
                      focus: true,
                    }),
                )}
                disabled={!focusedPane}
              >
                <Columns2 /> Split right
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={paneAct(
                  () =>
                    focusedPane &&
                    void rpc("pane.split", {
                      direction: "down",
                      target_pane_id: focusedPane.pane_id,
                      focus: true,
                    }),
                )}
                disabled={!focusedPane}
              >
                <Rows2 /> Split down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={paneAct(
                  () =>
                    focusedPane &&
                    void rpc("pane.swap", {
                      pane_id: focusedPane.pane_id,
                      direction: "right",
                    }),
                )}
                disabled={!focusedPane || paneCount < 2}
              >
                <SquareSplitHorizontalIcon /> Swap pane
              </DropdownMenuItem>
              <DropdownMenuItem onClick={paneAct(focusNextPane)} disabled={paneCount < 2}>
                <Columns2 /> Focus next pane
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={paneAct(
                  () =>
                    focusedPane && void rpc("pane.close", { pane_id: focusedPane.pane_id }),
                )}
                disabled={!focusedPane}
              >
                <XIcon /> Close pane
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={paneAct(
                  () =>
                    focusedPane && void rpc("pane.zoom", { pane_id: focusedPane.pane_id }),
                )}
                disabled={!focusedPane}
              >
                {zoomed ? <Minimize2 /> : <Maximize2 />}
                {zoomed ? "Unzoom" : "Zoom"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startTabRename(activeTab)}>
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
              <DropdownMenuItem
                onClick={() => focusedPane && setDetailsPane(focusedPane)}
                disabled={!focusedPane}
              >
                <InfoIcon /> Details…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  focusedPane &&
                  openPanelSurface({
                    id: `git:${focusedPane.pane_id}`,
                    kind: "git",
                    paneId: focusedPane.pane_id,
                  })
                }
                disabled={!focusedPane}
              >
                <FolderGit2Icon /> Source Control
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "scripts", kind: "scripts" })}
              >
                <SquarePlayIcon /> Project Scripts
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "worktrees", kind: "worktrees" })}
              >
                <GitBranchIcon /> Worktrees
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "projects", kind: "projects" })}
              >
                <FolderKanbanIcon /> Projects
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  openPanelSurface({
                    id: "checkpoints",
                    kind: "checkpoints",
                    paneId: focusedPane?.pane_id ?? null,
                  })
                }
              >
                <HistoryIcon /> Checkpoints
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "automations", kind: "automations" })}
              >
                <CalendarClockIcon /> Automations
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "conversations", kind: "conversations" })}
              >
                <MessagesSquareIcon /> Conversations
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "usage", kind: "usage" })}
              >
                <GaugeIcon /> Usage
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "artifacts", kind: "artifacts" })}
              >
                <PackageIcon /> Artifacts
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "handoffs", kind: "handoffs" })}
              >
                <ArrowLeftRightIcon /> Handoffs
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "controls", kind: "controls" })}
              >
                <BotIcon /> Controls
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "textgen", kind: "textgen" })}
              >
                <SparklesIcon /> Text Generation
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "secrets", kind: "secrets" })}
              >
                <KeyRoundIcon /> Secrets
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "machines", kind: "machines" })}
              >
                <ServerIcon /> Machines
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => openPanelSurface({ id: "mcp", kind: "mcp" })}
              >
                <PlugIcon /> MCP
              </DropdownMenuItem>
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
      <PaneDetailsDialog
        pane={detailsPane}
        machine={machine}
        onClose={() => setDetailsPane(null)}
      />
    </>
  );
}
