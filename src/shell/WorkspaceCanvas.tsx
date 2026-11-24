/*
 * Workspace canvas — the pane grid area driven by real bridge data
 * (issue #84). Renders herdr's own pane layout (rects from the tab's
 * PaneLayoutSnapshot) with Ghostty PaneTerminal surfaces; focus and zoom
 * come from the snapshot, never local guesses. M1's fixture grid is gone.
 */
import { useEffect, useState, type DragEvent } from "react";
import { cn } from "~/lib/utils";
import { isEditableTarget, isMacPlatform } from "~/lib/shortcuts";
import { PaneTerminal } from "~/components/PaneTerminal";
import { PaneDetailsDialog } from "~/components/PaneDetailsDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { paneTitle } from "~/lib/workspace";
import type { PaneInfo } from "../../shared/protocol";
import { useRouteWorkspace } from "./view";
import { callRpc, useBridgeState } from "./bridge";

function PaneSurface({
  machine,
  pane,
  connected,
  rect,
  area,
  focused,
  zoomed,
  onFocus,
  onDetails,
  dnd,
}: {
  machine: string;
  pane: PaneInfo;
  connected: boolean;
  rect: { x: number; y: number; width: number; height: number } | undefined;
  area: { width: number; height: number };
  focused: boolean;
  zoomed: boolean;
  onFocus: () => void;
  onDetails: () => void;
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
            "absolute overflow-hidden border transition-colors",
            // Focus treatment follows interaction.md: neutral emphasis, never a
            // full blue frame (issue #112).
            focused ? "border-foreground/25" : "border-border/50",
            dnd?.dropTarget && "ring-2 ring-inset ring-primary",
          )}
          style={style}
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
        <ContextMenuItem onSelect={onFocus}>Focus</ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void callRpc(machine, "pane.split", {
              direction: "right",
              target_pane_id: pane.pane_id,
              focus: true,
            })
          }
        >
          Split right
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void callRpc(machine, "pane.split", {
              direction: "down",
              target_pane_id: pane.pane_id,
              focus: true,
            })
          }
        >
          Split down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void callRpc(machine, "pane.zoom", { pane_id: pane.pane_id })}>
          {zoomed ? "Unzoom" : "Zoom"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onDetails}>Details…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void callRpc(machine, "pane.close", { pane_id: pane.pane_id })}>
          Close pane
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

  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden p-3">
      <div className="relative h-full w-full">
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
            onFocus={() => void callRpc(machine, "pane.focus", { pane_id: pane.pane_id })}
            onDetails={() => setDetailsPane(pane)}
            dnd={paneDnd(pane)}
          />
        ))}
      </div>
      <PaneDetailsDialog
        pane={detailsPane}
        machine={machine}
        onClose={() => setDetailsPane(null)}
      />
    </div>
  );
}
