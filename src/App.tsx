import { useEffect, useState } from "react";
import type { AgentStatus, PaneInfo, SessionSnapshot } from "../shared/protocol";
import { cn } from "./lib/utils";
import { connectBridge, fetchSession, onSnapshot, onStatus, rpc } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/menu";
import { PaneTerminal } from "./components/PaneTerminal";
import { PaneMessageDialog } from "./components/PaneMessageDialog";
import { AgentStatusBadge } from "./components/AgentStatusBadge";
import { RenameDialog, type RenameTarget } from "./components/RenameDialog";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Columns2,
  Loader2,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  Rows2,
  SquareSplitHorizontal,
  Terminal,
  Wifi,
  WifiOff,
  X,
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
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);

  useEffect(() => {
    const disconnect = connectBridge();
    const offSnapshot = onSnapshot((next) => {
      setSnapshot(next);
      setError(null);
    });
    const offStatus = onStatus(setConnection);
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
  const focusedPane =
    tabPanes.find((p) => p.pane_id === layout?.focused_pane_id) ??
    tabPanes.find((p) => p.focused) ??
    tabPanes[0];

  const paneTitle = (pane: PaneInfo) =>
    pane.terminal_title_stripped ?? pane.title ?? pane.label ?? pane.pane_id;

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
            onClick={() => void rpc("workspace.create", { focus: true })}
          >
            <Plus className="size-3.5" /> New workspace
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-1">
          {workspaces.map((ws, index) => {
            const selected = ws.workspace_id === activeWorkspace?.workspace_id;
            return (
              <ContextMenu key={ws.workspace_id}>
                <ContextMenuTrigger className="w-full">
                  <button
                    type="button"
                    onClick={() => void rpc("workspace.focus", { workspace_id: ws.workspace_id })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      selected
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
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void rpc("workspace.focus", { workspace_id: ws.workspace_id })}>
                    Focus
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => setRename({ kind: "workspace", id: ws.workspace_id, label: workspaceTitle(ws) })}
                  >
                    Rename…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={index === 0}
                    onSelect={() => void rpc("workspace.move", { workspace_id: ws.workspace_id, insert_index: index - 1 })}
                  >
                    Move up
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={index === workspaces.length - 1}
                    onSelect={() => void rpc("workspace.move", { workspace_id: ws.workspace_id, insert_index: index + 1 })}
                  >
                    Move down
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void rpc("workspace.close", { workspace_id: ws.workspace_id })}>
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {snapshot && workspaces.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">No workspaces yet.</p>
          )}
        </nav>
        {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          {workspaceTabs.map((tab, index) => {
            const selected = tab.tab_id === activeTab?.tab_id;
            return (
              <ContextMenu key={tab.tab_id}>
                <ContextMenuTrigger>
                  <div
                    className={cn(
                      "group flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void rpc("tab.focus", { tab_id: tab.tab_id })}
                      className="flex items-center gap-1.5"
                    >
                      {statusIcon(tab.agent_status)}
                      <span className="max-w-40 truncate">{tab.label || `Tab ${tab.number}`}</span>
                    </button>
                    {selected && (
                      <button
                        type="button"
                        title="Close tab"
                        className="rounded-sm p-0.5 opacity-0 hover:bg-foreground/10 group-hover:opacity-100"
                        onClick={() => void rpc("tab.close", { tab_id: tab.tab_id })}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void rpc("tab.focus", { tab_id: tab.tab_id })}>
                    Focus
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => setRename({ kind: "tab", id: tab.tab_id, label: tab.label || `Tab ${tab.number}` })}
                  >
                    Rename…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={index === 0}
                    onSelect={() => void rpc("tab.move", { tab_id: tab.tab_id, insert_index: index - 1 })}
                  >
                    Move left
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={index === workspaceTabs.length - 1}
                    onSelect={() => void rpc("tab.move", { tab_id: tab.tab_id, insert_index: index + 1 })}
                  >
                    Move right
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void rpc("tab.close", { tab_id: tab.tab_id })}>
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {activeWorkspace && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="New tab"
              onClick={() =>
                void rpc("tab.create", { workspace_id: activeWorkspace.workspace_id, focus: true })
              }
            >
              <Plus className="size-4" />
            </Button>
          )}
        </div>

        {focusedPane && (
          <div className="flex items-center gap-1 border-b border-border px-2 py-1">
            <span className="flex min-w-0 items-center gap-2 text-xs text-secondary-label">
              <span className="truncate">
                {paneTitle(focusedPane)}
                {focusedPane.agent ? ` · ${focusedPane.agent}` : ""}
              </span>
              <AgentStatusBadge status={focusedPane.agent_status} />
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              title={focusedPane.agent ? "Prompt agent" : "Send text"}
              onClick={() => setMessagePane(focusedPane)}
            >
              <MessageSquareText className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Split right"
              onClick={() =>
                void rpc("pane.split", { direction: "right", target_pane_id: focusedPane.pane_id, focus: true })
              }
            >
              <Columns2 className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Split down"
              onClick={() =>
                void rpc("pane.split", { direction: "down", target_pane_id: focusedPane.pane_id, focus: true })
              }
            >
              <Rows2 className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Swap pane"
              onClick={() => void rpc("pane.swap", { pane_id: focusedPane.pane_id, direction: "right" })}
            >
              <SquareSplitHorizontal className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={layout?.zoomed ? "Unzoom" : "Zoom"}
              onClick={() => void rpc("pane.zoom", { pane_id: focusedPane.pane_id })}
            >
              {layout?.zoomed ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Rename pane"
              onClick={() =>
                setRename({ kind: "pane", id: focusedPane.pane_id, label: paneTitle(focusedPane) })
              }
            >
              <span className="text-2xs">Aa</span>
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Close pane"
              onClick={() => void rpc("pane.close", { pane_id: focusedPane.pane_id })}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}

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
                  title={paneTitle(pane)}
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

      <RenameDialog target={rename} onClose={() => setRename(null)} />
      <PaneMessageDialog pane={messagePane} onClose={() => setMessagePane(null)} />
    </div>
  );
}
