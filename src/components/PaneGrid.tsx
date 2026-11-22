import { cn } from "../lib/utils";
import type { Bridge } from "../hooks/useBridge";
import type { WorkspaceView } from "../lib/workspace";
import { PaneTerminal } from "./PaneTerminal";

interface PaneGridProps {
  bridge: Bridge;
  view: WorkspaceView;
}

export function PaneGrid({ bridge, view }: PaneGridProps) {
  const { connection, machines, machine, snapshot, call } = bridge;
  const { tabPanes, layout } = view;

  return (
    <div className="relative flex-1 overflow-hidden bg-terminal-background">
      {tabPanes.length === 0 && (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {snapshot ? "No panes in this tab." : "Connecting to herdr…"}
        </div>
      )}
      {layout &&
        tabPanes.map((pane) => {
          const rect = layout.panes.find((lp) => lp.pane_id === pane.pane_id)?.rect;
          return (
            <div
              key={pane.pane_id}
              className={cn(
                "absolute overflow-hidden border",
                pane.focused ? "border-primary/60" : "border-border/60",
              )}
              style={
                rect
                  ? {
                      left: `${(rect.x / Math.max(layout.area.width, 1)) * 100}%`,
                      top: `${(rect.y / Math.max(layout.area.height, 1)) * 100}%`,
                      width: `${(rect.width / Math.max(layout.area.width, 1)) * 100}%`,
                      height: `${(rect.height / Math.max(layout.area.height, 1)) * 100}%`,
                    }
                  : undefined
              }
              // oxlint-disable-next-line herdr-t3/no-native-title-tooltip -- pane identity tooltip over the terminal surface; a styled Tooltip popup would obstruct xterm hover
              title={
                pane.terminal_title_stripped ?? pane.title ?? pane.label ?? pane.pane_id
              }
              onMouseDown={() => {
                if (!pane.focused) void call("pane.focus", { pane_id: pane.pane_id });
              }}
            >
              <PaneTerminal
                machine={machine}
                paneId={pane.pane_id}
                connected={
                  connection === "open" || machines[machine]?.status === "online"
                }
              />
            </div>
          );
        })}
    </div>
  );
}
