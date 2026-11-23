/*
 * Workspace canvas — the pane grid area driven by real bridge data
 * (issue #84). Renders herdr's own pane layout (rects from the tab's
 * PaneLayoutSnapshot) with Ghostty PaneTerminal surfaces; focus and zoom
 * come from the snapshot, never local guesses. M1's fixture grid is gone.
 */
import { cn } from "~/lib/utils";
import { PaneTerminal } from "~/components/PaneTerminal";
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
}: {
  machine: string;
  pane: PaneInfo;
  connected: boolean;
  rect: { x: number; y: number; width: number; height: number } | undefined;
  area: { width: number; height: number };
  focused: boolean;
  zoomed: boolean;
  onFocus: () => void;
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
    <div
      className={cn(
        "absolute overflow-hidden border",
        focused ? "border-primary/60" : "border-border/60",
      )}
      style={style}
      // oxlint-disable-next-line herdr-t3/no-native-title-tooltip -- pane identity tooltip over the terminal surface; a styled Tooltip popup would obstruct terminal hover
      title={paneTitle(pane)}
      onMouseDown={() => {
        if (!focused) onFocus();
      }}
    >
      <PaneTerminal machine={machine} paneId={pane.pane_id} connected={connected} />
    </div>
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
        {bridge.connection === "open" ? "Loading session…" : "Connecting to herdr…"}
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
          />
        ))}
      </div>
    </div>
  );
}
