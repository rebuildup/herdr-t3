import { useEffect, useRef, useState } from "react";
import type { AgentStatus, MachineInfo, MachineStatus, PaneInfo, SessionSnapshot } from "../shared/protocol";
import { cn } from "./lib/utils";
import {
  connectBridge,
  fetchSession,
  machineAdd,
  machineConnect,
  machineDisconnect,
  onMachineStatus,
  onMachines,
  onSnapshot,
  onStatus,
  rpc,
  LOCAL_MACHINE,
} from "./lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
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
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Tooltip } from "./components/ui/tooltip";
import {
  getAppearanceMode,
  initAppearance,
  onAppearanceChange,
  setAppearanceMode,
  type AppearanceMode,
} from "./lib/theme";
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
  Pencil,
  Plus,
  Rows2,
  SquareSplitHorizontal,
  Terminal,
  Monitor,
  MonitorOff,
  RefreshCw,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

function statusIcon(status: AgentStatus) {
  switch (status) {
    case "working":
      return <Loader2 className="size-3.5 animate-spin" />;
    case "blocked":
      return <CircleX className="size-3.5 text-warning" />;
    case "done":
      return <CircleCheck className="size-3.5 text-success" />;
    case "idle":
      return <Circle className="size-3.5 text-muted-foreground" />;
    default:
      return <CircleDashed className="size-3.5 text-muted-foreground" />;
  }
}

function workspaceTitle(ws: SessionSnapshot["workspaces"][number]): string {
  return ws.label || ws.worktree?.repo_name || ws.workspace_id;
}

function machineStatusIcon(status: MachineStatus) {
  switch (status) {
    case "online":
      return <Wifi className="size-3.5 text-success" />;
    case "connecting":
    case "reconnecting":
      return <RefreshCw className="size-3 animate-spin text-muted-foreground" />;
    case "auth_required":
      return <CircleX className="size-3.5 text-warning" />;
    case "disabled":
      return <MonitorOff className="size-3.5 text-muted-foreground" />;
    default:
      return <WifiOff className="size-3.5 text-muted-foreground" />;
  }
}

