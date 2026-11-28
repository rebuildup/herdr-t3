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
import { paneCanvasView, type CanvasPaneView } from "~/lib/paneCanvas";
import { focusPaneTerminal } from "~/lib/focusHandoff";
import type { PaneInfo } from "../../shared/protocol";
import { useRouteWorkspace } from "./view";
import { resolveCanvasSession } from "./canvasState";
import {
  callRpc,
  ensureMachine,
  machineListOf,
  newWorkspace,
  useBridgeState,
} from "./bridge";
import { navigate, settingsHash } from "./router";
import { useWorkspaceBranch } from "./worktrees";
import { WorkspaceContextCard } from "./PaneContextCard";
import {
  Columns2,
  Copy,
  Info,
  Maximize2,
  MousePointerClick,
  Plus,
  RefreshCw,
  Rows2,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";

function PaneSurface({
  machine,
  view,
  connected,
  zoomed,
  onFocus,
  onDetails,
  onCopy,
  dnd,
}: {
  machine: string;
  view: CanvasPaneView;
  connected: boolean;
  zoomed: boolean;
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
  const { pane, title, focused, frame, emphasis } = view;
  // Frame fractions are 0..1 of the layout area; zoomed panes get a
  // full-bleed frame from the model, matching the previous inline math.
  const style = frame
    ? {
        left: `${frame.x * 100}%`,
        top: `${frame.y * 100}%`,
        width: `${frame.width * 100}%`,
        height: `${frame.height * 100}%`,
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
            emphasis === "none"
              ? "border-0"
              : emphasis === "focused"
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
          title={title}
          onMouseDown={() => {
            if (!focused) onFocus();
          }}
        >
          <PaneTerminal
            machine={machine}
            paneId={pane.pane_id}
            connected={connected}
            label={title}
            // Only the pane the user is operating holds the writable
            // attach (resize authority + input); the rest stream read-only
            // so the GUI's presence cannot pin their sizes (issue #571).
            writable={focused}
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
  const { machine, machineInfo, snapshot, view, probe, summary } = useRouteWorkspace();
  const bridge = useBridgeState();
  const { workspace, activeTab, tabPanes, layout, focusedPane } = view;
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

  // Session-state contract (issue #421): loading, probe-only, stale,
  // down, disabled, error and genuinely-empty are distinct states with
  // distinct presentations — never one "no workspaces" catch-all. The
  // resolver is pure; see canvasState.ts for the upstream lifecycle
  // evidence behind each branch.
  const session = resolveCanvasSession({
    snapshot,
    // Summary snapshots (issue #585) are stripped sidebar data: the canvas
    // waits in `connecting` for the full-detail push the selection
    // upgrade triggers, same as a probe-only machine.
    probeSnapshot: probe || summary,
    machineInfo,
    bridgeConnection: bridge.connection,
    machineError: bridge.errors[machine],
    machinePending: bridge.pendingMachines[machine] === true,
  });
  const machineLabel = machineInfo?.label ?? machine;

  if (session.kind === "bridge") {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        {session.connection === "connecting"
          ? "Connecting to herdr…"
          : "Bridge disconnected — retrying…"}
      </div>
    );
  }
  if (session.kind === "connecting" || session.kind === "loading") {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        {session.kind === "connecting"
          ? `Connecting to ${machineLabel}…`
          : "Loading session…"}
      </div>
    );
  }
  if (session.kind === "stale" || session.kind === "down") {
    const status = machineInfo?.status ?? "offline";
    return (
      <Empty size="compact" className="min-h-0">
        <EmptyHeader>
          <EmptyTitle>
            {machineLabel} is {status.replace(/_/g, " ")}
          </EmptyTitle>
          <EmptyDescription>
            {machineInfo?.detail ?? "Reconnect to view live panes."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void ensureMachine(machine)}
          >
            <RefreshCw /> Reconnect
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (session.kind === "disabled") {
    return (
      <Empty size="compact" className="min-h-0">
        <EmptyHeader>
          <EmptyTitle>{machineLabel} is disabled</EmptyTitle>
          <EmptyDescription>
            Enable this machine in Settings → Connections to view its panes.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(settingsHash("connections"))}
          >
            Open Connections
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (session.kind === "error") {
    return (
      <Empty size="compact" className="min-h-0">
        <EmptyHeader>
          <EmptyTitle>Could not reach {machineLabel}</EmptyTitle>
          <EmptyDescription>{session.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void ensureMachine(machine)}
          >
            <RefreshCw /> Retry
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  // session.kind === "live": a real session snapshot is held. An empty
  // workspace list is a genuine herdr state (the session survives its
  // last workspace — upstream close_workspaces keeps the server alive),
  // so it gets the restrained empty treatment with a recovery action.
  if (!workspace) {
    return (
      <Empty size="compact" className="min-h-0">
        <EmptyHeader>
          <EmptyTitle>No workspaces</EmptyTitle>
          <EmptyDescription>
            {machineLabel} has no workspaces in this herdr session.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => void newWorkspace(machine)}>
            <Plus /> New workspace
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (!activeTab || tabPanes.length === 0) {
    // herdr never persists a pane-less tab or a tab-less workspace
    // (close_pane/close_active_tab cascade upward), so this is an
    // anomalous or mid-transition snapshot — report it plainly and let
    // the next pushed snapshot resolve it.
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        No panes in this tab.
      </div>
    );
  }

  // Pane-frame model (issue #324): visible panes, normalized geometry,
  // focus and hairline emphasis — shared with the GPUI port via
  // state-projections; the React layer only maps it to DOM.
  const canvas = paneCanvasView(tabPanes, layout, focusedPane ?? null);
  const { zoomed, canDragPanes } = canvas;

  // Pane drag-swap (issue #111): dragging one pane onto another issues
  // herdr `pane.swap {source_pane_id, target_pane_id}`, exchanging their
  // layout positions. Disabled while zoomed (single visible pane).
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
        {canvas.panes.map((paneView) => (
          <PaneSurface
            key={paneView.pane.pane_id}
            machine={machine}
            view={paneView}
            connected={machineOnline}
            zoomed={zoomed}
            onFocus={() =>
              void callRpc(machine, "pane.focus", { pane_id: paneView.pane.pane_id })
            }
            onDetails={() => setDetailsPane(paneView.pane)}
            onCopy={() => setCopyPane(paneView.pane)}
            dnd={paneDnd(paneView.pane)}
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
