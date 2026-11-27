/*
 * Workspace canvas — the pane grid area driven by real bridge data
 * (issue #84). Renders herdr's own pane layout (rects from the tab's
 * PaneLayoutSnapshot) with Ghostty PaneTerminal surfaces; focus and zoom
 * come from the snapshot, never local guesses. M1's fixture grid is gone.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { cn } from "~/lib/utils";
import { isEditableTarget, isMacPlatform } from "~/lib/shortcuts";
import { PaneTerminal } from "~/components/PaneTerminal";
import { PaneDetailsDialog } from "~/components/PaneDetailsDialog";
import { PaneMessageDialog } from "~/components/PaneMessageDialog";
import { PaneCopyDialog } from "~/components/PaneCopyDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { paneTitle } from "~/lib/workspace";
import { focusPaneTerminal } from "~/lib/focusHandoff";
import type { PaneInfo } from "../../shared/protocol";
import { useRouteWorkspace } from "./view";
import { callRpc, machineListOf, useBridgeState } from "./bridge";
import { useWorkspaceBranch } from "./worktrees";
import { WorkspaceContextCard } from "./PaneContextCard";
import {
  Columns2,
  Copy,
  Info,
  Maximize2,
  MousePointerClick,
  Rows2,
  X,
} from "lucide-react";

function PaneSurface({
  machine,
  pane,
  connected,
  rect,
  area,
  focused,
  zoomed,
  hasSiblings,
  onFocus,
  onDetails,
  onCopy,
  dnd,
}: {
  machine: string;
  pane: PaneInfo;
  connected: boolean;
  rect: { x: number; y: number; width: number; height: number } | undefined;
  area: { width: number; height: number };
  focused: boolean;
  zoomed: boolean;
  /** another pane shares the canvas — only then does the hairline split divider show (issue #432) */
  hasSiblings: boolean;
  onFocus: () => void;
  onDetails: () => void;
  onCopy: () => void;
  /** Drag-swap wiring (issue #111); undefined disables dragging. */
  dnd?:
    | {
        dropTarget: boolean;
        onDragStart: (e: DragEvent) => void;
        onDragOver: (e: DragEvent) => void;
        onDrop: (e: DragEvent) => void;
        onDragEnd: () => void;
      }
    | undefined;
}) {
  const style = zoomed
    ? { left: 0, top: 0, width: "100%", height: "100%" }
    : rect
      ? {
          left: `${(rect.x / Math.max(area.width, 1)) * 100}%`,
          top: `${(rect.y / Math.max(area.height, 1)) * 100}%`,
          width: `${(rect.width / Math.max(area.width, 1)) * 100}%`,
          height: `${(rect.height / Math.max(area.height, 1)) * 100}%`,
        }
      : undefined;
  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">
        <div
          className={cn(
            "absolute overflow-hidden transition-colors",
            // Split boundaries read as a hairline divider, not a card frame
            // (interaction.md §1, issue #432): single-pane and zoomed layouts
            // get no border at all; focused panes get a slightly stronger
            // hairline, never a full blue frame (issue #112).
            zoomed || !hasSiblings
              ? "border-0"
              : focused
                ? "border border-foreground/15 dark:border-foreground/30"
                : "border border-border/40",
            dnd?.dropTarget && "ring-2 ring-inset ring-primary",
          )}
          style={style}
          data-pane-id={pane.pane_id}
          data-focused={focused || undefined}
          draggable={dnd !== undefined}
          onDragStart={dnd?.onDragStart}
          onDragOver={dnd?.onDragOver}
          onDrop={dnd?.onDrop}
          onDragEnd={dnd?.onDragEnd}
          // oxlint-disable-next-line herdr-t3/no-native-title-tooltip -- pane identity tooltip over the terminal surface; a styled Tooltip popup would obstruct terminal hover
          title={paneTitle(pane)}
          onMouseDown={() => {
            if (!focused) onFocus();
          }}
        >
          <PaneTerminal
            machine={machine}
            paneId={pane.pane_id}
            connected={connected}
            label={paneTitle(pane)}
          />
        </div>
      </ContextMenuTrigger>
      {/* Pane context menu (issue #113): the right-click path herdr's TUI
          offers, translated to GUI actions — every item is a whitelisted
          herdr RPC or the details surface. */}
      <ContextMenuContent>
        {/* Menu actions return focus to this pane's terminal afterwards
            (issue #128); the deferred focus wins over the menu's own
            focus restoration to the trigger. */}
        <ContextMenuItem
          onSelect={() => {
            onFocus();
            setTimeout(() => focusPaneTerminal(), 0);
          }}
        >
          <MousePointerClick /> Focus
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void callRpc(machine, "pane.split", {
              direction: "right",
              target_pane_id: pane.pane_id,
              focus: true,
            });
            setTimeout(() => focusPaneTerminal(), 0);
          }}
        >
          <Columns2 /> Split right
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void callRpc(machine, "pane.split", {
              direction: "down",
              target_pane_id: pane.pane_id,
              focus: true,
            });
            setTimeout(() => focusPaneTerminal(), 0);
          }}
        >
          <Rows2 /> Split down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            void callRpc(machine, "pane.zoom", { pane_id: pane.pane_id });
            setTimeout(() => focusPaneTerminal(), 0);
          }}
        >
          <Maximize2 /> {zoomed ? "Unzoom" : "Zoom"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onDetails}>
          <Info /> Details…
        </ContextMenuItem>
        {/* Structured copy (issue #429): labeled range candidates —
            transcript/scrollback — instead of drag-selecting the TUI. */}
        <ContextMenuItem onSelect={onCopy}>
          <Copy /> Copy output…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          destructive
          onSelect={() => void callRpc(machine, "pane.close", { pane_id: pane.pane_id })}
        >
          <X /> Close pane
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WorkspaceCanvas() {
  const { machine, machineInfo, snapshot, view, stale } = useRouteWorkspace();
  const bridge = useBridgeState();
  const { workspace, activeTab, tabPanes, layout, focusedPane } = view;
  const zoomed = layout?.zoomed === true;
  // Attach attempts are gated on the client bridge only: the server queues
  // subscribes and reconnects ssh machines on demand, and machine reachability
  // is already surfaced by the sidebar status.
  const machineOnline = bridge.connection === "open";
  // Pane drag-swap state (issue #111) — declared before the early returns
  // below so hook order stays stable across renders.
  const [paneDragId, setPaneDragId] = useState<string | null>(null);
  const [paneDropId, setPaneDropId] = useState<string | null>(null);
  const [detailsPane, setDetailsPane] = useState<PaneInfo | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);
  const [copyPane, setCopyPane] = useState<PaneInfo | null>(null);
  // Context card (issue #390): the inline card positions inside this
  // container; the popover fallback anchors to the header trigger.
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const branch = useWorkspaceBranch(machine, workspace?.workspace_id ?? "");
  const machines = machineListOf(bridge);
  const focusedPaneId = focusedPane?.pane_id ?? layout?.focused_pane_id ?? null;

  // Keyboard pane navigation (issue #113): ⌘+Arrow on macOS,
  // Ctrl+Alt+Arrow elsewhere — modifier chords that never reach the pane
  // anyway. Runs in capture phase so the terminal's own key handling can't
  // consume the chord first; editable surfaces other than the terminal
  // (palette, dialogs, rename fields) keep their keys.
  useEffect(() => {
    if (!focusedPaneId) return;
    const directions: Record<string, string> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest(".ghostty-input") === null && isEditableTarget(target)) return;
        if (target.closest('[role="dialog"], [role="menu"], [data-command-palette]')) return;
      }
      const mac = isMacPlatform();
      const chord = mac
        ? event.metaKey && !event.ctrlKey && !event.altKey
        : event.ctrlKey && event.altKey && !event.metaKey;
      if (!chord) return;
      const direction = directions[event.key];
      if (!direction) return;
      event.preventDefault();
      void callRpc(machine, "pane.focus_direction", {
        pane_id: focusedPaneId,
        direction,
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [machine, focusedPaneId]);

  if (stale) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {machineInfo?.label ?? machine} is {machineInfo?.status}
        {machineInfo?.detail ? ` — ${machineInfo.detail}` : ""}. Reconnect from the sidebar to view live panes.
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {bridge.connection === "open"
          ? "Loading session…"
          : bridge.connection === "connecting"
            ? "Connecting to herdr…"
            : "Bridge disconnected — retrying…"}
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        No workspaces on this machine.
      </div>
    );
  }
  if (!activeTab || tabPanes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        No panes in this tab.
      </div>
    );
  }

  // herdr's zoom shows only the focused pane, full-bleed (issue #75).
  const visiblePanes = zoomed && focusedPane ? [focusedPane] : tabPanes;
  const area = layout?.area ?? { width: 1, height: 1 };

  // Pane drag-swap (issue #111): dragging one pane onto another issues
  // herdr `pane.swap {source_pane_id, target_pane_id}`, exchanging their
  // layout positions. Disabled while zoomed (single visible pane).
  const canDragPanes = !zoomed && visiblePanes.length > 1;
  const paneDnd = (pane: PaneInfo) =>
    canDragPanes
      ? {
          dropTarget: paneDropId === pane.pane_id,
          onDragStart: (e: DragEvent) => {
            setPaneDragId(pane.pane_id);
            e.dataTransfer.setData("text/plain", pane.pane_id);
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: DragEvent) => {
            if (!paneDragId || paneDragId === pane.pane_id) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setPaneDropId(pane.pane_id);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            const dragId = paneDragId ?? e.dataTransfer.getData("text/plain");
            setPaneDragId(null);
            setPaneDropId(null);
            if (!dragId || dragId === pane.pane_id) return;
            void callRpc(machine, "pane.swap", {
              source_pane_id: dragId,
              target_pane_id: pane.pane_id,
            });
          },
          onDragEnd: () => {
            setPaneDragId(null);
            setPaneDropId(null);
          },
        }
      : undefined;

  const focusedAgent = focusedPane
    ? snapshot?.agents.find((a) => a.pane_id === focusedPane.pane_id)
    : undefined;

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden p-2">
      <div ref={canvasAreaRef} className="relative h-full w-full">
        {visiblePanes.map((pane) => (
          <PaneSurface
            key={pane.pane_id}
            machine={machine}
            pane={pane}
            connected={machineOnline}
            rect={layout?.panes.find((p) => p.pane_id === pane.pane_id)?.rect}
            area={area}
            focused={
              layout
                ? pane.pane_id === layout.focused_pane_id
                : pane.focused
            }
            zoomed={zoomed}
            hasSiblings={visiblePanes.length > 1}
            onFocus={() => void callRpc(machine, "pane.focus", { pane_id: pane.pane_id })}
            onDetails={() => setDetailsPane(pane)}
            onCopy={() => setCopyPane(pane)}
            dnd={paneDnd(pane)}
          />
        ))}
        {focusedPane ? (
          <WorkspaceContextCard
            machine={machine}
            machineLabel={machineInfo?.label ?? machine}
            showMachine={machines.length > 1}
            pane={focusedPane}
            agent={focusedAgent}
            workspace={workspace}
            branch={branch}
            agents={snapshot?.agents ?? []}
            containerRef={canvasAreaRef}
            onPrompt={
              focusedPane.agent ? () => setMessagePane(focusedPane) : undefined
            }
            onDetails={() => setDetailsPane(focusedPane)}
          />
        ) : null}
      </div>
      <PaneDetailsDialog
        pane={detailsPane}
        machine={machine}
        onClose={() => setDetailsPane(null)}
      />
      <PaneMessageDialog
        pane={messagePane}
        machine={machine}
        onClose={() => setMessagePane(null)}
      />
      <PaneCopyDialog
        pane={copyPane}
        machine={machine}
        onClose={() => setCopyPane(null)}
      />
    </div>
  );
}