export default function App() {
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>({});
  const [machines, setMachines] = useState<Record<string, MachineInfo>>({});
  const [selectedMachine, setSelectedMachine] = useState<string>(LOCAL_MACHINE);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);
  const [addMachine, setAddMachine] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceMode>(getAppearanceMode());
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem("herdr-t3:sidebar-width"));
    return saved >= 200 && saved <= 480 ? saved : 256;
  });
  const sidebarDrag = useRef<{ startX: number; startWidth: number } | null>(null);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDrag.current = { startX: e.clientX, startWidth: sidebarWidth };
    const onMove = (ev: MouseEvent) => {
      if (!sidebarDrag.current) return;
      const next = Math.min(480, Math.max(200, sidebarDrag.current.startWidth + ev.clientX - sidebarDrag.current.startX));
      setSidebarWidth(next);
    };
    const onUp = () => {
      sidebarDrag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setSidebarWidth((w) => {
        localStorage.setItem("herdr-t3:sidebar-width", String(w));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    initAppearance();
    return onAppearanceChange(() => setAppearance(getAppearanceMode()));
  }, []);

  useEffect(() => {
    const disconnect = connectBridge();
    const offSnapshot = onSnapshot((next, machine) => {
      setSnapshots((prev) => ({ ...prev, [machine]: next }));
      setError(null);
    });
    const offStatus = onStatus(setConnection);
    const offMachines = onMachines((list) => {
      setMachines(Object.fromEntries(list.map((m) => [m.id, m])));
    });
    const offMachineStatus = onMachineStatus((m) => {
      setMachines((prev) => ({ ...prev, [m.id]: m }));
    });
    void fetchSession(LOCAL_MACHINE)
      .then((snap) => setSnapshots((prev) => ({ ...prev, [LOCAL_MACHINE]: snap })))
      .catch((e: Error) => setError(e.message));
    return () => {
      disconnect();
      offSnapshot();
      offStatus();
      offMachines();
      offMachineStatus();
    };
  }, []);

  const snapshot = snapshots[selectedMachine] ?? null;
  const machine = selectedMachine;
  const call = (method: Parameters<typeof rpc>[0], params: Record<string, unknown> = {}) =>
    rpc(method, params, machine);

  const selectMachine = (id: string) => {
    setSelectedMachine(id);
    setError(null);
    if (!snapshots[id]) {
      machineConnect(id);
      void fetchSession(id)
        .then((snap) => setSnapshots((prev) => ({ ...prev, [id]: snap })))
        .catch((e: Error) => setError(e.message));
    }
  };

  const machineList = Object.values(machines).sort((a, b) =>
    a.kind === "local" ? -1 : b.kind === "local" ? 1 : a.label.localeCompare(b.label),
  );
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
      <aside
        className="flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
        style={{ width: sidebarWidth }}
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Terminal className="size-4 text-primary" />
          <span className="text-sm font-medium">herdr-t3</span>
          <Tooltip content={connection}><span className="ml-auto flex items-center gap-1.5">
            {connection === "open" ? (
              <Wifi className="size-3.5 text-success" />
            ) : (
              <WifiOff className="size-3.5 text-muted-foreground" />
            )}
            {connection !== "open" && (
              <span className="text-2xs text-muted-foreground">
                {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
              </span>
            )}
          </span></Tooltip>
        </div>
        <div className="px-2 pb-1">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Machines</span>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Add machine"
              onClick={() => setAddMachine(true)}
            >
              <Plus className="size-3" />
            </Button>
          </div>
          {machineList.map((m) => {
            const selected = m.id === selectedMachine;
            const info = m.status === "online" ? null : (m.detail ?? m.status);
            return (
              <ContextMenu key={m.id}>
                <ContextMenuTrigger className="w-full">
                  <Tooltip content={info ?? m.id}>
                  {/* oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row; Button owns its own padding and shape */}
                  <button
                    type="button"
                    onClick={() => selectMachine(m.id)}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
                      selected
                        ? "bg-sidebar-row-selected text-foreground"
                        : "text-foreground/80 hover:bg-sidebar-row-hover",
                    )}
                  >
                    <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    {machineStatusIcon(m.status)}
                  </button>
                  </Tooltip>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  {m.status !== "online" && m.status !== "connecting" && m.status !== "disabled" && (
                    <ContextMenuItem onSelect={() => machineConnect(m.id)}>
                      <RefreshCw className="size-3.5" /> Connect
                    </ContextMenuItem>
                  )}
                  {m.status === "online" && (
                    <ContextMenuItem onSelect={() => machineDisconnect(m.id)}>
                      <MonitorOff className="size-3.5" /> Disconnect
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {machineList.length === 0 && (
            <p className="px-2 py-4 text-center text-2xs text-muted-foreground/60">No machines yet.</p>
          )}
        </div>
        <div className="px-2 pb-1">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={!snapshot}
            onClick={() => void call("workspace.create", { focus: true })}
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
                  {/* oxlint-disable-next-line herdr-t3/no-raw-control -- semantic sidebar row; Button owns its own padding and shape */}
                  <button
                    type="button"
                    onClick={() => void call("workspace.focus", { workspace_id: ws.workspace_id })}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm",
                      selected
                        ? "bg-sidebar-row-selected text-foreground"
                        : "text-foreground/80 hover:bg-sidebar-row-hover",
                    )}
                  >
                    {statusIcon(ws.agent_status)}
                    <span className="min-w-0 flex-1 truncate">{workspaceTitle(ws)}</span>
                    <span className="text-2xs text-secondary-label">
                      <span className="tabular-nums">{ws.tab_count}t · {ws.pane_count}p</span>
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void call("workspace.focus", { workspace_id: ws.workspace_id })}>
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
                    onSelect={() => void call("workspace.move", { workspace_id: ws.workspace_id, insert_index: index - 1 })}
                  >
                    Move up
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={index === workspaces.length - 1}
                    onSelect={() => void call("workspace.move", { workspace_id: ws.workspace_id, insert_index: index + 1 })}
                  >
                    Move down
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void call("workspace.close", { workspace_id: ws.workspace_id })}>
                    Close
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {snapshot && workspaces.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">No workspaces yet.</p>
          )}
        </nav>
        {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
        <div className="border-t border-sidebar-border px-3 py-2">
          <label className="flex items-center gap-2 text-2xs text-muted-foreground">
            Appearance
            <Select value={appearance} onValueChange={(v) => setAppearanceMode(v as AppearanceMode)}>
              <SelectTrigger className="ml-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ghostty">Ghostty sync</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="w-1 shrink-0 cursor-col-resize hover:bg-border"
        onMouseDown={startSidebarResize}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1">
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
                    {/* oxlint-disable-next-line herdr-t3/no-raw-control -- tab label is part of a composite tab row, not a standalone control */}
                    <button
                      type="button"
                      onClick={() => void call("tab.focus", { tab_id: tab.tab_id })}
                      className="flex items-center gap-1.5"
                    >
                      {statusIcon(tab.agent_status)}
                      <span className="max-w-40 truncate">{tab.label || `Tab ${tab.number}`}</span>
                    </button>
                    {selected && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Close tab"
                        // oxlint-disable-next-line shadcn/no-restyle -- hover-reveal affordance; no Button variant covers group-hover opacity
                        className="opacity-0 group-hover:opacity-100"
                        onClick={() => void call("tab.close", { tab_id: tab.tab_id })}
                      >
                        <X className="size-3" />
                      </Button>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => void call("tab.focus", { tab_id: tab.tab_id })}>
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
                    onSelect={() => void call("tab.move", { tab_id: tab.tab_id, insert_index: index - 1 })}
                  >
                    Move left
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={index === workspaceTabs.length - 1}
                    onSelect={() => void call("tab.move", { tab_id: tab.tab_id, insert_index: index + 1 })}
                  >
                    Move right
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => void call("tab.close", { tab_id: tab.tab_id })}>
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
                void call("tab.create", { workspace_id: activeWorkspace.workspace_id, focus: true })
              }
            >
              <Plus className="size-4" />
            </Button>
          )}
          {focusedPane && (
            <div className="ml-auto flex min-w-0 items-center gap-1">
              <div className="mr-1 h-4 w-px shrink-0 bg-border" />
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
                void call("pane.split", { direction: "right", target_pane_id: focusedPane.pane_id, focus: true })
              }
            >
              <Columns2 className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Split down"
              onClick={() =>
                void call("pane.split", { direction: "down", target_pane_id: focusedPane.pane_id, focus: true })
              }
            >
              <Rows2 className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Swap pane"
              onClick={() => void call("pane.swap", { pane_id: focusedPane.pane_id, direction: "right" })}
            >
              <SquareSplitHorizontal className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={layout?.zoomed ? "Unzoom" : "Zoom"}
              onClick={() => void call("pane.zoom", { pane_id: focusedPane.pane_id })}
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
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title="Close pane"
              onClick={() => void call("pane.close", { pane_id: focusedPane.pane_id })}
            >
              <X className="size-3.5" />
            </Button>
            </div>
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
                  title={paneTitle(pane)}
                  onMouseDown={() => {
                    if (!pane.focused) void call("pane.focus", { pane_id: pane.pane_id });
                  }}
                >
                  <PaneTerminal machine={machine} paneId={pane.pane_id} connected={connection === "open" || machines[machine]?.status === "online"} />
                </div>
              );
            })}
        </div>
      </main>

      <RenameDialog target={rename} machine={machine} onClose={() => setRename(null)} />
      <PaneMessageDialog pane={messagePane} machine={machine} onClose={() => setMessagePane(null)} />
      <AddMachineDialog open={addMachine} onClose={() => setAddMachine(false)} />
    </div>
  );
}

function AddMachineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState("");
  const [session, setSession] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!label.trim() || !target.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await machineAdd({ label: label.trim(), target: target.trim(), session: session.trim() || undefined });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Add machine</DialogTitle>
        <DialogDescription>
          Connect to a herdr server over SSH. Uses your existing ssh config; the first connect may
          require interactive SSH authentication in a terminal.
        </DialogDescription>
        <div className="flex flex-col gap-2">
          <Input
            
            placeholder="Label (e.g. lab-windows)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Input
            
            placeholder="SSH target (user@host or ssh config alias)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Input
            
            placeholder="Herdr session (default)"
            value={session}
            onChange={(e) => setSession(e.target.value)}
          />
          {error && <p className="text-2xs text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={busy || !label.trim() || !target.trim()} onClick={() => void submit()}>
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
