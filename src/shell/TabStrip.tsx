/*
 * Workspace tab strip — herdr tabs inside the selected workspace,
 * extracted from WorkspaceHeader (issue #550) so the real component is
 * reviewable in Storybook. Owns drag-reorder, overflow fade, inline
 * rename and the per-tab context menu; rename state itself stays
 * controlled by the header because the pane-actions overflow menu can
 * also start a tab rename.
 */
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MousePointerClickIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { requestFocusHandoff } from "~/lib/focusHandoff";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { moveInsertIndex } from "~/lib/reorder";
import type { RpcMethod, TabInfo } from "../../shared/protocol";
import { HeaderIconButton } from "./HeaderIconButton";

export type TabStripRpc = (
  method: RpcMethod,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export function TabStrip({
  tabs,
  activeTabId,
  machine,
  workspaceId,
  rpc,
  renamingTabId,
  renameDraft,
  onRenameDraftChange,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
}: {
  tabs: TabInfo[];
  activeTabId: string;
  machine: string;
  workspaceId: string;
  rpc: TabStripRpc;
  /** Inline rename is controlled: the header's overflow menu can start it too. */
  renamingTabId: string | null;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onRenameStart: (tab: TabInfo) => void;
  onRenameCommit: (tab: TabInfo) => void;
  onRenameCancel: () => void;
}) {
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

  return (
    // min-w-11 floors the strip at its fixed chrome (hairline +
    // gap + the size-8/size-7 new-tab button ≈ 41/37px): without it
    // flex-1 + min-w-0 let the container collapse to ~0 and the
    // shrink-0 "+" overflowed rightward onto the pane-summary text
    // (issue #417). The scroller still scrolls internally.
    <div className="flex min-w-11 flex-1 items-center gap-1">
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
          const selected = t.tab_id === activeTabId;
          const label = t.label || `Tab ${t.number}`;
          const dropHere = tabDrop?.index === tabIndex ? tabDrop.side : null;
          const tabButton = (
            <div
              draggable={renamingTabId !== t.tab_id}
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
              {renamingTabId === t.tab_id ? (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- inline rename field inside the tab row, mirrors T3 thread rename
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => onRenameDraftChange(e.target.value)}
                  onBlur={() => onRenameCommit(t)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onRenameCommit(t);
                    if (e.key === "Escape") onRenameCancel();
                  }}
                  className="w-24 rounded-sm border border-border bg-background px-1 text-sm outline-none"
                />
              ) : (
                // oxlint-disable-next-line herdr-t3/no-raw-control -- tab label is part of a composite tab row, not a standalone control
                <button
                  type="button"
                  onClick={() => {
                    // Issue #435: selecting a tab hands keyboard focus
                    // to the pane herdr focuses inside it once the
                    // snapshot and the mounted surface agree.
                    requestFocusHandoff({
                      machine,
                      workspaceId,
                      tabId: t.tab_id,
                    });
                    void rpc("tab.focus", { tab_id: t.tab_id });
                  }}
                  // Prevent mousedown focus: a clicked tab kept a
                  // persistent focus ring while hovering siblings
                  // (issue #204 review). Keyboard focus is unaffected.
                  onMouseDown={(e) => e.preventDefault()}
                  onDoubleClick={() => onRenameStart(t)}
                  className="flex min-w-0 items-center gap-1.5 rounded-sm outline-none"
                >
                  {/* TabInfo carries no provider kind — the generic mark
                      + status ring is the unified agent-work indicator. */}
                  <AgentIdentityIcon agent={null} status={t.agent_status} size="sm" />
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
                  onClick={() => {
                    requestFocusHandoff({ machine, workspaceId });
                    void rpc("tab.close", { tab_id: t.tab_id });
                  }}
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
                  onSelect={() => {
                    requestFocusHandoff({
                      machine,
                      workspaceId,
                      tabId: t.tab_id,
                    });
                    void rpc("tab.focus", { tab_id: t.tab_id });
                  }}
                >
                  <MousePointerClickIcon /> Focus tab
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onRenameStart(t)}>
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
                  onSelect={() => {
                    requestFocusHandoff({ machine, workspaceId });
                    void rpc("tab.close", { tab_id: t.tab_id });
                  }}
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
        onClick={() => {
          requestFocusHandoff({ machine, workspaceId });
          void rpc("tab.create", {
            workspace_id: workspaceId,
            focus: true,
          });
        }}
      >
        <PlusIcon className="size-4" />
      </HeaderIconButton>
    </div>
  );
}
