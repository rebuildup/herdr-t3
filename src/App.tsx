import { useEffect, useState } from "react";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol";
import { cn } from "./lib/utils";
import { connectBridge, fetchSession, onSnapshot, onStatus, rpc } from "./lib/api";
import { Button } from "./components/ui/button";
import { PaneTerminal } from "./components/PaneTerminal";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Plus,
  Terminal,
  Wifi,
  WifiOff,
} from "lucide-react";

function statusIcon(status: AgentStatus) {
  switch (status) {
    case "working":
      return <Loader2 className="size-3 animate-spin" />;
    case "blocked":
      return <CircleX className="size-3 text-warning" />;
    case "done":
      return <CircleCheck className="size-3 text-success" />;
    case "idle":
      return <Circle className="size-3 text-muted-foreground" />;
    default:
      return <CircleDashed className="size-3 text-muted-foreground" />;
  }
}

function workspaceTitle(ws: SessionSnapshot["workspaces"][number]): string {
  return ws.label || ws.worktree?.repo_name || ws.workspace_id;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const disconnect = connectBridge();
    const offSnapshot = onSnapshot((next) => {
      setSnapshot(next);
      setError(null);
    });
    const offStatus = onStatus(setConnection);
    // Initial REST snapshot covers the gap before the WS ready frame.
    void fetchSession()
      .then(setSnapshot)
      .catch((e: Error) => setError(e.message));
    return () => {
      disconnect();
      offSnapshot();
      offStatus();
    };
  }, []);

  const workspaces = snapshot?.workspaces ?? [];
  const tabs = snapshot?.tabs ?? [];
  const panes = snapshot?.panes ?? [];
  const focusedWorkspaceId = snapshot?.focused_workspace_id ?? workspaces.find((w) => w.focused)?.workspace_id;
  const activeWorkspace = workspaces.find((w) => w.workspace_id === focusedWorkspaceId) ?? workspaces[0];
  const workspaceTabs = activeWorkspace ? tabs.filter((t) => t.workspace_id === activeWorkspace.workspace_id) : [];
  const activeTab = workspaceTabs.find((t) => t.tab_id === activeWorkspace?.active_tab_id) ?? workspaceTabs[0];
  const tabPanes = activeTab ? panes.filter((p) => p.tab_id === activeTab.tab_id) : [];
  const layout = snapshot?.layouts.find((l) => l.tab_id === activeTab?.tab_id);

  return (
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Terminal className="size-4 text-primary" />
          <span className="text-sm font-medium">herdr-t3</span>
          <span className="ml-auto" title={connection}>
            {connection === "open" ? (
              <Wifi className="size-3.5 text-success" />
            ) : (
              <WifiOff className="size-3.5 text-muted-foreground" />
            )}
          </span>
        </div>
        <div className="px-2 pb-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            onClick={() => void rpc("workspace.create", {})}
          >
            <Plus className="size-3.5" /> New workspace
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {workspaces.map((ws) => (
            <button
              key={ws.workspace_id}
              type="button"
              onClick={() => {
                const pane = panes.find((p) => p.workspace_id === ws.workspace_id);
                if (pane) void rpc("pane.focus", { pane_id: pane.pane_id });
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                ws.workspace_id === activeWorkspace?.workspace_id
                  ? "bg-sidebar-row-selected text-foreground"
                  : "text-foreground/80 hover:bg-sidebar-row-hover",
              )}
            >
              {statusIcon(ws.agent_status)}
              <span className="min-w-0 flex-1 truncate">{workspaceTitle(ws)}</span>
              <span className="text-2xs text-secondary-label">
                {ws.tab_count}t · {ws.pane_count}p
              </span>
            </button>
          ))}
          {snapshot && workspaces.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">No workspaces yet.</p>
          )}
        </nav>
        {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {workspaceTabs.map((tab) => (
            <button
              key={tab.tab_id}
              type="button"
              onClick={() => {
                const pane = panes.find((p) => p.tab_id === tab.tab_id);
                if (pane) void rpc("pane.focus", { pane_id: pane.pane_id });
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                tab.tab_id === activeTab?.tab_id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {statusIcon(tab.agent_status)}
              <span className="max-w-40 truncate">{tab.label || `Tab ${tab.number}`}</span>
            </button>
          ))}
          {activeWorkspace && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="New tab"
              onClick={() => void rpc("tab.create", { workspace_id: activeWorkspace.workspace_id })}
            >
              <Plus className="size-4" />
            </Button>
          )}
        </div>

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
                    "absolute overflow-hidden rounded-md border",
                    pane.focused
                      ? "border-primary/60"
                      : "border-border/60",
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
                  title={pane.terminal_title_stripped ?? pane.title ?? pane.pane_id}
                  onMouseDown={() => {
                    if (!pane.focused) void rpc("pane.focus", { pane_id: pane.pane_id });
                  }}
                >
                  <PaneTerminal paneId={pane.pane_id} connected={connection === "open"} />
                </div>
              );
            })}
        </div>
      </main>
    </div>
  );
}
