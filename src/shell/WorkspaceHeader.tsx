/*
 * Workspace content header — T3 Code's ChatView header structure
 * (issue #83) driven by real bridge data (issue #84): 52px drag-region
 * row with breadcrumb (machine › workspace), tab strip, focused-pane
 * actions in an overflow menu. Every action is a whitelisted herdr RPC;
 * the pushed snapshot is what updates the UI.
 */
import {
  ArrowLeftRightIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2,
  EllipsisIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  GaugeIcon,
  GitBranchIcon,
  HistoryIcon,
  InfoIcon,
  Maximize2,
  MessagesSquareIcon,
  MessageSquareTextIcon,
  Minimize2,
  MousePointerClickIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  Rows2,
  SquarePlayIcon,
  SquareSplitHorizontalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { focusPaneTerminal } from "~/lib/paneFocus";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { statusIcon } from "~/components/statusIcons";
import { AgentStatusBadge, isKnownAgentStatus, PaneStatusDetail } from "~/components/AgentStatusBadge";
import { paneTitle, workspaceTitle } from "~/lib/workspace";
import { moveInsertIndex } from "~/lib/reorder";
import { nextPaneInReadingOrder } from "~/lib/paneOrder";
import type { PaneInfo, RpcMethod, TabInfo } from "../../shared/protocol";
import { useRouteWorkspace } from "./view";
import { callRpc } from "./bridge";
import { useWorkspaceBranch } from "./worktrees";
import { PaneMessageDialog } from "~/components/PaneMessageDialog";
import { PaneDetailsDialog } from "~/components/PaneDetailsDialog";
import { ContextCardTrigger } from "./PaneContextCard";
import { openSurface, type RightPanelSurface } from "./rightPanelStore";
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
  const [detailsPane, setDetailsPane] = useState<PaneInfo | null>(null);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [tabDraft, setTabDraft] = useState("");
  // Tab drag-reorder (issue #111): HTML5 drag with an insertion indicator;
  // the drop maps to herdr `tab.move {tab_id, insert_index}`.
  const [tabDragId, setTabDragId] = useState<string | null>(null);
  const [tabDrop, setTabDrop] = useState<{ index: number; side: "before" | "after" } | null>(null);
  // Scroll-edge fade: the hidden-scrollbar strip gives no overflow cue,
  // so a right-edge mask appears whenever tabs actually overflow
  // (issue #204 review).
  const tabStripRef = useRef<HTMLDivElement>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const check = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    return observeResize(el, check);
  }, [tabs]);
  const branch = useWorkspaceBranch(machine, workspace?.workspace_id ?? "");
  const zoomed = layout?.zoomed === true;
  const rpc = (method: RpcMethod, params: Record<string, unknown> = {}) =>
    callRpc(machine, method, params);
  // Issue #333: plugin surfaces open as docked right-panel tabs scoped to
  // this workspace — Source Control targets the focused pane's repo.
  const panelScope = `${machine}\n${workspace?.workspace_id ?? ""}`;
  const openPanelSurface = (surface: RightPanelSurface) =>
    openSurface(panelScope, surface);

  const headerClass = cn(
    "relative flex h-(--workspace-topbar-height) min-h-(--workspace-topbar-height) shrink-0 items-center gap-3",
    isElectron
      ? "drag-region bg-background px-3 sm:px-5 wco:pr-(--workspace-native-controls-inset)"
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

        {/* Tab strip — herdr tabs inside the selected workspace. The strip
            scrolls internally; the surrounding header space stays draggable.
            The new-tab action sits outside the scroller so it never slides
            out of view on narrow widths. */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* Hairline separating the workspace breadcrumb from the tab
              strip — at narrow widths the two read as one run without it
              (issue #130). */}
          <span aria-hidden className="h-4 w-px shrink-0 bg-border/60" />
          <div
            ref={tabStripRef}
            className={cn(
              "flex min-w-0 items-center gap-1 overflow-x-auto [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden [scrollbar-width:none]",
              tabsOverflow &&
                "[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
            )}
          >
            {tabs.map((t, tabIndex) => {
              const selected = t.tab_id === activeTab.tab_id;
              const label = t.label || `Tab ${t.number}`;
              const dropHere = tabDrop?.index === tabIndex ? tabDrop.side : null;
              const tabButton = (
                <div
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
                    // herdr `insert_index` is a pre-removal insertion point:
                    // the tab lands before the element currently at that index
                    // (`tabs.length` appends). Adjacent drops are no-ops.
                    // Verified against herdr 0.9.5 (issue #115).
                    const insertIndex = moveInsertIndex(from, tabIndex, side);
                    if (insertIndex === null) return;
                    void rpc("tab.move", { tab_id: dragId, insert_index: insertIndex });
                  }}
                  onDragEnd={() => {
                    setTabDragId(null);
                    setTabDrop(null);
                  }}
                  className={cn(
                    // shrink-0: the absolutely-positioned close button sits
                    // outside flow, so a squeezed tab would let it overlap
                    // the icon/label (issue #165). Overflow scrolls instead.
                    "group relative flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm",
                    // Keyboard focus rings the whole pill, not just the
                    // label button inside it (issue #165): has-[>button…]
                    // matches only the direct-child label button, so the
                    // nested close button keeps its own small ring.
                    "has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-inset has-[>button:focus-visible]:ring-ring",
                    tabDragId === t.tab_id && "opacity-50",
                    // pe-8 is constant on every tab: the absolutely-
                    // positioned close button always has reserved room and
                    // hover/focus reveal never shifts the strip (issue
                    // #204). hover:/focus-within: — NOT group-hover:,
                    // which only matches descendants of .group, never the
                    // .group element itself (issue #165). pe-7 pairs with
                    // the icon-xs close button (issue #204).
                    "pe-7",
                    selected
                      ? // The inset ring keeps the active pill distinct from
                        // an hovered inactive tab — both share bg-accent, so
                        // fill alone cannot carry selection (issue #204).
                        "bg-accent font-medium text-foreground inset-ring-1 inset-ring-border"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
                      // Prevent mousedown focus: a clicked tab kept a
                      // persistent focus ring while hovering siblings
                      // (issue #204 review). Keyboard focus is unaffected.
                      onMouseDown={(e) => e.preventDefault()}
                      onDoubleClick={() => {
                        setTabDraft(label);
                        setRenamingTab(t.tab_id);
                      }}
                      className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none"
                    >
                      {statusIcon(t.agent_status)}
                      <span className="min-w-0 max-w-40 truncate">{label}</span>
                    </button>
                  )}
                  {/* Close is a direct affordance on every tab: always
                      visible on the active tab (the reserved width must not
                      read as dead space, issue #128), hover/focus-revealed
                      on the rest — T3's SidebarThreadRow pattern (issue
                      #152). */}
                  <span
                    className={cn(
                      // Invisible until revealed, but still hit-testable —
                      // gate pointer events so it cannot swallow label
                      // clicks in the unpadded state (issue #165).
                      "absolute right-0.5 top-1/2 -translate-y-1/2 transition-opacity",
                      selected
                        ? "pointer-events-auto"
                        : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
                    )}
                  >
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Close tab"
                      onClick={() => void rpc("tab.close", { tab_id: t.tab_id })}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </span>
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
              // Tab context menu (issue #152): restores the direct right-
              // click operation path T3 Code threads have — focus, rename,
              // reorder and close without opening the overflow menu.
              return (
                <ContextMenu key={t.tab_id}>
                  {/* shrink-0: the trigger must never compress below the
                      pill — a squeezed trigger lets the shrink-0 pill
                      overflow into the next tab (issue #204). The scroller
                      scrolls instead. */}
                  <ContextMenuTrigger className="flex shrink-0">
                    {tabButton}
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      disabled={selected}
                      onSelect={() => void rpc("tab.focus", { tab_id: t.tab_id })}
                    >
                      <MousePointerClickIcon /> Focus tab
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        setTabDraft(label);
                        setRenamingTab(t.tab_id);
                      }}
                    >
                      <PencilIcon /> Rename…
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={tabIndex === 0}
                      onSelect={() =>
                        void rpc("tab.move", {
                          tab_id: t.tab_id,
                          insert_index: tabIndex - 1,
                        })
                      }
                    >
                      <ChevronLeftIcon /> Move left
                    </ContextMenuItem>
                    <ContextMenuItem
                      disabled={tabIndex === tabs.length - 1}
                      onSelect={() =>
                        void rpc("tab.move", {
                          tab_id: t.tab_id,
                          insert_index: tabIndex + 2,
                        })
                      }
                    >
                      <ChevronRightIcon /> Move right
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      destructive
                      onSelect={() => void rpc("tab.close", { tab_id: t.tab_id })}
                    >
                      <XIcon /> Close tab
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
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
                <span className="truncate">
                  {focusedTitle}
                  {focusedPane?.agent ? ` · ${focusedPane.agent}` : ""}
                </span>
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
